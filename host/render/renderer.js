// Render orchestration: compose files are served over the base site, a headless browser plays the composed story one
// fixed step at a time and posts JPEG frames + an audio event log, then the audio is rebuilt and ffmpeg encodes MP4.
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { BrowserPool } from "../../scripts/lib/story-author/chrome.js";
import { mixAudio } from "./audioMix.js";
import { decodePcm, muxVideoAudio, openVideoPipe, remuxFaststart } from "./ffmpeg.js";
import { createPageServer, CUBISM_CORE_URL } from "./pageServer.js";

const gunzip = promisify(zlib.gunzip);
const brotliDecompress = promisify(zlib.brotliDecompress);

const moveFile = async (src, dest) => {
  try {
    await fs.promises.rename(src, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
  }
};

const readJsonSafe = async (file) => {
  try { return JSON.parse(await fs.promises.readFile(file, "utf8")); }
  catch { return null; }
};

const decodeSiteBlob = async (file) => {
  const raw = await fs.promises.readFile(file);
  if (file.endsWith(".gz")) return gunzip(raw);
  if (file.endsWith(".br")) return brotliDecompress(raw);
  return raw;
};

const resolveCueFileOnHost = async ({ sourcePath, soundId, ext, files, siteDir, manifest, cuesDir }) => {
  if (!sourcePath || typeof sourcePath !== "string") return null;
  const dest = path.join(cuesDir, `${soundId}.${ext}`);
  if (files?.has(sourcePath)) {
    await fs.promises.writeFile(dest, files.get(sourcePath));
    return dest;
  }
  const entry = manifest?.files?.[sourcePath];
  if (entry?.asset && siteDir) {
    const assetFile = path.join(siteDir, ...entry.asset.split("/"));
    if (fs.existsSync(assetFile)) {
      if (!assetFile.endsWith(".gz") && !assetFile.endsWith(".br")) return assetFile;
      await fs.promises.writeFile(dest, await decodeSiteBlob(assetFile));
      return dest;
    }
  }
  // Product-site cues: `cuesheets/<sheet>/<file>` -> product manifest `cuesheets/<sheet>.json` -> `assets/<sha>.ext`.
  const slash = sourcePath.lastIndexOf("/");
  if (slash > 0) {
    const prodPath = `${sourcePath.slice(0, slash)}.json`;
    const fileName = sourcePath.slice(slash + 1);
    let prodManifest = null;
    if (files?.has(prodPath)) {
      try { prodManifest = JSON.parse(Buffer.from(files.get(prodPath)).toString("utf8")); } catch { /* ignore */ }
    } else if (siteDir) {
      prodManifest = await readJsonSafe(path.join(siteDir, ...prodPath.split("/")));
    }
    const prodEntry = prodManifest?.files?.[fileName];
    if (prodEntry?.asset) {
      if (files?.has(prodEntry.asset)) {
        await fs.promises.writeFile(dest, files.get(prodEntry.asset));
        return dest;
      }
      if (siteDir) {
        const assetFile = path.join(siteDir, ...prodEntry.asset.split("/"));
        if (fs.existsSync(assetFile)) {
          if (!assetFile.endsWith(".gz") && !assetFile.endsWith(".br")) return assetFile;
          await fs.promises.writeFile(dest, await decodeSiteBlob(assetFile));
          return dest;
        }
      }
    }
  }
  if (siteDir) {
    const direct = path.join(siteDir, ...sourcePath.split("/"));
    if (fs.existsSync(direct)) return direct;
  }
  return null;
};

const mapLimit = async (items, limit, fn) => {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const createDecodePool = ({ sampleRate, signal, logger, concurrency = 4 }) => {
  const predecoded = new Map();
  const queue = [];
  let active = 0;
  let stopped = false;
  const ac = new AbortController();
  const onParentAbort = () => ac.abort(signal?.reason || new Error("aborted"));
  if (signal) {
    if (signal.aborted) onParentAbort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

  const pump = () => {
    while (!stopped && active < concurrency && queue.length) {
      const task = queue.shift();
      active++;
      Promise.resolve()
        .then(() => {
          if (stopped || ac.signal.aborted) return null;
          return decodePcm(task.file, { sampleRate, signal: ac.signal });
        })
        .then(task.resolve, (e) => {
          if (!stopped && !ac.signal.aborted) logger.warn?.(`audio: predecode failed for ${task.soundId}: ${e.message}`);
          task.resolve(null);
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  return {
    predecoded,
    enqueue(soundId, file) {
      if (stopped || ac.signal.aborted) return;
      const key = String(soundId);
      if (predecoded.has(key)) return;
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      p.catch(() => {});
      predecoded.set(key, p);
      queue.push({ soundId: key, file, resolve });
      pump();
    },
    cancelPending() {
      stopped = true;
      if (signal) signal.removeEventListener("abort", onParentAbort);
      while (queue.length) {
        const task = queue.shift();
        predecoded.delete(task.soundId);
        task.resolve(null);
      }
    },
    abort() {
      ac.abort(new Error("decode pool aborted"));
      this.cancelPending();
    },
  };
};

const createPipeSession = ({ pipeVideoFile, fps, width, config, signal, logger }) => {
  const pending = new Map();
  let nextFrame = 0;
  let pipe = null;
  let initPromise = null;
  let writeChain = Promise.resolve();

  const ensurePipe = () => {
    if (!initPromise) {
      initPromise = openVideoPipe({
        output: pipeVideoFile, fps, width, config, signal, logger,
      }).then((p) => { pipe = p; return p; });
    }
    return initPromise;
  };

  return {
    onFrame(n, buf) {
      pending.set(n, buf);
      const op = writeChain.then(async () => {
        const p = await ensurePipe();
        while (pending.has(nextFrame)) {
          const frameBuf = pending.get(nextFrame);
          pending.delete(nextFrame);
          nextFrame++;
          await p.writeFrame(frameBuf);
        }
      });
      writeChain = op.catch(() => {});
      return op;
    },
    async finish() {
      await writeChain;
      if (pending.size) throw new Error(`missing frame ${nextFrame} in pipe stream`);
      if (!pipe && initPromise) pipe = await initPromise;
      if (!pipe) throw new Error("no frames were streamed to ffmpeg");
      return pipe.finish();
    },
    abort() {
      if (pipe) pipe.abort();
      else if (initPromise) initPromise.then((p) => p.abort()).catch(() => {});
    },
  };
};

const withTimeout = (promise, ms, signal, what) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
  const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s`)), ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); };
  signal?.addEventListener("abort", abort, { once: true });
  promise.then((v) => { clearTimeout(timer); signal?.removeEventListener?.("abort", abort); resolve(v); },
               (e) => { clearTimeout(timer); signal?.removeEventListener?.("abort", abort); reject(e); });
});

export class Renderer {
  constructor({ config, logger, browserPool = null }) {
    this.config = config;
    this.logger = logger;
    this.browserPool = browserPool || new BrowserPool({ maxJobsPerBrowser: 12, idleTimeoutMs: 300000 });
    this._ownsPool = !browserPool;
    this._pageServers = new Map();
    this._serverLocks = new Map();
  }

  _resolveMediaPaths(siteOverride = "") {
    const cfg = this.config;
    const siteDir = siteOverride || cfg.paths.site || cfg.paths.siteFormat || "";
    const vendorCore = siteDir ? path.join(siteDir, "vendor", "live2dcubismcore.min.js") : "";
    const vendorMotion = siteDir ? [
      path.join(siteDir, "vendor", "live2dcubismmotionsynccore.min.js"),
      path.join(siteDir, "vendor", "cubism-motionsync-core-5.0.4", "live2dcubismmotionsynccore.min.js"),
    ].find((p) => fs.existsSync(p)) : "";
    const core = cfg.render.core || (vendorCore && fs.existsSync(vendorCore) ? vendorCore : undefined);
    const motionsync = cfg.render.motionsync || vendorMotion || "";
    return { siteDir, core, motionsync };
  }

  _serverKey({ siteDir, core, motionsync }) {
    const resolvedCore = core === undefined ? CUBISM_CORE_URL : core;
    return `${siteDir || ""}|${resolvedCore}|${motionsync || ""}|${this.config.paths.output}`;
  }

  _warmKey({ siteDir, core, motionsync, siteEngine }) {
    const cfg = this.config;
    const outFps = 30 % cfg.video.fps === 0 ? cfg.video.fps : 30;
    return `${this._serverKey({ siteDir, core, motionsync })}|${!!siteEngine}|${!!cfg.render.gpu}|${cfg.video.width}x${cfg.video.height}@${outFps}|${cfg.video.captureMode || "auto"}`;
  }

  async _acquirePageServer({ siteDir, core, motionsync }) {
    const key = this._serverKey({ siteDir, core, motionsync });
    let entry = this._pageServers.get(key);
    if (!entry) {
      if (!this._serverLocks.has(key)) {
        const lock = (async () => {
          const pageServer = await createPageServer({
            site: siteDir, core, motionsync,
            outputDir: this.config.paths.output, logger: this.logger,
          });
          const created = { key, pageServer, active: 0 };
          this._pageServers.set(key, created);
          return created;
        })().finally(() => {
          if (this._serverLocks.get(key) === lock) this._serverLocks.delete(key);
        });
        this._serverLocks.set(key, lock);
      }
      entry = await this._serverLocks.get(key);
    }
    entry.active++;
    return entry;
  }

  _releasePageServer(entry) {
    if (!entry) return;
    entry.active = Math.max(0, entry.active - 1);
  }

  async close() {
    for (const lock of [...this._serverLocks.values()]) {
      try { await lock; } catch { /* ignore */ }
    }
    for (const entry of [...this._pageServers.values()]) {
      this._pageServers.delete(entry.key);
      try { await entry.pageServer.close(); } catch { /* ignore */ }
    }
    if (this._ownsPool && this.browserPool) {
      await this.browserPool.close();
    }
  }

  // Starts Chrome + isolated context + page warmup in the background so TTS/compile overlaps with browser startup.
  warm({ site = "", siteEngine = false, signal = null } = {}) {
    const cfg = this.config;
    const outFps = 30 % cfg.video.fps === 0 ? cfg.video.fps : 30;
    const { siteDir, core, motionsync } = this._resolveMediaPaths(site);
    const key = this._warmKey({ siteDir, core, motionsync, siteEngine });
    const ac = new AbortController();
    const sink = {
      errors: [],
      onConsole: (type, text) => {
        if (type === "error") sink.errors.push(text);
        const loud = type === "error" || type === "warning";
        this.logger[loud ? "warn" : "debug"]?.(`page: ${text}`);
      },
      onNetworkError: (error, type) => this.logger.warn?.(`page network: ${error}${type ? ` (${type})` : ""}`),
      onExit: (code, sig, stderr) => this.logger.warn?.(`page: chrome exited code=${code} signal=${sig || "-"}` +
        (stderr && stderr.trim() ? `\n${stderr.trim()}` : "")),
    };
    const state = {
      key,
      disposed: false,
      claimed: false,
      serverEntry: null,
      warmRec: null,
      browser: null,
      sink,
      ready: null,
    };

    const disposeInternal = async ({ keepForClaimed = false } = {}) => {
      if (state.disposed) return;
      if (keepForClaimed && state.claimed) return;
      state.disposed = true;
      if (signal) signal.removeEventListener("abort", onSignalAbort);
      ac.abort(signal?.reason || new Error("warm disposed"));
      try { state.warmRec?.dispose(); } catch { /* ignore */ }
      try { await state.ready; } catch { /* ignore */ }
      if (!keepForClaimed && !state.claimed) {
        try { await state.browser?.close(); } catch { /* ignore */ }
        this._releasePageServer(state.serverEntry);
        state.browser = null;
        state.serverEntry = null;
      }
    };
    const onSignalAbort = () => { void disposeInternal(); };
    if (signal) {
      if (signal.aborted) {
        state.disposed = true;
        return { key, disposed: true, claim: () => null, dispose: async () => {} };
      }
      signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    state.ready = (async () => {
      const serverEntry = await this._acquirePageServer({ siteDir, core, motionsync });
      if (state.disposed || ac.signal.aborted) {
        this._releasePageServer(serverEntry);
        return { ok: false };
      }
      state.serverEntry = serverEntry;
      const warmRec = serverEntry.pageServer.registerWarm({
        siteEngine: !!siteEngine,
        gpu: !!cfg.render.gpu,
        width: cfg.video.width,
        height: cfg.video.height,
        fps: outFps,
        captureMode: cfg.video.captureMode || "auto",
      });
      state.warmRec = warmRec;
      let browser = null;
      try {
        browser = await this.browserPool.acquire({
          executable: cfg.render.chrome || undefined,
          gpu: !!cfg.render.gpu,
          extraArgs: cfg.render.chromeArgs || [],
          width: cfg.video.width + 80,
          height: cfg.video.height + 80,
          signal: ac.signal,
          onConsole: (t, txt) => sink.onConsole?.(t, txt),
          onNetworkError: (err, t) => sink.onNetworkError?.(err, t),
          onExit: (code, sig, stderr) => sink.onExit?.(code, sig, stderr),
        });
        if (state.disposed || ac.signal.aborted) {
          try { await browser.close(); } catch { /* ignore */ }
          return { ok: false };
        }
        state.browser = browser;
        await withTimeout(
          browser.navigate(`${serverEntry.pageServer.url}/page.html?warm=${encodeURIComponent(warmRec.id)}`),
          Math.min(cfg.render.taskTimeoutMs, 60000), ac.signal, "the warm render page to load");
        return { ok: true, browser, serverEntry, warmRec, sink };
      } catch (e) {
        if (!state.disposed && !ac.signal.aborted) {
          this.logger.debug?.(`render warm fallback (${e.message})`);
        }
        try { await browser?.close(); } catch { /* ignore */ }
        state.browser = null;
        try { warmRec.dispose(); } catch { /* ignore */ }
        if (!state.claimed) {
          this._releasePageServer(state.serverEntry);
          state.serverEntry = null;
        }
        return { ok: false, error: e };
      }
    })();
    state.ready.catch(() => {});

    return {
      key,
      get disposed() { return state.disposed; },
      claim: (expectedKey) => {
        if (state.disposed || state.claimed || ac.signal.aborted || expectedKey !== state.key) return null;
        state.claimed = true;
        if (signal) signal.removeEventListener("abort", onSignalAbort);
        return {
          ready: state.ready,
          sink,
          release: async () => {
            try { state.warmRec?.dispose(); } catch { /* ignore */ }
            try { await state.browser?.close(); } catch { /* ignore */ }
            this._releasePageServer(state.serverEntry);
            state.browser = null;
            state.serverEntry = null;
          },
        };
      },
      dispose: () => disposeInternal({ keepForClaimed: true }),
    };
  }

  // story: {manifest, manifestPath, files: Map(path -> Buffer), language, script}
  // -> {output, report, audio, duration, pageErrors}
  async render({ story, jobId, signal, warm = null, onProgress = () => {} }) {
    const cfg = this.config;
    const files = new Map(story.files);
    const cleanManifestPath = String(story.manifestPath || "stories/0.json").replace(/^\/+/, "");
    files.set(cleanManifestPath, Buffer.from(JSON.stringify(story.manifest), "utf8"));
    const { siteDir, core, motionsync } = this._resolveMediaPaths(story.site);
    const serverEntry = await this._acquirePageServer({ siteDir, core, motionsync });
    const pageServer = serverEntry.pageServer;
    const warmKey = this._warmKey({ siteDir, core, motionsync, siteEngine: !!story.siteEngine });
    let claimedWarm = null;
    let pipeSession = null;
    let decodePool = null;
    let job = null;
    let browser = null;
    try {
      claimedWarm = warm ? warm.claim(warmKey) : null;
      if (warm && !claimedWarm) {
        await warm.dispose().catch(() => {});
      }

      const outFps = 30 % cfg.video.fps === 0 ? cfg.video.fps : 30;
      const jobConfig = {
        jobId,
        manifest: `/job/${encodeURIComponent(jobId)}/site/${cleanManifestPath}`,
        lang: story.language,
        width: cfg.video.width,
        height: cfg.video.height,
        fps: cfg.video.fps,
        jpegQuality: cfg.video.jpegQuality,
        captureMode: cfg.video.captureMode || "auto",
        watermark: cfg.video.watermark || "",
        gpu: !!cfg.render.gpu,
        maxDurationSec: cfg.video.maxDurationSec,
        fixtureUi: !!story.fixtureUi,
        siteEngine: !!story.siteEngine,
        settleFrames: cfg.render.settleFrames || 0,
        hostCueResolve: true,
      };
      const tempJobDir = path.join(pageServer.jobsDir, jobId);
      pipeSession = createPipeSession({
        pipeVideoFile: path.join(tempJobDir, "pipe.mp4"),
        fps: outFps,
        width: cfg.video.width,
        config: cfg.video,
        signal,
        logger: this.logger,
      });
      decodePool = createDecodePool({
        sampleRate: cfg.video.audioSampleRate || 48000,
        signal,
        logger: this.logger,
        concurrency: 4,
      });
      const resolvedHostFiles = new Map();
      job = pageServer.createJob(jobConfig, {
        files,
        site: siteDir,
        keepFrames: !!process.env.OURNOTES_KEEP_FRAMES,
        onFrame: (n, buf) => pipeSession.onFrame(n, buf),
        onPrepareCues: async (cuesList) => {
          const missing = [];
          await mapLimit(cuesList, 8, async (c) => {
            const soundId = String(c?.soundId ?? "");
            if (!soundId) return;
            const file = await resolveCueFileOnHost({
              sourcePath: c.sourcePath,
              soundId,
              ext: c.ext || "bin",
              files,
              siteDir,
              manifest: story.manifest,
              cuesDir: path.join(tempJobDir, "cues"),
            });
            if (file) {
              resolvedHostFiles.set(soundId, file);
              if (c.used !== false) decodePool.enqueue(soundId, file);
            } else {
              missing.push(soundId);
            }
          });
          return missing;
        },
      });
      const pageErrors = [];
      const onConsole = (type, text) => {
        if (type === "error") pageErrors.push(text);
        // Warnings carry upload retries and re-encodes; they must be visible when a render fails.
        const loud = type === "error" || type === "warning";
        this.logger[loud ? "warn" : "debug"]?.(`page: ${text}`);
      };
      const onNetworkError = (error, type) =>
        this.logger.warn?.(`page network: ${error}${type ? ` (${type})` : ""}`);
      const onExit = (code, sig, stderr) =>
        this.logger.warn?.(`page: chrome exited code=${code} signal=${sig || "-"}` +
                            (stderr && stderr.trim() ? `\n${stderr.trim()}` : ""));

      let usedWarmPage = false;
      if (claimedWarm) {
        onProgress("rendering", 0.02, "使用已预热的浏览器渲染");
        claimedWarm.sink.onConsole = onConsole;
        claimedWarm.sink.onNetworkError = onNetworkError;
        claimedWarm.sink.onExit = onExit;
        if (claimedWarm.sink.errors.length) pageErrors.push(...claimedWarm.sink.errors);
        const wr = await claimedWarm.ready;
        if (signal?.aborted) throw signal.reason || new Error("aborted");
        if (wr?.ok && wr.browser && !wr.browser.closed && wr.warmRec.deliverJob(job.id)) {
          browser = wr.browser;
          usedWarmPage = true;
        } else {
          await claimedWarm.release();
          claimedWarm = null;
        }
      }

      if (!usedWarmPage) {
        onProgress("rendering", 0.02, "启动无头浏览器");
        browser = await this.browserPool.acquire({
          executable: cfg.render.chrome || undefined,
          gpu: !!cfg.render.gpu,
          extraArgs: cfg.render.chromeArgs || [],
          width: cfg.video.width + 80,
          height: cfg.video.height + 80,
          signal,
          onConsole,
          onNetworkError,
          onExit,
        });
        await withTimeout(
          browser.navigate(`${pageServer.url}/page.html?job=${encodeURIComponent(job.id)}`),
          Math.min(cfg.render.taskTimeoutMs, 60000), signal, "the render page to load");
      }
      onProgress("rendering", 0.05, "渲染剧情帧");
      // The page reports every 60 frames; surface it so a long render does not look stuck at one percentage.
      const progressTimer = setInterval(() => {
        const p = job.progress;
        if (!p) return;
        const storyText = p.storySeconds ? `，${p.storySeconds.toFixed(1)} 秒剧情` : "";
        onProgress("rendering", 0.05, `渲染剧情帧 ${p.frames} 帧${storyText}`);
      }, 2000);
      let report;
      try {
        // A killed/crashed browser never posts /result; without the race the task would hold its queue slot until
        // render.taskTimeoutMs (an hour).
        report = await withTimeout(
          Promise.race([
            job.result,
            browser.onClosed().then(() => {
              const p = browser.proc;
              throw new Error("the browser closed before the render page reported a result" +
                ` (exitCode=${p?.exitCode}, signal=${p?.signalCode || "-"})`);
            }),
          ]),
          cfg.render.taskTimeoutMs, signal, "the render page");
      } finally {
        clearInterval(progressTimer);
      }
      if (!report.ok) throw new Error(report.error || "the render page failed");
      if (report.frames < 1) throw new Error("the render page produced no frame");
      decodePool.cancelPending();
      for (const [soundId, cueObj] of Object.entries(report.cues || {})) {
        const hostFile = resolvedHostFiles.get(soundId);
        if (hostFile) cueObj.hostFile = hostFile;
      }
      onProgress("mixing", 0.72, "混合 BGM 与配音");
      const [audio, pipeResult] = await Promise.all([
        mixAudio({
          report, cuesDir: job.cuesDir, predecoded: decodePool.predecoded,
          sampleRate: cfg.video.audioSampleRate, signal, logger: this.logger,
        }),
        report.captureMode === "webcodecs" ? Promise.resolve(null) : pipeSession.finish(),
      ]);
      void pipeResult;
      onProgress("encoding", 0.8, "编码 MP4");
      const output = path.join(cfg.paths.output, `${jobId}.mp4`);
      const rawVideoFile = report.captureMode === "webcodecs" ? job.mp4File : path.join(job.dir, "pipe.mp4");
      if (audio) {
        await muxVideoAudio({
          video: rawVideoFile, audio: audio.file, output,
          audioBitrate: cfg.video.audioBitrate, signal,
        });
      } else if (report.captureMode === "webcodecs") {
        await remuxFaststart({ input: rawVideoFile, output, signal });
      } else {
        await moveFile(rawVideoFile, output);
      }
      const duration = report.frames / (report.fps || cfg.video.fps);
      // The command timeline the page recorded at execution. The frame audit cuts against these timestamps, so the
      // sidecar lives next to the MP4 and the report never has to guess a command's start from episode durations.
      const timeline = path.join(cfg.paths.output, `${jobId}.timeline.json`);
      fs.writeFileSync(timeline, `${JSON.stringify({
        version: 1, videoStart: report.videoStart ?? 0, commands: report.timeline || [],
      }, null, 2)}\n`);
      onProgress("done", 1, "完成");
      return { output, report, audio, duration, timeline, pageErrors };
    } catch (e) {
      pipeSession?.abort();
      decodePool?.abort();
      throw e;
    } finally {
      if (claimedWarm) {
        try { await claimedWarm.release(); } catch { /* already gone */ }
      } else {
        try { await browser?.close(); } catch { /* already gone */ }
      }
      if (job) {
        try { pageServer.removeJob(job); } catch { /* gone */ }
      }
      this._releasePageServer(serverEntry);
      if (job && !process.env.OURNOTES_KEEP_FRAMES) {
        try { await fs.promises.rm(job.dir, { recursive: true, force: true }); } catch { /* locked */ }
      }
    }
  }

  // A site-free smoke render: the page draws synthetic frames, the host encodes them. Used by tests and `--smoke`.
  async renderSmoke({ jobId = "smoke", signal = null, onProgress = () => {}, frames = 12 } = {}) {
    const cfg = this.config;
    const pageServer = await createPageServer({
      site: "", files: new Map(), core: "", outputDir: cfg.paths.output, logger: this.logger,
    });
    const width = Math.min(cfg.video.width, 640);
    const height = Math.min(cfg.video.height, 360);
    const fps = Math.min(cfg.video.fps, 30);
    const pipeVideoFile = path.join(pageServer.jobsDir, jobId, "pipe.mp4");
    const pipeSession = createPipeSession({
      pipeVideoFile, fps, width, config: cfg.video, signal, logger: this.logger,
    });
    const job = pageServer.createJob({
      jobId, kind: "smoke", width, height, fps, frames,
    }, {
      onFrame: (n, buf) => pipeSession.onFrame(n, buf),
    });
    let browser = null;
    try {
      onProgress("rendering", 0.05, "启动无头浏览器");
      browser = await this.browserPool.acquire({
        executable: cfg.render.chrome || undefined, gpu: !!cfg.render.gpu,
        extraArgs: cfg.render.chromeArgs || [],
        width: job.config.width + 80, height: job.config.height + 80,
        onConsole: (type, text) => this.logger[type === "error" ? "warn" : "debug"]?.(`page: ${text}`),
      });
      await withTimeout(
        browser.navigate(`${pageServer.url}/page.html?job=${encodeURIComponent(job.id)}`),
        Math.min(cfg.render.taskTimeoutMs, 60000), signal, "the render page to load");
      const report = await withTimeout(job.result, Math.min(cfg.render.taskTimeoutMs, 120000), signal, "the smoke page");
      await pipeSession.finish();
      const output = path.join(cfg.paths.output, `${jobId}.mp4`);
      await moveFile(pipeVideoFile, output);
      return { output, report, duration: report.frames / report.fps };
    } catch (e) {
      pipeSession.abort();
      throw e;
    } finally {
      try { await browser?.close(); } catch { /* gone */ }
      try { pageServer.removeJob(job); } catch { /* gone */ }
      try { await pageServer.close(); } catch { /* gone */ }
      try { await fs.promises.rm(job.dir, { recursive: true, force: true }); } catch { /* locked */ }
    }
  }
}
