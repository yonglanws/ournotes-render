// Story script grammar constants, beat schemas, and pure cinematography/blocking helpers.

export const SCRIPT_FORMAT = "ournotes.story-script/1";

// Character slots on AdvCharacterField (PositionType), far left to far right.
export const POSITIONS = Object.freeze({ "far-left": 1, left: 3, center: 5, right: 7, "far-right": 9 });

// Default world X coordinate of each character slot in AdvStage focus points (spacing 1.05 units).
export const SLOT_WORLD_X = Object.freeze({ 1: -2.1, 3: -1.05, 5: 0, 7: 1.05, 9: 2.1 });

// Motion directional suffix facing center/partner: stage left slots (1, 3) face right (_R); stage right slots (7, 9) face left (_L).
export const SIDE = Object.freeze({ 1: "R", 3: "R", 5: "C", 7: "L", 9: "L" });

// Focus CameraDistance scale: 0 = full/establishing, 1 = near (1.2x), 2 = middle (1.4x), 3 = far (1.8x),
// 4 = close (2.8x), 5 = very-close (4x), 6 = macro.
export const CAMERAS = Object.freeze({
  full: 0,
  near: 1,
  middle: 2,
  far: 3,
  close: 4,
  "very-close": 5,
  macro: 6,
});

export const FADE_DIRECTIONS = Object.freeze({ out: "FadeOut", in: "FadeIn" });
export const FADE_RULES = Object.freeze(["0001", "0002", "0003", "0004", "0005"]);
export const FADE_COLORS = Object.freeze(["#000000", "#FFFFFF"]);
export const SCENE_TRANSITIONS = Object.freeze({ fade: "fade", dissolve: "dissolve" });
export const FONT_PRESETS = Object.freeze(["sans", "serif", "rounded"]);
export const MUSIC_STOP = "stop";
export const LOOK_STOP = "stop";
export const MAX_ACTIONS = 12;

export const EASES = Object.freeze(["OutQuad", "OutSine", "Linear", "OutQuint", "InOutSine", "InOutQuad"]);
export const EASE_MAP = Object.freeze(Object.fromEntries(EASES.map((e) => [e, e])));

// Commands whose Parameter2 accepts a DOTween ease name from EASES.
export const EASE_COMMANDS = new Set(["Focus", "Track", "Pedestal", "Zoom", "PanV2", "DoF", "Role", "Tilt"]);

export const MOVE_DIRECTIONS = Object.freeze({
  left: { cmd: "MoveToLeft", axis: "x", sign: -1 },
  right: { cmd: "MoveToRight", axis: "x", sign: 1 },
  up: { cmd: "MoveToUp", axis: "y", sign: 1 },
  down: { cmd: "MoveToDown", axis: "y", sign: -1 },
  forward: { cmd: "MoveToForward", axis: "z", sign: -1 },
  back: { cmd: "MoveToBack", axis: "z", sign: 1 },
});

export const TALK_WINDOWS = Object.freeze({
  default: "UIDefaultTalkWindow",
  center: "UICenterTalkWindow",
});

export const STAGE_ENV_TYPES = Object.freeze({
  All: "All",
  Light: "Light",
  Effect: "Effect",
  PostEffect: "PostEffect",
  FocusPosition: "FocusPosition",
});

export const FOCUS_POINT_MIN = 1;
export const FOCUS_POINT_MAX = 9;
export const TRACK_MIN = -4;
export const TRACK_MAX = 4;
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2.5;
export const PEDESTAL_MIN = -4;
export const PEDESTAL_MAX = 5;
export const PAN_MIN = -30;
export const PAN_MAX = 30;
export const ROLE_MIN = -30;
export const ROLE_MAX = 30;
export const TILT_MIN = -15;
export const TILT_MAX = 15;
export const ANGLE_MIN = -45;
export const ANGLE_MAX = 45;
export const LOOK_MIN = -1;
export const LOOK_MAX = 1;
export const SHAKE_POWER_MIN = 0.2;
export const SHAKE_POWER_MAX = 10;
export const DISSOLVE_MIN = 0.8;
export const DISSOLVE_MAX = 2.0;
export const DISSOLVE_DEFAULT = 1.2;
export const OFFICIAL_DURATION_MAX = 20;
export const DEFAULT_OFFICIAL_DURATION = 1.5;

export const MAX_CAMERA_DURATION = 10;
export const MAX_PAUSE = 60;
export const MAX_ACTION_PAUSE = 10;
export const HIDE_TALK_PAUSE_THRESHOLD = 0.6;

export const FRAME_PATTERN = /^adv_frame_[A-Za-z0-9_/-]+$/;
export const POST_EFFECT_PATTERN = /^adv_effect_posteffect_[A-Za-z0-9_/-]+$/;
export const FRAME_ACTIONS = Object.freeze({ Show_anime: "Show_anime", Hide_anime: "Hide_anime" });

// Allowed fields per beat kind; order of BEAT_KEYS keys is the discriminator precedence in parseScript.
// NOTE: `narrate` intentionally omits speaker-only fields (se, look, lookY, motionFadeIn, motionWait, motion,
// expression, lookAt), `camera` omits look/motionFadeIn, `positions` omits zoom, and `pause` omits se.
export const BEAT_KEYS = {
  scene: [
    "id", "scene", "music", "bgmFade", "bgmVolume", "bgmStart", "location", "positions",
    "transition", "transitionDuration", "fadeRule", "fadeColor", "duration", "moveDuration",
    "camera", "focus", "track", "focusDuration", "trackDuration", "pedestal", "pedestalDuration",
    "pan", "panDuration", "panFocusSlide", "dof", "dofDuration", "dofLayers", "dofTarget",
    "ease", "cameraDelay", "focusSharp", "focusTargetHead", "role", "roleDuration", "tilt", "tiltDuration",
    "stageEnv", "frame", "frameAction", "frameDuration", "postEffect", "postEffectDuration",
    "brightness", "talkWindow", "se", "seDuration", "seDelay", "seStop", "motionFadeIn", "motionWait",
  ],
  positions: [
    "id", "positions", "camera", "focus", "track", "focusDuration", "trackDuration", "moveDuration",
    "ease", "cameraDelay", "focusSharp", "focusTargetHead", "dof", "dofDuration", "dofLayers", "dofTarget",
    "motionFadeIn", "motionWait", "hideTalk",
  ],
  say: [
    "id", "say", "text", "thought", "ignoreLipSync", "hideTalk", "motion", "expression", "lookAt",
    "focus", "camera", "track", "zoom", "zoomDuration", "focusDuration", "trackDuration",
    "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide",
    "dof", "dofDuration", "dofLayers", "dofTarget", "ease", "cameraDelay", "focusSharp", "focusTargetHead",
    "role", "roleDuration", "tilt", "tiltDuration", "look", "lookY", "lookDuration",
    "move", "angle", "bgm", "bgmFade", "bgmVolume", "bgmStart",
    "frame", "frameAction", "frameDuration", "frameStop", "postEffect", "postEffectDuration", "postEffectStop",
    "brightness", "shake", "cameraShake", "cameraShakeFade", "cameraShakeStrength", "flash", "talkWindow",
    "se", "seDuration", "seDelay", "seStop", "motionFadeIn", "motionWait", "actions",
  ],
  narrate: [
    "id", "narrate", "thought", "ignoreLipSync", "hideTalk", "focus", "camera", "track", "zoom", "zoomDuration",
    "focusDuration", "trackDuration", "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide",
    "dof", "dofDuration", "dofLayers", "dofTarget", "ease", "cameraDelay", "focusSharp", "focusTargetHead",
    "role", "roleDuration", "tilt", "tiltDuration", "talkWindow", "actions",
  ],
  action: [
    "id", "action", "motion", "expression", "lookAt", "look", "lookY", "lookDuration",
    "move", "angle", "dof", "dofDuration", "dofLayers", "dofTarget", "duration",
    "se", "seDuration", "seDelay", "seStop", "motionFadeIn", "motionWait", "hideTalk",
  ],
  fade: ["id", "fade", "duration", "fadeRule", "fadeColor", "hideTalk"],
  pause: ["id", "pause", "hideTalk"],
  move: ["id", "move", "duration", "hideTalk"],
  camera: [
    "id", "camera", "focus", "track", "zoom", "zoomDuration", "cameraDuration", "focusDuration",
    "trackDuration", "pedestal", "pedestalDuration", "pan", "panDuration", "panFocusSlide",
    "dof", "dofDuration", "dofLayers", "dofTarget", "ease", "cameraDelay", "focusSharp", "focusTargetHead",
    "role", "roleDuration", "tilt", "tiltDuration", "se", "seDuration", "seDelay", "seStop", "duration", "hideTalk",
  ],
  bgm: ["id", "bgm", "bgmFade", "bgmVolume", "bgmStart", "hideTalk"],
  bgmFade: ["id", "bgmFade", "bgmVolume", "hideTalk"],
  bgmVolume: ["id", "bgmVolume", "bgmFade", "hideTalk"],
  angle: ["id", "angle", "duration", "hideTalk"],
  still: ["id", "still", "duration", "hideTalk"],
  subtitles: ["id", "subtitles", "duration", "hideTalk"],
  frame: ["id", "frame", "frameAction", "frameDuration", "hideTalk"],
  frameStop: ["id", "frameStop", "frame", "frameDuration", "hideTalk"],
  postEffect: ["id", "postEffect", "postEffectDuration", "hideTalk"],
  postEffectStop: ["id", "postEffectStop", "postEffect", "postEffectDuration", "hideTalk"],
  brightness: ["id", "brightness", "duration", "hideTalk"],
  shake: ["id", "shake", "duration", "hideTalk"],
  cameraShake: ["id", "cameraShake", "cameraShakeFade", "cameraShakeStrength", "hideTalk"],
  flash: ["id", "flash", "duration", "hideTalk"],
  stageEnv: ["id", "stageEnv", "hideTalk"],
  talkWindow: ["id", "talkWindow", "hideTalk"],
  se: ["id", "se", "seDuration", "seDelay", "hideTalk"],
  seStop: ["id", "seStop", "seDuration", "seDelay", "hideTalk"],
  hideTalk: ["id", "hideTalk"],
};

export const KINDS = Object.keys(BEAT_KEYS);

/**
 * Resolve the effective Track clamp for the active CameraDistance so close/macro speakers never drift off-screen.
 * @param {number} track
 * @param {number} distance
 * @returns {number}
 */
export const clampTrack = (track, distance) => {
  if (distance >= CAMERAS["very-close"]) return 0;
  if (distance === CAMERAS.close) return Math.max(-0.25, Math.min(0.25, track));
  return track;
};

/**
 * Compute Parameter2 ease for an eligible camera command, preserving explicit ease and defaulting slow ambient moves.
 * @param {string|undefined} explicitEase
 * @param {number} duration
 * @param {string} cmd
 * @returns {string|undefined}
 */
export const easeFor = (explicitEase, duration, cmd) => {
  if (!EASE_COMMANDS.has(cmd)) return undefined;
  if (explicitEase) return explicitEase;
  if (duration >= 4.0) return "Linear";
  if ((cmd === "Zoom" || cmd === "PanV2") && duration >= 0.8) return "OutSine";
  return undefined;
};

/**
 * True when plain text contains any letter or digit (including CJK letters) rather than pure punctuation/whitespace.
 * @param {string} text
 * @returns {boolean}
 */
export const hasSpokenContent = (text) => /[\p{L}\p{N}]/u.test(text);

/**
 * Normalize a rule transition identifier ("0001" -> "adv_transition_0001/adv_transition_0001").
 * @param {string|undefined} rule
 * @returns {string|undefined}
 */
export const transitionAssetName = (rule) => (rule ? `adv_transition_${rule}/adv_transition_${rule}` : undefined);
