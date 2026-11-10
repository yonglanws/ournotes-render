// The evaluator's per-scene contract: exactly one StoryWriter call (the writer
// owns truncation retries), and a failure record that still carries elapsed
// time plus any warnings/raw/stages the writer produced before failing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluateScene, failureRecord } from "./ai-eval.mjs";

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
