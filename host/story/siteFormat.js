// Site-format story sites (ournotes.story-manifest/2, the bdon.moe layout) as a script-writing catalog. The HTTP host
// uses this when `paths.site` (an nnnotes product site) is not configured but `paths.siteFormat` is: the AI
// writer, TTS, site-story compile and the site engine render all work from a downloaded site.
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

// A persona directory can hold more than one band (鸡狗 = MyGO + Ave Mujica), so the band map below is what the cast
// prompt shows next to a character; the writer uses it to keep a band in one outfit.
export const CHARACTER_BANDS = {
  tomori: "MyGO!!!!!", anon: "MyGO!!!!!", soyo: "MyGO!!!!!", taki: "MyGO!!!!!", rana: "MyGO!!!!!",
  sakiko: "Ave Mujica", mutsumi: "Ave Mujica", uika: "Ave Mujica", umiri: "Ave Mujica", nyamu: "Ave Mujica",
  sub_mortis: "Ave Mujica",
  arale: "梦限大", yuno: "梦限大", nonoka: "梦限大", ritsu: "梦限大", miyako: "梦限大", sub_viola: "梦限大",
  shizuku: "家团", chieri: "家团", yomogi: "家团", raika: "家团", miku: "家团",
  natsume: "茉团", nagi: "茉团", hotaru: "茉团", houka: "茉团", mahoro: "茉团", sub_kanata: "茉团",
};

export const modelKey = (id) => {
  const sub = /^adv_live2d_(sub_[a-z0-9]+?)_/i.exec(String(id));
  if (sub) return sub[1].toLowerCase();
  const m = /^adv_live2d_([a-z0-9]+?)_\d+_/i.exec(String(id));
  return m ? m[1].toLowerCase() : "";
};

// The costume suffix of a model id: `adv_live2d_anon_002_live_01` -> `live_01`;
// `adv_live2d_sub_mortis_school_summer_hs` -> `school_summer_hs`.
export const costumeOf = (id) => {
  const m = /^adv_live2d_(?:sub_[a-z0-9]+|[a-z0-9]+_\d+)_(.+)$/i.exec(String(id));
  return m ? m[1].toLowerCase() : "";
};

// Human labels for the cast prompt. The model id already carries the costume, but the writer chooses from a list of
// ids; a short label is what lets it keep a band in one outfit without decoding every suffix.
const COSTUME_LABELS = {
  live_01: "队服",
  school_winter_hs_1st: "校服·高一",
  school_winter_hs_2nd: "校服·高二",
  school_winter_hs: "校服",
  school_winter_jhs: "校服·初中",
  school_summer_hs: "校服·夏季",
  casual_spring_01: "便服",
  virtual_01: "虚拟舞台服",
  arbeit_ring_01: "打工服",
};
export const costumeLabel = (costume) => COSTUME_LABELS[costume] || costume || "默认服装";

export const characterName = (id, personas = []) => {
  const key = modelKey(id);
  if (CHARACTER_NAMES[key]) return CHARACTER_NAMES[key];
  const hit = (personas || []).find((p) =>
    (Array.isArray(p.aliases) ? p.aliases : []).some((a) => String(a).toLowerCase() === key));
  return hit ? hit.name : id;
};

// The prompt catalog of a site-format story: its stages, music, SE cue choices and every model whose character has a
// name (a sheet or the map above). Every costume is kept: the cast prompt lists a character's outfits together and
// asks the writer to keep a band in one outfit. A model without a sheet (an NPC, or a band the operator did not
// provide) is left out so the AI cannot cast a character it knows nothing about.
export const catalogFromSite = (site, baseRel, language = "", { personas = [] } = {}) => {
  const c = readSiteCatalog(site, baseRel, language);
  const baseIds = new Set(Object.keys(c.baseManifest.models || {}));
  const models = [];
  for (const id of c.models) {
    const name = characterName(id, personas);
    if (!name || name === id) continue;
    const a = c.actions.get(id);
    if (!a) continue;
    const key = modelKey(id);
    const sheet = (personas || []).find((p) => p.name === name);
    const costume = costumeOf(id);
    models.push({ id, key, name, character: name, group: sheet?.group || "",
                  band: CHARACTER_BANDS[key] || sheet?.group || "", costume, costumeLabel: costumeLabel(costume),
                  motions: a.motions, expressions: a.expressions, defaultMotion: a.defaultMotion,
                  defaultExpression: a.defaultExpression, actionsKnown: true });
  }
  models.sort((a, b) => Number(baseIds.has(b.id)) - Number(baseIds.has(a.id)));
  return { manifest: baseRel, language: c.lang, languages: c.base.languages, title: "",
           stages: c.base.stages, music: c.base.music,
           sounds: (c.base.sounds || []).map((s) => ({ cue: s.cue, label: s.label, name: s.name, use: s.use })),
           models, font: "sans" };
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

// A story manifest may be in the index while some of its content-addressed files are missing (an interrupted
// fetch-story, a partial copy). A font, episode or story-index asset that is absent would fail later inside
// readSiteCatalog/buildSiteStory, so don't offer that story as a base.
const manifestComplete = (dir, rel, language = "") => {
  const file = safeManifest(dir, rel);
  if (!file || !fs.existsSync(file)) return false;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  let complete = true;
  const walk = (value) => {
    if (!complete) return;
    if (typeof value === "string") {
      if (value.startsWith("assets/") && !fs.existsSync(path.join(dir, ...value.split("/")))) complete = false;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(doc.files || {});
  walk(doc.story || {});
  if (language) {
    walk(doc.languages?.[language]?.files || {});
  } else {
    for (const entry of Object.values(doc.languages || {})) walk(entry?.files || {});
  }
  return complete;
};

// A StoryCatalog-shaped reader for site-format sites. `bases()` and `catalog()` feed the AI writer, TTS and the
// site-story compile; the renderer receives the site directory separately.
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
      .filter((entry) => (!this.language || !Array.isArray(entry.languages) ||
        entry.languages.includes(this.language)) && manifestComplete(this.dir, entry.manifest, this.language))
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
    if (!bases.length) throw new Error("the site-format site has no complete story manifest");
    if (requested) {
      const found = bases.find((b) => b.manifest === requested || b.id === requested ||
        b.manifest === `stories/${requested}.json`);
      if (found) return found.manifest;
      const rel = requested.endsWith(".json") ? requested : `stories/${requested}.json`;
      if (safeManifest(this.dir, rel) && fs.existsSync(safeManifest(this.dir, rel))) {
        if (manifestComplete(this.dir, rel, this.language)) return rel;
        throw new Error(`base ${requested} is incomplete (one of its assets is missing)`);
      }
      throw new Error(`base ${requested} is not a story of the site-format site`);
    }
    if (this.base) {
      const configured = this.base.endsWith(".json") ? this.base : `stories/${this.base}.json`;
      if (manifestComplete(this.dir, configured, this.language)) return configured;
      this.logger.warn?.(`paths.siteFormat base ${this.base} is incomplete; using ${bases[0].manifest}`);
    }
    return bases[0].manifest;
  }

  async catalog({ manifest = "" } = {}) {
    const baseRel = this.pickBase(manifest);
    return catalogFromSite(this.dir, baseRel, this.language, { personas: this.personas });
  }
}
