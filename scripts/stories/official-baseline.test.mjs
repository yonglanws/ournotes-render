import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { discoverOfficialCorpus, episodeToLines, readEpisodeAsset } from "./official-corpus.mjs";
import { aggregate, percentile, summarize, windowsOf } from "./story-metrics.mjs";
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
