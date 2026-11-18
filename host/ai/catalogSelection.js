// Ranked and categorized candidate selection for AI prompts.
// Replaces blind `.slice(0, 40)` / `.slice(0, 80)` clipping with semantic query/tone/band matching and
// category-balanced presentation across all 343 stages, 91 BGMs, 345 SEs and 267 Live2D models.
import { frameLine, musicLine, postEffectLine, soundLine, stageLine, transitionLine } from "./resourceLines.js";

const MAIN_BAND_ORDER = ["MyGO!!!!!", "Ave Mujica", "梦限大", "家团", "茉团"];

// Expand natural Chinese story prompts into domain search tokens for stages, BGM and SE.
const SEMANTIC_EXPANSIONS = [
  [/咖啡|甜点|蛋糕|喝茶|饮料|奶茶|点单|下午茶/, ["咖啡", "餐厅", "餐饮", "饮品", "水杯", "cafe", "tea"]],
  [/餐厅|吃饭|聚餐|吃面|拉面|寿司|便当|厨房|做饭|料理/, ["餐厅", "餐饮", "食堂", "拉面", "寿司", "厨房", "餐饮", "餐具"]],
  [/排练|练习|合奏|乐队|试音|新曲|作曲|写歌|吉他|贝斯|鼓|键盘/, ["排练", "录音", "车库", "音乐室", "舞台", "乐器", "吉他", "贝斯", "鼓", "钢琴"]],
  [/live|演出|舞台|演唱会|观众|安可|后台|化妆间|休息室/, ["Live", "舞台", "休息室", "候场", "后台", "掌声", "欢呼"]],
  [/学校|校园|上课|放学|课间|教室|天台|操场|图书馆|走廊|换鞋/, ["学园", "学院", "教室", "学校", "天台", "操场", "走廊", "换鞋", "钟声"]],
  [/家|卧室|房间|宿舍|客厅|睡|起床|做梦|宅|打游戏|直播/, ["房间", "卧室", "客厅", "宿舍", "居家", "门", "电脑", "键盘"]],
  [/夜|晚上|深夜|夜谈|夜路|星星|星空|回家|路灯/, ["夜晚", "星空", "夜空", "夜谈", "回家", "路灯"]],
  [/夕阳|黄昏|傍晚|日落|晚霞/, ["黄昏", "傍晚", "夕阳", "晚霞"]],
  [/海|海边|海岸|沙滩|港口|船|游轮/, ["海", "海岸", "港口", "游轮", "风", "浪"]],
  [/雨|下雨|打雷|暴风|伞/, ["雨", "雷", "风", "伞"]],
  [/手机|消息|短信|微信|line|电话|来电|拍照|自拍|相机/, ["手机", "电话", "消息", "拍照", "快门", "相机", "铃声"]],
  [/搞笑|喜剧|吐槽|闹腾|尴尬|吃惊|吓一跳|跑|追/, ["搞笑", "喜剧", "闹腾", "集中线", "惊", "跑", "撞", "滑稽"]],
  [/回忆|过去|童年|初中|往事|失落|难过|哭|道歉|安慰/, ["回忆", "过去", "怀旧", "忧郁", "温柔", "安静", "闪回"]],
  [/紧张|悬疑|吵架|冲突|害怕|担心|焦虑/, ["紧张", "不安", "压迫", "暗角", "心跳", "悬疑"]],
  [/购物|逛街|商店|买|秋叶原|街道|公园|车站|电车/, ["商店", "商店街", "秋叶原", "公园", "车站", "电车", "街"]],
];

export const extractQueryTokens = ({ prompt = "", event = "", tone = "", logline = "", dialogue = null } = {}) => {
  const parts = [prompt, event, tone, logline];
  if (dialogue && Array.isArray(dialogue.lines)) {
    for (const l of dialogue.lines.slice(0, 60)) {
      if (l?.text) parts.push(l.text);
      if (l?.narrate) parts.push(l.narrate);
    }
  }
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  const tokens = new Set();
  for (const w of text.split(/[\s,，。！？?!、；;:："“”‘’()【】/\\]+/)) {
    if (w.length >= 2) tokens.add(w);
    // Sliding 2-char CJK bigrams so unspaced Chinese prompts still match character/venue names (e.g. 千石由乃/水濑/天台).
    const cjkRuns = w.match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (const run of cjkRuns) {
      for (let i = 0; i <= run.length - 2; i++) {
        tokens.add(run.slice(i, i + 2));
      }
    }
  }
  for (const [re, extra] of SEMANTIC_EXPANSIONS) {
    if (re.test(text)) {
      for (const kw of extra) tokens.add(kw.toLowerCase());
    }
  }
  return { text, tokens: [...tokens] };
};

const matchScore = (haystack, tokens) => {
  if (!haystack || !tokens.length) return 0;
  const low = haystack.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (low.includes(tok)) score += tok.length >= 3 ? 4 : 2;
  }
  return score;
};

const isSupportingNpcKey = (key = "") => key.startsWith("sub_") &&
  key !== "sub_mortis" && key !== "sub_viola" && key !== "sub_kanata";

export const selectPromptCharacterGroups = (models = [], { query = "", maxCap = 24 } = {}) => {
  const { text: qText } = extractQueryTokens({ prompt: query });
  const wantsSpecial = /(?:静止|剪影|面具|童年|幼年|初中|家人|路人|经纪人|女仆|万圣节|侦探|骑士|公主|修女|管理员)/.test(qText);

  const byChar = new Map();
  let genericCount = 0;

  for (const m of models) {
    if (m.actionsKnown === false) continue;
    const charKey = m.character || m.name;
    if (!charKey) continue;
    const keyLower = String(m.key || "").toLowerCase();
    if (!wantsSpecial && isSupportingNpcKey(keyLower)) continue;

    const hasMainBand = MAIN_BAND_ORDER.includes(m.band);
    if (!byChar.has(charKey)) {
      if (!hasMainBand) {
        if (genericCount >= maxCap) continue;
        genericCount++;
      } else if (byChar.size >= Math.max(maxCap, 32)) {
        continue;
      }
      byChar.set(charKey, []);
    }
    byChar.get(charKey).push(m);
  }

  const ordered = new Map();
  const entries = [...byChar.entries()].map(([name, list]) => {
    const band = list[0]?.band || "";
    const bandIdx = MAIN_BAND_ORDER.indexOf(band);
    let filtered = wantsSpecial ? list : list.filter((m) => !m.isStillOrMask);
    if (!filtered.length) filtered = list;
    // Prefer standard outfits first, keep all non-still outfits available
    filtered.sort((a, b) => {
      const rank = (c) => (c.costume === "casual_spring_01" ? 0
        : c.costume === "live_01" ? 1
        : /^school_(?:winter|summer)_hs/.test(c.costume || "") ? 2
        : c.isStillOrMask ? 9 : 4);
      return rank(a) - rank(b);
    });
    return { name, bandIdx: bandIdx === -1 ? 99 : bandIdx, list: filtered };
  });

  // Preserve relative order within same band; keep main bands grouped cleanly
  entries.sort((a, b) => a.bandIdx - b.bandIdx);
  for (const e of entries) ordered.set(e.name, e.list);
  return ordered;
};

const stageCategoryOf = (s) => {
  const hay = `${s.name || ""} ${(s.tags || []).join(" ")}`;
  if (/Live House|LiveHouse|Nest|舞台|剧场|排练|录音|车库|试音/.test(hay)) return "Live 与排练";
  if (/学园|学院|教室|学校|校门|天台|操场|走廊|换鞋|社团/.test(hay)) return "校园与社团";
  if (/咖啡|餐厅|食堂|拉面|寿司|餐饮/.test(hay)) return "餐饮与聚会";
  if (/房间|卧室|客厅|宿舍|居家|别墅|洋馆|古堡|厨房/.test(hay)) return "居家与室内";
  if (/街头|街道|车站|站台|公园|商店街|海|港口|天桥|停车场|广场|道路/.test(hay)) return "街道与户外";
  return "其他场景";
};

export const selectPromptStages = (stages = [], {
  query = "",
  castBands = [],
  baseIds = new Set(),
  limit = 64,
} = {}) => {
  const eligible = stages.filter((s) => s && s.kind !== "title");
  if (!eligible.length) return [];
  const { tokens } = extractQueryTokens({ prompt: query });
  const bandSet = new Set((castBands || []).filter(Boolean));

  const scored = eligible.map((s, idx) => {
    const hay = `${s.id} ${s.name || ""} ${s.caption || ""} ${(s.tags || []).join(" ")} ${s.description || ""} ${s.band || ""}`;
    let score = matchScore(hay, tokens);
    if (s.band && bandSet.has(s.band)) score += 6;
    else if (s.kind === "shared") score += 3;
    if (baseIds.has(s.id)) score += 2;
    return { stage: s, cat: stageCategoryOf(s), score, idx };
  });

  // Group into balanced buckets, sort each bucket by score desc then original index
  const byCat = new Map();
  for (const item of scored) {
    if (!byCat.has(item.cat)) byCat.set(item.cat, []);
    byCat.get(item.cat).push(item);
  }
  for (const list of byCat.values()) {
    list.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  }

  const catOrder = ["Live 与排练", "校园与社团", "餐饮与聚会", "居家与室内", "街道与户外", "其他场景"];
  const picked = [];
  const pickedIds = new Set();
  const perCatFloor = Math.max(4, Math.floor(limit / 6));

  for (const cat of catOrder) {
    for (const item of (byCat.get(cat) || []).slice(0, perCatFloor)) {
      if (picked.length < limit && !pickedIds.has(item.stage.id)) {
        picked.push(item.stage);
        pickedIds.add(item.stage.id);
      }
    }
  }
  const rest = scored.filter((x) => !pickedIds.has(x.stage.id)).sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  for (const item of rest) {
    if (picked.length >= limit) break;
    picked.push(item.stage);
    pickedIds.add(item.stage.id);
  }
  return picked;
};

export const formatCategorizedStages = (stages = [], opts = {}) => {
  const picked = selectPromptStages(stages, opts);
  if (!picked.length) return "(none)";
  const catOrder = ["Live 与排练", "校园与社团", "餐饮与聚会", "居家与室内", "街道与户外", "其他场景"];
  const groups = new Map();
  for (const s of picked) {
    const cat = stageCategoryOf(s);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(s);
  }
  const sections = [];
  for (const cat of catOrder) {
    const items = groups.get(cat);
    if (!items?.length) continue;
    sections.push(`### ${cat}\n${items.map(stageLine).join("\n")}`);
  }
  return sections.join("\n");
};

const bgmMoodCategory = (m) => {
  const hay = `${m.mood || ""} ${m.use || ""} ${m.name || ""}`;
  if (/搞笑|喜剧|闹腾|滑稽|警报|调皮|荒诞/.test(hay)) return "轻快与喜剧";
  if (/紧张|不安|悬疑|神秘|压迫|危机|焦躁|严肃|压抑/.test(hay)) return "紧张与悬疑";
  if (/安静|寂寞|忧郁|悲伤|沉重|失落|冷清|孤独|哀愁/.test(hay)) return "安静与忧郁";
  if (/摇滚|激昂|热血|燃|抗争|电子|游戏|人声/.test(hay)) return "燃曲与演出";
  if (/认真|希望|憧憬|温柔|释然|余韵|感动|回忆|怀旧|抒情/.test(hay)) return "认真与抒情";
  return "温暖与日常";
};

export const selectPromptMusic = (music = [], { query = "", tone = "", limit = 91 } = {}) => {
  if (!music.length) return [];
  const { tokens } = extractQueryTokens({ prompt: query, tone });
  const scored = music.map((m, idx) => {
    const hay = `${m.cue} ${m.name || ""} ${m.mood || ""} ${m.use || ""} ${m.tempo || ""}`;
    return { item: m, cat: bgmMoodCategory(m), score: matchScore(hay, tokens), idx };
  });
  if (music.length <= limit) {
    return scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx)).map((x) => x.item);
  }
  const byCat = new Map();
  for (const x of scored) {
    if (!byCat.has(x.cat)) byCat.set(x.cat, []);
    byCat.get(x.cat).push(x);
  }
  for (const list of byCat.values()) list.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  const picked = [];
  const seen = new Set();
  const cats = ["温暖与日常", "认真与抒情", "轻快与喜剧", "安静与忧郁", "紧张与悬疑", "燃曲与演出"];
  const floor = Math.max(4, Math.floor(limit / cats.length));
  for (const cat of cats) {
    for (const x of (byCat.get(cat) || []).slice(0, floor)) {
      if (picked.length < limit && !seen.has(x.item.cue)) {
        picked.push(x.item);
        seen.add(x.item.cue);
      }
    }
  }
  for (const x of scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx))) {
    if (picked.length >= limit) break;
    if (!seen.has(x.item.cue)) {
      picked.push(x.item);
      seen.add(x.item.cue);
    }
  }
  return picked;
};

export const formatCategorizedMusic = (music = [], opts = {}) => {
  const picked = selectPromptMusic(music, opts);
  if (!picked.length) return "(none)";
  const cats = ["温暖与日常", "认真与抒情", "轻快与喜剧", "安静与忧郁", "紧张与悬疑", "燃曲与演出"];
  const groups = new Map();
  for (const m of picked) {
    const cat = bgmMoodCategory(m);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(m);
  }
  const out = [];
  for (const cat of cats) {
    const list = groups.get(cat);
    if (list?.length) out.push(`### ${cat}\n${list.map(musicLine).join("\n")}`);
  }
  return out.join("\n");
};

export const selectPromptSounds = (sounds = [], { query = "", tone = "", dialogue = null, limit = 72 } = {}) => {
  if (!sounds.length) return [];
  const { tokens } = extractQueryTokens({ prompt: query, tone, dialogue });
  const scored = sounds.map((s, idx) => {
    const hay = `${s.cue} ${s.label || ""} ${s.name || ""} ${s.category || ""} ${s.use || ""}`;
    return { item: s, cat: s.category || "其他音效", score: matchScore(hay, tokens), idx };
  });
  if (sounds.length <= limit) {
    return scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx)).map((x) => x.item);
  }
  const byCat = new Map();
  for (const x of scored) {
    if (!byCat.has(x.cat)) byCat.set(x.cat, []);
    byCat.get(x.cat).push(x);
  }
  for (const list of byCat.values()) list.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  const picked = [];
  const seen = new Set();
  // First take top query-relevant sounds across the board
  for (const x of [...scored].sort((a, b) => (b.score - a.score) || (a.idx - b.idx))) {
    if (x.score <= 0 || picked.length >= Math.floor(limit * 0.55)) break;
    picked.push(x.item);
    seen.add(x.item.cue);
  }
  // Then guarantee broad category representation
  const cats = [...byCat.keys()];
  const perCat = Math.max(2, Math.floor((limit - picked.length) / Math.max(1, cats.length)));
  for (const cat of cats) {
    let added = 0;
    for (const x of byCat.get(cat)) {
      if (picked.length >= limit || added >= perCat) break;
      if (!seen.has(x.item.cue)) {
        picked.push(x.item);
        seen.add(x.item.cue);
        added++;
      }
    }
  }
  for (const x of scored) {
    if (picked.length >= limit) break;
    if (!seen.has(x.item.cue)) {
      picked.push(x.item);
      seen.add(x.item.cue);
    }
  }
  return picked;
};

export const formatCategorizedSounds = (sounds = [], opts = {}) => {
  const picked = selectPromptSounds(sounds, opts);
  if (!picked.length) return "(none)";
  const groups = new Map();
  for (const s of picked) {
    const cat = s.category || "通用音效";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(s);
  }
  return [...groups.entries()].map(([cat, list]) => `### ${cat}\n${list.map(soundLine).join("\n")}`).join("\n");
};

export const formatFxChoices = ({ frames = [], postEffects = [], transitions = [], frameLimit = 36, peLimit = 24, transLimit = 16 } = {}) => ({
  frameLines: frames.slice(0, frameLimit).map(frameLine).join("\n") || "(none)",
  postEffectLines: postEffects.slice(0, peLimit).map(postEffectLine).join("\n") || "(none)",
  transitionLines: transitions.slice(0, transLimit).map(transitionLine).join("\n") || "(none)",
});
