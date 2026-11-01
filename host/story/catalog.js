// The story site: bases, stages, music and the model catalog the AI writes from. Wraps the story-author Site loader
// (scripts/lib/story-author/site.js) and caches the expensive parts.
import fs from "node:fs";
import path from "node:path";
import { Site } from "../../scripts/lib/story-author/site.js";

const byName = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim();

// A site-relative manifest path from a request or an index: no absolute paths, no "."/".." segments, JSON only.
const safeRel = (p) => typeof p === "string" && p.endsWith(".json") && !path.isAbsolute(p) && !p.includes("\\") &&
  p.split("/").every((s) => s && s !== "." && s !== "..");

export class SiteCatalogError extends Error {
  constructor(message) { super(message); this.name = "SiteCatalogError"; this.code = "site"; }
}

export class StoryCatalog {
  constructor({ dir, language = "", maxModels = 24, cast = [], logger = console } = {}) {
    if (!dir) throw new SiteCatalogError("paths.site is not configured");
    this.dir = path.resolve(dir);
    if (!fs.existsSync(this.dir) || !fs.statSync(this.dir).isDirectory())
      throw new SiteCatalogError(`paths.site is not a directory: ${this.dir}`);
    this.site = new Site(this.dir);
    this.language = language || "";
    this.maxModels = maxModels;
    this.castFilter = new Set((cast || []).map(String));
    this.logger = logger;
    this._catalog = null;
    this._bases = null;
  }

  // stories.json entries that can be a base (Normal episodes)
  bases() {
    if (!this._bases) {
      let entries = [];
      try { entries = this.site.stories(); } catch (e) { this.logger.warn?.(`stories.json: ${e.message}`); }
      if (!entries.length) {
        // a site without stories.json: any story product under stories/ is a candidate
        const dir = path.join(this.dir, "stories");
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".json")) continue;
            const rel = `stories/${f}`;
            try {
              const m = this.site.json(rel);
              if (m.schema === "nnnotes.product/1" && m.product === "story") {
                entries.push({ manifest: rel, titles: {}, languages: [m.language].filter(Boolean) });
              }
            } catch { /* not a manifest */ }
          }
        }
      }
      this._bases = entries.filter((e) => safeRel(e.manifest)).map((e) => ({
        manifest: e.manifest, id: e.id ?? e.advId ?? null,
        title: pickTitle(e.titles, this.language) || e.manifest,
        languages: Array.isArray(e.languages) ? e.languages : [],
        groups: e.groups || [],
      })).sort((a, b) => byName(a.manifest, b.manifest));
    }
    return this._bases;
  }

  pickBase(requested = "") {
    if (requested) {
      const bases = this.bases();
      const found = bases.find((b) => b.manifest === requested || b.id === requested || b.manifest === `stories/${requested}.json`);
      if (found) return found;
      // a custom story that is not in stories.json can still be a base
      const rel = requested.endsWith(".json") ? requested : `stories/${requested}.json`;
      if (!safeRel(rel)) throw new SiteCatalogError(`base ${requested} is not a site-relative JSON manifest`);
      try {
        const m = this.site.json(rel);
        if (m.schema === "nnnotes.product/1" && m.product === "story")
          return { manifest: rel, id: m.subject, title: rel, languages: [m.language].filter(Boolean), groups: [] };
      } catch { /* not there */ }
      throw new SiteCatalogError(`base ${requested} is not a Normal story of the site`);
    }
    const bases = this.bases();
    if (!bases.length) throw new SiteCatalogError("the site has no Normal story that can be a base");
    return bases[0];
  }

  // {base, language, languages, stages, music, cast, models}
  async catalog({ manifest = "", refresh = false } = {}) {
    const chosen = this.pickBase(manifest);
    const key = `${chosen.manifest}\n${this.language}`;
    if (!refresh && this._catalog && this._catalog.key === key) return this._catalog;
    const language = this.language || chosen.languages[0] || "";
    let base;
    try {
      base = this.site.base(chosen.manifest, language || null);
    } catch (e) {
      throw new SiteCatalogError(`base ${chosen.manifest}: ${e.message}`);
    }
    const models = await this._models(base, language);
    const catalog = {
      key, manifest: chosen.manifest, language: base.language, languages: base.languages,
      title: pickTitle(chosen.title ? { [language]: chosen.title } : null, language) || chosen.manifest,
      stages: base.stages.map((s) => ({ id: s.id, caption: cleanName(s.caption) })).sort((a, b) => byName(a.id, b.id)),
      music: base.music.map((m) => ({ cue: m.cue, label: cleanName(m.label) })).sort((a, b) => byName(a.cue, b.cue)),
      models,
      font: "sans",
    };
    this._catalog = catalog;
    return catalog;
  }

  async _models(base, language) {
    const entries = this.site.models();
    const baseKeys = new Set(base.cast || []);
    const allowed = this.castFilter;
    const byCharacter = new Map();
    for (const e of entries) {
      const name = cleanName((e.names && e.names[language]) || e.label || e.character || "");
      const character = cleanName(e.character || e.group || "");
      if (allowed.size && !allowed.has(e.id) && !allowed.has(character) && !allowed.has(name)) continue;
      const candidate = { entry: e, name, character, base: baseKeys.has(e.id) };
      const k = character || e.id;
      const prev = byCharacter.get(k);
      // an explicitly allowed model wins, then a model the base story itself uses, then a labelled one
      const score = (m) => (allowed.has(m.entry.id) ? 4 : 0) + (m.base ? 2 : 0) + (m.entry.label ? 1 : 0);
      if (!prev || score(candidate) > score(prev)) byCharacter.set(k, candidate);
    }
    let chosen = [...byCharacter.values()];
    // if the filter left too many, keep the base's cast first, then the named characters
    chosen.sort((a, b) => Number(b.base) - Number(a.base) || Number(!!b.entry.label) - Number(!!a.entry.label) ||
                          byName(a.name || a.entry.id, b.name || b.entry.id));
    chosen = chosen.slice(0, this.maxModels);
    const models = [];
    const selected = new Set();
    for (const c of chosen) {
      const id = c.entry.id;
      if (selected.has(id)) continue;
      let actions;
      try {
        actions = this.site.model(id).actions;
      } catch (e) {
        this.logger.warn?.(`model ${id}: ${e.message}`);
        continue;
      }
      selected.add(id);
      models.push({
        id, name: c.name || id, character: c.character || id, group: c.entry.group || "",
        motions: actions.motions, expressions: actions.expressions,
        defaultMotion: actions.defaultMotion, defaultExpression: actions.defaultExpression,
        actionsKnown: true,
      });
    }
    if (!models.length) throw new SiteCatalogError("no usable Live2D model in the site's models.json");
    // Every other model is still a valid cast choice for a caller-supplied script; its actions are not preloaded
    // (and its motion/expression names are not checked), so the API catalog stays cheap.
    for (const e of entries) {
      if (selected.has(e.id)) continue;
      selected.add(e.id);
      const name = cleanName((e.names && e.names[language]) || e.label || e.character || "");
      models.push({
        id: e.id, name: name || e.id, character: cleanName(e.character || e.group || "") || e.id,
        group: e.group || "", motions: [], expressions: [], defaultMotion: "", defaultExpression: "",
        actionsKnown: false,
      });
    }
    return models;
  }

  // model id -> catalog entry (a generated script may name a model that was not in the prompt)
  modelMap() {
    if (!this._catalog) return new Map();
    return new Map(this._catalog.models.map((m) => [m.id, m]));
  }

  // Actions for cast models a caller supplied that were not among the preloaded prompt models.
  async actionsFor(ids) {
    const out = new Map();
    for (const id of new Set((ids || []).filter((x) => typeof x === "string" && x))) {
      const known = this._catalog?.models.find((m) => m.id === id);
      if (known && known.actionsKnown !== false) continue;       // already loaded
      try { out.set(id, this.site.model(id).actions); } catch { /* unknown model */ }
    }
    return out;
  }

  async compose(script, { language, family, extraFiles = new Map(), extraEpisode = null } = {}) {
    const baseManifest = script.base || this._catalog?.manifest || this.pickBase().manifest;
    const catalog = await this.catalog({ manifest: baseManifest });
    const base = this.site.base(catalog.manifest, language || catalog.language);
    const { parseScript, checkScript, compileScript } = await import("../../scripts/lib/story-author/script.js");
    const parsed = parseScript(script);
    if (parsed.errors.length) return { errors: parsed.errors, warnings: [] };
    // validate the cast's real motions/expressions even when the model was not preloaded for the AI prompt
    const castActions = {};
    for (const c of parsed.script.cast) {
      try { castActions[c.model] = this.site.model(c.model).actions; } catch { /* checkScript reports unknownModel */ }
    }
    const checked = checkScript(parsed.script, { base, models: catalog.models.map((m) => m.id), actions: castActions });
    if (checked.errors.length) return { errors: checked.errors, warnings: checked.warnings };
    const compiled = compileScript(parsed.script, {
      base, models: Object.fromEntries(parsed.script.cast.map((c) => [c.model, this._modelKey(c.model)])),
      actions: castActions,
    }, checked.language);
    if (extraEpisode) extraEpisode(compiled);
    const composed = await this.site.compose(base, compiled, { language: checked.language, family, root: "../" });
    for (const [p, b] of extraFiles) composed.assets.set(p, b);
    return { ...composed, compiled, base, language: checked.language, warnings: checked.warnings };
  }

  _modelKey(id) {
    const e = this.site.models().find((m) => m.id === id);
    return e ? e.key : "";
  }

  // model id -> the character's display name, for TTS voice selection and the API catalog
  voiceNameFor(modelId) {
    const m = this._catalog?.models.find((x) => x.id === modelId);
    return m ? (m.name || m.character || modelId) : modelId;
  }
}

const pickTitle = (titles, language) => {
  if (!titles || typeof titles !== "object") return "";
  const order = [language, "zh-Hans", "zh-Hant", "ja", "en", "ko"].filter(Boolean);
  for (const l of order) if (typeof titles[l] === "string" && titles[l].trim()) return titles[l].trim();
  const first = Object.values(titles).find((v) => typeof v === "string" && v.trim());
  return first ? first.trim() : "";
};
