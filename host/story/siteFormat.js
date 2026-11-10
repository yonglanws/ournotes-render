// Site-format story sites (ournotes.story-manifest/2, the bdon.moe layout) as a script-writing catalog. The HTTP host
// uses this when `paths.site` (an nnnotes product site) is not configured but `paths.siteFormat` is: script generation
// works from a downloaded site, while full rendering still needs the product pipeline or render-story/site-story.
import fs from "node:fs";
import path from "node:path";
import { readSiteCatalog } from "../tools/site-story.mjs";

// The site's model ids carry a character key (`adv_live2d_nagi_018_...`). The names come from the character sheets
// loaded by `story.personaDirs`; the MyGO/Ave Mujica names below keep the base tutorial usable without any sheet.
export const CHARACTER_NAMES = {
  tomori: "高松灯", anon: "千早爱音", soyo: "长崎素世", taki: "椎名立希", rana: "要乐奈",
  sakiko: "丰川祥子", mutsumi: "若叶睦", uika: "三角初华", umiri: "八幡海铃", nyamu: "祐天寺若麦",
  sub_mortis: "墨提斯",
  arale: "仲町阿拉蕾", yuno: "千石由乃", nonoka: "宫永野乃花", ritsu: "峰月律", miyako: "藤都子",
  sub_viola: "薇欧拉",
  natsume: "伊泽枣", nagi: "琴平凪", hotaru: "汐见萤", houka: "和泉朋花", mahoro: "滨崎茉幌",
  sub_kanata: "泽海奏多",
  shizuku: "四宫宁月", chieri: "梅里千樱梨", yomogi: "矢仓蓬咲", raika: "须贺蕾叶", miku: "马桥心玖",
};

export const modelKey = (id) => {
  const sub = /^adv_live2d_(sub_[a-z0-9]+?)_/i.exec(String(id));
  if (sub) return sub[1].toLowerCase();
  const m = /^adv_live2d_([a-z0-9]+?)_\d+_/i.exec(String(id));
  return m ? m[1].toLowerCase() : "";
};

export const characterName = (id, personas = []) => {
  const key = modelKey(id);
  if (CHARACTER_NAMES[key]) return CHARACTER_NAMES[key];
  const hit = (personas || []).find((p) =>
    (Array.isArray(p.aliases) ? p.aliases : []).some((a) => String(a).toLowerCase() === key));
  return hit ? hit.name : id;
};

// The prompt catalog of a site-format story: its stages, music, SE cue choices and every model whose character has a
// name (a sheet or the map above), one costume per character, base-story outfits first. A model without a sheet (an
// NPC, or a band the operator did not provide) is left out so the AI cannot cast a character it knows nothing about.
export const catalogFromSite = (site, baseRel, language = "", { personas = [] } = {}) => {
  const c = readSiteCatalog(site, baseRel, language);
  const baseIds = new Set(Object.keys(c.baseManifest.models || {}));
  const all = [];
  for (const id of c.models) {
    const name = characterName(id, personas);
    if (!name || name === id) continue;
    const a = c.actions.get(id);
    if (!a) continue;
    const sheet = (personas || []).find((p) => p.name === name);
    all.push({ id, name, character: name, group: sheet?.group || "", motions: a.motions,
               expressions: a.expressions, defaultMotion: a.defaultMotion, defaultExpression: a.defaultExpression,
               actionsKnown: true });
  }
  all.sort((a, b) => Number(baseIds.has(b.id)) - Number(baseIds.has(a.id)));
  const models = [];
  for (const m of all) {
    if (models.some((x) => x.character === m.character)) continue;
    models.push(m);
  }
  return { manifest: baseRel, language: c.lang, languages: c.base.languages, title: "",
           stages: c.base.stages, music: c.base.music,
           sounds: (c.base.sounds || []).map((s) => ({ cue: s.cue, label: s.label })), models, font: "sans" };
};

const pickTitle = (titles, language) => {
  if (!titles || typeof titles !== "object") return "";
  return String(titles[language] || titles.ja || titles["zh-Hans"] || titles.en || Object.values(titles)[0] || "");
};

const safeManifest = (dir, rel) => {
  if (typeof rel !== "string" || !rel.endsWith(".json") || path.isAbsolute(rel) || rel.includes("\\")) return "";
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return path.join(dir, ...parts);
};

// A StoryCatalog-shaped reader for site-format sites: `bases()` and `catalog()` are enough for the AI script writer.
// `actionsFor()` is deliberately absent because the product render pipeline is the only caller and it is rejected.
export class SiteFormatCatalog {
  constructor({ dir, language = "", personas = [], base = "", logger = console } = {}) {
    if (!dir) throw new Error("paths.siteFormat is not configured");
    this.dir = path.resolve(dir);
    if (!fs.existsSync(this.dir) || !fs.statSync(this.dir).isDirectory())
      throw new Error(`paths.siteFormat is not a directory: ${this.dir}`);
    this.language = language || "";
    this.personas = personas || [];
    this.base = base || "";
    this.logger = logger;
    this.kind = "site-format";
    this._bases = null;
  }

  bases() {
    if (this._bases) return this._bases;
    let index = null;
    try {
      index = JSON.parse(fs.readFileSync(path.join(this.dir, "stories.json"), "utf8"));
    } catch (e) {
      this.logger.warn?.(`paths.siteFormat stories.json: ${e.message}`);
    }
    let entries = Array.isArray(index?.stories) ? index.stories : [];
    if (!entries.length) {
      const dir = path.join(this.dir, "stories");
      if (fs.existsSync(dir)) {
        entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
          .map((name) => ({ manifest: `stories/${name}`, id: name.slice(0, -5) }));
      }
    }
    this._bases = entries
      .filter((entry) => safeManifest(this.dir, entry.manifest) &&
        fs.existsSync(safeManifest(this.dir, entry.manifest)))
      .map((entry) => ({
        manifest: entry.manifest,
        id: entry.id ?? entry.advId ?? null,
        title: pickTitle(entry.titles, this.language) || entry.manifest,
        languages: Array.isArray(entry.languages) ? entry.languages : [],
      }))
      .sort((a, b) => String(a.manifest).localeCompare(String(b.manifest), "en", { numeric: true }));
    return this._bases;
  }

  pickBase(requested = "") {
    const bases = this.bases();
    if (!bases.length) throw new Error("the site-format site has no story manifest");
    if (requested) {
      const found = bases.find((b) => b.manifest === requested || b.id === requested ||
        b.manifest === `stories/${requested}.json`);
      if (found) return found.manifest;
      const rel = requested.endsWith(".json") ? requested : `stories/${requested}.json`;
      if (safeManifest(this.dir, rel) && fs.existsSync(safeManifest(this.dir, rel))) return rel;
      throw new Error(`base ${requested} is not a story of the site-format site`);
    }
    if (this.base) {
      const configured = this.base.endsWith(".json") ? this.base : `stories/${this.base}.json`;
      if (safeManifest(this.dir, configured) && fs.existsSync(safeManifest(this.dir, configured))) return configured;
    }
    return bases[0].manifest;
  }

  async catalog({ manifest = "" } = {}) {
    const baseRel = this.pickBase(manifest);
    return catalogFromSite(this.dir, baseRel, this.language, { personas: this.personas });
  }
}
