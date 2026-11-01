import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildTtsProduct, injectVoices } from "../render/compile.js";
import { GptSovitsClient, VoiceBook, synthesizeStory } from "../tts/tts.js";
import { quietLogger, sineWav, tmpDir } from "./helpers.mjs";

const wav = (file) => sineWav(file, { seconds: 1 });

test("the TTS sound product has a manifest, cues.json and one WAV per line", () => {
  const dir = tmpDir();
  const file = path.join(dir, "line0.wav");
  wav(file);
  const voices = new Map([[0, { file, sampleRate: 48000, samples: 48000, channels: 1, cueName: "tts_line_0" }]]);
  const product = buildTtsProduct(voices);
  assert.equal(product.productPath, "cuesheets/ournotes_tts.json");
  const manifest = JSON.parse(product.files.get(product.productPath).toString("utf8"));
  assert.equal(manifest.schema, "nnnotes.product/1");
  assert.equal(manifest.product, "story.sound");
  assert.ok(manifest.files["tts_line_0.wav"]);
  assert.ok(manifest.files["cues.json"]);
  assert.ok(product.files.has(manifest.files["tts_line_0.wav"].asset));
  const cues = JSON.parse(product.files.get(manifest.files["cues.json"].asset).toString("utf8"));
  assert.equal(cues["tts_line_0.wav"].sampleRate, 48000);
  assert.equal(cues["tts_line_0.wav"].samples, 48000);
  assert.deepEqual(cues["tts_line_0.wav"].categories, ["Voice"]);
});

test("voice injection writes VoiceIDs and air lip sync into the compiled rows", () => {
  const dir = tmpDir();
  const a = path.join(dir, "a.wav"), b = path.join(dir, "b.wav");
  wav(a); wav(b);
  const voices = new Map([
    [0, { file: a, sampleRate: 48000, samples: 48000, channels: 1, cueName: "tts_line_0" }],
    [1, { file: b, sampleRate: 48000, samples: 48000, channels: 1, cueName: "tts_line_1" }],
  ]);
  const compiled = {
    story: { parts: { sounds: { base_sheet: "cuesheets/base.json" } } },
    episode: {
      sounds: {}, cuesheets: {},
      commands: [
        { i: 0, cmd: "Talk", AdvTextID: "custom_line_0", TargetName: "a" },
        { i: 1, cmd: "Talk", AdvTextID: "custom_line_1" },
      ],
    },
  };
  const product = injectVoices({ compiled, voices });
  assert.equal(compiled.story.parts.sounds.ournotes_tts, "cuesheets/ournotes_tts.json");
  assert.equal(compiled.episode.cuesheets[900001]._cueSheetName, "ournotes_tts");
  assert.deepEqual(compiled.episode.commands[0].VoiceIDs, [900000]);
  assert.equal(compiled.episode.commands[0].Parameter1, "airlipsync_voice");
  assert.deepEqual(compiled.episode.commands[1].VoiceIDs, [900001]);
  assert.equal(compiled.episode.commands[1].Parameter1, undefined);
  assert.equal(compiled.episode.sounds[900000]._cueName, "tts_line_0");
  assert.equal(compiled.episode.sounds[900000]._category, 2);
  assert.ok(product.files.size >= 3);
});

test("character voices match by full or short name", () => {
  const book = new VoiceBook({ voices: [{ name: "高松燈", refAudioPath: "/tomori.wav" },
                                        { name: "長崎そよ", refAudioPath: "/soyo.wav" }],
                               defaultVoice: { refAudioPath: "/default.wav" }, promptLang: "ja" });
  assert.equal(book.resolve("燈").refAudioPath, "/tomori.wav");
  assert.equal(book.resolve("高松燈").refAudioPath, "/tomori.wav");
  assert.equal(book.resolve("そよ").refAudioPath, "/soyo.wav");
  assert.equal(book.resolve("unknown").refAudioPath, "/default.wav");
  assert.equal(book.resolve("unknown").matched, false);
  assert.equal(book.resolve("燈").matched, true);
});

test("an emotion mapping can override the reference or only pacing", () => {
  const book = new VoiceBook({
    voices: [{ name: "灯", refAudioPath: "/base.wav", promptText: "base",
               emotions: [{ label: "开心", refAudioPath: "/happy.wav", promptText: "happy", speedFactor: 1.1 }] }],
    defaultVoice: { refAudioPath: "/default.wav" }, promptLang: "ja", speedFactor: 1, temperature: 1,
    emotion: { presets: [{ label: "低落", speedFactor: 0.9, temperature: 0.8 }] },
  });
  const happy = book.resolveFor("开心", ["灯"]);
  assert.equal(happy.refAudioPath, "/happy.wav");
  assert.equal(happy.promptText, "happy");
  assert.equal(happy.speedFactor, 1.1);
  const sad = book.resolveFor("低落", ["灯"]);
  assert.equal(sad.refAudioPath, "/base.wav", "a preset without a reference keeps the character's reference");
  assert.equal(sad.speedFactor, 0.9);
  assert.equal(sad.temperature, 0.8);
  assert.equal(book.resolve("灯").refAudioPath, "/base.wav", "no emotion uses the normal voice");
});

test("the GPT-SoVITS client sends api_v2 fields and caches by text and voice", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "src.wav");
  wav(src);
  const bytes = fs.readFileSync(src);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return new Response(bytes, { status: 200, headers: { "content-type": "audio/wav" } });
  };
  try {
    const client = new GptSovitsClient({
      enabled: true, baseUrl: "http://127.0.0.1:9880", textLang: "ja", promptLang: "ja", speedFactor: 1,
      topK: 5, topP: 1, temperature: 1, repetitionPenalty: 1.35, mediaType: "wav", timeoutMs: 5000,
    }, { logger: quietLogger() });
    client.setCacheDir(dir);
    const voice = { name: "tomori", refAudioPath: "/ref/tomori.wav", promptText: "hello", promptLang: "ja",
                    gptWeightsPath: "", sovitsWeightsPath: "", key: "tomori" };
    const a = await client.synthesize("こんにちは", voice);
    assert.equal(a.sampleRate, 48000);
    assert.equal(a.samples, 48000);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:9880/tts");
    assert.equal(calls[0].body.text, "こんにちは");
    assert.equal(calls[0].body.text_lang, "ja");
    assert.equal(calls[0].body.ref_audio_path, "/ref/tomori.wav");
    assert.equal(calls[0].body.prompt_text, "hello");
    const b = await client.synthesize("こんにちは", voice);
    assert.equal(b.file, a.file);
    assert.equal(calls.length, 1, "the second synthesis came from the cache");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("synthesis reports which voice spoke, which lines fell back, and which are silent", async () => {
  const script = {
    language: "ja",
    cast: [{ id: "a", model: "m_tomori", name: "灯" }, { id: "b", model: "m_anon", name: "爱音" }],
    beats: [
      { kind: "say", index: 0, speaker: "a", text: "こんにちは" },
      { kind: "say", index: 1, speaker: "b", text: "やあ" },
      { kind: "say", index: 2, speaker: "b", text: "またね" },
    ],
  };
  const catalog = { language: "ja", models: [{ id: "m_tomori", name: "高松灯" }, { id: "m_anon", name: "千早爱音" }] };
  const calls = [];
  const client = { synthesize: async (text, voice) => {
    calls.push({ text, voice: voice.name || "default" });
    return { file: `${text}.wav`, sampleRate: 48000, samples: 48000, channels: 1 };
  } };
  const base = {
    enabled: true, textLang: "ja", promptLang: "ja", concurrency: 1, retries: 0, translateForTts: false,
    voices: [{ name: "高松灯", refAudioPath: "/tomori.wav" }],
  };
  const logger = quietLogger();
  const withDefault = await synthesizeStory({
    script, catalog, client, llm: null, logger,
    config: { ...base, defaultVoice: { refAudioPath: "/default.wav" } },
    voiceBook: new VoiceBook({ ...base, defaultVoice: { refAudioPath: "/default.wav" } }),
  });
  assert.equal(withDefault.size, 3);
  assert.deepEqual(withDefault.report.voices, { default: 2, "高松灯": 1 });
  assert.equal(withDefault.report.fallbackLines, 2);
  assert.deepEqual(withDefault.report.fallbackSpeakers, ["爱音"]);
  assert.equal(withDefault.report.silentLines, 0);
  assert.deepEqual(calls.map((c) => c.voice), ["高松灯", "default", "default"], "the unknown character used the default");

  const silent = await synthesizeStory({
    script, catalog, client, llm: null, logger, config: { ...base, defaultVoice: {} },
    voiceBook: new VoiceBook({ ...base, defaultVoice: {} }),
  });
  assert.equal(silent.size, 1);
  assert.equal(silent.report.silentLines, 2);
  assert.deepEqual(silent.report.silentSpeakers, ["爱音"]);
});

test("a voice with GPT/SoVITS weights switches them through the server before TTS", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "src.wav");
  wav(src);
  const bytes = fs.readFileSync(src);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/set_")) return new Response('{"message":"success"}', { status: 200 });
    return new Response(bytes, { status: 200, headers: { "content-type": "audio/wav" } });
  };
  try {
    const client = new GptSovitsClient({
      enabled: true, baseUrl: "http://127.0.0.1:9880", textLang: "ja", promptLang: "ja", speedFactor: 1,
      topK: 5, topP: 1, temperature: 1, repetitionPenalty: 1.35, mediaType: "wav", timeoutMs: 5000,
    }, { logger: quietLogger() });
    client.setCacheDir(dir);
    const voice = { name: "tomori", refAudioPath: "/ref.wav", promptText: "hello", promptLang: "ja",
                    gptWeightsPath: "/g.ckpt", sovitsWeightsPath: "/s.pth", key: "tomori-weights" };
    await client.synthesize("こんにちは", voice);
    assert.deepEqual(calls.map((u) => u.split("/").pop().split("?")[0]),
                     ["set_gpt_weights", "set_sovits_weights", "tts"]);
    await client.synthesize("こんにちは", voice);
    assert.equal(calls.length, 3, "the cached line does not switch weights again");
  } finally {
    globalThis.fetch = realFetch;
  }
});
