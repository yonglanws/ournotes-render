// The site resource guide is what makes opaque asset ids choosable, and the site-wide pool is what stops a new
// episode from being limited to the base story's handful of backgrounds. Both are checked against the real downloaded
// site when it exists; the parsing tests always run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { musicLine, soundLine, stageLine } from "../ai/resourceLines.js";
import { applyStageGuide, loadResourceGuide } from "../story/resourceGuide.js";
import { buildSiteStory, readSiteCatalog } from "../tools/site-story.mjs";
import { tmpDir } from "./helpers.mjs";

test("the bundled guide names the official site's stages, music and SE", () => {
  const guide = loadResourceGuide("");
  assert.equal(guide.format, "ournotes.site-resources/1");
  assert.ok(guide.stages.size >= 12, `stages (${guide.stages.size})`);
  assert.ok(guide.music.size >= 9, `music (${guide.music.size})`);
  assert.ok(guide.sounds.size >= 18, `sounds (${guide.sounds.size})`);
  assert.equal(guide.stages.get("adv_bkg_stage_000218").kind, "title");
  assert.match(guide.stages.get("adv_bkg_stage_000180").description, /卧室/);
  assert.match(guide.music.get("sound_bgm_adv_liminal").use, /犹豫/);
  assert.match(guide.sounds.get("sound_se_adv_door_knock").use, /敲门/);
});

test("a site's own guide wins over the bundled one and unknown ids keep the story caption", () => {
  const site = tmpDir("ournotes-guide-");
  fs.writeFileSync(path.join(site, "story-resources.yaml"), [
    "format: ournotes.site-resources/1",
    "stages:",
    "  stage_a:",
    "    name: 自定义教室",
    "    description: 一间只属于这个站点的教室。",
    "    tags: [白天, 室内]",
  ].join("\n"));
  const guide = loadResourceGuide(site);
  assert.equal(guide.source, path.join(site, "story-resources.yaml"));
  assert.equal(guide.stages.get("stage_a").name, "自定义教室");
  assert.equal(guide.stages.size, 1);
  assert.deepEqual(applyStageGuide({ id: "unknown", caption: "回家路上" }, guide),
                   { id: "unknown", caption: "回家路上", name: "", description: "", tags: [], kind: "" });
  assert.equal(applyStageGuide({ id: "stage_a" }, guide).name, "自定义教室");
});

test("a title-card backdrop is never offered as a scene", () => {
  const guide = loadResourceGuide("");
  assert.equal(applyStageGuide({ id: "adv_bkg_stage_000218", caption: "" }, guide), null);
});

test("resource lines show the guide's name, tags and purpose", () => {
  assert.equal(stageLine({ id: "adv_bkg_stage_000180", name: "夜晚的卧室", tags: ["夜晚", "室内"],
                           description: "只开着一盏台灯的卧室。" }),
               "- adv_bkg_stage_000180 — 夜晚的卧室（夜晚，室内）：只开着一盏台灯的卧室。");
  assert.equal(stageLine({ id: "old_stage", caption: "回家路上" }), "- old_stage — 回家路上");
  assert.equal(musicLine({ cue: "bgm_a", name: "Liminal", mood: "安静", use: "夜路" }),
               "- bgm_a — Liminal（安静）：夜路");
  assert.equal(soundLine({ cue: "se_a", label: "Door Knock" }), "- se_a — Door Knock");
});

const localSite = path.resolve("resources/site");
const site = fs.existsSync(path.join(localSite, "stories.json")) ? localSite : "";

test("a downloaded site pools every story's locations and sounds, without title cards", { skip: !site }, () => {
  const catalog = readSiteCatalog(site, "stories/10438.json", "zh-Hans");
  assert.ok(catalog.base.stages.length >= 8, `stages (${catalog.base.stages.length})`);
  assert.ok(!catalog.base.stages.some((stage) => stage.id === "adv_bkg_stage_000218"),
            "the chapter-title backdrop is not a scene");
  assert.ok(catalog.base.stages.every((stage) => stage.name && stage.description),
            "every stage has a human description");
  assert.ok(catalog.base.stages.some((stage) => stage.id === "adv_bkg_stage_000294"),
            "a stage only another story of the same cast used is offered");
  assert.ok(!catalog.base.stages.some((stage) => stage.id === "adv_bkg_stage_000017"),
            "another band's school rooftop is not offered to this cast");
  assert.ok(!catalog.base.stages.some((stage) => stage.id === "adv_bkg_stage_000262"),
            "another band's room is not offered to this cast");
  assert.ok(catalog.base.stages.slice(0, 3).every((stage) => stage.caption !== "" || stage.id === "adv_bkg_stage_000164"),
            "the base story's own locations stay first");
  assert.ok(catalog.base.music.length >= 9, `music (${catalog.base.music.length})`);
  assert.ok(catalog.base.music.every((music) => music.name && music.mood && music.use));
  assert.ok(catalog.base.sounds.length >= 18, `sounds (${catalog.base.sounds.length})`);
  assert.ok(catalog.base.sounds.every((sound) => sound.name && sound.use));
});

test("a story can use a location and sounds another story brought", { skip: !site }, () => {
  // The test writes into the downloaded site (and cleans up), so never reuse an id the operator already has.
  let advId = 99011;
  while (fs.existsSync(path.join(site, "stories", `${advId}.json`))) advId++;
  const script = {
    format: "ournotes.story-script/1",
    base: "stories/10438.json",
    language: "zh-Hans",
    title: "操场测试",
    cast: {
      anon: { model: "adv_live2d_anon_002_live_01", name: "千早爱音" },
      tomori: { model: "adv_live2d_tomori_001_school_winter_jhs", name: "高松灯" },
    },
    beats: [
      { scene: "adv_bkg_stage_000294", music: "sound_bgm_adv_contrail", camera: "middle", focus: "far-left",
        positions: { anon: "far-left" } },
      { say: "anon", text: "……今天风好大。", se: "sound_se_adv_pen_write" },
      { say: "tomori", text: "嗯。天空，很漂亮。" },
    ],
  };
  const built = buildSiteStory({ site, baseRel: "stories/10438.json", script, advId, language: "zh-Hans",
                                 title: "操场测试", guide: loadResourceGuide(site), pool: true });
  try {
    assert.deepEqual(built.errors || [], []);
    const manifest = built.manifest;
    const stagesPart = manifest.files["scene.json"].parts.find(([key]) => key === "stages");
    const stages = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, stagesPart[1]))).toString());
    assert.ok(stages["adv_bkg_stage_000294/adv_bkg_stage_000294"], "the foreign prefab is merged into scene.json");
    assert.ok(Object.keys(manifest.files).some((file) => file.startsWith("textures/adv_bkg_stage_000294-")),
              "the foreign texture is in the manifest");
    assert.ok(Object.keys(manifest.files).includes("audio/sound_bgm_adv_contrail/sound_bgm_adv_contrail.m4a"));
    assert.ok(Object.keys(manifest.files).includes("audio/sound_se_adv_pen_write/sound_se_adv_pen_write.m4a"));
    assert.deepEqual(built.episode.commands.filter((c) => c.cmd === "Stage").map((c) => c.TargetAssetName),
                     ["adv_bkg_stage_000294/adv_bkg_stage_000294"]);
    const story = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, manifest.files["story.json"].asset)))
      .toString());
    assert.equal(story.audio.sound_bgm_adv_contrail, "audio/sound_bgm_adv_contrail");
    assert.equal(story.audio.sound_se_adv_pen_write, "audio/sound_se_adv_pen_write");
  } finally {
    // The test wrote a story into the downloaded site (as the opt-in e2e does). Remove its manifest and index entry;
    // the content-addressed assets are harmless and shared.
    fs.rmSync(path.join(site, "stories", `${advId}.json`), { force: true });
    const indexPath = path.join(site, "stories.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.stories = (index.stories || []).filter((entry) => String(entry.id) !== String(advId));
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }
});

test("pool: false keeps the old base-only vocabulary", { skip: !site }, () => {
  const catalog = readSiteCatalog(site, "stories/10438.json", "zh-Hans", { pool: false });
  assert.deepEqual(catalog.base.stages.map((stage) => stage.id),
                   ["adv_bkg_stage_000084", "adv_bkg_stage_000180", "adv_bkg_stage_000164"]);
});
