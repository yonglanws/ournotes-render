// AI story writer: prompt -> JSON -> parse/check -> apply known fixes -> ask the model to repair -> repeat.
// The writer only produces the script; TTS, compilation and rendering are separate stages.
//
// Two pipelines in the MySekaiStoryteller harness style:
//   single  — a fast cast pre-pass narrows the model pool first, then one call writes the whole script; failures go
//             through a repair loop that keeps the conversation and appends the problem list.
//   staged  — cast -> dialogue (full trimmed personas of the chosen cast only) -> storyboard. Every stage has its own
//             focused repair and a fallback, and the result carries per-stage diagnostics (stages/warnings/usage).
import { applyFixes, checkScript, parseScript, SCRIPT_FORMAT } from "../../scripts/lib/story-author/script.js";
import { extractJson } from "./json.js";
import { dialogueBudgetFor } from "./official-targets.js";
import { buildPlanMessages, buildQuickCastMessages, buildStoryMessages, MAX_PROMPT_MODELS } from "./prompt.js";
import {
  balanceLineBreaks, buildCastMessages, buildDialogueLengthPrompt, buildDialogueMessages,
  buildDialogueRepairMessages, buildStoryboardMessages, buildStoryboardRepairMessages, fallbackCastPlan,
  mergeStagedScript, modelIndex, normalizeCastPlan, normalizeDialogue, onStageProblems, resolveModel,
  spreadPositions, countDialogueChars,
} from "./staged.js";

export class StoryWriterError extends Error {
  constructor(message, { details = null, cause = null } = {}) {
    super(message);
    this.name = "StoryWriterError";
    this.code = "story_generation";
    this.details = details;
    if (cause) this.cause = cause;
  }
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const lower = (s) => String(s || "").trim().toLowerCase();
// A provider that counts reasoning against max_tokens can return finish_reason=length before any JSON is written.
// One retry of the same fixed request is cheaper than losing a finished dialogue pass.
const isTruncatedAnswer = (error) =>
  /truncated|finish_reason=length/i.test(`${error?.message || ""} ${error?.cause?.message || ""}`);

// Extended official camera/sound fields: normalize() preserves them for the parser, checker and compiler so a staged
// answer is not silently stripped.
const EXTRA_BEAT_FIELDS = ["focusDuration", "trackDuration", "pedestal", "pedestalDuration",
  "pan", "panDuration", "panFocusSlide", "dof", "dofDuration", "dofLayers",
  "look", "lookY", "lookDuration", "se", "seDuration", "seDelay", "seStop",
  "motionFadeIn", "motionWait"];
const EXTRA_NUMERIC_FIELDS = new Set(["focusDuration", "trackDuration", "pedestal", "pedestalDuration",
  "pan", "panDuration", "panFocusSlide", "dof", "dofDuration", "dofLayers",
  "look", "lookY", "lookDuration", "seDuration", "seDelay", "motionFadeIn"]);
const EXTRA_BOOLEAN_FIELDS = new Set(["seStop", "motionWait"]);
const asBoolean = (v) => (typeof v === "boolean" ? v
  : typeof v === "string" ? v.trim().toLowerCase() === "true"
    : typeof v === "number" ? v !== 0 : v);

// The staged repair loop asks for a fresh storyboard, so a failure keeps the finished dialogue. This hint does the
// same job for the single pipeline without resending the whole prompt template.
const REPAIR_HINT = (problems) => {
  const list = problems.map((p) => `- ${p.path || "/"}: [${p.code}] ${p.message}` +
    (p.expected ? `（可用值：${p.expected.slice(0, 40).join(", ")}${p.expected.length > 40 ? "…" : ""}）` : "") +
    (p.suggestion ? `（建议：${p.suggestion}）` : "")).join("\n");
  return `上一次输出的剧本没有通过校验：\n${list}\n\n` +
    "请只输出修复后的完整 JSON 对象（ournotes.story-script/1），保留原有剧情、台词与演出，不要解释，不要 markdown。";
};

const unwrap = (doc) => {
  if (!isObj(doc)) return doc;
  for (const k of ["script", "story", "data", "result"]) {
    if (isObj(doc[k]) && (Array.isArray(doc[k].beats) || Array.isArray(doc[k].cast))) return doc[k];
  }
  return doc;
};

const normalize = (raw, { catalog, request, config }) => {
  let doc = unwrap(raw);
  if (!isObj(doc)) return doc;
  doc = JSON.parse(JSON.stringify(doc));
  doc.format = SCRIPT_FORMAT;
  doc.base = catalog.manifest;
  doc.language = request.language || catalog.language;
  if (!doc.font) doc.font = config.story.font || "sans";
  if (request.title) doc.title = request.title;
  if (typeof doc.title !== "string" || !doc.title.trim()) doc.title = config.story.title || "";
  if (doc.title && doc.title.length > 64) doc.title = doc.title.slice(0, 64);

  // Cast: correct a model named by character/display name, and fill a missing display name.
  const byId = new Map(catalog.models.map((m) => [m.id, m]));
  const byText = new Map();
  for (const m of catalog.models) {
    for (const k of [m.name, m.character, m.id]) if (k && !byText.has(lower(k))) byText.set(lower(k), m);
  }
  const castIds = new Set();
  // accept the object form, and also the common array form [{id, model, name}]
  if (Array.isArray(doc.cast)) {
    const asObject = {};
    for (const c of doc.cast) {
      if (!isObj(c)) continue;
      const id = String(c.id || c.castId || c.name || "").replace(/[^A-Za-z0-9_]/g, "") || `c${Object.keys(asObject).length + 1}`;
      asObject[id] = c;
    }
    doc.cast = asObject;
  }
  if (isObj(doc.cast)) {
    for (const [id, entry] of Object.entries(doc.cast)) {
      if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) continue;
      const c = typeof entry === "string" ? { model: entry } : entry;
      if (!isObj(c)) continue;
      let model = typeof c.model === "string" ? c.model.trim() : "";
      if (!byId.has(model)) {
        const hit = byText.get(lower(model)) || byText.get(lower(c.name));
        if (hit) model = hit.id;
      }
      const m = byId.get(model);
      doc.cast[id] = { model: m ? m.id : model, name: String(c.name || m?.name || model || id).trim() };
      castIds.add(id);
    }
  }
  // A beat that names a cast id by display name instead of its key, or writes a number as a string.
  if (Array.isArray(doc.beats) && isObj(doc.cast)) {
    const byName = new Map(Object.entries(doc.cast).map(([id, c]) => [lower(c.name), id]));
    const idOf = (v) => (castIds.has(v) ? v : byName.get(lower(v)) || v);
    const asNumber = (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v);
    const targetOf = (v) => (typeof v === "string" && v && !castIds.has(v) ? idOf(v) : asNumber(v));
    for (const b of doc.beats) {
      if (!isObj(b)) continue;
      for (const key of ["say", "action"]) {
        if (typeof b[key] === "string" && !castIds.has(b[key])) b[key] = idOf(b[key]);
      }
      if ("focus" in b) b.focus = targetOf(b.focus);
      if ("lookAt" in b) b.lookAt = targetOf(b.lookAt);
      if ("track" in b) b.track = asNumber(b.track);
      if (isObj(b.camera)) {
        if ("focus" in b.camera) b.camera.focus = targetOf(b.camera.focus);
        if ("track" in b.camera) b.camera.track = asNumber(b.camera.track);
      }
      if (Array.isArray(b.actions)) {
        for (const a of b.actions) {
          if (!isObj(a)) continue;
          if ("at" in a) a.at = asNumber(a.at);
          if (typeof a.at === "number" && a.at > 1 && a.at <= 100) a.at = a.at / 100;   // models often write 45 for 0.45
          if (typeof a.cast === "string" && a.cast && !castIds.has(a.cast)) a.cast = idOf(a.cast);
          if ("lookAt" in a) a.lookAt = targetOf(a.lookAt);
        }
      }
      if (isObj(b.positions)) {
        const fixed = {};
        for (const [id, p] of Object.entries(b.positions)) {
          const key = castIds.has(id) ? id : byName.get(lower(id)) || id;
          fixed[key] = p;
        }
        b.positions = fixed;
      }
      for (const key of EXTRA_BEAT_FIELDS) {
        if (!(key in b)) continue;
        if (EXTRA_NUMERIC_FIELDS.has(key)) b[key] = asNumber(b[key]);
        else if (EXTRA_BOOLEAN_FIELDS.has(key)) b[key] = asBoolean(b[key]);
      }
    }
  }
  return doc;
};

const linesOf = (doc) => (Array.isArray(doc?.beats) ? doc.beats.filter((b) => isObj(b) && ("say" in b || "narrate" in b)).length : 0);

const trimLines = (doc, maxLines, logger) => {
  if (!Array.isArray(doc.beats) || maxLines <= 0) return doc;
  let lines = 0, cut = -1;
  for (let i = 0; i < doc.beats.length; i++) {
    const b = doc.beats[i];
    if (isObj(b) && ("say" in b || "narrate" in b)) {
      lines++;
      if (lines >= maxLines) { cut = i + 1; break; }
    }
  }
  if (cut > 0 && cut < doc.beats.length) {
    logger.warn?.(`script has ${linesOf(doc)} lines; truncating to ${maxLines}`);
    doc.beats = doc.beats.slice(0, cut);
  }
  return doc;
};

// A narrowed catalog for the fast cast: everything else (stages, music, manifest…) stays as configured.
const withModels = (catalog, models) => ({ ...catalog, models });

const maxOnStageOf = (config) => Math.max(2, Math.min(3, Math.round(Number(config.story?.maxOnStage ?? 3) || 3)));

/**
 * single 的前置快速选角：把大角色池缩到这场戏需要的 1~maxOnStage 人，
 * 主提示词只带入选角色的紧凑人设，而不是几十份完整表格。
 * 顺序：场景点名角色 → 一次很短的选角调用；两步失败都保留完整目录（staged 自带选角段，不走这里）。
 */
const resolveFastCast = async ({ catalog, request, config, llm, logger, signal }) => {
  const maxOnStage = maxOnStageOf(config);
  const pool = (catalog.models || []).slice(0, MAX_PROMPT_MODELS);
  if (pool.length <= maxOnStage) return catalog;

  const prompt = String(request.prompt || "");
  const mentioned = pool.filter((m) => [m.name, m.character]
    .filter((n) => n && String(n).length >= 2)
    .some((n) => prompt.includes(n)));
  if (mentioned.length) {
    logger.info?.(`场景点名角色：${mentioned.slice(0, maxOnStage).map((m) => m.name).join("、")}`);
    return withModels(catalog, mentioned.slice(0, maxOnStage));
  }

  if (!llm.available) return catalog;
  try {
    const answer = await llm.json(buildQuickCastMessages({ catalog, request, config }), { signal, label: "quick-cast" });
    const data = extractJson(answer.content);
    const raw = Array.isArray(data) ? data
      : isObj(data) && Array.isArray(data.cast) ? data.cast
        : isObj(data) && data.cast != null ? [data.cast] : [];
    const index = modelIndex(catalog);
    const cast = [];
    for (const item of raw) {
      const model = resolveModel(index, String(item ?? "").trim());
      if (model && !cast.some((m) => m.id === model.id)) cast.push(model);
    }
    if (cast.length) {
      logger.info?.(`快速选角：${cast.map((m) => m.name).join("、")}`);
      return withModels(catalog, cast.slice(0, maxOnStage));
    }
  } catch (e) {
    if (signal?.aborted) throw signal.reason || e;
    logger.warn?.(`快速选角失败，保留完整角色池：${e.message}`);
  }
  return catalog;
};

const siteFor = (catalog) => ({
  base: { language: catalog.language, languages: catalog.languages, stages: catalog.stages, music: catalog.music,
          sounds: catalog.sounds || [] },
  models: catalog.models.map((m) => m.id),
  actions: Object.fromEntries(catalog.models.filter((m) => m.actionsKnown !== false).map((m) => [m.id, {
    motions: m.motions, expressions: m.expressions, defaultMotion: m.defaultMotion, defaultExpression: m.defaultExpression,
  }])),
  sounds: catalog.sounds || [],
});

// Everything the API can tell a caller about a script before rendering.
export const checkDocument = (doc, catalog) => {
  const parsed = parseScript(doc);
  if (parsed.errors.length) return { script: parsed.script, errors: parsed.errors, warnings: [] };
  const checked = checkScript(parsed.script, siteFor(catalog));
  return { script: parsed.script, errors: checked.errors, warnings: checked.warnings };
};

// A script supplied by an API caller: normalize the shape, then apply the checker's known fixes until it is clean.
export const prepareScript = ({ doc, catalog, request = {}, config, logger = console }) => {
  let cur = normalize(doc, { catalog, request, config });
  if (!isObj(cur)) return { errors: [{ path: "", code: "type", message: "a script is a JSON object" }], warnings: [] };
  const site = siteFor(catalog);
  for (let round = 0; round < 6; round++) {
    const parsed = parseScript(cur);
    let problems = parsed.errors, warnings = [];
    if (!problems.length) {
      const checked = checkScript(parsed.script, site);
      problems = checked.errors;
      warnings = checked.warnings;
      if (!problems.length) return { script: parsed.script, doc: cur, warnings, errors: [] };
    }
    const fixable = [...problems, ...warnings].filter((p) => Array.isArray(p.fix) && p.fix.length);
    if (!fixable.length) return { errors: problems, warnings };
    const fixed = applyFixes(cur, fixable);
    if (!fixed.applied.length) return { errors: problems, warnings };
    logger.info?.(`script: applied ${fixed.applied.length} automatic fix(es)`);
    cur = fixed.script;
  }
  const parsed = parseScript(cur);
  const checked = parsed.errors.length ? { errors: parsed.errors, warnings: [] } : checkScript(parsed.script, site);
  return { script: parsed.script, doc: cur, errors: checked.errors || [], warnings: checked.warnings || [] };
};

const combineUsage = (calls) => {
  if (!calls.length) return null;
  const out = { calls: [...calls] };
  for (const u of calls) for (const [k, v] of Object.entries(u || {})) {
    if (typeof v === "number") out[k] = (out[k] || 0) + v;
  }
  return out;
};

const generateSingle = async ({ llm, catalog, request, config, logger, signal, onProgress = () => {} }) => {
  const maxOnStage = maxOnStageOf(config);
  // single 只有一次主生成：先把大角色池缩到这场戏需要的几个人，主提示词只带他们的紧凑人设。
  const narrowed = await resolveFastCast({ catalog, request, config, llm, logger, signal });
  // Optional first pass: a short director's plan. It improves shot flow and acting; a failure only loses the notes.
  let plan = null;
  if (config.llm.directorPlan === true) {
    onProgress("planning", 0, "AI 设计分镜");
    try {
      const answer = await llm.json(buildPlanMessages({ catalog: narrowed, request, config }), { signal, label: "plan" });
      plan = extractJson(answer.content);
      if (!plan) logger.warn?.("the director plan was not JSON; writing the script without it");
    } catch (e) {
      if (signal?.aborted) throw signal.reason || e;
      logger.warn?.(`the director plan failed (${e.message}); writing the script without it`);
    }
  }
  const messages = buildStoryMessages({ catalog: narrowed, request, config, plan });
  onProgress("writing", 0, "AI 编写剧本");
  const site = siteFor(narrowed);
  const maxLines = Number(request.maxLines ?? config.story.maxLines ?? 120);
  const rounds = Math.max(0, config.llm.repairRounds ?? 2);
  const details = [];
  let answer = null;
  let doc = null;
  let lastProblems = [];

  for (let round = 0; round <= rounds; round++) {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    if (round) onProgress("writing", round / (rounds + 1), `AI 修正剧本 (${round}/${rounds})`);
    try {
      answer = await llm.json(messages, { signal, label: round ? "repair" : "story" });
    } catch (e) {
      if (signal?.aborted) throw signal.reason || e;
      throw new StoryWriterError(`AI 剧本生成失败：${e.message}`, { cause: e });
    }

    // The answer itself is repairable too: keep the conversation, append the problem, try again (one focused retry
    // per round instead of failing the job).
    doc = normalize(extractJson(answer.content), { catalog: narrowed, request, config });
    if (!isObj(doc)) {
      const problem = { path: "/", code: "type", message: "the answer was not a JSON object" };
      details.push(problem.message);
      lastProblems = [problem];
      logger.warn?.(`round ${round}: the answer was not a JSON object`);
      if (round >= rounds) break;
      messages.push({ role: "assistant", content: answer.content.slice(0, 20_000) });
      messages.push({ role: "user", content: REPAIR_HINT([problem]) });
      continue;
    }
    doc = trimLines(doc, maxLines, logger);
    spreadPositions(doc.beats, maxOnStage);

    let problems = [];
    let warnings = [];
    const parsed = parseScript(doc);
    problems = parsed.errors;
    if (!problems.length) {
      const checked = checkScript(parsed.script, site);
      problems = checked.errors;
      warnings = checked.warnings;
      if (!problems.length) problems = onStageProblems(doc.beats, maxOnStage);
      if (!problems.length) {
        const lines = linesOf(doc);
        if (lines < 2) {
          problems = [{ path: "/beats", code: "tooShort", message: `the script has only ${lines} line(s)` }];
        } else {
          logger.info?.(`script ok: ${lines} lines, ${parsed.script.cast.length} cast, ${warnings.length} warning(s)`);
          return { script: parsed.script, doc, warnings, raw: answer.content, usage: answer.usage };
        }
      }
    }
    lastProblems = problems;
    // apply the fixes the checker knows (nearest names, duplicate ids, free positions)
    const fixable = [...problems, ...warnings].filter((p) => Array.isArray(p.fix) && p.fix.length);
    if (fixable.length) {
      const fixed = applyFixes(doc, fixable);
      if (fixed.applied.length) {
        logger.info?.(`script round ${round}: applied ${fixed.applied.length} automatic fix(es)`);
        doc = fixed.script;
        continue;
      }
    }
    if (round >= rounds) break;
    // Repair in the same conversation: the model sees its own answer and the problem list.
    messages.push({ role: "assistant", content: answer.content.slice(0, 20_000) });
    messages.push({ role: "user", content: REPAIR_HINT(problems) });
  }
  throw new StoryWriterError("AI 剧本经过自动修复后仍有错误", { details: lastProblems });
};

// Three calls instead of one: cast -> dialogue (full persona prompts, selected cast only) -> storyboard. The repair
// loop only asks for a new storyboard: the finished dialogue is restored verbatim after every merge. Every stage has
// a fallback and reports into `stages`, so a caller can see which leg needed help.
const generateStaged = async ({ llm, catalog, request, config, logger, signal, onProgress = () => {} }) => {
  const usages = [];
  const stages = [];
  const stageWarnings = [];
  const ask = async (messages, label) => {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    const startedAt = Date.now();
    let usedLabel = label;
    let answer;
    try {
      answer = await llm.json(messages, { signal, label });
    } catch (e) {
      if (signal?.aborted || !isTruncatedAnswer(e)) throw e;
      stageWarnings.push(`${label} 回答被截断，已重试一次`);
      logger.warn?.(`${label}: answer truncated; retrying once`);
      usedLabel = `${label}-retry`;
      answer = await llm.json(messages, { signal, label: usedLabel });
    }
    if (answer.usage) usages.push({ stage: usedLabel, ...answer.usage });
    stages.push({ stage: usedLabel, model: answer.model ?? null, latencyMs: Date.now() - startedAt,
                  usage: answer.usage ?? null, ok: true });
    return answer;
  };
  const markStageFailed = (note, stage) => {
    const last = stage ? [...stages].reverse().find((entry) => entry.stage === stage) : stages[stages.length - 1];
    if (last) { last.ok = false; last.note = note; }
  };
  const failed = (label, e) => {
    if (signal?.aborted) throw signal.reason || e;
    throw new StoryWriterError(`AI ${label}失败：${e.message}`, { cause: e });
  };

  onProgress("casting", 0.02, "AI 选角");
  let plan = null;
  try {
    const answer = await ask(buildCastMessages({ catalog, request, config }), "cast");
    plan = normalizeCastPlan(extractJson(answer.content), { catalog, request, config });
    if (!plan) {
      markStageFailed("没有返回目录中的角色");
      stageWarnings.push("选角结果没有可用角色，已按站点角色顺序回退");
      logger.warn?.("选角结果里没有已知模型；改用站点角色顺序");
    }
  } catch (e) {
    if (signal?.aborted) throw signal.reason || e;
    stageWarnings.push(`选角失败，已按站点角色顺序回退：${e.message}`);
    logger.warn?.(`选角失败（${e.message}）；改用站点角色顺序`);
  }
  if (!plan) plan = fallbackCastPlan({ catalog, request, config });
  if (!plan.cast.length) throw new StoryWriterError("站点没有可用于选角的模型");
  if (request.title) plan.title = request.title;

  onProgress("dialogue", 0.22, "AI 编写台词");
  const dialogueAnswer = await ask(buildDialogueMessages({ plan, catalog, request, config }), "dialogue")
    .catch((e) => failed("台词生成", e));
  const dialogueRaw = extractJson(dialogueAnswer.content);
  let dialogue = normalizeDialogue({ raw: dialogueRaw, plan, request, config });
  if (!dialogue) {
    markStageFailed("没有返回至少 2 条可用台词");
    stageWarnings.push("台词稿为空或不完整，已请求重写一次");
    logger.warn?.("the dialogue pass returned no usable lines; retrying once");
    onProgress("dialogue", 0.34, "AI 修正台词稿");
    const retry = await ask(buildDialogueRepairMessages({ plan, catalog, request, config, previous: dialogueRaw }),
                            "dialogue-repair").catch((e) => failed("修正台词稿", e));
    dialogue = normalizeDialogue({ raw: extractJson(retry.content), plan, request, config });
    if (!dialogue) markStageFailed("重写后仍没有至少 2 条可用台词");
  }
  if (!dialogue) {
    throw new StoryWriterError("AI 没有返回可用的台词稿", { details: String(dialogueAnswer.content).slice(0, 1000) });
  }
  if (!request.title && dialogue.title) plan.title = dialogue.title;
  logger.info?.(`staged: ${plan.cast.length} cast, ${dialogue.lines.length} dialogue lines`);

  // ---- 台词长度闸 ------------------------------------------------------------------------------------------
  // 句数和总字数共用一个官方预算（dialogueBudgetFor）；两者都达到下限才算合格。
  // 测试与调试用的极短 targetMinutes 不启用；补写最多两次，每次都保留原事件与人物关系。
  const targetMinutes = Number(request.targetMinutes ?? config.story?.targetMinutes ?? 0);
  const enforceDialogueLength = targetMinutes >= 0.5;
  const budget = dialogueBudgetFor(targetMinutes);
  const maxLinesConfig = Number(request.maxLines ?? config.story?.maxLines ?? 120);
  const lineCap = Math.max(1, Math.floor(Number(maxLinesConfig) || 120));
  const minDialogueLines = Math.max(1, Math.min(budget.minLines, lineCap));
  // A strict maxLines cap also scales the character floor; otherwise a 5-line
  // cap would still demand a full 3-minute character count and never converge.
  const lineScale = Math.min(1, lineCap / Math.max(1, budget.lines));
  const minDialogueChars = Math.max(10, Math.round(budget.chars * lineScale));
  const requiredLines = Math.min(lineCap, Math.max(minDialogueLines, budget.lines));
  const dialogueIsShort = () => dialogue.lines.length < minDialogueLines ||
    countDialogueChars(dialogue) < minDialogueChars;
  if (enforceDialogueLength && dialogueIsShort()) {
    const expandDialogue = async (label) => {
      const current = dialogue;
      const currentLines = current.lines.length;
      const currentChars = countDialogueChars(current);
      logger.info?.(`${label}: ${currentLines} 句 / ${currentChars} 字，目标 ${requiredLines} 句 / ${minDialogueChars} 字`);
      const answer = await ask(buildDialogueLengthPrompt({ plan, catalog, request, config, previous: current,
        actualLines: currentLines, requiredLines, requiredChars: minDialogueChars }), label);
      const expanded = normalizeDialogue({ raw: extractJson(answer.content), plan, request, config });
      if (expanded &&
          (expanded.lines.length > currentLines || countDialogueChars(expanded) > currentChars)) {
        dialogue = expanded;
        return true;
      }
      return false;
    };
    markStageFailed(
      `台词太短（${dialogue.lines.length} 句 / ${countDialogueChars(dialogue)} 字，` +
      `至少需要 ${minDialogueLines} 句 / ${minDialogueChars} 字）`);
    stageWarnings.push(
      `台词只有 ${dialogue.lines.length} 句 / ${countDialogueChars(dialogue)} 字，已请求补写` +
      `（至少 ${minDialogueLines} 句 / ${minDialogueChars} 字，目标 ${requiredLines} 句）`);
    for (let attempt = 0; attempt < 2 && dialogueIsShort(); attempt++) {
      if (attempt > 0) stageWarnings.push("补写后仍然偏短，已再补写一次");
      try {
        const improved = await expandDialogue(attempt === 0 ? "dialogue-expand" : "dialogue-expand-2");
        if (!improved) break;
      } catch (e) {
        if (signal?.aborted) throw signal.reason || e;
        stageWarnings.push(attempt === 0 ? `台词补写失败：${e.message}` : `台词二次补写失败：${e.message}`);
      }
    }
  }
  const breakBalance = balanceLineBreaks(dialogue);
  if (breakBalance.removed || breakBalance.added)
    stageWarnings.push(`台词换行已按官方两行比例调整（合并 ${breakBalance.removed} 条，拆分 ${breakBalance.added} 条）`);

  onProgress("storyboard", 0.48, "AI 设计分镜");
  let answer = await ask(buildStoryboardMessages({ plan, dialogue, catalog, request, config }), "storyboard")
    .catch((e) => failed("分镜生成", e));
  let storyboard = extractJson(answer.content);
  let merged = mergeStagedScript({ plan, dialogue, storyboard, catalog, request, config });
  let doc = normalize(merged.doc, { catalog, request, config });
  let mergeWarnings = merged.warnings;

  const site = siteFor(catalog);
  const maxOnStage = maxOnStageOf(config);
  let lastProblems = [];
  const rounds = Math.max(0, config.llm.repairRounds ?? 2);
  for (let round = 0; round <= rounds; round++) {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    const parsed = parseScript(doc);
    let problems = parsed.errors;
    let warnings = [];
    if (!problems.length) {
      const checked = checkScript(parsed.script, site);
      problems = checked.errors;
      warnings = checked.warnings;
      // A staged storyboard must put every speaker on stage: an off-stage line has no portrait to animate. The checker
      // only warns (hand-written scripts may call from off stage), so the AI repair loop treats it as a problem. Too
      // many people on stage is the other staging problem: with maxOnStage 2 the third person has to wait outside.
      const extra = [
        ...warnings.filter((w) => w.code === "speakerOffStage"),
        ...onStageProblems(doc.beats, maxOnStage),
      ];
      if (!problems.length && extra.length) problems = extra;
      if (!problems.length) {
        const lines = linesOf(doc);
        if (lines < 2) {
          problems = [{ path: "/beats", code: "tooShort", message: `the script has only ${lines} line(s)` }];
        } else {
          logger.info?.(`script ok: ${lines} lines, ${plan.cast.length} cast, ${warnings.length} warning(s)`);
          return {
            script: parsed.script, doc, warnings: [...stageWarnings, ...mergeWarnings, ...warnings], raw: answer.content,
            usage: combineUsage(usages), plan, dialogue, stages,
          };
        }
      }
    }
    lastProblems = problems;
    const fixable = [...problems, ...warnings].filter((p) => Array.isArray(p.fix) && p.fix.length);
    if (fixable.length) {
      const fixed = applyFixes(doc, fixable);
      if (fixed.applied.length) {
        logger.info?.(`storyboard round ${round}: applied ${fixed.applied.length} automatic fix(es)`);
        doc = fixed.script;
        continue;
      }
    }
    if (round === rounds) break;
    onProgress("storyboard", 0.48 + (round + 1) * 0.12, `AI 修正分镜 (${round + 1}/${rounds})`);
    logger.warn?.(`storyboard has ${problems.length} problem(s); repair ${round + 1}/${rounds}: ` +
      problems.slice(0, 3).map((p) => `${p.path || "/"} ${p.code}`).join("; "));
    const repaired = await ask(buildStoryboardRepairMessages({ plan, dialogue, storyboard, problems, catalog, request,
      config }), "storyboard-repair").catch((e) => failed("修正分镜", e));
    const next = extractJson(repaired.content);
    if (!isObj(next)) throw new StoryWriterError("AI 修正结果不是 JSON 对象", { details: repaired.content.slice(0, 1000) });
    storyboard = next;
    answer = repaired;
    merged = mergeStagedScript({ plan, dialogue, storyboard, catalog, request, config });
    doc = normalize(merged.doc, { catalog, request, config });
    mergeWarnings = merged.warnings;
  }

  // ---- 分镜降级 ---------------------------------------------------------------------------------------------
  // 分镜经修复仍有错误时不再直接失败：台词稿逐字保留，退回“默认走位 + 无动作演出”的可用剧本，
  // 与选角/台词段的降级策略一致。合成结果仍要过一遍完整校验，过不了才报错。
  try {
    const bare = mergeStagedScript({ plan, dialogue, storyboard: { beats: [] }, catalog, request, config });
    const bareDoc = normalize(bare.doc, { catalog, request, config });
    const parsed = parseScript(bareDoc);
    let problems = parsed.errors;
    if (!problems.length) problems = checkScript(parsed.script, site).errors;
    if (!problems.length && !onStageProblems(bareDoc.beats, maxOnStage).length) {
      markStageFailed("分镜经修复仍有错误，已退回无动作演出");
      stageWarnings.push("分镜不可用，已退回默认走位与无动作演出");
      logger.warn?.("storyboard unusable after repairs; falling back to bare lines");
      return {
        script: parsed.script, doc: bareDoc, warnings: [...stageWarnings, ...bare.warnings], raw: answer.content,
        usage: combineUsage(usages), plan, dialogue, stages,
      };
    }
  } catch { /* the fallback failed too; report the storyboard problems below */ }

  throw new StoryWriterError("AI 分镜经过自动修复后仍有错误", { details: lastProblems, plan, dialogue });
};

export const generateScript = async (args) => {
  if (!args.llm.available) throw new StoryWriterError("LLM is not configured (llm.enabled and llm.model)");
  const maxLines = Number(args.request?.maxLines ?? args.config?.story?.maxLines ?? 120);
  if (!Number.isInteger(maxLines) || maxLines < 2) {
    throw new StoryWriterError("maxLines must be an integer of at least 2", {
      details: [{ path: "/maxLines", code: "range", message: "maxLines must be an integer of at least 2" }],
    });
  }
  const startedAt = Date.now();
  const out = args.config.llm?.pipeline === "single" ? await generateSingle(args) : await generateStaged(args);
  return { ...out, durationMs: Date.now() - startedAt };
};
