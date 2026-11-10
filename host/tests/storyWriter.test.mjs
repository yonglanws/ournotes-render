import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuickCastMessages, buildStoryMessages } from "../ai/prompt.js";
import { parseScript } from "../../scripts/lib/story-author/script.js";
import { generateScript, prepareScript } from "../ai/storyWriter.js";
import { directionBudgetFor } from "../ai/official-targets.js";
import { buildDialogueMessages, buildStoryboardMessages, mergeStagedScript, normalizeDialogue, onStageProblems, spreadPositions } from "../ai/staged.js";
import { quietLogger } from "./helpers.mjs";

const CATALOG = {
  manifest: "stories/1.json", language: "zh-Hans", languages: ["zh-Hans", "ja"],
  stages: [{ id: "stage_a", caption: "教室" }, { id: "stage_b", caption: "走廊" }],
  music: [{ cue: "bgm_a", label: "Quiet" }],
  models: [
    { id: "m_a", name: "灯", character: "tomori", group: "tomori", motions: ["mtn_idle01_C", "mtn_smile01_C", "mtn_nod01_C"],
      expressions: ["exp_idle01", "exp_smile01"], defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" },
    { id: "m_b", name: "爽世", character: "soyo", group: "soyo", motions: ["mtn_idle01_L", "mtn_smile01_L"],
      expressions: ["exp_idle01", "exp_smile01"], defaultMotion: "mtn_idle01_L", defaultExpression: "exp_idle01" },
  ],
};

const CONFIG = {
  story: { maxLines: 120, font: "sans", title: "", personas: [] },
  llm: { repairRounds: 0, systemPrompt: "", pipeline: "single" },
};

const script = (extra = {}) => ({
  format: "ournotes.story-script/1", base: "stories/1.json", language: "zh-Hans", title: "测试",
  cast: { a: { model: "m_a", name: "灯" }, b: { model: "m_b", name: "爽世" } },
  beats: [
    { scene: "stage_a", location: "教室", camera: "middle", positions: { a: "left", b: "right" } },
    { say: "a", text: "今天也一起练习吧。", motion: "mtn_smile01" },
    { say: "b", text: "嗯。", expression: "exp_smile01" },
    { narrate: "窗外的雨声很轻。" },
  ],
  ...extra,
});

test("a clean supplied script passes and is normalized", () => {
  const r = prepareScript({ doc: script(), catalog: CATALOG, request: {}, config: CONFIG, logger: quietLogger() });
  assert.deepEqual(r.errors, []);
  assert.equal(r.script.cast.length, 2);
  assert.equal(r.script.beats.length, 4);
  assert.equal(r.warnings.length, 0);
});

test("maxLines below two or non-integer is rejected instead of becoming a story", async () => {
  let calls = 0;
  const llm = { available: true, async json() { calls++; return { content: JSON.stringify(script()) }; } };
  for (const maxLines of [1, 2.5]) {
    await assert.rejects(
      () => generateScript({ llm, catalog: CATALOG, request: { prompt: "放学后", maxLines },
        config: CONFIG, logger: quietLogger() }),
      /maxLines must be an integer of at least 2/);
  }
  assert.equal(calls, 0, "the LLM is not called");
});

test("near names and a model given by character name are fixed", () => {
  const doc = script();
  doc.cast.a.model = "灯";                       // the model id, but the display name was written
  doc.beats[1].motion = "mtn_smiel01";           // typo next to mtn_smile01
  doc.beats[0].positions.a = "centre";           // typo next to center
  const r = prepareScript({ doc, catalog: CATALOG, request: {}, config: CONFIG, logger: quietLogger() });
  assert.deepEqual(r.errors, []);
  assert.equal(r.script.cast[0].model, "m_a");
  assert.equal(r.script.beats[1].motion, "mtn_smile01");
  assert.equal(r.script.beats[0].positions[0].slot, 5);
});

test("an unfixable script reports errors with JSON pointers", () => {
  const doc = script();
  doc.beats = [{ say: "a", text: "没有场景。" }];
  const r = prepareScript({ doc, catalog: CATALOG, request: {}, config: CONFIG, logger: quietLogger() });
  assert.ok(r.errors.some((e) => e.code === "beforeScene" && e.path === "/beats/0"));
});

test("the prompt's few-shot example is itself a valid script on the catalog", () => {
  const [, user] = buildStoryMessages({ catalog: CATALOG, request: { prompt: "放学后" }, config: CONFIG });
  const start = user.content.indexOf("示例（");
  const from = user.content.indexOf("{", start);
  const to = user.content.indexOf("\n\n## beat 规则", from);
  assert.ok(from > 0 && to > from, "the example JSON is in the prompt");
  const doc = JSON.parse(user.content.slice(from, to));
  const r = prepareScript({ doc, catalog: CATALOG, request: {}, config: CONFIG, logger: quietLogger() });
  assert.deepEqual(r.errors, []);
  assert.ok(r.script.beats.some((b) => b.kind === "say" && b.actions?.some((a) => a.at === 0)), "a pre-line reaction");
  assert.ok(r.script.beats.some((b) => typeof b.track === "number"), "a track pan");
  const says = r.script.beats.filter((b) => b.kind === "say");
  assert.ok(says.some((b) => !b.motion && !b.actions?.length), "a line held without acting");
  assert.ok(says.some((b) => b.text.includes("\n")), "a two-row line");
  assert.ok(says.some((b) => [...b.text.replace(/\n/g, "")].length <= 6), "a short reaction");
  assert.ok(says.every((b) => b.motion || !b.expression), "no standalone expression");
});

test("the prompt lists the real model, stage and format names", () => {
  const [system, user] = buildStoryMessages({ catalog: CATALOG, request: { prompt: "放学后" }, config: CONFIG });
  assert.match(system.content, /ournotes\.story-script\/1/);
  assert.match(user.content, /m_a/);
  assert.match(user.content, /stage_a/);
  assert.match(user.content, /bgm_a/);
  assert.match(user.content, /放学后/);
});

test("the prompt teaches official-like camera, acting and transitions", () => {
  const [system, user] = buildStoryMessages({ catalog: CATALOG, request: { prompt: "放学后" }, config: CONFIG });
  assert.match(system.content, /ADV 分镜/);
  assert.match(system.content, /一句台词最多一个说话者动作/);
  assert.match(system.content, /3~4 句换一次/);
  assert.match(system.content, /近景停 1~2 句/);
  assert.match(system.content, /close 2\.8×/);
  assert.match(system.content, /不要把 near 当近景/);
  assert.match(system.content, /zoom 1\.03~1\.10/);
  assert.match(user.content, /"camera": "close"/);
  assert.match(user.content, /"zoom": 1\.06/);
  assert.match(user.content, /30 部官方样本/);
  assert.match(user.content, /整条台词常见 1~30 字/);
  assert.match(user.content, /约 38% 两行/);
  assert.match(user.content, /Focus 约 0\.40\/句/);
  assert.doesNotMatch(user.content, /8 部官方剧情实测/);
  assert.match(user.content, /Pedestal/);
  assert.match(user.content, /PanV2/);
  assert.match(user.content, /DoF/);
  assert.match(user.content, /Look/);
  assert.match(user.content, /Se/);
  assert.match(user.content, /focusDuration/);
  assert.match(user.content, /motionFadeIn/);
  assert.match(user.content, /独立 Expression/);
  assert.match(user.content, /10610/);
  for (const field of ["focus", "actions", "fade", "pause", "lookAt", "camera", "track"]) assert.match(user.content, new RegExp(field));
  const doc = script();
  doc.beats[1].focus = 2;                    // a focus point between two slots
  doc.beats[1].camera = "near";
  doc.beats[1].track = -0.4;
  doc.beats[1].lookAt = "b";
  doc.beats[1].actions = [{ at: 45, cast: "b", expression: "exp_smile01" }];   // a model writing percent
  doc.beats.splice(2, 0, { pause: 0.5 }, { fade: "out", duration: 0.6 });
  const r = prepareScript({ doc, catalog: CATALOG, request: {}, config: CONFIG, logger: quietLogger() });
  assert.deepEqual(r.errors, []);
  assert.equal(r.script.beats[1].focus, 2);
  assert.equal(r.script.beats[1].track, -0.4);
  assert.equal(r.script.beats[1].lookAt, "b");
  assert.equal(r.script.beats[1].actions.length, 1);
  assert.equal(r.script.beats[1].actions[0].at, 0.45);
  assert.equal(r.script.beats[2].kind, "pause");
  assert.equal(r.script.beats[3].kind, "fade");
});

test("a director plan is requested first when enabled", async () => {
  const calls = [];
  const llm = {
    available: true,
    async json(messages) {
      calls.push(messages.map((m) => m.content).join("\n"));
      if (calls.length === 1) return { content: JSON.stringify({ title: "雨", logline: "两人在教室", scenes: [] }) };
      return { content: JSON.stringify(script()) };
    },
  };
  const out = await generateScript({
    llm, catalog: CATALOG, request: { prompt: "写一场对话", language: "zh-Hans" },
    config: { ...CONFIG, llm: { ...CONFIG.llm, repairRounds: 0, directorPlan: true } }, logger: quietLogger(),
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /ADV 分镜导演/);
  assert.match(calls[1], /导演计划/);
  assert.equal(out.script.beats.length, 4);
});

test("the director plan is off unless it is asked for", async () => {
  let calls = 0;
  const llm = { available: true, async json() { calls++; return { content: JSON.stringify(script()) }; } };
  await generateScript({
    llm, catalog: CATALOG, request: { prompt: "写一场对话", language: "zh-Hans" },
    config: { ...CONFIG, llm: { ...CONFIG.llm, repairRounds: 0 } }, logger: quietLogger(),
  });
  assert.equal(calls, 1);
});

test("the AI answer is extracted, validated and repaired when needed", async () => {
  let calls = 0;
  const llm = {
    available: true,
    async json() {
      calls++;
      if (calls === 1) {
        // a say before any scene: no automatic fix exists, so the writer must ask for a repair
        return { content: JSON.stringify(script({ beats: [{ say: "a", text: "第一句。" }] })) };
      }
      return { content: "```json\n" + JSON.stringify(script()) + "\n```" };
    },
  };
  const out = await generateScript({
    llm, catalog: CATALOG, request: { prompt: "写一场对话", language: "zh-Hans" },
    config: { ...CONFIG, llm: { ...CONFIG.llm, repairRounds: 1 } }, logger: quietLogger(),
  });
  assert.equal(calls, 2);
  assert.equal(out.script.beats.length, 4);
  assert.equal(out.script.cast[0].model, "m_a");
});

// --- staged pipeline: cast -> dialogue -> storyboard ------------------------------------------------

const STAGED_CONFIG = {
  ...CONFIG,
  story: {
    ...CONFIG.story,
    personas: [
      { name: "灯", prompt: "PERSONA-TOMORI：内向，说话轻，常用省略号。" },
      { name: "爽世", prompt: "PERSONA-SOYO：温柔礼貌，笑容背后有算计。" },
    ],
  },
  llm: { ...CONFIG.llm, pipeline: "staged" },
};

const CAST_DOC = {
  title: "雨",
  logline: "两人在教室躲雨",
  event: "等雨停",
  setting: { stage: "stage_a", location: "教室" },
  cast: [
    { id: "a", model: "m_a", name: "灯", role: "发起者" },
    { id: "b", model: "m_b", name: "爽世", role: "回应者" },
  ],
  outline: ["灯在教室等人", "爽世进来", "两人聊起练习", "雨停"],
};

const DIALOGUE_DOC = {
  title: "雨",
  lines: [
    { say: "a", text: "今天也一起练习吧。" },
    { say: "b", text: "嗯。" },
    { narrate: "窗外的雨声很轻。" },
  ],
};

const STORYBOARD_DOC = {
  beats: [
    { scene: "stage_a", location: "教室", camera: "middle", focus: 5, positions: { a: "left", b: "right" } },
    { line: "l1", motion: "mtn_smile01", expression: "exp_smile01" },
    { line: "l2", say: "b", text: "完全不同的台词", motion: "mtn_idle01" },
    { line: "l3", camera: "middle" },
  ],
};

const stagedLlm = (storyboard, { cast = CAST_DOC, dialogue = DIALOGUE_DOC } = {}) => {
  const calls = [];
  return {
    calls,
    available: true,
    async json(messages) {
      calls.push(messages.map((m) => m.content).join("\n"));
      if (calls.length === 1) return { content: JSON.stringify(cast) };
      if (calls.length === 2) return { content: JSON.stringify(dialogue) };
      return { content: JSON.stringify(storyboard) };
    },
  };
};

const stagedRun = (llm) => generateScript({
  llm, catalog: CATALOG, request: { prompt: "放学后", language: "zh-Hans" },
  config: STAGED_CONFIG, logger: quietLogger(),
});

test("the staged pipeline writes cast, dialogue, then storyboard", async () => {
  const llm = stagedLlm(STORYBOARD_DOC);
  const out = await stagedRun(llm);
  assert.equal(llm.calls.length, 3);
  assert.match(llm.calls[0], /选角/);
  assert.doesNotMatch(llm.calls[0], /PERSONA-TOMORI/);
  assert.match(llm.calls[1], /PERSONA-TOMORI/);
  assert.match(llm.calls[1], /PERSONA-SOYO/);
  assert.match(llm.calls[2], /l1/);
  assert.doesNotMatch(llm.calls[2], /PERSONA-TOMORI/, "the storyboard pass does not carry the long personas");
  // the finished dialogue wins over anything the storyboard repeated
  assert.equal(out.doc.beats[1].text, "今天也一起练习吧。");
  assert.equal(out.doc.beats[2].text, "嗯。");
  assert.equal(out.doc.beats[2].say, "b");
  assert.equal(out.doc.beats[2].motion, "mtn_idle01");
  assert.ok(!JSON.stringify(out.doc).includes("完全不同的台词"));
  assert.deepEqual(out.plan.cast.map((c) => c.id), ["a", "b"]);
  assert.equal(out.dialogue.lines.length, 3);
  assert.equal(out.usage, null, "the fake returns no usage");
});

test("a dialogue answer with no usable lines is retried once", async () => {
  const calls = [];
  const llm = {
    available: true,
    async json(messages) {
      calls.push(messages.map((m) => m.content).join("\n"));
      if (calls.length === 1) return { content: JSON.stringify(CAST_DOC) };
      if (calls.length === 2) return { content: JSON.stringify({ lines: [] }) };
      if (calls.length === 3) return { content: JSON.stringify(DIALOGUE_DOC) };
      return { content: JSON.stringify(STORYBOARD_DOC) };
    },
  };
  const out = await stagedRun(llm);
  assert.equal(calls.length, 4);
  assert.match(calls[2], /上一轮的问题/);
  assert.equal(out.dialogue.lines.length, 3);
});

test("a cast label copied with its group suffix is cleaned for the talk window", async () => {
  const cast = { ...CAST_DOC, cast: [
    { ...CAST_DOC.cast[0], name: "灯（tomori）" },
    { ...CAST_DOC.cast[1], name: "爽世(soyo)" },
  ] };
  const out = await stagedRun(stagedLlm(STORYBOARD_DOC, { cast }));
  assert.equal(out.doc.cast.a.name, "灯");
  assert.equal(out.doc.cast.b.name, "爽世");
});

test("two people are spread to far-left and far-right, and a solo focus follows", () => {
  const beats = [
    { scene: "stage_a", focus: 5, positions: { a: "center" } },
    { say: "a", text: "一。" },
    { positions: { a: "center", b: "right" }, focus: 6 },
    { say: "b", text: "二。" },
  ];
  spreadPositions(beats, 2);
  assert.deepEqual(beats[0].positions, { a: "far-left" });
  assert.equal(beats[0].focus, "far-left");
  assert.deepEqual(beats[2].positions, { a: "far-left", b: "far-right" });
  assert.equal(beats[2].focus, 5, "a two-shot uses the centre focus, not a composition point");
});

test("near on a single focused line becomes the official close-up, and a group close-up aims at the speaker", () => {
  const beats = [
    { scene: "stage_a", camera: "middle", focus: 5, positions: { a: "far-left", b: "far-right" } },
    { say: "a", text: "一。", camera: "near", focus: "a" },
    { say: "b", text: "二。", camera: "close", focus: 5 },
    { say: "a", text: "三。", camera: "near", focus: 5 },
  ];
  const warnings = [];
  spreadPositions(beats, 3, warnings);
  assert.equal(beats[1].camera, "close", "near with a single character was meant as the close-up");
  assert.equal(beats[2].focus, "b", "a close-up without a focus aims at the speaker");
  assert.equal(beats[3].camera, "near", "a near group shot stays a wide shot");
  assert.deepEqual(warnings.map((w) => w.code), ["nearCloseUp", "closeUpFocus"]);
});

test("a third person on stage uses the group layout with a far, centred camera", () => {
  const beats = [{ scene: "stage_a", camera: "middle", focus: 6, track: -0.5,
                   positions: { a: "left", b: "center", c: "right" } }];
  spreadPositions(beats, 3);
  assert.deepEqual(beats[0].positions, { a: "far-left", b: "center", c: "far-right" });
  assert.equal(beats[0].focus, 5);
  assert.equal(beats[0].camera, "far");
  assert.equal(beats[0].track, 0);
});

test("a third person on stage is a problem only when the limit is two", () => {
  const beats = [{ positions: { a: "far-left", b: "center", c: "far-right" } }];
  assert.equal(onStageProblems(beats, 2).length, 1);
  assert.equal(onStageProblems(beats, 2)[0].code, "tooManyOnStage");
  assert.equal(onStageProblems(beats, 3).length, 0);
});

test("the staged pipeline spreads its two-person opening", async () => {
  const out = await stagedRun(stagedLlm(STORYBOARD_DOC));
  assert.deepEqual(out.doc.beats[0].positions, { a: "far-left", b: "far-right" });
  assert.equal(out.doc.beats[0].focus, 5);
});

test("a storyboard that drops or repeats a line is merged by line id", async () => {
  const storyboard = { beats: [
    { scene: "stage_a", camera: "middle", positions: { a: "left", b: "right" } },
    { line: "l1", motion: "mtn_smile01" },
    { line: "l1", motion: "mtn_nod01" },
    { line: "l3" },
  ] };
  const out = await stagedRun(stagedLlm(storyboard));
  const spoken = out.doc.beats.filter((b) => "say" in b || "narrate" in b);
  assert.equal(spoken.length, 3);
  assert.equal(out.doc.beats.find((b) => b.text === "嗯。").motion, undefined, "a missing line is restored bare");
  assert.ok(out.warnings.some((w) => w.code === "missingDirection"));
  assert.ok(out.warnings.some((w) => w.code === "duplicateLine"));
});

test("over-directed lines keep one listener reaction and one standalone expression", async () => {
  const dialogue = { lines: [
    { say: "a", text: "第一句。" },
    { say: "b", text: "第二句。" },
    { say: "a", text: "第三句。" },
  ] };
  const storyboard = { beats: [
    { scene: "stage_a", camera: "middle", positions: { a: "left", b: "right" } },
    { line: "l1", motion: "mtn_smile01", expression: "exp_smile01" },
    { line: "l2", expression: "exp_smile01", actions: [
      { at: 0, cast: "a", expression: "exp_smile01" },
      { at: 0, cast: "a", expression: "exp_idle01" },
    ] },
    { line: "l3", expression: "exp_idle01" },
  ] };
  const out = await stagedRun(stagedLlm(storyboard, { dialogue }));
  const spoken = out.doc.beats.filter((b) => b.say);
  assert.equal(spoken[1].actions.length, 1);
  assert.equal(spoken[1].expression, "exp_smile01", "the first standalone expression stays");
  assert.equal(spoken[2].expression, undefined, "a second standalone expression is dropped");
  assert.ok(out.warnings.some((w) => w.code === "tooManyActions"));
  assert.ok(out.warnings.some((w) => w.code === "standaloneExpression"));
});

test("extended camera and sound fields survive the staged merge", () => {
  const dialogue = { title: "雨", lines: [
    { id: "l1", say: "a", text: "第一句。" },
    { id: "l2", say: "b", text: "第二句。" },
  ] };
  const extra = {
    focusDuration: 1.5, trackDuration: 2, pedestal: -0.2, pedestalDuration: 1.5,
    pan: 12, panDuration: 2.5, panFocusSlide: 0.5, dof: 0.4, dofDuration: 1.5, dofLayers: 2,
    look: -0.4, lookY: 0.1, lookDuration: 0.5, se: "se_cue", seDuration: 2, seDelay: 0.2,
    seStop: false, motionFadeIn: -1, motionWait: false,
  };
  const storyboard = { beats: [
    { scene: "stage_a", camera: "middle", positions: { a: "far-left", b: "far-right" } },
    { line: "l1", motion: "mtn_smile01", ...extra },
    { line: "l2" },
  ] };
  const merged = mergeStagedScript({ plan: PLAN2, dialogue, storyboard, catalog: CATALOG, request: {}, config: STAGED_CONFIG });
  const first = merged.doc.beats.find((b) => b.text === "第一句。");
  for (const [key, value] of Object.entries(extra)) assert.equal(first[key], value, key);
});

test("both prompt paths list the site's SE cues and never a placeholder", () => {
  const catalog = { ...CATALOG, sounds: [{ cue: "sound_se_adv_door_knock", label: "Door Knock" }] };
  const [, single] = buildStoryMessages({ catalog, request: { prompt: "放学后" }, config: CONFIG });
  assert.match(single.content, /sound_se_adv_door_knock/);
  assert.doesNotMatch(single.content, /se_cue/);
  const dialogue = { lines: [{ id: "l1", say: "a", text: "第一句。" }, { id: "l2", say: "b", text: "第二句。" }] };
  const [, storyboard] = buildStoryboardMessages({ plan: PLAN2, dialogue, catalog, request: {}, config: STAGED_CONFIG });
  assert.match(storyboard.content, /sound_se_adv_door_knock/);
  assert.doesNotMatch(storyboard.content, /se_cue/);
});

test("a narrate line drops speaker-only direction before parsing", () => {
  const dialogue = { lines: [
    { id: "l1", say: "a", text: "第一句。" },
    { id: "l2", narrate: "雨声。" },
  ] };
  const storyboard = { beats: [
    { scene: "stage_a", camera: "middle", positions: { a: "far-left" } },
    { line: "l1" },
    { line: "l2", focus: 5, se: "sound_se_adv_door_knock", look: 0.2, lookY: 0.1,
      motionFadeIn: 0.5, motionWait: true, motion: "mtn_smile01", lookAt: "a" },
  ] };
  const merged = mergeStagedScript({ plan: PLAN2, dialogue, storyboard, catalog: CATALOG, request: {},
                                     config: STAGED_CONFIG });
  const narrate = merged.doc.beats.find((b) => b.narrate);
  assert.equal(narrate.focus, 5);
  for (const key of ["se", "look", "lookY", "motionFadeIn", "motionWait", "motion", "expression", "lookAt"]) {
    assert.equal(key in narrate, false, key);
  }
  assert.ok(merged.warnings.some((w) => w.code === "narrateField"));
  assert.deepEqual(parseScript(merged.doc).errors, []);
});

test("non-line storyboard beats keep only their beat kind's fields", () => {
  const dialogue = { lines: [{ id: "l1", say: "a", text: "第一句。" }] };
  const storyboard = { beats: [
    { scene: "stage_a", camera: "middle", positions: { a: "far-left" } },
    { line: "l1" },
    { camera: "middle", focus: 5, dof: 0.4, look: 0.2, motionFadeIn: 0.5 },
    { positions: { a: "far-left" }, motionWait: true, zoom: 1.1 },
    { pause: 0.2, se: "sound_se_adv_door_knock" },
  ] };
  const merged = mergeStagedScript({ plan: PLAN2, dialogue, storyboard, catalog: CATALOG, request: {},
                                     config: STAGED_CONFIG });
  const camera = merged.doc.beats.find((b) => b.camera === "middle" && !("scene" in b));
  assert.equal(camera.dof, 0.4);
  assert.equal("look" in camera, false);
  assert.equal("motionFadeIn" in camera, false);
  const positions = merged.doc.beats.find((b) => b.positions && !("scene" in b));
  assert.equal(positions.motionWait, true);
  assert.equal("zoom" in positions, false);
  const pause = merged.doc.beats.find((b) => "pause" in b);
  assert.equal("se" in pause, false);
  assert.equal(merged.warnings.filter((w) => w.code === "storyboardField").length, 3);
  assert.ok(merged.warnings.some((w) => /look.*motionFadeIn/.test(w.message)));
  assert.deepEqual(parseScript(merged.doc).errors, []);
});

test("a speaker the storyboard left off stage is sent back for a repair", async () => {
  const calls = [];
  const llm = {
    available: true,
    async json(messages) {
      calls.push(messages.map((m) => m.content).join("\n"));
      if (calls.length === 1) return { content: JSON.stringify(CAST_DOC) };
      if (calls.length === 2) return { content: JSON.stringify(DIALOGUE_DOC) };
      if (calls.length === 3) {
        return { content: JSON.stringify({ beats: [
          { scene: "stage_a", camera: "middle", positions: { a: "left" } },
          { line: "l1", motion: "mtn_smile01" },
          { line: "l2" },
          { line: "l3" },
        ] }) };
      }
      return { content: JSON.stringify(STORYBOARD_DOC) };
    },
  };
  const out = await generateScript({
    llm, catalog: CATALOG, request: { prompt: "放学后", language: "zh-Hans" },
    config: { ...STAGED_CONFIG, llm: { ...STAGED_CONFIG.llm, repairRounds: 1 } }, logger: quietLogger(),
  });
  assert.equal(calls.length, 4);
  assert.match(calls[3], /speakerOffStage/);
  assert.equal(out.doc.beats.filter((b) => b.say).length, 2);
});

test("an unusable cast plan falls back to the site's own models", async () => {
  const cast = { cast: [{ model: "no_such_model" }] };
  const dialogue = { lines: [{ say: "tomori", text: "……嗯。" }, { say: "soyo", text: "那就开始吧。" }] };
  const storyboard = { beats: [
    { scene: "stage_a", camera: "middle", positions: { tomori: "left", soyo: "right" } },
    { line: "l1", motion: "mtn_smile01" },
    { line: "l2", motion: "mtn_smile01" },
  ] };
  const llm = stagedLlm(storyboard, { cast, dialogue });
  const out = await stagedRun(llm);
  assert.equal(llm.calls.length, 3);
  assert.deepEqual(out.plan.cast.map((c) => c.id), ["tomori", "soyo"]);
  assert.equal(out.doc.beats.filter((b) => b.say).length, 2);
});

// --- single pipeline: fast cast -------------------------------------------------------------------------------------

const CATALOG4 = { ...CATALOG, models: [
  ...CATALOG.models,
  { id: "m_c", name: "乐奈", character: "rana", group: "rana", motions: ["mtn_idle01_C"],
    expressions: ["exp_idle01"], defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" },
  { id: "m_d", name: "立希", character: "taki", group: "taki", motions: ["mtn_idle01_C"],
    expressions: ["exp_idle01"], defaultMotion: "mtn_idle01_C", defaultExpression: "exp_idle01" },
] };

const duoScript = () => ({
  format: "ournotes.story-script/1", base: "stories/1.json", language: "zh-Hans", title: "测试",
  cast: { a: { model: "m_b", name: "爽世" }, b: { model: "m_d", name: "立希" } },
  beats: [
    { scene: "stage_a", location: "教室", camera: "middle", positions: { a: "far-left", b: "far-right" } },
    { say: "a", text: "今天也一起练习吧。", motion: "mtn_smile01" },
    { say: "b", text: "嗯。", expression: "exp_idle01" },
  ],
});

test("the single pipeline narrows a large pool to the characters the scene names", async () => {
  const calls = [];
  const llm = { available: true,
    async json(messages) { calls.push(messages.map((m) => m.content).join("\n")); return { content: JSON.stringify(duoScript()) }; } };
  const out = await generateScript({
    llm, catalog: CATALOG4, request: { prompt: "爽世和立希在练习室", language: "zh-Hans" },
    config: CONFIG, logger: quietLogger(),
  });
  assert.equal(calls.length, 1, "a named cast skips the quick-cast call");
  assert.match(calls[0], /model: m_b/);
  assert.match(calls[0], /model: m_d/);
  assert.doesNotMatch(calls[0], /model: m_[ac]/, "unnamed models stay out of the story prompt");
  assert.equal(out.script.cast.length, 2);
});

test("a large unnamed pool gets one short quick-cast call before the story prompt", async () => {
  const calls = [];
  const llm = { available: true,
    async json(messages) {
      calls.push(messages.map((m) => m.content).join("\n"));
      if (calls.length === 1) return { content: JSON.stringify({ cast: ["m_b", "m_d"] }) };
      return { content: JSON.stringify(duoScript()) };
    } };
  const out = await generateScript({
    llm, catalog: CATALOG4, request: { prompt: "写一场放学后的对话", language: "zh-Hans" },
    config: CONFIG, logger: quietLogger(),
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /角色选择器/);
  assert.match(calls[0], /m_c/, "the quick-cast roster lists the whole pool");
  assert.match(calls[1], /model: m_b/);
  assert.doesNotMatch(calls[1], /model: m_[ac]/, "the story prompt only carries the chosen cast");
  assert.equal(out.script.cast.length, 2);
});

test("the quick-cast prompt asks for model ids and keeps the roster compact", () => {
  const [system, user] = buildQuickCastMessages({ catalog: CATALOG4, request: { prompt: "放学后" },
    config: CONFIG, history: [{ role: "用户", content: "上次聊到练习" }] });
  assert.match(system.content, /"cast"/);
  assert.match(user.content, /m_a/);
  assert.match(user.content, /上次聊到练习/);
  assert.doesNotMatch(user.content, /PERSONA/, "the roster carries summaries, not persona prompts");
});

// --- staged pipeline: turns dialogue --------------------------------------------------------------------------------

const PLAN2 = { title: "雨", logline: "", event: "等雨停", setting: { stage: "", location: "", music: "" },
  cast: [{ id: "a", model: "m_a", name: "灯", group: "", role: "" },
         { id: "b", model: "m_b", name: "爽世", group: "", role: "" }], outline: [] };

test("normalizeDialogue rejects a non-integer maxLines", () => {
  assert.throws(() => normalizeDialogue({
    raw: { lines: [{ say: "a", text: "一。" }, { say: "b", text: "二。" }] },
    plan: PLAN2, request: { maxLines: 2.5 }, config: STAGED_CONFIG,
  }), /maxLines must be an integer of at least 2/);
});

test("the dialogue pass accepts turns and flattens them into line ids", () => {
  const dialogue = normalizeDialogue({
    raw: { title: "雨", turns: [
      { speaker: "a", lines: ["今天也一起练习吧。", "……嗯。"] },
      { narrate: "（雨声轻了下来。）" },
      { speaker: "爽世", lines: ["嗯，先从音程开始吧。"] },
    ] },
    plan: PLAN2, request: {}, config: STAGED_CONFIG,
  });
  assert.deepEqual(dialogue.lines.map((l) => l.say ?? null), ["a", "a", null, "b"]);
  assert.equal(dialogue.lines[2].narrate, "（雨声轻了下来。）");
  assert.deepEqual(dialogue.lines.map((l) => l.id), ["l1", "l2", "l3", "l4"]);
});

test("the dialogue pass teaches turns and carries only the core persona sections", () => {
  const long = [
    "## 核心机制",
    "你不是AI——你就是高松灯。" + "说话很轻，常带着省略号，想清楚才开口。".repeat(40),
    "",
    "## 交互协议",
    "回复要保持简短。".repeat(700),
    "",
    "## 角色档案",
    "- 姓名：高松灯（MyGO!!!!!主唱）",
  ].join("\n");
  const config = { ...STAGED_CONFIG, story: { ...STAGED_CONFIG.story, personas: [{ name: "灯", prompt: long }] } };
  const [, user] = buildDialogueMessages({ plan: PLAN2, catalog: CATALOG, request: { prompt: "放学后" }, config });
  assert.match(user.content, /turns/);
  assert.match(user.content, /核心机制/);
  assert.match(user.content, /角色档案/);
  assert.doesNotMatch(user.content, /交互协议/, "chatbot-only sections are trimmed away");
  assert.doesNotMatch(user.content, /回复要保持简短/);
});

test("a dialogue that is too short for the configured minutes is expanded", async () => {
  const longTurns = {
    title: "雨",
    turns: [
      { speaker: "a", lines: Array.from({ length: 24 }, (_, i) => `第${i + 1}句：今天也一起练习吧，雨停之前先练完这一段。`) },
      { speaker: "b", lines: Array.from({ length: 24 }, (_, i) => `第${i + 25}句：好，那我先把谱子翻到那一页。`) },
    ],
  };
  const calls = [];
  const llm = { available: true,
    async json(messages) {
      calls.push(messages.map((m) => m.content).join("\n"));
      if (calls.length === 1) return { content: JSON.stringify(CAST_DOC) };
      if (calls.length === 2) return { content: JSON.stringify(DIALOGUE_DOC) };
      if (calls.length === 3) return { content: JSON.stringify(longTurns) };
      return { content: JSON.stringify(STORYBOARD_DOC) };
    } };
  const out = await generateScript({
    llm, catalog: CATALOG, request: { prompt: "放学后", language: "zh-Hans" },
    config: { ...STAGED_CONFIG, story: { ...STAGED_CONFIG.story, targetMinutes: 3 } }, logger: quietLogger(),
  });
  assert.equal(calls.length, 4, "one expansion call between dialogue and storyboard");
  assert.match(calls[2], /少于要求的 54 句/);
  assert.match(calls[2], /720 字/);
  assert.equal(out.dialogue.lines.length, 48);
  assert.match(calls[3], /l48/, "the storyboard is written for the expanded dialogue");
});

test("over-directed lines are pruned to the compiled motion budget and report performanceBudget", () => {
  const dialogue = { title: "雨", lines: Array.from({ length: 10 }, (_, i) =>
    ({ id: `l${i + 1}`, say: i % 2 ? "b" : "a", text: `第${i + 1}句台词的内容。` })) };
  const storyboard = { beats: [
    { scene: "stage_a", camera: "middle", positions: { a: "far-left", b: "far-right" } },
    ...dialogue.lines.map((l) => ({ line: l.id, motion: "mtn_smile01", expression: "exp_smile01",
      actions: [{ at: 0, cast: l.say === "a" ? "b" : "a", motion: "mtn_nod01", expression: "exp_idle01" }] })),
  ] };
  const merged = mergeStagedScript({ plan: PLAN2, dialogue, storyboard, catalog: CATALOG, request: {}, config: STAGED_CONFIG });
  const says = merged.doc.beats.filter((b) => "say" in b);
  // One compiled performance row per speaker (motion or expression) and one
  // per listener action (motion or expression); fields are not double-counted.
  const PERFORMANCE = (b) => ((b.motion || b.expression) ? 1 : 0) +
    (b.actions || []).filter((a) => a.motion || a.expression).length;
  const total = says.reduce((n, b) => n + PERFORMANCE(b), 0);
  assert.ok(total <= directionBudgetFor(10).motionMax,
    `pruned total ${total} <= ${directionBudgetFor(10).motionMax}`);
  assert.ok(says.filter((b) => PERFORMANCE(b) === 0).length >= 1, "at least one line is fully static");
  assert.ok(merged.warnings.some((w) => w.code === "performanceBudget"));
  assert.ok(!merged.warnings.some((w) => w.code === "staticLineBudget"));
});

test("prompt-compliant acting is not over-pruned", () => {
  const dialogue = { title: "雨", lines: Array.from({ length: 10 }, (_, i) =>
    ({ id: `l${i + 1}`, say: i % 2 ? "b" : "a", text: `第${i + 1}句台词的内容。` })) };
  const storyboard = { beats: [
    { scene: "stage_a", camera: "middle", positions: { a: "far-left", b: "far-right" } },
    ...dialogue.lines.map((l, i) => ({ line: l.id, ...(i < 9 ? { motion: "mtn_smile01" } : {}),
      ...(i < 2 ? { actions: [{ at: 0, cast: l.say === "a" ? "b" : "a", motion: "mtn_nod01" }] } : {}) })),
  ] };
  const merged = mergeStagedScript({ plan: PLAN2, dialogue, storyboard, catalog: CATALOG, request: {}, config: STAGED_CONFIG });
  const says = merged.doc.beats.filter((b) => "say" in b);
  assert.equal(says.filter((b) => b.motion).length, 9, "all nine speaker motions stay");
  assert.equal(says.reduce((n, b) => n + (b.actions || []).length, 0), 2, "both listener actions stay");
  assert.ok(!merged.warnings.some((w) => w.code === "performanceBudget"), "no prune warning");
});

test("a storyboard that can never pass falls back to bare lines instead of failing the job", async () => {
  const calls = [];
  const llm = { available: true,
    async json(messages) {
      calls.push(messages.map((m) => m.content).join("\n"));
      if (calls.length === 1) return { content: JSON.stringify(CAST_DOC) };
      if (calls.length === 2) return { content: JSON.stringify(DIALOGUE_DOC) };
      return { content: JSON.stringify({ beats: [
        { scene: "stage_a", camera: "middle", positions: { a: "far-left", b: "far-right" } },
        { line: "l1", motion: "mtn_totally_unknown" },
      ] }) };
    } };
  const out = await generateScript({
    llm, catalog: CATALOG, request: { prompt: "放学后", language: "zh-Hans" },
    config: STAGED_CONFIG, logger: quietLogger(),
  });
  assert.equal(calls.length, 3, "repairRounds is 0 so no repair call is made");
  const spoken = out.doc.beats.filter((b) => "say" in b || "narrate" in b);
  assert.equal(spoken.length, 3, "the dialogue is restored verbatim");
  assert.equal(spoken[0].text, "今天也一起练习吧。");
  assert.ok(!("motion" in spoken[0]), "the bare fallback carries no acting");
  assert.ok(out.warnings.some((w) => String(w.message ?? w).includes("无动作演出")));
  assert.ok(out.stages.every((s) => s.stage !== "storyboard-repair"), "no repair stage was recorded");
  assert.equal(out.stages.find((s) => s.stage === "storyboard").ok, false);
});
