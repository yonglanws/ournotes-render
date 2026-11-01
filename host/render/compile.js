// Turns TTS audio into a story sound product, injects VoiceIDs/air lip sync into the compiled Talk rows, and composes
// the derived story over the base site. The result is a manifest plus the files the render server serves over the
// base site (never writes into the user's site).
import crypto from "node:crypto";
import fs from "node:fs";

const TTS_SHEET = "ournotes_tts";
const TTS_SHEET_ID = 900001;
const BASE_SOUND_ID = 900000;

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const wavBytes = (audio) => {
  // The TTS client already normalized to PCM16 mono; read the file as-is.
  return fs.readFileSync(audio.file);
};

// -> { files: Map(path -> Buffer), productPath, soundIds: Map(beat -> id), cueNames: Map(beat -> cue) }
export const buildTtsProduct = (voices) => {
  const files = new Map(), cues = {}, entries = {}, soundIds = new Map(), cueNames = new Map();
  for (const [beat, audio] of voices) {
    const cue = audio.cueName || `tts_line_${beat}`;
    const logical = `${cue}.wav`;
    const bytes = wavBytes(audio);
    const asset = `assets/${sha256(bytes)}.wav`;
    files.set(asset, bytes);
    entries[logical] = { asset, size: bytes.length };
    cues[logical] = { file: logical, sampleRate: audio.sampleRate, samples: audio.samples, channels: audio.channels,
                      categories: ["Voice"] };
    soundIds.set(beat, BASE_SOUND_ID + beat);
    cueNames.set(beat, cue);
  }
  const cuesBytes = Buffer.from(JSON.stringify(cues));
  const cuesAsset = `assets/${sha256(cuesBytes)}.json`;
  files.set(cuesAsset, cuesBytes);
  entries["cues.json"] = { asset: cuesAsset, size: cuesBytes.length };
  const manifest = {
    schema: "nnnotes.product/1", product: "story.sound", subject: TTS_SHEET,
    files: entries, objects: {},
  };
  const productPath = `cuesheets/${TTS_SHEET}.json`;
  files.set(productPath, Buffer.from(JSON.stringify(manifest)));
  return { files, productPath, soundIds, cueNames };
};

// injects the voices into compiled.episode / compiled.story; returns the TTS product description
export const injectVoices = ({ compiled, voices, product = null }) => {
  if (!voices || !voices.size) return null;
  const built = product || buildTtsProduct(voices);
  const p = built;
  compiled.story.parts.sounds = { ...(compiled.story.parts.sounds || {}), [TTS_SHEET]: p.productPath };
  compiled.episode.sounds = { ...(compiled.episode.sounds || {}) };
  compiled.episode.cuesheets = { ...(compiled.episode.cuesheets || {}) };
  compiled.episode.cuesheets[TTS_SHEET_ID] = { _cueSheetName: TTS_SHEET };
  for (const [beat, soundId] of p.soundIds) {
    compiled.episode.sounds[soundId] = {
      _id: soundId, _soundCueSheetID: TTS_SHEET_ID, _cueName: p.cueNames.get(beat), _category: 2,
      _isRandomPitch: 0, _isLoop: 0,
    };
    // the Talk row of this beat is the one whose text id is custom_line_<beat>
    const row = compiled.episode.commands.find((c) => c.cmd === "Talk" && c.AdvTextID === `custom_line_${beat}`);
    if (!row) continue;
    row.VoiceIDs = [soundId];
    if (row.TargetName) {
      // host extension: play the TTS voice and keep the game's timed air lip sync on the typed line
      row.Parameter1 = "airlipsync_voice";
      row.Parameter2 = "1";
    }
  }
  return p;
};

// Compose `script` over the catalog's base with TTS voices. -> {manifest, assets, compiled, product, language, warnings}
export const composeWithVoices = async ({ catalog, script, voices, language, font, root = "../" }) => {
  if (!voices || !voices.size) {
    return catalog.compose(script, { language, family: font, extraFiles: new Map(), root });
  }
  // Build the product before composing so the story.json can name it; the bytes are added afterwards.
  const product = buildTtsProduct(voices);
  const result = await catalog.compose(script, {
    language, family: font, extraFiles: new Map(), extraEpisode: (compiled) => {
      injectVoices({ compiled, voices, product });
    }, root,
  });
  if (result.errors) return result;
  for (const [p, b] of product.files) result.assets.set(p, b);
  return { ...result, product };
};
