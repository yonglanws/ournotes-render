// Integrated TTS: GPT-SoVITS api_v2 compatible synthesis, per-character reference voices, WAV normalization, a disk
// cache, and line-by-line text selection (with optional LLM translation when the story language differs from the
// TTS language). The renderer later turns these files into a story cue sheet.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertServiceHttpUrl } from "../net/urlGuard.js";
import { extractJson } from "../ai/json.js";
import { normalizeWav, probeWav } from "../render/ffmpeg.js";
import { normName } from "./voices.js";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const langBase = (code) => {
  const c = String(code || "").toLowerCase();
  if (c.startsWith("zh")) return "zh";
  if (c.startsWith("ja")) return "ja";
  if (c.startsWith("en")) return "en";
  if (c.startsWith("ko")) return "ko";
  return c;
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason || new Error("aborted")); }, { once: true });
});

export class TTSError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = "TTSError";
    this.code = "tts";
    this.status = status;
    this.retryable = retryable;
  }
}

const namesOf = (c) => [c?.name, ...(Array.isArray(c?.aliases) ? c.aliases : [])]
  .map(normName).filter(Boolean);

export class VoiceBook {
  constructor(config) {
    this.config = config;
    this.voices = (config.voices || []).map((c) => ({ ...c, aliases: [...(c.aliases || [])],
                                                       emotions: [...(c.emotions || [])] }));
  }

  // exact name or alias, then a containment match either way (full name / short name). Spaces and half/full-width
  // variants are ignored, so 高松 燈 and 高松燈 find the same voice.
  voiceFor(...names) {
    for (const raw of names) {
      const n = normName(raw);
      if (!n) continue;
      const exact = this.voices.find((c) => namesOf(c).includes(n));
      if (exact) return exact;
      const near = this.voices.find((c) => namesOf(c).some((cn) => cn && (cn.includes(n) || n.includes(cn))));
      if (near) return near;
    }
    return null;
  }

  // The emotion labels this character can speak: its own mappings, then the global presets and labels.
  labelsFor(...names) {
    const v = this.voiceFor(...names);
    const labels = [
      ...((v && v.emotions) || []).map((e) => e && e.label),
      ...((this.config.emotion && this.config.emotion.presets) || []).map((e) => e && e.label),
      ...((this.config.emotion && this.config.emotion.labels) || []),
    ];
    return [...new Set(labels.map((x) => String(x || "").trim()).filter(Boolean))];
  }

  resolve(...names) { return this.resolveFor("", names); }

  // `emotion` picks a per-character mapping first, then a global preset. A mapping may override the reference audio
  // (true emotional timbre) and/or the synthesis parameters (pacing and temperature when no reference exists).
  resolveFor(emotion, names) {
    const v = this.voiceFor(...names);
    const cfg = this.config;
    const lab = String(emotion || "").trim();
    const entry = lab
      ? ((v && v.emotions) || []).find((e) => e && String(e.label || "").trim() === lab) ||
        ((cfg.emotion && cfg.emotion.presets) || []).find((e) => e && String(e.label || "").trim() === lab)
      : null;
    const pick = (key, fallback) => {
      const value = entry && entry[key];
      return value !== undefined && value !== null && value !== "" ? value : fallback;
    };
    const fallback = cfg.defaultVoice || {};
    const refAudioPath = pick("refAudioPath", v?.refAudioPath || fallback.refAudioPath || "");
    const promptText = pick("promptText", v?.promptText || fallback.promptText || "");
    const promptLang = pick("promptLang", v?.promptLang || fallback.promptLang || cfg.promptLang || "ja");
    const speedFactor = Number(pick("speedFactor", v?.speedFactor ?? cfg.speedFactor ?? 1));
    const temperature = Number(pick("temperature", v?.temperature ?? cfg.temperature ?? 1));
    const topK = Number(pick("topK", v?.topK ?? cfg.topK ?? 5));
    const topP = Number(pick("topP", v?.topP ?? cfg.topP ?? 1));
    const repetitionPenalty = Number(pick("repetitionPenalty", v?.repetitionPenalty ?? cfg.repetitionPenalty ?? 1.35));
    const fragmentInterval = Number(pick("fragmentInterval", v?.fragmentInterval ?? cfg.fragmentInterval ?? 0.3));
    const gptWeightsPath = pick("gptWeightsPath", v?.gptWeightsPath || "");
    const sovitsWeightsPath = pick("sovitsWeightsPath", v?.sovitsWeightsPath || "");
    return {
      name: v?.name || "",
      matched: !!v,
      emotion: lab,
      refAudioPath,
      promptText,
      promptLang,
      gptWeightsPath,
      sovitsWeightsPath,
      speedFactor,
      temperature,
      topK,
      topP,
      repetitionPenalty,
      fragmentInterval,
      key: `${v?.name || "default"}|${lab}|${refAudioPath}|${promptText}|${promptLang}|` +
           `${gptWeightsPath}|${sovitsWeightsPath}|${speedFactor}|${temperature}|${topK}|${topP}|${repetitionPenalty}|` +
           `${fragmentInterval}`,
    };
  }
}

export const ttsAvailable = (config) => !!(config.enabled && config.baseUrl);

export class GptSovitsClient {
  constructor(config, { apiKey = "", logger = console, allowPrivate = true } = {}) {
    this.config = config;
    this.apiKey = apiKey;
    this.logger = logger;
    this.base = String(config.baseUrl || "").replace(/\/+$/, "");
    if (this.base) assertServiceHttpUrl(this.base, { allowPrivate, what: "tts.baseUrl" });
    this.cacheDir = "";
    this._inflight = new Map();
    this._weightsKey = "";
  }

  setCacheDir(dir) { this.cacheDir = dir; fs.mkdirSync(dir, { recursive: true }); }

  requestBody(text, voice, textLang = null) {
    const c = this.config;
    const lang = String(textLang || c.textLang || "ja").toLowerCase();
    const body = {
      text,
      text_lang: !lang || lang === "auto" ? "ja" : lang,
      ref_audio_path: voice.refAudioPath,
      aux_ref_audio_paths: [],
      prompt_text: voice.promptText || "",
      prompt_lang: String(voice.promptLang || c.promptLang || "ja").toLowerCase(),
      top_k: Number(voice.topK ?? c.topK ?? 5), top_p: Number(voice.topP ?? c.topP ?? 1),
      temperature: Number(voice.temperature ?? c.temperature ?? 1),
      text_split_method: "cut5", batch_size: 1, batch_threshold: 0.75, split_bucket: true,
      speed_factor: Number(voice.speedFactor ?? c.speedFactor ?? 1), fragment_interval: Number(voice.fragmentInterval ?? c.fragmentInterval ?? 0.3), seed: -1,
      media_type: c.mediaType || "wav", streaming_mode: false, parallel_infer: true,
      repetition_penalty: Number(voice.repetitionPenalty ?? c.repetitionPenalty ?? 1.35),
    };
    if (voice.gptWeightsPath) body.gpt_weights = voice.gptWeightsPath;
    if (voice.sovitsWeightsPath) body.sovits_weights = voice.sovitsWeightsPath;
    return body;
  }

  async synthesize(text, voice, { signal = null, textLang = null } = {}) {
    if (!this.config.enabled) throw new TTSError("TTS is disabled");
    if (!voice.refAudioPath) throw new TTSError(`no reference audio for ${voice.name || "the default voice"}`);
    return this._cached(text, voice, signal, textLang);
  }

  async _cached(text, voice, signal, textLang) {
    const c = this.config;
    const key = sha256(JSON.stringify({ text, v: voice.key, lang: textLang || c.textLang, promptLang: voice.promptLang,
      speed: c.speedFactor, topK: c.topK, topP: c.topP, temp: c.temperature, rep: c.repetitionPenalty,
      media: c.mediaType }));
    if (this._inflight.has(key)) return this._inflight.get(key);
    const job = this._synthesize(key, text, voice, signal, textLang).finally(() => this._inflight.delete(key));
    this._inflight.set(key, job);
    return job;
  }

  async _synthesize(key, text, voice, signal, textLang) {
    const wav = path.join(this.cacheDir, `${key}.wav`);
    if (fs.existsSync(wav)) {
      try { return { file: wav, ...probeWav(wav) }; } catch { /* rebuild */ }
    }
    await this._ensureWeights(voice, signal);
    const raw = await this._fetch(text, voice, signal, textLang);
    // GPT-SoVITS usually returns WAV; anything else is normalized through ffmpeg.
    const tmp = path.join(this.cacheDir, `${key}.raw`);
    fs.writeFileSync(tmp, raw);
    const looksWav = raw.length > 12 && raw.toString("latin1", 0, 4) === "RIFF" && raw.toString("latin1", 8, 12) === "WAVE";
    try {
      if (looksWav) fs.renameSync(tmp, wav);
      else await normalizeWav({ input: tmp, output: wav, sampleRate: 48000, signal });
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* gone */ }
    }
    return { file: wav, ...probeWav(wav) };
  }

  // GPT-SoVITS loads one GPT/SoVITS weight pair at a time; switch it before a line that names different weights.
  // (The /tts body does not carry weights in api_v2, so they are set through the server's endpoints.)
  async _ensureWeights(voice, signal) {
    const key = `${voice.gptWeightsPath || ""}|${voice.sovitsWeightsPath || ""}`;
    if (key === "|" || !key) return;
    if (this._weightsKey === key) return;
    const timeout = Math.max(1000, Number(this.config.timeoutMs || 120000));
    for (const [endpoint, value] of [["set_gpt_weights", voice.gptWeightsPath],
                                     ["set_sovits_weights", voice.sovitsWeightsPath]]) {
      if (!value) continue;
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason || new Error("aborted"));
      if (signal) {
        if (signal.aborted) throw signal.reason || new Error("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(new TTSError(`${endpoint} timed out`, { retryable: true })), timeout);
      try {
        const url = `${this.base}/${endpoint}?weights_path=${encodeURIComponent(value)}`;
        const response = await fetch(url, { signal: controller.signal });
        const body = await response.text();
        if (!response.ok)
          throw new TTSError(`${endpoint} failed: HTTP ${response.status} ${body.slice(0, 200)}`,
                             { status: response.status, retryable: response.status >= 500 });
      } catch (e) {
        if (controller.signal.aborted) throw controller.signal.reason || e;
        throw e instanceof TTSError ? e : new TTSError(`${endpoint} failed: ${e.message}`, { retryable: true });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      }
    }
    this._weightsKey = key;
  }

  async _fetch(text, voice, signal, textLang) {
    const c = this.config;
    const timeout = Math.max(1000, Number(c.timeoutMs || 60000));
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason || new Error("aborted"));
    if (signal) {
      if (signal.aborted) throw signal.reason || new Error("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new TTSError(`TTS timed out after ${Math.round(timeout / 1000)} s`,
                                                              { retryable: true })), timeout);
    const headers = { "content-type": "application/json", accept: "audio/*,application/octet-stream" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let response;
    try {
      response = await fetch(`${this.base}/tts`, { method: "POST", headers,
        body: JSON.stringify(this.requestBody(text, voice, textLang)),
                                                   signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) throw controller.signal.reason || e;
      throw new TTSError(`TTS connection failed: ${e.message}`, { retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
    const type = response.headers.get("content-type") || "";
    if (!response.ok || type.includes("application/json")) {
      const body = Buffer.from(await response.arrayBuffer()).toString("utf8").slice(0, 500);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new TTSError(`TTS HTTP ${response.status}: ${body}`, { status: response.status, retryable });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new TTSError("TTS returned empty audio", { retryable: true });
    return bytes;
  }
}

const mapLimit = async (items, limit, fn, signal) => {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) throw signal.reason || new Error("aborted");
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
};

const translateLines = async ({ llm, texts, from, to, signal, logger }) => {
  if (!llm?.available || !texts.length) return texts;
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const system = `You are a professional translator. Translate each numbered ${from} line to ${to}. ` +
    "Return ONLY a JSON array of strings, one translation per input line, same order and count. " +
    "Keep the speaker's tone and punctuation; do not add explanations or markdown.";
  try {
    const answer = await llm.json([{ role: "system", content: system }, { role: "user", content: numbered }],
                                  { signal, label: "tts-translate", temperature: 0.2 });
    const arr = extractJson(answer.content);
    if (Array.isArray(arr) && arr.length === texts.length && arr.every((x) => typeof x === "string" && x.trim()))
      return arr.map((x) => x.trim());
    logger.warn?.(`TTS translation returned ${Array.isArray(arr) ? arr.length : "no"} lines for ${texts.length}; using the original text`);
  } catch (e) {
    if (signal?.aborted) throw signal.reason || e;
    logger.warn?.(`TTS translation failed, using the original text: ${e.message}`);
  }
  return texts;
};

// One LLM call labels every line with one of `labels`, so each character can use its emotional reference/pacing.
// Failure is not fatal: every line falls back to its normal voice.
const judgeEmotions = async ({ llm, lines, labels, signal, logger }) => {
  const empty = lines.map(() => "");
  if (!llm?.available || !labels.length || !lines.length) return empty;
  const list = labels.map((x) => `- ${x}`).join("\n");
  const numbered = lines.map((l, i) => `${i + 1}. ${l.speakerName || l.castId}：${String(l.text).replace(/\n/g, " ")}`).join("\n");
  const system = [
    "你是配音情绪标注员。为每一句台词挑选最合适的语气标签。",
    "只能从下面的标签中选：", list,
    "情绪平淡、普通陈述时选“日常平静”，不要过度表演。",
    '只输出一个 JSON 对象：{"emotions":["标签1","标签2",...]}，数量必须与台词条数一致。',
  ].join("\n");
  try {
    const answer = await llm.json([{ role: "system", content: system }, { role: "user", content: numbered }],
                                  { signal, label: "tts-emotion", temperature: 0.2 });
    const data = extractJson(answer.content);
    const arr = Array.isArray(data) ? data : data && Array.isArray(data.emotions) ? data.emotions : null;
    if (!arr || arr.length !== lines.length) {
      logger.warn?.(`TTS emotion: expected ${lines.length} labels, got ${arr ? arr.length : "none"}; using normal voices`);
      return empty;
    }
    return arr.map((x) => (typeof x === "string" && labels.includes(x.trim()) ? x.trim() : ""));
  } catch (e) {
    if (signal?.aborted) throw signal.reason || e;
    logger.warn?.(`TTS emotion judge failed, using normal voices: ${e.message}`);
    return empty;
  }
};

// Lines that speak: [{beat, castId, speakerName, text, modelId, voiceName}]
export const speakingLines = (script, catalog) => {
  const cast = new Map((script.cast || []).map((c) => [c.id, c]));
  const models = new Map((catalog?.models || []).map((m) => [m.id, m]));
  const out = [];
  for (const b of script.beats || []) {
    if (b.kind !== "say" || !b.speaker) continue;
    const c = cast.get(b.speaker);
    if (!c) continue;
    const m = models.get(c.model);
    out.push({ beat: b.index, castId: c.id, speakerName: c.name, text: b.text, modelId: c.model,
               voiceName: m?.name || c.name });
  }
  return out;
};

// Synthesizes every speaking line. -> Map(beat index -> {file, sampleRate, samples, channels, cueName, text, ...})
// The returned Map also carries `report`: how many lines used a named voice, how many fell back to the default voice,
// and which speakers were left silent. That is what makes a missing reference audio visible in the API result instead
// of only in a log line.
export const synthesizeStory = async ({ script, catalog, config, client, voiceBook, llm, signal, logger,
                                        onProgress = () => {} }) => {
  const lines = speakingLines(script, catalog);
  const result = new Map();
  const report = {
    lines: lines.length, voiced: 0, voices: {}, fallbackLines: 0, silentLines: 0, failedLines: 0,
    fallbackSpeakers: [], silentSpeakers: [], failedSpeakers: [],
  };
  result.report = report;
  if (!lines.length || !config.enabled) {
    report.silentLines = lines.length;
    return result;
  }
  const from = langBase(script.language || catalog.language) || "ja";
  const configured = langBase(config.textLang);
  // "auto" (the default) synthesizes the story's own language; a concrete code translates the lines for that voice
  const to = !configured || configured === "auto" ? from : configured;
  let texts = lines.map((l) => l.text.replace(/\r\n?/g, "\n"));
  if (config.translateForTts !== false && from !== to) {
    onProgress(0, "翻译 TTS 台词");
    texts = await translateLines({ llm, texts, from, to, signal, logger });
  }
  let emotions = lines.map(() => "");
  if (config.emotion?.enabled) {
    const labels = [...new Set(lines.flatMap((l) => voiceBook.labelsFor(l.voiceName, l.speakerName, l.castId)))];
    if (labels.length) {
      onProgress(0, "判断台词情绪");
      emotions = await judgeEmotions({ llm, lines, labels, signal, logger });
      const judged = emotions.filter(Boolean).length;
      logger.info?.(`TTS emotion: ${judged}/${lines.length} line(s) labelled`);
    }
  }
  let done = 0;
  const usage = new Map();
  const fallbackSpeakers = new Set();
  const silentSpeakers = new Set();
  const failedSpeakers = new Set();
  // GPT-SoVITS switches GPT/SoVITS weights as global server state: do not parallelize when any voice names weights.
  const switchesWeights = (config.voices || []).some((c) => c.gptWeightsPath || c.sovitsWeightsPath);
  const limit = switchesWeights ? 1 : (config.concurrency || 2);
  await mapLimit(lines, limit, async (line, i) => {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    const voice = voiceBook.resolveFor(emotions[i], [line.voiceName, line.speakerName, line.castId]);
    if (!voice.matched) {
      report.fallbackLines++;
      fallbackSpeakers.add(line.speakerName);
    }
    if (!voice.refAudioPath) {
      if (config.required)
        throw new TTSError(`no reference audio for ${line.speakerName}: set tts.defaultVoice or add a voice entry`);
      report.silentLines++;
      silentSpeakers.add(line.speakerName);
    } else {
      try {
        const audio = await withRetry(() => client.synthesize(texts[i], voice, { signal, textLang: to }), {
          retries: config.retries ?? 1, signal,
          onRetry: (e, attempt) => logger.warn?.(`TTS ${line.speakerName} line ${line.beat} attempt ${attempt} failed: ` +
            `${e.message}; retrying`),
        });
        result.set(line.beat, {
          file: audio.file, sampleRate: audio.sampleRate, samples: audio.samples, channels: audio.channels,
          cueName: `tts_line_${line.beat}`, text: texts[i], speakerId: line.castId, speakerName: line.speakerName,
          voiceName: voice.name || "default", emotion: voice.emotion || "",
        });
        const key = voice.name || "default";
        usage.set(key, (usage.get(key) || 0) + 1);
      } catch (e) {
        if (signal?.aborted) throw signal.reason || e;
        if (config.required) throw e;
        report.failedLines++;
        failedSpeakers.add(line.speakerName);
        logger.warn?.(`TTS skipped for ${line.speakerName} line ${line.beat}: ${e.message}`);
      }
    }
    done++;
    onProgress(done / lines.length, `TTS ${done}/${lines.length}`);
  }, signal);
  report.voiced = result.size;
  report.voices = Object.fromEntries([...usage].sort((a, b) => b[1] - a[1]));
  report.fallbackSpeakers = [...fallbackSpeakers];
  report.silentSpeakers = [...silentSpeakers];
  report.failedSpeakers = [...failedSpeakers];
  if (report.silentLines)
    logger.warn?.(`TTS: ${report.silentLines} line(s) have no reference audio and are silent: ` +
      report.silentSpeakers.join("、"));
  if (report.failedLines)
    logger.warn?.(`TTS: ${report.failedLines} line(s) failed after retries and are silent: ` +
      report.failedSpeakers.join("、"));
  if (report.fallbackLines)
    logger.info?.(`TTS: ${report.fallbackLines} line(s) used the default voice (no named voice matched): ` +
      report.fallbackSpeakers.join("、"));
  logger.info?.(`TTS: ${result.size}/${lines.length} line(s) voiced` +
    (Object.keys(report.voices).length ? ` (${Object.entries(report.voices).map(([n, c]) => `${n}:${c}`).join(", ")})` : ""));
  return result;
};

// Retry helper for transient TTS failures.
export const withRetry = async (fn, { retries = 2, signal, onRetry = null } = {}) => {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (signal?.aborted) throw signal.reason || e;
      if (!e.retryable || i === retries) throw e;
      onRetry?.(e, i + 1);
      await sleep(500 * 2 ** i, signal);
    }
  }
  throw last;
};
