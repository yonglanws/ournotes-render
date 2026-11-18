import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "node:test";
import { costumeLabel, costumeOf, ensureOfficialAssetBundles, SiteFormatCatalog } from "../story/siteFormat.js";
import { addSiteVoices, bundleSiteEpisodeAssets, readSiteCatalog } from "../tools/site-story.mjs";
import { quietLogger, sineWav, tmpDir } from "./helpers.mjs";

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

const putGzAsset = (site, relDir, data, ext = "json") => {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const gz = zlib.gzipSync(bytes);
  const rel = `${relDir}/${sha}.${ext}.gz`;
  fs.mkdirSync(path.join(site, relDir), { recursive: true });
  fs.writeFileSync(path.join(site, rel), gz);
  return { asset: rel, size: bytes.length, stored: gz.length };
};

const readGzJson = (site, entry) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, entry.asset))).toString("utf8"));

const makePooledSite = () => {
  const dir = tmpDir("ournotes-site-pool-");
  fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });

  // Base story: Tomori (MyGO) + shared stage adv_bkg_stage_000010, minimal shaders/ui
  const baseScene = putGzAsset(dir, "assets", {
    stages: { "adv_bkg_stage_000010": { root: { name: "stage10" } } },
  });
  const baseUiTrans = putGzAsset(dir, "assets", {
    "adv_transition_0001/adv_transition_0001": { _texture: { texture: "rule1" }, _gradient: 0, _easingCurve: { m_Curve: [] } },
  });
  const baseUiTex = putGzAsset(dir, "assets", { rule1: { file: "textures/rule1.png" } });
  const baseStory = putGzAsset(dir, "assets", {
    models: { chr1: "adv_live2d_tomori_001_live_01" },
    frames: null, postEffects: null, effects: null, stills: null,
  });
  const baseEp = putGzAsset(dir, "assets", {
    advId: 100, commands: [{ cmd: "Stage", TargetAssetName: "adv_bkg_stage_000010" }], text: {}, sounds: {}, cuesheets: {},
  });
  const baseShaders = putGzAsset(dir, "assets", [
    { name: "Adv/Default", parsed: "default.json", variants: [{ file: "default.glsl" }] },
  ]);
  const fontsEntry = putGzAsset(dir, "assets", { texts: {}, textures: {}, materials: {}, materialKeywords: {} });

  const baseManifest = {
    format: "ournotes.story-manifest/2",
    advId: 100,
    language: "ja",
    files: {
      "scene.json": baseScene,
      "story.json": baseStory,
      "episode.json": baseEp,
      "shaders/shaders.json": baseShaders,
    },
    languages: {
      ja: {
        files: {
          "ui/ui.json": { parts: [["transitions", baseUiTrans.asset, baseUiTrans.size, baseUiTrans.stored],
                                   ["textures", baseUiTex.asset, baseUiTex.size, baseUiTex.stored]], size: 200 },
          "ui/fonts.json": fontsEntry,
        },
      },
    },
  };
  fs.writeFileSync(path.join(dir, "stories", "100.json"), JSON.stringify(baseManifest));

  // Donor story (Sakiko / Ave Mujica) with:
  // - shared neutral stage adv_bkg_stage_000084 AND Ave-specific stage adv_bkg_stage_000017
  // - Frame with stub controller + shader Mobile/Particles/Additive + texture
  // - PostEffect monochrome, Effect + instance, Still + clip stub, rule adv_transition_0002 + png
  const donorTex = putGzAsset(dir, "assets", Buffer.from("PNGDATA"), "png");
  const rule2Png = putGzAsset(dir, "assets", Buffer.from("RULE2PNG"), "png");
  const addParsed = putGzAsset(dir, "assets", { properties: {} });
  const addVariant = putGzAsset(dir, "assets", Buffer.from("void main(){}"), "glsl");
  const donorShaders = putGzAsset(dir, "assets", [
    { name: "Adv/Default", parsed: "default.json", variants: [{ file: "default.glsl" }] },
    { name: "Mobile/Particles/Additive", parsed: "additive.json", variants: [{ file: "additive.glsl" }] },
  ]);
  const donorFrames = putGzAsset(dir, "assets", {
    frames: {
      "adv_frame_other": { nodes: [{ anim: { controller: "shared_ctrl", layers: [{ states: [] }] },
                                       clip: { clip: "shared_clip", duration: 1 } }] },
      "adv_frame_glitch_1/adv_frame_glitch_1": {
        nodes: [{ texture: "textures/glitch_noise.png", shader: "Mobile/Particles/Additive",
                  anim: { controller: "shared_ctrl" } }],
      },
    },
  });
  const donorPostEffects = putGzAsset(dir, "assets", {
    postEffects: {
      "adv_effect_posteffect_monochrome": { asset: "VolumeProfile", name: "adv_effect_posteffect_monochrome", components: [] },
    },
  });
  const donorEffects = putGzAsset(dir, "assets", {
    instances: { eff_spark: "adv_effect_spark" },
    effects: { adv_effect_spark: { nodes: [{ texture: "textures/glitch_noise.png", shader: "Mobile/Particles/Additive" }] } },
  });
  const donorStills = putGzAsset(dir, "assets", {
    stills: { adv_still_01: { nodes: [{ anim: { clip: "shared_clip" } }], frames: { nodes: donorFrames.size } } },
  });
  // Include full clip inside donorStills too for AnimRecords resolution.
  const donorStillsFull = putGzAsset(dir, "assets", {
    stills: {
      adv_still_base: { nodes: [{ anim: { clip: "still_clip", length: 2 } }] },
      adv_still_01: { nodes: [{ anim: { clip: "still_clip" } }] },
    },
  });
  void donorStills;
  const donorScene = putGzAsset(dir, "assets", {
    stages: {
      "adv_bkg_stage_000084": {
        root: { name: "stage84" },
        nodes: [{ components: [{ class: "AdvStage", _allVolumeProfileCollection: { _profiles: [
          { asset: "VolumeProfile", name: "adv_bkg_posteffect_test_001" },
        ] } }] }],
      },
      "adv_bkg_stage_000017": {
        root: { name: "stage17" },
        nodes: [{ components: [{ class: "AdvStage", _allVolumeProfileCollection: { _profiles: [
          { asset: "VolumeProfile", name: "adv_bkg_posteffect_test_001", components: [{ asset: "Bloom" }] },
        ] } }] }],
      },
    },
  });
  const donorUiTrans = putGzAsset(dir, "assets", {
    "adv_transition_0002/adv_transition_0002": { _texture: { texture: "rule2" }, _gradient: 1, _easingCurve: { m_Curve: [] } },
  });
  const donorUiTex = putGzAsset(dir, "assets", { rule2: { texture: "textures/rule_adv_transition_0002.png" } });
  const donorStory = putGzAsset(dir, "assets", { models: { chr2: "adv_live2d_sakiko_006_live_01" } });
  const donorEp = putGzAsset(dir, "assets", { advId: 200, commands: [], text: {}, sounds: {}, cuesheets: {} });

  const donorManifest = {
    format: "ournotes.story-manifest/2",
    advId: 200,
    language: "ja",
    files: {
      "scene.json": donorScene,
      "story.json": donorStory,
      "episode.json": donorEp,
      "frames.json": donorFrames,
      "posteffects.json": donorPostEffects,
      "effects.json": donorEffects,
      "stills.json": donorStillsFull,
      "textures/glitch_noise.png": donorTex,
      "shaders/shaders.json": donorShaders,
      "shaders/additive.json": addParsed,
      "shaders/additive.glsl": addVariant,
      "ui/textures/rule_adv_transition_0002.png": rule2Png,
    },
    languages: {
      ja: {
        files: {
          "ui/ui.json": { parts: [["transitions", donorUiTrans.asset, donorUiTrans.size, donorUiTrans.stored],
                                   ["textures", donorUiTex.asset, donorUiTex.size, donorUiTex.stored]], size: 200 },
          "ui/fonts.json": fontsEntry,
        },
      },
    },
  };
  fs.writeFileSync(path.join(dir, "stories", "200.json"), JSON.stringify(donorManifest));
  fs.writeFileSync(path.join(dir, "stories.json"), JSON.stringify({
    format: "ournotes.stories/1",
    stories: [{ id: "100", advId: 100, manifest: "stories/100.json", titles: { ja: "Base" }, languages: ["ja"] }],
  }));
  return { dir, donorManifest };
};

test("addSiteVoices sets IgnoreLipSync: 1 on voiceless punctuation/ellipsis Talk rows and preserves voiced/text rows", () => {
  const dir = tmpDir("ournotes-lipsync-");
  const wav = path.join(dir, "line2.wav");
  sineWav(wav, { seconds: 0.2, sampleRate: 24000 });
  const episode = {
    sounds: {},
    cuesheets: {},
    text: {
      custom_line_0: { japanese: "……" },
      custom_line_1: { japanese: "？！」" },
      custom_line_2: { japanese: "……" },
      custom_line_3: { japanese: "おはよう" },
    },
    commands: [
      { cmd: "Talk", AdvTextID: "custom_line_0" },
      { cmd: "Talk", AdvTextID: "custom_line_1" },
      { cmd: "Talk", AdvTextID: "custom_line_2" },
      { cmd: "Talk", AdvTextID: "custom_line_3" },
      { cmd: "Talk", AdvTextID: "" },
    ],
  };
  const voices = new Map([["2", { file: wav, sampleRate: 24000, samples: 4800, channels: 1 }]]);
  addSiteVoices({ site: dir, episode, voices, field: "japanese" });
  assert.equal(episode.commands[0].IgnoreLipSync, 1);
  assert.equal(episode.commands[1].IgnoreLipSync, 1);
  assert.equal(episode.commands[2].IgnoreLipSync, undefined, "voiced ellipsis line keeps lip sync");
  assert.equal(episode.commands[3].IgnoreLipSync, undefined, "unvoiced spoken text is not ignored");
  assert.equal(episode.commands[4].IgnoreLipSync, undefined, "window-hide empty row untouched");

  // Also runs cleanly when voices is null/empty.
  const epNoVoices = {
    text: { custom_line_0: { japanese: "…………" } },
    commands: [{ cmd: "Talk", AdvTextID: "custom_line_0" }],
  };
  addSiteVoices({ site: dir, episode: epNoVoices, voices: null, field: "japanese" });
  assert.equal(epNoVoices.commands[0].IgnoreLipSync, 1);
});

test("readSiteCatalog & bundleSiteEpisodeAssets pool visual assets, shaders, transitions, and shared stages", () => {
  const { dir } = makePooledSite();
  const cat = readSiteCatalog(dir, "stories/100.json", "ja");

  // Default castOnly=false exposes all pooled/cloud stages (including cross-band venues); explicit castOnly=true still filters.
  const stageIds = cat.base.stages.map((s) => s.id);
  assert.ok(stageIds.includes("adv_bkg_stage_000010"));
  assert.ok(stageIds.includes("adv_bkg_stage_000084"), "shared venue relaxed across castOnly");
  assert.ok(stageIds.includes("adv_bkg_stage_000017"), "default castOnly=false exposes cross-band venues");
  const strictCat = readSiteCatalog(dir, "stories/100.json", "ja", { castOnly: true });
  const strictStageIds = strictCat.base.stages.map((s) => s.id);
  assert.ok(strictStageIds.includes("adv_bkg_stage_000084"), "shared venue stays offered under castOnly: true");
  assert.ok(!strictStageIds.includes("adv_bkg_stage_000017"), "explicit castOnly: true still filters cast-owned venue");

  assert.ok(cat.base.frames.includes("adv_frame_glitch_1/adv_frame_glitch_1"));
  assert.ok(cat.base.postEffects.includes("adv_effect_posteffect_monochrome"));
  assert.ok(cat.base.effects.includes("eff_spark"));
  assert.ok(cat.base.stills.includes("adv_still_01"));
  assert.ok(cat.base.transitions.includes("adv_transition_0002/adv_transition_0002"));

  const outManifest = JSON.parse(JSON.stringify(cat.baseManifest));
  const episode = {
    commands: [
      { cmd: "Stage", TargetAssetName: "adv_bkg_stage_000084" },
      { cmd: "Frame", TargetAssetName: "adv_frame_glitch_1/adv_frame_glitch_1" },
      { cmd: "PostEffect", TargetAssetName: "monochrome" },
      { cmd: "Effect", TargetName: "eff_spark" },
      { cmd: "Still", TargetAssetName: "adv_still_01" },
      { cmd: "FadeOut", TargetAssetName: "adv_transition_0002" },
    ],
    text: {}, sounds: {}, cuesheets: {},
  };
  bundleSiteEpisodeAssets({ site: dir, catalog: cat, manifest: outManifest, baseManifest: cat.baseManifest,
                            episode, lang: "ja" });

  assert.ok(outManifest.files["frames.json"]);
  assert.ok(outManifest.files["posteffects.json"]);
  assert.ok(outManifest.files["effects.json"]);
  assert.ok(outManifest.files["stills.json"]);
  assert.ok(outManifest.files["textures/glitch_noise.png"]);
  assert.ok(outManifest.files["shaders/additive.json"]);
  assert.ok(outManifest.files["shaders/additive.glsl"]);
  assert.ok(outManifest.files["ui/textures/rule_adv_transition_0002.png"]);

  const framesDoc = readGzJson(dir, outManifest.files["frames.json"]);
  assert.ok(Array.isArray(framesDoc.frames["adv_frame_glitch_1/adv_frame_glitch_1"].nodes[0].anim.layers),
            "stub controller inlined from donor");
  const stillsDoc = readGzJson(dir, outManifest.files["stills.json"]);
  assert.equal(stillsDoc.stills.adv_still_01.nodes[0].anim.length, 2, "stub clip inlined from donor");
  const peDoc = readGzJson(dir, outManifest.files["posteffects.json"]);
  assert.ok(peDoc.postEffects.monochrome && peDoc.postEffects.adv_effect_posteffect_monochrome);
  const shadersDoc = readGzJson(dir, outManifest.files["shaders/shaders.json"]);
  assert.ok(shadersDoc.some((r) => r.name === "Mobile/Particles/Additive"));
  const storyDoc = readGzJson(dir, outManifest.files["story.json"]);
  assert.equal(storyDoc.frames, "frames.json");
  assert.equal(storyDoc.postEffects, "posteffects.json");
  assert.equal(storyDoc.effects, "effects.json");
  assert.equal(storyDoc.stills, "stills.json");
  const transPart = readGzJson(dir, { asset: outManifest.languages.ja.files["ui/ui.json"].parts[0][1] });
  assert.ok(transPart.adv_transition_0002 && transPart["adv_transition_0002/adv_transition_0002"]);
  const sceneEntry = outManifest.files["scene.json"];
  const stagesPart = Array.isArray(sceneEntry.parts)
    ? readGzJson(dir, { asset: sceneEntry.parts.find(([k]) => k === "stages")[1] })
    : readGzJson(dir, sceneEntry).stages;
  assert.deepEqual(stagesPart["adv_bkg_stage_000084"].nodes[0].components[0]._allVolumeProfileCollection._profiles[0].components,
                   [{ asset: "Bloom" }], "stub VolumeProfile hydrated from donor pool");
});

test("ensureOfficialAssetBundles downloads and caches missing bundles cleanly and degrades gracefully offline", async () => {
  const { dir: remoteDir, donorManifest } = makePooledSite();
  const targetDir = tmpDir("ournotes-cdn-client-");
  fs.mkdirSync(path.join(targetDir, "stories"), { recursive: true });
  const srv = http.createServer((req, res) => {
    const clean = req.url.split("?")[0].replace(/^\/+/, "");
    const target = path.join(remoteDir, clean);
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200);
    fs.createReadStream(target).pipe(res);
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  try {
    void donorManifest;
    const baseUrl = `http://127.0.0.1:${port}`;
    const res = await ensureOfficialAssetBundles({
      site: targetDir,
      baseUrl,
      seedEpisodes: ["200"],
      scanIndex: false,
      allowPrivateUrl: true,
      targets: {
        frames: ["adv_frame_glitch_1"],
        postEffects: ["monochrome"],
        transitions: ["adv_transition_0002"],
      },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.offline, false);
    assert.ok(res.cached.includes("adv_frame_glitch_1/adv_frame_glitch_1"));
    assert.ok(res.cached.includes("adv_effect_posteffect_monochrome"));
    assert.ok(res.cached.includes("adv_transition_0002/adv_transition_0002"));
    assert.ok(fs.existsSync(path.join(targetDir, "official-bundles.json")));
    const bundleDoc = JSON.parse(fs.readFileSync(path.join(targetDir, "official-bundles.json"), "utf8"));
    const mirroredRule = bundleDoc.files["ui/textures/rule_adv_transition_0002.png"];
    assert.ok(mirroredRule && fs.existsSync(path.join(targetDir, mirroredRule.asset)),
              "rule transition PNG referenced via .texture is mirrored");

    // Second run finds everything already cached and performs zero downloads.
    const second = await ensureOfficialAssetBundles({
      site: targetDir,
      baseUrl: "http://127.0.0.1:1",
      seedEpisodes: ["200"],
      scanIndex: false,
      allowPrivateUrl: true,
      targets: {
        frames: ["adv_frame_glitch_1"],
        postEffects: ["monochrome"],
        transitions: ["adv_transition_0002"],
      },
    });
    assert.equal(second.ok, true);
    assert.deepEqual(second.cached, []);

    // Adding a local base story without donor 200.json lets readSiteCatalog pool directly from official-bundles.json.
    const base100 = JSON.parse(fs.readFileSync(path.join(remoteDir, "stories", "100.json"), "utf8"));
    for (const ref of [...Object.values(base100.files), ...base100.languages.ja.files["ui/ui.json"].parts.map((p) => p[1]),
                       base100.languages.ja.files["ui/fonts.json"]]) {
      const rel = typeof ref === "string" ? ref : ref.asset;
      if (rel) fs.copyFileSync(path.join(remoteDir, rel), path.join(targetDir, rel));
    }
    fs.writeFileSync(path.join(targetDir, "stories", "100.json"), JSON.stringify(base100));
    const pooledCat = readSiteCatalog(targetDir, "stories/100.json", "ja");
    assert.ok(pooledCat.base.frames.includes("adv_frame_glitch_1/adv_frame_glitch_1"));
    assert.ok(pooledCat.base.postEffects.includes("adv_effect_posteffect_monochrome"));
    assert.ok(pooledCat.base.transitions.includes("adv_transition_0002/adv_transition_0002"));
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }

  // Offline / unreachable endpoint falls back gracefully without throwing.
  const offlineRes = await ensureOfficialAssetBundles({
    site: tmpDir("ournotes-cdn-offline-"),
    baseUrl: `http://127.0.0.1:${port}`,
    seedEpisodes: ["99999"],
    scanIndex: false,
    allowPrivateUrl: true,
    timeoutMs: 1000,
    targets: { frames: ["adv_frame_fill_white"] },
  });
  assert.equal(offlineRes.ok, false);
  assert.equal(offlineRes.offline, true);
  assert.deepEqual(offlineRes.missing.frames, ["adv_frame_fill_white"]);
});
