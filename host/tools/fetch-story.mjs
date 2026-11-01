// Downloads one story episode of a published nnnotes story site (the layout bdon.moe serves at
// https://storage.bdon.moe/moenotes) into a local site directory the render host can read: the manifest, every common
// and language file it lists, the Live2D model manifests and their files. Assets stay content-addressed; a rerun only
// fetches what is missing. The optional Live2D runtimes are saved under vendor/ for the page to load.
//
//   node host/tools/fetch-story.mjs --adv 10610 --lang ja --out resources/site
//
// The downloader is also the setup step for the example render: no game files are committed to this repository.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePublicUrl } from "../net/urlGuard.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_BASE = "https://storage.bdon.moe/moenotes";
const CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";
const MOTIONSYNC_URL = "https://storage.bdon.moe/moenotes/vendor/cubism-motionsync-core-5.0.4/live2dcubismmotionsynccore.min.js";
const ASSET = /^assets\/[0-9a-f]{64}\.[a-z0-9]+(?:\.(?:gz|br))?$/;
const LANGUAGES = new Set(["ja", "en", "zh-Hant", "zh-Hans", "ko"]);

const usage = () => `usage: node host/tools/fetch-story.mjs --adv <id> [options]
       node host/tools/fetch-story.mjs --characters <keys> [options]

  --adv <id>          story advId to download (required unless --characters is given)
  --characters <keys> download one preferred costume per character key (comma-separated; sub_viola allowed)
  --lang <code>       story language: ja, en, zh-Hant, zh-Hans, ko (default ja)
  --out <dir>         destination site directory (default resources/site)
  --base <url>        story site root (default ${DEFAULT_BASE})
  --concurrency <n>   parallel downloads (default 8)
  --force             download every asset again
  --no-runtime        do not download the Live2D Cubism Core / MotionSync Core scripts
  --core <url|path>   Cubism Core source (default the Live2D SDK distribution URL)
  --motionsync <url|path>  MotionSync Core source (default bdon.moe's 5.0.4 copy)
  --help              show this text`;

export const parseArgs = (argv) => {
  const out = { adv: 0, lang: "ja", out: "resources/site", base: DEFAULT_BASE, concurrency: 8,
                force: false, runtime: true, core: CORE_URL, motionsync: MOTIONSYNC_URL, characters: [] };
  let advSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--help" || arg === "-h") { out.help = true; continue; }
    if (arg === "--adv") { out.adv = Number(next()); advSet = true; }
    else if (arg === "--characters") out.characters = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--lang") out.lang = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--base") out.base = next();
    else if (arg === "--concurrency") out.concurrency = Number(next());
    else if (arg === "--force") out.force = true;
    else if (arg === "--no-runtime") out.runtime = false;
    else if (arg === "--core") out.core = next();
    else if (arg === "--motionsync") out.motionsync = next();
    else throw new Error(`unknown option: ${arg}`);
  }
  if (out.help) return out;
  if (!advSet && !out.characters.length) throw new Error("--adv or --characters is required");
  if (advSet && (!Number.isInteger(out.adv) || out.adv < 0)) throw new Error("--adv must be a non-negative integer");
  if (!LANGUAGES.has(out.lang)) throw new Error(`--lang must be one of ${[...LANGUAGES].join(", ")}`);
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > 32)
    throw new Error("--concurrency must be 1..32");
  return out;
};

// ---- outbound requests: http(s) only, every host resolved and checked before a request ---------------------------
const checkedHosts = new Map();
const checkUrl = async (url, what) => {
  const u = url instanceof URL ? url : new URL(String(url));
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${what}: only http and https are allowed`);
  const key = `${u.protocol}//${u.host}`;
  if (!checkedHosts.has(key)) checkedHosts.set(key, resolvePublicUrl(u.href, what).catch((e) => {
    checkedHosts.delete(key);
    throw e;
  }));
  await checkedHosts.get(key);
  return u;
};

// A fetch that validates the URL (and every redirect target) before following it.
const get = async (url, what) => {
  let current = new URL(String(url));
  for (let hop = 0; hop < 6; hop++) {
    await checkUrl(current, what);
    const response = await fetch(current, { redirect: "manual", headers: { "user-agent": "ournotes-render-host/1" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`${what}: redirect without Location`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${current.href}`);
    return response;
  }
  throw new Error(`${what}: too many redirects`);
};

const readJson = async (url, what) => {
  const response = await get(url, what);
  const text = await response.text();
  try { return JSON.parse(text); } catch (e) { throw new Error(`${what}: invalid JSON: ${e.message}`, { cause: e }); }
};

// ---- file entries ------------------------------------------------------------------------------------------------
// {asset,size,stored} or {parts:[[name,asset,size,stored],...]}; every asset path is a content-addressed file.
export const assetsOf = (entry, where) => {
  const out = [];
  const add = (asset, size, stored) => {
    if (typeof asset !== "string" || !ASSET.test(asset))
      throw new Error(`${where}: not a content-addressed asset path: ${asset}`);
    out.push({ asset, size: Number(size) || 0, stored: stored == null ? null : Number(stored) });
  };
  if (!entry || typeof entry !== "object") return out;
  if (Array.isArray(entry.parts)) {
    for (const part of entry.parts) {
      if (!Array.isArray(part) || part.length < 3) throw new Error(`${where}: malformed split file entry`);
      add(part[1], part[2], part[3]);
    }
  } else {
    add(entry.asset, entry.size, entry.stored);
  }
  return out;
};

const writeAtomic = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
};

const downloadAsset = async ({ base, out, asset, size, stored, force, log }) => {
  const dest = path.join(out, ...asset.split("/"));
  const expected = stored ?? size;
  if (!force) {
    try {
      const st = fs.statSync(dest);
      if (st.isFile() && (!expected || st.size === expected)) return { skipped: true, bytes: st.size };
    } catch { /* missing */ }
  }
  const response = await get(`${base}/${asset}`, `asset ${asset}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (stored != null && bytes.length !== stored)
    throw new Error(`${asset}: ${bytes.length} bytes, the manifest says ${stored}`);
  if (stored == null && size && bytes.length !== size)
    throw new Error(`${asset}: ${bytes.length} bytes, the manifest says ${size}`);
  writeAtomic(dest, bytes);
  log?.(`  ${asset} (${(bytes.length / 1048576).toFixed(2)} MB)`);
  return { skipped: false, bytes: bytes.length };
};

const pool = async (items, limit, fn) => {
  let next = 0;
  const results = new Array(items.length);
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const sameFile = (file, bytes) => {
  try { return fs.readFileSync(file).equals(bytes); } catch { return false; }
};

const saveRuntime = async ({ source, dest, force, label }) => {
  if (!source) return null;
  if (!/^https?:\/\//i.test(source)) {
    const file = path.resolve(ROOT, source);
    if (!fs.existsSync(file)) throw new Error(`${label}: not a file: ${file}`);
    const bytes = fs.readFileSync(file);
    if (!force && sameFile(dest, bytes)) return { file: dest, skipped: true };
    writeAtomic(dest, bytes);
    return { file: dest, skipped: false, bytes: bytes.length };
  }
  // A runtime script is not content-addressed: keep the destination when it already exists unless --force.
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) return { file: dest, skipped: true };
  const response = await get(source, label);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024) throw new Error(`${label}: the response is too small to be a script`);
  writeAtomic(dest, bytes);
  return { file: dest, skipped: false, bytes: bytes.length };
};

// ---- model-only mode: fill a site with characters the downloaded stories never cast -------------------------------
const keyOfModel = (id) => {
  const sub = /^adv_live2d_(sub_[a-z0-9]+?)_/.exec(String(id));
  if (sub) return sub[1];
  const main = /^adv_live2d_([a-z0-9]+?)_\d+_/.exec(String(id));
  return main ? main[1] : String(id);
};

const readIndexAt = (out, name) => {
  try { return JSON.parse(fs.readFileSync(path.join(out, name), "utf8")); } catch { return null; }
};

const underAt = (out, rel) => typeof rel === "string" &&
  !rel.split("/").some((p) => p === ".." || p === "." || p === "") && fs.existsSync(path.join(out, ...rel.split("/")));

// A daily scene looks best in the school winter uniform; virtual bands use their virtual outfit; the rest fall back to
// casual/live. Stills, masks, hats and child variants are not castable models.
const COSTUME_ORDER = [
  /school_winter_hs_2nd$/, /school_winter_hs_1st$/, /school_winter_hs$/, /school_winter_jhs$/,
  /school_summer_hs$/, /school_summer_jhs_2nd$/, /school_summer_jhs_3rd$/,
  /virtual_01$/, /casual_spring_01$/, /live_01$/, /arbeit_livehouse_01$/, /roomwear_01$/,
];
const CHARACTER_COSTUME = {
  chieri: /school_winter_hs_1st$/, houka: /school_winter_hs_1st$/, mahoro: /school_winter_hs_2nd$/,
  miku: /school_winter_hs$/, shizuku: /school_winter_jhs$/, raika: /school_winter_hs_2nd$/,
  uika: /school_winter_hs$/, umiri: /school_winter_hs$/, sub_kanata: /school_winter_hs_1st$/,
  sub_viola: /school_winter_hs$/, sub_mortis: /school_summer_hs$/,
};

const preferredCostume = (key, models) => {
  const usable = models.filter((m) => !/(_still|_silhouette|_mask|_hat|_child)/.test(m.id));
  const pool = usable.length ? usable : models;
  const exact = CHARACTER_COSTUME[key] && pool.find((m) => CHARACTER_COSTUME[key].test(m.id));
  if (exact) return exact;
  for (const re of COSTUME_ORDER) {
    const hit = pool.find((m) => re.test(m.id));
    if (hit) return hit;
  }
  return pool[0];
};

const fetchCharacters = async ({ base, out, characters, concurrency, force }) => {
  const index = await readJson(`${base.href}/models.json`, "model index");
  if (index?.format !== 2 || !Array.isArray(index.models))
    throw new Error("models.json: not a model index (format 2)");
  const local = readIndexAt(out, "models.json");
  const existing = new Set((local?.format === 2 && Array.isArray(local.models) ? local.models : []).map((m) => m.id));
  const jobs = new Map();
  const selected = [];
  for (const key of characters) {
    const models = index.models.filter((m) => m.id === key || keyOfModel(m.id) === key);
    if (!models.length) { console.log(`  ${key}: not in the model index`); continue; }
    const model = preferredCostume(key, models);
    if (!model) continue;
    if (existing.has(model.id)) { console.log(`  ${key}: ${model.id} already local`); continue; }
    if (selected.some((m) => m.id === model.id)) continue;
    const manifest = await readJson(`${base.href}/${model.manifest}`, `model ${model.id}`);
    if (![2, 3].includes(manifest?.format) || typeof manifest.files !== "object")
      throw new Error(`${model.manifest}: not a model manifest (format 2 or 3)`);
    writeAtomic(path.join(out, ...model.manifest.split("/")), Buffer.from(JSON.stringify(manifest)));
    const before = jobs.size;
    for (const [name, entry] of Object.entries(manifest.files)) {
      for (const a of assetsOf(entry, `${model.manifest}: ${name}`)) jobs.set(a.asset, a);
    }
    selected.push({ id: model.id, manifest: model.manifest });
    console.log(`  ${key}: ${model.id} (${jobs.size - before} files)`);
  }
  if (!selected.length) { console.log("models: nothing to download"); return { models: [], assets: 0 }; }

  const list = [...jobs.values()];
  let done = 0, bytes = 0;
  await pool(list, concurrency, async (asset) => {
    const r = await downloadAsset({ base: base.href, out, ...asset, force, log: null });
    done++;
    if (!r.skipped) bytes += r.bytes;
    if (done % 25 === 0 || done === list.length)
      console.log(`  ${done}/${list.length} files, ${(bytes / 1048576).toFixed(1)} MB downloaded`);
    return r;
  });

  const old = readIndexAt(out, "models.json");
  const modelList = old?.format === 2 && Array.isArray(old.models)
    ? old.models.filter((m) => underAt(out, m?.manifest)) : [];
  for (const m of selected) {
    const j = modelList.findIndex((x) => x.id === m.id);
    const entry = { id: m.id, manifest: m.manifest };
    if (j >= 0) modelList[j] = entry; else modelList.push(entry);
  }
  writeAtomic(path.join(out, "models.json"), Buffer.from(JSON.stringify({ format: 2, models: modelList })));

  const site = readIndexAt(out, "site.json");
  if (site && Array.isArray(site.models)) {
    for (const m of selected) {
      const j = site.models.findIndex((x) => x.id === m.id);
      if (j >= 0) site.models[j] = { id: m.id, manifest: m.manifest };
      else site.models.push({ id: m.id, manifest: m.manifest });
    }
    site.downloadedAt = new Date().toISOString();
    writeAtomic(path.join(out, "site.json"), Buffer.from(JSON.stringify(site, null, 2)));
  }
  console.log(`models ready: ${selected.length} added, ${list.length} files listed`);
  return { models: selected, assets: list.length };
};

const main = async () => {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); console.error(usage()); process.exitCode = 2; return; }
  if (opts.help) { console.log(usage()); return; }

  const base = new URL(String(opts.base).replace(/\/+$/, ""));
  await checkUrl(base, "story site");
  const out = path.resolve(ROOT, opts.out);
  fs.mkdirSync(out, { recursive: true });

  if (opts.characters.length) {
    console.log(`model site: ${base.href}`);
    console.log(`characters: ${opts.characters.join(", ")} -> ${out}`);
    await fetchCharacters({ base, out, characters: opts.characters, concurrency: opts.concurrency, force: opts.force });
    return;
  }

  console.log(`story site: ${base.href}`);
  console.log(`episode ${opts.adv} (${opts.lang}) -> ${out}`);

  const manifestPath = `stories/${opts.adv}.json`;
  const manifest = await readJson(`${base.href}/${manifestPath}`, "story manifest");
  if (manifest?.format !== "ournotes.story-manifest/1" && manifest?.format !== "ournotes.story-manifest/2")
    throw new Error(`${manifestPath}: not an ournotes story manifest (format ${manifest?.format})`);
  if (manifest.advId !== opts.adv) throw new Error(`${manifestPath}: advId ${manifest.advId}, expected ${opts.adv}`);
  const language = manifest.languages?.[opts.lang];
  if (!language) throw new Error(`${manifestPath}: no language ${opts.lang} (${Object.keys(manifest.languages || {}).join(", ")})`);
  const story = manifest.story || {};
  const title = story.titles?.[opts.lang] || story.titles?.ja || String(opts.adv);
  console.log(`title: ${title}`);

  const jobs = new Map();                       // asset -> {asset,size,stored}
  const addJobs = (entry, where) => {
    for (const a of assetsOf(entry, where)) jobs.set(a.asset, a);
  };
  for (const [name, entry] of Object.entries(manifest.files || {})) addJobs(entry, `${manifestPath}: ${name}`);
  for (const [name, entry] of Object.entries(language.files || {}))
    addJobs(entry, `${manifestPath}: ${opts.lang}/${name}`);

  // Live2D models: model manifests are site files too; their files join the same content-addressed table.
  const models = [];
  for (const [id, modelPath] of Object.entries(manifest.models || {})) {
    if (typeof modelPath !== "string" || !/^models\/[A-Za-z0-9_.-]+\.json$/.test(modelPath))
      throw new Error(`${manifestPath}: bad model manifest path for ${id}: ${modelPath}`);
    const model = await readJson(`${base.href}/${modelPath}`, `model ${id}`);
    if (![2, 3].includes(model?.format) || typeof model.files !== "object")
      throw new Error(`${modelPath}: not a model manifest (format 2 or 3)`);
    if (model.id !== undefined && model.id !== id) throw new Error(`${modelPath}: model ${model.id}, expected ${id}`);
    writeAtomic(path.join(out, ...modelPath.split("/")), Buffer.from(JSON.stringify(model)));
    const before = jobs.size;
    for (const [name, entry] of Object.entries(model.files)) addJobs(entry, `${modelPath}: ${name}`);
    models.push({ id, manifest: modelPath, files: Object.keys(model.files).length,
                  assets: jobs.size - before });
  }
  console.log(`models: ${models.length}, files: ${jobs.size}`);

  // The manifest and index are small and always rewritten. The indexes keep the stories already downloaded: a site
  // that fetched eight episodes for comparison must not lose seven of them when the next one arrives.
  writeAtomic(path.join(out, ...manifestPath.split("/")), Buffer.from(JSON.stringify(manifest)));
  const under = (rel) => typeof rel === "string" && !rel.split("/").some((p) => p === ".." || p === "." || p === "") &&
    fs.existsSync(path.join(out, ...rel.split("/")));
  const readIndex = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(out, name), "utf8")); } catch { return null; }
  };
  const oldStories = readIndex("stories.json");
  const stories = oldStories?.format === "ournotes.stories/1" && Array.isArray(oldStories.stories)
    ? oldStories.stories.filter((s) => under(s?.manifest)) : [];
  const entry = {
    id: String(opts.adv), advId: opts.adv, manifest: manifestPath, playbackMode: story.playbackMode ?? 0,
    language: story.language || opts.lang, languages: story.languages || [opts.lang],
    titles: story.titles || { [opts.lang]: title }, audio: manifest.audio !== false,
    ...(manifest.audioFormat ? { audioFormat: manifest.audioFormat } : {}),
  };
  const at = stories.findIndex((s) => String(s.id) === String(opts.adv) || s.manifest === manifestPath);
  if (at >= 0) stories[at] = entry; else stories.push(entry);
  const index = {
    format: "ournotes.stories/1",
    language: story.language || opts.lang,
    languages: story.languages || [opts.lang],
    stories,
  };
  writeAtomic(path.join(out, "stories.json"), Buffer.from(JSON.stringify(index)));
  const oldModels = readIndex("models.json");
  const modelList = oldModels?.format === 2 && Array.isArray(oldModels.models)
    ? oldModels.models.filter((m) => under(m?.manifest)) : [];
  for (const m of models) {
    const model = { id: m.id, manifest: m.manifest };
    const j = modelList.findIndex((x) => x.id === m.id);
    if (j >= 0) modelList[j] = model; else modelList.push(model);
  }
  writeAtomic(path.join(out, "models.json"), Buffer.from(JSON.stringify({ format: 2, models: modelList })));

  const list = [...jobs.values()];
  const total = list.reduce((n, a) => n + (a.stored ?? a.size ?? 0), 0);
  console.log(`assets: ${list.length} files, ${(total / 1048576).toFixed(1)} MB listed`);
  let done = 0, downloaded = 0, bytes = 0;
  const results = await pool(list, opts.concurrency, async (asset) => {
    const r = await downloadAsset({ base: base.href, out, ...asset, force: opts.force, log: null });
    done++;
    if (!r.skipped) { downloaded++; bytes += r.bytes; }
    if (done % 25 === 0 || done === list.length)
      console.log(`  ${done}/${list.length} files, ${(bytes / 1048576).toFixed(1)} MB downloaded`);
    return r;
  });
  const skipped = results.filter((r) => r.skipped).length;

  let core = null, motionsync = null;
  if (opts.runtime) {
    const vendor = path.join(out, "vendor");
    core = await saveRuntime({ source: opts.core, dest: path.join(vendor, "live2dcubismcore.min.js"),
                               force: opts.force, label: "Live2D Cubism Core" });
    motionsync = await saveRuntime({ source: opts.motionsync, dest: path.join(vendor, "live2dcubismmotionsynccore.min.js"),
                                     force: opts.force, label: "Live2D MotionSync Core" });
    console.log(`runtime: ${core.skipped ? "kept" : "saved"} ${core.file}`);
    console.log(`runtime: ${motionsync.skipped ? "kept" : "saved"} ${motionsync.file}`);
  }

  const meta = {
    format: "ournotes.render-site/1",
    source: base.href,
    advId: opts.adv,
    language: opts.lang,
    title,
    playbackMode: story.playbackMode ?? 0,
    models: models.map(({ id, manifest: m }) => ({ id, manifest: m })),
    files: list.length,
    bytes: list.reduce((n, a) => n + (a.size || 0), 0),
    downloadedAt: new Date().toISOString(),
    note: "Game art, audio and story text belong to Bushiroad / Craft Egg / Ishimori; downloaded for local, " +
          "non-commercial use. This directory is generated and is not part of the repository.",
  };
  writeAtomic(path.join(out, "site.json"), Buffer.from(JSON.stringify(meta, null, 2)));

  console.log("");
  console.log(`site ready: ${out}`);
  console.log(`  story ${opts.adv}: ${title}`);
  console.log(`  ${list.length} assets (${downloaded} downloaded, ${skipped} kept)`);
  if (core) console.log(`  core: ${core.file}`);
  if (motionsync) console.log(`  motionsync: ${motionsync.file}`);
  console.log("");
  const corePath = core ? core.file : path.join(out, "vendor", "live2dcubismcore.min.js");
  console.log("render an example video:");
  console.log(`  node host/tools/render-story.mjs --site "${out}" --story "${manifestPath}" --lang ${opts.lang} ` +
              `--core "${corePath}"` + (motionsync ? ` --motionsync "${motionsync.file}"` : ""));
};

// Importable for tests: only the CLI entry runs the downloader.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`fetch-story: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  });
}
