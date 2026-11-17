// Compiled-command audit for generated story scripts. It reads the episode
// rows the compiler wrote, not the script, so it catches a row that the
// compiler or a repair pass made unplayable: an unregistered command, a broken
// index/raw id, a parameter outside the official checked range, a sound whose
// cue sheet or story part is missing, or a HostActions timed look that the
// 0.1.8 site engine does not play reliably.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADV_COMMAND } from "../../src/story/interfaces.js";
import { hasSpokenContent, SLOT_WORLD_X } from "../lib/story-author/grammar.js";
import { episodeText, episodeToLines } from "./official-corpus.mjs";
import { summarize } from "./story-metrics.mjs";

const COMMANDS = new Set(ADV_COMMAND.filter(Boolean));
const DIST_ZOOM = Object.freeze([1.0, 1.2, 1.4, 1.8, 2.8, 4.0, 6.0]);

// Ranges from docs/story-author.md and the approved harness design. Duration and
// look Parameter2 are optional: official Pedestal/PanV2 rows often omit Duration
// (a cut), and Look's y offset defaults to 0. Parameter1 (and Focus's
// CameraDistance, Track's offset) are required, except Look/LookTarget rows with
// Parameter3 === "Stop" which clear gaze without Parameter1/PositionType.
export const COMMAND_PARAMETER_RANGES = Object.freeze({
  Zoom: { required: ["Parameter1"], fields: { Parameter1: [0.7, 2.5], Duration: [0.2, 20] } },
  Pedestal: { required: ["Parameter1"], fields: { Parameter1: [-4, 5], Duration: [0, 20] } },
  PanV2: { required: ["Parameter1"], fields: {
    Parameter1: [-30, 30], Duration: [0, 20], Parameter3: [0, 1],
  } },
  DoF: { required: ["Parameter1"], fields: { Parameter1: [0, 1], Duration: [0.5, 10] } },
  Look: { required: ["Parameter1"], fields: {
    Parameter1: [-1, 1], Parameter2: [-1, 1], Duration: [0.2, 10],
  } },
  Focus: { required: ["CameraDistance"], fields: {
    CameraDistance: [0, 6], Duration: [0, 20], PositionType: [1, 9],
  } },
  Track: { required: ["Parameter1"], fields: { Parameter1: [-4, 4], Duration: [0, 20] } },
  Se: { required: [], fields: { Duration: [0.5, 10] } },
});

const numeric = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const sortedUnique = (values) => [...new Set(values)].sort();

const sortedCounts = (rows) => Object.fromEntries([...rows.reduce((map, row) => {
  map.set(row.cmd, (map.get(row.cmd) || 0) + 1);
  return map;
}, new Map())].sort(([a], [b]) => a.localeCompare(b, "en")));

const emptyParameterStats = () => ({
  Zoom: { count: 0, parameter1: [], durations: [] },
  Pedestal: { count: 0, parameter1: [], durations: [] },
  PanV2: { count: 0, parameter1: [], durations: [] },
  DoF: { count: 0, parameter1: [], durations: [] },
  Look: { count: 0, parameter1: [], parameter2: [], durations: [] },
  Focus: { count: 0, distances: [], durations: [] },
  Track: { count: 0, parameter1: [], durations: [] },
  Se: { count: 0, soundIds: [], stops: 0, durations: [] },
});

const checkManifestList = (value, expected, code, label, failures) => {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    failures.push({ code, message: `${label} is not an array` });
    return false;
  }
  const actual = sortedUnique(value.map(String));
  if (value.length !== actual.length) {
    failures.push({ code, message: `${label} contains duplicate commands`, expected, actual: value });
    return false;
  }
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    failures.push({ code, message: `${label} does not match the episode commands`,
                    expected, actual });
    return false;
  }
  return true;
};

const talkRowText = (episode, row, script) => {
  if (script?.language) {
    const t = episodeText(episode, row, script.language);
    if (t) return t;
  }
  const tZh = episodeText(episode, row, "zh-Hans");
  if (tZh) return tZh;
  const entry = episode?.text?.[String(row?.AdvTextID)];
  if (entry && typeof entry === "object") {
    for (const v of Object.values(entry)) if (typeof v === "string" && v) return v;
  }
  if (row?.lines && typeof row.lines === "object") {
    for (const v of Object.values(row.lines)) if (typeof v === "string" && v) return v;
  }
  return "";
};

const emptyEffects = () => ({
  dof: { active: false, index: -1 },
  role: { value: 0, index: -1 },
  tilt: { value: 0, index: -1 },
  brightness: new Map(),
  frames: new Map(),
  postEffects: new Map(),
  cameraShake: { active: false, index: -1 },
  gaze: new Map(),
});

const auditSceneSemantics = (rows, episode, script, failures) => {
  const onStage = new Map();
  let focus = { distance: 2, posType: 5, targetName: "" };
  let trackOffset = 0;
  let zoomMul = 1;
  let inClose = false;
  let closeTalkCount = 0;
  let closeStartIndex = -1;
  let closeBurstReported = false;
  let seenSceneContent = false;
  let effects = emptyEffects();

  const scriptTextBeats = Array.isArray(script?.beats)
    ? script.beats.filter((b) => b && typeof b === "object" && ("say" in b || "narrate" in b))
    : null;
  const talkRowsTotal = rows.reduce((n, r) => n + (r?.cmd === "Talk" ? 1 : 0), 0);
  const matchedBeats = scriptTextBeats && scriptTextBeats.length === talkRowsTotal ? scriptTextBeats : null;
  let talkCount = 0;

  const checkUnclosed = (whereLabel, atIndex) => {
    if (effects.dof.active) {
      failures.push({ code: "unclosedEffect", cmd: "DoF", index: effects.dof.index, where: atIndex,
                      message: `DoF left active at ${whereLabel}` });
    }
    if (effects.role.value !== 0) {
      failures.push({ code: "unclosedEffect", cmd: "Role", index: effects.role.index, where: atIndex,
                      message: `Role (${effects.role.value}) left active at ${whereLabel}` });
    }
    if (effects.tilt.value !== 0) {
      failures.push({ code: "unclosedEffect", cmd: "Tilt", index: effects.tilt.index, where: atIndex,
                      message: `Tilt (${effects.tilt.value}) left active at ${whereLabel}` });
    }
    for (const [scope, st] of effects.brightness) {
      failures.push({ code: "unclosedEffect", cmd: "Brightness", target: scope, index: st.index, where: atIndex,
                      message: `Brightness (${scope}=${st.value}) left unreset at ${whereLabel}` });
    }
    for (const [asset, idx] of effects.frames) {
      failures.push({ code: "unclosedEffect", cmd: "Frame", asset, index: idx, where: atIndex,
                      message: `Frame (${asset}) left active at ${whereLabel}` });
    }
    for (const [asset, idx] of effects.postEffects) {
      failures.push({ code: "unclosedEffect", cmd: "PostEffect", asset, index: idx, where: atIndex,
                      message: `PostEffect (${asset}) left active at ${whereLabel}` });
    }
    if (effects.cameraShake.active) {
      failures.push({ code: "unclosedEffect", cmd: "CameraShake", index: effects.cameraShake.index, where: atIndex,
                      message: `CameraShake left active at ${whereLabel}` });
    }
    for (const [target, st] of effects.gaze) {
      failures.push({ code: "unclosedEffect", cmd: st.cmd, target, index: st.index, where: atIndex,
                      message: `${st.cmd} on ${target} left unstopped at ${whereLabel}` });
    }
  };

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;

    if (row.cmd === "Stage") {
      if (seenSceneContent) {
        checkUnclosed("scene change", index);
        effects = emptyEffects();
        onStage.clear();
        focus = { distance: 2, posType: 5, targetName: "" };
        trackOffset = 0;
        zoomMul = 1;
        inClose = false;
        closeTalkCount = 0;
        closeStartIndex = -1;
        closeBurstReported = false;
      }
      seenSceneContent = true;
      continue;
    }
    if (row.cmd === "In") {
      seenSceneContent = true;
      if (row.TargetName) {
        onStage.set(String(row.TargetName), {
          cast: String(row.TargetName),
          slot: numeric(row.PositionType) ?? 5,
          x: 0, y: 0, z: 0,
        });
      }
      continue;
    }
    if (row.cmd === "Out") {
      if (row.TargetName) onStage.delete(String(row.TargetName));
      continue;
    }
    if (row.cmd === "MoveToDirection") {
      const m = row.TargetName ? onStage.get(String(row.TargetName)) : null;
      if (m) {
        m.x += numeric(row.Parameter1) ?? 0;
        m.y += numeric(row.Parameter2) ?? 0;
        m.z += numeric(row.Parameter3) ?? 0;
      }
      continue;
    }
    if (row.cmd === "MoveToLeft" || row.cmd === "MoveToRight" || row.cmd === "MoveToUp" ||
        row.cmd === "MoveToDown" || row.cmd === "MoveToForward" || row.cmd === "MoveToBack") {
      const m = row.TargetName ? onStage.get(String(row.TargetName)) : null;
      const amt = numeric(row.Parameter1) ?? 0;
      if (m) {
        if (row.cmd === "MoveToLeft") m.x -= amt;
        else if (row.cmd === "MoveToRight") m.x += amt;
        else if (row.cmd === "MoveToUp") m.y += amt;
        else if (row.cmd === "MoveToDown") m.y -= amt;
        else if (row.cmd === "MoveToForward") m.z -= amt;
        else if (row.cmd === "MoveToBack") m.z += amt;
      }
      continue;
    }
    if (row.cmd === "Focus") {
      seenSceneContent = true;
      const d = numeric(row.CameraDistance) ?? 2;
      const p = numeric(row.PositionType) ?? focus.posType;
      const t = row.TargetName ? String(row.TargetName) : "";
      focus = { distance: d, posType: p, targetName: t };
      trackOffset = 0;
      zoomMul = 1;
      if (d < 4) {
        inClose = false;
        closeTalkCount = 0;
        closeStartIndex = -1;
        closeBurstReported = false;
      } else if (!inClose) {
        inClose = true;
        closeTalkCount = 0;
        closeStartIndex = index;
        closeBurstReported = false;
      }
      continue;
    }
    if (row.cmd === "Track") {
      const tr = numeric(row.Parameter1);
      if (tr !== null) trackOffset = tr;
      continue;
    }
    if (row.cmd === "Zoom") {
      const zm = numeric(row.Parameter1);
      if (zm !== null) zoomMul = zm <= 0 ? 1 : zm;
      continue;
    }
    if (row.cmd === "DoF") {
      seenSceneContent = true;
      const v = numeric(row.Parameter1);
      if (v !== null && v > 0) {
        effects.dof = { active: true, index };
        const hasTargetName = Boolean(row.TargetName);
        const posType = numeric(row.PositionType);
        const layers = Array.isArray(row.CanvasLayers) ? row.CanvasLayers : null;
        const isCharLayerOnly = Boolean(layers && layers.includes(2) && !layers.includes(0));
        if (isCharLayerOnly && !hasTargetName && posType === null) {
          failures.push({ code: "dofFocusedSpeaker", index, cmd: "DoF",
                          message: "DoF on character CanvasLayers [2] without a non-speaker target blurs focused speaker" });
        } else if (hasTargetName || posType !== null) {
          let upcomingSpeaker = "";
          for (let j = index + 1; j < rows.length; j++) {
            const r = rows[j];
            if (!r || typeof r !== "object") continue;
            if (r.cmd === "Stage" || r.cmd === "FadeOut" || r.cmd === "DoF" || r.cmd === "Focus") break;
            if (r.cmd === "Talk") {
              upcomingSpeaker = r.TargetName ? String(r.TargetName) : "";
              break;
            }
          }
          const forbiddenTargets = new Set();
          const forbiddenSlots = new Set();
          if (upcomingSpeaker) {
            forbiddenTargets.add(upcomingSpeaker);
            if (onStage.has(upcomingSpeaker)) forbiddenSlots.add(onStage.get(upcomingSpeaker).slot);
          }
          if (focus.targetName) {
            forbiddenTargets.add(focus.targetName);
            if (onStage.has(focus.targetName)) forbiddenSlots.add(onStage.get(focus.targetName).slot);
          } else if (focus.posType !== 5) {
            const occupants = [...onStage.values()].filter((m) => m.slot === focus.posType);
            if (occupants.length === 1) {
              forbiddenTargets.add(occupants[0].cast);
              forbiddenSlots.add(focus.posType);
            }
          }
          if ((hasTargetName && forbiddenTargets.has(String(row.TargetName))) ||
              (posType !== null && forbiddenSlots.has(posType))) {
            failures.push({ code: "dofFocusedSpeaker", index, cmd: "DoF",
                            target: row.TargetName || posType,
                            message: `DoF targeted focused speaker (${row.TargetName || posType})` });
          }
        }
      } else if (v === 0) {
        effects.dof = { active: false, index: -1 };
      }
      continue;
    }
    if (row.cmd === "Role") {
      seenSceneContent = true;
      const v = numeric(row.Parameter1);
      if (v !== null) effects.role = Math.abs(v) > 0 ? { value: v, index } : { value: 0, index: -1 };
      continue;
    }
    if (row.cmd === "Tilt") {
      seenSceneContent = true;
      const v = numeric(row.Parameter1);
      if (v !== null) effects.tilt = Math.abs(v) > 0 ? { value: v, index } : { value: 0, index: -1 };
      continue;
    }
    if (row.cmd === "Brightness") {
      seenSceneContent = true;
      const v = numeric(row.Parameter1);
      const layers = Array.isArray(row.CanvasLayers) ? row.CanvasLayers : null;
      const scope = layers && layers.includes(0) && !row.TargetName ? "bg"
        : row.TargetName ? String(row.TargetName) : "global";
      if (v !== null) {
        if (Math.abs(v - 1) > 1e-6) effects.brightness.set(scope, { value: v, index });
        else effects.brightness.delete(scope);
      }
      continue;
    }
    if (row.cmd === "Frame") {
      seenSceneContent = true;
      const asset = String(row.TargetAssetName || "_default");
      const act = String(row.Parameter2 || "");
      if (act === "Hide_anime") effects.frames.delete(asset);
      else if (act === "Show_anime") effects.frames.set(asset, index);
      else if (effects.frames.has(asset)) effects.frames.delete(asset);
      else effects.frames.set(asset, index);
      continue;
    }
    if (row.cmd === "PostEffect") {
      seenSceneContent = true;
      const asset = String(row.TargetAssetName || "_default");
      if (effects.postEffects.has(asset)) effects.postEffects.delete(asset);
      else effects.postEffects.set(asset, index);
      continue;
    }
    if (row.cmd === "CameraShake") {
      seenSceneContent = true;
      if (effects.cameraShake.active) effects.cameraShake = { active: false, index: -1 };
      else effects.cameraShake = { active: true, index };
      continue;
    }
    if (row.cmd === "Look" || row.cmd === "LookTarget") {
      seenSceneContent = true;
      const target = String(row.TargetName || "_default");
      const isStop = String(row.Parameter3 || "").toLowerCase() === "stop";
      if (isStop) effects.gaze.delete(target);
      else effects.gaze.set(target, { cmd: row.cmd, index });
      continue;
    }
    if (row.cmd === "Talk") {
      seenSceneContent = true;
      const tIdx = talkCount++;
      const text = talkRowText(episode, row, script);
      const beat = matchedBeats ? matchedBeats[tIdx] : null;
      const isThought = beat?.thought === true;
      const isVoiceless = text !== "" && !hasSpokenContent(text);
      if ((isThought || isVoiceless) && row.IgnoreLipSync !== 1) {
        failures.push({ code: "missingIgnoreLipSync", index, cmd: "Talk",
                        message: "Talk on voiceless/thought line must set IgnoreLipSync: 1" });
      }
      if (inClose) {
        closeTalkCount++;
        if (closeTalkCount > 3 && !closeBurstReported) {
          closeBurstReported = true;
          failures.push({ code: "closeBurstUnrecovered", index, startIndex: closeStartIndex,
                          lines: closeTalkCount, cmd: "Talk",
                          message: "close/very-close burst exceeded 3 lines without recovering to middle/far" });
        }
      }
      if (row.TargetName && onStage.has(String(row.TargetName)) && (focus.distance >= 4 || Math.abs(trackOffset) > 1e-6)) {
        const char = onStage.get(String(row.TargetName));
        const charX = (SLOT_WORLD_X[char.slot] ?? 0) + char.x;
        const focusTarget = focus.targetName && onStage.has(focus.targetName) ? onStage.get(focus.targetName) : null;
        const camBaseX = (focus.posType in SLOT_WORLD_X
          ? SLOT_WORLD_X[focus.posType]
          : (focusTarget ? (SLOT_WORLD_X[focusTarget.slot] ?? 0) + focusTarget.x : 0));
        const camX = camBaseX + trackOffset;
        const distZoom = DIST_ZOOM[focus.distance] ?? 1.4;
        const fov = 39.6 / (distZoom * zoomMul);
        const halfWidth = (5.5 + char.z) * Math.tan((fov * Math.PI) / 360) * (13 / 6);
        if (halfWidth > 0 && Math.abs(charX - camX) > 0.7 * halfWidth) {
          failures.push({
            code: "speakerOutsideCentralBand", index, cmd: "Talk", target: String(row.TargetName),
            ratio: Number((Math.abs(charX - camX) / halfWidth).toFixed(3)),
            message: `Speaker ${row.TargetName} head is outside central 70% band (${Math.round((Math.abs(charX - camX) / halfWidth) * 100)}%)`,
          });
        }
      }
    }
  }

  checkUnclosed("episode end", rows.length - 1);
};

// {episode, story, script, requires} -> audit report. `requires` is the
// generated manifest's top-level requires object; `story` is its story index
// (both optional, checked when their `commands` array is present).
export const auditCompiledStory = ({ episode, story = null, script = null, requires = null } = {}) => {
  const failures = [];
  const rows = Array.isArray(episode?.commands) ? episode.commands : [];
  if (!Array.isArray(episode?.commands)) failures.push({ code: "commands", message: "episode.commands is not an array" });

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      failures.push({ code: "rowType", index, message: `row ${index} is not an object` });
      continue;
    }
    if (row.i !== index)
      failures.push({ code: "rowIndex", index, cmd: row.cmd, message: `row ${index} has i=${row.i}` });
    if (!COMMANDS.has(row.cmd)) {
      failures.push({ code: "unknownCommand", index, cmd: row.cmd,
                      message: `${String(row.cmd)} is not an ADV command` });
      continue;
    }
    const raw = numeric(row.raw);
    if (raw === null || !Number.isInteger(raw) || ADV_COMMAND[raw] !== row.cmd)
      failures.push({ code: "rawCommand", index, cmd: row.cmd,
                      message: `row ${index} raw=${row.raw} does not name ${row.cmd}` });
  }

  const commandCount = rows.length;
  if (episode?.commandCount !== commandCount)
    failures.push({ code: "commandCount", expected: commandCount, actual: episode?.commandCount,
                    message: `episode.commandCount is ${episode?.commandCount}, not ${commandCount}` });

  const parameters = emptyParameterStats();
  const checkRange = (row, index, field, [min, max], required = false) => {
    if (row[field] === undefined) {
      if (required)
        failures.push({ code: "parameterMissing", index, cmd: row.cmd,
                        message: `${row.cmd} has no ${field}` });
      return;
    }
    const value = numeric(row[field]);
    if (value === null) {
      failures.push({ code: "parameterType", index, cmd: row.cmd,
                      message: `${row.cmd}.${field}=${JSON.stringify(row[field])} is not numeric` });
      return;
    }
    if (value < min || value > max)
      failures.push({ code: "parameterRange", index, cmd: row.cmd,
                      message: `${row.cmd}.${field}=${value} is outside ${min}..${max}` });
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (row.cmd === "Focus") {
      parameters.Focus.count++;
      checkRange(row, index, "CameraDistance", [0, 6], true);
      checkRange(row, index, "Duration", [0, 20]);
      checkRange(row, index, "PositionType", [1, 9]);
      const distance = numeric(row.CameraDistance);
      if (distance !== null) parameters.Focus.distances.push(distance);
      const duration = numeric(row.Duration);
      if (duration !== null) parameters.Focus.durations.push(duration);
    } else if (row.cmd === "Track") {
      parameters.Track.count++;
      checkRange(row, index, "Parameter1", [-4, 4], true);
      checkRange(row, index, "Duration", [0, 20]);
      const value = numeric(row.Parameter1);
      if (value !== null) parameters.Track.parameter1.push(String(row.Parameter1));
      const duration = numeric(row.Duration);
      if (duration !== null) parameters.Track.durations.push(duration);
    } else if (row.cmd === "DoF") {
      parameters.DoF.count++;
      checkRange(row, index, "Parameter1", [0, 1], true);
      const dofVal = numeric(row.Parameter1);
      checkRange(row, index, "Duration", dofVal === 0 ? [0, 10] : [0.5, 10]);
      if (row.Parameter1 !== undefined) parameters.DoF.parameter1.push(String(row.Parameter1));
      const duration = numeric(row.Duration);
      if (duration !== null) parameters.DoF.durations.push(duration);
    } else if (row.cmd === "Look") {
      parameters.Look.count++;
      const isStop = String(row.Parameter3 || "").toLowerCase() === "stop";
      checkRange(row, index, "Parameter1", [-1, 1], !isStop);
      checkRange(row, index, "Parameter2", [-1, 1], false);
      checkRange(row, index, "Duration", isStop ? [0, 10] : [0.2, 10], false);
      if (row.Parameter1 !== undefined) parameters.Look.parameter1.push(String(row.Parameter1));
      if (row.Parameter2 !== undefined) parameters.Look.parameter2.push(String(row.Parameter2));
      const duration = numeric(row.Duration);
      if (duration !== null) parameters.Look.durations.push(duration);
    } else if (row.cmd === "LookTarget") {
      const isStop = String(row.Parameter3 || "").toLowerCase() === "stop";
      checkRange(row, index, "PositionType", [1, 9], !isStop && row.PositionType !== undefined);
      checkRange(row, index, "Duration", isStop ? [0, 10] : [0.2, 10], false);
    } else if (row.cmd === "Se") {
      parameters.Se.count++;
      if (row.Parameter1 === "Stop") parameters.Se.stops++;
      else if (row.SeID !== undefined) parameters.Se.soundIds.push(String(row.SeID));
      checkRange(row, index, "Duration", [0.5, 10]);
      const duration = numeric(row.Duration);
      if (duration !== null) parameters.Se.durations.push(duration);
    } else if (row.cmd === "Bgm") {
      const fadeSec = numeric(row.Parameter1);
      const stop = String(row.Parameter1 || "").toLowerCase() === "stop" ||
        (fadeSec !== null && fadeSec >= 0 && fadeSec <= 20);
      if (row.BgmID === undefined && !stop)
        failures.push({ code: "bgmId", index, cmd: row.cmd,
                        message: "Bgm has no BgmID and is not a stop row" });
    }
    const spec = ["Focus", "Track", "Se", "DoF", "Look", "LookTarget"].includes(row.cmd)
      ? null : COMMAND_PARAMETER_RANGES[row.cmd];
    if (!spec) continue;
    parameters[row.cmd].count++;
    for (const [field, range] of Object.entries(spec.fields)) {
      checkRange(row, index, field, range, spec.required.includes(field));
      if (row[field] === undefined) continue;
      if (field === "Parameter1") parameters[row.cmd].parameter1?.push(String(row[field]));
      else if (field === "Parameter2") parameters[row.cmd].parameter2?.push(String(row[field]));
      else if (field === "Duration") {
        const value = numeric(row[field]);
        if (value !== null) parameters[row.cmd].durations.push(value);
      }
    }
  }
  for (const stats of Object.values(parameters)) {
    for (const [key, value] of Object.entries(stats)) {
      if (Array.isArray(value)) stats[key] = [...new Set(value)].sort();
    }
  }

  // Resource closure: Se/Bgm -> episode.sounds -> episode.cuesheets -> story.parts.sounds.
  const closure = { ok: true, checked: false, sounds: 0, cuesheets: 0, sheets: 0, missing: [] };
  const soundIds = new Set(), sheetIds = new Set(), sheetNames = new Set();
  const inspectSound = (row, index, id, code) => {
    if (id === undefined || id === null || String(id).trim() === "") {
      failures.push({ code: "soundId", index, cmd: row.cmd, message: `${row.cmd} has no sound id` });
      closure.missing.push({ index, cmd: row.cmd, sound: null, sheet: null, storyPart: null, reason: "soundId" });
      return;
    }
    const sound = episode?.sounds?.[String(id)];
    if (!sound) {
      failures.push({ code, index, cmd: row.cmd, sound: String(id), message: `sound ${id} is not in episode.sounds` });
      closure.missing.push({ index, cmd: row.cmd, sound: String(id), sheet: null, storyPart: null, reason: "sound" });
      return;
    }
    soundIds.add(String(id));
    const sheetId = sound._soundCueSheetID;
    const sheet = episode?.cuesheets?.[String(sheetId)];
    if (!sheet) {
      failures.push({ code, index, cmd: row.cmd, sound: String(id), sheet: String(sheetId),
                      message: `cue sheet ${sheetId} is not in episode.cuesheets` });
      closure.missing.push({ index, cmd: row.cmd, sound: String(id), sheet: String(sheetId), storyPart: null,
                             reason: "cuesheet" });
      return;
    }
    sheetIds.add(String(sheetId));
    const name = sheet._cueSheetName;
    if (!name || !story?.parts?.sounds?.[name]) {
      failures.push({ code, index, cmd: row.cmd, sound: String(id), sheet: String(sheetId), storyPart: name || null,
                      message: `cue sheet ${name || "(unnamed)"} is not a story.parts.sounds part` });
      closure.missing.push({ index, cmd: row.cmd, sound: String(id), sheet: String(sheetId), storyPart: name || null,
                             reason: "storyPart" });
      return;
    }
    sheetNames.add(name);
  };
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    if (row.cmd === "Se") {
      if (row.Parameter1 !== "Stop") inspectSound(row, index, row.SeID, "seResource");
    } else if (row.cmd === "Bgm" && row.BgmID !== undefined) {
      inspectSound(row, index, row.BgmID, "bgmResource");
    }
  });
  closure.sounds = soundIds.size;
  closure.cuesheets = sheetIds.size;
  closure.sheets = sheetNames.size;
  closure.checked = Boolean(story?.parts?.sounds);
  closure.ok = closure.missing.length === 0;

  // HostActions timed looks run on the site host scheduler (`page.js`); validate slot 1..9 or Stop.
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    if (row.HostActions === undefined) return;
    if (!Array.isArray(row.HostActions)) {
      failures.push({ code: "hostActionsType", index, cmd: row.cmd, message: "HostActions is not an array" });
      return;
    }
    row.HostActions.forEach((action, actionIndex) => {
      if (!action || !Object.hasOwn(action, "LookTargetPosition")) return;
      const pos = action.LookTargetPosition;
      if (typeof pos === "string" && pos.toLowerCase() === "stop") return;
      const num = numeric(pos);
      if (num === null || num < 1 || num > 9) {
        failures.push({
          code: "hostActionsLook", index, action: actionIndex, cmd: row.cmd,
          message: `HostActions[${actionIndex}].LookTargetPosition=${JSON.stringify(pos)} must be in 1..9 or "Stop"`,
        });
      }
    });
  });

  // Semantic, framing, lip-sync and stateful effect closure checks.
  auditSceneSemantics(rows, episode, script, failures);

  const objectRows = rows.filter((row) => row && typeof row === "object" && !Array.isArray(row));
  const expected = sortedUnique(objectRows.map((row) => row.cmd));
  const requiresOk = checkManifestList(requires?.commands, expected, "requiresCommands", "requires.commands", failures);
  const storyOk = checkManifestList(story?.commands, expected, "storyCommands", "story.commands", failures);

  return {
    commands: expected,
    commandCount,
    counts: sortedCounts(objectRows),
    parameters,
    failures,
    resourceClosure: closure,
    manifestCommands: {
      ok: [requiresOk, storyOk].filter((value) => value !== null).every(Boolean) &&
          (requiresOk !== null || storyOk !== null),
      requires: requiresOk,
      story: storyOk,
    },
  };
};

// The compiled episode's text lines in the same shape episodeToLines gives the
// official corpus, plus the per-line rates the quality gate reports.
export const compiledToLines = (compiled, script = null) => {
  const episode = compiled?.episode || compiled;
  return episodeToLines(episode, {
    id: script?.title || script?.base || "generated",
    language: script?.language || "zh-Hans",
  }).lines;
};

export const summaryOfLines = (lines) => {
  const summary = summarize(lines);
  const charsTotal = lines.reduce((total, line) => total + (line.chars || 0), 0);
  const rate = (value) => (summary.count ? value / summary.count : 0);
  return {
    ...summary, charsTotal,
    focusPerLine: rate(summary.focus),
    motionsPerLine: rate(summary.motions),
    lookAnyPerLine: rate(summary.lookAny),
    zoomPerLine: rate(summary.zoom),
    pedestalPerLine: rate(summary.pedestal),
    panV2PerLine: rate(summary.panV2),
    sePerLine: rate(summary.se),
  };
};

export const auditGeneratedScriptToMetrics = (compiled, script = null) => {
  const lines = compiledToLines(compiled, script);
  const summary = summaryOfLines(lines);
  return { lines, summary, charsTotal: summary.charsTotal };
};

const parseAuditArgs = (argv) => {
  const o = { episode: "", story: "", manifest: "", site: "", base: "", lang: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--episode") o.episode = argv[++i] || "";
    else if (a === "--story") o.story = argv[++i] || "";
    else if (a === "--manifest") o.manifest = argv[++i] || "";
    else if (a === "--site") o.site = argv[++i] || "";
    else if (a === "--base") o.base = argv[++i] || "";
    else if (a === "--lang") o.lang = argv[++i] || "";
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.help && !o.episode) throw new Error("--episode is required (a compiled episode.json)");
  return o;
};

const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

// CLI: audit an already compiled episode against the base story's resources.
//   npm run audit:stories -- --episode out/episode.json --site resources/site \
//     --base stories/10438.json [--manifest out/stories/99001.json] [--lang zh-Hans]
// The base story stands in for the generated story's parts.sounds: the compiler
// copies SE cue sheets from it, so a missing part there is a missing part here.
const cli = async (argv) => {
  const o = parseAuditArgs(argv);
  if (o.help) {
    console.log("Usage: npm run audit:stories -- --episode <episode.json> " +
      "(--manifest <site-manifest.json> | --story <compiled-story.json with commands>)\n" +
      "       [--site <site> --base <story manifest>] [--lang <language>]\n\n" +
      "Reports row indices, raw ids, parameter ranges, sound closure, HostActions looks and the " +
      "requires.commands/story.commands lists.\nExit code 1 when any check fails.");
    return 0;
  }
  const episode = readJson(o.episode);
  let story = o.story ? readJson(o.story) : null;
  if ((!story?.parts?.sounds) && o.site) {
    if (!o.base) throw new Error("--base is required with --site (the base story manifest)");
    const { readSiteCatalog } = await import("../../host/tools/site-story.mjs");
    const catalog = readSiteCatalog(path.resolve(o.site), o.base, o.lang);
    story = { ...(story || {}), parts: catalog.base.story.parts };
  }
  const manifest = o.manifest ? readJson(o.manifest) : null;
  const requires = manifest?.requires || manifest || null;
  const manifestStory = manifest && typeof manifest.story === "object" ? manifest.story : null;
  const manifestStoryCommands = Array.isArray(manifestStory?.commands) ? manifestStory.commands : null;
  if (manifest && !Array.isArray(requires?.commands)) {
    throw new Error("--manifest must contain requires.commands; an audit cannot pass without checking " +
      "the required-command list");
  }
  if (manifest && !Array.isArray(manifestStoryCommands)) {
    throw new Error("--manifest must contain story.commands as well as requires.commands");
  }
  if (!Array.isArray(requires?.commands) && !Array.isArray(story?.commands) && !manifestStoryCommands) {
    throw new Error("--manifest (with requires.commands) or --story (with commands) is required: " +
      "an audit cannot pass without checking the required-command list");
  }
  // A site manifest carries its command list in story.commands as well as
  // requires.commands. Merge it with the --story/site parts so both lists are
  // checked, not just requires.commands.
  const auditStory = manifestStoryCommands
    ? { ...(story || {}), ...manifestStory, commands: manifestStoryCommands }
    : story;
  const audit = auditCompiledStory({ episode, story: auditStory, requires });
  console.log(JSON.stringify({ ok: audit.failures.length === 0, ...audit }, null, 2));
  return audit.failures.length ? 1 : 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { if (code) process.exitCode = code; })
    .catch((error) => { console.error(error.message); process.exit(2); });
}
