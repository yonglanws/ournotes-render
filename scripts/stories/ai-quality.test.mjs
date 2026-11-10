// The AI quality gate: one named evaluation run (OURNOTES_EVAL_REPORT) must
// keep every scene above the hard line/character floors and the aggregate
// distributions inside the checked official ranges. A missing report skips with
// an explicit reason instead of passing silently.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { aggregate } from "./story-metrics.mjs";

const reportPath = process.env.OURNOTES_EVAL_REPORT;
const skip = !reportPath ? "OURNOTES_EVAL_REPORT is not set"
  : !existsSync(reportPath) ? `${reportPath} does not exist`
    : false;
const loadReport = () => JSON.parse(readFileSync(reportPath, "utf8"));

const BETWEEN = (value, min, max) => value >= min && value <= max;
const show = (value, digits = 3) => (typeof value === "number" ? value.toFixed(digits) : String(value));

// The gate reads the report's named aggregate fields, not a ratio recomputed
// from raw counts: a missing or stale field must fail instead of silently
// falling back to another denominator.
const AGGREGATE_RANGES = [
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
];

const rangeFailures = (aggregateValues) => AGGREGATE_RANGES.flatMap(([name, valueOf, min, max]) => {
  const value = valueOf(aggregateValues || {});
  if (typeof value !== "number" || !Number.isFinite(value)) return [`${name} is not a finite number`];
  if (!BETWEEN(value, min, max)) return [`${name} ${show(value)} is outside ${min}..${max}`];
  return [];
});

test("the evaluation report has at least six complete successful scenes", { skip }, () => {
  const report = loadReport();
  assert.ok(Array.isArray(report.results), "report.results must be an array");
  assert.ok(report.results.length >= 6, `expected at least 6 successful scenes, got ${report.results.length}`);
  for (const result of report.results) {
    const where = result.label || result.prompt || "(unnamed scene)";
    assert.ok(!result.error, `${where}: ${result.error}`);
    assert.ok(result.summary, `${where}: summary is missing`);
    assert.ok(result.summary.count >= 28, `${where}: ${result.summary.count} dialogue lines < 28`);
    assert.ok(result.summary.charsTotal >= 400, `${where}: ${result.summary.charsTotal} characters < 400`);
    assert.ok(Array.isArray(result.warnings), `${where}: warnings must be an array`);
    assert.ok(result.compiled && Array.isArray(result.compiled.commands),
              `${where}: compiled.commands must be an array`);
    assert.ok(result.compiled.commands.length > 0, `${where}: compiled no commands`);
  }
});

test("the named aggregate generation distributions stay inside the official ranges", { skip }, () => {
  const report = loadReport();
  assert.ok(report.aggregate && typeof report.aggregate === "object", "report.aggregate is missing");
  assert.deepEqual(rangeFailures(report.aggregate), []);
  // The stored aggregate must be the successful-scene aggregate, not a stale or
  // hand-edited object that happens to sit inside the ranges.
  const recomputed = aggregate(report.results.map((result) => result.summary));
  for (const [name, valueOf] of AGGREGATE_RANGES) {
    const stored = valueOf(report.aggregate), fresh = valueOf(recomputed);
    assert.ok(typeof stored === "number" && Number.isFinite(stored), `${name} is not stored in report.aggregate`);
    assert.ok(Math.abs(stored - fresh) < 1e-9,
              `${name} stored ${stored} does not match the successful-scene aggregate ${fresh}`);
  }
});

test("the aggregate range checker rejects a mutated named field", () => {
  const good = {
    charsMean: 14, perTextLine: { twoLineShare: 0.39, shortShare: 0.16 }, soloRunShare: 0.6,
    focusPerLine: 0.42, motionsPerLine: 1.03, lookAnyPerLine: 0.32, zoomPerLine: 0.12,
    pedestalPerLine: 0.09, panV2PerLine: 0.07, sePerLine: 0.08,
  };
  assert.deepEqual(rangeFailures(good), []);
  assert.ok(rangeFailures({ ...good, focusPerLine: 0.9 }).some((failure) => failure.includes("focusPerLine")));
  assert.ok(rangeFailures({ ...good, motionsPerLine: undefined }).some((failure) => failure.includes("motionsPerLine")));
});

test("every new official command family is compiled at least once", { skip }, () => {
  const report = loadReport();
  const counts = {};
  for (const result of report.results) {
    for (const [cmd, count] of Object.entries(result.compiled?.counts || {})) {
      if (Number.isFinite(count)) counts[cmd] = (counts[cmd] || 0) + count;
    }
  }
  for (const cmd of ["Zoom", "Pedestal", "PanV2", "DoF", "Look", "Se"]) {
    assert.ok((counts[cmd] || 0) > 0, `${cmd} was compiled by no scene; counts=${JSON.stringify(counts)}`);
  }
});
