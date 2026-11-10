import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  discoverOfficialCorpus, episodeText, episodeToLines, OFFICIAL_IDS,
  rawCommandDistributions, decodeEpisodeAsset, tailAttribution, closeRunAttribution,
} from "./official-corpus.mjs";
import {
  aggregate, summarize, summarizeTailCounts, withCorpusRateDenominators, withTailCounts,
} from "./story-metrics.mjs";

const CHECKED_TOTALS = Object.freeze({
  episodes: 30,
  commands: 5623,
  talkRows: 1300,
  textLines: 1158,
  blankTalkRows: 142,
  focus: 516,
  motion: 1508,
  lookRows: 362,
  zoom: 152,
  pedestal: 122,
  track: 95,
  dof: 24,
  panV2: 167,
  se: 147,
});

const CHECKED_DISTRIBUTIONS = Object.freeze({
  count: 1158,
  charsMean: 15.5415,
  charsMedian: 14,
  charsP90: 30,
  segmentCharsMean: 11.1161,
  perTextLineTwoLineShare: 0.3826,
  perTextLineThreeLineShare: 0.0078,
  perTextLineShortShare: 0.2168,
  perTextLineEllipsisShare: 0.4637,
  perTextLineQuestionShare: 0.2582,
  perTextLineExclaimShare: 0.2142,
  perTextLineNoMotionShare: 0.0596,
  perTextLineLookLineShare: 0.3126,
  perTalkRowDistance2Share: 0.3892,
  perTalkRowDistance3Share: 0.3608,
  perTalkRowDistance4Share: 0.2038,
  perTalkRowDuoShare: 0.7623,
  perTalkRowEffectiveDuoShare: 0.7654,
  attributedMotions: 1502,
  motions: 1508,
  attributedMotionExpressions: 1497,
  motionExpressions: 1503,
  lookAny: 362,
  se: 147,
  bgm: 71,
  stage: 57,
  focus: 516,
  zoom: 152,
  pedestal: 122,
  panV2: 167,
  track: 95,
  dof: 24,
  speakerRunCount: 832,
  speakerRunMean: 1.3918,
  soloRunShare: 0.7284,
  // Raw-Talk-row close runs and performance-action lines, recomputed by
  // closeRunAttribution and performanceActionCount rather than hardcoded in
  // the prompt. closeRunOneOrTwoShare is oneOrTwo / total close runs.
  closeRunCount: 149,
  closeRunOneOrTwo: 116,
  closeRunOneOrTwoShare: 0.7785,
  twoActionLines: 518,
  twoMotionShare: 0.4473,
  standaloneExpressionPerEpisode: 0.0667,
});


const CHECKED_TAIL_COUNTS = Object.freeze({
  motions: 6, focus: 5, track: 1, zoom: 3, pedestal: 4,
  dof: 2, se: 5, bgm: 11, stage: 1, outs: 4,
});

const CHECKED_RAW_DISTRIBUTIONS = Object.freeze({
  talkRows: 1300, textLines: 1158, noMotionLines: 69,
});

export const BASELINE_TARGETS = Object.freeze({
  totals: CHECKED_TOTALS,
  distributions: CHECKED_DISTRIBUTIONS,
  tailCounts: CHECKED_TAIL_COUNTS,
  rawDistributions: CHECKED_RAW_DISTRIBUTIONS,
  corpusIds: OFFICIAL_IDS,
});

const rateOf = (n, d) => n / d;
const budget = (value, lines) => Math.max(1, Math.round(value * lines));
const CHECKED_LINE_MIN = 32;
const CHECKED_LINE_MAX = 47;
const CHECKED_LINES_PER_MINUTE = 18;
const CHECKED_CHARS_PER_MINUTE = 240;
const CHECKED_FOCUS_DURATION_DEFAULT = 1.5;
const CHECKED_ZOOM_DURATION_DEFAULT = 1.5;
const CHECKED_MOTION_FADE_IN_DEFAULT = -1;
const CHECKED_ZOOM_DEFAULT = 1.2;

// Flat, frozen adapter for downstream Task 2 prompt/budget consumers. Every
// value is derived from BASELINE_TARGETS; no checked literal is duplicated.
export const OFFICIAL_TARGETS = Object.freeze({
  lineCharsMean: CHECKED_DISTRIBUTIONS.charsMean,
  lineCharsMedian: CHECKED_DISTRIBUTIONS.charsMedian,
  lineCharsP90: CHECKED_DISTRIBUTIONS.charsP90,
  segmentCharsMean: CHECKED_DISTRIBUTIONS.segmentCharsMean,
  twoLineShare: CHECKED_DISTRIBUTIONS.perTextLineTwoLineShare,
  threeLineShare: CHECKED_DISTRIBUTIONS.perTextLineThreeLineShare,
  shortShare: CHECKED_DISTRIBUTIONS.perTextLineShortShare,
  ellipsisShare: CHECKED_DISTRIBUTIONS.perTextLineEllipsisShare,
  questionShare: CHECKED_DISTRIBUTIONS.perTextLineQuestionShare,
  exclaimShare: CHECKED_DISTRIBUTIONS.perTextLineExclaimShare,
  speakerRunMean: CHECKED_DISTRIBUTIONS.speakerRunMean,
  soloRunShare: CHECKED_DISTRIBUTIONS.soloRunShare,
  focusPerTalkRow: Number(rateOf(CHECKED_TOTALS.focus, CHECKED_TOTALS.talkRows).toFixed(3)),
  focusPerTextLine: Number(rateOf(CHECKED_TOTALS.focus, CHECKED_TOTALS.textLines).toFixed(3)),
  motionsPerTextLine: Number(rateOf(CHECKED_TOTALS.motion, CHECKED_TOTALS.textLines).toFixed(3)),
  lookAnyPerTextLine: Number(rateOf(CHECKED_TOTALS.lookRows, CHECKED_TOTALS.textLines).toFixed(3)),
  zoomPerTextLine: Number(rateOf(CHECKED_TOTALS.zoom, CHECKED_TOTALS.textLines).toFixed(3)),
  pedestalPerTextLine: Number(rateOf(CHECKED_TOTALS.pedestal, CHECKED_TOTALS.textLines).toFixed(3)),
  trackPerTextLine: Number(rateOf(CHECKED_TOTALS.track, CHECKED_TOTALS.textLines).toFixed(3)),
  dofPerTextLine: Number(rateOf(CHECKED_TOTALS.dof, CHECKED_TOTALS.textLines).toFixed(3)),
  panV2PerTextLine: Number(rateOf(CHECKED_TOTALS.panV2, CHECKED_TOTALS.textLines).toFixed(3)),
  sePerTextLine: Number(rateOf(CHECKED_TOTALS.se, CHECKED_TOTALS.textLines).toFixed(3)),
  bgmPerEpisode: Number(rateOf(CHECKED_DISTRIBUTIONS.bgm, CHECKED_TOTALS.episodes).toFixed(3)),
  noMotionShare: CHECKED_DISTRIBUTIONS.perTextLineNoMotionShare,
  closeRunOneOrTwoShare: CHECKED_DISTRIBUTIONS.closeRunOneOrTwoShare,
  twoMotionShare: CHECKED_DISTRIBUTIONS.twoMotionShare,
  standaloneExpressionPerEpisode: CHECKED_DISTRIBUTIONS.standaloneExpressionPerEpisode,
  lookLineShare: CHECKED_DISTRIBUTIONS.perTextLineLookLineShare,
  distance2Share: CHECKED_DISTRIBUTIONS.perTalkRowDistance2Share,
  distance3Share: CHECKED_DISTRIBUTIONS.perTalkRowDistance3Share,
  distance4Share: CHECKED_DISTRIBUTIONS.perTalkRowDistance4Share,
  duoShare: CHECKED_DISTRIBUTIONS.perTalkRowDuoShare,
  effectiveDuoShare: CHECKED_DISTRIBUTIONS.perTalkRowEffectiveDuoShare,
  textLinesPerEpisodeMean: rateOf(CHECKED_TOTALS.textLines, CHECKED_TOTALS.episodes),
  textLinesPerEpisodeMin: CHECKED_LINE_MIN,
  textLinesPerEpisodeMax: CHECKED_LINE_MAX,
  commandsPerEpisodeMean: rateOf(CHECKED_TOTALS.commands, CHECKED_TOTALS.episodes),
  linesPerMinute: CHECKED_LINES_PER_MINUTE,
  charsPerMinute: CHECKED_CHARS_PER_MINUTE,
  focusDurationDefault: CHECKED_FOCUS_DURATION_DEFAULT,
  zoomDurationDefault: CHECKED_ZOOM_DURATION_DEFAULT,
  motionFadeInDefault: CHECKED_MOTION_FADE_IN_DEFAULT,
  zoomDefault: CHECKED_ZOOM_DEFAULT,
  staticLineBudget: CHECKED_LINE_MAX,
  closeUps: budget(CHECKED_DISTRIBUTIONS.perTalkRowDistance4Share, CHECKED_LINE_MAX),
  motionBudget: budget(rateOf(CHECKED_TOTALS.motion, CHECKED_TOTALS.textLines), CHECKED_LINE_MAX),
  focusChanges: budget(rateOf(CHECKED_TOTALS.focus, CHECKED_TOTALS.talkRows), CHECKED_LINE_MAX),
  lookAtBudget: budget(rateOf(CHECKED_TOTALS.lookRows, CHECKED_TOTALS.textLines), CHECKED_LINE_MAX),
});

// Backward-compatible alias for the earlier Task 1 public export.
export const BASELINE_EXPECTATIONS = CHECKED_TOTALS;
export const BASELINE_SCHEMA = "official-baseline/2";
export const BASELINE_VERSION = 2;

const CHECKED_COMMANDS = Object.freeze({
  focus: ["Focus"], motion: ["Motion"], lookRows: ["Look", "LookTarget"],
  zoom: ["Zoom"], pedestal: ["Pedestal"], track: ["Track"], dof: ["DoF"],
  panV2: ["PanV2"], se: ["Se"], bgm: ["Bgm"], stage: ["Stage"],
  expression: ["Expression"],
});

const resolveRoot = (value, fallback) => path.resolve(value || fallback);
const hasObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const sortByCodePoint = (entries) => entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(sortByCodePoint(Object.entries(value))
      .map(([k, v]) => [k, stable(v)]));
  }
  return value;
};

const canonicalPayload = (report) => {
  const keys = Object.keys(report || {}).filter((key) => key !== "generatedAt");
  return Object.fromEntries(sortByCodePoint(keys.map((key) => {
    const value = key === "provenance"
      ? Object.fromEntries(Object.entries(report[key] || {})
        .filter(([field]) => field !== "digest"))
      : report[key];
    return [key, stable(value)];
  })));
};

export const canonicalReportDigest = (report) =>
  sha256(JSON.stringify(canonicalPayload(report)));

export const corpusConfigFromEnv = (env = process.env) => ({
  siteRoot: resolveRoot(env.OURNOTES_OFFICIAL_SITE, ""),
  sampleRoot: resolveRoot(env.OURNOTES_OFFICIAL_SAMPLE, ""),
  assetsRoot: resolveRoot(env.OURNOTES_OFFICIAL_ASSETS, ""),
  language: env.OURNOTES_OFFICIAL_LANGUAGE || "zh-Hans",
});

export const corpusEvidence = ({ siteRoot, sampleRoot, assetsRoot }) => {
  if (!siteRoot || !sampleRoot || !assetsRoot ||
      !fs.existsSync(path.join(siteRoot, "stories")) ||
      !fs.existsSync(sampleRoot) || !fs.existsSync(assetsRoot)) return false;
  const corpus = discoverOfficialCorpus({ siteRoot, sampleRoot, assetsRoot });
  return corpus.length === BASELINE_TARGETS.totals.episodes && !corpus.failures.length;
};

export const compareBaselineToReport = (recomputed, report) => {
  const failures = [];
  if (!report || typeof report !== "object") return ["report missing"];
  for (const key of ["schema", "version"]) {
    if (recomputed[key] !== report[key]) failures.push(`${key} mismatch`);
  }
  const recomputedCanonical = JSON.stringify(canonicalPayload(recomputed));
  const reportCanonical = JSON.stringify(canonicalPayload(report));
  if (recomputedCanonical !== reportCanonical) {
    const changed = Object.keys(recomputed).filter((key) =>
      key !== "generatedAt" && key !== "provenance" &&
      JSON.stringify(stable(recomputed[key])) !== JSON.stringify(stable(report[key])));
    failures.push(...changed.map((key) => `report ${key} mismatch`));
    if (!changed.length) failures.push("canonical payload mismatch: report has extra material fields");
  }
  const reportDigest = canonicalReportDigest(report);
  if (report.provenance?.digest !== reportDigest) {
    failures.push("provenance.digest mismatch: report is stale or fabricated");
  }
  if (recomputed.provenance?.digest !== report.provenance?.digest) {
    failures.push("provenance.digest does not match freshly recomputed corpus evidence");
  }
  for (const [key, expected] of Object.entries(BASELINE_TARGETS.totals)) {
    if (report.totals?.[key] !== expected) failures.push(`report totals.${key} mismatch`);
  }
  return failures;
};

const validateEpisode = (episode) => {
  const failures = [];
  if (!Array.isArray(episode?.commands)) failures.push("commands array missing");
  if (!hasObject(episode?.text)) failures.push("text object missing");
  if (!hasObject(episode?.sounds)) failures.push("sounds object missing");
  if (!hasObject(episode?.cuesheets)) failures.push("cuesheets object missing");
  if (!hasObject(episode?.videos)) failures.push("videos object missing");
  if (!Array.isArray(episode?.resources)) failures.push("resources array missing");
  if (Array.isArray(episode?.commands) && Number.isFinite(episode.commandCount) &&
      episode.commandCount !== episode.commands.length) {
    failures.push(`commandCount ${episode.commandCount} != ${episode.commands.length} commands`);
  }
  return failures;
};

const histogram = (commands) => {
  const out = {};
  for (const c of commands || []) {
    const cmd = typeof c?.cmd === "string" ? c.cmd : "<invalid>";
    out[cmd] = (out[cmd] || 0) + 1;
  }
  return Object.fromEntries(sortByCodePoint(Object.entries(out)));
};

export const buildBaseline = ({ siteRoot, sampleRoot, assetsRoot, language = "zh-Hans", corpus }) => {
  const discovery = corpus
    ? { length: corpus.length, failures: [...(corpus.failures || [])], entries: corpus }
    : discoverOfficialCorpus({ siteRoot, sampleRoot, assetsRoot });
  const entries = corpus || discovery;
  const failures = [...(discovery.failures || [])];
  const episodes = [], summaries = [], allLines = [], tailLines = [];
  const closeRuns = { total: 0, oneOrTwo: 0 };
  const rawDistributions = { talkRows: 0, textLines: 0, duoRows: 0, effectiveDuoRows: 0,
    noMotionLines: 0, distance2Rows: 0, distance3Rows: 0, distance4Rows: 0 };
  const totals = {
    episodes: 0, commands: 0, talkRows: 0, rawTalkRows: 0,
    textLines: 0, blankTalkRows: 0,
    focus: 0, motion: 0, lookRows: 0, zoom: 0, pedestal: 0, track: 0,
    dof: 0, panV2: 0, se: 0, bgm: 0, stage: 0, expression: 0,
  };
  const commandHistogram = {};

  for (const entry of entries) {
    const { id } = entry;
    const file = entry.file || entry.provenance?.file || "";
    const record = { id, file: path.basename(file), commands: 0, talkRows: 0, textLines: 0, blankTalkRows: 0 };
    try {
      const bytes = entry.provenance?.bytes !== undefined
        ? entry.provenance.bytes : fs.readFileSync(file);
      const episode = entry.episode || decodeEpisodeAsset(file, bytes);
      const validation = validateEpisode(episode);
      if (validation.length) {
        failures.push({ id, file: record.file, errors: validation });
        continue;
      }
      const commands = episode.commands;
      const hist = histogram(commands);
      const textLines = commands.filter((c) =>
        c.cmd === "Talk" && episodeText(episode, c, language)).length;
      const adapted = episodeToLines(episode, { id, language });
      if (adapted.talkRows !== (hist.Talk || 0) || adapted.lines.length !== textLines) {
        failures.push({ id, file: record.file,
          errors: [`Talk count mismatch: raw ${hist.Talk || 0}, adapted ${adapted.talkRows}, ` +
            `raw text ${textLines}, adapted text ${adapted.lines.length}`] });
        continue;
      }
      const summary = summarize(adapted.lines);
      const tail = tailAttribution(episode, { id, language });
      const close = closeRunAttribution(episode, { language });
      closeRuns.total += close.total;
      closeRuns.oneOrTwo += close.oneOrTwo;
      const raw = rawCommandDistributions(episode, { language });
      for (const key of Object.keys(rawDistributions)) rawDistributions[key] += raw[key];
      record.sha256 = entry.provenance?.sha256 || sha256(bytes);
      record.provenance = entry.provenance || {
        file: record.file, sha256: record.sha256, bytes: bytes.length,
      };
      record.commands = commands.length;
      record.commandCount = episode.commandCount;
      record.commandHistogram = hist;
      record.talkRows = adapted.talkRows;
      record.textLines = adapted.lines.length;
      record.blankTalkRows = adapted.talkRows - adapted.lines.length;
      record.rawTextTalkRows = textLines;
      record.summary = summary;
      record.tailAttribution = tail;
      record.closeRuns = close;
      episodes.push(record);
      summaries.push(summary);
      allLines.push(...adapted.lines);
      tailLines.push(tail);
      totals.episodes++;
      totals.commands += commands.length;
      totals.talkRows += adapted.talkRows;
      totals.rawTalkRows += hist.Talk || 0;
      totals.textLines += adapted.lines.length;
      totals.blankTalkRows += record.blankTalkRows;
      for (const [key, commands] of Object.entries(CHECKED_COMMANDS)) {
        for (const cmd of commands) totals[key] += hist[cmd] || 0;
      }
      for (const [cmd, count] of Object.entries(hist)) {
        commandHistogram[cmd] = (commandHistogram[cmd] || 0) + count;
      }
    } catch (error) {
      failures.push({ id, file: record.file, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (entries.length < BASELINE_TARGETS.totals.episodes) {
    failures.push({
      error: `expected ${BASELINE_TARGETS.totals.episodes} episode IDs, found ${entries.length}`,
      found: [...entries].map((e) => e.id),
    });
  }

  for (const [key, expected] of Object.entries(BASELINE_TARGETS.totals)) {
    if (totals[key] !== expected) {
      failures.push({ error: `total ${key}: expected ${expected}, got ${totals[key]}` });
    }
  }

  const corpusSummary = summarize(allLines);
  const report = {
    schema: BASELINE_SCHEMA,
    version: BASELINE_VERSION,
    generatedAt: new Date().toISOString(),
    language,
    corpusIds: [...entries].map((e) => e.id),
    expectations: BASELINE_TARGETS,
    generatedFrom: {
      siteRoot: path.basename(siteRoot || ""),
      sampleRoot: path.basename(sampleRoot || ""),
      assetsRoot: path.basename(assetsRoot || ""),
    },
    episodes,
    failures,
    totals: {
      ...totals,
      commandHistogram: Object.fromEntries(sortByCodePoint(Object.entries(commandHistogram))),
    },
    commandHistogram: Object.fromEntries(sortByCodePoint(Object.entries(commandHistogram))),
    all: {
      corpus: {
        ...Object.fromEntries(Object.entries(corpusSummary.perTextLine)
          .map(([k, v]) => [`perTextLine${k[0].toUpperCase()}${k.slice(1)}`, v])),
        ...Object.fromEntries(Object.entries(withCorpusRateDenominators(corpusSummary,
          rawDistributions, totals).perTalkRow)
          .map(([k, v]) => [`perTalkRow${k[0].toUpperCase()}${k.slice(1)}`, v])),
        ...withTailCounts(withCorpusRateDenominators(corpusSummary, rawDistributions, totals), tailLines),
        attributedMotions: corpusSummary.motions,
        attributedMotionExpressions: corpusSummary.motionExpressions,
        // Flat aliases are retained for downstream traceability, with explicit names.
        perTextLineNoMotionShare: rateOrZero(rawDistributions.noMotionLines, rawDistributions.textLines),
        perTextLineLookLineShare: rateOrZero(totals.lookRows, totals.textLines),
        perTalkRowDistance2Share: rateOrZero(rawDistributions.distance2Rows, rawDistributions.talkRows),
        perTalkRowDistance3Share: rateOrZero(rawDistributions.distance3Rows, rawDistributions.talkRows),
        perTalkRowDistance4Share: rateOrZero(rawDistributions.distance4Rows, rawDistributions.talkRows),
        perTalkRowDuoShare: rateOrZero(rawDistributions.duoRows, rawDistributions.talkRows),
        perTalkRowEffectiveDuoShare: rateOrZero(rawDistributions.effectiveDuoRows, rawDistributions.talkRows),
        // Directly recomputable from the checked command totals above.
        standaloneExpressionPerEpisode: rateOrZero(totals.expression, totals.episodes),
        // Raw-Talk-row close runs and >=2 performance-action lines.
        closeRunCount: closeRuns.total,
        closeRunOneOrTwo: closeRuns.oneOrTwo,
        closeRunOneOrTwoShare: rateOrZero(closeRuns.oneOrTwo, closeRuns.total),
        twoActionLines: corpusSummary.twoActionLines,
        twoMotionShare: corpusSummary.perTextLine.twoActionShare,
      },
      closeRuns: {
        total: closeRuns.total,
        oneOrTwo: closeRuns.oneOrTwo,
        share: rateOrZero(closeRuns.oneOrTwo, closeRuns.total),
      },
      perEpisodeMean: aggregate(summaries),
      rawDistributions,
      tailCounts: Object.fromEntries(Object.entries(summarizeTailCounts(tailLines))
        .filter(([, value]) => value !== 0)),
    },
  };
  const provenance = {
    episodeCount: episodes.length,
    language,
    bytes: report.episodes.reduce((n, e) => n + (e.provenance.bytes || 0), 0),
  };
  report.provenance = { ...provenance, digest: canonicalReportDigest({ ...report, provenance }) };
  return report;
};

const rateOrZero = (n, d) => (d ? n / d : 0);

const normalizeExecutable = (p) => path.resolve(p).toLowerCase().replaceAll("\\", "/");
const isCli = process.argv[1] &&
  normalizeExecutable(process.argv[1]) === normalizeExecutable(fileURLToPath(import.meta.url));

if (isCli) {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const siteRoot = resolveRoot(process.env.OURNOTES_OFFICIAL_SITE, path.join(workspace, "resources/site"));
  const assetsRoot = resolveRoot(process.env.OURNOTES_OFFICIAL_ASSETS, path.join(siteRoot, "assets"));
  const sampleRoot = resolveRoot(process.env.OURNOTES_OFFICIAL_SAMPLE, path.join(workspace, "output/_official-sample"));
  const lab = process.env.OURNOTES_AI_LAB ? path.resolve(process.env.OURNOTES_AI_LAB) : "";
  if (!lab) throw new Error("OURNOTES_AI_LAB is required");
  const report = buildBaseline({ siteRoot, sampleRoot, assetsRoot });
  fs.mkdirSync(lab, { recursive: true });
  const out = path.join(lab, "official-baseline.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${out}: ${report.episodes.length} episodes, ` +
    `${report.totals.commands} commands, ${report.failures.length} failures`);
  if (report.failures.length || report.episodes.length < BASELINE_TARGETS.totals.episodes) {
    for (const failure of report.failures) console.error(JSON.stringify(failure));
    process.exitCode = 1;
  }
}
