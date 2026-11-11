# Official-Script Harness and Generation Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ournotes-player generate and compile stories that match measured official distributions, expose a verified official-command subset, and produce statistical, compiled, and rendered-frame evidence.

**Architecture:** Four independently testable layers share one official-baseline data source: a corpus/metric/evaluation harness, prompt budgets derived from those metrics, a story-script-to-episode command compiler extension, and a rendered-frame audit. Generated commands are independent ADV rows; this avoids the site-engine 0.1.8 `HostActions` timed-look defect.

**Tech Stack:** Node 22+ ESM, `node:test`, JSON/gzip/brotli episode assets, `ournotes.story-script/1`, the existing host AI client and `StoryWriter`, site-format player 0.1.8, ffmpeg, ESLint.

---

## File structure

- Create `scripts/stories/official-corpus.mjs`: corpus discovery, decompression, command-state inheritance, normalized line records.
- Create `scripts/stories/story-metrics.mjs`: one metric shape for official and generated scripts, aggregation and window helpers.
- Create `scripts/stories/official-baseline.mjs`: CLI baseline report and committed target constants.
- Create `scripts/stories/ai-eval.mjs`: fixed-scene offline `StoryWriter` evaluation and machine-readable reports.
- Create `scripts/stories/compiled-command-audit.mjs`: generated-script/compiled-episode command and resource-closure audit.
- Create `scripts/stories/frame-audit.mjs`: timeline-driven ffmpeg frame extraction and frame report.
- Create `scripts/stories/*.test.mjs`: baseline, AI-quality, command-audit, and frame-report gates.
- Create `host/ai/official-targets.js`: one imported source of prompt budgets and target ranges.
- Modify `host/ai/prompt.js`, `host/ai/staged.js`, `host/ai/storyWriter.js`: consume targets; add field allow-lists and diagnostics.
- Modify `scripts/lib/story-author/script.js`: parse/check/compile official camera, look, motion, and SE fields.
- Modify `host/tools/site-story.mjs`, `host/story/catalog.js`, `scripts/lib/story-author/site.js`: expose and close SE cue resources.
- Modify `schema/episode.schema.json`: declare real command fields.
- Modify `package.json`: `test:stories`, `baseline:stories`, `eval:stories`, `audit:stories`, `audit:frames` scripts.
- Modify `docs/story-director.md`, `docs/story-author.md`, `docs/host.md`: correct official numbers and document fields/commands.
- Preserve all 23 pre-existing unstaged files; never use `git add -A`.

All reports and generated data use `OURNOTES_AI_LAB` (default `<workspace>/../ournotes-ai-lab`) or the existing ignored `output/` directory. Never commit corpus, model responses, video, or frame PNGs.

---

## Task 1: Reproducible official corpus and metrics

**Files:**
- Create: `scripts/stories/official-corpus.mjs`
- Create: `scripts/stories/story-metrics.mjs`
- Create: `scripts/stories/official-baseline.mjs`
- Create: `scripts/stories/official-baseline.test.mjs`
- Create: `scripts/stories/fixtures/mini-official-episode.json`
- Modify: `package.json:23-34`
- Test: `scripts/stories/official-baseline.test.mjs`

- [ ] **Step 1: Write a tiny official-shaped fixture and failing test**

Create `scripts/stories/fixtures/mini-official-episode.json` with two text `Talk` rows, one blank `Talk`, one `Focus`, two `Motion`, one `Look`, one `LookTarget`, one `Zoom`, one `Pedestal`, one `PanV2`, one `DoF`, one `Se`, one `Bgm`, and one `Stage`. Include `i`, `cmd`, `raw`, `AdvTextID`, `lines.zh-Hans`, `VoiceIDs`, `CameraDistance`, `PositionType`, and `Parameter1` where relevant.

Add to `scripts/stories/official-baseline.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { episodeToLines } from "../scripts/stories/official-corpus.mjs";
import { summarize } from "../scripts/stories/story-metrics.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mini-official-episode.json", import.meta.url)));

test("official adapter separates text Talk rows from blank Talk rows", () => {
  const result = episodeToLines(fixture, { id: "fixture", language: "zh-Hans" });
  assert.equal(result.talkRows, 3);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].chars, 8);
  assert.equal(result.lines[0].renderedLines, 1);
});

test("metrics attribute pending camera and acting events to the next text Talk", () => {
  const { lines } = episodeToLines(fixture, { id: "fixture", language: "zh-Hans" });
  const totals = summarize(lines);
  assert.equal(totals.count, 2);
  assert.equal(totals.motions, 2);
  assert.equal(totals.lookAny, 2);
  assert.equal(totals.zoom, 1);
  assert.equal(totals.pedestal, 1);
  assert.equal(totals.panV2, 1);
  assert.equal(totals.dof, 1);
  assert.equal(totals.se, 1);
});
```

- [ ] **Step 2: Run the failing test**

Run: `node --test scripts/stories/official-baseline.test.mjs`
Expected: FAIL because `official-corpus.mjs` and `story-metrics.mjs` do not exist.

- [ ] **Step 3: Implement the corpus adapter**

In `scripts/stories/official-corpus.mjs`, export `readEpisodeAsset(path)`, `discoverOfficialCorpus(root)`, and `episodeToLines(episode, options)`.

```js
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OFFICIAL_IDS = new Set([
  "10438", "10450", "10459", "10462", "10466", "10468", "10610", "10946",
  "10460", "10461", "10463", "10467", "10470", "10478", "10489", "10490",
  "10499", "10509", "10518", "10520", "10530", "10540", "10548", "10550",
  "10560", "10570", "10578", "10580", "10590", "10598",
]);

export const readEpisodeAsset = (file) => {
  const bytes = fs.readFileSync(file);
  if (file.endsWith(".gz")) return JSON.parse(zlib.gunzipSync(bytes).toString("utf8"));
  if (file.endsWith(".br")) return JSON.parse(zlib.brotliDecompressSync(bytes).toString("utf8"));
  return JSON.parse(bytes.toString("utf8"));
};

const assetPath = (root, file) => {
  const rel = typeof file === "string" ? file : file.asset;
  return path.resolve(root, rel);
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
    if (entry) found.set(id, assetPath(assetsRoot, entry));
  }
  return [...found].map(([id, file]) => ({ id, file }));
};

const textOf = (episode, row, field) =>
  row.lines?.[field] || episode.text?.[String(row.AdvTextID)]?.[field] || "";
const visibleChars = (s) => [...s.replace(/\s/g, "")].length;
const number = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export const episodeToLines = (episode, { id, language = "zh-Hans" }) => {
  const lines = [], pending = { motions: 0, expressions: 0, looks: 0, lookTargets: 0,
    focus: 0, track: 0, zoom: 0, pedestal: 0, panV2: 0, dof: 0, se: 0, bgm: 0, stage: 0,
    ins: 0, outs: 0, onStage: 0 };
  let talkRows = 0, distance = 0, speaker = "", lastCamera = null;
  const on = new Map();
  const commands = Array.isArray(episode.commands) ? episode.commands : [];
  for (const c of commands) {
    if (c.IgnoreData) continue;
    switch (c.cmd) {
      case "Character": on.set(c.TargetName, null); break;
      case "In": on.set(c.TargetName, c.PositionType ?? null); pending.ins++; break;
      case "Out": on.delete(c.TargetName); pending.outs++; break;
      case "MoveToDirection": on.set(c.TargetName, c.PositionType ?? null); break;
      case "Stage": pending.stage++; break;
      case "Focus":
        distance = c.CameraDistance === undefined ? distance : number(c.CameraDistance);
        pending.focus++;
        lastCamera = { kind: "focus", duration: number(c.Duration), value: distance };
        break;
      case "Track": pending.track++; lastCamera = { kind: "track", duration: number(c.Duration), value: number(c.Parameter1) }; break;
      case "Zoom": pending.zoom++; lastCamera = { kind: "zoom", duration: number(c.Duration), value: number(c.Parameter1) }; break;
      case "Pedestal": pending.pedestal++; lastCamera = { kind: "pedestal", duration: number(c.Duration), value: number(c.Parameter1) }; break;
      case "PanV2": pending.panV2++; lastCamera = { kind: "panV2", duration: number(c.Duration), value: number(c.Parameter1) }; break;
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
        speaker = c.TargetName || speaker;
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
```

- [ ] **Step 4: Implement shared metrics**

In `scripts/stories/story-metrics.mjs`, export `summarize(lines)`, `aggregate(summaries)`, `windowsOf(lines, size)`, and `percentile(values, q)`.

```js
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
  for (const l of lines) {
    const last = runs.at(-1);
    if (last && last.speaker === l.speaker) last.length++;
    else runs.push({ speaker: l.speaker, length: 1 });
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
```

- [ ] **Step 5: Run the fixture tests**

Run: `node --test scripts/stories/official-baseline.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 6: Implement the baseline CLI and real-corpus gate**

In `scripts/stories/official-baseline.mjs`, resolve paths from `OURNOTES_OFFICIAL_SITE`, `OURNOTES_OFFICIAL_ASSETS`, `OURNOTES_OFFICIAL_SAMPLE`, and `OURNOTES_AI_LAB`; call `discoverOfficialCorpus`, `readEpisodeAsset`, `episodeToLines`, `summarize`, and `aggregate`; write `official-baseline.json` with `generatedAt`, corpus IDs, per-episode records, `failures`, totals, and an `all` aggregate. Exit code 1 when any episode fails or fewer than 30 IDs are found. Export `BASELINE_EXPECTATIONS` with the checked 30-episode values from the spec: 30 episodes, 5623 commands, 1300 Talk rows, 1158 text lines, 142 blank rows, 516 Focus, 1508 Motion, 362 look rows, 152 Zoom, 122 Pedestal, 95 Track, 24 DoF, 167 PanV2, 147 Se.

Append to `scripts/stories/official-baseline.test.mjs` a corpus-gated test:

```js
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const lab = process.env.OURNOTES_AI_LAB;
const report = lab ? `${lab}/official-baseline.json` : "";
test("30-episode corpus recomputes the checked official totals", { skip: !report || !existsSync(report) }, () => {
  const data = JSON.parse(readFileSync(report, "utf8"));
  assert.deepEqual(data.failures, []);
  assert.equal(data.episodes.length, 30);
  assert.equal(data.totals.talkRows, 1300);
  assert.equal(data.totals.textLines, 1158);
  assert.equal(data.totals.blankTalkRows, 142);
  assert.equal(data.totals.focus, 516);
  assert.equal(data.totals.motion, 1508);
  assert.equal(data.totals.zoom, 152);
  assert.equal(data.totals.pedestal, 122);
  assert.equal(data.totals.panV2, 167);
  assert.equal(data.totals.se, 147);
});
```

- [ ] **Step 7: Wire npm scripts and verify a real baseline**

Modify `package.json` scripts:

```json
"test:stories": "node --test scripts/stories/*.test.mjs",
"baseline:stories": "node scripts/stories/official-baseline.mjs"
```

Run:

```bash
OURNOTES_OFFICIAL_SITE=resources/site \
OURNOTES_OFFICIAL_ASSETS=resources/site/assets \
OURNOTES_OFFICIAL_SAMPLE=output/_official-sample \
OURNOTES_AI_LAB=../ournotes-ai-lab \
npm run baseline:stories
OURNOTES_AI_LAB=../ournotes-ai-lab npm run test:stories
```

Expected: baseline report has `failures: []`, `episodes: 30`, and the checked totals; tests pass or show an explicit skip only for missing external inputs.

- [ ] **Step 8: Commit Task 1**

```bash
git add scripts/stories/official-corpus.mjs scripts/stories/story-metrics.mjs \
  scripts/stories/official-baseline.mjs scripts/stories/official-baseline.test.mjs \
  scripts/stories/fixtures/mini-official-episode.json package.json
git diff --cached --check
git commit -m "feat(stories): add reproducible official-baseline harness"
```

---

## Task 2: Shared official targets and AI prompt budgets

**Files:**
- Create: `host/ai/official-targets.js`
- Create: `host/tests/official-targets.test.mjs`
- Modify: `host/ai/prompt.js:1-12,216-412`
- Modify: `host/ai/staged.js:1-100,266-477,524-640,781-916`
- Modify: `host/ai/storyWriter.js:33-39,105-131,345-551`
- Modify: `host/tests/storyWriter.test.mjs:64-122,239-258,526-591`
- Modify: `docs/story-director.md:19-39,300-379`
- Test: `host/tests/official-targets.test.mjs`, `host/tests/storyWriter.test.mjs`

- [ ] **Step 1: Write failing target and prompt tests**

Add `host/tests/official-targets.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { dialogueBudgetFor, directionBudgetFor, OFFICIAL_TARGETS } from "../ai/official-targets.js";

test("line and character budgets use one 2-minute formula", () => {
  assert.deepEqual(dialogueBudgetFor(2), { lines: 36, chars: 480, minLines: 32, maxLines: 47 });
  assert.deepEqual(dialogueBudgetFor(3), { lines: 54, chars: 720, minLines: 47, maxLines: 70 });
});

test("direction budgets scale with the actual line count", () => {
  const b = directionBudgetFor(40);
  assert.equal(b.focusChanges, 16);
  assert.equal(b.closeUps, 8);
  assert.equal(b.motionMin, 48);
  assert.equal(b.motionMax, 56);
  assert.equal(b.maxStatic, 5);
  assert.equal(b.lookAt, 12);
  assert.equal(b.zoomMin, 2);
  assert.equal(b.zoomMax, 5);
  assert.equal(b.se, 5);
  assert.equal(OFFICIAL_TARGETS.focusPerTalkRow, 0.397);
});
```

Add a test that builds staged messages with 40 lines and asserts `30 部官方样本`, `整条台词常见 1~30 字`, `约 38% 两行`, `Focus 约 0.40/句`, `Pedestal`, `PanV2`, `DoF`, `Look`, `Se`, and the absence of `8 部官方剧情实测`.

- [ ] **Step 2: Run the failing tests**

Run: `node --test host/tests/official-targets.test.mjs`
Expected: FAIL because `official-targets.js` does not exist.

- [ ] **Step 3: Create shared targets**

Create `host/ai/official-targets.js`:

```js
export const OFFICIAL_TARGETS = Object.freeze({
  corpus: { episodes: 30, commands: 5623, talkRows: 1300, textLines: 1158, blankTalkRows: 142 },
  lineCharsMean: 15.541, lineCharsP90: 30, segmentCharsMean: 11.116,
  twoLineShare: 0.3826, threeLineShare: 0.0078, shortShare: 0.2168,
  ellipsisShare: 0.4637, questionShare: 0.2582, exclaimShare: 0.2142,
  speakerRunMean: 1.392, soloRunShare: 0.7284,
  focusPerTalkRow: 0.397, focusPerTextLine: 0.446,
  distance2Share: 0.3892, distance3Share: 0.3608, distance4Share: 0.2038,
  closeRunOneOrTwoShare: 0.7785, motionsPerTextLine: 1.297,
  noMotionShare: 0.0596, twoMotionShare: 0.4473, standaloneExpressionPerEpisode: 0.067,
  lookAnyPerTextLine: 0.313, zoomPerTextLine: 0.131,
  panV2PerTextLine: 0.144, pedestalPerTextLine: 0.105, trackPerTextLine: 0.082,
  dofPerTextLine: 0.021, sePerTextLine: 0.127, bgmPerEpisode: 2.367,
  textLinesPerEpisodeMean: 38.6, textLinesPerEpisodeMin: 32,
  textLinesPerEpisodeMax: 47, charsPerMinute: 240, linesPerMinute: 18,
  focusDurationDefault: 1.5, zoomDurationDefault: 1.5,
});

export const dialogueBudgetFor = (minutes = 2) => {
  const lines = Math.round(minutes * OFFICIAL_TARGETS.linesPerMinute);
  return { lines, chars: Math.round(minutes * OFFICIAL_TARGETS.charsPerMinute),
    minLines: Math.max(12, Math.round(lines * 0.88)), maxLines: Math.round(lines * 1.3) };
};

export const directionBudgetFor = (lineCount) => ({
  focusChanges: Math.max(4, Math.round(lineCount * OFFICIAL_TARGETS.focusPerTalkRow)),
  closeUps: Math.max(1, Math.round(lineCount * OFFICIAL_TARGETS.distance4Share)),
  motionMin: Math.max(2, Math.round(lineCount * 1.2)),
  motionMax: Math.round(lineCount * 1.4),
  maxStatic: Math.max(1, Math.round(lineCount * 0.09)),
  lookAt: Math.max(2, Math.round(lineCount * OFFICIAL_TARGETS.lookAnyPerTextLine)),
  zoomMin: 2, zoomMax: Math.min(6, Math.max(2, Math.round(lineCount * 0.1))),
  pedestal: Math.max(1, Math.round(lineCount * 0.1)),
  panV2: Math.max(1, Math.round(lineCount * 0.12)),
  dof: Math.max(0, Math.round(lineCount * 0.02)),
  se: Math.max(1, Math.round(lineCount * 0.12)),
});
```

- [ ] **Step 4: Replace prompt constants with target imports**

In `host/ai/prompt.js`, `host/ai/staged.js`, and `host/ai/storyWriter.js`, import `OFFICIAL_TARGETS`, `dialogueBudgetFor`, and `directionBudgetFor`. Replace `lineBudgetFor`, `minDialogueLines`, `minDialogueChars`, `focusChanges`, `cameraChanges`, `closeUps`, `zoomBudget`, `lookAtBudget`, `motionBudget`, `noMotion`, `twoMotion`, and `staticLineBudget` with calls into `directionBudgetFor(lines.length)`.

Specific replacements:
- `staged.js:41`: `lineBudgetFor` returns `dialogueBudgetFor(minutes).lines`; cap by configured `maxLines` only after this call.
- `storyWriter.js:410-454`: set `const budget = dialogueBudgetFor(targetMinutes)`, `minDialogueLines = budget.minLines`, `minDialogueChars = budget.chars`; require both bounds; expand at most twice; stop when `lines >= minLines && chars >= minChars`.
- `staged.js:546-553`: replace all hard-coded direction budgets with `directionBudgetFor(lineCount)`.
- `staged.js:877-898`: replace `maxDirected = ceil(0.9*says.length)` with a total-performance-action check using `motionBudget` and `maxStatic`; count `say.motion`, `say.expression`, `actions[].motion`, and `actions[].expression`, not only `motion||expression`.
- `prompt.js:3,337-343`: correct provenance and text stats; use `OFFICIAL_TARGETS` values rather than duplicated literals.
- `staged.js:335-345`: replace the contradictory `1~6 lines/turn` plus `至少 2 个 6 条以上` with `约 73% 单句 turn、均值 1.4 句；短反应约 22%；整条台词均值 15.5 字、p90 30 字；换行片段均值 11.1 字`.

- [ ] **Step 5: Extend storyboard fields and normalization**

Add `focusDuration`, `trackDuration`, `pedestal`, `pedestalDuration`, `pan`, `panDuration`, `panFocusSlide`, `dof`, `dofDuration`, `dofLayers`, `look`, `lookY`, `lookDuration`, `se`, `seDuration`, `seDelay`, `seStop`, `motionFadeIn`, and `motionWait` to the storyboard allow-list in `staged.js`, the few-shot/example in `prompt.js`, and `normalize()` in `storyWriter.js:105-131`. Add `host/pipeline.js` persistence of `stages`, `plan`, `dialogue`, and `usage` in the job result and `<jobId>.story.json` diagnostics without changing existing API fields.

- [ ] **Step 6: Update tests and run host AI tests**

Update `host/tests/storyWriter.test.mjs` regexes and budget assertions to the new strings/numbers. Keep tests for three-call staged flow, one dialogue retry, verbatim dialogue, bare fallback, and persona trimming; replace `staticLineBudget` with `performanceBudget`.

Run: `npm run test:host -- --test-name-pattern="staged|official|length|budget|prompt"`
Expected: PASS; no test still asserts `0.28`, `0.9L`, `min(5, L/8)`, or `ceil(0.9*N)` as a desired target.

- [ ] **Step 7: Update docs and lint**

Correct `docs/story-director.md:19-39` provenance/denominators; update `:310-320,342-379` budgets to shared-target language. Run `npm run lint`.

- [ ] **Step 8: Commit Task 2**

```bash
git add host/ai/official-targets.js host/ai/prompt.js host/ai/staged.js \
  host/ai/storyWriter.js host/pipeline.js host/tests/official-targets.test.mjs \
  host/tests/storyWriter.test.mjs docs/story-director.md
git diff --cached --check
git commit -m "feat(ai): derive story budgets from official corpus targets"
```

---

## Task 3: Story-script parser, checker, compiler, and sound closure

**Files:**
- Modify: `scripts/lib/story-author/script.js:31-74,398-408,444-503,529-683,687-818,827-1069`
- Modify: `scripts/lib/story-author/site.js:292-303`
- Modify: `host/tools/site-story.mjs:105-159,162-255`
- Modify: `host/story/catalog.js:184-206`
- Modify: `schema/episode.schema.json:182-336`
- Modify: `tests/unit/story-author.test.mjs:112-513,623-675`
- Modify: `tests/unit/json-schema.test.mjs:52-56`
- Modify: `docs/story-author.md:192-300`
- Test: `tests/unit/story-author.test.mjs`, `tests/unit/json-schema.test.mjs`

- [ ] **Step 1: Write failing parser/compiler tests**

Append exact assertions to `tests/unit/story-author.test.mjs`:

```js
test("official camera and sound fields parse with bounded ranges", () => {
  const { script, errors } = parseScript({
    format: "ournotes.story-script/1", base: "stories/10610.json", cast: { a: { model: "m", name: "A" } },
    beats: [
      { scene: "stage_a", positions: { a: "center" } },
      { say: "a", text: "……", zoom: 1.2, zoomDuration: 1.5, pedestal: -0.2,
        pedestalDuration: 1.5, pan: -5, panDuration: 1.5, dof: 0.5,
        look: 0.3, lookY: -0.3, se: "sound_se_door", seDuration: 0.7 },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(script.beats[1].zoom, 1.2);
  assert.equal(script.beats[1].pan, -5);
  assert.equal(script.beats[1].se, "sound_se_door");
});

test("out-of-range and mutually exclusive official fields fail", () => {
  const { errors } = parseScript({
    format: "ournotes.story-script/1", base: "stories/10610.json", cast: {},
    beats: [{ camera: "middle", zoom: 3, look: 0.3, lookAt: 5, seStop: true, se: "sound_se_door" }],
  });
  assert.ok(errors.some((e) => e.code === "range"));
  assert.ok(errors.some((e) => e.code === "exclusive"));
});
```

Add a compiler test that supplies `musicChoices` plus `soundChoices` in the fake `site`, parses the same script, calls `compileScript`, and asserts:

```js
const rows = compiled.episode.commands;
assert.ok(rows.some((r) => r.cmd === "Zoom" && r.Parameter1 === "1.2" && r.Duration === 1.5));
assert.ok(rows.some((r) => r.cmd === "Pedestal" && r.Parameter1 === "-0.2" && r.Duration === 1.5));
assert.ok(rows.some((r) => r.cmd === "PanV2" && r.Parameter1 === "-5"));
assert.ok(rows.some((r) => r.cmd === "DoF" && r.Parameter1 === "0.5"));
assert.ok(rows.some((r) => r.cmd === "Look" && r.Parameter1 === "0.3" && r.Parameter2 === "-0.3"));
const se = rows.find((r) => r.cmd === "Se");
assert.ok(se?.SeID);
assert.ok(compiled.episode.sounds[se.SeID]);
assert.ok(compiled.episode.cuesheets[compiled.episode.sounds[se.SeID]._soundCueSheetID]);
assert.ok(compiled.story.parts.sounds[compiled.episode.cuesheets[compiled.episode.sounds[se.SeID]._soundCueSheetID]._cueSheetName]);
assert.equal(compiled.episode.commandCount, rows.length);
assert.ok(rows.every((r, i) => r.i === i && Number.isInteger(r.raw) && r.raw >= 0));
```

- [ ] **Step 2: Run failing tests**

Run: `node --test tests/unit/story-author.test.mjs`
Expected: FAIL with `unknownKey` for new fields and missing command rows.

- [ ] **Step 3: Extend constants and BEAT_KEYS**

In `scripts/lib/story-author/script.js`, add exported ranges `ZOOM_MIN=0.7`, `ZOOM_MAX=2.5`, `PEDESTAL_MIN=-4`, `PEDESTAL_MAX=5`, `PAN_MIN=-30`, `PAN_MAX=30`, `LOOK_MIN=-1`, `LOOK_MAX=1`, `OFFICIAL_DURATION_MAX=20`, `DEFAULT_OFFICIAL_DURATION=1.5`. Add all new keys from the spec to `BEAT_KEYS.say`, `narrate`, `camera`, `action`, and `scene`; keep old `camera.duration`.

- [ ] **Step 4: Extend parser**

Add `numberOf` calls for the new fields to `parseScript`. Validate:
- `look` and `lookAt` are mutually exclusive (`exclusive` error).
- `se` and `seStop` are mutually exclusive; `seDuration`/`seDelay` require `se`.
- `panFocusSlide` requires `pan`; `dofLayers` requires `dof`; `pedestalDuration` requires `pedestal`.
- `motionFadeIn` is `-1..2`; `motionWait` is a boolean.
- Existing `zoom` becomes `0.7..2.5`, `zoomDuration` becomes `0.2..20`.
- `duration` on a camera beat aliases `cameraDuration`; when both exist, keep `cameraDuration` and add a `conflict` warning.

Preserve every parsed field on the beat object so `compileScript` can emit it.

- [ ] **Step 5: Extend checker and sound catalog**

In `script.js` add `soundChoices(episode, story)` next to `musicChoices`: select `sound_se*` sheets with `audio[name]`, returning `{cue,label,sound,sheet}`. Add `site.sounds` to `checkScript`, and report `unknownSe` with the available cue names when `beat.se` is absent. Validate `dofLayers` is `0`, `2`, or absent.

In `host/tools/site-story.mjs` and `host/story/catalog.js`, build a `sounds` list with the same function and pass it into `checkScript`/`compileScript`; keep `music` unchanged. In `Site.compose`, include SE sheet entries in `story.parts.sounds` from the compiled episode closure.

- [ ] **Step 6: Extend compileScript**

After `cameraRows(b, ...)`, add deterministic row emitters:

```js
const durationOf = (b, own, fallback) => b[own] ?? b.cameraDuration ?? b.duration ?? fallback;
const pedestalRow = (b) => {
  if (b.pedestal === undefined) return;
  row("Pedestal", { Parameter1: String(b.pedestal), Duration: durationOf(b, "pedestalDuration", DEFAULT_OFFICIAL_DURATION), IsNoWait: 1 });
};
const panRow = (b) => {
  if (b.pan === undefined) return;
  const fields = { Parameter1: String(b.pan), Duration: durationOf(b, "panDuration", DEFAULT_OFFICIAL_DURATION), IsNoWait: 1 };
  if (b.panFocusSlide !== undefined) fields.Parameter3 = String(b.panFocusSlide);
  row("PanV2", fields);
};
const dofRow = (b) => {
  if (b.dof === undefined) return;
  const fields = { Parameter1: String(b.dof), Duration: durationOf(b, "dofDuration", DEFAULT_OFFICIAL_DURATION), IsNoWait: 1 };
  if (b.dofLayers !== undefined) fields.CanvasLayers = b.dofLayers;
  row("DoF", fields);
};
const lookRow = (b, target) => {
  if (b.look === undefined) return;
  const fields = { TargetName: target, Parameter1: String(b.look), Parameter2: String(b.lookY ?? 0),
    Duration: durationOf(b, "lookDuration", 0.5), IsNoWait: 1 };
  row("Look", fields);
};
const seRow = (b) => {
  if (!b.se && !b.seStop) return;
  const sound = b.se ? new Map(site.sounds.map((s) => [s.cue, s])).get(b.se) : null;
  if (b.se && !sound) throw new Error(`unknown SE cue ${b.se}`);
  const fields = b.seStop ? { Parameter1: "Stop" } : { SeID: sound.sound };
  if (b.seDuration !== undefined) fields.Duration = b.seDuration;
  if (b.seDelay !== undefined) fields.DelaySeconds = b.seDelay;
  row("Se", fields);
};
```

Call `pedestalRow/panRow/dofRow/zoomRow/seRow` for say, narrate, camera, scene, and action beats in that order; call `lookRow` where a target cast id is known. Make `zoomRow` use `b.zoomDuration ?? b.cameraDuration ?? b.duration ?? DEFAULT_OFFICIAL_DURATION`. Pass `focusDuration`/`trackDuration`/`cameraDuration` into `cameraRows` as explicit duration overrides. Add `MotionFadeIn` and `MotionWait` to row fields when specified.

Extend the final sound closure loop to include both `Bgm` and `Se` rows with IDs:

```js
for (const r of rows) {
  if ((r.cmd !== "Bgm" && r.cmd !== "Se") || !Number(r[r.cmd === "Bgm" ? "BgmID" : "SeID"])) continue;
  const id = r.cmd === "Bgm" ? r.BgmID : r.SeID;
  const s = base.episode.sounds[id], sheet = base.episode.cuesheets[s._soundCueSheetID];
  sounds[id] = s;
  cuesheets[s._soundCueSheetID] = sheet;
  story.parts.sounds[sheet._cueSheetName] = base.story.parts.sounds[sheet._cueSheetName];
}
```

- [ ] **Step 7: Extend schema and docs**

Add top-level `MotionFadeIn` (number), `MotionWait` (boolean), `CanvasLayers` (array of integers), and `TargetTextColors` (array of strings) to `schema/episode.schema.json` command properties. Document every new beat field and its compiled ADV row in `docs/story-author.md`; replace the `docs/story-director.md:414` blanket exclusion with the verified command white-list.

- [ ] **Step 8: Run parser, schema, and host tests**

Run:

```bash
node --test tests/unit/story-author.test.mjs tests/unit/json-schema.test.mjs
npm test
npm run test:host
npm run lint
```

Expected: all PASS, including the exact command-row and SE-closure assertions.

- [ ] **Step 9: Commit Task 3**

```bash
git add scripts/lib/story-author/script.js scripts/lib/story-author/site.js \
  host/tools/site-story.mjs host/story/catalog.js schema/episode.schema.json \
  tests/unit/story-author.test.mjs tests/unit/json-schema.test.mjs \
  docs/story-author.md docs/story-director.md
git diff --cached --check
git commit -m "feat(story-author): compile official camera, look, motion and SE commands"
```

---

## Task 4: Fixed-scene AI evaluation, quality gate, and command audit

**Files:**
- Create: `scripts/stories/ai-eval.mjs`
- Create: `scripts/stories/compiled-command-audit.mjs`
- Create: `scripts/stories/ai-quality.test.mjs`
- Create: `scripts/stories/compiled-command-audit.test.mjs`
- Modify: `package.json:23-34`
- Modify: `docs/host.md:347-450`
- Test: `scripts/stories/ai-quality.test.mjs`, `scripts/stories/compiled-command-audit.test.mjs`

- [ ] **Step 1: Write the quality-gate test first**

Create `scripts/stories/ai-quality.test.mjs` with:
- `const reportPath = process.env.OURNOTES_EVAL_REPORT`;
- `test(..., { skip: !reportPath || !existsSync(reportPath) }, ...)`;
- assert `results.length >= 6`, every result has `!error`, `summary.count >= 28`, `summary.charsTotal >= 400`, `warnings` exists, and `compiled.commands` exists;
- aggregate ranges: `charsMean 12..19`, `twoLineShare 0.25..0.50`, `shortShare 0.12..0.30`, `soloRunShare 0.58..0.82`, `focusPerLine 0.30..0.50`, `motionsPerLine 1.0..1.5`, `lookAnyPerLine 0.20..0.42`, `zoomPerLine 0.03..0.16`, `pedestalPerLine 0.04..0.15`, `panV2PerLine 0.05..0.18`, `sePerLine 0.04..0.16`;
- at least one compiled command of each new type across all results.

- [ ] **Step 2: Write the command-audit test first**

Create `scripts/stories/compiled-command-audit.test.mjs` that imports `auditCompiledStory` and feeds the Task 1 mini episode plus a compiled story object. Assert:
- all `cmd` values are in `ADV_COMMAND`;
- `i` is contiguous, `raw >= 0`, `commandCount === commands.length`;
- every `Se.SeID` resolves through `sounds -> cuesheets -> story.parts.sounds`;
- `requires.commands` and `story.commands` equal the sorted unique command list;
- `HostActions` are absent or contain no `LookTargetPosition`.

- [ ] **Step 3: Run the failing tests**

Run: `node --test scripts/stories/ai-quality.test.mjs scripts/stories/compiled-command-audit.test.mjs`
Expected: command-audit test FAILS for missing module; quality test SKIPS with an explicit missing-report reason.

- [ ] **Step 4: Implement the command audit**

In `scripts/stories/compiled-command-audit.mjs`, export `auditCompiledStory({episode, story, script})`; return `{commands, counts, parameters, failures, resourceClosure}`. Use `ADV_COMMAND` from `src/story/interfaces.js`; check row indices/raw, known command names, numeric `Parameter1` ranges for Zoom/Pedestal/PanV2/DoF/Look, `Se` closure, and `HostActions` look restrictions. Add `auditGeneratedScriptToMetrics(compiled, script)` converting generated beats into the same `line` records used by `story-metrics.mjs`.

- [ ] **Step 5: Implement fixed-scene AI evaluation**

In `scripts/stories/ai-eval.mjs`:
- define exactly 8 hard-coded two-character scenes with labels and Chinese loglines;
- parse `--run`, `--prompts`, `--pipeline`, `--temperature`, `--target`, `--runs`;
- load `host/config.js` via `loadConfig`, override `pipeline`, `targetMinutes: 2`, `repairRounds: 2`, `translateForTts: false`, `jsonMode: "auto"`, `maxTokens: 16384`, `timeoutMs: 180000`;
- instantiate `LLMClient` and `StoryWriter` from `host/ai/llm.js` and `host/ai/storyWriter.js`;
- call `writer.generateScript` once per selected scene, catch and record errors without aborting the run;
- call `parseScript`, `checkScript`, and `compileScript` with the configured site catalog; call `auditCompiledStory` and `summarize` on generated lines;
- write `runs/<run>/<label>.story.json`, `<label>.report.json`, `all-stories.json`, and `report.json` with `generatedAt`, config (redact API key), per-result latency/usage/warnings/summary/compiled counts, successful-only aggregate, and failures.

- [ ] **Step 6: Wire npm scripts and docs**

Add:

```json
"eval:stories": "node scripts/stories/ai-eval.mjs",
"audit:stories": "node scripts/stories/compiled-command-audit.mjs"
```

Document fixed-scene runs, `OURNOTES_EVAL_REPORT`, and the skip behavior in `docs/host.md`.

- [ ] **Step 7: Run a real evaluation and gate**

Run:

```bash
npm run eval:stories -- --run phase1 --pipeline staged --temperature 0.8
OURNOTES_EVAL_REPORT=../ournotes-ai-lab/runs/phase1/report.json npm run test:stories
```

Expected: at least 6 successful scenes, `report.json` with nonzero new-command counts, and the quality gate PASS. If any range fails, tune only the prompt/budget emission and rerun; do not widen the gate to admit a failed run.

- [ ] **Step 8: Commit Task 4**

```bash
git add scripts/stories/ai-eval.mjs scripts/stories/compiled-command-audit.mjs \
  scripts/stories/ai-quality.test.mjs scripts/stories/compiled-command-audit.test.mjs \
  package.json docs/host.md
git diff --cached --check
git commit -m "feat(stories): add fixed-scene AI evaluation and command gates"
```

---

## Task 5: Real render and ffmpeg frame audit

**Files:**
- Create: `scripts/stories/frame-audit.mjs`
- Create: `scripts/stories/frame-audit.test.mjs`
- Create: `scripts/stories/fixtures/frame-report.json`
- Modify: `package.json:23-34`
- Modify: `host/tests/e2e-director.test.mjs:23-64`
- Test: `scripts/stories/frame-audit.test.mjs`, `host/tests/e2e-director.test.mjs`

- [ ] **Step 1: Write the frame-report fixture and failing test**

Create `scripts/stories/fixtures/frame-report.json` with a synthetic report containing two `checks`, each with `before`, `after`, `meanAbsoluteDifference`, and `changed: true`.

Create `scripts/stories/frame-audit.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateFrameReport } from "./frame-audit.mjs";

test("frame report needs real extracted frames and visible changes", () => {
  const report = JSON.parse(readFileSync(new URL("./fixtures/frame-report.json", import.meta.url)));
  assert.deepEqual(validateFrameReport(report), []);
  const broken = structuredClone(report);
  broken.checks[0].changed = false;
  broken.checks[0].before = "";
  assert.ok(validateFrameReport(broken).length >= 2);
});
```

- [ ] **Step 2: Run the failing test**

Run: `node --test scripts/stories/frame-audit.test.mjs`
Expected: FAIL because `frame-audit.mjs` does not exist.

- [ ] **Step 3: Implement timeline and frame extraction**

In `scripts/stories/frame-audit.mjs`, export `validateFrameReport`, `frameCheckpoints(episode, timeline)`, `frameTarget`, `duplicateFramePairs`, and CLI `main`:
- parse `--video`, `--episode`, `--timeline`, `--out`, `--ffmpeg`, `--require-camera`;
- the renderer writes `<job>.timeline.json` from the StorySession `onCommand` clock (shifted to video time by the first captured frame); checkpoints come only from that timeline, never from a second `blockingSeconds`/duration model;
- skip the settle with `beforeSeconds >= settleSeconds`, prefer a non-zero-duration camera move, include `Track`/`LookTarget`, cap the after window at the next command start, mark `Se` `visual:false` (audio-only), and record overlapping visual rows as `confounds`;
- probe width/height/duration/fps with the pinned ffmpeg (`-i` stderr), record its version and binary sha256; no external ffprobe requirement;
- extract full-resolution PNGs with `spawnSync`; near the end seek on the output (`-i ... -ss ...`) so the frame is exact; compare 160×90 gray frames and set `changed = meanAbsoluteDifference > 1.0`;
- write `frame-report.json` with relative video/episode/timeline paths, sha256, command counts, method threshold/windows, every checkpoint's `i`, `cmd`, `commandSeconds`, effect `seconds`, before/after PNG paths + sha256, difference, `changed`, `visual`, `confounds`, `lowerBound`/`clamped`/`afterCapped` flags, duplicate pairs, and `failures`.

`validateFrameReport` must return failures for zero checks, missing/unsafe frame paths, missing hashes or difference values, a `changed` flag inconsistent with the difference, missing video/episode/timeline provenance, any ffmpeg failure, a `frameFailure`, duplicate camera frame pairs, `Se` marked visual, a non-visual camera check, or (with `--require-camera`) no visual camera checkpoint.

- [ ] **Step 4: Extend e2e director test**

In `host/tests/e2e-director.test.mjs`, after the existing site-engine render assertion, add a gated step that writes the generated episode next to the MP4, passes the renderer's `<job>.timeline.json`, and invokes the frame-audit CLI with `--timeline` and `--require-camera` when `OURNOTES_FRAME_AUDIT=1`. Keep the existing `OURNOTES_E2E_SITE`, `OURNOTES_E2E_CORE`, and `OURNOTES_E2E_DIRECTOR_BASE` skip guards. Give `spawnSync` a timeout and assert zero failures, an empty duplicate list, the video/timeline/episode sha256 and command count, and at least one visual camera checkpoint after the settle and after a real line time.

- [ ] **Step 5: Wire npm script**

Add:

```json
"audit:frames": "node scripts/stories/frame-audit.mjs"
```

- [ ] **Step 6: Run unit and real frame audit**

Run:

```bash
node --test scripts/stories/frame-audit.test.mjs
OURNOTES_E2E_CORE=1 OURNOTES_E2E_SITE=resources/site \
OURNOTES_E2E_DIRECTOR_BASE=stories/10610.json OURNOTES_FRAME_AUDIT=1 \
npm run test:host -- --test-name-pattern="director"
npm run audit:frames -- --video ../ournotes-ai-lab/frame-check.mp4 \
  --episode ../ournotes-ai-lab/frame-check.episode.json \
  --timeline ../ournotes-ai-lab/frame-check.timeline.json \
  --out ../ournotes-ai-lab/frames --require-camera
```

Expected: frame-report has zero failures, at least one visual `Focus`, `Zoom`, `Pedestal`, `PanV2`, `DoF`, or `Track` checkpoint, and all referenced PNGs exist with nonzero difference. `Se` is marked `visual:false`; overlapping rows are listed in `confounds`, not claimed as isolated evidence. If browser/core/ffmpeg is unavailable, record the exact skip reason as an unfinished acceptance item; do not replace it with a synthetic report.

- [ ] **Step 7: Commit Task 5**

```bash
git add scripts/stories/frame-audit.mjs scripts/stories/frame-audit.test.mjs \
  scripts/stories/fixtures/frame-report.json host/tests/e2e-director.test.mjs package.json
git diff --cached --check
git commit -m "feat(stories): audit rendered frames against compiled commands"
```

---

## Task 6: Full verification, sync design/plan state, and final evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-11-10-official-script-harness-design.md` only if measured values require a correction.
- Test: full suite and real reports.

- [ ] **Step 1: Confirm worktree isolation**

Run:

```bash
git status --short
git diff --cached --name-only
git diff --name-only
```

Expected: only this task's staged files; the original 23 modified files remain unstaged and unchanged by this work.

- [ ] **Step 2: Run the complete verification matrix**

Run and retain output:

```bash
npm test
npm run test:host
npm run lint
OURNOTES_AI_LAB=../ournotes-ai-lab npm run baseline:stories
OURNOTES_AI_LAB=../ournotes-ai-lab \
OURNOTES_EVAL_REPORT=../ournotes-ai-lab/runs/phase1/report.json \
npm run test:stories
npm run eval:stories -- --run final --pipeline staged --temperature 0.8
npm run audit:frames -- --video ../ournotes-ai-lab/final.mp4 \
  --episode ../ournotes-ai-lab/final.episode.json \
  --timeline ../ournotes-ai-lab/final.timeline.json \
  --out ../ournotes-ai-lab/final-frames --require-camera
```

Expected: all available gates PASS; any skipped external gate has a clear reason and is listed as evidence, not counted as a visual pass.

- [ ] **Step 3: Build the prompt-to-artifact evidence table**

Create `../ournotes-ai-lab/final-evidence.json` mapping:
- official corpus numbers -> `official-baseline.json`;
- prompt/budget values -> `host/ai/official-targets.js` and `ai-quality.test.mjs`;
- every new command -> exact compiled episode row and frame PNG;
- every test/gate -> command and output path;
- user-approved scope and spec -> `033bd50`;
- commit hashes for Tasks 1-5;
- pre-existing 23 files -> `git status --short` snapshot.

- [ ] **Step 4: Commit only final doc corrections**

If the spec needs numeric corrections, edit it and run:

```bash
git add docs/superpowers/specs/2026-11-10-official-script-harness-design.md
git diff --cached --check
git commit -m "docs(stories): sync official-target spec with measurements"
```

Otherwise make no commit.

- [ ] **Step 5: Report completion truthfully**

Report: commits, exact test results, baseline/eval/frame report paths, whether real e2e and frame extraction ran, any skipped or failed external gate, and confirmation that no push occurred. Do not claim completion if the frame evidence or any required test is missing.

---

## Self-review coverage

- Spec §1: Tasks 1, 4, 5, and 6 cover reproducible statistics, generation reports, compiler checks, and frame evidence.
- Spec §2: Task 1 encodes denominators and measured values; Task 2 consumes them from one source.
- Spec §3: Tasks 1-5 create every named module and preserve reports outside git.
- Spec §4: Task 3 implements every new field, range, row type, sound closure, and compatibility rule; Task 4 audits it.
- Spec §5: Task 2 replaces competing budgets and corrects prompt/docs; Task 4 gates generated distributions.
- Spec §6: Tasks 1, 4, 5, and 6 specify deterministic failures, skip semantics, and worktree isolation.
- Spec §7: Task 6 lists every required verification command and evidence artifact.
- Spec §8: no task changes TTS, site-engine version, all 46 commands, or remote state.
- Spec §9: Task order matches the implementation sequence.
