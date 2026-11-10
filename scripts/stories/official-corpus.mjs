import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const OFFICIAL_IDS = Object.freeze([
  "10438", "10450", "10459", "10462", "10466", "10468", "10610", "10946",
  "10460", "10461", "10463", "10467", "10470", "10478", "10489", "10490",
  "10499", "10509", "10518", "10520", "10530", "10540", "10548", "10550",
  "10560", "10570", "10578", "10580", "10590", "10598",
]);

// The fixture uses BCP-47 keys; the downloaded site episodes use the engine's
// descriptive language keys. Both resolve through one shared text resolver.
export const LANGUAGE_FIELDS = Object.freeze({
  "zh-Hans": ["zh-Hans", "simplifiedChinese"],
  "zh-Hant": ["zh-Hant", "traditionalChinese"],
  ja: ["ja", "japanese"],
  en: ["en", "english"],
  ko: ["ko", "korean"],
});

export const episodeText = (episode, row, language = "zh-Hans") => {
  const fields = LANGUAGE_FIELDS[language] || [language];
  const sources = [row?.lines, episode?.text?.[String(row?.AdvTextID)]];
  for (const field of fields) {
    for (const source of sources) {
      if (typeof source?.[field] === "string" && source[field]) return source[field];
    }
  }
  return "";
};

export const decodeEpisodeAsset = (file, bytes) => {
  if (file.endsWith(".gz")) return JSON.parse(zlib.gunzipSync(bytes).toString("utf8"));
  if (file.endsWith(".br")) return JSON.parse(zlib.brotliDecompressSync(bytes).toString("utf8"));
  return JSON.parse(bytes.toString("utf8"));
};

export const readEpisodeAsset = (file) => decodeEpisodeAsset(file, fs.readFileSync(file));

const strictlyInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const pathHasLink = (from, to) => {
  let current = from;
  const relative = path.relative(from, to);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // Missing intermediate paths are handled by realpathSync below.
    }
  }
  return false;
};

const realRoot = (dir) => {
  const lexical = path.resolve(dir);
  const drive = path.parse(lexical).root;
  if (pathHasLink(drive, lexical)) return null;
  try {
    if (fs.lstatSync(lexical).isSymbolicLink()) return null;
    return { lexical, real: fs.realpathSync(lexical) };
  } catch {
    return null;
  }
};

// A candidate is accepted only when it is lexically and really strictly inside
// one allowed root and no component from that root to the candidate is a
// symlink/junction. This closes lexical-only containment bypasses.
const inspectCandidate = (candidate, roots) => {
  let realCandidate = null;
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return { file: null, reason: "symlink" };
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return { file: null, reason: "missing" };
  }
  let escaped = false;
  for (const root of roots) {
    if (!strictlyInside(root.lexical, candidate)) continue;
    if (pathHasLink(root.lexical, candidate)) return { file: null, reason: "symlink" };
    if (strictlyInside(root.real, realCandidate)) return { file: realCandidate, reason: null };
    escaped = true;
  }
  return { file: null, reason: escaped ? "symlink" : "outside" };
};

const assetPath = (assetsRoot, entry, siteRoot, roots) => {
  const rel = typeof entry === "string" ? entry : entry?.asset;
  if (typeof rel !== "string" || path.isAbsolute(rel) || !rel) {
    return { file: null, reason: "invalid" };
  }
  const normalized = rel.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return { file: null, reason: "invalid" };
  const clean = normalized.replace(/^\.\//, "");
  const candidates = [];
  if (siteRoot && clean.startsWith("assets/")) {
    candidates.push(path.resolve(siteRoot, clean));
  }
  candidates.push(path.resolve(assetsRoot, clean));
  if (siteRoot && clean.startsWith("assets/")) {
    candidates.push(path.resolve(assetsRoot, clean.slice("assets/".length)));
  }
  let symlink = false;
  for (const candidate of candidates) {
    const inspected = inspectCandidate(candidate, roots);
    if (inspected.file) return { file: inspected.file, reason: null };
    if (inspected.reason === "symlink") symlink = true;
  }
  return { file: null, reason: symlink ? "symlink" : "missing" };
};

export const discoverOfficialCorpus = ({ siteRoot, sampleRoot, assetsRoot }) => {
  const found = new Map();
  const failures = [];
  const roots = [realRoot(siteRoot), realRoot(assetsRoot), realRoot(sampleRoot)].filter(Boolean);
  for (const id of OFFICIAL_IDS) {
    try {
      const direct = path.join(sampleRoot, id, "episode.json");
      if (fs.existsSync(direct)) {
        const inspected = inspectCandidate(direct, roots);
        if (inspected.file) found.set(id, inspected.file);
        else failures.push({ id, kind: inspected.reason === "symlink" ? "symlink" : "asset",
          file: path.basename(direct),
          error: "direct sample episode resolves outside a real allowed root or through a link" });
        continue;
      }
      const story = path.join(siteRoot, "stories", `${id}.json`);
      const safeStory = inspectCandidate(story, roots);
      if (!safeStory.file) {
        if (safeStory.reason === "symlink") {
          failures.push({ id, kind: "symlink", file: path.basename(story),
            error: "site manifest resolves outside a real allowed root or through a link" });
        }
        continue;
      }
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(safeStory.file, "utf8"));
      } catch (error) {
        failures.push({ id, kind: "manifest", file: path.basename(story),
          error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const entry = manifest.files?.["episode.json"];
      if (!entry) {
        failures.push({ id, kind: "manifest", file: path.basename(story),
          error: "episode.json entry missing" });
        continue;
      }
      const asset = assetPath(assetsRoot, entry, siteRoot, roots);
      if (asset.file) found.set(id, asset.file);
      else failures.push({ id, kind: asset.reason === "symlink" ? "symlink" : "asset",
        file: String(typeof entry === "string" ? entry : entry.asset),
        error: "asset is missing, unsafe or resolves outside a real allowed root" });
    } catch (error) {
      failures.push({ id, kind: "discovery",
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  const entries = [...found].map(([id, file]) => ({ id, file }));
  Object.defineProperty(entries, "failures", { value: failures, enumerable: false });
  return entries;
};

const visibleChars = (s) => [...s.replace(/\s/g, "")].length;
const number = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// Close-up run attribution over the raw command stream. Every Talk row (text
// or blank) inherits the most recent Focus CameraDistance. A new close run
// starts at each Focus while the inherited distance is >=4, except a 4->5
// refinement of the same shot. A run's length is the number of text-bearing
// Talk rows until the next start; a trailing blank is a held reaction after
// the final spoken line, so it ends the run and the closing line is not
// counted separately. Zero-text runs count as one. This reproduces the checked
// 149 close runs, 116 of them length 1-2 (0.7785).
export const closeRunAttribution = (episode, { language = "zh-Hans" } = {}) => {
  const commands = Array.isArray(episode?.commands) ? episode.commands : [];
  const shots = [];
  let distance = 0, current = null;
  for (const c of commands) {
    if (c.cmd === "Focus") {
      const next = c.CameraDistance === undefined ? distance : number(c.CameraDistance);
      const refinement = current && distance === 4 && next === 5;
      if (next >= 4 && !refinement) {
        if (current) shots.push(current);
        current = { rows: [] };
      } else if (next < 4 && current) {
        shots.push(current);
        current = null;
      }
      distance = next;
    } else if (c.cmd === "Talk" && current) {
      current.rows.push(Boolean(episodeText(episode, c, language)));
    }
  }
  if (current) shots.push(current);
  const lengths = shots.map((shot) => {
    const text = shot.rows.filter(Boolean).length;
    const trailingBlank = shot.rows.length > 0 && !shot.rows[shot.rows.length - 1];
    return Math.max(1, text - (trailingBlank ? 1 : 0));
  });
  return {
    total: lengths.length,
    oneOrTwo: lengths.filter((n) => n <= 2).length,
    lengths,
  };
};

const TAIL_COMMANDS = Object.freeze({
  motions: ["Motion"], expressions: ["Expression"], looks: ["Look"],
  lookTargets: ["LookTarget"], focus: ["Focus"], track: ["Track"],
  zoom: ["Zoom"], pedestal: ["Pedestal"], panV2: ["PanV2"],
  dof: ["DoF"], se: ["Se"], bgm: ["Bgm"], stage: ["Stage"],
  ins: ["In"], outs: ["Out"],
});

// Commands after the final text Talk have no next line and are reported
// separately as a tail attribution. Ignored commands before that point are
// counted by episodeToLines without replaying their state mutations.
export const tailAttribution = (episode, { id, language = "zh-Hans" } = {}) => {
  const commands = Array.isArray(episode?.commands) ? episode.commands : [];
  let lastText = -1;
  for (let i = 0; i < commands.length; i++) {
    if (commands[i].cmd === "Talk" && episodeText(episode, commands[i], language)) lastText = i;
  }
  const counts = Object.fromEntries(Object.keys(TAIL_COMMANDS).map((key) => [key, 0]));
  counts.motionExpressions = 0;
  for (const c of commands.slice(lastText + 1)) {
    for (const [key, names] of Object.entries(TAIL_COMMANDS)) {
      if (names.includes(c.cmd)) counts[key]++;
    }
    if (c.cmd === "Motion" && c.ExpressionName) counts.motionExpressions++;
  }
  return { id, speaker: "", body: "", chars: 0, renderedLines: 0,
    segmentChars: [], distance: 0, camera: null, ...counts,
    onStage: 0, tail: true };
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
      if (episodeText(episode, c, language)) {
        totals.textLines++;
        if (!pendingMotions) totals.noMotionLines++;
      }
      pendingMotions = 0;
    }
  }
  return totals;
};

export const episodeToLines = (episode, { id, language = "zh-Hans" }) => {
  const lines = [], pending = { motions: 0, motionExpressions: 0, expressions: 0, looks: 0, lookTargets: 0,
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
      case "Motion": pending.motions++; if (c.ExpressionName) pending.motionExpressions++; break;
      case "Expression": pending.expressions++; break;
      case "Se": pending.se++; break;
      case "Bgm": pending.bgm++; break;
      case "Talk": {
        talkRows++;
        const body = episodeText(episode, c, language);
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
