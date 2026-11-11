// Opt-in end-to-end render of the director script format on a published site: it compiles host/fixtures/director-demo.json
// (focus points, Track pans, pre-line reactions, a timed mid-line action, a pause) onto the site, then renders it with
// the site engine. It needs a site-format site with the demo's models and the Live2D runtimes:
//
//   OURNOTES_E2E_SITE=resources/site OURNOTES_E2E_CORE=resources/site/vendor/live2dcubismcore.min.js \
//     node --test host/tests/e2e-director.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildSiteStory } from "../tools/site-story.mjs";
import { configureFfmpeg, runFfmpeg } from "../render/ffmpeg.js";
import { Renderer } from "../render/renderer.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

const site = process.env.OURNOTES_E2E_SITE || "";
const core = process.env.OURNOTES_E2E_CORE || "";
const base = process.env.OURNOTES_E2E_DIRECTOR_BASE || "stories/10610.json";
const skip = !site ? "OURNOTES_E2E_SITE is not set"
  : !core ? "OURNOTES_E2E_CORE is not set"
  : !fs.existsSync(path.join(site, ...base.split("/"))) ? `${base} is not in the site` : false;

test("a director script compiles onto a site and renders with camera and acting", { skip, timeout: 900000 }, async () => {
  configureFfmpeg();
  const script = JSON.parse(fs.readFileSync(path.resolve("host/fixtures/director-demo.json"), "utf8"));
  script.base = base;
  const built = buildSiteStory({ site, baseRel: base, script, advId: 99001, language: "ja", title: "ライブのあとで" });
  assert.deepEqual(built.errors || [], []);
  assert.equal(built.language, "ja");
  assert.ok(built.compiled.lines.length >= 4);
  const rows = built.episode.commands;
  assert.ok(rows.some((r) => r.cmd === "Focus" && r.PositionType === 5), "a camera focus row on a character's slot");
  assert.ok(rows.some((r) => r.cmd === "Focus" && Number.isInteger(r.PositionType)), "a camera focus point");
  assert.ok(rows.some((r) => r.cmd === "Track" && r.Parameter1), "a Track pan");
  assert.ok(rows.some((r) => r.cmd === "LookTarget"), "a look target");
  assert.ok(rows.some((r) => r.cmd === "Talk" && Array.isArray(r.HostActions) && r.HostActions.length), "timed actions");
  assert.ok(rows.some((r) => r.cmd === "Delay"), "a pause");

  const output = tmpDir("ournotes-director-e2e-");
  const manifest = JSON.parse(fs.readFileSync(path.join(site, ...built.manifestPath.split("/")), "utf8"));
  const motion = path.join(site, "vendor", "live2dcubismmotionsynccore.min.js");
  const config = {
    paths: { site, output, cache: path.join(output, "cache") },
    story: { maxLines: 20, font: "sans", title: "", personas: [] },
    tts: { enabled: false, voices: [], textLang: "ja", promptLang: "ja", translateForTts: false, concurrency: 1 },
    llm: { repairRounds: 0 },
    video: { width: 1300, height: 600, fps: 30, crf: 28, preset: "veryfast", encoder: "auto",
             audioBitrate: "128k", maxDurationSec: 12, jpegQuality: 85, audioSampleRate: 48000, watermark: "" },
    render: { core, motionsync: fs.existsSync(motion) ? motion : "", gpu: false, chrome: "", taskTimeoutMs: 900000,
              settleFrames: 0 },
    queue: { outputMaxAgeHours: 0 },
  };
  const renderer = new Renderer({ config, logger: quietLogger() });
  const result = await renderer.render({
    story: { manifest, manifestPath: built.manifestPath, files: new Map(), language: "ja", siteEngine: true },
    jobId: "e2e-director", signal: null, onProgress: () => {},
  });
  assert.ok(fs.existsSync(result.output), "the director render produced an MP4");
  assert.ok(fs.statSync(result.output).size > 10_000, "the MP4 has content");
  assert.ok(result.report.frames > 60, `enough frames (${result.report.frames})`);
  assert.ok(result.report.lines.length > 0, "the story reached a line");
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", result.output, "-f", "null", "-"]);
  console.log(`e2e director video: ${result.output} (${result.report.frames} frames, ${result.duration}s, ` +
              `${result.report.lines.length} lines)`);

  // Opt-in frame audit: keep the generated episode next to the MP4, extract real PNG stills from
  // the encoded video for the first camera/acting row of each kind, and fail on an unchanged
  // camera checkpoint. The audit writes its own report and evidence under the temporary output.
  if (process.env.OURNOTES_FRAME_AUDIT === "1") {
    const outputDir = path.dirname(result.output);
    const episodeFile = path.join(outputDir, "e2e-director.episode.json");
    const framesDir = path.join(outputDir, "frames");
    fs.writeFileSync(episodeFile, JSON.stringify(built.episode, null, 2));
    const audit = spawnSync(process.execPath, [
      path.resolve("scripts/stories/frame-audit.mjs"),
      "--video", result.output,
      "--episode", episodeFile,
      "--out", framesDir,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(audit.status, 0, `frame audit failed:\n${audit.stdout}\n${audit.stderr}`);
    const reportFile = path.join(framesDir, "frame-report.json");
    const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    assert.deepEqual(report.failures, [], JSON.stringify(report.failures));
    const camera = new Set(["Focus", "Zoom", "Pedestal", "PanV2", "DoF"]);
    assert.ok(report.checks.some((check) => camera.has(check.cmd)), "at least one camera checkpoint");
    for (const check of report.checks) {
      assert.ok(fs.existsSync(path.join(framesDir, check.before)), `${check.cmd} before PNG exists`);
      assert.ok(fs.existsSync(path.join(framesDir, check.after)), `${check.cmd} after PNG exists`);
    }
    console.log(`e2e frame report: ${reportFile} (${report.checks.length} checks, ` +
                `${report.checks.filter((check) => check.changed).length} changed)`);
  }
});
