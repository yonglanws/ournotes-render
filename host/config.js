// Host configuration: config.yaml (or OURNOTES_CONFIG), then OURNOTES_* environment overrides.
//
// Secrets are never read from the file: only the environment variables named by *Env fields are read. The loader also
// returns `issues` (errors and warnings) instead of failing on the first typo, so `npm run check` and the startup log
// can explain every problem at once: unknown keys with a suggestion, wrong types, an unusable TTS voice table, a
// non-loopback server without an API key, and similar.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadPersonaDirs, mergePersonas } from "./ai/personas.js";
import { assertServiceHttpUrl } from "./net/urlGuard.js";
import {
  enrichVoiceAliases, mergeVoiceLists, normalizeVoiceTable, validateVoices, voiceSummary,
} from "./tts/voices.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  server: { port: 9881, host: "127.0.0.1", cors: false, corsOrigins: [] },
  security: { apiKeyEnv: "OURNOTES_API_KEY", allowPrivateServiceEndpoints: false },
  paths: { site: "", siteFormat: "", output: "output", cache: "cache" },
  story: { base: "", language: "", font: "sans", title: "", targetMinutes: 3, maxModels: 24, maxLines: 120,
           maxOnStage: 3, cast: [], personas: [], personaDirs: [] },
  llm: { enabled: true, baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OURNOTES_LLM_API_KEY",
         model: "gpt-4.1-mini", temperature: 0.85, maxTokens: 8192, timeoutMs: 120000, retries: 2,
         concurrency: 2,
         repairRounds: 2, pipeline: "staged", directorPlan: false, translateForTts: true, systemPrompt: "",
         reasoningEffort: "" },
  tts: {
    enabled: true,
    // gpt-sovits: POST /tts (api_v2) with server-side weight switching; irodori: OpenAI-compatible
    // POST /v1/audio/speech where every request carries its own reference audio / LoRA adapter / caption.
    provider: "gpt-sovits",
    baseUrl: "http://127.0.0.1:9880", apiKeyEnv: "", textLang: "auto", promptLang: "ja",
    // The fallback voice of characters without their own entry. `voicesFile` points at a list like
    // voices.example.yaml; `voices` are inline entries that override file entries field by field.
    defaultVoice: { refAudioPath: "", promptText: "", promptLang: "" }, voicesFile: "", voices: [],
    speedFactor: 1, topK: 5, topP: 1, temperature: 1, repetitionPenalty: 1.35, fragmentInterval: 0.3,
    mediaType: "wav", timeoutMs: 60000, concurrency: 2, retries: 1, required: false,
    // Irodori-TTS inference defaults; the fields mirror MySekaiStoryteller's tts.irodori block.
    irodori: {
      model: "irodori-tts", responseFormat: "wav", numSteps: 40,
      cfgScaleText: 3, cfgScaleCaption: 3, cfgScaleSpeaker: 5, durationScale: 1,
      chunkingEnabled: true, chunkMinChars: 80, seed: -1,
      defaultLoraAdapter: "", defaultCaption: "", emotionLabels: [],
    },
    emotion: { enabled: false, labels: [], presets: [] },
  },
  video: { width: 1300, height: 600, fps: 30, jpegQuality: 92, crf: 20, preset: "veryfast", encoder: "auto",
           audioBitrate: "192k", maxDurationSec: 600, audioSampleRate: 48000, watermark: "", ffmpegPath: "" },
  render: { gpu: false, chrome: "", chromeArgs: [], core: "", motionsync: "", taskTimeoutMs: 1800000,
            settleFrames: 0 },
  queue: { concurrency: 1, maxSize: 20, taskTimeoutMs: 3600000, retentionMs: 3600000,
           cleanupIntervalMs: 600000, outputMaxAgeHours: 24 },
  logLevel: "info",
};

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isObjSection = (key) => isObj(DEFAULTS[key]);

const merge = (base, extra) => {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  }
  return out;
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const env = (...names) => {
  for (const n of names) if (process.env[n] !== undefined) return process.env[n];
  return undefined;
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

const nearest = (key, known) => {
  let best = "";
  let score = Infinity;
  for (const candidate of known) {
    const d = levenshtein(String(key).toLowerCase(), String(candidate).toLowerCase());
    if (d < score) { score = d; best = candidate; }
  }
  return score <= 2 ? best : "";
};

// Recurses through the default shape. Arrays are values (their entries are validated by their owners), except that
// an object inside an array is never walked here.
const unknownKeys = (node, shape, prefix, out) => {
  for (const [key, value] of Object.entries(node || {})) {
    if (!(key in shape)) {
      const hint = nearest(key, Object.keys(shape));
      out.push({ path: `${prefix}${key}`, message: `unknown setting${hint ? `; did you mean ${hint}?` : ""}` });
      continue;
    }
    if (isObj(value) && isObj(shape[key])) unknownKeys(value, shape[key], `${prefix}${key}.`, out);
  }
};

const checkArray = (obj, key, pathName, issues) => {
  if (obj?.[key] === undefined) return;
  if (!Array.isArray(obj[key])) {
    issues.errors.push({ path: pathName, message: "expected a list" });
    obj[key] = [];
  }
};

const checkObject = (obj, key, pathName, issues) => {
  if (obj?.[key] === undefined) return;
  if (!isObj(obj[key])) {
    issues.errors.push({ path: pathName, message: "expected a mapping" });
    obj[key] = {};
  }
};

const serviceUrlIssue = (value, pathName, allowPrivate, issues) => {
  if (!value) return;
  try {
    assertServiceHttpUrl(value, { allowPrivate, what: pathName });
  } catch (e) {
    issues.errors.push({ path: pathName, message: e.message });
  }
};

const cleanVoiceShape = (tts) => {
  if (tts.defaultVoice === undefined || !isObj(tts.defaultVoice)) tts.defaultVoice = { ...DEFAULTS.tts.defaultVoice };
  for (const key of ["refAudioPath", "promptText", "promptLang"]) {
    const value = tts.defaultVoice[key];
    tts.defaultVoice[key] = value === undefined || value === null ? "" : String(value).trim();
  }
};

// The loaded config with absolute paths and resolved secrets (secrets stay out of JSON serialization: see public()).
export const loadConfig = ({ file = env("OURNOTES_CONFIG") || path.join(ROOT, "config.yaml"),
                             logger = console } = {}) => {
  const errors = [];
  const warnings = [];
  let disk = {};
  if (fs.existsSync(file)) {
    try {
      disk = yaml.load(fs.readFileSync(file, "utf8")) || {};
      if (!isObj(disk)) throw new Error("the document is not a mapping");
    } catch (e) {
      throw new Error(`${file}: ${e.message}`, { cause: e });
    }
  }

  // ---- shape, unknown keys and exact type errors ----------------------------------------------------------------
  unknownKeys(disk, DEFAULTS, "", warnings);
  for (const key of Object.keys(DEFAULTS)) {
    if (isObjSection(key) && disk[key] !== undefined && !isObj(disk[key])) {
      errors.push({ path: key, message: "expected a mapping" });
      delete disk[key];
    }
  }
  if (disk.logLevel !== undefined && typeof disk.logLevel !== "string") {
    errors.push({ path: "logLevel", message: "expected a string" });
    delete disk.logLevel;
  }
  for (const [section, key] of [
    ["server", "host"], ["paths", "site"], ["paths", "siteFormat"], ["paths", "output"], ["paths", "cache"],
    ["story", "base"], ["story", "language"], ["story", "font"], ["story", "title"],
    ["llm", "baseUrl"], ["llm", "model"], ["llm", "apiKeyEnv"], ["llm", "reasoningEffort"],
    ["tts", "provider"], ["tts", "baseUrl"], ["tts", "apiKeyEnv"], ["tts", "textLang"], ["tts", "promptLang"],
    ["tts", "voicesFile"], ["tts", "mediaType"], ["video", "ffmpegPath"], ["video", "preset"], ["video", "encoder"],
    ["video", "audioBitrate"], ["video", "watermark"], ["render", "chrome"], ["render", "core"],
    ["render", "motionsync"],
  ]) {
    const obj = disk[section];
    if (isObj(obj) && obj[key] !== undefined && typeof obj[key] !== "string") {
      errors.push({ path: `${section}.${key}`, message: "expected a string" });
      delete obj[key];
    }
  }
  const ttsDisk = isObj(disk.tts) ? disk.tts : {};
  checkArray(ttsDisk, "voices", "tts.voices", { errors });
  checkArray(disk.story || {}, "personaDirs", "story.personaDirs", { errors });
  checkArray(disk.story || {}, "personas", "story.personas", { errors });
  checkArray(disk.story || {}, "cast", "story.cast", { errors });
  checkArray(disk.server || {}, "corsOrigins", "server.corsOrigins", { errors });
  checkObject(ttsDisk, "defaultVoice", "tts.defaultVoice", { errors });
  checkObject(ttsDisk, "emotion", "tts.emotion", { errors });
  checkObject(ttsDisk, "irodori", "tts.irodori", { errors });
  if (isObj(ttsDisk.irodori)) {
    for (const key of ["model", "responseFormat", "defaultLoraAdapter", "defaultCaption"]) {
      if (ttsDisk.irodori[key] !== undefined && typeof ttsDisk.irodori[key] !== "string") {
        errors.push({ path: `tts.irodori.${key}`, message: "expected a string" });
        delete ttsDisk.irodori[key];
      }
    }
    checkArray(ttsDisk.irodori, "emotionLabels", "tts.irodori.emotionLabels", { errors });
  }
  if (ttsDisk.emotion !== undefined && isObj(ttsDisk.emotion)) {
    checkArray(ttsDisk.emotion, "labels", "tts.emotion.labels", { errors });
    checkArray(ttsDisk.emotion, "presets", "tts.emotion.presets", { errors });
  }
  if (Array.isArray(disk.story?.personas)) {
    for (const [index, persona] of disk.story.personas.entries()) {
      if (isObj(persona)) {
        unknownKeys(persona, { name: "", prompt: "", group: "", summary: "", aliases: [], source: "" },
          `story.personas[${index}].`, warnings);
      }
    }
  }
  for (const [oldKey, replacement, where] of [
    ["astrbotConfig", "tts.voicesFile / tts.voices", "AstrBot config reuse was removed"],
    ["characters", "tts.voices", "tts.characters was renamed"],
    ["defaultRefAudioPath", "tts.defaultVoice.refAudioPath", "the flat default voice fields were grouped"],
    ["defaultPromptText", "tts.defaultVoice.promptText", "the flat default voice fields were grouped"],
  ]) {
    if (ttsDisk[oldKey] !== undefined) {
      errors.push({ path: `tts.${oldKey}`, message: `${where}; use ${replacement} (see voices.example.yaml)` });
    }
  }

  const cfg = merge(DEFAULTS, disk);

  // environment overrides
  const set = (obj, key, value) => { if (value !== undefined) obj[key] = value; };
  set(cfg.server, "port", num(env("OURNOTES_PORT"), undefined));
  set(cfg.server, "host", env("OURNOTES_HOST"));
  set(cfg.paths, "site", env("OURNOTES_SITE"));
  set(cfg.paths, "siteFormat", env("OURNOTES_SITE_FORMAT"));
  set(cfg.paths, "output", env("OURNOTES_OUTPUT"));
  set(cfg.paths, "cache", env("OURNOTES_CACHE"));
  set(cfg.llm, "baseUrl", env("OURNOTES_LLM_BASE_URL"));
  set(cfg.llm, "model", env("OURNOTES_LLM_MODEL"));
  set(cfg.llm, "reasoningEffort", env("OURNOTES_LLM_REASONING_EFFORT"));
  if (env("OURNOTES_LLM_CONCURRENCY") !== undefined)
    cfg.llm.concurrency = num(env("OURNOTES_LLM_CONCURRENCY"), cfg.llm.concurrency);
  set(cfg.tts, "provider", env("OURNOTES_TTS_PROVIDER"));
  set(cfg.tts, "baseUrl", env("OURNOTES_TTS_BASE_URL"));
  set(cfg.tts.irodori, "model", env("OURNOTES_IRODORI_MODEL"));
  if (env("OURNOTES_IRODORI_NUM_STEPS") !== undefined) {
    cfg.tts.irodori.numSteps = num(env("OURNOTES_IRODORI_NUM_STEPS"), cfg.tts.irodori.numSteps);
  }
  set(cfg.render, "chrome", env("OURNOTES_CHROME"));
  set(cfg.render, "core", env("OURNOTES_CORE"));
  set(cfg, "logLevel", env("OURNOTES_LOG_LEVEL"));
  if (env("OURNOTES_FFMPEG")) cfg.video.ffmpegPath = env("OURNOTES_FFMPEG");

  // resolve relative paths against the repository root
  const abs = (p) => (p ? path.resolve(ROOT, String(p)) : "");
  cfg.paths.site = abs(cfg.paths.site);
  cfg.paths.siteFormat = abs(cfg.paths.siteFormat);
  cfg.paths.output = abs(cfg.paths.output);
  cfg.paths.cache = abs(cfg.paths.cache);
  if (cfg.render.core && !/^https?:\/\//i.test(cfg.render.core)) cfg.render.core = abs(cfg.render.core);
  if (cfg.render.motionsync && !/^https?:\/\//i.test(cfg.render.motionsync)) cfg.render.motionsync = abs(cfg.render.motionsync);
  if (cfg.render.chrome) cfg.render.chrome = abs(cfg.render.chrome);
  if (cfg.video.ffmpegPath) cfg.video.ffmpegPath = abs(cfg.video.ffmpegPath);
  cfg.tts.voicesFile = cfg.tts.voicesFile ? abs(cfg.tts.voicesFile) : "";

  // numbers and ranges
  cfg.server.port = Math.max(1, Math.min(65535, Math.round(num(cfg.server.port, 9881))));
  cfg.video.width = Math.max(320, Math.min(7680, Math.round(num(cfg.video.width, 1300))));
  cfg.video.height = Math.max(180, Math.min(4320, Math.round(num(cfg.video.height, 600))));
  cfg.video.fps = Math.max(1, Math.min(30, Math.round(num(cfg.video.fps, 30))));
  cfg.video.jpegQuality = Math.max(30, Math.min(100, Math.round(num(cfg.video.jpegQuality, 92))));
  cfg.video.crf = Math.max(0, Math.min(51, Math.round(num(cfg.video.crf, 20))));
  cfg.video.maxDurationSec = Math.max(1, num(cfg.video.maxDurationSec, 600));
  cfg.video.audioSampleRate = Math.max(8000, Math.round(num(cfg.video.audioSampleRate, 48000)));
  cfg.llm.concurrency = Math.max(1, Math.min(16, Math.round(num(cfg.llm.concurrency, 2))));
  cfg.render.taskTimeoutMs = Math.max(1000, num(cfg.render.taskTimeoutMs, 1800000));
  cfg.render.settleFrames = Math.max(0, Math.min(120, Math.round(num(cfg.render.settleFrames, 0))));
  checkArray(cfg.render, "chromeArgs", "render.chromeArgs", { errors });
  cfg.render.chromeArgs = (cfg.render.chromeArgs || []).map((value, index) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    errors.push({ path: `render.chromeArgs[${index}]`, message: "expected a non-empty string" });
    return null;
  }).filter(Boolean);
  cfg.queue.concurrency = Math.max(1, Math.min(16, Math.round(num(cfg.queue.concurrency, 1))));
  cfg.queue.maxSize = Math.max(1, Math.round(num(cfg.queue.maxSize, 20)));
  cfg.queue.taskTimeoutMs = Math.max(1000, num(cfg.queue.taskTimeoutMs, 3600000));
  cfg.queue.retentionMs = Math.max(0, num(cfg.queue.retentionMs, 3600000));
  cfg.queue.cleanupIntervalMs = Math.max(1000, num(cfg.queue.cleanupIntervalMs, 600000));
  cfg.queue.outputMaxAgeHours = Math.max(0, num(cfg.queue.outputMaxAgeHours, 24));
  cfg.story.targetMinutes = Math.max(0.5, num(cfg.story.targetMinutes, 3));
  cfg.story.maxModels = Math.max(1, Math.round(num(cfg.story.maxModels, 24)));
  const maxLines = num(cfg.story.maxLines, 120);
  if (!Number.isInteger(maxLines) || maxLines < 2) {
    errors.push({ path: "story.maxLines", message: "must be an integer of at least 2; a one-line story cannot be staged" });
    cfg.story.maxLines = maxLines;
  } else {
    cfg.story.maxLines = Math.min(300, maxLines);
  }
  cfg.story.maxOnStage = Math.max(2, Math.min(3, Math.round(num(cfg.story.maxOnStage, 3))));
  cfg.llm.temperature = Math.max(0, Math.min(2, num(cfg.llm.temperature, 0.85)));
  cfg.llm.maxTokens = Math.max(256, Math.round(num(cfg.llm.maxTokens, 8192)));
  cfg.llm.timeoutMs = Math.max(1000, num(cfg.llm.timeoutMs, 120000));
  cfg.llm.retries = Math.max(0, Math.min(8, Math.round(num(cfg.llm.retries, 2))));
  cfg.llm.repairRounds = Math.max(0, Math.min(4, Math.round(num(cfg.llm.repairRounds, 2))));
  cfg.llm.pipeline = String(cfg.llm.pipeline || "staged").toLowerCase() === "single" ? "single" : "staged";
  cfg.llm.directorPlan = cfg.llm.directorPlan === true;
  const effort = String(cfg.llm.reasoningEffort || "").trim().toLowerCase();
  if (effort && !["minimal", "low", "medium", "high"].includes(effort)) {
    warnings.push({ path: "llm.reasoningEffort",
                    message: `unknown thinking effort ${JSON.stringify(cfg.llm.reasoningEffort)}; use minimal, low, medium or high` });
    cfg.llm.reasoningEffort = "";
  } else {
    cfg.llm.reasoningEffort = effort;
  }
  cfg.tts.concurrency = Math.max(1, Math.min(16, Math.round(num(cfg.tts.concurrency, 2))));
  cfg.tts.timeoutMs = Math.max(1000, num(cfg.tts.timeoutMs, 60000));
  cfg.tts.retries = Math.max(0, Math.min(5, Math.round(num(cfg.tts.retries, 1))));
  cfg.tts.fragmentInterval = Math.max(0, Math.min(2, num(cfg.tts.fragmentInterval, 0.3)));
  const provider = String(cfg.tts.provider || "gpt-sovits").trim().toLowerCase().replace(/_/g, "-");
  if (!["gpt-sovits", "irodori"].includes(provider)) {
    warnings.push({ path: "tts.provider",
                    message: `unknown TTS provider ${JSON.stringify(cfg.tts.provider)}; use gpt-sovits or irodori` });
    cfg.tts.provider = "gpt-sovits";
  } else {
    cfg.tts.provider = provider;
  }
  // Irodori inference defaults, in the same shape as MySekaiStoryteller's tts.irodori block.
  cfg.tts.irodori = isObj(cfg.tts.irodori) ? cfg.tts.irodori : {};
  const irodori = cfg.tts.irodori;
  const stringField = (key, fallback) => {
    const value = String(irodori[key] ?? "").trim();
    irodori[key] = value || fallback;
  };
  stringField("model", "irodori-tts");
  const format = String(irodori.responseFormat || "wav").trim().toLowerCase();
  if (!["wav", "mp3", "ogg"].includes(format)) {
    warnings.push({ path: "tts.irodori.responseFormat",
                    message: `unknown response format ${JSON.stringify(irodori.responseFormat)}; use wav, mp3 or ogg` });
    irodori.responseFormat = "wav";
  } else {
    irodori.responseFormat = format;
  }
  irodori.numSteps = Math.max(1, Math.min(200, Math.round(num(irodori.numSteps, 40))));
  irodori.cfgScaleText = Math.max(0, num(irodori.cfgScaleText, 3));
  irodori.cfgScaleCaption = Math.max(0, num(irodori.cfgScaleCaption, 3));
  irodori.cfgScaleSpeaker = Math.max(0, num(irodori.cfgScaleSpeaker, 5));
  irodori.durationScale = Math.max(0.1, Math.min(10, num(irodori.durationScale, 1)));
  irodori.chunkingEnabled = irodori.chunkingEnabled !== false;
  irodori.chunkMinChars = Math.max(1, Math.min(1000, Math.round(num(irodori.chunkMinChars, 80))));
  const seed = Math.round(num(irodori.seed, -1));
  irodori.seed = seed >= 0 ? seed : -1;
  stringField("defaultLoraAdapter", "");
  stringField("defaultCaption", "");
  irodori.emotionLabels = Array.isArray(irodori.emotionLabels)
    ? irodori.emotionLabels.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  cfg.story.cast = Array.isArray(cfg.story.cast) ? cfg.story.cast.map(String) : [];
  cfg.story.personas = Array.isArray(cfg.story.personas) ? cfg.story.personas : [];
  // Character sheets live outside the repository (one *.md per character); the writer gets only the selected cast's
  // full sheet, so a long sheet does not have to fit in every prompt.
  cfg.story.personaDirs = Array.isArray(cfg.story.personaDirs)
    ? cfg.story.personaDirs.map((p) => String(p || "").trim()).filter(Boolean).map((p) => path.resolve(ROOT, p))
    : [];
  cfg.story.personas = mergePersonas(loadPersonaDirs(cfg.story.personaDirs, { logger }), cfg.story.personas);
  cfg.tts.emotion = isObj(cfg.tts.emotion) ? cfg.tts.emotion : { enabled: false, labels: [], presets: [] };
  cfg.tts.emotion.enabled = !!cfg.tts.emotion.enabled;
  // With Irodori, `irodori.emotionLabels` (the MSST field) is a complete emotion list on its own; treat it as the
  // switch so copying an MSST irodori block also turns per-line emotion selection on.
  if (cfg.tts.provider === "irodori" && cfg.tts.irodori.emotionLabels.length) cfg.tts.emotion.enabled = true;
  cfg.tts.emotion.labels = Array.isArray(cfg.tts.emotion.labels) ? cfg.tts.emotion.labels.map(String) : [];
  cfg.tts.emotion.presets = Array.isArray(cfg.tts.emotion.presets) ? cfg.tts.emotion.presets : [];
  cfg.server.corsOrigins = Array.isArray(cfg.server.corsOrigins) ? cfg.server.corsOrigins.map(String) : [];
  cfg.server.cors = !!cfg.server.cors && cfg.server.corsOrigins.length > 0;

  // ---- the voice table ---------------------------------------------------------------------------------------
  cleanVoiceShape(cfg.tts);
  const voiceIssues = { errors: [], warnings: [] };
  let fileTable = { defaultVoice: {}, voices: [] };
  if (cfg.tts.voicesFile) {
    if (!fs.existsSync(cfg.tts.voicesFile)) {
      voiceIssues.errors.push({ path: "tts.voicesFile", message: `not found: ${cfg.tts.voicesFile}` });
    } else {
      try {
        const raw = yaml.load(fs.readFileSync(cfg.tts.voicesFile, "utf8"));
        fileTable = normalizeVoiceTable(raw, "voicesFile", voiceIssues);
      } catch (e) {
        voiceIssues.errors.push({ path: "tts.voicesFile", message: `${cfg.tts.voicesFile}: ${e.message}` });
      }
    }
  }
  const inlineTable = normalizeVoiceTable({ defaultVoice: cfg.tts.defaultVoice, voices: cfg.tts.voices },
                                           "tts", voiceIssues);
  const defaultVoice = { ...fileTable.defaultVoice };
  for (const [key, value] of Object.entries(inlineTable.defaultVoice)) {
    if (value !== "") defaultVoice[key] = value;
  }
  cfg.tts.defaultVoice = { refAudioPath: "", promptText: "", promptLang: "", ...defaultVoice };
  cfg.tts.voices = enrichVoiceAliases(mergeVoiceLists(fileTable.voices, inlineTable.voices), cfg.story.personas);
  validateVoices(cfg.tts, voiceIssues);
  errors.push(...voiceIssues.errors);
  warnings.push(...voiceIssues.warnings);

  // ---- service endpoints and security defaults ----------------------------------------------------------------
  const allowPrivate = cfg.security.allowPrivateServiceEndpoints === true;
  if (cfg.llm.enabled) {
    if (!cfg.llm.baseUrl) errors.push({ path: "llm.baseUrl", message: "llm is enabled but no base URL is set" });
    serviceUrlIssue(cfg.llm.baseUrl, "llm.baseUrl", allowPrivate, { errors });
    if (!cfg.llm.model) errors.push({ path: "llm.model", message: "llm is enabled but no model is set" });
  }
  if (cfg.tts.enabled) serviceUrlIssue(cfg.tts.baseUrl, "tts.baseUrl", allowPrivate, { errors });

  // secrets: environment only
  cfg.secrets = {
    llmApiKey: cfg.llm.apiKeyEnv ? env(cfg.llm.apiKeyEnv) || "" : "",
    ttsApiKey: cfg.tts.apiKeyEnv ? env(cfg.tts.apiKeyEnv) || "" : "",
    apiKey: cfg.security.apiKeyEnv ? env(cfg.security.apiKeyEnv) || "" : "",
  };

  if (!["127.0.0.1", "::1", "localhost"].includes(String(cfg.server.host).toLowerCase()) && !cfg.secrets.apiKey) {
    warnings.push({ path: "security.apiKeyEnv",
      message: `server.host is ${cfg.server.host} but ${cfg.security.apiKeyEnv || "the API key variable"} is empty; ` +
        "the API would be reachable without authentication" });
  }
  if (!cfg.paths.site && !cfg.paths.siteFormat) {
    warnings.push({ path: "paths.site",
      message: "not set; set paths.site (nnnotes product site) or paths.siteFormat (downloaded bdon site)" });
  } else if (!cfg.paths.site) {
    warnings.push({ path: "paths.site",
      message: "not set; using paths.siteFormat (a downloaded bdon site) for the full pipeline" });
  }
  if (Math.abs(cfg.video.width / cfg.video.height - 13 / 6) > 0.01) {
    warnings.push({ path: "video.width", message: "the game's ADV viewport is 13:6; other aspect ratios letterbox or crop" });
  }
  const font = String(cfg.story.font || "sans").toLowerCase();
  if (!["sans", "serif", "rounded"].includes(font)) {
    warnings.push({ path: "story.font", message: "expected sans, serif or rounded; the compiler will use it as a family name" });
  }
  cfg.story.font = font;

  cfg.issues = { errors, warnings };
  cfg.voiceSummary = voiceSummary(cfg.tts);
  cfg.configFile = fs.existsSync(file) ? path.resolve(file) : null;
  return cfg;
};

// The config without secrets and without the multi-KB character sheets, for logs.
export const publicConfig = (cfg) => {
  const { secrets, story, ...rest } = cfg;
  return {
    ...rest,
    story: {
      ...story,
      personas: (story.personas || []).map((p) => ({
        name: p.name, group: p.group, summary: p.summary, aliases: p.aliases, chars: (p.prompt || "").length,
      })),
    },
    tts: {
      ...rest.tts,
      defaultVoice: { refAudioPath: !!rest.tts?.defaultVoice?.refAudioPath, promptText: !!rest.tts?.defaultVoice?.promptText },
      voices: (rest.tts?.voices || []).map((v) => ({
        name: v.name, aliases: v.aliases,
        ref: !!(v.refAudioPath || (v.refAudioPaths || []).length),
        weights: !!(v.gptWeightsPath || v.sovitsWeightsPath), lora: !!v.loraAdapter,
        emotions: (v.emotions || []).map((e) => e.label),
      })),
    },
    issues: { errors: cfg.issues?.errors?.length || 0, warnings: cfg.issues?.warnings?.length || 0 },
    secrets: { llmApiKey: !!secrets.llmApiKey, ttsApiKey: !!secrets.ttsApiKey, apiKey: !!secrets.apiKey },
  };
};

export const ensureDirs = (cfg) => {
  for (const d of [cfg.paths.output, cfg.paths.cache]) fs.mkdirSync(d, { recursive: true });
};

export const requireSite = (cfg) => {
  if (!cfg.paths.site) throw new Error("paths.site is not set: point it at an nnnotes-built story site");
  if (!fs.existsSync(cfg.paths.site) || !fs.statSync(cfg.paths.site).isDirectory())
    throw new Error(`paths.site is not a directory: ${cfg.paths.site}`);
  return cfg.paths.site;
};
