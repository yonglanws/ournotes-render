// Story scripts: the document an author writes to make a dialogue story with the stages, music, story UI and Live2D
// models of a story site, its checks and its compilation into the story player's data (docs/story-author.md).
//
// A script (format SCRIPT_FORMAT) names a base story of the site (`base`: the path of its story manifest) whose
// stages, music, story UI and player settings it uses, the language of its texts, the font family the browser draws
// them with, the cast (models of the site's models.json and the names they speak under) and the beats in order.
// parseScript checks the document's shape; checkScript checks its names against the site (stages, music, models,
// motions, expressions) and the staging (positions, speakers on stage). Every problem names the JSON pointer of the
// value, an unknown name comes with the names that exist and the nearest one, and a problem with a known fix carries it
// as JSON Patch operations (applyFixes applies them; layoutFix makes the fix of a line that overflows the talk
// window). compileScript turns a script without errors into the episode's command rows (episode.json) and the story
// index (story.json).

import { componentClass } from "../../../src/engine/prefab.js";
import { ADV_COMMAND } from "../../../src/story/interfaces.js";
import { STORY_LANGUAGES } from "../../../src/story/params.js";
import {
  ANGLE_MAX, ANGLE_MIN, BEAT_KEYS, CAMERAS, DEFAULT_OFFICIAL_DURATION, DISSOLVE_DEFAULT, DISSOLVE_MAX,
  DISSOLVE_MIN, EASES, EASE_MAP, FADE_COLORS, FADE_DIRECTIONS, FADE_RULES, FOCUS_POINT_MAX, FOCUS_POINT_MIN,
  FONT_PRESETS, FRAME_ACTIONS, FRAME_PATTERN, HIDE_TALK_PAUSE_THRESHOLD, KINDS, LOOK_MAX, LOOK_MIN, LOOK_STOP,
  MAX_ACTIONS, MAX_ACTION_PAUSE, MAX_CAMERA_DURATION, MAX_PAUSE, MOVE_DIRECTIONS, MUSIC_STOP, OFFICIAL_DURATION_MAX,
  PAN_MAX, PAN_MIN, PEDESTAL_MAX, PEDESTAL_MIN, POSITIONS, POST_EFFECT_PATTERN, ROLE_MAX, ROLE_MIN,
  SCENE_TRANSITIONS, SCRIPT_FORMAT, SHAKE_POWER_MAX, SHAKE_POWER_MIN, SIDE, SLOT_WORLD_X, STAGE_ENV_TYPES,
  TALK_WINDOWS, TILT_MAX, TILT_MIN, TRACK_MAX, TRACK_MIN, ZOOM_MAX, ZOOM_MIN,
  clampTrack, easeFor, hasSpokenContent, transitionAssetName,
} from "./grammar.js";

export {
  ANGLE_MAX, ANGLE_MIN, CAMERAS, DEFAULT_OFFICIAL_DURATION, EASES, FADE_COLORS, FADE_DIRECTIONS, FADE_RULES,
  FOCUS_POINT_MAX, FOCUS_POINT_MIN, FONT_PRESETS, LOOK_MAX, LOOK_MIN, LOOK_STOP, MAX_ACTIONS, MOVE_DIRECTIONS,
  MUSIC_STOP, OFFICIAL_DURATION_MAX, PAN_MAX, PAN_MIN, PEDESTAL_MAX, PEDESTAL_MIN, POSITIONS, ROLE_MAX, ROLE_MIN,
  SCENE_TRANSITIONS, SCRIPT_FORMAT, SHAKE_POWER_MAX, SHAKE_POWER_MIN, SLOT_WORLD_X, STAGE_ENV_TYPES, TALK_WINDOWS,
  TILT_MAX, TILT_MIN, TRACK_MAX, TRACK_MIN, ZOOM_MAX, ZOOM_MIN,
  clampTrack, easeFor, hasSpokenContent, transitionAssetName,
};

// The name of the position nearest `slot` that `occupied` (a set of position values) does not hold, or null when every
// position is taken. -> "far-left" | "left" | "center" | "right" | "far-right"
export const freeSlot = (slot, occupied) =>
  Object.keys(POSITIONS).sort((a, b) => Math.abs(POSITIONS[a] - slot) - Math.abs(POSITIONS[b] - slot) || POSITIONS[a] - POSITIONS[b])
    .find((k) => !occupied.has(POSITIONS[k])) || null;

const NAME_COLOR = "#FFFFFF";
const SCENE_FADE = 1;                                          // seconds of the fade between scenes
const CAST_FADE = 0.2;                                         // seconds a character takes to enter or leave
// A Motion / Expression row without MotionFadeIn plays with a 0 s fade: the player replaces the current pose with the
// new clip's first frame and the switch snaps. -1 uses the motion's own FadeInTime from the game's fade data (1 s for
// the MyGO motions), so a new motion cross-fades from the pose on screen.
const MOTION_FADE = -1;
const FOCUS_MOVE = 0.5;                                        // seconds the camera takes to follow a positions beat
// The official episodes cut in to a closer shot (no Duration) and ease back out over about 1.2 s; a lateral move at
// the same distance is a short 0.5 s pan, except between close-ups, which cut.
const FOCUS_RETURN = 1.2;
const FOCUS_PAN = 0.5;
const BGM_FADE = "1.5";
const TITLE_ID = "custom_title";
const CAST_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

// The browser's font families (CSS font-family lists) of the font presets, per story language.
export const FONT_FAMILIES = Object.freeze({
  sans: {
    ja: "\"Noto Sans JP\", \"Hiragino Sans\", \"Yu Gothic UI\", \"Yu Gothic\", Meiryo, sans-serif",
    en: "\"Noto Sans\", \"Segoe UI\", \"Helvetica Neue\", Arial, sans-serif",
    "zh-Hant": "\"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif",
    "zh-Hans": "\"Noto Sans SC\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    ko: "\"Noto Sans KR\", \"Apple SD Gothic Neo\", \"Malgun Gothic\", sans-serif",
  },
  serif: {
    ja: "\"Noto Serif JP\", \"Hiragino Mincho ProN\", \"Yu Mincho\", serif",
    en: "\"Noto Serif\", Georgia, \"Times New Roman\", serif",
    "zh-Hant": "\"Noto Serif TC\", \"Songti TC\", PMingLiU, serif",
    "zh-Hans": "\"Noto Serif SC\", \"Songti SC\", SimSun, serif",
    ko: "\"Noto Serif KR\", \"AppleMyungjo\", Batang, serif",
  },
  rounded: {
    ja: "\"M PLUS Rounded 1c\", \"Hiragino Maru Gothic ProN\", \"Yu Gothic UI\", sans-serif",
    en: "Nunito, \"Varela Round\", \"Arial Rounded MT Bold\", sans-serif",
    "zh-Hant": "\"Yuanti TC\", \"Microsoft JhengHei\", sans-serif",
    "zh-Hans": "\"Yuanti SC\", YouYuan, \"Microsoft YaHei\", sans-serif",
    ko: "\"NanumSquareRound\", \"Malgun Gothic\", sans-serif",
  },
});

// the CSS font-family list a script's texts are drawn with (`language`: the story language it plays in)
export const fontFamily = (font, language) => (font && font.family) || FONT_FAMILIES[(font && font.preset) || "sans"][language];

// ------------------------------------------------------------------------------------------------ names

// a JSON pointer token
const tok = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");

const distance = (a, b) => {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
};

// the name of `names` nearest to `name` (case-insensitive edit distance, at most a third of its length), or null
export const nearest = (name, names) => {
  const s = String(name).toLowerCase();
  let best = null, bd = Infinity;
  for (const n of names) {
    const d = distance(s, String(n).toLowerCase());
    if (d < bd) { bd = d; best = n; }
  }
  return best !== null && bd <= Math.max(2, Math.floor(s.length / 3)) ? best : null;
};

const EXPECTED_MAX = 40;
export const byName = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });

// the JSON Patch operation that renames the object key at `path` to `key`
const renameOp = (path, key) => ({ op: "move", from: path, path: `${path.slice(0, path.lastIndexOf("/"))}/${tok(key)}` });

// An error about a name that is not one of `names` (`where`: what holds them, if not the script): the names (up to
// EXPECTED_MAX) and the nearest one, with the fix that writes it in: `fix` "replace" (the name is the value at
// `path`), "rename" (the name is the key at `path`) or null (no fix).
const unknown = (path, code, what, name, names, where = "", fix = "replace") => {
  const list = [...names], near = nearest(name, list);
  return { path, code, message: `${what} ${JSON.stringify(name)} does not exist${where ? ` in ${where}` : ""}` +
           (list.length ? (near ? `; did you mean ${JSON.stringify(near)}?` : "") : ` (${where || "it"} has none)`),
           ...(list.length <= EXPECTED_MAX ? { expected: list } : { expectedCount: list.length }),
           ...(near ? { suggestion: near } : {}),
           ...(near && fix ? { fix: [fix === "rename" ? renameOp(path, near) : { op: "replace", path, value: near }] } : {}) };
};

// ------------------------------------------------------------------------------------------------ text

const LT_FULLWIDTH = String.fromCharCode(0xFF1C);
const WORD_JOINER = String.fromCharCode(0x2060);
const str = (v) => (typeof v === "string" ? v : "");

// An author's text as TextMeshPro rich text that shows it as written: "<" becomes the full-width less-than sign
// (U+FF1C), since the talk window's typewriter counts the characters of the text with every "<...>" removed; a word
// joiner (U+2060, zero width, no break) after every "\" keeps it from starting an escape; line breaks are line feeds.
export const plainText = (s) => str(s).replace(/\r\n?/g, "\n").replace(/</g, LT_FULLWIDTH).replace(/\\/g, `\\${WORD_JOINER}`);

// "sound_bgm_adv_the_tender_light" -> "The Tender Light"; "sound_se_adv_door_knock" -> "Door Knock"
export const cueLabel = (cue) => str(cue).replace(/^sound_(?:bgm|se)_(?:adv_)?/i, "").split("_").filter(Boolean)
  .map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// ------------------------------------------------------------------------------------------------ layout fixes

// The word joiner plainText writes after a "\": it is in the text the talk window lays out, not in the script's.
const JOINER = String.fromCharCode(0x2060);

// The lines a text wraps into, as the script writes them: `shown` are the lines of plainText(text) the talk window
// lays out with word wrapping (page.js), each with the line feed that ends it, if any. Apart from the word joiners,
// plainText writes one character for each character of the text, so the two line up character for character. ->
// the lines without the line feeds and the spaces at their ends, or null when `shown` is not the text.
export const wrapText = (text, shown) => {
  const src = [...str(text).replace(/\r\n?/g, "\n")];
  const lines = (shown || []).map((l) => [...l].filter((c) => c !== JOINER));
  const flat = lines.flat();
  if (!lines.length || flat.length !== src.length || flat.join("") !== [...plainText(src.join(""))].filter((c) => c !== JOINER).join(""))
    return null;
  const out = [];
  let at = 0, wrapped = false;
  for (const l of lines) {
    let line = src.slice(at, at + l.length).join("");
    at += l.length;
    if (wrapped) line = line.replace(/^[ \t]+/, "");                   // the space a wrapped line starts after
    wrapped = !line.endsWith("\n");
    out.push(line.replace(/[ \t]*\n?$/, ""));
  }
  return out;
};

// The lines (with the ascender and descender of each: their top and bottom in the text) cut into runs that each fit
// `heightLimit`, as even as the longest run that fits allows: [[from, to), ...], or null when a line alone does not
// fit.
export const lineGroups = (asc, desc, heightLimit) => {
  const fits = (a, b) => asc[a] - desc[b - 1] <= heightLimit + 0.01;
  const n = asc.length;
  let most = 0;
  while (most < n && fits(0, most + 1)) most++;
  if (!most) return null;
  const count = Math.ceil(n / most), size = Math.ceil(n / count), even = [];
  for (let a = 0; a < n; a += size) even.push([a, Math.min(n, a + size)]);
  if (even.every(([a, b]) => fits(a, b))) return even;
  const greedy = [];
  for (let a = 0; a < n;) {
    let b = a + 1;
    if (!fits(a, b)) return null;
    while (b < n && fits(a, b + 1)) b++;
    greedy.push([a, b]);
    a = b;
  }
  return greedy;
};

// The fix of a line whose text does not fit the talk window: its text broken where TextMeshPro wraps it and, where
// the window holds fewer lines, spread over beats of the same speaker after it. `beat`: the beat as the script writes
// it (say or narrate) at `index`; `wrap`: {lines, asc, desc} of its text laid out with word wrapping (page.js: null
// when a line stays wider than the window); `heightLimit`: the room the window has. -> {texts, fix}, or null when the
// text as written already fits or breaking it does not help (a single line taller than the window).
export const layoutFix = ({ beat, index, wrap, heightLimit }) => {
  const key = "say" in beat ? "text" : "narrate", text = beat[key];
  if (!wrap) return null;
  const lines = wrapText(text, wrap.lines), groups = lines && lineGroups(wrap.asc, wrap.desc, heightLimit);
  if (!groups) return null;
  const texts = groups.map(([a, b]) => lines.slice(a, b).join("\n"));
  const fix = [];
  if (texts[0] !== text) fix.push({ op: "replace", path: `/beats/${index}/${key}`, value: texts[0] });
  texts.slice(1).forEach((t, i) => fix.push({ op: "add", path: `/beats/${index + 1 + i}`,
                                               value: key === "text" ? { say: beat.say, text: t } : { narrate: t } }));
  return fix.length ? { texts, fix } : null;
};

// ------------------------------------------------------------------------------------------------ applying fixes

// The JSON Patch operations of the fixes (RFC 6902): replace, add, and move of an object key to another key of the
// same object (a rename, which keeps the key's place). -> null, or why `op` cannot be applied to `doc`.
const applyOp = (doc, op) => {
  const tokens = (p) => str(p).split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  const parentOf = (ts) => {
    let o = doc;
    for (const t of ts.slice(0, -1)) o = o && typeof o === "object" ? o[t] : undefined;
    return o && typeof o === "object" ? o : null;
  };
  const ts = tokens(op.path), key = ts[ts.length - 1], parent = parentOf(ts);
  if (!parent) return `${op.path} does not exist`;
  const index = Array.isArray(parent) && /^\d+$/.test(key) ? Number(key) : -1;
  if (op.op === "replace") {
    if (Array.isArray(parent) ? index < 0 || index >= parent.length : !(key in parent)) return `${op.path} does not exist`;
    parent[Array.isArray(parent) ? index : key] = op.value;
    return null;
  }
  if (op.op === "add") {
    if (!Array.isArray(parent)) { parent[key] = op.value; return null; }
    if (index < 0 || index > parent.length) return `${op.path} is not a place in the array`;
    parent.splice(index, 0, op.value);
    return null;
  }
  if (op.op === "move") {
    const from = tokens(op.from);
    if (Array.isArray(parent) || parentOf(from) !== parent) return "a move other than renaming a key is not supported";
    const old = from[from.length - 1];
    if (!(old in parent)) return `${op.from} does not exist`;
    if (key !== old && key in parent) return `${op.path} exists already`;
    const entries = Object.entries(parent).map(([k, v]) => [k === old ? key : k, v]);
    for (const k of Object.keys(parent)) delete parent[k];
    for (const [k, v] of entries) parent[k] = v;
    return null;
  }
  return `operation ${JSON.stringify(op.op)} is not supported`;
};

// the beat a JSON pointer is in (-1: none)
const beatOf = (path) => Number((/^\/beats\/(\d+)/.exec(str(path)) || [])[1] ?? -1);

// The script document with the fixes of `problems` applied, later beats first (the fix of a line that does not fit
// adds beats after it, which moves the beats after those). -> {script, applied: [{path, code}], failed: [{path, code,
// message}]}
export const applyFixes = (doc, problems) => {
  const script = JSON.parse(JSON.stringify(doc)), applied = [], failed = [];
  const fixes = (problems || []).filter((p) => Array.isArray(p.fix) && p.fix.length).sort((a, b) => beatOf(b.path) - beatOf(a.path));
  for (const p of fixes) {
    let why = null;
    for (const op of p.fix) if ((why = applyOp(script, op))) break;
    (why ? failed : applied).push({ path: p.path, code: p.code, ...(why ? { message: why } : {}) });
  }
  return { script, applied, failed };
};

// ------------------------------------------------------------------------------------------------ the base story

// The music of a base story: the sound rows of its episode whose cue sheet is a BGM sheet the story has the sound
// files of (story.json audio) -> [{cue, label, sound, sheet}], by cue name.
export const musicChoices = (episode, story) => {
  const audio = story?.parts?.sounds || {}, out = new Map();
  for (const [id, row] of Object.entries((episode && episode.sounds) || {})) {
    const sheet = episode.cuesheets && episode.cuesheets[row._soundCueSheetID];
    const name = sheet && sheet._cueSheetName;
    if (!name || !/^sound_bgm/i.test(name) || !audio[name] || !row._cueName || out.has(row._cueName)) continue;
    out.set(row._cueName, { cue: row._cueName, label: cueLabel(row._cueName), sound: Number(id), sheet: name });
  }
  return [...out.values()].sort((a, b) => a.cue.localeCompare(b.cue));
};

// The SE cues of a base story: the sound rows whose cue sheet is an SE sheet the story has the sound files of
// (story.json parts.sounds) -> [{cue, label, sound, sheet}], by cue name. A sheet may hold several cue names.
export const soundChoices = (episode, story) => {
  const audio = story?.parts?.sounds || {}, out = new Map();
  for (const [id, row] of Object.entries((episode && episode.sounds) || {})) {
    const sheet = episode.cuesheets && episode.cuesheets[row._soundCueSheetID];
    const name = sheet && sheet._cueSheetName;
    if (!name || !/^sound_se/i.test(name) || !audio[name] || !row._cueName || out.has(row._cueName)) continue;
    out.set(row._cueName, { cue: row._cueName, label: cueLabel(row._cueName), sound: Number(id), sheet: name });
  }
  return [...out.values()].sort((a, b) => a.cue.localeCompare(b.cue));
};

// The stages of a base story: [{id, key, caption}] in the order its episode sets them (the others last, by key). The
// id is the key's last segment, or the whole key where two keys end alike; the caption is the first location caption
// (in `language`) the episode shows while that stage is set, or "".
export const stageChoices = (assets, episode, language) => {
  const field = STORY_LANGUAGES[language];
  const keys = Object.keys(assets || {}).filter((k) => k.startsWith("Adv/Stage/")).map((k) => k.slice(10)), captions = new Map(), order = [];
  let cur = null;
  for (const c of (episode && episode.commands) || []) {
    if (c.IgnoreData) continue;
    if (c.cmd === "Stage" && keys.includes(c.TargetAssetName)) { cur = c.TargetAssetName; if (!order.includes(cur)) order.push(cur); }
    else if (c.cmd === "Location" && cur && !captions.has(cur)) {
      const id = c.AdvTextID || (c.TargetTextIDs || [])[0];
      const t = (c.lines && c.lines[field]) || (episode.text && episode.text[id] && episode.text[id][field]) || "";
      if (t) captions.set(cur, t.replace(/<[^>]*>/g, "").trim());
    }
  }
  for (const k of [...keys].sort()) if (!order.includes(k)) order.push(k);
  const last = (k) => k.split("/").pop();
  const count = new Map();
  for (const k of keys) count.set(last(k), (count.get(last(k)) || 0) + 1);
  return order.map((key) => ({ id: count.get(last(key)) > 1 ? key : last(key), key, caption: captions.get(key) || "" }));
};

// The Texture2D object id of the stage's background Sprite, or null.
export const stageBackground = (prefab, objects) => {
  const stage = prefab.find("AdvStage").c.fields;
  return objects.sprite(stage._backgroundSprite)?.texture.id || null;
};

// ------------------------------------------------------------------------------------------------ models

// The motions and expressions of a model (`model`: its model.json; `assets`: the AssetStore of its objects), from the
// Live2DCharacter component of its prefab's root: {motions: the names of its clips, expressions, defaultMotion,
// defaultExpression}.
export const modelActions = (assets, model) => {
  const root = assets.prefab(model.prefab).nodes[0];
  const ch = root && root.components.find((c) => componentClass(c) === "Live2DCharacter");
  if (!ch) throw new Error("the model prefab has no Live2DCharacter");
  const f = ch.fields;
  return { motions: (f._motionList || []).map((r) => assets.clip(assets.ref(r, "AnimationClip")).name),
           expressions: [...(f._expressionList || [])],
           defaultMotion: f.DefaultMotionName || "", defaultExpression: f.DefaultExpressionName || "" };
};

// "mtn_smile02_L" -> {stem: "mtn_smile02", side: "L"}; a name without a side is its own stem
export const motionStem = (name) => {
  const m = /^(.*)_([LCR])$/.exec(str(name));
  return m ? { stem: m[1], side: m[2] } : { stem: str(name), side: "" };
};

// the motion stems of a list of motion names, in first-seen order
export const motionStems = (names) => [...new Set((names || []).map((n) => motionStem(n).stem))];

// The clip a motion of a script plays on `slot`: a clip name of the model as it is; a stem, the variant facing the
// slot's side, else the centre one, else the stem itself, else any variant. "" when the model has none of these.
export const resolveMotion = (motion, slot, motions) => {
  if (!motion) return "";
  if (motions.includes(motion) && motionStem(motion).side) return motion;
  for (const n of [`${motion}_${SIDE[slot] || "C"}`, `${motion}_C`, motion]) if (motions.includes(n)) return n;
  return motions.find((n) => motionStem(n).stem === motion) || "";
};

// ------------------------------------------------------------------------------------------------ fonts

// The base story's font product with every font asset drawn by the browser in `family` (the story player's browser
// fonts): the asset keeps its point size, padding, render mode, style settings, line metrics and fallbacks; its
// characters and glyphs are made as texts use them, so every character of the family shows (no missing glyph). The
// glyph cell margin keeps the room the asset's text materials need for their underlay offset.
export const withBrowserFonts = (fonts, family) => {
  const out = JSON.parse(JSON.stringify(fonts));
  for (const [name, f] of Object.entries(out.fonts || {})) {
    const gs = f.atlasPadding + 1;
    const margin = f.source && f.source.generator && f.source.generator.margin;
    let underlay = Number.isFinite(margin) ? Math.max(0, (margin - Math.ceil(gs) - 1) / gs) : 0;
    for (const [mname, m] of Object.entries(out.materials || {})) {
      if (!mname.startsWith(name) || !m.floats) continue;
      underlay = Math.max(underlay, Math.abs(m.floats._UnderlayOffsetX || 0), Math.abs(m.floats._UnderlayOffsetY || 0));
    }
    // A story's own dialogue shares this page with every UI text, so a 2048 square fills after ~200 CJK glyphs and
    // the renderer then refuses the episode as "missing" characters. 4096 holds a full short episode's vocabulary.
    f.browser = { family, pageWidth: 4096, pageHeight: 4096,
                  ...(underlay > 0 ? { underlayOffset: underlay } : {}) };
    f.characters = {};
    f.glyphs = {};
    delete f.missingGlyph;
  }
  if (out.coverage) {
    out.coverage.characters = 0; out.coverage.missing = [];
    delete out.coverage.missingGlyph;
  }
  return out;
};

// ------------------------------------------------------------------------------------------------ parsing

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const TOP_KEYS = ["format", "base", "language", "title", "font", "cast", "beats"];

// The shape of a script: -> {script, errors, warnings}. `script` is the document with every value checked for its type
// and form (a value with an error is left out); errors: [{path, code, message, ...}].
export const parseScript = (doc) => {
  const errors = [], warnings = [];
  const err = (path, code, message, extra = {}) => errors.push({ path, code, message, ...extra });
  const keys = (o, allowed, path) => {
    for (const k of Object.keys(o)) {
      if (allowed.includes(k)) continue;
      const near = nearest(k, allowed), kp = `${path}/${tok(k)}`;
      err(kp, "unknownKey", `unknown key ${JSON.stringify(k)}` + (near ? `; did you mean ${JSON.stringify(near)}?` : ""),
          { expected: allowed, ...(near ? { suggestion: near } : {}), ...(near && !(near in o) ? { fix: [renameOp(kp, near)] } : {}) });
    }
  };
  const text = (o, k, path, { required = false, empty = false } = {}) => {
    if (!(k in o)) { if (required) err(path, "missing", `${path.split("/").pop()} is required`); return undefined; }
    if (typeof o[k] !== "string") { err(path, "type", `${path.split("/").pop()} must be a string`); return undefined; }
    if (!empty && !o[k].trim()) { err(path, "empty", `${path.split("/").pop()} is empty`); return undefined; }
    return o[k];
  };
  const named = (v, table, path, code, what) => {
    if (typeof v !== "string") { err(path, "type", `${what} must be a string`, { expected: Object.keys(table) }); return undefined; }
    if (!(v in table)) { errors.push(unknown(path, code, what, v, Object.keys(table))); return undefined; }
    return table[v];
  };
  const numberOf = (o, k, path, { min = 0, max = Infinity, defaultValue = undefined, what = k, integer = false } = {}) => {
    if (!(k in o)) return defaultValue;
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v) || (integer && !Number.isInteger(v))) {
      err(path, "type", `${what} must be ${integer ? "an integer" : "a number"}`);
      return undefined;
    }
    if (v < min || v > max) { err(path, "range", `${what} must be between ${min} and ${max}`); return undefined; }
    return v;
  };
  const booleanOf = (o, k, path, what = k) => {
    if (!(k in o)) return undefined;
    if (typeof o[k] !== "boolean") { err(path, "type", `${what} must be a boolean`); return undefined; }
    return o[k];
  };
  const targetOf = (o, k, path, what = k, { allowStop = false } = {}) => {
    if (!(k in o)) return "";
    const v = o[k];
    if (allowStop && v === LOOK_STOP) return LOOK_STOP;
    if (typeof v === "number") {
      if (Number.isInteger(v) && v >= FOCUS_POINT_MIN && v <= FOCUS_POINT_MAX) return v;
      err(path, "range", `${what} must be a focus point ${FOCUS_POINT_MIN}..${FOCUS_POINT_MAX}, a position or a cast id`);
      return "";
    }
    if (typeof v !== "string") {
      err(path, "type", `${what} must be a cast id, a position or a focus point ${FOCUS_POINT_MIN}..${FOCUS_POINT_MAX}`);
      return "";
    }
    return v;
  };
  const trackOf = (o, k, path) => {
    if (!(k in o)) return undefined;
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) { err(path, "type", `${k} must be a number`); return undefined; }
    if (v < TRACK_MIN || v > TRACK_MAX) { err(path, "range", `${k} must be between ${TRACK_MIN} and ${TRACK_MAX}`); return undefined; }
    return v;
  };
  const zoomOf = (b, path) => {
    const zoom = numberOf(b, "zoom", `${path}/zoom`, { min: ZOOM_MIN, max: ZOOM_MAX, what: "zoom" });
    const duration = numberOf(b, "zoomDuration", `${path}/zoomDuration`,
                              { min: 0.2, max: OFFICIAL_DURATION_MAX, what: "zoomDuration" });
    if (duration !== undefined && zoom === undefined) err(`${path}/zoom`, "empty", "zoomDuration needs a zoom");
    return { zoom, duration };
  };
  const dofLayersOf = (o, path) => {
    if (!("dofLayers" in o)) return undefined;
    const v = o.dofLayers;
    if (typeof v !== "number" || !Number.isInteger(v)) { err(`${path}/dofLayers`, "type", "dofLayers must be 0 or 2"); return undefined; }
    if (v !== 0 && v !== 2) { err(`${path}/dofLayers`, "range", "dofLayers must be 0 or 2"); return undefined; }
    return v;
  };

  const castRefOf = (o, k, path, required) => {
    const id = text(o, k, path, { required });
    if (id && !CAST_ID.test(id))
      err(path, "castId", `cast id ${JSON.stringify(id)} must be a letter followed by letters, digits or _`);
    return id || "";
  };

  const parseMove = (raw, path, defaultCast = "") => {
    if (!isObj(raw)) { err(path, "type", "move must be an object {cast?, to?, dir?, dx?, dy?, dz?, distance?, duration?, wait?}"); return null; }
    keys(raw, ["cast", "to", "dir", "dx", "dy", "dz", "distance", "duration", "wait"], path);
    const cast = "cast" in raw ? castRefOf(raw, "cast", `${path}/cast`, !defaultCast) : defaultCast;
    if (!cast && !defaultCast) err(`${path}/cast`, "missing", "cast is required on a standalone move beat");
    const to = "to" in raw ? named(raw.to, POSITIONS, `${path}/to`, "unknownPosition", "position") : undefined;
    const dir = "dir" in raw ? named(raw.dir, MOVE_DIRECTIONS, `${path}/dir`, "unknownMoveDirection", "move direction") : undefined;
    const dx = numberOf(raw, "dx", `${path}/dx`, { min: -10, max: 10 });
    const dy = numberOf(raw, "dy", `${path}/dy`, { min: -10, max: 10 });
    const dz = numberOf(raw, "dz", `${path}/dz`, { min: -10, max: 10 });
    const distance = numberOf(raw, "distance", `${path}/distance`, { min: 0.01, max: 10 });
    const duration = numberOf(raw, "duration", `${path}/duration`, { min: 0, max: OFFICIAL_DURATION_MAX });
    const wait = booleanOf(raw, "wait", `${path}/wait`);
    if ("to" in raw && "dir" in raw) err(`${path}/dir`, "exclusive", "to and dir cannot be combined in move");
    if ("to" in raw && "distance" in raw) err(`${path}/distance`, "exclusive", "distance cannot be used with to");
    if ("distance" in raw && !("dir" in raw)) err(`${path}/distance`, "empty", "distance needs a dir");
    if ("dir" in raw) {
      const axis = dir ? MOVE_DIRECTIONS[raw.dir]?.axis : null;
      if (axis === "x" && (dy !== undefined || dz !== undefined)) err(path, "exclusive", "left/right dir cannot mix with dy/dz");
      if (axis === "y" && (dx !== undefined || dz !== undefined)) err(path, "exclusive", "up/down dir cannot mix with dx/dz");
      if (axis === "z" && (dx !== undefined || dy !== undefined)) err(path, "exclusive", "forward/back dir cannot mix with dx/dz");
      const delta = axis === "x" ? dx : axis === "y" ? dy : axis === "z" ? dz : undefined;
      if ("distance" in raw && delta !== undefined) err(`${path}/distance`, "exclusive", "distance and axis offset cannot both be set");
      if (delta === 0) err(`${path}/d${axis}`, "range", `d${axis} for dir ${raw.dir} must be non-zero`);
    } else if (to === undefined && dx === undefined && dy === undefined && dz === undefined) {
      err(path, "empty", "move needs to, dir, dx, dy or dz");
    }
    return {
      ...(cast ? { cast } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(dir ? { dir: raw.dir } : {}),
      ...(dx !== undefined ? { dx } : {}),
      ...(dy !== undefined ? { dy } : {}),
      ...(dz !== undefined ? { dz } : {}),
      ...(distance !== undefined ? { distance } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(wait !== undefined ? { wait } : {}),
      path,
    };
  };

  const parseAngle = (raw, path, defaultCast = "") => {
    if (!isObj(raw)) { err(path, "type", "angle must be an object {cast?, z?, x?, duration?, delay?, wait?}"); return null; }
    keys(raw, ["cast", "z", "x", "duration", "delay", "wait"], path);
    const cast = "cast" in raw ? castRefOf(raw, "cast", `${path}/cast`, !defaultCast) : defaultCast;
    if (!cast && !defaultCast) err(`${path}/cast`, "missing", "cast is required on an angle beat");
    const z = numberOf(raw, "z", `${path}/z`, { min: ANGLE_MIN, max: ANGLE_MAX });
    const x = numberOf(raw, "x", `${path}/x`, { min: ANGLE_MIN, max: ANGLE_MAX });
    const duration = numberOf(raw, "duration", `${path}/duration`, { min: 0, max: OFFICIAL_DURATION_MAX });
    const delay = numberOf(raw, "delay", `${path}/delay`, { min: 0, max: OFFICIAL_DURATION_MAX });
    const wait = booleanOf(raw, "wait", `${path}/wait`);
    if (z === undefined && x === undefined) err(path, "empty", "angle needs z or x");
    return {
      ...(cast ? { cast } : {}),
      ...(z !== undefined ? { z } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(delay !== undefined ? { delay } : {}),
      ...(wait !== undefined ? { wait } : {}),
      path,
    };
  };

  const parseBrightness = (raw, path) => {
    if (!isObj(raw)) { err(path, "type", "brightness must be {target, value, duration?, wait?}"); return null; }
    keys(raw, ["target", "value", "duration", "wait"], path);
    const target = text(raw, "target", `${path}/target`, { required: true });
    if (target && target !== "bg" && target !== "cast" && !CAST_ID.test(target))
      err(`${path}/target`, "castId", `target ${JSON.stringify(target)} must be "bg", "cast", or a valid cast id`);
    if (!("value" in raw)) err(`${path}/value`, "missing", "value is required");
    const value = "value" in raw ? numberOf(raw, "value", `${path}/value`, { min: 0, max: 1 }) : undefined;
    const duration = numberOf(raw, "duration", `${path}/duration`, { min: 0, max: MAX_CAMERA_DURATION });
    const wait = booleanOf(raw, "wait", `${path}/wait`);
    return target !== undefined && value !== undefined
      ? { target, value, ...(duration !== undefined ? { duration } : {}), ...(wait !== undefined ? { wait } : {}), path }
      : null;
  };

  const parseShake = (raw, path) => {
    if (!isObj(raw)) { err(path, "type", "shake must be {target?, power, duration?, wait?}"); return null; }
    keys(raw, ["target", "power", "duration", "wait"], path);
    const target = "target" in raw ? text(raw, "target", `${path}/target`) : "all";
    if (target && target !== "ui" && target !== "stage" && target !== "all" && !CAST_ID.test(target))
      err(`${path}/target`, "castId", `shake target ${JSON.stringify(target)} must be "ui", "stage", "all", or a cast id`);
    if (!("power" in raw)) err(`${path}/power`, "missing", "power is required");
    const power = "power" in raw ? numberOf(raw, "power", `${path}/power`, { min: SHAKE_POWER_MIN, max: SHAKE_POWER_MAX }) : undefined;
    const duration = numberOf(raw, "duration", `${path}/duration`, { min: 0.05, max: MAX_CAMERA_DURATION, defaultValue: 0.5 });
    const wait = booleanOf(raw, "wait", `${path}/wait`);
    return power !== undefined
      ? { target: target || "all", power, duration: duration ?? 0.5, ...(wait !== undefined ? { wait } : {}), path }
      : null;
  };

  const parseFlash = (raw, path) => {
    if (raw === true) return { duration: 0.3, path };
    if (!isObj(raw)) { err(path, "type", "flash must be true or {duration?, wait?}"); return null; }
    keys(raw, ["duration", "wait"], path);
    const duration = numberOf(raw, "duration", `${path}/duration`, { min: 0.05, max: 5, defaultValue: 0.3 });
    const wait = booleanOf(raw, "wait", `${path}/wait`);
    return { duration: duration ?? 0.3, ...(wait !== undefined ? { wait } : {}), path };
  };

  const parseStageEnv = (raw, path) => {
    if (!isObj(raw)) { err(path, "type", "stageEnv must be {type, value}"); return null; }
    keys(raw, ["type", "value"], path);
    const type = "type" in raw
      ? named(raw.type, STAGE_ENV_TYPES, `${path}/type`, "unknownStageEnvType", "stageEnv type")
      : (err(`${path}/type`, "missing", "type is required"), undefined);
    if (!("value" in raw)) err(`${path}/value`, "missing", "value is required");
    const value = "value" in raw ? numberOf(raw, "value", `${path}/value`, { min: 0, max: 5, integer: true }) : undefined;
    return type && value !== undefined ? { type, value, path } : null;
  };

  const parseStill = (raw, path) => {
    if (!isObj(raw)) { err(path, "type", "still must be {asset?, fade?, alpha?, screenAlpha?, index?, stop?}"); return null; }
    keys(raw, ["asset", "fade", "alpha", "screenAlpha", "index", "stop"], path);
    const asset = "asset" in raw ? text(raw, "asset", `${path}/asset`, { empty: true }) : undefined;
    const fade = numberOf(raw, "fade", `${path}/fade`, { min: 0, max: MAX_CAMERA_DURATION });
    const alpha = numberOf(raw, "alpha", `${path}/alpha`, { min: 0, max: 1 });
    const screenAlpha = numberOf(raw, "screenAlpha", `${path}/screenAlpha`, { min: 0, max: 1 });
    const index = numberOf(raw, "index", `${path}/index`, { min: 0, max: 100, integer: true });
    const stop = booleanOf(raw, "stop", `${path}/stop`);
    if (!stop && (!asset || !asset.trim())) err(`${path}/asset`, "missing", "still requires a non-empty asset or stop: true");
    return {
      ...(asset ? { asset } : {}),
      ...(fade !== undefined ? { fade } : {}),
      ...(alpha !== undefined ? { alpha } : {}),
      ...(screenAlpha !== undefined ? { screenAlpha } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(stop !== undefined ? { stop } : {}),
      path,
    };
  };

  const parseSubtitles = (raw, path) => {
    if (!isObj(raw)) { err(path, "type", "subtitles must be {text, target?, duration?, wait?}"); return null; }
    keys(raw, ["text", "target", "duration", "wait"], path);
    const subtitleText = text(raw, "text", `${path}/text`, { required: true, empty: true });
    const target = "target" in raw ? castRefOf(raw, "target", `${path}/target`, false) : undefined;
    const duration = numberOf(raw, "duration", `${path}/duration`, { min: 0.1, max: MAX_PAUSE });
    const wait = booleanOf(raw, "wait", `${path}/wait`);
    if (subtitleText === "" && "duration" in raw)
      err(`${path}/duration`, "exclusive", "duration cannot be used when clearing subtitles with empty text");
    return subtitleText !== undefined
      ? { text: subtitleText, ...(target ? { target } : {}), ...(duration !== undefined ? { duration } : {}), ...(wait !== undefined ? { wait } : {}), path }
      : null;
  };

  // Parse and validate direction/effect modifiers shared across beat kinds.
  const directionOf = (b, beat, path, kind) => {
    const has = (k) => BEAT_KEYS[kind].includes(k) && k in b;
    if (has("look") && has("lookAt")) err(`${path}/look`, "exclusive", "look and lookAt cannot be used on the same beat");
    if (has("se") && has("seStop")) err(`${path}/seStop`, "exclusive", "se and seStop cannot be used on the same beat");
    if (has("seDuration") && !has("se")) err(`${path}/seDuration`, "empty", "seDuration needs a se");
    if (has("seDelay") && !has("se")) err(`${path}/seDelay`, "empty", "seDelay needs a se");
    if (has("panDuration") && !has("pan")) err(`${path}/panDuration`, "empty", "panDuration needs a pan");
    if (has("panFocusSlide") && !has("pan")) err(`${path}/panFocusSlide`, "empty", "panFocusSlide needs a pan");
    if (has("dofDuration") && !has("dof")) err(`${path}/dofDuration`, "empty", "dofDuration needs a dof");
    if (has("dofLayers") && !has("dof")) err(`${path}/dofLayers`, "empty", "dofLayers needs a dof");
    if (has("dofTarget") && !has("dof")) err(`${path}/dofTarget`, "empty", "dofTarget needs a dof");
    if (has("lookY") && !has("look")) err(`${path}/lookY`, "empty", "lookY needs a look");
    if (has("lookDuration") && !has("look")) err(`${path}/lookDuration`, "empty", "lookDuration needs a look");
    if (has("pedestalDuration") && !has("pedestal")) err(`${path}/pedestalDuration`, "empty", "pedestalDuration needs a pedestal");
    if (has("trackDuration") && beat.track === undefined) err(`${path}/trackDuration`, "empty", "trackDuration needs a track");
    if (has("roleDuration") && !has("role")) err(`${path}/roleDuration`, "empty", "roleDuration needs a role");
    if (has("tiltDuration") && !has("tilt")) err(`${path}/tiltDuration`, "empty", "tiltDuration needs a tilt");

    const hasCameraField = kind === "scene" || kind === "positions" || Boolean(beat.focus) || beat.camera !== undefined;
    if (has("focusDuration") && !hasCameraField) err(`${path}/focusDuration`, "empty", "focusDuration needs a focus or a camera");
    if (has("focusSharp") && !hasCameraField) err(`${path}/focusSharp`, "empty", "focusSharp needs a focus or a camera");
    if (has("focusTargetHead") && !hasCameraField) err(`${path}/focusTargetHead`, "empty", "focusTargetHead needs a focus or a camera");

    const num = (k, min, max) => {
      if (!has(k)) return;
      const v = numberOf(b, k, `${path}/${k}`, { min, max, what: k });
      if (v !== undefined) beat[k] = v;
    };
    const bool = (k) => {
      if (!has(k)) return;
      const v = booleanOf(b, k, `${path}/${k}`, k);
      if (v !== undefined) beat[k] = v;
    };

    num("focusDuration", 0, OFFICIAL_DURATION_MAX);
    num("trackDuration", 0, OFFICIAL_DURATION_MAX);
    num("moveDuration", 0, OFFICIAL_DURATION_MAX);
    num("pedestal", PEDESTAL_MIN, PEDESTAL_MAX);
    num("pedestalDuration", 0, OFFICIAL_DURATION_MAX);
    num("pan", PAN_MIN, PAN_MAX);
    num("panDuration", 0, OFFICIAL_DURATION_MAX);
    num("panFocusSlide", 0, 1);
    num("role", ROLE_MIN, ROLE_MAX);
    num("roleDuration", 0, OFFICIAL_DURATION_MAX);
    num("tilt", TILT_MIN, TILT_MAX);
    num("tiltDuration", 0, OFFICIAL_DURATION_MAX);
    num("dof", 0, 1);
    num("dofDuration", 0.5, 10);
    if (has("dofLayers")) {
      const layers = dofLayersOf(b, path);
      if (layers !== undefined) beat.dofLayers = layers;
    }
    if (has("dofTarget")) {
      const dt = targetOf(b, "dofTarget", `${path}/dofTarget`, "dofTarget");
      if (dt === "") err(`${path}/dofTarget`, "empty", "dofTarget cannot be empty");
      else beat.dofTarget = dt;
      if (beat.dofLayers === 0) err(`${path}/dofTarget`, "exclusive", "dofTarget cannot be combined with dofLayers 0");
    }

    bool("focusSharp");
    bool("focusTargetHead");
    num("cameraDelay", 0, OFFICIAL_DURATION_MAX);
    if (has("ease")) {
      const e = named(b.ease, EASE_MAP, `${path}/ease`, "unknownEase", "ease");
      if (e) beat.ease = e;
    }
    const hasAnyCameraOp = hasCameraField || beat.track !== undefined || beat.pedestal !== undefined ||
      beat.pan !== undefined || beat.dof !== undefined || beat.zoom !== undefined ||
      beat.role !== undefined || beat.tilt !== undefined;
    if (has("ease") && !hasAnyCameraOp) err(`${path}/ease`, "empty", "ease needs a camera move");
    if (has("cameraDelay") && !hasAnyCameraOp) err(`${path}/cameraDelay`, "empty", "cameraDelay needs a camera move");

    if (has("look")) {
      if (b.look === LOOK_STOP) {
        beat.look = LOOK_STOP;
        if (has("lookY")) err(`${path}/lookY`, "exclusive", "lookY cannot be used with look: \"stop\"");
      } else {
        num("look", LOOK_MIN, LOOK_MAX);
      }
    }
    if (has("lookY") && beat.look !== LOOK_STOP) num("lookY", LOOK_MIN, LOOK_MAX);
    num("lookDuration", 0.2, 10);

    bool("thought");
    bool("ignoreLipSync");
    bool("hideTalk");

    if (has("se")) {
      const se = text(b, "se", `${path}/se`);
      if (se !== undefined) beat.se = se;
    }
    num("seDuration", 0.5, 10);
    num("seDelay", 0, 10);
    if (has("seStop")) {
      const stop = booleanOf(b, "seStop", `${path}/seStop`, "seStop");
      if (stop !== undefined) beat.seStop = stop;
    }
    num("motionFadeIn", -1, 2);
    if (has("motionWait")) {
      const wait = booleanOf(b, "motionWait", `${path}/motionWait`, "motionWait");
      if (wait !== undefined) beat.motionWait = wait;
    }

    if (has("bgm")) {
      const bgm = text(b, "bgm", `${path}/bgm`);
      if (bgm !== undefined) beat.bgm = bgm;
    }
    num("bgmFade", 0, MAX_CAMERA_DURATION);
    num("bgmVolume", 0, 1);
    num("bgmStart", 0, 600);
    if (has("bgmStart")) {
      const activeCue = kind === "scene" ? beat.music : beat.bgm;
      if (!activeCue || activeCue === MUSIC_STOP)
        err(`${path}/bgmStart`, "empty", "bgmStart needs a playing music/bgm cue");
    }

    if (has("move")) {
      const mv = parseMove(b.move, `${path}/move`, kind === "say" ? beat.speaker : kind === "action" ? beat.action : "");
      if (mv) beat.move = mv;
    }
    if (has("angle")) {
      const ag = parseAngle(b.angle, `${path}/angle`, kind === "say" ? beat.speaker : kind === "action" ? beat.action : "");
      if (ag) beat.angle = ag;
    }
    if (has("frame")) {
      const fr = text(b, "frame", `${path}/frame`);
      if (fr && !FRAME_PATTERN.test(fr))
        err(`${path}/frame`, "unknownFrame", `frame ${JSON.stringify(fr)} must match adv_frame_*`);
      else if (fr) beat.frame = fr;
    }
    if (has("frameAction")) {
      if (!has("frame")) err(`${path}/frameAction`, "empty", "frameAction needs a frame");
      if (has("frameStop")) err(`${path}/frameAction`, "exclusive", "frameAction cannot be used with frameStop");
      const fa = named(b.frameAction, FRAME_ACTIONS, `${path}/frameAction`, "unknownFrameAction", "frameAction");
      if (fa) beat.frameAction = fa;
    }
    if (has("frameStop")) {
      const fs = booleanOf(b, "frameStop", `${path}/frameStop`, "frameStop");
      if (fs !== undefined) beat.frameStop = fs;
      if (has("frame") && !has("frameStop")) err(`${path}/frame`, "empty", "frame needs a name");
    }
    num("frameDuration", 0, MAX_CAMERA_DURATION);
    if (has("frameDuration") && !has("frame") && !has("frameStop"))
      err(`${path}/frameDuration`, "empty", "frameDuration needs a frame or frameStop");

    if (has("postEffect")) {
      const pe = text(b, "postEffect", `${path}/postEffect`);
      if (pe && !POST_EFFECT_PATTERN.test(pe))
        err(`${path}/postEffect`, "unknownPostEffect", `postEffect ${JSON.stringify(pe)} must match adv_effect_posteffect_*`);
      else if (pe) beat.postEffect = pe;
    }
    if (has("postEffectStop")) {
      const ps = booleanOf(b, "postEffectStop", `${path}/postEffectStop`, "postEffectStop");
      if (ps !== undefined) beat.postEffectStop = ps;
    }
    num("postEffectDuration", 0, MAX_CAMERA_DURATION);
    if (has("postEffectDuration") && !has("postEffect") && !has("postEffectStop"))
      err(`${path}/postEffectDuration`, "empty", "postEffectDuration needs a postEffect or postEffectStop");

    if (has("brightness")) {
      const br = parseBrightness(b.brightness, `${path}/brightness`);
      if (br) beat.brightness = br;
    }
    if (has("shake")) {
      const sh = parseShake(b.shake, `${path}/shake`);
      if (sh) beat.shake = sh;
    }
    if (has("cameraShake")) {
      const cs = named(b.cameraShake, { start: "start", stop: "stop" }, `${path}/cameraShake`, "unknownCameraShake", "cameraShake");
      if (cs) beat.cameraShake = cs;
    }
    num("cameraShakeFade", 0, MAX_CAMERA_DURATION);
    if (has("cameraShakeFade") && !has("cameraShake"))
      err(`${path}/cameraShakeFade`, "empty", "cameraShakeFade needs cameraShake");
    num("cameraShakeStrength", 0.01, MAX_CAMERA_DURATION);
    if (has("cameraShakeStrength") && beat.cameraShake !== "start")
      err(`${path}/cameraShakeStrength`, beat.cameraShake === "stop" ? "exclusive" : "empty",
          "cameraShakeStrength needs cameraShake: \"start\"");
    if (has("flash")) {
      const fl = parseFlash(b.flash, `${path}/flash`);
      if (fl) beat.flash = fl;
    }
    if (has("stageEnv")) {
      const se = parseStageEnv(b.stageEnv, `${path}/stageEnv`);
      if (se) beat.stageEnv = se;
    }
    if (has("talkWindow")) {
      const tw = named(b.talkWindow, TALK_WINDOWS, `${path}/talkWindow`, "unknownTalkWindow", "talkWindow");
      if (tw) beat.talkWindow = b.talkWindow;
    }
    if (has("fadeRule")) {
      const ruleMap = Object.fromEntries(FADE_RULES.map((r) => [r, r]));
      const fr = named(b.fadeRule, ruleMap, `${path}/fadeRule`, "unknownFadeRule", "fadeRule");
      if (fr) beat.fadeRule = fr;
    }
    if (has("fadeColor")) {
      const fc = text(b, "fadeColor", `${path}/fadeColor`);
      if (fc) {
        const up = fc.toUpperCase();
        if (!FADE_COLORS.includes(up))
          errors.push(unknown(`${path}/fadeColor`, "unknownFadeColor", "fadeColor", fc, FADE_COLORS));
        else beat.fadeColor = up;
      }
    }
  };

  // `camera` is a distance name, or {distance, focus, track}; `focus`/`track` on the beat override the object's
  const cameraOf = (b, path) => {
    let distance, focus = "", track;
    if ("camera" in b) {
      const v = b.camera;
      if (typeof v === "string") distance = named(v, CAMERAS, `${path}/camera`, "unknownCamera", "camera");
      else if (isObj(v)) {
        keys(v, ["distance", "focus", "track"], `${path}/camera`);
        distance = "distance" in v
          ? named(v.distance, CAMERAS, `${path}/camera/distance`, "unknownCamera", "camera distance")
          : CAMERAS.middle;
        focus = targetOf(v, "focus", `${path}/camera/focus`, "camera focus");
        track = trackOf(v, "track", `${path}/camera/track`);
      } else {
        err(`${path}/camera`, "type",
            `camera must be a distance (${Object.keys(CAMERAS).join(", ")}) or {distance, focus, track}`);
      }
    }
    if ("focus" in b) {
      const own = targetOf(b, "focus", `${path}/focus`, "focus");
      if (own !== "") focus = own;
    }
    if ("track" in b) {
      const own = trackOf(b, "track", `${path}/track`);
      if (own !== undefined) track = own;
    }
    return { distance, focus, track };
  };

  const actionsOf = (b, path) => {
    if (!("actions" in b)) return [];
    if (!Array.isArray(b.actions)) { err(`${path}/actions`, "type", "actions must be an array of timed events"); return []; }
    if (b.actions.length > MAX_ACTIONS)
      err(`${path}/actions`, "tooManyActions", `at most ${MAX_ACTIONS} actions per line`);
    const out = [];
    b.actions.slice(0, MAX_ACTIONS).forEach((a, i) => {
      const ap = `${path}/actions/${i}`;
      if (!isObj(a)) { err(ap, "type", "an action is an object {at, cast, motion, expression, lookAt}"); return; }
      keys(a, ["at", "cast", "motion", "expression", "lookAt"], ap);
      const at = numberOf(a, "at", `${ap}/at`, { min: 0, max: 1, defaultValue: 0, what: "at" });
      const cast = text(a, "cast", `${ap}/cast`) || "";
      const motion = text(a, "motion", `${ap}/motion`) || "";
      const expression = text(a, "expression", `${ap}/expression`) || "";
      const lookAt = targetOf(a, "lookAt", `${ap}/lookAt`, "lookAt", { allowStop: true });
      if (cast && !CAST_ID.test(cast))
        err(`${ap}/cast`, "castId", `cast id ${JSON.stringify(cast)} must be a letter followed by letters, digits or _`);
      if (lookAt === LOOK_STOP && (at ?? 0) > 0)
        err(`${ap}/lookAt`, "exclusive", "lookAt: \"stop\" in actions is only supported at at: 0");
      if (!motion && !expression && !lookAt)
        err(ap, "emptyAction", "an action needs a motion, an expression or a lookAt");
      out.push({ at: at ?? 0, cast, motion, expression, lookAt, path: ap });
    });
    return out;
  };

  if (!isObj(doc)) { err("", "type", "a script is a JSON object"); return { script: null, errors }; }
  if (doc.format !== SCRIPT_FORMAT) err("/format", "format", `format must be ${JSON.stringify(SCRIPT_FORMAT)}`);
  keys(doc, TOP_KEYS, "");
  const script = { format: SCRIPT_FORMAT, base: text(doc, "base", "/base", { required: true }), language: undefined,
                   title: text(doc, "title", "/title", { empty: true }) || "", font: { preset: "sans" }, cast: [], beats: [] };
  if ("language" in doc) {
    if (typeof doc.language !== "string" || !STORY_LANGUAGES[doc.language])
      errors.push(unknown("/language", "unknownLanguage", "language", doc.language, Object.keys(STORY_LANGUAGES)));
    else script.language = doc.language;
  }
  if ("font" in doc) {
    const f = doc.font;
    if (typeof f === "string") {
      if (FONT_PRESETS.includes(f)) script.font = { preset: f };
      else errors.push(unknown("/font", "unknownFont", "font preset", f, FONT_PRESETS));
    } else if (isObj(f)) {
      keys(f, ["family"], "/font");
      const family = text(f, "family", "/font/family", { required: true });
      if (family) script.font = { family };
    } else err("/font", "type", `font must be a preset (${FONT_PRESETS.join(", ")}) or {"family": <CSS font-family list>}`);
  }

  if (!("cast" in doc)) err("/cast", "missing", "cast is required (an object: cast id -> {model, name})");
  else if (!isObj(doc.cast)) err("/cast", "type", "cast must be an object: cast id -> {model, name}");
  else for (const [id, c] of Object.entries(doc.cast)) {
    const path = `/cast/${tok(id)}`;
    if (!CAST_ID.test(id)) { err(path, "castId", `cast id ${JSON.stringify(id)} must be a letter followed by letters, digits or _`); continue; }
    if (!isObj(c)) { err(path, "type", "a cast member is an object {model, name}"); continue; }
    keys(c, ["model", "name"], path);
    const model = text(c, "model", `${path}/model`, { required: true }), name = text(c, "name", `${path}/name`, { required: true });
    if (model && name) script.cast.push({ id, model, name, path });
  }

  const positions = (v, path) => {
    if (!isObj(v)) { err(path, "type", "positions must be an object: cast id -> position or {at, motion, expression, dx, dy, dz}"); return null; }
    const out = [];
    for (const [id, p] of Object.entries(v)) {
      const pp = `${path}/${tok(id)}`;
      let at, motion, expression, dx, dy, dz;
      if (typeof p === "string") at = named(p, POSITIONS, pp, "unknownPosition", "position");
      else if (isObj(p)) {
        keys(p, ["at", "motion", "expression", "dx", "dy", "dz"], pp);
        if (!("at" in p)) err(`${pp}/at`, "missing", "at is required", { expected: Object.keys(POSITIONS) });
        else at = named(p.at, POSITIONS, `${pp}/at`, "unknownPosition", "position");
        motion = text(p, "motion", `${pp}/motion`);
        expression = text(p, "expression", `${pp}/expression`);
        dx = numberOf(p, "dx", `${pp}/dx`, { min: -10, max: 10 });
        dy = numberOf(p, "dy", `${pp}/dy`, { min: -10, max: 10 });
        dz = numberOf(p, "dz", `${pp}/dz`, { min: -10, max: 10 });
      } else { err(pp, "type", "a position is a name or {at, motion, expression}", { expected: Object.keys(POSITIONS) }); continue; }
      if (at !== undefined) out.push({
        cast: id, slot: at, motion: motion || "", expression: expression || "",
        ...(dx !== undefined ? { dx } : {}),
        ...(dy !== undefined ? { dy } : {}),
        ...(dz !== undefined ? { dz } : {}),
        path: pp, atPath: typeof p === "string" ? pp : `${pp}/at`,
      });
    }
    return out;
  };

  const ids = new Set();
  const allIds = new Set(Array.isArray(doc.beats) ? doc.beats.filter((b) => isObj(b) && typeof b.id === "string").map((b) => b.id) : []);
  const freeId = (id) => {
    let n = 2;
    while (allIds.has(`${id}_${n}`)) n++;
    allIds.add(`${id}_${n}`);
    return `${id}_${n}`;
  };
  if (!("beats" in doc)) err("/beats", "missing", "beats is required (an array)");
  else if (!Array.isArray(doc.beats)) err("/beats", "type", "beats must be an array");
  else if (!doc.beats.length) err("/beats", "empty", "beats is empty");
  else doc.beats.forEach((b, index) => {
    const path = `/beats/${index}`;
    if (!isObj(b)) { err(path, "type", "a beat is an object"); return; }
    const kind = KINDS.find((k) => k in b);
    if (!kind) { err(path, "beatKind", `a beat has one of ${KINDS.join(", ")}`, { expected: KINDS }); return; }
    keys(b, BEAT_KEYS[kind], path);
    const beat = { kind, index, path, id: undefined };
    if ("id" in b) {
      const id = text(b, "id", `${path}/id`);
      if (id && ids.has(id)) {
        const next = freeId(id);
        err(`${path}/id`, "duplicateId", `beat id ${JSON.stringify(id)} is used by an earlier beat`,
            { suggestion: next, fix: [{ op: "replace", path: `${path}/id`, value: next }] });
      } else if (id) { ids.add(id); beat.id = id; }
    }
    if (kind === "scene" || kind === "positions") {
      if (kind === "scene") {
        beat.stage = text(b, "scene", `${path}/scene`, { required: true });
        if ("music" in b) beat.music = text(b, "music", `${path}/music`);
        beat.location = text(b, "location", `${path}/location`, { empty: true }) || "";
        if ("transition" in b) beat.transition = named(b.transition, SCENE_TRANSITIONS, `${path}/transition`, "unknownTransition", "scene transition");
        if ("transitionDuration" in b) {
          if (!("transition" in b)) err(`${path}/transitionDuration`, "empty", "transitionDuration needs transition");
          const min = beat.transition === "dissolve" ? DISSOLVE_MIN : 0.05;
          const max = beat.transition === "dissolve" ? DISSOLVE_MAX : MAX_CAMERA_DURATION;
          const td = numberOf(b, "transitionDuration", `${path}/transitionDuration`, { min, max });
          if (td !== undefined) beat.transitionDuration = td;
        }
        if ("duration" in b) {
          const d = numberOf(b, "duration", `${path}/duration`, { min: 0.05, max: MAX_CAMERA_DURATION });
          if (d !== undefined) beat.duration = d;
        }
        if (beat.transition === "dissolve") {
          if ("fadeRule" in b) err(`${path}/fadeRule`, "exclusive", "fadeRule cannot be used with transition: \"dissolve\"");
          if ("fadeColor" in b) err(`${path}/fadeColor`, "exclusive", "fadeColor cannot be used with transition: \"dissolve\"");
        }
      }
      const cam = cameraOf(b, path);
      beat.camera = cam.distance;
      beat.focus = cam.focus;
      beat.track = cam.track;
      beat.positions = "positions" in b ? positions(b.positions, `${path}/positions`) : (kind === "scene" ? [] : null);
      if (kind === "positions" && !beat.positions) return;
      directionOf(b, beat, path, kind);
    } else if (kind === "say") {
      beat.speaker = text(b, "say", `${path}/say`, { required: true });
      beat.text = text(b, "text", `${path}/text`, { required: true });
      beat.motion = text(b, "motion", `${path}/motion`) || "";
      beat.expression = text(b, "expression", `${path}/expression`) || "";
      beat.lookAt = targetOf(b, "lookAt", `${path}/lookAt`, "lookAt", { allowStop: true });
      const cam = cameraOf(b, path);
      beat.camera = cam.distance;
      beat.focus = cam.focus;
      beat.track = cam.track;
      const zoom = zoomOf(b, path);
      if (zoom.zoom !== undefined) beat.zoom = zoom.zoom;
      if (zoom.duration !== undefined) beat.zoomDuration = zoom.duration;
      directionOf(b, beat, path, "say");
      beat.actions = actionsOf(b, path);
    } else if (kind === "narrate") {
      beat.speaker = null;
      beat.text = text(b, "narrate", `${path}/narrate`, { required: true });
      const cam = cameraOf(b, path);
      beat.camera = cam.distance;
      beat.focus = cam.focus;
      beat.track = cam.track;
      const zoom = zoomOf(b, path);
      if (zoom.zoom !== undefined) beat.zoom = zoom.zoom;
      if (zoom.duration !== undefined) beat.zoomDuration = zoom.duration;
      directionOf(b, beat, path, "narrate");
      beat.actions = actionsOf(b, path);
    } else if (kind === "camera") {
      const cam = cameraOf(b, path);
      beat.camera = cam.distance;
      beat.focus = cam.focus;
      beat.track = cam.track;
      const zoom = zoomOf(b, path);
      if (zoom.zoom !== undefined) beat.zoom = zoom.zoom;
      if (zoom.duration !== undefined) beat.zoomDuration = zoom.duration;
      const cameraDuration = numberOf(b, "cameraDuration", `${path}/cameraDuration`,
                                      { min: 0, max: OFFICIAL_DURATION_MAX, what: "cameraDuration" });
      const legacyDuration = numberOf(b, "duration", `${path}/duration`,
                                      { min: 0, max: OFFICIAL_DURATION_MAX, what: "duration" });
      if ("cameraDuration" in b && "duration" in b)
        warnings.push({ path: `${path}/duration`, code: "conflict",
                        message: "duration is an alias of cameraDuration; cameraDuration wins" });
      const moveDuration = cameraDuration !== undefined ? cameraDuration : legacyDuration;
      if (moveDuration !== undefined) beat.cameraDuration = moveDuration;
      directionOf(b, beat, path, "camera");
      if (beat.camera === undefined && !beat.focus && beat.track === undefined && beat.zoom === undefined &&
          beat.pedestal === undefined && beat.pan === undefined && beat.dof === undefined &&
          beat.role === undefined && beat.tilt === undefined && !beat.se && !beat.seStop)
        err(path, "empty", "a camera beat needs a camera distance, a focus, a track, a zoom, a pedestal, a pan, a dof, a role, a tilt or a sound");
    } else if (kind === "fade") {
      const dir = text(b, "fade", `${path}/fade`, { required: true });
      if (dir && !(dir in FADE_DIRECTIONS))
        errors.push(unknown(`${path}/fade`, "unknownFade", "fade direction", dir, Object.keys(FADE_DIRECTIONS)));
      else beat.fade = dir;
      beat.duration = numberOf(b, "duration", `${path}/duration`,
                               { min: 0.01, max: MAX_CAMERA_DURATION, defaultValue: SCENE_FADE, what: "duration" });
      directionOf(b, beat, path, "fade");
    } else if (kind === "pause") {
      beat.pause = numberOf(b, "pause", `${path}/pause`, { min: 0.01, max: MAX_PAUSE, what: "pause" });
      if (beat.pause === undefined) err(`${path}/pause`, "missing", "pause is required");
      directionOf(b, beat, path, "pause");
    } else if (kind === "action") {
      const id = text(b, "action", `${path}/action`, { required: true });
      if (id && !CAST_ID.test(id))
        err(`${path}/action`, "castId", `cast id ${JSON.stringify(id)} must be a letter followed by letters, digits or _`);
      beat.action = id;
      beat.motion = text(b, "motion", `${path}/motion`) || "";
      beat.expression = text(b, "expression", `${path}/expression`) || "";
      beat.lookAt = targetOf(b, "lookAt", `${path}/lookAt`, "lookAt", { allowStop: true });
      beat.duration = numberOf(b, "duration", `${path}/duration`,
                               { min: 0.01, max: MAX_ACTION_PAUSE, what: "duration" });
      directionOf(b, beat, path, "action");
      if (!beat.motion && !beat.expression && !beat.lookAt && !beat.move && !beat.angle && beat.look === undefined)
        err(path, "emptyAction", "an action needs a motion, an expression, a lookAt, a look, a move or an angle");
    } else if (kind === "move") {
      beat.duration = numberOf(b, "duration", `${path}/duration`, { min: 0, max: OFFICIAL_DURATION_MAX });
      directionOf(b, beat, path, "move");
    } else if (kind === "angle") {
      beat.duration = numberOf(b, "duration", `${path}/duration`, { min: 0, max: OFFICIAL_DURATION_MAX });
      directionOf(b, beat, path, "angle");
    } else if (kind === "still") {
      beat.duration = numberOf(b, "duration", `${path}/duration`, { min: 0, max: MAX_CAMERA_DURATION });
      const st = parseStill(b.still, `${path}/still`);
      if (st) beat.still = st;
      directionOf(b, beat, path, "still");
    } else if (kind === "subtitles") {
      beat.duration = numberOf(b, "duration", `${path}/duration`, { min: 0.1, max: MAX_PAUSE });
      const sub = parseSubtitles(b.subtitles, `${path}/subtitles`);
      if (sub) beat.subtitles = sub;
      directionOf(b, beat, path, "subtitles");
    } else if (kind === "hideTalk") {
      const ht = booleanOf(b, "hideTalk", `${path}/hideTalk`, "hideTalk");
      if (ht === false) err(`${path}/hideTalk`, "range", "standalone hideTalk beat must be true");
      if (ht !== undefined) beat.hideTalk = ht;
    } else {
      if ("duration" in b && BEAT_KEYS[kind].includes("duration")) {
        const d = numberOf(b, "duration", `${path}/duration`, { min: 0.05, max: MAX_CAMERA_DURATION });
        if (d !== undefined) beat.duration = d;
      }
      directionOf(b, beat, path, kind);
      if (kind === "frameStop" && beat.frameStop === false)
        err(`${path}/frameStop`, "range", "standalone frameStop beat must be true");
      if (kind === "postEffectStop" && beat.postEffectStop === false)
        err(`${path}/postEffectStop`, "range", "standalone postEffectStop beat must be true");
      if (kind === "seStop" && beat.seStop === false)
        err(`${path}/seStop`, "range", "standalone seStop beat must be true");
    }
    script.beats.push(beat);
  });
  script.warnings = warnings;
  return { script, errors, warnings };
};

// ------------------------------------------------------------------------------------------------ checking

// The names of a script against its site. `site`:
//   base     {languages, language, stages: stageChoices(...), music: musicChoices(...)} of the script's base story
//   models   the model ids of the site's models.json (an array or a Set)
//   actions  model id -> modelActions, for the models of the cast that exist
//   sounds   soundChoices(...) of the base story: the SE cues a beat's `se` may name
// -> {language, errors, warnings}: language, the language the story plays in.
export const checkScript = (script, site) => {
  const errors = [], warnings = [...(script.warnings || [])];
  const base = site.base, models = new Set(site.models || []), actions = site.actions || {};
  const language = script.language || base.language;
  if (script.language && !base.languages.includes(script.language))
    errors.push(unknown("/language", "unknownLanguage", "language", script.language, base.languages, "the base story"));
  const cast = new Map(script.cast.map((c) => [c.id, c]));
  for (const c of script.cast) if (!models.has(c.model)) errors.push(unknown(`${c.path}/model`, "unknownModel", "model", c.model, [...models].sort(byName), "models.json"));
  const actionsOf = (id) => (cast.has(id) ? actions[cast.get(id).model] : undefined);
  const checkAction = (id, motion, expression, path) => {
    const a = actionsOf(id);
    if (!a) return;
    if (motion && !a.motions.includes(motion) && !motionStems(a.motions).includes(motion))
      errors.push(unknown(`${path}/motion`, "unknownMotion", "motion", motion, motionStems(a.motions).sort(byName), cast.get(id).model));
    if (expression && !a.expressions.includes(expression))
      errors.push(unknown(`${path}/expression`, "unknownExpression", "expression", expression, [...a.expressions].sort(byName), cast.get(id).model));
  };

  const castAtSlot = (stagedSlots, slot) => {
    for (const [id, s] of stagedSlots.entries()) if (s === slot) return id;
    return null;
  };
  const checkCastOnStage = (id, path, code = "offStage") => {
    if (!id) return false;
    if (!cast.has(id)) {
      errors.push(unknown(path, "unknownCast", "cast member", id, cast.keys()));
      return false;
    }
    used.add(id);
    if (!on.has(id)) {
      errors.push({ path, code, message: `${id} is not on stage` });
      return false;
    }
    return true;
  };

  // `focus` is a focus point, a position name or a cast member standing on stage
  const checkFocus = (b, staged) => {
    if (!b.focus) return;
    if (typeof b.focus === "number") return;
    if (b.focus in POSITIONS) return;
    if (!cast.has(b.focus)) {
      errors.push(unknown(`${b.path}/focus`, "unknownFocus", "focus", b.focus, [...Object.keys(POSITIONS), ...cast.keys()]));
      return;
    }
    used.add(b.focus);
    if (!staged.has(b.focus))
      errors.push({ path: `${b.path}/focus`, code: "offStage", message: `${b.focus} is not on stage: the camera cannot focus on it` });
  };

  // `focusTargetHead` needs a single identifiable on-stage cast member.
  const checkFocusTargetHead = (b, stagedSlots) => {
    if (!b.focusTargetHead) return;
    if (typeof b.focus === "number") {
      if (!castAtSlot(stagedSlots, b.focus))
        errors.push({ path: `${b.path}/focusTargetHead`, code: "offStage", message: `focusTargetHead needs a character at focus position ${b.focus}` });
      return;
    }
    if (b.focus && b.focus in POSITIONS) {
      if (!castAtSlot(stagedSlots, POSITIONS[b.focus]))
        errors.push({ path: `${b.path}/focusTargetHead`, code: "offStage", message: `focusTargetHead needs a character at focus position ${b.focus}` });
      return;
    }
    if (b.focus) return;                                        // cast focus handled by checkFocus
    if (stagedSlots.size !== 1)
      errors.push({ path: `${b.path}/focusTargetHead`, code: "offStage",
                    message: "focusTargetHead needs an explicit single-character focus when multiple characters are on stage" });
  };

  // `lookAt` is "stop", a focus point, a position name or a cast member standing on stage
  const checkLookAt = (a, staged) => {
    if ((!a.lookAt && a.lookAt !== 0) || a.lookAt === LOOK_STOP) return;
    if (typeof a.lookAt === "number") return;
    if (a.lookAt in POSITIONS) return;
    if (!cast.has(a.lookAt)) {
      errors.push(unknown(`${a.path}/lookAt`, "unknownLookAt", "lookAt", a.lookAt, [...Object.keys(POSITIONS), ...cast.keys()]));
      return;
    }
    used.add(a.lookAt);
    if (!staged.has(a.lookAt))
      errors.push({ path: `${a.path}/lookAt`, code: "offStage", message: `${a.lookAt} is not on stage: nobody can look at it` });
  };

  const checkActions = (b, staged, speaker) => {
    for (const a of b.actions || []) {
      const id = a.cast || speaker;
      if (!id) { errors.push({ path: a.path, code: "missing", message: "an action needs a cast id" }); continue; }
      if (!cast.has(id)) {
        errors.push(unknown(a.cast ? `${a.path}/cast` : `${b.path}/say`, "unknownCast", "cast member", id, cast.keys()));
        continue;
      }
      used.add(id);
      if (!staged.has(id))
        errors.push({ path: a.path, code: "offStageAction", message: `${id} is not on stage: a timed action needs the character on stage` });
      checkAction(id, a.motion, a.expression, a.path);
      checkLookAt(a, staged);
    }
  };

  const stageIds = base.stages.map((s) => s.id), cues = base.music.map((m) => m.cue);
  const seCues = [...new Set((site.sounds || []).map((s) => s.cue))].sort(byName);
  const knownFrames = site.frames ? [...site.frames].sort(byName) : null;
  const knownPostEffects = site.postEffects ? [...site.postEffects].sort(byName) : null;
  const knownStills = site.stills ? [...site.stills].sort(byName) : null;
  const used = new Set();
  let scenes = 0, on = new Set(), stagedSlots = new Map(), curCamera = CAMERAS.middle;

  // R-2 DoF Polarity: default dof is background blur ([0]). Character DoF requires explicit dofTarget naming a
  // non-focused character; dofTarget matching the focused character/speaker is rejected.
  const checkDofTarget = (b) => {
    if (b.dof === undefined) return;
    const hasTarget = b.dofTarget !== undefined && b.dofTarget !== "";
    if (b.dofLayers === 2 && !hasTarget) {
      errors.push({ path: `${b.path}/dofLayers`, code: "missingDofTarget",
                    message: "character DoF (dofLayers: 2) requires dofTarget naming a non-focused character" });
      return;
    }
    if (!hasTarget || b.dofLayers === 0) return;

    let dofCast = null, dofSlot = null;
    if (typeof b.dofTarget === "number") {
      dofSlot = b.dofTarget;
      dofCast = castAtSlot(stagedSlots, dofSlot);
      if (!dofCast) {
        errors.push({ path: `${b.path}/dofTarget`, code: "offStage", message: `dofTarget needs a character at position ${b.dofTarget}` });
        return;
      }
    } else if (b.dofTarget in POSITIONS) {
      dofSlot = POSITIONS[b.dofTarget];
      dofCast = castAtSlot(stagedSlots, dofSlot);
      if (!dofCast) {
        errors.push({ path: `${b.path}/dofTarget`, code: "offStage", message: `dofTarget needs a character at position ${b.dofTarget}` });
        return;
      }
    } else {
      if (!cast.has(b.dofTarget)) {
        errors.push(unknown(`${b.path}/dofTarget`, "unknownDofTarget", "dofTarget", b.dofTarget, [...Object.keys(POSITIONS), ...cast.keys()]));
        return;
      }
      used.add(b.dofTarget);
      if (!on.has(b.dofTarget)) {
        errors.push({ path: `${b.path}/dofTarget`, code: "offStage", message: `${b.dofTarget} is not on stage: dofTarget needs an on-stage character` });
        return;
      }
      dofCast = b.dofTarget;
      dofSlot = stagedSlots.get(b.dofTarget);
    }

    let focusCast = null, focusSlot = null;
    if (typeof b.focus === "number") {
      focusSlot = b.focus;
      focusCast = castAtSlot(stagedSlots, focusSlot);
    } else if (b.focus && b.focus in POSITIONS) {
      focusSlot = POSITIONS[b.focus];
      focusCast = castAtSlot(stagedSlots, focusSlot);
    } else if (b.focus) {
      focusCast = b.focus;
      focusSlot = stagedSlots.get(b.focus) ?? null;
    } else if (b.kind === "say") {
      focusCast = b.speaker;
      focusSlot = stagedSlots.get(b.speaker) ?? null;
    } else if (b.kind === "action") {
      focusCast = b.action;
      focusSlot = stagedSlots.get(b.action) ?? null;
    }
    if ((focusCast && dofCast && focusCast === dofCast) || (focusSlot !== null && dofSlot !== null && focusSlot === dofSlot)) {
      errors.push({ path: `${b.path}/dofTarget`, code: "dofFocusedSpeaker",
                    message: `dofTarget ${JSON.stringify(b.dofTarget)} is the focused character; blurring the focused character leaves them out of focus` });
    }
  };

  for (const b of script.beats) {
    if (b.se && !seCues.includes(b.se))
      errors.push(unknown(`${b.path}/se`, "unknownSe", "SE cue", b.se, seCues, "the base story's sound files"));
    if (b.bgm && b.bgm !== MUSIC_STOP && !cues.includes(b.bgm))
      errors.push(unknown(`${b.path}/bgm`, "unknownMusic", "music", b.bgm, [MUSIC_STOP, ...cues], "the base story"));
    if (b.frame && knownFrames && !knownFrames.includes(b.frame))
      errors.push(unknown(`${b.path}/frame`, "unknownFrame", "frame", b.frame, knownFrames, "the site"));
    if (b.postEffect && knownPostEffects && !knownPostEffects.includes(b.postEffect))
      errors.push(unknown(`${b.path}/postEffect`, "unknownPostEffect", "postEffect", b.postEffect, knownPostEffects, "the site"));
    if (b.still?.asset && knownStills && !knownStills.includes(b.still.asset))
      errors.push(unknown(`${b.path}/still/asset`, "unknownStill", "still", b.still.asset, knownStills, "the site"));

    if (b.kind !== "scene" && !scenes) errors.push({ path: b.path, code: "beforeScene", message: "the first beat must be a scene" });
    if (b.kind === "scene") {
      scenes++;
      curCamera = b.camera ?? CAMERAS.middle;
      if (b.stage && !stageIds.includes(b.stage)) errors.push(unknown(`${b.path}/scene`, "unknownStage", "stage", b.stage, stageIds, "the base story"));
      if (b.music && b.music !== MUSIC_STOP && !cues.includes(b.music))
        errors.push(unknown(`${b.path}/music`, "unknownMusic", "music", b.music, [MUSIC_STOP, ...cues], "the base story"));
    } else if (b.camera !== undefined) {
      curCamera = b.camera;
    }

    if (b.track !== undefined && clampTrack(b.track, curCamera) !== b.track) {
      warnings.push({ path: `${b.path}/track`, code: "trackClamped",
                      message: `track ${b.track} is clamped to ${clampTrack(b.track, curCamera)} at camera distance ${curCamera}` });
    }

    if (b.positions) {
      const slots = new Map();
      const occupied = new Set(b.positions.map((p) => p.slot));
      for (const p of b.positions) {
        if (!cast.has(p.cast)) {
          const near = nearest(p.cast, cast.keys());
          errors.push(unknown(p.path, "unknownCast", "cast member", p.cast, cast.keys(), "",
                              near && !b.positions.some((q) => q.cast === near) ? "rename" : null));
          continue;
        }
        used.add(p.cast);
        if (slots.has(p.slot)) {
          const free = freeSlot(p.slot, occupied);
          if (free) occupied.add(POSITIONS[free]);
          errors.push({ path: p.path, code: "positionTaken", message: `${p.cast} and ${slots.get(p.slot)} stand at the same position` +
                        (free ? `; ${JSON.stringify(free)} is free` : ""),
                        ...(free ? { suggestion: free, fix: [{ op: "replace", path: p.atPath, value: free }] } : {}) });
        } else slots.set(p.slot, p.cast);
        checkAction(p.cast, p.motion, p.expression, p.path);
      }
      on = new Set(b.positions.map((p) => p.cast));
      stagedSlots = new Map(b.positions.map((p) => [p.cast, p.slot]));
      checkFocus(b, on);
      checkFocusTargetHead(b, stagedSlots);
      checkDofTarget(b);
    }

    if (b.move) {
      const id = b.move.cast || (b.kind === "say" ? b.speaker : b.kind === "action" ? b.action : "");
      if (checkCastOnStage(id, b.move.cast ? `${b.move.path}/cast` : b.path) && b.move.to !== undefined) {
        const blocker = [...stagedSlots.entries()].find(([cid, s]) => cid !== id && s === b.move.to)?.[0];
        if (blocker) {
          errors.push({ path: `${b.move.path}/to`, code: "positionTaken", message: `${id} cannot move to ${blocker}'s position` });
        } else {
          stagedSlots.set(id, b.move.to);
        }
      }
    }
    if (b.angle) {
      const id = b.angle.cast || (b.kind === "say" ? b.speaker : b.kind === "action" ? b.action : "");
      checkCastOnStage(id, b.angle.cast ? `${b.angle.path}/cast` : b.path);
    }
    if (b.brightness && b.brightness.target !== "bg" && b.brightness.target !== "cast") {
      checkCastOnStage(b.brightness.target, `${b.brightness.path}/target`);
    }
    if (b.shake && b.shake.target !== "ui" && b.shake.target !== "stage" && b.shake.target !== "all") {
      checkCastOnStage(b.shake.target, `${b.shake.path}/target`);
    }
    if (b.subtitles?.target) {
      if (!cast.has(b.subtitles.target))
        errors.push(unknown(`${b.subtitles.path}/target`, "unknownCast", "cast member", b.subtitles.target, cast.keys()));
      else used.add(b.subtitles.target);
    }

    if (b.kind === "say" && b.speaker) {
      if (!cast.has(b.speaker)) { errors.push(unknown(`${b.path}/say`, "unknownCast", "cast member", b.speaker, cast.keys())); continue; }
      used.add(b.speaker);
      if (!on.has(b.speaker)) {
        if (b.motion || b.expression || b.look !== undefined || (b.dof !== undefined && b.dofTarget))
          errors.push({ path: b.path, code: "offStage",
                        message: `${b.speaker} is not on stage: a motion, an expression, a look or a character DoF needs the speaker on stage` });
        else warnings.push({ path: `${b.path}/say`, code: "speakerOffStage", message: `${b.speaker} speaks from off stage` });
      }
      checkAction(b.speaker, b.motion, b.expression, b.path);
      checkFocus(b, on);
      checkFocusTargetHead(b, stagedSlots);
      checkDofTarget(b);
      checkLookAt({ lookAt: b.lookAt, path: b.path }, on);
      checkActions(b, on, b.speaker);
    } else if (b.kind === "narrate") {
      checkFocus(b, on);
      checkFocusTargetHead(b, stagedSlots);
      checkDofTarget(b);
      checkActions(b, on, null);
    } else if (b.kind === "camera") {
      checkFocus(b, on);
      checkFocusTargetHead(b, stagedSlots);
      checkDofTarget(b);
    } else if (b.kind === "action") {
      if (!cast.has(b.action)) {
        errors.push(unknown(`${b.path}/action`, "unknownCast", "cast member", b.action, cast.keys()));
      } else {
        used.add(b.action);
        if (!on.has(b.action))
          errors.push({ path: b.path, code: "offStageAction", message: `${b.action} is not on stage: an action needs the character on stage` });
        checkAction(b.action, b.motion, b.expression, b.path);
        checkLookAt(b, on);
        checkDofTarget(b);
      }
    }
  }
  for (const c of script.cast) if (!used.has(c.id)) warnings.push({ path: c.path, code: "unusedCast", message: `${c.id} never comes on stage or speaks` });
  return { language, errors, warnings };
};

// ------------------------------------------------------------------------------------------------ compiling

const roundCoord = (n) => {
  const r = Math.round(n * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};

// The story data of a script that checkScript passes. `site`:
//   base     {story, episode, stages, music} of the base story (its story.json and episode.json; stageChoices,
//            musicChoices)
//   models   model id -> model key (Character/Live2D/<group>/<name>/model/<name>) of the site's models.json
//   actions  model id -> modelActions
//   sounds   soundChoices(...) of the base story: the SE cues and sound rows its `se` fields resolve through
// language: the story language. -> {episode, story, lines: [{line, beat, path, id, speaker, name, text}], scenes}
export const compileScript = (script, site, language) => {
  const field = STORY_LANGUAGES[language];
  if (!field) throw new Error(`unknown story language ${language}`);
  const { base, models, actions } = site;
  const stageKey = new Map(base.stages.map((s) => [s.id, s.key])), music = new Map(base.music.map((m) => [m.cue, m]));
  const seSounds = new Map(((site && site.sounds) || []).map((s) => [s.cue, s]));
  const cast = new Map(script.cast.map((c) => [c.id, c]));
  const rows = [], text = {}, lines = [];
  const row = (cmd, fields = {}) => {
    const raw = ADV_COMMAND.indexOf(cmd);
    if (raw < 0) throw new Error(`no ADV command ${cmd}`);
    rows.push({ i: rows.length, cmd, raw, ...fields });
  };
  const textId = (id, s) => { text[id] = { [field]: s }; return id; };
  const motionsOf = (id) => actions[cast.get(id).model].motions;
  const resolvedExpression = (id, explicit = "") => {
    if (explicit) return explicit;
    if (expression.get(id)) return expression.get(id);
    const a = actions[cast.get(id).model];
    return (a && (a.defaultExpression || a.expressions?.[0])) || "";
  };
  const enterMotion = (m) => {
    if (m.motion) return resolveMotion(m.motion, m.slot, motionsOf(m.cast));
    const a = actions[cast.get(m.cast).model];
    if (!a.defaultMotion) return "";
    const v = resolveMotion(motionStem(a.defaultMotion).stem, m.slot, a.motions);
    return v === a.defaultMotion ? "" : v;
  };

  // the models: one Character row per cast member that comes on stage (the player loads them before playing)
  const onStageEver = new Set(script.beats.flatMap((b) => (b.positions || []).map((p) => p.cast)));
  const story = {
    format: 1, advId: 0, episode: "episode.json", chats: {}, effects: {},
    parts: {
      scene: base.story.parts.scene,
      ui: { ...base.story.parts.ui },
      fonts: { ...base.story.parts.fonts },
      assets: Object.fromEntries(Object.entries(base.story.parts.assets).filter(([key]) =>
        /^Adv\/(Stage|Transition|Frame|Still|PostEffect|Effect)\//.test(key))),
      models: {},
      sounds: {},
      videos: {},
    },
  };
  for (const c of script.cast) {
    if (!onStageEver.has(c.id)) continue;
    const key = models[c.model];
    story.parts.models[key] = c.model;
    row("Character", { TargetName: c.id, TargetAssetName: key.replace(/^Character\/Live2D\//, "") });
  }

  let on = new Map();                                           // cast id -> {cast, slot, stageSlot, offset:{x,y,z}}
  let scenes = 0, bgm = 0, camera = CAMERAS.middle;
  let lastShot = null;                                          // the distance and focus of the last Focus row
  let talkOpen = false;
  let activeDof = null;
  let activeRole = 0;
  let activeTilt = 0;
  let bgBrightness = 1;
  let activeFrame = null;                                       // { asset, action }
  const activePostEffects = new Set();
  let activeCameraShake = false;
  let activeTalkWindow = TALK_WINDOWS.default;
  let activeStill = null;
  let activeSubtitles = false;
  const activeGaze = new Map();                                 // cast id -> "Look" | "LookTarget"
  const activeAngles = new Map();                               // cast id -> { z, x }
  const charBrightness = new Map();                             // cast id -> value
  const expression = new Map();                                 // cast id -> current expression

  const closeTalk = (force = false) => {
    if (!talkOpen && !force) return;
    row("Talk", { AdvTextID: "", IsNoWait: 1 });
    talkOpen = false;
  };

  const resetGaze = (id, dur = 0.2) => {
    const mode = activeGaze.get(id);
    if (!mode) return;
    row(mode, { TargetName: id, Parameter3: "Stop", ...(dur ? { Duration: dur } : {}), IsNoWait: 1 });
    activeGaze.delete(id);
  };
  const resetGazeAll = (dur = 0.2) => {
    for (const id of [...activeGaze.keys()]) resetGaze(id, dur);
  };
  const resetAngle = (id, dur = 0) => {
    if (!activeAngles.has(id)) return;
    row("Angle", { TargetName: id, Parameter1: "0", Parameter2: "0", ...(dur ? { Duration: dur } : {}), IsNoWait: 1 });
    activeAngles.delete(id);
  };
  const resetCharBrightness = (id, dur = 0) => {
    const v = charBrightness.get(id);
    if (v === undefined || v >= 1) return;
    const m = on.get(id);
    row("Brightness", {
      TargetName: id,
      ...(m ? { PositionType: m.stageSlot } : {}),
      CanvasLayers: [2],
      Parameter1: "1",
      ...(dur ? { Duration: dur } : {}),
      IsNoWait: 1,
    });
    charBrightness.delete(id);
  };

  const resetDof = (dur = 1) => {
    if (!activeDof) return;
    const fields = { Parameter1: "0", IsNoWait: 1, ...(dur ? { Duration: dur } : {}) };
    if (activeDof.layers !== undefined) fields.CanvasLayers = [activeDof.layers];
    if (activeDof.target) Object.assign(fields, activeDof.target);
    row("DoF", fields);
    activeDof = null;
  };

  // Stateful Effect Closure Linter: cleanly reset leaked visual/gaze/UI state on scene swaps and episode end.
  const closeSceneEffects = ({ dur = 0.3, gazeDur = 0.2, keepTalk = false } = {}) => {
    if (activeDof) resetDof(dur);
    if (activeRole !== 0) {
      row("Role", { Parameter1: "0", ...(dur ? { Duration: dur } : {}), IsNoWait: 1 });
      activeRole = 0;
    }
    if (activeTilt !== 0) {
      row("Tilt", { Parameter1: "0", ...(dur ? { Duration: dur } : {}), IsNoWait: 1 });
      activeTilt = 0;
    }
    if (bgBrightness < 1) {
      row("Brightness", { CanvasLayers: [0], Parameter1: "1", ...(dur ? { Duration: dur } : {}), IsNoWait: 1 });
      bgBrightness = 1;
    }
    for (const id of [...charBrightness.keys()]) resetCharBrightness(id, dur);
    if (activeFrame) {
      row("Frame", {
        TargetAssetName: activeFrame.asset,
        ...(activeFrame.action ? { Parameter2: "Hide_anime" } : {}),
        ...(dur ? { Duration: dur } : {}),
        IsNoWait: 1,
      });
      activeFrame = null;
    }
    for (const asset of [...activePostEffects]) {
      row("PostEffect", { TargetAssetName: asset, ...(dur ? { Duration: dur } : {}) });
    }
    activePostEffects.clear();
    if (activeCameraShake) {
      row("CameraShake", { ...(dur ? { Duration: dur } : {}) });
      activeCameraShake = false;
    }
    resetGazeAll(gazeDur);
    for (const id of [...activeAngles.keys()]) resetAngle(id, dur);
    if (activeStill) {
      if (!keepTalk) closeTalk();
      row("Still", { TargetAssetName: activeStill, Parameter1: String(dur) });
      activeStill = null;
    }
    if (activeSubtitles) {
      if (!keepTalk) closeTalk();
      row("Subtitles", { AdvTextID: "" });
      activeSubtitles = false;
    }
    if (activeTalkWindow === TALK_WINDOWS.center) {
      if (!keepTalk) closeTalk();
      row("TalkWindow", { TargetAssetName: TALK_WINDOWS.default });
      activeTalkWindow = TALK_WINDOWS.default;
    }
  };

  const focus = (staged) => {
    const slots = [...staged.values()].map((m) => m.slot);
    return slots.length ? Math.min(9, Math.max(1, Math.round(slots.reduce((a, b) => a + b, 0) / slots.length))) : 5;
  };
  const memberAtLogicalSlot = (staged, slot) => [...staged.values()].find((m) => m.slot === slot);
  const focusFields = (b, staged, distance) => {
    const fields = { CameraDistance: distance };
    let headTarget = null;
    if (typeof b.focus === "number") {
      fields.PositionType = b.focus;
      headTarget = memberAtLogicalSlot(staged, b.focus)?.cast || null;
    } else if (b.focus && b.focus in POSITIONS) {
      fields.PositionType = POSITIONS[b.focus];
      headTarget = memberAtLogicalSlot(staged, POSITIONS[b.focus])?.cast || null;
    } else if (b.focus && staged.has(b.focus)) {
      fields.PositionType = staged.get(b.focus).slot;
      headTarget = b.focus;
    } else {
      fields.PositionType = focus(staged);
      if (staged.size === 1) headTarget = [...staged.keys()][0];
    }
    if (b.focusSharp) fields.Parameter1 = "Sharp";
    if (b.focusTargetHead && headTarget) fields.TargetName = headTarget;
    return fields;
  };
  const stagePositionOf = (target, staged) => {
    if (typeof target === "number") return memberAtLogicalSlot(staged, target)?.stageSlot ?? target;
    if (target && target in POSITIONS) {
      const slot = POSITIONS[target];
      return memberAtLogicalSlot(staged, slot)?.stageSlot ?? slot;
    }
    return target && staged.get(target) ? staged.get(target).stageSlot : 0;
  };
  const autoDuration = (fields, distance) => {
    if (!lastShot) return 0;
    if (distance > lastShot.distance) return 0;
    if (distance < lastShot.distance) return FOCUS_RETURN;
    if ((fields.PositionType ?? 0) !== lastShot.pos || (fields.TargetName || "") !== lastShot.name)
      return distance >= CAMERAS.close ? 0 : FOCUS_PAN;
    return 0;
  };
  const camExtras = (b, dur, cmd) => {
    const e = easeFor(b.ease, dur, cmd);
    return {
      ...(e ? { Parameter2: e } : {}),
      ...(b.cameraDelay ? { DelaySeconds: b.cameraDelay } : {}),
    };
  };
  const cameraRows = (b, staged, distance, { duration = 0, noWait = false, focusAlways = false, auto = false } = {}) => {
    let move = duration, hasFocusRow = false;
    if (b.focus || b.camera !== undefined || b.track === undefined || focusAlways) {
      const fields = focusFields(b, staged, distance);
      if (b.focusDuration !== undefined) move = b.focusDuration;
      else if (b.cameraDuration !== undefined) move = b.cameraDuration;
      else if (auto) move = autoDuration(fields, distance);
      if (move) fields.Duration = move;
      Object.assign(fields, camExtras(b, move, "Focus"));
      if (noWait) fields.IsNoWait = 1;
      row("Focus", fields);
      lastShot = { distance, pos: fields.PositionType ?? 0, name: fields.TargetName || "" };
      hasFocusRow = true;
    }
    if (b.track !== undefined) {
      const trackMove = b.trackDuration ?? (hasFocusRow ? move : b.cameraDuration ?? 0);
      const clamped = clampTrack(b.track, distance);
      row("Track", {
        Parameter1: String(clamped),
        ...(trackMove ? { Duration: trackMove } : {}),
        ...camExtras(b, trackMove, "Track"),
        IsNoWait: 1,
      });
    }
  };

  const durationOf = (b, own, fallback) => b[own] ?? b.cameraDuration ?? b.duration ?? fallback;
  const pedestalRow = (b) => {
    if (b.pedestal === undefined) return;
    const dur = durationOf(b, "pedestalDuration", DEFAULT_OFFICIAL_DURATION);
    row("Pedestal", {
      Parameter1: String(b.pedestal),
      ...(dur ? { Duration: dur } : {}),
      ...camExtras(b, dur, "Pedestal"),
      IsNoWait: 1,
    });
  };
  const panRow = (b) => {
    if (b.pan === undefined) return;
    const dur = durationOf(b, "panDuration", DEFAULT_OFFICIAL_DURATION);
    const fields = {
      Parameter1: String(b.pan),
      ...(dur ? { Duration: dur } : {}),
      ...camExtras(b, dur, "PanV2"),
      IsNoWait: 1,
    };
    if (b.panFocusSlide !== undefined) fields.Parameter3 = String(b.panFocusSlide);
    row("PanV2", fields);
  };
  const roleRow = (b) => {
    if (b.role === undefined) return;
    const dur = durationOf(b, "roleDuration", DEFAULT_OFFICIAL_DURATION);
    row("Role", {
      Parameter1: String(b.role),
      ...(dur ? { Duration: dur } : {}),
      ...camExtras(b, dur, "Role"),
      IsNoWait: 1,
    });
    activeRole = b.role;
  };
  const tiltRow = (b) => {
    if (b.tilt === undefined) return;
    const dur = durationOf(b, "tiltDuration", DEFAULT_OFFICIAL_DURATION);
    row("Tilt", {
      Parameter1: String(b.tilt),
      ...(dur ? { Duration: dur } : {}),
      ...camExtras(b, dur, "Tilt"),
      IsNoWait: 1,
    });
    activeTilt = b.tilt;
  };

  const dofTargetOf = (b, staged) => {
    if (b.dofTarget === undefined || b.dofTarget === "") return null;
    const slot = typeof b.dofTarget === "number" ? b.dofTarget
      : Object.hasOwn(POSITIONS, b.dofTarget) ? POSITIONS[b.dofTarget] : null;
    if (slot !== null) {
      const m = memberAtLogicalSlot(staged, slot);
      return m ? { TargetName: m.cast, PositionType: m.stageSlot } : null;
    }
    const m = staged.get(b.dofTarget);
    return m ? { TargetName: m.cast, PositionType: m.stageSlot } : null;
  };
  const nextDofSpec = (b) => {
    const hasTarget = b.dofTarget !== undefined && b.dofTarget !== "";
    const background = !hasTarget || b.dofLayers === 0;
    return {
      layers: background ? (b.dofLayers ?? 0) : (b.dofLayers === 2 ? 2 : undefined),
      target: background ? null : dofTargetOf(b, on),
    };
  };
  const sameDofScope = (a, c) =>
    a && c && a.layers === c.layers && (a.target?.TargetName || "") === (c.target?.TargetName || "") &&
    (a.target?.PositionType ?? 0) === (c.target?.PositionType ?? 0);

  const dofRow = (b, target) => {
    if (b.dof === undefined) return;
    const hasTarget = b.dofTarget !== undefined && b.dofTarget !== "";
    const background = !hasTarget || b.dofLayers === 0;
    if (!background && !target) throw new Error(`character DoF on ${b.path} has no on-stage target`);
    const dur = durationOf(b, "dofDuration", DEFAULT_OFFICIAL_DURATION);
    const layer = background ? (b.dofLayers ?? 0) : b.dofLayers;
    const fields = {
      Parameter1: String(b.dof),
      IsNoWait: 1,
      ...(dur ? { Duration: dur } : {}),
      ...camExtras(b, dur, "DoF"),
    };
    if (layer !== undefined) fields.CanvasLayers = [layer];
    if (!background) Object.assign(fields, target);
    row("DoF", fields);
    activeDof = Number(b.dof) > 0 ? { layers: layer, target: background ? null : target } : null;
  };

  const zoomRow = (b) => {
    if (b.zoom === undefined) return;
    const dur = b.zoomDuration ?? b.cameraDuration ?? b.duration ?? DEFAULT_OFFICIAL_DURATION;
    row("Zoom", {
      Parameter1: String(b.zoom),
      Duration: dur,
      ...camExtras(b, dur, "Zoom"),
      IsNoWait: 1,
    });
  };

  const seRow = (b) => {
    if (!b.se && !b.seStop) return;
    const sound = b.se ? seSounds.get(b.se) : null;
    if (b.se && !sound) throw new Error(`unknown SE cue ${b.se}`);
    const fields = b.seStop ? { Parameter1: "Stop" } : { SeID: sound.sound };
    if (b.seDuration !== undefined) fields.Duration = b.seDuration;
    if (b.seDelay !== undefined) fields.DelaySeconds = b.seDelay;
    row("Se", fields);
  };

  const lookRow = (b, target) => {
    if (b.look === undefined || !target) return;
    const dur = b.lookDuration ?? b.cameraDuration ?? 0.5;
    if (b.look === LOOK_STOP) {
      row("Look", { TargetName: target, Parameter3: "Stop", Duration: dur, IsNoWait: 1 });
      activeGaze.delete(target);
      return;
    }
    row("Look", { TargetName: target, Parameter1: String(b.look), Parameter2: String(b.lookY ?? 0), Duration: dur, IsNoWait: 1 });
    activeGaze.set(target, "Look");
  };

  const officialRows = (b, lookActor = "", dofTarget = null) => {
    pedestalRow(b);
    panRow(b);
    roleRow(b);
    tiltRow(b);
    dofRow(b, dofTarget);
    zoomRow(b);
    seRow(b);
    lookRow(b, lookActor);
  };

  const motionFade = (b) => (b.motionFadeIn !== undefined ? b.motionFadeIn : MOTION_FADE);
  const motionWait = (b) => (b.motionWait !== undefined ? { MotionWait: b.motionWait } : {});

  const emitMotionRow = (id, slot, motionName, explicitExp, fade, extra = {}) => {
    const resolved = resolveMotion(motionName, slot, motionsOf(id));
    if (resolved) {
      const exp = resolvedExpression(id, explicitExp);
      row("Motion", {
        TargetName: id,
        MotionName: resolved,
        MotionFadeIn: fade,
        ...extra,
        ...(exp ? { ExpressionName: exp } : {}),
      });
      expression.set(id, exp);
      return true;
    }
    if (explicitExp) {
      row("Expression", { TargetName: id, ExpressionName: explicitExp, MotionFadeIn: fade });
      expression.set(id, explicitExp);
    }
    return false;
  };

  const emitLookAt = (id, lookAt, staged, dur = 0.2) => {
    if (!lookAt && lookAt !== 0) return;
    if (lookAt === LOOK_STOP) {
      row("LookTarget", { TargetName: id, Parameter3: "Stop", Duration: dur, IsNoWait: 1 });
      activeGaze.delete(id);
      return;
    }
    const pos = stagePositionOf(lookAt, staged);
    if (pos) {
      row("LookTarget", { TargetName: id, PositionType: pos, Duration: dur, IsNoWait: 1 });
      activeGaze.set(id, "LookTarget");
    }
  };

  const emitOffsetMove = (m, dx, dy, dz, dur, wait = false) => {
    const rx = roundCoord(dx), ry = roundCoord(dy), rz = roundCoord(dz);
    if (!rx && !ry && !rz) return;
    row("MoveToDirection", {
      TargetName: m.cast,
      PositionType: m.stageSlot,
      Parameter1: String(rx),
      ...(ry ? { Parameter2: String(ry) } : {}),
      ...(rz ? { Parameter3: String(rz) } : {}),
      ...(dur ? { Duration: dur } : {}),
      ...(wait ? {} : { IsNoWait: 1 }),
    });
    m.offset.x = roundCoord(m.offset.x + rx);
    m.offset.y = roundCoord(m.offset.y + ry);
    m.offset.z = roundCoord(m.offset.z + rz);
  };

  const emitMove = (mv, fallbackDur = undefined) => {
    if (!mv) return;
    const m = on.get(mv.cast);
    if (!m) return;
    const dur = mv.duration ?? fallbackDur ?? 0.5;
    const wait = mv.wait === true;
    if (mv.to !== undefined) {
      const dx = roundCoord(SLOT_WORLD_X[mv.to] - (SLOT_WORLD_X[m.stageSlot] + m.offset.x));
      row("MoveToDirection", {
        TargetName: m.cast,
        PositionType: m.stageSlot,
        Parameter1: String(dx),
        ...(dur ? { Duration: dur } : {}),
        ...(wait ? {} : { IsNoWait: 1 }),
      });
      m.offset.x = roundCoord(m.offset.x + dx);
      m.slot = mv.to;
      return;
    }
    if (mv.dir) {
      const spec = MOVE_DIRECTIONS[mv.dir];
      const rawDelta = mv.distance ?? (spec.axis === "x" ? mv.dx : spec.axis === "y" ? mv.dy : mv.dz);
      const amount = Math.abs(rawDelta ?? 0.5);
      row(spec.cmd, {
        TargetName: m.cast,
        PositionType: m.stageSlot,
        Parameter1: String(roundCoord(amount)),
        ...(dur ? { Duration: dur } : {}),
        ...(wait ? {} : { IsNoWait: 1 }),
      });
      m.offset[spec.axis] = roundCoord(m.offset[spec.axis] + spec.sign * amount);
      return;
    }
    const rx = roundCoord(mv.dx ?? 0), ry = roundCoord(mv.dy ?? 0), rz = roundCoord(mv.dz ?? 0);
    row("MoveToDirection", {
      TargetName: m.cast,
      PositionType: m.stageSlot,
      Parameter1: String(rx),
      Parameter2: String(ry),
      Parameter3: String(rz),
      ...(dur ? { Duration: dur } : {}),
      ...(wait ? {} : { IsNoWait: 1 }),
    });
    m.offset.x = roundCoord(m.offset.x + rx);
    m.offset.y = roundCoord(m.offset.y + ry);
    m.offset.z = roundCoord(m.offset.z + rz);
  };

  const emitAngle = (ag, fallbackDur = undefined) => {
    if (!ag || !on.has(ag.cast)) return;
    const dur = ag.duration ?? fallbackDur;
    const z = ag.z ?? 0, x = ag.x ?? 0;
    row("Angle", {
      TargetName: ag.cast,
      Parameter1: String(z),
      Parameter2: String(x),
      ...(dur ? { Duration: dur } : {}),
      ...(ag.delay ? { DelaySeconds: ag.delay } : {}),
      ...(ag.wait ? {} : { IsNoWait: 1 }),
    });
    if (z === 0 && x === 0) activeAngles.delete(ag.cast);
    else activeAngles.set(ag.cast, { z, x });
  };

  const emitBgm = (b, { force = false } = {}) => {
    const cue = b.kind === "scene" ? b.music : b.bgm;
    if (cue === MUSIC_STOP) {
      if (bgm || (b.kind !== "scene" && force)) {
        const p1 = b.bgmFade !== undefined ? String(b.bgmFade) : (b.kind === "scene" ? "1" : "Stop");
        row("Bgm", { Parameter1: p1 });
        bgm = 0;
      }
    } else if (cue) {
      const m = music.get(cue);
      if (m.sound !== bgm || b.bgmStart !== undefined || b.bgmFade !== undefined || force) {
        row("Bgm", {
          BgmID: m.sound,
          Parameter1: b.bgmFade !== undefined ? String(b.bgmFade) : BGM_FADE,
          ...(b.bgmStart !== undefined ? { Parameter2: String(b.bgmStart) } : {}),
        });
        bgm = m.sound;
      }
    } else if (b.bgmFade !== undefined && b.bgmVolume === undefined && b.kind !== "scene") {
      if (bgm || force) {
        row("Bgm", { Parameter1: String(b.bgmFade) });
        bgm = 0;
      }
    }
    if (b.bgmVolume !== undefined) {
      row("SoundVolume", {
        Parameter1: "Bgm",
        Parameter2: String(b.bgmVolume),
        ...(b.bgmFade ? { Duration: b.bgmFade } : {}),
        IsNoWait: 1,
      });
    }
  };

  const emitEffects = (b) => {
    if (b.talkWindow) {
      const nextWin = TALK_WINDOWS[b.talkWindow];
      if (nextWin !== activeTalkWindow) {
        closeTalk();
        row("TalkWindow", { TargetAssetName: nextWin });
        activeTalkWindow = nextWin;
      }
    }
    if (b.frame && !b.frameStop) {
      const dur = b.frameDuration ?? 0;
      if (!b.frameAction && activeFrame && activeFrame.asset !== b.frame) {
        row("Frame", {
          TargetAssetName: activeFrame.asset,
          ...(activeFrame.action ? { Parameter2: "Hide_anime" } : {}),
          ...(dur ? { Duration: dur } : {}),
          IsNoWait: 1,
        });
        activeFrame = null;
      }
      row("Frame", {
        TargetAssetName: b.frame,
        ...(b.frameAction ? { Parameter2: b.frameAction } : {}),
        ...(dur ? { Duration: dur } : {}),
        IsNoWait: 1,
      });
      if (b.frameAction === "Hide_anime") activeFrame = null;
      else if (b.frameAction === "Show_anime") activeFrame = { asset: b.frame, action: "Show_anime" };
      else activeFrame = activeFrame && activeFrame.asset === b.frame ? null : { asset: b.frame, action: null };
    } else if (b.frameStop) {
      const dur = b.frameDuration ?? 0;
      const target = b.frame || activeFrame?.asset;
      if (target) {
        const useHideAnime = activeFrame && activeFrame.asset === target && activeFrame.action === "Show_anime";
        row("Frame", {
          TargetAssetName: target,
          ...(useHideAnime ? { Parameter2: "Hide_anime" } : {}),
          ...(dur ? { Duration: dur } : {}),
          IsNoWait: 1,
        });
        if (activeFrame && activeFrame.asset === target) activeFrame = null;
      }
    }
    if (b.postEffect && !b.postEffectStop) {
      const dur = b.postEffectDuration ?? 0;
      row("PostEffect", { TargetAssetName: b.postEffect, ...(dur ? { Duration: dur } : {}) });
      if (activePostEffects.has(b.postEffect)) activePostEffects.delete(b.postEffect);
      else activePostEffects.add(b.postEffect);
    } else if (b.postEffectStop) {
      const dur = b.postEffectDuration ?? 0;
      const targets = b.postEffect ? [b.postEffect] : [...activePostEffects];
      for (const pe of targets) {
        row("PostEffect", { TargetAssetName: pe, ...(dur ? { Duration: dur } : {}) });
        activePostEffects.delete(pe);
      }
    }
    if (b.brightness) {
      const br = b.brightness;
      const dur = br.duration ?? b.duration;
      const wait = br.wait === true;
      const baseFields = { Parameter1: String(br.value), ...(dur ? { Duration: dur } : {}), ...(wait ? {} : { IsNoWait: 1 }) };
      if (br.target === "bg") {
        row("Brightness", { CanvasLayers: [0], ...baseFields });
        bgBrightness = br.value;
      } else if (br.target === "cast") {
        for (const m of on.values()) {
          row("Brightness", { TargetName: m.cast, PositionType: m.stageSlot, CanvasLayers: [2], ...baseFields });
          charBrightness.set(m.cast, br.value);
        }
      } else {
        const m = on.get(br.target);
        if (m) {
          row("Brightness", { TargetName: br.target, PositionType: m.stageSlot, CanvasLayers: [2], ...baseFields });
          charBrightness.set(br.target, br.value);
        }
      }
    }
    if (b.flash) {
      const dur = b.flash.duration ?? b.duration ?? 0.3;
      row("Flash", { Duration: dur, ...(b.flash.wait ? {} : { IsNoWait: 1 }) });
    }
    if (b.shake) {
      const sh = b.shake;
      const dur = sh.duration ?? b.duration ?? 0.5;
      const baseFields = { Parameter1: String(sh.power), Duration: dur, ...(sh.wait ? {} : { IsNoWait: 1 }) };
      if (sh.target === "ui") row("Shake", { CanvasLayers: [9], ...baseFields });
      else if (sh.target === "stage") row("Shake", { CanvasLayers: [0, 2], ...baseFields });
      else if (sh.target === "all") row("Shake", baseFields);
      else {
        const m = on.get(sh.target);
        row("Shake", { CanvasLayers: [2], TargetName: sh.target, ...(m ? { PositionType: m.stageSlot } : {}), ...baseFields });
      }
    }
    if (b.cameraShake) {
      const dur = b.cameraShakeFade;
      if (b.cameraShake === "start" && !activeCameraShake) {
        row("CameraShake", {
          ...(dur ? { Duration: dur } : {}),
          ...(b.cameraShakeStrength ? { Parameter2: String(b.cameraShakeStrength) } : {}),
        });
        activeCameraShake = true;
      } else if (b.cameraShake === "stop" && activeCameraShake) {
        row("CameraShake", { ...(dur ? { Duration: dur } : {}) });
        activeCameraShake = false;
      }
    }
  };

  const enter = (p, duration, b = null) => {
    const motion = enterMotion(p);
    row("In", {
      TargetName: p.cast,
      PositionType: p.slot,
      ...(duration ? { Duration: duration } : {}),
      IsNoWait: 1,
      ...(motion ? { MotionName: motion } : {}),
      ...(p.expression ? { ExpressionName: p.expression } : {}),
      ...(b && b.motionFadeIn !== undefined ? { MotionFadeIn: b.motionFadeIn } : {}),
    });
    expression.set(p.cast, p.expression || "");
    const member = { cast: p.cast, slot: p.slot, stageSlot: p.slot, offset: { x: 0, y: 0, z: 0 } };
    if (p.dx || p.dy || p.dz) emitOffsetMove(member, p.dx ?? 0, p.dy ?? 0, p.dz ?? 0, 0);
    return member;
  };

  const exitCharacter = (m, duration) => {
    resetGaze(m.cast, 0.2);
    resetAngle(m.cast, 0);
    resetCharBrightness(m.cast, 0);
    row("Out", { TargetName: m.cast, PositionType: m.stageSlot, ...(duration ? { Duration: duration } : {}) });
    if (duration && (m.offset.x || m.offset.y || m.offset.z)) {
      emitOffsetMove(m, -m.offset.x, -m.offset.y, -m.offset.z, 0);
    }
  };

  for (const b of script.beats) {
    const shotChange = b.kind === "positions" || b.kind === "camera" ||
      ((b.kind === "say" || b.kind === "narrate") &&
        (b.camera !== undefined || b.focus !== undefined || b.track !== undefined));
    if (b.kind !== "scene" && activeDof && (shotChange || b.dof !== undefined)) {
      const nextSpec = b.dof === 0 ? nextDofSpec(b) : null;
      if (!sameDofScope(activeDof, nextSpec)) resetDof();
      else activeDof = null;
    }

    if (b.hideTalk && b.kind !== "say" && b.kind !== "narrate" && b.kind !== "hideTalk") {
      closeTalk();
    }

    if (b.kind === "scene") {
      const dissolve = b.transition === "dissolve";
      const fadeDur = b.duration ?? b.transitionDuration ?? SCENE_FADE;
      const ruleName = transitionAssetName(b.fadeRule);
      const fadeExtras = {
        ...(ruleName ? { TargetAssetName: ruleName } : {}),
        ...(b.fadeColor ? { Parameter1: b.fadeColor } : {}),
      };
      const next = new Map();
      if (scenes) {
        closeTalk();
        if (dissolve) {
          closeSceneEffects({ dur: 0.3, gazeDur: 0.2 });
          const nextByCast = new Map(b.positions.map((p) => [p.cast, p]));
          for (const m of on.values()) {
            const p = nextByCast.get(m.cast);
            if (!p || p.slot !== m.slot) exitCharacter(m, 0);
          }
        } else {
          row("FadeOut", { Duration: fadeDur, ...fadeExtras });
          closeSceneEffects({ dur: 0, gazeDur: 0 });
          for (const m of on.values()) exitCharacter(m, 0);
        }
      }
      const stageDur = dissolve ? (b.transitionDuration ?? DISSOLVE_DEFAULT) : 0;
      row("Stage", { TargetAssetName: stageKey.get(b.stage), ...(stageDur ? { Duration: stageDur } : {}) });
      if (b.stageEnv) row("StageEnv", { Parameter1: b.stageEnv.type, Parameter2: String(b.stageEnv.value) });
      emitBgm(b);
      for (const p of b.positions) {
        if (dissolve && scenes && on.has(p.cast) && on.get(p.cast).slot === p.slot) {
          const kept = { ...on.get(p.cast), offset: { x: 0, y: 0, z: 0 } };
          if (p.motion || p.expression) {
            emitMotionRow(p.cast, p.slot, p.motion, p.expression, motionFade(b), motionWait(b));
          }
          if (p.dx || p.dy || p.dz) emitOffsetMove(kept, p.dx ?? 0, p.dy ?? 0, p.dz ?? 0, 0);
          next.set(p.cast, kept);
        } else {
          next.set(p.cast, enter(p, 0, b));
        }
      }
      camera = b.camera ?? CAMERAS.middle;
      cameraRows(b, next, camera, { focusAlways: true });
      officialRows(b, "", dofTargetOf(b, next));
      emitEffects(b);
      if (scenes && !dissolve) row("FadeIn", { Duration: fadeDur, ...fadeExtras });
      if (b.location.trim()) row("Location", { AdvTextID: textId(`custom_location_${b.index}`, plainText(b.location)) });
      on = next;
      scenes++;
    } else if (b.kind === "positions") {
      const nextList = b.positions;
      const nextByCast = new Map(nextList.map((p) => [p.cast, p]));
      const entering = nextList.filter((p) => !on.has(p.cast));
      const exiting = [...on.values()].filter((m) => !nextByCast.has(m.cast));
      const enteringSlots = new Set(entering.map((p) => p.slot));
      const groupChanged = entering.length > 0 || exiting.length > 0;
      if (groupChanged) resetGazeAll(0.2);

      // Reclaim a physical stageSlot with Out + In only if an entering character needs that exact stageSlot.
      const fallbackRelocate = new Set();
      for (const p of nextList) {
        if (!on.has(p.cast)) continue;
        const cur = on.get(p.cast);
        if (p.slot !== cur.slot && enteringSlots.has(cur.stageSlot)) fallbackRelocate.add(p.cast);
      }

      for (const m of on.values()) {
        if (!nextByCast.has(m.cast) || fallbackRelocate.has(m.cast)) exitCharacter(m, CAST_FADE);
      }
      const next = new Map();
      const moveDur = b.moveDuration ?? 0.5;
      for (const p of nextList) {
        if (!on.has(p.cast) || fallbackRelocate.has(p.cast)) {
          next.set(p.cast, enter(p, CAST_FADE, b));
          continue;
        }
        const cur = { ...on.get(p.cast), offset: { ...on.get(p.cast).offset } };
        const targetDx = roundCoord((SLOT_WORLD_X[p.slot] + (p.dx ?? 0)) - (SLOT_WORLD_X[cur.stageSlot] + cur.offset.x));
        const targetDy = roundCoord((p.dy ?? 0) - cur.offset.y);
        const targetDz = roundCoord((p.dz ?? 0) - cur.offset.z);
        if (targetDx || targetDy || targetDz) emitOffsetMove(cur, targetDx, targetDy, targetDz, moveDur);
        cur.slot = p.slot;
        if (p.motion || p.expression) {
          emitMotionRow(p.cast, p.slot, p.motion, p.expression, motionFade(b), motionWait(b));
        }
        next.set(p.cast, cur);
      }
      if (b.camera !== undefined) camera = b.camera;
      cameraRows(b, next, camera, { duration: FOCUS_MOVE, noWait: true, focusAlways: true });
      officialRows(b, "", dofTargetOf(b, next));
      on = next;
    } else if (b.kind === "say" || b.kind === "narrate") {
      const speaker = b.speaker ? cast.get(b.speaker) : null;
      if (b.camera !== undefined) camera = b.camera;
      if (b.focus || b.camera !== undefined || b.track !== undefined)
        cameraRows(b, on, camera, { auto: true, noWait: true });
      const lookTarget = speaker && on.has(speaker.id) ? speaker.id : "";
      officialRows(b, lookTarget, dofTargetOf(b, on));
      emitBgm(b);
      emitEffects(b);
      if (b.move) emitMove(b.move);
      if (b.angle) emitAngle(b.angle);

      for (const a of b.actions || []) {
        if (a.at > 0) continue;
        const id = a.cast || b.speaker;
        if (!id || !on.has(id)) continue;
        emitMotionRow(id, on.get(id).slot, a.motion, a.expression, MOTION_FADE);
        emitLookAt(id, a.lookAt, on, 0.2);
      }
      if (speaker && on.has(speaker.id)) {
        emitMotionRow(speaker.id, on.get(speaker.id).slot, b.motion, b.expression, motionFade(b), motionWait(b));
        emitLookAt(speaker.id, b.lookAt, on, 0.2);
      }

      const hostActions = [];
      for (const a of b.actions || []) {
        if (a.at <= 0) continue;
        const id = a.cast || b.speaker;
        if (!id || !on.has(id)) continue;
        const action = { at: a.at, TargetName: id, MotionFadeIn: 0.15 };
        const motion = resolveMotion(a.motion, on.get(id).slot, motionsOf(id));
        if (motion) {
          action.MotionName = motion;
          const exp = resolvedExpression(id, a.expression);
          if (exp) action.ExpressionName = exp;
        } else if (a.expression) {
          action.ExpressionName = a.expression;
        }
        if (action.ExpressionName) expression.set(id, action.ExpressionName);
        if (a.lookAt && a.lookAt !== LOOK_STOP) {
          const pos = stagePositionOf(a.lookAt, on);
          if (pos) {
            action.LookTargetPosition = pos;
            activeGaze.set(id, "LookTarget");
          }
        }
        hostActions.push(action);
      }
      const spokenPlain = plainText(b.text);
      const silent = b.ignoreLipSync !== false &&
        (b.ignoreLipSync === true || b.thought === true || !hasSpokenContent(spokenPlain));
      const fields = { AdvTextID: textId(`custom_line_${b.index}`, spokenPlain) };
      if (silent) fields.IgnoreLipSync = 1;
      if (hostActions.length) fields.HostActions = hostActions;
      if (speaker) {
        Object.assign(fields, {
          TargetName: speaker.id,
          TargetTextIDs: [textId(`custom_name_${speaker.id}`, plainText(speaker.name))],
          TargetTextColors: [NAME_COLOR],
        });
      }
      row("Talk", fields);
      talkOpen = true;
      if (b.hideTalk) closeTalk();
      lines.push({
        line: lines.length, beat: b.index, path: b.path, ...(b.id ? { id: b.id } : {}),
        speaker: speaker ? speaker.id : null, name: speaker ? speaker.name : "", text: b.text,
      });
    } else if (b.kind === "camera") {
      closeTalk();
      if (b.camera !== undefined) camera = b.camera;
      if (b.camera !== undefined || b.focus || b.track !== undefined)
        cameraRows(b, on, camera, { auto: true, noWait: true });
      officialRows(b, "", dofTargetOf(b, on));
    } else if (b.kind === "fade") {
      closeTalk();
      const ruleName = transitionAssetName(b.fadeRule);
      row(FADE_DIRECTIONS[b.fade], {
        Duration: b.duration || SCENE_FADE,
        ...(ruleName ? { TargetAssetName: ruleName } : {}),
        ...(b.fadeColor ? { Parameter1: b.fadeColor } : {}),
      });
    } else if (b.kind === "pause") {
      if (b.pause >= HIDE_TALK_PAUSE_THRESHOLD) closeTalk();
      row("Delay", { Duration: b.pause });
    } else if (b.kind === "move") {
      closeTalk();
      emitMove(b.move, b.duration);
    } else if (b.kind === "action") {
      const m = on.get(b.action);
      if (m) {
        officialRows(b, b.action, dofTargetOf(b, on));
        if (b.move) emitMove(b.move, b.duration);
        if (b.angle) emitAngle(b.angle, b.duration);
        emitMotionRow(b.action, m.slot, b.motion, b.expression, motionFade(b), motionWait(b));
        emitLookAt(b.action, b.lookAt, on, 0.2);
        if (b.duration) row("Delay", { Duration: b.duration });
      }
    } else if (b.kind === "still") {
      closeTalk();
      const st = b.still;
      const fade = st.fade ?? b.duration;
      if (st.stop) {
        const target = st.asset || activeStill;
        if (target) {
          row("Still", { TargetAssetName: target, ...(fade !== undefined ? { Parameter1: String(fade) } : {}) });
          if (activeStill === target) activeStill = null;
        }
      } else if (st.asset) {
        if (activeStill && activeStill !== st.asset) {
          row("Still", { TargetAssetName: activeStill, ...(fade !== undefined ? { Parameter1: String(fade) } : {}) });
          activeStill = null;
        }
        row("Still", {
          TargetAssetName: st.asset,
          ...(fade !== undefined ? { Parameter1: String(fade) } : {}),
          ...(st.alpha !== undefined ? { Parameter2: String(st.alpha) } : {}),
          ...(st.index !== undefined ? { Parameter3: String(st.index) } : {}),
          ...(st.screenAlpha !== undefined ? { Parameter4: String(st.screenAlpha) } : {}),
        });
        activeStill = activeStill === st.asset ? null : st.asset;
      }
    } else if (b.kind === "subtitles") {
      closeTalk();
      const sub = b.subtitles;
      if (!sub.text.trim()) {
        row("Subtitles", { AdvTextID: "" });
        activeSubtitles = false;
      } else {
        const sp = sub.target ? cast.get(sub.target) : null;
        const fields = { AdvTextID: textId(`custom_subtitles_${b.index}`, plainText(sub.text)) };
        if (sp) {
          Object.assign(fields, {
            TargetName: sp.id,
            TargetTextIDs: [textId(`custom_name_${sp.id}`, plainText(sp.name))],
            TargetTextColors: [NAME_COLOR],
          });
        }
        const dur = sub.duration ?? b.duration;
        if (dur !== undefined) {
          row("Subtitles", { ...fields, IsNoWait: 1 });
          row("Delay", { Duration: dur });
          row("Subtitles", { AdvTextID: "" });
          activeSubtitles = false;
        } else {
          if (sub.wait === false) fields.IsNoWait = 1;
          row("Subtitles", fields);
          activeSubtitles = true;
        }
      }
    } else if (b.kind === "hideTalk") {
      closeTalk(true);
    } else if (b.kind === "se" || b.kind === "seStop") {
      closeTalk();
      seRow(b);
    } else if (b.kind === "angle") {
      emitAngle(b.angle, b.duration);
    } else if (b.kind === "bgm" || b.kind === "bgmFade" || b.kind === "bgmVolume") {
      emitBgm(b, { force: true });
    } else if (b.kind === "stageEnv") {
      row("StageEnv", { Parameter1: b.stageEnv.type, Parameter2: String(b.stageEnv.value) });
    } else {
      emitEffects(b);
    }
  }

  // Close any effects/gaze/UI modes left active at episode end.
  closeSceneEffects({ dur: 0.3, gazeDur: 0.2 });

  // the sounds the rows play, with their cue sheets and sound files (BGM and SE)
  const sounds = {}, cuesheets = {};
  for (const r of rows) {
    if (r.cmd !== "Bgm" && r.cmd !== "Se") continue;
    const id = r.cmd === "Bgm" ? r.BgmID : r.SeID;
    if (!Number(id)) continue;
    const s = base.episode.sounds[id];
    if (!s) throw new Error(`sound ${id} is not in the base episode`);
    const sheet = base.episode.cuesheets[s._soundCueSheetID];
    if (!sheet) throw new Error(`cue sheet ${s._soundCueSheetID} is not in the base episode`);
    sounds[id] = s;
    cuesheets[s._soundCueSheetID] = sheet;
    story.parts.sounds[sheet._cueSheetName] = base.story.parts.sounds[sheet._cueSheetName];
  }
  const title = script.title.trim();
  const episode = {
    advId: 0, asset: "", commandCount: rows.length, commands: rows,
    text: { ...(title ? { [TITLE_ID]: { [field]: plainText(title) } } : {}), ...text },
    sounds, cuesheets, videos: {}, resources: [],
    master: { _id: 0, _sheetName: "", _advEpisodeAsset: "", _titleTextId: title ? TITLE_ID : "", _rubyTitleTextId: "",
              _playbackMode: 0 },
    title: title ? { [field]: plainText(title) } : null,
  };
  return { episode, story, lines, scenes };
};

// every text a compiled story shows (the characters a font has to draw)
export const scriptTexts = (script) => [
  script.title,
  ...script.cast.map((c) => c.name),
  ...script.beats.map((b) => (b.kind === "scene" ? b.location : b.kind === "subtitles" ? (b.subtitles?.text || "") : b.text || "")),
].join("");
