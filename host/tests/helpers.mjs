// Shared test helpers: temporary directories, a quiet logger and a PCM WAV writer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeWav } from "../render/ffmpeg.js";

export const tmpDir = (prefix = "ournotes-test-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const quietLogger = () => {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child() { return this; }, levelName: "error" };
};

export const sineWav = (file, { seconds = 1, freq = 440, sampleRate = 48000, channels = 1, amp = 0.4 } = {}) => {
  const frames = Math.round(seconds * sampleRate);
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp;
    for (let c = 0; c < channels; c++) out[i * channels + c] = v;
  }
  return writeWav(file, channels, sampleRate, out);
};

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
