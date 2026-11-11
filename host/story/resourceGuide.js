// The semantic layer over a site's opaque resource ids.
//
// A site-format story names its background `adv_bkg_stage_000164` and its music `sound_bgm_adv_f6b483`; the only
// human text a story carries is the chapter title next to a Stage row ("初中時代" for a dark bedroom). An AI writer
// cannot choose from that, so this guide supplies a name, a description and tags per id. A site may ship its own
// <site>/story-resources.yaml; otherwise the bundled guide for the official bdon site is used. Unknown ids fall back
// to the story's caption, so a different site still works without a guide.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), "site-resources.yaml");

const string = (value) => (value === undefined || value === null ? "" : String(value));

const normalizeEntry = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const tags = Array.isArray(value.tags) ? value.tags.map(string).filter(Boolean) : [];
  return {
    name: string(value.name),
    description: string(value.description),
    tags,
    kind: string(value.kind),
    mood: string(value.mood),
    use: string(value.use),
  };
};

const readGuide = (file) => {
  const doc = yaml.load(fs.readFileSync(file, "utf8")) || {};
  const table = (value) => new Map(Object.entries(value || {}).map(([id, entry]) => [id, normalizeEntry(entry)]));
  return { format: string(doc.format), stages: table(doc.stages), music: table(doc.music),
           sounds: table(doc.sounds), source: file };
};

const EMPTY = { format: "", stages: new Map(), music: new Map(), sounds: new Map(), source: "" };

export const loadResourceGuide = (site = "") => {
  const local = site ? path.join(site, "story-resources.yaml") : "";
  if (local && fs.existsSync(local)) return readGuide(local);
  if (fs.existsSync(BUNDLED)) return readGuide(BUNDLED);
  return EMPTY;
};

// Merges the guide into a stage/music/SE entry without dropping fields the site already supplied.
export const applyStageGuide = (stage, guide) => {
  const entry = guide.stages.get(stage.id) || {};
  if (entry.kind === "title") return null;
  return { ...stage, name: entry.name || "", description: entry.description || "", tags: entry.tags || [],
           kind: entry.kind || "" };
};

export const applyMusicGuide = (music, guide) => {
  const entry = guide.music.get(music.cue) || {};
  return { ...music, name: entry.name || "", mood: entry.mood || "", use: entry.use || "" };
};

export const applySoundGuide = (sound, guide) => {
  const entry = guide.sounds.get(sound.cue) || {};
  return { ...sound, name: entry.name || "", use: entry.use || "" };
};
