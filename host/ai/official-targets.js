// Shared official targets and AI prompt budgets.
//
// The measured values live in exactly one place: the checked 30-episode
// adapter in scripts/stories/official-baseline.mjs. This module re-exports
// them and derives the line/character and direction budgets both the single
// and the staged pipelines use, so prompt.js, staged.js and storyWriter.js
// cannot drift into separate thresholds again.
import { OFFICIAL_TARGETS } from "../../scripts/stories/official-baseline.mjs";

export { OFFICIAL_TARGETS };

const CHECKED_MIN_LINE_FLOOR = 12;
const LINES_TOLERANCE = 0.88;
const LINES_ABOVE_TARGET = 1.3;
// 0.88 of a 54-line three-minute target rounds to 48, one line above the
// longest checked official episode (47 text lines). Anchor the required lower
// bound to that checked per-episode maximum for targets near the official
// range, while longer requests still scale down as (target - 7).
const MIN_LINES_SHORTFALL = 7;

export const dialogueBudgetFor = (minutes = 2) => {
  const requested = Number(minutes);
  const targetMinutes = Number.isFinite(requested) && requested > 0 ? requested : 2;
  const lines = Math.round(targetMinutes * OFFICIAL_TARGETS.linesPerMinute);
  const rawMinLines = Math.max(CHECKED_MIN_LINE_FLOOR, Math.round(lines * LINES_TOLERANCE));
  return {
    lines,
    chars: Math.round(targetMinutes * OFFICIAL_TARGETS.charsPerMinute),
    minLines: Math.min(rawMinLines,
      Math.max(OFFICIAL_TARGETS.textLinesPerEpisodeMax, lines - MIN_LINES_SHORTFALL)),
    maxLines: Math.round(lines * LINES_ABOVE_TARGET),
  };
};

// Every rate below is a checked official rate (or a documented policy bound
// around one); no field is a renamed copy of an old prompt constant.
export const directionBudgetFor = (lineCount) => {
  const requested = Number(lineCount);
  const lines = Number.isFinite(requested) && requested > 0 ? requested : 1;
  const motionMin = Math.max(2, Math.round(lines * 1.2));
  return {
    lines,
    focusChanges: Math.max(4, Math.round(lines * OFFICIAL_TARGETS.focusPerTalkRow)),
    closeUps: Math.max(1, Math.round(lines * OFFICIAL_TARGETS.distance4Share)),
    motionMin,
    // Official mean is 1.297 Motion per text line; 1.2~1.4 is the target band.
    motionMax: Math.max(motionMin, Math.round(lines * 1.4)),
    // Official no-action share is 0.0596; 0.12 is a policy upper bound that
    // only prunes extreme over-acting, not the normal still-line share.
    maxStatic: Math.max(1, Math.round(lines * 0.12)),
    lookAt: Math.max(2, Math.floor(lines * OFFICIAL_TARGETS.lookAnyPerTextLine)),
    zoomMin: 2,
    zoomMax: Math.min(6, Math.max(2, Math.round(lines * OFFICIAL_TARGETS.zoomPerTextLine))),
    pedestal: Math.max(1, Math.round(lines * OFFICIAL_TARGETS.pedestalPerTextLine)),
    panV2: Math.max(1, Math.round(lines * OFFICIAL_TARGETS.panV2PerTextLine)),
    dof: Math.max(0, Math.round(lines * OFFICIAL_TARGETS.dofPerTextLine)),
    se: Math.max(1, Math.round(lines * OFFICIAL_TARGETS.sePerTextLine)),
    track: Math.max(1, Math.round(lines * OFFICIAL_TARGETS.trackPerTextLine)),
  };
};
