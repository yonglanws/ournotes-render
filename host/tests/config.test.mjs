import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT, loadConfig, publicConfig, requireSite } from "../config.js";
import { tmpDir } from "./helpers.mjs";

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
};

test("environment overrides win and secrets never come from the file", async () => {
  const dir = tmpDir();
  const site = path.join(dir, "site");
  fs.mkdirSync(site);
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, [
    "server: { port: 1234 }",
    "paths: { output: out, site: ignored }",
    "llm: { apiKey: literal-should-be-ignored, model: file-model }",
    "tts: { voices: [{ name: A, refAudioPath: /a.wav }] }",
  ].join("\n"));
  await withEnv({ OURNOTES_PORT: "4321", OURNOTES_LLM_API_KEY: "env-secret", OURNOTES_SITE: site,
                  OURNOTES_LLM_MODEL: "env-model", OURNOTES_LLM_REASONING_EFFORT: "Medium" }, async () => {
    const cfg = loadConfig({ file });
    assert.equal(cfg.server.port, 4321);
    assert.equal(cfg.llm.model, "env-model");
    assert.equal(cfg.llm.reasoningEffort, "medium", "the effort is normalized to lower case");
    assert.equal(cfg.paths.site, path.resolve(site));
    assert.equal(cfg.paths.output, path.resolve(ROOT, "out"));
    assert.equal(cfg.secrets.llmApiKey, "env-secret");
    assert.equal(cfg.llm.apiKey, "literal-should-be-ignored", "the file value is not used as a secret");
    assert.equal(publicConfig(cfg).secrets.llmApiKey, true);
    assert.equal(publicConfig(cfg).secrets.apiKey, false);
    assert.equal(requireSite(cfg), path.resolve(site));
  });
});

test("an unknown thinking effort is reported and falls back to unset", () => {
  const file = path.join(tmpDir(), "config.yaml");
  fs.writeFileSync(file, ['llm: { reasoningEffort: turbo }'].join("\n"));
  const cfg = loadConfig({ file });
  assert.equal(cfg.llm.reasoningEffort, "");
  assert.ok(cfg.issues.warnings.some((w) => w.path === "llm.reasoningEffort" && /medium/.test(w.message)));
});

test("missing config falls back to built-in defaults", () => {
  const cfg = loadConfig({ file: path.join(tmpDir(), "missing.yaml") });
  assert.equal(cfg.server.port, 9881);
  assert.equal(cfg.server.host, "127.0.0.1");
  assert.equal(cfg.security.allowPrivateServiceEndpoints, false);
  assert.equal(cfg.video.width, 1300);
  assert.equal(cfg.video.height, 600);
  assert.equal(cfg.paths.site, "");
  assert.equal(cfg.paths.siteFormat, "");
  assert.equal(cfg.llm.concurrency, 2);
  assert.equal(cfg.tts.defaultVoice.refAudioPath, "");
  assert.deepEqual(cfg.tts.voices, []);
  assert.deepEqual(cfg.render.chromeArgs, []);
  assert.throws(() => requireSite(cfg), /paths\.site/);
});

test("render.chromeArgs keeps operator flags and rejects blank entries", () => {
  const file = path.join(tmpDir(), "config.yaml");
  fs.writeFileSync(file, [
    "render:",
    "  chromeArgs:",
    "    - --use-angle=vulkan",
    "    - '  --disable-dev-shm-usage  '",
    "    - ''",
  ].join("\n"));
  const cfg = loadConfig({ file });
  assert.deepEqual(cfg.render.chromeArgs, ["--use-angle=vulkan", "--disable-dev-shm-usage"]);
  assert.ok(cfg.issues.errors.some((e) => e.path === "render.chromeArgs[2]"));
});

test("unknown settings are reported with a suggestion instead of being ignored silently", () => {  const file = path.join(tmpDir(), "config.yaml");
  fs.writeFileSync(file, [
    "security: { allowPrivateServiceEndpoints: true }",
    "server: { prot: 9881 }",
    "tts:",
    "  baseUrl: http://127.0.0.1:9880",
    "  voices: []",
    "  emoition: { enabled: true }",
  ].join("\n"));
  const cfg = loadConfig({ file });
  const paths = cfg.issues.warnings.map((w) => w.path);
  assert.ok(paths.includes("server.prot"));
  assert.ok(paths.includes("tts.emoition"));
  assert.match(cfg.issues.warnings.find((w) => w.path === "server.prot").message, /did you mean port/);
});

test("wrong scalar types are reported and fall back to defaults", () => {
  const file = path.join(tmpDir(), "config.yaml");
  fs.writeFileSync(file, [
    "server: { host: 123 }",
    "paths: { site: [] }",
    "tts: { voicesFile: 7 }",
  ].join("\n"));
  const cfg = loadConfig({ file });
  const paths = cfg.issues.errors.map((e) => e.path);
  assert.ok(paths.includes("server.host"));
  assert.ok(paths.includes("paths.site"));
  assert.ok(paths.includes("tts.voicesFile"));
  assert.equal(cfg.server.host, "127.0.0.1");
  assert.equal(cfg.paths.site, "");
  assert.equal(cfg.tts.voicesFile, "");
});

test("invalid numbers and collections are clamped", () => {
  const dir = tmpDir();
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, [
    "video: { width: 1, height: 999999, fps: 500, crf: 99 }",
    "queue: { concurrency: 0, maxSize: 0 }",
    "server: { corsOrigins: '*' }",
  ].join("\n"));
  const cfg = loadConfig({ file });
  assert.equal(cfg.video.width, 320);
  assert.equal(cfg.video.height, 4320);
  assert.equal(cfg.video.fps, 30);
  assert.equal(cfg.video.crf, 51);
  assert.equal(cfg.queue.concurrency, 1);
  assert.equal(cfg.queue.maxSize, 1);
  assert.deepEqual(cfg.server.corsOrigins, []);
  assert.equal(cfg.server.cors, false);
});

test("story.maxLines below two or non-integer is reported instead of being adjusted", () => {
  for (const value of [1, 2.5]) {
    const file = path.join(tmpDir(), "config.yaml");
    fs.writeFileSync(file, `story: { maxLines: ${value} }`);
    const cfg = loadConfig({ file });
    const issue = cfg.issues.errors.find((e) => e.path === "story.maxLines");
    assert.ok(issue, `story.maxLines ${value} is reported as a config error`);
    assert.match(issue.message, /at least 2/);
    assert.equal(cfg.story.maxLines, value, "the invalid value is not silently adjusted");
  }
});

test("tts.provider and the irodori block default like MSST and clamp bad values", async () => {
  const defaults = loadConfig({ file: path.join(tmpDir(), "missing.yaml") });
  assert.equal(defaults.tts.provider, "gpt-sovits");
  assert.equal(defaults.tts.irodori.model, "irodori-tts");
  assert.equal(defaults.tts.irodori.numSteps, 40);
  assert.equal(defaults.tts.irodori.cfgScaleSpeaker, 5);
  assert.equal(defaults.tts.irodori.chunkingEnabled, true);
  assert.equal(defaults.tts.irodori.seed, -1);
  assert.deepEqual(defaults.tts.irodori.emotionLabels, []);
  assert.equal(defaults.tts.emotion.enabled, false);

  await withEnv({ OURNOTES_TTS_PROVIDER: "Irodori", OURNOTES_IRODORI_MODEL: "test-model",
                  OURNOTES_IRODORI_NUM_STEPS: "12" }, async () => {
    const cfg = loadConfig({ file: path.join(tmpDir(), "missing.yaml") });
    assert.equal(cfg.tts.provider, "irodori", "the provider is normalized to lower case");
    assert.equal(cfg.tts.irodori.model, "test-model");
    assert.equal(cfg.tts.irodori.numSteps, 12);
  });

  const file = path.join(tmpDir(), "config.yaml");
  fs.writeFileSync(file, [
    "security: { allowPrivateServiceEndpoints: true }",
    "tts:",
    "  provider: irodori",
    "  baseUrl: http://192.168.1.10:8088",
    "  irodori:",
    "    numSteps: 0",
    "    chunkMinChars: -5",
    "    durationScale: 0",
    "    seed: -9",
    "    emotionLabels: [平静, ' ', 开心]",
    "  voices: [{ name: 瑞希, refAudioPath: /refs/main.wav }]",
  ].join("\n"));
  const cfg = loadConfig({ file });
  assert.equal(cfg.tts.provider, "irodori");
  assert.equal(cfg.tts.irodori.numSteps, 1);
  assert.equal(cfg.tts.irodori.chunkMinChars, 1);
  assert.equal(cfg.tts.irodori.durationScale, 0.1);
  assert.equal(cfg.tts.irodori.seed, -1);
  assert.deepEqual(cfg.tts.irodori.emotionLabels, ["平静", "开心"]);
  assert.equal(cfg.tts.emotion.enabled, true, "MSST emotionLabels turn emotion selection on");
});

test("an unknown tts.provider is reported and falls back to gpt-sovits", () => {
  const file = path.join(tmpDir(), "config.yaml");
  fs.writeFileSync(file, 'tts: { provider: vits }');
  const cfg = loadConfig({ file });
  assert.equal(cfg.tts.provider, "gpt-sovits");
  assert.ok(cfg.issues.warnings.some((w) => w.path === "tts.provider" && /irodori/.test(w.message)));
});
