// Compiles an ournotes.story-script/1 director script onto a site-format story site (ournotes.story-manifest/2),
// the format bdon.moe's story player serves. The site's own stage, music, models, motions and expressions are the
// vocabulary; the output is a new story manifest and its episode asset inside the site, so render-story can play it.
//
// This is the authoring bridge for sites that are not nnnotes product sites: the AI writer and the API queue use this
// same script format, and the product path compiles it with the same script library.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { compileScript, checkScript, cueLabel, fontFamily, parseScript, withBrowserFonts } from "../../scripts/lib/story-author/script.js";
import { STORY_LANGUAGES } from "../../src/story/params.js";
import { assertPublicHttpUrl, isPrivateAddress, resolvePublicUrl } from "../net/urlGuard.js";
import { ensureStageFocusPoints, loadCloudCatalog } from "../story/cloudCatalogData.js";
import { applyMusicGuide, applySoundGuide, applyStageGuide, loadResourceGuide } from "../story/resourceGuide.js";

export const OFFICIAL_ASSET_BASE_URL = "https://assets.bdon.moe";

const FIELD = (language) => {
  const field = STORY_LANGUAGES[language];
  if (!field) throw new Error(`unknown story language ${language}`);
  return field;
};

export const readAsset = (site, rel) => {
  let b = fs.readFileSync(path.join(site, rel));
  if (rel.endsWith(".gz")) b = zlib.gunzipSync(b);
  else if (rel.endsWith(".br")) b = zlib.brotliDecompressSync(b);
  return b;
};

// An entry of a site manifest: a file {asset,size,stored}, or parts [[key, asset, size, stored], ...] merged into one
// object (the prefab of a model is split this way).
export const readEntry = (site, entry, kind = "json") => {
  if (!entry) throw new Error("missing file entry");
  if (Array.isArray(entry.parts)) {
    const out = {};
    for (const [key, asset] of entry.parts) out[key] = JSON.parse(readAsset(site, asset).toString());
    return out;
  }
  const bytes = readAsset(site, entry.asset);
  return kind === "json" ? JSON.parse(bytes.toString()) : bytes;
};

export const writeAtomic = (file, data) => {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};

export const writeAsset = (site, bytes, ext = "json") => {
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const gz = zlib.gzipSync(bytes);
  const rel = `assets/${sha}.${ext}.gz`;
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  const dest = path.join(site, rel);
  // Content-addressed: identical bytes are already there. Skipping the rewrite also stops a second job from
  // truncating a font/asset another render page is streaming.
  if (!fs.existsSync(dest)) writeAtomic(dest, gz);
  return { asset: rel, size: bytes.length, stored: gz.length };
};

const unique = (list) => [...new Set(list)];

const TTS_SHEET = "ournotes_tts";
const TTS_SHEET_ID = 900001;
const TTS_SOUND_BASE = 900000;
const PUNCT_ONLY_RE = /^[\s….。、？！?!—～~（）()「」『』]+$/u;

const talkRowText = (episode, row, field = "") => {
  const rec = (row.AdvTextID && episode.text && episode.text[row.AdvTextID]) || row.lines || null;
  if (!rec || typeof rec !== "object") return "";
  const candidates = field ? [field, ...Object.keys(rec)] : Object.keys(rec);
  for (const key of candidates) {
    const val = rec[key];
    if (typeof val === "string" && val.length) return val.replace(/<[^>]*>/g, "");
  }
  return "";
};

// Adds synthesized voices to a site episode: one TTS cue sheet under audio/ournotes_tts, one WAV per Talk line, and
// VoiceIDs/voiceCues on the row. Also marks voiceless punctuation/ellipsis-only Talk rows with IgnoreLipSync: 1 so
// 0.1.8 does not flap mouths silently.
export const addSiteVoices = ({ site, episode, voices, field = "" }) => {
  const files = {}, cues = {};
  if (voices && voices.size) {
    episode.sounds = { ...(episode.sounds || {}) };
    episode.cuesheets = { ...(episode.cuesheets || {}) };
    episode.cuesheets[TTS_SHEET_ID] = { _cueSheetName: TTS_SHEET };
    for (const [beat, audio] of voices) {
      const row = episode.commands.find((c) => c.cmd === "Talk" && c.AdvTextID === `custom_line_${beat}`);
      if (!row) continue;
      const cue = audio.cueName || `tts_line_${beat}`;
      const name = `${cue}.wav`;
      const bytes = fs.readFileSync(audio.file);
      files[`audio/${TTS_SHEET}/${name}`] = writeAsset(site, bytes, "wav");
      cues[cue] = { file: name, sampleRate: audio.sampleRate, samples: audio.samples, channels: audio.channels,
                    categories: ["Voice"] };
      const soundId = TTS_SOUND_BASE + Number(beat);
      episode.sounds[soundId] = { _id: soundId, _category: 2, _soundCueSheetID: TTS_SHEET_ID, _cueName: cue,
                                  _cacheType: 0, _audioSyncedTimerEnabled: false, _isRandomPitch: false,
                                  _minPitch: 0, _maxPitch: 0, _note: "" };
      row.VoiceIDs = [soundId];
      row.voiceCues = [cue];
    }
    files[`audio/${TTS_SHEET}/cues.json`] = writeAsset(site, Buffer.from(JSON.stringify(cues)));
  }
  for (const row of episode.commands || []) {
    if (row.cmd !== "Talk") continue;
    const hasVoice = (Array.isArray(row.VoiceIDs) && row.VoiceIDs.length > 0) ||
                     (Array.isArray(row.voiceCues) && row.voiceCues.length > 0);
    if (hasVoice) continue;
    const text = talkRowText(episode, row, field);
    if (text && PUNCT_ONLY_RE.test(text)) row.IgnoreLipSync = 1;
  }
  return { files };
};

// model id -> {key, motions, expressions, defaultMotion, defaultExpression}
export const readModelActions = (site, id) => {
  const file = path.join(site, "models", `${id}.json`);
  const mm = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!mm.key || !mm.files) throw new Error(`${file}: not a model manifest`);
  const prefabName = Object.keys(mm.files).find((p) => p.endsWith(".prefab.json"));
  if (!prefabName) throw new Error(`${file}: no prefab`);
  const prefab = readEntry(site, mm.files[prefabName]);
  const nodes = prefab.nodes || [];
  const root = nodes.find((n) => (n.components || []).some((c) => c.class === "Live2DCharacter")) || nodes[0];
  const ch = root && (root.components || []).find((c) => c.class === "Live2DCharacter");
  if (!ch) throw new Error(`${file}: no Live2DCharacter`);
  let motions = (ch._motionList || []).map((m) => (typeof m === "string" ? m : m.clip || m.name)).filter(Boolean);
  const expressions = (ch._expressionList || []).filter((e) => typeof e === "string");
  // A split prefab stores clips inline with their names; a referenced one stores {clip: name}.
  if (!motions.length) motions = (ch.Motions || []).map((m) => m && m.Name).filter(Boolean);
  return { key: mm.key, motions: unique(motions), expressions: unique(expressions),
           defaultMotion: ch.DefaultMotionName || "", defaultExpression: ch.DefaultExpressionName || "" };
};

// The language fields a Location row may carry. A caption in another language is still a better hint than an empty
// string: the official site's zh-Hans build does not translate every chapter title.
const TEXT_FIELDS = ["japanese", "english", "simplifiedChinese", "traditionalChinese", "korean"];

const locationText = (row, field) => {
  for (const key of [field, ...TEXT_FIELDS]) {
    const text = row && row[key];
    if (text) return String(text).replace(/<[^>]*>/g, "").trim();
  }
  return "";
};

// Stage ids in command order, each with the first Location caption that follows it.
const readStageRows = (episode, field) => {
  const out = [], byId = new Map();
  let current = "";
  for (const c of episode.commands || []) {
    if (c.cmd === "Stage" && c.TargetAssetName) {
      current = c.TargetAssetName.split("/").pop();
      if (!byId.has(current)) {
        const stage = { key: c.TargetAssetName, id: current, caption: "" };
        byId.set(current, stage);
        out.push(stage);
      }
    } else if (c.cmd === "Location" && current) {
      const stage = byId.get(current);
      const id = c.AdvTextID || (c.TargetTextIDs || [])[0];
      const text = locationText(c.lines, field) || locationText(episode.text && episode.text[id], field);
      if (stage && !stage.caption && text) stage.caption = text;
    }
  }
  return out;
};

// The BGM and SE rows of an episode, with the cue sheet and the audio files the manifest actually ships. A cue the
// renderer cannot play is not a choice, so a row without audio is left out.
const readSoundRows = (site, manifest, episode) => {
  const music = [], sounds = [];
  const files = manifest.files || {};
  for (const [id, row] of Object.entries(episode.sounds || {})) {
    const sheet = episode.cuesheets && episode.cuesheets[row && row._soundCueSheetID];
    if (!sheet || !row._cueName || !sheet._cueSheetName) continue;
    const audio = Object.fromEntries(Object.entries(files)
      .filter(([file]) => file.startsWith(`audio/${sheet._cueSheetName}/`)));
    if (!Object.keys(audio).length) continue;
    const entry = { cue: row._cueName, label: cueLabel(row._cueName), sound: Number(id), sheet: sheet._cueSheetName,
                    row, cuesheet: sheet, audio };
    if (/^sound_bgm/i.test(sheet._cueSheetName)) music.push(entry);
    else if (/^sound_se/i.test(sheet._cueSheetName)) sounds.push(entry);
  }
  return { music, sounds };
};

export const isSafeRelPath = (rel) => {
  if (!rel || typeof rel !== "string" || rel.includes("\0") || rel.startsWith("/") || rel.startsWith("\\")) return false;
  return !rel.split(/[\\/]/).some((seg) => seg === "" || seg === "." || seg === "..");
};

export const addAliasKey = (map, rawKey, canonical) => {
  if (!rawKey) return;
  const k = String(rawKey);
  if (!map.has(k)) map.set(k, canonical);
  const lower = k.toLowerCase();
  if (!map.has(lower)) map.set(lower, canonical);
  const tail = k.includes("/") ? k.split("/").pop() : k;
  if (tail && !map.has(tail)) map.set(tail, canonical);
  if (tail && !map.has(tail.toLowerCase())) map.set(tail.toLowerCase(), canonical);
  const shortPe = tail.replace(/^adv_effect_posteffect_/i, "");
  if (shortPe && shortPe !== tail) {
    if (!map.has(shortPe)) map.set(shortPe, canonical);
    if (!map.has(shortPe.toLowerCase())) map.set(shortPe.toLowerCase(), canonical);
  }
};

const hasEntryKey = (container, name) => {
  if (!container) return false;
  if (container instanceof Map) {
    if (!container.has(name)) return false;
    const v = container.get(name);
    if (v && typeof v === "object") {
      if ("entry" in v && v.entry === null) return false;
      if ("profile" in v && v.profile === null) return false;
      if ("transition" in v && v.transition === null) return false;
    }
    return true;
  }
  return Object.hasOwn(container, name);
};

export const resolveAliasKey = (map, aliasMap, name) => {
  if (!name) return "";
  if (hasEntryKey(map, name)) return name;
  const direct = aliasMap.get(name) || aliasMap.get(String(name).toLowerCase());
  if (direct && hasEntryKey(map, direct)) return direct;
  return "";
};

const indexAnimDoc = (doc) => {
  const controllers = new Map(), clips = new Map();
  const walk = (x) => {
    if (Array.isArray(x)) { for (const v of x) walk(v); return; }
    if (!x || typeof x !== "object") return;
    if (typeof x.controller === "string" && Array.isArray(x.layers) && !controllers.has(x.controller)) {
      controllers.set(x.controller, x);
    } else if (typeof x.clip === "string" && Object.keys(x).length > 1 && !clips.has(x.clip)) {
      clips.set(x.clip, x);
    }
    for (const v of Object.values(x)) walk(v);
  };
  walk(doc);
  return { controllers, clips };
};

// Re-hydrates Animator stub references ({ controller: name } / { clip: name }) from the donor doc so a frame,
// effect or still stays self-contained when copied into another manifest.
const inlineAnimRefs = (node, anim, seenCtrl = new Set(), seenClip = new Set()) => {
  if (Array.isArray(node)) return node.map((v) => inlineAnimRefs(v, anim, seenCtrl, seenClip));
  if (!node || typeof node !== "object") return node;
  if (typeof node.controller === "string" && !Array.isArray(node.layers) && !seenCtrl.has(node.controller)) {
    const full = anim.controllers.get(node.controller);
    if (full) {
      seenCtrl.add(node.controller);
      return inlineAnimRefs(structuredClone(full), anim, seenCtrl, seenClip);
    }
  }
  if (typeof node.clip === "string" && Object.keys(node).length === 1 && !seenClip.has(node.clip)) {
    const full = anim.clips.get(node.clip);
    if (full) {
      seenClip.add(node.clip);
      return inlineAnimRefs(structuredClone(full), anim, seenCtrl, seenClip);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = inlineAnimRefs(v, anim, seenCtrl, seenClip);
  return out;
};

export const readShadersMap = (site, manifest) => {
  const entry = manifest.files && manifest.files["shaders/shaders.json"];
  if (!entry) return new Map();
  let list;
  try { list = readEntry(site, entry); } catch { return new Map(); }
  if (!Array.isArray(list)) return new Map();
  const files = manifest.files || {};
  const map = new Map();
  for (const rec of list) {
    if (!rec || typeof rec.name !== "string") continue;
    const shaderFiles = {};
    if (rec.parsed && files[`shaders/${rec.parsed}`]) shaderFiles[`shaders/${rec.parsed}`] = files[`shaders/${rec.parsed}`];
    for (const v of rec.variants || []) {
      if (v && v.file && files[`shaders/${v.file}`]) shaderFiles[`shaders/${v.file}`] = files[`shaders/${v.file}`];
    }
    map.set(rec.name, { rec, files: shaderFiles });
  }
  return map;
};

export const collectDeps = (node, donorFiles, donorShaders) => {
  const files = {};
  const shaders = new Map();
  const seen = new Set();
  const walk = (x, prop = "") => {
    if (typeof x === "string") {
      if (x && donorFiles[x] && !files[x]) files[x] = donorFiles[x];
      if (x && !x.startsWith("textures/") && donorFiles[`textures/${x}`] && !files[`textures/${x}`]) {
        files[`textures/${x}`] = donorFiles[`textures/${x}`];
      }
      if ((prop === "shader" || donorShaders.has(x)) && donorShaders.has(x) && !shaders.has(x)) {
        shaders.set(x, donorShaders.get(x));
      }
      return;
    }
    if (!x || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) {
      for (const v of x) walk(v, prop);
      return;
    }
    for (const [k, v] of Object.entries(x)) walk(v, k);
  };
  walk(node);
  return { files, shaders };
};

const readSplitParts = (site, entry, keys) => {
  if (!entry) return {};
  if (Array.isArray(entry.parts)) {
    const out = {};
    for (const key of keys) {
      const part = entry.parts.find(([k]) => k === key);
      out[key] = part ? JSON.parse(readAsset(site, part[1]).toString()) : {};
    }
    return out;
  }
  const doc = readEntry(site, entry);
  const out = {};
  for (const key of keys) out[key] = doc[key] || {};
  return out;
};

// Rewrites named parts of a split asset (`scene.json` -> `stages`, `ui/ui.json` -> `transitions`/`textures`),
// preserving the exact `size` delta required by manifest /2 split readers.
const writeSplitParts = (site, entry, updates) => {
  if (Array.isArray(entry.parts)) {
    let size = Number.isFinite(Number(entry.size)) ? Number(entry.size) : undefined;
    const parts = entry.parts.map(([key, asset, partSize, stored]) => {
      if (!(key in updates)) return [key, asset, partSize, stored].filter((value) => value !== undefined);
      const written = writeAsset(site, Buffer.from(JSON.stringify(updates[key])));
      if (size !== undefined) size += written.size - (Number(partSize) || 0);
      return [key, written.asset, written.size, written.stored];
    });
    for (const [key, data] of Object.entries(updates)) {
      if (!entry.parts.some(([k]) => k === key)) {
        const written = writeAsset(site, Buffer.from(JSON.stringify(data)));
        if (size !== undefined) size += written.size + key.length + 4;
        parts.push([key, written.asset, written.size, written.stored]);
      }
    }
    return size === undefined ? { parts } : { parts, size };
  }
  const doc = readEntry(site, entry);
  Object.assign(doc, updates);
  return writeAsset(site, Buffer.from(JSON.stringify(doc)));
};

const uiEntryOf = (manifest, preferredLang = "") => {
  const langs = manifest.languages || {};
  const candidates = [];
  if (preferredLang && langs[preferredLang]?.files?.["ui/ui.json"]) {
    candidates.push({ entry: langs[preferredLang].files["ui/ui.json"], files: langs[preferredLang].files });
  }
  for (const [code, langObj] of Object.entries(langs)) {
    if (code !== preferredLang && langObj?.files?.["ui/ui.json"]) {
      candidates.push({ entry: langObj.files["ui/ui.json"], files: langObj.files });
    }
  }
  if (manifest.files?.["ui/ui.json"]) {
    candidates.push({ entry: manifest.files["ui/ui.json"], files: manifest.files });
  }
  return candidates;
};

const readUiTransitions = (site, manifest, preferredLang = "") => {
  const out = new Map();
  const baseFiles = manifest.files || {};
  for (const { entry, files: scopeFiles } of uiEntryOf(manifest, preferredLang)) {
    let uiParts;
    try { uiParts = readSplitParts(site, entry, ["transitions", "textures"]); } catch { continue; }
    const transitions = uiParts.transitions || {};
    const uiTextures = uiParts.textures || {};
    for (const [addr, tr] of Object.entries(transitions)) {
      if (!tr || out.has(addr)) continue;
      const texName = tr._texture?.texture || "";
      const texMeta = texName ? uiTextures[texName] || null : null;
      const texPath = texMeta?.texture || texMeta?.file || "";
      const texFiles = {};
      if (texPath) {
        const relUi = texPath.startsWith("ui/") ? texPath : `ui/${texPath}`;
        const hit = scopeFiles[relUi] || baseFiles[relUi] || scopeFiles[texPath] || baseFiles[texPath];
        if (hit) texFiles[relUi] = hit;
      }
      out.set(addr, { addr, transition: tr, textureName: texName, textureMeta: texMeta, files: texFiles });
    }
  }
  return out;
};

// The stage prefabs of a story's own scene.json. The map is split out of a multi-part asset, so only the `stages`
// part has to be read (and later rewritten).
export const readSceneStages = (site, manifest) => {
  const entry = manifest.files && manifest.files["scene.json"];
  if (!entry) return { entry: null, stages: {} };
  return { entry, stages: readSplitParts(site, entry, ["stages"]).stages || {} };
};

export const textureEntries = (manifest, id) => Object.fromEntries(Object.entries(manifest.files || {})
  .filter(([file]) => file.startsWith(`textures/${id}-`)));

// The character key of a model id (`adv_live2d_anon_002_live_01` → anon, `adv_live2d_sub_mortis_...` → sub_mortis).
// Duplicated from story/siteFormat.js so the catalogue and the compiler stay independent of each other.
const modelKeyOf = (id) => {
  const sub = /^adv_live2d_(sub_[a-z0-9]+?)_/i.exec(String(id));
  if (sub) return sub[1].toLowerCase();
  const match = /^adv_live2d_([a-z0-9]+?)_\d+_/i.exec(String(id));
  return match ? match[1].toLowerCase() : "";
};

// The character keys a story casts, from its own story index.
const castKeysOf = (site, manifest) => {
  const entry = manifest.files && manifest.files["story.json"];
  if (!entry) return new Set();
  try {
    const story = readEntry(site, entry);
    return new Set(Object.values(story.models || {}).map(modelKeyOf).filter(Boolean));
  } catch {
    return new Set();
  }
};

const stageAdvComp = (prefab) => {
  if (!prefab || typeof prefab !== "object") return null;
  for (const node of Array.isArray(prefab.nodes) ? prefab.nodes : []) {
    for (const comp of Array.isArray(node?.components) ? node.components : []) {
      if (comp?.class === "AdvStage") return comp;
    }
  }
  return null;
};

export const collectStageVolumeProfiles = (prefab, volumeProfiles) => {
  const profs = stageAdvComp(prefab)?._allVolumeProfileCollection?._profiles;
  if (!Array.isArray(profs)) return;
  for (const p of profs) {
    if (p && typeof p === "object" && p.name && Array.isArray(p.components) && !volumeProfiles.has(p.name)) {
      volumeProfiles.set(p.name, p);
    }
  }
};

const hydrateStagePrefab = (prefab, volumeProfiles) => {
  if (!prefab) return prefab;
  const adv = stageAdvComp(prefab);
  const profs = adv?._allVolumeProfileCollection?._profiles;
  const needsProfiles = !!(volumeProfiles?.size && Array.isArray(profs)
    && profs.some((p) => p && p.name && !Array.isArray(p.components) && volumeProfiles.has(p.name)));
  const needsFocus = !!(adv && (!Array.isArray(adv._focusPointsCollection?._entries)
    || adv._focusPointsCollection._entries.length === 0));
  if (!needsProfiles && !needsFocus) return prefab;
  const cloned = structuredClone(prefab);
  ensureStageFocusPoints(cloned);
  if (needsProfiles) {
    const clonedProfs = stageAdvComp(cloned)._allVolumeProfileCollection._profiles;
    for (let i = 0; i < clonedProfs.length; i++) {
      const p = clonedProfs[i];
      if (p && p.name && !Array.isArray(p.components) && volumeProfiles.has(p.name)) {
        clonedProfs[i] = structuredClone(volumeProfiles.get(p.name));
      }
    }
  }
  return cloned;
};

// Every story of the site contributes its locations, sounds, frames, post-effects, particle effects, stills,
// rule transitions and shaders to one pool, so a new episode is not limited to what its base story happened to use.
// Shared neutral venues (`kind: shared` in resourceGuide) are kept even with `castOnly: true`.
const readSitePool = (site, baseRel, baseManifest, baseEpisode, field, { all = true, castOnly = false, guide = null, cloud = true } = {}) => {
  const stages = [], music = [], sounds = [];
  const stageIds = new Set(), musicCues = new Set(), soundCues = new Set();
  const stageFiles = new Map(), stagePrefabs = new Map(), stageShaders = new Map(), soundFiles = new Map();
  const sheetCuesEntries = new Map(), sheetCuesAssets = new Map(), sheetCueMeta = new Map();
  const stageCasts = new Map();
  const volumeProfiles = new Map();
  const frames = new Map(), frameAliases = new Map();
  const postEffects = new Map(), postEffectAliases = new Map();
  const effectInstances = new Map(), effectAssets = new Map(), effectAliases = new Map();
  const stills = new Map(), stillAliases = new Map();
  const transitions = new Map(), transitionAliases = new Map();
  const seen = new Set([baseRel]);

  const absorbSoundAudio = (sheet, audioFiles = {}, cueMeta = null) => {
    const dest = soundFiles.get(sheet) || {};
    const cuesRel = `audio/${sheet}/cues.json`;
    for (const [rel, entry] of Object.entries(audioFiles || {})) {
      if (rel === cuesRel) {
        const list = sheetCuesEntries.get(sheet) || [];
        const seenAsset = sheetCuesAssets.get(sheet) || new Set();
        const tag = entry?.asset || JSON.stringify(entry);
        if (!seenAsset.has(tag)) {
          seenAsset.add(tag);
          list.push(entry);
          sheetCuesAssets.set(sheet, seenAsset);
          sheetCuesEntries.set(sheet, list);
        }
      } else {
        dest[rel] = entry;
      }
    }
    if (cueMeta && typeof cueMeta === "object") {
      const meta = sheetCueMeta.get(sheet) || {};
      Object.assign(meta, cueMeta);
      sheetCueMeta.set(sheet, meta);
    }
    soundFiles.set(sheet, dest);
  };

  const poolExtras = (manifest) => {
    const files = manifest.files || {};
    const shaders = readShadersMap(site, manifest);

    if (files["frames.json"]) {
      try {
        const doc = readEntry(site, files["frames.json"]);
        const anim = indexAnimDoc(doc);
        for (const [key, rawEntry] of Object.entries(doc.frames || {})) {
          addAliasKey(frameAliases, key, key);
          if (frames.has(key)) continue;
          const entry = inlineAnimRefs(structuredClone(rawEntry), anim);
          frames.set(key, { key, entry, deps: collectDeps(entry, files, shaders) });
        }
      } catch { /* partially cached donor */ }
    }

    if (files["posteffects.json"]) {
      try {
        const doc = readEntry(site, files["posteffects.json"]);
        for (const [key, profile] of Object.entries(doc.postEffects || {})) {
          addAliasKey(postEffectAliases, key, key);
          if (postEffects.has(key)) continue;
          postEffects.set(key, { key, profile, deps: collectDeps(profile, files, shaders) });
        }
      } catch { /* partially cached donor */ }
    }

    if (files["effects.json"]) {
      try {
        const doc = readEntry(site, files["effects.json"]);
        const anim = indexAnimDoc(doc);
        const resolvedEffects = new Map();
        for (const [assetName, rawEntry] of Object.entries(doc.effects || {})) {
          addAliasKey(effectAliases, assetName, assetName);
          const entry = inlineAnimRefs(structuredClone(rawEntry), anim);
          const deps = collectDeps(entry, files, shaders);
          resolvedEffects.set(assetName, { assetName, entry, deps });
          if (!effectAssets.has(assetName)) effectAssets.set(assetName, { assetName, entry, deps });
        }
        for (const [targetName, assetName] of Object.entries(doc.instances || {})) {
          addAliasKey(effectAliases, targetName, targetName);
          if (effectInstances.has(targetName)) continue;
          const resolved = resolvedEffects.get(assetName) || effectAssets.get(assetName);
          if (resolved) effectInstances.set(targetName, { targetName, ...resolved });
        }
      } catch { /* partially cached donor */ }
    }

    if (files["stills.json"]) {
      try {
        const doc = readEntry(site, files["stills.json"]);
        const anim = indexAnimDoc(doc);
        for (const [key, rawEntry] of Object.entries(doc.stills || {})) {
          addAliasKey(stillAliases, key, key);
          if (stills.has(key)) continue;
          const entry = inlineAnimRefs(structuredClone(rawEntry), anim);
          stills.set(key, { key, entry, deps: collectDeps(entry, files, shaders) });
        }
      } catch { /* partially cached donor */ }
    }

    for (const [addr, item] of readUiTransitions(site, manifest, baseManifest.language)) {
      addAliasKey(transitionAliases, addr, addr);
      if (!transitions.has(addr)) transitions.set(addr, item);
    }
  };

  const addStory = (manifest, episode, stageOrder = []) => {
    const donorShaders = readShadersMap(site, manifest);
    if (manifest.files?.["scene.json"]) {
      const scene = readSceneStages(site, manifest);
      const cast = castKeysOf(site, manifest);
      const keys = Object.keys(scene.stages);
      if (stageOrder.length) {
        keys.sort((a, b) => stageOrder.indexOf(a.split("/").pop()) - stageOrder.indexOf(b.split("/").pop()));
      }
      for (const key of keys) {
        const id = key.split("/").pop();
        collectStageVolumeProfiles(scene.stages[key], volumeProfiles);
        if (!stagePrefabs.has(key)) stagePrefabs.set(key, scene.stages[key]);
        if (!stageShaders.has(key) && donorShaders.size) {
          stageShaders.set(key, collectDeps(scene.stages[key], manifest.files || {}, donorShaders).shaders);
        }
        const files = textureEntries(manifest, id);
        if (!stageIds.has(id)) {
          stageIds.add(id);
          stages.push({ key, id, caption: "" });
          stageCasts.set(key, cast);
        }
        if (!stageFiles.has(key) && Object.keys(files).length) stageFiles.set(key, files);
      }
    }
    if (episode) {
      const rows = readSoundRows(site, manifest, episode);
      for (const item of rows.music) {
        absorbSoundAudio(item.sheet, item.audio);
        if (musicCues.has(item.cue)) continue;
        musicCues.add(item.cue);
        music.push(item);
      }
      for (const item of rows.sounds) {
        absorbSoundAudio(item.sheet, item.audio);
        if (soundCues.has(item.cue)) continue;
        soundCues.add(item.cue);
        sounds.push(item);
      }
    }
    poolExtras(manifest);
  };

  const baseOrder = readStageRows(baseEpisode, field).map((stage) => stage.id);
  addStory(baseManifest, baseEpisode, baseOrder);
  if (all) {
    const dir = path.join(site, "stories");
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
      if (!name.endsWith(".json")) continue;
      const rel = `stories/${name}`;
      if (seen.has(rel)) continue;
      seen.add(rel);
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(path.join(site, rel), "utf8")); } catch { continue; }
      if (manifest.format !== "ournotes.story-manifest/2" || !manifest.files || !manifest.files["episode.json"]) continue;
      let episode;
      try { episode = readEntry(site, manifest.files["episode.json"]); } catch { continue; }
      try { addStory(manifest, episode); } catch { continue; }
    }
    const bundlePath = path.join(site, "official-bundles.json");
    if (fs.existsSync(bundlePath)) {
      try {
        const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
        if (bundle && bundle.files) poolExtras(bundle);
      } catch { /* ignore corrupt bundle cache */ }
    }
    const cloudPoolPath = path.join(site, "cloud-pool.json");
    if (fs.existsSync(cloudPoolPath)) {
      try {
        const cp = JSON.parse(fs.readFileSync(cloudPoolPath, "utf8"));
        for (const [id, st] of Object.entries(cp?.stages || {})) {
          if (!st?.key || !st?.prefab) continue;
          const prefab = structuredClone(st.prefab);
          ensureStageFocusPoints(prefab);
          collectStageVolumeProfiles(prefab, volumeProfiles);
          stagePrefabs.set(st.key, prefab);
          if (Array.isArray(st.shaders) && st.shaders.length) stageShaders.set(st.key, new Map(st.shaders));
          if (st.files && Object.keys(st.files).length) stageFiles.set(st.key, st.files);
          if (!stageIds.has(id)) {
            stageIds.add(id);
            stages.push({ key: st.key, id, caption: "" });
            stageCasts.set(st.key, new Set());
          }
        }
        let nextPoolSoundId = 820000;
        let nextPoolSheetId = 820000;
        for (const [cue, au] of Object.entries(cp?.audio || {})) {
          if (!au?.sheet) continue;
          absorbSoundAudio(au.sheet, au.files || {}, au.cueEntry ? { [cue]: au.cueEntry } : null);
          const isBgm = au.kind === "bgm" || /^sound_bgm/i.test(au.sheet);
          const soundId = Number(au.soundId) || nextPoolSoundId++;
          const sheetId = Number(au.sheetId) || nextPoolSheetId++;
          if (isBgm && !musicCues.has(cue)) {
            musicCues.add(cue);
            music.push({
              cue, label: cueLabel(cue), sound: soundId, sheet: au.sheet,
              row: au.row || { _id: soundId, _category: 0, _soundCueSheetID: sheetId, _cueName: cue },
              cuesheet: au.cuesheet || { _id: sheetId, _cueSheetName: au.sheet },
              audio: au.files || {},
            });
          } else if (!isBgm && !soundCues.has(cue)) {
            soundCues.add(cue);
            sounds.push({
              cue, label: cueLabel(cue), sound: soundId, sheet: au.sheet,
              row: au.row || { _id: soundId, _category: 1, _soundCueSheetID: sheetId, _cueName: cue },
              cuesheet: au.cuesheet || { _id: sheetId, _cueSheetName: au.sheet },
              audio: au.files || {},
            });
          }
        }
      } catch { /* ignore corrupt cloud-pool */ }
    }
  }
  const hasCustomGuide = !!(site && fs.existsSync(path.join(site, "story-resources.yaml")));
  if (cloud && all && !hasCustomGuide) {
    const cc = loadCloudCatalog();
    const bandMembers = new Map();
    for (const [ck, b] of Object.entries(cc.characterBands || {})) {
      if (!bandMembers.has(b)) bandMembers.set(b, new Set());
      bandMembers.get(b).add(ck);
    }
    for (const s of cc.stages || []) {
      if (!s?.id || s.kind === "title" || stageIds.has(s.id)) continue;
      const key = `Adv/Stage/${s.id}/${s.id}`;
      stageIds.add(s.id);
      stages.push({ key, id: s.id, caption: "" });
      stageCasts.set(key, s.kind === "shared" || !s.band ? new Set() : (bandMembers.get(s.band) || new Set()));
    }
    let nextSoundId = 800000;
    let nextSheetId = 800000;
    for (const m of cc.music || []) {
      if (!m?.cue || musicCues.has(m.cue)) continue;
      const soundId = nextSoundId++;
      const sheetId = nextSheetId++;
      const sheet = m.sheet || m.cue;
      musicCues.add(m.cue);
      music.push({
        cue: m.cue, label: cueLabel(m.cue), sound: soundId, sheet,
        row: { _id: soundId, _category: 0, _soundCueSheetID: sheetId, _cueName: m.cue },
        cuesheet: { _id: sheetId, _cueSheetName: sheet },
        audio: {},
      });
    }
    const seSheetId = 819999;
    let nextSeId = 810000;
    for (const se of cc.sounds || []) {
      if (!se?.cue || soundCues.has(se.cue)) continue;
      const soundId = nextSeId++;
      const sheet = se.sheet || "sound_se_adv";
      soundCues.add(se.cue);
      sounds.push({
        cue: se.cue, label: cueLabel(se.cue), sound: soundId, sheet,
        row: { _id: soundId, _category: 1, _soundCueSheetID: seSheetId, _cueName: se.cue },
        cuesheet: { _id: seSheetId, _cueSheetName: sheet },
        audio: {},
      });
    }
    for (const k of Object.keys(cc.donors?.frames || {})) {
      if (!resolveAliasKey(frames, frameAliases, k)) {
        addAliasKey(frameAliases, k, k);
        if (!frames.has(k)) frames.set(k, { key: k, entry: null, deps: null });
      }
    }
    for (const k of Object.keys(cc.donors?.postEffects || {})) {
      if (!resolveAliasKey(postEffects, postEffectAliases, k)) {
        addAliasKey(postEffectAliases, k, k);
        if (!postEffects.has(k)) postEffects.set(k, { key: k, profile: null, deps: null });
      }
    }
    for (const k of Object.keys(cc.donors?.effects || {})) {
      if (!resolveAliasKey(effectInstances, effectAliases, k) && !resolveAliasKey(effectAssets, effectAliases, k)) {
        addAliasKey(effectAliases, k, k);
        if (!effectInstances.has(k) && !effectAssets.has(k)) effectAssets.set(k, { assetName: k, entry: null, deps: null });
      }
    }
    for (const k of Object.keys(cc.donors?.stills || {})) {
      if (!resolveAliasKey(stills, stillAliases, k)) {
        addAliasKey(stillAliases, k, k);
        if (!stills.has(k)) stills.set(k, { key: k, entry: null, deps: null });
      }
    }
    for (const k of Object.keys(cc.donors?.transitions || {})) {
      if (!resolveAliasKey(transitions, transitionAliases, k)) {
        addAliasKey(transitionAliases, k, k);
        if (!transitions.has(k)) transitions.set(k, { addr: k, transition: null });
      }
    }
  }
  const baseStages = readStageRows(baseEpisode, field);
  const captions = new Map(baseStages.map((stage) => [stage.id, stage.caption]));
  const baseCast = castKeysOf(site, baseManifest);
  const baseIds = new Set(baseStages.map((stage) => stage.id));
  const isSharedStage = (stage) => {
    const entry = guide?.stages?.get(stage.id) || guide?.stages?.get(stage.key);
    return entry?.kind === "shared" || entry?.kind === "neutral" || entry?.shared === true;
  };
  const offered = castOnly && baseCast.size
    ? stages.filter((stage) => baseIds.has(stage.id) || isSharedStage(stage) || !stageCasts.get(stage.key)?.size ||
        [...stageCasts.get(stage.key)].some((key) => baseCast.has(key)))
    : stages;
  for (const stage of offered) stage.caption = captions.get(stage.id) || "";
  return {
    stages: offered, music, sounds, stageFiles, stagePrefabs, stageShaders, soundFiles, volumeProfiles,
    sheetCuesEntries, sheetCueMeta,
    frames, frameAliases, postEffects, postEffectAliases,
    effectInstances, effectAssets, effectAliases,
    stills, stillAliases, transitions, transitionAliases,
    baseSceneStages: readSceneStages(site, baseManifest).stages,
  };
};

// The vocabulary of a site-format story: its stages, BGM, SE cues, visual effects and every model's actions.
export const readSiteCatalog = (site, baseRel, language = "", { guide = null, pool = true, castOnly = false, cloud = true } = {}) => {
  const book = guide || loadResourceGuide(site);
  const baseManifest = JSON.parse(fs.readFileSync(path.join(site, baseRel), "utf8"));
  if (baseManifest.format !== "ournotes.story-manifest/2")
    throw new Error(`${baseRel}: not an ournotes.story-manifest/2 story`);
  const lang = language || baseManifest.language;
  const field = FIELD(lang);
  const baseEpisode = readEntry(site, baseManifest.files["episode.json"]);
  const poolData = readSitePool(site, baseRel, baseManifest, baseEpisode, field, { all: pool, castOnly, guide: book, cloud });
  const stageList = poolData.stages.map((stage) => applyStageGuide(stage, book)).filter(Boolean);
  const music = poolData.music.map((item) => applyMusicGuide(item, book));
  const sounds = poolData.sounds.map((item) => applySoundGuide(item, book));
  baseEpisode.sounds ||= {};
  baseEpisode.cuesheets ||= {};
  for (const item of [...music, ...sounds]) {
    baseEpisode.sounds[item.sound] = item.row;
    baseEpisode.cuesheets[item.row._soundCueSheetID] = item.cuesheet;
  }
  const modelsDir = path.join(site, "models");
  const ids = fs.existsSync(modelsDir)
    ? fs.readdirSync(modelsDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  const actions = new Map();
  const modelKeys = new Map();
  for (const id of ids) {
    try {
      const a = readModelActions(site, id);
      actions.set(id, a);
      modelKeys.set(id, a.key);
    } catch { /* not a model */ }
  }
  const hasCustomGuide = !!(site && fs.existsSync(path.join(site, "story-resources.yaml")));
  if (cloud && !hasCustomGuide) {
    const cc = loadCloudCatalog();
    for (const m of [...(cc.models?.tw || []), ...(cc.models?.jp || [])]) {
      if (!m?.id || actions.has(m.id)) continue;
      const charKey = m.characterKey || modelKeyOf(m.id);
      if (!charKey) continue;
      actions.set(m.id, {
        key: charKey,
        motions: unique(m.actions?.motions || []),
        expressions: unique(m.actions?.expressions || []),
        defaultMotion: m.actions?.defaultMotion || "",
        defaultExpression: m.actions?.defaultExpression || "",
      });
      modelKeys.set(m.id, charKey);
    }
  }
  const modelIds = [...actions.keys()];
  const sheets = unique([...music.map((m) => m.sheet), ...sounds.map((s) => s.sheet)]);
  const storyParts = {
    scene: "scene.json",
    ui: { [lang]: "ui/ui.json" },
    fonts: { [lang]: "ui/fonts.json" },
    assets: {},
    sounds: Object.fromEntries(sheets.map((name) => [name, `audio/${name}`])),
  };
  const baseStory = { parts: storyParts };
  const strip = ({ row, cuesheet, audio, ...rest }) => rest;
  const base = {
    language: lang, languages: unique([lang, ...(baseManifest.story?.languages || []), ...Object.keys(baseManifest.languages || {})]),
    stages: stageList, music: music.map(strip), sounds: sounds.map(strip),
    frames: [...poolData.frames.keys()],
    postEffects: [...poolData.postEffects.keys()],
    effects: unique([...poolData.effectInstances.keys(), ...poolData.effectAssets.keys()]),
    stills: [...poolData.stills.keys()],
    transitions: [...poolData.transitions.keys()],
    episode: baseEpisode,
    story: baseStory,
  };
  return { baseManifest, baseEpisode, base, lang, field, models: modelIds, actions, modelKeys, guide: book, pool: poolData };
};

// Resolves pooled stages, audio sheets, frames, post-effects, effects, stills, rule transitions, shaders,
// fonts and TTS voices referenced by `episode.commands` into `manifest` and `story.json`.
export const bundleSiteEpisodeAssets = ({
  site, catalog, manifest, baseManifest, episode, lang, castModels = {}, voices = null,
}) => {
  const activeCmds = (episode.commands || []).filter((c) => !c.IgnoreData);
  const usedStages = new Set(activeCmds.filter((c) => c.cmd === "Stage" && c.TargetAssetName).map((c) => c.TargetAssetName));
  const usedFrames = unique(activeCmds.filter((c) => c.cmd === "Frame" && (c.TargetAssetName || "").trim()).map((c) => c.TargetAssetName));
  const usedPostEffects = unique(activeCmds.filter((c) => c.cmd === "PostEffect" && (c.TargetAssetName || "").trim()).map((c) => c.TargetAssetName));
  const usedEffects = unique(activeCmds.filter((c) => c.cmd === "Effect" && (c.TargetName || "").trim()).map((c) => c.TargetName));
  const usedStills = unique(activeCmds.filter((c) => c.cmd === "Still" && (c.TargetAssetName || "").trim()).map((c) => c.TargetAssetName));
  const usedTransitions = unique(activeCmds
    .filter((c) => (c.cmd === "FadeIn" || c.cmd === "FadeOut") && (c.TargetAssetName || "").trim())
    .map((c) => c.TargetAssetName));
  const usedSheets = new Set(Object.values(episode.cuesheets || {})
    .map((sheet) => sheet && sheet._cueSheetName).filter(Boolean));
  const baseStoryEntry = baseManifest.files["story.json"];
  const storyIndex = baseStoryEntry ? readEntry(site, baseStoryEntry) : null;
  const langFiles = manifest.languages[lang].files;

  const usedFiles = {};
  const addedShaders = new Map();
  const absorbDeps = (deps) => {
    if (!deps) return;
    Object.assign(usedFiles, deps.files || {});
    for (const [name, info] of deps.shaders || []) {
      if (!addedShaders.has(name)) addedShaders.set(name, info);
    }
  };

  for (const key of usedStages) {
    Object.assign(usedFiles, catalog.pool.stageFiles.get(key) || {});
    for (const [name, info] of catalog.pool.stageShaders.get(key) || []) {
      if (!addedShaders.has(name)) addedShaders.set(name, info);
    }
  }
  for (const sheet of usedSheets) {
    Object.assign(usedFiles, catalog.pool.soundFiles.get(sheet) || {});
    const cueEntries = catalog.pool.sheetCuesEntries?.get(sheet) || [];
    const inlineMeta = catalog.pool.sheetCueMeta?.get(sheet) || {};
    const cuesRel = `audio/${sheet}/cues.json`;
    if (cueEntries.length === 1 && !Object.keys(inlineMeta).length) {
      usedFiles[cuesRel] = cueEntries[0];
    } else if (cueEntries.length || Object.keys(inlineMeta).length) {
      const mergedCues = {};
      for (const e of cueEntries) {
        try { Object.assign(mergedCues, readEntry(site, e)); } catch { /* skip corrupt cue sheet */ }
      }
      Object.assign(mergedCues, inlineMeta);
      usedFiles[cuesRel] = writeAsset(site, Buffer.from(JSON.stringify(mergedCues)));
    }
  }

  const baseSceneStages = catalog.pool.baseSceneStages || {};
  const addedStages = [...usedStages].filter((key) => !(key in baseSceneStages));
  let sceneEntry = baseManifest.files["scene.json"];
  if (addedStages.length && sceneEntry) {
    const merged = { ...baseSceneStages };
    for (const key of addedStages) {
      const prefab = hydrateStagePrefab(catalog.pool.stagePrefabs.get(key), catalog.pool.volumeProfiles);
      if (prefab) merged[key] = prefab;
    }
    sceneEntry = writeSplitParts(site, sceneEntry, { stages: merged });
  }

  const extraJsonFiles = {};
  if (usedFrames.length) {
    const doc = baseManifest.files["frames.json"]
      ? readEntry(site, baseManifest.files["frames.json"])
      : { frames: {} };
    doc.frames = { ...(doc.frames || {}) };
    let dirty = false;
    for (const req of usedFrames) {
      const canonical = resolveAliasKey(catalog.pool.frames, catalog.pool.frameAliases, req);
      const item = canonical ? catalog.pool.frames.get(canonical) : null;
      if (!item?.entry) continue;
      if (!(req in doc.frames)) {
        doc.frames[req] = item.entry;
        dirty = true;
      }
      if (canonical && canonical !== req && !(canonical in doc.frames)) {
        doc.frames[canonical] = item.entry;
        dirty = true;
      }
      absorbDeps(item.deps);
    }
    if (dirty) {
      extraJsonFiles["frames.json"] = writeAsset(site, Buffer.from(JSON.stringify(doc)));
    }
  }

  if (usedPostEffects.length) {
    const doc = baseManifest.files["posteffects.json"]
      ? readEntry(site, baseManifest.files["posteffects.json"])
      : { postEffects: {} };
    doc.postEffects = { ...(doc.postEffects || {}) };
    let dirty = false;
    for (const req of usedPostEffects) {
      const canonical = resolveAliasKey(catalog.pool.postEffects, catalog.pool.postEffectAliases, req);
      const item = canonical ? catalog.pool.postEffects.get(canonical) : null;
      if (!item?.profile) continue;
      if (!(req in doc.postEffects)) {
        doc.postEffects[req] = { ...item.profile, name: req };
        dirty = true;
      }
      if (canonical && canonical !== req && !(canonical in doc.postEffects)) {
        doc.postEffects[canonical] = item.profile;
        dirty = true;
      }
      absorbDeps(item.deps);
    }
    if (dirty) {
      extraJsonFiles["posteffects.json"] = writeAsset(site, Buffer.from(JSON.stringify(doc)));
    }
  }

  if (usedEffects.length) {
    const doc = baseManifest.files["effects.json"]
      ? readEntry(site, baseManifest.files["effects.json"])
      : { instances: {}, effects: {} };
    doc.instances = { ...(doc.instances || {}) };
    doc.effects = { ...(doc.effects || {}) };
    let dirty = false;
    for (const req of usedEffects) {
      let item = null;
      const instKey = resolveAliasKey(catalog.pool.effectInstances, catalog.pool.effectAliases, req);
      if (instKey) item = catalog.pool.effectInstances.get(instKey);
      else {
        const assetKey = resolveAliasKey(catalog.pool.effectAssets, catalog.pool.effectAliases, req);
        if (assetKey) item = catalog.pool.effectAssets.get(assetKey);
      }
      if (!item?.entry) continue;
      if (doc.instances[req] !== item.assetName) { doc.instances[req] = item.assetName; dirty = true; }
      if (!(item.assetName in doc.effects)) { doc.effects[item.assetName] = item.entry; dirty = true; }
      absorbDeps(item.deps);
    }
    if (dirty) {
      extraJsonFiles["effects.json"] = writeAsset(site, Buffer.from(JSON.stringify(doc)));
    }
  }

  if (usedStills.length) {
    const doc = baseManifest.files["stills.json"]
      ? readEntry(site, baseManifest.files["stills.json"])
      : { stills: {} };
    doc.stills = { ...(doc.stills || {}) };
    let dirty = false;
    for (const req of usedStills) {
      const canonical = resolveAliasKey(catalog.pool.stills, catalog.pool.stillAliases, req);
      const item = canonical ? catalog.pool.stills.get(canonical) : null;
      if (!item?.entry) continue;
      if (!(req in doc.stills)) { doc.stills[req] = item.entry; dirty = true; }
      if (canonical && canonical !== req && !(canonical in doc.stills)) {
        doc.stills[canonical] = item.entry;
        dirty = true;
      }
      absorbDeps(item.deps);
    }
    if (dirty) {
      extraJsonFiles["stills.json"] = writeAsset(site, Buffer.from(JSON.stringify(doc)));
    }
  }

  if (usedTransitions.length) {
    const uiScope = langFiles["ui/ui.json"] ? langFiles : manifest.files;
    const uiEntry = uiScope && uiScope["ui/ui.json"];
    if (uiEntry) {
      const uiParts = readSplitParts(site, uiEntry, ["transitions", "textures"]);
      const nextTransitions = { ...(uiParts.transitions || {}) };
      const nextTextures = { ...(uiParts.textures || {}) };
      let dirty = false;
      for (const req of usedTransitions) {
        const canonical = resolveAliasKey(catalog.pool.transitions, catalog.pool.transitionAliases, req);
        const item = canonical ? catalog.pool.transitions.get(canonical) : null;
        if (!item?.transition) continue;
        if (!(req in nextTransitions)) { nextTransitions[req] = item.transition; dirty = true; }
        if (canonical && canonical !== req && !(canonical in nextTransitions)) {
          nextTransitions[canonical] = item.transition;
          dirty = true;
        }
        if (item.textureName && item.textureMeta && !(item.textureName in nextTextures)) {
          nextTextures[item.textureName] = item.textureMeta;
          dirty = true;
        }
        Object.assign(usedFiles, item.files || {});
      }
      if (dirty) {
        uiScope["ui/ui.json"] = writeSplitParts(site, uiEntry, { transitions: nextTransitions, textures: nextTextures });
      }
    }
  }

  if (addedShaders.size) {
    const existingList = baseManifest.files["shaders/shaders.json"]
      ? readEntry(site, baseManifest.files["shaders/shaders.json"])
      : [];
    const mergedList = Array.isArray(existingList) ? [...existingList] : [];
    const have = new Set(mergedList.map((r) => r && r.name).filter(Boolean));
    let dirty = false;
    for (const [name, info] of addedShaders) {
      if (!have.has(name)) {
        mergedList.push(info.rec);
        have.add(name);
        Object.assign(usedFiles, info.files || {});
        dirty = true;
      }
    }
    if (dirty) extraJsonFiles["shaders/shaders.json"] = writeAsset(site, Buffer.from(JSON.stringify(mergedList)));
  }

  let storyEntry = null;
  if (storyIndex) {
    storyIndex.models = { ...castModels };
    if (voices && voices.size) storyIndex.audio = { ...(storyIndex.audio || {}), [TTS_SHEET]: `audio/${TTS_SHEET}` };
    for (const sheet of usedSheets) {
      storyIndex.audio = { ...(storyIndex.audio || {}), [sheet]: `audio/${sheet}` };
    }
    if (extraJsonFiles["frames.json"] || baseManifest.files["frames.json"]) storyIndex.frames = "frames.json";
    if (extraJsonFiles["posteffects.json"] || baseManifest.files["posteffects.json"]) storyIndex.postEffects = "posteffects.json";
    if (extraJsonFiles["effects.json"] || baseManifest.files["effects.json"]) storyIndex.effects = "effects.json";
    if (extraJsonFiles["stills.json"] || baseManifest.files["stills.json"]) storyIndex.stills = "stills.json";
    storyEntry = writeAsset(site, Buffer.from(JSON.stringify(storyIndex)));
  }

  const ttsFiles = addSiteVoices({ site, episode, voices, field: catalog.field }).files;
  const episodeEntry = writeAsset(site, Buffer.from(JSON.stringify(episode)));
  manifest.files = { ...baseManifest.files, ...usedFiles, ...extraJsonFiles, ...ttsFiles,
                     ...(sceneEntry !== baseManifest.files["scene.json"] ? { "scene.json": sceneEntry } : {}),
                     ...(storyEntry ? { "story.json": storyEntry } : {}),
                     "episode.json": episodeEntry };
  return manifest;
};

// The rows and texts of `script` as a new story of `site`; `advId` names it, `outRel` is its manifest path.
export const buildSiteStory = ({ site, baseRel, script, advId, language = "", title = "", outRel = "",
                                  voices = null, guide = null, pool = true,
                                  writeManifest = true, updateIndex = true }) => {
  const parsed = parseScript(script);
  if (parsed.errors.length) return { errors: parsed.errors, warnings: [] };
  const requested = language || parsed.script.language || "";
  const catalog = readSiteCatalog(site, baseRel, requested, { guide, pool });
  const lang = requested || catalog.lang;
  const checked = checkScript(parsed.script, { base: catalog.base, models: catalog.models,
                                               actions: Object.fromEntries(catalog.actions),
                                               sounds: catalog.base.sounds });
  if (checked.errors.length) return { errors: checked.errors, warnings: checked.warnings };
  const compiled = compileScript(parsed.script, {
    base: catalog.base,
    models: Object.fromEntries(catalog.modelKeys),
    actions: Object.fromEntries(catalog.actions),
    sounds: catalog.base.sounds,
  }, checked.language);
  const id = String(advId);
  const commands = unique(compiled.episode.commands.map((c) => c.cmd));
  const episode = {
    ...compiled.episode,
    advId: Number(advId) || advId,
    asset: id,
    commandCount: compiled.episode.commands.length,
    master: { ...compiled.episode.master, _id: Number(advId) || advId, _sheetName: id, _advEpisodeAsset: id,
              _titleTextId: compiled.episode.title ? "custom_title" : "", _playbackMode: 0 },
    title: compiled.episode.title || (title ? { [catalog.field]: title } : null),
  };
  if (title && !episode.text.custom_title) episode.text.custom_title = { [catalog.field]: title };
  if (episode.title && !episode.master._titleTextId) episode.master._titleTextId = "custom_title";

  const baseManifest = catalog.baseManifest;
  const castModels = compiled.story?.parts?.models || {};
  const manifest = JSON.parse(JSON.stringify(baseManifest));
  manifest.advId = Number(advId) || advId;
  manifest.language = lang;
  manifest.languages = { [lang]: JSON.parse(JSON.stringify(baseManifest.languages?.[lang] || { files: {} })) };
  manifest.models = {};
  const modelIndex = (() => {
    const map = new Map();
    for (const rel of ["jp/models.json", "models.json"]) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(site, rel), "utf8"));
        for (const m of doc.models || []) if (m?.id && m?.manifest) map.set(m.id, m.manifest);
      } catch { /* optional */ }
    }
    return map;
  })();
  for (const modelId of Object.values(castModels)) {
    const localDefault = `models/${modelId}.json`;
    const indexedRel = modelIndex.get(modelId) || "";
    const rel = fs.existsSync(path.join(site, localDefault))
      ? localDefault
      : (indexedRel && fs.existsSync(path.join(site, ...indexedRel.split("/"))) ? indexedRel : localDefault);
    if (rel) manifest.models[modelId] = rel;
  }

  const langFiles = manifest.languages[lang].files;
  if (langFiles && langFiles["ui/fonts.json"]) {
    const fonts = readEntry(site, langFiles["ui/fonts.json"]);
    const browser = withBrowserFonts(fonts, fontFamily(parsed.script.font, checked.language));
    langFiles["ui/fonts.json"] = writeAsset(site, Buffer.from(JSON.stringify(browser)));
  }

  bundleSiteEpisodeAssets({ site, catalog, manifest, baseManifest, episode, lang, castModels, voices });
  if (voices && voices.size) {
    manifest.audio = true;
    manifest.audioFormat = "wav";
  }
  manifest.requires = { ...(baseManifest.requires || {}), commands };
  manifest.story = { ...(baseManifest.story || {}), advId: manifest.advId, asset: id, sheetName: id,
    commandCount: episode.commandCount, commands, groups: [], language: lang, languages: [lang], playbackMode: 0,
    titles: { [lang]: title || script.title || id } };
  const out = outRel || `stories/${id}.json`;
  if (writeManifest) {
    fs.mkdirSync(path.dirname(path.join(site, out)), { recursive: true });
    writeAtomic(path.join(site, out), JSON.stringify(manifest, null, 2));
    // the site's index, so the new story is listed next to the base
    if (updateIndex) {
      const indexPath = path.join(site, "stories.json");
      if (fs.existsSync(indexPath)) {
        const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        if (Array.isArray(index.stories)) {
          const entry = { id, advId: manifest.advId, manifest: out, playbackMode: 0, language: lang, languages: [lang],
            titles: manifest.story.titles, audio: !!(baseManifest.audio || (voices && voices.size)),
            audioFormat: manifest.audioFormat || baseManifest.audioFormat };
          const at = index.stories.findIndex((s) => String(s.id) === id || s.manifest === out);
          if (at >= 0) index.stories[at] = entry; else index.stories.push(entry);
          writeAtomic(indexPath, JSON.stringify(index, null, 2));
        }
      }
    }
  }
  return { manifest, manifestPath: out, episode, compiled, warnings: checked.warnings, language: lang,
           voices: voices ? voices.size : 0 };
};

export const OFFICIAL_BUNDLE_BASE_URL = "https://storage.bdon.moe/moenotes";
export const OFFICIAL_ASSET_SEED_EPISODES = [
  "10000", "10004", "10013", "10019", "10021", "10023", "10025", "10028", "10037", "10040", "10041", "10043",
];
export const DEFAULT_OFFICIAL_ASSET_TARGETS = Object.freeze({
  frames: [
    "adv_frame_fill_white",
    "adv_frame_letterbox_white",
    "adv_frame_glitch_1",
    "adv_frame_glitch_2",
    "adv_frame_lensflare_1",
    "adv_frame_moyamoya",
    "adv_frame_comic_speedline_white",
  ],
  postEffects: [
    "monochrome",
    "vignette",
    "vignette2",
    "motion_blur",
    "blur",
    "sepia",
    "chromatic_aberration",
  ],
  transitions: [
    "adv_transition_0002",
    "adv_transition_0003",
    "adv_transition_0004",
    "adv_transition_0005",
  ],
});

const noProxyMatch = (hostname, noProxy) => {
  if (!noProxy) return false;
  const host = String(hostname || "").toLowerCase();
  for (const raw of String(noProxy).split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token === "*") return true;
    const bare = token.replace(/^\[(.*)\]$/, "$1").split(":")[0].replace(/^\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
};

const selectProxyUrl = (targetUrl) => {
  const u = new URL(targetUrl);
  if (noProxyMatch(u.hostname, process.env.NO_PROXY || process.env.no_proxy || "")) return "";
  if (u.protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  }
  if (u.protocol === "http:") {
    return process.env.HTTP_PROXY || process.env.http_proxy || "";
  }
  return "";
};

const readStreamBuffer = (res) => new Promise((resolve, reject) => {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => resolve(Buffer.concat(chunks)));
  res.on("error", reject);
});

const requestViaHttpProxy = (targetUrl, proxyUrl, timeoutMs, signal = null) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason || new Error("aborted"));
    return;
  }
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  const targetPort = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
  const proxyAuth = proxy.username || proxy.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
    : "";
  let settled = false;
  let activeReq = null;
  let activeInner = null;
  let activeSocket = null;
  const cleanup = () => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  };
  const fail = (err) => {
    if (settled) return;
    settled = true;
    cleanup();
    try { activeReq?.destroy(); } catch { /* ignore */ }
    try { activeInner?.destroy(); } catch { /* ignore */ }
    try { activeSocket?.destroy(); } catch { /* ignore */ }
    reject(err);
  };
  const finish = (val) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(val);
  };
  const onAbort = () => fail(signal.reason || new Error("aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => fail(new Error(`proxy request timed out (${timeoutMs}ms)`)), timeoutMs);

  if (target.protocol === "http:" && proxy.protocol === "http:") {
    const req = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: "GET",
      path: target.toString(),
      headers: {
        Host: target.host,
        ...(proxyAuth ? { "Proxy-Authorization": proxyAuth } : {}),
      },
    }, async (res) => {
      try {
        const body = await readStreamBuffer(res);
        finish({ status: res.statusCode || 0, location: res.headers.location || "", body });
      } catch (e) { fail(e); }
    });
    activeReq = req;
    req.on("error", fail);
    req.end();
    return;
  }

  const connectHeaders = { Host: `${target.hostname}:${targetPort}` };
  if (proxyAuth) connectHeaders["Proxy-Authorization"] = proxyAuth;
  const connectReq = (proxy.protocol === "https:" ? https : http).request({
    host: proxy.hostname,
    port: proxyPort,
    method: "CONNECT",
    path: `${target.hostname}:${targetPort}`,
    headers: connectHeaders,
  });
  activeReq = connectReq;
  connectReq.on("connect", (res, socket) => {
    activeSocket = socket;
    if (settled) {
      socket.destroy();
      return;
    }
    if (res.statusCode !== 200) {
      socket.destroy();
      fail(new Error(`proxy CONNECT failed (${res.statusCode})`));
      return;
    }
    const tlsSocket = target.protocol === "https:"
      ? tls.connect({ socket, servername: target.hostname })
      : socket;
    activeSocket = tlsSocket;
    const reqOpts = {
      createConnection: () => tlsSocket,
      host: target.hostname,
      port: targetPort,
      method: "GET",
      path: `${target.pathname}${target.search}`,
      headers: { Host: target.host, Connection: "close" },
    };
    const inner = (target.protocol === "https:" ? https : http).request(reqOpts, async (innerRes) => {
      try {
        const body = await readStreamBuffer(innerRes);
        finish({ status: innerRes.statusCode || 0, location: innerRes.headers.location || "", body });
      } catch (e) { fail(e); }
    });
    activeInner = inner;
    inner.on("error", fail);
    inner.end();
  });
  connectReq.on("error", fail);
  connectReq.end();
});

const OFFICIAL_ASSET_HOSTS = new Set(["storage.bdon.moe", "assets.bdon.moe", "cubism.live2d.com"]);

const isTunFakeIpV4 = (ip) => {
  if (!net.isIPv4(ip)) return false;
  const parts = ip.split(".").map(Number);
  return parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
};

export const assertOfficialRemoteUrl = async (value, { allowPrivateUrl = false, proxy = "", lookup = null } = {}) => {
  if (allowPrivateUrl) return new URL(String(value));
  const u = assertPublicHttpUrl(value, "official asset url");
  if (proxy) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!OFFICIAL_ASSET_HOSTS.has(host)) return resolvePublicUrl(value, "official asset url");
  if (net.isIP(host)) return u;
  const resolveDns = lookup || ((h) => dns.lookup(h, { all: true, verbatim: true }));
  let addresses;
  try {
    addresses = await resolveDns(host);
  } catch (e) {
    throw new Error(`official asset url: cannot resolve ${host}: ${e.message}`, { cause: e });
  }
  if (!addresses?.length) throw new Error(`official asset url: ${host} resolves to no address`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address) && !isTunFakeIpV4(address)) {
      throw new Error(`official asset url: ${host} resolves to a private, loopback or reserved address`);
    }
  }
  return u;
};

export const fetchRemoteBytes = async (url, { timeoutMs = 15000, allowPrivateUrl = false, proxyUrl = "",
                                                 signal = null } = {}) => {
  let current = url;
  for (let hops = 0; hops < 5; hops++) {
    signal?.throwIfAborted?.();
    const proxy = proxyUrl || selectProxyUrl(current);
    await assertOfficialRemoteUrl(current, { allowPrivateUrl, proxy });
    signal?.throwIfAborted?.();
    let status = 0, location = "", body = null;
    if (proxy) {
      const res = await requestViaHttpProxy(current, proxy, timeoutMs, signal);
      status = res.status;
      location = res.location;
      body = res.body;
    } else {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const reqSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(current, { redirect: "manual", signal: reqSignal });
      status = res.status;
      location = res.headers.get("location") || "";
      if (status >= 200 && status < 300) body = Buffer.from(await res.arrayBuffer());
    }
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status} for ${current}`);
    return body || Buffer.alloc(0);
  }
  throw new Error(`too many redirects fetching ${url}`);
};

export const decodeRemoteAsset = (raw, relAsset) => {
  if (relAsset.endsWith(".gz")) return zlib.gunzipSync(raw);
  if (relAsset.endsWith(".br")) return zlib.brotliDecompressSync(raw);
  return raw;
};

export const extOfRelPath = (rel) => {
  const clean = String(rel || "").replace(/\.(gz|br)$/i, "");
  const dot = path.posix.extname(clean).replace(/^\./, "").toLowerCase();
  return dot || "bin";
};

const collectLocalAssetsPool = (site) => {
  const frames = new Map(), frameAliases = new Map();
  const postEffects = new Map(), postEffectAliases = new Map();
  const effectInstances = new Map(), effectAssets = new Map(), effectAliases = new Map();
  const stills = new Map(), stillAliases = new Map();
  const transitions = new Map(), transitionAliases = new Map();

  const absorbManifest = (manifest) => {
    const files = manifest?.files || {};
    if (files["frames.json"]) {
      try {
        const doc = readEntry(site, files["frames.json"]);
        for (const k of Object.keys(doc.frames || {})) { frames.set(k, true); addAliasKey(frameAliases, k, k); }
      } catch { /* ignore */ }
    }
    if (files["posteffects.json"]) {
      try {
        const doc = readEntry(site, files["posteffects.json"]);
        for (const k of Object.keys(doc.postEffects || {})) {
          postEffects.set(k, true); addAliasKey(postEffectAliases, k, k);
        }
      } catch { /* ignore */ }
    }
    if (files["effects.json"]) {
      try {
        const doc = readEntry(site, files["effects.json"]);
        for (const k of Object.keys(doc.instances || {})) {
          effectInstances.set(k, true); addAliasKey(effectAliases, k, k);
        }
        for (const k of Object.keys(doc.effects || {})) {
          effectAssets.set(k, true); addAliasKey(effectAliases, k, k);
        }
      } catch { /* ignore */ }
    }
    if (files["stills.json"]) {
      try {
        const doc = readEntry(site, files["stills.json"]);
        for (const k of Object.keys(doc.stills || {})) { stills.set(k, true); addAliasKey(stillAliases, k, k); }
      } catch { /* ignore */ }
    }
    for (const [addr] of readUiTransitions(site, manifest)) {
      transitions.set(addr, true);
      addAliasKey(transitionAliases, addr, addr);
    }
  };

  const storiesDir = path.join(site, "stories");
  for (const name of fs.existsSync(storiesDir) ? fs.readdirSync(storiesDir).sort() : []) {
    if (!name.endsWith(".json")) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(storiesDir, name), "utf8"));
      if (m && m.files) absorbManifest(m);
    } catch { /* ignore */ }
  }
  const bundlePath = path.join(site, "official-bundles.json");
  if (fs.existsSync(bundlePath)) {
    try {
      const m = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
      if (m && m.files) absorbManifest(m);
    } catch { /* ignore */ }
  }
  return { frames, frameAliases, postEffects, postEffectAliases, effectInstances, effectAssets,
           effectAliases, stills, stillAliases, transitions, transitionAliases };
};

// Fetches and caches missing official Frame, PostEffect, Effect, Still, rule Transition and shader/texture blobs
// from `storage.bdon.moe/moenotes` (or custom `baseUrl`) into `<site>/official-bundles.json` + `<site>/assets/`.
// Supports proxy env (`NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`) and falls back gracefully when offline.
export const ensureOfficialAssetBundles = async ({
  site,
  baseUrl = OFFICIAL_BUNDLE_BASE_URL,
  targets = DEFAULT_OFFICIAL_ASSET_TARGETS,
  seedEpisodes = OFFICIAL_ASSET_SEED_EPISODES,
  scanIndex = true,
  maxIndexEpisodes = 60,
  timeoutMs = 15000,
  allowPrivateUrl = false,
  proxyUrl = "",
  signal = null,
} = {}) => {
  if (!site) throw new Error("ensureOfficialAssetBundles: site directory is required");
  const cleanBase = String(baseUrl || OFFICIAL_BUNDLE_BASE_URL).replace(/\/+$/, "");
  const want = {
    frames: unique(targets?.frames || []),
    postEffects: unique(targets?.postEffects || []),
    effects: unique(targets?.effects || []),
    stills: unique(targets?.stills || []),
    transitions: unique(targets?.transitions || []),
  };
  const local = collectLocalAssetsPool(site);
  const missing = {
    frames: want.frames.filter((k) => !resolveAliasKey(local.frames, local.frameAliases, k)),
    postEffects: want.postEffects.filter((k) => !resolveAliasKey(local.postEffects, local.postEffectAliases, k)),
    effects: want.effects.filter((k) => !resolveAliasKey(local.effectInstances, local.effectAliases, k) &&
                                        !resolveAliasKey(local.effectAssets, local.effectAliases, k)),
    stills: want.stills.filter((k) => !resolveAliasKey(local.stills, local.stillAliases, k)),
    transitions: want.transitions.filter((k) => !resolveAliasKey(local.transitions, local.transitionAliases, k)),
  };
  const remainingCount = () => missing.frames.length + missing.postEffects.length + missing.effects.length +
    missing.stills.length + missing.transitions.length;
  const flatMissing = () => ({
    frames: [...missing.frames],
    postEffects: [...missing.postEffects],
    effects: [...missing.effects],
    stills: [...missing.stills],
    transitions: [...missing.transitions],
  });

  const bundlePath = path.join(site, "official-bundles.json");
  if (!remainingCount()) {
    return {
      ok: true, offline: false, cached: [],
      missing: flatMissing(),
      bundleFile: fs.existsSync(bundlePath) ? "official-bundles.json" : "",
    };
  }

  let bundle = { format: "ournotes.official-bundles/1", source: cleanBase, updatedAt: "", files: {} };
  if (fs.existsSync(bundlePath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
      if (prev && typeof prev === "object" && prev.files) bundle = prev;
    } catch { /* rebuild bundle index cleanly */ }
  }
  const bundleFiles = bundle.files = { ...(bundle.files || {}) };
  const readBundleJson = (rel, initVal) => {
    if (!bundleFiles[rel]) return initVal;
    try { return readEntry(site, bundleFiles[rel]); } catch { return initVal; }
  };
  const framesDoc = readBundleJson("frames.json", { frames: {} });
  framesDoc.frames ||= {};
  const postEffectsDoc = readBundleJson("posteffects.json", { postEffects: {} });
  postEffectsDoc.postEffects ||= {};
  const effectsDoc = readBundleJson("effects.json", { instances: {}, effects: {} });
  effectsDoc.instances ||= {};
  effectsDoc.effects ||= {};
  const stillsDoc = readBundleJson("stills.json", { stills: {} });
  stillsDoc.stills ||= {};
  const uiDoc = readBundleJson("ui/ui.json", { transitions: {}, textures: {} });
  uiDoc.transitions ||= {};
  uiDoc.textures ||= {};
  const shadersList = readBundleJson("shaders/shaders.json", []);
  const shaderMap = new Map(Array.isArray(shadersList) ? shadersList.filter((r) => r?.name).map((r) => [r.name, r]) : []);

  const fetchOpts = { timeoutMs, allowPrivateUrl, proxyUrl, signal };
  const remoteRawCache = new Map();
  const cached = [];
  const errors = [];
  let dirtyFrames = false, dirtyPost = false, dirtyEffects = false, dirtyStills = false, dirtyUi = false, dirtyShaders = false;

  const downloadEntryRaw = async (entry) => {
    if (!entry || !isSafeRelPath(entry.asset)) throw new Error("invalid remote asset path");
    if (remoteRawCache.has(entry.asset)) return remoteRawCache.get(entry.asset);
    const bytes = await fetchRemoteBytes(`${cleanBase}/${entry.asset}`, fetchOpts);
    const raw = decodeRemoteAsset(bytes, entry.asset);
    remoteRawCache.set(entry.asset, raw);
    return raw;
  };
  const readRemoteJson = async (entry) => JSON.parse((await downloadEntryRaw(entry)).toString("utf8"));

  const mirrorRemoteFile = async (rel, entry) => {
    if (!entry || !isSafeRelPath(rel) || !isSafeRelPath(entry.asset)) return;
    if (bundleFiles[rel]) return;
    const raw = await downloadEntryRaw(entry);
    bundleFiles[rel] = writeAsset(site, raw, extOfRelPath(rel));
  };

  const mirrorRemoteShaders = async (remoteManifest, wantedNames) => {
    if (!wantedNames.size || !remoteManifest.files?.["shaders/shaders.json"]) return;
    let list;
    try { list = await readRemoteJson(remoteManifest.files["shaders/shaders.json"]); } catch { return; }
    if (!Array.isArray(list)) return;
    const byName = new Map(list.filter((r) => r?.name).map((r) => [r.name, r]));
    for (const name of wantedNames) {
      if (shaderMap.has(name) || !byName.has(name)) continue;
      const rec = byName.get(name);
      if (rec.parsed && remoteManifest.files[`shaders/${rec.parsed}`]) {
        await mirrorRemoteFile(`shaders/${rec.parsed}`, remoteManifest.files[`shaders/${rec.parsed}`]);
      }
      for (const v of rec.variants || []) {
        if (v?.file && remoteManifest.files[`shaders/${v.file}`]) {
          await mirrorRemoteFile(`shaders/${v.file}`, remoteManifest.files[`shaders/${v.file}`]);
        }
      }
      shaderMap.set(name, rec);
      dirtyShaders = true;
    }
  };

  const mirrorNodeDeps = async (node, remoteManifest) => {
    const rFiles = remoteManifest.files || {};
    const remoteShaderNames = new Set();
    if (rFiles["shaders/shaders.json"]) {
      try {
        const list = await readRemoteJson(rFiles["shaders/shaders.json"]);
        if (Array.isArray(list)) for (const rec of list) if (rec?.name) remoteShaderNames.add(rec.name);
      } catch { /* ignore */ }
    }
    const fakeShaders = new Map([...remoteShaderNames].map((n) => [n, true]));
    const deps = collectDeps(node, rFiles, fakeShaders);
    for (const [rel, entry] of Object.entries(deps.files)) await mirrorRemoteFile(rel, entry);
    await mirrorRemoteShaders(remoteManifest, new Set(deps.shaders.keys()));
  };

  const processManifest = async (remoteManifest) => {
    const rFiles = remoteManifest?.files || {};
    if (missing.frames.length && rFiles["frames.json"]) {
      const doc = await readRemoteJson(rFiles["frames.json"]);
      const aliases = new Map();
      for (const k of Object.keys(doc.frames || {})) addAliasKey(aliases, k, k);
      const anim = indexAnimDoc(doc);
      const stillLeft = [];
      for (const req of missing.frames) {
        const canonical = resolveAliasKey(doc.frames || {}, aliases, req);
        if (!canonical) { stillLeft.push(req); continue; }
        const hydrated = inlineAnimRefs(structuredClone(doc.frames[canonical]), anim);
        await mirrorNodeDeps(hydrated, remoteManifest);
        framesDoc.frames[canonical] = hydrated;
        if (canonical !== req) framesDoc.frames[req] = hydrated;
        dirtyFrames = true;
        cached.push(canonical);
      }
      missing.frames = stillLeft;
    }

    if (missing.postEffects.length && rFiles["posteffects.json"]) {
      const doc = await readRemoteJson(rFiles["posteffects.json"]);
      const aliases = new Map();
      for (const k of Object.keys(doc.postEffects || {})) addAliasKey(aliases, k, k);
      const stillLeft = [];
      for (const req of missing.postEffects) {
        const canonical = resolveAliasKey(doc.postEffects || {}, aliases, req);
        if (!canonical) { stillLeft.push(req); continue; }
        const prof = structuredClone(doc.postEffects[canonical]);
        await mirrorNodeDeps(prof, remoteManifest);
        postEffectsDoc.postEffects[canonical] = prof;
        if (canonical !== req) postEffectsDoc.postEffects[req] = { ...prof, name: req };
        dirtyPost = true;
        cached.push(canonical);
      }
      missing.postEffects = stillLeft;
    }

    if (missing.effects.length && rFiles["effects.json"]) {
      const doc = await readRemoteJson(rFiles["effects.json"]);
      const aliases = new Map();
      for (const k of [...Object.keys(doc.instances || {}), ...Object.keys(doc.effects || {})]) addAliasKey(aliases, k, k);
      const anim = indexAnimDoc(doc);
      const stillLeft = [];
      for (const req of missing.effects) {
        const instKey = resolveAliasKey(doc.instances || {}, aliases, req);
        const assetKey = instKey ? doc.instances[instKey] : resolveAliasKey(doc.effects || {}, aliases, req);
        const rawEntry = assetKey && doc.effects?.[assetKey];
        if (!rawEntry) { stillLeft.push(req); continue; }
        const hydrated = inlineAnimRefs(structuredClone(rawEntry), anim);
        await mirrorNodeDeps(hydrated, remoteManifest);
        effectsDoc.effects[assetKey] = hydrated;
        effectsDoc.instances[instKey || req] = assetKey;
        if (req !== (instKey || req)) effectsDoc.instances[req] = assetKey;
        dirtyEffects = true;
        cached.push(instKey || assetKey);
      }
      missing.effects = stillLeft;
    }

    if (missing.stills.length && rFiles["stills.json"]) {
      const doc = await readRemoteJson(rFiles["stills.json"]);
      const aliases = new Map();
      for (const k of Object.keys(doc.stills || {})) addAliasKey(aliases, k, k);
      const anim = indexAnimDoc(doc);
      const stillLeft = [];
      for (const req of missing.stills) {
        const canonical = resolveAliasKey(doc.stills || {}, aliases, req);
        if (!canonical) { stillLeft.push(req); continue; }
        const hydrated = inlineAnimRefs(structuredClone(doc.stills[canonical]), anim);
        await mirrorNodeDeps(hydrated, remoteManifest);
        stillsDoc.stills[canonical] = hydrated;
        if (canonical !== req) stillsDoc.stills[req] = hydrated;
        dirtyStills = true;
        cached.push(canonical);
      }
      missing.stills = stillLeft;
    }

    if (missing.transitions.length) {
      const langScope = remoteManifest.languages?.[remoteManifest.language]?.files
        || Object.values(remoteManifest.languages || {})[0]?.files || {};
      const uiEntry = langScope["ui/ui.json"] || rFiles["ui/ui.json"];
      if (uiEntry) {
        let transitions = {}, uiTextures = {};
        if (Array.isArray(uiEntry.parts)) {
          const tPart = uiEntry.parts.find(([k]) => k === "transitions");
          const texPart = uiEntry.parts.find(([k]) => k === "textures");
          if (tPart?.[1]) transitions = await readRemoteJson({ asset: tPart[1] });
          if (texPart?.[1]) uiTextures = await readRemoteJson({ asset: texPart[1] });
        } else {
          const fullUi = await readRemoteJson(uiEntry);
          transitions = fullUi.transitions || {};
          uiTextures = fullUi.textures || {};
        }
        const aliases = new Map();
        for (const k of Object.keys(transitions)) addAliasKey(aliases, k, k);
        const stillLeft = [];
        for (const req of missing.transitions) {
          const canonical = resolveAliasKey(transitions, aliases, req);
          if (!canonical) { stillLeft.push(req); continue; }
          const tr = transitions[canonical];
          const texName = tr._texture?.texture || "";
          const texMeta = texName ? uiTextures[texName] : null;
          const texPath = texMeta?.texture || texMeta?.file || "";
          if (texPath) {
            const relUi = texPath.startsWith("ui/") ? texPath : `ui/${texPath}`;
            const blobEntry = langScope[relUi] || rFiles[relUi] || langScope[texPath] || rFiles[texPath];
            if (blobEntry) await mirrorRemoteFile(relUi, blobEntry);
          }
          uiDoc.transitions[canonical] = tr;
          if (canonical !== req) uiDoc.transitions[req] = tr;
          if (texName && texMeta) uiDoc.textures[texName] = texMeta;
          dirtyUi = true;
          cached.push(canonical);
        }
        missing.transitions = stillLeft;
      }
    }
  };

  const seenManifests = new Set();
  const queue = (seedEpisodes || []).map((ep) => `stories/${String(ep).replace(/\.json$/i, "")}.json`);
  let scannedIndex = false;

  for (let i = 0; i < queue.length && remainingCount() > 0; i++) {
    signal?.throwIfAborted?.();
    const rel = queue[i];
    if (!isSafeRelPath(rel) || seenManifests.has(rel)) continue;
    seenManifests.add(rel);
    try {
      const m = JSON.parse((await fetchRemoteBytes(`${cleanBase}/${rel}`, fetchOpts)).toString("utf8"));
      await processManifest(m);
    } catch (e) {
      if (signal?.aborted) throw signal.reason || e;
      errors.push(`${rel}: ${e.message}`);
    }
    if (i === queue.length - 1 && remainingCount() > 0 && scanIndex && !scannedIndex) {
      scannedIndex = true;
      try {
        const index = JSON.parse((await fetchRemoteBytes(`${cleanBase}/stories.json`, fetchOpts)).toString("utf8"));
        const list = (Array.isArray(index.stories) ? index.stories : [])
          .filter((s) => s && s.manifest && (s.playbackMode === undefined || s.playbackMode === 0));
        for (const item of list.slice(0, maxIndexEpisodes)) {
          if (!seenManifests.has(item.manifest)) queue.push(item.manifest);
        }
      } catch (e) {
        if (signal?.aborted) throw signal.reason || e;
        errors.push(`stories.json: ${e.message}`);
      }
    }
  }

  if (dirtyFrames) bundleFiles["frames.json"] = writeAsset(site, Buffer.from(JSON.stringify(framesDoc)));
  if (dirtyPost) bundleFiles["posteffects.json"] = writeAsset(site, Buffer.from(JSON.stringify(postEffectsDoc)));
  if (dirtyEffects) bundleFiles["effects.json"] = writeAsset(site, Buffer.from(JSON.stringify(effectsDoc)));
  if (dirtyStills) bundleFiles["stills.json"] = writeAsset(site, Buffer.from(JSON.stringify(stillsDoc)));
  if (dirtyUi) bundleFiles["ui/ui.json"] = writeAsset(site, Buffer.from(JSON.stringify(uiDoc)));
  if (dirtyShaders) bundleFiles["shaders/shaders.json"] = writeAsset(site, Buffer.from(JSON.stringify([...shaderMap.values()])));
  if (cached.length || fs.existsSync(bundlePath)) {
    bundle.updatedAt = new Date().toISOString();
    fs.mkdirSync(site, { recursive: true });
    writeAtomic(bundlePath, JSON.stringify(bundle, null, 2));
  }

  return {
    ok: remainingCount() === 0,
    offline: errors.length > 0 && cached.length === 0,
    error: errors[0] || "",
    errors,
    cached: unique(cached),
    missing: flatMissing(),
    bundleFile: fs.existsSync(bundlePath) ? "official-bundles.json" : "",
  };
};

export const parseArgs = (argv) => {
  const o = { site: "", base: "", script: "", adv: "", out: "", lang: "", title: "", list: false, ensureAssets: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--site") o.site = argv[++i] || "";
    else if (a === "--base") o.base = argv[++i] || "";
    else if (a === "--script") o.script = argv[++i] || "";
    else if (a === "--adv") o.adv = argv[++i] || "";
    else if (a === "--out") o.out = argv[++i] || "";
    else if (a === "--lang") o.lang = argv[++i] || "";
    else if (a === "--title") o.title = argv[++i] || "";
    else if (a === "--list") o.list = true;
    else if (a === "--ensure-assets") o.ensureAssets = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.site) throw new Error("--site is required (a site-format story site directory)");
  if (!o.base) throw new Error("--base is required (the site-relative base story manifest)");
  if (!o.list && !o.script) throw new Error("--script is required (an ournotes.story-script/1 JSON file)");
  if (!o.list && !o.adv) throw new Error("--adv is required (the new story id)");
  return o;
};

const main = async () => {
  const o = parseArgs(process.argv.slice(2));
  const site = path.resolve(o.site);
  if (o.ensureAssets) await ensureOfficialAssetBundles({ site });
  if (o.list) {
    const c = readSiteCatalog(site, o.base, o.lang);
    console.log(JSON.stringify({
      base: o.base, language: c.lang,
      stages: c.base.stages,
      music: c.base.music,
      sounds: c.base.sounds,
      frames: c.base.frames,
      postEffects: c.base.postEffects,
      effects: c.base.effects,
      stills: c.base.stills,
      transitions: c.base.transitions,
      models: c.models.map((id) => ({ id, ...c.actions.get(id) })),
    }, null, 2));
    return;
  }
  const scriptPath = path.resolve(o.script);
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
  const result = buildSiteStory({ site, baseRel: o.base, script, advId: o.adv, language: o.lang, title: o.title, outRel: o.out });
  if (result.errors) {
    console.log(JSON.stringify({ ok: false, errors: result.errors, warnings: result.warnings }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, manifest: result.manifestPath, advId: result.manifest.advId,
    language: result.language, commands: result.episode.commandCount, lines: result.compiled.lines.length,
    voices: result.voices, warnings: result.warnings }, null, 2));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(2); });
}
