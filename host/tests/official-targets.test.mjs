import test from "node:test";
import assert from "node:assert/strict";
import { dialogueBudgetFor, directionBudgetFor, OFFICIAL_TARGETS } from "../ai/official-targets.js";
import { buildStoryboardMessages } from "../ai/staged.js";

test("line and character budgets use one 2-minute formula", () => {
  assert.deepEqual(dialogueBudgetFor(2), { lines: 36, chars: 480, minLines: 32, maxLines: 47 });
  assert.deepEqual(dialogueBudgetFor(3), { lines: 54, chars: 720, minLines: 47, maxLines: 70 });
});

test("direction budgets scale with the actual line count", () => {
  const b = directionBudgetFor(40);
  assert.equal(b.focusChanges, 16);
  assert.equal(b.closeUps, 8);
  assert.equal(b.motionMin, 48);
  assert.equal(b.motionMax, 56);
  assert.equal(b.maxStatic, 5);
  assert.equal(b.lookAt, 12);
  assert.equal(b.zoomMin, 2);
  assert.equal(b.zoomMax, 5);
  assert.equal(b.se, 5);
  assert.equal(OFFICIAL_TARGETS.focusPerTalkRow, 0.397);
});

test("checked close-run, two-motion and standalone-expression shares are exposed unchanged", () => {
  assert.equal(OFFICIAL_TARGETS.closeRunOneOrTwoShare, 0.7785);
  assert.equal(OFFICIAL_TARGETS.twoMotionShare, 0.4473);
  assert.equal(OFFICIAL_TARGETS.standaloneExpressionPerEpisode, 0.0667);
});

const CATALOG = {
  manifest: "stories/1.json",
  language: "zh-Hans",
  stages: [{ id: "stage_a", caption: "教室" }],
  music: [{ cue: "bgm_a", label: "Quiet" }],
  models: [
    { id: "m_a", name: "灯", character: "tomori", motions: ["mtn_idle01_C", "mtn_smile01_C", "mtn_nod01_C"],
      expressions: ["exp_idle01", "exp_smile01"] },
    { id: "m_b", name: "爽世", character: "soyo", motions: ["mtn_idle01_L", "mtn_smile01_L"],
      expressions: ["exp_idle01", "exp_smile01"] },
  ],
};

const PLAN = {
  title: "雨",
  event: "等雨停",
  setting: { stage: "stage_a", location: "教室" },
  cast: [
    { id: "a", model: "m_a", name: "灯", role: "" },
    { id: "b", model: "m_b", name: "爽世", role: "" },
  ],
  outline: [],
};

const CONFIG = { story: { maxOnStage: 3 }, llm: {} };

test("staged messages built from 40 lines carry the 30-sample official targets", () => {
  const dialogue = {
    lines: Array.from({ length: 40 }, (_, i) => ({
      id: `l${i + 1}`,
      say: i % 2 ? "b" : "a",
      text: `第${i + 1}句台词的内容。`,
    })),
  };
  const messages = buildStoryboardMessages({
    plan: PLAN, dialogue, catalog: CATALOG, request: {}, config: CONFIG,
  });
  const text = messages.map((m) => m.content).join("\n");
  for (const needle of [
    "30 部官方样本", "整条台词常见 1~30 字", "约 38% 两行", "Focus 约 0.40/句",
    "Pedestal", "PanV2", "DoF", "Look", "Se",
  ]) {
    assert.ok(text.includes(needle), `staged messages must mention ${needle}`);
  }
  assert.ok(!text.includes("8 部官方剧情实测"), "the old 8-episode provenance is gone");
});

test("no official target is NaN and every numeric field is finite", () => {
  for (const [key, value] of Object.entries(OFFICIAL_TARGETS)) {
    assert.equal(typeof value, "number", key);
    assert.ok(Number.isFinite(value), `${key} must be finite`);
  }
  for (const minutes of [0.5, 1, 2, 3, 5, 10]) {
    const budget = dialogueBudgetFor(minutes);
    for (const [key, value] of Object.entries(budget)) {
      assert.ok(Number.isFinite(value), `dialogueBudgetFor(${minutes}).${key}`);
    }
  }
  for (const lines of [2, 10, 40, 120]) {
    const budget = directionBudgetFor(lines);
    for (const [key, value] of Object.entries(budget)) {
      assert.ok(Number.isFinite(value), `directionBudgetFor(${lines}).${key}`);
    }
  }
});
