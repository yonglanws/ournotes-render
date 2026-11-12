// Render orchestration: compose files are served over the base site, a headless browser plays the composed story one
// fixed step at a time and posts JPEG frames + an audio event log, then the audio is rebuilt and ffmpeg encodes MP4.
import fs from "node:fs";
import path from "node:path";
import { Browser } from "../../scripts/lib/story-author/chrome.js";
import { mixAudio } from "./audioMix.js";
import { encodeVideo } from "./ffmpeg.js";
import { createPageServer } from "./pageServer.js";

const withTimeout = (promise, ms, signal, what) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
  const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s`)), ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); };
  signal?.addEventListener("abort", abort, { once: true });
  promise.then((v) => { clearTimeout(timer); signal?.removeEventListener?.("abort", abort); resolve(v); },
               (e) => { clearTimeout(timer); signal?.removeEventListener?.("abort", abort); reject(e); });
});

export class Renderer {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  // story: {manifest, manifestPath, files: Map(path -> Buffer), language, script}
  // -> {output, report, audio, duration, pageErrors}
  async render({ story, jobId, signal, onProgress = () => {} }) {
    const cfg = this.config;
    const files = new Map(story.files);
    files.set(story.manifestPath, Buffer.from(JSON.stringify(story.manifest), "utf8"));
    const pageServer = await createPageServer({
      site: story.site || cfg.paths.site, files, core: cfg.render.core || undefined, motionsync: cfg.render.motionsync || "",
      outputDir: cfg.paths.output, logger: this.logger,
    });
    const job = pageServer.createJob({
      jobId,
      manifest: `/site/${story.manifestPath}`,
      lang: story.language,
      width: cfg.video.width,
      height: cfg.video.height,
      fps: cfg.video.fps,
      jpegQuality: cfg.video.jpegQuality,
      maxDurationSec: cfg.video.maxDurationSec,
      fixtureUi: !!story.fixtureUi,
      siteEngine: !!story.siteEngine,
      settleFrames: cfg.render.settleFrames || 0,
    });
    const pageErrors = [];
    let browser = null;
    try {
      onProgress("rendering", 0.02, "启动无头浏览器");
      browser = await Browser.launch({
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
      });
      await withTimeout(
        browser.navigate(`${pageServer.url}/page.html?job=${encodeURIComponent(job.id)}`),
        Math.min(cfg.render.taskTimeoutMs, 60000), signal, "the render page to load");
      onProgress("rendering", 0.05, "渲染剧情帧");
      // The page reports every 60 frames; surface it so a long render does not look stuck at one percentage.
      const progressTimer = setInterval(() => {
        const p = job.progress;
        if (!p) return;
        const story = p.storySeconds ? `，${p.storySeconds.toFixed(1)} 秒剧情` : "";
        onProgress("rendering", 0.05, `渲染剧情帧 ${p.frames} 帧${story}`);
      }, 2000);
      let report;
      try {
        // A killed/crashed browser never posts /result; without the race the task would hold its queue slot until
        // render.taskTimeoutMs (an hour).
        report = await withTimeout(
          Promise.race([
            job.result,
            browser.onClosed().then(() => {
              throw new Error("the browser closed before the render page reported a result");
            }),
          ]),
          cfg.render.taskTimeoutMs, signal, "the render page");
      } finally {
        clearInterval(progressTimer);
      }
      if (!report.ok) throw new Error(report.error || "the render page failed");
      if (report.frames < 1) throw new Error("the render page produced no frame");
      onProgress("mixing", 0.72, "混合 BGM 与配音");
      const audio = await mixAudio({
        report, cuesDir: job.cuesDir, sampleRate: cfg.video.audioSampleRate, signal, logger: this.logger,
      });
      onProgress("encoding", 0.8, "编码 MP4");
      const output = path.join(cfg.paths.output, `${jobId}.mp4`);
      await encodeVideo({
        frames: path.join(job.framesDir, "%06d.jpg"), audio: audio ? audio.file : null, output,
        fps: report.fps || cfg.video.fps, width: report.width, height: report.height, config: cfg.video,
        signal, logger: this.logger,
      });
      const duration = report.frames / (report.fps || cfg.video.fps);
      // The command timeline the page recorded at execution. The frame audit cuts against these timestamps, so the
      // sidecar lives next to the MP4 and the report never has to guess a command's start from episode durations.
      const timeline = path.join(cfg.paths.output, `${jobId}.timeline.json`);
      fs.writeFileSync(timeline, `${JSON.stringify({
        version: 1, videoStart: report.videoStart ?? 0, commands: report.timeline || [],
      }, null, 2)}\n`);
      onProgress("done", 1, "完成");
      return { output, report, audio, duration, timeline, pageErrors };
    } finally {
      try { await browser?.close(); } catch { /* already gone */ }
      try { pageServer.removeJob(job); } catch { /* gone */ }
      try { await pageServer.close(); } catch { /* already closed */ }
      if (!process.env.OURNOTES_KEEP_FRAMES) {
        try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch { /* locked */ }
      }
    }
  }

  // A site-free smoke render: the page draws synthetic frames, the host encodes them. Used by tests and `--smoke`.
  async renderSmoke({ jobId = "smoke", signal = null, onProgress = () => {}, frames = 12 } = {}) {
    const cfg = this.config;
    const pageServer = await createPageServer({
      site: "", files: new Map(), core: "", outputDir: cfg.paths.output, logger: this.logger,
    });
    const job = pageServer.createJob({
      jobId, kind: "smoke", width: Math.min(cfg.video.width, 640), height: Math.min(cfg.video.height, 360),
      fps: Math.min(cfg.video.fps, 30), frames,
    });
    let browser = null;
    try {
      onProgress("rendering", 0.05, "启动无头浏览器");
      browser = await Browser.launch({
        executable: cfg.render.chrome || undefined, gpu: !!cfg.render.gpu,
        extraArgs: cfg.render.chromeArgs || [],
        width: job.config.width + 80, height: job.config.height + 80,
        onConsole: (type, text) => this.logger[type === "error" ? "warn" : "debug"]?.(`page: ${text}`),
      });
      await withTimeout(
        browser.navigate(`${pageServer.url}/page.html?job=${encodeURIComponent(job.id)}`),
        Math.min(cfg.render.taskTimeoutMs, 60000), signal, "the render page to load");
      const report = await withTimeout(job.result, Math.min(cfg.render.taskTimeoutMs, 120000), signal, "the smoke page");
      const output = path.join(cfg.paths.output, `${jobId}.mp4`);
      await encodeVideo({
        frames: path.join(job.framesDir, "%06d.jpg"), audio: null, output, fps: report.fps,
        width: report.width, height: report.height, config: cfg.video, signal, logger: this.logger,
      });
      return { output, report, duration: report.frames / report.fps };
    } finally {
      try { await browser?.close(); } catch { /* gone */ }
      try { pageServer.removeJob(job); } catch { /* gone */ }
      try { await pageServer.close(); } catch { /* gone */ }
      try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch { /* locked */ }
    }
  }
}
