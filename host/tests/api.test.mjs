import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ApiServer } from "../api/server.js";
import { TaskQueue } from "../queue/taskQueue.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

const CATALOG = {
  manifest: "stories/1.json", language: "zh-Hans", languages: ["zh-Hans"],
  stages: [{ id: "stage_a", caption: "教室" }], music: [{ cue: "bgm_a", label: "Quiet" }],
  sounds: [{ cue: "sound_se_adv_door_knock", label: "Door Knock" }],
  models: [{ id: "m_a", name: "灯", character: "tomori", group: "g", motions: ["mtn_idle01_C"],
             expressions: ["exp_idle01"], defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" }],
};

const configFor = (output) => ({
  server: { port: 0, host: "127.0.0.1", cors: false, corsOrigins: [] },
  paths: { output, cache: output },
  queue: { cleanupIntervalMs: 600000, outputMaxAgeHours: 24, concurrency: 1, maxSize: 10,
           taskTimeoutMs: 5000, retentionMs: 1000 },
  secrets: { apiKey: "" },
  video: { ffmpegPath: "" },
  render: { chrome: "", gpu: false },
  llm: { enabled: false, model: "" },
  tts: { enabled: false, baseUrl: "", voices: [] },
  story: { personas: [] },
});

const SCRIPT = {
  format: "ournotes.story-script/1", base: "stories/1.json", language: "zh-Hans", title: "T",
  cast: { a: { model: "m_a", name: "灯" } },
  beats: [{ scene: "stage_a", positions: { a: "center" } }, { say: "a", text: "你好。" }],
};

const makeServer = async ({ output, apiKey = "", pipeline } = {}) => {
  const config = configFor(output || tmpDir());
  config.secrets.apiKey = apiKey;
  const queue = new TaskQueue({ ...config.queue, logger: quietLogger() });
  const catalog = {
    async catalog() { return CATALOG; },
    bases() { return [{ manifest: "stories/1.json", id: "1", title: "Test", languages: ["zh-Hans"] }]; },
  };
  const stub = pipeline || {
    async run(body, { jobId, progress }) {
      progress("rendering", 0.5, "half");
      const file = path.join(config.paths.output, `${jobId}.mp4`);
      fs.writeFileSync(file, Buffer.from("fake mp4 bytes"));
      return { videoPath: file, downloadUrl: `/api/v1/download/${jobId}.mp4`, duration: 1, frameCount: 30 };
    },
    async generateScriptOnly() { return { ok: true, script: SCRIPT, warnings: [] }; },
  };
  const api = new ApiServer({ config, queue, pipeline: stub, catalog, logger: quietLogger() });
  const addr = await api.listen();
  return { api, queue, base: `http://127.0.0.1:${addr.port}`, config };
};

const stop = async ({ api, queue }) => { await api.close(); await queue.close(); };
const json = async (r) => ({ status: r.status, body: await r.json() });

test("a queued generate task completes and its file downloads", async () => {
  const s = await makeServer();
  try {
    const created = await json(await fetch(`${s.base}/api/v1/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "写一场对话", wait: false }),
    }));
    assert.equal(created.status, 202);
    const id = created.body.taskId;
    let task = null;
    for (let i = 0; i < 50; i++) {
      task = (await json(await fetch(`${s.base}/api/v1/tasks/${id}`))).body;
      if (["completed", "failed", "cancelled"].includes(task.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(task.status, "completed");
    assert.equal(task.result.duration, 1);
    const file = path.join(s.config.paths.output, `${id}.mp4`);
    assert.equal(fs.readFileSync(file, "utf8"), "fake mp4 bytes");
    const download = await fetch(`${s.base}${task.result.downloadUrl}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "fake mp4 bytes");
    const files = (await json(await fetch(`${s.base}/api/v1/files`))).body;
    assert.ok(files.data.some((f) => f.filename === `${id}.mp4`));
  } finally {
    await stop(s);
  }
});

test("a synchronous generate returns the result in the response", async () => {
  const s = await makeServer();
  try {
    const r = await fetch(`${s.base}/api/v1/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", timeout: 5000 }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.success, true);
    assert.ok(body.downloadUrl.endsWith(".mp4"));
  } finally {
    await stop(s);
  }
});

test("the AI-only script endpoint returns the validated document", async () => {
  const s = await makeServer();
  try {
    const r = await fetch(`${s.base}/api/v1/script/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "写一场对话" }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.script.cast.a.model, "m_a");
  } finally {
    await stop(s);
  }
});

test("script/check validates and fixes a supplied script", async () => {
  const s = await makeServer();
  try {
    const good = await json(await fetch(`${s.base}/api/v1/script/check`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: SCRIPT }),
    }));
    assert.equal(good.status, 200);
    assert.equal(good.body.ok, true);
    assert.equal(good.body.script.beats.length, 2);
    const bad = await json(await fetch(`${s.base}/api/v1/script/check`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: { ...SCRIPT, beats: [{ say: "a", text: "no scene" }] } }),
    }));
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.some((e) => e.code === "beforeScene"));
  } finally {
    await stop(s);
  }
});

test("resources reports the catalog", async () => {
  const s = await makeServer();
  try {
    const r = await json(await fetch(`${s.base}/api/v1/resources`));
    assert.equal(r.status, 200);
    assert.equal(r.body.base, "stories/1.json");
    assert.equal(r.body.models[0].id, "m_a");
    assert.equal(r.body.stages[0].id, "stage_a");
    assert.equal(r.body.sounds[0].cue, "sound_se_adv_door_knock");
  } finally {
    await stop(s);
  }
});

test("a running task can be cancelled through the API", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await makeServer({
    pipeline: {
      async run(body, { signal }) {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          gate.then(resolve);
        });
        return {};
      },
    },
  });
  try {
    const created = await json(await fetch(`${s.base}/api/v1/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "slow", wait: false }),
    }));
    const id = created.body.taskId;
    await new Promise((r) => setTimeout(r, 50));
    const cancelled = await json(await fetch(`${s.base}/api/v1/tasks/${id}/cancel`, { method: "POST" }));
    assert.equal(cancelled.body.cancelled, true);
    let task = null;
    for (let i = 0; i < 50; i++) {
      task = (await json(await fetch(`${s.base}/api/v1/tasks/${id}`))).body;
      if (task.status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(task.status, "cancelled");
    release();
  } finally {
    await stop(s);
  }
});

test("the API requires a bearer token when one is configured", async () => {
  const s = await makeServer({ apiKey: "secret-token" });
  try {
    assert.equal((await fetch(`${s.base}/api/v1/status`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/v1/status`, { headers: { authorization: "Bearer secret-token" } })).status, 200);
    // health stays public
    assert.equal((await fetch(`${s.base}/api/v1/health`)).status, 200);
  } finally {
    await stop(s);
  }
});

test("cleanup removes outputs older than the retention window", async () => {
  const output = tmpDir();
  const old = path.join(output, "old.mp4");
  fs.writeFileSync(old, "old");
  const then = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, then, then);
  const s = await makeServer({ output });
  s.config.queue.outputMaxAgeHours = 1;
  try {
    const r = await json(await fetch(`${s.base}/api/v1/cleanup`, { method: "POST" }));
    assert.equal(r.body.removed, 1);
    assert.equal(fs.existsSync(old), false);
  } finally {
    await stop(s);
  }
});
