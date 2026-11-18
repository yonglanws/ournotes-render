import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { mixAudio } from "../render/audioMix.js";
import { RecordingAudio } from "../render/recording-audio.js";
import { BT709_FLAGS, buildEncodeTail, configureFfmpeg, probeWav } from "../render/ffmpeg.js";
import { PlayerLoop } from "../../src/engine/loop.js";
import { SOUND_CATEGORY } from "../../src/engine/audio.js";
import { quietLogger, sineWav, tmpDir } from "./helpers.mjs";

configureFfmpeg();

const cue = (file, { freq = 440, seconds = 2, sampleRate = 48000 } = {}) =>
  sineWav(file, { freq, seconds, sampleRate, channels: 1 });

test("a looped BGM with a fade-out is placed on the timeline", async () => {
  const dir = tmpDir(), cues = path.join(dir, "cues");
  fs.mkdirSync(cues);
  cue(path.join(cues, "1.wav"), { seconds: 1 });
  const report = {
    frames: 90, fps: 30,
    events: [
      { type: "play", t: 0, id: 1, soundId: 1, startSec: 0, loop: true, speed: 1, crossFade: 0,
        isAutoCrossFade: false, forceFadeIn: false, category: 0, cueCategories: ["Bgm"], volume: 1 },
      { type: "stop", t: 2, id: 1, soundId: 1, fadeOut: true, dur: 0.5 },
    ],
    cues: { "1": { file: "1.wav", sampleRate: 48000, samples: 48000, channels: 1, categories: ["Bgm"],
                   loopStart: null, loopEnd: null } },
  };
  const out = await mixAudio({ report, cuesDir: cues, sampleRate: 48000, logger: quietLogger() });
  assert.ok(out);
  const info = probeWav(out.file);
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.channels, 2);
  assert.equal(info.samples, 3 * 48000);
  assert.ok(out.mixed === 1);
  // the fade-out leaves the tail quieter than the middle
  const b = fs.readFileSync(out.file);
  const rms = (from, to) => {
    let sum = 0, n = 0;
    for (let f = from; f < to; f++) {
      const v = b.readInt16LE(44 + f * 4);
      sum += v * v;
      n++;
    }
    return Math.sqrt(sum / Math.max(1, n));
  };
  assert.ok(rms(48000, 52800) > rms(115200, 120000));
});

test("two voices at different times are both mixed", async () => {
  const dir = tmpDir(), cues = path.join(dir, "cues");
  fs.mkdirSync(cues);
  cue(path.join(cues, "1.wav"), { freq: 440, seconds: 1 });
  cue(path.join(cues, "2.wav"), { freq: 880, seconds: 1 });
  const report = {
    frames: 60, fps: 30,
    events: [
      { type: "play", t: 0, id: 1, soundId: 1, startSec: 0, loop: false, speed: 1, category: 2,
        cueCategories: ["Voice"], volume: 1 },
      { type: "play", t: 1, id: 2, soundId: 2, startSec: 0, loop: false, speed: 1, category: 2,
        cueCategories: ["Voice"], volume: 1 },
    ],
    cues: {
      "1": { file: "1.wav", sampleRate: 48000, samples: 48000, channels: 1, categories: ["Voice"] },
      "2": { file: "2.wav", sampleRate: 48000, samples: 48000, channels: 1, categories: ["Voice"] },
    },
  };
  const out = await mixAudio({ report, cuesDir: cues, sampleRate: 48000, logger: quietLogger() });
  assert.equal(out.mixed, 2);
  assert.equal(probeWav(out.file).samples, 2 * 48000);
});

test("nothing played means no audio track", async () => {
  const dir = tmpDir();
  const out = await mixAudio({ report: { frames: 30, fps: 30, events: [], cues: {} }, cuesDir: dir,
                               sampleRate: 48000, logger: quietLogger() });
  assert.equal(out, null);
});

const stepWav = (file, { silentSeconds = 0.367, soundSeconds = 1.633, sampleRate = 48000, freq = 440 } = {}) => {
  const n0 = Math.round(silentSeconds * sampleRate);
  const n1 = Math.round(soundSeconds * sampleRate);
  const total = n0 + n1;
  const buf = Buffer.alloc(44 + total * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(total * 2, 40);
  for (let i = n0; i < total; i++) {
    const s = Math.sin(2 * Math.PI * freq * (i / sampleRate)) * 0.5;
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
};

test("videoStart=0.367 warmup offsetSeconds trims intro, advances fadeIn, and keeps post-warmup cues aligned", async () => {
  const dir = tmpDir(), cues = path.join(dir, "cues");
  fs.mkdirSync(cues);
  // First 0.367s is silence; audio begins at 0.367s inside cue 1.
  stepWav(path.join(cues, "1.wav"), { silentSeconds: 0.367, soundSeconds: 1.633 });
  cue(path.join(cues, "2.wav"), { freq: 660, seconds: 1 });
  const videoStart = 0.367;
  const report = {
    frames: 60, fps: 30,
    events: [
      { type: "play", t: 0, offsetSeconds: videoStart, storyT: 0, id: 1, soundId: 1, startSec: 0,
        loop: false, speed: 1, crossFade: videoStart * 2, isAutoCrossFade: false, forceFadeIn: true,
        category: 0, cueCategories: ["Bgm"], volume: 1 },
      { type: "play", t: +(1.367 - videoStart).toFixed(6), storyT: 1.367, id: 2, soundId: 2, startSec: 0,
        loop: false, speed: 1, category: 2, cueCategories: ["Voice"], volume: 1 },
    ],
    cues: {
      "1": { file: "1.wav", sampleRate: 48000, samples: 96000, channels: 1, categories: ["Bgm"] },
      "2": { file: "2.wav", sampleRate: 48000, samples: 48000, channels: 1, categories: ["Voice"] },
    },
  };
  const out = await mixAudio({ report, cuesDir: cues, sampleRate: 48000, logger: quietLogger() });
  assert.ok(out);
  const b = fs.readFileSync(out.file);
  const rms = (from, to) => {
    let sum = 0, n = 0;
    for (let f = from; f < to; f++) {
      const v = b.readInt16LE(44 + f * 4);
      sum += v * v;
      n++;
    }
    return Math.sqrt(sum / Math.max(1, n));
  };
  // Trimmed warmup sound is already active at frame 0 (and half-faded at t=0 rather than silent).
  assert.ok(rms(0, 2400) > 1000, `expected non-zero warmup-trimmed output at t=0, got ${rms(0, 2400)}`);
  // Post-warmup cue plays at exact video time 1.000s (frame 48000) after shifting by videoStart=0.367s.
  assert.ok(rms(48000, 50400) > rms(45600, 48000));
});

test("ffmpeg buildEncodeTail sets BT.709 color tags and config render presets choose resolution & quality 98", () => {
  const args = buildEncodeTail({ videoIn: "frames", out: "out.mp4", fps: 30, preset: "medium", crf: 18,
                                 audioIn: null, faststart: true });
  const vf = args[args.indexOf("-vf") + 1];
  assert.match(vf, /out_color_matrix=bt709:out_range=tv,format=yuv420p/);
  for (let i = 0; i < BT709_FLAGS.length; i += 2) {
    const idx = args.indexOf(BT709_FLAGS[i]);
    assert.ok(idx >= 0 && args[idx + 1] === BT709_FLAGS[i + 1]);
  }
  const stdDir = tmpDir("ournotes-cfg-std-");
  const stdCfg = loadConfig({ file: path.join(stdDir, "none.yaml"), env: {}, logger: quietLogger() });
  assert.equal(stdCfg.video.width, 1300);
  assert.equal(stdCfg.video.height, 600);
  assert.equal(stdCfg.video.jpegQuality, 98);
  assert.equal(stdCfg.render.preset, "standard");

  const bestFile = path.join(stdDir, "best.yaml");
  fs.writeFileSync(bestFile, "render:\n  preset: best\n");
  const bestCfg = loadConfig({ file: bestFile, env: {}, logger: quietLogger() });
  assert.equal(bestCfg.render.preset, "best");
  assert.equal(bestCfg.video.width, 1920);
  assert.equal(bestCfg.video.height, 886);
  assert.equal(bestCfg.video.jpegQuality, 98);
});

test("mixAudio respects volume=0 muted cues instead of falling back to volume 1", async () => {
  const dir = tmpDir(), cues = path.join(dir, "cues");
  fs.mkdirSync(cues);
  cue(path.join(cues, "1.wav"), { freq: 440, seconds: 1 });
  const mutedOnly = {
    frames: 30, fps: 30,
    events: [
      { type: "play", t: 0, id: 1, soundId: 1, startSec: 0, loop: false, speed: 1, category: 2,
        cueCategories: ["Voice"], volume: 0 },
    ],
    cues: { "1": { file: "1.wav", sampleRate: 48000, samples: 48000, channels: 1, categories: ["Voice"] } },
  };
  const outMuted = await mixAudio({ report: mutedOnly, cuesDir: cues, sampleRate: 48000, logger: quietLogger() });
  assert.equal(outMuted, null, "lone volume: 0 cue produces no audio track instead of playing at full volume");

  // Mix a muted loud cue alongside a silent audible cue to confirm 0 sample contribution.
  sineWav(path.join(cues, "2.wav"), { freq: 0, amp: 0, seconds: 1 });
  const mixed = {
    frames: 30, fps: 30,
    events: [
      { type: "play", t: 0, id: 1, soundId: 1, startSec: 0, loop: false, speed: 1, category: 2,
        cueCategories: ["Voice"], volume: 0 },
      { type: "play", t: 0, id: 2, soundId: 2, startSec: 0, loop: false, speed: 1, category: 2,
        cueCategories: ["Voice"], volume: 1 },
    ],
    cues: {
      "1": { file: "1.wav", sampleRate: 48000, samples: 48000, channels: 1, categories: ["Voice"] },
      "2": { file: "2.wav", sampleRate: 48000, samples: 48000, channels: 1, categories: ["Voice"] },
    },
  };
  const out = await mixAudio({ report: mixed, cuesDir: cues, sampleRate: 48000, logger: quietLogger() });
  assert.ok(out);
  assert.equal(out.mixed, 1);
  const b = fs.readFileSync(out.file);
  let maxSample = 0;
  for (let i = 44; i + 1 < b.length; i += 2) {
    maxSample = Math.max(maxSample, Math.abs(b.readInt16LE(i)));
  }
  assert.equal(maxSample, 0, "volume: 0 cue must contribute zero amplitude");
});

test("mixAudio reuses predecoded PCM promises without re-reading missing disk files", async () => {
  const dir = tmpDir(), cues = path.join(dir, "cues");
  fs.mkdirSync(cues);
  const predecoded = new Map([
    ["9", Promise.resolve({ samples: new Float32Array(48000 * 2).fill(0.25), frames: 48000, sampleRate: 48000, channels: 2 })],
  ]);
  const report = {
    frames: 30, fps: 30,
    events: [
      { type: "play", t: 0, id: 1, soundId: 9, startSec: 0, loop: false, speed: 1, category: 2,
        cueCategories: ["Voice"], volume: 1 },
    ],
    cues: { "9": { file: "nonexistent.wav", sampleRate: 48000, samples: 48000, channels: 2, categories: ["Voice"] } },
  };
  const out = await mixAudio({ report, cuesDir: cues, predecoded, sampleRate: 48000, logger: quietLogger() });
  assert.ok(out && out.mixed === 1);
  const b = fs.readFileSync(out.file);
  assert.ok(b.readInt16LE(44) > 7000);
});

test("RecordingAudio records stop on isAutoCrossFade BGM swap so mixAudio ends old BGM instead of overlapping", async () => {
  const dir = tmpDir(), cues = path.join(dir, "cues");
  fs.mkdirSync(cues);
  cue(path.join(cues, "1.wav"), { freq: 440, seconds: 1 });
  cue(path.join(cues, "2.wav"), { freq: 0, seconds: 1 }); // silent second BGM so any bleed from BGM 1 is measurable
  const loop = new PlayerLoop(30);
  const defs = {
    1: { sheet: "bgm", cue: "bgm1", category: SOUND_CATEGORY.Bgm, meta: { file: "1.wav", sampleRate: 48000, samples: 48000, channels: 1, categories: ["Bgm"] } },
    2: { sheet: "bgm", cue: "bgm2", category: SOUND_CATEGORY.Bgm, meta: { file: "2.wav", sampleRate: 48000, samples: 48000, channels: 1, categories: ["Bgm"] } },
  };
  const audio = new RecordingAudio((id) => defs[id], loop, { assets: null, sounds: true });
  audio.play(1, { isAutoCrossFade: true, crossFade: 0.2, loop: true });
  for (let i = 0; i < 30; i++) { await loop.step(); audio.update(); }
  audio.play(2, { isAutoCrossFade: true, crossFade: 0.2, loop: true });
  for (let i = 0; i < 60; i++) { await loop.step(); audio.update(); }

  assert.ok(audio.events.some((e) => e.type === "stop" && e.soundId === 1 && e.fadeOut), "crossfade stop emitted for old BGM");
  const report = {
    frames: 90, fps: 30,
    events: audio.events,
    cues: { "1": defs[1].meta, "2": defs[2].meta },
  };
  const out = await mixAudio({ report, cuesDir: cues, sampleRate: 48000, logger: quietLogger() });
  assert.ok(out);
  const b = fs.readFileSync(out.file);
  let tailPeak = 0;
  for (let f = Math.round(1.5 * 48000); f < 3 * 48000; f++) {
    tailPeak = Math.max(tailPeak, Math.abs(b.readInt16LE(44 + f * 4)));
  }
  assert.equal(tailPeak, 0, "old looped BGM must be silent after crossfade completes");
});

test("mixAudio applies category volume events (SoundVolume)", async () => {
  const dir = tmpDir(), cues = path.join(dir, "cues");
  fs.mkdirSync(cues);
  cue(path.join(cues, "1.wav"), { freq: 440, seconds: 2 });
  const report = {
    frames: 60, fps: 30,
    events: [
      { type: "play", t: 0, id: 1, soundId: 1, startSec: 0, loop: false, speed: 1, category: 0, cueCategories: ["Bgm"], volume: 1 },
      { type: "volume", t: 1, category: "Bgm", volume: 0 },
    ],
    cues: { "1": { file: "1.wav", sampleRate: 48000, samples: 96000, channels: 1, categories: ["Bgm"] } },
  };
  const out = await mixAudio({ report, cuesDir: cues, sampleRate: 48000, logger: quietLogger() });
  assert.ok(out);
  const b = fs.readFileSync(out.file);
  let tailPeak = 0;
  for (let f = 48000; f < 96000; f++) tailPeak = Math.max(tailPeak, Math.abs(b.readInt16LE(44 + f * 4)));
  assert.equal(tailPeak, 0, "Bgm muted by volume=0 event after t=1s");
});
