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
                  OURNOTES_LLM_MODEL: "env-model" }, async () => {
    const cfg = loadConfig({ file });
    assert.equal(cfg.server.port, 4321);
    assert.equal(cfg.llm.model, "env-model");
    assert.equal(cfg.paths.site, path.resolve(site));
    assert.equal(cfg.paths.output, path.resolve(ROOT, "out"));
    assert.equal(cfg.secrets.llmApiKey, "env-secret");
    assert.equal(cfg.llm.apiKey, "literal-should-be-ignored", "the file value is not used as a secret");
    assert.equal(publicConfig(cfg).secrets.llmApiKey, true);
    assert.equal(publicConfig(cfg).secrets.apiKey, false);
    assert.equal(requireSite(cfg), path.resolve(site));
  });
});

test("missing config falls back to built-in defaults", () => {
  const cfg = loadConfig({ file: path.join(tmpDir(), "missing.yaml") });
  assert.equal(cfg.server.port, 9881);
  assert.equal(cfg.server.host, "127.0.0.1");
  assert.equal(cfg.security.allowPrivateServiceEndpoints, false);
  assert.equal(cfg.video.width, 1300);
  assert.equal(cfg.video.height, 600);
  assert.equal(cfg.paths.site, "");
  assert.equal(cfg.tts.defaultVoice.refAudioPath, "");
  assert.deepEqual(cfg.tts.voices, []);
  assert.throws(() => requireSite(cfg), /paths\.site/);
});

test("unknown settings are reported with a suggestion instead of being ignored silently", () => {
  const file = path.join(tmpDir(), "config.yaml");
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
