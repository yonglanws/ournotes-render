// Frame audit: a real MP4 is probed, full-resolution PNG stills are extracted before and after
// every camera/acting checkpoint, and a 160x90 grayscale difference decides whether the frame
// actually changed. The timeline follows the player's own blocking rules (StoryPlayerCore), so a
// report can be checked against the episode the renderer played rather than a hand-made schedule.
//
//   node scripts/stories/frame-audit.mjs --video frame-check.mp4 \
//     --episode frame-check.episode.json --out frames [--ffmpeg ffmpeg] [--ffprobe ffprobe]
//
// The report's checks point at PNG basenames inside --out; frame-report.json itself carries the
// video's sha256, the episode's command count and the ffmpeg version, and is deterministic.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StoryPlayerCore } from "../../src/story/player-core.js";
import { validateFfmpeg } from "../../host/render/ffmpeg.js";

export const CAMERA_COMMANDS = Object.freeze(["Focus", "Zoom", "Pedestal", "PanV2", "DoF"]);
export const CHECKPOINT_COMMANDS = Object.freeze([...CAMERA_COMMANDS, "Se", "Motion", "In", "Out"]);
export const FRAME_BEFORE_SECONDS = 0.15;
export const FRAME_AFTER_SECONDS = 0.45;
export const RAW_WIDTH = 160;
export const RAW_HEIGHT = 90;
export const CHANGE_THRESHOLD = 1.0;

const CAMERA = new Set(CAMERA_COMMANDS);
const CHECKPOINT = new Set(CHECKPOINT_COMMANDS);
const PNG_EXT = ".png";

const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const number = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return 0;
};

const rowsOf = (episode) => (Array.isArray(episode?.commands) ? episode.commands : []);

const isNoWait = (row) => row?.IsNoWait === true || row?.IsNoWait === 1 || row?.IsNoWait === "1" ||
  row?.IsNoWait === "true";

// Advance the timeline with the player's GetBlockingSeconds: a row that is not IsNoWait holds
// the command loop for its blocking seconds, while a no-wait row (the camera moves the compiler
// emits) only delays its own effect. The rows before a checkpoint decide when it starts, and the
// row's own DelaySeconds is when its effect begins. One checkpoint per command kind keeps the
// report small and deterministic; the first occurrence is the one that follows the opening
// staging most closely. Talk/Wait are unbounded waits whose line time is not in the episode, so
// a checkpoint after one is a lower bound on its real timeline position.
export const frameCheckpoints = (episode) => {
  const rows = rowsOf(episode);
  const seen = new Set();
  const checks = [];
  let elapsed = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const delay = Math.max(number(row.DelaySeconds), 0);
    if (CHECKPOINT.has(row.cmd) && !seen.has(row.cmd)) {
      const seconds = round(elapsed + delay);
      checks.push({
        i: index,
        cmd: row.cmd,
        seconds,
        beforeSeconds: round(Math.max(0, seconds - FRAME_BEFORE_SECONDS)),
        afterSeconds: round(seconds + FRAME_AFTER_SECONDS),
      });
      seen.add(row.cmd);
    }
    elapsed += isNoWait(row) ? 0 : StoryPlayerCore.blockingSeconds({
      ...row, Duration: number(row.Duration), DelaySeconds: number(row.DelaySeconds),
    });
  }
  return checks;
};

const isPngName = (value) => typeof value === "string" && value.trim() !== "" &&
  path.extname(value).toLowerCase() === PNG_EXT;

const fileOf = (dir, value) => (path.isAbsolute(value) ? value : path.resolve(dir || ".", value));

// Report failures: no checks at all, a frame path that is absent/empty/not a PNG (and, when
// verifyFiles is set, not an extracted file), a non-numeric difference, missing ffmpeg
// provenance, or a camera checkpoint whose frames did not change.
export const validateFrameReport = (report, { dir = "", verifyFiles = false } = {}) => {
  const failures = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return [{ code: "report", message: "the frame report is not an object" }];
  }
  const checks = Array.isArray(report.checks) ? report.checks
    : Array.isArray(report.checkpoints) ? report.checkpoints : null;
  if (!checks) {
    failures.push({ code: "checks", message: "the frame report has no checks array" });
  } else if (checks.length === 0) {
    failures.push({ code: "zeroChecks", message: "the frame report has no checkpoints" });
  }

  const ffmpeg = report.ffmpeg;
  if (!ffmpeg || typeof ffmpeg !== "object" || Array.isArray(ffmpeg)) {
    failures.push({ code: "ffmpegMissing", message: "the frame report has no ffmpeg provenance" });
  } else if (ffmpeg.ok === false || ffmpeg.error) {
    failures.push({ code: "ffmpegFailed", message: `ffmpeg failed: ${ffmpeg.error || "unknown error"}` });
  } else if (typeof ffmpeg.version !== "string" || ffmpeg.version.trim() === "") {
    failures.push({ code: "ffmpegMissing", message: "the frame report has no ffmpeg version" });
  }

  for (const [index, check] of (checks || []).entries()) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      failures.push({ code: "check", index, message: `check ${index} is not an object` });
      continue;
    }
    const where = { index, i: check.i, cmd: check.cmd };
    for (const key of ["before", "after"]) {
      const value = check[key];
      if (!isPngName(value)) {
        failures.push({ ...where, code: "missingFrame", key,
                        message: `${check.cmd || `check ${index}`} has no ${key} PNG` });
      } else if (verifyFiles) {
        const file = fileOf(dir, value);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
          failures.push({ ...where, code: "missingFrameFile", key, file,
                          message: `${check.cmd || `check ${index}`} ${key} PNG is missing or empty: ${file}` });
        }
      }
    }
    const difference = check.meanAbsoluteDifference ?? check.difference;
    if (typeof difference !== "number" || !Number.isFinite(difference)) {
      failures.push({ ...where, code: "missingDifference",
                      message: `${check.cmd || `check ${index}`} has no numeric mean absolute difference` });
    }
    if (typeof check.changed !== "boolean") {
      failures.push({ ...where, code: "missingChanged", message: `${check.cmd || `check ${index}`} has no changed flag` });
    } else if (CAMERA.has(check.cmd) && check.changed === false) {
      failures.push({ ...where, code: "cameraUnchanged",
                      message: `${check.cmd} checkpoint at ${check.seconds}s did not change the frame` });
    }
  }
  return failures;
};

const onPath = (names) => {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return "";
};

const resolveFfmpeg = (explicit = "") => {
  if (explicit) return validateFfmpeg(explicit);
  if (process.env.OURNOTES_FFMPEG) return validateFfmpeg(process.env.OURNOTES_FFMPEG);
  try {
    return validateFfmpeg();
  } catch {
    const file = onPath(process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"]);
    if (file) return validateFfmpeg(file);
    throw new Error("ffmpeg is not available: install ffmpeg-static, set OURNOTES_FFMPEG or pass --ffmpeg");
  }
};

const probeNames = () => (process.platform === "win32" ? ["ffprobe.exe", "ffprobe"] : ["ffprobe"]);

const resolveFfprobe = (ffmpeg, explicit = "") => {
  const given = explicit || process.env.OURNOTES_FFPROBE || "";
  if (given) {
    const file = path.resolve(given);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      throw new Error(`ffprobe not found: ${file}`);
    if (!/^ffprobe(\.exe)?$/i.test(path.basename(file)))
      throw new Error(`refusing to run ${path.basename(file)}: the probe must be named ffprobe or ffprobe.exe`);
    return fs.realpathSync(file);
  }
  for (const name of probeNames()) {
    const sibling = path.join(path.dirname(ffmpeg), name);
    if (fs.existsSync(sibling) && fs.statSync(sibling).isFile()) return fs.realpathSync(sibling);
  }
  return onPath(probeNames());
};

const probe = (ffprobe, ffmpeg, video) => {
  if (ffprobe) {
    const run = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "json", video],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`ffprobe failed: ${String(run.stderr || "").trim() || `exit ${run.status}`}`);
    let parsed;
    try { parsed = JSON.parse(run.stdout); } catch (e) {
      throw new Error(`ffprobe output is not JSON: ${e.message}`, { cause: e });
    }
    const stream = parsed?.streams?.[0] || {};
    const width = Math.round(number(stream.width));
    const height = Math.round(number(stream.height));
    const duration = number(parsed?.format?.duration);
    if (!width || !height || !(duration > 0))
      throw new Error(`ffprobe did not report width/height/duration for ${video}`);
    return { tool: "ffprobe", path: ffprobe, width, height, duration };
  }
  // Fallback for a machine without ffprobe: ffmpeg prints the same stream and duration lines.
  const run = spawnSync(ffmpeg, ["-hide_banner", "-i", video], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const text = `${run.stdout || ""}${run.stderr || ""}`;
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text);
  const length = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (run.status === 0 || !size || !length)
    throw new Error(`cannot probe ${video}: ${text.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`);
  return {
    tool: "ffmpeg", path: ffmpeg,
    width: Number(size[1]), height: Number(size[2]),
    duration: Number(length[1]) * 3600 + Number(length[2]) * 60 + Number(length[3]),
  };
};

const ffmpegVersion = (ffmpeg) => {
  const run = spawnSync(ffmpeg, ["-version"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (run.status !== 0) return { ok: false, version: "", error: String(run.stderr || "").trim() || `exit ${run.status}` };
  return { ok: true, version: String(run.stdout || "").split(/\r?\n/)[0].trim(), error: "" };
};

const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  stream.on("error", reject);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(hash.digest("hex")));
});

const clampTime = (seconds, duration) => Math.min(Math.max(seconds, 0), Math.max(0, duration - 0.001));

const grabPng = (ffmpeg, video, seconds, png) => {
  const run = spawnSync(ffmpeg, ["-nostdin", "-hide_banner", "-v", "error", "-ss", String(seconds),
    "-i", video, "-frames:v", "1", "-y", png], { maxBuffer: 8 * 1024 * 1024 });
  if (run.status !== 0 || !fs.existsSync(png) || fs.statSync(png).size === 0)
    throw new Error(`ffmpeg PNG extraction failed at ${seconds}s: ${String(run.stderr || "").trim() || `exit ${run.status}`}`);
};

const grabGray = (ffmpeg, video, seconds) => {
  const run = spawnSync(ffmpeg, ["-nostdin", "-hide_banner", "-v", "error", "-ss", String(seconds),
    "-i", video, "-frames:v", "1", "-vf", `scale=${RAW_WIDTH}:${RAW_HEIGHT}`, "-pix_fmt", "gray",
    "-f", "rawvideo", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0 || !run.stdout || run.stdout.length < RAW_WIDTH * RAW_HEIGHT)
    throw new Error(`ffmpeg raw frame extraction failed at ${seconds}s: ` +
      `${String(run.stderr || "").trim() || "short output"}`);
  return run.stdout.subarray(0, RAW_WIDTH * RAW_HEIGHT);
};

const meanAbsoluteDifference = (a, b) => {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) total += Math.abs(a[i] - b[i]);
  return length ? total / length : 0;
};

const frameName = (check, side) => `${String(check.i).padStart(6, "0")}-${check.cmd}-${side}.png`;

export const auditFrames = async ({ video, episode, out, ffmpeg = "", ffprobe = "", logger = console } = {}) => {
  const videoFile = path.resolve(video);
  const episodeFile = path.resolve(episode);
  const outDir = path.resolve(out);
  if (!fs.existsSync(videoFile) || !fs.statSync(videoFile).isFile()) throw new Error(`video not found: ${videoFile}`);
  if (!fs.existsSync(episodeFile) || !fs.statSync(episodeFile).isFile())
    throw new Error(`episode not found: ${episodeFile}`);
  const episodeJson = JSON.parse(fs.readFileSync(episodeFile, "utf8"));
  const rows = rowsOf(episodeJson);
  if (!rows.length) throw new Error(`${episodeFile}: episode.commands is empty`);
  fs.mkdirSync(outDir, { recursive: true });

  const ffmpegPath = resolveFfmpeg(ffmpeg);
  const ffprobePath = resolveFfprobe(ffmpegPath, ffprobe);
  const info = probe(ffprobePath, ffmpegPath, videoFile);
  const version = ffmpegVersion(ffmpegPath);
  const checkpoints = frameCheckpoints(episodeJson);
  logger.info?.(`frame audit: ${rows.length} commands, ${checkpoints.length} checkpoints, ` +
    `${info.width}x${info.height}, ${round(info.duration, 3)} s`);

  const report = {
    video: {
      path: videoFile,
      sha256: await sha256(videoFile),
      duration: round(info.duration, 3),
      width: info.width,
      height: info.height,
    },
    episode: { path: episodeFile, commandCount: rows.length },
    ffmpeg: { path: ffmpegPath, version: version.version, ok: version.ok, error: version.error,
              probe: { tool: info.tool, path: info.path || "" } },
    checks: [],
    failures: [],
  };

  for (const checkpoint of checkpoints) {
    const beforeAt = round(clampTime(checkpoint.beforeSeconds, info.duration));
    const afterAt = round(clampTime(checkpoint.afterSeconds, info.duration));
    const check = {
      i: checkpoint.i,
      cmd: checkpoint.cmd,
      seconds: checkpoint.seconds,
      beforeSeconds: beforeAt,
      afterSeconds: afterAt,
      before: frameName(checkpoint, "before"),
      after: frameName(checkpoint, "after"),
      meanAbsoluteDifference: null,
      changed: false,
    };
    try {
      grabPng(ffmpegPath, videoFile, beforeAt, path.join(outDir, check.before));
      grabPng(ffmpegPath, videoFile, afterAt, path.join(outDir, check.after));
      const beforeGray = grabGray(ffmpegPath, videoFile, beforeAt);
      const afterGray = grabGray(ffmpegPath, videoFile, afterAt);
      const difference = meanAbsoluteDifference(beforeGray, afterGray);
      check.meanAbsoluteDifference = round(difference, 4);
      check.changed = difference > CHANGE_THRESHOLD;
    } catch (e) {
      check.error = e.message;
      report.ffmpeg.ok = false;
      report.ffmpeg.error = report.ffmpeg.error || e.message;
      logger.warn?.(`${check.cmd} at ${check.seconds}s: ${e.message}`);
    }
    report.checks.push(check);
  }

  report.failures = validateFrameReport(report, { dir: outDir, verifyFiles: true });
  const reportPath = path.join(outDir, "frame-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  logger.info?.(`frame report: ${reportPath} (${report.failures.length} failures)`);
  return { report, reportPath };
};

const parseArgs = (argv) => {
  const options = { video: "", episode: "", out: "", ffmpeg: "", ffprobe: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value == null || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--video") options.video = next();
    else if (arg === "--episode") options.episode = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--ffmpeg") options.ffmpeg = next();
    else if (arg === "--ffprobe") options.ffprobe = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.help) return options;
  if (!options.video) throw new Error("--video is required");
  if (!options.episode) throw new Error("--episode is required");
  if (!options.out) throw new Error("--out is required (the directory for frames and frame-report.json)");
  return options;
};

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("usage: node scripts/stories/frame-audit.mjs --video <mp4> --episode <episode.json> --out <dir> " +
      "[--ffmpeg <file>] [--ffprobe <file>]");
    return null;
  }
  const { report, reportPath } = await auditFrames(options);
  const summary = {
    ok: report.failures.length === 0,
    report: reportPath,
    checks: report.checks.length,
    cameraChecks: report.checks.filter((check) => CAMERA.has(check.cmd)).length,
    changed: report.checks.filter((check) => check.changed).length,
    failures: report.failures,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
  return report;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`frame-audit: ${e.message}`);
    process.exitCode = 1;
  });
}
