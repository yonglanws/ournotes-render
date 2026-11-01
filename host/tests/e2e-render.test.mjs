// Opt-in end-to-end render against a real nnnotes site. It writes a tiny three-beat script over the site's first
// model/stage and renders it through the browser + ffmpeg pipeline.
//
//   OURNOTES_E2E_SITE=/path/to/site OURNOTES_E2E_CORE=/path/to/live2dcubismcore.min.js \
//     node --test host/tests/e2e-render.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Pipeline } from "../pipeline.js";
import { configureFfmpeg, runFfmpeg } from "../render/ffmpeg.js";
import { Renderer } from "../render/renderer.js";
import { StoryCatalog } from "../story/catalog.js";
import { buildMinimalSite } from "../fixtures/minimal-site.mjs";
import { quietLogger, tmpDir } from "./helpers.mjs";

const site = process.env.OURNOTES_E2E_SITE || "";
const core = process.env.OURNOTES_E2E_CORE || "";
const fixture = process.env.OURNOTES_E2E_FIXTURE === "1";
const skip = !core ? "OURNOTES_E2E_CORE is not set" : (!site && !fixture) ? "OURNOTES_E2E_SITE is not set" : false;

test("a real site renders a short Our Notes story to MP4", { skip, timeout: 900000 }, async () => {
  configureFfmpeg();
  const output = tmpDir("ournotes-e2e-");
  if (fixture) {
    const siteDir = site || path.join(output, "site");
    buildMinimalSite(siteDir);
    const config = {
      paths: { site: siteDir, output, cache: path.join(output, "cache") },
      story: { maxLines: 20, font: "sans", title: "", personas: [] },
      tts: { enabled: false, voices: [], textLang: "ja", promptLang: "ja", translateForTts: false, concurrency: 1 },
      llm: { repairRounds: 0 },
      video: { width: 640, height: 360, fps: 30, crf: 28, preset: "veryfast", encoder: "auto",
               audioBitrate: "128k", maxDurationSec: 60, jpegQuality: 85, audioSampleRate: 48000, watermark: "" },
      render: { core, motionsync: "", gpu: false, chrome: "", taskTimeoutMs: 600000, settleFrames: 0 },
      queue: { outputMaxAgeHours: 0 },
    };
    const manifest = JSON.parse(fs.readFileSync(path.join(siteDir, "stories/0.json"), "utf8"));
    const renderer = new Renderer({ config, logger: quietLogger() });
    const result = await renderer.render({
      story: { manifest, manifestPath: "stories/0.json", files: new Map(), language: "ja", fixtureUi: true },
      jobId: "e2e-fixture", signal: null, onProgress: () => {},
    });
    assert.ok(fs.existsSync(result.output), "the fixture render produced an MP4");
    assert.ok(fs.statSync(result.output).size > 10_000, "the MP4 has content");
    assert.ok(result.report.frames > 30, `enough frames (${result.report.frames})`);
    assert.equal(result.report.ended, true, "the story ended");
    // decode the whole file, then keep one frame to look at
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", result.output, "-f", "null", "-"]);
    const frame = path.join(output, "frame.png");
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", result.output, "-vf", "select=eq(n\\,45)",
                     "-frames:v", "1", frame]);
    assert.ok(fs.existsSync(frame));
    console.log(`e2e fixture video: ${result.output} (${result.report.frames} frames, ${result.duration}s) frame: ${frame}`);
    return;
  }

  const config = {
    paths: { site, output, cache: path.join(output, "cache") },
    story: { maxLines: 20, font: "sans", title: "", personas: [] },
    tts: { enabled: false, voices: [], textLang: "zh", promptLang: "ja", translateForTts: false, concurrency: 1 },
    llm: { repairRounds: 0 },
    video: { width: 640, height: 360, fps: 30, crf: 28, preset: "veryfast", encoder: "auto",
             audioBitrate: "128k", maxDurationSec: 60, jpegQuality: 85, audioSampleRate: 48000, watermark: "" },
    render: { core, motionsync: "", gpu: false, chrome: "", taskTimeoutMs: 600000, settleFrames: 0 },
    queue: { outputMaxAgeHours: 0 },
  };
  const catalog = new StoryCatalog({ dir: site, language: process.env.OURNOTES_E2E_LANG || "",
    maxModels: 8, cast: [], logger: quietLogger() });
  const data = await catalog.catalog();
  const stage = data.stages[0];
  const model = data.models.find((m) => m.motions.length) || data.models[0];
  assert.ok(stage && model, "the site has a stage and a model");
  const motion = model.motions.find((m) => /smile|nod|idle/i.test(m)) || model.motions[0] || "";
  const script = {
    format: "ournotes.story-script/1", base: data.manifest, language: data.language, title: "E2E",
    cast: { a: { model: model.id, name: model.name } },
    beats: [
      { scene: stage.id, location: stage.caption || "", positions: { a: "center" } },
      { say: "a", text: "这是宿主端到端渲染测试。", ...(motion ? { motion } : {}) },
      { narrate: "画面由 Our Notes 剧情播放器绘制。" },
    ],
  };
  const renderer = new Renderer({ config, logger: quietLogger() });
  const pipeline = new Pipeline({ config, catalog, llm: null, tts: null, renderer, logger: quietLogger() });
  const result = await pipeline.run({ script, tts: false }, { signal: null, jobId: "e2e-test", progress: () => {} });
  assert.equal(result.success, true);
  assert.ok(fs.existsSync(result.videoPath));
  assert.ok(fs.statSync(result.videoPath).size > 10_000);
  assert.ok(result.frameCount > 10);
  console.log(`e2e video: ${result.videoPath} (${result.frameCount} frames, ${result.duration}s)`);
});
