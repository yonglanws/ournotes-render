import assert from "node:assert/strict";
import { test } from "node:test";
import { assetsOf, parseArgs } from "../tools/fetch-story.mjs";

test("fetch-story accepts an episode, language and site", () => {
  const o = parseArgs(["--adv", "10610", "--lang", "ja", "--out", "resources/site", "--concurrency", "12"]);
  assert.equal(o.adv, 10610);
  assert.equal(o.lang, "ja");
  assert.equal(o.out, "resources/site");
  assert.equal(o.concurrency, 12);
  assert.equal(o.runtime, true);
});

test("fetch-story rejects bad episodes, languages and parallelism", () => {
  assert.throws(() => parseArgs([]), /--adv/);
  assert.throws(() => parseArgs(["--adv", "-1"]), /--adv/);
  assert.throws(() => parseArgs(["--adv", "1", "--lang", "fr"]), /--lang/);
  assert.throws(() => parseArgs(["--adv", "1", "--concurrency", "0"]), /--concurrency/);
  assert.throws(() => parseArgs(["--adv", "1", "--unknown"]), /unknown option/);
});

test("fetch-story reads whole, encoded and split asset entries", () => {
  const whole = assetsOf({ asset: `assets/${"a".repeat(64)}.json`, size: 10 }, "whole");
  assert.deepEqual(whole, [{ asset: `assets/${"a".repeat(64)}.json`, size: 10, stored: null }]);
  const encoded = assetsOf({ asset: `assets/${"b".repeat(64)}.json.gz`, size: 10, stored: 4 }, "encoded");
  assert.deepEqual(encoded, [{ asset: `assets/${"b".repeat(64)}.json.gz`, size: 10, stored: 4 }]);
  const split = assetsOf({ parts: [
    ["scene", `assets/${"c".repeat(64)}.json`, 12, 5],
    ["settings", `assets/${"d".repeat(64)}.json`, 3],
  ] }, "split");
  assert.deepEqual(split, [
    { asset: `assets/${"c".repeat(64)}.json`, size: 12, stored: 5 },
    { asset: `assets/${"d".repeat(64)}.json`, size: 3, stored: null },
  ]);
});

test("fetch-story refuses a file that is not content-addressed", () => {
  assert.throws(() => assetsOf({ asset: "../../etc/passwd", size: 1 }, "bad"), /content-addressed/);
  assert.throws(() => assetsOf({ parts: [["x", "assets/short.json", 1]] }, "bad part"), /content-addressed/);
});
