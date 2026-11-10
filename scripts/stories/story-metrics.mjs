const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (lines, k) => lines.reduce((a, b) => a + (b[k] || 0), 0);
const rate = (n, d) => (d ? n / d : 0);

export const percentile = (values, q) => {
  if (!values.length) return 0;
  const xs = [...values].sort((a, b) => a - b), pos = (xs.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
};

export const summarize = (lines) => {
  const chars = lines.map((l) => l.chars), segments = lines.flatMap((l) => l.segmentChars || []);
  const runs = [];
  let currentEpisode;
  for (const l of lines) {
    // Speaker runs are scoped to an episode: the same speaker at the end of one
    // episode and the start of another is still two separate runs.
    const newEpisode = l.id !== currentEpisode;
    const last = runs.at(-1);
    if (last && !newEpisode && last.speaker === l.speaker) last.length++;
    else runs.push({ speaker: l.speaker, length: 1 });
    currentEpisode = l.id;
  }
  const runLengths = runs.map((r) => r.length);
  return {
    count: lines.length, charsMean: mean(chars), charsMedian: percentile(chars, 0.5),
    charsP90: percentile(chars, 0.9), segmentCharsMean: mean(segments),
    twoLineShare: rate(lines.filter((l) => l.renderedLines === 2).length, lines.length),
    threeLineShare: rate(lines.filter((l) => l.renderedLines >= 3).length, lines.length),
    shortShare: rate(lines.filter((l) => l.chars >= 2 && l.chars <= 6).length, lines.length),
    ellipsisShare: rate(lines.filter((l) => /[…‥⋯]|\.\.\./.test(l.body)).length, lines.length),
    questionShare: rate(lines.filter((l) => /[?？]/.test(l.body)).length, lines.length),
    exclaimShare: rate(lines.filter((l) => /[!！]/.test(l.body)).length, lines.length),
    speakerRunCount: runLengths.length,
    speakerRunMean: mean(runLengths), soloRunShare: rate(runLengths.filter((n) => n === 1).length, runLengths.length),
    motions: sum(lines, "motions"), expressions: sum(lines, "expressions"),
    lookAny: sum(lines, "looks") + sum(lines, "lookTargets"),
    focus: sum(lines, "focus"), track: sum(lines, "track"), zoom: sum(lines, "zoom"),
    pedestal: sum(lines, "pedestal"), panV2: sum(lines, "panV2"), dof: sum(lines, "dof"),
    se: sum(lines, "se"), bgm: sum(lines, "bgm"), stage: sum(lines, "stage"),
    ins: sum(lines, "ins"), outs: sum(lines, "outs"),
    noMotionShare: rate(lines.filter((l) => !l.motions).length, lines.length),
    distance2Share: rate(lines.filter((l) => l.distance === 2).length, lines.length),
    distance3Share: rate(lines.filter((l) => l.distance === 3).length, lines.length),
    distance4Share: rate(lines.filter((l) => l.distance === 4).length, lines.length),
    duoShare: rate(lines.filter((l) => l.onStage === 2).length, lines.length),
  };
};

// Count-only tail records supply command totals for events that follow the
// final text Talk or carry IgnoreData. They are not dialogue lines: text,
// speaker-run and camera/position share denominators remain the real lines.
export const summarizeTailCounts = (records) => {
  const tail = records.filter((l) => l.tail);
  return {
    motions: sum(tail, "motions"), expressions: sum(tail, "expressions"),
    lookAny: sum(tail, "looks") + sum(tail, "lookTargets"),
    focus: sum(tail, "focus"), track: sum(tail, "track"), zoom: sum(tail, "zoom"),
    pedestal: sum(tail, "pedestal"), panV2: sum(tail, "panV2"), dof: sum(tail, "dof"),
    se: sum(tail, "se"), bgm: sum(tail, "bgm"), stage: sum(tail, "stage"),
    ins: sum(tail, "ins"), outs: sum(tail, "outs"),
  };
};

export const withTailCounts = (summary, records) => {
  const counts = summarizeTailCounts(records);
  return Object.fromEntries(Object.entries(summary).map(([k, v]) =>
    [k, typeof counts[k] === "number" ? v + counts[k] : v]));
};

export const aggregate = (summaries) => {
  const keys = Object.keys(summaries[0] || {}), out = {};
  for (const k of keys) out[k] = mean(summaries.map((s) => s[k] || 0));
  return out;
};

export const windowsOf = (lines, size = 40) => {
  const out = [];
  for (let i = 0; i + size <= lines.length; i += size) out.push(lines.slice(i, i + size));
  return out;
};
