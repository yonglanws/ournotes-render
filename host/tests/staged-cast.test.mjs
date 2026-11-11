// The cast pass is prompt-driven: the catalog lists every costume, the prompt requires one outfit per band, and the
// plan keeps the tone the writer declared for the BGM choice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCastMessages, normalizeCastPlan } from "../ai/staged.js";

const catalog = {
  manifest: "stories/1.json", language: "zh-Hans",
  stages: [{ id: "stage_a" }], music: [{ cue: "bgm_a", label: "Quiet", mood: "安静", use: "夜谈" }],
  models: [
    { id: "m_tomori_live", key: "tomori", name: "高松灯", character: "高松灯", band: "MyGO!!!!!",
      costume: "live_01", costumeLabel: "队服", motions: [], expressions: [] },
    { id: "m_tomori_jhs", key: "tomori", name: "高松灯", character: "高松灯", band: "MyGO!!!!!",
      costume: "school_winter_jhs", costumeLabel: "校服·初中", motions: [], expressions: [] },
    { id: "m_anon_live", key: "anon", name: "千早爱音", character: "千早爱音", band: "MyGO!!!!!",
      costume: "live_01", costumeLabel: "队服", motions: [], expressions: [] },
  ],
};
const config = { story: { maxOnStage: 2 }, llm: {} };
const request = { prompt: "认真谈心" };

test("the cast prompt lists every costume and states the band outfit rule", () => {
  const [, user] = buildCastMessages({ catalog, request, config });
  assert.match(user.content, /m_tomori_live（队服）/);
  assert.match(user.content, /m_tomori_jhs（校服·初中）/);
  assert.match(user.content, /服装按乐队尽量统一/);
  assert.match(user.content, /个别角色没有这一类时可以例外/);
  assert.match(user.content, /避免一个人穿队服、另一个人穿初中校服/);
});

test("normalizeCastPlan accepts a costume id and keeps the declared tone", () => {
  const plan = normalizeCastPlan({
    title: "t", event: "e", tone: "认真谈心",
    setting: { stage: "stage_a" },
    cast: [
      { id: "tomori", model: "m_tomori_live", name: "高松灯" },
      { id: "anon", model: "m_anon_live", name: "千早爱音" },
    ],
  }, { catalog, request, config });
  assert.equal(plan.tone, "认真谈心");
  assert.deepEqual(plan.cast.map((c) => c.model), ["m_tomori_live", "m_anon_live"]);
});

test("normalizeCastPlan refuses two costumes of the same character", () => {
  const plan = normalizeCastPlan({
    title: "t", event: "e", cast: [
      { id: "tomori", model: "m_tomori_live", name: "高松灯" },
      { id: "tomori2", model: "m_tomori_jhs", name: "高松灯" },
      { id: "anon", model: "m_anon_live", name: "千早爱音" },
    ],
  }, { catalog, request, config });
  assert.deepEqual(plan.cast.map((c) => c.model), ["m_tomori_live", "m_anon_live"]);
});

test("models without action names are not offered and the character list is capped", () => {
  const many = [];
  for (let i = 0; i < 40; i++) {
    many.push({ id: `m_c${i}`, key: `c${i}`, name: `角色${i}`, character: `角色${i}`, motions: [], expressions: [] });
  }
  const view = {
    ...catalog,
    models: [...catalog.models, { id: "m_npc", key: "npc", name: "路人", character: "路人", motions: [],
                                  expressions: [], actionsKnown: false }, ...many],
  };
  const [, user] = buildCastMessages({ catalog: view, request, config });
  assert.ok(!user.content.includes("m_npc"), "a model the storyboard cannot act is not offered");
  assert.ok(user.content.includes("m_c0"));
  assert.ok(!user.content.includes("m_c24"), "the prompt stops at MAX_PROMPT_MODELS characters");
  const plan = normalizeCastPlan({ title: "t", event: "e", cast: [{ id: "npc", model: "m_npc" }] },
                                 { catalog: view, request, config });
  assert.equal(plan, null, "a plan that only named an unactionable model is rejected");
});
