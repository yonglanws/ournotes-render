import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { mixAudio } from "../render/audioMix.js";
import { configureFfmpeg, probeWav } from "../render/ffmpeg.js";
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
