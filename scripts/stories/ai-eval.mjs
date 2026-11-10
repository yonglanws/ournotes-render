// Fixed-scene AI evaluation for the offline StoryWriter. Eight versioned
// two-character scenes are generated one call at a time with the operator's
// configured model, compiled against a site-format story, audited row by row,
// and measured with the same line/metric adapter as the official corpus.
//
// Runs are written outside the repository under OURNOTES_AI_LAB (default
// <workspace>/../ournotes-ai-lab): runs/<run>/<label>.story.json,
// <label>.report.json, all-stories.json and report.json. No API key and no
// absolute main-repo path is written into the report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, loadConfig } from "../../host/config.js";
import { LLMClient } from "../../host/ai/llm.js";
import { generateScript } from "../../host/ai/storyWriter.js";
import { checkScript, compileScript, parseScript } from "../lib/story-author/script.js";
import { readSiteCatalog } from "../../host/tools/site-story.mjs";
import { SiteFormatCatalog } from "../../host/story/siteFormat.js";
import { aggregate } from "./story-metrics.mjs";
import { auditCompiledStory, auditGeneratedScriptToMetrics } from "./compiled-command-audit.mjs";

// Exactly eight fixed two-character scenes. Keep this list versioned: a gate
// compares runs across models, temperatures and prompt revisions, so changing a
// logline is a new evaluation baseline, not a local tweak.
export const EVAL_SCENES = Object.freeze([
  { label: "rain-stop", logline: "雨后便利店的屋檐下，两名乐队成员等雨停；一人想立刻走，一人想再多待一会儿。",
    title: "雨停之前" },
  { label: "lost-ticket", logline: "车站检票口，一人发现车票不见了；另一人嘴上说不管，还是蹲下来一起找。",
    title: "找不到的票" },
  { label: "last-rehearsal", logline: "练习室熄灯前，两人为一句和声反复磨合；一人先失去耐心，另一人坚持再来一次。",
    title: "最后一遍" },
  { label: "shared-snack", logline: "深夜厨房只剩最后一份点心，两人推来推去，谁也不肯先吃。",
    title: "最后一份" },
  { label: "one-umbrella", logline: "放学时突然下起大雨，只有一把伞；两人挤在伞下，谁都没提要走快一点。",
    title: "一把伞" },
  { label: "before-stage", logline: "演出开始前十分钟，一人在后台紧张得说不出话；另一人用很笨的方式让她开口。",
    title: "上场之前" },
  { label: "missing-earring", logline: "更衣室里，一人发现耳环少了一只；另一人一边安慰一边翻遍每个角落。",
    title: "少了一只" },
  { label: "last-train", logline: "末班车进站前，两人在站台聊起明天；广播响了，谁也没有先动。",
    title: "末班车" },
]);

export const parseArgs = (argv) => {
  const o = { run: "", prompts: "all", pipeline: "staged", temperature: 0.8, target: 2, runs: 1, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") o.run = argv[++i] || "";
    else if (a === "--prompts") o.prompts = argv[++i] || "";
    else if (a === "--pipeline") o.pipeline = argv[++i] || "";
    else if (a === "--temperature") o.temperature = Number(argv[++i]);
    else if (a === "--target") o.target = Number(argv[++i]);
    else if (a === "--runs") o.runs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.help) return o;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.run) || o.run.includes(".."))
    throw new Error("--run is required and must be a safe name (letters, digits, . _ -)");
  if (!["staged", "single"].includes(o.pipeline))
    throw new Error("--pipeline must be staged or single");
  if (!Number.isFinite(o.temperature) || o.temperature < 0 || o.temperature > 2)
    throw new Error("--temperature must be a number in 0..2");
  if (!Number.isFinite(o.target) || o.target < 0.5 || o.target > 10)
    throw new Error("--target must be a number of minutes in 0.5..10");
  if (!Number.isInteger(o.runs) || o.runs < 1 || o.runs > 10)
    throw new Error("--runs must be an integer in 1..10");
  return o;
};

export const selectScenes = (spec = "all") => {
  const scenes = EVAL_SCENES.map((scene, index) => ({ ...scene, index: index + 1 }));
  if (!spec || spec === "all") return scenes;
  const indexes = [...new Set(spec.split(",").map((part) => part.trim()).filter(Boolean).map(Number))];
  if (!indexes.length) throw new Error("--prompts must be all or a comma-separated list of scene numbers");
  for (const index of indexes)
    if (!Number.isInteger(index) || index < 1 || index > scenes.length)
      throw new Error(`--prompts selects ${index}; there are ${scenes.length} fixed scenes`);
  return indexes.map((index) => scenes[index - 1]);
};

const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const dedupeWarnings = (warnings) => [...new Map((warnings || []).map((warning) => [
  typeof warning === "string" ? `string|${warning}`
    : `${warning?.path || ""}|${warning?.code || ""}|${warning?.message || ""}`, warning,
])).values()];

const errorRecord = (error) => ({
  error: error instanceof Error ? error.message : String(error),
  code: error && typeof error === "object" && "code" in error ? error.code : null,
  details: error && typeof error === "object" && "details" in error ? error.details : null,
});

// The writer catalog (SiteFormatCatalog) and the compiler catalog (readSiteCatalog)
// both come from the same base story manifest and language.
const catalogsFor = async ({ siteDir, language, personas, base, logger }) => {
  const siteCatalog = new SiteFormatCatalog({ dir: siteDir, language, personas, base, logger });
  const catalog = await siteCatalog.catalog();
  if (!catalog.models.length) throw new Error(`${siteDir}: no named models for the AI writer`);
  const compiler = readSiteCatalog(siteDir, catalog.manifest, catalog.language);
  return { catalog, compiler };
};

const compilerSite = (compiler) => ({
  base: compiler.base,
  models: compiler.models,
  actions: Object.fromEntries(compiler.actions),
  sounds: compiler.base.sounds,
});

// The manifest fields buildSiteStory writes, produced in memory so the
// evaluation never writes into the site it reads.
const manifestSlices = (compiler, episode) => {
  const commands = [...new Set(episode.commands.map((row) => row.cmd))].sort();
  return {
    commands,
    story: { commands },
    requires: { ...(compiler.baseManifest.requires || {}), commands },
  };
};

const compileDocument = ({ doc, compiler }) => {
  const parsed = parseScript(doc);
  if (parsed.errors.length) return { errors: parsed.errors, warnings: parsed.warnings };
  const checked = checkScript(parsed.script, compilerSite(compiler));
  if (checked.errors.length) return { errors: checked.errors, warnings: checked.warnings };
  const compiled = compileScript(parsed.script, {
    base: compiler.base,
    models: Object.fromEntries(compiler.modelKeys),
    actions: Object.fromEntries(compiler.actions),
    sounds: compiler.base.sounds,
  }, checked.language);
  return { compiled, script: parsed.script, warnings: [...parsed.warnings, ...checked.warnings] };
};

const isTruncated = (error) => {
  const text = `${error?.message || ""} ${error?.cause?.message || ""}`;
  return /truncated|finish_reason=length/i.test(text);
};

export const evaluateScene = async ({ scene, run, label, llm, catalog, compiler, config, runDir, logger }) => {
  const started = Date.now();
  const request = { prompt: scene.logline, language: catalog.language, title: scene.title,
                    targetMinutes: Number(config.story.targetMinutes) };
  const generate = () => generateScript({ llm, catalog, request, config, logger });
  let generated;
  try {
    generated = await generate();
  } catch (error) {
    // A truncated answer is a stochastic model failure, not a bad scene: retry
    // the same fixed request once before recording the scene as failed.
    if (!isTruncated(error)) throw error;
    logger.warn?.(`${label}: truncated answer; retrying the scene once`);
    generated = await generate();
  }
  const generationMs = generated.durationMs ?? (Date.now() - started);
  const storyFile = `${label}.story.json`;
  if (generated.doc) writeJson(path.join(runDir, storyFile), generated.doc);
  // The last model answer is useful when a staged storyboard was repaired or
  // fell back; it is a model response, never the prompt or the API key.
  if (generated.raw) fs.writeFileSync(path.join(runDir, `${label}.raw.txt`), generated.raw);

  const result = { label, scene: { index: scene.index, label: scene.label, logline: scene.logline },
                   run, error: null, generationMs, latencyMs: 0,
                   usage: generated.usage || null, warnings: [], summary: null, compiled: null,
                   script: storyFile, raw: generated.raw ? `${label}.raw.txt` : null,
                   stages: generated.stages || null };
  // A bare-line fallback has no storyboard direction at all. Keep the document
  // for diagnosis, but it is not a successful evaluation scene: counting it
  // would let a zero-direction episode satisfy the per-scene hard minima.
  const degraded = (generated.warnings || []).some((warning) =>
    (typeof warning === "string" && warning.includes("分镜不可用")) ||
    (warning && typeof warning === "object" && String(warning.message || "").includes("分镜不可用"))) ||
    (generated.stages || []).some((stage) => stage.ok === false && /退回无动作演出/.test(stage.note || ""));
  if (degraded) {
    result.warnings = dedupeWarnings(generated.warnings);
    result.latencyMs = Date.now() - started;
    throw Object.assign(new Error("the storyboard fell back to bare lines"), {
      code: "degraded", details: (generated.stages || []).filter((stage) => stage.ok === false), partial: result,
    });
  }
  const compiledOut = compileDocument({ doc: generated.doc, compiler });
  const warnings = dedupeWarnings([...(generated.warnings || []), ...(compiledOut.warnings || [])]);
  result.warnings = warnings;
  if (compiledOut.errors) {
    result.latencyMs = Date.now() - started;
    throw Object.assign(new Error("the generated script did not compile"), {
      code: "compile", details: compiledOut.errors, partial: result,
    });
  }
  const { compiled, script } = compiledOut;
  const slices = manifestSlices(compiler, compiled.episode);
  const audit = auditCompiledStory({
    episode: compiled.episode,
    story: { ...compiled.story, ...slices.story },
    script,
    requires: slices.requires,
  });
  if (audit.failures.length) {
    result.latencyMs = Date.now() - started;
    throw Object.assign(new Error("the compiled episode failed the command audit"), {
      code: "audit", details: audit.failures, partial: { ...result, compiled: { ...audit } },
    });
  }
  const metrics = auditGeneratedScriptToMetrics({ episode: compiled.episode }, script);
  result.summary = metrics.summary;
  result.compiled = {
    commandCount: audit.commandCount,
    commands: audit.commands,
    counts: audit.counts,
    parameters: audit.parameters,
    resourceClosure: audit.resourceClosure,
  };
  result.latencyMs = Date.now() - started;
  return result;
};

const redactedConfig = ({ config, catalog, pipeline, temperature, targetMinutes }) => ({
  configFile: config.configFile ? path.basename(config.configFile) : null,
  siteFormat: config.paths.siteFormat ? path.basename(config.paths.siteFormat) : "",
  base: catalog.manifest,
  language: catalog.language,
  pipeline,
  temperature,
  targetMinutes,
  maxLines: config.story.maxLines,
  maxOnStage: config.story.maxOnStage,
  repairRounds: config.llm.repairRounds,
  translateForTts: config.llm.translateForTts,
  jsonMode: config.llm.jsonMode,
  maxTokens: config.llm.maxTokens,
  timeoutMs: config.llm.timeoutMs,
  model: config.llm.model,
  baseUrl: config.llm.baseUrl,
  apiKey: config.secrets.llmApiKey ? "set" : "unset",
});

const usage = () => `Usage: npm run eval:stories -- --run <name> [--prompts all|1,2,...]
       [--pipeline staged|single] [--temperature 0..2] [--target minutes] [--runs 1..10]

Environment:
  OURNOTES_CONFIG        host config file (default: <repo>/config.yaml)
  OURNOTES_SITE_FORMAT   site-format story site directory (absolute path works)
  OURNOTES_AI_LAB        report root outside the repository
  OURNOTES_LLM_API_KEY   LLM key, read through llm.apiKeyEnv (never printed)`;

export const main = async (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const config = loadConfig({ file: process.env.OURNOTES_CONFIG || path.join(ROOT, "config.yaml") });
  const siteDir = config.paths.siteFormat;
  if (!siteDir) throw new Error("paths.siteFormat is empty: set OURNOTES_SITE_FORMAT to a site-format story site");
  if (!config.llm.enabled || !config.llm.model) throw new Error("llm.enabled and llm.model are required");

  // Fixed evaluation parameters. The model, base URL and key stay the
  // operator's configuration; everything that affects the gate is pinned.
  config.llm.pipeline = args.pipeline;
  config.llm.temperature = args.temperature;
  config.llm.repairRounds = 2;
  config.llm.translateForTts = false;
  config.llm.jsonMode = "auto";
  config.llm.maxTokens = 16384;
  config.llm.timeoutMs = 180000;
  config.story.targetMinutes = args.target;
  // 2 minutes is 36 lines by the official formula; 36 is also the strict
  // line cap for one answer, which keeps the storyboard JSON inside maxTokens.
  config.story.maxLines = Math.min(Number(config.story.maxLines) || 36, 36);
  // The fixed scenes are two-character scenes; the third stage never needs a
  // third person on stage.
  config.story.maxOnStage = 2;

  const selected = selectScenes(args.prompts);
  const labRoot = path.resolve(process.env.OURNOTES_AI_LAB || path.join(ROOT, "..", "ournotes-ai-lab"));
  if (inside(ROOT, labRoot)) throw new Error("OURNOTES_AI_LAB must be outside the repository");
  const runDir = path.join(labRoot, "runs", args.run);
  fs.mkdirSync(runDir, { recursive: true });

  const { catalog, compiler } = await catalogsFor({
    siteDir, language: config.story.language, personas: config.story.personas,
    base: config.story.base, logger: console,
  });
  const llm = new LLMClient({ ...config.llm, apiKey: config.secrets.llmApiKey },
    { logger: console, allowPrivate: config.security.allowPrivateServiceEndpoints });
  if (!llm.available) throw new Error("the LLM client is not configured");

  const results = [], failures = [], allStories = {};
  const total = selected.length * args.runs;
  let done = 0;
  for (let repeat = 1; repeat <= args.runs; repeat++) {
    for (const scene of selected) {
      const label = args.runs > 1 ? `${scene.label}-run${repeat}` : scene.label;
      done++;
      console.error(`[${done}/${total}] ${label} (${args.pipeline}, temperature ${args.temperature})`);
      try {
        const result = await evaluateScene({
          scene, run: repeat, label, llm, catalog, compiler, config, runDir, logger: console,
        });
        results.push(result);
        writeJson(path.join(runDir, `${label}.report.json`), result);
        if (fs.existsSync(path.join(runDir, result.script)))
          allStories[label] = JSON.parse(fs.readFileSync(path.join(runDir, result.script), "utf8"));
      } catch (error) {
        const record = {
          label, scene: { index: scene.index, label: scene.label, logline: scene.logline },
          run: repeat, latencyMs: error?.partial?.latencyMs ?? null, ...errorRecord(error),
        };
        if (error && typeof error === "object" && error.partial) record.partial = error.partial;
        failures.push(record);
        writeJson(path.join(runDir, `${label}.report.json`), record);
        console.error(`  failed: ${record.error}`);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    run: args.run,
    scenes: EVAL_SCENES.map((scene, index) => ({ index: index + 1, label: scene.label, logline: scene.logline })),
    selected: selected.map((scene) => scene.label),
    config: redactedConfig({ config, catalog, pipeline: args.pipeline,
                             temperature: args.temperature, targetMinutes: args.target }),
    counts: { selected: selected.length, attempted: total, succeeded: results.length, failed: failures.length },
    results,
    aggregate: results.length ? aggregate(results.map((result) => result.summary)) : null,
    failures,
  };
  writeJson(path.join(runDir, "all-stories.json"), allStories);
  writeJson(path.join(runDir, "report.json"), report);
  console.error(`${results.length}/${total} scenes succeeded; report: ${path.join(runDir, "report.json")}`);
  return results.length ? 0 : 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { if (code) process.exitCode = code; })
    .catch((error) => { console.error(error.message); if (error.details) console.error(JSON.stringify(error.details, null, 2)); process.exit(2); });
}
