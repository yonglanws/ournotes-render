// Voice configuration: the host's own voice table (no external bot config format). A voice names one GPT-SoVITS
// reference recording and may carry its GPT/SoVITS weights and per-emotion references. The table may live inline in
// config.yaml (`tts.voices`) or in a separate YAML/JSON file (`tts.voicesFile`); inline entries override file entries
// with the same name field by field.
//
// Paths (refAudioPath, gptWeightsPath, sovitsWeightsPath) are paths on the GPT-SoVITS server, not on this machine.
// They are never fetched by the host, so no URL check applies; only the TTS base URL is a service endpoint.
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => String(v ?? "").replace(/^\uFEFF/, "").trim();

// Names arrive from three places that do not agree on CJK variants (Chinese voice tables, Japanese character sheets,
// the site's model names). Fold the common traditional/Japanese forms so 高松燈, 高松灯 and 高松 燈 compare equal.
const VARIANTS = {
  燈: "灯", 長: "长", 愛: "爱", 樂: "乐", 豊: "丰", 葉: "叶", 鈴: "铃", 華: "华", 櫻: "樱", 繪: "绘", 絵: "绘",
  純: "纯", 紗: "纱", 優: "优", 亞: "亚", 鄉: "乡", 廣: "广", 濱: "滨", 岡: "冈", 澤: "泽", 島: "岛", 邊: "边",
  國: "国", 學: "学", 會: "会", 樣: "样", 眞: "真", 冨: "富", 條: "条", 藝: "艺",
};
export const foldName = (value) => [...String(value || "")].map((c) => VARIANTS[c] || c).join("");
export const normName = (value) => foldName(String(value || "").normalize("NFKC"))
  .replace(/[\s·・]+/g, "").toLowerCase();

export const VOICE_KEYS = Object.freeze([
  "name", "aliases", "refAudioPath", "promptText", "promptLang", "gptWeightsPath", "sovitsWeightsPath",
  "speedFactor", "temperature", "topK", "topP", "repetitionPenalty", "fragmentInterval", "emotions",
]);
export const EMOTION_KEYS = Object.freeze([
  "label", "refAudioPath", "promptText", "promptLang", "speedFactor", "temperature", "topK", "topP",
  "repetitionPenalty", "fragmentInterval",
]);
const PATH_KEYS = ["refAudioPath", "promptText", "promptLang", "gptWeightsPath", "sovitsWeightsPath"];
const NUMBER_KEYS = {
  speedFactor: [0.5, 2, false], temperature: [0, 2, false], topK: [1, 100, true], topP: [0, 1, false],
  repetitionPenalty: [0.5, 2, false], fragmentInterval: [0, 2, false],
};

const fail = (issues, path, message) => issues.errors.push({ path, message });
const warn = (issues, path, message) => issues.warnings.push({ path, message });
const unique = (values) => [...new Set(values.map(str).filter(Boolean))];

const suggest = (key, known) => {
  const k = String(key).toLowerCase();
  let best = "";
  let score = Infinity;
  for (const candidate of known) {
    const c = String(candidate).toLowerCase();
    const distance = levenshtein(k, c);
    if (distance < score) { score = distance; best = candidate; }
  }
  return score <= 2 ? best : "";
};

const levenshtein = (a, b) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
};

const unknownKeys = (raw, known, path, issues) => {
  for (const key of Object.keys(raw)) {
    if (known.includes(key)) continue;
    const hint = suggest(key, known);
    warn(issues, `${path}.${key}`, `unknown voice field${hint ? `; did you mean ${hint}?` : ""}`);
  }
};

const cleanNumber = (raw, key, path, issues) => {
  if (raw[key] === undefined || raw[key] === null || raw[key] === "") return undefined;
  const [min, max, integer] = NUMBER_KEYS[key];
  const n = Number(raw[key]);
  if (!Number.isFinite(n) || n < min || n > max) {
    warn(issues, `${path}.${key}`, `expected ${min}..${max}${integer ? " (integer)" : ""}; ignored`);
    return undefined;
  }
  return integer ? Math.round(n) : n;
};

const cleanEmotion = (raw, path, issues) => {
  if (!isObj(raw)) { warn(issues, path, "an emotion entry must be a mapping; ignored"); return null; }
  unknownKeys(raw, EMOTION_KEYS, path, issues);
  const label = str(raw.label);
  if (!label) { warn(issues, path, "an emotion entry needs a label; ignored"); return null; }
  const out = { label };
  for (const key of PATH_KEYS) if (str(raw[key])) out[key] = str(raw[key]);
  for (const key of Object.keys(NUMBER_KEYS)) {
    const value = cleanNumber(raw, key, path, issues);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

export const normalizeVoiceEntry = (raw, path, issues) => {
  if (!isObj(raw)) { fail(issues, path, "a voice entry must be a mapping"); return null; }
  unknownKeys(raw, VOICE_KEYS, path, issues);
  const name = str(raw.name);
  if (!name) { fail(issues, path, "a voice entry needs a name"); return null; }
  const voice = { name, aliases: [], emotions: [] };
  voice.aliases = unique(Array.isArray(raw.aliases) ? raw.aliases : raw.aliases ? [raw.aliases] : [])
    .filter((a) => a !== name);
  for (const key of PATH_KEYS) if (str(raw[key])) voice[key] = str(raw[key]);
  for (const key of Object.keys(NUMBER_KEYS)) {
    const value = cleanNumber(raw, key, path, issues);
    if (value !== undefined) voice[key] = value;
  }
  voice.emotions = (Array.isArray(raw.emotions) ? raw.emotions : [])
    .map((e, i) => cleanEmotion(e, `${path}.emotions[${i}]`, issues)).filter(Boolean);
  return voice;
};

// `voicesFile` may be a list or {defaultVoice, voices}. `tts.defaultVoice` and `tts.voices` in config.yaml use the same
// shape, so one normalizer covers both.
export const normalizeVoiceTable = (raw, path, issues) => {
  const table = { defaultVoice: {}, voices: [] };
  if (raw === undefined || raw === null) return table;
  if (Array.isArray(raw)) raw = { voices: raw };
  if (!isObj(raw)) { fail(issues, path, "expected a list or a mapping with defaultVoice/voices"); return table; }
  for (const key of Object.keys(raw)) {
    if (key !== "defaultVoice" && key !== "voices") {
      warn(issues, `${path}.${key}`, `unknown field; use defaultVoice or voices`);
    }
  }
  if (raw.defaultVoice !== undefined) {
    if (!isObj(raw.defaultVoice)) fail(issues, `${path}.defaultVoice`, "must be a mapping");
    else {
      const known = ["refAudioPath", "promptText", "promptLang"];
      for (const key of Object.keys(raw.defaultVoice)) {
        if (!known.includes(key)) warn(issues, `${path}.defaultVoice.${key}`, `unknown field`);
      }
      for (const key of known) if (str(raw.defaultVoice[key])) table.defaultVoice[key] = str(raw.defaultVoice[key]);
    }
  }
  if (raw.voices !== undefined && !Array.isArray(raw.voices)) {
    fail(issues, `${path}.voices`, "must be a list");
  } else {
    table.voices = (raw.voices || []).map((v, i) => normalizeVoiceEntry(v, `${path}.voices[${i}]`, issues))
      .filter(Boolean);
  }
  return table;
};

const defined = (value) => value !== undefined && value !== null && value !== "";

// Later entries override earlier ones field by field; aliases are merged and emotions are replaced only when the
// override names some. That is what lets a short config.yaml entry adjust one field of a long voices.yaml entry.
export const mergeVoiceLists = (base, extra) => {
  const out = base.map((v) => ({ ...v, aliases: [...v.aliases], emotions: [...v.emotions] }));
  const at = new Map(out.map((v, i) => [v.name, i]));
  for (const voice of extra) {
    const index = at.get(voice.name);
    if (index == null) { at.set(voice.name, out.length); out.push(voice); continue; }
    const before = out[index];
    const merged = { ...before };
    for (const [key, value] of Object.entries(voice)) if (defined(value)) merged[key] = value;
    merged.aliases = unique([...(before.aliases || []), ...(voice.aliases || [])]).filter((a) => a !== voice.name);
    merged.emotions = voice.emotions.length ? voice.emotions : before.emotions;
    out[index] = merged;
  }
  return out;
};

// A character sheet often knows the names a site uses (Japanese name, romanization) that a voice entry does not. Add
// those aliases when a sheet and a voice describe the same character, so `高松燈` finds the voice `高松灯`.
//
// One sheet may be claimed by several voices (a main voice and an alternate costume/nickname voice). Only the voice
// whose name matches the sheet's name, or the first match, receives the sheet's aliases; and a name that belongs to
// another voice is never added, so an exact `白祥` keeps resolving to the 白祥 voice rather than to 丰川祥子.
export const enrichVoiceAliases = (voices, personas) => {
  const namesOf = (voice) => [voice.name, ...(voice.aliases || [])].map(normName).filter(Boolean);
  const belongsToOther = (voice, name) => voices.some((other) =>
    other !== voice && namesOf(other).includes(normName(name)));
  for (const persona of personas || []) {
    const sheetNames = [persona.name, ...(persona.aliases || [])].map(normName).filter(Boolean);
    const matches = voices.filter((voice) => namesOf(voice).some((name) => sheetNames.includes(name)));
    if (!matches.length) continue;
    const primary = matches.find((voice) => normName(voice.name) === normName(persona.name)) || matches[0];
    const added = [persona.name, ...(persona.aliases || [])]
      .filter((name) => !belongsToOther(primary, name));
    primary.aliases = unique([...(primary.aliases || []), ...added]).filter((a) => a !== primary.name);
  }
  return voices;
};

export const voiceSummary = (tts) => {
  const voices = tts.voices || [];
  const fallback = !!(tts.defaultVoice && tts.defaultVoice.refAudioPath);
  return {
    count: voices.length,
    defaultVoice: fallback,
    withOwnReference: voices.filter((v) => !!v.refAudioPath).length,
    missingReference: voices.filter((v) => !v.refAudioPath && !fallback).map((v) => v.name),
    emotions: voices.reduce((n, v) => n + (v.emotions || []).length, 0),
  };
};

// Errors stop a correct voice; warnings describe a setup that will still render, usually with silence or a shared
// default voice. Both are reported by `npm run check` and logged at startup.
export const validateVoices = (tts, issues) => {
  const summary = voiceSummary(tts);
  if (!tts.enabled) return summary;
  if (!tts.baseUrl) fail(issues, "tts.baseUrl", "TTS is enabled but no base URL is set");
  if (!summary.count && !summary.defaultVoice) {
    const message = "TTS is enabled but no voice is configured; every line will be silent. Set tts.defaultVoice " +
      "or add tts.voices (see voices.example.yaml)";
    if (tts.required) fail(issues, "tts.voices", message);
    else warn(issues, "tts.voices", message);
  }
  if (summary.count && !summary.defaultVoice) {
    const missing = summary.missingReference;
    if (missing.length) {
      const message = `${missing.length} voice(s) have no refAudioPath and there is no defaultVoice: ` +
        `${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}; their lines will be silent`;
      if (tts.required) fail(issues, "tts.defaultVoice", message);
      else warn(issues, "tts.defaultVoice", message);
    }
  }
  if (tts.required && !summary.count) {
    warn(issues, "tts.required", "required is true but no named voices exist; only tts.defaultVoice can be used");
  }
  const labels = new Map();
  for (const voice of tts.voices || []) {
    for (const alias of voice.aliases || []) {
      const owners = labels.get(alias) || [];
      owners.push(voice.name);
      labels.set(alias, owners);
    }
  }
  const collisions = new Map();
  for (const [alias, owners] of labels) {
    const unique = [...new Set(owners)];
    if (unique.length < 2) continue;
    const key = unique.sort().join(" / ");
    if (!collisions.has(key)) collisions.set(key, []);
    collisions.get(key).push(alias);
  }
  for (const [owners, aliases] of collisions) {
    warn(issues, "tts.voices", `aliases shared by ${owners}: ${aliases.join(", ")}; the first matching voice wins. ` +
      "Remove an alias from one voice or make the names distinct");
  }
  const weighted = (tts.voices || []).filter((v) => v.gptWeightsPath || v.sovitsWeightsPath);
  if (weighted.length && weighted.length < (tts.voices || []).length) {
    warn(issues, "tts.voices", `${weighted.length}/${tts.voices.length} voice(s) name GPT/SoVITS weights; a voice without ` +
      "weights uses whatever the GPT-SoVITS server loaded last. Configure weights for every voice, or for none");
  }
  return summary;
};
