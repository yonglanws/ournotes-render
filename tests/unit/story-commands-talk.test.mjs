// The Talk row's HostActions: timed acting inside a line (the director script's `actions`). Synthetic inputs only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PlayerLoop } from "../../src/engine/loop.js";
import { lineBody, startHostActions } from "../../src/story/commands/talk.js";

const makePlayer = () => {
  const loop = new PlayerLoop(30);
  const calls = [];
  const ch = {
    isShowing: true,
    playExpression(name, fade) { calls.push(["expression", name, fade]); },
  };
  const p = {
    ctx: {
      loop,
      characters: { get: (name) => (name === "a" ? ch : undefined) },
      settings: { player: { _waitTalkTextUnitTime: 0.04, _waitAfterVoiceTime: 0.6, _minTalkDisplayTime: 1.6 } },
    },
    cancelled: false, shortcut: false,
    speedRate() { return 1; },
    motions: { playMotion(character, c) { calls.push(["motion", c.TargetName, c.MotionName, c.ExpressionName]); } },
  };
  return { p, loop, calls };
};

test("lineBody uses the voice length, else the typed text's hold, with the minimum display time", () => {
  const { p } = makePlayer();
  assert.ok(Math.abs(lineBody(p, [{ t0: 0, end: 2 }], 10) - 2.6) < 1e-6);   // voice 2 s + _waitAfterVoiceTime
  assert.ok(Math.abs(lineBody(p, [], 10) - 1.6) < 1e-6);        // text 0.4 s, raised to the minimum
  assert.ok(Math.abs(lineBody(p, [], 60) - 2.4) < 1e-6);        // text 2.4 s
  assert.ok(Math.abs(lineBody(p, [{ t0: 0, end: Infinity }], 10) - 1.6) < 1e-6); // a looped cue is not a line length
});

test("HostActions play at their fraction of the line and stop with it", async () => {
  const { p, loop, calls } = makePlayer();
  const stop = startHostActions(p, { HostActions: [
    { at: 0.5, TargetName: "a", MotionName: "mtn_nod01_C", ExpressionName: "exp_smile01" },
    { at: 0.2, TargetName: "a", ExpressionName: "exp_idle01" },
  ] }, 1);
  for (let i = 0; i < 8; i++) await loop.step();
  assert.deepEqual(calls, [["expression", "exp_idle01", 0]]);
  for (let i = 0; i < 12; i++) await loop.step();
  assert.deepEqual(calls[1], ["motion", "a", "mtn_nod01_C", "exp_smile01"]);
  stop();
});

test("a stopped line does not run its later actions", async () => {
  const { p, loop, calls } = makePlayer();
  const stop = startHostActions(p, { HostActions: [{ at: 0.9, TargetName: "a", ExpressionName: "exp_idle01" }] }, 1);
  stop();
  for (let i = 0; i < 40; i++) await loop.step();
  assert.deepEqual(calls, []);
});

test("an action on a character that is not showing is skipped", async () => {
  const { p, loop, calls } = makePlayer();
  startHostActions(p, { HostActions: [{ at: 0, TargetName: "missing", ExpressionName: "exp_idle01" }] }, 1);
  await loop.step();
  await loop.step();
  assert.deepEqual(calls, []);
});
