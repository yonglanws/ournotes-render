// Rebuilds the story's audio track from the render page's event log: every play/stop of a cue is placed on the game
// timeline and mixed into one 48 kHz stereo WAV. The visual pass never plays audio, so this is deterministic too.
import fs from "node:fs";
import path from "node:path";
import { decodePcm, writeWav } from "./ffmpeg.js";

const rateOf = (event) => (Number.isFinite(event.speed) && event.speed > 0 ? event.speed : 1);

const busGain = (event) => {
  const cats = (event.cueCategories || []).map((c) => String(c));
  if (cats.includes("Bgm")) return 0.7;
  if (cats.includes("Se") || cats.includes("Voice")) return 1;
  return event.category === 0 ? 0.7 : 1;                 // the game's default BGM bus is 0.7
};

// the stop event that ends play `id`, if any
const stopOf = (events, id, from) => {
  let best = null;
  for (const e of events) {
    if (e.type !== "stop" || e.id !== id || e.t < from) continue;
    if (!best || e.t < best.t) best = e;
  }
  return best;
};

const loopPoints = (cue, duration) => {
  if (cue.loopStart == null || cue.loopEnd == null) return { start: 0, end: duration };
  const sr = Number(cue.sampleRate) || 48000;
  const start = Number(cue.loopStart) / sr, end = Number(cue.loopEnd) / sr;
  return end > start && start >= 0 ? { start, end: Math.min(end, duration) } : { start: 0, end: duration };
};

export const mixAudio = async ({ report, cuesDir, sampleRate = 48000, signal = null, logger = console }) => {
  const events = report.events || [];
  const plays = events.filter((e) => e.type === "play");
  if (!plays.length) return null;
  const fps = report.fps || 30;
  const duration = Math.max(0.1, (report.frames || 1) / fps);
  const total = Math.ceil(duration * sampleRate);
  const out = new Float32Array(total * 2);
  const decoded = new Map();

  const load = async (soundId) => {
    const cue = report.cues?.[String(soundId)];
    if (!cue) return null;
    if (decoded.has(soundId)) return decoded.get(soundId);
    const file = path.join(cuesDir, cue.file);
    if (!fs.existsSync(file)) { decoded.set(soundId, null); return null; }
    try {
      const pcm = await decodePcm(file, { sampleRate, signal });
      decoded.set(soundId, { ...pcm, cue });
      return decoded.get(soundId);
    } catch (e) {
      logger.warn?.(`audio: cannot decode ${cue.file}: ${e.message}`);
      decoded.set(soundId, null);
      return null;
    }
  };

  let mixed = 0;
  for (const play of plays) {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    const src = await load(play.soundId);
    if (!src) continue;
    const cueDuration = src.frames / sampleRate;
    const startSec = Math.max(0, Number(play.startSec) || 0);
    const speed = rateOf(play);
    const stop = stopOf(events, play.id, play.t);
    const startFrame = Math.round(play.t * sampleRate);
    if (startFrame >= total) continue;
    const gain = (Number(play.volume) || 1) * busGain(play);
    const fadeIn = play.isAutoCrossFade || play.forceFadeIn ? Math.max(0, Number(play.crossFade) || 0) : 0;
    const fadeOut = stop && stop.fadeOut ? Math.max(0, Number(stop.dur) || 0) : 0;
    const stopAt = stop ? stop.t + (stop.fadeOut ? Math.max(0, Number(stop.dur) || 0) : 0) : null;
    let endSec;
    if (stopAt != null) endSec = stopAt;
    else if (play.loop) endSec = duration;
    else endSec = Math.min(duration, play.t + Math.max(0, cueDuration - startSec) / speed);
    endSec = Math.min(duration, endSec);
    const endFrame = Math.min(total, Math.round(endSec * sampleRate));
    const loop = cueOfLoop(src.cue, cueDuration);
    let wrote = false;
    for (let i = 0; startFrame + i < endFrame; i++) {
      const t = play.t + i / sampleRate;
      let pos = startSec + (i / sampleRate) * speed;
      if (play.loop) {
        if (pos >= loop.end) {
          const span = loop.end - loop.start;
          if (span <= 0) break;
          pos = loop.start + ((pos - loop.start) % span);
        }
      } else if (pos >= cueDuration) break;
      let g = gain;
      if (fadeIn > 0 && t - play.t < fadeIn) g *= (t - play.t) / fadeIn;
      if (fadeOut > 0 && stop) {
        const left = stopAt - t;
        if (left <= 0) break;
        if (left < fadeOut) g *= left / fadeOut;
      }
      if (g <= 0) continue;
      const si = Math.min(src.frames - 1, Math.max(0, Math.round(pos * sampleRate)));
      const oi = (startFrame + i) * 2;
      out[oi] += src.samples[si * 2] * g;
      out[oi + 1] += src.samples[si * 2 + 1] * g;
      wrote = true;
    }
    if (wrote) mixed++;
  }
  if (!mixed) return null;
  // clamp (hard limit, the game's mixer does not clip the buses together either)
  for (let i = 0; i < out.length; i++) out[i] = out[i] > 1 ? 1 : out[i] < -1 ? -1 : out[i];
  const file = path.join(cuesDir, "..", "audio.wav");
  const wav = writeWav(file, 2, sampleRate, out);
  return { file, ...wav, duration, mixed };
};

const cueOfLoop = (cue, duration) => loopPoints(cue, duration);
