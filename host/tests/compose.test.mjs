import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { composeWithVoices } from "../render/compile.js";
import { StoryCatalog } from "../story/catalog.js";
import { quietLogger, sineWav, tmpDir } from "./helpers.mjs";

const MODEL_KEY = "Character/Live2D/g/m_a/model/m_a";

const BASE = {
  language: "en", languages: ["en"],
  stages: [{ id: "garden", key: "st/garden", caption: "Garden" }],
  music: [{ cue: "sound_bgm_adv_quiet", label: "Quiet", sound: 11, sheet: "sound_bgm_adv_quiet" }],
  sounds: [{ cue: "sound_se_adv_door_knock", label: "Door Knock", sound: 12, sheet: "sound_se_adv_door_knock" }],
  story: { format: 1, advId: 9, episode: "episode.json", parts: {
    scene: "storyscenes/default.json", ui: { en: "storyui/en.json" }, fonts: { en: "storyfonts/9_en.json" },
    models: { [MODEL_KEY]: "models/m_a.json" }, assets: { "Adv/Stage/st/garden": "storyassets/garden.json" },
    sounds: { sound_bgm_adv_quiet: "cuesheets/quiet.json", sound_se_adv_door_knock: "cuesheets/se.json" },
  } },
  episode: {
    advId: 9, commands: [{ i: 0, cmd: "Stage", TargetAssetName: "st/garden" }], text: {},
    sounds: { 11: { _soundCueSheetID: 5, _cueName: "sound_bgm_adv_quiet" },
              12: { _soundCueSheetID: 6, _cueName: "sound_se_adv_door_knock" } },
    cuesheets: { 5: { _cueSheetName: "sound_bgm_adv_quiet" }, 6: { _cueSheetName: "sound_se_adv_door_knock" } },
  },
};

const ACTIONS = { motions: ["mtn_idle01_C", "mtn_smile01_C"], expressions: ["exp_idle01", "exp_smile01"],
                  defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" };

const makeCatalog = () => {
  const cat = new StoryCatalog({ dir: tmpDir("ournotes-compose-"), logger: quietLogger() });
  cat._catalog = {
    manifest: "stories/9.json", language: "en", languages: ["en"],
    stages: BASE.stages, music: BASE.music.map((m) => ({ cue: m.cue, label: m.label })),
    sounds: BASE.sounds.map((s) => ({ cue: s.cue, label: s.label })),
    models: [{ id: "m_a", name: "Ann", character: "ann", group: "g", motions: ACTIONS.motions,
               expressions: ACTIONS.expressions, defaultMotion: ACTIONS.defaultMotion,
               defaultExpression: ACTIONS.defaultExpression, actionsKnown: true }],
  };
  cat.catalog = async () => cat._catalog;
  cat.site = {
    base: () => BASE,
    models: () => [{ id: "m_a", key: MODEL_KEY }],
    model: () => ({ actions: ACTIONS }),
    compose: async (base, compiled) => ({ manifest: { schema: "nnnotes.product/1", files: {}, parts: compiled.story.parts },
                                          assets: new Map() }),
  };
  return cat;
};

test("composeWithVoices compiles the raw script and attaches the TTS sound product", async () => {  const dir = tmpDir();
  const wav = path.join(dir, "line.wav");
  sineWav(wav, { seconds: 1 });
  const voices = new Map([[1, { file: wav, sampleRate: 48000, samples: 48000, channels: 1, cueName: "tts_line_1" }]]);
  const script = {
    format: "ournotes.story-script/1", base: "stories/9.json", language: "en", title: "T",
    cast: { a: { model: "m_a", name: "Ann" } },
    beats: [
      { scene: "garden", music: "sound_bgm_adv_quiet", positions: { a: "center" } },
      { say: "a", text: "Hello.", motion: "mtn_smile01" },
      { narrate: "The garden is quiet." },
    ],
  };
  const result = await composeWithVoices({ catalog: makeCatalog(), script, voices, language: "en", font: "sans-serif" });
  assert.deepEqual(result.errors, undefined);
  assert.equal(result.manifest.parts.sounds.ournotes_tts, "cuesheets/ournotes_tts.json");
  assert.ok(result.assets.has("cuesheets/ournotes_tts.json"));
  const talk = result.compiled.episode.commands.find((c) => c.cmd === "Talk" && c.AdvTextID === "custom_line_1");
  assert.deepEqual(talk.VoiceIDs, [900001]);
  assert.equal(talk.Parameter1, "airlipsync_voice");
  assert.equal(result.compiled.episode.sounds[900001]._category, 2);
});

test("composeWithVoices compiles SE rows and attaches their sound parts", async () => {
  const script = {
    format: "ournotes.story-script/1", base: "stories/9.json", language: "en", title: "T",
    cast: { a: { model: "m_a", name: "Ann" } },
    beats: [
      { scene: "garden", positions: { a: "center" } },
      { say: "a", text: "Hello.", se: "sound_se_adv_door_knock", seDuration: 0.7, seDelay: 0.2 },
    ],
  };
  const result = await composeWithVoices({ catalog: makeCatalog(), script, voices: new Map(), language: "en",
                                           font: "sans-serif" });
  assert.deepEqual(result.errors, undefined);
  const se = result.compiled.episode.commands.find((c) => c.cmd === "Se");
  assert.equal(se.SeID, 12);
  assert.equal(se.Duration, 0.7);
  assert.equal(se.DelaySeconds, 0.2);
  assert.deepEqual(result.compiled.episode.sounds[se.SeID], BASE.episode.sounds[12]);
  assert.ok(result.compiled.episode.cuesheets[6]);
  assert.equal(result.compiled.story.parts.sounds.sound_se_adv_door_knock, BASE.story.parts.sounds.sound_se_adv_door_knock);
});

test("composeWithVoices without voices leaves the story untouched", async () => {
  const script = {
    format: "ournotes.story-script/1", base: "stories/9.json", language: "en", title: "T",
    cast: { a: { model: "m_a", name: "Ann" } },
    beats: [{ scene: "garden", positions: { a: "center" } }, { say: "a", text: "Hi." }],
  };
  const result = await composeWithVoices({ catalog: makeCatalog(), script, voices: new Map(), language: "en",
                                           font: "sans-serif" });
  assert.equal(result.manifest.parts.sounds.ournotes_tts, undefined);
  assert.deepEqual(result.compiled.episode.sounds, {});
  assert.deepEqual(result.compiled.episode.cuesheets, {});
});
