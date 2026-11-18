// Render orchestration: compose files are served over the base site, a headless browser plays the composed story one
// fixed step at a time and posts JPEG frames + an audio event log, then the audio is rebuilt and ffmpeg encodes MP4.
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { BrowserPool } from "../../scripts/lib/story-author/chrome.js";
import { mixAudio } from "./audioMix.js";
import { decodePcm, muxVideoAudio, openVideoPipe, remuxFaststart } from "./ffmpeg.js";
import { createPageServer } from "./pageServer.js";

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

const createDecodePool = ({ sampleRate, signal, logger, concurrency = 4 }) => {
  const predecoded = new Map();
  const queue = [];
  let active = 0;

  const pump = () => {
    while (active < concurrency && queue.length) {
      const task = queue.shift();
      active++;
      Promise.resolve()
        .then(() => {
          if (signal?.aborted) return null;
          return decodePcm(task.file, { sampleRate, signal });
        })
        .then(task.resolve, (e) => {
          if (!signal?.aborted) logger.warn?.(`audio: predecode failed for ${task.soundId}: ${e.message}`);
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
      const key = String(soundId);
      if (predecoded.has(key)) return;
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      p.catch(() => {});
      predecoded.set(key, p);
      queue.push({ soundId: key, file, resolve });
      pump();
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
  }

  async close() {
    if (this._ownsPool && this.browserPool) {
      await this.browserPool.close();
    }
  }

  // story: {manifest, manifestPath, files: Map(path -> Buffer), language, script}
  // -> {output, report, audio, duration, pageErrors}
  async render({ story, jobId, signal, onProgress = () => {} }) {
    const cfg = this.config;
    const files = new Map(story.files);
    files.set(story.manifestPath, Buffer.from(JSON.stringify(story.manifest), "utf8"));
    const siteDir = story.site || cfg.paths.site;
    const vendorCore = siteDir ? path.join(siteDir, "vendor", "live2dcubismcore.min.js") : "";
    const vendorMotion = siteDir ? [
      path.join(siteDir, "vendor", "live2dcubismmotionsynccore.min.js"),
      path.join(siteDir, "vendor", "cubism-motionsync-core-5.0.4", "live2dcubismmotionsynccore.min.js"),
    ].find((p) => fs.existsSync(p)) : "";
    const core = cfg.render.core || (vendorCore && fs.existsSync(vendorCore) ? vendorCore : undefined);
    const motionsync = cfg.render.motionsync || vendorMotion || "";
    const pageServer = await createPageServer({
      site: siteDir, files, core, motionsync,
      outputDir: cfg.paths.output, logger: this.logger,
    });
    const outFps = 30 % cfg.video.fps === 0 ? cfg.video.fps : 30;
    const jobConfig = {
      jobId,
      manifest: `/site/${story.manifestPath}`,
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
    const pipeSession = createPipeSession({
      pipeVideoFile: path.join(tempJobDir, "pipe.mp4"),
      fps: outFps,
      width: cfg.video.width,
      config: cfg.video,
      signal,
      logger: this.logger,
    });
    const decodePool = createDecodePool({
      sampleRate: cfg.video.audioSampleRate || 48000,
      signal,
      logger: this.logger,
      concurrency: 4,
    });
    const resolvedHostFiles = new Map();
    const job = pageServer.createJob(jobConfig, {
      keepFrames: !!process.env.OURNOTES_KEEP_FRAMES,
      onFrame: (n, buf) => pipeSession.onFrame(n, buf),
      onPrepareCues: async (cuesList) => {
        const missing = [];
        for (const c of cuesList) {
          const soundId = String(c?.soundId ?? "");
          if (!soundId) continue;
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
            decodePool.enqueue(soundId, file);
          } else {
            missing.push(soundId);
          }
        }
        return missing;
      },
    });
    const pageErrors = [];
    let browser = null;
    try {
      onProgress("rendering", 0.02, "启动无头浏览器");
      browser = await this.browserPool.acquire({
        executable: cfg.render.chrome || undefined,
        gpu: !!cfg.render.gpu,
        extraArgs: cfg.render.chromeArgs || [],
        width: cfg.video.width + 80,
        height: cfg.video.height + 80,
        onConsole: (type, text) => {
          if (type === "error") pageErrors.push(text);
          // Warnings carry upload retries and re-encodes; they must be visible when a render fails.
          const loud = type === "error" || type === "warning";
          this.logger[loud ? "warn" : "debug"]?.(`page: ${text}`);
        },
        onNetworkError: (error, type) =>
          this.logger.warn?.(`page network: ${error}${type ? ` (${type})` : ""}`),
        onExit: (code, sig, stderr) =>
          this.logger.warn?.(`page: chrome exited code=${code} signal=${sig || "-"}` +
                              (stderr && stderr.trim() ? `\n${stderr.trim()}` : "")),
      });
      await withTimeout(
        browser.navigate(`${pageServer.url}/page.html?job=${encodeURIComponent(job.id)}`),
        Math.min(cfg.render.taskTimeoutMs, 60000), signal, "the render page to load");
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
      pipeSession.abort();
      throw e;
    } finally {
      try { await browser?.close(); } catch { /* already gone */ }
      try { pageServer.removeJob(job); } catch { /* gone */ }
      try { await pageServer.close(); } catch { /* already closed */ }
      if (!process.env.OURNOTES_KEEP_FRAMES) {
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
