import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Pipeline } from "../pipeline.js";
import { VoiceBook } from "../tts/tts.js";
import { quietLogger, sineWav, tmpDir } from "./helpers.mjs";

const CATALOG = {
  manifest: "stories/1.json", language: "zh-Hans", languages: ["zh-Hans"],
  stages: [{ id: "stage_a", caption: "教室" }], music: [],
  models: [{ id: "m_a", name: "灯", character: "tomori", group: "g", motions: ["mtn_idle01_C"],
             expressions: ["exp_idle01"], defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" }],
};

const SCRIPT = {
  format: "ournotes.story-script/1", base: "stories/1.json", language: "zh-Hans", title: "T",
  cast: { a: { model: "m_a", name: "灯" } },
  beats: [{ scene: "stage_a", positions: { a: "center" } }, { say: "a", text: "你好。" }],
};

const configFor = (output) => ({
  paths: { output, cache: output },
  story: { maxLines: 120, font: "sans", title: "" },
  tts: { enabled: false, concurrency: 1, textLang: "zh", promptLang: "ja", translateForTts: false, voices: [] },
  llm: { repairRounds: 0, pipeline: "single" },
  video: { width: 640, height: 360 },
});

const stubCatalog = () => ({
  async catalog() { return CATALOG; },
  async compose(script, { extraEpisode }) {
    const compiled = {
      story: { format: 1, parts: { sounds: {}, models: {}, assets: {} } },
      episode: {
        sounds: {}, cuesheets: {},
        commands: (script.beats || []).map((b, i) => (b && b.say
          ? { i, cmd: "Talk", AdvTextID: `custom_line_${i}`, TargetName: b.say }
          : null)).filter(Boolean),
      },
      lines: [],
    };
    extraEpisode?.(compiled);
    return { manifest: { schema: "nnnotes.product/1", files: {}, parts: compiled.story.parts }, assets: new Map(), compiled,
             language: "zh-Hans", warnings: [] };
  },
});

test("a supplied script is compiled, rendered and recorded", async () => {
  const output = tmpDir();
  let captured = null;
  const renderer = {
    async render({ story }) {
      captured = story;
      const file = path.join(output, "task-test.mp4");
      fs.writeFileSync(file, "video");
      return { output: file, report: { frames: 90, seconds: 1 }, duration: 3, audio: null, pageErrors: [] };
    },
  };
  const pipeline = new Pipeline({ config: configFor(output), catalog: stubCatalog(), llm: null, tts: null,
                                  renderer, logger: quietLogger() });
  const result = await pipeline.run({ script: SCRIPT }, { signal: null, jobId: "task-test", progress: () => {} });
  assert.equal(result.success, true);
  assert.equal(result.duration, 3);
  assert.equal(result.frameCount, 90);
  assert.equal(result.tts.voiced, 0);
  assert.ok(fs.existsSync(result.storyPath));
  const saved = JSON.parse(fs.readFileSync(result.storyPath, "utf8"));
  assert.equal(saved.script.title, "T");
  assert.ok(captured.manifest);
  assert.ok(captured.files instanceof Map);
  assert.equal(captured.language, "zh-Hans");
});

test("TTS voices become a sound product and VoiceIDs before rendering", async () => {
  const output = tmpDir();
  const wav = path.join(output, "line.wav");
  sineWav(wav, { seconds: 1 });
  let captured = null;
  const pipeline = new Pipeline({
    config: { ...configFor(output), tts: { enabled: true, concurrency: 1, textLang: "zh", promptLang: "ja",
                                          translateForTts: false, voices: [] } },
    catalog: stubCatalog(), llm: null,
    tts: {
      client: { async synthesize() { const b = fs.readFileSync(wav); return { file: wav, sampleRate: 48000,
        samples: 48000, channels: 1, bytes: b.length }; } },
      voiceBook: new VoiceBook({ voices: [], defaultVoice: { refAudioPath: "/ref.wav" }, promptLang: "ja" }),
    },
    renderer: {
      async render({ story }) {
        captured = story;
        const file = path.join(output, "task-tts.mp4");
        fs.writeFileSync(file, "video");
        return { output: file, report: { frames: 90, seconds: 1 }, duration: 3, audio: null, pageErrors: [] };
      },
    },
    logger: quietLogger(),
  });
  const result = await pipeline.run({ script: SCRIPT }, { signal: null, jobId: "task-tts", progress: () => {} });
  assert.equal(result.tts.voiced, 1);
  assert.equal(captured.manifest.parts.sounds.ournotes_tts, "cuesheets/ournotes_tts.json");
  assert.ok(captured.files.has("cuesheets/ournotes_tts.json"));
  const story = JSON.parse(fs.readFileSync(path.join(output, "task-tts.story.json"), "utf8"));
  assert.equal(story.tts.voiced, 1);
});

test("an invalid supplied script is rejected before rendering", async () => {
  const output = tmpDir();
  let rendered = false;
  const pipeline = new Pipeline({
    config: configFor(output), catalog: stubCatalog(), llm: null, tts: null,
    renderer: { async render() { rendered = true; return {}; } }, logger: quietLogger(),
  });
  await assert.rejects(
    () => pipeline.run({ script: { ...SCRIPT, beats: [{ say: "a", text: "x" }] } },
                       { signal: null, jobId: "bad", progress: () => {} }),
    (e) => e.status === 400 && e.code === "invalid_script");
  assert.equal(rendered, false);
});

test("a prompt without a configured LLM is refused with 503", async () => {
  const output = tmpDir();
  const pipeline = new Pipeline({
    config: configFor(output), catalog: stubCatalog(), llm: null, tts: null,
    renderer: { async render() { throw new Error("must not render"); } }, logger: quietLogger(),
  });
  await assert.rejects(
    () => pipeline.run({ prompt: "写点东西" }, { signal: null, jobId: "no-llm", progress: () => {} }),
    (e) => e.status === 503 && e.code === "llm_missing");
});

test("maxLines below two or non-integer is rejected before generation", async () => {
  const output = tmpDir();
  let calls = 0;
  const llm = { available: true, async json() { calls++; return { content: JSON.stringify(SCRIPT) }; } };
  const pipeline = new Pipeline({
    config: configFor(output), catalog: stubCatalog(), llm, tts: null,
    renderer: { async render() { throw new Error("must not render"); } }, logger: quietLogger(),
  });
  const badCap = (e) => e.status === 400 && e.code === "bad_request" &&
    /maxLines/.test(e.message) && /at least 2/.test(e.message);
  for (const maxLines of [1, 2.5]) {
    await assert.rejects(() => pipeline.generateScriptOnly({ prompt: "写一场对话", maxLines }), badCap);
    await assert.rejects(
      () => pipeline.run({ prompt: "写一场对话", maxLines }, { signal: null, jobId: "bad-max", progress: () => {} }),
      badCap);
  }
  assert.equal(calls, 0, "neither path reaches the LLM");
});

test("an AI job persists diagnostics without changing the public result fields", async () => {
  const output = tmpDir();
  const doc = { ...SCRIPT, beats: [...SCRIPT.beats, { say: "a", text: "今天也练习吧。" }] };
  const llm = { available: true, async json() { return { content: JSON.stringify(doc) }; } };
  const renderer = {
    async render() {
      const file = path.join(output, "task-ai.mp4");
      fs.writeFileSync(file, "video");
      return { output: file, report: { frames: 90, seconds: 1 }, duration: 3, audio: null, pageErrors: [] };
    },
  };
  const pipeline = new Pipeline({ config: configFor(output), catalog: stubCatalog(), llm, tts: null,
                                  renderer, logger: quietLogger() });
  const result = await pipeline.run({ prompt: "写一场对话" }, { signal: null, jobId: "task-ai", progress: () => {} });
  assert.equal(result.success, true);
  assert.deepEqual(result.diagnostics, { stages: null, plan: null, dialogue: null, usage: null });
  assert.equal(result.story.title, "T");
  const saved = JSON.parse(fs.readFileSync(result.storyPath, "utf8"));
  assert.deepEqual(saved.diagnostics, result.diagnostics);
  assert.equal(saved.script.title, "T");
  assert.equal(saved.tts.voiced, 0);
});

test("the AI stage can return a script without rendering", async () => {
  const output = tmpDir();
  const doc = { ...SCRIPT, beats: [...SCRIPT.beats, { narrate: "安静的夜晚。" }] };
  const llm = {
    available: true,
    async json() { return { content: JSON.stringify(doc) }; },
  };
  const pipeline = new Pipeline({
    config: configFor(output), catalog: stubCatalog(), llm, tts: null,
    renderer: { async render() { throw new Error("must not render"); } }, logger: quietLogger(),
  });
  const out = await pipeline.generateScriptOnly({ prompt: "写一场对话" });
  assert.equal(out.ok, true);
  assert.equal(out.script.cast.a.model, "m_a");
  assert.equal(out.script.beats.length, 3);
});

test("history and pipeline request fields are validated before the LLM is called", async () => {
  const output = tmpDir();
  let calls = 0;
  const llm = { available: true, async json() { calls++; return { content: JSON.stringify(SCRIPT) }; } };
  const pipeline = new Pipeline({
    config: configFor(output), catalog: stubCatalog(), llm, tts: null,
    renderer: { async render() { throw new Error("must not render"); } }, logger: quietLogger(),
  });
  const badHistory = (e) => e.status === 400 && e.code === "bad_request" && /history/.test(e.message);
  await assert.rejects(() => pipeline.generateScriptOnly({ prompt: "写一场对话", history: "nope" }), badHistory);
  await assert.rejects(
    () => pipeline.generateScriptOnly({ prompt: "写一场对话", history: [{ role: "user" }] }), badHistory);
  await assert.rejects(
    () => pipeline.generateScriptOnly({ prompt: "写一场对话", pipeline: "auto" }),
    (e) => e.status === 400 && /pipeline/.test(e.message));
  assert.equal(calls, 0);
});

test("chat mode clamps the target length and puts the history into the story prompt", async () => {
  const output = tmpDir();
  const prompts = [];
  const doc = { ...SCRIPT, beats: [...SCRIPT.beats, { say: "a", text: "今天也练习吧。" }] };
  const llm = { available: true, async json(messages) {
    prompts.push(messages.map((m) => m.content).join("\n"));
    return { content: JSON.stringify(doc) };
  } };
  const pipeline = new Pipeline({
    config: configFor(output), catalog: stubCatalog(), llm, tts: null,
    renderer: { async render() { throw new Error("must not render"); } }, logger: quietLogger(),
  });
  const out = await pipeline.generateScriptOnly({
    prompt: "在吗？", mode: "chat", targetMinutes: 8, maxLines: 2,
    history: [{ role: "用户", content: "昨天练到很晚" }],
  });
  assert.equal(out.ok, true);
  assert.equal(prompts.length, 1, "one open model needs no quick-cast call");
  assert.match(prompts[0], /写一小段约 1\.5 分钟/);
  assert.match(prompts[0], /昨天练到很晚/);
  assert.match(prompts[0], /即时对话回复/);
});

test("site index writes are serialized across concurrent jobs", async () => {
  const output = tmpDir();
  const pipeline = new Pipeline({
    config: configFor(output), catalog: null, llm: null, tts: null, renderer: null, logger: quietLogger(),
  });
  const order = [];
  const step = (name, ms) => async () => {
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`${name}:end`);
    return name;
  };
  const first = pipeline._withSiteWrite(step("a", 20));
  const second = pipeline._withSiteWrite(step("b", 1));
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});
