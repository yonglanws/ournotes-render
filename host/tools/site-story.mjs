// Compiles an ournotes.story-script/1 director script onto a site-format story site (ournotes.story-manifest/2),
// the format bdon.moe's story player serves. The site's own stage, music, models, motions and expressions are the
// vocabulary; the output is a new story manifest and its episode asset inside the site, so render-story can play it.
//
// This is the authoring bridge for sites that are not nnnotes product sites: the AI writer and the API queue use this
// same script format, and the product path compiles it with the same script library.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { compileScript, checkScript, cueLabel, fontFamily, parseScript, withBrowserFonts } from "../../scripts/lib/story-author/script.js";
import { STORY_LANGUAGES } from "../../src/story/params.js";
import { applyMusicGuide, applySoundGuide, applyStageGuide, loadResourceGuide } from "../story/resourceGuide.js";

const FIELD = (language) => {
  const field = STORY_LANGUAGES[language];
  if (!field) throw new Error(`unknown story language ${language}`);
  return field;
};

const readAsset = (site, rel) => {
  let b = fs.readFileSync(path.join(site, rel));
  if (rel.endsWith(".gz")) b = zlib.gunzipSync(b);
  else if (rel.endsWith(".br")) b = zlib.brotliDecompressSync(b);
  return b;
};

// An entry of a site manifest: a file {asset,size,stored}, or parts [[key, asset, size, stored], ...] merged into one
// object (the prefab of a model is split this way).
const readEntry = (site, entry, kind = "json") => {
  if (!entry) throw new Error("missing file entry");
  if (Array.isArray(entry.parts)) {
    const out = {};
    for (const [key, asset] of entry.parts) out[key] = JSON.parse(readAsset(site, asset).toString());
    return out;
  }
  const bytes = readAsset(site, entry.asset);
  return kind === "json" ? JSON.parse(bytes.toString()) : bytes;
};

const writeAtomic = (file, data) => {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};

const writeAsset = (site, bytes, ext = "json") => {
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

// Adds synthesized voices to a site episode: one TTS cue sheet under audio/ournotes_tts, one WAV per Talk line, and
// VoiceIDs/voiceCues on the row. The site engine then plays the real waveforms (and MotionSync reads them).
const addSiteVoices = ({ site, episode, voices }) => {
  if (!voices || !voices.size) return { files: {} };
  const files = {}, cues = {};
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

// The stage prefabs of a story's own scene.json. The map is split out of a multi-part asset, so only the `stages`
// part has to be read (and later rewritten).
const readSceneStages = (site, manifest) => {
  const entry = manifest.files && manifest.files["scene.json"];
  if (!entry) return { entry: null, stages: {} };
  if (Array.isArray(entry.parts)) {
    const part = entry.parts.find(([key]) => key === "stages");
    return { entry, stages: part ? JSON.parse(readAsset(site, part[1]).toString()) : {} };
  }
  const scene = readEntry(site, entry);
  return { entry, stages: scene.stages || {} };
};

const textureEntries = (manifest, id) => Object.fromEntries(Object.entries(manifest.files || {})
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

// Every story of the site contributes its locations and sounds to one pool, so a new episode is not limited to the
// handful of backgrounds its base story happened to use. The base story is added first, in its own command order, so
// its captions and ordering win; a donor only fills in the prefab/texture/audio entries the new manifest must copy.
//
// A location is also owned: the first story that uses it casts the characters it belongs to. A school rooftop from a
// story about another band is not offered to this story's cast (the guide names the place, but the model still picked
// 水濑女子学园's rooftop for MyGO when both were listed). Sounds are not filtered: a BGM or SE is not tied to a cast.
const readSitePool = (site, baseRel, baseManifest, baseEpisode, field, { all = true, castOnly = true } = {}) => {
  const stages = [], music = [], sounds = [];
  const stageIds = new Set(), musicCues = new Set(), soundCues = new Set();
  const stageFiles = new Map(), stagePrefabs = new Map(), soundFiles = new Map();
  const stageCasts = new Map();
  const seen = new Set([baseRel]);

  const addStory = (manifest, episode, stageOrder = []) => {
    const scene = readSceneStages(site, manifest);
    const cast = castKeysOf(site, manifest);
    const keys = Object.keys(scene.stages);
    if (stageOrder.length) {
      keys.sort((a, b) => stageOrder.indexOf(a.split("/").pop()) - stageOrder.indexOf(b.split("/").pop()));
    }
    for (const key of keys) {
      const id = key.split("/").pop();
      if (!stagePrefabs.has(key)) stagePrefabs.set(key, scene.stages[key]);
      const files = textureEntries(manifest, id);
      if (!stageIds.has(id)) {
        stageIds.add(id);
        stages.push({ key, id, caption: "" });
        stageCasts.set(key, cast);
      }
      if (!(stageFiles.get(key) || {}).length && Object.keys(files).length) stageFiles.set(key, files);
    }
    const rows = readSoundRows(site, manifest, episode);
    for (const item of rows.music) {
      if (musicCues.has(item.cue)) continue;
      musicCues.add(item.cue);
      music.push(item);
      soundFiles.set(item.sheet, item.audio);
    }
    for (const item of rows.sounds) {
      if (soundCues.has(item.cue)) continue;
      soundCues.add(item.cue);
      sounds.push(item);
      soundFiles.set(item.sheet, item.audio);
    }
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
      // A partially downloaded donor can still fail while reading scene/texture assets; one bad story must not take
      // down the whole catalog (and with it every script-generation request).
      try { addStory(manifest, episode); } catch { continue; }
    }
  }
  // Only the base story's captions are used: a donor's chapter title describes the donor's scene, not the place.
  const baseStages = readStageRows(baseEpisode, field);
  const captions = new Map(baseStages.map((stage) => [stage.id, stage.caption]));
  const baseCast = castKeysOf(site, baseManifest);
  const baseIds = new Set(baseStages.map((stage) => stage.id));
  const offered = castOnly && baseCast.size
    ? stages.filter((stage) => baseIds.has(stage.id) || !stageCasts.get(stage.key)?.size ||
        [...stageCasts.get(stage.key)].some((key) => baseCast.has(key)))
    : stages;
  for (const stage of offered) stage.caption = captions.get(stage.id) || "";
  return { stages: offered, music, sounds, stageFiles, stagePrefabs, soundFiles,
           baseSceneStages: readSceneStages(site, baseManifest).stages };
};

// The vocabulary of a site-format story: its stages, BGM, SE cues and every model's actions.
export const readSiteCatalog = (site, baseRel, language = "", { guide = null, pool = true } = {}) => {
  const book = guide || loadResourceGuide(site);
  const baseManifest = JSON.parse(fs.readFileSync(path.join(site, baseRel), "utf8"));
  if (baseManifest.format !== "ournotes.story-manifest/2")
    throw new Error(`${baseRel}: not an ournotes.story-manifest/2 story`);
  const lang = language || baseManifest.language;
  const field = FIELD(lang);
  const baseEpisode = readEntry(site, baseManifest.files["episode.json"]);
  const poolData = readSitePool(site, baseRel, baseManifest, baseEpisode, field, { all: pool });
  // The guide is what makes an id choosable: a human name, what the picture is, and the facets the prompt reasons
  // about. Title-card backdrops are dropped instead of offered: they render as a black screen.
  const stageList = poolData.stages.map((stage) => applyStageGuide(stage, book)).filter(Boolean);
  const music = poolData.music.map((item) => applyMusicGuide(item, book));
  const sounds = poolData.sounds.map((item) => applySoundGuide(item, book));
  // The compiler reads the donor rows and cue sheets from the episode it was given, so merge them in.
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
    episode: baseEpisode,
    story: baseStory,
  };
  return { baseManifest, baseEpisode, base, lang, field, models: modelIds, actions, modelKeys, guide: book, pool: poolData };
};

// A scene.json entry with its `stages` replaced. The asset is split into named parts (player, cameraManager, …), so
// only the stages part is rewritten; a single-file scene is rewritten whole.
const writeSceneStages = (site, entry, stages) => {
  if (Array.isArray(entry.parts)) {
    const current = entry.parts.find(([key]) => key === "stages");
    const written = writeAsset(site, Buffer.from(JSON.stringify(stages)));
    // `size` is the byte length of the rebuilt `{"player":…,"stages":…}` text, not the sum of the parts: keep it exact
    // by applying the stages delta to the original value.
    const oldSize = current ? Number(current[2]) || 0 : 0;
    const size = Number.isFinite(Number(entry.size)) ? Number(entry.size) - oldSize + written.size : undefined;
    const parts = entry.parts.map(([key, asset, partSize, stored]) => key === "stages"
      ? [key, written.asset, written.size, written.stored]
      : [key, asset, partSize, stored].filter((value) => value !== undefined));
    return size === undefined ? { parts } : { parts, size };
  }
  const scene = readEntry(site, entry);
  scene.stages = stages;
  return writeAsset(site, Buffer.from(JSON.stringify(scene)));
};

// The rows and texts of `script` as a new story of `site`; `advId` names it, `outRel` is its manifest path.
export const buildSiteStory = ({ site, baseRel, script, advId, language = "", title = "", outRel = "",
                                  voices = null, guide = null, pool = true }) => {
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
  // The resources this episode actually uses. A stage from another story needs its prefab, texture and scene entry;
  // a BGM/SE sheet from another story needs its cue sheet and audio files. Everything else stays out of the manifest.
  const usedStages = new Set(episode.commands.filter((c) => c.cmd === "Stage" && c.TargetAssetName)
    .map((c) => c.TargetAssetName));
  const usedSheets = new Set(Object.values(episode.cuesheets || {})
    .map((sheet) => sheet && sheet._cueSheetName).filter(Boolean));
  const baseManifest = catalog.baseManifest;
  // The new episode may cast models the base story never used (another band in the same site). The story index lists
  // the model keys of the episode, and manifest.models maps each id to its model manifest, so both have to grow.
  const baseStoryEntry = baseManifest.files["story.json"];
  const storyIndex = baseStoryEntry ? readEntry(site, baseStoryEntry) : null;
  const castModels = compiled.story?.parts?.models || {};
  let storyEntry = null;
  if (storyIndex) {
    // The site story index is flat (`models`, not `parts.models`): add the cast model keys the base story lacks.
    storyIndex.models = { ...(storyIndex.models || {}), ...castModels };
    if (voices && voices.size) storyIndex.audio = { ...(storyIndex.audio || {}), [TTS_SHEET]: `audio/${TTS_SHEET}` };
    // Sounds borrowed from another story have to be listed in the index's audio map as well.
    for (const sheet of usedSheets) {
      storyIndex.audio = { ...(storyIndex.audio || {}), [sheet]: `audio/${sheet}` };
    }
    storyEntry = writeAsset(site, Buffer.from(JSON.stringify(storyIndex)));
  }
  const modelIndex = (() => {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(site, "models.json"), "utf8"));
      return new Map((doc.models || []).map((m) => [m.id, m.manifest]));
    } catch { return new Map(); }
  })();
  const manifest = JSON.parse(JSON.stringify(baseManifest));
  manifest.advId = Number(advId) || advId;
  manifest.language = lang;
  manifest.languages = { [lang]: JSON.parse(JSON.stringify(baseManifest.languages?.[lang] || { files: {} })) };
  manifest.models = { ...(baseManifest.models || {}) };
  for (const modelId of Object.values(castModels)) {
    const rel = modelIndex.get(modelId);
    if (rel) manifest.models[modelId] = rel;
  }
  // The site's font atlas only has the base story's characters. Replace it with the same font product in browser-font
  // mode, so the director script's new lines draw with the machine's font family instead of missing glyphs.
  const langFiles = manifest.languages[lang].files;
  if (langFiles && langFiles["ui/fonts.json"]) {
    const fonts = readEntry(site, langFiles["ui/fonts.json"]);
    const browser = withBrowserFonts(fonts, fontFamily(parsed.script.font, checked.language));
    langFiles["ui/fonts.json"] = writeAsset(site, Buffer.from(JSON.stringify(browser)));
  }
  const usedFiles = {};
  for (const key of usedStages) Object.assign(usedFiles, catalog.pool.stageFiles.get(key) || {});
  for (const sheet of usedSheets) Object.assign(usedFiles, catalog.pool.soundFiles.get(sheet) || {});
  // A stage the base story never used needs its prefab in scene.json, not only its texture in the file map.
  const baseSceneStages = catalog.pool.baseSceneStages || {};
  const addedStages = [...usedStages].filter((key) => !(key in baseSceneStages));
  let sceneEntry = baseManifest.files["scene.json"];
  if (addedStages.length) {
    const merged = { ...baseSceneStages };
    for (const key of addedStages) {
      const prefab = catalog.pool.stagePrefabs.get(key);
      if (prefab) merged[key] = prefab;
    }
    sceneEntry = writeSceneStages(site, sceneEntry, merged);
  }
  const ttsFiles = addSiteVoices({ site, episode, voices }).files;
  const episodeEntry = writeAsset(site, Buffer.from(JSON.stringify(episode)));
  manifest.files = { ...baseManifest.files, ...usedFiles, ...ttsFiles,
                     ...(sceneEntry !== baseManifest.files["scene.json"] ? { "scene.json": sceneEntry } : {}),
                     ...(storyEntry ? { "story.json": storyEntry } : {}),
                     "episode.json": episodeEntry };
  if (voices && voices.size) {
    manifest.audio = true;
    manifest.audioFormat = "wav";
  }
  manifest.requires = { ...(baseManifest.requires || {}), commands };
  manifest.story = { ...(baseManifest.story || {}), advId: manifest.advId, asset: id, sheetName: id,
    commandCount: episode.commandCount, commands, groups: [], language: lang, languages: [lang], playbackMode: 0,
    titles: { [lang]: title || script.title || id } };
  const out = outRel || `stories/${id}.json`;
  fs.mkdirSync(path.dirname(path.join(site, out)), { recursive: true });
  writeAtomic(path.join(site, out), JSON.stringify(manifest, null, 2));
  // the site's index, so the new story is listed next to the base
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
  return { manifest, manifestPath: out, episode, compiled, warnings: checked.warnings, language: lang,
           voices: voices ? voices.size : 0 };
};

export const parseArgs = (argv) => {
  const o = { site: "", base: "", script: "", adv: "", out: "", lang: "", title: "", list: false };
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
  if (o.list) {
    const c = readSiteCatalog(site, o.base, o.lang);
    console.log(JSON.stringify({
      base: o.base, language: c.lang,
      stages: c.base.stages,
      music: c.base.music,
      sounds: c.base.sounds,
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
