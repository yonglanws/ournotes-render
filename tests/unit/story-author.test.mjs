// The story author (scripts/story-author.mjs, scripts/lib/story-author/): the script format, its checks against a
// site, its compilation into story data, and the commands that need no browser, on a synthetic site.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  SCRIPT_FORMAT, applyFixes, checkScript, compileScript, cueLabel, fontFamily, freeSlot, layoutFix, lineGroups,
  modelActions, musicChoices, nearest, parseScript, plainText, resolveMotion, soundChoices, stageBackground,
  stageChoices, wrapText, withBrowserFonts,
} from "../../scripts/lib/story-author/script.js";
import { Site } from "../../scripts/lib/story-author/site.js";
import { compile } from "../../scripts/lib/json-schema.mjs";
import { fileFetch, nodeDecode } from "../../scripts/lib/headless.mjs";
import { StoryData } from "../../src/story/data.js";
import { Prefab } from "../../src/engine/prefab.js";
import { loadStoryStore } from "../../src/story/assets.js";
import { StoryPlayerCore } from "../../src/story/player-core.js";
import "../../src/story/features/index.js";
import { ModelObjects, mb, node, ref } from "./live2d-objects.mjs";
import { modelObjects, modelProduct, png, putFiles } from "./site-fixture.mjs";

const CLI = path.resolve("scripts/story-author.mjs");
const LT = String.fromCharCode(0xFF1C), WJ = String.fromCharCode(0x2060);

const MODELS = { m_a: "Character/Live2D/001_adv/m_a/model/m_a", m_b: "Character/Live2D/002_adv/m_b/model/m_b" };
const ACTIONS = {
  m_a: { motions: ["mtn_idle01_L", "mtn_idle01_C", "mtn_idle01_R", "mtn_smile01_L", "mtn_smile01_C", "mtn_nod01_C"],
         expressions: ["exp_idle01", "exp_smile01"], defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" },
  m_b: { motions: ["mtn_idle01_C"], expressions: ["exp_idle01"], defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" },
};
const EPISODE = {
  sounds: { 11: { _soundCueSheetID: 5, _cueName: "sound_bgm_adv_quiet_morning" },
            12: { _soundCueSheetID: 6, _cueName: "sound_se_adv_door_knock" },
            13: { _soundCueSheetID: 7, _cueName: "sound_bgm_adv_missing" } },
  cuesheets: { 5: { _cueSheetName: "sound_bgm_adv_quiet_morning" }, 6: { _cueSheetName: "sound_se_adv_door_knock" },
               7: { _cueSheetName: "sound_bgm_adv_missing" } },
  commands: [{ i: 0, cmd: "Stage", TargetAssetName: "st/garden" }, { i: 1, cmd: "Location", AdvTextID: "t1" },
             { i: 2, cmd: "Stage", TargetAssetName: "other/hall" }],
  text: { t1: { english: "<b>Garden</b>" } },
};
const STORY = { format: 1, advId: 9, episode: "episode.json", parts: {
  scene: "storyscenes/default.json", ui: { en: "storyui/en.json", ja: "storyui/ja.json" },
  fonts: { en: "storyfonts/9_en.json", ja: "storyfonts/9_ja.json" },
  models: { [MODELS.m_a]: "models/m_a.json" }, assets: { "Adv/Stage/st/garden": "storyassets/garden.json",
    "Adv/Stage/other/hall": "storyassets/other_hall.json", "Adv/Stage/st/hall": "storyassets/hall.json" },
  sounds: { sound_bgm_adv_quiet_morning: "cuesheets/sound_bgm_adv_quiet_morning.json",
            sound_se_adv_door_knock: "cuesheets/se.json" } } };
const BASE = { language: "en", languages: ["en", "ja"], story: STORY, episode: EPISODE,
               stages: stageChoices(STORY.parts.assets, EPISODE, "en"), music: musicChoices(EPISODE, STORY),
               sounds: soundChoices(EPISODE, STORY) };
const SITE = { base: BASE, models: MODELS, actions: ACTIONS, sounds: BASE.sounds };

const script = (beats, extra = {}) => ({
  format: SCRIPT_FORMAT, base: "stories/9.json", language: "en", title: "T",
  cast: { a: { model: "m_a", name: "Ann" }, b: { model: "m_b", name: "Bea" } }, beats, ...extra,
});
// a script through parse and check: {script, errors, warnings, language}
const checked = (doc) => {
  const p = parseScript(doc);
  const c = checkScript(p.script, { base: BASE, models: Object.keys(MODELS), actions: ACTIONS, sounds: BASE.sounds });
  return { script: p.script, errors: [...p.errors, ...c.errors], warnings: c.warnings, language: c.language };
};
const compiled = (doc) => {
  const c = checked(doc);
  assert.deepEqual(c.errors, []);
  return compileScript(c.script, SITE, c.language);
};
const strip = (rows) => rows.map(({ i, raw, ...r }) => r);
const codes = (list) => list.map((e) => [e.path, e.code]);

test("plain text shows as written in the talk window", () => {
  assert.equal(plainText("a<b>c</b>"), `a${LT}b>c${LT}/b>`);
  assert.equal(plainText("x\\ny"), `x\\${WJ}ny`);
  assert.equal(plainText("1\r\n2\r3"), "1\n2\n3");
  assert.equal(plainText(undefined), "");
  assert.equal(cueLabel("sound_bgm_adv_the_tender_light"), "The Tender Light");
});

test("the base story's stages with short ids and captions, its music and a stage's background", () => {
  assert.deepEqual(BASE.stages, [{ id: "garden", key: "st/garden", caption: "Garden" },
                                 { id: "other/hall", key: "other/hall", caption: "" },
                                 { id: "st/hall", key: "st/hall", caption: "" }]);
  assert.deepEqual(BASE.music, [{ cue: "sound_bgm_adv_quiet_morning", label: "Quiet Morning", sound: 11,
                                  sheet: "sound_bgm_adv_quiet_morning" }]);
  // only SE sheets whose sound files the base story has, with the cue and its sheet
  assert.deepEqual(BASE.sounds, [{ cue: "sound_se_adv_door_knock", label: "Door Knock", sound: 12,
                                   sheet: "sound_se_adv_door_knock" }]);
  const prefab = new Prefab({ nodes: [node("Stage", [mb("AdvStage", { _backgroundSprite: ref("test:1") })])] });
  assert.equal(stageBackground(prefab, { sprite: () => ({ texture: { id: "test:2" } }) }), "test:2");
  assert.equal(stageBackground(prefab, { sprite: () => null }), null);
});

test("soundChoices keeps the SE cues whose sheet has audio, several per sheet, without duplicates", () => {
  const episode = {
    sounds: {
      1: { _soundCueSheetID: 1, _cueName: "sound_se_adv_door_knock" },
      2: { _soundCueSheetID: 1, _cueName: "sound_se_adv_phone_buzz" },
      3: { _soundCueSheetID: 1, _cueName: "sound_se_adv_door_knock" },
      4: { _soundCueSheetID: 2, _cueName: "sound_se_adv_missing" },
      5: { _soundCueSheetID: 3, _cueName: "sound_bgm_adv_quiet" },
    },
    cuesheets: { 1: { _cueSheetName: "sound_se_adv_room" }, 2: { _cueSheetName: "sound_se_adv_missing" },
                 3: { _cueSheetName: "sound_bgm_adv_quiet" } },
  };
  const story = { parts: { sounds: { sound_se_adv_room: "cuesheets/room.json" } } };
  assert.deepEqual(soundChoices(episode, story), [
    { cue: "sound_se_adv_door_knock", label: "Door Knock", sound: 1, sheet: "sound_se_adv_room" },
    { cue: "sound_se_adv_phone_buzz", label: "Phone Buzz", sound: 2, sheet: "sound_se_adv_room" },
  ]);
});

test("official camera, gaze, motion and sound fields parse within their ranges", () => {
  const { script, errors } = parseScript({
    format: SCRIPT_FORMAT, base: "stories/10610.json",
    cast: { a: { model: "m", name: "A" } },
    beats: [
      { scene: "stage_a", positions: { a: "center" }, focusDuration: 1.5, trackDuration: 2, track: 0.2,
        se: "sound_se_adv_door_knock", seDelay: 0.2 },
      { say: "a", text: "……", zoom: 1.2, zoomDuration: 1.5, pedestal: -0.2, pedestalDuration: 1.5,
        pan: -5, panDuration: 1.5, panFocusSlide: 0.5, dof: 0.5, dofDuration: 1.5, dofLayers: 2,
        focusDuration: 1.5, trackDuration: 2, focus: 5, camera: "middle", track: 0.2,
        look: 0.3, lookY: -0.3, lookDuration: 0.5,
        se: "sound_se_adv_door_knock", seDuration: 0.7, motionFadeIn: 0.5, motionWait: true },
      { narrate: "Wind.", zoom: 0.7, pedestal: 5, pan: 30, dof: 0, dofLayers: 0 },
      { camera: "middle", cameraDuration: 3, focusDuration: 0, trackDuration: 20, track: 0.1, zoom: 2.5,
        pedestal: -4, pan: -30, dof: 1, se: "sound_se_adv_door_knock" },
      { action: "a", motion: "mtn_smile01", look: 1, lookY: 1, lookDuration: 10,
        seStop: true, motionFadeIn: -1, motionWait: false },
    ],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(script.warnings, []);
  assert.equal(script.beats[0].focusDuration, 1.5);
  assert.equal(script.beats[0].trackDuration, 2);
  assert.equal(script.beats[0].se, "sound_se_adv_door_knock");
  assert.equal(script.beats[0].seDelay, 0.2);
  assert.equal(script.beats[1].zoom, 1.2);
  assert.equal(script.beats[1].zoomDuration, 1.5);
  assert.equal(script.beats[1].pedestal, -0.2);
  assert.equal(script.beats[1].pan, -5);
  assert.equal(script.beats[1].panFocusSlide, 0.5);
  assert.equal(script.beats[1].dofLayers, 2);
  assert.equal(script.beats[1].look, 0.3);
  assert.equal(script.beats[1].lookY, -0.3);
  assert.equal(script.beats[1].se, "sound_se_adv_door_knock");
  assert.equal(script.beats[1].motionFadeIn, 0.5);
  assert.equal(script.beats[1].motionWait, true);
  assert.equal(script.beats[2].zoom, 0.7);
  assert.equal(script.beats[3].cameraDuration, 3);
  assert.equal(script.beats[3].focusDuration, 0);
  assert.equal(script.beats[3].trackDuration, 20);
  assert.equal(script.beats[4].seStop, true);
  assert.equal(script.beats[4].motionWait, false);
});

test("out-of-range and mutually exclusive official fields fail", () => {
  const { errors } = parseScript({
    format: SCRIPT_FORMAT, base: "stories/10610.json", cast: {},
    beats: [
      { camera: "middle", zoom: 3, pedestal: 6, pan: 31, dof: 1.1, dofDuration: 0.2, seDuration: 0.4 },
      { say: "a", text: "x", look: 0.3, lookAt: 5, seStop: true, se: "sound_se_door", dofLayers: 1 },
      { say: "a", text: "y", motionFadeIn: -2, motionWait: "yes" },
    ],
  });
  assert.ok(errors.some((e) => e.code === "range"));
  assert.ok(errors.some((e) => e.code === "exclusive"));
  for (const code of ["range", "exclusive", "type", "empty"]) assert.ok(errors.some((e) => e.code === code), code);
});

test("official modifier fields need the field they modify", () => {
  const { errors } = parseScript({
    format: SCRIPT_FORMAT, base: "stories/10610.json",
    cast: { a: { model: "m_a", name: "A" } },
    beats: [
      { scene: "garden", positions: { a: "left" }, seDuration: 1 },
      { say: "a", text: "x", seDelay: 0.2 },
      { say: "a", text: "y", panFocusSlide: 0.5, dofLayers: 2, pedestalDuration: 1 },
    ],
  });
  assert.deepEqual(codes(errors), [
    ["/beats/0/seDuration", "empty"], ["/beats/1/seDelay", "empty"],
    ["/beats/2/panFocusSlide", "empty"], ["/beats/2/dofLayers", "empty"], ["/beats/2/pedestalDuration", "empty"],
  ]);
});

test("a camera duration is the cameraDuration alias; both warn and cameraDuration wins", () => {
  const both = parseScript({
    format: SCRIPT_FORMAT, base: "stories/10610.json", cast: {},
    beats: [{ camera: "middle", duration: 1, cameraDuration: 2 }],
  });
  assert.deepEqual(both.errors, []);
  assert.equal(both.script.beats[0].cameraDuration, 2);
  assert.deepEqual(both.script.warnings.map((w) => [w.path, w.code]),
                   [["/beats/0/duration", "conflict"]]);
  const aliasOnly = parseScript({
    format: SCRIPT_FORMAT, base: "stories/10610.json", cast: {},
    beats: [{ camera: "middle", duration: 2 }],
  });
  assert.deepEqual(aliasOnly.errors, []);
  assert.equal(aliasOnly.script.beats[0].cameraDuration, 2);
  assert.deepEqual(aliasOnly.script.warnings, []);
});

test("a model's motions and expressions; the clip a motion plays at a position", () => {
  const o = new ModelObjects();
  const clips = ["mtn_idle01_C", "mtn_nod01_L"].map((name) => ref(o.clip({ name })));
  const actions = (components) => {
    const prefab = o.prefab([node("m", components)]);
    return modelActions(o.store({ prefab, moc: prefab, shaders: [], resources: {} }), { prefab });
  };
  assert.deepEqual(actions([mb("CubismModel"), mb("Live2DCharacter", { DefaultMotionName: "mtn_idle01_C", DefaultExpressionName: "exp_idle01",
                                                                       _motionList: clips, _expressionList: ["exp_idle01"] })]),
                   { motions: ["mtn_idle01_C", "mtn_nod01_L"], expressions: ["exp_idle01"], defaultMotion: "mtn_idle01_C",
                     defaultExpression: "exp_idle01" });
  assert.throws(() => actions([]), /Live2DCharacter/);
  const m = ACTIONS.m_a.motions;
  assert.equal(resolveMotion("mtn_smile01", 3, m), "mtn_smile01_L");
  assert.equal(resolveMotion("mtn_smile01", 9, m), "mtn_smile01_C");          // no _R: the centre one
  assert.equal(resolveMotion("mtn_idle01_R", 1, m), "mtn_idle01_R");          // a clip name plays as it is
  assert.equal(resolveMotion("mtn_gone01", 5, m), "");
  assert.equal(resolveMotion("", 5, m), "");
});

test("the shape of a script: every problem names its JSON pointer, unknown names come with the nearest", () => {
  const { errors } = parseScript({
    format: "x", base: "stories/9.json", langauge: "en", font: "comic",
    cast: { a: { model: "m_a", name: "Ann" }, "2x": { model: "m", name: "n" }, c: { model: "m_b" } },
    beats: [
      { scene: "garden", camera: "clos", positions: { a: "middle", b: { at: "left", mood: 1 } } },
      { say: "a", txt: "hi" }, { narate: "x" }, { narrate: " " }, { id: "x", narrate: "1" }, { id: "x", narrate: "2" }, 3,
    ],
  });
  assert.deepEqual(codes(errors), [
    ["/format", "format"], ["/langauge", "unknownKey"], ["/font", "unknownFont"], ["/cast/2x", "castId"],
    ["/cast/c/name", "missing"], ["/beats/0/camera", "unknownCamera"], ["/beats/0/positions/a", "unknownPosition"],
    ["/beats/0/positions/b/mood", "unknownKey"], ["/beats/1/txt", "unknownKey"], ["/beats/1/text", "missing"],
    ["/beats/2", "beatKind"], ["/beats/3/narrate", "empty"], ["/beats/5/id", "duplicateId"], ["/beats/6", "type"],
  ]);
  assert.equal(errors[1].suggestion, "language");
  assert.deepEqual(errors[5].expected, ["near", "middle", "far", "close", "very-close"]);
  assert.equal(errors[5].suggestion, "close");
  assert.deepEqual(errors[6].expected, ["far-left", "left", "center", "right", "far-right"]);
  assert.equal(errors[8].suggestion, "text");
  assert.deepEqual(parseScript([]).errors, [{ path: "", code: "type", message: "a script is a JSON object" }]);
  assert.deepEqual(parseScript({ format: SCRIPT_FORMAT, font: { family: "Serif X" } }).script.font, { family: "Serif X" });
  assert.equal(nearest("exp_smile1", ["exp_idle01", "exp_smile01"]), "exp_smile01");
  assert.equal(nearest("zzz", ["exp_idle01"]), null);
});

test("a script against its site: stages, music, models, motions, expressions and the staging", () => {
  const { errors, warnings } = checked(script([
    { say: "a", text: "before" },
    { scene: "gardn", music: "sound_bgm_x", positions: { a: "left", q: "right" } },
    { say: "a", text: "x", motion: "mtn_smil01", expression: "exp_smile1" },
    { say: "b", text: "y", expression: "exp_idle01" },
    { say: "b", text: "z" },
    { positions: { a: "center", b: { at: "center" } } },
  ], { language: "ko", cast: { a: { model: "m_a", name: "A" }, b: { model: "m_b", name: "B" }, z: { model: "m_gone", name: "Z" } } }));
  assert.deepEqual(codes(errors), [
    ["/language", "unknownLanguage"], ["/cast/z/model", "unknownModel"], ["/beats/0", "beforeScene"],
    ["/beats/1/scene", "unknownStage"], ["/beats/1/music", "unknownMusic"], ["/beats/1/positions/q", "unknownCast"],
    ["/beats/2/motion", "unknownMotion"], ["/beats/2/expression", "unknownExpression"], ["/beats/3", "offStage"],
    ["/beats/5/positions/b", "positionTaken"],
  ]);
  const by = Object.fromEntries(errors.map((e) => [e.path, e]));
  assert.equal(by["/beats/1/scene"].suggestion, "garden");
  assert.deepEqual(by["/beats/1/music"].expected, ["stop", "sound_bgm_adv_quiet_morning"]);
  assert.equal(by["/beats/2/motion"].suggestion, "mtn_smile01");
  assert.deepEqual(by["/beats/2/motion"].expected, ["mtn_idle01", "mtn_nod01", "mtn_smile01"]);
  assert.equal(by["/beats/2/expression"].suggestion, "exp_smile01");
  assert.match(by["/beats/2/expression"].message, /does not exist in m_a; did you mean "exp_smile01"\?/);
  assert.deepEqual(codes(warnings), [["/beats/0/say", "speakerOffStage"], ["/beats/4/say", "speakerOffStage"],
                                     ["/cast/z", "unusedCast"]]);
});

test("a scene compiles to the game's rows: stage, music, entrances, focus, caption, lines", () => {
  const c = compiled(script([
    { scene: "garden", music: "sound_bgm_adv_quiet_morning", location: "Garden", camera: "near",
      positions: { a: { at: "left", expression: "exp_smile01" }, b: "right" } },
    { id: "hi", say: "a", text: "Hi <you>", motion: "mtn_smile01" },
    { narrate: "Wind." },
    { say: "a", text: "Mm.", expression: "exp_idle01" },
  ]));
  assert.deepEqual(strip(c.episode.commands), [
    { cmd: "Character", TargetName: "a", TargetAssetName: "001_adv/m_a/model/m_a" },
    { cmd: "Character", TargetName: "b", TargetAssetName: "002_adv/m_b/model/m_b" },
    { cmd: "Stage", TargetAssetName: "st/garden" },
    { cmd: "Bgm", BgmID: 11, Parameter1: "1.5" },
    { cmd: "In", TargetName: "a", PositionType: 3, IsNoWait: 1, MotionName: "mtn_idle01_L", ExpressionName: "exp_smile01" },
    { cmd: "In", TargetName: "b", PositionType: 7, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 5, CameraDistance: 1 },
    { cmd: "Location", AdvTextID: "custom_location_0" },
    { cmd: "Motion", TargetName: "a", MotionName: "mtn_smile01_L", MotionFadeIn: -1, ExpressionName: "exp_smile01" },
    { cmd: "Talk", AdvTextID: "custom_line_1", TargetName: "a", TargetTextIDs: ["custom_name_a"], TargetTextColors: ["#FFFFFF"] },
    { cmd: "Talk", AdvTextID: "custom_line_2" },
    { cmd: "Expression", TargetName: "a", ExpressionName: "exp_idle01", MotionFadeIn: -1 },
    { cmd: "Talk", AdvTextID: "custom_line_3", TargetName: "a", TargetTextIDs: ["custom_name_a"], TargetTextColors: ["#FFFFFF"] },
  ]);
  const raw = { Character: 23, Stage: 25, Bgm: 15, In: 0, Focus: 7, Location: 20, Motion: 21, Talk: 2, Expression: 17 };
  for (const r of c.episode.commands) assert.equal(r.raw, raw[r.cmd]);
  assert.deepEqual(c.episode.commands.map((r) => r.i), c.episode.commands.map((_, i) => i));
  assert.deepEqual(c.episode.text.custom_line_1, { english: `Hi ${LT}you>` });
  assert.deepEqual(c.episode.text.custom_name_a, { english: "Ann" });
  assert.deepEqual(c.episode.text.custom_location_0, { english: "Garden" });
  assert.deepEqual(c.episode.title, { english: "T" });
  assert.equal(c.episode.master._titleTextId, "custom_title");
  assert.deepEqual(c.episode.sounds, { 11: EPISODE.sounds[11] });
  assert.deepEqual(c.episode.cuesheets, { 5: EPISODE.cuesheets[5] });
  assert.deepEqual(c.story.parts.sounds, { sound_bgm_adv_quiet_morning: "cuesheets/sound_bgm_adv_quiet_morning.json" });
  assert.deepEqual(c.story.parts.models, { [MODELS.m_a]: "m_a", [MODELS.m_b]: "m_b" });
  assert.deepEqual(c.story.parts.ui, STORY.parts.ui);
  assert.deepEqual(c.story.parts.videos, {});
  assert.deepEqual(c.lines, [
    { line: 0, beat: 1, path: "/beats/1", id: "hi", speaker: "a", name: "Ann", text: "Hi <you>" },
    { line: 1, beat: 2, path: "/beats/2", speaker: null, name: "", text: "Wind." },
    { line: 2, beat: 3, path: "/beats/3", speaker: "a", name: "Ann", text: "Mm." },
  ]);
  assert.equal(c.episode.commandCount, c.episode.commands.length);
});

test("a second scene fades out, clears the stage and fades in; a positions beat moves characters", () => {
  const c = compiled(script([
    { scene: "garden", positions: { a: "left", b: "right" } },
    { positions: { a: "center", b: { at: "right", expression: "exp_idle01" } }, camera: "far" },
    { say: "b", text: "Here." },
    { scene: "st/hall", music: "stop", positions: { b: "center" } },
    { say: "b", text: "Again." },
  ], { title: "" }));
  assert.deepEqual(strip(c.episode.commands).slice(2), [
    { cmd: "Stage", TargetAssetName: "st/garden" },
    { cmd: "In", TargetName: "a", PositionType: 3, IsNoWait: 1, MotionName: "mtn_idle01_L" },
    { cmd: "In", TargetName: "b", PositionType: 7, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 5, CameraDistance: 2 },
    // each Out waits for its fade, then the entrance on the new position
    { cmd: "Out", TargetName: "a", PositionType: 3, Duration: 0.2 },
    { cmd: "In", TargetName: "a", PositionType: 5, Duration: 0.2, IsNoWait: 1 },
    { cmd: "Expression", TargetName: "b", ExpressionName: "exp_idle01", MotionFadeIn: -1 },
    { cmd: "Focus", PositionType: 6, CameraDistance: 3, Duration: 0.5, IsNoWait: 1 },
    { cmd: "Talk", AdvTextID: "custom_line_2", TargetName: "b", TargetTextIDs: ["custom_name_b"], TargetTextColors: ["#FFFFFF"] },
    { cmd: "FadeOut", Duration: 1 },
    { cmd: "Out", TargetName: "a", PositionType: 5 },
    { cmd: "Out", TargetName: "b", PositionType: 7 },
    { cmd: "Stage", TargetAssetName: "st/hall" },
    { cmd: "In", TargetName: "b", PositionType: 5, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 5, CameraDistance: 2 },
    { cmd: "FadeIn", Duration: 1 },
    { cmd: "Talk", AdvTextID: "custom_line_4", TargetName: "b", TargetTextIDs: ["custom_name_b"], TargetTextColors: ["#FFFFFF"] },
  ]);
  assert.equal(c.episode.title, null);
  assert.equal(c.episode.master._titleTextId, "");
  assert.deepEqual(c.episode.sounds, {});                  // music stopped while none plays: no row
  assert.equal(c.scenes, 2);
});

test("director beats compile to focus, timed actions, fades, pauses and silent acting", () => {
  const c = compiled(script([
    { scene: "garden", camera: "far", focus: "a", positions: { a: "left", b: "right" } },
    { say: "a", text: "Look.", focus: "b", camera: "near", motion: "mtn_smile01",
      actions: [{ at: 0.45, cast: "b", expression: "exp_idle01" }, { at: 0.6, cast: "a", lookAt: "b" }] },
    { action: "b", expression: "exp_idle01", lookAt: "a", duration: 0.4 },
    { fade: "out", duration: 0.8 },
    { pause: 0.5 },
    { camera: "far", focus: "a", duration: 1 },
    { scene: "st/hall", positions: { b: "center" } },
    { narrate: "Wind.", actions: [{ at: 0.5, cast: "b", expression: "exp_idle01" }] },
  ]));
  assert.deepEqual(strip(c.episode.commands).slice(2), [
    { cmd: "Stage", TargetAssetName: "st/garden" },
    { cmd: "In", TargetName: "a", PositionType: 3, IsNoWait: 1, MotionName: "mtn_idle01_L" },
    { cmd: "In", TargetName: "b", PositionType: 7, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 3, CameraDistance: 3 },
    // the line's own camera (a wider distance eases back over 1.2 s), then the speaker's motion and the reactions
    { cmd: "Focus", PositionType: 7, CameraDistance: 1, Duration: 1.2, IsNoWait: 1 },
    { cmd: "Motion", TargetName: "a", MotionName: "mtn_smile01_L", MotionFadeIn: -1 },
    { cmd: "Talk", AdvTextID: "custom_line_1", TargetName: "a", TargetTextIDs: ["custom_name_a"], TargetTextColors: ["#FFFFFF"],
      HostActions: [{ at: 0.45, TargetName: "b", MotionFadeIn: 0.15, ExpressionName: "exp_idle01" },
                    { at: 0.6, TargetName: "a", MotionFadeIn: 0.15, LookTargetPosition: 7 }] },
    // a silent reaction shot, then the transitions
    { cmd: "Expression", TargetName: "b", ExpressionName: "exp_idle01", MotionFadeIn: -1 },
    { cmd: "LookTarget", TargetName: "b", PositionType: 3, Duration: 0.2, IsNoWait: 1 },
    { cmd: "Delay", Duration: 0.4 },
    { cmd: "FadeOut", Duration: 0.8 },
    { cmd: "Delay", Duration: 0.5 },
    { cmd: "Focus", PositionType: 3, CameraDistance: 3, Duration: 1, IsNoWait: 1 },
    // the second scene: fade, clear, stage, entrance, focus, fade in
    { cmd: "FadeOut", Duration: 1 },
    { cmd: "Out", TargetName: "a", PositionType: 3 },
    { cmd: "Out", TargetName: "b", PositionType: 7 },
    { cmd: "Stage", TargetAssetName: "st/hall" },
    { cmd: "In", TargetName: "b", PositionType: 5, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 5, CameraDistance: 2 },
    { cmd: "FadeIn", Duration: 1 },
    { cmd: "Talk", AdvTextID: "custom_line_7",
      HostActions: [{ at: 0.5, TargetName: "b", MotionFadeIn: 0.15, ExpressionName: "exp_idle01" }] },
  ]);
});

test("official close-ups: 2.8x and 4x, cut in, ease back, and a cast focus aims at its slot", () => {
  const c = compiled(script([
    { scene: "garden", camera: "middle", focus: 5, positions: { a: "left", b: "right" } },
    { say: "a", text: "One." },
    { say: "b", text: "Two.", focus: "b", camera: "close" },          // 2 -> 4: hard cut to b's slot
    { say: "a", text: "Three.", focus: "a", camera: "close" },        // 4 -> 4 across: hard cut
    { say: "b", text: "Four.", focus: 5, camera: "middle" },          // 4 -> 2: ease back
    { say: "a", text: "Five.", focus: "b" },                          // 2 -> 2 across: 0.5 s pan
    { say: "b", text: "Six.", focus: "a", camera: "very-close" },     // 2 -> 5: hard cut
  ]));
  const focusRows = strip(c.episode.commands).filter((r) => r.cmd === "Focus");
  assert.deepEqual(focusRows, [
    { cmd: "Focus", PositionType: 5, CameraDistance: 2 },
    { cmd: "Focus", PositionType: 7, CameraDistance: 4, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 3, CameraDistance: 4, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 5, CameraDistance: 2, Duration: 1.2, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 7, CameraDistance: 2, Duration: 0.5, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 3, CameraDistance: 5, IsNoWait: 1 },
  ]);
});

test("a slow zoom compiles to a Zoom row, with the beat's duration or 1.5 s", () => {
  const c = compiled(script([
    { scene: "garden", camera: "middle", focus: 5, positions: { a: "left", b: "right" } },
    { say: "a", text: "One.", zoom: 1.06, zoomDuration: 4 },
    { say: "b", text: "Two.", zoom: 0.94 },
    { camera: "close", focus: "a", zoom: 1.1, duration: 2 },
  ]));
  const zoomRows = strip(c.episode.commands).filter((r) => r.cmd === "Zoom");
  assert.deepEqual(zoomRows, [
    { cmd: "Zoom", Parameter1: "1.06", Duration: 4, IsNoWait: 1 },
    { cmd: "Zoom", Parameter1: "0.94", Duration: 1.5, IsNoWait: 1 },
    { cmd: "Zoom", Parameter1: "1.1", Duration: 2, IsNoWait: 1 },
  ]);
  const bad = parseScript({ format: SCRIPT_FORMAT, base: "b", cast: {}, beats: [
    { say: "a", text: "x", zoom: 3 }, { say: "a", text: "y", zoomDuration: 3 },
  ] }).errors;
  assert.deepEqual(bad.map((e) => e.code), ["range", "empty"]);
});

test("a Track follows the Focus duration; cameraDuration is the no-Focus fallback", () => {
  const c = compiled(script([
    { scene: "garden", camera: "middle", focus: 5, positions: { a: "left", b: "right" } },
    { camera: "middle", focus: 5, cameraDuration: 3, focusDuration: 1, track: 0.5 },
    { say: "a", text: "Two.", track: 0.7, trackDuration: 2.5 },
    { say: "b", text: "Three.", track: 0.2 },
  ]));
  const rows = strip(c.episode.commands);
  assert.equal(rows.filter((r) => r.cmd === "Focus").length, 2, "the scene and the first camera beat");
  assert.equal(rows.filter((r) => r.cmd === "Track").length, 3);
  assert.deepEqual(rows.filter((r) => r.cmd === "Focus" || r.cmd === "Track").slice(1), [
    { cmd: "Focus", PositionType: 5, CameraDistance: 2, Duration: 1, IsNoWait: 1 },
    { cmd: "Track", Parameter1: "0.5", Duration: 1, IsNoWait: 1 },
    { cmd: "Track", Parameter1: "0.7", Duration: 2.5, IsNoWait: 1 },
    { cmd: "Track", Parameter1: "0.2", IsNoWait: 1 },
  ]);
});

test("a Track without a Focus row falls back to cameraDuration", () => {
  // A parsed camera beat always names a camera distance and therefore emits a Focus row; this guards the compiler's
  // fallback for a hand-built beat (the same shape a caller could construct before compiling).
  const doc = { format: SCRIPT_FORMAT, base: "b", language: "en", title: "", font: { preset: "sans" }, warnings: [],
    cast: [{ id: "a", model: "m_a", name: "Ann", path: "/cast/a" }],
    beats: [{ kind: "camera", index: 0, path: "/beats/0", focus: "", track: 0.5, cameraDuration: 2.5 }] };
  assert.deepEqual(strip(compileScript(doc, SITE, "en").episode.commands), [
    { cmd: "Track", Parameter1: "0.5", Duration: 2.5, IsNoWait: 1 },
  ]);
});

test("a look needs its speaker on stage", () => {
  const { errors } = checked(script([
    { scene: "garden", positions: { b: "right" } },
    { say: "a", text: "Off.", look: 0.2 },
  ]));
  assert.deepEqual(codes(errors), [["/beats/1", "offStage"]]);
});

test("official camera rows compile in deterministic order with their durations", () => {
  const c = compiled(script([
    { scene: "garden", camera: "middle", focus: 5, positions: { a: "left", b: "right" } },
    { camera: "middle", focus: "a", cameraDuration: 3, focusDuration: 1, track: 0.5, pedestal: -0.2,
      pan: -5, panFocusSlide: 0.5, dof: 0.5, dofLayers: 2, zoom: 1.2,
      se: "sound_se_adv_door_knock", seDuration: 0.7 },
    { say: "a", text: "One.", look: 0.3, lookY: -0.3, lookDuration: 0.4 },
  ]));
  assert.deepEqual(strip(c.episode.commands).slice(2), [
    { cmd: "Stage", TargetAssetName: "st/garden" },
    { cmd: "In", TargetName: "a", PositionType: 3, IsNoWait: 1, MotionName: "mtn_idle01_L" },
    { cmd: "In", TargetName: "b", PositionType: 7, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 5, CameraDistance: 2 },
    // one Focus then one Track: the explicit Focus duration wins over cameraDuration for both
    { cmd: "Focus", PositionType: 3, CameraDistance: 2, Duration: 1, IsNoWait: 1 },
    { cmd: "Track", Parameter1: "0.5", Duration: 1, IsNoWait: 1 },
    // cameraDuration is the fallback for the rows that have no duration of their own
    { cmd: "Pedestal", Parameter1: "-0.2", Duration: 3, IsNoWait: 1 },
    { cmd: "PanV2", Parameter1: "-5", Duration: 3, IsNoWait: 1, Parameter3: "0.5" },
    // a character DoF names its on-stage target; both engines resolve PositionType, else TargetName
    { cmd: "DoF", Parameter1: "0.5", IsNoWait: 1, Duration: 3, CanvasLayers: [2],
      TargetName: "a", PositionType: 3 },
    { cmd: "Zoom", Parameter1: "1.2", Duration: 3, IsNoWait: 1 },
    { cmd: "Se", SeID: 12, Duration: 0.7 },
    // look is a say field: it follows the camera rows of the beat before it
    { cmd: "Look", TargetName: "a", Parameter1: "0.3", Parameter2: "-0.3", Duration: 0.4, IsNoWait: 1 },
    { cmd: "Talk", AdvTextID: "custom_line_2", TargetName: "a", TargetTextIDs: ["custom_name_a"],
      TargetTextColors: ["#FFFFFF"] },
  ]);
  const rows = c.episode.commands;
  const se = rows.find((r) => r.cmd === "Se");
  assert.equal(se.SeID, 12);
  assert.ok(c.episode.sounds[se.SeID]);
  assert.ok(c.episode.cuesheets[c.episode.sounds[se.SeID]._soundCueSheetID]);
  assert.ok(c.story.parts.sounds[c.episode.cuesheets[c.episode.sounds[se.SeID]._soundCueSheetID]._cueSheetName]);
  assert.equal(c.episode.commandCount, rows.length);
  assert.ok(rows.every((r, i) => r.i === i && Number.isInteger(r.raw) && r.raw >= 0));
});

test("motion fade/wait and a SE stop reach their rows", () => {
  const c = compiled(script([
    { scene: "garden", positions: { a: "left", b: "right" } },
    { say: "a", text: "One.", motion: "mtn_smile01", motionFadeIn: 0.5, motionWait: true },
    { action: "b", expression: "exp_idle01", motionFadeIn: 0.75, seStop: true },
  ]));
  assert.deepEqual(strip(c.episode.commands).slice(-4), [
    { cmd: "Motion", TargetName: "a", MotionName: "mtn_smile01_L", MotionFadeIn: 0.5, MotionWait: true },
    { cmd: "Talk", AdvTextID: "custom_line_1", TargetName: "a", TargetTextIDs: ["custom_name_a"],
      TargetTextColors: ["#FFFFFF"] },
    { cmd: "Se", Parameter1: "Stop" },
    { cmd: "Expression", TargetName: "b", ExpressionName: "exp_idle01", MotionFadeIn: 0.75 },
  ]);
});

test("character DoF rows always carry an on-stage target", () => {
  const c = compiled(script([
    { scene: "garden", positions: { a: "left", b: "right" } },
    { say: "a", text: "One.", dof: 0.4, dofLayers: 2 },
    { action: "b", expression: "exp_idle01", dof: 0.6 },
    { camera: "middle", focus: "b", dof: 0.5 },
    { camera: "middle", dof: 0.3 },
    { camera: "middle", focus: 5, dof: 0.2, dofLayers: 0 },
    { narrate: "Wind.", dof: 0.1 },
  ]));
  assert.deepEqual(strip(c.episode.commands).filter((r) => r.cmd === "DoF"), [
    { cmd: "DoF", Parameter1: "0.4", IsNoWait: 1, Duration: 1.5, CanvasLayers: [2],
      TargetName: "a", PositionType: 3 },
    { cmd: "DoF", Parameter1: "0.6", IsNoWait: 1, Duration: 1.5, TargetName: "b", PositionType: 7 },
    { cmd: "DoF", Parameter1: "0.5", IsNoWait: 1, Duration: 1.5, TargetName: "b", PositionType: 7 },
    // no explicit focus: the nearest on-stage character to the current shot is the target
    { cmd: "DoF", Parameter1: "0.3", IsNoWait: 1, Duration: 1.5, TargetName: "a", PositionType: 3 },
    // background-only DoF needs no character target
    { cmd: "DoF", Parameter1: "0.2", IsNoWait: 1, Duration: 1.5, CanvasLayers: [0] },
    { cmd: "DoF", Parameter1: "0.1", IsNoWait: 1, Duration: 1.5, TargetName: "a", PositionType: 3 },
  ]);
});

test("a character DoF needs an on-stage target", () => {
  const { errors, warnings } = checked(script([
    { scene: "garden", positions: {} },
    { camera: "middle", dof: 0.5 },
    { narrate: "Rain.", dof: 0.5 },
    { scene: "garden", positions: { a: "left", b: "right" } },
    { camera: "middle", focus: 5, dof: 0.5 },
    { camera: "middle", focus: "a", dof: 0.5 },
    { camera: "middle", focus: 5, dof: 0.5, dofLayers: 0 },
    { positions: { a: "left" } },
    { say: "b", text: "Off.", dof: 0.5 },
    { say: "b", text: "Off background.", dof: 0.5, dofLayers: 0 },
  ]));
  assert.deepEqual(codes(errors), [
    ["/beats/1/dof", "offStage"], ["/beats/2/dof", "offStage"], ["/beats/4/dof", "offStage"],
    ["/beats/8", "offStage"],
  ]);
  assert.ok(warnings.some((w) => w.code === "speakerOffStage" && w.path === "/beats/9/say"));
});

test("modifier fields need the field they modify", () => {
  const { errors } = parseScript({
    format: SCRIPT_FORMAT, base: "stories/10610.json",
    cast: { a: { model: "m_a", name: "A" } },
    beats: [
      { scene: "garden", positions: { a: "left" } },
      { say: "a", text: "a", focusDuration: 1 },
      { say: "a", text: "b", trackDuration: 1 },
      { say: "a", text: "c", panDuration: 1 },
      { say: "a", text: "d", dofDuration: 1 },
      { say: "a", text: "e", lookY: 0.1, lookDuration: 1 },
    ],
  });
  assert.deepEqual(codes(errors), [
    ["/beats/1/focusDuration", "empty"],
    ["/beats/2/trackDuration", "empty"],
    ["/beats/3/panDuration", "empty"],
    ["/beats/4/dofDuration", "empty"],
    ["/beats/5/lookY", "empty"], ["/beats/5/lookDuration", "empty"],
  ]);
});

test("normalized camera state decides the duration dependencies", () => {
  const ok = parseScript({
    format: SCRIPT_FORMAT, base: "stories/10610.json",
    cast: { a: { model: "m_a", name: "A" } },
    beats: [
      { scene: "garden", positions: { a: "left" }, focusDuration: 1 },
      { positions: { a: "left" }, focusDuration: 1 },
      { say: "a", text: "x", camera: { track: 0.5 }, trackDuration: 1 },
      { say: "a", text: "y", camera: { focus: "a" }, focusDuration: 1 },
    ],
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.script.beats[2].track, 0.5);
  assert.equal(ok.script.beats[2].trackDuration, 1);
});

test("a raw empty focus does not satisfy focusDuration", () => {
  const { errors } = parseScript({
    format: SCRIPT_FORMAT, base: "stories/10610.json",
    cast: { a: { model: "m_a", name: "A" } },
    beats: [
      { scene: "garden", positions: { a: "left" } },
      { say: "a", text: "x", focus: "", focusDuration: 1 },
      { say: "a", text: "y", focusDuration: 1 },
    ],
  });
  assert.deepEqual(codes(errors), [
    ["/beats/1/focusDuration", "empty"], ["/beats/2/focusDuration", "empty"],
  ]);
});

test("track, focus points and pre-line reactions compile to the game's continuous staging", () => {
  const c = compiled(script([
    { scene: "garden", camera: { distance: "far", focus: 5, track: 0.5 }, positions: { a: "left", b: "right" } },
    { say: "a", text: "Look.", focus: 2, camera: "middle", track: -0.3, motion: "mtn_smile01", lookAt: "b",
      actions: [{ at: 0, cast: "b", expression: "exp_idle01" }, { at: 0.5, cast: "a", lookAt: "b" }] },
    { positions: { b: "center" }, track: 0.2 },
  ]));
  assert.deepEqual(strip(c.episode.commands).slice(2), [
    { cmd: "Stage", TargetAssetName: "st/garden" },
    { cmd: "In", TargetName: "a", PositionType: 3, IsNoWait: 1, MotionName: "mtn_idle01_L" },
    { cmd: "In", TargetName: "b", PositionType: 7, IsNoWait: 1 },
    // the scene establishes a two-shot with a focus point between the two slots plus a pan
    { cmd: "Focus", PositionType: 5, CameraDistance: 3 },
    { cmd: "Track", Parameter1: "0.5", IsNoWait: 1 },
    // the line eases from the group to a focus point between far-left and left over 1.2 s, pans with it, reacts,
    // then speaks and looks over
    { cmd: "Focus", PositionType: 2, CameraDistance: 2, Duration: 1.2, IsNoWait: 1 },
    { cmd: "Track", Parameter1: "-0.3", Duration: 1.2, IsNoWait: 1 },
    { cmd: "Expression", TargetName: "b", ExpressionName: "exp_idle01", MotionFadeIn: -1 },
    { cmd: "Motion", TargetName: "a", MotionName: "mtn_smile01_L", MotionFadeIn: -1 },
    { cmd: "LookTarget", TargetName: "a", PositionType: 7, Duration: 0.2, IsNoWait: 1 },
    { cmd: "Talk", AdvTextID: "custom_line_1", TargetName: "a", TargetTextIDs: ["custom_name_a"], TargetTextColors: ["#FFFFFF"],
      HostActions: [{ at: 0.5, TargetName: "a", MotionFadeIn: 0.15, LookTargetPosition: 7 }] },
    // the group changes: the camera follows the new center and pans
    { cmd: "Out", TargetName: "a", PositionType: 3, Duration: 0.2 },
    { cmd: "Out", TargetName: "b", PositionType: 7, Duration: 0.2 },
    { cmd: "In", TargetName: "b", PositionType: 5, Duration: 0.2, IsNoWait: 1 },
    { cmd: "Focus", PositionType: 5, CameraDistance: 2, Duration: 0.5, IsNoWait: 1 },
    { cmd: "Track", Parameter1: "0.2", Duration: 0.5, IsNoWait: 1 },
  ]);
});

test("every motion and expression cross-fades from the pose on screen", () => {
  const c = compiled(script([
    { scene: "garden", positions: { a: "left", b: "right" } },
    { say: "a", text: "One.", motion: "mtn_smile01", expression: "exp_smile01",
      actions: [{ at: 0, cast: "a", motion: "mtn_nod01" }] },
    { positions: { a: { at: "left", motion: "mtn_nod01" }, b: "right" } },
    { action: "a", motion: "mtn_nod01" },
  ]));
  const animated = strip(c.episode.commands).filter((r) => r.cmd === "Motion" || r.cmd === "Expression");
  // the pre-line reaction, the speaker's motion, a staying position's motion and the silent action
  assert.equal(animated.length, 4);
  assert.ok(animated.every((r) => r.MotionFadeIn === -1), JSON.stringify(animated));
});

test("an SE cue is checked against the base story's sound files", () => {
  const { errors } = checked(script([
    { scene: "garden", positions: { a: "left" }, se: "sound_se_adv_nope" },
  ]));
  assert.deepEqual(codes(errors), [["/beats/0/se", "unknownSe"]]);
  assert.deepEqual(errors[0].expected, ["sound_se_adv_door_knock"]);
});

test("director names are checked: focus, actions and lookAt need a cast member on stage", () => {
  const { errors, warnings } = checked(script([
    { scene: "garden", positions: { a: "left", b: "right" } },
    { say: "a", text: "x", focus: "b", actions: [{ at: 0.5, cast: "b", expression: "exp_nope" }] },
    { action: "b", lookAt: "missing" },
    { say: "a", text: "y", actions: [{ at: 1.5, cast: "missing", motion: "mtn_smile01" }] },
  ]));
  assert.deepEqual(codes(errors), [
    ["/beats/3/actions/0/at", "range"],
    ["/beats/1/actions/0/expression", "unknownExpression"],
    ["/beats/2/lookAt", "unknownLookAt"],
    ["/beats/3/actions/0/cast", "unknownCast"],
  ]);
  assert.deepEqual(codes(warnings), []);
});

test("a script's problem names the fix that writes it in", () => {
  const { errors } = parseScript({
    format: SCRIPT_FORMAT, base: "b", cast: { a: { model: "m_a", name: "Ann" } },
    beats: [{ scene: "garden", positions: { a: "middle" } }, { id: "x", say: "a", txt: "hi" }, { id: "x", narrate: "no" },
            { narrate: "x", postions: {} }],
  });
  const by = Object.fromEntries(errors.map((e) => [e.path, e]));
  assert.deepEqual(by["/beats/1/txt"].fix, [{ op: "move", from: "/beats/1/txt", path: "/beats/1/text" }]);  // rename
  assert.equal(by["/beats/0/positions/a"].suggestion, undefined);    // "middle" is no near name for a position
  const camera = parseScript({ format: SCRIPT_FORMAT, base: "b", cast: {},
    beats: [{ scene: "garden", camera: "midle" }] }).errors.find((e) => e.code === "unknownCamera");
  assert.deepEqual(camera.fix, [{ op: "replace", path: "/beats/0/camera", value: "middle" }]);
  assert.deepEqual(by["/beats/2/id"].fix, [{ op: "replace", path: "/beats/2/id", value: "x_2" }]);         // free id
  assert.equal(by["/beats/3/postions"].suggestion, undefined);       // no near name in this beat's keys
  assert.equal(by["/beats/3/postions"].fix, undefined);              // and so no fix
  assert.deepEqual(by["/beats/3/postions"].expected,
                   ["id", "narrate", "focus", "camera", "track", "zoom", "zoomDuration", "focusDuration",
                    "trackDuration", "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide",
                    "dof", "dofDuration", "dofLayers", "actions"]);
  assert.equal(parseScript({ format: SCRIPT_FORMAT, zzz: 1 }).errors[0].fix, undefined);
  // a key whose near name is taken is left alone: renaming onto it would lose a value
  const taken = parseScript({ format: SCRIPT_FORMAT, base: "b", cast: {},
    beats: [{ scene: "garden", positions: { a: "left" }, psotions: {} }] }).errors.find((e) => e.code === "unknownKey");
  assert.equal(taken.suggestion, "positions");
  assert.equal(taken.fix, undefined);
  assert.equal(freeSlot(5, new Set([5])), "left");                   // the nearest free position, ties to the left
  assert.equal(freeSlot(5, new Set([5, 3])), "right");
  assert.equal(freeSlot(3, new Set([1, 3, 5, 7, 9])), null);
});

test("where the game wraps a line, and how its lines are cut into the window and spread over beats", () => {
  assert.deepEqual(wrapText("He said hello there.", ["He said hello ", "there."]), ["He said hello", "there."]);
  // the word joiner the talk window has after a "\", and a line feed of the text
  assert.deepEqual(wrapText("x\\\ny z", [`x\\${WJ}\n`, "y z"]), ["x\\", "y z"]);
  assert.deepEqual(wrapText("one two", ["one ", "two", ""]), ["one", "two", ""]);
  assert.equal(wrapText("one two", ["one ", "three"]), null);        // not this text
  assert.equal(wrapText("one two", []), null);
  assert.equal(wrapText("ab", ["a"]), null);

  // four lines of 60 px, 30 px apart: two lines stack 90 px, three 120, four 150
  const asc = [40, 10, -20, -50], desc = [-20, -50, -80, -110];
  assert.deepEqual(lineGroups(asc, desc, 150), [[0, 4]]);
  assert.deepEqual(lineGroups(asc, desc, 120), [[0, 2], [2, 4]]);    // three fit, but two and two are as few groups
  assert.deepEqual(lineGroups(asc, desc, 60), [[0, 1], [1, 2], [2, 3], [3, 4]]);
  assert.equal(lineGroups(asc, desc, 50), null);                     // a line alone is taller than the window
  assert.equal(lineGroups([], [], 30), null);
  // lines of 10, 10, 40 and 10 px: the even groups do not fit, so each group takes as many lines as fit
  assert.deepEqual(lineGroups([0, -10, -20, -60], [-10, -20, -60, -70], 45), [[0, 2], [2, 3], [3, 4]]);

  const a3 = asc.slice(0, 3), d3 = desc.slice(0, 3), beat = { say: "a", text: "one two three four" };
  const wrap = { lines: ["one two ", "three ", "four"], asc: a3, desc: d3 };
  // the window holds one line: the text stays on the beat and gets its own for each further line
  const fix = layoutFix({ beat, index: 2, wrap, heightLimit: 60 });
  assert.deepEqual(fix.texts, ["one two", "three", "four"]);
  assert.deepEqual(fix.fix, [{ op: "replace", path: "/beats/2/text", value: "one two" },
                             { op: "add", path: "/beats/3", value: { say: "a", text: "three" } },
                             { op: "add", path: "/beats/4", value: { say: "a", text: "four" } }]);
  // a narration's beats are narrations too; the window holding two lines, the second beat takes the rest
  const said = layoutFix({ beat: { narrate: "one two three four" }, index: 0, wrap, heightLimit: 90 });
  assert.deepEqual(said.fix, [{ op: "replace", path: "/beats/0/narrate", value: "one two\nthree" },
                              { op: "add", path: "/beats/1", value: { narrate: "four" } }]);
  // the window holds all three: the line breaks where the game wraps it
  assert.deepEqual(layoutFix({ beat, index: 0, wrap, heightLimit: 120 }).fix,
                   [{ op: "replace", path: "/beats/0/text", value: "one two\nthree\nfour" }]);
  assert.equal(layoutFix({ beat, index: 0, wrap: null, heightLimit: 120 }), null);
  assert.equal(layoutFix({ beat: { say: "a", text: "one\ntwo\nthree" }, index: 0,             // it fits as written
                           wrap: { lines: ["one\n", "two\n", "three"], asc: a3, desc: d3 }, heightLimit: 120 }), null);
  assert.equal(layoutFix({ beat, index: 0, wrap, heightLimit: 50 }), null);                     // a line is too tall
});

test("the fixes of a script's problems are applied, later beats first", () => {
  // a script with a mistyped stage, a mistyped beat key, a mistyped motion, a repeated beat id and a line that does
  // not fit the window
  const doc = script([
    { scene: "gardne", positions: { a: "center", b: "center" } },
    { say: "a", text: "One two three" },
    { id: "x", say: "a", txt: "Hi", motion: "mtn_smil01" },
    { id: "x", narrate: "The end." },
  ]);
  const c = checked(doc);
  assert.deepEqual(codes(c.errors), [["/beats/2/txt", "unknownKey"], ["/beats/2/text", "missing"],
                                     ["/beats/3/id", "duplicateId"], ["/beats/0/scene", "unknownStage"],
                                     ["/beats/0/positions/b", "positionTaken"], ["/beats/2/motion", "unknownMotion"]]);
  // the wrap of the first line's text and the room the window has
  const wrap = { lines: ["One two ", "three"], asc: [40, 10], desc: [-20, -50] };
  const layout = layoutFix({ beat: doc.beats[1], index: 1, wrap, heightLimit: 60 });
  const { script: fixed, applied, failed } = applyFixes(doc, [...c.errors, { path: "/beats/1", code: "textTooTall", fix: layout.fix }]);
  assert.deepEqual(failed, []);
  // what the fixed script checks as
  assert.deepEqual(checked(fixed).errors, []);
  assert.deepEqual(fixed.beats, [
    { scene: "garden", positions: { a: "center", b: "left" } },
    { say: "a", text: "One two" },
    { say: "a", text: "three" },
    { id: "x", say: "a", text: "Hi", motion: "mtn_smile01" },       // a renamed key keeps its place
    { id: "x_2", narrate: "The end." },
  ]);
  // later beats first, so that the beats the line's fix adds do not move the ones after it; a problem without a
  // fix (the missing text) is not among them
  assert.deepEqual(applied.map((a) => [a.path, a.code]), [["/beats/3/id", "duplicateId"], ["/beats/2/txt", "unknownKey"],
                                                          ["/beats/2/motion", "unknownMotion"], ["/beats/1", "textTooTall"],
                                                          ["/beats/0/scene", "unknownStage"],
                                                          ["/beats/0/positions/b", "positionTaken"]]);
  assert.deepEqual(doc.beats[2], { id: "x", say: "a", txt: "Hi", motion: "mtn_smil01" });  // the document is kept

  // a fix that cannot be applied is reported and left out; the others still go in
  const why = applyFixes({ beats: [{ say: "a", text: "x" }] }, [
    { path: "/beats/1/text", code: "textTooTall", fix: [{ op: "replace", path: "/beats/1/text", value: "y" }] },
    { path: "/beats/0", code: "other", fix: [{ op: "remove", path: "/beats/0" }] },
  ]);
  assert.deepEqual(why.applied, []);
  assert.deepEqual(why.failed.map((f) => [f.code, f.message]), [["textTooTall", "/beats/1/text does not exist"],
                                                               ["other", 'operation "remove" is not supported']]);
});

test("the compiled rows are commands the story player runs", () => {
  const ep = compiled(script([
    { scene: "garden", music: "sound_bgm_adv_quiet_morning", location: "L", positions: { a: "left" } },
    { positions: { a: "left", b: "right" } },
    { say: "a", text: "x", expression: "exp_smile01" },
    { scene: "st/hall", music: "stop" },
    { narrate: "end" },
  ])).episode;
  const settings = { _initializeEpisodes: [], _finalizeEpisodes: [] };
  const missing = StoryPlayerCore.requiredCommands(ep, settings).filter((c) => !StoryPlayerCore.supportedCommands().includes(c));
  assert.deepEqual(missing, []);
  StoryPlayerCore.checkEpisode(ep, settings, "story script");
});

test("browser fonts: every font asset drawn in the family, with room for its underlay", () => {
  const fonts = {
    source: "open",
    coverage: { characters: 1, missing: [], missingGlyph: ["x"] },
    fonts: {
      "F (G SDF)": { atlasPadding: 4, faceInfo: { m_PointSize: 40 }, characters: { 65: { glyph: 1 } }, glyphs: { 1: {} },
                     missingGlyph: { unicode: 9633, characters: [1] }, source: { generator: { margin: 8 } }, fallbacks: [] },
      "H (K SDF)": { atlasPadding: 9, faceInfo: { m_PointSize: 80 }, characters: {}, glyphs: {}, fallbacks: ["F (G SDF)"] },
    },
    materials: { "H (K SDF) - Shadow": { floats: { _UnderlayOffsetX: 0.5, _UnderlayOffsetY: -0.75 } } },
  };
  const out = withBrowserFonts(fonts, "Sans");
  assert.deepEqual(out.fonts["F (G SDF)"].browser, { family: "Sans", underlayOffset: 0.4 });
  assert.deepEqual(out.fonts["H (K SDF)"].browser, { family: "Sans", underlayOffset: 0.75 });
  assert.deepEqual(out.fonts["F (G SDF)"].characters, {});
  assert.deepEqual(out.fonts["F (G SDF)"].glyphs, {});
  assert.equal(out.fonts["F (G SDF)"].missingGlyph, undefined);
  assert.deepEqual(out.coverage, { characters: 0, missing: [] });
  assert.deepEqual(out.fonts["H (K SDF)"].fallbacks, ["F (G SDF)"]);
  assert.deepEqual(fonts.fonts["F (G SDF)"].characters, { 65: { glyph: 1 } });          // the input is kept
  assert.match(fontFamily({ preset: "sans" }, "zh-Hans"), /Noto Sans SC/);
  assert.match(fontFamily({ preset: "serif" }, "ja"), /Noto Serif JP/);
  assert.equal(fontFamily({ family: "\"My Font\", serif" }, "ko"), "\"My Font\", serif");
});

// ------------------------------------------------------------------------------------------------ a synthetic site

const FONTS = { format: "nnnotes.story-fonts/1", source: "open", language: "en", fonts: { "F SDF": { atlasPadding: 4, faceInfo: { m_PointSize: 40 },
  characters: { 65: { glyph: 1 } }, glyphs: { 1: {} }, fallbacks: [] } }, materials: {}, textures: {} };

// a site with the base story stories/9.json (format /2, languages en and ja) and the models m_a and m_b
const makeSite = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "story-author-test-"));
  const models = [];
  for (const id of ["m_a", "m_b"]) {
    const man = modelProduct(dir, modelObjects(id));
    fs.mkdirSync(path.join(dir, "models"), { recursive: true });
    fs.writeFileSync(path.join(dir, "models", `${id}.json`), JSON.stringify(man));
    models.push({ id, group: "g", key: man.subject, manifest: `models/${id}.json` });
  }
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ format: 2, models }));
  const product = (file, kind, subject, own, objects = {}, extra = {}) => {
    const manifest = { schema: "nnnotes.product/1", product: kind, subject, files: putFiles(dir, own), objects, ...extra };
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(manifest));
  };
  const story = structuredClone(STORY);
  delete story.parts.assets["Adv/Stage/other/hall"];
  story.parts.models = { "Character/Live2D/g/m_a/model/m_a": "models/m_a.json" };
  const o = new ModelObjects("stage"), texture = o.texture("background", { image: png(8, 4), width: 8, height: 4 });
  const sprite = o.add("Sprite", "background", { json: JSON.stringify({ sprite: { m_Name: "background" },
    renderData: { texture: ref(texture), uvTransform: { x: 1, y: 0, z: 1, w: 0 } } }) });
  const prefab = o.prefab([node("Stage", [mb("AdvStage", { _backgroundSprite: ref(sprite) })])]);
  const objects = Object.fromEntries(Object.entries(o.objects).map(([id, object]) => [id, { ...object, files: putFiles(dir, object.files) }]));
  for (const [key, file] of Object.entries(story.parts.assets)) product(file, "story.asset", key, { "asset.json": { format: 1, objects: [prefab] } }, objects);
  product(story.parts.scene, "story.scene", "default", { "scene.json": { format: 1, settings: {} } });
  for (const lang of ["en", "ja"]) {
    product(story.parts.ui[lang], "story.ui", lang, { "ui.json": { format: 1, language: { code: lang } } });
    product(story.parts.fonts[lang], "story.fonts", `9/${lang}`, { "fonts.json": { ...FONTS, language: lang } });
  }
  for (const [sheet, file] of Object.entries(story.parts.sounds)) product(file, "story.sound", sheet, { "cues.json": {} });
  product("stories/9.json", "story", "9", { "story.json": story, "episode.json": { ...EPISODE, advId: 9 } }, {}, { language: "en" });
  fs.writeFileSync(path.join(dir, "stories.json"), JSON.stringify({ format: "ournotes.stories/1", stories: [
    { id: "9", manifest: "stories/9.json", advId: 9, asset: "s", playbackMode: 0, titles: { en: "Base" }, groups: [],
      language: "en", languages: ["en", "ja"] },
    { id: "10", manifest: "stories/10.json", advId: 10, playbackMode: 1, titles: { en: "Overlay" }, groups: [] },
  ] }));
  return dir;
};

const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};

test("a site: base stories, the stories a script can use, models and their actions", async () => {
  const dir = makeSite();
  try {
    const site = new Site(dir);
    assert.deepEqual(site.stories().map((s) => s.id), ["9"]);                    // no Overlay episode
    const b = await site.base("stories/9.json", "ja");
    assert.equal(b.language, "ja");
    assert.deepEqual(b.languages, ["en", "ja"]);
    assert.deepEqual(b.stages.map((s) => [s.id, s.background]), [["garden", "stage:1"], ["hall", "stage:1"]]);
    assert.deepEqual(b.sounds, [{ cue: "sound_se_adv_door_knock", label: "Door Knock", sound: 12,
                                  sheet: "sound_se_adv_door_knock" }]);
    assert.deepEqual((await site.baseFiles(b, ["stage:1"])).get("stage:1"), png(8, 4));
    assert.deepEqual(b.cast, ["m_a"]);
    assert.equal(b.fonts.language, "ja");
    assert.deepEqual((await site.model("m_b")).actions,
                     { motions: ["mtn_idle"], expressions: ["exp_idle"], defaultMotion: "mtn_idle", defaultExpression: "exp_idle" });
    await assert.rejects(site.model("m_x"), /not in models.json/);
    await assert.rejects(site.base("stories/9.json", "ko"), /no ui for language ko/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a site without stories.json says so, and a manifest in the earlier format is named as one", () => {
  const dir = makeSite();
  try {
    fs.rmSync(path.join(dir, "stories.json"));
    let r = run(["bases", "--site", dir]);
    assert.equal(r.out.count, 0);
    assert.match(r.out.note, /no stories\.json/);
    fs.writeFileSync(path.join(dir, "stories", "old.json"), JSON.stringify({ advId: 1, files: {} }));
    r = run(["base", "stories/old.json", "--site", dir]);
    assert.equal(r.status, 1);
    assert.match(r.out.error, /earlier format/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the commands without a browser: new, check, build; the built story loads", async () => {
  const dir = makeSite();
  try {
    let r = run(["bases", "--site", dir]);
    assert.equal(r.status, 0);
    assert.deepEqual(r.out.bases.map((b) => b.manifest), ["stories/9.json"]);
    r = run(["base", "stories/9.json", "--site", dir]);
    assert.deepEqual(r.out.stages, [{ id: "garden", caption: "Garden" }, { id: "hall", caption: "" }]);
    assert.deepEqual(r.out.music, [{ cue: "sound_bgm_adv_quiet_morning", label: "Quiet Morning" }]);
    assert.deepEqual(r.out.sounds, [{ cue: "sound_se_adv_door_knock", label: "Door Knock" }]);
    r = run(["model", "m_a", "--site", dir]);
    assert.deepEqual(r.out.motions, [{ stem: "mtn_idle", sides: "" }]);

    r = run(["new", "stories/9.json", "--site", dir]);
    assert.equal(r.status, 0);
    const doc = r.out;
    assert.equal(doc.format, SCRIPT_FORMAT);
    assert.deepEqual(doc.cast, { c1: { model: "m_a", name: "c1" } });
    const file = path.join(dir, "s.json");
    doc.title = "Mine";
    doc.cast.b = { model: "m_b", name: "Bea" };
    doc.beats = [{ scene: "garden", music: "sound_bgm_adv_quiet_morning", positions: { c1: "left", b: "right" } },
                 { say: "b", text: "Hello", motion: "mtn_idle" }, { narrate: "The end." }];
    fs.writeFileSync(file, JSON.stringify(doc));
    r = run(["check", file, "--site", dir]);
    assert.equal(r.status, 0, JSON.stringify(r.out));
    assert.deepEqual({ ok: r.out.ok, lines: r.out.lines, scenes: r.out.scenes }, { ok: true, lines: 2, scenes: 1 });

    r = run(["build", file, "--site", dir, "--name", "mine"]);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out.manifest, "custom-stories/mine.json");
    const url = pathToFileURL(path.join(dir, "custom-stories", "mine.json")).href;
    const man = JSON.parse(fs.readFileSync(new URL(url), "utf8"));
    assert.equal(man.schema, "nnnotes.product/1");
    assert.equal(man.product, "story");
    assert.equal(man.language, "en");
    assert.deepEqual(Object.keys(man.files), ["episode.json", "story.json"]);
    const store = await loadStoryStore(url, { fetch: fileFetch, decode: nodeDecode }), data = new StoryData(store);
    const episodeSchema = compile(JSON.parse(fs.readFileSync(new URL("../../schema/episode.schema.json", import.meta.url), "utf8")));
    assert.deepEqual(episodeSchema(data.episode), []);
    assert.equal(data.episode.commands.filter((c) => c.cmd === "Talk").length, 2);
    assert.deepEqual(data.story.parts.models, { "Character/Live2D/g/m_a/model/m_a": "models/m_a.json", "Character/Live2D/g/m_b/model/m_b": "models/m_b.json" });
    assert.deepEqual(Object.keys(data.story.parts.sounds), ["sound_bgm_adv_quiet_morning"]);
    assert.deepEqual(data.fonts.fonts["F SDF"].browser.family.split(",")[0], "\"Noto Sans\"");
    assert.ok(store.has("models/m_b/model.json"));

    fs.writeFileSync(file, JSON.stringify({ ...doc, language: "ja", title: "" }));
    r = run(["build", file, "--site", dir, "--name", "japanese"]);
    assert.equal(r.status, 0, r.err);
    const japanese = new StoryData(await loadStoryStore(pathToFileURL(path.join(dir, r.out.manifest)).href,
      { fetch: fileFetch, decode: nodeDecode }));
    assert.equal(japanese.ui.language.code, "ja");
    assert.equal(japanese.fonts.language, "ja");
    assert.deepEqual(episodeSchema(japanese.episode), []);

    fs.writeFileSync(file, JSON.stringify({ ...doc, beats: [{ say: "b", text: "x" }] }));
    r = run(["check", file, "--site", dir]);
    assert.equal(r.status, 1);
    assert.deepEqual(codes(r.out.errors), [["/beats/0", "beforeScene"]]);
    r = run(["build", file, "--site", dir, "--name", "Bad Name"]);
    assert.equal(r.status, 2);
    assert.equal(run(["check", file, "--site", dir, "--nope"]).status, 2);

    // check --fix: the script with its fixes applied, checked again
    fs.writeFileSync(file, JSON.stringify({ ...doc, beats: [{ scene: "gardn", positions: { c1: "left", b: "left" } },
                                                            { say: "b", txt: "Hello" }] }));
    const fixedFile = path.join(dir, "fixed", "s.json");
    r = run(["check", file, "--site", dir, "--fix", fixedFile]);
    assert.equal(r.status, 1);
    assert.deepEqual(codes(r.out.errors), [["/beats/1/txt", "unknownKey"], ["/beats/1/text", "missing"],
                                           ["/beats/0/scene", "unknownStage"], ["/beats/0/positions/b", "positionTaken"]]);
    assert.deepEqual(r.out.fixed, { file: fixedFile, applied: [{ path: "/beats/1/txt", code: "unknownKey" },
      { path: "/beats/0/scene", code: "unknownStage" }, { path: "/beats/0/positions/b", code: "positionTaken" }],
      failed: [], ok: true, errors: 0, warnings: 0 });
    assert.deepEqual(JSON.parse(fs.readFileSync(fixedFile, "utf8")).beats,
                     [{ scene: "garden", positions: { c1: "left", b: "far-left" } }, { say: "b", text: "Hello" }]);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).beats[0].scene, "gardn");          // the script is kept
    assert.equal(run(["check", fixedFile, "--site", dir]).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
