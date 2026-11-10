import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { discoverOfficialCorpus, episodeToLines, readEpisodeAsset } from "./official-corpus.mjs";
import { aggregate, summarize } from "./story-metrics.mjs";

export const BASELINE_EXPECTATIONS = Object.freeze({
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

const CHECKED_COMMANDS = Object.freeze({
  focus: ["Focus"], motion: ["Motion"], lookRows: ["Look", "LookTarget"],
  zoom: ["Zoom"], pedestal: ["Pedestal"], track: ["Track"], dof: ["DoF"],
  panV2: ["PanV2"], se: ["Se"], bgm: ["Bgm"], stage: ["Stage"],
  expression: ["Expression"],
});

const resolveRoot = (value, fallback) => path.resolve(value || fallback);

const hasObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

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
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

const textOf = (episode, row) =>
  row.lines?.["zh-Hans"] || row.lines?.simplifiedChinese ||
  episode.text?.[String(row.AdvTextID)]?.["zh-Hans"] ||
  episode.text?.[String(row.AdvTextID)]?.simplifiedChinese || "";

export const buildBaseline = ({ siteRoot, sampleRoot, assetsRoot, language = "zh-Hans" }) => {
  const corpus = discoverOfficialCorpus({ siteRoot, sampleRoot, assetsRoot });
  const failures = [];
  const episodes = [], summaries = [], allLines = [];
  const totals = {
    episodes: 0, commands: 0, talkRows: 0, rawTalkRows: 0,
    textLines: 0, blankTalkRows: 0,
    focus: 0, motion: 0, lookRows: 0, zoom: 0, pedestal: 0, track: 0,
    dof: 0, panV2: 0, se: 0, bgm: 0, stage: 0, expression: 0,
  };
  const commandHistogram = {};

  for (const { id, file } of corpus) {
    const record = { id, file: path.basename(file), commands: 0, talkRows: 0, textLines: 0, blankTalkRows: 0 };
    try {
      const bytes = fs.readFileSync(file);
      const episode = readEpisodeAsset(file);
      const validation = validateEpisode(episode);
      if (validation.length) {
        failures.push({ id, file: record.file, errors: validation });
      } else {
        const commands = episode.commands;
        const hist = histogram(commands);
        const textLines = commands.filter((c) =>
          c.cmd === "Talk" && textOf(episode, c)).length;
        const adapted = episodeToLines(episode, { id, language });
        if (adapted.talkRows !== (hist.Talk || 0) || adapted.lines.length !== textLines) {
          failures.push({ id, file: record.file,
            errors: [`Talk count mismatch: raw ${hist.Talk || 0}, adapted ${adapted.talkRows}, ` +
              `raw text ${textLines}, adapted text ${adapted.lines.length}`] });
          continue;
        }
        const summary = summarize(adapted.lines);
        record.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        record.commands = commands.length;
        record.commandCount = episode.commandCount;
        record.commandHistogram = hist;
        record.talkRows = adapted.talkRows;
        record.textLines = adapted.lines.length;
        record.blankTalkRows = adapted.talkRows - adapted.lines.length;
        record.rawTextTalkRows = textLines;
        record.summary = summary;
        episodes.push(record);
        summaries.push(summary);
        allLines.push(...adapted.lines);
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
      }
    } catch (error) {
      failures.push({ id, file: record.file, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (corpus.length < BASELINE_EXPECTATIONS.episodes) {
    failures.push({
      error: `expected ${BASELINE_EXPECTATIONS.episodes} episode IDs, found ${corpus.length}`,
      found: corpus.map((e) => e.id),
    });
  }

  for (const [key, expected] of Object.entries(BASELINE_EXPECTATIONS)) {
    if (totals[key] !== expected) {
      failures.push({ error: `total ${key}: expected ${expected}, got ${totals[key]}` });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    corpusIds: corpus.map((e) => e.id),
    expectations: BASELINE_EXPECTATIONS,
    generatedFrom: {
      siteRoot: path.basename(siteRoot),
      sampleRoot: path.basename(sampleRoot),
      assetsRoot: path.basename(assetsRoot),
    },
    episodes,
    failures,
    totals: {
      ...totals,
      commandHistogram: Object.fromEntries(
        Object.entries(commandHistogram).sort(([a], [b]) => a.localeCompare(b))),
    },
    commandHistogram: Object.fromEntries(
      Object.entries(commandHistogram).sort(([a], [b]) => a.localeCompare(b))),
    all: {
      corpus: summarize(allLines),
      perEpisodeMean: aggregate(summaries),
    },
  };
};

const normalizeExecutable = (p) => path.resolve(p).toLowerCase().replaceAll("\\", "/");
const isCli = process.argv[1] &&
  normalizeExecutable(process.argv[1]) === normalizeExecutable(fileURLToPath(import.meta.url));

if (isCli) {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const siteRoot = resolveRoot(process.env.OURNOTES_OFFICIAL_SITE, path.join(workspace, "resources/site"));
  const assetsRoot = resolveRoot(process.env.OURNOTES_OFFICIAL_ASSETS, path.join(siteRoot, "assets"));
  const sampleRoot = resolveRoot(process.env.OURNOTES_OFFICIAL_SAMPLE, path.join(workspace, "output/_official-sample"));
  const lab = process.env.OURNOTES_AI_LAB
    ? path.resolve(process.env.OURNOTES_AI_LAB)
    : "";
  if (!lab) throw new Error("OURNOTES_AI_LAB is required");
  const report = buildBaseline({ siteRoot, sampleRoot, assetsRoot });
  fs.mkdirSync(lab, { recursive: true });
  const out = path.join(lab, "official-baseline.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${out}: ${report.episodes.length} episodes, ` +
    `${report.totals.commands} commands, ${report.failures.length} failures`);
  if (report.failures.length || report.episodes.length < BASELINE_EXPECTATIONS.episodes) {
    for (const failure of report.failures) console.error(JSON.stringify(failure));
    process.exitCode = 1;
  }
}
