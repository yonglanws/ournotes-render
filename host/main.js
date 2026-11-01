// Entry point: node host/main.js
// Loads config.yaml, prepares the site catalog, the LLM and TTS clients, the queue and the HTTP API.
import path from "node:path";
import { loadConfig, ensureDirs, publicConfig, ROOT } from "./config.js";
import { runDoctor } from "./doctor.js";
import { Logger } from "./util/logger.js";
import { StoryCatalog } from "./story/catalog.js";
import { LLMClient } from "./ai/llm.js";
import { GptSovitsClient, VoiceBook } from "./tts/tts.js";
import { Renderer } from "./render/renderer.js";
import { configureFfmpeg, validateFfmpeg } from "./render/ffmpeg.js";
import { Pipeline } from "./pipeline.js";
import { TaskQueue } from "./queue/taskQueue.js";
import { ApiServer } from "./api/server.js";
import { findBrowser } from "../scripts/lib/story-author/chrome.js";

const main = async () => {
  const args = process.argv.slice(2);
  const checking = args.includes("--check");
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  // --check prints one JSON document; keep persona/config warnings out of stdout by loading with a quiet logger.
  const config = loadConfig({ logger: checking ? quiet : console });
  const logger = new Logger(config.logLevel, { scope: "host" });
  ensureDirs(config);

  if (checking) {
    const report = runDoctor(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  logger.info(`ournotes host starting in ${ROOT}`);
  logger.info(`config: ${config.configFile || "built-in defaults (no config.yaml)"}`);
  for (const issue of config.issues.warnings) logger.warn(`config: ${issue.path}: ${issue.message}`);
  for (const issue of config.issues.errors) logger.error(`config: ${issue.path}: ${issue.message}`);

  try {
    const ffmpeg = validateFfmpeg(config.video.ffmpegPath || "");
    configureFfmpeg(config.video.ffmpegPath || "");
    logger.info(`ffmpeg: ${ffmpeg}`);
  } catch (e) {
    logger.warn(`ffmpeg: ${e.message}`);
  }
  try { logger.info(`browser: ${findBrowser(config.render.chrome || "")}`); }
  catch (e) { logger.warn(`browser: ${e.message}`); }

  let catalog = null;
  if (config.paths.site) {
    try {
      catalog = new StoryCatalog({ dir: config.paths.site, language: config.story.language,
        maxModels: config.story.maxModels, cast: config.story.cast, logger: logger.child("site") });
      const bases = catalog.bases();
      logger.info(`site: ${config.paths.site} (${bases.length} base story/stories)`);
    } catch (e) {
      logger.error(`site: ${e.message}`);
    }
  } else {
    logger.warn("paths.site is empty: /api/v1/generate cannot run until a nnnotes site is configured");
  }

  let llm = null;
  try {
    llm = new LLMClient({ ...config.llm, apiKey: config.secrets.llmApiKey },
      { logger: logger.child("llm"), allowPrivate: config.security.allowPrivateServiceEndpoints });
    logger.info(`llm: ${config.llm.enabled ? `${config.llm.model} @ ${config.llm.baseUrl}` : "disabled"}` +
      (config.llm.enabled && !config.secrets.llmApiKey ? " (no API key in the configured environment variable)" : ""));
  } catch (e) {
    logger.error(`llm: ${e.message}`);
  }

  let tts = null;
  try {
    const client = new GptSovitsClient(config.tts,
      { apiKey: config.secrets.ttsApiKey, logger: logger.child("tts"), allowPrivate: config.security.allowPrivateServiceEndpoints });
    client.setCacheDir(path.join(config.paths.cache, "tts"));
    tts = { client, voiceBook: new VoiceBook(config.tts) };
    const summary = config.voiceSummary;
    logger.info(`tts: ${config.tts.enabled ? config.tts.baseUrl : "disabled"}` +
      (config.tts.enabled ? ` (${summary.count} voice(s), ${summary.defaultVoice ? "default voice set" : "no default voice"})` : ""));
    if (config.tts.enabled && !summary.count && !summary.defaultVoice)
      logger.warn("tts: no voice is configured; every line will be silent (see voices.example.yaml)");
  } catch (e) {
    logger.error(`tts: ${e.message}`);
  }

  const renderer = new Renderer({ config, logger: logger.child("render") });
  const pipeline = new Pipeline({ config, catalog, llm, tts, renderer, logger: logger.child("job") });

  if (args.includes("--smoke")) {
    const result = await renderer.renderSmoke({ jobId: `smoke-${Date.now().toString(36)}`, frames: 12 });
    logger.info(`smoke video: ${result.output} (${result.report.frames} frames)`);
    return;
  }
  const queue = new TaskQueue({
    concurrency: config.queue.concurrency, maxSize: config.queue.maxSize,
    taskTimeoutMs: config.queue.taskTimeoutMs, retentionMs: config.queue.retentionMs,
    cleanupIntervalMs: config.queue.cleanupIntervalMs, logger: logger.child("queue"),
  });
  const api = new ApiServer({ config, queue, pipeline, catalog, logger: logger.child("api") });

  const shutdown = async (sig) => {
    logger.info(`${sig}: shutting down`);
    try { await api.close(); } catch { /* already closed */ }
    try { await queue.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await api.listen();
  logger.debug(`public config: ${JSON.stringify(publicConfig(config))}`);
};

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
