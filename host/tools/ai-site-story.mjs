// AI story writing for a site-format story site (ournotes.story-manifest/2, the bdon.moe layout). It builds the
// catalog the AI writer needs from the site's own stages, BGM and models, generates a director script, synthesizes
// per-line TTS (with optional emotion-mapped references), and compiles it back onto the site with site-story.mjs.
// Use it when you have downloaded a site with fetch-story but do not have an nnnotes product site for the HTTP queue.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LLMClient } from "../ai/llm.js";
import { generateScript, prepareScript } from "../ai/storyWriter.js";
import { loadConfig } from "../config.js";
import { configureFfmpeg } from "../render/ffmpeg.js";
import { GptSovitsClient, synthesizeStory, VoiceBook } from "../tts/tts.js";
import { buildSiteStory, readSiteCatalog } from "./site-story.mjs";

// The site's model ids carry a character key (`adv_live2d_nagi_018_...`). The names come from the character sheets
// loaded by `story.personaDirs`; the MyGO/Ave Mujica names below keep the base tutorial usable without any sheet.
const CHARACTER_NAMES = {
  tomori: "高松灯", anon: "千早爱音", soyo: "长崎素世", taki: "椎名立希", rana: "要乐奈",
  sakiko: "丰川祥子", mutsumi: "若叶睦", uika: "三角初华", umiri: "八幡海铃", nyamu: "祐天寺若麦",
  sub_mortis: "墨提斯",
  arale: "仲町阿拉蕾", yuno: "千石由乃", nonoka: "宫永野乃花", ritsu: "峰月律", miyako: "藤都子",
  sub_viola: "薇欧拉",
  natsume: "伊泽枣", nagi: "琴平凪", hotaru: "汐见萤", houka: "和泉朋花", mahoro: "滨崎茉幌",
  sub_kanata: "泽海奏多",
  shizuku: "四宫宁月", chieri: "梅里千樱梨", yomogi: "矢仓蓬咲", raika: "须贺蕾叶", miku: "马桥心玖",
};

const modelKey = (id) => {
  const sub = /^adv_live2d_(sub_[a-z0-9]+?)_/i.exec(String(id));
  if (sub) return sub[1].toLowerCase();
  const m = /^adv_live2d_([a-z0-9]+?)_\d+_/i.exec(String(id));
  return m ? m[1].toLowerCase() : "";
};

const characterName = (id, personas = []) => {
  const key = modelKey(id);
  if (CHARACTER_NAMES[key]) return CHARACTER_NAMES[key];
  const hit = (personas || []).find((p) =>
    (Array.isArray(p.aliases) ? p.aliases : []).some((a) => String(a).toLowerCase() === key));
  return hit ? hit.name : id;
};

// The prompt catalog of a site-format story: every model whose character has a name (a sheet or the map above), one
// costume per character, base-story outfits first. A model without a sheet (an NPC, or a band the operator did not
// provide) is left out so the AI cannot cast a character it knows nothing about.
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
           stages: c.base.stages, music: c.base.music, models, font: "sans" };
};

export const parseArgs = (argv) => {
  const o = { site: "", base: "", prompt: "", script: "", adv: "", lang: "", title: "", config: "", out: "",
              minutes: 3, lines: 60, tts: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--site") o.site = argv[++i] || "";
    else if (a === "--base") o.base = argv[++i] || "";
    else if (a === "--prompt") o.prompt = argv[++i] || "";
    else if (a === "--script") o.script = argv[++i] || "";
    else if (a === "--adv") o.adv = argv[++i] || "";
    else if (a === "--lang") o.lang = argv[++i] || "";
    else if (a === "--title") o.title = argv[++i] || "";
    else if (a === "--config") o.config = argv[++i] || "";
    else if (a === "--out") o.out = argv[++i] || "";
    else if (a === "--minutes") o.minutes = Number(argv[++i]) || 3;
    else if (a === "--lines") o.lines = Number(argv[++i]) || 60;
    else if (a === "--no-tts") o.tts = false;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.site) throw new Error("--site is required (a site-format story site directory)");
  if (!o.base) throw new Error("--base is required (the site-relative base story manifest)");
  if (!o.prompt && !o.script) throw new Error("--prompt or --script is required (what the scene should be)");
  if (!o.adv) throw new Error("--adv is required (the new story id)");
  return o;
};

const main = async () => {
  const o = parseArgs(process.argv.slice(2));
  const site = path.resolve(o.site);
  const cfg = loadConfig({ file: o.config ? path.resolve(o.config) : undefined });
  if (!cfg.llm.enabled || !cfg.llm.model) throw new Error("llm.enabled and llm.model are required in the config");
  const client = new LLMClient({ ...cfg.llm, apiKey: cfg.secrets.llmApiKey },
    { logger: console, allowPrivate: cfg.security.allowPrivateServiceEndpoints });
  const catalog = catalogFromSite(site, o.base, o.lang, { personas: cfg.story.personas });
  const request = { prompt: o.prompt, language: o.lang || catalog.language, title: o.title,
                    targetMinutes: Math.max(0.5, Math.min(10, o.minutes)), maxLines: Math.max(6, Math.min(200, o.lines)) };
  const generated = o.script
    ? { doc: JSON.parse(fs.readFileSync(path.resolve(o.script), "utf8")), script: null, usage: null }
    : await generateScript({ llm: client, catalog, request, config: cfg, logger: console,
        onProgress: (phase, p, message) => console.error(`${phase} ${Math.round((p || 0) * 100)}% ${message}`) });
  // The writer already checks, but applying its known fixes once more against the same catalog catches any fix that
  // depends on the site-format catalog and gives the TTS stage a script that is known to compile.
  const prepared = prepareScript({ doc: generated.doc, catalog, request, config: cfg, logger: console });
  const out = o.out ? path.resolve(o.out) : path.join(cfg.paths.output, `${o.adv}.script.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(prepared.doc || generated.doc, null, 2));
  if (prepared.errors?.length)
    throw Object.assign(new Error(`the generated script still has errors (${out})`), { details: prepared.errors });
  let voices = new Map();
  if (o.tts && cfg.tts.enabled) {
    configureFfmpeg();
    const ttsClient = new GptSovitsClient(cfg.tts, { apiKey: cfg.secrets.ttsApiKey, logger: console,
      allowPrivate: cfg.security.allowPrivateServiceEndpoints });
    ttsClient.setCacheDir(path.join(cfg.paths.cache, "tts"));
    voices = await synthesizeStory({
      script: prepared.script, catalog, config: { ...cfg.tts, translateForTts: cfg.llm.translateForTts },
      client: ttsClient, voiceBook: new VoiceBook(cfg.tts), llm: client, signal: null, logger: console,
      onProgress: (p, message) => console.error(`tts ${Math.round((p || 0) * 100)}% ${message}`),
    });
  }
  const built = buildSiteStory({ site, baseRel: o.base, script: prepared.doc, advId: o.adv, language: request.language,
    title: o.title || prepared.script.title, voices });
  if (built.errors) throw Object.assign(new Error(`the generated script did not compile (${out})`),
                                      { details: built.errors });
  console.log(JSON.stringify({ ok: true, manifest: built.manifestPath, script: out, advId: built.manifest.advId,
    language: built.language, commands: built.episode.commandCount, lines: built.compiled.lines.length,
    voices: voices.size, warnings: built.warnings, usage: generated.usage || null }, null, 2));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); if (e.details) console.error(JSON.stringify(e.details, null, 2)); process.exit(2); });
}
