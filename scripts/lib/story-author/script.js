// Story scripts: the document an author writes to make a dialogue story with the stages, music, story UI and Live2D
// models of a story site, its checks and its compilation into the story player's data (docs/story-author.md).
//
// A script (format SCRIPT_FORMAT) names a base story of the site (`base`: the path of its story manifest) whose
// stages, music, story UI and player settings it uses, the language of its texts, the font family the browser draws
// them with, the cast (models of the site's models.json and the names they speak under) and the beats in order:
//   {"scene": <stage>, "music"?, "location"?, "camera"?, "focus"?, "track"?, "positions"?} a new stage behind a fade
//   {"positions": {...}, "camera"?, "focus"?, "track"?}                           who stands where from this beat on
//   {"say": <cast id>, "text", "motion"?, "expression"?, "lookAt"?, "focus"?, "camera"?, "track"?, "actions"?}
//   {"narrate": <text>, "focus"?, "camera"?, "track"?, "actions"?}                a line without a speaker
//   {"camera": <distance|{distance, focus, track}>, "focus"?, "track"?, "duration"?} a camera move, no movement
//   {"fade": "out"|"in", "duration"?}                                             a screen fade
//   {"pause": <seconds>}                                                         a silent beat
//   {"action": <cast id>, "motion"?, "expression"?, "lookAt"?, "duration"?}       acting between lines
// `actions` on a line are timed events inside it: {"at": 0..1, "cast"?, "motion"?, "expression"?, "lookAt"?}.
// An action at 0 plays before the line starts (the game's usual listener reaction); a later one plays during the
// text. They play on the speaker's or a listener's Live2D model; `focus` names a cast member, a position, or a focus
// point 1..9 and moves the story camera to it; `track` offsets the camera horizontally from that focus the way the
// game's Track command does.
// parseScript checks the document's shape; checkScript checks its names against the site (stages, music, models,
// motions, expressions) and the staging (positions, speakers on stage). Every problem names the JSON pointer of the
// value, an unknown name comes with the names that exist and the nearest one, and a problem with a known fix carries it
// as JSON Patch operations (applyFixes applies them; layoutFix makes the fix of a line that overflows the talk
// window). compileScript turns a script without errors into the episode's command rows (episode.json) and the story
// index (story.json).

import { componentClass } from "../../../src/engine/prefab.js";
import { ADV_COMMAND } from "../../../src/story/interfaces.js";
import { STORY_LANGUAGES } from "../../../src/story/params.js";

export const SCRIPT_FORMAT = "ournotes.story-script/1";

// the character slots of the story field (AdvCharacterField position types), far left to far right
export const POSITIONS = Object.freeze({ "far-left": 1, left: 3, center: 5, right: 7, "far-right": 9 });
// the side a slot's motions face: the game's motions come in _L, _C and _R variants
const SIDE = { 1: "L", 3: "L", 5: "C", 7: "R", 9: "R" };

// The name of the position nearest `slot` that `occupied` (a set of position values) does not hold, or null when every
// position is taken. -> "far-left" | "left" | "center" | "right" | "far-right"
export const freeSlot = (slot, occupied) =>
  Object.keys(POSITIONS).sort((a, b) => Math.abs(POSITIONS[a] - slot) - Math.abs(POSITIONS[b] - slot) || POSITIONS[a] - POSITIONS[b])
    .find((k) => !occupied.has(POSITIONS[k])) || null;
// Focus data camera distances. Each distance is the game's field zoom for that focus data: 1 = 1.2x (the widest, an
// establishing shot), 2 = 1.4x (the two-shot), 3 = 1.8x (a group or a tight medium), 4 = 2.8x (a close-up) and
// 5 = 4x (a big close-up). The official episodes use 2/3 for group shots and 4 for emotional close-ups; 1 and 5 are
// rare.
export const CAMERAS = Object.freeze({ near: 1, middle: 2, far: 3, close: 4, "very-close": 5 });
export const FADE_DIRECTIONS = Object.freeze({ out: "FadeOut", in: "FadeIn" });
export const FONT_PRESETS = Object.freeze(["sans", "serif", "rounded"]);
export const MUSIC_STOP = "stop";
export const MAX_ACTIONS = 12;
// Focus points 1..9 are the game's camera anchors: 1/3/5/7/9 are the character slots, 2/4/6/8 sit between two slots
// and frame a pair. Track moves the camera by a horizontal offset from the focus point.
export const FOCUS_POINT_MIN = 1;
export const FOCUS_POINT_MAX = 9;
export const TRACK_MIN = -4;
export const TRACK_MAX = 4;
// The verified official camera and gaze ranges (docs/story-director.md). Durations are shared by the Focus, Track,
// Pedestal, PanV2 and DoF fields; 1.5 s is the official non-zero camera move.
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2.5;
export const PEDESTAL_MIN = -4;
export const PEDESTAL_MAX = 5;
export const PAN_MIN = -30;
export const PAN_MAX = 30;
export const LOOK_MIN = -1;
export const LOOK_MAX = 1;
export const OFFICIAL_DURATION_MAX = 20;
export const DEFAULT_OFFICIAL_DURATION = 1.5;
const MAX_CAMERA_DURATION = 10;
const MAX_PAUSE = 60;
const MAX_ACTION_PAUSE = 10;

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
    f.browser = { family, ...(underlay > 0 ? { underlayOffset: underlay } : {}) };
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
const BEAT_KEYS = {
  scene: ["id", "scene", "music", "location", "camera", "focus", "track", "positions", "focusDuration",
          "trackDuration", "se", "seDuration", "seDelay", "seStop"],
  say: ["id", "say", "text", "motion", "expression", "lookAt", "focus", "camera", "track", "zoom", "zoomDuration",
        "focusDuration", "trackDuration", "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide",
        "dof", "dofDuration", "dofLayers", "look", "lookY", "lookDuration", "se", "seDuration", "seDelay", "seStop",
        "motionFadeIn", "motionWait", "actions"],
  narrate: ["id", "narrate", "focus", "camera", "track", "zoom", "zoomDuration", "focusDuration", "trackDuration",
            "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide", "dof", "dofDuration", "dofLayers",
            "actions"],
  positions: ["id", "positions", "camera", "focus", "track", "focusDuration", "trackDuration", "motionFadeIn",
              "motionWait"],
  camera: ["id", "camera", "focus", "track", "zoom", "zoomDuration", "cameraDuration", "focusDuration", "trackDuration",
           "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide", "dof", "dofDuration", "dofLayers",
           "se", "seDuration", "seDelay", "seStop", "duration"],
  fade: ["id", "fade", "duration"],
  pause: ["id", "pause"],
  action: ["id", "action", "motion", "expression", "lookAt", "look", "lookY", "lookDuration", "duration", "se",
           "seDuration", "seDelay", "seStop", "motionFadeIn", "motionWait"],
};
const KINDS = Object.keys(BEAT_KEYS);

// The shape of a script: -> {script, errors}. `script` is the document with every value checked for its type and
// form (a value with an error is left out); errors: [{path, code, message, ...}] with codes format, type, missing,
// unknownKey, castId, beatKind, empty, duplicateId, unknownLanguage, unknownFont, unknownPosition, unknownCamera.
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
  // a finite number in [min, max]; `defaultValue` when the key is absent
  const numberOf = (o, k, path, { min = 0, max = Infinity, defaultValue = undefined, what = k } = {}) => {
    if (!(k in o)) return defaultValue;
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) { err(path, "type", `${what} must be a number`); return undefined; }
    if (v < min || v > max) { err(path, "range", `${what} must be between ${min} and ${max}`); return undefined; }
    return v;
  };
  // a camera target: a cast id, a position name, or one of the game's focus points 1..9
  const targetOf = (o, k, path, what = k) => {
    if (!(k in o)) return "";
    const v = o[k];
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
  // the Track offset in stage units
  const trackOf = (o, k, path) => {
    if (!(k in o)) return undefined;
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) { err(path, "type", `${k} must be a number`); return undefined; }
    if (v < TRACK_MIN || v > TRACK_MAX) { err(path, "range", `${k} must be between ${TRACK_MIN} and ${TRACK_MAX}`); return undefined; }
    return v;
  };
  // an optional slow Zoom on a line or a camera beat: a zoom ratio (0.7..2.5) and its seconds (0.2..20)
  const zoomOf = (b, path) => {
    const zoom = numberOf(b, "zoom", `${path}/zoom`, { min: ZOOM_MIN, max: ZOOM_MAX, what: "zoom" });
    const duration = numberOf(b, "zoomDuration", `${path}/zoomDuration`,
                              { min: 0.2, max: OFFICIAL_DURATION_MAX, what: "zoomDuration" });
    if (duration !== undefined && zoom === undefined)
      err(`${path}/zoom`, "empty", "zoomDuration needs a zoom");
    return { zoom, duration };
  };
  const booleanOf = (o, k, path, what = k) => {
    if (!(k in o)) return undefined;
    if (typeof o[k] !== "boolean") { err(path, "type", `${what} must be a boolean`); return undefined; }
    return o[k];
  };
  // DoF canvas layers: 0 (background), 2 (characters), or absent (characters)
  const dofLayersOf = (o, path) => {
    if (!("dofLayers" in o)) return undefined;
    const v = o.dofLayers;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      err(`${path}/dofLayers`, "type", "dofLayers must be 0 or 2");
      return undefined;
    }
    if (v !== 0 && v !== 2) { err(`${path}/dofLayers`, "range", "dofLayers must be 0 or 2"); return undefined; }
    return v;
  };
  // The verified official camera, gaze, acting and sound fields of a beat. A field is only read on the beats the
  // format allows it on; the dependencies and the two exclusive pairs are reported before the values are checked.
  const directionOf = (b, beat, path, kind) => {
    const has = (k) => BEAT_KEYS[kind].includes(k) && k in b;
    if (has("look") && has("lookAt"))
      err(`${path}/look`, "exclusive", "look and lookAt cannot be used on the same beat");
    if (has("se") && has("seStop"))
      err(`${path}/seStop`, "exclusive", "se and seStop cannot be used on the same beat");
    if (has("seDuration") && !has("se")) err(`${path}/seDuration`, "empty", "seDuration needs a se");
    if (has("seDelay") && !has("se")) err(`${path}/seDelay`, "empty", "seDelay needs a se");
    if (has("panFocusSlide") && !has("pan")) err(`${path}/panFocusSlide`, "empty", "panFocusSlide needs a pan");
    if (has("dofLayers") && !has("dof")) err(`${path}/dofLayers`, "empty", "dofLayers needs a dof");
    if (has("pedestalDuration") && !has("pedestal"))
      err(`${path}/pedestalDuration`, "empty", "pedestalDuration needs a pedestal");
    const num = (k, min, max) => {
      if (!has(k)) return;
      const v = numberOf(b, k, `${path}/${k}`, { min, max, what: k });
      if (v !== undefined) beat[k] = v;
    };
    num("focusDuration", 0, OFFICIAL_DURATION_MAX);
    num("trackDuration", 0, OFFICIAL_DURATION_MAX);
    num("pedestal", PEDESTAL_MIN, PEDESTAL_MAX);
    num("pedestalDuration", 0, OFFICIAL_DURATION_MAX);
    num("pan", PAN_MIN, PAN_MAX);
    num("panDuration", 0, OFFICIAL_DURATION_MAX);
    num("panFocusSlide", 0, 1);
    num("dof", 0, 1);
    num("dofDuration", 0.5, 10);
    if (has("dofLayers")) {
      const layers = dofLayersOf(b, path);
      if (layers !== undefined) beat.dofLayers = layers;
    }
    num("look", LOOK_MIN, LOOK_MAX);
    num("lookY", LOOK_MIN, LOOK_MAX);
    num("lookDuration", 0.2, 10);
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
  // timed acting events inside a line: [{"at": 0..1, "cast"?, "motion"?, "expression"?, "lookAt"?}]
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
      const lookAt = targetOf(a, "lookAt", `${ap}/lookAt`, "lookAt");
      if (cast && !CAST_ID.test(cast))
        err(`${ap}/cast`, "castId", `cast id ${JSON.stringify(cast)} must be a letter followed by letters, digits or _`);
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
    if (!isObj(v)) { err(path, "type", "positions must be an object: cast id -> position or {at, motion, expression}"); return null; }
    const out = [];
    for (const [id, p] of Object.entries(v)) {
      const pp = `${path}/${tok(id)}`;
      let at, motion, expression;
      if (typeof p === "string") at = named(p, POSITIONS, pp, "unknownPosition", "position");
      else if (isObj(p)) {
        keys(p, ["at", "motion", "expression"], pp);
        if (!("at" in p)) err(`${pp}/at`, "missing", "at is required", { expected: Object.keys(POSITIONS) });
        else at = named(p.at, POSITIONS, `${pp}/at`, "unknownPosition", "position");
        motion = text(p, "motion", `${pp}/motion`);
        expression = text(p, "expression", `${pp}/expression`);
      } else { err(pp, "type", "a position is a name or {at, motion, expression}", { expected: Object.keys(POSITIONS) }); continue; }
      if (at !== undefined) out.push({ cast: id, slot: at, motion: motion || "", expression: expression || "", path: pp,
                                       atPath: typeof p === "string" ? pp : `${pp}/at` });
    }
    return out;
  };

  const ids = new Set();
  // every beat id of the document, for the fix of a duplicate one (an id no beat has)
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
      beat.lookAt = targetOf(b, "lookAt", `${path}/lookAt`, "lookAt");
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
          !beat.se && !beat.seStop)
        err(path, "empty", "a camera beat needs a camera distance, a focus, a track, a zoom, a pedestal, a pan, a dof or a sound");
    } else if (kind === "fade") {
      const dir = text(b, "fade", `${path}/fade`, { required: true });
      if (dir && !(dir in FADE_DIRECTIONS))
        errors.push(unknown(`${path}/fade`, "unknownFade", "fade direction", dir, Object.keys(FADE_DIRECTIONS)));
      else beat.fade = dir;
      beat.duration = numberOf(b, "duration", `${path}/duration`,
                               { min: 0.01, max: MAX_CAMERA_DURATION, defaultValue: SCENE_FADE, what: "duration" });
    } else if (kind === "pause") {
      beat.pause = numberOf(b, "pause", `${path}/pause`, { min: 0.01, max: MAX_PAUSE, what: "pause" });
      if (beat.pause === undefined) err(`${path}/pause`, "missing", "pause is required");
    } else {
      const id = text(b, "action", `${path}/action`, { required: true });
      if (id && !CAST_ID.test(id))
        err(`${path}/action`, "castId", `cast id ${JSON.stringify(id)} must be a letter followed by letters, digits or _`);
      beat.action = id;
      beat.motion = text(b, "motion", `${path}/motion`) || "";
      beat.expression = text(b, "expression", `${path}/expression`) || "";
      beat.lookAt = targetOf(b, "lookAt", `${path}/lookAt`, "lookAt");
      if (!beat.motion && !beat.expression && !beat.lookAt)
        err(path, "emptyAction", "an action needs a motion, an expression or a lookAt");
      beat.duration = numberOf(b, "duration", `${path}/duration`,
                               { min: 0.01, max: MAX_ACTION_PAUSE, what: "duration" });
      directionOf(b, beat, path, "action");
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
// -> {language, errors, warnings}: language, the language the story plays in; error codes unknownLanguage,
// unknownModel, unknownCast, unknownStage, unknownMusic, unknownSe, unknownMotion, unknownExpression, beforeScene,
// positionTaken, offStage; warning codes speakerOffStage (a line of a character not on stage), unusedCast, conflict
// (a camera beat has both duration and cameraDuration).
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
  // `focus` is a focus point, a position name or a cast member standing on stage
  const checkFocus = (b, staged) => {
    if (!b.focus) return;
    if (typeof b.focus === "number") return;                       // parseScript checked 1..9
    if (b.focus in POSITIONS) return;
    if (!cast.has(b.focus)) {
      errors.push(unknown(`${b.path}/focus`, "unknownFocus", "focus", b.focus, [...Object.keys(POSITIONS), ...cast.keys()]));
      return;
    }
    if (!staged.has(b.focus))
      errors.push({ path: `${b.path}/focus`, code: "offStage", message: `${b.focus} is not on stage: the camera cannot focus on it` });
  };
  // `lookAt` is a focus point, a position name or a cast member standing on stage
  const checkLookAt = (a, on) => {
    if (!a.lookAt && a.lookAt !== 0) return;
    if (typeof a.lookAt === "number") return;                      // parseScript checked 1..9
    if (a.lookAt in POSITIONS) return;
    if (!cast.has(a.lookAt)) {
      errors.push(unknown(`${a.path}/lookAt`, "unknownLookAt", "lookAt", a.lookAt, [...Object.keys(POSITIONS), ...cast.keys()]));
      return;
    }
    if (!on.has(a.lookAt))
      errors.push({ path: `${a.path}/lookAt`, code: "offStage", message: `${a.lookAt} is not on stage: nobody can look at it` });
  };
  // the timed actions of a line; `speaker` is the line's speaker, the default target
  const checkActions = (b, on, speaker) => {
    for (const a of b.actions || []) {
      const id = a.cast || speaker;
      if (!id) { errors.push({ path: a.path, code: "missing", message: "an action needs a cast id" }); continue; }
      if (!cast.has(id)) {
        errors.push(unknown(a.cast ? `${a.path}/cast` : `${b.path}/say`, "unknownCast", "cast member", id, cast.keys()));
        continue;
      }
      used.add(id);
      if (!on.has(id))
        errors.push({ path: a.path, code: "offStageAction", message: `${id} is not on stage: a timed action needs the character on stage` });
      checkAction(id, a.motion, a.expression, a.path);
      checkLookAt(a, on);
    }
  };
  const stageIds = base.stages.map((s) => s.id), cues = base.music.map((m) => m.cue);
  const seCues = [...new Set((site.sounds || []).map((s) => s.cue))].sort(byName);
  const used = new Set();
  let scenes = 0, on = new Set();
  for (const b of script.beats) {
    if (b.se && !seCues.includes(b.se))
      errors.push(unknown(`${b.path}/se`, "unknownSe", "SE cue", b.se, seCues, "the base story's sound files"));
    if (b.kind !== "scene" && !scenes) errors.push({ path: b.path, code: "beforeScene", message: "the first beat must be a scene" });
    if (b.kind === "scene") {
      scenes++;
      if (b.stage && !stageIds.includes(b.stage)) errors.push(unknown(`${b.path}/scene`, "unknownStage", "stage", b.stage, stageIds, "the base story"));
      if (b.music && b.music !== MUSIC_STOP && !cues.includes(b.music))
        errors.push(unknown(`${b.path}/music`, "unknownMusic", "music", b.music, [MUSIC_STOP, ...cues], "the base story"));
    }
    if (b.positions) {
      const slots = new Map();
      // the slots of the beat and the ones given to fixes of characters on a taken slot
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
      checkFocus(b, on);
    }
    if (b.kind === "say" && b.speaker) {
      if (!cast.has(b.speaker)) { errors.push(unknown(`${b.path}/say`, "unknownCast", "cast member", b.speaker, cast.keys())); continue; }
      used.add(b.speaker);
      if (!on.has(b.speaker)) {
        if (b.motion || b.expression)
          errors.push({ path: b.path, code: "offStage", message: `${b.speaker} is not on stage: a motion or an expression needs the speaker on stage` });
        else warnings.push({ path: `${b.path}/say`, code: "speakerOffStage", message: `${b.speaker} speaks from off stage` });
      }
      checkAction(b.speaker, b.motion, b.expression, b.path);
      checkFocus(b, on);
      checkLookAt({ lookAt: b.lookAt, path: b.path }, on);
      checkActions(b, on, b.speaker);
    } else if (b.kind === "narrate") {
      checkFocus(b, on);
      checkActions(b, on, null);
    } else if (b.kind === "camera") {
      checkFocus(b, on);
    } else if (b.kind === "action") {
      if (!cast.has(b.action)) {
        errors.push(unknown(`${b.path}/action`, "unknownCast", "cast member", b.action, cast.keys()));
      } else {
        used.add(b.action);
        if (!on.has(b.action))
          errors.push({ path: b.path, code: "offStageAction", message: `${b.action} is not on stage: an action needs the character on stage` });
        checkAction(b.action, b.motion, b.expression, b.path);
        checkLookAt(b, on);
      }
    }
  }
  for (const c of script.cast) if (!used.has(c.id)) warnings.push({ path: c.path, code: "unusedCast", message: `${c.id} never comes on stage or speaks` });
  return { language, errors, warnings };
};

// ------------------------------------------------------------------------------------------------ compiling

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
  const enterMotion = (m) => {
    if (m.motion) return resolveMotion(m.motion, m.slot, motionsOf(m.cast));
    const a = actions[cast.get(m.cast).model];
    if (!a.defaultMotion) return "";
    const v = resolveMotion(motionStem(a.defaultMotion).stem, m.slot, a.motions);
    return v === a.defaultMotion ? "" : v;
  };

  // the models: one Character row per cast member that comes on stage (the player loads them before playing)
  const onStageEver = new Set(script.beats.flatMap((b) => (b.positions || []).map((p) => p.cast)));
  const story = { format: 1, advId: 0, episode: "episode.json", chats: {}, effects: {},
    parts: { scene: base.story.parts.scene, ui: { ...base.story.parts.ui }, fonts: { ...base.story.parts.fonts },
      assets: Object.fromEntries(Object.entries(base.story.parts.assets).filter(([key]) => /^Adv\/(Stage|Transition)\//.test(key))),
      models: {}, sounds: {}, videos: {} } };
  for (const c of script.cast) {
    if (!onStageEver.has(c.id)) continue;
    const key = models[c.model];
    story.parts.models[key] = c.model;
    row("Character", { TargetName: c.id, TargetAssetName: key.replace(/^Character\/Live2D\//, "") });
  }

  let on = new Map(), scenes = 0, bgm = 0, camera = CAMERAS.middle;
  let lastShot = null;                                          // the distance and focus of the last Focus row
  const expression = new Map();                                 // cast id -> the expression it shows
  const focus = (staged) => {
    const slots = [...staged.values()].map((m) => m.slot);
    return slots.length ? Math.min(9, Math.max(1, Math.round(slots.reduce((a, b) => a + b, 0) / slots.length))) : 5;
  };
  // Focus row fields: an explicit focus point, position or cast member, else the group's centre. A cast focus writes
  // the cast member's slot as PositionType, like the official solo close-ups (their TargetName rows are pair framings
  // that follow one character's head); PositionType keeps the distance's own vertical framing, so a 2.8x shot is a
  // head-and-shoulders close-up and not a face-only crop.
  const focusFields = (b, staged, distance) => {
    const fields = { CameraDistance: distance };
    if (typeof b.focus === "number") fields.PositionType = b.focus;
    else if (b.focus && b.focus in POSITIONS) fields.PositionType = POSITIONS[b.focus];
    else if (b.focus && staged.has(b.focus)) fields.PositionType = staged.get(b.focus).slot;
    else fields.PositionType = focus(staged);
    return fields;
  };
  const positionOf = (target, staged) => {
    if (typeof target === "number") return target;
    if (target && target in POSITIONS) return POSITIONS[target];
    return target && staged.get(target) ? staged.get(target).slot : 0;
  };
  // The official cut: a closer distance cuts (no Duration), a wider one eases back over 1.2 s, and a lateral move at
  // the same distance pans over 0.5 s (close-ups cut between sides). `auto` uses it; an explicit duration wins.
  const autoDuration = (fields, distance) => {
    if (!lastShot) return 0;
    if (distance > lastShot.distance) return 0;
    if (distance < lastShot.distance) return FOCUS_RETURN;
    if ((fields.PositionType ?? 0) !== lastShot.pos || (fields.TargetName || "") !== lastShot.name)
      return distance >= CAMERAS.close ? 0 : FOCUS_PAN;
    return 0;
  };
  // A Focus row and, when the beat asks for one, a Track row: the camera pans by `track` from the focus point. A
  // track without a focus keeps the camera's current focus and only pans; a scene always re-establishes its focus.
  // Duration priority: the field's own duration, then a camera beat's cameraDuration, then the cut/ease the compiler
  // chooses. A Track follows the Focus row's duration unless its own trackDuration or the cameraDuration is set.
  const cameraRows = (b, staged, distance, { duration = 0, noWait = false, focusAlways = false, auto = false } = {}) => {
    let move = duration, hasFocusRow = false;
    if (b.focus || b.camera !== undefined || b.track === undefined || focusAlways) {
      const fields = focusFields(b, staged, distance);
      if (b.focusDuration !== undefined) move = b.focusDuration;
      else if (b.cameraDuration !== undefined) move = b.cameraDuration;
      else if (auto) move = autoDuration(fields, distance);
      if (move) fields.Duration = move;
      if (noWait) fields.IsNoWait = 1;
      row("Focus", fields);
      lastShot = { distance, pos: fields.PositionType ?? 0, name: fields.TargetName || "" };
      hasFocusRow = true;
    }
    if (b.track !== undefined) {
      const trackMove = b.trackDuration !== undefined ? b.trackDuration
        : b.cameraDuration !== undefined ? b.cameraDuration
          : hasFocusRow ? move : 0;
      row("Track", { Parameter1: String(b.track), ...(trackMove ? { Duration: trackMove } : {}), IsNoWait: 1 });
    }
  };
  // a slow Zoom after the Focus/Track rows: the line's shot pushes in or pulls out over `zoomDuration` seconds
  const durationOf = (b, own, fallback) => b[own] ?? b.cameraDuration ?? b.duration ?? fallback;
  const pedestalRow = (b) => {
    if (b.pedestal === undefined) return;
    row("Pedestal", { Parameter1: String(b.pedestal), IsNoWait: 1,
                      Duration: durationOf(b, "pedestalDuration", DEFAULT_OFFICIAL_DURATION) });
  };
  const panRow = (b) => {
    if (b.pan === undefined) return;
    const fields = { Parameter1: String(b.pan), IsNoWait: 1,
                     Duration: durationOf(b, "panDuration", DEFAULT_OFFICIAL_DURATION) };
    if (b.panFocusSlide !== undefined) fields.Parameter3 = String(b.panFocusSlide);
    row("PanV2", fields);
  };
  const dofRow = (b) => {
    if (b.dof === undefined) return;
    const fields = { Parameter1: String(b.dof), IsNoWait: 1,
                     Duration: durationOf(b, "dofDuration", DEFAULT_OFFICIAL_DURATION) };
    // the engine reads CanvasLayers as an array; 0 is the background, 2 the character field
    if (b.dofLayers !== undefined) fields.CanvasLayers = [b.dofLayers];
    row("DoF", fields);
  };
  const zoomRow = (b) => {
    if (b.zoom === undefined) return;
    const duration = b.zoomDuration ?? b.cameraDuration ?? b.duration ?? DEFAULT_OFFICIAL_DURATION;
    row("Zoom", { Parameter1: String(b.zoom), Duration: duration, IsNoWait: 1 });
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
    row("Look", { TargetName: target, Parameter1: String(b.look), Parameter2: String(b.lookY ?? 0),
                  Duration: b.lookDuration ?? b.cameraDuration ?? 0.5, IsNoWait: 1 });
  };
  // the official rows a beat adds after its Focus/Track rows, in a fixed order
  const officialRows = (b, target = "") => {
    pedestalRow(b);
    panRow(b);
    dofRow(b);
    zoomRow(b);
    seRow(b);
    lookRow(b, target);
  };
  const motionFade = (b) => (b.motionFadeIn !== undefined ? b.motionFadeIn : MOTION_FADE);
  const motionWait = (b) => (b.motionWait !== undefined ? { MotionWait: b.motionWait } : {});
  const enter = (m, duration, b = null) => {
    const motion = enterMotion(m);
    row("In", { TargetName: m.cast, PositionType: m.slot, ...(duration ? { Duration: duration } : {}), IsNoWait: 1,
                ...(motion ? { MotionName: motion } : {}), ...(m.expression ? { ExpressionName: m.expression } : {}),
                ...(b && b.motionFadeIn !== undefined ? { MotionFadeIn: b.motionFadeIn } : {}) });
    expression.set(m.cast, m.expression || "");
  };

  for (const b of script.beats) {
    if (b.kind === "scene") {
      const next = new Map(b.positions.map((p) => [p.cast, p]));
      if (scenes) {
        row("FadeOut", { Duration: SCENE_FADE });
        for (const m of on.values()) row("Out", { TargetName: m.cast, PositionType: m.slot });
      }
      row("Stage", { TargetAssetName: stageKey.get(b.stage) });
      if (b.music === MUSIC_STOP) { if (bgm) { row("Bgm", { Parameter1: "1" }); bgm = 0; } }
      else if (b.music) {
        const m = music.get(b.music);
        if (m.sound !== bgm) { row("Bgm", { BgmID: m.sound, Parameter1: BGM_FADE }); bgm = m.sound; }
      }
      for (const m of next.values()) enter(m, 0, b);
      camera = b.camera || CAMERAS.middle;
      cameraRows(b, next, camera, { focusAlways: true });
      officialRows(b);
      if (scenes) row("FadeIn", { Duration: SCENE_FADE });
      if (b.location.trim()) row("Location", { AdvTextID: textId(`custom_location_${b.index}`, plainText(b.location)) });
      on = next;
      scenes++;
    } else if (b.kind === "positions") {
      const next = new Map(b.positions.map((p) => [p.cast, p]));
      // each Out waits for its fade, so that a slot is free before a character enters it
      for (const m of on.values())
        if (!next.has(m.cast) || next.get(m.cast).slot !== m.slot) row("Out", { TargetName: m.cast, PositionType: m.slot, Duration: CAST_FADE });
      for (const m of next.values()) {
        if (!on.has(m.cast) || on.get(m.cast).slot !== m.slot) enter(m, CAST_FADE, b);
        else if (m.motion || m.expression) {
          const motion = resolveMotion(m.motion, m.slot, motionsOf(m.cast));
          const exp = m.expression || expression.get(m.cast) || "";
          if (motion) row("Motion", { TargetName: m.cast, MotionName: motion, MotionFadeIn: motionFade(b), ...motionWait(b),
                                      ...(exp ? { ExpressionName: exp } : {}) });
          else row("Expression", { TargetName: m.cast, ExpressionName: exp, MotionFadeIn: motionFade(b) });
          expression.set(m.cast, exp);
        }
      }
      if (b.camera) camera = b.camera;
      cameraRows(b, next, camera, { duration: FOCUS_MOVE, noWait: true, focusAlways: true });
      officialRows(b);
      on = next;
    } else if (b.kind === "say" || b.kind === "narrate") {
      const speaker = b.speaker ? cast.get(b.speaker) : null;
      if (b.camera) camera = b.camera;
      if (b.focus || b.camera || b.track !== undefined)
        cameraRows(b, on, camera, { auto: true, noWait: true });
      const lookTarget = speaker && on.has(speaker.id) ? speaker.id : "";
      officialRows(b, lookTarget);
      // actions at 0 are the game's usual pre-line reactions (a listener turning, smiling, looking over); later ones
      // stay timed inside the line and are played by Talk's HostActions
      for (const a of b.actions || []) {
        if (a.at > 0) continue;
        const id = a.cast || b.speaker;
        if (!id || !on.has(id)) continue;
        const motion = resolveMotion(a.motion, on.get(id).slot, motionsOf(id));
        if (motion) {
          const exp = a.expression || expression.get(id) || "";
          row("Motion", { TargetName: id, MotionName: motion, MotionFadeIn: MOTION_FADE, ...(exp ? { ExpressionName: exp } : {}) });
          expression.set(id, exp);
        } else if (a.expression) {
          row("Expression", { TargetName: id, ExpressionName: a.expression, MotionFadeIn: MOTION_FADE });
          expression.set(id, a.expression);
        }
        const pos = positionOf(a.lookAt, on);
        if (pos) row("LookTarget", { TargetName: id, PositionType: pos, Duration: 0.2, IsNoWait: 1 });
      }
      if (speaker && on.has(speaker.id)) {
        const motion = resolveMotion(b.motion, on.get(speaker.id).slot, motionsOf(speaker.id));
        if (motion) {
          // a Motion row sets the expression too (an empty one is the default): the current one unless the line sets one
          const exp = b.expression || expression.get(speaker.id) || "";
          row("Motion", { TargetName: speaker.id, MotionName: motion, MotionFadeIn: motionFade(b), ...motionWait(b),
                          ...(exp ? { ExpressionName: exp } : {}) });
          expression.set(speaker.id, exp);
        } else if (b.expression) {
          row("Expression", { TargetName: speaker.id, ExpressionName: b.expression, MotionFadeIn: motionFade(b) });
          expression.set(speaker.id, b.expression);
        }
        const pos = positionOf(b.lookAt, on);
        if (pos) row("LookTarget", { TargetName: speaker.id, PositionType: pos, Duration: 0.2, IsNoWait: 1 });
      }
      const hostActions = [];
      for (const a of b.actions || []) {
        if (a.at <= 0) continue;
        const id = a.cast || b.speaker;
        if (!id || !on.has(id)) continue;
        const action = { at: a.at, TargetName: id, MotionFadeIn: 0.15 };
        const motion = resolveMotion(a.motion, on.get(id).slot, motionsOf(id));
        if (motion) action.MotionName = motion;
        if (a.expression) action.ExpressionName = a.expression;
        const pos = positionOf(a.lookAt, on);
        if (pos) action.LookTargetPosition = pos;
        hostActions.push(action);
      }
      const fields = { AdvTextID: textId(`custom_line_${b.index}`, plainText(b.text)) };
      if (hostActions.length) fields.HostActions = hostActions;
      if (speaker) Object.assign(fields, { TargetName: speaker.id, TargetTextIDs: [textId(`custom_name_${speaker.id}`, plainText(speaker.name))],
                                           TargetTextColors: [NAME_COLOR] });
      row("Talk", fields);
      lines.push({ line: lines.length, beat: b.index, path: b.path, ...(b.id ? { id: b.id } : {}),
                   speaker: speaker ? speaker.id : null, name: speaker ? speaker.name : "", text: b.text });
    } else if (b.kind === "camera") {
      if (b.camera) camera = b.camera;
      if (b.camera !== undefined || b.focus || b.track !== undefined)
        cameraRows(b, on, camera, { auto: true, noWait: true });
      officialRows(b);
    } else if (b.kind === "fade") {
      row(FADE_DIRECTIONS[b.fade], { Duration: b.duration || SCENE_FADE });
    } else if (b.kind === "pause") {
      row("Delay", { Duration: b.pause });
    } else if (b.kind === "action") {
      const m = on.get(b.action);
      if (m) {
        officialRows(b, b.action);
        const motion = resolveMotion(b.motion, m.slot, motionsOf(b.action));
        if (motion) {
          const exp = b.expression || expression.get(b.action) || "";
          row("Motion", { TargetName: b.action, MotionName: motion, MotionFadeIn: motionFade(b), ...motionWait(b),
                          ...(exp ? { ExpressionName: exp } : {}) });
          expression.set(b.action, exp);
        } else if (b.expression) {
          row("Expression", { TargetName: b.action, ExpressionName: b.expression, MotionFadeIn: motionFade(b) });
          expression.set(b.action, b.expression);
        }
        const pos = positionOf(b.lookAt, on);
        if (pos) row("LookTarget", { TargetName: b.action, PositionType: pos, Duration: 0.2, IsNoWait: 1 });
        if (b.duration) row("Delay", { Duration: b.duration });
      }
    }
  }

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
export const scriptTexts = (script) => [script.title, ...script.cast.map((c) => c.name),
  ...script.beats.map((b) => (b.kind === "scene" ? b.location : b.text || ""))].join("");
