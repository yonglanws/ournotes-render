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
import { episodeToLines } from "./official-corpus.mjs";
import { summarize } from "./story-metrics.mjs";

const COMMANDS = new Set(ADV_COMMAND.filter(Boolean));

// Ranges from docs/story-author.md and the approved harness design. Duration is
// checked where the compiler emits it because the parser admits the same range.
export const COMMAND_PARAMETER_RANGES = Object.freeze({
  Zoom: { Parameter1: [0.7, 2.5], Duration: [0.2, 20] },
  Pedestal: { Parameter1: [-4, 5], Duration: [0, 20] },
  PanV2: { Parameter1: [-30, 30], Duration: [0, 20] },
  DoF: { Parameter1: [0, 1], Duration: [0.5, 10] },
  Look: { Parameter1: [-1, 1], Parameter2: [-1, 1], Duration: [0.2, 10] },
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

// {episode, story, script, requires} -> audit report. `requires` is the
// generated manifest's top-level requires object; `story` is its story index
// (both optional, checked when their `commands` array is present).
export const auditCompiledStory = ({ episode, story = null, script = null, requires = null } = {}) => {
  const failures = [];
  const rows = Array.isArray(episode?.commands) ? episode.commands : [];
  if (!Array.isArray(episode?.commands)) failures.push({ code: "commands", message: "episode.commands is not an array" });

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
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
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const ranges = COMMAND_PARAMETER_RANGES[row.cmd];
    if (row.cmd === "Focus") {
      parameters.Focus.count++;
      const distance = numeric(row.CameraDistance);
      if (distance !== null) parameters.Focus.distances.push(distance);
      const duration = numeric(row.Duration);
      if (duration !== null) parameters.Focus.durations.push(duration);
    } else if (row.cmd === "Track") {
      parameters.Track.count++;
      const value = numeric(row.Parameter1);
      if (value === null) failures.push({ code: "parameterMissing", index, cmd: row.cmd,
                                          message: "Track has no numeric Parameter1" });
      else parameters.Track.parameter1.push(String(row.Parameter1));
      const duration = numeric(row.Duration);
      if (duration !== null) parameters.Track.durations.push(duration);
    } else if (row.cmd === "Se") {
      parameters.Se.count++;
      if (row.Parameter1 === "Stop") parameters.Se.stops++;
      else if (row.SeID !== undefined) parameters.Se.soundIds.push(String(row.SeID));
      const duration = numeric(row.Duration);
      if (duration !== null) parameters.Se.durations.push(duration);
    }
    if (!ranges) continue;
    parameters[row.cmd].count++;
    for (const [field, [min, max]] of Object.entries(ranges)) {
      if (row[field] === undefined) {
        failures.push({ code: "parameterMissing", index, cmd: row.cmd,
                        message: `${row.cmd} has no ${field}` });
        continue;
      }
      const value = numeric(row[field]);
      if (value === null) {
        failures.push({ code: "parameterType", index, cmd: row.cmd,
                        message: `${row.cmd}.${field}=${JSON.stringify(row[field])} is not numeric` });
        continue;
      }
      if (value < min || value > max)
        failures.push({ code: "parameterRange", index, cmd: row.cmd,
                        message: `${row.cmd}.${field}=${value} is outside ${min}..${max}` });
      if (field === "Parameter1") parameters[row.cmd].parameter1?.push(String(row[field]));
      else if (field === "Parameter2") parameters[row.cmd].parameter2?.push(String(row[field]));
      else if (field === "Duration") parameters[row.cmd].durations.push(value);
    }
  }
  for (const stats of Object.values(parameters)) {
    for (const [key, value] of Object.entries(stats)) {
      if (Array.isArray(value)) stats[key] = [...new Set(value)].sort();
    }
  }

  // Resource closure: Se/Bgm -> episode.sounds -> episode.cuesheets -> story.parts.sounds.
  const closure = { ok: true, sounds: 0, cuesheets: 0, sheets: 0, missing: [] };
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
    if (row.cmd === "Se") {
      if (row.Parameter1 !== "Stop") inspectSound(row, index, row.SeID, "seResource");
    } else if (row.cmd === "Bgm" && row.BgmID !== undefined) {
      inspectSound(row, index, row.BgmID, "bgmResource");
    }
  });
  closure.sounds = soundIds.size;
  closure.cuesheets = sheetIds.size;
  closure.sheets = sheetNames.size;
  closure.ok = closure.missing.length === 0;

  // HostActions timed looks are the 0.1.8 engine defect this harness avoids.
  rows.forEach((row, index) => {
    if (row.HostActions === undefined) return;
    if (!Array.isArray(row.HostActions)) {
      failures.push({ code: "hostActionsType", index, cmd: row.cmd, message: "HostActions is not an array" });
      return;
    }
    row.HostActions.forEach((action, actionIndex) => {
      if (action && Object.hasOwn(action, "LookTargetPosition"))
        failures.push({ code: "hostActionsLook", index, action: actionIndex, cmd: row.cmd,
                        message: "HostActions contains LookTargetPosition; emit a Look/LookTarget row instead" });
    });
  });

  const expected = sortedUnique(rows.map((row) => row.cmd));
  const requiresOk = checkManifestList(requires?.commands, expected, "requiresCommands", "requires.commands", failures);
  const storyOk = checkManifestList(story?.commands, expected, "storyCommands", "story.commands", failures);

  return {
    commands: expected,
    commandCount,
    counts: sortedCounts(rows),
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
  if (!Array.isArray(requires?.commands) && !Array.isArray(story?.commands)) {
    throw new Error("--manifest (with requires.commands) or --story (with commands) is required: " +
      "an audit cannot pass without checking the required-command list");
  }
  const audit = auditCompiledStory({ episode, story, requires });
  console.log(JSON.stringify({ ok: audit.failures.length === 0, ...audit }, null, 2));
  return audit.failures.length ? 1 : 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { if (code) process.exitCode = code; })
    .catch((error) => { console.error(error.message); process.exit(2); });
}
