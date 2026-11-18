// The semantic layer over a site's opaque resource ids.
//
// A site-format story names its background `adv_bkg_stage_000164` and its music `sound_bgm_adv_f6b483`; the only
// human text a story carries is the chapter title next to a Stage row ("初中時代" for a dark bedroom). An AI writer
// cannot choose from that, so this guide supplies a name, a description and tags per id. A site may ship its own
// <site>/story-resources.yaml; otherwise the bundled guide for the official bdon site is used. Unknown ids fall back
// to the story's caption, so a different site still works without a guide.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), "site-resources.yaml");

const string = (value) => (value === undefined || value === null ? "" : String(value));
const stringList = (value) => (Array.isArray(value) ? value.map(string).filter(Boolean) : []);

const normalizeEntry = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    name: string(value.name),
    description: string(value.description),
    tags: stringList(value.tags),
    actions: stringList(value.actions),
    kind: string(value.kind),
    mood: string(value.mood),
    tempo: string(value.tempo),
    category: string(value.category),
    band: string(value.band),
    indoor: typeof value.indoor === "boolean" ? value.indoor : undefined,
    timeOfDay: string(value.timeOfDay),
    use: string(value.use),
  };
};

// Built-in semantic labels for official bdon.moe Frames, PostEffects, and Transitions.
// Sites with their own <site>/story-resources.yaml may override or extend these tables.
const BUILTIN_FRAMES = Object.freeze({
  adv_frame_fill_black: {
    name: "纯黑遮罩（瞬黑）",
    tags: ["遮罩", "黑底", "转场"],
    use: "硬切瞬间遮黑、压暗开场或强烈留白；无需擦除动画，再次调用或 frameStop: true 撤去",
  },
  adv_frame_fill_white: {
    name: "纯白遮罩（强光）",
    tags: ["遮罩", "白底", "转场"],
    use: "刺眼强光、回忆切入或白屏转场，再次调用或 frameStop: true 撤去",
  },
  adv_frame_letterbox_black: {
    name: "黑色电影遮幅（上下黑边）",
    tags: ["电影感", "黑边", "回忆", "高潮"],
    actions: ["Show_anime", "Hide_anime"],
    use: "回忆段落、独白或情感高潮；用 frameAction: \"Show_anime\" 展开，结束时 frameStop: true 撤去",
  },
  adv_frame_letterbox_white: {
    name: "白色电影遮幅（上下白边）",
    tags: ["电影感", "白边", "回忆", "温暖"],
    actions: ["Show_anime", "Hide_anime"],
    use: "柔和回忆、幻想或明亮抒情段落；用 frameAction: \"Show_anime\" 展开，结束时 frameStop: true 撤去",
  },
  adv_frame_fog: {
    name: "雾气晕影遮罩",
    tags: ["氛围", "雾气", "回忆", "不安"],
    use: "画面边缘朦胧雾气，用于回忆、失神、犹豫不安或清晨微雾氛围",
  },
  adv_frame_kirakira_1: {
    name: "星光闪烁特效",
    tags: ["氛围", "闪亮", "憧憬", "喜悦"],
    use: "画面飘散闪亮光点，用于心动瞬间、灵感闪现、舞台憧憬或感动时刻",
  },
  adv_frame_kirakira_2: {
    name: "星光闪烁特效 2",
    tags: ["氛围", "闪亮", "憧憬"],
    use: "较密星光粒子特效，用于盛大演出或强烈感动时刻",
  },
  adv_frame_glitch_1: {
    name: "故障噪点遮罩 1",
    tags: ["冲击", "故障", "动摇", "紧张"],
    use: "电子噪点撕裂效果，用于心理动摇、震惊或突发异变",
  },
  adv_frame_glitch_2: {
    name: "故障噪点遮罩 2",
    tags: ["冲击", "故障", "崩溃"],
    use: "强烈信号错位效果，用于剧烈混乱或意识冲击",
  },
  adv_frame_lensflare_1: {
    name: "镜头光晕",
    tags: ["光影", "温暖", "逆光"],
    use: "柔和光斑与镜头耀光，用于阳光穿透、抬头望天或释怀瞬间",
  },
  adv_frame_moyamoya: {
    name: "阴郁心绪暗纹",
    tags: ["情绪", "阴郁", "烦躁"],
    use: "暗沉思绪纹理，用于心情低落、闷闷不乐或内心纠结",
  },
  adv_frame_eyeblink_blink: {
    name: "眨眼视角遮罩",
    tags: ["视角", "苏醒"],
    use: "第一人称睁眼或闭眼瞬间",
  },
  adv_frame_rain_heavy_vertical: {
    name: "暴雨雨丝遮罩",
    tags: ["天气", "下雨", "阴沉"],
    use: "强降雨前景雨丝，只用于明确的室外大雨场景",
  },
  adv_frame_comic_speedline_white: {
    name: "漫画集中线（白）",
    tags: ["夸张", "惊讶", "喜剧", "吐槽"],
    use: "漫符集中速度线，用于突然反应、震惊吐槽或喜剧爆发",
  },
});

const BUILTIN_POST_EFFECTS = Object.freeze({
  adv_effect_posteffect_reminiscence1: {
    name: "冷调回忆滤镜",
    mood: "清冷、怀旧、略带忧伤",
    use: "过去回忆或闪回段落（偏冷蓝低饱和带轻柔景深）；结束时必须写 postEffectStop: true",
  },
  adv_effect_posteffect_reminiscence2: {
    name: "暖调回忆滤镜",
    mood: "温暖、怀旧、柔和",
    use: "温情往事或柔和回想；结束时必须写 postEffectStop: true",
  },
  adv_effect_posteffect_monochrome: {
    name: "黑白单色滤镜",
    mood: "凝重、冲击、定格",
    use: "强烈心理冲击、残酷真相或过去回溯；结束时写 postEffectStop: true",
  },
  adv_effect_posteffect_sepia: {
    name: "复古棕褐滤镜",
    mood: "复古、陈旧、遥远过去",
    use: "遥远回忆或老照片质感；结束时写 postEffectStop: true",
  },
  adv_effect_posteffect_vignette: {
    name: "重度暗角滤镜",
    mood: "压迫、沉重、不安",
    use: "心理压迫、孤立感或紧张逼近；结束时写 postEffectStop: true",
  },
  adv_effect_posteffect_vignette2: {
    name: "柔焦暗角滤镜",
    mood: "专注、微暗、沉浸",
    use: "轻度聚拢视线、内心独白或冷开场氛围；结束时写 postEffectStop: true",
  },
  adv_effect_posteffect_blur: {
    name: "全屏失焦模糊",
    mood: "朦胧、眩晕、苏醒",
    use: "刚醒来、晕眩或梦境转醒；恢复清晰时写 postEffectStop: true",
  },
  adv_effect_posteffect_motion_blur: {
    name: "动态模糊",
    mood: "疾速、冲刺、急转",
    use: "奔跑、急切冲出或大幅甩镜瞬间；结束后写 postEffectStop: true",
  },
  adv_effect_posteffect_chromatic_aberration: {
    name: "色差畸变滤镜",
    mood: "眩晕、动摇、焦躁",
    use: "情绪剧烈动摇或眩晕不稳感；结束后写 postEffectStop: true",
  },
  adv_effect_posteffect_lens_distortion: {
    name: "广角镜头畸变",
    mood: "压迫、扭曲、失真",
    use: "心理扭曲或夸张透视；结束后写 postEffectStop: true",
  },
  adv_effect_posteffect_glitch: {
    name: "数字信号故障滤镜",
    mood: "崩溃、错乱、冲击",
    use: "电子信号紊乱或剧烈心理冲击；结束后写 postEffectStop: true",
  },
  adv_effect_posteffect_glitch2: {
    name: "强信号故障滤镜 2",
    mood: "剧烈动摇、混乱",
    use: "较强画面撕裂干扰；结束后写 postEffectStop: true",
  },
  adv_effect_posteffect_glitch3: {
    name: "局部干扰故障滤镜 3",
    mood: "异样、焦躁",
    use: "短促画面干扰；结束后写 postEffectStop: true",
  },
  adv_effect_posteffect_glitch4: {
    name: "全屏错位故障滤镜 4",
    mood: "失控、冲击",
    use: "强烈数字失真；结束后写 postEffectStop: true",
  },
});

const BUILTIN_TRANSITIONS = Object.freeze({
  "0001": {
    name: "纯色渐变淡入淡出",
    use: "标准黑场（#000000）或白场（#FFFFFF）整幕切换，时间/地点跳跃最稳妥",
  },
  "0002": {
    name: "方向扫除规则转场",
    use: "横向/斜向规则擦除，适合节奏明快的切场",
  },
  "0003": {
    name: "渐变规则擦除转场",
    use: "纹理规则擦除，适合时间推进或场景切换",
  },
  "0004": {
    name: "柔和规则擦除转场",
    use: "柔和过渡擦除，适合日常换幕与回忆切入前后",
  },
  "0005": {
    name: "扩散渐隐规则转场",
    use: "柔和扩散擦除，适合情绪余韵或回忆/梦境过渡",
  },
  "0006": {
    name: "百叶/光影规则转场",
    use: "光影切换规则擦除，适合时间流逝或节奏转场",
  },
  dissolve: {
    name: "背景直接叠化（scene.transition: \"dissolve\"）",
    use: "不黑屏直接交叉叠化舞台背景（transitionDuration 0.8~2.0 秒），适合同地点的光线/时间流逝或梦境切入",
  },
});

const builtinMap = (raw) => new Map(Object.entries(raw).map(([id, entry]) => [id, normalizeEntry(entry)]));

const readGuide = (file, { withBuiltins = false } = {}) => {
  const doc = yaml.load(fs.readFileSync(file, "utf8")) || {};
  const table = (value, defaults = null) => {
    const out = defaults ? builtinMap(defaults) : new Map();
    for (const [id, entry] of Object.entries(value || {})) out.set(id, normalizeEntry(entry));
    return out;
  };
  return {
    format: string(doc.format),
    stages: table(doc.stages),
    music: table(doc.music),
    sounds: table(doc.sounds),
    frames: table(doc.frames, withBuiltins ? BUILTIN_FRAMES : null),
    postEffects: table(doc.postEffects, withBuiltins ? BUILTIN_POST_EFFECTS : null),
    transitions: table(doc.transitions, withBuiltins ? BUILTIN_TRANSITIONS : null),
    source: file,
  };
};

const EMPTY = {
  format: "",
  stages: new Map(),
  music: new Map(),
  sounds: new Map(),
  frames: builtinMap(BUILTIN_FRAMES),
  postEffects: builtinMap(BUILTIN_POST_EFFECTS),
  transitions: builtinMap(BUILTIN_TRANSITIONS),
  source: "",
};

export const loadResourceGuide = (site = "") => {
  const local = site ? path.join(site, "story-resources.yaml") : "";
  if (local && fs.existsSync(local)) return readGuide(local, { withBuiltins: false });
  if (fs.existsSync(BUNDLED)) return readGuide(BUNDLED, { withBuiltins: true });
  return EMPTY;
};

const humanLabel = (id, prefixRe) => string(id).split("/").pop().replace(prefixRe, "")
  .split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

const lookupFrameEntry = (id, guide) => {
  const raw = string(id);
  const tail = raw.includes("/") ? raw.split("/").pop() : raw;
  const map = guide?.frames;
  const hit = map?.get(raw) || map?.get(tail);
  if (hit) return hit;
  return BUILTIN_FRAMES[raw] || BUILTIN_FRAMES[tail] ? normalizeEntry(BUILTIN_FRAMES[raw] || BUILTIN_FRAMES[tail]) : {};
};

const lookupPostEffectEntry = (id, guide) => {
  const raw = string(id);
  const tail = raw.includes("/") ? raw.split("/").pop() : raw;
  const canonical = /^adv_effect_posteffect_/i.test(tail) ? tail : `adv_effect_posteffect_${tail}`;
  const short = tail.replace(/^adv_effect_posteffect_/i, "");
  const map = guide?.postEffects;
  const hit = map?.get(raw) || map?.get(tail) || map?.get(canonical) || map?.get(short);
  if (hit) return hit;
  const fallback = BUILTIN_POST_EFFECTS[raw] || BUILTIN_POST_EFFECTS[tail] || BUILTIN_POST_EFFECTS[canonical];
  return fallback ? normalizeEntry(fallback) : {};
};

export const transitionRuleOf = (value) => {
  const raw = string(value).trim();
  if (!raw) return "";
  if (raw === "dissolve") return "dissolve";
  const m = /(?:^|\/)(?:adv_transition_)?(\d{4})(?:\/|$)/i.exec(raw);
  return m ? m[1] : raw;
};

const lookupTransitionEntry = (id, guide) => {
  const raw = string(id);
  const rule = transitionRuleOf(raw);
  const map = guide?.transitions;
  const hit = map?.get(raw) || map?.get(rule) || map?.get(`adv_transition_${rule}`);
  if (hit) return hit;
  const fallback = BUILTIN_TRANSITIONS[rule] || BUILTIN_TRANSITIONS[raw];
  return fallback ? normalizeEntry(fallback) : {};
};

// Merges the guide into a stage/music/SE/frame/postEffect/transition entry without dropping site fields.
export const applyStageGuide = (stage, guide) => {
  const entry = guide.stages.get(stage.id) || {};
  if (entry.kind === "title") return null;
  return {
    ...stage,
    name: entry.name || stage.name || "",
    description: entry.description || stage.description || "",
    tags: entry.tags?.length ? entry.tags : (stage.tags || []),
    kind: entry.kind || stage.kind || "",
    ...(entry.band ? { band: entry.band } : {}),
    ...(entry.indoor !== undefined ? { indoor: entry.indoor } : {}),
    ...(entry.timeOfDay ? { timeOfDay: entry.timeOfDay } : {}),
  };
};

export const applyMusicGuide = (music, guide) => {
  const entry = guide.music.get(music.cue) || {};
  return {
    ...music,
    name: entry.name || music.name || "",
    mood: entry.mood || music.mood || "",
    ...(entry.tempo ? { tempo: entry.tempo } : {}),
    use: entry.use || music.use || "",
  };
};

export const applySoundGuide = (sound, guide) => {
  const item = typeof sound === "string" ? { cue: sound } : (sound || {});
  const entry = guide?.sounds?.get(item.cue) || {};
  return {
    ...item,
    label: item.label || humanLabel(item.cue, /^sound_(?:bgm|se)_(?:adv_)?/i),
    name: entry.name || item.name || "",
    ...(entry.category ? { category: entry.category } : {}),
    use: entry.use || item.use || "",
  };
};

const inferFrameMeta = (id) => {
  const s = string(id).toLowerCase();
  if (/rain/.test(s)) return { name: `雨丝前景遮罩（${s.replace(/^adv_frame_/, "")}）`, use: "室外下雨场景前景雨丝特效，结束时写 frameStop: true" };
  if (/eyeblink/.test(s)) return { name: `睁闭眼遮罩（${s.replace(/^adv_frame_/, "")}）`, use: "第一人称眨眼、昏迷苏醒或闭眼转场" };
  if (/effectline|speedline/.test(s)) return { name: `漫画效果线（${s.replace(/^adv_frame_/, "")}）`, use: "强调冲击、奔跑、震惊或紧张吐槽的漫符速度线" };
  if (/fill_/.test(s)) return { name: `纯色遮罩（${s.replace(/^adv_frame_/, "")}）`, use: "全屏压暗、强光闪烁或颜色氛围遮罩，结束时写 frameStop: true" };
  if (/shadow_/.test(s)) return { name: `阴影压迫遮罩（${s.replace(/^adv_frame_/, "")}）`, use: "心理阴影或压抑情绪暗角，结束时写 frameStop: true" };
  if (/video|tv|poweroff|slander|rec_/.test(s)) return { name: `录像/屏幕画框（${s.replace(/^adv_frame_/, "")}）`, use: "录像、直播、电视或网络舆论屏幕框效果，结束时写 frameStop: true" };
  if (/smoke/.test(s)) return { name: "烟雾前景遮罩", use: "舞台干冰烟雾或朦胧氛围前景，结束时写 frameStop: true" };
  if (/underwater/.test(s)) return { name: "水下光影遮罩", use: "水下或深海沉浸意象遮罩，结束时写 frameStop: true" };
  if (/lightleak|lensflare/.test(s)) return { name: `漏光光斑遮罩（${s.replace(/^adv_frame_/, "")}）`, use: "逆光暖色光晕效果，结束时写 frameStop: true" };
  if (/irisout/.test(s)) return { name: "圆形收拢黑场", use: "圆孔收缩聚焦与戏剧化收尾" };
  if (/pillarbox|scrollwork|key_open/.test(s)) return { name: `画幅装饰遮罩（${s.replace(/^adv_frame_/, "")}）`, use: "回忆窄画幅或特定戏剧画框，结束时写 frameStop: true" };
  return { name: humanLabel(id, /^adv_frame_/i), use: "官方剧情前景遮罩特效，不用时写 frameStop: true" };
};

export const applyFrameGuide = (frame, guide = EMPTY) => {
  const item = typeof frame === "string" ? { id: frame } : (frame || {});
  const id = string(item.id || item.key);
  const entry = lookupFrameEntry(id, guide);
  const fallback = !entry.name || !entry.use ? inferFrameMeta(id) : null;
  return {
    ...item,
    id,
    key: item.key || id,
    name: entry.name || item.name || fallback?.name || humanLabel(id, /^adv_frame_/i),
    tags: entry.tags?.length ? entry.tags : (item.tags || []),
    actions: entry.actions?.length ? entry.actions : (item.actions || []),
    use: entry.use || item.use || fallback?.use || "",
  };
};

export const applyPostEffectGuide = (postEffect, guide = EMPTY) => {
  const item = typeof postEffect === "string" ? { id: postEffect } : (postEffect || {});
  const id = string(item.id || item.key);
  const entry = lookupPostEffectEntry(id, guide);
  return {
    ...item,
    id,
    key: item.key || id,
    name: entry.name || item.name || humanLabel(id, /^adv_effect_posteffect_/i),
    mood: entry.mood || item.mood || "",
    use: entry.use || item.use || "",
  };
};

export const applyTransitionGuide = (transition, guide = EMPTY) => {
  const item = typeof transition === "string" ? { id: transition } : (transition || {});
  const raw = string(item.asset || item.id);
  const rule = transitionRuleOf(item.id || raw);
  const entry = lookupTransitionEntry(rule || raw, guide);
  const kind = rule === "dissolve" ? "transition" : (item.kind || "fadeRule");
  return {
    ...item,
    id: rule || raw,
    asset: kind === "fadeRule" ? (item.asset || (raw.includes("/") ? raw : `adv_transition_${rule}/adv_transition_${rule}`)) : "",
    kind,
    name: entry.name || item.name || (rule === "dissolve" ? "Dissolve" : `Rule ${rule}`),
    use: entry.use || item.use || "",
  };
};

export const frameChoices = (frames = [], guide = EMPTY) =>
  (frames || []).map((f) => applyFrameGuide(f, guide)).filter((f) => f.id);

export const postEffectChoices = (postEffects = [], guide = EMPTY) =>
  (postEffects || []).map((p) => applyPostEffectGuide(p, guide)).filter((p) => p.id);

export const transitionChoices = (transitions = [], guide = EMPTY, { includeDissolve = true } = {}) => {
  const out = [];
  const seen = new Set();
  for (const t of transitions || []) {
    const item = applyTransitionGuide(t, guide);
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  if (includeDissolve && !seen.has("dissolve")) {
    out.push(applyTransitionGuide({ id: "dissolve", kind: "transition" }, guide));
  }
  return out;
};

export const soundChoices = (sounds = [], guide = EMPTY) =>
  (sounds || []).map((s) => applySoundGuide(s, guide)).filter((s) => s.cue);
