import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordingAudio } from "../render/recording-audio.js";

const CUE = { sheet: "sheet", cue: "sound_bgm_x", category: 0, meta: { file: "x.m4a", sampleRate: 48000, samples: 96000,
  channels: 2, categories: ["Bgm"], loopStart: 0, loopEnd: 96000 } };

test("play, crossfade stop and natural end are recorded on the game clock", () => {
  const loop = { time: 0 };
  const audio = new RecordingAudio(() => CUE, loop, { sounds: true });
  const id = audio.play(7, { loop: true, isAutoCrossFade: true, crossFade: 1.5, startSec: 0.5 });
  assert.ok(id >= 0);
  assert.equal(audio.events.length, 1);
  const play = audio.events[0];
  assert.equal(play.type, "play");
  assert.equal(play.soundId, 7);
  assert.equal(play.category, 0);
  assert.deepEqual(play.cueCategories, ["Bgm"]);
  assert.equal(play.loop, true);
  assert.equal(play.isAutoCrossFade, true);
  assert.equal(play.crossFade, 1.5);
  assert.equal(play.samples, 96000);

  loop.time = 5;
  audio.stop(id, true, 1.5);
  const stop = audio.events.find((e) => e.type === "stop");
  assert.equal(stop.t, 5);
  assert.equal(stop.fadeOut, true);
  assert.equal(stop.dur, 1.5);

  loop.time = 6.5;
  audio.update();
  assert.ok(audio.events.some((e) => e.type === "end" && e.id === id));
});

test("stopAll records one stop per playing sound of its category", () => {
  const loop = { time: 0 };
  const audio = new RecordingAudio((id) => ({ ...CUE, category: id === 2 ? 2 : 0, cue: `cue_${id}` }), loop,
                                   { sounds: true });
  audio.play(1, { loop: true });
  audio.play(2, { loop: true });
  loop.time = 3;
  audio.stopAll(0, true, 2);
  const stops = audio.events.filter((e) => e.type === "stop");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].soundId, 1);
  assert.ok(stops[0].fadeOut && stops[0].dur === 2 && stops[0].t === 3);
  assert.ok(audio.isPlaying(2), "the voice on another bus is still playing");
});

test("an unknown sound id fails before a play is recorded", () => {
  const loop = { time: 0 };
  const audio = new RecordingAudio(() => { throw new Error("no cue"); }, loop, { sounds: true });
  assert.throws(() => audio.play(99), /no cue/);
  assert.equal(audio.events.length, 0);
});
