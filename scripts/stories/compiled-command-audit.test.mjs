// The compiled-command audit: every row is a registered ADV command with a
// contiguous index and a raw command id, the new camera/look/SE fields stay in
// the checked official ranges, every sound resolves to a cue sheet and a story
// part, and the manifest's required-command lists match the episode.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkScript, compileScript, musicChoices, parseScript, soundChoices, stageChoices,
} from "../lib/story-author/script.js";
import { auditCompiledStory, auditGeneratedScriptToMetrics } from "./compiled-command-audit.mjs";
import { ADV_COMMAND } from "../../src/story/interfaces.js";

const MODELS = { m_a: "Character/Live2D/001_adv/m_a/model/m_a", m_b: "Character/Live2D/002_adv/m_b/model/m_b" };
const ACTIONS = {
  m_a: { motions: ["mtn_idle01_L", "mtn_idle01_C", "mtn_smile01_C"], expressions: ["exp_idle01", "exp_smile01"],
         defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" },
  m_b: { motions: ["mtn_idle01_C", "mtn_nod01_C"], expressions: ["exp_idle01", "exp_smile01"],
         defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" },
};
const EPISODE = {
  sounds: {
    11: { _soundCueSheetID: 5, _cueName: "sound_bgm_adv_quiet_morning" },
    12: { _soundCueSheetID: 6, _cueName: "sound_se_adv_door_knock" },
  },
  cuesheets: {
    5: { _cueSheetName: "sound_bgm_adv_quiet_morning" },
    6: { _cueSheetName: "sound_se_adv_door_knock" },
  },
  commands: [{ i: 0, cmd: "Stage", TargetAssetName: "st/garden" }],
  text: {},
};
const STORY = {
  format: 1, advId: 9, episode: "episode.json",
  parts: {
    scene: "storyscenes/default.json",
    ui: { en: "storyui/en.json" },
    fonts: { en: "storyfonts/9_en.json" },
    models: { [MODELS.m_a]: "models/m_a.json" },
    assets: { "Adv/Stage/st/garden": "storyassets/garden.json" },
    sounds: {
      sound_bgm_adv_quiet_morning: "cuesheets/sound_bgm_adv_quiet_morning.json",
      sound_se_adv_door_knock: "cuesheets/se.json",
    },
  },
};
const BASE = {
  language: "en", languages: ["en"], story: STORY, episode: EPISODE,
  stages: stageChoices(STORY.parts.assets, EPISODE, "en"),
  music: musicChoices(EPISODE, STORY),
  sounds: soundChoices(EPISODE, STORY),
};
const SITE = { base: BASE, models: MODELS, actions: ACTIONS, sounds: BASE.sounds };

const scene = (beats) => ({
  format: "ournotes.story-script/1", base: "stories/9.json", language: "en", title: "Command audit",
  cast: { a: { model: "m_a", name: "Ann" }, b: { model: "m_b", name: "Bea" } }, beats,
});

const checked = (doc) => {
  const parsed = parseScript(doc);
  assert.deepEqual(parsed.errors, []);
  const checkedScript = checkScript(parsed.script, {
    base: BASE, models: Object.keys(MODELS), actions: ACTIONS, sounds: BASE.sounds,
  });
  assert.deepEqual(checkedScript.errors, []);
  return { script: parsed.script, language: checkedScript.language, warnings: checkedScript.warnings };
};

// The episode and the manifest slices buildSiteStory adds: requires.commands and
// story.commands are both the sorted unique command list.
const compiledOf = (doc) => {
  const c = checked(doc);
  const built = compileScript(c.script, SITE, c.language);
  const commands = [...new Set(built.episode.commands.map((row) => row.cmd))].sort();
  return {
    episode: built.episode,
    story: { ...built.story, commands },
    requires: { commands },
    script: c.script,
    warnings: c.warnings,
  };
};

const officialScene = () => compiledOf(scene([
  { scene: "garden", location: "Garden", focus: 5, track: 0.5, trackDuration: 1.5,
    positions: { a: "left", b: "right" },
    se: "sound_se_adv_door_knock", seDuration: 0.7 },
  { say: "a", text: "The rain stopped.",
    zoom: 1.2, zoomDuration: 1.5,
    pedestal: -0.2, pedestalDuration: 1.5,
    pan: -5, panDuration: 1, panFocusSlide: 0.2,
    dof: 0.5, dofDuration: 1,
    look: 0.4, lookY: 0.2, lookDuration: 0.5,
    se: "sound_se_adv_door_knock", seDuration: 0.7 },
  { say: "b", text: "Then let us go." },
]));

test("the compiled episode uses registered ADV commands with contiguous rows", () => {
  const compiled = officialScene();
  const audit = auditCompiledStory(compiled);
  const commands = compiled.episode.commands;
  assert.deepEqual(audit.failures, []);
  assert.equal(audit.commandCount, commands.length);
  assert.deepEqual(audit.commands, [...new Set(commands.map((row) => row.cmd))].sort());
  commands.forEach((row, index) => {
    assert.equal(row.i, index);
    assert.ok(Number.isInteger(row.raw) && row.raw >= 0);
  });
  assert.equal(audit.counts.Zoom, 1);
  assert.equal(audit.counts.Pedestal, 1);
  assert.equal(audit.counts.PanV2, 1);
  assert.equal(audit.counts.DoF, 2);
  assert.equal(audit.counts.Look, 2);
  assert.equal(audit.counts.Se, 2);
});

test("the audit carries the official parameter values and durations", () => {
  const audit = auditCompiledStory(officialScene());
  assert.deepEqual(audit.parameters.Zoom.parameter1, ["1.2"]);
  assert.deepEqual(audit.parameters.Zoom.durations, [1.5]);
  assert.deepEqual(audit.parameters.Pedestal.parameter1, ["-0.2"]);
  assert.deepEqual(audit.parameters.PanV2.parameter1, ["-5"]);
  assert.deepEqual(audit.parameters.DoF.parameter1, ["0", "0.5"]);
  assert.deepEqual(audit.parameters.Look.parameter1, ["0.4"]);
  assert.deepEqual(audit.parameters.Look.parameter2, ["0.2"]);
});

test("optional Duration and Look Parameter2 are legal, while Track and Focus ranges are checked", () => {
  const compiled = officialScene();
  const episode = { ...compiled.episode, commands: compiled.episode.commands.map((row) => ({ ...row })) };
  const pedestal = episode.commands.find((row) => row.cmd === "Pedestal");
  const look = episode.commands.find((row) => row.cmd === "Look");
  delete pedestal.Duration;
  delete look.Parameter2;
  delete look.Duration;
  assert.deepEqual(auditCompiledStory({ ...compiled, episode }).failures, []);

  const track = episode.commands.find((row) => row.cmd === "Track");
  track.Parameter1 = "9";
  const focus = episode.commands.find((row) => row.cmd === "Focus" && row.CameraDistance !== undefined);
  focus.CameraDistance = 9;
  const failures = auditCompiledStory({ ...compiled, episode }).failures;
  assert.ok(failures.some((failure) => failure.code === "parameterRange" && failure.cmd === "Track"));
  assert.ok(failures.some((failure) => failure.code === "parameterRange" && failure.cmd === "Focus"));
});

test("a non-stop Bgm without BgmID and a non-object row are structured failures", () => {
  const bgmIndex = ADV_COMMAND.indexOf("Bgm");
  const bgm = {
    commandCount: 3,
    commands: [
      { i: 0, cmd: "Bgm", raw: bgmIndex },
      { i: 1, cmd: "Bgm", raw: bgmIndex, Parameter1: "1.5" },
      { i: 2, cmd: "Bgm", raw: bgmIndex, Parameter1: "-1" },
    ],
    sounds: {},
    cuesheets: {},
  };
  const bgmFailures = auditCompiledStory({ episode: bgm }).failures.filter((f) => f.code === "bgmId");
  assert.deepEqual(bgmFailures.map((f) => f.index), [0, 2]);
  const mixed = {
    commandCount: 2,
    commands: [{ i: 0, cmd: "Talk", raw: ADV_COMMAND.indexOf("Talk") }, null],
    sounds: {},
    cuesheets: {},
  };
  const failures = auditCompiledStory({ episode: mixed }).failures;
  assert.ok(failures.some((failure) => failure.code === "rowType"));
});

test("every Se sound closes through sounds, cue sheets and story parts", () => {
  const compiled = officialScene();
  const audit = auditCompiledStory(compiled);
  const seRows = compiled.episode.commands.filter((row) => row.cmd === "Se" && row.SeID !== undefined);
  assert.ok(seRows.length >= 1);
  for (const row of seRows) {
    const sound = compiled.episode.sounds[row.SeID];
    assert.ok(sound, `sound ${row.SeID}`);
    const sheet = compiled.episode.cuesheets[sound._soundCueSheetID];
    assert.ok(sheet, `cue sheet ${sound._soundCueSheetID}`);
    assert.ok(compiled.story.parts.sounds[sheet._cueSheetName], `story part ${sheet._cueSheetName}`);
  }
  assert.equal(audit.resourceClosure.ok, true);
  assert.deepEqual(audit.resourceClosure.missing, []);
  assert.equal(audit.resourceClosure.sounds, 1);
});

test("a Se row without a sound id fails resource closure", () => {
  const compiled = officialScene();
  const episode = { ...compiled.episode, commands: compiled.episode.commands.map((row) => ({ ...row })) };
  const se = episode.commands.find((row) => row.cmd === "Se" && row.SeID !== undefined);
  delete se.SeID;
  const audit = auditCompiledStory({ ...compiled, episode });
  assert.ok(audit.failures.some((failure) => failure.code === "soundId"));
  assert.equal(audit.resourceClosure.ok, false);
  assert.ok(audit.resourceClosure.missing.some((entry) => entry.reason === "soundId"));
});

test("the manifest command lists match the episode and a mismatch is a failure", () => {
  const compiled = officialScene();
  const audit = auditCompiledStory(compiled);
  assert.deepEqual(compiled.requires.commands, audit.commands);
  assert.deepEqual(compiled.story.commands, audit.commands);
  assert.equal(audit.manifestCommands.ok, true);

  const broken = { ...compiled, requires: { commands: ["Talk"] }, story: { ...compiled.story, commands: ["Talk"] } };
  const failures = auditCompiledStory(broken).failures;
  assert.ok(failures.some((failure) => failure.code === "requiresCommands"));
  assert.ok(failures.some((failure) => failure.code === "storyCommands"));
});

test("a broken row index, an unknown command and an out-of-range parameter fail the audit", () => {
  const compiled = officialScene();
  const episode = { ...compiled.episode, commands: compiled.episode.commands.map((row) => ({ ...row })) };
  episode.commands[0] = { ...episode.commands[0], i: 3 };
  const zoom = episode.commands.find((row) => row.cmd === "Zoom");
  zoom.Parameter1 = "9.9";
  const unknown = episode.commands.find((row) => row.cmd === "DoF");
  unknown.cmd = "DoParam";
  const failures = auditCompiledStory({ ...compiled, episode }).failures;
  assert.ok(failures.some((failure) => failure.code === "rowIndex"));
  assert.ok(failures.some((failure) => failure.code === "unknownCommand"));
  assert.ok(failures.some((failure) => failure.code === "parameterRange" && failure.cmd === "Zoom"));
});

test("Talk HostActions timed LookTargetPosition allows slots 1..9 / Stop and rejects invalid slots", () => {
  const compiled = officialScene();
  const episode = { ...compiled.episode, commands: compiled.episode.commands.map((row) => ({ ...row })) };
  const talk = episode.commands.find((row) => row.cmd === "Talk");
  talk.HostActions = [
    { at: 0.35, TargetName: "a", LookTargetPosition: 3 },
    { at: 0.8, TargetName: "a", LookTargetPosition: "Stop" },
  ];
  assert.deepEqual(auditCompiledStory({ ...compiled, episode }).failures, []);

  talk.HostActions = [{ at: 0.5, TargetName: "a", LookTargetPosition: 10 }];
  assert.ok(auditCompiledStory({ ...compiled, episode }).failures.some((failure) => failure.code === "hostActionsLook"));
  talk.HostActions = [{ at: 0.5, TargetName: "a", LookTargetPosition: 0 }];
  assert.ok(auditCompiledStory({ ...compiled, episode }).failures.some((failure) => failure.code === "hostActionsLook"));
});

test("compiled rows become the same text-line records the official metrics use", () => {
  const compiled = officialScene();
  const metrics = auditGeneratedScriptToMetrics(compiled, compiled.script);
  assert.equal(metrics.lines.length, 2);
  assert.equal(metrics.summary.count, 2);
  assert.ok(metrics.charsTotal > 20);
  assert.equal(metrics.summary.zoom, 1);
  assert.equal(metrics.summary.pedestal, 1);
  assert.equal(metrics.summary.panV2, 1);
  assert.equal(metrics.summary.dof, 2);
  assert.equal(metrics.summary.se, 2);
  assert.equal(metrics.summary.lookAny, 1);
  assert.equal(metrics.lines[0].renderedLines, 1);
});

test("the audit CLI refuses to pass without a required-command list", () => {
  const compiled = officialScene();
  const dir = mkdtempSync(path.join(tmpdir(), "command-audit-cli-"));
  const cli = fileURLToPath(new URL("./compiled-command-audit.mjs", import.meta.url));
  const episodeFile = path.join(dir, "episode.json");
  const manifestFile = path.join(dir, "manifest.json");
  const partialManifestFile = path.join(dir, "partial-manifest.json");
  const storyFile = path.join(dir, "story.json");
  writeFileSync(episodeFile, JSON.stringify(compiled.episode));
  writeFileSync(manifestFile, JSON.stringify({ requires: compiled.requires, story: { commands: compiled.requires.commands } }));
  writeFileSync(partialManifestFile, JSON.stringify({ requires: compiled.requires }));
  writeFileSync(storyFile, JSON.stringify(compiled.story));
  try {
    const missing = spawnSync(process.execPath, [cli, "--episode", episodeFile], { encoding: "utf8" });
    assert.notEqual(missing.status, 0, "an unchecked command list must not exit 0");
    assert.match(`${missing.stdout}${missing.stderr}`, /--manifest|required-command/);
    const partial = spawnSync(process.execPath,
      [cli, "--episode", episodeFile, "--manifest", partialManifestFile], { encoding: "utf8" });
    assert.notEqual(partial.status, 0, "a manifest without story.commands must not pass");
    assert.match(`${partial.stdout}${partial.stderr}`, /story\.commands/);
    for (const args of [["--story", storyFile], ["--story", storyFile, "--manifest", manifestFile]]) {
      const run = spawnSync(process.execPath, [cli, "--episode", episodeFile, ...args], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).ok, true);
      assert.equal(JSON.parse(run.stdout).manifestCommands.ok, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the audit CLI checks manifest.story.commands when only --manifest is supplied", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "command-audit-manifest-"));
  const cli = fileURLToPath(new URL("./compiled-command-audit.mjs", import.meta.url));
  const episodeFile = path.join(dir, "episode.json");
  const manifestFile = path.join(dir, "manifest.json");
  const episode = {
    commandCount: 1,
    commands: [{ i: 0, cmd: "Talk", raw: 2, AdvTextID: "line_1" }],
    text: { line_1: { "zh-Hans": "一句台词。" } },
    sounds: {},
    cuesheets: {},
  };
  writeFileSync(episodeFile, JSON.stringify(episode));
  try {
    writeFileSync(manifestFile, JSON.stringify({
      requires: { commands: ["Talk"] },
      story: { commands: ["Wrong"] },
    }));
    const wrong = spawnSync(process.execPath, [cli, "--episode", episodeFile, "--manifest", manifestFile],
      { encoding: "utf8" });
    assert.notEqual(wrong.status, 0, "a wrong manifest.story.commands must fail the audit");
    const parsed = JSON.parse(wrong.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.failures.some((failure) => failure.code === "storyCommands"));
    assert.equal(parsed.manifestCommands.story, false);

    writeFileSync(manifestFile, JSON.stringify({
      requires: { commands: ["Talk"] },
      story: { commands: ["Talk"] },
    }));
    const correct = spawnSync(process.execPath, [cli, "--episode", episodeFile, "--manifest", manifestFile],
      { encoding: "utf8" });
    assert.equal(correct.status, 0, correct.stderr);
    assert.equal(JSON.parse(correct.stdout).ok, true);
    assert.equal(JSON.parse(correct.stdout).manifestCommands.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Look and LookTarget Stop rows pass without Parameter1/PositionType", () => {
  const compiled = compiledOf(scene([
    { scene: "garden", positions: { a: "left", b: "right" } },
    { say: "a", text: "One.", look: 0.4, lookY: -0.6 },
    { say: "b", text: "Two.", lookAt: "a" },
    { say: "a", text: "Three.", look: "stop" },
    { say: "b", text: "Four.", lookAt: "stop" },
  ]));
  const audit = auditCompiledStory(compiled);
  assert.deepEqual(audit.failures, []);
});

test("DoF targeting the focused speaker fails while non-speaker and background DoF pass", () => {
  const validNonSpeaker = compiledOf(scene([
    { scene: "garden", focus: 5, positions: { a: "left", b: "right" } },
    { say: "a", text: "Focus on me.", camera: "close", focus: "a", dof: 0.5, dofLayers: 2, dofTarget: "b" },
    { say: "b", text: "Okay.", camera: "middle", focus: 5 },
  ]));
  assert.deepEqual(auditCompiledStory(validNonSpeaker).failures, []);

  // Mutated compiled episode targeting focused speaker `a`.
  const badEp = {
    ...validNonSpeaker.episode,
    commands: validNonSpeaker.episode.commands.map((row) =>
      row.cmd === "DoF" && row.Parameter1 === "0.5" ? { ...row, TargetName: "a", PositionType: 3 } : { ...row }),
  };
  assert.ok(auditCompiledStory({ ...validNonSpeaker, episode: badEp }).failures.some((f) => f.code === "dofFocusedSpeaker"));

  // Synthetic untargeted character-layer DoF row.
  const rawDof = {
    commandCount: 4,
    commands: [
      { i: 0, cmd: "Stage", raw: ADV_COMMAND.indexOf("Stage"), TargetAssetName: "st/garden" },
      { i: 1, cmd: "DoF", raw: ADV_COMMAND.indexOf("DoF"), Parameter1: "0.5", Duration: 1, CanvasLayers: [2] },
      { i: 2, cmd: "Talk", raw: ADV_COMMAND.indexOf("Talk"), AdvTextID: "t1", TargetName: "a" },
      { i: 3, cmd: "DoF", raw: ADV_COMMAND.indexOf("DoF"), Parameter1: "0", Duration: 0.5 },
    ],
    text: { t1: { "zh-Hans": "一句。" } },
    sounds: {}, cuesheets: {},
  };
  assert.ok(auditCompiledStory({ episode: rawDof }).failures.some((f) => f.code === "dofFocusedSpeaker"));
});

test("voiceless ellipsis and thought Talk lines require IgnoreLipSync: 1", () => {
  const compiled = compiledOf(scene([
    { scene: "garden", positions: { a: "left", b: "right" } },
    { say: "a", text: "……" },
    { say: "b", text: "内心的独白。", thought: true },
  ]));
  assert.deepEqual(auditCompiledStory(compiled).failures, []);

  const rawMissing = {
    commandCount: 2,
    commands: [
      { i: 0, cmd: "Talk", raw: ADV_COMMAND.indexOf("Talk"), AdvTextID: "t1", TargetName: "a" },
      { i: 1, cmd: "Talk", raw: ADV_COMMAND.indexOf("Talk"), AdvTextID: "t2", TargetName: "b" },
    ],
    text: { t1: { "zh-Hans": "……？！" }, t2: { "zh-Hans": "内心独白。" } },
    sounds: {}, cuesheets: {},
  };
  const missingBoth = auditCompiledStory({
    episode: rawMissing,
    script: { beats: [{ say: "a", text: "……？！" }, { say: "b", text: "内心独白。", thought: true }] },
  });
  assert.equal(missingBoth.failures.filter((f) => f.code === "missingIgnoreLipSync").length, 2);
});

test("close bursts over 3 lines and off-band speakers under Track/close fail", () => {
  const longClose = compiledOf(scene([
    { scene: "garden", positions: { a: "left", b: "right" } },
    { say: "a", text: "One.", camera: "close", focus: "a" },
    { say: "a", text: "Two." },
    { say: "a", text: "Three." },
    { say: "a", text: "Four." },
  ]));
  assert.ok(auditCompiledStory(longClose).failures.some((f) => f.code === "closeBurstUnrecovered"));

  const endingShortClose = compiledOf(scene([
    { scene: "garden", positions: { a: "left", b: "right" } },
    { say: "b", text: "Start." },
    { say: "a", text: "End one.", camera: "close", focus: "a" },
    { say: "a", text: "End two." },
  ]));
  assert.deepEqual(auditCompiledStory(endingShortClose).failures, []);

  const offBand = compiledOf(scene([
    { scene: "garden", positions: { a: "far-left", b: "far-right" }, focus: "a", track: 0.5 },
    { say: "a", text: "I am in frame." },
    { say: "b", text: "I am outside the central band." },
  ]));
  assert.ok(auditCompiledStory(offBand).failures.some((f) => f.code === "speakerOutsideCentralBand" && f.target === "b"));
});

test("unclosed DoF, Role, Tilt, Brightness, Frame, PostEffect, CameraShake and Look fail audit", () => {
  const row = (i, cmd, fields = {}) => ({ i, cmd, raw: ADV_COMMAND.indexOf(cmd), ...fields });
  const leaked = {
    commandCount: 11,
    commands: [
      row(0, "Stage", { TargetAssetName: "st/garden" }),
      row(1, "DoF", { Parameter1: "0.5", Duration: 1 }),
      row(2, "Role", { Parameter1: "8", Duration: 1 }),
      row(3, "Tilt", { Parameter1: "4", Duration: 1 }),
      row(4, "Brightness", { CanvasLayers: [0], Parameter1: "0.5", Duration: 1 }),
      row(5, "Frame", { TargetAssetName: "adv_frame_fog", Parameter2: "Show_anime" }),
      row(6, "PostEffect", { TargetAssetName: "adv_effect_posteffect_reminiscence1" }),
      row(7, "CameraShake", { Parameter2: "0.5" }),
      row(8, "Look", { TargetName: "a", Parameter1: "0.4", Duration: 0.4 }),
      row(9, "Talk", { AdvTextID: "t1", TargetName: "a" }),
      row(10, "Stage", { TargetAssetName: "st/garden" }),
    ],
    text: { t1: { "zh-Hans": "对白。" } },
    sounds: {}, cuesheets: {},
  };
  const failures = auditCompiledStory({ episode: leaked }).failures.filter((f) => f.code === "unclosedEffect");
  const cmds = new Set(failures.map((f) => f.cmd));
  for (const expectedCmd of ["DoF", "Role", "Tilt", "Brightness", "Frame", "PostEffect", "CameraShake", "Look"]) {
    assert.ok(cmds.has(expectedCmd), `missing unclosedEffect for ${expectedCmd}`);
  }
});

test("speakerOutsideCentralBand accounts for MoveToDirection and updated Focus.PositionType", () => {
  const spreadClose = compiledOf({
    ...scene([
      { scene: "garden", positions: { a: "left", b: "right" } },
      { say: "a", text: "先两个人。" },
      { positions: { a: "far-left", c: "center", b: "far-right" } },
      { say: "b", text: "我也加入了！", focus: "b", camera: "close", focusTargetHead: true },
      { say: "a", text: "我也特写！", focus: "a", camera: "close", focusTargetHead: true },
    ]),
    cast: { a: { model: "m_a", name: "Ann" }, b: { model: "m_b", name: "Bea" }, c: { model: "m_a", name: "Cat" } },
  });
  const bandFailures = auditCompiledStory(spreadClose).failures.filter((f) => f.code === "speakerOutsideCentralBand");
  assert.deepEqual(bandFailures, []);
});
