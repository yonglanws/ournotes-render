// Shared official targets and AI prompt budgets.
//
// The measured values live in exactly one place: the checked 30-episode
// adapter in scripts/stories/official-baseline.mjs. This module re-exports
// them and derives the line/character and direction budgets both the single
// and the staged pipelines use, so prompt.js, staged.js and storyWriter.js
// cannot drift into separate thresholds again.
import { OFFICIAL_TARGETS } from "../../scripts/stories/official-baseline.mjs";

export { OFFICIAL_TARGETS };

// Fixed evaluation floors for one generated pair scene. The class has a
// 338.8-character mean and 372-character median per pair scene in the checked
// official sample; 300 is deliberately below that official mean. The line floor
// keeps the 32-line official minimum with a small tolerance.
export const FIXED_MIN_LINES = 28;
export const FIXED_MIN_CHARS = 300;

const CHECKED_MIN_LINE_FLOOR = 12;
const LINES_TOLERANCE = 0.88;
const LINES_ABOVE_TARGET = 1.3;
// 0.88 of a 54-line three-minute target rounds to 48, one line above the
// longest checked official episode (47 text lines). Anchor the required lower
// bound to that checked per-episode maximum for targets near the official
// range, while longer requests still scale down as (target - 7).
const MIN_LINES_SHORTFALL = 7;

// Direction-count policy floors/caps. The rates themselves are measured
// (OFFICIAL_TARGETS); these numbers keep tiny scenes from requesting more
// camera/gaze/sound rows than they have dialogue lines. Motion rows are not
// capped to the line count because one line can carry a speaker and a listener
// performance row.
const FOCUS_FLOOR = 4;
const CLOSE_FLOOR = 1;
const LOOK_FLOOR = 2;
const ZOOM_POLICY_MIN = 2;
const ZOOM_POLICY_MAX = 6;
const MOTION_MIN_PER_LINE = 1.2;
const MOTION_MAX_PER_LINE = 1.4;
// Official no-Motion share is ~6%; 12% is a policy cap for pruning extreme
// over-acting, not a target for normal scenes.
const STATIC_POLICY_SHARE = 0.12;
const PEDESTAL_FLOOR = 1;
const PAN_V2_FLOOR = 1;
const SE_FLOOR = 1;
const TRACK_FLOOR = 1;

export const dialogueBudgetFor = (minutes = 2) => {
  const requested = Number(minutes);
  const targetMinutes = Number.isFinite(requested) && requested > 0 ? requested : 2;
  const lines = Math.round(targetMinutes * OFFICIAL_TARGETS.linesPerMinute);
  const maxLines = Math.max(1, Math.round(lines * LINES_ABOVE_TARGET));
  const rawMinLines = Math.max(CHECKED_MIN_LINE_FLOOR, Math.round(lines * LINES_TOLERANCE));
  const minCap = Math.max(OFFICIAL_TARGETS.textLinesPerEpisodeMax, lines - MIN_LINES_SHORTFALL);
  // Very short targets (below the pipeline's 0.5-minute floor) must still get
  // a coherent range: clamp the minimum to maxLines rather than returning
  // minLines > maxLines. The pipeline rejects targetMinutes < 0.5.
  return {
    lines,
    chars: Math.round(targetMinutes * OFFICIAL_TARGETS.charsPerMinute),
    minLines: Math.max(1, Math.min(maxLines, rawMinLines, minCap)),
    maxLines,
  };
};

// Text-bearing lines are the input denominator: generated scripts never emit
// blank Talk rows, so focus/close rates use the text-line checked values
// (focusPerTextLine 0.446, distance4TextLineShare 0.2288) instead of the
// all-Talk-row rates (focusPerTalkRow 0.397, distance4Share 0.2038). The
// prompt states both denominators.
// One range formatter for prompts: a small-scene floor never prints "2~1".
export const budgetCount = (minimum, maximum) => {
  const cap = Math.max(0, Math.round(Number(maximum) || 0));
  const floor = Math.max(0, Math.min(Math.round(Number(minimum) || 0), cap));
  return floor === cap ? String(cap) : `${floor}~${cap}`;
};

export const directionBudgetFor = (lineCount) => {
  const requested = Number(lineCount);
  const lines = Number.isFinite(requested) && requested > 0 ? Math.max(1, Math.floor(requested)) : 1;
  const count = (value, min = 1) => Math.min(lines, Math.max(min, value));
  const motionMin = Math.max(2, Math.round(lines * MOTION_MIN_PER_LINE));
  const zoomMin = Math.min(lines, ZOOM_POLICY_MIN);
  const zoomMax = Math.min(lines, ZOOM_POLICY_MAX,
    Math.max(zoomMin, Math.round(lines * OFFICIAL_TARGETS.zoomPerTextLine)));
  return {
    lines,
    focusChanges: count(Math.round(lines * OFFICIAL_TARGETS.focusPerTextLine), FOCUS_FLOOR),
    closeUps: count(Math.round(lines * OFFICIAL_TARGETS.distance4TextLineShare), CLOSE_FLOOR),
    motionMin,
    // Official mean is 1.297 Motion per text line; 1.2~1.4 is the target band.
    motionMax: Math.max(motionMin, Math.round(lines * MOTION_MAX_PER_LINE)),
    maxStatic: count(Math.round(lines * STATIC_POLICY_SHARE), 1),
    lookAt: Math.min(lines, Math.max(LOOK_FLOOR, Math.floor(lines * OFFICIAL_TARGETS.lookAnyPerTextLine))),
    zoomMin,
    zoomMax,
    pedestal: count(Math.round(lines * OFFICIAL_TARGETS.pedestalPerTextLine), PEDESTAL_FLOOR),
    panV2: count(Math.round(lines * OFFICIAL_TARGETS.panV2PerTextLine), PAN_V2_FLOOR),
    dof: Math.min(lines, Math.max(0, Math.round(lines * OFFICIAL_TARGETS.dofPerTextLine))),
    se: count(Math.round(lines * OFFICIAL_TARGETS.sePerTextLine), SE_FLOOR),
    track: count(Math.round(lines * OFFICIAL_TARGETS.trackPerTextLine), TRACK_FLOOR),
  };
};

// The official Look + LookTarget rate is one total gaze budget. Independent
// look/lookY offsets are a channel inside that total, not extra rows, and the
// merge path enforces the same total. Keeping both prompt channels on this
// helper prevents them from asking for lookAt + look separately.
export const gazeBudgetFor = (budget = {}) => {
  const total = Math.max(0, Math.round(Number(budget.lookAt) || 0));
  return { total, independentMax: Math.min(2, total) };
};
