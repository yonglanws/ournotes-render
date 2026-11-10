// Pure validation of one named evaluation report. The CLI/test gate loads the
// JSON and calls reportFailures; every check is deterministic and can be tested
// with a mutated in-memory report.
import { aggregate } from "./story-metrics.mjs";
import { EVAL_SCENES, EVAL_SCENE_LABELS } from "./eval-scenes.mjs";
import {
  FIXED_MAX_LINES, FIXED_TARGET_MINUTES, PROVENANCE_SCHEMA, configDigest, evalSourceDigest,
  sceneListDigest,
} from "./eval-provenance.mjs";

export const REPORT_MAX_AGE_HOURS = 72;

export const AGGREGATE_RANGES = Object.freeze([
  ["charsMean", (a) => a.charsMean, 12, 19],
  ["twoLineShare", (a) => a.perTextLine?.twoLineShare, 0.25, 0.50],
  ["shortShare", (a) => a.perTextLine?.shortShare, 0.12, 0.30],
  ["soloRunShare", (a) => a.soloRunShare, 0.58, 0.82],
  ["focusPerLine", (a) => a.focusPerLine, 0.30, 0.50],
  ["motionsPerLine", (a) => a.motionsPerLine, 1.0, 1.5],
  ["lookAnyPerLine", (a) => a.lookAnyPerLine, 0.20, 0.42],
  ["zoomPerLine", (a) => a.zoomPerLine, 0.03, 0.16],
  ["pedestalPerLine", (a) => a.pedestalPerLine, 0.04, 0.15],
  ["panV2PerLine", (a) => a.panV2PerLine, 0.05, 0.18],
  ["sePerLine", (a) => a.sePerLine, 0.04, 0.16],
]);

export const NORMALIZATION_CAPS = Object.freeze({
  lineBreakChangedShare: 0.45,
  focusPruneShare: 0.55,
  gazePruneShare: 0.40,
  nameChangedShare: 0.20,
});

export const RAW_RANGES = Object.freeze({
  // The model may write all single-line dialogue; the normalization cap below
  // bounds how much the host may reshape it. The upper bound still catches
  // nearly-every-line two-line output.
  twoLineShare: [0, 0.85],
  focusPerLine: [0.15, 1.20],
  lookAnyPerLine: [0.05, 0.90],
});

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const near = (a, b, epsilon = 1e-9) => finite(a) && finite(b) && Math.abs(a - b) <= epsilon;
const show = (value, digits = 3) => (finite(value) ? value.toFixed(digits) : String(value));
const outside = (value, min, max) => !finite(value) || value < min || value > max;

export const rangeFailures = (aggregateValues) => AGGREGATE_RANGES.flatMap(([name, valueOf, min, max]) => {
  const value = valueOf(aggregateValues || {});
  if (!finite(value)) return [`${name} is not a finite number`];
  return outside(value, min, max) ? [`${name} ${show(value)} is outside ${min}..${max}`] : [];
});

export const fixedBaselineFailures = (config = {}) => {
  const expected = {
    targetMinutes: FIXED_TARGET_MINUTES, maxLines: FIXED_MAX_LINES, maxOnStage: 2, repairRounds: 2,
    translateForTts: false, jsonMode: "auto", maxTokens: 16384, timeoutMs: 180000, retries: 2,
    directorPlan: false,
  };
  return Object.entries(expected).flatMap(([key, value]) =>
    config[key] === value ? [] : [`config.${key} is ${JSON.stringify(config[key])}, expected ${JSON.stringify(value)}`]);
};

export const sceneCoverageFailures = (report) => {
  const failures = [];
  const scenes = Array.isArray(report.scenes) ? report.scenes : [];
  const labels = scenes.map((scene) => scene?.label);
  if (labels.length !== EVAL_SCENE_LABELS.length ||
      labels.some((label, index) => label !== EVAL_SCENE_LABELS[index]))
    failures.push(`report.scenes is not the fixed 8-scene list: ${JSON.stringify(labels)}`);
  const results = Array.isArray(report.results) ? report.results : [];
  const runs = report.provenance?.runs?.runs ?? 1;
  if (!Number.isInteger(runs) || runs < 1) failures.push(`provenance.runs.runs is invalid: ${runs}`);
  const resultLabels = results.map((result) => result?.label);
  if (new Set(resultLabels).size !== resultLabels.length) failures.push("report.results has duplicate labels");
  const baseLabels = results.map((result) => result?.scene?.label);
  const baseCounts = new Map();
  for (const label of baseLabels) baseCounts.set(label, (baseCounts.get(label) || 0) + 1);
  const missing = EVAL_SCENE_LABELS.filter((label) => !baseCounts.has(label));
  const extra = [...baseCounts.keys()].filter((label) => !EVAL_SCENE_LABELS.includes(label));
  if (missing.length) failures.push(`report.results is missing scenes: ${missing.join(", ")}`);
  if (extra.length) failures.push(`report.results has unknown scenes: ${extra.join(", ")}`);
  for (const label of EVAL_SCENE_LABELS) {
    if (baseCounts.has(label) && baseCounts.get(label) !== runs)
      failures.push(`report.results has ${baseCounts.get(label)} result(s) for ${label}; expected ${runs}`);
  }
  for (const result of results) {
    const expectedIndex = EVAL_SCENE_LABELS.indexOf(result?.scene?.label) + 1;
    if (expectedIndex > 0 && result.scene.index !== expectedIndex)
      failures.push(`${result.scene.label}: scene.index ${result.scene.index} != ${expectedIndex}`);
  }
  if (report.provenance?.sceneList?.digest !== sceneListDigest())
    failures.push("report.provenance.sceneList.digest does not match the fixed scene list");
  return failures;
};

const normalizationFailures = (result) => {
  const failures = [];
  const label = result.label || "(unnamed scene)";
  const summary = result.summary || {};
  const normalization = result.normalization;
  const metrics = result.metrics;
  if (!normalization || typeof normalization !== "object") {
    failures.push(`${label}: normalization is missing`);
    return failures;
  }
  if (!metrics?.raw || !metrics?.final) {
    failures.push(`${label}: metrics.raw/metrics.final is missing`);
    return failures;
  }
  const lineBreaks = normalization.lineBreaks || {};
  const direction = normalization.direction || {};
  const names = normalization.names || {};
  const total = lineBreaks.total ?? summary.count;
  if (total !== summary.count) failures.push(`${label}: lineBreaks.total ${total} != summary.count ${summary.count}`);
  if (!finite(lineBreaks.rawTwoLine) || lineBreaks.rawTwoLine < 0 || lineBreaks.rawTwoLine > total)
    failures.push(`${label}: lineBreaks.rawTwoLine is invalid`);
  if (!finite(lineBreaks.removed) || !finite(lineBreaks.added) || lineBreaks.removed < 0 || lineBreaks.added < 0)
    failures.push(`${label}: lineBreaks removed/added is invalid`);
  const changedShare = total ? ((lineBreaks.removed || 0) + (lineBreaks.added || 0)) / total : 0;
  if (!near(changedShare, lineBreaks.changedShare))
    failures.push(`${label}: lineBreaks.changedShare ${show(lineBreaks.changedShare)} != ${show(changedShare)}`);
  if (changedShare > NORMALIZATION_CAPS.lineBreakChangedShare)
    failures.push(`${label}: lineBreakChangedShare ${show(changedShare)} > ${NORMALIZATION_CAPS.lineBreakChangedShare}`);
  const rawTwoLineShare = total ? lineBreaks.rawTwoLine / total : 0;
  if (!near(rawTwoLineShare, lineBreaks.rawTwoLineShare))
    failures.push(`${label}: lineBreaks.rawTwoLineShare ${show(lineBreaks.rawTwoLineShare)} != ${show(rawTwoLineShare)}`);
  if (!finite(direction.lineCount) || direction.lineCount !== summary.count)
    failures.push(`${label}: direction.lineCount != summary.count`);
  for (const field of ["rawFocus", "focusPruned", "finalFocus", "rawGaze", "gazePruned", "finalGaze"]) {
    if (!finite(direction[field]) || direction[field] < 0) failures.push(`${label}: direction.${field} is invalid`);
  }
  if (finite(direction.rawFocus) && finite(direction.focusPruned) && finite(direction.finalFocus) &&
      direction.rawFocus - direction.focusPruned !== direction.finalFocus)
    failures.push(`${label}: rawFocus - focusPruned != finalFocus`);
  if (finite(direction.rawGaze) && finite(direction.gazePruned) && finite(direction.finalGaze) &&
      direction.rawGaze - direction.gazePruned !== direction.finalGaze)
    failures.push(`${label}: rawGaze - gazePruned != finalGaze`);
  const focusPruneShare = direction.rawFocus ? direction.focusPruned / direction.rawFocus : 0;
  const gazePruneShare = direction.rawGaze ? direction.gazePruned / direction.rawGaze : 0;
  const nameChanged = (names.repaired || 0) + (names.dropped || 0);
  const nameChangedShare = summary.count ? nameChanged / summary.count : 0;
  if (focusPruneShare > NORMALIZATION_CAPS.focusPruneShare)
    failures.push(`${label}: focusPruneShare ${show(focusPruneShare)} > ${NORMALIZATION_CAPS.focusPruneShare}`);
  if (gazePruneShare > NORMALIZATION_CAPS.gazePruneShare)
    failures.push(`${label}: gazePruneShare ${show(gazePruneShare)} > ${NORMALIZATION_CAPS.gazePruneShare}`);
  if (nameChangedShare > NORMALIZATION_CAPS.nameChangedShare)
    failures.push(`${label}: nameChangedShare ${show(nameChangedShare)} > ${NORMALIZATION_CAPS.nameChangedShare}`);
  // The raw model metrics must also be plausible; host normalization is capped above.
  for (const [name, [min, max]] of Object.entries(RAW_RANGES)) {
    const value = metrics.raw[name];
    if (outside(value, min, max)) failures.push(`${label}: raw ${name} ${show(value)} is outside ${min}..${max}`);
  }
  const expectedRawTwoLine = rawTwoLineShare;
  if (!near(metrics.raw.twoLineShare, expectedRawTwoLine))
    failures.push(`${label}: metrics.raw.twoLineShare != lineBreaks.rawTwoLineShare`);
  const expectedFocusPerLine = summary.count ? direction.rawFocus / summary.count : 0;
  const expectedLookPerLine = summary.count ? direction.rawGaze / summary.count : 0;
  if (!near(metrics.raw.focusPerLine, expectedFocusPerLine))
    failures.push(`${label}: metrics.raw.focusPerLine != direction.rawFocus / count`);
  if (!near(metrics.raw.lookAnyPerLine, expectedLookPerLine))
    failures.push(`${label}: metrics.raw.lookAnyPerLine != direction.rawGaze / count`);
  for (const name of ["twoLineShare", "focusPerLine", "lookAnyPerLine"]) {
    const expected = {
      twoLineShare: summary.perTextLine?.twoLineShare,
      focusPerLine: summary.focusPerLine,
      lookAnyPerLine: summary.lookAnyPerLine,
    }[name];
    if (!near(metrics.final[name], expected))
      failures.push(`${label}: metrics.final.${name} != summary.${name}`);
  }
  return failures;
};

export const resultFailures = (report) => {
  const failures = [];
  const results = Array.isArray(report.results) ? report.results : [];
  for (const result of results) {
    const label = result.label || "(unnamed scene)";
    if (result.error) failures.push(`${label}: ${result.error}`);
    if (!result.summary) { failures.push(`${label}: summary is missing`); continue; }
    if (!finite(result.summary.count) || result.summary.count < 28)
      failures.push(`${label}: ${result.summary.count} dialogue lines < 28`);
    if (!finite(result.summary.charsTotal) || result.summary.charsTotal < 400)
      failures.push(`${label}: ${result.summary.charsTotal} characters < 400`);
    if (!Array.isArray(result.warnings)) failures.push(`${label}: warnings must be an array`);
    if (!Array.isArray(result.compiled?.commands) || !result.compiled.commands.length)
      failures.push(`${label}: compiled.commands must be a non-empty array`);
    const compiled = result.compiled || {};
    const counts = compiled.counts || {};
    if (!Number.isInteger(compiled.commandCount))
      failures.push(`${label}: compiled.commandCount is not an integer`);
    const countSum = Object.values(counts).reduce((sum, value) => sum + (finite(value) ? value : 0), 0);
    if (countSum !== compiled.commandCount)
      failures.push(`${label}: compiled counts sum ${countSum} != commandCount ${compiled.commandCount}`);
    const countCommands = Object.keys(counts).sort();
    const declared = [...(compiled.commands || [])].sort();
    if (JSON.stringify(countCommands) !== JSON.stringify(declared))
      failures.push(`${label}: compiled.commands != compiled.counts keys`);
    if (counts.Talk !== result.summary.count)
      failures.push(`${label}: summary.count ${result.summary.count} != compiled Talk count ${counts.Talk}`);
    if (!result.direction || !result.direction.linesWithDirection || !result.direction.commandCount)
      failures.push(`${label}: compiled scene has no line direction`);
    if (!near(result.summary.charsMean, result.summary.count ? result.summary.charsTotal / result.summary.count : 0))
      failures.push(`${label}: charsMean != charsTotal / count`);
    for (const [name, key, value] of [
      ["focusPerLine", "focus", result.summary.focus],
      ["motionsPerLine", "motions", result.summary.motions],
      ["lookAnyPerLine", "lookAny", result.summary.lookAny],
      ["zoomPerLine", "zoom", result.summary.zoom],
      ["pedestalPerLine", "pedestal", result.summary.pedestal],
      ["panV2PerLine", "panV2", result.summary.panV2],
      ["sePerLine", "se", result.summary.se],
    ]) {
      const expected = result.summary.count ? value / result.summary.count : 0;
      if (!near(result.summary[name], expected)) failures.push(`${label}: ${name} != ${key} / count`);
    }
    failures.push(...normalizationFailures(result));
  }
  if (Array.isArray(report.failures) && report.failures.length)
    failures.push(`report has ${report.failures.length} failure record(s)`);
  return failures;
};

export const provenanceFailures = (report, {
  now = Date.now(), maxAgeHours = REPORT_MAX_AGE_HOURS, sourceDigest = evalSourceDigest(),
  catalogDigestValue = null,
} = {}) => {
  const failures = [];
  const provenance = report.provenance;
  if (!provenance || provenance.schema !== PROVENANCE_SCHEMA) {
    failures.push(`provenance schema is not ${PROVENANCE_SCHEMA}`);
    return failures;
  }
  const generatedAt = Date.parse(report.generatedAt);
  if (!Number.isFinite(generatedAt)) failures.push("report.generatedAt is not a timestamp");
  else {
    const ageHours = (now - generatedAt) / 3_600_000;
    if (ageHours > maxAgeHours) failures.push(`report is ${ageHours.toFixed(1)} h old; max ${maxAgeHours} h`);
    if (ageHours < -5 / 60) failures.push("report.generatedAt is in the future");
  }
  if (provenance.generatedAt !== report.generatedAt)
    failures.push("provenance.generatedAt != report.generatedAt");
  if (provenance.sceneList?.digest !== sceneListDigest())
    failures.push("provenance.sceneList.digest does not match the fixed scene list");
  if (JSON.stringify(provenance.sceneList?.labels) !== JSON.stringify(EVAL_SCENE_LABELS))
    failures.push("provenance.sceneList.labels does not match the fixed scene list");
  if (provenance.source?.digest !== sourceDigest)
    failures.push("provenance.source.digest does not match the checked-in evaluator source");
  if (typeof provenance.source?.gitHead !== "string" && provenance.source?.gitHead !== null)
    failures.push("provenance.source.gitHead is not a hash or null");
  if (configDigest(report.config) !== provenance.config?.digest)
    failures.push("provenance.config.digest does not match report.config");
  failures.push(...fixedBaselineFailures(report.config));
  if (report.config?.catalogDigest !== provenance.catalog?.digest)
    failures.push("report.config.catalogDigest != provenance.catalog.digest");
  if (report.config?.base !== provenance.catalog?.base ||
      report.config?.language !== provenance.catalog?.language)
    failures.push("provenance.catalog base/language does not match report.config");
  if (report.config?.sceneListDigest !== sceneListDigest())
    failures.push("report.config.sceneListDigest does not match the fixed scene list");
  if (catalogDigestValue !== null && provenance.catalog?.digest !== catalogDigestValue)
    failures.push("provenance.catalog.digest does not match the configured site catalog");
  return failures;
};

export const aggregateFailures = (report) => {
  const failures = [];
  if (!report.aggregate || typeof report.aggregate !== "object") return ["report.aggregate is missing"];
  failures.push(...rangeFailures(report.aggregate));
  const recomputed = aggregate((report.results || []).map((result) => result.summary));
  for (const [name, valueOf] of AGGREGATE_RANGES) {
    const stored = valueOf(report.aggregate), fresh = valueOf(recomputed);
    if (!near(stored, fresh)) failures.push(`aggregate.${name} ${show(stored)} != recomputed ${show(fresh)}`);
  }
  return failures;
};

export const reportFailures = (report, options = {}) => {
  const failures = [];
  failures.push(...sceneCoverageFailures(report));
  failures.push(...provenanceFailures(report, options));
  failures.push(...resultFailures(report));
  failures.push(...aggregateFailures(report));
  const counts = report.counts || {};
  const selected = Array.isArray(report.selected) ? report.selected.length : 0;
  const runs = report.provenance?.runs?.runs ?? 1;
  if (counts.selected !== selected) failures.push("counts.selected != selected scenes");
  if (counts.attempted !== selected * runs) failures.push("counts.attempted != selected * runs");
  if (counts.succeeded !== (report.results || []).length) failures.push("counts.succeeded != results.length");
  if (counts.failed !== (report.failures || []).length) failures.push("counts.failed != failures.length");
  return failures;
};

export const SCENE_LABELS = EVAL_SCENE_LABELS;
export const SCENES = EVAL_SCENES;
