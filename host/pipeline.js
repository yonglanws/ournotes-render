// One complete job: AI script (or a supplied script) -> TTS -> compile/compose over the base site -> browser render ->
// audio mix -> MP4. Every stage reports progress through the queue task.
import fs from "node:fs";
import path from "node:path";
import { fontFamily } from "../scripts/lib/story-author/script.js";
import { generateScript, prepareScript } from "./ai/storyWriter.js";
import { synthesizeStory, speakingLines } from "./tts/tts.js";
import { composeWithVoices } from "./render/compile.js";

export class PipelineError extends Error {
  constructor(message, { status = 500, code = "job_failed", details = null } = {}) {
    super(message);
    this.name = "PipelineError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const parseJsonArg = (v) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { throw new PipelineError("script is not valid JSON", { status: 400, code: "bad_request" }); }
};

// A one-line story cannot be staged (two lines are the minimum for a
// speaker/listener exchange), so a cap below two is a request error instead of
// being silently promoted to two.
const maxLinesOf = (request, fallback) => {
  const raw = request.maxLines ?? fallback;
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 2) {
    throw new PipelineError("maxLines must be an integer of at least 2", { status: 400, code: "bad_request" });
  }
  return Math.min(300, value);
};

export class Pipeline {
  constructor({ config, catalog, llm, tts, renderer, logger }) {
    this.config = config;
    this.catalog = catalog;
    this.llm = llm;
    this.tts = tts;
    this.renderer = renderer;
    this.logger = logger;
  }

  // The AI stage on its own: prompt -> validated ournotes.story-script/1 document, without TTS or rendering.
  async generateScriptOnly(request, { signal = null } = {}) {
    if (!this.catalog) throw new PipelineError("the site is not configured (paths.site / paths.siteFormat)", { status: 503, code: "site_missing" });
    if (!this.llm?.available) throw new PipelineError("LLM is not configured (llm.enabled / llm.model / llm key)",
      { status: 503, code: "llm_missing" });
    const base = String(request.base || "").trim();
    const catalog = await this.catalog.catalog({ manifest: base });
    const req = {
      prompt: String(request.prompt || "").trim().slice(0, 4000),
      base,
      language: String(request.language || "").trim(),
      title: String(request.title || "").trim().slice(0, 64),
      targetMinutes: request.targetMinutes != null
        ? Math.max(0.5, Math.min(10, Number(request.targetMinutes) || 3)) : undefined,
      maxLines: maxLinesOf(request, this.config.story?.maxLines),
    };
    if (!req.prompt) throw new PipelineError("prompt is required", { status: 400, code: "bad_request" });
    const out = await generateScript({ llm: this.llm, catalog, request: req, config: this.config, logger: this.logger,
      signal });
    return { ok: true, script: out.doc, warnings: out.warnings || [], usage: out.usage || null,
      stages: out.stages ?? null, plan: out.plan ?? null, dialogue: out.dialogue ?? null };
  }

  async run(request, { signal, jobId, progress }) {
    const t0 = Date.now();
    if (!this.catalog) throw new PipelineError("the site is not configured (paths.site / paths.siteFormat)", { status: 503, code: "site_missing" });
    if (this.catalog.kind === "site-format")
      throw new PipelineError(
        "paths.siteFormat can only generate scripts; use /api/v1/script/generate, or configure a product site for /api/v1/generate",
        { status: 400, code: "site_format" });
    const req = {
      prompt: String(request.prompt || "").trim().slice(0, 4000),
      script: request.script ? parseJsonArg(request.script) : null,
      base: String(request.base || (request.script && request.script.base) || "").trim(),
      language: String(request.language || (request.script && request.script.language) || "").trim(),
      title: String(request.title || "").trim().slice(0, 64),
      targetMinutes: request.targetMinutes != null
        ? Math.max(0.5, Math.min(10, Number(request.targetMinutes) || 3)) : undefined,
      maxLines: maxLinesOf(request, this.config.story?.maxLines),
      tts: request.tts !== false,
    };
    if (!req.prompt && !req.script) throw new PipelineError("prompt or script is required", { status: 400, code: "bad_request" });

    const siteCatalog = await this.catalog.catalog({ manifest: req.base });
    progress("writing", 0.03, req.script ? "校验剧本" : "AI 编写剧本");
    let script, warnings = [], doc = null, diagnostics = null;
    if (req.script) {
      // a caller may cast any model of the site, not only the models preloaded for the AI prompt: load the actions of
      // the cast models it names so the checker validates their motion/expression names too
      let validationCatalog = siteCatalog;
      try {
        const cast = req.script.cast;
        const ids = Array.isArray(cast) ? cast.map((c) => c && c.model)
          : cast && typeof cast === "object" ? Object.values(cast).map((c) => (typeof c === "string" ? c : c && c.model))
            : [];
        const actions = await this.catalog.actionsFor(ids);
        if (actions.size) {
          validationCatalog = { ...siteCatalog, models: siteCatalog.models.map((m) => (actions.has(m.id)
            ? { ...m, ...actions.get(m.id), actionsKnown: true } : m)) };
        }
      } catch { /* the checker reports an unknown model */ }
      const prepared = prepareScript({ doc: req.script, catalog: validationCatalog, request: req, config: this.config,
        logger: this.logger });
      if (prepared.errors?.length)
        throw new PipelineError("the script has errors", { status: 400, code: "invalid_script", details: prepared.errors });
      script = prepared.script;
      doc = prepared.doc;
      warnings = prepared.warnings || [];
    } else {
      if (!this.llm?.available) throw new PipelineError("LLM is not configured (llm.enabled / llm.model / llm key)",
        { status: 503, code: "llm_missing" });
      const out = await generateScript({ llm: this.llm, catalog: siteCatalog, request: req, config: this.config, logger: this.logger,
        signal, onProgress: (phase, p, message) => progress(phase, 0.03 + p * 0.2, message) });
      script = out.script;
      doc = out.doc;
      warnings = out.warnings || [];
      // Staged/single AI diagnostics for run-to-run comparison; additive only.
      diagnostics = {
        stages: out.stages ?? null,
        plan: out.plan ?? null,
        dialogue: out.dialogue ?? null,
        usage: out.usage ?? null,
      };
    }

    // TTS: the backend's own stage. A missing voice or a failed line leaves that line silent unless tts.required.
    const ttsConfig = { ...this.config.tts, enabled: this.config.tts.enabled && req.tts,
                        translateForTts: this.config.llm.translateForTts };
    const lines = speakingLines(script, siteCatalog);
    progress("synthesizing", 0.25, "合成配音");
    let voices = new Map();
    if (ttsConfig.enabled && this.tts) {
      voices = await synthesizeStory({
        script, catalog: siteCatalog, config: ttsConfig, client: this.tts.client, voiceBook: this.tts.voiceBook, llm: this.llm,
        signal, logger: this.logger, onProgress: (p, message) => progress("synthesizing", 0.25 + p * 0.3, message),
      });
    } else if (ttsConfig.enabled) {
      this.logger.warn?.("TTS is enabled but not available; rendering without voices");
    }
    const voiceReport = voices.report || null;
    const ttsResult = {
      enabled: ttsConfig.enabled, lines: lines.length, voiced: voices.size,
      ...(voiceReport ? {
        voices: voiceReport.voices, fallbackLines: voiceReport.fallbackLines, silentLines: voiceReport.silentLines,
        failedLines: voiceReport.failedLines, fallbackSpeakers: voiceReport.fallbackSpeakers,
        silentSpeakers: voiceReport.silentSpeakers, failedSpeakers: voiceReport.failedSpeakers,
      } : {}),
    };

    progress("compiling", 0.57, "编译 Our Notes 剧情");
    const language = script.language || siteCatalog.language;
    const family = fontFamily(script.font, language);
    // compose from the raw document: the parsed view keeps cast as an array, while the format has a cast object
    const composed = await composeWithVoices({ catalog: this.catalog, script: doc, voices, language, font: family });
    if (composed.errors?.length)
      throw new PipelineError("the story could not be compiled", { status: 400, code: "invalid_script", details: composed.errors });
    warnings = [...warnings, ...(composed.warnings || [])];
    if (!doc) doc = script;
    const manifestPath = `stories/ournotes-${jobId.replace(/[^a-z0-9-]/gi, "").slice(0, 48)}.json`;

    const render = await this.renderer.render({
      story: { manifest: composed.manifest, manifestPath, files: composed.assets, language: composed.language, script },
      jobId, signal,
      onProgress: (phase, p, message) => progress(phase, 0.6 + p * 0.38, message),
    });
    if (!render.report.ended) this.logger.warn?.("the render stopped at video.maxDurationSec before the story ended");
    progress("writing_output", 0.99, "写入剧本与结果");
    const storyFile = path.join(this.config.paths.output, `${jobId}.story.json`);
    fs.writeFileSync(storyFile, JSON.stringify({
      // the raw script document, so the file can be sent back to /api/v1/render unchanged
      format: script.format, script: doc, warnings,
      tts: ttsResult,
      ...(diagnostics ? { diagnostics } : {}),
    }, null, 2));
    const stat = fs.statSync(render.output);
    return {
      success: true,
      videoPath: render.output,
      storyPath: storyFile,
      fileSize: stat.size,
      duration: Math.round(render.duration * 1000) / 1000,
      frameCount: render.report.frames,
      downloadUrl: `/api/v1/download/${path.basename(render.output)}`,
      storyDownloadUrl: `/api/v1/download/${path.basename(storyFile)}`,
      tts: ttsResult,
      warnings,
      timings: { totalMs: Date.now() - t0, renderMs: Math.round((render.report.seconds || 0) * 1000) },
      story: { title: script.title, language: composed.language, lines: lines.length, cast: doc.cast },
      ...(diagnostics ? { diagnostics } : {}),
    };
  }
}
