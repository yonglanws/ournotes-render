// The HTTP API. Pure JSON in/out: the AstrBot plugin (or any client) submits a prompt or a script, polls a task, and
// downloads the MP4. Queue, AI writing and TTS all live behind these endpoints.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { findBrowser } from "../../scripts/lib/story-author/chrome.js";
import { prepareScript } from "../ai/storyWriter.js";
import { QueueFullError, TaskCancelledError, TaskTimeoutError } from "../queue/taskQueue.js";
import { PipelineError } from "../pipeline.js";
import { validateFfmpeg } from "../render/ffmpeg.js";
import { HttpError, readJson, safeName, sendJson } from "./http.js";

const version = (() => {
  try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || "0.1.0"; }
  catch { return "0.1.0"; }
})();

const human = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
};

const withTimeout = (promise, ms, onTimeout) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    try { onTimeout?.(); } catch { /* best effort */ }
    reject(new HttpError(504, "export timed out"));
  }, ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

export class ApiServer {
  constructor({ config, queue, pipeline, catalog, logger }) {
    this.config = config;
    this.queue = queue;
    this.pipeline = pipeline;
    this.catalog = catalog;
    this.logger = logger;
    this.startedAt = Date.now();
    this.cleanupStats = { lastRun: null, removed: 0, freedBytes: 0, totalRuns: 0 };
    this.server = http.createServer((req, res) => this._handle(req, res).catch((e) => this._fail(res, e)));
    this.cleanupTimer = setInterval(() => this.cleanup().catch((e) => this.logger.warn?.(`cleanup: ${e.message}`)),
      config.queue.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.server.port, this.config.server.host, () => {
        this.server.removeListener("error", reject);
        const a = this.server.address();
        this.logger.info?.(`API listening on http://${a.address}:${a.port}`);
        resolve(a);
      });
    });
  }

  close() {
    clearInterval(this.cleanupTimer);
    return new Promise((resolve) => { this.server.closeAllConnections?.(); this.server.close(() => resolve()); });
  }

  // Only exact origins from server.corsOrigins. Any other origin gets no CORS headers, so a browser cannot read the
  // answer; same-origin and server-to-server clients are unaffected.
  _cors(req, res) {
    res.setHeader("vary", "Origin");
    const origin = req.headers.origin;
    if (!this.config.server.cors || !origin || !this.config.server.corsOrigins.includes(origin)) return;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization, x-user-id");
    res.setHeader("access-control-max-age", "86400");
  }

  _authorized(req) {
    const key = this.config.secrets.apiKey;
    if (!key) return true;
    return (req.headers.authorization || "") === `Bearer ${key}`;
  }

  async _handle(req, res) {
    this._cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const u = new URL(req.url, "http://localhost");
    const p = u.pathname.replace(/\/+$/, "") || "/";
    if (p === "/api/v1/health") return this._health(res);
    if (!this._authorized(req)) return sendJson(res, 401, { success: false, message: "unauthorized" });
    if (req.method === "GET" && p === "/api/v1/status") return this._status(res);
    if (req.method === "GET" && p === "/api/v1/resources") return this._resources(res, u.searchParams);
    if (req.method === "GET" && p === "/api/v1/files") return this._files(res, u.searchParams);
    if (req.method === "GET" && p === "/api/v1/cleanup/stats") return this._cleanupStats(res);
    if (req.method === "POST" && p === "/api/v1/cleanup") return this._cleanup(res);
    if (req.method === "GET" && p.startsWith("/api/v1/download/")) return this._download(res, p.slice("/api/v1/download/".length));
    if (req.method === "POST" && (p === "/api/v1/generate" || p === "/api/v1/render")) return this._generate(req, res);
    if (req.method === "POST" && p === "/api/v1/script/generate") return this._generateScript(req, res);
    if (req.method === "POST" && p === "/api/v1/script/check") return this._check(req, res);
    const taskMatch = p.match(/^\/api\/v1\/tasks\/([A-Za-z0-9._-]+)(\/status)?$/);
    if (req.method === "GET" && taskMatch) {
      const v = this.queue.view(taskMatch[1]);
      if (!v) return sendJson(res, 200, { taskId: taskMatch[1], status: "unknown" });
      return sendJson(res, 200, { success: true, ...v });
    }
    const cancelMatch = p.match(/^\/api\/v1\/tasks\/([A-Za-z0-9._-]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const ok = this.queue.cancel(cancelMatch[1], "cancelled by API");
      return sendJson(res, 200, { taskId: cancelMatch[1], cancelled: ok });
    }
    if (req.method === "GET" && p === "/api/v1/tasks") return sendJson(res, 200, { success: true, tasks: this.queue.list() });
    return sendJson(res, 404, { success: false, message: "not found" });
  }

  _health(res) {
    let ffmpeg = null, browser = null;
    try { ffmpeg = validateFfmpeg(this.config.video.ffmpegPath || ""); } catch (e) { ffmpeg = { error: e.message }; }
    try { browser = findBrowser(this.config.render.chrome || ""); } catch (e) { browser = { error: e.message }; }
    sendJson(res, 200, {
      success: true, service: "ournotes-player-host", version, uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      site: this.config.paths.site ? { configured: true, dir: this.config.paths.site } : { configured: false },
      queue: this.queue.summary(),
      render: { concurrency: this.config.queue.concurrency, gpu: this.config.render.gpu },
      ffmpeg, browser,
      llm: { configured: this.config.llm.enabled && !!this.config.llm.model, model: this.config.llm.model,
             key: !!this.config.secrets.llmApiKey },
      tts: {
        enabled: this.config.tts.enabled, baseUrl: this.config.tts.baseUrl,
        voices: this.config.voiceSummary?.count || 0,
        defaultVoice: !!this.config.voiceSummary?.defaultVoice,
        required: !!this.config.tts.required, emotion: !!this.config.tts.emotion?.enabled,
      },
      config: { errors: this.config.issues?.errors?.length || 0, warnings: this.config.issues?.warnings?.length || 0 },
      cleanup: { ...this.cleanupStats, maxAgeHours: this.config.queue.outputMaxAgeHours },
    });
  }

  _status(res) {
    sendJson(res, 200, { success: true, queue: this.queue.summary(), tasks: this.queue.list({ limit: 50 }),
                         outputs: this._listOutputs().length,
                         uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) });
  }

  async _resources(res, params) {
    if (!this.catalog) return sendJson(res, 503, { success: false, message: "the site is not configured" });
    try {
      const catalog = await this.catalog.catalog({ manifest: params.get("base") || "", refresh: params.get("refresh") === "1" });
      sendJson(res, 200, {
        success: true, base: catalog.manifest, language: catalog.language, languages: catalog.languages,
        stages: catalog.stages, music: catalog.music,
        models: catalog.models.map((m) => ({ id: m.id, name: m.name, character: m.character, group: m.group,
          motions: m.motions, expressions: m.expressions, defaultMotion: m.defaultMotion,
          defaultExpression: m.defaultExpression })),
        bases: this.catalog.bases(),
        voices: this.config.tts.voices.map((c) => c.name).filter(Boolean),
        personas: this.config.story.personas.map((p) => p.name).filter(Boolean),
      });
    } catch (e) {
      sendJson(res, 503, { success: false, message: e.message, code: "site" });
    }
  }

  async _generateScript(req, res) {
    const body = await readJson(req);
    if (!body || typeof body !== "object") throw new HttpError(400, "a JSON object is required");
    try {
      const result = await this.pipeline.generateScriptOnly(body);
      sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof PipelineError) throw new HttpError(e.status, e.message, { code: e.code, details: e.details });
      throw e;
    }
  }

  async _generate(req, res) {
    const body = await readJson(req);
    if (!body || typeof body !== "object") throw new HttpError(400, "a JSON object is required");
    const userId = String(body.userId || req.headers["x-user-id"] || req.socket.remoteAddress || "");
    const wait = body.wait !== false;
    const timeoutMs = Math.max(1000, Math.min(2 ** 31 - 1, Number(body.timeout) || 1800000));
    let task;
    try {
      task = this.queue.submit({
        userId, priority: Number(body.priority) || 0, label: String(body.prompt || (body.script ? "script" : "")).slice(0, 60),
        run: (ctx) => this.pipeline.run(body, { signal: ctx.signal, jobId: ctx.task.id, progress: ctx.progress }),
      });
    } catch (e) {
      if (e instanceof QueueFullError) return sendJson(res, 429, { success: false, message: e.message, code: "queue_full" });
      throw e;
    }
    if (!wait) {
      return sendJson(res, 202, { success: true, taskId: task.id, status: "queued",
        statusUrl: `/api/v1/tasks/${task.id}`, downloadUrl: null }, { location: `/api/v1/tasks/${task.id}` });
    }
    // a client that disconnects before the answer cancels its render instead of leaving it running
    const onClose = () => { if (!res.writableEnded) this.queue.cancel(task.id, "client disconnected"); };
    res.on("close", onClose);
    try {
      const result = await withTimeout(task.promise, timeoutMs, () => this.queue.cancel(task.id, "request timed out"));
      return sendJson(res, 200, { success: true, message: "Video exported successfully", ...result });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof TaskCancelledError) throw new HttpError(499, "Export cancelled", { code: "cancelled" });
      if (e instanceof TaskTimeoutError) throw new HttpError(504, e.message, { code: "timeout" });
      if (e instanceof PipelineError) throw new HttpError(e.status, e.message, { code: e.code, details: e.details });
      throw e;
    } finally {
      res.removeListener("close", onClose);
    }
  }

  async _check(req, res) {
    const body = await readJson(req);
    if (!this.catalog) return sendJson(res, 503, { success: false, message: "the site is not configured" });
    try {
      const doc = body.script ?? body;
      const manifest = String(body.base || (doc && doc.base) || "");
      let catalog = await this.catalog.catalog({ manifest });
      try {
        const cast = doc && doc.cast;
        const ids = Array.isArray(cast) ? cast.map((c) => c && c.model)
          : cast && typeof cast === "object" ? Object.values(cast).map((c) => (typeof c === "string" ? c : c && c.model))
            : [];
        const actions = await this.catalog.actionsFor(ids);
        if (actions.size) {
          catalog = { ...catalog, models: catalog.models.map((m) => (actions.has(m.id)
            ? { ...m, ...actions.get(m.id), actionsKnown: true } : m)) };
        }
      } catch { /* the checker reports an unknown model */ }
      const prepared = prepareScript({
        doc, catalog,
        request: { ...body, base: manifest, language: body.language || (doc && doc.language) || "" },
        config: this.config, logger: this.logger,
      });
      const ok = !prepared.errors?.length;
      sendJson(res, ok ? 200 : 400, {
        ok, errors: prepared.errors || [], warnings: prepared.warnings || [],
        // the normalized raw document, ready to send back to /api/v1/render
        ...(ok ? { script: prepared.doc } : {}),
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, errors: [{ path: "", code: "bad_request", message: e.message }] });
    }
  }

  // entries of the output directory; `path` is internal and never serialized
  _listOutputs() {
    const dir = this.config.paths.output;
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(mp4|json)$/i.test(entry.name) || !safeName(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const st = fs.statSync(full);
      out.push({ filename: entry.name, path: full, size: st.size, sizeHuman: human(st.size),
                 createdAt: st.birthtime.toISOString(), modifiedAt: st.mtime.toISOString(), mtimeMs: st.mtimeMs,
                 downloadUrl: `/api/v1/download/${encodeURIComponent(entry.name)}` });
    }
    return out;
  }

  _files(res, params) {
    const page = Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(params.get("limit") || "20", 10) || 20));
    const sort = params.get("sort") === "asc" ? "asc" : "desc";
    const all = this._listOutputs().sort((a, b) => (sort === "asc" ? a.mtimeMs - b.mtimeMs : b.mtimeMs - a.mtimeMs));
    const total = all.length, totalPages = Math.ceil(total / limit);
    const data = all.slice((page - 1) * limit, page * limit)
      .map(({ mtimeMs, path: _p, ...x }) => x);
    sendJson(res, 200, { success: true, data, pagination: { page, limit, total, totalPages } });
  }

  _download(res, raw) {
    let name;
    try { name = decodeURIComponent(raw); } catch { return sendJson(res, 400, { error: "Invalid filename" }); }
    if (!safeName(name)) return sendJson(res, 400, { error: "Invalid filename" });
    // look the name up in the directory listing rather than joining a caller string onto a path
    const entry = this._listOutputs().find((x) => x.filename === name);
    if (!entry) return sendJson(res, 404, { error: "File not found" });
    res.writeHead(200, { "content-type": name.endsWith(".mp4") ? "video/mp4" : "application/json",
      "content-length": entry.size, "content-disposition": "attachment", "cache-control": "no-cache",
      "x-content-type-options": "nosniff" });
    fs.createReadStream(entry.path).pipe(res);
  }

  async _cleanup(res) {
    const r = await this.cleanup();
    sendJson(res, 200, { success: true, ...r });
  }

  _cleanupStats(res) {
    sendJson(res, 200, { success: true, policy: { maxAgeHours: this.config.queue.outputMaxAgeHours },
                         stats: this.cleanupStats });
  }

  async cleanup() {
    const maxAge = this.config.queue.outputMaxAgeHours * 3600 * 1000;
    let removed = 0, freedBytes = 0;
    if (maxAge > 0) {
      const cutoff = Date.now() - maxAge;
      for (const entry of this._listOutputs()) {
        try {
          if (entry.mtimeMs < cutoff) { fs.unlinkSync(entry.path); removed++; freedBytes += entry.size; }
        } catch { /* raced */ }
      }
    }
    this.cleanupStats = { lastRun: new Date().toISOString(), removed, freedBytes,
                          totalRuns: this.cleanupStats.totalRuns + 1 };
    return { removed, freedBytes, ...this.cleanupStats };
  }

  _fail(res, e) {
    const status = e instanceof HttpError ? e.status : e instanceof QueueFullError ? 429 : 500;
    if (!res.headersSent) {
      sendJson(res, status, { success: false, message: e.message || String(e), ...(e.details ? { details: e.details } : {}),
        ...(e.code ? { code: e.code } : {}) });
    } else res.destroy();
    if (status >= 500) this.logger.error?.(e.stack || e.message);
  }
}
