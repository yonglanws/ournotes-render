// The frame audit: a report passes only when every check names a relative PNG pair, carries the
// hashes and a numeric difference that agrees with `changed`, and every camera checkpoint shows a
// visible, non-duplicated change. Checkpoints come from the renderer's own command timeline
// (Location, Talk and no-wait rows included), never from a second host-side duration model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateFfmpeg } from "../../host/render/ffmpeg.js";
import {
  CAMERA_COMMANDS, duplicateFramePairs, extractPng, frameCheckpoints, frameTarget, validateFrameReport,
} from "./frame-audit.mjs";

const probe = (() => {
  try { return validateFfmpeg(); } catch { return ""; }
})();

const reportFixture = () => JSON.parse(readFileSync(new URL("./fixtures/frame-report.json", import.meta.url)));

const timelineOf = (entries) => ({ version: 1, commands: entries });
const t = (i, cmd, seconds) => ({ i, cmd, seconds });

test("a complete renderer report passes", () => {
  const report = reportFixture();
  assert.deepEqual(validateFrameReport(report), []);
});

test("an empty frame path and a lying changed flag fail", () => {
  const report = reportFixture();
  report.checks[0].changed = false;
  report.checks[0].before = "";
  const failures = validateFrameReport(report);
  assert.ok(failures.length >= 2);
  assert.ok(failures.some((failure) => failure.code === "missingFrame"));
  assert.ok(failures.some((failure) => failure.code === "cameraUnchanged"));
});

test("checkpoints use the renderer timeline, including a Location wait", () => {
  const episode = {
    commands: [
      { i: 0, cmd: "Location" },
      { i: 1, cmd: "Focus", Duration: 1.2 },
      { i: 2, cmd: "Delay", Duration: 0.5 },
      { i: 3, cmd: "Zoom", Duration: 0.8 },
    ],
  };
  const checks = frameCheckpoints(episode, timelineOf([
    t(0, "Location", 0), t(1, "Focus", 2.5), t(2, "Delay", 2.5), t(3, "Zoom", 3.1),
  ]));
  assert.deepEqual(checks.map((check) => [check.i, check.seconds]), [[1, 2.5], [3, 3.1]]);
  assert.ok(checks.every((check) => check.lowerBound === false));
});

test("a checkpoint after a Talk uses the renderer's actual line time, not a lower bound", () => {
  const episode = { commands: [{ i: 0, cmd: "Talk" }, { i: 1, cmd: "Focus", Duration: 1.2 }] };
  const checks = frameCheckpoints(episode, timelineOf([t(0, "Talk", 4), t(1, "Focus", 5.2)]));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].seconds, 5.2);
  assert.equal(checks[0].lowerBound, false);
});

test("a row's DelaySeconds shifts its effect window without inventing a timeline", () => {
  const episode = {
    commands: [
      { i: 0, cmd: "Se", DelaySeconds: 0.5 },
      { i: 1, cmd: "Track", Duration: 1 },
    ],
  };
  const checks = frameCheckpoints(episode, timelineOf([t(0, "Se", 9.6), t(1, "Track", 9.6)]));
  assert.deepEqual(checks.map((check) => [check.i, check.cmd, check.seconds, check.commandSeconds]),
                   [[1, "Track", 9.6, 9.6], [0, "Se", 10.1, 9.6]]);
  assert.equal(checks.filter((check) => CAMERA_COMMANDS.includes(check.cmd)).length, 1);
});

test("the after frame stops before the next command starts", () => {
  const episode = {
    commands: [
      { i: 0, cmd: "Out", Duration: 0.2 },
      { i: 1, cmd: "Focus", Duration: 0.5 },
    ],
  };
  const checks = frameCheckpoints(episode, timelineOf([t(0, "Out", 12.1), t(1, "Focus", 12.367)]));
  const out = checks.find((check) => check.cmd === "Out");
  const focus = checks.find((check) => check.cmd === "Focus");
  assert.equal(out.afterSeconds, 12.327);
  assert.equal(out.afterCapped, true);
  assert.equal(focus.afterSeconds, 12.817);
  assert.equal(focus.afterCapped, false);
});

test("the settle covers the before window, not just the command start", () => {
  const episode = {
    commands: [
      { i: 0, cmd: "Focus", Duration: 1.2 },
      { i: 1, cmd: "Focus", Duration: 1.2 },
    ],
  };
  const checks = frameCheckpoints(episode, timelineOf([t(0, "Focus", 1.1), t(1, "Focus", 1.2)]));
  assert.deepEqual(checks.map((check) => check.i), [1]);
});

test("attribution marks audio-only Se and overlapping visual rows", () => {
  const episode = {
    commands: [
      { i: 0, cmd: "Pedestal", Duration: 1 },
      { i: 1, cmd: "Track", Duration: 1 },
      { i: 2, cmd: "Se", DelaySeconds: 0.5, Duration: 1 },
      { i: 3, cmd: "Pedestal", Duration: 1 },
    ],
  };
  const checks = frameCheckpoints(episode, timelineOf([
    t(0, "Pedestal", 5), t(1, "Track", 9.2), t(2, "Se", 9.2), t(3, "Pedestal", 9.2),
  ]));
  const track = checks.find((check) => check.i === 1);
  const se = checks.find((check) => check.i === 2);
  assert.equal(track.visual, true);
  assert.ok(track.confounds.some((confound) => confound.i === 3 && confound.cmd === "Pedestal"));
  assert.equal(se.visual, false);
  assert.ok(se.confounds.some((confound) => confound.i === 1 && confound.cmd === "Track"));
  assert.ok(se.confounds.some((confound) => confound.i === 3 && confound.cmd === "Pedestal"));
});

test("near-end extraction is frame-accurate", { skip: probe ? false : "ffmpeg is not available" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "frame-audit-seek-"));
  try {
    const clip = path.join(dir, "clip.mp4");
    const made = spawnSync(probe, ["-nostdin", "-hide_banner", "-v", "error", "-f", "lavfi",
      "-i", "testsrc2=size=320x180:rate=30:duration=1", "-pix_fmt", "yuv420p", "-y", clip],
    { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const near = path.join(dir, "near.png");
    const exact = path.join(dir, "exact.png");
    extractPng(probe, { path: clip, lastFrameAt: 29 / 30 }, 0.95, near);
    // Exact reference: input seek with accurate_seek (the frame at/after 0.95), not -sseof.
    const reference = spawnSync(probe, ["-nostdin", "-hide_banner", "-v", "error", "-ss", "0.95",
      "-i", clip, "-frames:v", "1", "-y", exact], { encoding: "utf8" });
    assert.equal(reference.status, 0, reference.stderr);
    const hash = (file) => crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
    assert.equal(hash(near), hash(exact));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requireCamera and dependent frame failures are explicit", () => {
  const noCamera = reportFixture();
  noCamera.checks = noCamera.checks.map((check) => ({ ...check, cmd: "Motion" }));
  assert.ok(validateFrameReport(noCamera, { requireCamera: true })
    .some((failure) => failure.code === "missingCamera"));

  const failed = reportFixture();
  failed.checks[0].frameFailure = "ffmpeg produced no output PNG frame at 1.2s";
  failed.checks[0].frameFailureKind = "no-frame";
  failed.checks[0].before = "";
  failed.checks[0].meanAbsoluteDifference = null;
  const codes = validateFrameReport(failed).map((failure) => failure.code);
  assert.ok(codes.includes("frameFailure"));
  assert.ok(!codes.includes("missingFrame"));
  assert.ok(!codes.includes("missingDifference"));

  const audio = reportFixture();
  audio.checks[0].cmd = "Se";
  audio.checks[0].visual = true;
  assert.ok(validateFrameReport(audio).some((failure) => failure.code === "audioVisual"));
});

test("an episode without camera rows has no camera checkpoint", () => {
  const episode = {
    commands: [
      { i: 0, cmd: "Location" },
      { i: 1, cmd: "In", Duration: 0.2 },
      { i: 2, cmd: "Motion" },
      { i: 3, cmd: "Out", Duration: 0.2 },
    ],
  };
  const checks = frameCheckpoints(episode, timelineOf([
    t(0, "Location", 0), t(1, "In", 2.5), t(2, "Motion", 3), t(3, "Out", 3.5),
  ]));
  assert.deepEqual(checks.map((check) => check.cmd), ["In", "Motion", "Out"]);
  assert.ok(checks.every((check) => !CAMERA_COMMANDS.includes(check.cmd)));
});

test("selection skips the opening settle, prefers a non-zero camera move and adds Track/LookTarget", () => {
  const episode = {
    commands: [
      { i: 0, cmd: "Focus", Duration: 0 },
      { i: 1, cmd: "Focus", Duration: 0 },
      { i: 2, cmd: "Focus", Duration: 1.2 },
      { i: 3, cmd: "Zoom", Duration: 0.8 },
      { i: 4, cmd: "Track", Duration: 1 },
      { i: 5, cmd: "LookTarget", Duration: 0.2 },
    ],
  };
  const checks = frameCheckpoints(episode, timelineOf([
    t(0, "Focus", 0), t(1, "Focus", 2), t(2, "Focus", 3), t(3, "Zoom", 4), t(4, "Track", 5),
    t(5, "LookTarget", 6),
  ]));
  assert.deepEqual(checks.map((check) => [check.i, check.cmd, check.seconds]),
                   [[2, "Focus", 3], [3, "Zoom", 4], [4, "Track", 5], [5, "LookTarget", 6]]);
  assert.ok(checks.every((check) => check.seconds >= 1));
});

test("a camera checkpoint never duplicates another checkpoint's frame window", () => {
  const episode = {
    commands: [
      { i: 0, cmd: "In", Duration: 0.2 },
      { i: 1, cmd: "Zoom", Duration: 0.8 },
      { i: 2, cmd: "Zoom", Duration: 0.8 },
      { i: 3, cmd: "Track", Duration: 1 },
    ],
  };
  const checks = frameCheckpoints(episode, timelineOf([
    t(0, "In", 3), t(1, "Zoom", 3), t(2, "Zoom", 4), t(3, "Track", 3),
  ]));
  assert.deepEqual(checks.map((check) => [check.i, check.cmd, check.seconds]),
                   [[0, "In", 3], [2, "Zoom", 4]]);
});

test("frameTarget rejects a frame beyond the last video frame and clamps only before zero", () => {
  const video = { duration: 10, fps: 30, lastFrameAt: 9.9667 };
  assert.deepEqual(frameTarget(5, video), { time: 5, clamped: false, failure: "" });
  const late = frameTarget(10, video);
  assert.equal(late.clamped, true);
  assert.match(late.failure, /after the last frame/);
  const before = frameTarget(-1, video);
  assert.deepEqual(before, { time: 0, clamped: true, failure: "" });
});

test("the validator enforces changed, hashes, provenance, paths and frame failures", () => {
  let report = reportFixture();
  report.checks[0].meanAbsoluteDifference = 0.5;
  report.checks[0].changed = true;
  assert.ok(validateFrameReport(report).some((failure) => failure.code === "changedMismatch"));

  report = reportFixture();
  report.checks[1].beforeSha256 = report.checks[0].beforeSha256;
  report.checks[1].afterSha256 = report.checks[0].afterSha256;
  assert.ok(validateFrameReport(report).some((failure) => failure.code === "duplicateFrames"));
  assert.equal(duplicateFramePairs(report.checks).length, 1);

  report = reportFixture();
  report.checks[0].frameFailure = "ffmpeg produced no output PNG frame at 1.2s";
  report.checks[0].frameFailureKind = "no-frame";
  const frameFailure = validateFrameReport(report).find((failure) => failure.code === "frameFailure");
  assert.equal(frameFailure.kind, "no-frame");

  report = reportFixture();
  report.checks[0].meanAbsoluteDifference = null;
  report.checks[0].before = "frame.jpg";
  assert.ok(validateFrameReport(report).some((failure) => failure.code === "missingDifference"));
  assert.ok(validateFrameReport(report).some((failure) => failure.code === "missingFrame"));

  report = reportFixture();
  report.ffmpeg.ok = false;
  report.ffmpeg.error = "ffmpeg exited with 1";
  assert.ok(validateFrameReport(report).some((failure) => failure.code === "ffmpegFailed"));

  report = reportFixture();
  delete report.ffmpeg.probe.version;
  assert.ok(validateFrameReport(report).some((failure) => failure.code === "ffmpegMissing"));

  report = reportFixture();
  report.video.sha256 = "";
  report.episode.sha256 = "";
  const failures = validateFrameReport(report);
  assert.ok(failures.some((failure) => failure.code === "missingVideoSha"));
  assert.ok(failures.some((failure) => failure.code === "missingEpisodeSha"));
});

test("verified frame paths stay inside the output directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "frame-audit-paths-"));
  try {
    for (const unsafe of ["../x.png", path.join(dir, "x.png"), "a/../../x.png"]) {
      const report = reportFixture();
      report.checks[0].before = unsafe;
      const codes = validateFrameReport(report, { dir, verifyFiles: true }).map((failure) => failure.code);
      assert.ok(codes.includes("unsafeFramePath"), `${unsafe}: ${codes}`);
    }
    const report = reportFixture();
    report.checks[0].before = "missing.png";
    assert.ok(validateFrameReport(report, { dir, verifyFiles: true })
      .some((failure) => failure.code === "missingFrameFile"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
