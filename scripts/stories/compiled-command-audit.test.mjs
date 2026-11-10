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
  { scene: "garden", location: "Garden", focus: "a", track: 0.5, trackDuration: 1.5,
    positions: { a: "far-left", b: "far-right" },
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
  assert.equal(audit.counts.DoF, 1);
  assert.equal(audit.counts.Look, 1);
  assert.equal(audit.counts.Se, 2);
});

test("the audit carries the official parameter values and durations", () => {
  const audit = auditCompiledStory(officialScene());
  assert.deepEqual(audit.parameters.Zoom.parameter1, ["1.2"]);
  assert.deepEqual(audit.parameters.Zoom.durations, [1.5]);
  assert.deepEqual(audit.parameters.Pedestal.parameter1, ["-0.2"]);
  assert.deepEqual(audit.parameters.PanV2.parameter1, ["-5"]);
  assert.deepEqual(audit.parameters.DoF.parameter1, ["0.5"]);
  assert.deepEqual(audit.parameters.Look.parameter1, ["0.4"]);
  assert.deepEqual(audit.parameters.Look.parameter2, ["0.2"]);
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

test("a Talk HostActions timed look is rejected; a shot without one passes", () => {
  const compiled = officialScene();
  const episode = { ...compiled.episode, commands: compiled.episode.commands.map((row) => ({ ...row })) };
  const talk = episode.commands.find((row) => row.cmd === "Talk");
  talk.HostActions = [{ at: 0.5, TargetName: "a", LookTargetPosition: 3 }];
  const failures = auditCompiledStory({ ...compiled, episode }).failures;
  assert.ok(failures.some((failure) => failure.code === "hostActionsLook"));
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
  assert.equal(metrics.summary.dof, 1);
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
  const storyFile = path.join(dir, "story.json");
  writeFileSync(episodeFile, JSON.stringify(compiled.episode));
  writeFileSync(manifestFile, JSON.stringify({ requires: compiled.requires }));
  writeFileSync(storyFile, JSON.stringify(compiled.story));
  try {
    const missing = spawnSync(process.execPath, [cli, "--episode", episodeFile], { encoding: "utf8" });
    assert.notEqual(missing.status, 0, "an unchecked command list must not exit 0");
    assert.match(`${missing.stdout}${missing.stderr}`, /--manifest|required-command/);
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
