// Everything `npm run check` and `node host/main.js --check` report: configuration issues collected by loadConfig,
// Node/ffmpeg/Chrome, the story site, Live2D runtimes, LLM/TTS readiness and writable output directories. No network
// requests are made; a TTS/LLM endpoint is checked for shape, and `npm run tts:check` synthesizes a real sample.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findBrowser } from "../scripts/lib/story-author/chrome.js";
import { validateFfmpeg } from "./render/ffmpeg.js";
import { voiceSummary } from "./tts/voices.js";

const require = createRequire(import.meta.url);

const issue = (errors, warnings, pathName, message) => {
  const match = (i) => i.path === pathName && i.message === message;
  if (errors) {
    if (errors.some(match)) return;
    const at = warnings.findIndex(match);
    if (at >= 0) warnings.splice(at, 1);
    errors.push({ path: pathName, message });
    return;
  }
  if ((errors || []).some(match) || warnings.some(match)) return;
  warnings.push({ path: pathName, message });
};

const checkDir = (dir, pathName, { optional = false } = {}) => {
  if (!dir) return { ok: optional, detail: optional ? "not set" : "not set" };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true, detail: dir };
  } catch (e) {
    return { ok: false, detail: `${dir}: ${e.message}` };
  }
};

export const runDoctor = (config, { logger = console } = {}) => {
  const errors = [...(config.issues?.errors || [])];
  const warnings = [...(config.issues?.warnings || [])];
  const checks = {};

  const major = Number(String(process.versions.node).split(".")[0]);
  checks.node = major >= 22 ? { ok: true, detail: process.versions.node } : { ok: false, detail: `${process.versions.node}; Node.js 22+ is required` };
  if (!checks.node.ok) issue(errors, warnings, "node", checks.node.detail);

  checks.output = checkDir(config.paths.output, "paths.output");
  checks.cache = checkDir(config.paths.cache, "paths.cache");
  for (const key of ["output", "cache"]) {
    if (!checks[key].ok) issue(errors, warnings, `paths.${key}`, checks[key].detail);
  }

  if (config.paths.site) {
    if (!fs.existsSync(config.paths.site) || !fs.statSync(config.paths.site).isDirectory()) {
      checks.site = { ok: false, detail: `not a directory: ${config.paths.site}` };
      issue(errors, warnings, "paths.site", checks.site.detail);
    } else {
      const stories = path.join(config.paths.site, "stories.json");
      const models = path.join(config.paths.site, "models.json");
      const missing = [stories, models].filter((f) => !fs.existsSync(f));
      checks.site = { ok: missing.length === 0, detail: config.paths.site };
      if (missing.length) {
        checks.site.detail = `${config.paths.site} is missing ${missing.map((f) => path.basename(f)).join(", ")}`;
        issue(errors, warnings, "paths.site", checks.site.detail);
      }
    }
  } else if (config.paths.siteFormat) {
    const dir = config.paths.siteFormat;
    const storiesDir = path.join(dir, "stories");
    const hasStories = fs.existsSync(path.join(dir, "stories.json")) ||
      (fs.existsSync(storiesDir) && fs.readdirSync(storiesDir).some((name) => name.endsWith(".json")));
    checks.site = {
      ok: fs.existsSync(dir) && fs.statSync(dir).isDirectory() && hasStories,
      detail: `${dir} (site-format)`,
    };
    if (!checks.site.ok) {
      checks.site.detail = `${dir}: not a story site with stories.json or stories/*.json`;
      issue(errors, warnings, "paths.siteFormat", checks.site.detail);
    }
  } else {
    checks.site = {
      ok: false,
      detail: "not set; /api/v1/generate needs an nnnotes product site, /api/v1/script/generate can use paths.siteFormat",
    };
    issue(null, warnings, "paths.site", checks.site.detail);
  }

  try {
    checks.ffmpeg = { ok: true, detail: validateFfmpeg(config.video.ffmpegPath || "") };
  } catch (e) {
    checks.ffmpeg = { ok: false, detail: e.message };
    issue(errors, warnings, "video.ffmpegPath", e.message);
  }

  try {
    checks.browser = { ok: true, detail: findBrowser(config.render.chrome || "") };
  } catch (e) {
    checks.browser = { ok: false, detail: e.message };
    issue(errors, warnings, "render.chrome", e.message);
  }

  try {
    const main = require.resolve("ournotes-player-site");
    checks.siteEngine = { ok: true, detail: path.resolve(path.dirname(main), "..") };
  } catch {
    checks.siteEngine = { ok: false, detail: "the site-format engine package is not installed" };
    issue(errors, warnings, "site-engine", "run npm install at the repository root (the host is an npm workspace)");
  }

  const core = config.render.core;
  if (!core) checks.core = { ok: true, detail: "Live2D official CDN (render.core is empty)" };
  else if (/^https?:\/\//i.test(core)) checks.core = { ok: true, detail: core };
  else if (fs.existsSync(core)) checks.core = { ok: true, detail: core };
  else {
    checks.core = { ok: false, detail: `not found: ${core}` };
    issue(errors, warnings, "render.core", checks.core.detail);
  }
  if (config.render.motionsync) {
    const m = config.render.motionsync;
    checks.motionsync = { ok: /^https?:\/\//i.test(m) || fs.existsSync(m), detail: m };
    if (!checks.motionsync.ok) issue(errors, warnings, "render.motionsync", `not found: ${m}`);
  }

  checks.personas = { ok: true, detail: `${(config.story.personas || []).length} character sheet(s)` };
  if (config.story.personaDirs?.length && !(config.story.personas || []).length) {
    checks.personas = { ok: false, detail: `no *.md character sheet found in ${config.story.personaDirs.join(", ")}` };
    issue(errors, warnings, "story.personaDirs", checks.personas.detail);
  }

  checks.llm = {
    ok: !config.llm.enabled || (!!config.llm.model && !!config.llm.baseUrl),
    detail: config.llm.enabled ? `${config.llm.model || "(no model)"} @ ${config.llm.baseUrl || "(no base URL)"}` : "disabled",
  };
  if (config.llm.enabled && !config.secrets.llmApiKey)
    issue(null, warnings, "llm.apiKeyEnv", `no value in ${config.llm.apiKeyEnv || "(unset)"}; a local endpoint may not need one`);

  const summary = voiceSummary(config.tts);
  checks.tts = {
    ok: !config.tts.enabled || summary.count > 0 || summary.defaultVoice,
    detail: config.tts.enabled
      ? `${config.tts.provider || "gpt-sovits"} @ ${config.tts.baseUrl || "(no base URL)"}; ` +
        `${summary.count} voice(s), ${summary.defaultVoice ? "default voice set" : "no default voice"}`
      : "disabled",
    voices: summary,
  };

  return { ok: errors.length === 0, errors, warnings, checks, voiceSummary: summary };
};

export const formatReport = (report) => {
  const lines = [];
  for (const [name, check] of Object.entries(report.checks)) {
    lines.push(`${check.ok ? "[ok]" : "[!!]"} ${name}: ${check.detail}`);
  }
  if (report.errors.length) {
    lines.push("", "errors:");
    for (const e of report.errors) lines.push(`  - ${e.path}: ${e.message}`);
  }
  if (report.warnings.length) {
    lines.push("", "warnings:");
    for (const w of report.warnings) lines.push(`  - ${w.path}: ${w.message}`);
  }
  lines.push("", report.ok ? "OK" : "FAILED");
  return lines.join("\n");
};
