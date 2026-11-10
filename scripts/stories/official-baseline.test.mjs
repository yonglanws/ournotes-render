import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  discoverOfficialCorpus, episodeText, episodeToLines, rawCommandDistributions,
  readEpisodeAsset, tailAttribution,
} from "./official-corpus.mjs";
import {
  aggregate, percentile, summarize, summarizeTailCounts, windowsOf, withTailCounts,
} from "./story-metrics.mjs";
import {
  BASELINE_TARGETS, OFFICIAL_TARGETS, buildBaseline,
  compareBaselineToReport, corpusConfigFromEnv, corpusEvidence, canonicalReportDigest,
} from "./official-baseline.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mini-official-episode.json", import.meta.url)));

const tempSite = () => {
  const temp = mkdtempSync(path.join(tmpdir(), "official-corpus-"));
  const siteRoot = path.join(temp, "site");
  const assetsRoot = path.join(siteRoot, "assets");
  const stories = path.join(siteRoot, "stories");
  const sampleRoot = path.join(temp, "sample");
  for (const dir of [assetsRoot, stories, sampleRoot]) mkdirSync(dir, { recursive: true });
  return { temp, siteRoot, assetsRoot, stories, sampleRoot };
};

test("official adapter separates text Talk rows from blank Talk rows", () => {
  const result = episodeToLines(fixture, { id: "fixture", language: "zh-Hans" });
  assert.equal(result.talkRows, 3);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].chars, 8);
  assert.equal(result.lines[0].renderedLines, 1);
});

test("metrics attribute pending camera and acting events to the next text Talk", () => {
  const { lines } = episodeToLines(fixture, { id: "fixture", language: "zh-Hans" });
  const totals = summarize(lines);
  assert.equal(totals.count, 2);
  assert.equal(totals.motions, 2);
  assert.equal(totals.lookAny, 2);
  assert.equal(totals.zoom, 1);
  assert.equal(totals.pedestal, 1);
  assert.equal(totals.panV2, 1);
  assert.equal(totals.dof, 1);
  assert.equal(totals.se, 1);
  assert.equal(totals.perTextLine.noMotionShare, 0);
  assert.equal(totals.perTextLine.duoShare, 0);
});

test("ignored events count for the next line while trailing events stay separate", () => {
  const episode = { commands: [
    { i: 0, cmd: "Motion", raw: 21, IgnoreData: 1, TargetName: "anon" },
    { i: 1, cmd: "Talk", raw: 2, TargetName: "anon", AdvTextID: "ignored-1",
      lines: { "zh-Hans": "忽略状态但计数" } },
    { i: 2, cmd: "Se", raw: 31, Parameter1: "tail" },
  ] };
  const { lines } = episodeToLines(episode, { id: "ignored", language: "zh-Hans" });
  const tail = tailAttribution(episode, { id: "ignored", language: "zh-Hans" });
  assert.equal(lines[0].motions, 1);
  assert.equal(lines[0].se, 0);
  assert.equal(summarizeTailCounts([tail]).se, 1);
  assert.equal(withTailCounts(summarize(lines), [tail]).se, 1);
  const raw = rawCommandDistributions(episode, { language: "zh-Hans" });
  assert.equal(raw.talkRows, 1);
  assert.equal(raw.textLines, 1);
  assert.equal(raw.noMotionLines, 0);
});

test("slot transforms without TargetName do not create phantom on-stage characters", () => {
  const episode = { commands: [
    { i: 0, cmd: "Character", raw: 23, TargetName: "anon" },
    { i: 1, cmd: "Character", raw: 23, TargetName: "tomori" },
    { i: 2, cmd: "In", raw: 0, TargetName: "anon", PositionType: 3 },
    { i: 3, cmd: "In", raw: 0, TargetName: "tomori", PositionType: 7 },
    { i: 4, cmd: "MoveToDirection", raw: 64, PositionType: 3, Parameter1: "0.2" },
    { i: 5, cmd: "Talk", raw: 2, TargetName: "anon", AdvTextID: "slot-1",
      lines: { "zh-Hans": "两个人都在场" } },
  ] };
  const { lines } = episodeToLines(episode, { id: "slots", language: "zh-Hans" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].onStage, 2);
  assert.equal(summarize(lines).perTextLine.duoShare, 1);
});

test("speaker runs reset at episode boundaries", () => {
  const lines = [
    { id: "a", speaker: "anon", body: "甲", chars: 1, renderedLines: 1, segmentChars: [1] },
    { id: "b", speaker: "anon", body: "乙", chars: 1, renderedLines: 1, segmentChars: [1] },
  ];
  const totals = summarize(lines);
  assert.equal(totals.speakerRunMean, 1);
  assert.equal(totals.soloRunShare, 1);
  assert.equal(totals.perTextLine.shortShare, 0);
});

test("shared language resolver is used by adapters, tails and raw distributions", () => {
  const episode = {
    text: { j1: { japanese: "日本語" } }, sounds: {}, cuesheets: {}, videos: {}, resources: [],
    commands: [
      { i: 0, cmd: "Talk", raw: 2, AdvTextID: "j1", lines: { japanese: "日本語" } },
      { i: 1, cmd: "Se", raw: 31 },
    ],
  };
  assert.equal(episodeText(episode, episode.commands[0], "ja"), "日本語");
  assert.equal(episodeToLines(episode, { id: "ja", language: "ja" }).lines[0].body, "日本語");
  assert.equal(rawCommandDistributions(episode, { language: "ja" }).textLines, 1);
  assert.equal(tailAttribution(episode, { id: "ja", language: "ja" }).se, 1);
  const built = buildBaseline({
    siteRoot: "D:/unused-site", sampleRoot: "D:/unused-sample",
    assetsRoot: "D:/unused-assets", language: "ja", corpus: [{
      id: "10438",
      episode,
      provenance: { file: "fixture:ja.json", sha256: "x".repeat(64), bytes: Buffer.from("{}") },
    }],
  });
  assert.equal(built.totals.textLines, 1);
  assert.equal(built.episodes[0].textLines, 1);
});

test("corpus discovery rejects parent traversal outside provided roots", () => {
  const { temp, siteRoot, assetsRoot, stories, sampleRoot } = tempSite();
  try {
    writeFileSync(path.join(siteRoot, "secret.json"), JSON.stringify({ commands: [] }));
    writeFileSync(path.join(stories, "10438.json"), JSON.stringify({
      files: { "episode.json": { asset: "assets/../secret.json" } },
    }));
    assert.deepEqual(discoverOfficialCorpus({ siteRoot, sampleRoot, assetsRoot }), []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("malformed site manifests produce structured failures without aborting discovery", () => {
  const { temp, siteRoot, assetsRoot, stories, sampleRoot } = tempSite();
  try {
    writeFileSync(path.join(assetsRoot, "ep.gz"), zlib.gzipSync(JSON.stringify({ commands: [] })));
    writeFileSync(path.join(stories, "10438.json"), "{not-json");
    writeFileSync(path.join(stories, "10450.json"), JSON.stringify({
      files: { "episode.json": { asset: "assets/ep.gz" } },
    }));
    const found = discoverOfficialCorpus({ siteRoot, sampleRoot, assetsRoot });
    assert.equal(found.length, 1);
    assert.equal(found.failures.length, 1);
    assert.equal(found.failures[0].id, "10438");
    assert.equal(found.failures[0].kind, "manifest");
    assert.match(found.failures[0].error, /JSON|Unexpected|Expected/i);
    const built = buildBaseline({ siteRoot, sampleRoot, assetsRoot });
    assert.ok(built.failures.some((f) => f.id === "10438" && f.kind === "manifest"));
    const injected = [...found];
    Object.defineProperty(injected, "failures", { value: found.failures, enumerable: false });
    const injectedBuilt = buildBaseline({ siteRoot, sampleRoot, assetsRoot, corpus: injected });
    assert.ok(injectedBuilt.failures.some((f) => f.id === "10438" && f.kind === "manifest"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("discovery rejects symlinked assets and direct sample paths outside real roots", () => {
  const { temp, siteRoot, assetsRoot, stories, sampleRoot } = tempSite();
  try {
    const outside = path.join(temp, "outside.json");
    writeFileSync(outside, JSON.stringify({ commands: [] }));
    writeFileSync(path.join(assetsRoot, "ep.json"), zlib.gzipSync(JSON.stringify({ commands: [] })));
    const linked = path.join(assetsRoot, "linked.json");
    symlinkSync(outside, linked, "file");
    writeFileSync(path.join(stories, "10438.json"), JSON.stringify({
      files: { "episode.json": { asset: "assets/linked.json" } },
    }));
    const directDir = path.join(sampleRoot, "10450");
    mkdirSync(directDir, { recursive: true });
    const outsideSample = path.join(sampleRoot, "10450", "episode.json");
    rmSync(outsideSample, { force: true });
    symlinkSync(outside, outsideSample, "file");
    const found = discoverOfficialCorpus({ siteRoot, sampleRoot, assetsRoot });
    assert.deepEqual([...found].map((e) => e.id), []);
    assert.equal(found.failures.some((f) => f.kind === "symlink"), true);
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("discovery rejects symlinked allowed roots", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "official-corpus-"));
  try {
    const real = path.join(temp, "real-site");
    const stories = path.join(real, "stories");
    const assetsRoot = path.join(real, "assets");
    const sampleRoot = path.join(temp, "sample");
    for (const dir of [stories, assetsRoot, sampleRoot]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(assetsRoot, "ep.json"), JSON.stringify({ commands: [] }));
    writeFileSync(path.join(stories, "10438.json"), JSON.stringify({
      files: { "episode.json": { asset: "assets/ep.json" } },
    }));
    const link = path.join(temp, "link-site");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    const found = discoverOfficialCorpus({
      siteRoot: link, assetsRoot: path.join(link, "assets"), sampleRoot,
    });
    assert.deepEqual([...found], []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("corpus discovery accepts string manifests, compressed assets and real language keys", () => {
  const { temp, siteRoot, assetsRoot, stories, sampleRoot } = tempSite();
  try {
    const episode = { commands: [{ i: 0, cmd: "Talk", raw: 2, AdvTextID: "t1",
      lines: { simplifiedChinese: "真实剧本" } }] };
    writeFileSync(path.join(assetsRoot, "ep.gz"), zlib.gzipSync(JSON.stringify(episode)));
    writeFileSync(path.join(assetsRoot, "ep.br"), zlib.brotliCompressSync(JSON.stringify(episode)));
    writeFileSync(path.join(stories, "10438.json"), JSON.stringify({
      files: { "episode.json": { asset: "assets/ep.gz" } },
    }));
    writeFileSync(path.join(stories, "10450.json"), JSON.stringify({
      files: { "episode.json": "assets/ep.br" },
    }));
    const found = discoverOfficialCorpus({ siteRoot, sampleRoot, assetsRoot });
    assert.deepEqual([...found].map((e) => e.id), ["10438", "10450"]);
    for (const { id, file } of found) {
      const lines = episodeToLines(readEpisodeAsset(file), { id, language: "zh-Hans" }).lines;
      assert.equal(lines.length, 1);
      assert.equal(lines[0].body, "真实剧本");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("aggregate recursively averages nested rate objects without NaN", () => {
  const a = summarize([
    { id: "a", speaker: "x", body: "甲", chars: 2, renderedLines: 1, segmentChars: [2] },
  ]);
  const b = summarize([
    { id: "b", speaker: "y", body: "乙？", chars: 2, renderedLines: 1, segmentChars: [2] },
  ]);
  const result = aggregate([a, b]);
  assert.equal(result.count, 1);
  assert.equal(result.perTextLine.twoLineShare, 0);
  assert.equal(result.perTextLine.questionShare, 0.5);
  assert.equal(result.perTalkRow.duoShare, 0);
  assert.ok(Object.values(result.perTextLine).every(Number.isFinite));
  assert.ok(Object.values(result.perTalkRow).every(Number.isFinite));
});

test("OFFICIAL_TARGETS is a frozen flat adapter derived from one checked source", () => {
  assert.equal(Object.isFrozen(OFFICIAL_TARGETS), true);
  const expectedKeys = [
    "lineCharsMean", "lineCharsMedian", "lineCharsP90", "segmentCharsMean",
    "twoLineShare", "threeLineShare", "shortShare", "ellipsisShare",
    "questionShare", "exclaimShare", "speakerRunMean", "soloRunShare",
    "focusPerTalkRow", "focusPerTextLine", "motionsPerTextLine",
    "lookAnyPerTextLine", "zoomPerTextLine", "pedestalPerTextLine",
    "trackPerTextLine", "dofPerTextLine", "panV2PerTextLine", "sePerTextLine",
    "bgmPerEpisode", "noMotionShare", "lookLineShare", "distance2Share",
    "distance3Share", "distance4Share", "duoShare", "effectiveDuoShare",
    "closeRunOneOrTwoShare", "twoMotionShare", "standaloneExpressionPerEpisode",
    "textLinesPerEpisodeMean", "textLinesPerEpisodeMin", "textLinesPerEpisodeMax",
    "commandsPerEpisodeMean", "linesPerMinute", "charsPerMinute",
    "focusDurationDefault", "zoomDurationDefault", "motionFadeInDefault",
    "zoomDefault", "staticLineBudget", "closeUps", "motionBudget",
    "focusChanges", "lookAtBudget",
  ];
  assert.deepEqual(Object.keys(OFFICIAL_TARGETS).sort(), [...expectedKeys].sort());
  assert.equal(OFFICIAL_TARGETS.lineCharsMean, BASELINE_TARGETS.distributions.charsMean);
  assert.equal(OFFICIAL_TARGETS.twoLineShare, BASELINE_TARGETS.distributions.perTextLineTwoLineShare);
  assert.equal(OFFICIAL_TARGETS.shortShare, BASELINE_TARGETS.distributions.perTextLineShortShare);
  assert.equal(OFFICIAL_TARGETS.focusPerTalkRow, 0.397);
  assert.equal(OFFICIAL_TARGETS.focusPerTextLine,
    Number((BASELINE_TARGETS.totals.focus / BASELINE_TARGETS.totals.textLines).toFixed(3)));
  assert.equal(OFFICIAL_TARGETS.motionsPerTextLine,
    Number((BASELINE_TARGETS.totals.motion / BASELINE_TARGETS.totals.textLines).toFixed(3)));
  assert.equal(OFFICIAL_TARGETS.lookAnyPerTextLine,
    Number((BASELINE_TARGETS.totals.lookRows / BASELINE_TARGETS.totals.textLines).toFixed(3)));
  assert.equal(OFFICIAL_TARGETS.textLinesPerEpisodeMean,
    BASELINE_TARGETS.totals.textLines / BASELINE_TARGETS.totals.episodes);
  assert.equal(OFFICIAL_TARGETS.duoShare, BASELINE_TARGETS.distributions.perTalkRowDuoShare);
  assert.equal(OFFICIAL_TARGETS.duoShare, 0.7623);
  assert.equal(OFFICIAL_TARGETS.effectiveDuoShare,
    BASELINE_TARGETS.distributions.perTalkRowEffectiveDuoShare);
  assert.equal(OFFICIAL_TARGETS.effectiveDuoShare, 0.7654);
  assert.equal(OFFICIAL_TARGETS.closeUps, 10);
  assert.equal(OFFICIAL_TARGETS.closeRunOneOrTwoShare, 0.7785);
  assert.equal(OFFICIAL_TARGETS.twoMotionShare, 0.4473);
  assert.equal(OFFICIAL_TARGETS.standaloneExpressionPerEpisode, 0.0667);
  assert.equal(OFFICIAL_TARGETS.closeRunOneOrTwoShare,
    BASELINE_TARGETS.distributions.closeRunOneOrTwoShare);
  assert.equal(OFFICIAL_TARGETS.twoMotionShare, BASELINE_TARGETS.distributions.twoMotionShare);
  assert.equal(OFFICIAL_TARGETS.standaloneExpressionPerEpisode,
    BASELINE_TARGETS.distributions.standaloneExpressionPerEpisode);
  const exactBudgets = {
    staticLineBudget: 47, motionBudget: 61, focusChanges: 19, lookAtBudget: 15,
    linesPerMinute: 18, charsPerMinute: 240,
    focusDurationDefault: 1.5, zoomDurationDefault: 1.5,
    motionFadeInDefault: -1, zoomDefault: 1.2,
  };
  for (const [key, expected] of Object.entries(exactBudgets)) {
    assert.equal(OFFICIAL_TARGETS[key], expected, `OFFICIAL_TARGETS.${key}`);
  }
  assert.equal(OFFICIAL_TARGETS.closeUps,
    Math.max(1, Math.round(47 * BASELINE_TARGETS.distributions.perTalkRowDistance4Share)));
  for (const value of Object.values(OFFICIAL_TARGETS)) {
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value));
  }
});

test("shared metrics expose percentiles, aggregation and guarded full windows", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([], 0.9), 0);
  assert.deepEqual(aggregate([{ count: 2 }, { count: 4 }]), { count: 3 });
  assert.deepEqual(windowsOf([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4]]);
  for (const size of [0, -1, NaN, 1.5, Infinity]) {
    assert.throws(() => windowsOf([1, 2], size), RangeError, `size ${size}`);
  }
});

const lab = process.env.OURNOTES_AI_LAB;
const report = lab ? path.join(lab, "official-baseline.json") : "";
const config = corpusConfigFromEnv(process.env);
const realCorpus = corpusEvidence(config);
const corpusSkip = !realCorpus
  ? "set OURNOTES_OFFICIAL_SITE, OURNOTES_OFFICIAL_ASSETS and OURNOTES_OFFICIAL_SAMPLE to the real corpus" : false;
const reportSkip = corpusSkip || !report || !existsSync(report)
  ? "real corpus or external official-baseline.json is unavailable" : false;

test("external report comparison rejects stale or fabricated evidence", { skip: corpusSkip }, () => {
  const recomputed = buildBaseline(config);
  const stale = JSON.parse(JSON.stringify(recomputed));
  stale.provenance.digest = "0".repeat(64);
  stale.totals.talkRows = 999;
  const mismatches = compareBaselineToReport(recomputed, stale);
  assert.match(mismatches.join(" | "), /provenance\.digest mismatch/);
  assert.match(mismatches.join(" | "), /report totals\.talkRows mismatch/);
});

test("canonical report digest rejects tampering with every material report field", { skip: corpusSkip }, () => {
  const recomputed = buildBaseline(config);
  const mutate = (fn) => {
    const forged = JSON.parse(JSON.stringify(recomputed));
    fn(forged);
    forged.provenance.digest = canonicalReportDigest(forged);
    return compareBaselineToReport(recomputed, forged);
  };
  const cases = [
    ["all.corpus", (r) => { r.all.corpus.motions += 1; }],
    ["all.perEpisodeMean", (r) => { r.all.perEpisodeMean.count += 1; }],
    ["all.rawDistributions", (r) => { r.all.rawDistributions.noMotionLines += 1; }],
    ["all.tailCounts", (r) => { r.all.tailCounts.se += 1; }],
    ["nested rate object", (r) => { r.all.corpus.perTextLine.shortShare += 0.1; }],
    ["totals.commandHistogram", (r) => { r.totals.commandHistogram.Motion += 1; }],
    ["commandHistogram", (r) => { r.commandHistogram.Motion += 1; }],
    ["expectations", (r) => { r.expectations.totals.motion += 1; }],
    ["failures", (r) => { r.failures.push({ error: "forged" }); }],
    ["generatedFrom", (r) => { r.generatedFrom.siteRoot = "forged"; }],
    ["per-episode summary", (r) => { r.episodes[0].summary.count += 1; }],
    ["per-episode provenance", (r) => { r.episodes[0].provenance.bytes += 1; }],
    ["provenance metadata", (r) => { r.provenance.episodeCount += 1; }],
    ["omitted all", (r) => { delete r.all; }],
  ];
  for (const [name, tamper] of cases) {
    const mismatches = mutate(tamper);
    assert.notDeepEqual(mismatches, [], `tampered ${name} must be rejected`);
  }
  const unchanged = JSON.parse(JSON.stringify(recomputed));
  unchanged.generatedAt = "1999-01-01T00:00:00.000Z";
  unchanged.provenance.digest = canonicalReportDigest(unchanged);
  assert.deepEqual(compareBaselineToReport(recomputed, unchanged), [],
    "volatile generatedAt may change without invalidating provenance");
});

test("30-episode corpus recomputes the checked official totals", { skip: corpusSkip }, () => {
  const recomputed = buildBaseline(config);
  assert.deepEqual(recomputed.failures, []);
  assert.equal(recomputed.episodes.length, BASELINE_TARGETS.totals.episodes);
  assert.deepEqual([...recomputed.corpusIds].sort(), [...BASELINE_TARGETS.corpusIds].sort());
  for (const [key, expected] of Object.entries(BASELINE_TARGETS.totals)) {
    assert.equal(recomputed.totals[key], expected, `totals.${key}`);
  }
  for (const episode of recomputed.episodes) {
    assert.match(episode.file, /\.json(?:\.gz|\.br)?$/);
    assert.match(episode.sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof episode.provenance.bytes, "number");
    assert.equal(episode.provenance.sha256, episode.sha256);
  }
  assert.match(recomputed.provenance.digest, /^[a-f0-9]{64}$/);
  assert.equal(recomputed.schema, "official-baseline/2");
  assert.equal(recomputed.version, 2);
});

test("30-episode corpus reproduces the official distribution metrics", { skip: corpusSkip }, () => {
  const recomputed = buildBaseline(config);
  const all = recomputed.all.corpus;
  for (const [key, expected] of Object.entries(BASELINE_TARGETS.distributions)) {
    const actual = typeof expected === "number" && !Number.isInteger(expected)
      ? Number(all[key].toFixed(4)) : all[key];
    assert.equal(actual, expected, `all.corpus.${key}`);
  }
  assert.equal(Number(all.standaloneExpressionPerEpisode.toFixed(4)),
    BASELINE_TARGETS.distributions.standaloneExpressionPerEpisode);
  assert.equal(Number((recomputed.totals.expression / recomputed.totals.episodes).toFixed(4)),
    BASELINE_TARGETS.distributions.standaloneExpressionPerEpisode);
  for (const [key, expected] of Object.entries(BASELINE_TARGETS.tailCounts)) {
    assert.equal(recomputed.all.tailCounts[key] || 0, expected, `all.tailCounts.${key}`);
  }
  assert.equal(recomputed.all.rawDistributions.talkRows, BASELINE_TARGETS.rawDistributions.talkRows);
  assert.equal(recomputed.all.rawDistributions.textLines, BASELINE_TARGETS.rawDistributions.textLines);
  assert.equal(recomputed.all.rawDistributions.noMotionLines, BASELINE_TARGETS.rawDistributions.noMotionLines);
});

test("raw close-up runs and performance-action lines are recomputed from the corpus", { skip: corpusSkip }, () => {
  const recomputed = buildBaseline(config);
  const all = recomputed.all.corpus;
  assert.equal(all.closeRunCount, 149);
  assert.equal(all.closeRunOneOrTwo, 116);
  assert.equal(Number(all.closeRunOneOrTwoShare.toFixed(4)), 0.7785);
  assert.equal(all.twoActionLines, 518);
  assert.equal(Number(all.twoMotionShare.toFixed(4)), 0.4473);
  assert.equal(all.attributedMotionExpressions, 1497);
  assert.equal(all.motionExpressions, 1503);
  assert.deepEqual(recomputed.all.closeRuns, {
    total: 149, oneOrTwo: 116, share: 116 / 149,
  });
});

test("external baseline report is bound to freshly recomputed corpus evidence", { skip: reportSkip }, () => {
  const data = JSON.parse(readFileSync(report, "utf8"));
  const recomputed = buildBaseline(config);
  assert.deepEqual(compareBaselineToReport(recomputed, data), []);
  assert.equal(data.schema, "official-baseline/2");
  assert.equal(data.version, 2);
  assert.equal(data.provenance.digest, recomputed.provenance.digest);
  assert.deepEqual(data.corpusIds, recomputed.corpusIds);
  assert.deepEqual(data.failures, []);
  assert.equal(data.episodes.length, BASELINE_TARGETS.totals.episodes);
  assert.equal(data.all.corpus.count, BASELINE_TARGETS.distributions.count);
  for (const [key, expected] of Object.entries(BASELINE_TARGETS.totals)) {
    assert.equal(data.totals[key], expected, `report totals.${key}`);
  }
});
