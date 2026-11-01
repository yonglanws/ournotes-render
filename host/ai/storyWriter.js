// AI story writer: prompt -> JSON -> parse/check -> apply known fixes -> ask the model to repair -> repeat.
// The writer only produces the script; TTS, compilation and rendering are separate stages.
import { applyFixes, checkScript, parseScript, SCRIPT_FORMAT } from "../../scripts/lib/story-author/script.js";
import { extractJson } from "./json.js";
import { buildPlanMessages, buildRepairMessages, buildStoryMessages } from "./prompt.js";
import {
  buildCastMessages, buildDialogueMessages, buildDialogueRepairMessages, buildStoryboardMessages,
  buildStoryboardRepairMessages, fallbackCastPlan, mergeStagedScript, normalizeCastPlan, normalizeDialogue,
  onStageProblems, spreadPositions,
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

const siteFor = (catalog) => ({
  base: { language: catalog.language, languages: catalog.languages, stages: catalog.stages, music: catalog.music },
  models: catalog.models.map((m) => m.id),
  actions: Object.fromEntries(catalog.models.filter((m) => m.actionsKnown !== false).map((m) => [m.id, {
    motions: m.motions, expressions: m.expressions, defaultMotion: m.defaultMotion, defaultExpression: m.defaultExpression,
  }])),
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
  const maxOnStage = Math.max(2, Math.min(3, Math.round(Number(config.story?.maxOnStage ?? 3) || 3)));
  // Optional first pass: a short director's plan. It improves shot flow and acting; a failure only loses the notes.
  let plan = null;
  if (config.llm.directorPlan === true) {
    onProgress("planning", 0, "AI 设计分镜");
    try {
      const answer = await llm.json(buildPlanMessages({ catalog, request, config }), { signal, label: "plan" });
      plan = extractJson(answer.content);
      if (!plan) logger.warn?.("the director plan was not JSON; writing the script without it");
    } catch (e) {
      if (signal?.aborted) throw signal.reason || e;
      logger.warn?.(`the director plan failed (${e.message}); writing the script without it`);
    }
  }
  const messages = buildStoryMessages({ catalog, request, config, plan });
  onProgress("writing", 0, "AI 编写剧本");
  let answer;
  try {
    answer = await llm.json(messages, { signal, label: "story" });
  } catch (e) {
    if (signal?.aborted) throw signal.reason || e;
    throw new StoryWriterError(`AI 剧本生成失败：${e.message}`, { cause: e });
  }
  let doc = normalize(extractJson(answer.content), { catalog, request, config });
  if (!isObj(doc)) {
    throw new StoryWriterError("AI 没有返回 JSON 对象", { details: answer.content.slice(0, 1000) });
  }
  doc = trimLines(doc, Number(request.maxLines ?? config.story.maxLines ?? 120), logger);
  spreadPositions(doc.beats, maxOnStage);

  const site = siteFor(catalog);
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
    if (round === rounds) break;
    onProgress("writing", (round + 1) / (rounds + 1), `AI 修正剧本 (${round + 1}/${rounds})`);
    let repaired;
    try {
      repaired = await llm.json(buildRepairMessages({ previous: doc, problems, catalog, request, config, plan }),
                                { signal, label: "repair" });
    } catch (e) {
      if (signal?.aborted) throw signal.reason || e;
      throw new StoryWriterError(`AI 修正剧本失败：${e.message}`, { cause: e });
    }
    const next = normalize(extractJson(repaired.content), { catalog, request, config });
    if (!isObj(next)) throw new StoryWriterError("AI 修正结果不是 JSON 对象", { details: repaired.content.slice(0, 1000) });
    doc = trimLines(next, Number(request.maxLines ?? config.story.maxLines ?? 120), logger);
    spreadPositions(doc.beats, maxOnStage);
  }
  throw new StoryWriterError("AI 剧本经过自动修复后仍有错误", { details: lastProblems });
};

// Three calls instead of one: cast -> dialogue (full persona prompts, selected cast only) -> storyboard. The repair
// loop only asks for a new storyboard: the finished dialogue is restored verbatim after every merge.
const generateStaged = async ({ llm, catalog, request, config, logger, signal, onProgress = () => {} }) => {
  const usages = [];
  const ask = async (messages, label) => {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    const answer = await llm.json(messages, { signal, label });
    if (answer.usage) usages.push({ stage: label, ...answer.usage });
    return answer;
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
    if (!plan) logger.warn?.("选角结果里没有已知模型；改用站点角色顺序");
  } catch (e) {
    if (signal?.aborted) throw signal.reason || e;
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
    logger.warn?.("the dialogue pass returned no usable lines; retrying once");
    onProgress("dialogue", 0.34, "AI 修正台词稿");
    const retry = await ask(buildDialogueRepairMessages({ plan, catalog, request, config, previous: dialogueRaw }),
                            "dialogue-repair").catch((e) => failed("修正台词稿", e));
    dialogue = normalizeDialogue({ raw: extractJson(retry.content), plan, request, config });
  }
  if (!dialogue) {
    throw new StoryWriterError("AI 没有返回可用的台词稿", { details: String(dialogueAnswer.content).slice(0, 1000) });
  }
  if (!request.title && dialogue.title) plan.title = dialogue.title;
  logger.info?.(`staged: ${plan.cast.length} cast, ${dialogue.lines.length} dialogue lines`);

  onProgress("storyboard", 0.48, "AI 设计分镜");
  let answer = await ask(buildStoryboardMessages({ plan, dialogue, catalog, request, config }), "storyboard")
    .catch((e) => failed("分镜生成", e));
  let storyboard = extractJson(answer.content);
  let merged = mergeStagedScript({ plan, dialogue, storyboard, catalog, request, config });
  let doc = normalize(merged.doc, { catalog, request, config });
  let mergeWarnings = merged.warnings;

  const site = siteFor(catalog);
  const maxOnStage = Math.max(2, Math.min(3, Math.round(Number(config.story?.maxOnStage ?? 3) || 3)));
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
            script: parsed.script, doc, warnings: [...mergeWarnings, ...warnings], raw: answer.content,
            usage: combineUsage(usages), plan, dialogue,
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
  throw new StoryWriterError("AI 分镜经过自动修复后仍有错误", { details: lastProblems, plan, dialogue });
};

export const generateScript = async (args) => {
  if (!args.llm.available) throw new StoryWriterError("LLM is not configured (llm.enabled and llm.model)");
  return args.config.llm?.pipeline === "single" ? generateSingle(args) : generateStaged(args);
};
