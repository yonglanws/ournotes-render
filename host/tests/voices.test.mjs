import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import {
  enrichVoiceAliases, hasVoiceReference, mergeVoiceLists, normalizeVoiceTable, validateVoices, voiceSummary,
} from "../tts/voices.js";
import { tmpDir } from "./helpers.mjs";

const issues = () => ({ errors: [], warnings: [] });

test("a voice table normalizes aliases, emotion references and rejects bad numbers", () => {
  const list = issues();
  const table = normalizeVoiceTable({
    defaultVoice: { refAudioPath: "/refs/default.wav", promptText: "default" },
    voices: [{
      name: "高松灯",
      aliases: ["灯", "高松灯", "tomori"],
      refAudioPath: "/refs/tomori.wav",
      promptText: "ともりです",
      promptLang: "ja",
      speedFactor: 1.1,
      temperature: 9,
      unknownField: true,
      emotions: [
        { label: "开心喜悦", refAudioPath: "/refs/tomori-happy.wav", promptText: "うれしい", speedFactor: 1.05 },
        { refAudioPath: "/refs/no-label.wav" },
      ],
    }],
  }, "voicesFile", list);
  assert.deepEqual(table.defaultVoice, { refAudioPath: "/refs/default.wav", promptText: "default" });
  assert.equal(table.voices.length, 1);
  const voice = table.voices[0];
  assert.equal(voice.name, "高松灯");
  assert.deepEqual(voice.aliases, ["灯", "tomori"]);
  assert.equal(voice.speedFactor, 1.1);
  assert.equal(voice.temperature, undefined, "an out-of-range number is dropped");
  assert.deepEqual(voice.emotions.map((e) => e.label), ["开心喜悦"]);
  assert.ok(list.warnings.some((w) => w.path === "voicesFile.voices[0].unknownField"));
  assert.ok(list.warnings.some((w) => w.path === "voicesFile.voices[0].temperature"));
  assert.ok(list.warnings.some((w) => w.path === "voicesFile.voices[0].emotions[1]"));
});

test("an inline entry overrides a file entry field by field and keeps its aliases", () => {
  const list = issues();
  const base = normalizeVoiceTable({
    voices: [{ name: "高松灯", aliases: ["灯"], refAudioPath: "/a.wav", promptText: "a",
               emotions: [{ label: "平静", refAudioPath: "/calm.wav" }] }],
  }, "file", list).voices;
  const extra = normalizeVoiceTable({
    voices: [{ name: "高松灯", aliases: ["tomori"], speedFactor: 1.2 }],
  }, "inline", list).voices;
  const merged = mergeVoiceLists(base, extra);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].refAudioPath, "/a.wav", "an omitted field keeps the file value");
  assert.equal(merged[0].speedFactor, 1.2);
  assert.deepEqual(merged[0].aliases, ["灯", "tomori"]);
  assert.equal(merged[0].emotions.length, 1);
});

test("voice aliases pick up the names of the matching character sheet", () => {
  const voices = [{ name: "高松灯", aliases: [], refAudioPath: "/a.wav" }];
  enrichVoiceAliases(voices, [{ name: "高松燈", aliases: ["高松燈", "燈", "tomori"], prompt: "..." }]);
  assert.deepEqual(voices[0].aliases, ["高松燈", "燈", "tomori"]);
});

test("config.yaml loads a voices.yaml file and an inline override", () => {
  const dir = tmpDir();
  const voicesFile = path.join(dir, "voices.yaml");
  fs.writeFileSync(voicesFile, [
    "defaultVoice:",
    "  refAudioPath: /refs/default.wav",
    "voices:",
    "  - name: 高松灯",
    "    aliases: [灯]",
    "    refAudioPath: /refs/tomori.wav",
    "  - name: 千早爱音",
    "    refAudioPath: /refs/anon.wav",
  ].join("\n"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, [
    "security: { allowPrivateServiceEndpoints: true }",
    "tts:",
    "  baseUrl: http://127.0.0.1:9880",
    `  voicesFile: ${JSON.stringify(voicesFile)}`,
    "  voices:",
    "    - name: 高松灯",
    "      speedFactor: 1.2",
  ].join("\n"));
  const cfg = loadConfig({ file });
  assert.equal(cfg.tts.voices.length, 2);
  assert.equal(cfg.tts.voices[0].name, "高松灯");
  assert.equal(cfg.tts.voices[0].refAudioPath, "/refs/tomori.wav");
  assert.equal(cfg.tts.voices[0].speedFactor, 1.2);
  assert.deepEqual(cfg.tts.voices[0].aliases, ["灯"]);
  assert.equal(cfg.tts.defaultVoice.refAudioPath, "/refs/default.wav");
  assert.deepEqual(voiceSummary(cfg.tts), {
    count: 2, defaultVoice: true, withOwnReference: 2, withLora: 0, missingReference: [], emotions: 0,
  });
});

test("the old AstrBot/flat TTS fields are errors with a migration hint", () => {
  const dir = tmpDir();
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, [
    "security: { allowPrivateServiceEndpoints: true }",
    "tts:",
    "  astrbotConfig: old.json",
    "  characters: []",
    "  defaultRefAudioPath: /old.wav",
    "  defaultPromptText: old",
  ].join("\n"));
  const cfg = loadConfig({ file });
  const paths = cfg.issues.errors.map((e) => e.path);
  assert.ok(paths.includes("tts.astrbotConfig"));
  assert.ok(paths.includes("tts.characters"));
  assert.ok(paths.includes("tts.defaultRefAudioPath"));
  assert.ok(paths.includes("tts.defaultPromptText"));
  assert.match(cfg.issues.errors.find((e) => e.path === "tts.characters").message, /tts\.voices/);
});

test("a voice without a reference is silent unless a default voice exists; required makes it a failure", () => {
  const list = issues();
  const tts = { enabled: true, baseUrl: "http://127.0.0.1:9880", voices: [{ name: "灯", emotions: [] }],
                defaultVoice: {}, required: false };
  validateVoices(tts, list);
  assert.ok(list.warnings.some((w) => w.path === "tts.defaultVoice"));
  const required = issues();
  validateVoices({ ...tts, required: true }, required);
  assert.ok(required.errors.some((e) => e.path === "tts.defaultVoice"));
});

test("Irodori fields normalize, including MSST field names and several reference clips", () => {
  const list = issues();
  const table = normalizeVoiceTable({
    voices: [{
      characterName: "晓山瑞希",
      loraAdapter: "/models/LoRA/晓山瑞希/lora_adapter",
      refAudioPath: "/refs/main.wav",
      refAudioPaths: ["/refs/a.wav", " /refs/b.wav ", ""],
      caption: "落ち着いた、穏やかな口調で話している。",
      speed: 0.95,
      numSteps: 32,
      emotions: [
        { emotion: "开心", caption: "明るく話している。", speed: 1.1, refAudioPaths: "/refs/happy.wav" },
        { emotion: "  ", caption: "no label" },
      ],
    }],
  }, "voices", list);
  assert.deepEqual(list.errors, []);
  assert.equal(table.voices.length, 1);
  const voice = table.voices[0];
  assert.equal(voice.name, "晓山瑞希", "characterName is accepted as name");
  assert.equal(voice.loraAdapter, "/models/LoRA/晓山瑞希/lora_adapter");
  assert.deepEqual(voice.refAudioPaths, ["/refs/a.wav", "/refs/b.wav"]);
  assert.equal(voice.caption, "落ち着いた、穏やかな口調で話している。");
  assert.equal(voice.speed, 0.95);
  assert.equal(voice.numSteps, 32);
  assert.equal(voice.emotions.length, 1, "an emotion entry without a label is dropped");
  assert.equal(voice.emotions[0].label, "开心", "emotion is accepted as label");
  assert.deepEqual(voice.emotions[0].refAudioPaths, ["/refs/happy.wav"]);
  assert.equal(voice.emotions[0].speed, 1.1);
});

test("refAudioPaths counts as a reference and warns only when the provider ignores it", () => {
  const voices = [{ name: "瑞希", refAudioPaths: ["/a.wav"], emotions: [] }];
  assert.equal(hasVoiceReference(voices[0]), true);
  const summary = voiceSummary({ voices, defaultVoice: {} });
  assert.equal(summary.withOwnReference, 1);
  assert.deepEqual(summary.missingReference, []);
  const gsv = issues();
  validateVoices({ enabled: true, provider: "gpt-sovits", baseUrl: "http://127.0.0.1:9880", voices,
                   defaultVoice: {} }, gsv);
  assert.ok(gsv.warnings.some((w) => /refAudioPaths/.test(w.message)));
  const irodori = issues();
  validateVoices({ enabled: true, provider: "irodori", baseUrl: "http://127.0.0.1:8088", voices,
                   defaultVoice: {} }, irodori);
  assert.ok(!irodori.warnings.some((w) => /refAudioPaths/.test(w.message)));
});
