// Opt-in end-to-end render of a published story site (ournotes.story-manifest/2) through the same engine the bdon.moe
// story player uses. It needs a downloaded site and the Live2D runtimes, and renders the first seconds of one episode:
//
//   OURNOTES_E2E_SITE=resources/site OURNOTES_E2E_CORE=resources/site/vendor/live2dcubismcore.min.js \
//     node --test host/tests/e2e-site.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configureFfmpeg, runFfmpeg } from "../render/ffmpeg.js";
import { Renderer } from "../render/renderer.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

const site = process.env.OURNOTES_E2E_SITE || "";
const core = process.env.OURNOTES_E2E_CORE || "";
const storyPath = process.env.OURNOTES_E2E_STORY || "stories/10610.json";
const language = process.env.OURNOTES_E2E_LANG || "ja";
const skip = !site ? "OURNOTES_E2E_SITE is not set"
  : !core ? "OURNOTES_E2E_CORE is not set"
  : !fs.existsSync(path.join(site, ...storyPath.split("/"))) ? `${storyPath} is not in the site` : false;

test("a published story site renders with the site engine", { skip, timeout: 600000 }, async () => {
  configureFfmpeg();
  const output = tmpDir("ournotes-site-e2e-");
  const manifest = JSON.parse(fs.readFileSync(path.join(site, ...storyPath.split("/")), "utf8"));
  assert.equal(manifest.format, "ournotes.story-manifest/2");
  const motion = path.join(site, "vendor", "live2dcubismmotionsynccore.min.js");
  const config = {
    paths: { site, output, cache: path.join(output, "cache") },
    story: { maxLines: 20, font: "sans", title: "", personas: [] },
    tts: { enabled: false, voices: [], textLang: language, promptLang: language, translateForTts: false,
           concurrency: 1 },
    llm: { repairRounds: 0 },
    video: { width: 1300, height: 600, fps: 30, crf: 28, preset: "veryfast", encoder: "auto",
             audioBitrate: "128k", maxDurationSec: 8, jpegQuality: 85, audioSampleRate: 48000, watermark: "" },
    render: { core, motionsync: fs.existsSync(motion) ? motion : "", gpu: false, chrome: "", taskTimeoutMs: 600000,
              settleFrames: 0 },
    queue: { outputMaxAgeHours: 0 },
  };
  const renderer = new Renderer({ config, logger: quietLogger() });
  const result = await renderer.render({
    story: { manifest, manifestPath: storyPath, files: new Map(), language, siteEngine: true },
    jobId: "e2e-site", signal: null, onProgress: () => {},
  });
  assert.ok(fs.existsSync(result.output), "the site render produced an MP4");
  assert.ok(fs.statSync(result.output).size > 10_000, "the MP4 has content");
  assert.ok(result.report.frames > 60, `enough frames (${result.report.frames})`);
  assert.ok(result.report.lines.length > 0, "the story reached a line");
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", result.output, "-f", "null", "-"]);
  console.log(`e2e site video: ${result.output} (${result.report.frames} frames, ${result.duration}s, ` +
              `${result.report.lines.length} lines, ${result.audio ? "with audio" : "no audio"})`);
});
