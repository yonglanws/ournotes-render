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
import { EVAL_SCENES, sceneList } from "./eval-scenes.mjs";
import {
  buildProvenance, catalogDigest, configFingerprint, evalSourceDigestInfo, EVAL_POLICY,
} from "./eval-provenance.mjs";
import { redactValue, redactingLogger } from "./redaction.mjs";

export { EVAL_SCENES };

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
  const scenes = sceneList();
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

export const assertLabOutsideRepository = (labRoot) => {
  const resolved = path.resolve(labRoot);
  if (inside(ROOT, resolved)) throw new Error("OURNOTES_AI_LAB must be outside the repository");
  return resolved;
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

// Fatal CLI errors bypass per-scene redaction otherwise. Keep the formatting
// here so a key in an exception message or details block is scrubbed too.
export const fatalErrorText = (error, secrets = []) => {
  const message = error instanceof Error ? error.message : String(error);
  const details = error && typeof error === "object" && "details" in error ? error.details : null;
  const body = details === null ? message : `${message}\n${JSON.stringify(details, null, 2)}`;
  return redactValue(body, secrets);
};

// One failure shape for every scene, including a generation failure that has no
// compiled result: elapsed time, warnings already produced, and the raw/partial
// answer reference when the writer got that far.
export const failureRecord = ({ scene, run, label, error, startedAt, partial = null }) => {
  const record = {
    label,
    scene: { index: scene.index, label: scene.label, logline: scene.logline },
    run,
    latencyMs: partial?.latencyMs ?? (Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null),
    warnings: partial?.warnings || [],
    raw: partial?.raw ?? null,
    stages: partial?.stages ?? null,
    usage: partial?.usage ?? null,
    ...errorRecord(error),
  };
  if (partial) record.partial = partial;
  return record;
};

const LINE_DIRECTION_KEYS = ["focus", "camera", "track", "zoom", "zoomDuration", "focusDuration",
  "trackDuration", "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide",
  "dof", "dofDuration", "dofLayers", "look", "lookY", "lookDuration", "lookAt",
  "motion", "expression", "motionFadeIn", "motionWait", "se", "seDuration", "seDelay", "seStop"];
const DIRECTION_COMMANDS = ["Focus", "Track", "Zoom", "Pedestal", "PanV2", "DoF", "Look", "LookTarget",
  "Motion", "Expression", "Se"];

// A line has direction when it carries a camera/acting/gaze/sound field, not
// merely because a scene or positions beat set the inherited shot. This is what
// separates a directed storyboard from a bare-line fallback.
const hasLineDirectionValue = (value) => {
  if (value === undefined || value === null || value === "" || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};
const hasLineDirection = (beat) => {
  if (!beat || typeof beat !== "object") return false;
  if (Array.isArray(beat.actions) && beat.actions.length) return true;
  return LINE_DIRECTION_KEYS.some((key) => hasLineDirectionValue(beat[key]));
};

export const sceneDirectionStats = (script, episode) => {
  const beats = Array.isArray(script?.beats) ? script.beats : [];
  const lineBeats = beats.filter((beat) => beat && (beat.kind === "say" || beat.kind === "narrate" ||
    "say" in beat || "narrate" in beat));
  const commands = Array.isArray(episode?.commands) ? episode.commands : [];
  return {
    lineCount: lineBeats.length,
    linesWithDirection: lineBeats.filter(hasLineDirection).length,
    commandCount: commands.filter((row) => DIRECTION_COMMANDS.includes(row?.cmd)).length,
  };
};

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

export const evaluateScene = async ({ scene, run, label, llm, catalog, compiler, config, runDir, logger,
                                      generate = generateScript, redact = (value) => value }) => {
  const started = Date.now();
  const request = { prompt: scene.logline, language: catalog.language, title: scene.title,
                    targetMinutes: Number(config.story.targetMinutes) };
  // Exactly one StoryWriter invocation per scene. StoryWriter owns its own
  // truncation retry (staged "ask" and its repair rounds); a second call here
  // would generate a second script for the same scene and double the budget.
  // Warnings emitted before a failure are kept for the failure record.
  const capturedWarnings = [];
  const captureLogger = Object.create(logger || null);
  captureLogger.warn = (message) => {
    capturedWarnings.push(message);
    logger?.warn?.(message);
  };
  let generated;
  try {
    generated = await generate({ llm, catalog, request, config, logger: captureLogger });
  } catch (error) {
    if (error && typeof error === "object" && !error.partial) {
      error.partial = { latencyMs: Date.now() - started, warnings: capturedWarnings, raw: null, stages: null };
    }
    throw error;
  }
  const generationMs = generated.durationMs ?? (Date.now() - started);
  const storyFile = `${label}.story.json`;
  if (generated.doc) writeJson(path.join(runDir, storyFile), redact(generated.doc));
  // The last model answer is useful when a staged storyboard was repaired or
  // fell back; it is a model response, never the prompt or the API key.
  if (generated.raw) fs.writeFileSync(path.join(runDir, `${label}.raw.txt`), redact(generated.raw));

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
  const direction = sceneDirectionStats(script, compiled.episode);
  result.direction = direction;
  if (!direction.lineCount || !direction.linesWithDirection || !direction.commandCount) {
    result.latencyMs = Date.now() - started;
    throw Object.assign(new Error("the compiled scene has no line direction"), {
      code: "noDirection", details: direction, partial: result,
    });
  }
  const metrics = auditGeneratedScriptToMetrics({ episode: compiled.episode }, script);
  const count = metrics.summary.count;
  const finalMetrics = {
    twoLineShare: metrics.summary.perTextLine.twoLineShare,
    focusPerLine: metrics.summary.focusPerLine,
    lookAnyPerLine: metrics.summary.lookAnyPerLine,
  };
  let normalization = generated.normalization || null;
  if (!normalization) {
    const rawTwoLine = metrics.lines.filter((line) => String(line.body || "").includes("\n")).length;
    normalization = {
      pipeline: config.llm.pipeline,
      lineBreaks: { total: count, rawTwoLine, removed: 0, added: 0,
                    changedShare: 0, rawTwoLineShare: count ? rawTwoLine / count : 0 },
      direction: { lineCount: count, rawFocus: metrics.summary.focus, focusPruned: 0,
                   finalFocus: metrics.summary.focus, rawGaze: metrics.summary.lookAny, gazePruned: 0,
                   finalGaze: metrics.summary.lookAny },
      names: { repaired: 0, dropped: 0 },
    };
  }
  const lineBreaks = normalization.lineBreaks || {};
  const rawTwoLine = Math.min(count, Math.max(0, Number(lineBreaks.rawTwoLine) || 0));
  const removed = Math.max(0, Number(lineBreaks.removed) || 0);
  const added = Math.max(0, Number(lineBreaks.added) || 0);
  normalization.lineBreaks = {
    total: count, rawTwoLine, removed, added,
    changedShare: count ? (removed + added) / count : 0,
    rawTwoLineShare: count ? rawTwoLine / count : 0,
  };
  const rawFocus = Math.max(metrics.summary.focus,
    Number(normalization.direction?.rawFocus) || 0);
  const rawGaze = Math.max(metrics.summary.lookAny,
    Number(normalization.direction?.rawGaze) || 0);
  normalization.direction = {
    lineCount: count,
    rawFocus, focusPruned: rawFocus - metrics.summary.focus, finalFocus: metrics.summary.focus,
    rawGaze, gazePruned: rawGaze - metrics.summary.lookAny, finalGaze: metrics.summary.lookAny,
  };
  normalization.names = {
    repaired: Math.max(0, Number(normalization.names?.repaired) || 0),
    dropped: Math.max(0, Number(normalization.names?.dropped) || 0),
  };
  normalization.pipeline = normalization.pipeline || config.llm.pipeline;
  result.normalization = normalization;
  result.metrics = {
    raw: {
      twoLineShare: normalization.lineBreaks.rawTwoLineShare,
      focusPerLine: count ? normalization.direction.rawFocus / count : 0,
      lookAnyPerLine: count ? normalization.direction.rawGaze / count : 0,
    },
    final: finalMetrics,
  };
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

const usage = () => `Usage: npm run eval:stories -- --run <name> [--prompts all|1,2,...]
       [--pipeline staged|single] [--temperature 0..2] [--target minutes] [--runs 1..10]

Environment:
  OURNOTES_CONFIG        host config file (default: <repo>/config.yaml)
  OURNOTES_SITE_FORMAT   site-format story site directory (absolute path works)
  OURNOTES_AI_LAB        report root outside the repository
  OURNOTES_LLM_API_KEY   LLM key, read through llm.apiKeyEnv (never printed)`;

// The CLI top-level catch runs outside the per-scene redaction boundary. Keep
// the configured values here so a fatal error is scrubbed with the same set.
let fatalSecrets = [];

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
  config.llm.retries = 2;
  config.llm.directorPlan = false;
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

  const secrets = [config.secrets.llmApiKey, config.secrets.ttsApiKey, config.secrets.apiKey]
    .filter((secret) => typeof secret === "string" && secret.length >= 4);
  fatalSecrets = secrets;
  const logger = redactingLogger(console, secrets);
  const redact = (value) => redactValue(value, secrets);

  const selected = selectScenes(args.prompts);
  const labRoot = assertLabOutsideRepository(
    process.env.OURNOTES_AI_LAB || path.join(ROOT, "..", "ournotes-ai-lab"),
  );
  const runDir = path.join(labRoot, "runs", args.run);
  fs.mkdirSync(runDir, { recursive: true });

  const { catalog, compiler } = await catalogsFor({
    siteDir, language: config.story.language, personas: config.story.personas,
    base: config.story.base, logger,
  });
  const catalogHash = catalogDigest(catalog, compiler);
  const fingerprint = configFingerprint({
    config, catalog, catalogHash, pipeline: args.pipeline,
    temperature: args.temperature, targetMinutes: args.target,
  });
  const source = evalSourceDigestInfo();
  const generatedAt = new Date().toISOString();
  const llm = new LLMClient({ ...config.llm, apiKey: config.secrets.llmApiKey },
    { logger, allowPrivate: config.security.allowPrivateServiceEndpoints });
  if (!llm.available) throw new Error("the LLM client is not configured");

  const results = [], failures = [], allStories = {};
  const total = selected.length * args.runs;
  let done = 0;
  for (let repeat = 1; repeat <= args.runs; repeat++) {
    for (const scene of selected) {
      const label = args.runs > 1 ? `${scene.label}-run${repeat}` : scene.label;
      done++;
      logger.error(`[${done}/${total}] ${label} (${args.pipeline}, temperature ${args.temperature})`);
      const sceneStarted = Date.now();
      try {
        const result = redact(await evaluateScene({
          scene, run: repeat, label, llm, catalog, compiler, config, runDir, logger, redact,
        }));
        results.push(result);
        writeJson(path.join(runDir, `${label}.report.json`), result);
        if (fs.existsSync(path.join(runDir, result.script)))
          allStories[label] = redact(JSON.parse(fs.readFileSync(path.join(runDir, result.script), "utf8")));
      } catch (error) {
        const record = redact(failureRecord({
          scene, run: repeat, label, error, startedAt: sceneStarted,
          partial: error && typeof error === "object" ? error.partial || null : null,
        }));
        failures.push(record);
        writeJson(path.join(runDir, `${label}.report.json`), record);
        logger.error(`  failed: ${record.error}`);
      }
    }
  }

  const provenance = buildProvenance({
    configFingerprint: fingerprint, catalogHash, sourceDigest: source.digest,
    runs: { name: args.run, runs: args.runs, selected: selected.map((scene) => scene.label) },
  });
  provenance.generatedAt = generatedAt;
  const report = {
    generatedAt,
    run: args.run,
    policy: EVAL_POLICY,
    scenes: EVAL_SCENES.map((scene, index) => ({ index: index + 1, ...scene })),
    selected: selected.map((scene) => scene.label),
    config: fingerprint,
    provenance,
    counts: { selected: selected.length, attempted: total, succeeded: results.length, failed: failures.length },
    results,
    aggregate: results.length ? aggregate(results.map((result) => result.summary)) : null,
    failures,
  };
  writeJson(path.join(runDir, "all-stories.json"), allStories);
  writeJson(path.join(runDir, "report.json"), report);
  logger.error(`${results.length}/${total} scenes succeeded; report: ${path.join(runDir, "report.json")}`);
  return results.length ? 0 : 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { if (code) process.exitCode = code; })
    .catch((error) => {
      redactingLogger(console, fatalSecrets).error(fatalErrorText(error, fatalSecrets));
      process.exit(2);
    });
}
