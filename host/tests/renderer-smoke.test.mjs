import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { findBrowser } from "../../scripts/lib/story-author/chrome.js";
import { configureFfmpeg } from "../render/ffmpeg.js";
import { Renderer } from "../render/renderer.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

let browser = "";
try { browser = findBrowser(); } catch { /* no Chrome */ }
const skip = process.env.OURNOTES_SKIP_BROWSER ? "OURNOTES_SKIP_BROWSER" : browser ? false : "no Chrome/Edge";

test("a headless browser posts frames and ffmpeg encodes them", { skip, timeout: 180000 }, async () => {
  configureFfmpeg();
  const output = tmpDir();
  const config = {
    paths: { output, cache: output, site: "" },
    video: { width: 640, height: 360, fps: 30, crf: 28, preset: "veryfast", encoder: "libx264",
             audioBitrate: "128k", watermark: "" },
    render: { gpu: false, chrome: browser, core: "", taskTimeoutMs: 120000 },
  };
  const renderer = new Renderer({ config, logger: quietLogger() });
  const r = await renderer.renderSmoke({ jobId: "smoke-test", frames: 10 });
  assert.ok(fs.existsSync(r.output));
  assert.ok(fs.statSync(r.output).size > 1000);
  assert.equal(r.report.frames, 10);
  assert.equal(r.report.fps, 30);
});
