// The frame audit: a report passes only when it carries checks whose before/after PNGs are
// named, a numeric difference and a visible change on every camera checkpoint. A broken
// report (an empty frame path, a camera checkpoint that did not change) fails with one
// finding per problem, and the timeline follows the player's blocking rules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { frameCheckpoints, validateFrameReport } from "./frame-audit.mjs";

test("frame report needs real extracted frames and visible changes", () => {
  const report = JSON.parse(readFileSync(new URL("./fixtures/frame-report.json", import.meta.url)));
  assert.deepEqual(validateFrameReport(report), []);
  const broken = structuredClone(report);
  broken.checks[0].changed = false;
  broken.checks[0].before = "";
  assert.ok(validateFrameReport(broken).length >= 2);
});

test("frame checkpoints follow the player's blocking seconds and window", () => {
  const episode = {
    commands: [
      { i: 0, cmd: "Stage", TargetAssetName: "st/garden" },
      { i: 1, cmd: "Focus", CameraDistance: 2, PositionType: 5, Duration: 1.2 },
      { i: 2, cmd: "Delay", Duration: 0.5 },
      { i: 3, cmd: "Zoom", Parameter1: "1.2", Duration: 0.8, DelaySeconds: 0.2 },
      { i: 4, cmd: "Talk", TargetName: "anon" },
      { i: 5, cmd: "Pedestal", Parameter1: "-0.2", Duration: 1 },
      { i: 6, cmd: "Focus", CameraDistance: 3, PositionType: 1, Duration: 0.5 },
      { i: 7, cmd: "Se", Parameter1: "se_01", Duration: 0.5 },
    ],
  };
  const checks = frameCheckpoints(episode);
  assert.deepEqual(checks.map((c) => [c.i, c.cmd]), [[1, "Focus"], [3, "Zoom"], [5, "Pedestal"], [7, "Se"]]);
  assert.deepEqual(checks.map((c) => c.seconds), [0, 1.9, 2.7, 4.2]);
  for (const check of checks) {
    assert.equal(check.beforeSeconds, Number(Math.max(0, check.seconds - 0.15).toFixed(3)));
    assert.equal(check.afterSeconds, Number((check.seconds + 0.45).toFixed(3)));
  }
});

test("a report without checks or ffmpeg provenance fails", () => {
  const empty = { checks: [], ffmpeg: { ok: true, version: "ffmpeg version 7.0" } };
  assert.ok(validateFrameReport(empty).some((failure) => failure.code === "zeroChecks"));
  const noFfmpeg = {
    checks: [{ i: 1, cmd: "Focus", seconds: 0, before: "a.png", after: "b.png",
               meanAbsoluteDifference: 3, changed: true }],
  };
  assert.ok(validateFrameReport(noFfmpeg).some((failure) => failure.code === "ffmpegMissing"));
});
