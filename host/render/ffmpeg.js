// ffmpeg helpers: one validated binary, argument arrays only (never a shell), TTS audio normalization, and MP4
// encoding. The executable cannot be chosen by a request: it is the bundled ffmpeg-static build, or an operator
// configured absolute path whose file name is ffmpeg / ffmpeg.exe. PATH is not scanned.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const FFMPEG_NAMES = new Set(["ffmpeg", "ffmpeg.exe"]);

export const validateFfmpeg = (explicit = "") => {
  let file = "";
  if (explicit) file = path.resolve(String(explicit));
  else {
    try {
      const p = require("ffmpeg-static");
      if (typeof p === "string" && p) file = path.resolve(p);
    } catch { /* not installed */ }
  }
  if (!file) throw new Error("ffmpeg is not available: run npm install at the repository root (ffmpeg-static) or set " +
    "video.ffmpegPath / OURNOTES_FFMPEG to an ffmpeg executable");
  if (!FFMPEG_NAMES.has(path.basename(file).toLowerCase()))
    throw new Error(`refusing to run ${path.basename(file)}: the executable must be named ffmpeg or ffmpeg.exe`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`ffmpeg not found: ${file}`);
  return fs.realpathSync(file);
};

let binary = null;
export const configureFfmpeg = (explicit = "") => (binary = validateFfmpeg(explicit));

export const runFfmpeg = (args, { signal = null, onStderr = null } = {}) => new Promise((resolve, reject) => {
  if (!binary) throw new Error("ffmpeg is not configured: call configureFfmpeg() first");
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderr += s;
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
    onStderr?.(s);
  });
  const abort = () => { try { child.kill("SIGKILL"); } catch { /* ended */ } };
  if (signal) {
    if (signal.aborted) { abort(); return reject(signal.reason || new Error("aborted")); }
    signal.addEventListener("abort", abort, { once: true });
  }
  child.on("error", (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
  child.on("close", (code) => {
    signal?.removeEventListener?.("abort", abort);
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    if (code === 0) resolve({ stderr });
    else reject(new Error(`ffmpeg exited with ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-6).join(" | ")}`));
  });
});

export const normalizeWav = async ({ input, output, sampleRate = 48000, signal = null }) => {
  await runFfmpeg(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ac", "1", "-ar", String(sampleRate),
    "-sample_fmt", "s16", "-c:a", "pcm_s16le", output], { signal });
  return output;
};

// Decode any audio file ffmpeg understands to interleaved float32 stereo at `sampleRate`.
// -> {samples: Float32Array, frames, sampleRate, channels: 2}
export const decodePcm = (input, { sampleRate = 48000, signal = null } = {}) => new Promise((resolve, reject) => {
  if (!binary) return reject(new Error("ffmpeg is not configured: call configureFfmpeg() first"));
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", input, "-f", "f32le", "-ac", "2",
    "-ar", String(sampleRate), "-"];
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const chunks = [];
  let stderr = "";
  child.stdout.on("data", (c) => chunks.push(c));
  child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
  const abort = () => { try { child.kill("SIGKILL"); } catch { /* ended */ } };
  if (signal) {
    if (signal.aborted) { abort(); return reject(signal.reason || new Error("aborted")); }
    signal.addEventListener("abort", abort, { once: true });
  }
  child.on("error", (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
  child.on("close", (code) => {
    signal?.removeEventListener?.("abort", abort);
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    if (code !== 0) return reject(new Error(`ffmpeg decode failed: ${stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ")}`));
    const buf = Buffer.concat(chunks);
    const copy = new ArrayBuffer(buf.length - (buf.length % 4));
    Buffer.from(copy).set(buf.subarray(0, copy.byteLength));
    const samples = new Float32Array(copy);
    resolve({ samples, frames: Math.floor(samples.length / 2), sampleRate, channels: 2 });
  });
});

const ENCODERS = {
  nvidia: { codec: "h264_nvenc", args: ["-preset", "p5", "-rc", "vbr", "-cq", "20", "-b:v", "0"] },
  amd: { codec: "h264_amf", args: ["-quality", "balanced", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"] },
  intel: { codec: "h264_qsv", args: ["-preset", "medium", "-global_quality", "20"] },
  libx264: { codec: "libx264", args: ["-preset", "veryfast", "-crf", "20"] },
};

const withCrf = (args, crf) => args.map((a) => (a === "20" ? String(crf) : a));

const encoderOrder = (choice, crf, preset) => {
  const custom = (codec, args) => ({ codec, args });
  const x264 = custom("libx264", ["-preset", preset || "veryfast", "-crf", String(crf)]);
  if (choice && choice !== "auto") {
    if (choice === "libx264") return [x264];
    const e = ENCODERS[choice];
    return e ? [custom(e.codec, withCrf(e.args, crf))] : [x264];
  }
  return [ENCODERS.nvidia, ENCODERS.amd, ENCODERS.intel, x264].map((e) =>
    e.codec === "libx264" ? x264 : custom(e.codec, withCrf(e.args, crf)));
};

// Cached per-process 1-frame encoder probe results keyed by `${binary}\0${codec}` (and QSV vs libx264 comparison).
const encoderProbeCache = new Map();
export const resetEncoderProbeCache = () => encoderProbeCache.clear();

const runFfmpegPipe = (args, frames, { bin = binary, signal = null } = {}) => new Promise((resolve, reject) => {
  if (!bin) return reject(new Error("ffmpeg is not configured: call configureFfmpeg() first"));
  const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  child.stdin.on("error", () => { /* ffmpeg may exit before reading all input */ });
  const abort = () => { try { child.kill("SIGKILL"); } catch { /* ended */ } };
  if (signal) {
    if (signal.aborted) { abort(); return reject(signal.reason || new Error("aborted")); }
    signal.addEventListener("abort", abort, { once: true });
  }
  child.on("error", (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
  child.on("close", (code) => {
    signal?.removeEventListener?.("abort", abort);
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    if (code === 0) resolve({ stderr });
    else reject(new Error(`ffmpeg exited with ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ")}`));
  });
  (async () => {
    try {
      for (const frame of frames) {
        if (child.stdin.destroyed || child.exitCode !== null) break;
        if (!child.stdin.write(frame)) {
          await new Promise((r) => child.stdin.once("drain", r));
        }
      }
      if (!child.stdin.destroyed) child.stdin.end();
    } catch { /* close handler reports exit code */ }
  })();
});

const PROBE_FRAME_128 = Buffer.alloc(128 * 128 * 3);

const probeEncoderOnce = (enc, { bin = binary, signal = null } = {}) => {
  if (!bin) return Promise.resolve(false);
  const key = `${bin}\0${enc.codec}`;
  if (encoderProbeCache.has(key)) return encoderProbeCache.get(key);
  const p = (async () => {
    const args = [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "128x128", "-r", "30", "-i", "-",
      "-frames:v", "1", "-c:v", enc.codec, ...enc.args,
      "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-f", "null", "-",
    ];
    try {
      await runFfmpegPipe(args, [PROBE_FRAME_128], { bin, signal });
      return true;
    } catch {
      if (signal?.aborted) encoderProbeCache.delete(key);
      return false;
    }
  })();
  encoderProbeCache.set(key, p);
  return p;
};

let benchFrame640 = null;
const getBenchFrames = () => {
  if (!benchFrame640) {
    const buf = Buffer.allocUnsafe(640 * 360 * 3);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 17) & 0xff;
    benchFrame640 = buf;
  }
  return Array.from({ length: 15 }, () => benchFrame640);
};

const isQsvFasterThanX264 = (qsvEnc, x264Enc, { bin = binary, preset = "veryfast", signal = null } = {}) => {
  const key = `${bin}\0qsv-vs-x264\0${preset}`;
  if (encoderProbeCache.has(key)) return encoderProbeCache.get(key);
  const p = (async () => {
    const frames = getBenchFrames();
    const runBench = async (enc) => {
      const t0 = performance.now();
      await runFfmpegPipe([
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "640x360", "-r", "30", "-i", "-",
        "-c:v", enc.codec, ...enc.args,
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-f", "null", "-",
      ], frames, { bin, signal });
      return performance.now() - t0;
    };
    try {
      const qsvMs = await runBench(qsvEnc);
      const x264Ms = await runBench(x264Enc);
      return qsvMs < x264Ms;
    } catch {
      if (signal?.aborted) encoderProbeCache.delete(key);
      return false;
    }
  })();
  encoderProbeCache.set(key, p);
  return p;
};

// Resolve working encoders in preference order (cached per process + binary).
export const resolveEncoders = async ({ encoder = "auto", crf = 20, preset = "veryfast",
                                        signal = null, logger = console } = {}) => {
  const x264 = { codec: "libx264", args: ["-preset", preset || "veryfast", "-crf", String(crf)] };
  if (encoder && encoder !== "auto") return encoderOrder(encoder, crf, preset);
  const nv = { codec: ENCODERS.nvidia.codec, args: withCrf(ENCODERS.nvidia.args, crf) };
  if (await probeEncoderOnce(nv, { signal })) return [nv, x264];
  const amd = { codec: ENCODERS.amd.codec, args: withCrf(ENCODERS.amd.args, crf) };
  if (await probeEncoderOnce(amd, { signal })) return [amd, x264];
  const qsv = { codec: ENCODERS.intel.codec, args: withCrf(ENCODERS.intel.args, crf) };
  if (await probeEncoderOnce(qsv, { signal })) {
    const qsvWins = await isQsvFasterThanX264(qsv, x264, { preset: preset || "veryfast", signal });
    logger.debug?.(`ffmpeg auto encoder probe: h264_qsv vs libx264 (${preset || "veryfast"}) -> ${qsvWins ? "h264_qsv" : "libx264"}`);
    return qsvWins ? [qsv, x264] : [x264, qsv];
  }
  return [x264];
};

const escapeDrawText = (s) => String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")
  .replace(/%/g, "\\%").replace(/\n/g, "\\n");

export const BT709_FLAGS = Object.freeze(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]);

export const buildEncodeTail = ({ width, config, audio = null }) => {
  const vf = [];
  if (config?.watermark) {
    const size = Math.max(16, Math.round(width * 0.018));
    vf.push(`drawtext=text='${escapeDrawText(config.watermark)}':x=w-tw-24:y=20:fontsize=${size}:fontcolor=white@0.6`);
  }
  vf.push("scale=out_color_matrix=bt709:out_range=tv", "format=yuv420p");
  const tail = ["-vf", vf.join(","), ...BT709_FLAGS, "-movflags", "+faststart", "-shortest"];
  if (audio) tail.push("-c:a", "aac", "-b:a", config?.audioBitrate || "192k");
  return tail;
};

// frames: path pattern with %06d; audio: optional WAV; output: .mp4
export const encodeVideo = async ({ frames, audio = null, output, fps, width, height, config, signal = null,
                                    logger = console }) => {
  if (!fs.existsSync(frames.replace(/%06d/, "000000"))) throw new Error(`no captured frames at ${frames}`);
  const base = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", frames];
  if (audio) base.push("-i", audio);
  const tail = buildEncodeTail({ width, config, audio });
  const errors = [];
  const candidates = await resolveEncoders({
    encoder: config.encoder, crf: config.crf, preset: config.preset, signal, logger,
  });
  for (const enc of candidates) {
    const args = [...base, "-c:v", enc.codec, ...enc.args, ...tail, output];
    try {
      await runFfmpeg(args, { signal });
      logger.info?.(`encoded ${path.basename(output)} with ${enc.codec}`);
      return { encoder: enc.codec, output };
    } catch (e) {
      if (signal?.aborted) throw signal.reason || e;
      if (binary && enc.codec !== "libx264") encoderProbeCache.set(`${binary}\0${enc.codec}`, Promise.resolve(false));
      errors.push(`${enc.codec}: ${e.message}`);
      logger.warn?.(`encoder ${enc.codec} failed, trying the next one`);
    }
  }
  throw new Error(`video encoding failed: ${errors.join(" || ")}`);
};

// Streaming JPEG -> MP4 encoder via image2pipe (zero frame JPEG disk writes).
export const openVideoPipe = async ({ output, fps, width, config, signal = null, logger = console }) => {
  if (!binary) throw new Error("ffmpeg is not configured: call configureFfmpeg() first");
  const candidates = await resolveEncoders({
    encoder: config.encoder, crf: config.crf, preset: config.preset, signal, logger,
  });
  const enc = candidates[0];
  const tail = buildEncodeTail({ width, config, audio: null });
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", String(fps), "-i", "-",
    "-c:v", enc.codec, ...enc.args, ...tail, output,
  ];
  const child = spawn(binary, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  let exited = false;
  let exitErr = null;
  let closed = false;
  child.stderr.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });
  child.stdin.on("error", (e) => {
    if (!exited && !closed) exitErr = exitErr || e;
  });
  const abort = () => {
    closed = true;
    try { child.stdin.destroy(); } catch { /* ended */ }
    try { child.kill("SIGKILL"); } catch { /* ended */ }
  };
  if (signal) {
    if (signal.aborted) { abort(); throw signal.reason || new Error("aborted"); }
    signal.addEventListener("abort", abort, { once: true });
  }
  const done = new Promise((resolve, reject) => {
    child.on("error", (e) => {
      exited = true;
      reject(new Error(`ffmpeg pipe failed to start: ${e.message}`));
    });
    child.on("close", (code) => {
      exited = true;
      signal?.removeEventListener?.("abort", abort);
      if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
      if (code === 0) resolve({ encoder: enc.codec, output, stderr });
      else reject(new Error(`ffmpeg pipe exited with ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-6).join(" | ")}`));
    });
  });
  // Keep a rejection handler attached so an early ffmpeg crash does not trigger unhandledRejection before finish().
  done.catch(() => {});

  return {
    encoder: enc.codec,
    async writeFrame(buf) {
      if (signal?.aborted) throw signal.reason || new Error("aborted");
      if (exited || exitErr) {
        await done;
        throw exitErr || new Error("ffmpeg pipe exited unexpectedly");
      }
      if (!child.stdin.write(buf)) {
        await Promise.race([
          new Promise((resolve) => child.stdin.once("drain", resolve)),
          done.then(() => { throw new Error("ffmpeg pipe closed before drain"); }),
        ]);
      }
    },
    async finish() {
      if (!closed && !child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
      const res = await done;
      logger.info?.(`encoded ${path.basename(output)} with ${enc.codec}`);
      return res;
    },
    abort() {
      abort();
    },
  };
};

// Fast stream-copy mux of video-only MP4 + WAV audio into final faststart MP4.
export const muxVideoAudio = async ({ video, audio, output, audioBitrate = "192k", signal = null }) => {
  await runFfmpeg([
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", video, "-i", audio,
    "-c:v", "copy", "-c:a", "aac", "-b:a", audioBitrate || "192k",
    "-movflags", "+faststart", "-shortest", output,
  ], { signal });
  return { output };
};

export const remuxFaststart = async ({ input, output, signal = null }) => {
  await runFfmpeg([
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", input, "-c", "copy", "-movflags", "+faststart", output,
  ], { signal });
  return { output };
};

const IS_LITTLE_ENDIAN = os.endianness() === "LE";

// Write interleaved float32 samples (stereo) as a 16-bit PCM WAV.
export const writeWav = (file, channels, sampleRate, samples) => {
  const totalSamples = samples.length;
  const frames = totalSamples / channels;
  const dataBytes = totalSamples * 2;
  const buf = Buffer.allocUnsafe(44 + dataBytes);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(dataBytes, 40);
  if (IS_LITTLE_ENDIAN && ((buf.byteOffset + 44) & 1) === 0) {
    const pcm16 = new Int16Array(buf.buffer, buf.byteOffset + 44, totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      const s = samples[i];
      const v = s > 1 ? 1 : s < -1 ? -1 : s;
      pcm16[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
    }
  } else {
    for (let i = 0; i < totalSamples; i++) {
      const s = samples[i];
      const v = s > 1 ? 1 : s < -1 ? -1 : s;
      buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
    }
  }
  fs.writeFileSync(file, buf);
  return { file, sampleRate, channels, samples: frames, duration: frames / sampleRate };
};

// Probe a WAV (PCM or float) for its rate, channels and frame count.
export const probeWav = (file) => {
  const b = fs.readFileSync(file);
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE")
    throw new Error(`${file}: not a WAV`);
  let at = 12, fmt = null, dataSize = 0;
  while (at + 8 <= b.length) {
    const id = b.toString("latin1", at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === "fmt ") {
      fmt = { format: b.readUInt16LE(at + 8), channels: b.readUInt16LE(at + 10), sampleRate: b.readUInt32LE(at + 12),
              bits: b.readUInt16LE(at + 22) };
    } else if (id === "data") {
      dataSize = size;
      break;
    }
    at += 8 + size + (size & 1);
  }
  if (!fmt) throw new Error(`${file}: no fmt chunk`);
  const bytes = fmt.bits / 8;
  return { ...fmt, samples: bytes ? Math.floor(dataSize / (bytes * fmt.channels)) : 0 };
};
