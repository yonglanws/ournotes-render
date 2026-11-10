import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OFFICIAL_IDS = new Set([
  "10438", "10450", "10459", "10462", "10466", "10468", "10610", "10946",
  "10460", "10461", "10463", "10467", "10470", "10478", "10489", "10490",
  "10499", "10509", "10518", "10520", "10530", "10540", "10548", "10550",
  "10560", "10570", "10578", "10580", "10590", "10598",
]);

// The fixture uses BCP-47 keys; the downloaded site episodes use the engine's
// descriptive language keys. Both must resolve to the same simplified Chinese.
const LANGUAGE_FIELDS = {
  "zh-Hans": ["zh-Hans", "simplifiedChinese"],
  "zh-Hant": ["zh-Hant", "traditionalChinese"],
  ja: ["ja", "japanese"],
  en: ["en", "english"],
  ko: ["ko", "korean"],
};

export const readEpisodeAsset = (file) => {
  const bytes = fs.readFileSync(file);
  if (file.endsWith(".gz")) return JSON.parse(zlib.gunzipSync(bytes).toString("utf8"));
  if (file.endsWith(".br")) return JSON.parse(zlib.brotliDecompressSync(bytes).toString("utf8"));
  return JSON.parse(bytes.toString("utf8"));
};

const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const assetPath = (root, file, siteRoot) => {
  const rel = typeof file === "string" ? file : file.asset;
  if (typeof rel !== "string" || path.isAbsolute(rel) || !rel) return null;
  const normalized = rel.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return null;
  const clean = normalized.replace(/^\.\//, "");
  const roots = siteRoot ? [path.resolve(siteRoot), path.resolve(root)] : [path.resolve(root)];
  const candidates = [];
  if (siteRoot && clean.startsWith("assets/")) {
    candidates.push(path.resolve(siteRoot, clean));
  }
  candidates.push(path.resolve(root, clean));
  if (siteRoot && clean.startsWith("assets/")) {
    candidates.push(path.resolve(root, clean.slice("assets/".length)));
  }
  const found = candidates.find((candidate) =>
    roots.some((allowed) => isInside(allowed, candidate)) && fs.existsSync(candidate));
  return found || null;
};

export const discoverOfficialCorpus = ({ siteRoot, sampleRoot, assetsRoot }) => {
  const found = new Map();
  for (const id of OFFICIAL_IDS) {
    const direct = path.join(sampleRoot, id, "episode.json");
    if (fs.existsSync(direct)) { found.set(id, direct); continue; }
    const story = path.join(siteRoot, "stories", `${id}.json`);
    if (!fs.existsSync(story)) continue;
    const manifest = JSON.parse(fs.readFileSync(story, "utf8"));
    const entry = manifest.files?.["episode.json"];
    if (!entry) continue;
    const file = assetPath(assetsRoot, entry, siteRoot);
    if (file) found.set(id, file);
  }
  return [...found].map(([id, file]) => ({ id, file }));
};

const textOf = (episode, row, language) => {
  const fields = LANGUAGE_FIELDS[language] || [language];
  const sources = [row.lines, episode.text?.[String(row.AdvTextID)]];
  for (const field of fields) {
    for (const source of sources) {
      if (typeof source?.[field] === "string" && source[field]) return source[field];
    }
  }
  return "";
};
const visibleChars = (s) => [...s.replace(/\s/g, "")].length;
const number = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

const TAIL_COMMANDS = Object.freeze({
  motions: ["Motion"], expressions: ["Expression"], looks: ["Look"],
  lookTargets: ["LookTarget"], focus: ["Focus"], track: ["Track"],
  zoom: ["Zoom"], pedestal: ["Pedestal"], panV2: ["PanV2"],
  dof: ["DoF"], se: ["Se"], bgm: ["Bgm"], stage: ["Stage"],
  ins: ["In"], outs: ["Out"],
});

// Commands carrying IgnoreData are still part of the official command stream:
// their events count toward the next text Talk, but they are not replayed as
// state mutations. Commands after the final text Talk have no next line and
// are reported separately as a tail attribution.
export const tailAttribution = (episode, { id, language = "zh-Hans" } = {}) => {
  const commands = Array.isArray(episode?.commands) ? episode.commands : [];
  let lastText = -1;
  for (let i = 0; i < commands.length; i++) {
    if (commands[i].cmd === "Talk" && textOf(episode, commands[i], language)) lastText = i;
  }
  const counts = Object.fromEntries(Object.keys(TAIL_COMMANDS).map((key) => [key, 0]));
  for (const c of commands.slice(lastText + 1)) {
    for (const [key, names] of Object.entries(TAIL_COMMANDS)) {
      if (names.includes(c.cmd)) counts[key]++;
    }
  }
  return {
    id,
    speaker: "",
    body: "",
    chars: 0,
    renderedLines: 0,
    segmentChars: [],
    distance: 0,
    camera: null,
    ...counts,
    onStage: 0,
    tail: true,
  };
};

// Corpus-wide distributions use every raw Talk row as the denominator for
// inherited stage/camera state. The official checked shares also include the
// state of IgnoreData commands in that raw command stream.
export const rawCommandDistributions = (episode, { language = "zh-Hans" } = {}) => {
  const commands = Array.isArray(episode?.commands) ? episode.commands : [];
  const rawOn = new Map();
  const on = new Map();
  let distance = 0, pendingMotions = 0;
  const totals = {
    talkRows: 0, textLines: 0, duoRows: 0, effectiveDuoRows: 0, noMotionLines: 0,
    distance2Rows: 0, distance3Rows: 0, distance4Rows: 0,
  };
  for (const c of commands) {
    const name = typeof c.TargetName === "string" && c.TargetName ? c.TargetName : null;
    const effectiveName = c.IgnoreData ? null : name;
    for (const [map, target] of [[rawOn, name], [on, effectiveName]]) {
      if (!target) continue;
      if (c.cmd === "Character") map.set(target, null);
      else if (c.cmd === "In") map.set(target, c.PositionType ?? null);
      else if (c.cmd === "Out") map.delete(target);
      else if (c.cmd === "MoveToDirection" && map.has(target)) map.set(target, c.PositionType ?? null);
    }
    if (c.cmd === "Focus" && c.CameraDistance !== undefined) distance = number(c.CameraDistance);
    if (c.cmd === "Motion") pendingMotions++;
    else if (c.cmd === "Talk") {
      totals.talkRows++;
      const onStage = (map) => [...map.values()].filter((v) => v !== null).length;
      if (onStage(rawOn) === 2) totals.duoRows++;
      if (onStage(on) === 2) totals.effectiveDuoRows++;
      if (distance === 2) totals.distance2Rows++;
      else if (distance === 3) totals.distance3Rows++;
      else if (distance === 4) totals.distance4Rows++;
      if (textOf(episode, c, language)) {
        totals.textLines++;
        if (!pendingMotions) totals.noMotionLines++;
      }
      pendingMotions = 0;
    }
  }
  return totals;
};

export const episodeToLines = (episode, { id, language = "zh-Hans" }) => {
  const lines = [], pending = { motions: 0, expressions: 0, looks: 0, lookTargets: 0,
    focus: 0, track: 0, zoom: 0, pedestal: 0, panV2: 0, dof: 0, se: 0, bgm: 0, stage: 0,
    ins: 0, outs: 0, onStage: 0 };
  let talkRows = 0, distance = 0, speaker = "", lastCamera = null;
  const on = new Map();
  const commands = Array.isArray(episode.commands) ? episode.commands : [];
  const targetName = (c) => typeof c.TargetName === "string" && c.TargetName ? c.TargetName : null;
  for (const c of commands) {
    // Count the event even when its state mutation is intentionally ignored.
    const ignored = !!c.IgnoreData;
    switch (c.cmd) {
      case "Character": {
        const name = targetName(c);
        if (!ignored && name) on.set(name, null);
        break;
      }
      case "In": {
        const name = targetName(c);
        if (!ignored && name) on.set(name, c.PositionType ?? null);
        pending.ins++;
        break;
      }
      case "Out": {
        const name = targetName(c);
        if (!ignored && name) on.delete(name);
        pending.outs++;
        break;
      }
      // A slot transform without TargetName moves an existing stage position;
      // it must never introduce an `undefined` character into the stage map.
      case "MoveToDirection": {
        const name = targetName(c);
        if (!ignored && name && on.has(name)) on.set(name, c.PositionType ?? null);
        break;
      }
      case "Stage": pending.stage++; break;
      case "Focus":
        if (!ignored) distance = c.CameraDistance === undefined ? distance : number(c.CameraDistance);
        pending.focus++;
        if (!ignored) lastCamera = { kind: "focus", duration: number(c.Duration), value: distance };
        break;
      case "Track": pending.track++; if (!ignored) lastCamera = { kind: "track", duration: number(c.Duration), value: number(c.Parameter1) }; break;
      case "Zoom": pending.zoom++; if (!ignored) lastCamera = { kind: "zoom", duration: number(c.Duration), value: number(c.Parameter1) }; break;
      case "Pedestal": pending.pedestal++; if (!ignored) lastCamera = { kind: "pedestal", duration: number(c.Duration), value: number(c.Parameter1) }; break;
      case "PanV2": pending.panV2++; if (!ignored) lastCamera = { kind: "panV2", duration: number(c.Duration), value: number(c.Parameter1) }; break;
      case "DoF": pending.dof++; break;
      case "Look": pending.looks++; break;
      case "LookTarget": pending.lookTargets++; break;
      case "Motion": pending.motions++; break;
      case "Expression": pending.expressions++; break;
      case "Se": pending.se++; break;
      case "Bgm": pending.bgm++; break;
      case "Talk": {
        talkRows++;
        const body = textOf(episode, c, language);
        if (!body) break;
        const segments = body.split("\n").filter((s) => s.length);
        const chars = visibleChars(body);
        if (!ignored) speaker = c.TargetName || speaker;
        lines.push({ id, speaker, body, chars, renderedLines: segments.length,
          segmentChars: segments.map(visibleChars), distance,
          camera: lastCamera, ...pending, onStage: [...on.values()].filter((v) => v !== null).length });
        for (const k of Object.keys(pending)) if (typeof pending[k] === "number") pending[k] = 0;
        pending.onStage = 0;
        break;
      }
      default: break;
    }
  }
  return { id, talkRows, lines, commandCount: commands.length, failures: [] };
};
