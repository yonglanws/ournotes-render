// Staged story writing for long character prompts: pass 1 picks a small cast and a micro-event, pass 2 writes only the
// dialogue with the full persona prompts of the chosen cast, pass 3 directs that finished dialogue (stage, blocking,
// camera, motion, expression, gaze, listener reactions, BGM). The dialogue is final after pass 2: pass 3 references
// line ids and mergeStagedScript restores the exact text, so a direction pass can never silently rewrite a line.
import { motionStems, nearest } from "../../scripts/lib/story-author/script.js";
import { budgetCount, dialogueBudgetFor, directionBudgetFor, OFFICIAL_TARGETS } from "./official-targets.js";
import { dialoguePersonaPrompt } from "./personas.js";
import { MAX_PROMPT_MODELS, expressionListFor, motionListFor, officialDenominatorNote, personaEntryFor, stagingRules, voiceStyleFor } from "./prompt.js";

const MAX_CAST = 3;

const pct = (value) => Math.round(value * 100);
const pct1 = (value) => (Math.round(value * 1000) / 10).toFixed(1);
const fixed = (value, digits = 2) => Number(value).toFixed(digits);
// Formats a checked per-text-line rate as a per-episode count.
const perEpisode = (rate) =>
  (rate * OFFICIAL_TARGETS.textLinesPerEpisodeMean).toFixed(1);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const s = (v) => String(v ?? "").trim();
const lower = (s) => String(s || "").trim().toLowerCase();
// The cast list shows "name（group）" to help the model choose across bands; models often copy the whole label as
// the display name, which then shows in the talk window. Strip a trailing group suffix equal to the model's group.
const cleanCastName = (name, group) => {
  const out = s(name);
  if (!out || !group) return out;
  for (const [open, close] of [["（", "）"], ["(", ")"]]) {
    const suffix = `${open}${group}${close}`;
    if (out.endsWith(suffix)) return out.slice(0, -suffix.length).trim();
  }
  return out;
};

const unwrap = (doc) => {
  if (!isObj(doc)) return doc;
  for (const k of ["plan", "cast_plan", "dialogue", "storyboard", "script", "story", "data", "result"]) {
    if (isObj(doc[k]) && (Array.isArray(doc[k].cast) || Array.isArray(doc[k].lines) || Array.isArray(doc[k].beats))) {
      return doc[k];
    }
  }
  return doc;
};

const minutes = (request, config) => Number(request.targetMinutes ?? config.story?.targetMinutes ?? 3);

// The shared official line budget; maxLines is a strict configured cap.
const lineBudgetFor = (request, config) => {
  const maxLines = Number(request.maxLines ?? config.story?.maxLines ?? 120);
  const budget = dialogueBudgetFor(minutes(request, config));
  return Math.min(maxLines, Math.max(1, budget.lines, budget.minLines));
};

// One model per character (the site lists each costume separately), and only models whose motions are loaded: a cast
// pass cannot pick a model the storyboard has no action names for.
const castableModels = (catalog) => {
  const out = [];
  for (const m of catalog.models || []) {
    if (m.actionsKnown === false) continue;
    const key = m.character || m.name;
    if (out.some((x) => (x.character || x.name) === key)) continue;
    out.push(m);
    if (out.length >= MAX_PROMPT_MODELS) break;
  }
  return out;
};

export const modelIndex = (catalog) => {
  const byId = new Map((catalog.models || []).map((m) => [m.id, m]));
  const byText = new Map();
  for (const m of catalog.models || []) {
    for (const k of [m.name, m.character, m.id]) if (k && !byText.has(lower(k))) byText.set(lower(k), m);
  }
  return { byId, byText };
};

export const resolveModel = (index, text) => index.byId.get(s(text)) || index.byText.get(lower(text)) || null;

const sanitizeId = (v) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(s(v)) ? s(v) : "");

// `adv_live2d_anon_002_live_01` -> `anon`; other sites fall back to the character field, then c1/c2…
const castIdFor = (model, used) => {
  const candidates = [];
  const m = /^adv_live2d_([a-z0-9]+?)_\d+_live_/i.exec(s(model.id));
  if (m) candidates.push(m[1].toLowerCase());
  const character = s(model.character).toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (/^[a-z][a-z0-9_]*$/.test(character)) candidates.push(character);
  let n = used.size + 1;
  candidates.push(`c${n}`);
  for (const c of candidates) if (!used.has(c)) return c;
  while (used.has(`c${n}`)) n++;
  return `c${n}`;
};

const byName = (plan) => {
  const out = new Map();
  for (const c of plan.cast) {
    out.set(lower(c.name), c.id);
    out.set(lower(c.model), c.id);
  }
  return out;
};

const cleanText = (v) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

const firstOf = (list, preferred = []) => {
  const names = [...new Set(list || [])];
  for (const p of preferred) if (names.includes(p)) return p;
  return names[0] || "";
};

const motionChoices = (model) => {
  const motions = motionStems(model?.motions || []);
  const expressions = model?.expressions || [];
  return {
    motions,
    expressions,
    a: firstOf(motions, ["mtn_smile01", "mtn_smile02", "mtn_nod01", "mtn_idle01"]),
    b: firstOf(motions, ["mtn_nod01", "mtn_smile01", "mtn_thinking01", "mtn_idle01"]),
    smile: firstOf(expressions, ["exp_smile01", "exp_smile02", "exp_idle01"]),
    idle: firstOf(expressions, ["exp_idle01", "exp_idle02", "exp_idle03"]),
  };
};

const castBlock = (plan) => plan.cast
  .map((c) => `- ${c.id}（${c.name}${c.group ? ` / ${c.group}` : ""}）${c.role ? ` — ${c.role}` : ""}`)
  .join("\n") || "(none)";

// ---------------------------------------------------------------------------
// Pass 1: cast and micro-event
// ---------------------------------------------------------------------------

export const buildCastMessages = ({ catalog, request, config }) => {
  const language = request.language || catalog.language;
  const budget = lineBudgetFor(request, config);
  const maxOnStage = Math.max(2, Math.min(3, Math.round(Number(config.story?.maxOnStage ?? 3) || 3)));
  const models = castableModels(catalog);
  const modelLines = models
    .map((m) => {
      const p = personaEntryFor(config.story?.personas, m);
      const group = p?.group || m.group || "";
      const summary = p?.summary || "";
      return `- ${m.id} — ${m.name}${group ? `（${group}）` : ""}${summary ? `：${summary}` : ""}`;
    })
    .join("\n") || "(none)";
  const stages = catalog.stages.slice(0, 40)
    .map((st) => `- ${st.id}${st.caption ? ` — ${st.caption}` : ""}`).join("\n") || "(none)";
  const fixed = config.story?.cast?.length
    ? "\n本单只允许从清单里的角色选（配置的 story.cast 已限定可用角色）。" : "";

  return [
    {
      role: "system",
      content: [
        "你是《BanG Dream! Our Notes》的编剧兼选角。",
        "这是多轮写作的第一轮：只选角色、设计一个很小的具体事件，并给出剧情大纲。",
        "不要写台词，不要写镜头、动作、表情或 BGM。只输出一个 JSON 对象。",
      ].join("\n"),
    },
    {
      role: "user",
      content: `## 任务
${request.prompt || "写一段安静的日常对话。"}

- 语言：${language}
- 目标时长：约 ${minutes(request, config)} 分钟，约 ${budget} 句台词（按官方有文本 Talk 行计；单集常见 ${OFFICIAL_TARGETS.textLinesPerEpisodeMin}~${OFFICIAL_TARGETS.textLinesPerEpisodeMax} 条，本场按时长换算）
- 底本：${catalog.manifest}

## 可选角色（model id — 显示名）
${modelLines}
${fixed}
## 可选场景
${stages}

## 要求
- 选 ${maxOnStage === 2 ? "2 名" : "2~3 名"}角色（用户明确要求独白时才可以 1 人）。同一角色的不同服装只能选一个模型。${maxOnStage === 2 ? "同台最多 2 人，所以不要选第三个人。" : "同台最多 3 人；三人同台时用 far-left / center / far-right，群像 focus 5、track 0。"}
- 两位角色的说话量要有反差：至少一位话多、愿意解释或吐槽，另一位可以寡言；不要两位都只会 2~5 字的短句。
- 选的角色要能自然演完一个日常小事件：拍照、找东西、等人、收拾器材、分零食、试新曲、发消息之类。
- 给每个角色一个本场功能（谁发起、谁回应、谁吐槽/拆台、谁收尾），第三轮分镜会按这个安排反应。
- 只用一个舞台就能演完；不要比赛结果、生离死别、世界观解说。
- 大纲 4~6 条，每条一句话，写“发生什么”，不要写镜头，也不要写台词。
- title 是短标题（不超过 12 个字），logline 一句话，event 是这一场的小事件。

## 输出 JSON
{
  "title": "短标题",
  "logline": "一句话概括",
  "event": "这一场的小事件",
  "setting": { "stage": "舞台 id", "location": "地点字幕", "music": "可选 BGM cue" },
  "cast": [
    { "id": "anon", "model": "模型 id", "name": "显示名", "role": "本场功能" }
  ],
  "outline": ["开场……", "闲聊……", "发现/请求……", "情绪转一次……", "收尾……"]
}

只输出 JSON 对象本身，不要 markdown 或解释。`,
    },
  ];
};

// Accept a plan only when at least one known model came back; the caller falls back to the site's own cast otherwise.
export const normalizeCastPlan = (raw, { catalog, request, config }) => {
  if (!isObj(raw)) return null;
  const doc = unwrap(raw);
  if (!isObj(doc)) return null;
  const allowed = new Set(castableModels(catalog).map((m) => m.id));
  const index = modelIndex(catalog);
  const entries = Array.isArray(doc.cast) ? doc.cast
    : isObj(doc.cast) ? Object.entries(doc.cast).map(([id, v]) => (typeof v === "string" ? { id, model: v } : { id, ...v }))
      : [];
  const used = new Set();
  const cast = [];
  const limit = Math.max(2, Math.min(MAX_CAST, Math.round(Number(config.story?.maxOnStage ?? 3) || 3)));
  for (const e of entries) {
    if (cast.length >= limit) break;
    if (!isObj(e) && typeof e !== "string") continue;
    const c = typeof e === "string" ? { model: e } : e;
    const model = resolveModel(index, c.model || c.id || c.name);
    if (!model || !allowed.has(model.id)) continue;
    if (cast.some((x) => x.model === model.id)) continue;
    let id = sanitizeId(c.id || c.castId);
    if (!id || used.has(id)) id = castIdFor(model, used);
    used.add(id);
    const group = personaEntryFor(config.story?.personas, model)?.group || model.group || "";
    cast.push({
      id,
      model: model.id,
      name: cleanCastName(c.name, group) || model.name || model.id,
      group,
      role: s(c.role).slice(0, 80),
    });
  }
  if (!cast.length) return null;

  const stageIds = new Set(catalog.stages.map((x) => x.id));
  const musicCues = new Set(catalog.music.map((x) => x.cue));
  const setting = isObj(doc.setting) ? doc.setting : {};
  const outline = Array.isArray(doc.outline)
    ? doc.outline.map((x) => s(x).slice(0, 200)).filter(Boolean).slice(0, 8) : [];
  return {
    title: (s(doc.title) || s(request.title) || s(config.story?.title) || "").slice(0, 64),
    logline: s(doc.logline).slice(0, 300),
    event: s(doc.event || doc.logline).slice(0, 300),
    setting: {
      stage: stageIds.has(s(setting.stage)) ? s(setting.stage) : "",
      location: s(setting.location).slice(0, 40),
      music: musicCues.has(s(setting.music)) ? s(setting.music) : "",
    },
    cast,
    outline,
  };
};

// The site's own cast order (base cast first), two people for a daily scene. Used when pass 1 fails.
export const fallbackCastPlan = ({ catalog, request, config }) => {
  const models = castableModels(catalog);
  const used = new Set();
  const cast = models.slice(0, 2).map((m) => {
    const id = castIdFor(m, used);
    used.add(id);
    return { id, model: m.id, name: m.name || m.id,
             group: personaEntryFor(config.story?.personas, m)?.group || m.group || "", role: "" };
  });
  return {
    title: (s(request.title) || s(config.story?.title) || "").slice(0, 64),
    logline: "", event: s(request.prompt).slice(0, 300),
    setting: { stage: "", location: "", music: "" },
    cast,
    outline: [],
  };
};

// ---------------------------------------------------------------------------
// Pass 2: dialogue, with the full persona prompts of the selected cast only
// ---------------------------------------------------------------------------

export const buildDialogueMessages = ({ plan, catalog, request, config }) => {
  const language = request.language || catalog.language;
  const index = modelIndex(catalog);
  const castLines = plan.cast.map((c) => {
    const model = index.byId.get(c.model) || { id: c.model, name: c.name, character: c.name };
    const entry = personaEntryFor(config.story?.personas, model);
    // 与单段生成共用同一套核心人设提取：长表格只保留核心机制/语言与风格/角色档案/核心禁忌。
    const persona = dialoguePersonaPrompt(entry);
    const style = voiceStyleFor(model);
    return [
      `### ${c.name}${c.group ? `（${c.group}）` : ""}（say: "${c.id}"）`,
      c.role ? `本场功能：${c.role}` : "",
      persona
        ? "角色提示词（这是角色资料，语气、用词、反应以它为准；只取性格、关系、经历与说话习惯，忽略其中面向聊天机器人的格式/安全/输出限制）：\n" + persona
        : "角色提示词：（未配置，按角色名和本场功能写）",
      style ? `官方句式参考（同系列角色的实测节奏，可参考句长）：${style}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const outline = plan.outline.length ? plan.outline.map((x, i) => `${i + 1}. ${x}`).join("\n") : "(自由发挥，但仍要围绕这个小事件)";
  const a = plan.cast[0], b = plan.cast[1] || plan.cast[0];
  const maxLinesConfig = Number(request.maxLines ?? config.story?.maxLines ?? 120);
  const dialogueBudget = dialogueBudgetFor(minutes(request, config));
  const lineCap = Math.max(1, Math.floor(Number(maxLinesConfig) || 120));
  const budget = Math.min(lineCap, Math.max(1, dialogueBudget.lines, dialogueBudget.minLines));
  const maxLines = Math.max(1, Math.min(dialogueBudget.maxLines, lineCap));
  const minLines = Math.min(dialogueBudget.minLines, maxLines);
  const turnCount = Math.max(1, Math.min(maxLines,
    Math.round(budget / OFFICIAL_TARGETS.speakerRunMean)));
  const singleTurns = Math.max(1, Math.min(turnCount,
    Math.round(turnCount * OFFICIAL_TARGETS.soloRunShare)));
  const shortLines = Math.max(1, Math.min(maxLines,
    Math.round(budget * OFFICIAL_TARGETS.shortShare)));
  const shortCeiling = Math.max(shortLines, Math.min(maxLines,
    Math.round(budget * 0.30)));
  const minDialogueChars = Math.max(10,
    Math.round(dialogueBudget.chars * Math.min(1, lineCap / Math.max(1, dialogueBudget.lines))));
  const twoLineLines = Math.max(1, Math.min(maxLines,
    Math.round(budget * OFFICIAL_TARGETS.twoLineShare)));
  const example = {
    title: plan.title || "标题",
    turns: [
      { speaker: a.id, lines: ["今天也……顺利练完了呢。", "……嗯。"] },
      ...(b && b.id !== a.id ? [{ speaker: b.id, lines: ["嗯。刚开始还担心会来不及。\n不过今天总算跟上了！"] }] : []),
      { speaker: a.id, lines: ["你也会……担心吗？"] },
      ...(b && b.id !== a.id ? [{ speaker: b.id, lines: ["……会啊。", "毕竟是你的事嘛。"] }] : []),
      { speaker: a.id, lines: ["那……下次一起练到最后一班车吧。"] },
      { narrate: "（雨声轻了下来。）" },
    ],
  };

  return [
    {
      role: "system",
      content: [
        "你是《BanG Dream! Our Notes》的编剧。",
        "这是多轮写作的第二轮：只写台词稿——谁在第几句说什么。",
        "不要写动作、表情、镜头、舞台、BGM 或旁白式描写；这些由第三轮分镜决定。",
        "台词稿会被逐字使用，分镜不会改一个字，所以这一轮只把“话”写对。只输出一个 JSON 对象。",
        config.llm?.systemPrompt || "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: `## 这一场
小事件：${plan.event || request.prompt || "一段安静的日常对话。"}
${plan.logline ? `一句话：${plan.logline}` : ""}
${plan.setting?.location ? `地点：${plan.setting.location}` : ""}
出场角色：
${castBlock(plan)}

## 大纲（参考，不必逐条对应）
${outline}

## 角色（请完整阅读每个人的提示词）
${castLines}

## 台词要求（按 ${budget} 句的场次计算）
- 语言：${language}；总共 ${minLines}~${maxLines} 句（目标约 ${budget} 句）；少于 ${minLines} 句或超过 ${maxLines} 句都视为不合格。
- 总字数至少 ${minDialogueChars} 字（约每句 ${fixed(OFFICIAL_TARGETS.lineCharsMean, 1)} 字）；低于这个总字数同样视为不合格，不要用大量 2~5 字短句凑句数。
- 用 turns 组织：一个角色的一次发言 = 一个 turn，turn 里放 1~4 条 lines。
  整场约 ${turnCount} 个 turns；约 ${pct(OFFICIAL_TARGETS.soloRunShare)}% 单句 turn、均值 ${fixed(OFFICIAL_TARGETS.speakerRunMean, 1)} 句；短反应约 ${pct(OFFICIAL_TARGETS.shortShare)}%；整条台词均值 ${fixed(OFFICIAL_TARGETS.lineCharsMean, 1)} 字、p90 ${OFFICIAL_TARGETS.lineCharsP90} 字；换行片段均值 ${fixed(OFFICIAL_TARGETS.segmentCharsMean, 1)} 字。
  约 ${singleTurns} 个单句 turn；约 1/4 的 turn 放 2 条；其余放 3~4 条，只在情绪最重或解释来龙去脉时用 4 条。
  单句负责节奏，长段负责情绪；不要每个 turn 都写 2 条，也不要机械一人一句。
- 句长：整条台词常见 1~${OFFICIAL_TARGETS.lineCharsP90} 字（均值 ${fixed(OFFICIAL_TARGETS.lineCharsMean, 1)} 字、p90 ${OFFICIAL_TARGETS.lineCharsP90} 字），显式换行片段常见 7~17 字（均值 ${fixed(OFFICIAL_TARGETS.segmentCharsMean, 1)} 字）；单行最多 22 个全角字符；
  约 ${pct(OFFICIAL_TARGETS.twoLineShare)}% 两行（约 ${twoLineLines} 句），**大多数 line 是单行（约 ${100 - pct(OFFICIAL_TARGETS.twoLineShare)}%），不要给每句都加换行**；三行以上不足 1%；约 ${shortLines} 句是 2~6 字的短反应
  （「…………」「……嗯。」「真的？」「诶？」），但**不要超过 ${shortCeiling} 句**；其余句子要有完整的语气和停顿，不要所有台词都 10~15 字。
- 每个角色要有自己的句长和语气，严格按角色提示词；不要所有人都用同一种 12~15 字的书面句。
- 一条 line 通常只放一句话；换行只放在标点之后，不要在词中间断开。
- 只写说出口的话。不要括号动作（例如「（笑）」）、不要「她转过头」这类叙述；唯一的例外是 narrate。
- narrate 全场 0~2 条，用「（……）」这种短句，放在开场、沉默反应或收尾；不要用旁白推进剧情。
- 允许重复对方的话、停顿、欲言又止；不要每句都完整主谓宾。
- 结尾用一句短话、一个没说完的句子或一句日常收束，不要总结主题，不要写“未完待续”。
- 台词里不要提镜头、分镜、BGM 或“场景”。

## 写完后自检（不要输出自检过程）
- 把 turns 里每条 lines 数一遍：总句数是否在 ${minLines}~${maxLines} 句？
- 是否有约 ${singleTurns} 个单句 turn、约 1/4 的两条 turn、其余 3~4 条？
- 是否有至少 ${shortLines} 句 2~6 字？是否约 ${pct(OFFICIAL_TARGETS.twoLineShare)}% 两行？
- 是否只有清单里的角色，且没有括号动作和镜头词？

## 输出 JSON
示例（只演示 turns 结构，台词请按上面的要求重写）：
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`,
    },
  ];
};

// The line ids are assigned here (l1, l2, …) so the storyboard pass cannot drift from the dialogue it directs.
export const normalizeDialogue = ({ raw, plan, request, config }) => {
  if (!isObj(raw)) return null;
  const doc = unwrap(raw);
  if (!isObj(doc)) return null;
  const ids = new Set(plan.cast.map((c) => c.id));
  const names = byName(plan);
  const lines = [];
  const pushSay = (say, text) => {
    if (!ids.has(say)) say = names.get(lower(say)) || "";
    if (!say) return;
    const clean = cleanText(text);
    if (clean) lines.push({ id: `l${lines.length + 1}`, say, text: clean });
  };

  // 首选 turns：一个角色的一次发言 = 一个 turn，内部 1~6 条 lines。
  // 这种结构能自然产生官方那种「同一个人连说 2~3 句」，比扁平 lines 更稳。
  const turns = Array.isArray(doc.turns) ? doc.turns : [];
  for (const turn of turns) {
    if (!isObj(turn)) continue;
    if (typeof turn.narrate === "string" && turn.narrate.trim() && !turn.speaker && !turn.say) {
      const text = cleanText(turn.narrate);
      if (text) lines.push({ id: `l${lines.length + 1}`, narrate: text });
      continue;
    }
    const say = s(turn.speaker ?? turn.say ?? turn.cast ?? turn.name);
    const rawLines = Array.isArray(turn.lines) ? turn.lines : [];
    for (const item of rawLines) {
      pushSay(say, isObj(item) ? (item.text ?? item.line ?? item.content) : item);
    }
  }

  if (lines.length === 0) {
    const body = Array.isArray(doc.lines) ? doc.lines
      : Array.isArray(doc.dialogue) ? doc.dialogue
        : Array.isArray(doc.beats) ? doc.beats.filter((b) => isObj(b) && (b.say || b.narrate))
          : [];
    for (const item of body) {
      if (!isObj(item)) continue;
      if (typeof item.narrate === "string" && item.narrate.trim() && !item.say) {
        const text = cleanText(item.narrate);
        if (text) lines.push({ id: `l${lines.length + 1}`, narrate: text });
        continue;
      }
      pushSay(s(item.say || item.cast || item.speaker), item.text ?? item.line ?? item.content);
    }
  }
  const maxLines = Number(request.maxLines ?? config.story?.maxLines ?? 120);
  if (!Number.isInteger(maxLines) || maxLines < 2) {
    throw new RangeError("maxLines must be an integer of at least 2");
  }
  if (lines.length > maxLines) lines.length = maxLines;
  if (lines.length < 2) return null;
  return { title: (s(doc.title) || plan.title || "").slice(0, 64), lines };
};

// 台词总字数（不含空白）：长度闸用「句数 + 总字数」两个下限，只看句数会被大量 2~4 字短句骗过。
export const countDialogueChars = (dialogue) =>
  (dialogue?.lines || []).reduce((sum, line) => {
    const text = String(line?.text ?? line?.narrate ?? "").replace(/\s/g, "");
    return sum + [...text].length;
  }, 0);

// The dialogue pass either puts a newline in almost every line or in none while chasing the segment-length target.
// Two rendered lines are ~38% of official text lines, so join the shortest excess lines and, when the share is too
// low, add a break at an existing punctuation mark with both segments near the official segment mean. The words and
// punctuation are untouched; only the explicit line break moves (and no segment may exceed the 22-character rule).
const BREAK_PUNCTUATION = /[，。！？!?…；;、,]/g;
export const balanceLineBreaks = (dialogue, { maxLineChars = 22 } = {}) => {
  if (!dialogue || !Array.isArray(dialogue.lines))
    return { dialogue, removed: 0, added: 0, total: 0, rawTwoLine: 0, rawTwoLineShare: 0, changedShare: 0 };
  const total = dialogue.lines.length;
  const target = Math.round(total * OFFICIAL_TARGETS.twoLineShare);
  const twoLine = dialogue.lines.filter((line) => typeof line.text === "string" && line.text.includes("\n"));
  const rawTwoLine = twoLine.length;
  const visible = (text) => [...String(text).replace(/\s/g, "")].length;
  let removed = 0;
  for (const line of [...twoLine].sort((a, b) => visible(a.text) - visible(b.text))) {
    if (twoLine.length - removed <= target) break;
    const joined = line.text.replace(/\n/g, "");
    if (visible(joined) > maxLineChars) continue;
    line.text = joined;
    removed++;
  }
  // Split the lines whose punctuation gives two balanced segments, closest to the official 11.1-character mean.
  const splitPoint = (text) => {
    let best = null;
    for (const match of text.matchAll(BREAK_PUNCTUATION)) {
      const index = match.index + match[0].length;
      const left = text.slice(0, index), right = text.slice(index).trimStart();
      if (!left || !right || /^[…‥]/.test(right)) continue;
      const leftChars = visible(left), rightChars = visible(right);
      if (leftChars < 3 || rightChars < 3 || leftChars > maxLineChars || rightChars > maxLineChars) continue;
      const score = Math.abs(leftChars - OFFICIAL_TARGETS.segmentCharsMean) +
        Math.abs(rightChars - OFFICIAL_TARGETS.segmentCharsMean);
      if (!best || score < best.score) best = { index, score };
    }
    return best;
  };
  let added = 0;
  const remaining = target - (twoLine.length - removed);
  if (remaining > 0) {
    const candidates = dialogue.lines
      .filter((line) => typeof line.text === "string" && !line.text.includes("\n"))
      .map((line) => ({ line, at: splitPoint(line.text) }))
      .filter((item) => item.at)
      .sort((a, b) => a.at.score - b.at.score);
    for (const { line, at } of candidates) {
      if (added >= remaining) break;
      line.text = `${line.text.slice(0, at.index)}\n${line.text.slice(at.index).trimStart()}`;
      added++;
    }
  }
  return {
    dialogue, removed, added, total, rawTwoLine,
    rawTwoLineShare: total ? rawTwoLine / total : 0,
    changedShare: total ? (removed + added) / total : 0,
  };
};

// 台词太短（模型偶尔只写十几句）会让整场明显短于目标时长；这是针对性的补写提示词，
// 保留原事件与人物关系，只把对话的来回、停顿和情绪铺垫补足。
export const buildDialogueLengthPrompt = ({ plan, catalog, request, config, previous, actualLines, requiredLines, requiredChars = 0 }) => {
  const base = buildDialogueMessages({ plan, catalog, request, config });
  const raw = typeof previous === "string" ? previous : JSON.stringify(previous);
  const lineCap = Math.max(1, Math.floor(Number(request.maxLines ?? config.story?.maxLines ?? 120) || 120));
  const upper = Math.max(requiredLines, Math.min(lineCap, Math.round(requiredLines * 1.15)));
  const actualChars = countDialogueChars(
    typeof previous === "string" ? (() => { try { return JSON.parse(previous); } catch { return null; } })() : previous,
  );
  const charRule = requiredChars
    ? `- 总字数至少 ${requiredChars} 字（上一轮约 ${actualChars} 字），平均每句约 ${fixed(OFFICIAL_TARGETS.lineCharsMean, 1)} 字；`
    : "";
  const actualMean = actualLines > 0 ? (actualChars / actualLines).toFixed(1) : "0";
  const longRule = requiredChars
    ? `- 上一轮平均每句只有 ${actualMean} 字；这一轮不要用大量 2~4 字短句凑句数，把对话的来回写满；也不要靠给每句加换行来凑长度。`
    : "";
  return [
    base[0],
    {
      role: "user",
      content: `${base[1].content}\n\n## 上一轮的问题
上一轮只写了 ${actualLines} 句台词${requiredChars ? `、约 ${actualChars} 字` : ""}，
少于要求的 ${requiredLines} 句${requiredChars ? ` / ${requiredChars} 字` : ""}。请保留原来的小事件和人物关系，
重写一份完整台词稿：
- 总句数 ${requiredLines}~${upper} 句，仍然用 turns 结构，每个 turn 1~4 条 lines；
${charRule}
${longRule}
- 不要靠重复台词凑数；补足对话的来回、停顿、短反应和情绪铺垫；
- 只用出场角色，不要旁白和动作描写。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

只输出 JSON 对象本身，不要 markdown 或解释。`,
    },
  ];
};

// A dialogue answer can be well-formed JSON with no usable lines (wrong keys, speakers outside the cast, one line).
// One focused retry is cheaper than failing the job, and it cannot touch the cast or the storyboard.
export const buildDialogueRepairMessages = ({ plan, catalog, request, config, previous }) => {
  const base = buildDialogueMessages({ plan, catalog, request, config });
  return [
    base[0],
    {
      role: "user",
      content: `${base[1].content}\n\n## 上一轮的问题\n` +
        "上一轮没有给出至少 2 条可用的台词：必须用 turns 数组，每个 turn 同时有 speaker（上面列出的 cast id）" +
        "和 lines（1~4 条台词字符串），narrate 只能单独成条。\n\n" +
        `## 上一轮输出\n${typeof previous === "string" ? previous : JSON.stringify(previous)}\n\n` +
        "请按上面的角色提示词和格式重写台词稿，输出完整的 JSON 对象。",
    },
  ];
};

// ---------------------------------------------------------------------------
// Pass 3: storyboard for a finished dialogue
// ---------------------------------------------------------------------------

const storyboardExample = ({ plan, dialogue, catalog }) => {
  const index = modelIndex(catalog);
  const firstSpeaker = dialogue.lines.find((l) => l.say)?.say;
  if (!firstSpeaker) return null;
  const listener = plan.cast.find((c) => c.id !== firstSpeaker);
  // Only the first two speakers appear: the snippet is a valid opening (one person at far-left, the second enters
  // at far-right), and the two of them do not overlap.
  const lines = dialogue.lines
    .filter((l) => l.say && (l.say === firstSpeaker || l.say === listener?.id))
    .slice(0, 3);
  if (!lines.length) return null;
  const stage = plan.setting?.stage || catalog.stages[0]?.id || "stage_id";
  const root = { scene: stage, camera: "middle", focus: "far-left", positions: { [firstSpeaker]: "far-left" } };
  if (plan.setting?.location) root.location = plan.setting.location;
  if (plan.setting?.music) root.music = plan.setting.music;
  const beats = [root];
  const placed = new Set([firstSpeaker]);

  lines.forEach((line, i) => {
    if (!placed.has(line.say) && placed.size < 2) {
      beats.push({ positions: { [firstSpeaker]: "far-left", [line.say]: "far-right" }, focus: 5, camera: "middle" });
      placed.add(line.say);
    }
    const cast = plan.cast.find((c) => c.id === line.say);
    const model = index.byId.get(cast?.model || "");
    const sound = motionChoices(model);
    const beat = { line: line.id };
    // the last line of the snippet is held without acting, to show that not every line moves
    if (i < lines.length - 1 && sound.a) beat.motion = i === 0 ? sound.a : sound.b;
    if (beat.motion && sound.smile) beat.expression = i === 0 ? sound.smile : sound.idle;
    if (line.say !== firstSpeaker) beat.lookAt = firstSpeaker;
    if (i === 1 && listener && placed.has(listener.id)) {
      const lmodel = index.byId.get(listener.model || "");
      const lsound = motionChoices(lmodel);
      if (lsound.idle) beat.actions = [{ at: 0, cast: listener.id, expression: lsound.idle }];
    }
    beats.push(beat);
  });
  return { beats };
};

export const buildStoryboardMessages = ({ plan, dialogue, catalog, request, config, planNotes = "" }) => {
  const index = modelIndex(catalog);
  const maxOnStage = Math.max(2, Math.min(3, Math.round(Number(config.story?.maxOnStage ?? 3) || 3)));
  const stageLines = catalog.stages.slice(0, 80)
    .map((x) => `- ${x.id}${x.caption ? ` — ${x.caption}` : ""}`).join("\n") || "(none)";
  const musicLines = catalog.music.slice(0, 40)
    .map((x) => `- ${x.cue}${x.label ? ` — ${x.label}` : ""}`).join("\n") || "(none)";
  const soundChoices = (catalog.sounds || []).slice(0, 40);
  const soundLines = soundChoices
    .map((x) => `- ${x.cue}${x.label ? ` — ${x.label}` : ""}`).join("\n") || "(none)";
  const exampleSe = soundChoices[0]?.cue || "";
  const modelLines = plan.cast.map((c) => {
    const m = index.byId.get(c.model);
    return [
      `- ${c.id}（${c.name}）model: ${c.model}`,
      `  motions: ${m ? motionListFor(m.motions) || "(none)" : "(unknown model)"}`,
      `  expressions: ${m ? expressionListFor(m.expressions) || "(none)" : "(unknown model)"}`,
      m?.defaultMotion ? `  default motion: ${m.defaultMotion}` : "",
      m?.defaultExpression ? `  default expression: ${m.defaultExpression}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n");
  const lineList = dialogue.lines.map((l) => {
    if (l.narrate) return `- ${l.id} [narrate] ${l.narrate.replace(/\n/g, " ⏎ ")}`;
    return `- ${l.id} [${l.say}] ${l.text.replace(/\n/g, " ⏎ ")}`;
  }).join("\n");
  const lines = dialogue.lines.length;
  const budget = directionBudgetFor(lines);
  const motionBudget = `${budget.motionMin}~${budget.motionMax}`;
  const noMotionTarget = Math.max(1, Math.round(lines * OFFICIAL_TARGETS.noMotionShare));
  const example = storyboardExample({ plan, dialogue, catalog });

  return [
    {
      role: "system",
      content: [
        "你是《BanG Dream! Our Notes》的 ADV 分镜演出家。",
        "台词稿已经定稿：你只决定舞台、站位、镜头焦点、远近、Track、动作、表情、视线、听者反应、BGM、黑场和留白。",
        "不要改写、增加或删除任何台词；只能通过 line id 引用它们。只输出一个 JSON 对象。",
        stagingRules(maxOnStage, budget),
        config.llm?.systemPrompt || "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: `## 这一场
小事件：${plan.event || request.prompt || "一段日常对话。"}
${plan.logline ? `一句话：${plan.logline}` : ""}
出场角色：
${castBlock(plan)}

## 官方节奏（30 部官方样本：8 部本地章节 + 22 部双人友情戏）
- 台词：整条台词常见 1~${OFFICIAL_TARGETS.lineCharsP90} 字（均值 ${fixed(OFFICIAL_TARGETS.lineCharsMean, 1)} 字、p90 ${OFFICIAL_TARGETS.lineCharsP90} 字），换行片段均值 ${fixed(OFFICIAL_TARGETS.segmentCharsMean, 1)} 字；约 ${pct(OFFICIAL_TARGETS.twoLineShare)}% 两行，三行以上不足 1%；2~6 字短反应约 ${pct(OFFICIAL_TARGETS.shortShare)}%。
- 镜头：Focus 约 ${fixed(OFFICIAL_TARGETS.focusPerTalkRow, 2)}/句（官方 Talk 行口径；生成脚本无空白 Talk 行，预算按 ${fixed(OFFICIAL_TARGETS.focusPerTextLine, 2)}/有文本行）；距离 2/3/4 分别约 ${pct(OFFICIAL_TARGETS.distance2Share)}%/${pct(OFFICIAL_TARGETS.distance3Share)}%/${pct(OFFICIAL_TARGETS.distance4Share)}%；近景段长 0~2 句（空镜按 1 段；末尾空白 Talk 会缩短段长）约占 ${pct1(OFFICIAL_TARGETS.closeRunOneOrTwoShare)}%。
- ${officialDenominatorNote()}
- 运镜：Pedestal 约 ${perEpisode(OFFICIAL_TARGETS.pedestalPerTextLine)} 次/集、PanV2 约 ${perEpisode(OFFICIAL_TARGETS.panV2PerTextLine)} 次/集、DoF 约 ${perEpisode(OFFICIAL_TARGETS.dofPerTextLine)} 次/集、Look + LookTarget 约 ${fixed(OFFICIAL_TARGETS.lookAnyPerTextLine, 2)}/句、Se 约 ${perEpisode(OFFICIAL_TARGETS.sePerTextLine)} 条/集。

## 台词稿（逐字定稿，按顺序）
${lineList}

## 可用舞台
${stageLines}

## 可用音乐
${musicLines}

## 可用音效（se 只能从这里选；没有合适的就省略）
${soundLines}

## 可用动作与表情（只能给对应的 cast）
${modelLines}

${planNotes ? `## 导演计划（参考）\n${planNotes}\n` : ""}
## 输出 JSON
{
  "beats": [
    { "scene": "舞台 id", "location": "地点", "music": "可选 BGM", "camera": "middle", "focus": "far-left",
      "positions": { "${plan.cast[0]?.id || "a"}": "far-left" } },
    { "line": "l1", "motion": "动作名", "expression": "表情名", "focus": "far-left", "camera": "middle" },
    { "positions": { "${plan.cast[0]?.id || "a"}": "far-left", "${plan.cast[1]?.id || "b"}": "far-right" }, "focus": 5 },
    { "line": "l2", "lookAt": "${plan.cast[0]?.id || "a"}", "focus": "${plan.cast[0]?.id || "a"}", "camera": "close",
      "zoom": 1.06, "zoomDuration": 4,
      "actions": [{ "at": 0, "cast": "${plan.cast[0]?.id || "a"}", "expression": "表情名" }] },
    { "line": "l3", "motion": "动作名", "expression": "表情名", "focus": 5, "camera": "middle", "track": 0.5,
      "focusDuration": ${OFFICIAL_TARGETS.focusDurationDefault}, "trackDuration": 2, "pedestal": -0.2, "pedestalDuration": 1.5,
      "pan": 12, "panDuration": 2.5, "panFocusSlide": 0.5, "dof": 0.4, "dofDuration": 1.5, "dofLayers": 2,
      "look": -0.4, "lookY": 0.1, "lookDuration": 0.5, ${exampleSe ? `"se": ${JSON.stringify(exampleSe)}, "seDuration": 2, "seDelay": 0.2, ` : ""}"motionFadeIn": ${OFFICIAL_TARGETS.motionFadeInDefault}, "motionWait": false },
    { "pause": 0.3 }
  ]
}

规则：
- 第一条 beat 必须是 scene；scene 的 positions 只放 1 人，其余角色 2~4 句后用 positions 进场。
- **每个 line id 必须出现且只出现一次，顺序与台词稿完全一致**；不要在 line beat 里写 say 或 text。
- 非 line beat 只有 scene / positions / camera / fade / pause / action，插在合适的台词之间；不要为每一句新开 scene，也不要反复 fade。
- line beat 只写演出字段：motion、expression、lookAt、focus、camera、track、zoom、zoomDuration、actions，以及可选的 focusDuration、trackDuration、pedestal、pedestalDuration、pan、panDuration、panFocusSlide、dof、dofDuration、dofLayers、look、lookY、lookDuration、se、seDuration、seDelay、seStop、motionFadeIn、motionWait。不写 focus/camera/track 就保持当前镜头。trackDuration 只在写了 track 时有效，focusDuration 只在写了 focus/camera 时有效。
- narrate 台词（[narrate]）没有说话者，不能写 motion、expression、lookAt、look、lookY、lookDuration、se、seDuration、seDelay、seStop、motionFadeIn、motionWait；只写 focus/camera/track/zoom/运镜字段和 actions（actions 必须带 cast）。
- 每个说话者开口前必须已经在台上；用 positions 让他进场。**两人同台必须 far-left / far-right**；${maxOnStage === 3 ? "三人同台用 far-left / center / far-right（camera far，focus 5，track 0）" : "同台最多 2 人，第 3 人必须等一人退场后再进场"}；不要用 center+right、center+left 或 left+right（会重叠）。
- **镜头预算**：全场约 ${budget.focusChanges} 个 focus（含 scene/positions 上的；官方 Focus 约 ${fixed(OFFICIAL_TARGETS.focusPerTalkRow, 2)}/句），其中 close 近景约 ${budget.closeUps} 次（距离 4 约占 ${pct1(OFFICIAL_TARGETS.distance4TextLineShare)}% 的有文本行），near 全景 0~1 次。close 停 1~2 句（偶尔 3 句），下一句用 middle + focus 5 回到二人/群像；不要连续两句 close，也不要停在同一个 close 上直到结尾。
  大部分 line beat 不要写 focus/camera/track，只有真的换机位时才写；同一机位保持 3~4 句，连续两句都写 focus 通常就是切太碎。推近（middle/far → close）是硬切，拉回（close → middle/far）会自动缓推，不需要写 duration。
- **换机位上限**：带 focus/camera/track 的 line beat 不超过 ${Math.max(0, budget.focusChanges - 2)} 句（scene/positions 的 Focus 另计）；多写的会在合并时删除。不要把每句都写成新机位。
- **慢推镜**：全场约 ${budget.zoomMin}~${budget.zoomMax} 次 zoom，写在情绪句/近景或结尾：推近 1.03~1.10，拉远 0.92~0.98，zoomDuration 3~5 秒。一个机位最多 1 次；不写就静止，不要每个镜头都推。
- **视线预算**：全场约 ${budget.lookAt} 个 lookAt；双人戏每 3~4 句最多 1 个，三人以上只在被点名或明显反应时写。lookAt 是台上的 cast id、位置名或 1~9 的构图点；不要每句都看着对方。${budgetCount(2, budget.lookAt)} 句写独立 look/lookY（"look": -0.4, "lookY": 0.1, "lookDuration": 0.5，与 lookAt 二选一），用来表现角色把视线移开。
- **表演预算**：全场至少 ${budget.motionMin} 个、目标 ${motionBudget} 个表演动作（Motion/Expression，官方约 ${fixed(OFFICIAL_TARGETS.motionsPerTextLine, 2)}/句）；低于 ${budget.motionMin} 个视为不合格。约 ${noMotionTarget} 句可以完全没有 Motion（参考上限 ${budget.maxStatic} 句；超出预算时优先修剪最短句）；约 ${pct1(OFFICIAL_TARGETS.twoMotionShare)}% 的有文本行有 2 个以上表演动作 (Motion + Expression + Look + LookTarget)；独立 Expression 默认 0（官方每集约 ${fixed(OFFICIAL_TARGETS.standaloneExpressionPerEpisode, 2)} 条），确有必要最多 1 条。表情尽量和 motion 一起写，默认 idle。
- **扩展运镜与声音（官方实测频率，不是可选装饰）**：写 ${budgetCount(2, budget.pedestal)} 个 pedestal（"pedestal": -0.2, "pedestalDuration": 1.5，轻微上下移）、${budgetCount(2, budget.panV2)} 个 pan（"pan": -5 或 8, "panDuration": 2，只在换组/横移句）、${budgetCount(0, budget.dof)} 个 dof（"dof": 0.5, "dofLayers": 2, "dofDuration": 1.5，情绪特写；角色 DoF 必须有台上目标）、${budgetCount(2, budget.lookAt)} 个独立 look（见视线预算）；Se 约 ${budget.se} 条（se 只能写上面音效清单里的 cue；清单为 (none) 时不写 se/seStop），Track 约 ${budget.track} 次。可选时长字段：focusDuration、trackDuration、pedestalDuration、panDuration、panFocusSlide、dofDuration、dofLayers、lookY、lookDuration、seDuration、seDelay、seStop、motionFadeIn、motionWait；不写就给默认时长。trackDuration 只在写了 track 时有效，focusDuration 只在写了 focus/camera 时有效；角色 DoF 需要台上目标（say 默认说话者，action 用动作角色；camera/narrate 的 focus 指向具体角色或有人的位置，省略 focus 时编译器选当前镜头附近的台上角色），背景 DoF（dofLayers 0）不需要。
- 听者反应写进 actions（at: 0），**每句最多 1 条**，cast 必须是台上的其他角色；不要给说话者本人写 actions，也不要一句叠两个听者。
- focus 优先写构图点/位置，角色 focus 只给 close 近景和情绪最重的 1~2 句；close / very-close 必须 focus 到角色 id 或该角色的位置，不要用 focus 5。track 只在换组/群像横移时写，-4~4，双人通常 0~1 次。
- 没有合适的动作/表情就省略字段，不要编清单之外的名字。

示例（只演示引用 line id、镜头和反应的结构；不要照抄演出）：
${example ? JSON.stringify(example, null, 2) : "(none)"}

只输出 JSON 对象本身，不要 markdown 或解释。`,
    },
  ];
};

export const buildStoryboardRepairMessages = ({ plan, dialogue, storyboard, problems, catalog, request, config, planNotes = "" }) => {
  const base = buildStoryboardMessages({ plan, dialogue, catalog, request, config, planNotes });
  const list = problems.map((p) => `- ${p.path || "/"}: [${p.code}] ${p.message}` +
    (p.expected ? `（可用值：${p.expected.slice(0, 40).join(", ")}${p.expected.length > 40 ? "…" : ""}）` : "") +
    (p.suggestion ? `（建议：${p.suggestion}）` : "")).join("\n");
  return [
    base[0],
    {
      role: "user",
      content: `${base[1].content}\n\n## 上一轮分镜的问题\n${list}\n\n` +
        `## 上一轮分镜\n${typeof storyboard === "string" ? storyboard : JSON.stringify(storyboard)}\n\n` +
        "请只修正分镜（舞台、站位、镜头、动作、表情、BGM），台词稿一个字都不要改，输出完整的 JSON 对象。",
    },
  ];
};

// ---------------------------------------------------------------------------
// Merge: the dialogue is authoritative, the storyboard only says how it is staged
// ---------------------------------------------------------------------------

// The extended official camera/sound fields the parser, checker and compiler support. The merge keeps them on the
// right beats and drops any field the resolved beat kind does not accept.
const EXTRA_DIRECTION_KEYS = ["focusDuration", "trackDuration", "pedestal", "pedestalDuration",
  "pan", "panDuration", "panFocusSlide", "dof", "dofDuration", "dofLayers",
  "look", "lookY", "lookDuration", "se", "seDuration", "seDelay", "seStop",
  "motionFadeIn", "motionWait"];

const DIRECTION_KEYS = ["motion", "expression", "lookAt", "focus", "camera", "track", "zoom", "zoomDuration",
                        "actions", ...EXTRA_DIRECTION_KEYS];
// A narration has no speaker: motion/expression/gaze/sound/acting fields belong to a say or action beat.
const NARRATE_DIRECTION_KEYS = ["focus", "camera", "track", "zoom", "zoomDuration", "focusDuration", "trackDuration",
                                "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide",
                                "dof", "dofDuration", "dofLayers", "actions"];
const BEAT_KEYS = ["scene", "positions", "camera", "focus", "track", "zoom", "zoomDuration", "music", "location",
                   "duration", "fade", "pause", "action", "motion", "expression", "lookAt",
                   ...EXTRA_DIRECTION_KEYS];
// The fields each non-line beat kind accepts, so a storyboard cannot hand the parser a field its beat rejects.
const NON_LINE_KEYS = {
  scene: ["scene", "music", "location", "camera", "focus", "track", "positions", "focusDuration", "trackDuration",
          "se", "seDuration", "seDelay", "seStop"],
  positions: ["positions", "camera", "focus", "track", "focusDuration", "trackDuration", "motionFadeIn", "motionWait"],
  camera: ["camera", "focus", "track", "zoom", "zoomDuration", "cameraDuration", "focusDuration", "trackDuration",
           "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide", "dof", "dofDuration", "dofLayers",
           "se", "seDuration", "seDelay", "seStop", "duration"],
  fade: ["fade", "duration"],
  pause: ["pause"],
  action: ["action", "motion", "expression", "lookAt", "look", "lookY", "lookDuration", "dof", "dofDuration",
           "dofLayers", "duration", "se", "seDuration", "seDelay", "seStop", "motionFadeIn", "motionWait"],
};
const beatKindOf = (beat) => ["scene", "positions", "camera", "fade", "pause", "action"].find((k) => k in beat) || "";

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
};

const resolveLine = (beat, lines, index, next) => {
  const ref = s(beat.line ?? beat.lineId ?? beat.line_id);
  if (ref) {
    if (index.has(ref)) return index.get(ref);
    const m = /^l?(\d+)$/i.exec(ref);
    if (m && index.has(`l${m[1]}`)) return index.get(`l${m[1]}`);
    return null;
  }
  // A storyboard that copied the line instead of its id: match the text, then the speaker at the expected position.
  if (typeof beat.text === "string") {
    const text = cleanText(beat.text);
    const at = lines.findIndex((l) => !l.narrate && l.text === text);
    if (at >= 0) return at;
  }
  if (beat.say && next < lines.length && !lines[next].narrate && lines[next].say === s(beat.say)) return next;
  return null;
};

const POSITION_NUMBER = { "far-left": 1, left: 3, center: 5, right: 7, "far-right": 9 };
const CAMERA_NUMBER = { near: 1, middle: 2, far: 3, close: 4, "very-close": 5 };
const positionNumber = (v) => (typeof v === "number" ? v
  : isObj(v) ? POSITION_NUMBER[String(v.at || "").trim()] || 5
  : POSITION_NUMBER[String(v || "").trim()] || 5);
const cameraNumber = (v) => (typeof v === "string" ? CAMERA_NUMBER[v] : isObj(v) ? CAMERA_NUMBER[v.distance] : undefined);
const setCameraDistance = (beat, name) => {
  beat.camera = isObj(beat.camera) ? { ...beat.camera, distance: name } : name;
};
// The cast member a focus names: a cast id, a position name, or a slot number. "" when it frames the group.
const focusedCast = (focus, positions) => {
  if (typeof focus === "string" && Object.prototype.hasOwnProperty.call(positions, focus)) return focus;
  const n = typeof focus === "number" ? focus : POSITION_NUMBER[String(focus || "").trim()];
  if (!n) return "";
  return Object.keys(positions).find((id) => positionNumber(positions[id]) === n) || "";
};

// The published slots are 1.6 world units apart and a character is about that wide, so two people at
// center+right (or left+right) overlap. Normalize every position snapshot in a scene:
//   2 people -> far-left / far-right (3.2 apart, a clear gap)
//   3 people -> far-left / far-right for the first two and center for the third (maxOnStage 3 only)
// A solo opening is put at far-left and its camera focus follows, so the first person does not have to
// move when the second enters.
export const spreadPositions = (beats, maxOnStage = 3, warnings = []) => {
  const limit = Math.max(2, Math.min(3, Math.round(Number(maxOnStage) || 3)));
  let start = 0;
  while (start < beats.length) {
    let end = start + 1;
    while (end < beats.length && !("scene" in beats[end])) end++;
    const section = beats.slice(start, end);
    let maxCount = 0, firstSize = 0, firstSeen = false;
    const order = [];
    for (const beat of section) {
      if (!isObj(beat.positions)) continue;
      const ids = Object.keys(beat.positions);
      if (!firstSeen) { firstSize = ids.length; firstSeen = true; }
      maxCount = Math.max(maxCount, Math.min(ids.length, limit));
      const sorted = [...ids].sort((a, b) => positionNumber(beat.positions[a]) - positionNumber(beat.positions[b]));
      for (const id of sorted) if (!order.includes(id)) order.push(id);
    }
    if (maxCount >= 2) {
      const layout = maxCount === 2 ? ["far-left", "far-right"]
        : firstSize >= 3 ? ["far-left", "center", "far-right"] : ["far-left", "far-right", "center"];
      const slotOf = new Map(order.map((id, i) => [id, layout[i] || "center"]));
      for (const beat of section) {
        if (!isObj(beat.positions)) continue;
        const ids = Object.keys(beat.positions);
        const next = {};
        for (const id of ids) next[id] = slotOf.get(id) || "center";
        const changed = ids.some((id) => beat.positions[id] !== next[id]);
        beat.positions = next;
        if (changed) warnings.push({ code: "spreadPositions", message: "站位改为分站两侧，避免人物重叠" });
        // A focus written as a position that no longer has a character would aim at empty space.
        if (typeof beat.focus === "string" && POSITION_NUMBER[beat.focus] && !Object.values(next).includes(beat.focus)) {
          beat.focus = ids.length === 1 ? next[ids[0]] : 5;
        }
        if (ids.length === 1) {
          const only = next[ids[0]];
          if (beat.focus === undefined || beat.focus === 5 || beat.focus === "center") beat.focus = only;
        } else if (beat.focus === undefined || [2, 4, 6, 8].includes(Number(beat.focus))) {
          beat.focus = 5;
        }
        // A group shot with a pan crops the outermost character; the official group framing is centred and far.
        if (ids.length >= 3) {
          if (beat.track === undefined || Number(beat.track) !== 0) {
            beat.track = 0;
            warnings.push({ code: "groupTrack", message: "三人同台取消横移，避免切掉最外侧角色" });
          }
          if (beat.camera === undefined || beat.camera === "middle" || beat.camera === "near") {
            beat.camera = "far";
            warnings.push({ code: "groupCamera", message: "三人同台改用 far 机位，避免两侧角色被裁切" });
          } else if (isObj(beat.camera) && (!beat.camera.distance || beat.camera.distance === "middle" || beat.camera.distance === "near")) {
            beat.camera = { ...beat.camera, distance: "far" };
            warnings.push({ code: "groupCamera", message: "三人同台改用 far 机位，避免两侧角色被裁切" });
          }
        }
      }
      // The camera distances are not intuitive: near is the widest (1.2x), close is a 2.8x close-up. A model that
      // writes near on a line focused on one character means the close-up; and a close-up that kept the group focus
      // is aimed at the speaker, not at the empty middle of the stage.
      let stage = {};
      for (const beat of section) {
        if (isObj(beat.positions)) stage = beat.positions;
        if (!isObj(beat)) continue;
        const distance = cameraNumber(beat.camera);
        if (distance === CAMERA_NUMBER.near && (beat.say || beat.narrate) && Object.keys(stage).length >= 2) {
          const id = focusedCast(beat.focus, stage);
          if (id) {
            setCameraDistance(beat, "close");
            warnings.push({ code: "nearCloseUp", message: "near 是全景；单人台词改用 close 近景" });
          }
        }
        if (distance >= CAMERA_NUMBER.close && Object.keys(stage).length >= 2 &&
            (beat.focus === undefined || beat.focus === 5 || beat.focus === "center") &&
            beat.say && Object.prototype.hasOwnProperty.call(stage, beat.say)) {
          beat.focus = beat.say;
          warnings.push({ code: "closeUpFocus", message: "近景改为对着说话者，避免镜头对着空处" });
        }
      }
    }
    start = end;
  }
  return beats;
};

// The AI path treats too many people on stage as a repair problem: with maxOnStage 2 the third person has to wait
// until someone leaves, which is the only way to keep every pair far-left / far-right and non-overlapping.
export const onStageProblems = (beats, maxOnStage = 3) => {
  const limit = Math.max(2, Math.min(3, Math.round(Number(maxOnStage) || 3)));
  const out = [];
  (beats || []).forEach((beat, i) => {
    if (!isObj(beat.positions)) return;
    const n = Object.keys(beat.positions).length;
    if (n > limit) {
      out.push({ path: `/beats/${i}/positions`, code: "tooManyOnStage",
        message: `${n} characters are on stage; the limit is ${limit}`,
        suggestion: "have one character leave before the next enters (positions)" });
    }
  });
  return out;
};

const defaultScene = ({ plan, catalog, maxOnStage = 3 }) => {
  const limit = Math.max(2, Math.min(3, Math.round(Number(maxOnStage) || 3)));
  const positions = {};
  if (plan.cast.length === 1) positions[plan.cast[0].id] = "center";
  else if (plan.cast.length >= 2) {
    positions[plan.cast[0].id] = "far-left";
    positions[plan.cast[1].id] = "far-right";
    if (limit >= 3 && plan.cast[2]) positions[plan.cast[2].id] = "center";
  }
  return {
    scene: plan.setting?.stage || catalog.stages[0]?.id || "",
    ...(plan.setting?.location ? { location: plan.setting.location } : {}),
    ...(plan.setting?.music ? { music: plan.setting.music } : {}),
    camera: "middle",
    focus: 5,
    positions,
  };
};

// Evenly spaced samples, so a pruned camera/gaze budget stays spread through the scene instead of clustering at the
// start. Centers the samples in their slices.
const evenlySpaced = (items, count) => {
  if (count <= 0) return [];
  if (count >= items.length) return [...items];
  return Array.from({ length: count }, (_, index) =>
    items[Math.min(items.length - 1, Math.floor((index + 0.5) * items.length / count))]);
};

// Restores the dialogue verbatim and keeps the storyboard's direction in line order. A missing direction is filled
// with a bare line; an unknown line id is dropped; a repeated one keeps the first. That makes a mostly-correct
// storyboard usable without a repair round just for ordering.
export const mergeStagedScript = ({ plan, dialogue, storyboard, catalog, request = {}, config = {} }) => {
  const warnings = [];
  const lines = dialogue.lines;
  const index = new Map(lines.map((l, i) => [l.id, i]));
  const direction = new Array(lines.length).fill(null);
  const before = lines.map(() => []);
  const tail = [];
  let next = 0;
  const beats = Array.isArray(storyboard?.beats) ? storyboard.beats : [];
  for (const beat of beats) {
    if (!isObj(beat)) continue;
    const isLineRef = "line" in beat || "lineId" in beat || "line_id" in beat ||
      (("say" in beat || "text" in beat) && !("scene" in beat) && !("positions" in beat));
    if (isLineRef) {
      const at = resolveLine(beat, lines, index, next);
      if (at == null) {
        warnings.push({ code: "unknownLine", message: `分镜引用了不存在的台词：${JSON.stringify(beat.line ?? beat.text ?? beat.say)}` });
        continue;
      }
      if (direction[at]) {
        warnings.push({ code: "duplicateLine", message: `分镜重复引用了 ${lines[at].id}，保留第一次` });
        continue;
      }
      const chosen = pick(beat, lines[at].narrate ? NARRATE_DIRECTION_KEYS : DIRECTION_KEYS);
      direction[at] = Object.keys(chosen).length ? chosen : null;
      if (lines[at].narrate) {
        const dropped = DIRECTION_KEYS.filter((k) => k in beat && !NARRATE_DIRECTION_KEYS.includes(k));
        if (dropped.length)
          warnings.push({ code: "narrateField", message: `旁白没有说话者，已忽略 ${dropped.join("、")}` });
      }
      next = at + 1;
      continue;
    }
    const kind = beatKindOf(beat);
    const keys = kind ? NON_LINE_KEYS[kind] : BEAT_KEYS;
    const clean = pick(beat, keys);
    if (kind) {
      const dropped = BEAT_KEYS.filter((k) => k in beat && !keys.includes(k));
      if (dropped.length)
        warnings.push({ code: "storyboardField", message: `${kind} beat 不支持 ${dropped.join("、")}，已忽略` });
    }
    if (next < lines.length) before[next].push(clean); else tail.push(clean);
  }
  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    if (!direction[i] || Object.keys(direction[i]).length === 0)
      warnings.push({ code: "missingDirection", message: `${lines[i].id} 没有分镜，按无动作处理` });
    merged.push(...before[i]);
    const dir = direction[i] || {};
    merged.push(lines[i].say ? { say: lines[i].say, text: lines[i].text, ...dir }
      : { narrate: lines[i].narrate, ...dir });
  }
  merged.push(...tail);
  // A storyboard sometimes invents one motion or expression name. The checker can repair names close to a real one,
  // but an unfixable name used to send the whole storyboard through the repair loop and then into the bare-line
  // fallback. Repair what is close and drop only the unknown field (with a warning); the line and its other direction
  // stay intact.
  const actionModels = new Map((catalog.models || []).map((model) => [model.id, model]));
  const castModelId = new Map((plan.cast || []).map((member) => [member.id, member.model]));
  const nameStats = { repaired: 0, dropped: 0 };
  const repairedNames = (beat, castId, path) => {
    if (!castId) return;
    const model = actionModels.get(castModelId.get(castId) || castId);
    if (!model) return;
    if (beat.motion !== undefined) {
      const motions = [...new Set([...(model.motions || []), ...motionStems(model.motions || [])])];
      if (!motions.includes(beat.motion)) {
        const suggestion = nearest(String(beat.motion), motions);
        if (suggestion) {
          warnings.push({ code: "unknownMotion",
            message: `${path} 的动作 ${beat.motion} 不在 ${castId} 的动作表，已改为 ${suggestion}` });
          beat.motion = suggestion;
          nameStats.repaired++;
        } else {
          warnings.push({ code: "unknownMotion",
            message: `${path} 的动作 ${beat.motion} 不在 ${castId} 的动作表，已省略该动作` });
          delete beat.motion;
          nameStats.dropped++;
        }
      }
    }
    if (beat.expression !== undefined && !(model.expressions || []).includes(beat.expression)) {
      const suggestion = nearest(String(beat.expression), model.expressions || []);
      if (suggestion) {
        warnings.push({ code: "unknownExpression",
          message: `${path} 的表情 ${beat.expression} 不在 ${castId} 的表情表，已改为 ${suggestion}` });
        beat.expression = suggestion;
        nameStats.repaired++;
      } else {
        warnings.push({ code: "unknownExpression",
          message: `${path} 的表情 ${beat.expression} 不在 ${castId} 的表情表，已省略该表情` });
        delete beat.expression;
        nameStats.dropped++;
      }
    }
  };
  merged.forEach((beat, index) => {
    const path = `/beats/${index}`;
    repairedNames(beat, beat.say || beat.action, path);
    (Array.isArray(beat.actions) ? beat.actions : []).forEach((action, actionIndex) =>
      repairedNames(action, action?.cast || beat.say, `${path}/actions/${actionIndex}`));
    if (beat.positions && typeof beat.positions === "object") {
      for (const [castId, position] of Object.entries(beat.positions)) {
        if (position && typeof position === "object") repairedNames(position, castId, `${path}/positions/${castId}`);
      }
    }
  });
  // The storyboard pass over-directs: this model wrote focus/camera on 26 of 40 lines and a lookAt on every other
  // line. The official rates are scene budgets, so keep evenly spaced cuts and gaze beats and let the rest inherit
  // the previous shot. Acting, zoom, pedestal, pan, dof and sound stay on the pruned beat.
  const textBeats = merged.filter((beat) => "say" in beat || "narrate" in beat);
  const cameraBudget = directionBudgetFor(textBeats.length);
  const hasCamera = (beat) => beat.focus !== undefined || beat.camera !== undefined || beat.track !== undefined;
  const structuralFocus = merged.filter((beat) => !("say" in beat || "narrate" in beat) &&
    (beat.scene !== undefined || beat.positions !== undefined || hasCamera(beat))).length;
  const lineFocus = textBeats.filter(hasCamera);
  const allowedLineFocus = Math.max(0, cameraBudget.focusChanges - structuralFocus);
  let focusPruned = 0;
  if (lineFocus.length > allowedLineFocus) {
    const keep = new Set(evenlySpaced(lineFocus, allowedLineFocus));
    let removed = 0;
    for (const beat of lineFocus) {
      if (keep.has(beat)) continue;
      for (const key of ["focus", "camera", "track", "focusDuration", "trackDuration", "cameraDuration"])
        delete beat[key];
      removed++;
    }
    focusPruned = removed;
    warnings.push({ code: "focusBudget",
      message: `换机位 ${lineFocus.length + structuralFocus} 处，超过本场 Focus 预算 ${cameraBudget.focusChanges}；` +
        `已省略 ${removed} 处 line 镜头，保留的剪辑点均匀分布` });
  }
  // One gaze channel per beat, and the measured look rate for the scene. The first independent gaze offset is kept
  // so an episode still exercises the sampled Look x/y command, not only LookTarget.
  for (const beat of textBeats) {
    if (beat.lookAt !== undefined && beat.look !== undefined) {
      delete beat.look;
      delete beat.lookY;
      delete beat.lookDuration;
      warnings.push({ code: "lookChannel", message: "lookAt 与 look 同时出现，保留 lookAt" });
    }
  }
  const gazeSlots = [];
  for (const beat of textBeats) {
    if (beat.lookAt !== undefined && beat.lookAt !== "") gazeSlots.push({ beat, key: "lookAt" });
    if (beat.look !== undefined) gazeSlots.push({ beat, key: "look" });
    for (const action of Array.isArray(beat.actions) ? beat.actions : []) {
      if (action && action.lookAt !== undefined && action.lookAt !== "")
        gazeSlots.push({ beat, action, key: "actionLookAt" });
    }
  }
  let gazePruned = 0;
  if (gazeSlots.length > cameraBudget.lookAt) {
    const keep = new Set();
    const offset = gazeSlots.find((slot) => slot.key === "look");
    if (offset) keep.add(offset);
    for (const slot of evenlySpaced(gazeSlots.filter((item) => !keep.has(item)), cameraBudget.lookAt - keep.size))
      keep.add(slot);
    let removed = 0;
    for (const slot of gazeSlots) {
      if (keep.has(slot)) continue;
      if (slot.action) delete slot.action.lookAt;
      else {
        delete slot.beat.lookAt;
        if (slot.key === "look") {
          delete slot.beat.lookY;
          delete slot.beat.lookDuration;
        }
      }
      removed++;
    }
    gazePruned = removed;
    warnings.push({ code: "gazeBudget",
      message: `视线 ${gazeSlots.length} 处，超过本场预算 ${cameraBudget.lookAt}；已省略 ${removed} 处视线` });
  }
  // The storyboard pass sometimes over-directs: keep one listener reaction per line and one standalone expression per
  // scene. Both limits are what the official episodes do and what the prompt asks for.
  let standaloneExpressions = 0;
  for (const beat of merged) {
    if (!("say" in beat)) continue;
    if (Array.isArray(beat.actions) && beat.actions.length > 1) {
      warnings.push({
        code: "tooManyActions",
        message: `台词「${String(beat.text).slice(0, 12)}」有 ${beat.actions.length} 个听者反应，保留第一个`,
      });
      beat.actions = beat.actions.slice(0, 1);
    }
    if (beat.expression && !beat.motion) {
      standaloneExpressions++;
      if (standaloneExpressions > 1) {
        delete beat.expression;
        warnings.push({ code: "standaloneExpression", message: "独立表情一场最多 1 次，已省略多余的表情" });
      }
    }
  }
  // 表演预算：一行 say 编译出一条说话者 Motion（motion/expression 取其一即一条），
  // 每条 actions 编译出一条听者表演行；字段不再重复计数。
  // 官方 noMotionShare 约 6%，maxStatic（12%）是策略上限，但修剪必须达到 motionMax。
  const says = merged.filter((beat) => "say" in beat);
  const budget = directionBudgetFor(says.length);
  const performanceRows = (beat) => {
    let count = beat.motion || beat.expression ? 1 : 0;
    for (const a of Array.isArray(beat.actions) ? beat.actions : []) {
      if (a && (a.motion || a.expression)) count++;
    }
    return count;
  };
  let totalRows = says.reduce((sum, beat) => sum + performanceRows(beat), 0);
  if (totalRows > budget.motionMax) {
    const beforeRows = totalRows;
    let removedUnits = 0;
    const candidates = says
      .map((beat, index) => ({ beat, index,
        length: [...String(beat.text || "").replace(/\s/g, "")].length }))
      .filter((item) => performanceRows(item.beat) > 0)
      .sort((a, b) => a.length - b.length || b.index - a.index);
    for (const item of candidates) {
      if (totalRows <= budget.motionMax) break;
      // Speaker motion + expression compile to one Motion row: remove them together.
      if (item.beat.motion || item.beat.expression) {
        delete item.beat.motion;
        delete item.beat.expression;
        totalRows -= 1;
        removedUnits += 1;
      }
      // Listener actions compile one row each: pop whole entries one at a time.
      while (totalRows > budget.motionMax && Array.isArray(item.beat.actions) && item.beat.actions.length) {
        const action = item.beat.actions.pop();
        if (action && (action.motion || action.expression)) totalRows -= 1;
        removedUnits += 1;
      }
    }
    const staticLines = says.filter((beat) => performanceRows(beat) === 0).length;
    warnings.push({ code: "performanceBudget",
      message: `表演行 ${beforeRows} 条，超过官方目标 ${budget.motionMin}~${budget.motionMax}；` +
        `已摘掉 ${removedUnits} 个表演单元（现在 ${totalRows} 条，${staticLines} 句静止）` });
  }
  const maxOnStage = Math.max(2, Math.min(3, Math.round(Number(config.story?.maxOnStage ?? 3) || 3)));
  if (!merged.length || !("scene" in merged[0])) merged.unshift(defaultScene({ plan, catalog, maxOnStage }));
  spreadPositions(merged, maxOnStage, warnings);

  const cast = Object.fromEntries(plan.cast.map((c) => [c.id, { model: c.model, name: c.name }]));
  const rawFocus = structuralFocus + lineFocus.length;
  const rawGaze = gazeSlots.length;
  return {
    warnings,
    normalization: {
      direction: {
        lineCount: textBeats.length,
        rawFocus, focusPruned, finalFocus: rawFocus - focusPruned,
        rawGaze, gazePruned, finalGaze: rawGaze - gazePruned,
      },
      names: { ...nameStats },
    },
    doc: {
      format: "ournotes.story-script/1",
      base: catalog.manifest,
      language: request.language || catalog.language,
      title: dialogue.title || plan.title || request.title || config.story?.title || "",
      font: config.story?.font || "sans",
      cast,
      beats: merged,
    },
  };
};
