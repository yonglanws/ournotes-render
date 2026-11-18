// Zero-local-site cloud runtime bootstrap & on-demand asset materializer for BanG Dream! Our Notes.
// Modeled after bdon.moe (`storage.bdon.moe/moenotes` + `assets.bdon.moe`):
// - `ensureCloudRuntimeBase` initializes a minimal runnable site under `paths.cache/cloud-site` without
//   downloading `audio/adv_voice_*` or all 1,021 story manifests.
// - `materializeSiteStoryAssets` materializes only the Live2D models, stages, BGM/SE cues, frames, post-effects,
//   particle effects, stills and transitions selected by a given story — working seamlessly for both `cloud-site`
//   and a partial local `resources/site` without deleting existing files.
import fs from "node:fs";
import path from "node:path";
import {
  ensureStageFocusPoints,
  loadCloudCatalog,
  probeM4aCue,
  synthesizeStagePrefab,
  webpDimensions,
} from "./cloudCatalogData.js";
import {
  collectDeps,
  collectStageVolumeProfiles,
  decodeRemoteAsset,
  ensureOfficialAssetBundles,
  fetchRemoteBytes,
  isSafeRelPath,
  OFFICIAL_ASSET_BASE_URL,
  OFFICIAL_ASSET_SEED_EPISODES,
  OFFICIAL_BUNDLE_BASE_URL,
  readEntry,
  readSceneStages,
  readShadersMap,
  textureEntries,
  writeAsset,
  writeAtomic,
} from "../tools/site-story.mjs";

export const DEFAULT_CLOUD_SEED_ADV_ID = "10610";
export const CLOUD_MOTIONSYNC_URL = `${OFFICIAL_BUNDLE_BASE_URL}/vendor/cubism-motionsync-core-5.0.4/live2dcubismmotionsynccore.min.js`;
export const CUBISM_CORE_CDN_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";

const cleanBaseUrl = (u) => String(u || "").replace(/\/+$/, "");

// Per-asset in-flight download lock so concurrent renders share one network download instead of duplicating it,
// and per-site serialized index updates so cloud-pool.json / models.json / official-bundles.json never lose entries.
const inFlightAssetLocks = new Map();
const withAssetLock = (key, fn) => {
  const existing = inFlightAssetLocks.get(key);
  if (existing) return existing;
  const run = Promise.resolve().then(fn).finally(() => {
    if (inFlightAssetLocks.get(key) === run) inFlightAssetLocks.delete(key);
  });
  inFlightAssetLocks.set(key, run);
  return run;
};

const siteIndexLocks = new Map();
const withSiteIndexLock = (site, fn) => {
  const key = path.resolve(site);
  const prev = siteIndexLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  siteIndexLocks.set(key, tail);
  tail.finally(() => {
    if (siteIndexLocks.get(key) === tail) siteIndexLocks.delete(key);
  });
  return run;
};

const writeSafeRelFile = (dir, rel, bytes) => {
  if (!isSafeRelPath(rel)) throw new Error(`unsafe relative path: ${rel}`);
  const dest = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  writeAtomic(dest, bytes);
  return dest;
};

const ensureRemoteBlob = async (dir, baseUrl, relAsset, fetchOpts, fallbackBaseUrl = "") => {
  if (!relAsset || !isSafeRelPath(relAsset)) return false;
  const dest = path.join(dir, ...relAsset.split("/"));
  if (fs.existsSync(dest)) return true;
  return withAssetLock(`blob:${path.resolve(dest)}`, async () => {
    if (fs.existsSync(dest)) return true;
    try {
      const raw = await fetchRemoteBytes(`${cleanBaseUrl(baseUrl)}/${relAsset}`, fetchOpts);
      writeSafeRelFile(dir, relAsset, raw);
      return true;
    } catch (err) {
      if (fallbackBaseUrl && fallbackBaseUrl !== baseUrl) {
        const raw = await fetchRemoteBytes(`${cleanBaseUrl(fallbackBaseUrl)}/${relAsset}`, fetchOpts);
        writeSafeRelFile(dir, relAsset, raw);
        return true;
      }
      throw err;
    }
  });
};

const collectEntryAssetRels = (entry) => {
  if (!entry || typeof entry !== "object") return [];
  if (Array.isArray(entry.parts)) return entry.parts.map((p) => p?.[1]).filter(Boolean);
  return entry.asset ? [entry.asset] : [];
};

const manifestVoiceFilter = (files = {}) => Object.fromEntries(
  Object.entries(files).filter(([k]) => !/^audio\/adv_voice_/i.test(k)),
);

const isRuntimeSeedComplete = (dir, seedRel, lang) => {
  const manifestFile = path.join(dir, ...seedRel.split("/"));
  if (!fs.existsSync(path.join(dir, "stories.json")) || !fs.existsSync(path.join(dir, "models.json"))) return false;
  if (!fs.existsSync(manifestFile)) return false;
  try {
    const doc = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const refs = [
      ...Object.values(doc.files || {}),
      ...Object.values(doc.languages?.[lang]?.files || {}),
    ];
    for (const ref of refs) {
      for (const rel of collectEntryAssetRels(ref)) {
        if (!fs.existsSync(path.join(dir, ...rel.split("/")))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

// Initializes a lightweight cloud runtime base under `dir` (default: `<cache>/cloud-site`) when no local site is
// configured. Fetches `models.json` (TW), `jp/models.json` (JP), MotionSync core, and non-voice runtime assets from a
// minimal seed story without downloading `audio/adv_voice_*` or the full 1,021-story archive.
export const ensureCloudRuntimeBase = async ({
  dir,
  baseUrl = OFFICIAL_BUNDLE_BASE_URL,
  coreUrl = CUBISM_CORE_CDN_URL,
  motionSyncUrl = CLOUD_MOTIONSYNC_URL,
  language = "zh-Hans",
  seedAdvId = DEFAULT_CLOUD_SEED_ADV_ID,
  timeoutMs = 20000,
  allowPrivateUrl = false,
  proxyUrl = "",
  logger = console,
} = {}) => {
  if (!dir) throw new Error("ensureCloudRuntimeBase: dir is required");
  const rootDir = path.resolve(dir);
  fs.mkdirSync(path.join(rootDir, "stories"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "models"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "vendor"), { recursive: true });

  const cleanStorage = cleanBaseUrl(baseUrl);
  const fetchOpts = { timeoutMs, allowPrivateUrl, proxyUrl };
  const lang = language || "zh-Hans";
  const seedId = String(seedAdvId || DEFAULT_CLOUD_SEED_ADV_ID).replace(/\.json$/i, "");
  const seedRel = `stories/${seedId}.json`;

  const motionMainDest = path.join(rootDir, "vendor", "live2dcubismmotionsynccore.min.js");
  const motionSubRel = "vendor/cubism-motionsync-core-5.0.4/live2dcubismmotionsynccore.min.js";
  const motionSubDest = path.join(rootDir, ...motionSubRel.split("/"));
  const coreDest = path.join(rootDir, "vendor", "live2dcubismcore.min.js");

  const downloaded = [];

  if (!fs.existsSync(path.join(rootDir, "models.json")) || !fs.existsSync(path.join(rootDir, "jp", "models.json"))) {
    const twRaw = await fetchRemoteBytes(`${cleanStorage}/models.json`, fetchOpts);
    const twDoc = JSON.parse(twRaw.toString("utf8"));
    let jpDoc = { models: [] };
    try {
      const jpRaw = await fetchRemoteBytes(`${cleanStorage}/jp/models.json`, fetchOpts);
      jpDoc = JSON.parse(jpRaw.toString("utf8"));
      writeSafeRelFile(rootDir, "jp/models.json", jpRaw);
      downloaded.push("jp/models.json");
    } catch (e) {
      logger.warn?.(`cloud-site: jp/models.json unavailable (${e.message})`);
    }
    const mergedModels = Array.isArray(twDoc.models) ? [...twDoc.models] : [];
    const haveModelIds = new Set(mergedModels.map((m) => m?.id).filter(Boolean));
    for (const jm of Array.isArray(jpDoc.models) ? jpDoc.models : []) {
      if (jm?.id && !haveModelIds.has(jm.id)) {
        haveModelIds.add(jm.id);
        mergedModels.push({ ...jm, manifest: `models/${jm.id}.json` });
      }
    }
    writeSafeRelFile(rootDir, "models.json", Buffer.from(JSON.stringify({ ...twDoc, models: mergedModels }, null, 2)));
    downloaded.push("models.json");
  }

  if (!fs.existsSync(motionMainDest) || !fs.existsSync(motionSubDest)) {
    try {
      const msBytes = await fetchRemoteBytes(motionSyncUrl || `${cleanStorage}/${motionSubRel}`, fetchOpts);
      writeSafeRelFile(rootDir, "vendor/live2dcubismmotionsynccore.min.js", msBytes);
      writeSafeRelFile(rootDir, motionSubRel, msBytes);
      downloaded.push("vendor/live2dcubismmotionsynccore.min.js");
    } catch (e) {
      logger.warn?.(`cloud-site: MotionSync core download failed (${e.message})`);
    }
  }

  if (coreUrl && !fs.existsSync(coreDest)) {
    try {
      const coreBytes = await fetchRemoteBytes(coreUrl, fetchOpts);
      writeSafeRelFile(rootDir, "vendor/live2dcubismcore.min.js", coreBytes);
      downloaded.push("vendor/live2dcubismcore.min.js");
    } catch (e) {
      logger.warn?.(`cloud-site: Cubism core download skipped (${e.message})`);
    }
  }

  if (!isRuntimeSeedComplete(rootDir, seedRel, lang)) {
    let remoteIndex = { stories: [] };
    try {
      remoteIndex = JSON.parse((await fetchRemoteBytes(`${cleanStorage}/stories.json`, fetchOpts)).toString("utf8"));
    } catch (e) {
      logger.warn?.(`cloud-site: stories.json fetch failed (${e.message})`);
    }
    const remoteStories = Array.isArray(remoteIndex?.stories) ? remoteIndex.stories : [];
    const chosenEntry = remoteStories.find((s) => String(s?.advId ?? s?.id) === seedId)
      || remoteStories.find((s) => s?.manifest && (!lang || !Array.isArray(s.languages) || s.languages.includes(lang)))
      || { id: seedId, advId: Number(seedId) || seedId, manifest: seedRel, languages: [lang], titles: { [lang]: seedId } };
    const actualRel = chosenEntry.manifest || seedRel;
    if (!isSafeRelPath(actualRel)) throw new Error(`unsafe seed manifest path: ${actualRel}`);

    const rawManifest = JSON.parse((await fetchRemoteBytes(`${cleanStorage}/${actualRel}`, fetchOpts)).toString("utf8"));
    const cleanFiles = manifestVoiceFilter(rawManifest.files || {});
    const targetLang = rawManifest.languages?.[lang] ? lang : (rawManifest.language || Object.keys(rawManifest.languages || {})[0] || lang);
    const langFiles = manifestVoiceFilter(rawManifest.languages?.[targetLang]?.files || {});

    const allRefs = [...Object.values(cleanFiles), ...Object.values(langFiles)];
    const blobRels = [...new Set(allRefs.flatMap(collectEntryAssetRels))];
    for (const rel of blobRels) {
      await ensureRemoteBlob(rootDir, cleanStorage, rel, fetchOpts);
    }

    const strippedManifest = {
      ...rawManifest,
      language: targetLang,
      audio: false,
      files: cleanFiles,
      languages: targetLang ? { [targetLang]: { files: langFiles } } : {},
    };
    writeSafeRelFile(rootDir, actualRel, Buffer.from(JSON.stringify(strippedManifest, null, 2)));
    downloaded.push(actualRel);

    const localIndexPath = path.join(rootDir, "stories.json");
    let localStories = [];
    if (fs.existsSync(localIndexPath)) {
      try {
        const cur = JSON.parse(fs.readFileSync(localIndexPath, "utf8"));
        if (Array.isArray(cur?.stories)) localStories = cur.stories;
      } catch { /* rebuild index cleanly */ }
    }
    const seedIndexEntry = {
      id: String(chosenEntry.id ?? chosenEntry.advId ?? seedId),
      advId: Number(chosenEntry.advId ?? chosenEntry.id) || chosenEntry.advId || seedId,
      manifest: actualRel,
      playbackMode: 0,
      language: targetLang,
      languages: [targetLang],
      titles: chosenEntry.titles || rawManifest.story?.titles || { [targetLang]: seedId },
      audio: false,
    };
    const withoutSeed = localStories.filter((s) => s?.manifest !== actualRel);
    writeSafeRelFile(rootDir, "stories.json", Buffer.from(JSON.stringify({
      format: remoteIndex.format || "ournotes.stories/1",
      stories: [seedIndexEntry, ...withoutSeed],
    }, null, 2)));
    downloaded.push("stories.json");
  }

  return { dir: rootDir, downloaded, seedManifest: seedRel };
};

const extractRequestedAssets = (script) => {
  const models = new Set();
  const stages = new Set();
  const music = new Set();
  const sounds = new Set();
  const frames = new Set();
  const postEffects = new Set();
  const effects = new Set();
  const stills = new Set();
  const transitions = new Set();

  if (!script || typeof script !== "object") {
    return { models, stages, music, sounds, frames, postEffects, effects, stills, transitions };
  }

  for (const c of Array.isArray(script.cast) ? script.cast : Object.values(script.cast || {})) {
    if (typeof c === "string" && c.trim()) models.add(c.trim());
    else if (c && typeof c === "object" && c.model) models.add(String(c.model).trim());
  }
  if (script.setting?.stage) stages.add(String(script.setting.stage).trim());
  if (script.setting?.music && script.setting.music !== "stop") music.add(String(script.setting.music).trim());

  const visitBeat = (b) => {
    if (!b || typeof b !== "object") return;
    if (b.scene && b.scene !== "none") stages.add(String(b.scene).trim());
    if (b.stage) stages.add(String(b.stage).trim());
    if (b.bg && b.bg !== "none") stages.add(String(b.bg).trim());
    const bgm = b.music || b.bgm;
    if (bgm && bgm !== "stop") music.add(String(bgm).trim());
    const se = b.se || b.sfx;
    if (se) sounds.add(String(se).trim());
    if (b.frame) frames.add(String(b.frame).trim());
    if (b.postEffect) postEffects.add(String(b.postEffect).trim());
    if (b.effect) effects.add(String(b.effect).trim());
    if (b.still) stills.add(String(b.still).trim());
    if (b.fadeRule) transitions.add(String(b.fadeRule).trim());
    if (b.transition && b.transition !== "dissolve" && b.transition !== "fade") transitions.add(String(b.transition).trim());
    if (b.in && b.in !== "dissolve") transitions.add(String(b.in).trim());
    if (b.out && b.out !== "dissolve") transitions.add(String(b.out).trim());
    if (Array.isArray(b.actions)) for (const a of b.actions) visitBeat(a);
    if (Array.isArray(b.parallel)) for (const a of b.parallel) visitBeat(a);
  };

  for (const b of Array.isArray(script.beats) ? script.beats : []) visitBeat(b);
  for (const sc of Array.isArray(script.scenes) ? script.scenes : []) {
    visitBeat(sc);
    for (const b of Array.isArray(sc?.beats) ? sc.beats : []) visitBeat(b);
  }
  return { models, stages, music, sounds, frames, postEffects, effects, stills, transitions };
};

const scanLocalAssets = (site) => {
  const stageIds = new Set();
  const cueFiles = new Map();
  const absorbManifest = (m) => {
    if (!m?.files) return;
    if (m.files["scene.json"]) {
      try {
        const sc = readSceneStages(site, m);
        for (const k of Object.keys(sc.stages || {})) stageIds.add(k.split("/").pop());
      } catch { /* ignore partial */ }
    }
    for (const rel of Object.keys(m.files)) {
      const mAudio = /^audio\/([^/]+)\/([^/]+)\.(?:m4a|wav|mp3|ogg|flac|aac|bin)$/i.exec(rel);
      if (mAudio) {
        const [, sheet, cue] = mAudio;
        if (!cueFiles.has(cue)) cueFiles.set(cue, sheet);
      }
    }
  };

  const storiesDir = path.join(site, "stories");
  if (fs.existsSync(storiesDir)) {
    for (const f of fs.readdirSync(storiesDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        absorbManifest(JSON.parse(fs.readFileSync(path.join(storiesDir, f), "utf8")));
      } catch { /* ignore corrupt */ }
    }
  }
  const poolPath = path.join(site, "cloud-pool.json");
  let cloudPool = { format: "ournotes.cloud-pool/1", updatedAt: "", stages: {}, audio: {} };
  let repairedStages = false;
  if (fs.existsSync(poolPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(poolPath, "utf8"));
      if (prev && typeof prev === "object") {
        cloudPool = {
          format: "ournotes.cloud-pool/1",
          updatedAt: prev.updatedAt || "",
          stages: { ...(prev.stages || {}) },
          audio: { ...(prev.audio || {}) },
        };
      }
      for (const [id, st] of Object.entries(cloudPool.stages)) {
        if (st?.prefab && ensureStageFocusPoints(st.prefab)) repairedStages = true;
        stageIds.add(id);
      }
      for (const [cue, au] of Object.entries(cloudPool.audio)) {
        if (au?.files && Object.keys(au.files).length) cueFiles.set(cue, au.sheet);
      }
    } catch { /* rebuild clean pool */ }
  }
  return { stageIds, cueFiles, cloudPool, repairedStages };
};

const findDonorAudioMatch = (files, cue, preferredSheet) => {
  if (!files || typeof files !== "object") return null;
  const candidates = [];
  const push = (s) => { if (s && !candidates.includes(s)) candidates.push(s); };
  push(preferredSheet);
  push(cue);
  for (const rel of Object.keys(files)) {
    const m = /^audio\/([^/]+)\/cues\.json$/i.exec(rel);
    if (m && !/^adv_voice_/i.test(m[1])) push(m[1]);
  }
  for (const rel of Object.keys(files)) {
    const m = /^audio\/([^/]+)\/([^/]+)\.(?:m4a|wav|mp3|ogg|flac|aac|bin)$/i.exec(rel);
    if (m && m[2] === cue && !/^adv_voice_/i.test(m[1])) push(m[1]);
  }
  for (const candSheet of candidates) {
    const cuesRel = `audio/${candSheet}/cues.json`;
    const prefix = `audio/${candSheet}/${cue}.`;
    const matchingAudio = Object.entries(files).filter(([rel]) => rel.startsWith(prefix));
    if (files[cuesRel] && matchingAudio.length) {
      return { donorSheet: candSheet, cuesRel, matchingAudio };
    }
  }
  for (const candSheet of candidates) {
    const prefix = `audio/${candSheet}/${cue}.`;
    const matchingAudio = Object.entries(files).filter(([rel]) => rel.startsWith(prefix));
    if (matchingAudio.length) {
      return { donorSheet: candSheet, cuesRel: null, matchingAudio };
    }
  }
  return null;
};

const modelAssetsPresent = (site, modelId) => {
  const mf = path.join(site, "models", `${modelId}.json`);
  if (!fs.existsSync(mf)) return false;
  try {
    const mm = JSON.parse(fs.readFileSync(mf, "utf8"));
    for (const entry of Object.values(mm.files || {})) {
      for (const rel of collectEntryAssetRels(entry)) {
        if (!fs.existsSync(path.join(site, ...rel.split("/")))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

const mapLimit = async (items, limit, fn) => {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

// Materializes any Live2D model, stage, BGM, SE, frame, post-effect, effect, still or rule transition
// referenced by `script` that is missing from `site` (whether `cache/cloud-site` or a partial `resources/site`).
export const materializeSiteStoryAssets = async ({
  site,
  script,
  language = "zh-Hans",
  storageBaseUrl = OFFICIAL_BUNDLE_BASE_URL,
  assetBaseUrl = OFFICIAL_ASSET_BASE_URL,
  allowPrivateUrl = false,
  proxyUrl = "",
  timeoutMs = 20000,
  signal = null,
  logger = console,
} = {}) => {
  if (!site) throw new Error("materializeSiteStoryAssets: site directory is required");
  if (!script) return { ok: true, materialized: [] };
  signal?.throwIfAborted?.();

  const cleanStorage = cleanBaseUrl(storageBaseUrl);
  const cleanAssets = cleanBaseUrl(assetBaseUrl);
  const fetchOpts = { timeoutMs, allowPrivateUrl, proxyUrl, signal };
  const lang = language || script.language || "zh-Hans";
  const cc = loadCloudCatalog();
  const req = extractRequestedAssets(script);
  const { stageIds: localStages, cueFiles: localCues, cloudPool, repairedStages } = scanLocalAssets(site);
  const donorManifests = new Map();
  const materialized = [];
  let poolDirty = repairedStages;

  const getDonorManifest = (advId) => {
    const key = String(advId);
    if (donorManifests.has(key)) return donorManifests.get(key);
    const p = (async () => {
      try {
        const bytes = await fetchRemoteBytes(`${cleanStorage}/stories/${key}.json`, fetchOpts);
        return JSON.parse(bytes.toString("utf8"));
      } catch (e) {
        if (signal?.aborted) throw signal.reason || e;
        return null;
      }
    })();
    donorManifests.set(key, p);
    return p;
  };

  const mirrorManifestEntry = async (_rel, entry, remoteStorage = cleanStorage) => {
    if (!entry) return;
    const assetRels = collectEntryAssetRels(entry);
    await mapLimit(assetRels, 4, (assetRel) => {
      signal?.throwIfAborted?.();
      return ensureRemoteBlob(site, remoteStorage, assetRel, fetchOpts, cleanStorage);
    });
  };

  const pendingStages = {};
  const pendingAudio = {};

  // 1. Live2D Models
  const missingModels = [...req.models].filter((modelId) => !modelAssetsPresent(site, modelId));
  await mapLimit(missingModels, 4, async (modelId) => {
    signal?.throwIfAborted?.();
    const didMaterialize = await withAssetLock(`model:${path.resolve(site)}:${modelId}`, async () => {
      if (modelAssetsPresent(site, modelId)) return false;
      const meta = cc.modelMap.get(modelId);
      const candidates = meta?.region === "jp"
        ? [{ manifest: meta.manifest, remoteBase: `${cleanStorage}/jp` }, { manifest: `models/${modelId}.json`, remoteBase: cleanStorage }]
        : [{ manifest: meta?.manifest || `models/${modelId}.json`, remoteBase: cleanStorage },
           { manifest: `jp/models/${modelId}.json`, remoteBase: `${cleanStorage}/jp` }];
      let mm = null;
      let usedRemote = cleanStorage;
      for (const c of candidates) {
        signal?.throwIfAborted?.();
        try {
          const bytes = await fetchRemoteBytes(`${cleanStorage}/${c.manifest}`, fetchOpts);
          mm = JSON.parse(bytes.toString("utf8"));
          usedRemote = c.remoteBase;
          break;
        } catch (e) {
          if (signal?.aborted) throw signal.reason || e;
          /* try fallback region */
        }
      }
      if (!mm?.files) {
        logger.warn?.(`cloud-site: could not fetch model manifest for ${modelId}`);
        return false;
      }
      await mapLimit(Object.values(mm.files), 4, (entry) => mirrorManifestEntry(modelId, entry, usedRemote));
      writeSafeRelFile(site, `models/${modelId}.json`, Buffer.from(JSON.stringify(mm, null, 2)));
      await withSiteIndexLock(site, () => {
        const modelsIndexPath = path.join(site, "models.json");
        if (fs.existsSync(modelsIndexPath)) {
          try {
            const idx = JSON.parse(fs.readFileSync(modelsIndexPath, "utf8"));
            if (Array.isArray(idx.models)) {
              const hit = idx.models.find((m) => m?.id === modelId);
              if (!hit) {
                idx.models.push({ id: modelId, manifest: `models/${modelId}.json` });
                writeAtomic(modelsIndexPath, JSON.stringify(idx, null, 2));
              } else if (hit.manifest !== `models/${modelId}.json`) {
                hit.manifest = `models/${modelId}.json`;
                writeAtomic(modelsIndexPath, JSON.stringify(idx, null, 2));
              }
            }
          } catch { /* ignore */ }
        }
      });
      return true;
    });
    if (didMaterialize) materialized.push(modelId);
  });

  // 2. Stages
  const missingStages = [...req.stages].filter((stageId) => !localStages.has(stageId));
  await mapLimit(missingStages, 4, async (stageId) => {
    signal?.throwIfAborted?.();
    const stageEntry = await withAssetLock(`stage:${path.resolve(site)}:${stageId}`, async () => {
      const stageMeta = cc.stageMap.get(stageId);
      if (stageMeta?.donorAdvId != null) {
        const dm = await getDonorManifest(stageMeta.donorAdvId);
        if (dm?.files?.["scene.json"]) {
          try {
            await mapLimit(collectEntryAssetRels(dm.files["scene.json"]), 4,
              (assetRel) => ensureRemoteBlob(site, cleanStorage, assetRel, fetchOpts));
            const sc = readSceneStages(site, dm);
            const stageKey = Object.keys(sc.stages || {}).find((k) => k === stageId || k.endsWith(`/${stageId}`));
            if (stageKey && sc.stages[stageKey]) {
              const prefab = structuredClone(sc.stages[stageKey]);
              ensureStageFocusPoints(prefab);
              // Ensure volume profiles referenced only by name are hydrated from donor stage prefabs
              const vp = new Map();
              for (const other of Object.values(sc.stages)) collectStageVolumeProfiles(other, vp);
              const advComp = prefab.nodes?.flatMap((n) => n.components || []).find((c) => c?.class === "AdvStage");
              const profs = advComp?._allVolumeProfileCollection?._profiles;
              if (Array.isArray(profs)) {
                for (let i = 0; i < profs.length; i++) {
                  if (profs[i]?.name && !Array.isArray(profs[i].components) && vp.has(profs[i].name)) {
                    profs[i] = structuredClone(vp.get(profs[i].name));
                  }
                }
              }
              const texFiles = textureEntries(dm, stageId);
              await mapLimit(Object.entries(texFiles), 4, ([tRel, tEntry]) => mirrorManifestEntry(tRel, tEntry));
              if (dm.files["shaders/shaders.json"]) {
                await mapLimit(collectEntryAssetRels(dm.files["shaders/shaders.json"]), 4,
                  (ar) => ensureRemoteBlob(site, cleanStorage, ar, fetchOpts));
              }
              const donorShaders = readShadersMap(site, dm);
              const deps = collectDeps(prefab, dm.files || {}, donorShaders);
              await mapLimit(Object.entries(deps.files || {}), 4, ([dRel, dEntry]) => mirrorManifestEntry(dRel, dEntry));
              const stageShaderEntries = [];
              for (const [sName, sInfo] of deps.shaders || []) {
                await mapLimit(Object.entries(sInfo.files || {}), 4, ([sfRel, sfEntry]) => mirrorManifestEntry(sfRel, sfEntry));
                stageShaderEntries.push([sName, sInfo]);
              }
              return {
                key: stageKey,
                prefab,
                shaders: stageShaderEntries,
                files: { ...texFiles, ...(deps.files || {}) },
              };
            }
          } catch (e) {
            if (signal?.aborted) throw signal.reason || e;
            logger.warn?.(`cloud-site: donor stage ${stageId} fallback (${e.message})`);
          }
        }
      }
      try {
        const webpUrl = `${cleanAssets}/${encodeURIComponent(lang)}/Adv/Stage/${stageId}/data/${stageId}/${stageId}.webp`;
        const webpBytes = await fetchRemoteBytes(webpUrl, fetchOpts);
        const { width, height } = webpDimensions(webpBytes);
        const texEntry = writeAsset(site, webpBytes, "webp");
        const texRel = `textures/${stageId}-${stageId}.webp`;
        const prefab = synthesizeStagePrefab(stageId, width, height, texRel);
        return {
          key: `Adv/Stage/${stageId}/${stageId}`,
          prefab,
          shaders: [],
          files: { [texRel]: texEntry },
        };
      } catch (e) {
        if (signal?.aborted) throw signal.reason || e;
        logger.warn?.(`cloud-site: could not materialize stage ${stageId}: ${e.message}`);
        return null;
      }
    });
    if (stageEntry) {
      pendingStages[stageId] = stageEntry;
      localStages.add(stageId);
      materialized.push(stageId);
      poolDirty = true;
    }
  });

  // 3. BGM & SE Cues
  const audioTargets = [
    ...[...req.music].map((cue) => ({ cue, isBgm: true, meta: cc.musicMap.get(cue), sheet: cc.musicMap.get(cue)?.sheet || cue })),
    ...[...req.sounds].map((cue) => ({ cue, isBgm: false, meta: cc.soundMap.get(cue), sheet: cc.soundMap.get(cue)?.sheet || "sound_se_adv" })),
  ].filter(({ cue }) => !localCues.has(cue));
  await mapLimit(audioTargets, 4, async ({ cue, isBgm, meta, sheet }) => {
    signal?.throwIfAborted?.();
    const audioEntry = await withAssetLock(`audio:${path.resolve(site)}:${cue}`, async () => {
      if (meta?.donorAdvId != null) {
        const dm = await getDonorManifest(meta.donorAdvId);
        if (dm?.files) {
          try {
            const match = findDonorAudioMatch(dm.files, cue, sheet);
            if (match) {
              const { donorSheet, cuesRel, matchingAudio } = match;
              let cuesDoc = {};
              if (cuesRel) {
                await mirrorManifestEntry(cuesRel, dm.files[cuesRel]);
                cuesDoc = readEntry(site, dm.files[cuesRel]) || {};
              }
              const filesObj = {};
              await mapLimit(matchingAudio, 4, async ([aRel, aEntry]) => {
                await mirrorManifestEntry(aRel, aEntry);
                filesObj[aRel] = aEntry;
              });
              let cueEntry = cuesDoc[cue] || null;
              if (!cueEntry) {
                const [firstRel, firstEntry] = matchingAudio[0];
                const audioBytes = readEntry(site, firstEntry, "bytes");
                cueEntry = {
                  ...probeM4aCue(audioBytes, cue, isBgm),
                  file: path.posix.basename(firstRel),
                };
              }
              let row = null, cuesheet = null;
              if (dm.files["episode.json"]) {
                await mirrorManifestEntry("episode.json", dm.files["episode.json"]);
                const depEp = readEntry(site, dm.files["episode.json"]);
                const sEntry = Object.values(depEp.sounds || {}).find((r) => r?._cueName === cue);
                if (sEntry) {
                  row = sEntry;
                  const depSheet = depEp.cuesheets?.[sEntry._soundCueSheetID] || null;
                  cuesheet = depSheet
                    ? (depSheet._cueSheetName === donorSheet ? depSheet : { ...depSheet, _cueSheetName: donorSheet })
                    : null;
                }
              }
              return {
                sheet: donorSheet,
                cue,
                kind: isBgm ? "bgm" : "se",
                soundId: row?._id,
                sheetId: cuesheet?._id || row?._soundCueSheetID,
                row,
                cuesheet,
                cueEntry,
                files: filesObj,
              };
            }
          } catch (e) {
            if (signal?.aborted) throw signal.reason || e;
            logger.warn?.(`cloud-site: donor audio ${cue} fallback (${e.message})`);
          }
        }
      }
      const fallbackSheets = cue && cue !== sheet ? [sheet, cue] : [sheet];
      let lastAudioErr = null;
      for (const fbSheet of fallbackSheets) {
        try {
          const audioUrl = `${cleanAssets}/${encodeURIComponent(lang)}/Cri/Sound/${fbSheet}/${cue}.m4a`;
          const m4aBytes = await fetchRemoteBytes(audioUrl, fetchOpts);
          const m4aEntry = writeAsset(site, m4aBytes, "m4a");
          const cueEntry = probeM4aCue(m4aBytes, cue, isBgm);
          return {
            sheet: fbSheet,
            cue,
            kind: isBgm ? "bgm" : "se",
            cueEntry,
            files: { [`audio/${fbSheet}/${cue}.m4a`]: m4aEntry },
          };
        } catch (e) {
          if (signal?.aborted) throw signal.reason || e;
          lastAudioErr = e;
        }
      }
      logger.warn?.(`cloud-site: could not materialize audio ${cue}: ${lastAudioErr?.message || "not found"}`);
      return null;
    });
    if (audioEntry) {
      pendingAudio[cue] = audioEntry;
      localCues.set(cue, sheet);
      materialized.push(cue);
      poolDirty = true;
    }
  });

  if (poolDirty) {
    await withSiteIndexLock(site, () => {
      const poolPath = path.join(site, "cloud-pool.json");
      let latest = cloudPool;
      if (fs.existsSync(poolPath)) {
        try {
          const prev = JSON.parse(fs.readFileSync(poolPath, "utf8"));
          if (prev && typeof prev === "object") {
            latest = {
              format: "ournotes.cloud-pool/1",
              updatedAt: prev.updatedAt || "",
              stages: { ...(prev.stages || {}) },
              audio: { ...(prev.audio || {}) },
            };
          }
        } catch { /* merge into current */ }
      }
      for (const st of Object.values(latest.stages)) {
        if (st?.prefab) ensureStageFocusPoints(st.prefab);
      }
      Object.assign(latest.stages, pendingStages);
      Object.assign(latest.audio, pendingAudio);
      latest.updatedAt = new Date().toISOString();
      writeSafeRelFile(site, "cloud-pool.json", Buffer.from(JSON.stringify(latest, null, 2)));
    });
  }

  // 4. Frames / PostEffects / Effects / Stills / Transitions via targeted donors
  const needFx = req.frames.size || req.postEffects.size || req.effects.size || req.stills.size || req.transitions.size;
  if (needFx) {
    const donorIds = new Set();
    const collectDonors = (set, table) => {
      for (const rawKey of set) {
        const hit = table?.[rawKey]
          || Object.entries(table || {}).find(([k]) => k.toLowerCase() === rawKey.toLowerCase() || k.endsWith(`/${rawKey}`))?.[1];
        if (hit != null) donorIds.add(String(hit));
      }
    };
    collectDonors(req.frames, cc.donors?.frames);
    collectDonors(req.postEffects, cc.donors?.postEffects);
    collectDonors(req.effects, cc.donors?.effects);
    collectDonors(req.stills, cc.donors?.stills);
    collectDonors(req.transitions, cc.donors?.transitions);
    const fxRes = await withSiteIndexLock(site, () => ensureOfficialAssetBundles({
      site,
      baseUrl: cleanStorage,
      targets: {
        frames: [...req.frames],
        postEffects: [...req.postEffects],
        effects: [...req.effects],
        stills: [...req.stills],
        transitions: [...req.transitions],
      },
      seedEpisodes: [...donorIds, ...OFFICIAL_ASSET_SEED_EPISODES],
      scanIndex: donorIds.size === 0,
      timeoutMs,
      allowPrivateUrl,
      proxyUrl,
      signal,
    }));
    if (fxRes?.cached?.length) materialized.push(...fxRes.cached);
  }

  return { ok: true, materialized: [...new Set(materialized)] };
};

export { decodeRemoteAsset };
