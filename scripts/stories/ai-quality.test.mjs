// The AI quality gate: a named evaluation report must cover the fixed 8 scenes,
// carry fresh provenance that matches the checked-in evaluator and config, keep
// every scene above the hard floors, and stay inside the official aggregate and
// normalization ranges. A missing report skips with an explicit reason.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { aggregate } from "./story-metrics.mjs";
import { EVAL_SCENES, EVAL_SCENE_LABELS } from "./eval-scenes.mjs";
import {
  PROVENANCE_SCHEMA, configDigest, evalSourceDigest, sceneListDigest, sha256,
} from "./eval-provenance.mjs";
import { reportFailures, rangeFailures } from "./eval-gate.mjs";

const reportPath = process.env.OURNOTES_EVAL_REPORT;
const skip = !reportPath ? "OURNOTES_EVAL_REPORT is not set"
  : !existsSync(reportPath) ? `${reportPath} does not exist`
    : false;
const loadReport = () => JSON.parse(readFileSync(reportPath, "utf8"));

const validReport = () => {
  const config = {
    configFile: "config.yaml", siteFormat: "site", base: "stories/10438.json", language: "zh-Hans",
    catalogDigest: "a".repeat(64), pipeline: "staged", temperature: 0.8, targetMinutes: 2,
    maxLines: 36, maxOnStage: 2, repairRounds: 2, translateForTts: false, jsonMode: "auto",
    maxTokens: 16384, timeoutMs: 180000, retries: 2, directorPlan: false, model: "test-model",
    baseUrl: "http://127.0.0.1:5000/v1", apiKey: "unset", systemPromptChars: 0,
    systemPromptDigest: sha256(""), personas: [], sceneListDigest: sceneListDigest(),
  };
  const generatedAt = new Date().toISOString();
  const counts = { DoF: 1, Focus: 14, Look: 10, LookTarget: 5, Motion: 36, PanV2: 3, Pedestal: 4,
                   Se: 3, Talk: 36, Zoom: 4 };
  const commands = Object.keys(counts).sort();
  const commandCount = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const twoLine = 14 / 36;
  const results = EVAL_SCENES.map((scene, index) => ({
    label: scene.label,
    scene: { index: index + 1, label: scene.label, logline: scene.logline },
    run: 1, error: null, warnings: [],
    summary: {
      count: 36, charsTotal: 480, charsMean: 480 / 36,
      perTextLine: { twoLineShare: twoLine, shortShare: 0.16 }, soloRunShare: 0.6,
      focus: 14, motions: 36, lookAny: 15, zoom: 4, pedestal: 4, panV2: 3, se: 3,
      focusPerLine: 14 / 36, motionsPerLine: 1, lookAnyPerLine: 15 / 36,
      zoomPerLine: 4 / 36, pedestalPerLine: 4 / 36, panV2PerLine: 3 / 36, sePerLine: 3 / 36,
    },
    compiled: { commandCount, commands, counts },
    direction: { lineCount: 36, linesWithDirection: 36, commandCount: 100 },
    normalization: {
      pipeline: "staged",
      lineBreaks: { total: 36, rawTwoLine: 14, removed: 0, added: 0, changedShare: 0,
                    rawTwoLineShare: twoLine },
      direction: { lineCount: 36, rawFocus: 14, focusPruned: 0, finalFocus: 14,
                   rawGaze: 15, gazePruned: 0, finalGaze: 15 },
      names: { repaired: 0, dropped: 0 },
    },
    metrics: {
      raw: { twoLineShare: twoLine, focusPerLine: 14 / 36, lookAnyPerLine: 15 / 36 },
      final: { twoLineShare: twoLine, focusPerLine: 14 / 36, lookAnyPerLine: 15 / 36 },
    },
  }));
  return {
    generatedAt,
    run: "test",
    scenes: EVAL_SCENES.map((scene, index) => ({ index: index + 1, ...scene })),
    selected: EVAL_SCENE_LABELS,
    config,
    provenance: {
      schema: PROVENANCE_SCHEMA, generatedAt,
      sceneList: { digest: sceneListDigest(), labels: EVAL_SCENE_LABELS },
      source: { digest: evalSourceDigest(), gitHead: null },
      catalog: { digest: config.catalogDigest, base: config.base, language: config.language },
      config: { digest: configDigest(config) },
      runs: { name: "test", runs: 1, selected: EVAL_SCENE_LABELS },
    },
    counts: { selected: 8, attempted: 8, succeeded: 8, failed: 0 },
    results,
    aggregate: aggregate(results.map((result) => result.summary)),
    failures: [],
  };
};

test("the real evaluation report passes the provenance, scene and metric gate", { skip }, () => {
  const report = loadReport();
  assert.deepEqual(reportFailures(report), []);
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

test("a valid synthetic report passes; duplicate, missing and stale reports fail", () => {
  const report = validReport();
  assert.deepEqual(reportFailures(report), []);
  const duplicate = JSON.parse(JSON.stringify(report));
  duplicate.results[1].label = duplicate.results[0].label;
  assert.ok(reportFailures(duplicate).some((failure) => /duplicate labels/.test(failure)));

  const missing = JSON.parse(JSON.stringify(report));
  missing.results.pop();
  missing.counts.succeeded = missing.results.length;
  assert.ok(reportFailures(missing).some((failure) => /missing scenes/.test(failure)));

  const stale = JSON.parse(JSON.stringify(report));
  stale.generatedAt = new Date(Date.now() - 100 * 3_600_000).toISOString();
  stale.provenance.generatedAt = stale.generatedAt;
  assert.ok(reportFailures(stale).some((failure) => /old; max/.test(failure)));
});

test("tampered provenance, config and aggregate fields fail", () => {
  const report = validReport();
  const source = JSON.parse(JSON.stringify(report));
  source.provenance.source.digest = "0".repeat(64);
  assert.ok(reportFailures(source).some((failure) => /source.digest/.test(failure)));

  const scene = JSON.parse(JSON.stringify(report));
  scene.provenance.sceneList.digest = "0".repeat(64);
  assert.ok(reportFailures(scene).some((failure) => /sceneList.digest/.test(failure)));

  const config = JSON.parse(JSON.stringify(report));
  config.config.model = "other-model";
  assert.ok(reportFailures(config).some((failure) => /config.digest/.test(failure)));

  const changedAggregate = JSON.parse(JSON.stringify(report));
  changedAggregate.aggregate.focusPerLine = 0.9;
  assert.ok(reportFailures(changedAggregate).some((failure) => /focusPerLine/.test(failure)));
});

test("a scene with inconsistent compiled counts or missing normalization fails", () => {
  const report = validReport();
  const counts = JSON.parse(JSON.stringify(report));
  counts.results[0].compiled.counts.Talk = 35;
  assert.ok(reportFailures(counts).some((failure) => /Talk count/.test(failure)));

  const normalization = JSON.parse(JSON.stringify(report));
  delete normalization.results[0].normalization;
  assert.ok(reportFailures(normalization).some((failure) => /normalization is missing/.test(failure)));

  const mutatedNormalization = JSON.parse(JSON.stringify(report));
  mutatedNormalization.results[0].normalization.lineBreaks.added = 20;
  assert.ok(reportFailures(mutatedNormalization).some((failure) => /lineBreakChangedShare/.test(failure)));
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
