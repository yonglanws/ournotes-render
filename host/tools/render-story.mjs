// Renders one existing episode of a local story site to MP4, without the AI/TTS pipeline. This is the example path:
// download a site with fetch-story.mjs, then render its manifest through the reference site engine.
//
//   node host/tools/render-story.mjs --site resources/site --story stories/10610.json --lang ja \
//     --core resources/site/vendor/live2dcubismcore.min.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { configureFfmpeg } from "../render/ffmpeg.js";
import { Renderer } from "../render/renderer.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const usage = () => `usage: node host/tools/render-story.mjs --site <dir> [options]

  --site <dir>       local story site (stories/<id>.json, assets/, models/)
  --story <path>     story manifest under the site (default stories/0.json)
  --lang <code>      language (default the manifest's language, then ja)
  --out <dir>        output directory (default output)
  --job <name>       output base name (default story-<advId>)
  --width <px>       frame width (default 1300, the 13:6 ADV viewport)
  --height <px>      frame height (default 600)
  --fps <n>          frames per second, 1..30 (default 30)
  --crf <n>          x264 quality (default 20)
  --max-duration <s> stop after this many seconds (default 600)
  --core <file>      Live2D Cubism Core (default <site>/vendor/live2dcubismcore.min.js)
  --motionsync <file> Live2D MotionSync Core (optional; voice lip sync)
  --chrome <file>    Chrome/Chromium executable (default auto)
  --keep-frames      keep the JPEG frames and job directory
  --help             show this text`;

const args = (argv) => {
  const o = { site: "", story: "stories/0.json", lang: "", out: "output", job: "", width: 1300, height: 600,
              fps: 30, crf: 20, maxDuration: 600, core: "", motionsync: "", chrome: "", keepFrames: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--help" || a === "-h") { o.help = true; continue; }
    if (a === "--site") o.site = next();
    else if (a === "--story") o.story = next();
    else if (a === "--lang") o.lang = next();
    else if (a === "--out") o.out = next();
    else if (a === "--job") o.job = next();
    else if (a === "--width") o.width = Number(next());
    else if (a === "--height") o.height = Number(next());
    else if (a === "--fps") o.fps = Number(next());
    else if (a === "--crf") o.crf = Number(next());
    else if (a === "--max-duration") o.maxDuration = Number(next());
    else if (a === "--core") o.core = next();
    else if (a === "--motionsync") o.motionsync = next();
    else if (a === "--chrome") o.chrome = next();
    else if (a === "--keep-frames") o.keepFrames = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (o.help) return o;
  if (!o.site) throw new Error("--site is required");
  if (!Number.isFinite(o.width) || !Number.isFinite(o.height) || o.width < 64 || o.height < 64)
    throw new Error("--width and --height must be at least 64");
  if (!Number.isFinite(o.fps) || o.fps < 1 || o.fps > 30) throw new Error("--fps must be 1..30");
  if (!Number.isFinite(o.maxDuration) || o.maxDuration <= 0) throw new Error("--max-duration must be positive");
  return o;
};

const main = async () => {
  let o;
  try { o = args(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(usage()); process.exitCode = 2; return; }
  if (o.help) { console.log(usage()); return; }

  const site = path.resolve(ROOT, o.site);
  if (!fs.existsSync(site) || !fs.statSync(site).isDirectory()) throw new Error(`site is not a directory: ${site}`);
  const storyParts = o.story.replace(/\\/g, "/").split("/");
  if (storyParts.some((part) => part === ".." || part === "." || part === ""))
    throw new Error(`--story must be a path below the site: ${o.story}`);
  const manifestFile = path.join(site, ...storyParts);
  if (!fs.existsSync(manifestFile)) throw new Error(`story manifest not found: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.format !== "ournotes.story-manifest/1" && manifest.format !== "ournotes.story-manifest/2")
    throw new Error(`${o.story}: not an ournotes story manifest (format ${manifest.format})`);
  const language = o.lang || manifest.language || "ja";

  const cfg = loadConfig({ file: path.join(ROOT, "config.yaml") });
  cfg.paths.site = site;
  cfg.paths.output = path.resolve(ROOT, o.out);
  cfg.paths.cache = path.join(cfg.paths.output, ".cache");
  cfg.video.width = Math.round(o.width);
  cfg.video.height = Math.round(o.height);
  cfg.video.fps = Math.round(o.fps);
  cfg.video.crf = Math.round(o.crf);
  cfg.video.maxDurationSec = o.maxDuration;
  cfg.render.chrome = o.chrome ? path.resolve(ROOT, o.chrome) : cfg.render.chrome;
  const core = o.core || path.join(site, "vendor", "live2dcubismcore.min.js");
  const motion = o.motionsync || path.join(site, "vendor", "live2dcubismmotionsynccore.min.js");
  if (o.core) cfg.render.core = path.resolve(ROOT, o.core);
  else if (fs.existsSync(core)) cfg.render.core = core;
  if (o.motionsync) cfg.render.motionsync = path.resolve(ROOT, o.motionsync);
  else if (fs.existsSync(motion)) cfg.render.motionsync = motion;
  if (!cfg.render.core)
    throw new Error(`no Live2D Cubism Core: pass --core or put it at ${core}`);
  fs.mkdirSync(cfg.paths.output, { recursive: true });
  fs.mkdirSync(cfg.paths.cache, { recursive: true });
  configureFfmpeg();

  const advId = manifest.advId ?? manifest.story?.advId ?? path.basename(o.story, ".json");
  const jobId = o.job || `story-${advId}`;
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(jobId)) throw new Error(`--job must match [a-z0-9-]{3,80}: ${jobId}`);
  if (o.keepFrames) process.env.OURNOTES_KEEP_FRAMES = "1";

  const logger = {
    info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m), debug: () => {},
  };
  const renderer = new Renderer({ config: cfg, logger });
  console.log(`story ${advId} (${language}) from ${site}`);
  console.log(`video ${cfg.video.width}x${cfg.video.height} @ ${cfg.video.fps} fps, core ${cfg.render.core || "(none)"}` +
              (cfg.render.motionsync ? `, motionsync ${cfg.render.motionsync}` : ""));
  const started = Date.now();
  const result = await renderer.render({
    story: { manifest, manifestPath: o.story.replace(/\\/g, "/"), files: new Map(), language, siteEngine: true },
    jobId,
    signal: null,
    onProgress: (stage, progress, message) => {
      if (message) console.log(`  [${stage}] ${message}${progress != null ? ` (${Math.round(progress * 100)}%)` : ""}`);
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  console.log(`video: ${result.output}`);
  console.log(`  ${result.report.frames} frames, ${result.duration.toFixed(2)} s, ${(fs.statSync(result.output).size / 1048576).toFixed(1)} MB`);
  console.log(`  story ${result.report.ended ? "ended" : "stopped at the duration limit"}, ` +
              `${result.report.storySeconds.toFixed(2)} s of game time, ${result.report.lines?.length ?? 0} lines`);
  if (result.audio) console.log(`  audio: ${result.audio.duration.toFixed(2)} s, ${result.audio.mixed} cues mixed`);
  if (result.pageErrors.length) console.log(`  page errors: ${result.pageErrors.length} (see the log above)`);
  console.log(`  rendered in ${seconds} s`);
};

main().catch((e) => {
  console.error(`render-story: ${e.message}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exitCode = 1;
});
