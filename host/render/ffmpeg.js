// ffmpeg helpers: one validated binary, argument arrays only (never a shell), TTS audio normalization, and MP4
// encoding. The executable cannot be chosen by a request: it is the bundled ffmpeg-static build, or an operator
// configured absolute path whose file name is ffmpeg / ffmpeg.exe. PATH is not scanned.
import { spawn } from "node:child_process";
import fs from "node:fs";
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
  return [ENCODERS.nvidia, ENCODERS.amd, ENCODERS.intel, x264].map((e) => custom(e.codec, withCrf(e.args, crf)));
};

const escapeDrawText = (s) => String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")
  .replace(/%/g, "\\%").replace(/\n/g, "\\n");

// frames: path pattern with %06d; audio: optional WAV; output: .mp4
export const encodeVideo = async ({ frames, audio = null, output, fps, width, height, config, signal = null,
                                    logger = console }) => {
  if (!fs.existsSync(frames.replace(/%06d/, "000000"))) throw new Error(`no captured frames at ${frames}`);
  const vf = [];
  if (config.watermark) {
    const size = Math.max(16, Math.round(width * 0.018));
    vf.push(`drawtext=text='${escapeDrawText(config.watermark)}':x=w-tw-24:y=20:fontsize=${size}:fontcolor=white@0.6`);
  }
  vf.push("format=yuv420p");
  const base = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", frames];
  if (audio) base.push("-i", audio);
  const tail = ["-vf", vf.join(","), "-movflags", "+faststart", "-shortest"];
  if (audio) tail.push("-c:a", "aac", "-b:a", config.audioBitrate || "192k");
  const errors = [];
  for (const enc of encoderOrder(config.encoder, config.crf, config.preset)) {
    const args = [...base, "-c:v", enc.codec, ...enc.args, ...tail, output];
    try {
      await runFfmpeg(args, { signal });
      logger.info?.(`encoded ${path.basename(output)} with ${enc.codec}`);
      return { encoder: enc.codec, output };
    } catch (e) {
      if (signal?.aborted) throw signal.reason || e;
      errors.push(`${enc.codec}: ${e.message}`);
      logger.warn?.(`encoder ${enc.codec} failed, trying the next one`);
    }
  }
  throw new Error(`video encoding failed: ${errors.join(" || ")}`);
};

// Write interleaved float32 samples (stereo) as a 16-bit PCM WAV.
export const writeWav = (file, channels, sampleRate, samples) => {
  const frames = samples.length / channels;
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames * channels; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
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
