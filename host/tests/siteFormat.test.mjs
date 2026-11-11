import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { costumeLabel, costumeOf, SiteFormatCatalog } from "../story/siteFormat.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

const makeSite = () => {
  const dir = tmpDir("ournotes-site-format-");
  fs.mkdirSync(path.join(dir, "stories"));
  fs.writeFileSync(path.join(dir, "stories", "1.json"), "{}");
  fs.writeFileSync(path.join(dir, "stories.json"), JSON.stringify({
    format: "ournotes.stories/1",
    stories: [
      { id: "1", advId: 1, manifest: "stories/1.json", titles: { ja: "第一篇" }, languages: ["ja", "en", "zh-Hans"] },
      { id: "bad", manifest: "../outside.json", titles: {} },
    ],
  }));
  return dir;
};

test("a site-format site lists its stories and picks a safe base", () => {
  const catalog = new SiteFormatCatalog({ dir: makeSite(), language: "ja", logger: quietLogger() });
  assert.equal(catalog.kind, "site-format");
  assert.deepEqual(catalog.bases(), [
    { manifest: "stories/1.json", id: "1", title: "第一篇", languages: ["ja", "en", "zh-Hans"] },
  ]);
  assert.equal(catalog.pickBase(), "stories/1.json");
  assert.equal(catalog.pickBase("1"), "stories/1.json");
  assert.throws(() => catalog.pickBase("missing"), /not a story/);
});

test("a story with a missing asset is skipped and cannot be picked", () => {
  const dir = makeSite();
  fs.writeFileSync(path.join(dir, "stories", "2.json"), JSON.stringify({
    languages: { "zh-Hans": { files: { "ui/fonts.json": { asset: "assets/missing.json.gz" } } } },
  }));
  const index = JSON.parse(fs.readFileSync(path.join(dir, "stories.json"), "utf8"));
  index.stories.push({ id: "2", manifest: "stories/2.json", titles: { "zh-Hans": "不完整" }, languages: ["zh-Hans"] });
  fs.writeFileSync(path.join(dir, "stories.json"), JSON.stringify(index));
  const catalog = new SiteFormatCatalog({ dir, language: "zh-Hans", logger: quietLogger() });
  assert.deepEqual(catalog.bases().map((base) => base.manifest), ["stories/1.json"]);
  assert.throws(() => catalog.pickBase("2"), /incomplete/);
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

test("a costume suffix and its prompt label are read from the model id", () => {
  assert.equal(costumeOf("adv_live2d_anon_002_live_01"), "live_01");
  assert.equal(costumeOf("adv_live2d_tomori_001_school_winter_jhs"), "school_winter_jhs");
  assert.equal(costumeOf("adv_live2d_sub_mortis_school_summer_hs"), "school_summer_hs");
  assert.equal(costumeOf("not-a-model"), "");
  assert.equal(costumeLabel("live_01"), "队服");
  assert.equal(costumeLabel("school_winter_jhs"), "校服·初中");
  assert.equal(costumeLabel("unknown_suit"), "unknown_suit");
});

test("the catalog keeps every costume so the cast prompt can choose one per band", { skip: !site }, async () => {
  const catalog = new SiteFormatCatalog({ dir: site, language: "ja", logger: quietLogger() });
  const result = await catalog.catalog({ manifest: catalog.bases()[0].manifest });
  const tomori = result.models.filter((m) => m.key === "tomori");
  assert.ok(tomori.length >= 2, `灯 has ${tomori.length} costumes`);
  assert.ok(tomori.some((m) => m.costume === "live_01"));
  assert.ok(tomori.some((m) => m.costume === "school_winter_jhs"));
  assert.ok(result.models.every((m) => m.costume && m.costumeLabel), "every model has a costume label");
});
