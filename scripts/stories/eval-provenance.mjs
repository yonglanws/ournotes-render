// Reproducibility metadata for an evaluation report. The quality gate recomputes
// the same digests from the shared scene list and the checked-in source, so a
// stale, hand-edited or scene-cherry-picked report cannot pass.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EVAL_SCENES } from "./eval-scenes.mjs";
import { FIXED_MIN_CHARS, FIXED_MIN_LINES } from "../../host/ai/official-targets.js";

export { FIXED_MIN_CHARS, FIXED_MIN_LINES };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROVENANCE_SCHEMA = "ournotes-eval-provenance/1";
export const FIXED_TARGET_MINUTES = 2;
export const FIXED_MAX_LINES = 36;

// A product decision, recorded in every report: line-break balancing is a
// deterministic renderer layout step. Raw two-line output is diagnostic; the
// final compiled metric is the gated output. A raw two-line minimum is
// deliberately not required because the layout step decides the rendered shape.
export const EVAL_POLICY = Object.freeze({
  schema: "ournotes-eval-policy/1",
  lineBreakBalancing: "deterministic-renderer-layout",
  gatedMetricBasis: "final-compiled",
  rawTwoLineMinimum: null,
  note: "Raw model line breaks are reported for diagnosis only; the host balances line breaks during layout, and the final compiled metric is gated with a normalization cap.",
});

// Files whose contents decide the generated script and its metrics. Tests and
// docs are deliberately excluded: changing a test must not invalidate a report.
export const EVAL_SOURCE_FILES = Object.freeze([
  "host/ai/json.js",
  "host/ai/llm.js",
  "host/ai/official-targets.js",
  "host/ai/personas.js",
  "host/ai/prompt.js",
  "host/ai/staged.js",
  "host/ai/storyWriter.js",
  "host/config.js",
  "host/story/siteFormat.js",
  "host/tools/site-story.mjs",
  "scripts/lib/story-author/script.js",
  "scripts/stories/ai-eval.mjs",
  "scripts/stories/compiled-command-audit.mjs",
  "scripts/stories/eval-provenance.mjs",
  "scripts/stories/eval-scenes.mjs",
  "scripts/stories/official-baseline.mjs",
  "scripts/stories/official-corpus.mjs",
  "scripts/stories/story-metrics.mjs",
  "src/story/interfaces.js",
]);

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
};

export const stableStringify = (value) => JSON.stringify(sortValue(value));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export const sceneListDigest = (scenes = EVAL_SCENES) => sha256(stableStringify(
  scenes.map(({ label, logline, title }) => ({ label, logline, title })),
));

export const evalSourceDigestInfo = () => {
  const files = EVAL_SOURCE_FILES.map((rel) => {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) throw new Error(`evaluation source file is missing: ${rel}`);
    return { path: rel, digest: sha256(fs.readFileSync(file)) };
  });
  return { digest: sha256(stableStringify(files)), files };
};

export const evalSourceDigest = () => evalSourceDigestInfo().digest;

export const gitHead = () => {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) return null;
  const head = String(result.stdout || "").trim();
  return /^[0-9a-f]{40}$/i.test(head) ? head : null;
};

const safeBaseUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return String(value || "");
  }
};

// Identity of the site/base catalog the writer saw: stages, music, sounds and
// every model's motion/expression vocabulary.
export const catalogIdentity = (catalog, compiler) => ({
  base: catalog.manifest,
  language: catalog.language,
  stages: catalog.stages,
  music: catalog.music,
  sounds: catalog.sounds,
  models: (catalog.models || []).map((model) => ({
    id: model.id, name: model.name, character: model.character, group: model.group,
    motions: model.motions, expressions: model.expressions,
    defaultMotion: model.defaultMotion, defaultExpression: model.defaultExpression,
  })),
  baseManifest: compiler?.baseManifest
    ? {
      format: compiler.baseManifest.format,
      language: compiler.baseManifest.language,
      languages: compiler.baseManifest.languages,
      story: compiler.baseManifest.story,
      requires: compiler.baseManifest.requires,
    }
    : null,
});

export const catalogDigest = (catalog, compiler) => sha256(stableStringify(catalogIdentity(catalog, compiler)));

export const personaIdentity = (personas = []) => personas.map((persona) => ({
  name: persona.name || "",
  group: persona.group || "",
  aliases: [...(persona.aliases || [])].sort(),
  promptChars: String(persona.prompt || "").length,
  promptDigest: sha256(String(persona.prompt || "")),
})).sort((a, b) => `${a.name}|${a.group}`.localeCompare(`${b.name}|${b.group}`, "en"));

// The redacted report config plus the reproducibility inputs. The gate recomputes
// this object's digest from report.config and also pins the fixed baseline values.
export const configFingerprint = ({ config, catalog, catalogHash, pipeline, temperature, targetMinutes }) => ({
  configFile: config.configFile ? path.basename(config.configFile) : null,
  siteFormat: config.paths.siteFormat ? path.basename(config.paths.siteFormat) : "",
  base: catalog.manifest,
  language: catalog.language,
  catalogDigest: catalogHash,
  pipeline,
  temperature,
  targetMinutes,
  maxLines: config.story.maxLines,
  minLines: FIXED_MIN_LINES,
  minChars: FIXED_MIN_CHARS,
  maxOnStage: config.story.maxOnStage,
  repairRounds: config.llm.repairRounds,
  translateForTts: config.llm.translateForTts,
  jsonMode: config.llm.jsonMode,
  maxTokens: config.llm.maxTokens,
  timeoutMs: config.llm.timeoutMs,
  retries: config.llm.retries,
  directorPlan: config.llm.directorPlan,
  model: config.llm.model,
  baseUrl: safeBaseUrl(config.llm.baseUrl),
  apiKey: config.secrets.llmApiKey ? "set" : "unset",
  systemPromptChars: String(config.llm.systemPrompt || "").length,
  systemPromptDigest: sha256(String(config.llm.systemPrompt || "")),
  personas: personaIdentity(config.story.personas),
  sceneListDigest: sceneListDigest(),
});

export const configDigest = (fingerprint) => sha256(stableStringify(fingerprint));

export const buildProvenance = ({ configFingerprint: fingerprint, catalogHash, sourceDigest, runs }) => ({
  schema: PROVENANCE_SCHEMA,
  generatedAt: new Date().toISOString(),
  sceneList: { digest: sceneListDigest(), labels: EVAL_SCENES.map((scene) => scene.label) },
  source: { digest: sourceDigest, gitHead: gitHead() },
  catalog: { digest: catalogHash, base: fingerprint.base, language: fingerprint.language },
  config: { digest: configDigest(fingerprint) },
  runs,
});
