import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SiteFormatCatalog } from "../story/siteFormat.js";
import { Pipeline } from "../pipeline.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

const makeSite = () => {
  const dir = tmpDir("ournotes-site-format-");
  fs.mkdirSync(path.join(dir, "stories"));
  fs.writeFileSync(path.join(dir, "stories", "1.json"), "{}");
  fs.writeFileSync(path.join(dir, "stories.json"), JSON.stringify({
    format: "ournotes.stories/1",
    stories: [
      { id: "1", advId: 1, manifest: "stories/1.json", titles: { ja: "第一篇" }, languages: ["ja", "en"] },
      { id: "bad", manifest: "../outside.json", titles: {} },
    ],
  }));
  return dir;
};

test("a site-format site lists its stories and picks a safe base", () => {
  const catalog = new SiteFormatCatalog({ dir: makeSite(), language: "ja", logger: quietLogger() });
  assert.equal(catalog.kind, "site-format");
  assert.deepEqual(catalog.bases(), [
    { manifest: "stories/1.json", id: "1", title: "第一篇", languages: ["ja", "en"] },
  ]);
  assert.equal(catalog.pickBase(), "stories/1.json");
  assert.equal(catalog.pickBase("1"), "stories/1.json");
  assert.throws(() => catalog.pickBase("missing"), /not a story/);
});

test("the product render pipeline refuses a site-format catalog with a clear error", async () => {
  const pipeline = new Pipeline({
    config: { tts: {}, llm: {}, paths: {} },
    catalog: { kind: "site-format" }, llm: null, tts: null, renderer: null, logger: quietLogger(),
  });
  await assert.rejects(
    () => pipeline.run({ prompt: "test" }, { signal: null, jobId: "test", progress: () => {} }),
    /script\/generate/,
  );
});

const e2eSite = process.env.OURNOTES_E2E_SITE || "";
const localSite = path.resolve("resources/site");
const site = e2eSite || (fs.existsSync(path.join(localSite, "stories.json")) ? localSite : "");

test("a downloaded site produces a usable script catalog", { skip: !site }, async () => {
  const catalog = new SiteFormatCatalog({ dir: site, language: "ja", logger: quietLogger() });
  const base = catalog.bases()[0];
  assert.ok(base, "the site has at least one story");
  const result = await catalog.catalog({ manifest: base.manifest });
  assert.equal(result.manifest, base.manifest);
  assert.ok(result.stages.length > 0, "stages");
  assert.ok(result.models.length > 0, "models with character sheets");
  assert.ok(result.models.every((m) => m.id && m.name && Array.isArray(m.motions)), "model actions");
});
