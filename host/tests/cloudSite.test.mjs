// Integration & unit tests for:
// 1) Left/Right Live2D facing orientation (_L on left slots, _R on right slots, _C on center)
// 2) Zero-local-site cloud bootstrap (paths.site/siteFormat empty -> <cache>/cloud-site without adv_voice_*)
// 3) Full on-demand materialization of cloud Live2D models, donor/direct .webp stages, BGM/SE .m4a cues & FX
// 4) Full cloud semantic catalog (343 stages, 91 BGMs, 345 SEs, 209 TW + 58 JP models) & categorized AI prompts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { loadConfig } from "../config.js";
import { runDoctor } from "../doctor.js";
import { buildStoryMessages } from "../ai/prompt.js";
import { buildCastMessages, buildStoryboardMessages } from "../ai/staged.js";
import { loadCloudCatalog, synthesizeStagePrefab, webpDimensions } from "../story/cloudCatalogData.js";
import { ensureCloudRuntimeBase, materializeSiteStoryAssets } from "../story/cloudSite.js";
import { loadResourceGuide } from "../story/resourceGuide.js";
import { SiteFormatCatalog } from "../story/siteFormat.js";
import { assertOfficialRemoteUrl, buildSiteStory, readSiteCatalog } from "../tools/site-story.mjs";
import { compileScript, parseScript } from "../../scripts/lib/story-author/script.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

const gzAsset = (data, ext = "json") => {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const gz = zlib.gzipSync(bytes);
  const rel = `assets/${sha}.${ext}.gz`;
  return { entry: { asset: rel, size: bytes.length, stored: gz.length }, rel, raw: gz };
};

// Minimal valid 20x10 RIFF/WEBP VP8L header for exact dimension probing without external tools.
const tinyVp8lWebp = (w = 640, h = 360) => {
  const buf = Buffer.alloc(32);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(24, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8L", 12, "ascii");
  buf.writeUInt32LE(12, 16);
  buf[20] = 0x2f;
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  buf.writeUInt32LE(bits >>> 0, 21);
  return buf;
};

test("cloud semantic catalog covers all 343 stages, 91 BGMs, 345 SEs, and 209 TW + 58 JP models", () => {
  const cc = loadCloudCatalog();
  assert.equal(cc.counts.stages, 343);
  assert.equal(cc.counts.music, 91);
  assert.equal(cc.counts.sounds, 345);
  assert.equal(cc.counts.twModels, 209);
  assert.equal(cc.counts.jpModels, 58);

  const guide = loadResourceGuide("");
  assert.equal(guide.stages.size, 343);
  assert.equal(guide.music.size, 91);
  assert.equal(guide.sounds.size, 345);

  for (const titleId of ["adv_bkg_stage_000217", "adv_bkg_stage_000218", "adv_bkg_stage_000333"]) {
    assert.equal(guide.stages.get(titleId)?.kind, "title", `${titleId} must be marked title`);
  }
  const f6 = guide.music.get("sound_bgm_adv_f6b483");
  assert.ok(f6 && /温暖|明快/.test(f6.mood), `sound_bgm_adv_f6b483 mood should be warm/bright, got: ${f6?.mood}`);
  assert.ok(cc.models.tw.every((m) => m.characterName && m.costumeLabel && Array.isArray(m.actions?.motions)));
});

test("empty paths.site and paths.siteFormat enable cloud-auto in loadConfig and runDoctor", () => {
  const dir = tmpDir("ournotes-empty-site-");
  const cfgPath = path.join(dir, "config.yaml");
  fs.writeFileSync(cfgPath, [
    "security:",
    "  allowPrivateServiceEndpoints: true",
    "paths:",
    "  site: ''",
    "  siteFormat: ''",
    `  cache: ${JSON.stringify(path.join(dir, "cache"))}`,
    `  output: ${JSON.stringify(path.join(dir, "output"))}`,
  ].join("\n"));
  const cfg = loadConfig({ file: cfgPath, logger: quietLogger() });
  assert.equal(cfg.issues.errors.length, 0);
  const report = runDoctor(cfg);
  assert.equal(report.checks.site.ok, true);
  assert.equal(report.checks.site.mode, "cloud-auto");
  assert.equal(report.checks.site.dir, path.join(dir, "cache", "cloud-site"));
});

test("left-slot characters compile with _L and right-slot characters compile with _R (including 5-position slots)", () => {
  const parsed = parseScript({
    format: "ournotes.story-script/1",
    base: "stories/10610.json",
    language: "zh-Hans",
    cast: {
      left: { model: "adv_live2d_tomori_001_live_01", name: "高松灯" },
      right: { model: "adv_live2d_anon_002_live_01", name: "千早爱音" },
    },
    beats: [
      { scene: "adv_bkg_stage_000152", positions: { left: "left", right: "right" } },
      { say: "left", text: "左边说话", motion: "nod01", expression: "smile01" },
      { say: "right", text: "右边说话", motion: "talk01", expression: "idle01" },
    ],
  });
  assert.deepEqual(parsed.errors, []);
  const actions = {
    adv_live2d_tomori_001_live_01: {
      motions: ["nod01_L", "nod01_R", "nod01_C", "idle01_L", "idle01_R", "idle01_C"],
      expressions: ["smile01", "idle01"],
      defaultMotion: "idle01_L",
      defaultExpression: "idle01",
    },
    adv_live2d_anon_002_live_01: {
      motions: ["talk01_L", "talk01_R", "talk01_C", "idle01_L", "idle01_R", "idle01_C"],
      expressions: ["idle01"],
      defaultMotion: "idle01_R",
      defaultExpression: "idle01",
    },
  };
  const compiled = compileScript(parsed.script, {
    base: {
      language: "zh-Hans",
      languages: ["zh-Hans"],
      stages: [{ id: "adv_bkg_stage_000152" }],
      music: [],
      episode: { master: { _id: 1, _sheetName: "1" }, sounds: {}, cuesheets: {}, text: {}, commands: [] },
      story: { parts: { scene: "scene.json", ui: { "zh-Hans": "ui/ui.json" }, fonts: { "zh-Hans": "ui/fonts.json" }, assets: {}, sounds: {} } },
    },
    models: { adv_live2d_tomori_001_live_01: "tomori", adv_live2d_anon_002_live_01: "anon" },
    actions,
    sounds: [],
  }, "zh-Hans");
  const acts = compiled.episode.commands;
  assert.ok(acts.some((c) => c.TargetName === "left" && c.MotionName === "nod01_L"));
  assert.ok(acts.some((c) => c.TargetName === "right" && c.MotionName === "talk01_R"));
});

test("zero-local-site bootstrap + on-demand cloud materialization + buildSiteStory end-to-end", async () => {
  const { width, height } = webpDimensions(tinyVp8lWebp(800, 450));
  assert.equal(width, 800);
  assert.equal(height, 450);

  const blobMap = new Map();
  const addBlob = (b) => { blobMap.set(b.rel, b.raw); return b.entry; };

  const seedScene = addBlob(gzAsset({ stages: { "Adv/Stage/adv_bkg_stage_000152/adv_bkg_stage_000152": { nodes: [] } } }));
  const seedStory = addBlob(gzAsset({ models: { anon: "adv_live2d_anon_002_live_01" }, frames: null, postEffects: null, effects: null, stills: null }));
  const seedEp = addBlob(gzAsset({ advId: 10610, commands: [{ cmd: "Stage", TargetAssetName: "Adv/Stage/adv_bkg_stage_000152/adv_bkg_stage_000152" }], text: {}, sounds: {}, cuesheets: {} }));
  const seedUiTrans = addBlob(gzAsset({ "adv_transition_0001/adv_transition_0001": { _texture: { texture: "" }, _gradient: 0 } }));
  const seedUiTex = addBlob(gzAsset({}));
  const seedFonts = addBlob(gzAsset({ texts: {}, textures: {}, materials: {}, materialKeywords: {} }));
  const voiceBlob = addBlob(gzAsset(Buffer.from("VOICE"), "m4a"));

  const seedManifest = {
    format: "ournotes.story-manifest/2",
    advId: 10610,
    language: "zh-Hans",
    audio: true,
    models: { adv_live2d_anon_002_live_01: "models/adv_live2d_anon_002_live_01.json" },
    files: {
      "scene.json": seedScene,
      "story.json": seedStory,
      "episode.json": seedEp,
      "audio/adv_voice_test/line1.m4a": voiceBlob,
    },
    languages: {
      "zh-Hans": {
        files: {
          "ui/ui.json": { parts: [["transitions", seedUiTrans.asset, seedUiTrans.size, seedUiTrans.stored],
                                   ["textures", seedUiTex.asset, seedUiTex.size, seedUiTex.stored]], size: 100 },
          "ui/fonts.json": seedFonts,
        },
      },
    },
  };

  // Remote cloud model (Sakiko)
  const sakikoPrefab = addBlob(gzAsset({
    nodes: [{
      components: [{
        class: "Live2DCharacter",
        _motionList: ["idle01_L", "idle01_C", "idle01_R", "nod01_L", "nod01_C", "nod01_R"],
        _expressionList: ["idle01", "smile01"],
        DefaultMotionName: "idle01_C",
        DefaultExpressionName: "idle01",
      }],
    }],
  }));
  const sakikoManifest = {
    key: "sakiko",
    files: { "sakiko.prefab.json": sakikoPrefab },
  };

  // Donor story 10473 providing BGM sound_bgm_adv_f6b483 & SE sound_se_adv_door_knock
  const f6M4a = addBlob(gzAsset(Buffer.from("F6BGM"), "m4a"));
  const f6Cues = addBlob(gzAsset({ sound_bgm_adv_f6b483: { file: "sound_bgm_adv_f6b483.m4a", sampleRate: 48000, samples: 48000, channels: 2, categories: ["Bgm"] } }));
  const knockM4a = addBlob(gzAsset(Buffer.from("KNOCKSE"), "m4a"));
  const seCues = addBlob(gzAsset({ sound_se_adv_door_knock: { file: "sound_se_adv_door_knock.m4a", sampleRate: 48000, samples: 24000, channels: 2, categories: ["Se"] } }));
  const donor10473Ep = addBlob(gzAsset({
    advId: 10473,
    commands: [],
    text: {},
    sounds: {
      501: { _id: 501, _category: 0, _soundCueSheetID: 601, _cueName: "sound_bgm_adv_f6b483" },
      502: { _id: 502, _category: 1, _soundCueSheetID: 602, _cueName: "sound_se_adv_door_knock" },
    },
    cuesheets: {
      601: { _id: 601, _cueSheetName: "sound_bgm_adv_f6b483" },
      602: { _id: 602, _cueSheetName: "sound_se_adv" },
    },
  }));
  const donor10473Manifest = {
    format: "ournotes.story-manifest/2",
    advId: 10473,
    language: "zh-Hans",
    files: {
      "episode.json": donor10473Ep,
      "audio/sound_bgm_adv_f6b483/sound_bgm_adv_f6b483.m4a": f6M4a,
      "audio/sound_bgm_adv_f6b483/cues.json": f6Cues,
      "audio/sound_se_adv/sound_se_adv_door_knock.m4a": knockM4a,
      "audio/sound_se_adv/cues.json": seCues,
    },
  };

  // Direct stage WebP (for adv_bkg_stage_000042 which has no donorAdvId) & direct SE .m4a
  const stage42Webp = tinyVp8lWebp(1280, 720);
  const directSeM4a = Buffer.from("DIRECTM4A");

  const requestedPaths = [];
  const srv = http.createServer((req, res) => {
    const clean = req.url.split("?")[0];
    requestedPaths.push(clean);
    if (clean === "/storage/models.json") {
      res.writeHead(200);
      res.end(JSON.stringify({ models: [{ id: "adv_live2d_sakiko_006_live_01", manifest: "models/adv_live2d_sakiko_006_live_01.json" }] }));
      return;
    }
    if (clean === "/storage/jp/models.json") {
      res.writeHead(200);
      res.end(JSON.stringify({ models: [{ id: "adv_live2d_tomori_001_casual_spring_01", manifest: "models/adv_live2d_tomori_001_casual_spring_01.json" }] }));
      return;
    }
    if (clean === "/storage/vendor/cubism-motionsync-core-5.0.4/live2dcubismmotionsynccore.min.js") {
      res.writeHead(200);
      res.end("/* motionsync */");
      return;
    }
    if (clean === "/storage/stories.json") {
      res.writeHead(200);
      res.end(JSON.stringify({
        format: "ournotes.stories/1",
        stories: [{ id: "10610", advId: 10610, manifest: "stories/10610.json", languages: ["zh-Hans"], titles: { "zh-Hans": "Seed" } }],
      }));
      return;
    }
    if (clean === "/storage/stories/10610.json") { res.writeHead(200); res.end(JSON.stringify(seedManifest)); return; }
    if (clean === "/storage/stories/10473.json") { res.writeHead(200); res.end(JSON.stringify(donor10473Manifest)); return; }
    if (clean === "/storage/models/adv_live2d_sakiko_006_live_01.json" ||
        clean === "/storage/models/adv_live2d_tomori_001_casual_spring_01.json" ||
        clean === "/storage/jp/models/adv_live2d_tomori_001_casual_spring_01.json") {
      res.writeHead(200);
      res.end(JSON.stringify({ ...sakikoManifest, key: clean.includes("tomori") ? "tomori" : "sakiko" }));
      return;
    }
    if (clean.startsWith("/storage/assets/")) {
      const rel = clean.slice("/storage/".length);
      if (blobMap.has(rel)) { res.writeHead(200); res.end(blobMap.get(rel)); return; }
    }
    if (clean === "/assets/zh-Hans/Adv/Stage/adv_bkg_stage_000042/data/adv_bkg_stage_000042/adv_bkg_stage_000042.webp") {
      res.writeHead(200); res.end(stage42Webp); return;
    }
    if (clean === "/assets/zh-Hans/Cri/Sound/sound_se_adv/sound_se_adv_cat.m4a" ||
        clean === "/assets/zh-Hans/Cri/Sound/sound_se_adv/sound_se_adv_door_knock.m4a") {
      res.writeHead(200); res.end(directSeM4a); return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  const storageBaseUrl = `http://127.0.0.1:${port}/storage`;
  const assetBaseUrl = `http://127.0.0.1:${port}/assets`;
  const cloudDir = tmpDir("ournotes-cloud-site-");

  try {
    const boot = await ensureCloudRuntimeBase({
      dir: cloudDir,
      baseUrl: storageBaseUrl,
      coreUrl: "",
      motionSyncUrl: `${storageBaseUrl}/vendor/cubism-motionsync-core-5.0.4/live2dcubismmotionsynccore.min.js`,
      language: "zh-Hans",
      seedAdvId: "10610",
      allowPrivateUrl: true,
      logger: quietLogger(),
    });
    assert.ok(fs.existsSync(path.join(cloudDir, "models.json")));
    assert.ok(fs.existsSync(path.join(cloudDir, "jp", "models.json")));
    assert.ok(fs.existsSync(path.join(cloudDir, "vendor", "live2dcubismmotionsynccore.min.js")));
    assert.ok(!requestedPaths.includes(`/storage/${voiceBlob.rel}`), "voice audio adv_voice_* must NOT be downloaded on bootstrap");
    assert.ok(boot.downloaded.includes("stories/10610.json"));

    const catalog = new SiteFormatCatalog({ dir: cloudDir, language: "zh-Hans", logger: quietLogger() });
    assert.equal(catalog.bases().length, 1);

    const reqBeforeCount = requestedPaths.length;
    await ensureCloudRuntimeBase({
      dir: cloudDir,
      baseUrl: storageBaseUrl,
      coreUrl: "",
      motionSyncUrl: `${storageBaseUrl}/vendor/cubism-motionsync-core-5.0.4/live2dcubismmotionsynccore.min.js`,
      language: "zh-Hans",
      seedAdvId: "10610",
      allowPrivateUrl: true,
      logger: quietLogger(),
    });
    assert.equal(requestedPaths.length, reqBeforeCount, "second bootstrap run is idempotent with zero downloads");

    // Materialize cloud story selecting model + JP-listed model + direct .webp stage + donor BGM + 2 SE cues
    const script = {
      format: "ournotes.story-script/1",
      base: "stories/10610.json",
      language: "zh-Hans",
      title: "云端测试剧",
      cast: {
        sakiko: { model: "adv_live2d_sakiko_006_live_01", name: "丰川祥子" },
        tomori: { model: "adv_live2d_tomori_001_casual_spring_01", name: "高松灯" },
      },
      beats: [
        { scene: "adv_bkg_stage_000042", music: "sound_bgm_adv_f6b483", positions: { sakiko: "left", tomori: "right" } },
        { say: "sakiko", text: "咚咚。", se: "sound_se_adv_door_knock", motion: "nod01", expression: "smile01" },
        { say: "tomori", text: "喵？", se: "sound_se_adv_cat" },
      ],
    };

    const mat = await materializeSiteStoryAssets({
      site: cloudDir,
      script,
      language: "zh-Hans",
      storageBaseUrl,
      assetBaseUrl,
      allowPrivateUrl: true,
      logger: quietLogger(),
    });
    assert.ok(mat.materialized.includes("adv_live2d_sakiko_006_live_01"));
    assert.ok(mat.materialized.includes("adv_live2d_tomori_001_casual_spring_01"));
    assert.ok(mat.materialized.includes("adv_bkg_stage_000042"));
    assert.ok(mat.materialized.includes("sound_bgm_adv_f6b483"));
    assert.ok(mat.materialized.includes("sound_se_adv_door_knock"));

    // Verify direct stage .webp prefab synthesized exact pixel dimensions
    const poolDoc = JSON.parse(fs.readFileSync(path.join(cloudDir, "cloud-pool.json"), "utf8"));
    const stage42Tex = poolDoc.stages.adv_bkg_stage_000042.prefab.nodes[0].components[0]._backgroundSprite.texture;
    assert.equal(stage42Tex.width, 1280);
    assert.equal(stage42Tex.height, 720);

    // Compile story onto cloud-site; verify manifest.models contains ONLY cast models with existing on-disk paths
    const built = buildSiteStory({
      site: cloudDir,
      baseRel: "stories/10610.json",
      script,
      advId: 900123,
      language: "zh-Hans",
      title: "云端测试剧",
    });
    assert.equal(built.errors, undefined, JSON.stringify(built.errors));
    assert.equal(built.manifest.models.adv_live2d_anon_002_live_01, undefined,
                 "unused baseManifest seed models must not leak into manifest.models");
    assert.equal(built.manifest.models.adv_live2d_sakiko_006_live_01, "models/adv_live2d_sakiko_006_live_01.json");
    assert.equal(built.manifest.models.adv_live2d_tomori_001_casual_spring_01, "models/adv_live2d_tomori_001_casual_spring_01.json");
    for (const rel of Object.values(built.manifest.models)) {
      assert.ok(fs.existsSync(path.join(cloudDir, ...rel.split("/"))), `manifest model path must exist on disk: ${rel}`);
    }
    const builtStoryJson = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cloudDir, built.manifest.files["story.json"].asset))).toString("utf8"));
    assert.equal(builtStoryJson.models.anon, undefined, "unused base story.json models must not leak");
    assert.ok(built.manifest.files["audio/sound_bgm_adv_f6b483/sound_bgm_adv_f6b483.m4a"]);
    assert.ok(built.manifest.files["audio/sound_se_adv/cues.json"]);
    assert.ok(built.manifest.files["audio/sound_se_adv/sound_se_adv_door_knock.m4a"]);
    assert.ok(built.manifest.files["audio/sound_se_adv/sound_se_adv_cat.m4a"]);
    const mergedCues = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(cloudDir, built.manifest.files["audio/sound_se_adv/cues.json"].asset))).toString("utf8"));
    assert.ok(mergedCues.sound_se_adv_door_knock, "first SE cue included in merged cues.json");
    assert.ok(mergedCues.sound_se_adv_cat, "second SE cue included in merged cues.json");

    // Verify readSiteCatalog merges cloud catalog & preserves local entries
    const fullCat = readSiteCatalog(cloudDir, "stories/10610.json", "zh-Hans");
    assert.equal(fullCat.base.stages.length, 340, "343 stages minus 3 title cards");
    assert.equal(fullCat.base.music.length, 91);
    assert.equal(fullCat.base.sounds.length, 345);
    assert.ok(fullCat.models.length >= 209);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("AI prompts use categorized & query-ranked Chinese selection instead of blind clipping", () => {
  const cc = loadCloudCatalog();
  const stages = cc.stages.filter((s) => s.kind !== "title");
  const music = cc.music;
  const sounds = cc.sounds;
  const models = cc.models.tw.map((m) => ({
    id: m.id,
    key: m.characterKey,
    name: m.characterName,
    character: m.characterName,
    band: m.band,
    costume: m.costumeKey,
    costumeLabel: m.costumeLabel,
    isStillOrMask: m.isStillOrMask,
    motions: m.actions.motions,
    expressions: m.actions.expressions,
    actionsKnown: true,
  }));
  const catalog = {
    manifest: "stories/10610.json",
    language: "zh-Hans",
    stages,
    music,
    sounds,
    models,
    frames: [],
    postEffects: [],
    transitions: [],
  };
  const cfg = { story: { maxOnStage: 3, personas: [] }, llm: {} };

  const [, castUser] = buildCastMessages({ catalog, request: { prompt: "夜晚在千石由乃的房间直播完去家庭餐厅聚餐，敲门后拍照" }, config: cfg });
  assert.match(castUser.content, /### Live 与排练/);
  assert.match(castUser.content, /### 餐饮与聚会/);
  assert.match(castUser.content, /adv_bkg_stage_000262/);
  assert.match(castUser.content, /### 温暖与日常/);
  assert.match(castUser.content, /sound_bgm_adv_f6b483/);
  // All 5 bands appear (not cut off after 24 models)
  assert.match(castUser.content, /高松灯/);
  assert.match(castUser.content, /丰川祥子/);
  assert.match(castUser.content, /仲町阿拉蕾/);
  assert.match(castUser.content, /四宫宁月/);
  assert.match(castUser.content, /伊泽枣/);

  const [, sbUser] = buildStoryboardMessages({
    plan: {
      title: "夜谈", event: "敲门进屋并拍照", tone: "温暖日常",
      setting: { stage: "adv_bkg_stage_000262", music: "sound_bgm_adv_f6b483" },
      cast: [{ id: "yuno", model: "adv_live2d_yuno_012_casual_spring_01", name: "千石由乃", group: "梦限大" }],
    },
    dialogue: { lines: [{ id: 1, say: "yuno", text: "请进！我们合个影拍张照吧。" }] },
    catalog,
    request: { prompt: "敲门后拍照" },
    config: cfg,
  });
  assert.match(sbUser.content, /sound_se_adv_door_knock/);
  assert.match(sbUser.content, /sound_se_adv_.*camera/);

  const [, singleUser] = buildStoryMessages({
    catalog,
    request: { prompt: "咖啡厅喝茶聊天" },
    config: cfg,
  });
  assert.match(singleUser.content, /### 餐饮与聚会/);
});

test("assertOfficialRemoteUrl allows Clash TUN Fake-IP for trusted official hosts while keeping SSRF guards intact", async () => {
  const fakeIpLookup = async () => [{ address: "198.18.0.191", family: 4 }];
  const lanLookup = async () => [{ address: "192.168.1.10", family: 4 }];
  const loopbackLookup = async () => [{ address: "127.0.0.1", family: 4 }];

  // Trusted official CDN hosts succeed under TUN Fake-IP (198.18.0.0/15) even when allowPrivateUrl is false.
  await assert.doesNotReject(() =>
    assertOfficialRemoteUrl("https://storage.bdon.moe/moenotes/models.json", { allowPrivateUrl: false, lookup: fakeIpLookup }));
  await assert.doesNotReject(() =>
    assertOfficialRemoteUrl("https://assets.bdon.moe/catalogs", { allowPrivateUrl: false, lookup: fakeIpLookup }));

  // Trusted hosts still refuse loopback/LAN IPs unless allowPrivateUrl is enabled.
  await assert.rejects(() =>
    assertOfficialRemoteUrl("https://storage.bdon.moe/moenotes/models.json", { allowPrivateUrl: false, lookup: lanLookup }), /private/);
  await assert.rejects(() =>
    assertOfficialRemoteUrl("https://storage.bdon.moe/moenotes/models.json", { allowPrivateUrl: false, lookup: loopbackLookup }), /private/);

  // Untrusted hosts and literal private IPs remain blocked when allowPrivateUrl is false.
  await assert.rejects(() =>
    assertOfficialRemoteUrl("http://198.18.0.1/moenotes/models.json", { allowPrivateUrl: false }), /private/);
  await assert.rejects(() =>
    assertOfficialRemoteUrl("http://127.0.0.1:8080/models.json", { allowPrivateUrl: false }), /private/);

  // Proxy-routed official requests skip local DNS resolution and keep scheme/literal guards.
  await assert.doesNotReject(() =>
    assertOfficialRemoteUrl("https://storage.bdon.moe/moenotes/models.json", {
      allowPrivateUrl: false,
      proxy: "http://127.0.0.1:7890",
      lookup: loopbackLookup,
    }));

  // allowPrivateUrl: true permits local/private test servers.
  await assert.doesNotReject(() =>
    assertOfficialRemoteUrl("http://127.0.0.1:8080/models.json", { allowPrivateUrl: true }));
});

test("materializeSiteStoryAssets coalesces concurrent downloads via per-asset lock and preserves cloud-pool entries", async () => {
  const stage42 = tinyVp8lWebp(640, 360);
  const stage43 = tinyVp8lWebp(800, 450);
  const hits = new Map();
  const srv = http.createServer(async (req, res) => {
    const clean = req.url.split("?")[0];
    hits.set(clean, (hits.get(clean) || 0) + 1);
    await new Promise((r) => setTimeout(r, 30));
    if (clean.includes("adv_bkg_stage_000042")) { res.writeHead(200); res.end(stage42); return; }
    if (clean.includes("adv_bkg_stage_000043")) { res.writeHead(200); res.end(stage43); return; }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  const site = tmpDir("ournotes-cloud-lock-");
  fs.mkdirSync(path.join(site, "stories"), { recursive: true });
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  const baseUrl = `http://127.0.0.1:${port}/assets`;
  try {
    const scriptA = { beats: [{ scene: "adv_bkg_stage_000042" }] };
    const scriptB = { beats: [{ scene: "adv_bkg_stage_000042" }, { scene: "adv_bkg_stage_000043" }] };
    await Promise.all([
      materializeSiteStoryAssets({ site, script: scriptA, language: "zh-Hans", storageBaseUrl: baseUrl, assetBaseUrl: baseUrl, allowPrivateUrl: true, logger: quietLogger() }),
      materializeSiteStoryAssets({ site, script: scriptB, language: "zh-Hans", storageBaseUrl: baseUrl, assetBaseUrl: baseUrl, allowPrivateUrl: true, logger: quietLogger() }),
    ]);
    const hit42 = [...hits.entries()].find(([k]) => k.includes("adv_bkg_stage_000042"))?.[1] || 0;
    assert.equal(hit42, 1, "concurrent requests for the same asset coalesce to one download");
    const pool = JSON.parse(fs.readFileSync(path.join(site, "cloud-pool.json"), "utf8"));
    assert.ok(pool.stages.adv_bkg_stage_000042 && pool.stages.adv_bkg_stage_000043, "serialized pool merge preserves all concurrent additions");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("synthesizeStagePrefab populates valid focusPoints and materializeSiteStoryAssets/buildSiteStory auto-repair empty cloud-pool entries", async () => {
  const synth = synthesizeStagePrefab("adv_bkg_stage_000185", 2048, 1119, "textures/adv_bkg_stage_000185-adv_bkg_stage_000185.webp");
  const advComp = synth.nodes[0].components.find((c) => c.class === "AdvStage");
  assert.equal(advComp._focusPointsCollection._entries.length, 5);
  for (const row of advComp._focusPointsCollection._entries) {
    assert.equal(row._focusPointPositions.length, 9);
  }

  const site = tmpDir("ournotes-stage-repair-");
  fs.mkdirSync(path.join(site, "stories"), { recursive: true });
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  fs.mkdirSync(path.join(site, "models"), { recursive: true });
  const putBlob = (data, ext = "json") => {
    const b = gzAsset(data, ext);
    fs.writeFileSync(path.join(site, b.rel), b.raw);
    return b.entry;
  };
  const baseScene = putBlob({ stages: { "Adv/Stage/adv_bkg_stage_000152/adv_bkg_stage_000152": { nodes: [] } } });
  const baseStory = putBlob({ models: { anon: "adv_live2d_anon_002_live_01" } });
  const baseEp = putBlob({ advId: 10610, commands: [{ cmd: "Stage", TargetAssetName: "Adv/Stage/adv_bkg_stage_000152/adv_bkg_stage_000152" }], text: {}, sounds: {}, cuesheets: {} });
  const uiTrans = putBlob({});
  const uiTex = putBlob({});
  const fonts = putBlob({ texts: {}, textures: {}, materials: {}, materialKeywords: {} });
  const anonPrefab = putBlob({
    nodes: [{ components: [{ class: "Live2DCharacter", _motionList: ["idle01_L", "idle01_C", "idle01_R"], _expressionList: ["idle01"], DefaultMotionName: "idle01_C", DefaultExpressionName: "idle01" }] }],
  });
  fs.writeFileSync(path.join(site, "models", "adv_live2d_anon_002_live_01.json"), JSON.stringify({ key: "anon", files: { "anon.prefab.json": anonPrefab } }));
  fs.writeFileSync(path.join(site, "stories", "10610.json"), JSON.stringify({
    format: "ournotes.story-manifest/2",
    advId: 10610,
    language: "zh-Hans",
    models: { adv_live2d_anon_002_live_01: "models/adv_live2d_anon_002_live_01.json" },
    files: { "scene.json": baseScene, "story.json": baseStory, "episode.json": baseEp },
    languages: { "zh-Hans": { files: { "ui/ui.json": { parts: [["transitions", uiTrans.asset, uiTrans.size, uiTrans.stored], ["textures", uiTex.asset, uiTex.size, uiTex.stored]], size: 100 }, "ui/fonts.json": fonts } } },
  }));

  // Seed cloud-pool.json with a broken synthesized stage whose _entries is [] (matching cached adv_bkg_stage_000185).
  const brokenPrefab = structuredClone(synth);
  brokenPrefab.nodes[0].components[0]._focusPointsCollection._entries = [];
  const texEntry = putBlob(tinyVp8lWebp(2048, 1119), "webp");
  fs.writeFileSync(path.join(site, "cloud-pool.json"), JSON.stringify({
    format: "ournotes.cloud-pool/1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stages: {
      adv_bkg_stage_000185: {
        key: "Adv/Stage/adv_bkg_stage_000185/adv_bkg_stage_000185",
        prefab: brokenPrefab,
        shaders: [],
        files: { "textures/adv_bkg_stage_000185-adv_bkg_stage_000185.webp": texEntry },
      },
    },
    audio: {},
  }, null, 2));

  // Even without running materializeSiteStoryAssets first, buildSiteStory repairs the bundled scene.json stage.
  const script = {
    format: "ournotes.story-script/1",
    base: "stories/10610.json",
    language: "zh-Hans",
    title: "舞台修复测试",
    cast: { anon: { model: "adv_live2d_anon_002_live_01", name: "千早爱音" } },
    beats: [
      { scene: "adv_bkg_stage_000185", positions: { anon: "center" } },
      { say: "anon", text: "舞台切换正常。" },
    ],
  };
  const built = buildSiteStory({ site, baseRel: "stories/10610.json", script, advId: 900185, language: "zh-Hans" });
  assert.equal(built.errors, undefined, JSON.stringify(built.errors));
  const sceneEntry = built.manifest.files["scene.json"];
  const bundledStages = Array.isArray(sceneEntry.parts)
    ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, sceneEntry.parts.find(([k]) => k === "stages")[1]))).toString("utf8"))
    : JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, sceneEntry.asset))).toString("utf8")).stages;
  const bundledAdv = bundledStages["Adv/Stage/adv_bkg_stage_000185/adv_bkg_stage_000185"].nodes[0].components[0];
  assert.equal(bundledAdv._focusPointsCollection._entries.length, 5);
  assert.equal(bundledAdv._focusPointsCollection._entries[0]._focusPointPositions.length, 9);

  // materializeSiteStoryAssets also auto-repairs the cached cloud-pool.json on disk with zero network hits.
  await materializeSiteStoryAssets({
    site,
    script,
    language: "zh-Hans",
    storageBaseUrl: "http://127.0.0.1:1",
    assetBaseUrl: "http://127.0.0.1:1",
    allowPrivateUrl: true,
    logger: quietLogger(),
  });
  const repairedPool = JSON.parse(fs.readFileSync(path.join(site, "cloud-pool.json"), "utf8"));
  const poolEntries = repairedPool.stages.adv_bkg_stage_000185.prefab.nodes[0].components[0]._focusPointsCollection._entries;
  assert.equal(poolEntries.length, 5);
  assert.equal(poolEntries[0]._focusPointPositions.length, 9);
});

test("donor-backed SE cues resolve under audio/<cue>/ in donor manifests (sound_se_adv_pulsation & sound_se_adv_clap_solo) and fallback handles per-cue CDN paths", async () => {
  const blobMap = new Map();
  const addBlob = (b) => { blobMap.set(b.rel, b.raw); return b.entry; };

  const makeDonorManifest = (advId, cue, soundId, sheetId) => {
    const m4a = addBlob(gzAsset(Buffer.from(`M4A-${cue}`), "m4a"));
    const cues = addBlob(gzAsset({ [cue]: { file: `${cue}.m4a`, sampleRate: 48000, samples: 32000, channels: 2, categories: ["Se"] } }));
    const ep = addBlob(gzAsset({
      advId,
      commands: [],
      text: {},
      sounds: { [soundId]: { _id: soundId, _category: 1, _soundCueSheetID: sheetId, _cueName: cue } },
      cuesheets: { [sheetId]: { _id: sheetId, _cueSheetName: cue } },
    }));
    return {
      format: "ournotes.story-manifest/2",
      advId,
      language: "zh-Hans",
      files: {
        "episode.json": ep,
        [`audio/${cue}/${cue}.m4a`]: m4a,
        [`audio/${cue}/cues.json`]: cues,
      },
    };
  };

  const donor10980 = makeDonorManifest(10980, "sound_se_adv_pulsation", 2100000000101, 2100000000101);
  const donor10524 = makeDonorManifest(10524, "sound_se_adv_clap_solo", 2100000000202, 2100000000202);
  // Empty donor manifest for a cue that falls back to per-cue CDN path after Cri/Sound/sound_se_adv/... 404s.
  const donorEmpty = { format: "ournotes.story-manifest/2", advId: 10061, language: "zh-Hans", files: {} };

  const requestedPaths = [];
  const srv = http.createServer((req, res) => {
    const clean = req.url.split("?")[0];
    requestedPaths.push(clean);
    if (clean === "/storage/stories/10980.json") { res.writeHead(200); res.end(JSON.stringify(donor10980)); return; }
    if (clean === "/storage/stories/10524.json") { res.writeHead(200); res.end(JSON.stringify(donor10524)); return; }
    if (clean === "/storage/stories/10061.json") { res.writeHead(200); res.end(JSON.stringify(donorEmpty)); return; }
    if (clean.startsWith("/storage/assets/")) {
      const rel = clean.slice("/storage/".length);
      if (blobMap.has(rel)) { res.writeHead(200); res.end(blobMap.get(rel)); return; }
    }
    if (clean === "/assets/zh-Hans/Cri/Sound/sound_se_adv_clap_min_loop/sound_se_adv_clap_min_loop.m4a") {
      res.writeHead(200);
      res.end(Buffer.from("FALLBACK-CLAP-MIN"));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  const storageBaseUrl = `http://127.0.0.1:${port}/storage`;
  const assetBaseUrl = `http://127.0.0.1:${port}/assets`;

  const site = tmpDir("ournotes-se-donor-");
  fs.mkdirSync(path.join(site, "stories"), { recursive: true });
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  fs.mkdirSync(path.join(site, "models"), { recursive: true });
  const putBlob = (data, ext = "json") => {
    const b = gzAsset(data, ext);
    fs.writeFileSync(path.join(site, b.rel), b.raw);
    return b.entry;
  };
  const baseScene = putBlob({ stages: { "Adv/Stage/adv_bkg_stage_000152/adv_bkg_stage_000152": { nodes: [] } } });
  const baseStory = putBlob({ models: { anon: "adv_live2d_anon_002_live_01" } });
  const baseEp = putBlob({ advId: 10610, commands: [{ cmd: "Stage", TargetAssetName: "Adv/Stage/adv_bkg_stage_000152/adv_bkg_stage_000152" }], text: {}, sounds: {}, cuesheets: {} });
  const uiTrans = putBlob({});
  const uiTex = putBlob({});
  const fonts = putBlob({ texts: {}, textures: {}, materials: {}, materialKeywords: {} });
  const anonPrefab = putBlob({
    nodes: [{ components: [{ class: "Live2DCharacter", _motionList: ["idle01_L", "idle01_C", "idle01_R"], _expressionList: ["idle01"], DefaultMotionName: "idle01_C", DefaultExpressionName: "idle01" }] }],
  });
  fs.writeFileSync(path.join(site, "models", "adv_live2d_anon_002_live_01.json"), JSON.stringify({ key: "anon", files: { "anon.prefab.json": anonPrefab } }));
  fs.writeFileSync(path.join(site, "stories", "10610.json"), JSON.stringify({
    format: "ournotes.story-manifest/2",
    advId: 10610,
    language: "zh-Hans",
    models: { adv_live2d_anon_002_live_01: "models/adv_live2d_anon_002_live_01.json" },
    files: { "scene.json": baseScene, "story.json": baseStory, "episode.json": baseEp },
    languages: { "zh-Hans": { files: { "ui/ui.json": { parts: [["transitions", uiTrans.asset, uiTrans.size, uiTrans.stored], ["textures", uiTex.asset, uiTex.size, uiTex.stored]], size: 100 }, "ui/fonts.json": fonts } } },
  }));

  try {
    const script = {
      format: "ournotes.story-script/1",
      base: "stories/10610.json",
      language: "zh-Hans",
      title: "SE Donor 测试",
      cast: { anon: { model: "adv_live2d_anon_002_live_01", name: "千早爱音" } },
      beats: [
        { scene: "adv_bkg_stage_000152", positions: { anon: "center" } },
        { say: "anon", text: "心跳加速。", se: "sound_se_adv_pulsation" },
        { say: "anon", text: "拍手！", se: "sound_se_adv_clap_solo" },
        { say: "anon", text: "零星掌声。", se: "sound_se_adv_clap_min_loop" },
      ],
    };

    const mat = await materializeSiteStoryAssets({
      site,
      script,
      language: "zh-Hans",
      storageBaseUrl,
      assetBaseUrl,
      allowPrivateUrl: true,
      logger: quietLogger(),
    });
    assert.ok(mat.materialized.includes("sound_se_adv_pulsation"));
    assert.ok(mat.materialized.includes("sound_se_adv_clap_solo"));
    assert.ok(mat.materialized.includes("sound_se_adv_clap_min_loop"));
    assert.ok(!requestedPaths.includes("/assets/zh-Hans/Cri/Sound/sound_se_adv/sound_se_adv_pulsation.m4a"),
              "donor-backed sound_se_adv_pulsation must not fall back to CDN 404");
    assert.ok(!requestedPaths.includes("/assets/zh-Hans/Cri/Sound/sound_se_adv/sound_se_adv_clap_solo.m4a"),
              "donor-backed sound_se_adv_clap_solo must not fall back to CDN 404");

    const poolDoc = JSON.parse(fs.readFileSync(path.join(site, "cloud-pool.json"), "utf8"));
    assert.equal(poolDoc.audio.sound_se_adv_pulsation.sheet, "sound_se_adv_pulsation");
    assert.ok(poolDoc.audio.sound_se_adv_pulsation.files["audio/sound_se_adv_pulsation/sound_se_adv_pulsation.m4a"]);
    assert.equal(poolDoc.audio.sound_se_adv_clap_solo.sheet, "sound_se_adv_clap_solo");
    assert.ok(poolDoc.audio.sound_se_adv_clap_solo.files["audio/sound_se_adv_clap_solo/sound_se_adv_clap_solo.m4a"]);
    assert.equal(poolDoc.audio.sound_se_adv_clap_min_loop.sheet, "sound_se_adv_clap_min_loop");

    const built = buildSiteStory({ site, baseRel: "stories/10610.json", script, advId: 900199, language: "zh-Hans" });
    assert.equal(built.errors, undefined, JSON.stringify(built.errors));
    for (const cue of ["sound_se_adv_pulsation", "sound_se_adv_clap_solo", "sound_se_adv_clap_min_loop"]) {
      assert.ok(built.manifest.files[`audio/${cue}/cues.json`], `${cue} cues.json bundled`);
      assert.ok(built.manifest.files[`audio/${cue}/${cue}.m4a`], `${cue} .m4a bundled`);
      const cuesDoc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, built.manifest.files[`audio/${cue}/cues.json`].asset))).toString("utf8"));
      assert.equal(cuesDoc[cue]?.file, `${cue}.m4a`);
    }
    const builtStory = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, built.manifest.files["story.json"].asset))).toString("utf8"));
    assert.equal(builtStory.audio.sound_se_adv_pulsation, "audio/sound_se_adv_pulsation");
    assert.equal(builtStory.audio.sound_se_adv_clap_solo, "audio/sound_se_adv_clap_solo");
    assert.equal(builtStory.audio.sound_se_adv_clap_min_loop, "audio/sound_se_adv_clap_min_loop");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("partial focusPoints rows in baseSceneStages/cloud-pool and shared donor cuesheet IDs do not break buildSiteStory, and missing pool blobs re-materialize", async () => {
  const synth = synthesizeStagePrefab("adv_bkg_stage_000152", 2048, 1119, "textures/adv_bkg_stage_000152-adv_bkg_stage_000152.webp");
  const partialBaseStage = structuredClone(synth);
  // Non-empty _entries array whose row has empty _focusPointPositions (would crash field.js if unrepaired).
  partialBaseStage.nodes[0].components[0]._focusPointsCollection._entries = [{ _focusPointPositions: [] }];

  const blobMap = new Map();
  const addBlob = (b) => { blobMap.set(b.rel, b.raw); return b.entry; };
  // Single donor episode that assigns the same _soundCueSheetID (700) to two split SE cues.
  const pulseM4a = addBlob(gzAsset(Buffer.from("PULSE"), "m4a"));
  const pulseCues = addBlob(gzAsset({ sound_se_adv_pulsation: { file: "sound_se_adv_pulsation.m4a", sampleRate: 48000, samples: 24000, channels: 2, categories: ["Se"] } }));
  const clapM4a = addBlob(gzAsset(Buffer.from("CLAP"), "m4a"));
  const clapCues = addBlob(gzAsset({ sound_se_adv_clap_solo: { file: "sound_se_adv_clap_solo.m4a", sampleRate: 48000, samples: 24000, channels: 2, categories: ["Se"] } }));
  const sharedDonorEp = addBlob(gzAsset({
    advId: 10980,
    commands: [],
    text: {},
    sounds: {
      701: { _id: 701, _category: 1, _soundCueSheetID: 700, _cueName: "sound_se_adv_pulsation" },
      702: { _id: 702, _category: 1, _soundCueSheetID: 700, _cueName: "sound_se_adv_clap_solo" },
    },
    cuesheets: { 700: { _id: 700, _cueSheetName: "sound_se_adv" } },
  }));
  const donorManifest = {
    format: "ournotes.story-manifest/2",
    advId: 10980,
    language: "zh-Hans",
    files: {
      "episode.json": sharedDonorEp,
      "audio/sound_se_adv_pulsation/sound_se_adv_pulsation.m4a": pulseM4a,
      "audio/sound_se_adv_pulsation/cues.json": pulseCues,
      "audio/sound_se_adv_clap_solo/sound_se_adv_clap_solo.m4a": clapM4a,
      "audio/sound_se_adv_clap_solo/cues.json": clapCues,
    },
  };
  // Serve 10524 with the same split layout if requested, or 10980 for pulsation.
  const donor10524 = { ...donorManifest, advId: 10524 };

  const srv = http.createServer((req, res) => {
    const clean = req.url.split("?")[0];
    if (clean === "/storage/stories/10980.json") { res.writeHead(200); res.end(JSON.stringify(donorManifest)); return; }
    if (clean === "/storage/stories/10524.json") { res.writeHead(200); res.end(JSON.stringify(donor10524)); return; }
    if (clean.startsWith("/storage/assets/")) {
      const rel = clean.slice("/storage/".length);
      if (blobMap.has(rel)) { res.writeHead(200); res.end(blobMap.get(rel)); return; }
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  const storageBaseUrl = `http://127.0.0.1:${port}/storage`;
  const assetBaseUrl = `http://127.0.0.1:${port}/assets`;

  const site = tmpDir("ournotes-edge-repair-");
  fs.mkdirSync(path.join(site, "stories"), { recursive: true });
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  fs.mkdirSync(path.join(site, "models"), { recursive: true });
  const putBlob = (data, ext = "json") => {
    const b = gzAsset(data, ext);
    fs.writeFileSync(path.join(site, b.rel), b.raw);
    return b.entry;
  };
  const baseScene = putBlob({ stages: { "Adv/Stage/adv_bkg_stage_000152/adv_bkg_stage_000152": partialBaseStage } });
  const baseStory = putBlob({ models: { anon: "adv_live2d_anon_002_live_01" } });
  const baseEp = putBlob({ advId: 10610, commands: [{ cmd: "Stage", TargetAssetName: "Adv/Stage/adv_bkg_stage_000152/adv_bkg_stage_000152" }], text: {}, sounds: {}, cuesheets: {} });
  const uiTrans = putBlob({});
  const uiTex = putBlob({});
  const fonts = putBlob({ texts: {}, textures: {}, materials: {}, materialKeywords: {} });
  const anonPrefab = putBlob({
    nodes: [{ components: [{ class: "Live2DCharacter", _motionList: ["idle01_C"], _expressionList: ["idle01"], DefaultMotionName: "idle01_C", DefaultExpressionName: "idle01" }] }],
  });
  fs.writeFileSync(path.join(site, "models", "adv_live2d_anon_002_live_01.json"), JSON.stringify({ key: "anon", files: { "anon.prefab.json": anonPrefab } }));
  fs.writeFileSync(path.join(site, "stories", "10610.json"), JSON.stringify({
    format: "ournotes.story-manifest/2",
    advId: 10610,
    language: "zh-Hans",
    models: { adv_live2d_anon_002_live_01: "models/adv_live2d_anon_002_live_01.json" },
    files: { "scene.json": baseScene, "story.json": baseStory, "episode.json": baseEp },
    languages: { "zh-Hans": { files: { "ui/ui.json": { parts: [["transitions", uiTrans.asset, uiTrans.size, uiTrans.stored], ["textures", uiTex.asset, uiTex.size, uiTex.stored]], size: 100 }, "ui/fonts.json": fonts } } },
  }));

  // Seed cloud-pool.json with a stale audio entry whose blob on disk is missing: must re-materialize.
  fs.writeFileSync(path.join(site, "cloud-pool.json"), JSON.stringify({
    format: "ournotes.cloud-pool/1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stages: {},
    audio: {
      sound_se_adv_pulsation: {
        sheet: "sound_se_adv_pulsation",
        cue: "sound_se_adv_pulsation",
        kind: "se",
        files: { "audio/sound_se_adv_pulsation/sound_se_adv_pulsation.m4a": { asset: "assets/missing.m4a.gz", size: 5, stored: 5 } },
      },
    },
  }, null, 2));

  try {
    const script = {
      format: "ournotes.story-script/1",
      base: "stories/10610.json",
      language: "zh-Hans",
      title: "边界修复测试",
      cast: { anon: { model: "adv_live2d_anon_002_live_01", name: "千早爱音" } },
      beats: [
        { scene: "adv_bkg_stage_000152", positions: { anon: "center" } },
        { say: "anon", text: "一", se: "sound_se_adv_pulsation" },
        { say: "anon", text: "二", se: "sound_se_adv_clap_solo" },
      ],
    };
    const mat = await materializeSiteStoryAssets({
      site,
      script,
      language: "zh-Hans",
      storageBaseUrl,
      assetBaseUrl,
      allowPrivateUrl: true,
      logger: quietLogger(),
    });
    assert.ok(mat.materialized.includes("sound_se_adv_pulsation"), "stale missing blob in cloud-pool must re-materialize");
    assert.ok(mat.materialized.includes("sound_se_adv_clap_solo"));

    const built = buildSiteStory({ site, baseRel: "stories/10610.json", script, advId: 900200, language: "zh-Hans" });
    assert.equal(built.errors, undefined, JSON.stringify(built.errors));
    const sceneEntry = built.manifest.files["scene.json"];
    const bundledStages = Array.isArray(sceneEntry.parts)
      ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, sceneEntry.parts.find(([k]) => k === "stages")[1]))).toString("utf8"))
      : JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, sceneEntry.asset))).toString("utf8")).stages;
    const repairedAdv = bundledStages["Adv/Stage/adv_bkg_stage_000152/adv_bkg_stage_000152"].nodes[0].components[0];
    assert.equal(repairedAdv._focusPointsCollection._entries.length, 5);
    assert.equal(repairedAdv._focusPointsCollection._entries[0]._focusPointPositions.length, 9);

    const epDoc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(site, built.manifest.files["episode.json"].asset))).toString("utf8"));
    const sheetNames = Object.values(epDoc.cuesheets).map((c) => c._cueSheetName);
    assert.ok(sheetNames.includes("sound_se_adv_pulsation"));
    assert.ok(sheetNames.includes("sound_se_adv_clap_solo"));
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
