import test from "node:test";
import assert from "node:assert/strict";
import { dialogueBudgetFor, directionBudgetFor, OFFICIAL_TARGETS } from "../ai/official-targets.js";
import { buildCastMessages, buildDialogueMessages, buildStoryboardMessages } from "../ai/staged.js";
import { buildStoryMessages, stagingRules } from "../ai/prompt.js";

test("line and character budgets use one 2-minute formula", () => {
  assert.deepEqual(dialogueBudgetFor(2), { lines: 36, chars: 480, minLines: 32, maxLines: 47 });
  assert.deepEqual(dialogueBudgetFor(3), { lines: 54, chars: 720, minLines: 47, maxLines: 70 });
});

test("tiny dialogue targets clamp minLines to maxLines", () => {
  for (const minutes of [0.1, 0.25, 0.5, 1]) {
    const budget = dialogueBudgetFor(minutes);
    assert.ok(budget.minLines >= 1, `${minutes}: minLines is positive`);
    assert.ok(budget.minLines <= budget.maxLines, `${minutes}: minLines <= maxLines`);
  }
});

test("direction budgets scale with the actual text-line count", () => {
  const b = directionBudgetFor(40);
  assert.equal(b.focusChanges, 18);
  assert.equal(b.closeUps, 9);
  assert.equal(b.motionMin, 48);
  assert.equal(b.motionMax, 56);
  assert.equal(b.maxStatic, 5);
  assert.equal(b.lookAt, 12);
  assert.equal(b.zoomMin, 2);
  assert.equal(b.zoomMax, 5);
  assert.equal(b.pedestal, 4);
  assert.equal(b.panV2, 6);
  assert.equal(b.dof, 1);
  assert.equal(b.se, 5);
  assert.equal(b.track, 3);
  assert.equal(OFFICIAL_TARGETS.focusPerTalkRow, 0.397);
  assert.equal(OFFICIAL_TARGETS.focusPerTextLine, 0.446);
  assert.equal(OFFICIAL_TARGETS.distance4TextLineShare, 0.2288);

  const b54 = directionBudgetFor(54);
  assert.equal(b54.focusChanges, 24);
  assert.equal(b54.closeUps, 12);
  assert.equal(b54.motionMin, 65);
  assert.equal(b54.motionMax, 76);
  assert.equal(b54.maxStatic, 6);
  assert.equal(b54.lookAt, 16);
  assert.equal(b54.zoomMin, 2);
  assert.equal(b54.zoomMax, 6);
  assert.equal(b54.pedestal, 6);
  assert.equal(b54.panV2, 8);
  assert.equal(b54.dof, 1);
  assert.equal(b54.se, 7);
  assert.equal(b54.track, 4);
});

test("tiny scene budgets never request more directional rows than there are lines", () => {
  for (const lines of [1, 2, 3]) {
    const b = directionBudgetFor(lines);
    for (const key of ["focusChanges", "closeUps", "lookAt", "zoomMin", "zoomMax",
      "pedestal", "panV2", "dof", "se", "track", "maxStatic"]) {
      assert.ok(b[key] <= lines, `${lines} lines: ${key}=${b[key]} <= ${lines}`);
    }
    assert.ok(b.zoomMin <= b.zoomMax, `${lines} lines: zoomMin <= zoomMax`);
  }
});

test("checked close-run, two-motion and standalone-expression shares are exposed unchanged", () => {
  assert.equal(OFFICIAL_TARGETS.closeRunOneOrTwoShare, 0.7785);
  assert.equal(OFFICIAL_TARGETS.twoMotionShare, 0.4473);
  assert.equal(OFFICIAL_TARGETS.standaloneExpressionPerEpisode, 0.0667);
});

const CATALOG = {
  manifest: "stories/1.json",
  language: "zh-Hans",
  languages: ["zh-Hans"],
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
    "约 44.7% 的有文本行有 2 个以上表演动作 (Motion + Expression + Look + LookTarget)",
    "近景段长 0~2 句（空镜按 1 段",
    "0.397", "0.446", "20.4%", "22.9%", "没有 Motion",
  ]) {
    assert.ok(text.includes(needle), `staged messages must mention ${needle}`);
  }
  assert.ok(!text.includes("8 部官方剧情实测"), "the old 8-episode provenance is gone");
  assert.ok(!text.includes("有动作的句子里约"), "the two-action share is not conditioned on action lines");
  assert.ok(!text.includes("没有动作"), "no-Motion wording is not confused with no performance actions");
});

test("the single prompt states the two-action share and close-run rule with the correct denominator", () => {
  const [, user] = buildStoryMessages({ catalog: CATALOG, request: { prompt: "放学后" }, config: CONFIG });
  assert.ok(user.content.includes(
    "约 44.7% 的有文本行有 2 个以上表演动作 (Motion + Expression + Look + LookTarget)"));
  assert.ok(user.content.includes("近景段长 0~2 句（空镜按 1 段"));
  assert.ok(user.content.includes("0.397"));
  assert.ok(user.content.includes("0.446"));
  assert.ok(user.content.includes("20.4%"));
  assert.ok(user.content.includes("22.9%"));
  assert.ok(user.content.includes("没有 Motion"));
  assert.ok(!user.content.includes("有动作的句子里约"), "no action-line-conditioned wording");
  assert.ok(!user.content.includes("没有动作"), "no-Motion wording is not confused with no performance actions");
});

test("configured maxLines is a strict cap for the single and staged dialogue prompts", () => {
  const capped = { ...CONFIG, story: { ...CONFIG.story, maxLines: 5 } };
  const [, user] = buildStoryMessages({
    catalog: CATALOG, request: { prompt: "放学后", targetMinutes: 3 }, config: capped,
  });
  assert.match(user.content, /台词总量 5~5 条/);
  assert.doesNotMatch(user.content, /台词总量 10~10 条/);

  const [, cast] = buildCastMessages({
    catalog: CATALOG, request: { prompt: "放学后", targetMinutes: 3, maxLines: 5 }, config: capped,
  });
  assert.match(cast.content, /约 5 句台词/);

  const [, dialogue] = buildDialogueMessages({
    plan: PLAN, catalog: CATALOG, request: { prompt: "放学后", targetMinutes: 3 }, config: capped,
  });
  const range = /总共 (\d+)~(\d+) 句/.exec(dialogue.content);
  assert.ok(range, "the dialogue prompt states a line range");
  assert.ok(Number(range[1]) <= Number(range[2]), "min <= max");
  assert.ok(Number(range[2]) <= 5, "the configured cap is respected");
  assert.match(dialogue.content, /总共 5~5 句/);
});

test("half-minute prompts keep a coherent minimum line target", () => {
  const [, user] = buildStoryMessages({
    catalog: CATALOG, request: { prompt: "放学后", targetMinutes: 0.5 }, config: CONFIG,
  });
  assert.match(user.content, /台词总量 12~12 条/);
  const [, dialogue] = buildDialogueMessages({
    plan: PLAN, catalog: CATALOG, request: { prompt: "放学后", targetMinutes: 0.5 }, config: CONFIG,
  });
  assert.match(dialogue.content, /总共 12~12 句/);
});

test("the shared staging rules receive the actual scene budget", () => {
  const rules = stagingRules(3, directionBudgetFor(40));
  assert.match(rules, /一场 2~5 次/);
  assert.doesNotMatch(rules, /一场 0~2 次/);
  assert.match(rules, /本场预算：Focus 约 18 次、close 约 9 次、zoom 2~5 次、lookAt 约 12 次、Se 约 5 条、Track 约 3 次。/);
});

test("system and user storyboard prompts agree on the 40-line and 54-line budgets", () => {
  for (const [lineCount, expected] of [
    [40, { focus: 18, close: 9, zoomMin: 2, zoomMax: 5, lookAt: 12, se: 5, track: 3 }],
    [54, { focus: 24, close: 12, zoomMin: 2, zoomMax: 6, lookAt: 16, se: 7, track: 4 }],
  ]) {
    const dialogue = {
      lines: Array.from({ length: lineCount }, (_, i) => ({
        id: `l${i + 1}`, say: i % 2 ? "b" : "a", text: `第${i + 1}句台词的内容。`,
      })),
    };
    const [system, user] = buildStoryboardMessages({
      plan: PLAN, dialogue, catalog: CATALOG, request: {}, config: CONFIG,
    });
    const budgetLine = `本场预算：Focus 约 ${expected.focus} 次、close 约 ${expected.close} 次、` +
      `zoom ${expected.zoomMin}~${expected.zoomMax} 次、lookAt 约 ${expected.lookAt} 次、` +
      `Se 约 ${expected.se} 条、Track 约 ${expected.track} 次。`;
    assert.ok(system.content.includes(budgetLine), `${lineCount}: system budget line`);
    assert.ok(user.content.includes(`全场约 ${expected.focus} 个 focus`), `${lineCount}: focus`);
    assert.ok(user.content.includes(`close 近景约 ${expected.close} 次`), `${lineCount}: close`);
    assert.ok(user.content.includes(`全场约 ${expected.zoomMin}~${expected.zoomMax} 次 zoom`), `${lineCount}: zoom`);
    assert.ok(user.content.includes(`全场约 ${expected.lookAt} 个 lookAt`), `${lineCount}: lookAt`);
    assert.ok(user.content.includes(`Se 约 ${expected.se} 条`), `${lineCount}: se`);
    assert.ok(user.content.includes(`Track 约 ${expected.track} 次`), `${lineCount}: track`);
  }
});

test("the single-pass extended-field example is a say beat, not a staged line reference", () => {
  const [, user] = buildStoryMessages({ catalog: CATALOG, request: { prompt: "放学后" }, config: CONFIG });
  assert.match(user.content, /"say": "a", "text": "……嗯。"/);
  assert.doesNotMatch(user.content, /"line": "l7"/);
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
