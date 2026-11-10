import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { discoverOfficialCorpus, episodeToLines, rawCommandDistributions, readEpisodeAsset, tailAttribution } from "./official-corpus.mjs";
import { aggregate, percentile, summarize, summarizeTailCounts, windowsOf, withTailCounts } from "./story-metrics.mjs";
import { BASELINE_EXPECTATIONS } from "./official-baseline.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mini-official-episode.json", import.meta.url)));

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
  assert.equal(summarize(lines).duoShare, 1);
});

test("speaker runs reset at episode boundaries", () => {
  const lines = [
    { id: "a", speaker: "anon", body: "甲", chars: 1, renderedLines: 1, segmentChars: [1] },
    { id: "b", speaker: "anon", body: "乙", chars: 1, renderedLines: 1, segmentChars: [1] },
  ];
  const totals = summarize(lines);
  assert.equal(totals.speakerRunMean, 1);
  assert.equal(totals.soloRunShare, 1);
});

test("corpus discovery rejects parent traversal outside provided roots", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "official-corpus-"));
  try {
    const siteRoot = path.join(temp, "site");
    const assetsRoot = path.join(siteRoot, "assets");
    const stories = path.join(siteRoot, "stories");
    const sampleRoot = path.join(temp, "sample");
    for (const dir of [assetsRoot, stories, sampleRoot]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(siteRoot, "secret.json"), JSON.stringify({ commands: [] }));
    writeFileSync(path.join(stories, "10438.json"), JSON.stringify({
      files: { "episode.json": { asset: "assets/../secret.json" } },
    }));
    const found = discoverOfficialCorpus({ siteRoot, sampleRoot, assetsRoot });
    assert.deepEqual(found, []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("corpus discovery accepts string manifests, compressed assets and real language keys", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "official-corpus-"));
  try {
    const siteRoot = path.join(temp, "site");
    const assetsRoot = path.join(siteRoot, "assets");
    const stories = path.join(siteRoot, "stories");
    const sampleRoot = path.join(temp, "sample");
    for (const dir of [assetsRoot, stories, sampleRoot]) mkdirSync(dir, { recursive: true });
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
    assert.deepEqual(found.map((e) => e.id), ["10438", "10450"]);
    for (const { id, file } of found) {
      const lines = episodeToLines(readEpisodeAsset(file), { id, language: "zh-Hans" }).lines;
      assert.equal(lines.length, 1);
      assert.equal(lines[0].body, "真实剧本");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("shared metrics expose percentiles, aggregation and full windows", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([], 0.9), 0);
  assert.deepEqual(aggregate([{ count: 2 }, { count: 4 }]), { count: 3 });
  assert.deepEqual(windowsOf([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4]]);
});

const lab = process.env.OURNOTES_AI_LAB;
const report = lab ? `${lab}/official-baseline.json` : "";
const corpusSkip = !report || !existsSync(report)
  ? "set OURNOTES_AI_LAB to a directory containing official-baseline.json" : false;
test("30-episode corpus recomputes the checked official totals", { skip: corpusSkip }, () => {
  const data = JSON.parse(readFileSync(report, "utf8"));
  assert.deepEqual(data.failures, []);
  assert.equal(data.episodes.length, 30);
  assert.equal(data.totals.talkRows, 1300);
  assert.equal(data.totals.textLines, 1158);
  assert.equal(data.totals.blankTalkRows, 142);
  assert.equal(data.totals.focus, 516);
  assert.equal(data.totals.motion, 1508);
  assert.equal(data.totals.zoom, 152);
  assert.equal(data.totals.pedestal, 122);
  assert.equal(data.totals.panV2, 167);
  assert.equal(data.totals.se, 147);
  for (const [key, expected] of Object.entries(BASELINE_EXPECTATIONS)) {
    assert.equal(data.totals[key], expected, `totals.${key}`);
  }
});

test("30-episode corpus reproduces the official distribution metrics", { skip: corpusSkip }, () => {
  const data = JSON.parse(readFileSync(report, "utf8"));
  const all = data.all.corpus;
  assert.equal(all.count, 1158);
  assert.equal(Number(all.charsMean.toFixed(3)), 15.541);
  assert.equal(all.charsMedian, 14);
  assert.equal(all.charsP90, 30);
  assert.equal(Number(all.segmentCharsMean.toFixed(3)), 11.116);
  assert.equal(Number(all.twoLineShare.toFixed(4)), 0.3826);
  assert.equal(Number(all.threeLineShare.toFixed(4)), 0.0078);
  assert.equal(Number(all.shortShare.toFixed(4)), 0.2168);
  assert.equal(Number(all.ellipsisShare.toFixed(4)), 0.4637);
  assert.equal(Number(all.questionShare.toFixed(4)), 0.2582);
  assert.equal(Number(all.exclaimShare.toFixed(4)), 0.2142);
  assert.equal(all.attributedMotions, 1502);
  assert.equal(all.motions, 1508);
  assert.equal(all.lookAny, 362);
  assert.equal(all.se, 147);
  assert.equal(all.bgm, 71);
  assert.equal(all.stage, 57);
  assert.equal(all.focus, 516);
  assert.equal(all.zoom, 152);
  assert.equal(all.pedestal, 122);
  assert.equal(all.panV2, 167);
  assert.equal(all.track, 95);
  assert.equal(all.dof, 24);
  assert.equal(data.all.tailCounts.motions, 6);
  assert.equal(data.all.tailCounts.lookAny || 0, 0);
  assert.equal(data.all.tailCounts.focus, 5);
  assert.equal(data.all.tailCounts.se, 5);
  assert.equal(data.all.tailCounts.bgm, 11);
  assert.equal(data.all.tailCounts.stage, 1);
  assert.equal(Number(all.noMotionShare.toFixed(4)), 0.0596);
  assert.equal(Number(all.distance2Share.toFixed(4)), 0.3892);
  assert.equal(Number(all.distance3Share.toFixed(4)), 0.3608);
  assert.equal(Number(all.distance4Share.toFixed(4)), 0.2038);
  assert.equal(Number(all.duoShare.toFixed(4)), 0.7623);
  assert.equal(Number(all.effectiveDuoShare.toFixed(4)), 0.7654);
  assert.equal(Number(all.lookLineShare.toFixed(4)), 0.3126);
  assert.equal(all.speakerRunCount, 832);
  assert.equal(Number(all.speakerRunMean.toFixed(3)), 1.392);
  assert.equal(Number(all.soloRunShare.toFixed(4)), 0.7284);
});
