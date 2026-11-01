// Builds a minimal on-disk nnnotes site for the e2e StorySession render: a Normal story with Talk/Location rows,
// a minimal scene whose prefabs the fixture renderer supplies, a minimal UI/fonts product (the page uses the synthetic
// StoryUI instead) and no Live2D models. No game data is needed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const put = (dir, logical, value) => {
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const ext = (path.extname(logical).slice(1) || "json").toLowerCase();
  const asset = `assets/${sha}.${ext}`;
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, asset), bytes);
  return { asset, size: bytes.length };
};

const product = (dir, file, kind, subject, files, objects = {}) => {
  const entries = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, put(dir, name, value)]));
  const manifest = { schema: "nnnotes.product/1", product: kind, subject, files: entries, objects };
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(manifest));
  return manifest;
};

const mono = (dir, cls, name, fields) => ({ class: "MonoBehaviour", name, files: { json: put(dir, `${name}.json`,
  { $script: `Test||${cls}`, m_Name: name, ...fields }) } });

export const buildMinimalSite = (dir, { language = "ja", title = "E2E Fixture" } = {}) => {
  const root = path.resolve(dir);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const field = language === "ja" ? "japanese" : language === "en" ? "english" : language;

  const text = {
    1: { [field]: "灯" },
    2: { [field]: "放学后的教室很安静，只有窗外的风声。" },
    3: { [field]: "今天也一起练习吧！" },
    4: { [field]: "窗外的夕阳把桌椅的影子拉得很长。" },
    5: { [field]: "教室" },
    6: { [field]: title },
    7: { [field]: "???" },
    8: { [field]: " & " },
  };
  const commands = [
    { i: 0, cmd: "TalkWindow", TargetAssetName: "UIDefaultTalkWindow" },
    { i: 1, cmd: "Location", AdvTextID: "5" },
    { i: 2, cmd: "Talk", AdvTextID: "2", TargetName: "speaker", TargetTextIDs: ["1"], TargetTextColors: ["#FFFFFF"] },
    { i: 3, cmd: "Talk", AdvTextID: "3", TargetName: "speaker", TargetTextIDs: ["1"], TargetTextColors: ["#FFFFFF"] },
    { i: 4, cmd: "Talk", AdvTextID: "4" },
  ];
  const episode = {
    advId: 0, asset: "", commandCount: commands.length, commands, text,
    sounds: {}, cuesheets: {}, videos: {}, resources: [],
    master: { _id: 0, _sheetName: "", _advEpisodeAsset: "", _titleTextId: "6", _rubyTitleTextId: "", _playbackMode: 0 },
    title: { [field]: title },
  };
  const story = { format: 1, advId: 0, episode: "episode.json", chats: {}, effects: {}, parts: {
    scene: "storyscenes/default.json", models: {}, assets: {}, sounds: {}, videos: {},
    ui: { [language]: "storyui/ja.json" }, fonts: { [language]: "storyfonts/0_ja.json" },
  } };
  product(root, "stories/0.json", "story", "0", { "story.json": story, "episode.json": episode });

  const scene = {
    format: 1, scene: [], renderSettings: null,
    prefabs: { cameraManager: "fixture:camera", characterField: "fixture:field", backgroundField: "fixture:bg",
               globalVolume: "fixture:volume" },
    settings: { playerSettings: "fixture:player", masterIdSettings: "fixture:ids" },
    graphics: { graphics: "fixture:graphics" }, bindings: {}, shaders: {},
  };
  product(root, "storyscenes/default.json", "story.scene", "default", { "scene.json": scene }, {
    "fixture:player": mono(root, "AdvPlayerSettings", "player", {
      _initializeEpisodes: [], _finalizeEpisodes: [], _targetNameSplitKey: "・",
      _waitAfterVoiceTime: 0.6, _waitTalkTextUnitTime: 0.04, _minTalkDisplayTime: 1.6,
      _defaultFocusDataSettingsKey: "default", _focusDataSettingsMap: { _list: [] },
    }),
    "fixture:ids": mono(root, "AdvMasterIdSettings", "ids", {
      _unknownCharacterNameTextId: "7", _splitCharacterNameTextId: "8",
    }),
    "fixture:graphics": { class: "GraphicsSettings", name: "graphics", files: { json: put(root, "graphics.json", {}) } },
  });

  const ui = {
    format: 1, language: { code: language, mode: language === "ja" ? 0 : 1, field,
      lineSpacing: 0, fontNames: [], additionalFontNames: [], materialTypes: [], fontSwap: {} },
    widget: "fixture:widget", chatWidget: null, uiManager: null,
    talkWindows: { UIDefaultTalkWindow: "fixture:window" }, dialogs: {}, letterbox: null, clips: {}, controllers: {},
    settings: { dotween: null }, graphics: { graphics: null }, texts: {}, bindings: {}, shaders: {},
  };
  product(root, "storyui/ja.json", "story.ui", language, { "ui.json": ui });
  const fonts = {
    format: "nnnotes.story-fonts/1", language, source: "open", fonts: {}, textures: {}, materials: {},
    materialKeywords: {}, texts: {}, sprites: {}, shaders: {}, coverage: { characters: 0, missing: [] },
    lineBreaking: { leading: "", following: "。", useModernHangulLineBreakingRules: false },
  };
  product(root, "storyfonts/0_ja.json", "story.fonts", `0/${language}`, { "fonts.json": fonts });

  fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({ format: 2, models: [] }));
  fs.writeFileSync(path.join(root, "stories.json"), JSON.stringify({
    format: "ournotes.stories/1",
    stories: [{ id: "0", advId: 0, manifest: "stories/0.json", playbackMode: 0, language,
                languages: [language], titles: { [language]: title } }],
  }));
  return { dir: root, manifest: "stories/0.json", language, title };
};

if (process.argv[1] && process.argv[1].endsWith("minimal-site.mjs")) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node host/fixtures/minimal-site.mjs <site-dir>");
    process.exit(2);
  }
  const site = buildMinimalSite(out);
  console.log(JSON.stringify(site));
}
