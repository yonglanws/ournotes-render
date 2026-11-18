#!/usr/bin/env node
// Offline cloud semantic catalog builder:
// Queries assets.bdon.moe (/catalogs, /assets?snapshot=..., Adv/Stage/, Cri/Sound/, Adv/Episode/*) and
// storage.bdon.moe/moenotes (models.json, jp/models.json, stories.json) to extract raw metadata for all
// 343 stages, 91 BGMs, 345 SEs, and 209 TW + 58 JP Live2D models, then builds the Simplified Chinese
// semantic catalog (`host/story/cloud-catalog.json` + `host/story/site-resources.yaml`).
//
// Usage:
//   node host/tools/build-cloud-catalog.mjs --collect   # fetch & cache raw data into cache/cloud-catalog-raw/
//   node host/tools/build-cloud-catalog.mjs --build     # build host/story/cloud-catalog.json & site-resources.yaml from raw cache
//   node host/tools/build-cloud-catalog.mjs             # collect (using cache) + build
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import yaml from "js-yaml";
import {
  BGM_GUIDE,
  CLOUD_CHARACTER_BANDS,
  CLOUD_CHARACTER_NAMES,
  CLOUD_COSTUME_LABELS,
} from "../story/cloud-dictionaries.js";
import { SE_GUIDE } from "../story/cloud-se-dict.js";
import { CORE_STAGE_OVERRIDES, EXTRA_STAGE_OVERRIDES } from "../story/cloud-stage-dict.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ASSETS_BASE = "https://assets.bdon.moe";
const STORAGE_BASE = "https://storage.bdon.moe/moenotes";
const RAW_DIR = path.join(ROOT, "cache", "cloud-catalog-raw");
const SUMMARY_FILE = path.join(RAW_DIR, "summary.json");
const CLOUD_CATALOG_OUT = path.join(ROOT, "host", "story", "cloud-catalog.json");
const SITE_RESOURCES_OUT = path.join(ROOT, "host", "story", "site-resources.yaml");

const pool = async (items, limit, fn) => {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
};

const fetchBuffer = async (url, { retries = 3, timeoutMs = 20000 } = {}) => {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (attempt + 1 < retries) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
};

const fetchCachedBuffer = async (cacheFile, url) => {
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile);
  const buf = await fetchBuffer(url);
  if (!buf) return null;
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, buf);
  return buf;
};

const fetchCachedJson = async (cacheFile, url) => {
  const buf = await fetchCachedBuffer(cacheFile, url);
  if (!buf) return null;
  try { return JSON.parse(buf.toString("utf8")); } catch { return null; }
};

const listPrefix = async (snapshot, prefix) => {
  const out = [];
  let offset = 0;
  while (true) {
    const u = `${ASSETS_BASE}/assets?snapshot=${encodeURIComponent(snapshot)}&prefix=${encodeURIComponent(prefix)}&limit=1000&offset=${offset}`;
    const buf = await fetchBuffer(u);
    const j = JSON.parse(buf.toString("utf8"));
    out.push(...(j.assets || []));
    if (out.length >= j.total || !j.assets?.length) break;
    offset += j.assets.length;
  }
  return out;
};

const isTimeCaption = (text) => {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^(?:第?[一二三四五六七八九十百\d]+[天日周月年]|次日|当天|翌日|几天|数[日天周月年]|数[小钟]时|数分钟|片刻|一会儿|不久|过了一会|此时|与此同时|同一时间|现在|过去|以前|从前|初中时代|中学时代|高中时代|那之后|在那之后|之后|后来|数年前|几年前|几个月前|几天前|几小时后|数小时后|几分钟后|数分钟后|数天后|数日后|一周后|一个月后|一年后|两年后|春天|夏天|秋天|冬天|春|夏|秋|冬|早春|初夏|盛夏|深秋|隆冬|清晨|早上|上午|中午|正午|午后|下午|傍晚|黄昏|夜晚|晚上|深夜|凌晨|半夜|次日清晨|当天傍晚|次日放学后|放学后|数周后|几天后|[一二三四五六七八九十\d]+(?:分钟|小时|天|日|周|个月|年)[前后]|Live当天|Live前一天|Live结束后|演唱会当天|演出当天|数小时前|半小时后|10分钟后|几秒后)/.test(t)) {
    return true;
  }
  if (/^(?:January|February|March|April|May|June|July|August|September|October|November|December|\d+月\d+日|\d+:\d+)/i.test(t)) {
    return true;
  }
  if (t.length <= 2 && /^(?:夜|晚|朝|昼|夕)$/.test(t)) return true;
  return false;
};

const cleanCaption = (text) => String(text || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

const charKeyOfModelAsset = (assetName) => {
  const s = String(assetName || "").split("/").pop() || "";
  const sub = /^adv_live2d_(sub_[a-z0-9]+?)_/i.exec(s);
  if (sub) return sub[1].toLowerCase();
  const m = /^adv_live2d_([a-z0-9]+?)_\d+_/i.exec(s);
  return m ? m[1].toLowerCase() : s;
};

const extractModelActions = async (baseUrl, cacheSubdir, modelEntry) => {
  const relManifest = modelEntry.manifest;
  const manifest = await fetchCachedJson(
    path.join(RAW_DIR, cacheSubdir, relManifest),
    `${baseUrl}/${relManifest}`,
  );
  if (!manifest?.files) return null;
  const prefabKey = Object.keys(manifest.files).find((k) => k.endsWith(".prefab.json"));
  if (!prefabKey) return null;
  const prefabEntry = manifest.files[prefabKey];
  let nodes = [];
  if (Array.isArray(prefabEntry.parts)) {
    const nodesPart = prefabEntry.parts.find(([k]) => k === "nodes");
    if (nodesPart?.[1]) {
      const assetRel = nodesPart[1];
      const raw = await fetchCachedBuffer(path.join(RAW_DIR, "assets", assetRel), `${baseUrl}/${assetRel}`);
      if (raw) {
        const jsonBuf = assetRel.endsWith(".gz") ? zlib.gunzipSync(raw) : raw;
        nodes = JSON.parse(jsonBuf.toString("utf8"));
      }
    }
  } else if (prefabEntry.asset) {
    const assetRel = prefabEntry.asset;
    const raw = await fetchCachedBuffer(path.join(RAW_DIR, "assets", assetRel), `${baseUrl}/${assetRel}`);
    if (raw) {
      const jsonBuf = assetRel.endsWith(".gz") ? zlib.gunzipSync(raw) : raw;
      nodes = JSON.parse(jsonBuf.toString("utf8")).nodes || [];
    }
  }
  const root = nodes.find((n) => (n.components || []).some((c) => c.class === "Live2DCharacter")) || nodes[0];
  const ch = root?.components?.find((c) => c.class === "Live2DCharacter");
  if (!ch) return null;
  let motions = (ch._motionList || []).map((m) => (typeof m === "string" ? m : m?.clip || m?.name)).filter(Boolean);
  if (!motions.length) motions = (ch.Motions || []).map((m) => m?.Name).filter(Boolean);
  const expressions = (ch._expressionList || []).filter((e) => typeof e === "string");
  return {
    motions: [...new Set(motions)],
    expressions: [...new Set(expressions)],
    defaultMotion: ch.DefaultMotionName || "",
    defaultExpression: ch.DefaultExpressionName || "",
  };
};

export const collectCloudRaw = async () => {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  console.log("Fetching catalogs, models, stories index...");
  const catalogs = await fetchCachedJson(path.join(RAW_DIR, "catalogs.json"), `${ASSETS_BASE}/catalogs`);
  const twSnap = catalogs.find((c) => c.region === "tw" && c.locale === "zh-Hans" && c.current)?.snapshot;
  if (!twSnap) throw new Error("Could not find current tw/zh-Hans snapshot");

  const twModelsDoc = await fetchCachedJson(path.join(RAW_DIR, "tw-models.json"), `${STORAGE_BASE}/models.json`);
  const jpModelsDoc = await fetchCachedJson(path.join(RAW_DIR, "jp-models.json"), `${STORAGE_BASE}/jp/models.json`);
  const storiesDoc = await fetchCachedJson(path.join(RAW_DIR, "stories.json"), `${STORAGE_BASE}/stories.json`);

  const stageAssets = await listPrefix(twSnap, "Adv/Stage/adv_bkg_stage_");
  const bgmAssets = await listPrefix(twSnap, "Cri/Sound/sound_bgm_adv");
  const seAssets = await listPrefix(twSnap, "Cri/Sound/sound_se_adv");
  const epAssets = await listPrefix(twSnap, "Adv/Episode/");

  const stageIds = [...new Set(stageAssets.map((a) => a.key.split("/")[2]).filter(Boolean))].sort();
  const bgmCues = [...new Set(bgmAssets.map((a) => a.key.split("/").pop()).filter(Boolean))].sort();
  const seCues = [...new Set(seAssets.map((a) => a.key.split("/").pop()).filter(Boolean))].sort();
  const scripts = [...new Set(epAssets.map((a) => a.key.split("/")[2]).filter(Boolean))].sort();

  console.log(`Discovered: ${stageIds.length} stages, ${bgmCues.length} BGMs, ${seCues.length} SEs, ${scripts.length} scripts, ` +
    `${twModelsDoc.models.length} TW models, ${jpModelsDoc.models.length} JP models`);

  const validStoryAdvIds = new Set(
    (storiesDoc?.stories || [])
      .filter((s) => s && s.advId != null && (s.playbackMode === undefined || s.playbackMode === 0))
      .map((s) => Number(s.advId)),
  );
  const storyTitlesByAdvId = new Map(
    (storiesDoc?.stories || []).map((s) => [Number(s.advId), s.titles?.["zh-Hans"] || s.titles?.ja || ""]),
  );

  const stageInfo = Object.fromEntries(stageIds.map((id) => [id, {
    id, captions: {}, timeCaptions: {}, allCaptions: {}, chars: {}, scripts: [], donorAdvIds: [], sampleLines: [],
  }]));
  const bgmInfo = Object.fromEntries(bgmCues.map((cue) => [cue, {
    cue, notes: {}, expressions: {}, motions: {}, stages: {}, scripts: [], donorAdvIds: [], sampleLines: [],
  }]));
  const seInfo = Object.fromEntries(seCues.map((cue) => [cue, {
    cue, notes: {}, scripts: [], donorAdvIds: [], sampleLines: [],
  }]));
  const extraDonors = { frames: {}, postEffects: {}, effects: {}, stills: {}, transitions: {} };

  const bump = (obj, key, n = 1) => { if (key) obj[key] = (obj[key] || 0) + n; };
  const pushUnique = (arr, val, max = 8) => { if (val != null && !arr.includes(val) && arr.length < max) arr.push(val); };

  let epDone = 0;
  await pool(scripts, 24, async (sc) => {
    const base = `${ASSETS_BASE}/zh-Hans/Adv/Episode/${sc}/${sc}`;
    const cdir = path.join(RAW_DIR, "episodes", sc);
    const [ep, text, sound, sheet] = await Promise.all([
      fetchCachedJson(path.join(cdir, "Episode.json"), `${base}-Episode/${sc}-Episode.json`),
      fetchCachedJson(path.join(cdir, "Text.json"), `${base}-Text/${sc}-Text.json`),
      fetchCachedJson(path.join(cdir, "Sound.json"), `${base}-Sound/${sc}-Sound.json`),
      fetchCachedJson(path.join(cdir, "SoundCueSheet.json"), `${base}-SoundCueSheet/${sc}-SoundCueSheet.json`),
    ]);
    epDone++;
    if (epDone % 200 === 0 || epDone === scripts.length) console.log(`  episodes ${epDone}/${scripts.length}`);
    if (!ep?._allData) return;

    const textMap = new Map((text?._allData || []).map((r) => [r._id, r]));
    const sheetMap = new Map((sheet?._allData || []).map((r) => [r._id, r]));
    const soundMap = new Map((sound?._allData || []).map((r) => [r._id, r]));
    const charModels = new Map();
    const advId = Number(ep._allData[0]?._advID);
    const isStoryDonor = Number.isFinite(advId) && validStoryAdvIds.has(advId);

    for (const row of sheet?._allData || []) {
      const name = row._cueSheetName;
      if (bgmInfo[name] && row._note) bump(bgmInfo[name].notes, row._note);
      if (seInfo[name] && row._note) bump(seInfo[name].notes, row._note);
    }

    let curStage = "";
    let curStageAt = -999;
    let curBgm = "";
    let stageSampleCount = 0;
    const rows = ep._allData;
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      if (row._ignoreData) continue;
      const cmd = row._command;
      if (cmd === 23 && row._targetName) {
        charModels.set(row._targetName, charKeyOfModelAsset(row._targetAssetName));
      } else if (cmd === 25 && row._targetAssetName) {
        const sid = String(row._targetAssetName).split("/").pop();
        curStage = stageInfo[sid] ? sid : "";
        curStageAt = idx;
        stageSampleCount = 0;
        if (curStage) {
          pushUnique(stageInfo[curStage].scripts, sc, 12);
          if (isStoryDonor) pushUnique(stageInfo[curStage].donorAdvIds, advId, 6);
        }
      } else if (cmd === 20 && curStage) {
        const tid = row._advTextID || (row._targetTextIDs || [])[0];
        const trec = tid ? textMap.get(tid) : null;
        const caption = cleanCaption(trec?._simplifiedChinese || trec?._traditionalChinese || trec?._japanese || trec?._english);
        if (caption) {
          bump(stageInfo[curStage].allCaptions, caption);
          if (idx - curStageAt <= 12) {
            if (isTimeCaption(caption)) bump(stageInfo[curStage].timeCaptions, caption);
            else bump(stageInfo[curStage].captions, caption);
          }
        }
      } else if (cmd === 15) {
        if (row._parameter1 === "Stop") {
          curBgm = "";
        } else if (row._bgmID) {
          const srow = soundMap.get(row._bgmID);
          const sh = srow ? sheetMap.get(srow._soundCueSheetID) : null;
          const cue = srow?._cueName || sh?._cueSheetName || "";
          if (bgmInfo[cue]) {
            curBgm = cue;
            pushUnique(bgmInfo[cue].scripts, `${sc}:${storyTitlesByAdvId.get(advId) || ""}`, 10);
            if (isStoryDonor) pushUnique(bgmInfo[cue].donorAdvIds, advId, 6);
            if (curStage) bump(bgmInfo[cue].stages, curStage);
          } else {
            curBgm = "";
          }
        }
      } else if (cmd === 31 && row._seID) {
        const srow = soundMap.get(row._seID);
        const sh = srow ? sheetMap.get(srow._soundCueSheetID) : null;
        const cue = srow?._cueName || "";
        if (seInfo[cue]) {
          if (srow._note) bump(seInfo[cue].notes, srow._note);
          if (sh?._note) bump(seInfo[cue].notes, sh._note);
          pushUnique(seInfo[cue].scripts, sc, 8);
          if (isStoryDonor) pushUnique(seInfo[cue].donorAdvIds, advId, 4);
          // grab nearby talk text for SE context
          for (let j = Math.max(0, idx - 1); j <= Math.min(rows.length - 1, idx + 2); j++) {
            if (rows[j]?._command === 2 && rows[j]._advTextID) {
              const t = cleanCaption(textMap.get(rows[j]._advTextID)?._simplifiedChinese);
              if (t) { pushUnique(seInfo[cue].sampleLines, t.slice(0, 60), 4); break; }
            }
          }
        }
      } else if (cmd === 2 || cmd === 17 || cmd === 21 || cmd === 0) {
        if (curStage && row._targetName) {
          const ck = charModels.get(row._targetName) || row._targetName;
          bump(stageInfo[curStage].chars, ck);
        }
        if (curBgm && bgmInfo[curBgm]) {
          if (row._expressionName) bump(bgmInfo[curBgm].expressions, row._expressionName);
          if (row._motionName) bump(bgmInfo[curBgm].motions, row._motionName.replace(/_[LCR]$/, ""));
        }
        if (cmd === 2 && row._advTextID) {
          const t = cleanCaption(textMap.get(row._advTextID)?._simplifiedChinese);
          if (t) {
            if (curStage && stageSampleCount < 3) {
              pushUnique(stageInfo[curStage].sampleLines, t.slice(0, 70), 6);
              stageSampleCount++;
            }
            if (curBgm && bgmInfo[curBgm]) pushUnique(bgmInfo[curBgm].sampleLines, t.slice(0, 60), 5);
          }
        }
      } else if (isStoryDonor && row._targetAssetName) {
        const assetTail = String(row._targetAssetName).split("/").pop();
        if (cmd === 44) pushUnique(extraDonors.frames[assetTail] ||= [], advId, 4);
        else if (cmd === 43) pushUnique(extraDonors.postEffects[assetTail] ||= [], advId, 4);
        else if (cmd === 54) pushUnique(extraDonors.effects[assetTail] ||= [], advId, 4);
        else if (cmd === 30) pushUnique(extraDonors.stills[assetTail] ||= [], advId, 4);
        else if ((cmd === 5 || cmd === 6) && /adv_transition_/.test(assetTail)) {
          pushUnique(extraDonors.transitions[assetTail] ||= [], advId, 4);
        }
      }
    }
  });

  console.log("Fetching model actions for 209 TW + 58 JP models...");
  const twModels = [];
  await pool(twModelsDoc.models, 12, async (m) => {
    const actions = await extractModelActions(STORAGE_BASE, "tw-models", m);
    twModels.push({
      id: m.id,
      region: "tw",
      manifest: m.manifest,
      characterNum: m.character ?? null,
      group: m.group || "",
      label: m.label || "",
      names: m.names || {},
      actions: actions || { motions: [], expressions: [], defaultMotion: "", defaultExpression: "" },
    });
  });
  const jpModels = [];
  await pool(jpModelsDoc.models, 12, async (m) => {
    const actions = await extractModelActions(`${STORAGE_BASE}/jp`, "jp-models", m);
    jpModels.push({
      id: m.id,
      region: "jp",
      manifest: `jp/${m.manifest}`,
      characterNum: m.character ?? null,
      group: m.group || "",
      label: m.label || "",
      names: m.names || {},
      actions: actions || { motions: [], expressions: [], defaultMotion: "", defaultExpression: "" },
    });
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    snapshot: twSnap,
    counts: {
      stages: stageIds.length,
      bgm: bgmCues.length,
      se: seCues.length,
      twModels: twModels.length,
      jpModels: jpModels.length,
      scripts: scripts.length,
    },
    stages: stageInfo,
    bgm: bgmInfo,
    se: seInfo,
    extraDonors,
    twModels: twModels.sort((a, b) => a.id.localeCompare(b.id)),
    jpModels: jpModels.sort((a, b) => a.id.localeCompare(b.id)),
  };
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  console.log(`Saved raw summary to ${SUMMARY_FILE}`);
  return summary;
};

const BAND_ALIAS = {
  "是一家Dumb Rock!": "家团",
  "梦限大MewType": "梦限大",
};

const normalizeBand = (b) => BAND_ALIAS[b] || b || "";

const isNonPlaceCaption = (t) => {
  if (isTimeCaption(t)) return true;
  return /^(?:演出(?:前|中|后|结束|当天|当日|活动)|彩排|正式演出|下班|回家路上|练习(?:前|中|后|日)|乐队排练|乐队练习|休[息假]日|某个|某天|又过了一天|几十分钟|双方Family|开学典礼|午休|约半年|文化节演出|第\d+话|另一天|由乃收到|采访当天|回到现在|？？？|全国巡演|新曲完成)/.test(String(t || "").trim());
};

const isIndoorPlace = (name) => /(?:房间|教室|大厅|休息室|候场室|咖啡|餐厅|厨房|客厅|礼堂|会场|舞台|办公室|办公区|会议室|摄影棚|录音室|排练室|走廊|楼梯|车库|电车|教堂|古堡|洋馆|水族馆|体育馆|店|食堂|医院|车内|后台|换鞋处|玄关|阁楼|图书馆|寝室|书房|洗衣间|琴房|卖场|前台|中转|宿舍|室内|卡拉OK|台球室|游轮|船内)/.test(name);

const isSharedPlace = (name) => /(?:街头|街道|道路|路口|停车场|RiNG|咖啡|餐厅|公园|车站|站台|广场|商店街|便利店|海边|天桥|卡拉OK|水族馆|市民会场|商场|购物中心|商店|拉面|体育馆|电车|机场|港口|渡轮|剧场|天空|夜空|晚霞|住宅区|校园操场|大台阶|集合地点|游乐场)/.test(name);

const inferBandFromMeta = (name, charsObj = {}) => {
  if (/水濑女子|都立艺术|汐见|伊泽|滨崎|琴平|泽海/.test(name)) return "茉团";
  if (/Peace之家|惠子食堂|Nest/.test(name)) return "家团";
  if (/Win-Wing|丰川|若叶|月之森|初华|若麦|海铃|翡翠交响|古堡|洋馆/.test(name)) return "Ave Mujica";
  if (/羽丘|花咲川|千早|长崎|高松|椎名|RiNG/.test(name)) return "MyGO!!!!!";
  if (/神田白八马|VR Floor|仲町|千石|峰月|藤家|宫永|铃鸣莱|集训设施/.test(name)) return "梦限大";
  const counts = {};
  for (const [ck, n] of Object.entries(charsObj)) {
    const b = CLOUD_CHARACTER_BANDS[ck];
    if (b) counts[b] = (counts[b] || 0) + Number(n || 0);
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (top.length === 1 || (top[0] && (!top[1] || top[0][1] >= top[1][1] * 2))) {
    return top[0][0];
  }
  return "";
};

const inferTimeOfDay = (raw, visual) => {
  if (visual) {
    const [r, , b] = visual.rgb || [128, 128, 128];
    if (visual.luma < 65) return "夜晚";
    if (r - b > 35 && visual.luma >= 65) return "黄昏";
  }
  const timeText = Object.keys(raw.timeCaptions || {}).join(" ");
  if (/夜|晚|深夜|凌晨/.test(timeText)) return "夜晚";
  if (/傍晚|黄昏/.test(timeText)) return "黄昏";
  return "白天";
};

const pickBestPlaceCaption = (raw) => {
  const ranked = Object.entries(raw.captions || {})
    .filter(([k]) => !isNonPlaceCaption(k))
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length) return ranked[0][0];
  const fallback = Object.entries(raw.allCaptions || {})
    .filter(([k]) => !isNonPlaceCaption(k))
    .sort((a, b) => b[1] - a[1]);
  return fallback[0]?.[0] || "";
};

const SORTED_CHAR_KEYS = Object.keys(CLOUD_CHARACTER_NAMES).sort((a, b) => b.length - a.length);

const splitModelKey = (id, assetName = "") => {
  const s = String(assetName || id).split("/").pop().replace(/^adv_live2d_/i, "");
  const numbered = /^([a-z0-9]+?)_\d+_(.+)$/i.exec(s);
  if (numbered) return { charKey: numbered[1].toLowerCase(), costumeKey: numbered[2].toLowerCase() };
  const sLow = s.toLowerCase();
  for (const ck of SORTED_CHAR_KEYS) {
    if (sLow.startsWith(`${ck}_`)) {
      return { charKey: ck, costumeKey: sLow.slice(ck.length + 1) };
    }
  }
  const sub = /^(sub_[a-z0-9]+?)_(.+)$/i.exec(s);
  if (sub) return { charKey: sub[1].toLowerCase(), costumeKey: sub[2].toLowerCase() };
  return { charKey: sLow, costumeKey: "" };
};

export const buildCloudCatalog = () => {
  if (!fs.existsSync(SUMMARY_FILE)) {
    throw new Error(`Missing raw summary ${SUMMARY_FILE}; run with --collect first`);
  }
  const summary = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8"));
  const visualsPath = path.join(RAW_DIR, "stage-visuals.json");
  const rawVisuals = fs.existsSync(visualsPath) ? JSON.parse(fs.readFileSync(visualsPath, "utf8")) : {};
  const visuals = Array.isArray(rawVisuals)
    ? Object.fromEntries(rawVisuals.map((v) => [v.id, v]))
    : rawVisuals;

  const stagesYaml = {};
  const stageRecords = [];

  for (const id of Object.keys(summary.stages).sort()) {
    const raw = summary.stages[id];
    const vis = visuals[id];
    const core = CORE_STAGE_OVERRIDES[id];
    const extra = EXTRA_STAGE_OVERRIDES[id];
    const override = core || extra;

    const place = override?.name || pickBestPlaceCaption(raw) || "通用室内外场景";
    const timeOfDay = override?.timeOfDay || inferTimeOfDay(raw, vis);
    const indoor = override?.indoor !== undefined ? override.indoor : isIndoorPlace(place);
    const kind = override?.kind || (isSharedPlace(place) ? "shared" : "");
    const band = normalizeBand(override?.band || inferBandFromMeta(place, raw.chars));

    const tags = override?.tags
      ? [...override.tags]
      : [timeOfDay, indoor ? "室内" : "室外"];
    if (!override?.tags) {
      if (/学园|学院|教室|学校|校门|天台|操场/.test(place)) tags.push("学校");
      if (/排练室|录音室|车库/.test(place)) tags.push("排练");
      if (/房间|客厅|厨房|卧室|宿舍/.test(place)) tags.push("居家");
      if (/街头|街道|车站|公园|海边/.test(place)) tags.push("街景");
      if (/咖啡|餐厅|拉面|食堂/.test(place)) tags.push("餐饮");
      if (/舞台|Live House|Nest|剧场/.test(place)) tags.push("演出");
    }

    const description = override?.description || [
      `${timeOfDay}${indoor ? "室内" : "室外"}的「${place}」`,
      band && kind !== "shared" ? `（${band}相关场景）` : "",
      "。",
      indoor ? "适合室内对话与聚会" : "适合户外出行、偶遇与交谈",
      timeOfDay === "夜晚" ? "，氛围安静偏暗" : timeOfDay === "黄昏" ? "，夕阳光线偏暖" : "",
      "。",
    ].join("");

    const entry = {
      name: place,
      ...(kind ? { kind } : {}),
      tags: [...new Set(tags)],
      ...(kind === "title" ? {} : { indoor, timeOfDay }),
      ...(band ? { band } : {}),
      description,
    };
    stagesYaml[id] = entry;
    stageRecords.push({
      id,
      ...entry,
      kind: kind || "",
      donorAdvId: raw.donorAdvIds?.[0] ?? null,
    });
  }

  const musicYaml = {};
  const musicRecords = [];
  for (const cue of Object.keys(summary.bgm).sort()) {
    const raw = summary.bgm[cue];
    const g = BGM_GUIDE[cue];
    if (!g) throw new Error(`Missing BGM_GUIDE entry for ${cue}`);
    const entry = {
      name: g.name,
      mood: g.mood,
      ...(g.tempo ? { tempo: g.tempo } : {}),
      use: g.use,
    };
    musicYaml[cue] = entry;
    musicRecords.push({
      cue,
      sheet: cue,
      ...entry,
      donorAdvId: raw.donorAdvIds?.[0] ?? null,
    });
  }

  const soundsYaml = {};
  const soundRecords = [];
  for (const cue of Object.keys(summary.se).sort()) {
    const raw = summary.se[cue];
    const g = SE_GUIDE[cue];
    if (!g) throw new Error(`Missing SE_GUIDE entry for ${cue}`);
    const entry = {
      name: g.name,
      ...(g.category ? { category: g.category } : {}),
      use: g.use,
    };
    soundsYaml[cue] = entry;
    soundRecords.push({
      cue,
      sheet: "sound_se_adv",
      ...entry,
      donorAdvId: raw.donorAdvIds?.[0] ?? null,
    });
  }

  const enrichModel = (m) => {
    const { charKey, costumeKey } = splitModelKey(m.id);
    const charName = CLOUD_CHARACTER_NAMES[charKey] || m.names?.["zh-Hans"] || charKey;
    const costumeLabel = CLOUD_COSTUME_LABELS[costumeKey] || m.label || costumeKey;
    const band = CLOUD_CHARACTER_BANDS[charKey] || "";
    return {
      id: m.id,
      region: m.region,
      manifest: m.manifest,
      characterKey: charKey,
      characterNum: m.characterNum,
      characterName: charName,
      band,
      costumeKey,
      costumeLabel,
      isStillOrMask: /(?:_still|_mask|_silhouette)$/.test(costumeKey),
      actions: m.actions,
    };
  };

  const twModels = summary.twModels.map(enrichModel);
  const jpModels = summary.jpModels.map(enrichModel);

  const yamlHeader = [
    "# Semantic catalogue of the full BanG Dream! Our Notes cloud resources for the AI writer.",
    "# Generated offline by `node host/tools/build-cloud-catalog.mjs --build`.",
    `# Coverage: ${stageRecords.length} stages, ${musicRecords.length} BGMs, ${soundRecords.length} SEs.`,
    "# A site may ship its own <site>/story-resources.yaml; otherwise this bundled copy is used.",
    "",
  ].join("\n");

  const yamlDoc = {
    format: "ournotes.site-resources/1",
    stages: stagesYaml,
    music: musicYaml,
    sounds: soundsYaml,
  };
  fs.writeFileSync(SITE_RESOURCES_OUT, yamlHeader + yaml.dump(yamlDoc, { lineWidth: 140, noRefs: true }));

  const firstDonor = (map) => Object.fromEntries(
    Object.entries(map || {}).map(([k, arr]) => [k, arr?.[0] ?? null]).filter(([, v]) => v !== null),
  );

  const cloudCatalog = {
    format: "ournotes.cloud-catalog/1",
    generatedAt: new Date().toISOString(),
    snapshot: summary.snapshot,
    counts: {
      stages: stageRecords.length,
      music: musicRecords.length,
      sounds: soundRecords.length,
      twModels: twModels.length,
      jpModels: jpModels.length,
      totalModels: twModels.length + jpModels.length,
    },
    characters: CLOUD_CHARACTER_NAMES,
    characterBands: CLOUD_CHARACTER_BANDS,
    costumeLabels: CLOUD_COSTUME_LABELS,
    models: {
      tw: twModels,
      jp: jpModels,
    },
    stages: stageRecords,
    music: musicRecords,
    sounds: soundRecords,
    donors: {
      frames: firstDonor(summary.extraDonors?.frames),
      postEffects: firstDonor(summary.extraDonors?.postEffects),
      effects: firstDonor(summary.extraDonors?.effects),
      stills: firstDonor(summary.extraDonors?.stills),
      transitions: firstDonor(summary.extraDonors?.transitions),
    },
  };
  fs.writeFileSync(CLOUD_CATALOG_OUT, JSON.stringify(cloudCatalog, null, 2));
  console.log(
    `Built semantic catalog: ${stageRecords.length} stages, ${musicRecords.length} BGMs, ` +
    `${soundRecords.length} SEs, ${twModels.length} TW + ${jpModels.length} JP models.`,
  );
  return cloudCatalog;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--collect") || (!args.has("--build") && !fs.existsSync(SUMMARY_FILE))) {
    await collectCloudRaw();
  }
  if (!args.has("--collect") || args.has("--build")) {
    buildCloudCatalog();
  }
}
