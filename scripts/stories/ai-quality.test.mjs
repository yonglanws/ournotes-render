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

test("the aggregate generation distributions stay inside the official ranges", { skip }, () => {
  const report = loadReport();
  const results = report.results;
  const agg = aggregate(results.map((result) => result.summary));
  const perLine = (key) => (agg.count ? agg[key] / agg.count : 0);
  const checks = [
    ["charsMean", agg.charsMean, 12, 19],
    ["twoLineShare", agg.perTextLine?.twoLineShare, 0.25, 0.50],
    ["shortShare", agg.perTextLine?.shortShare, 0.12, 0.30],
    ["soloRunShare", agg.soloRunShare, 0.58, 0.82],
    ["focusPerLine", perLine("focus"), 0.30, 0.50],
    ["motionsPerLine", perLine("motions"), 1.0, 1.5],
    ["lookAnyPerLine", perLine("lookAny"), 0.20, 0.42],
    ["zoomPerLine", perLine("zoom"), 0.03, 0.16],
    ["pedestalPerLine", perLine("pedestal"), 0.04, 0.15],
    ["panV2PerLine", perLine("panV2"), 0.05, 0.18],
    ["sePerLine", perLine("se"), 0.04, 0.16],
  ];
  for (const [name, value, min, max] of checks) {
    assert.ok(typeof value === "number" && Number.isFinite(value), `${name} is not a finite number`);
    assert.ok(BETWEEN(value, min, max),
              `${name} ${show(value)} is outside ${min}..${max} (${results.length} scenes)`);
  }
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
