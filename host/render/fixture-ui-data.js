// The synthetic story UI document and fonts of tests/unit/story-ui-canvas.test.mjs, extracted for the e2e fixture
// render. It is the real StoryUI layout (front canvas, talk window, speaker plate, location caption, title, menu,
// letterbox) on stand-in prefabs and a browser-rasterized font, so the page needs no game UI/font products.
import { F } from "../../src/engine/core.js";

const v2 = (x, y) => ({ x, y });
const node = (path, { aMin = [0, 0], aMax = [1, 1], pos = [0, 0], size = [0, 0], pivot = [0.5, 0.5], active = 1, ...rest } = {}) => ({
  path, name: path.slice(path.lastIndexOf("/") + 1), active, localPosition: { x: 0, y: 0, z: 0 },
  localRotation: { x: 0, y: 0, z: 0, w: 1 }, localScale: { x: 1, y: 1, z: 1 },
  rect: { m_AnchorMin: v2(...aMin), m_AnchorMax: v2(...aMax), m_AnchoredPosition: v2(...pos), m_SizeDelta: v2(...size),
          m_Pivot: v2(...pivot) }, ...rest,
});
const white = { r: 1, g: 1, b: 1, a: 1 };
const image = (sprite = null) => ({ m_Enabled: 1, m_Color: white, m_Type: 0, m_PreserveAspect: 0, m_FillCenter: 1,
                                    m_UseSpriteMesh: 0, m_PixelsPerUnitMultiplier: 1, sprite, material: null });
const group = (alpha = 1) => ({ m_Enabled: 1, m_Alpha: alpha, m_IgnoreParentGroups: 0 });
const animator = (controller) => ({ controller, enabled: 1, updateMode: 0, keepStateOnDisable: 0 });
const hlg = (left, right) => ({ m_Enabled: 1, class: "HorizontalLayoutGroup", m_Padding: { m_Left: left, m_Right: right, m_Top: 0, m_Bottom: 0 },
                                m_Spacing: 0, m_ChildAlignment: 3, m_ChildControlWidth: 1, m_ChildControlHeight: 0,
                                m_ChildForceExpandWidth: 0, m_ChildForceExpandHeight: 0, m_ChildScaleWidth: 0,
                                m_ChildScaleHeight: 0, m_ReverseArrangement: 0 });
const fitter = { m_Enabled: 1, m_HorizontalFit: 2, m_VerticalFit: 0 };
const F0 = "UIAdvWidget/FrontCanvas", C = `${F0}/UISafeArea/UIContainer`, W = `${C}/TalkView/UIDefaultTalkWindow`;
const K = `${W}/TalkArea/Content`, L = "UIAdvWidget/AdvLetterBoxCanvas";
const style = { fontRole: "primary" };
const M = `${C}/MenuView`;

export const uiDoc = () => ({
  nodes: [
    node("UIAdvWidget/VideoCanvas", { canvas: { m_Enabled: 1, m_RenderMode: 1, m_PixelPerfect: 0 } }),
    node("UIAdvWidget/VideoCanvas/VideoView", { image: image("nope") }),
    node(F0, { canvas: { m_Enabled: 1, m_RenderMode: 1, m_PixelPerfect: 0 },
               canvasScaler: { m_Enabled: 1, m_UiScaleMode: 1, m_ReferencePixelsPerUnit: 100, m_ScaleFactor: 1,
                               m_ReferenceResolution: v2(1920, 1080), m_ScreenMatchMode: 1, m_MatchWidthOrHeight: 1 } }),
    node(`${F0}/FlashView`, { image: image(), flashView: { enabled: 1, _flash: `${F0}/FlashView` } }),
    node(`${F0}/RuleTransition`, { active: 0, image: image(), ruleTransition: { material: "UI-Transition" } }),
    node(`${F0}/LocationVIew`, { aMin: [0.5, 0.5], aMax: [0.5, 0.5], size: [1400, 86], active: 0, canvasGroup: group(),
                                 animator: animator("AdvLocation"),
                                 tweenSequence: { list: [{ _commandType: 1, _duration: 2.5 }], raw: { updateType: 0, isSpeedBased: 0 } } }),
    node(`${F0}/LocationVIew/LocationText`, { aMin: [0.5, 0.5], aMax: [0.5, 0.5], size: [1400, 62], textStyle: style }),
    node(`${F0}/UISafeArea`), node(C),
    node(`${C}/SubtitlesView`, { subtitlesView: { enabled: 1, _subtitles: `${C}/SubtitlesView/SubtitlesText`,
                                                  _subtitlesText: `${C}/SubtitlesView/SubtitlesText` } }),
    node(`${C}/SubtitlesView/SubtitlesText`, { aMin: [0, 0], aMax: [1, 0], pos: [0, 60], size: [0, 141], pivot: [0.5, 0], textStyle: style }),
    node(`${C}/TalkView`),
    node(W, { talkWindow: { _typingDelay: F(0.05), _useBackdropFilter: 0 } }),
    node(`${W}/TalkBackground`, { aMin: [0, 0], aMax: [1, 0], pos: [0, -66], size: [800, 356], pivot: [0.5, 0],
                                   image: { ...image(), m_Color: { r: 0.06, g: 0.05, b: 0.10, a: 0.92 } }, canvasGroup: group() }),
    node(`${W}/TalkArea`, { aMin: [0, 0], aMax: [1, 0] }),
    node(K, { aMin: [0.5, 0.5], aMax: [0.5, 0.5], size: [1580, 0] }),
    node(`${K}/TalkText`, { aMin: [0, 0.5], aMax: [0, 0.5], pos: [198.71, 201.91], size: [1200, 200], pivot: [0, 1], textStyle: style }),
    node(`${K}/TalkNextIndicator`, { aMin: [1, 0], aMax: [1, 0], pos: [-152, 76], size: [60, 60], active: 0, image: image(),
                                     animator: animator("NextIndicator") }),
    node(`${K}/AutoIcon`, { aMin: [1, 0], aMax: [1, 0], pos: [-152, 76], size: [60, 60], active: 0, animator: animator("AutoNext") }),
    node(`${K}/FastIcon`, { aMin: [1, 0], aMax: [1, 0], pos: [-60, 76], size: [60, 60], active: 0 }),
    node(`${K}/Speaker`, { aMin: [0, 0.5], aMax: [0, 0.5], pos: [184, 285], size: [800, 60], pivot: [0, 0.5] }),
    node(`${K}/Speaker/Back`, { aMin: [0, 0.5], aMax: [0, 0.5], pos: [0, -26.9], size: [0, 60], pivot: [0, 0.5],
                                layoutGroup: hlg(20, 80), contentSizeFitter: fitter }),
    node(`${K}/Speaker/Back/SpeakerText`, { aMin: [0, 0], aMax: [0, 0], size: [0, 36], textStyle: style }),
    node(`${C}/NextIndicator`, { aMin: [1, 0], aMax: [1, 0], pos: [-60, -25], size: [28, 19] }),
    node(`${C}/NextIndicator/IndicatorIcon`, { aMin: [0.5, 0.5], aMax: [0.5, 0.5], pos: [0, 68], size: [28, 19], image: image("next"),
                                                animator: animator("NextIndicator") }),
    node(M, { canvasGroup: group() }),
    node(`${M}/MenuEntryButton`, { aMin: [1, 1], aMax: [1, 1], pos: [-84, -8], size: [120, 120], pivot: [1, 1] }),
    node(`${M}/VideoButtons`, { layoutGroup: { ...hlg(0, 0), m_ChildAlignment: 4, m_Spacing: 30, m_ChildControlWidth: 0 } }),
    node(`${M}/VideoButtons/BlackFilter`, { pivot: [1, 1], image: { ...image(), m_Color: { r: 0, g: 0, b: 0, a: 0.4 } },
                                            layoutElement: { m_Enabled: 1, m_IgnoreLayout: 1, m_LayoutPriority: 1, m_MinWidth: -1,
                                                             m_PreferredWidth: -1, m_FlexibleWidth: -1 },
                                            safeAreaEdgeAnchor: { enabled: 1, _left: { _target: 1, _anchor: 0, _offset: 0 },
                                                                  _right: { _target: 1, _anchor: 2, _offset: 0 },
                                                                  _top: { _target: 1, _anchor: 2, _offset: 0 },
                                                                  _bottom: { _target: 1, _anchor: 0, _offset: 0 } } }),
    node(`${M}/VideoButtons/PauseButton`, { aMin: [0, 0], aMax: [0, 0], size: [180, 180],
                                            buttonImageState: { normal: "stop", selected: "play", target: `${M}/VideoButtons/PauseButton/IconImage` } }),
    node(`${M}/VideoButtons/PauseButton/IconImage`, { aMin: [0.5, 0.5], aMax: [0.5, 0.5], size: [180, 180], image: image("stop") }),
    node(`${M}/VideoButtons/SkipButton`, { aMin: [0, 0], aMax: [0, 0], size: [180, 180] }),
    node(`${C}/TitleView`, { aMin: [0, 1], aMax: [0, 1], active: 0, canvasGroup: group(), animator: animator("AdvTitle"),
                             tweenSequence: { list: [{ _commandType: 1, _duration: 0 }], raw: { updateType: 0, isSpeedBased: 0 } } }),
    node(`${C}/TitleView/Title`, { aMin: [0.5, 0.5], aMax: [0.5, 0.5], pos: [0, -30], size: [0, 60], pivot: [0, 1],
                                   layoutGroup: hlg(40, 0), contentSizeFitter: fitter }),
    node(`${C}/TitleView/Title/TitleText`, { size: [0, 60], aMin: [0, 0], aMax: [0, 0], textStyle: style }),
    node(`${C}/TitleView/Title/Padding`, { size: [0, 60], aMin: [0, 0], aMax: [0, 0],
                                           layoutElement: { m_Enabled: 1, m_IgnoreLayout: 0, m_LayoutPriority: 1, m_MinWidth: 364.5,
                                                            m_PreferredWidth: -1, m_FlexibleWidth: -1 } }),
    node(L, { canvas: { m_Enabled: 1, m_RenderMode: 0, m_PixelPerfect: 0 } }),
    node(`${L}/TopBand`, { aMin: [0, 1], aMax: [1, 1], pivot: [0.5, 0], active: 0, image: image() }),
    node(`${L}/BottomBand`, { aMin: [0, 0], aMax: [1, 0], pivot: [0.5, 1], active: 0, image: image() }),
  ],
  sprites: Object.fromEntries(["letterbox", "next", "stop", "play"].map((n) => [n, {
    texture: "lb", rect: { x: 0, y: 0, width: 1920, height: 1440 }, textureRect: { x: 0, y: 0, width: 1920, height: 1440 },
    textureRectOffset: { x: 0, y: 0 }, border: { x: 0, y: 0, z: 0, w: 0 }, pivot: v2(0.5, 0.5), pixelsPerUnit: 100 }])),
  letterBoxSprite: "letterbox",
  textures: { lb: { texture: "textures/lb.png", width: 1920, height: 1440, mipCount: 1 } },
  materials: { "UI-Transition": { material: "UI-Transition", shader: { shader: "UI/Default" }, keywords: [], floats: { _Val: 1, _UseGradient: 0 },
                                  colors: { _Color: { r: 0, g: 0, b: 0, a: 1 } } },
               "Default UI Material": { material: "Default UI Material", shader: { shader: "UI/Default" }, keywords: [], floats: {}, colors: {} } },
  materialKeywords: {},
  clips: {
    "NextIndicator/Loop": { name: "Loop", startTime: 0, stopTime: 0.9166667, loopTime: 1, events: [],
                            curves: { "RectTransform.m_AnchoredPosition.y": { keys: [[0, 2000, -600, 0, 76], [0.2, -2596.544678, 714.049683, 0, 68], [0.3833333, 0, 0, 0, 76]] } } },
    "AutoNext/Loop": { name: "Loop", startTime: 0, stopTime: 2, loopTime: 1, events: [],
                       curves: { "Transform.localEulerAngles.z": { keys: [[0, -89.75, 269.25, 0, 0]] } } },
    "AdvLocation/Play": { name: "Play", startTime: 0, stopTime: 2.5, loopTime: 0, events: [],
                          curves: { "CanvasGroup.m_Alpha": { keys: [[0, -74.074066, 33.333332, 0, 0], [0.3, 0, 0, 0, 1], [2, 74.07412, -33.333347, 0, 1], [2.3, 0, 0, 0, 0]] },
                                    "RectTransform.m_AnchoredPosition.x": { keys: [[0, 4800, -3600, 0, 300], [0.5, 0, 0, 0, 0], [2, 4800, -3600, 0, 0]] } } },
    "AdvTitle/Play": { name: "Play", startTime: 0, stopTime: 6, loopTime: 0, events: [],
                       curves: { "CanvasGroup.m_Alpha": { keys: [[0, 0, 0, 0, 1], [5, 2, -3, 0, 1], [6, 0, 0, 0, 0]] },
                                 "RectTransform.m_AnchoredPosition.x": { keys: [[0, 0, 0, 0, 0], [5, 600, -900, 0, 0]] } } },
  },
  controllers: {
    NextIndicator: { name: "NextIndicator", defaultState: "Loop", states: [{ name: "Loop", speed: 1, clip: "Loop" }] },
    AutoNext: { name: "AutoNext", defaultState: "Loop", states: [{ name: "Loop", speed: -1, clip: "Loop" }] },
    AdvLocation: { name: "AdvLocation", defaultState: "Idle", states: [{ name: "Idle", speed: 1, clip: "Idle" }, { name: "Play", speed: 1, clip: "Play" }] },
    AdvTitle: { name: "AdvTitle", defaultState: "Idle", states: [{ name: "Idle", speed: 1, clip: "Idle" }, { name: "Play", speed: 1, clip: "Play" }] },
  },
  transitions: { "adv_transition_0001/adv_transition_0001": {
    _texture: { texture: "lb", name: "rule" }, _gradient: 0,
    _easingCurve: { m_Curve: [{ time: 0, value: 0, inSlope: 1, outSlope: 1, weightedMode: 0 }, { time: 1, value: 1, inSlope: 1, outSlope: 1, weightedMode: 0 }] } } },
  playerSettings: { _defaultTransitionAssetAddress: "adv_transition_0001/adv_transition_0001", _waitTalkTextUnitTime: 0.04 },
  dotween: { defaultEaseType: 6 },
  shaders: { index: "shaders/shaders.json", names: [] },
});

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 !?.,一二三。";
const fontAsset = () => {
  const characters = {}, glyphs = {};
  [...CHARS].forEach((ch, i) => {
    const gi = i + 1, space = ch === " ";
    characters[ch.codePointAt(0)] = { glyph: gi, scale: 1, elementType: 1 };
    glyphs[String(gi)] = { metrics: space ? { m_Width: 0, m_Height: 0, m_HorizontalBearingX: 0, m_HorizontalBearingY: 0, m_HorizontalAdvance: 30 }
                                          : { m_Width: 50, m_Height: 70, m_HorizontalBearingX: 5, m_HorizontalBearingY: 70, m_HorizontalAdvance: 60 },
                           rect: { m_X: (i % 16) * 64 + 8, m_Y: Math.floor(i / 16) * 96 + 8, m_Width: space ? 0 : 50, m_Height: space ? 0 : 70 },
                           scale: 1, atlasIndex: 0, packed: { texture: "page0", dx: 0, dy: 0 } };
  });
  return { faceInfo: { m_PointSize: 100, m_Scale: 1, m_LineHeight: 120, m_AscentLine: 90, m_DescentLine: -30, m_Baseline: 0, m_TabWidth: 25 },
           normalStyle: 0, normalSpacingOffset: 0, boldStyle: 0.75, boldSpacing: 7, tabSize: 10, characters, glyphs,
           glyphPairAdjustmentRecords: 0, fallbacks: [], atlasPadding: 2, atlasRenderMode: 4134,
           browser: { family: "\"Microsoft YaHei\", \"Yu Gothic\", \"Noto Sans CJK SC\", sans-serif",
                      pageWidth: 1024, pageHeight: 1024 } };
};
const tmp = (cls, over) => ({
  class: cls, enabled: 1, m_fontSize: 36, m_fontSizeBase: 36, m_enableAutoSizing: 0, m_fontSizeMin: 18, m_fontSizeMax: 36,
  m_charWidthMaxAdj: 0, m_lineSpacingMax: 0, m_fontStyle: 0, m_HorizontalAlignment: 1, m_VerticalAlignment: 256,
  m_characterSpacing: 2, m_wordSpacing: 0, m_paragraphSpacing: 0, m_TextWrappingMode: 0, m_overflowMode: 0,
  m_isRichText: 1, m_parseCtrlCharacters: 1, m_overrideHtmlColors: 0, m_useMaxVisibleDescender: 1,
  m_margin: { x: 0, y: 0, z: 0, w: 0 }, m_fontColor: white, m_ActiveFontFeatures: [], m_isOrthographic: 1,
  m_isRightToLeft: 0, m_enableVertexGradient: 0, m_characterHorizontalScale: 1, m_horizontalMapping: 0,
  m_verticalMapping: 0, m_enableExtraPadding: 0,
  localized: { fontAsset: "Test SDF", material: "Test - Default", lineSpacing: 5 }, ...over,
});
const RUBY = { _rubyVerticalOffset: "1em", _rubyScale: 0.5, _rubyLineHeight: "", _rubyShowType: 0, _rubyMargin: 10 };
const rubyText = (top) => ({ ruby: RUBY, uiRubyText: { _rubyMarginTop: top } });

export const fontsDoc = () => ({
  language: "ja", source: "open", fonts: { "Test SDF": fontAsset() },
  // no atlas pages: the font asset is rasterized by the browser (BrowserGlyphFont)
  textures: {},
  materials: { "Test - Default": { material: "Test - Default", shader: { shader: "UI/Default" }, keywords: [],
                                   floats: { _GradientScale: 10, _ScaleRatioA: 1, _ScaleRatioC: 1 }, colors: {} } },
  materialKeywords: { "Test - Default": [] },
  shaders: { "UI/Default": "UI/Default" },
  texts: {
    [`${K}/TalkText`]: tmp("RubyEmojiTextMeshProUGUI", rubyText(-22)),
    [`${K}/Speaker/Back/SpeakerText`]: tmp("RubyTextMeshProUGUI", { m_fontStyle: 1, m_VerticalAlignment: 512, m_TextWrappingMode: 1, ...rubyText(-24) }),
    [`${F0}/LocationVIew/LocationText`]: tmp("RubyTextMeshProUGUI", { m_fontSize: 40, m_fontStyle: 1, m_HorizontalAlignment: 2, m_VerticalAlignment: 512,
                                                                     ...rubyText(0) }),
    [`${C}/SubtitlesView/SubtitlesText`]: tmp("RubyTextMeshProUGUI", { m_fontStyle: 1, m_HorizontalAlignment: 2, m_VerticalAlignment: 1024,
                                                                      ...rubyText(0) }),
    [`${C}/TitleView/Title/TitleText`]: tmp("TextMeshProUGUI", { m_fontSize: 40, m_fontSizeBase: 40, m_enableAutoSizing: 1, m_fontSizeMin: 24,
                                                                  m_fontSizeMax: 40, m_fontStyle: 1, m_VerticalAlignment: 512 }),
  },
  coverage: { characters: CHARS.length, missing: [] },
  lineBreaking: { leading: "", following: "。", useModernHangulLineBreakingRules: false },
});
