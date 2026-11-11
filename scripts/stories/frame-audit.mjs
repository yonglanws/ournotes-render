// Frame audit: a real MP4 is probed, full-resolution PNG stills are extracted around the command
// timeline the renderer recorded, and a 160x90 grayscale difference decides whether the frame
// actually changed. There is no host-side duration model: `page.js` reports the story clock when
// each row starts, the renderer writes that sidecar next to the MP4, and this audit cuts against
// those timestamps.
//
//   node scripts/stories/frame-audit.mjs --video frame-check.mp4 \
//     --episode frame-check.episode.json --timeline frame-check.timeline.json --out frames \
//     [--ffmpeg ffmpeg] [--ffprobe ffprobe]
//
// Checks name PNG basenames inside --out; the report stores relative paths only, so it is
// deterministic for the same inputs and does not leak the machine's directory layout.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateFfmpeg } from "../../host/render/ffmpeg.js";

export const CAMERA_COMMANDS = Object.freeze(["Focus", "Zoom", "Pedestal", "PanV2", "DoF", "Track"]);
export const CHECKPOINT_COMMANDS = Object.freeze([
  ...CAMERA_COMMANDS, "Se", "Motion", "LookTarget", "In", "Out",
]);
export const FRAME_BEFORE_SECONDS = 0.15;
export const FRAME_AFTER_SECONDS = 0.45;
export const DEFAULT_SETTLE_SECONDS = 1.0;
export const RAW_WIDTH = 160;
export const RAW_HEIGHT = 90;
export const CHANGE_THRESHOLD = 1.0;

const CAMERA = new Set(CAMERA_COMMANDS);
const CHECKPOINT = new Set(CHECKPOINT_COMMANDS);
const CAMERA_ORDER = ["Focus", "Zoom", "Pedestal", "PanV2", "DoF", "Track"];
const OTHER_ORDER = ["Se", "Motion", "LookTarget", "In", "Out"];
const PNG_EXT = ".png";
const SHA256 = /^[0-9a-f]{64}$/i;

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

const isSha256 = (value) => typeof value === "string" && SHA256.test(value);

const rowsOf = (episode) => (Array.isArray(episode?.commands) ? episode.commands : []);

const timelineEntries = (timeline) => {
  const entries = Array.isArray(timeline) ? timeline
    : Array.isArray(timeline?.commands) ? timeline.commands : null;
  if (!entries) throw new Error("frameCheckpoints needs the renderer timeline ({version, commands: [{i, cmd, seconds}]})");
  return entries;
};

const windowKey = (check) => `${check.beforeSeconds}|${check.afterSeconds}`;

// Checkpoints come from the renderer's command timestamps. The opening settle is skipped, a camera
// command prefers a non-zero-duration move (the longest one), and no two checkpoints share a frame
// window: a duplicate pair would be the same picture labelled twice, not evidence for both rows.
export const frameCheckpoints = (episode, timeline, { settleSeconds = DEFAULT_SETTLE_SECONDS } = {}) => {
  if (!Number.isFinite(settleSeconds) || settleSeconds < 0)
    throw new Error(`settleSeconds must be a non-negative number (got ${settleSeconds})`);
  const times = new Map();
  const starts = [];
  for (const entry of timelineEntries(timeline)) {
    if (!entry || !Number.isInteger(entry.i) || entry.i < 0 || typeof entry.cmd !== "string") continue;
    if (!Number.isFinite(entry.seconds) || entry.seconds < 0) continue;
    if (!times.has(entry.i)) times.set(entry.i, { cmd: entry.cmd, seconds: entry.seconds });
    starts.push(round(entry.seconds));
  }
  starts.sort((a, b) => a - b);
  const candidates = new Map();
  for (const row of rowsOf(episode)) {
    if (!row || typeof row !== "object" || !CHECKPOINT.has(row.cmd)) continue;
    const at = times.get(row.i);
    if (!at || at.cmd !== row.cmd) continue;
    if (!(at.seconds >= settleSeconds)) continue;
    const commandSeconds = round(at.seconds);
    const effectSeconds = round(commandSeconds + Math.max(number(row.DelaySeconds), 0));
    // Never let the after frame sample the next command's effect: cap at the next start (one frame earlier).
    const nextStart = starts.find((value) => value > effectSeconds + 0.05);
    const cappedAfter = nextStart == null ? effectSeconds + FRAME_AFTER_SECONDS
      : Math.min(effectSeconds + FRAME_AFTER_SECONDS, nextStart - 0.04);
    const afterSeconds = round(Math.max(effectSeconds + 0.04, cappedAfter));
    const check = {
      i: row.i,
      cmd: row.cmd,
      seconds: effectSeconds,
      commandSeconds,
      beforeSeconds: round(Math.max(0, effectSeconds - FRAME_BEFORE_SECONDS)),
      afterSeconds,
      duration: round(number(row.Duration)),
      lowerBound: false,
      clamped: false,
      afterCapped: afterSeconds < round(effectSeconds + FRAME_AFTER_SECONDS) - 1e-9,
    };
    if (!candidates.has(row.cmd)) candidates.set(row.cmd, []);
    candidates.get(row.cmd).push(check);
  }
  const byTime = (a, b) => a.seconds - b.seconds || a.i - b.i;
  // A non-zero camera move is real evidence; a cut is the fallback only when the episode has no
  // move of that kind after the settle.
  const byPreference = (a, b) => {
    const am = a.duration > 0 ? 1 : 0, bm = b.duration > 0 ? 1 : 0;
    if (am !== bm) return bm - am;
    if (a.duration !== b.duration) return b.duration - a.duration;
    return byTime(a, b);
  };
  const chosen = [];
  const used = new Set();
  for (const cmd of OTHER_ORDER) {
    const list = [...(candidates.get(cmd) || [])].sort(byTime);
    if (!list.length) continue;
    chosen.push(list[0]);
    used.add(windowKey(list[0]));
  }
  for (const cmd of CAMERA_ORDER) {
    const list = [...(candidates.get(cmd) || [])].sort(byPreference);
    const pick = list.find((check) => !used.has(windowKey(check)));
    if (!pick) continue;
    chosen.push(pick);
    used.add(windowKey(pick));
  }
  return chosen.sort(byTime);
};

// Frame-accurate target: a time beyond the last decoded frame is a hard failure, a negative one is
// clamped to the first frame. `lastFrameAt` is duration - 1/fps from ffprobe.
export const frameTarget = (seconds, video) => {
  const last = number(video?.lastFrameAt);
  if (!(last >= 0)) throw new Error("frameTarget needs the video's lastFrameAt");
  const value = round(number(seconds));
  if (value > last) {
    return { time: round(last), clamped: true,
             failure: `checkpoint ${value}s is after the last frame at ${round(last)}s` };
  }
  if (value < 0) return { time: 0, clamped: true, failure: "" };
  return { time: value, clamped: false, failure: "" };
};

// The same before/after PNG pair under two rows is one picture labelled twice. This is reported for
// every pair; only camera checks are fatal (a non-camera row may legitimately share a staging window
// with another non-camera row).
export const duplicateFramePairs = (checks = []) => {
  const groups = new Map();
  for (const check of checks) {
    if (!check || !isSha256(check.beforeSha256) || !isSha256(check.afterSha256)) continue;
    const key = `${check.beforeSha256.toLowerCase()}:${check.afterSha256.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ i: check.i, cmd: check.cmd });
  }
  return [...groups.entries()].filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, checks: list.sort((a, b) => a.i - b.i) }))
    .sort((a, b) => a.key.localeCompare(b.key));
};

const framePathProblem = (value) => {
  if (typeof value !== "string" || value.trim() === "") return "missing";
  if (path.extname(value).toLowerCase() !== PNG_EXT) return "missing";
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return "unsafe";
  if (value.split(/[\\/]+/).some((part) => part === ".." || part === ".")) return "unsafe";
  return "";
};

const within = (dir, value) => {
  const file = path.resolve(dir, value);
  const rel = path.relative(path.resolve(dir), file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return file;
};

// Report failures: no checks, missing/unsafe frame paths, missing hashes, a numeric difference that
// disagrees with `changed`, a camera row that did not change, duplicate camera frames, a frame
// failure, missing renderer/environment provenance, or an invalid timeline entry.
export const validateFrameReport = (report, { dir = "", verifyFiles = false } = {}) => {
  const failures = [];
  const fail = (code, message, extra = {}) => failures.push({ code, message, ...extra });
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return [{ code: "report", message: "the frame report is not an object" }];
  }
  if (report.version !== 2) fail("reportVersion", `the frame report version is ${report.version}, not 2`);

  let threshold = CHANGE_THRESHOLD;
  const method = report.method;
  if (!method || typeof method !== "object" || Array.isArray(method)) {
    fail("methodMissing", "the frame report has no method block");
  } else {
    if (method.timing !== "renderer")
      fail("timelineNotRenderer", `the timeline is ${method.timing || "missing"}, not the renderer's command clock`);
    if (typeof method.threshold !== "number" || !(method.threshold > 0)) {
      fail("methodField", "method.threshold is not a positive number", { field: "threshold" });
    } else threshold = method.threshold;
    for (const field of ["rawWidth", "rawHeight"]) {
      if (!Number.isInteger(method[field]) || method[field] <= 0)
        fail("methodField", `method.${field} is not a positive integer`, { field });
    }
    for (const field of ["beforeSeconds", "afterSeconds", "settleSeconds"]) {
      if (typeof method[field] !== "number" || !Number.isFinite(method[field]) || method[field] < 0)
        fail("methodField", `method.${field} is not a non-negative number`, { field });
    }
    const timeline = method.timeline;
    if (!timeline || typeof timeline !== "object" || !isSha256(timeline.sha256) ||
        !Number.isInteger(timeline.commands) || timeline.commands < 0 ||
        typeof timeline.videoStart !== "number" || !Number.isFinite(timeline.videoStart) || timeline.videoStart < 0) {
      fail("timelineMissing", "the method block has no renderer timeline provenance");
    }
  }

  const video = report.video;
  if (!video || typeof video !== "object" || Array.isArray(video)) {
    fail("videoMissing", "the frame report has no video block");
  } else {
    if (!isSha256(video.sha256)) fail("missingVideoSha", "the video has no sha256");
    if (!(typeof video.duration === "number" && video.duration > 0))
      fail("videoField", "video.duration is not positive", { field: "duration" });
    if (!(typeof video.lastFrameAt === "number" && video.lastFrameAt >= 0))
      fail("videoField", "video.lastFrameAt is not non-negative", { field: "lastFrameAt" });
    if (!(typeof video.fps === "number" && video.fps > 0))
      fail("videoField", "video.fps is not positive", { field: "fps" });
    for (const field of ["width", "height"]) {
      if (!Number.isInteger(video[field]) || video[field] <= 0)
        fail("videoField", `video.${field} is not a positive integer`, { field });
    }
  }

  const episode = report.episode;
  if (!episode || typeof episode !== "object" || Array.isArray(episode)) {
    fail("episodeMissing", "the frame report has no episode block");
  } else {
    if (!isSha256(episode.sha256)) fail("missingEpisodeSha", "the episode has no sha256");
    if (!Number.isInteger(episode.commandCount) || episode.commandCount < 0)
      fail("episodeField", "episode.commandCount is not a non-negative integer", { field: "commandCount" });
  }

  const ffmpeg = report.ffmpeg;
  if (!ffmpeg || typeof ffmpeg !== "object" || Array.isArray(ffmpeg)) {
    fail("ffmpegMissing", "the frame report has no ffmpeg provenance");
  } else {
    if (ffmpeg.ok === false || ffmpeg.error) fail("ffmpegFailed", `ffmpeg failed: ${ffmpeg.error || "unknown error"}`);
    if (typeof ffmpeg.version !== "string" || ffmpeg.version.trim() === "")
      fail("ffmpegMissing", "the frame report has no ffmpeg version");
    if (!ffmpeg.probe || typeof ffmpeg.probe.version !== "string" || ffmpeg.probe.version.trim() === "")
      fail("ffmpegMissing", "the frame report has no ffprobe version");
  }

  const checks = Array.isArray(report.checks) ? report.checks
    : Array.isArray(report.checkpoints) ? report.checkpoints : null;
  if (!checks) {
    fail("checks", "the frame report has no checks array");
  } else if (checks.length === 0) {
    fail("zeroChecks", "the frame report has no checkpoints");
  }
  if (!Array.isArray(report.duplicates)) fail("duplicates", "the frame report has no duplicate-frame list");

  for (const [index, check] of (checks || []).entries()) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      fail("check", `check ${index} is not an object`, { index });
      continue;
    }
    const where = { index, i: check.i, cmd: check.cmd };
    if (!Number.isInteger(check.i) || check.i < 0) fail("invalidIndex", `check ${index} has no valid i`, where);
    if (typeof check.cmd !== "string" || check.cmd.trim() === "")
      fail("invalidCommand", `check ${index} has no command`, where);
    if (typeof check.seconds !== "number" || !Number.isFinite(check.seconds) || check.seconds < 0)
      fail("invalidSeconds", `check ${index} has no valid seconds`, where);
    if (typeof check.commandSeconds !== "number" || !Number.isFinite(check.commandSeconds) ||
        check.commandSeconds < 0 || check.commandSeconds > check.seconds + 1e-9)
      fail("invalidCommandSeconds", `check ${index} has no valid commandSeconds`, where);
    for (const key of ["before", "after"]) {
      const problem = framePathProblem(check[key]);
      if (problem === "missing") {
        fail("missingFrame", `${check.cmd || `check ${index}`} has no ${key} PNG`, { ...where, key });
      } else if (problem === "unsafe") {
        fail("unsafeFramePath", `${check.cmd || `check ${index}`} ${key} path is absolute or escapes the output`,
             { ...where, key, value: check[key] });
      } else if (verifyFiles) {
        const file = within(dir, check[key]);
        if (!file) {
          fail("unsafeFramePath", `${check.cmd || `check ${index}`} ${key} path escapes the output directory`,
               { ...where, key, value: check[key] });
        } else if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
          fail("missingFrameFile", `${check.cmd || `check ${index}`} ${key} PNG is missing or empty: ${file}`,
               { ...where, key, file });
        }
      }
    }
    for (const key of ["beforeSha256", "afterSha256"]) {
      if (!isSha256(check[key])) fail("missingFrameHash", `${check.cmd || `check ${index}`} has no ${key}`, { ...where, key });
    }
    const difference = check.meanAbsoluteDifference ?? check.difference;
    if (typeof difference !== "number" || !Number.isFinite(difference)) {
      fail("missingDifference", `${check.cmd || `check ${index}`} has no numeric mean absolute difference`, where);
    }
    if (typeof check.changed !== "boolean") {
      fail("missingChanged", `${check.cmd || `check ${index}`} has no changed flag`, where);
    } else if (typeof difference === "number" && Number.isFinite(difference) &&
               check.changed !== (difference > threshold)) {
      fail("changedMismatch", `${check.cmd || `check ${index}`} changed=${check.changed} but difference ` +
        `${difference} against threshold ${threshold}`, where);
    }
    for (const key of ["lowerBound", "clamped", "afterCapped"]) {
      if (typeof check[key] !== "boolean") fail("missingFlag", `${check.cmd || `check ${index}`} has no ${key} flag`,
                                                 { ...where, key });
    }
    if (check.lowerBound === true && CAMERA.has(check.cmd))
      fail("lowerBoundCamera", `${check.cmd} checkpoint is a lower bound, not a renderer timestamp`, where);
    if (CAMERA.has(check.cmd) && check.changed === false)
      fail("cameraUnchanged", `${check.cmd} checkpoint at ${check.seconds}s did not change the frame`, where);
    if (typeof check.frameFailure === "string" && check.frameFailure.trim() !== "")
      fail("frameFailure", check.frameFailure, { ...where, kind: check.frameFailureKind || "" });
  }

  for (const pair of duplicateFramePairs(checks || [])) {
    const camera = pair.checks.filter((member) => CAMERA.has(member.cmd));
    for (const member of camera) {
      fail("duplicateFrames", `${member.cmd} checkpoint ${member.i} duplicates another checkpoint's frame pair`,
           { i: member.i, cmd: member.cmd });
    }
  }
  return failures;
};

const resolveFfmpeg = (explicit = "") => {
  if (explicit) return validateFfmpeg(explicit);
  if (process.env.OURNOTES_FFMPEG) return validateFfmpeg(process.env.OURNOTES_FFMPEG);
  return validateFfmpeg();
};

const resolveFfprobe = (ffmpeg, explicit = "") => {
  const given = explicit || process.env.OURNOTES_FFPROBE || "";
  if (given) {
    const file = path.resolve(given);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`ffprobe not found: ${file}`);
    if (!/^ffprobe(\.exe)?$/i.test(path.basename(file)))
      throw new Error(`refusing to run ${path.basename(file)}: the probe must be named ffprobe or ffprobe.exe`);
    return fs.realpathSync(file);
  }
  // A bundled probe beside the pinned ffmpeg; PATH is never scanned.
  for (const name of process.platform === "win32" ? ["ffprobe.exe", "ffprobe"] : ["ffprobe"]) {
    const sibling = path.join(path.dirname(ffmpeg), name);
    if (fs.existsSync(sibling) && fs.statSync(sibling).isFile()) return fs.realpathSync(sibling);
  }
  throw new Error("ffprobe is not available: pass --ffprobe or set OURNOTES_FFPROBE to a pinned ffprobe");
};

const toolVersion = (file) => {
  const run = spawnSync(file, ["-version"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (run.status !== 0)
    return { ok: false, version: "", error: String(run.stderr || "").trim() || `exit ${run.status}` };
  return { ok: true, version: String(run.stdout || "").split(/\r?\n/)[0].trim(), error: "" };
};

const ratio = (value) => {
  const parts = String(value || "").split("/").map(Number);
  if (parts.length === 2 && parts[1] > 0) return parts[0] / parts[1];
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const probeVideo = (ffprobe, video) => {
  const run = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate",
    "-show_entries", "format=duration", "-of", "json", video],
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
  const fps = ratio(stream.avg_frame_rate) || ratio(stream.r_frame_rate);
  if (!width || !height || !(duration > 0) || !(fps > 0))
    throw new Error(`ffprobe did not report width/height/duration/fps for ${video}`);
  return { path: video, width, height, duration, fps, lastFrameAt: Math.max(0, duration - 1 / fps) };
};

const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file);
  stream.on("error", reject);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(hash.digest("hex")));
});

const reportPath = (dir, file) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return path.basename(file);
  return rel.split(path.sep).join("/");
};

const seekArgs = (target, video) => {
  // Within half a second of the end, seek from EOF so a frame-accurate last frame is still decoded.
  if (target >= video.lastFrameAt - 0.5) {
    const offset = Math.min(video.duration, Math.max(0.05, video.duration - target + 0.05));
    return ["-sseof", `-${offset.toFixed(3)}`];
  }
  return ["-ss", String(target)];
};

const noFrame = (what, seconds) => {
  const error = new Error(`ffmpeg produced no output ${what} at ${seconds}s`);
  error.kind = "no-frame";
  return error;
};

const processFailure = (what, seconds, run) => {
  const error = new Error(`ffmpeg ${what} process failed at ${seconds}s: ` +
    `${String(run.stderr || "").trim() || `exit ${run.status}`}`);
  error.kind = "ffmpeg-process";
  return error;
};

const grabPng = (ffmpeg, video, seconds, png) => {
  const run = spawnSync(ffmpeg, ["-nostdin", "-hide_banner", "-v", "error", ...seekArgs(seconds, video),
    "-i", video.path, "-frames:v", "1", "-y", png], { maxBuffer: 8 * 1024 * 1024 });
  if (run.status !== 0) throw processFailure("PNG", seconds, run);
  if (!fs.existsSync(png) || fs.statSync(png).size === 0) throw noFrame("PNG frame", seconds);
};

const grabGray = (ffmpeg, video, seconds) => {
  const run = spawnSync(ffmpeg, ["-nostdin", "-hide_banner", "-v", "error", ...seekArgs(seconds, video),
    "-i", video.path, "-frames:v", "1", "-vf", `scale=${RAW_WIDTH}:${RAW_HEIGHT}`, "-pix_fmt", "gray",
    "-f", "rawvideo", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw processFailure("raw frame", seconds, run);
  if (!run.stdout || run.stdout.length < RAW_WIDTH * RAW_HEIGHT) throw noFrame("raw frame", seconds);
  return run.stdout.subarray(0, RAW_WIDTH * RAW_HEIGHT);
};

const meanAbsoluteDifference = (a, b) => {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) total += Math.abs(a[i] - b[i]);
  return length ? total / length : 0;
};

const frameName = (check, side) => `${String(check.i).padStart(6, "0")}-${check.cmd}-${side}.png`;

export const auditFrames = async ({ video, episode, timeline, out, ffmpeg = "", ffprobe = "",
                                     logger = console } = {}) => {
  if (!video) throw new Error("--video is required");
  if (!episode) throw new Error("--episode is required");
  if (!timeline) throw new Error("--timeline is required (the renderer's <job>.timeline.json)");
  if (!out) throw new Error("--out is required (the directory for frames and frame-report.json)");
  const videoFile = path.resolve(video);
  const episodeFile = path.resolve(episode);
  const timelineFile = path.resolve(timeline);
  const outDir = path.resolve(out);
  for (const [what, file] of [["video", videoFile], ["episode", episodeFile], ["timeline", timelineFile]]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${what} not found: ${file}`);
  }
  const episodeJson = JSON.parse(fs.readFileSync(episodeFile, "utf8"));
  const rows = rowsOf(episodeJson);
  if (!rows.length) throw new Error(`${episodeFile}: episode.commands is empty`);
  const timelineJson = JSON.parse(fs.readFileSync(timelineFile, "utf8"));
  const entries = timelineEntries(timelineJson);
  const byIndex = new Map(rows.filter((row) => row && Number.isInteger(row.i)).map((row) => [row.i, row]));
  for (const entry of entries) {
    if (!entry || !Number.isInteger(entry.i) || entry.i < 0) continue;
    const row = byIndex.get(entry.i);
    if (row && row.cmd !== entry.cmd)
      throw new Error(`timeline row ${entry.i} is ${entry.cmd}, but the episode says ${row.cmd}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const ffmpegPath = resolveFfmpeg(ffmpeg);
  const ffprobePath = resolveFfprobe(ffmpegPath, ffprobe);
  const info = probeVideo(ffprobePath, videoFile);
  const ffmpegVersion = toolVersion(ffmpegPath);
  const probeVersion = toolVersion(ffprobePath);
  if (!ffmpegVersion.ok) throw new Error(`ffmpeg -version failed: ${ffmpegVersion.error}`);
  if (!probeVersion.ok) throw new Error(`ffprobe -version failed: ${probeVersion.error}`);
  const checkpoints = frameCheckpoints(episodeJson, timelineJson);
  logger.info?.(`frame audit: ${rows.length} commands, ${checkpoints.length} checkpoints, ` +
    `${info.width}x${info.height} @ ${round(info.fps, 3)} fps, ${round(info.duration, 3)} s`);

  const report = {
    version: 2,
    method: {
      timing: "renderer",
      threshold: CHANGE_THRESHOLD,
      rawWidth: RAW_WIDTH,
      rawHeight: RAW_HEIGHT,
      beforeSeconds: FRAME_BEFORE_SECONDS,
      afterSeconds: FRAME_AFTER_SECONDS,
      settleSeconds: DEFAULT_SETTLE_SECONDS,
      timeline: {
        path: reportPath(outDir, timelineFile),
        sha256: await sha256File(timelineFile),
        commands: entries.length,
        videoStart: round(number(timelineJson.videoStart)),
      },
    },
    video: {
      path: reportPath(outDir, videoFile),
      sha256: await sha256File(videoFile),
      duration: round(info.duration, 3),
      width: info.width,
      height: info.height,
      fps: round(info.fps, 3),
      lastFrameAt: round(info.lastFrameAt, 3),
    },
    episode: {
      path: reportPath(outDir, episodeFile),
      sha256: await sha256File(episodeFile),
      commandCount: rows.length,
    },
    ffmpeg: {
      version: ffmpegVersion.version,
      ok: true,
      error: "",
      probe: { version: probeVersion.version },
    },
    checks: [],
    duplicates: [],
    failures: [],
  };

  for (const checkpoint of checkpoints) {
    const before = frameTarget(checkpoint.beforeSeconds, info);
    const after = frameTarget(checkpoint.afterSeconds, info);
    const check = {
      i: checkpoint.i,
      cmd: checkpoint.cmd,
      seconds: checkpoint.seconds,
      commandSeconds: checkpoint.commandSeconds,
      duration: checkpoint.duration,
      beforeSeconds: before.time,
      afterSeconds: after.time,
      before: frameName(checkpoint, "before"),
      after: frameName(checkpoint, "after"),
      beforeSha256: null,
      afterSha256: null,
      meanAbsoluteDifference: null,
      changed: false,
      lowerBound: checkpoint.lowerBound,
      clamped: before.clamped || after.clamped,
      afterCapped: checkpoint.afterCapped,
    };
    const targetFailure = before.failure || after.failure;
    if (targetFailure) {
      check.frameFailure = targetFailure;
      check.frameFailureKind = "duration";
      logger.warn?.(`${check.cmd} at ${check.seconds}s: ${targetFailure}`);
    } else {
      try {
        grabPng(ffmpegPath, info, before.time, path.join(outDir, check.before));
        grabPng(ffmpegPath, info, after.time, path.join(outDir, check.after));
        check.beforeSha256 = await sha256File(path.join(outDir, check.before));
        check.afterSha256 = await sha256File(path.join(outDir, check.after));
        const beforeGray = grabGray(ffmpegPath, info, before.time);
        const afterGray = grabGray(ffmpegPath, info, after.time);
        const difference = meanAbsoluteDifference(beforeGray, afterGray);
        check.meanAbsoluteDifference = round(difference, 4);
        check.changed = check.meanAbsoluteDifference > CHANGE_THRESHOLD;
      } catch (e) {
        check.frameFailure = e.message;
        check.frameFailureKind = e.kind || "extraction";
        if (e.kind === "ffmpeg-process") {
          report.ffmpeg.ok = false;
          report.ffmpeg.error = report.ffmpeg.error || e.message;
        }
        logger.warn?.(`${check.cmd} at ${check.seconds}s: ${e.message}`);
      }
    }
    report.checks.push(check);
  }

  report.duplicates = duplicateFramePairs(report.checks);
  report.failures = validateFrameReport(report, { dir: outDir, verifyFiles: true });
  const reportFile = path.join(outDir, "frame-report.json");
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  logger.info?.(`frame report: ${reportFile} (${report.failures.length} failures)`);
  return { report, reportPath: reportFile };
};

const parseArgs = (argv) => {
  const options = { video: "", episode: "", timeline: "", out: "", ffmpeg: "", ffprobe: "", help: false };
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
    else if (arg === "--timeline") options.timeline = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--ffmpeg") options.ffmpeg = next();
    else if (arg === "--ffprobe") options.ffprobe = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.help) return options;
  if (!options.video) throw new Error("--video is required");
  if (!options.episode) throw new Error("--episode is required");
  if (!options.timeline) throw new Error("--timeline is required");
  if (!options.out) throw new Error("--out is required (the directory for frames and frame-report.json)");
  return options;
};

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("usage: node scripts/stories/frame-audit.mjs --video <mp4> --episode <episode.json> " +
      "--timeline <timeline.json> --out <dir> [--ffmpeg <file>] [--ffprobe <file>]");
    return null;
  }
  const { report, reportPath } = await auditFrames(options);
  const summary = {
    ok: report.failures.length === 0,
    report: reportPath,
    checks: report.checks.length,
    cameraChecks: report.checks.filter((check) => CAMERA.has(check.cmd)).length,
    changed: report.checks.filter((check) => check.changed).length,
    duplicates: report.duplicates.length,
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
