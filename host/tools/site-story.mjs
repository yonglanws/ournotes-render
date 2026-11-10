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
import { compileScript, checkScript, cueLabel, fontFamily, parseScript, soundChoices, withBrowserFonts } from "../../scripts/lib/story-author/script.js";
import { STORY_LANGUAGES } from "../../src/story/params.js";

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

const writeAsset = (site, bytes, ext = "json") => {
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const gz = zlib.gzipSync(bytes);
  const rel = `assets/${sha}.${ext}.gz`;
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  fs.writeFileSync(path.join(site, rel), gz);
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

// The vocabulary of a site-format story: its stages, BGM, SE cues and every model's actions.
export const readSiteCatalog = (site, baseRel, language = "") => {
  const baseManifest = JSON.parse(fs.readFileSync(path.join(site, baseRel), "utf8"));
  if (baseManifest.format !== "ournotes.story-manifest/2")
    throw new Error(`${baseRel}: not an ournotes.story-manifest/2 story`);
  const lang = language || baseManifest.language;
  const field = FIELD(lang);
  const baseEpisode = readEntry(site, baseManifest.files["episode.json"]);
  const stageList = [];
  let current = null;
  for (const c of baseEpisode.commands || []) {
    if (c.cmd === "Stage" && c.TargetAssetName) {
      if (!stageList.some((s) => s.key === c.TargetAssetName))
        stageList.push({ key: c.TargetAssetName, id: c.TargetAssetName.split("/").pop(), caption: "" });
      current = c.TargetAssetName;
    } else if (c.cmd === "Location" && current) {
      const stage = stageList.find((s) => s.key === current);
      const id = c.AdvTextID || (c.TargetTextIDs || [])[0];
      const text = (c.lines && c.lines[field]) || (baseEpisode.text && baseEpisode.text[id] && baseEpisode.text[id][field]) || "";
      if (stage && !stage.caption && text) stage.caption = text.replace(/<[^>]*>/g, "").trim();
    }
  }
  const music = [];
  for (const [id, row] of Object.entries(baseEpisode.sounds || {})) {
    const sheet = baseEpisode.cuesheets && baseEpisode.cuesheets[row._soundCueSheetID];
    if (!sheet || !/^sound_bgm/i.test(sheet._cueSheetName) || !row._cueName) continue;
    if (music.some((m) => m.cue === row._cueName)) continue;
    music.push({ cue: row._cueName, label: cueLabel(row._cueName), sound: Number(id), sheet: sheet._cueSheetName });
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
  // The sheets whose audio the site actually has (the manifest lists audio/<sheet>/…), so soundChoices only offers
  // cues the renderer can play. A sheet may hold several cue names.
  const sheetNames = new Set(Object.values(baseEpisode.cuesheets || {}).map((sheet) => sheet && sheet._cueSheetName)
    .filter(Boolean));
  const audioSheets = new Set(Object.keys(baseManifest.files || {})
    .map((file) => /^audio\/([^/]+)\//.exec(file)?.[1])
    .filter((name) => name && sheetNames.has(name)));
  const storyParts = {
    scene: "scene.json",
    ui: { [lang]: "ui/ui.json" },
    fonts: { [lang]: "ui/fonts.json" },
    assets: {},
    sounds: Object.fromEntries([
      ...music.map((m) => [m.sheet, "cuesheets/placeholder.json"]),
      ...[...audioSheets].map((name) => [name, `audio/${name}`]),
    ]),
  };
  const baseStory = { parts: storyParts };
  const base = {
    language: lang, languages: unique([lang, ...(baseManifest.story?.languages || []), ...Object.keys(baseManifest.languages || {})]),
    stages: stageList, music, sounds: soundChoices(baseEpisode, baseStory),
    episode: baseEpisode,
    story: baseStory,
  };
  return { baseManifest, baseEpisode, base, lang, field, models: modelIds, actions, modelKeys };
};

// The rows and texts of `script` as a new story of `site`; `advId` names it, `outRel` is its manifest path.
export const buildSiteStory = ({ site, baseRel, script, advId, language = "", title = "", outRel = "",
                                  voices = null }) => {
  const parsed = parseScript(script);
  if (parsed.errors.length) return { errors: parsed.errors, warnings: [] };
  const requested = language || parsed.script.language || "";
  const catalog = readSiteCatalog(site, baseRel, requested);
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
  const ttsFiles = addSiteVoices({ site, episode, voices }).files;
  const episodeEntry = writeAsset(site, Buffer.from(JSON.stringify(episode)));
  manifest.files = { ...baseManifest.files, ...ttsFiles, ...(storyEntry ? { "story.json": storyEntry } : {}),
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
  fs.writeFileSync(path.join(site, out), JSON.stringify(manifest, null, 2));
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
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
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
