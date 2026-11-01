import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { StoryCatalog } from "../story/catalog.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

const site = () => {
  const dir = tmpDir("ournotes-site-");
  fs.writeFileSync(path.join(dir, "stories.json"), JSON.stringify({ format: "ournotes.stories/1", stories: [] }));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ format: 2, models: [] }));
  fs.mkdirSync(path.join(dir, "stories"));
  return dir;
};

test("a base manifest paths outside the site are refused", () => {
  const cat = new StoryCatalog({ dir: site(), logger: quietLogger() });
  for (const bad of ["../secret.json", "/etc/passwd.json", "stories/../../secret.json", "C:\\secret.json",
                     "stories/1.txt", "stories/./1.json"]) {
    assert.throws(() => cat.pickBase(bad), /site-relative|Normal story/, bad);
  }
});

test("a custom story manifest inside the site can be a base", () => {
  const dir = site();
  const manifest = {
    schema: "nnnotes.product/1", product: "story", subject: "0", language: "zh-Hans",
    files: { "story.json": { asset: "assets/a.json", size: 2 }, "episode.json": { asset: "assets/b.json", size: 2 } },
    objects: {},
  };
  fs.mkdirSync(path.join(dir, "custom-stories"));
  fs.writeFileSync(path.join(dir, "custom-stories", "mine.json"), JSON.stringify(manifest));
  const cat = new StoryCatalog({ dir, logger: quietLogger() });
  const base = cat.pickBase("custom-stories/mine.json");
  assert.equal(base.manifest, "custom-stories/mine.json");
  assert.equal(base.id, "0");
});
