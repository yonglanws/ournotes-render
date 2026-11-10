// The evaluator's per-scene contract: exactly one StoryWriter call (the writer
// owns truncation retries), and a failure record that still carries elapsed
// time plus any warnings/raw/stages the writer produced before failing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../../host/config.js";
import {
  assertLabOutsideRepository, evaluateScene, failureRecord, parseArgs, sceneDirectionStats,
} from "./ai-eval.mjs";
import { redactText, redactValue, redactingLogger } from "./redaction.mjs";

test("a scene invokes the StoryWriter once even when the answer is truncated", async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "ai-eval-"));
  let calls = 0;
  let seen = null;
  let caught = null;
  try {
    try {
      await evaluateScene({
        scene: { index: 1, label: "rain-stop", logline: "雨停在屋檐下", title: "雨停之前" },
        run: 1, label: "rain-stop", llm: {}, catalog: { language: "zh-Hans" }, compiler: {},
        config: { story: { targetMinutes: 2 } }, runDir, logger: { warn() {}, info() {} },
        generate: async (args) => {
          calls++;
          seen = args;
          args.logger.warn("repair warning before truncation");
          throw new Error("AI 分镜生成失败：LLM answer was truncated (finish_reason=length)");
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.match(caught.message, /truncated/);
    assert.equal(calls, 1, "the evaluator must not call generateScript a second time");
    assert.equal(seen.request.prompt, "雨停在屋檐下");
    assert.equal(seen.request.targetMinutes, 2);
    assert.deepEqual(caught.partial.warnings, ["repair warning before truncation"]);
    assert.ok(caught.partial.latencyMs >= 0, "a generation failure records elapsed time");
    assert.equal(caught.partial.raw, null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a failure record carries elapsed time, warnings, raw and stages when available", () => {
  const scene = { index: 3, label: "lost-ticket", logline: "检票口" };
  const error = Object.assign(new Error("the generated script did not compile"), {
    code: "compile",
    details: [{ path: "/beats/1", code: "unknownMotion" }],
    partial: { latencyMs: 1234, warnings: ["补写"], raw: "lost-ticket.raw.txt",
               stages: [{ stage: "storyboard", ok: true }] },
  });
  const record = failureRecord({ scene, run: 2, label: "lost-ticket", error, startedAt: Date.now() - 50,
                                partial: error.partial });
  assert.equal(record.label, "lost-ticket");
  assert.equal(record.scene.index, 3);
  assert.equal(record.run, 2);
  assert.equal(record.code, "compile");
  assert.deepEqual(record.details, [{ path: "/beats/1", code: "unknownMotion" }]);
  assert.equal(record.latencyMs, 1234);
  assert.deepEqual(record.warnings, ["补写"]);
  assert.equal(record.raw, "lost-ticket.raw.txt");
  assert.equal(record.stages[0].stage, "storyboard");

  const plain = failureRecord({ scene, run: 1, label: "lost-ticket", error: new Error("boom"),
                                startedAt: Date.now() - 10 });
  assert.ok(plain.latencyMs >= 0, "a generation failure still records elapsed time");
  assert.deepEqual(plain.warnings, []);
  assert.equal(plain.raw, null);
});

test("scene direction stats reject empty, line-only and scene-only storyboards", () => {
  const talk = (i) => ({ i, cmd: "Talk", raw: 2 });
  const empty = sceneDirectionStats({ beats: [] }, { commands: [talk(0)] });
  assert.equal(empty.lineCount, 0);
  assert.equal(empty.linesWithDirection, 0);

  const lines = { beats: [
    { say: "a", text: "甲" }, { say: "b", text: "乙" },
  ] };
  const lineOnly = sceneDirectionStats(lines, { commands: [talk(0), talk(1)] });
  assert.equal(lineOnly.lineCount, 2);
  assert.equal(lineOnly.linesWithDirection, 0);
  assert.equal(lineOnly.commandCount, 0);

  const sceneOnly = sceneDirectionStats({ beats: [
    { scene: "stage_a" }, { say: "a", text: "甲" }, { say: "b", text: "乙" },
  ] }, { commands: [{ i: 0, cmd: "Focus", raw: 7 }, talk(1), talk(2)] });
  assert.equal(sceneOnly.linesWithDirection, 0, "an inherited scene Focus is not line direction");
  assert.equal(sceneOnly.commandCount, 1);

  const directed = sceneDirectionStats({ beats: [
    { scene: "stage_a" }, { say: "a", text: "甲", motion: "mtn_idle01" }, { say: "b", text: "乙" },
  ] }, { commands: [{ i: 0, cmd: "Focus", raw: 7 }, { i: 1, cmd: "Motion", raw: 21 }, talk(2)] });
  assert.equal(directed.linesWithDirection, 1);
  assert.equal(directed.commandCount, 2);

  // parseScript emits kind/speaker with empty camera/focus/lookAt fields on a
  // line that has no real direction; those empty values must not count.
  const parsedEmpty = sceneDirectionStats({ beats: [
    { kind: "scene" }, { kind: "say", speaker: "a", text: "甲", focus: "", camera: undefined,
      track: undefined, lookAt: "", actions: [] },
    { kind: "say", speaker: "b", text: "乙", focus: "", camera: undefined, track: undefined, lookAt: "",
      actions: [] },
  ] }, { commands: [{ i: 0, cmd: "Focus", raw: 7 }, talk(1), talk(2)] });
  assert.equal(parsedEmpty.lineCount, 2);
  assert.equal(parsedEmpty.linesWithDirection, 0);
  assert.equal(parsedEmpty.commandCount, 1);
});

test("the CLI rejects invalid argument ranges and a run name that can escape the lab", () => {
  assert.throws(() => parseArgs([]), /--run is required/);
  assert.throws(() => parseArgs(["--run", "../escape"]), /safe name/);
  assert.throws(() => parseArgs(["--run", "x", "--pipeline", "other"]), /pipeline/);
  assert.throws(() => parseArgs(["--run", "x", "--temperature", "3"]), /temperature/);
  assert.throws(() => parseArgs(["--run", "x", "--target", "11"]), /target/);
  assert.throws(() => parseArgs(["--run", "x", "--runs", "0"]), /runs/);
  assert.throws(() => parseArgs(["--run", "x", "--unknown"]), /unknown argument/);
  assert.equal(parseArgs(["--run", "x", "--runs", "2"]).runs, 2);
});

test("the external lab guard rejects paths inside the repository", () => {
  assert.throws(() => assertLabOutsideRepository(path.join(ROOT, "output", "eval")), /outside the repository/);
  assert.throws(() => assertLabOutsideRepository(ROOT), /outside the repository/);
  const outside = path.join(tmpdir(), "ournotes-ai-lab-test");
  assert.equal(assertLabOutsideRepository(outside), path.resolve(outside));
});

test("secret redaction scrubs configured keys and key-shaped tokens from reports and logs", () => {
  const key = "sk-test-secret-123456";
  assert.equal(redactText(`failure ${key}`, [key]), "failure [REDACTED]");
  assert.equal(redactText("Authorization: Bearer abc.def.ghi", [key]), "Authorization: Bearer [REDACTED]");
  assert.ok(!redactText("sk-other-secret-987654", [key]).includes("sk-other-secret"));
  const value = redactValue({ error: `boom ${key}`, nested: [key], n: 1 }, [key]);
  assert.ok(!JSON.stringify(value).includes(key));
  assert.equal(value.n, 1);
  const lines = [];
  const logger = redactingLogger({ warn: (line) => lines.push(line) }, [key]);
  logger.warn(`HTTP 500 with ${key}`);
  assert.ok(!lines[0].includes(key));
  assert.match(lines[0], /\[REDACTED\]/);
});

test("a failure record is scrubbed before it reaches a report", () => {
  const key = "sk-test-secret-123456";
  const record = failureRecord({
    scene: { index: 1, label: "x", logline: "x" }, run: 1, label: "x",
    error: Object.assign(new Error(`upstream failed with ${key}`), { details: [{ message: key }] }),
    startedAt: Date.now() - 5,
  });
  assert.ok(!JSON.stringify(redactValue(record, [key])).includes(key));
});
