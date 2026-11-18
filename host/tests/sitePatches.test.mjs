import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { PlayerLoop } from "../../src/engine/loop.js";
import { createStoryContext, createStoryUILayers } from "../../src/story/interfaces.js";
import { StoryCharacters } from "../../src/story/player-core.js";
import { SilentAudio } from "../../src/story/silent-audio.js";
import { SITE_ENGINE_DIR } from "../render/pageServer.js";
import { applyRenderSessionPatches } from "../render/sitePatches.js";

const makeMockTalkWindow = (ui, name, autoIconActive = true) => {
  const autoIcon = { name: `${name}/AutoIcon`, activeSelf: autoIconActive };
  const nextIndicator = { name: `${name}/NextIndicator`, activeSelf: true };
  const part = { window: { name }, autoIcon, nextIndicator };
  const talk = {
    p: part,
    _isAutoMode: false,
    _isActiveIndicator: true,
    _autoIconActive: false,
    _setAutoModeFlag(v) {
      this._isAutoMode = v;
      if (v) ui.setActive(nextIndicator, false);
      else ui.setActive(nextIndicator, this._isActiveIndicator);
    },
    // Mirrors ournotes-player-site StoryTalkWindow._showAutoIcon (ignores hideAutoIcon)
    _showAutoIcon() {
      if (this.p.autoIcon) ui.setActive(this.p.autoIcon, true);
      this._setAutoModeFlag(true);
    },
    _hideAutoIcon() {
      if (this.p.autoIcon) ui.setActive(this.p.autoIcon, false);
      this._setAutoModeFlag(false);
    },
    setAutoMode(v) {
      this._autoIconActive = !!v;
      if (v) this._showAutoIcon();
      else this._hideAutoIcon();
    },
  };
  return { name, node: part.window, part, talk };
};

const makeSiteMockUi = (loop, log = []) => {
  const ui = {
    loop,
    layers: createStoryUILayers(),
    talkWindows: ["UIDefaultTalkWindow", "UICenterTalkWindow"],
    windows: new Map(),
    _window: null,
    _view: { autoIcon: false, fastIcon: false, playbackSpeed: 1 },
    get talk() {
      return this._window ? this._window.talk : null;
    },
    setActive(node, v) {
      if (node) node.activeSelf = !!v;
    },
    setTalkWindow(name) {
      const w = this.windows.get(name);
      if (!w) throw new Error(`unknown window ${name}`);
      this._window = w;
      this.talk.setAutoMode(this._view.autoIcon);
    },
    setAutoMode(on) {
      this._view.autoIcon = !!on;
      if (this.talk) this.talk.setAutoMode(this._view.autoIcon);
    },
    setFastIconActive() {},
    setPlaybackSpeed() {},
    showTalk() {},
    hideTalk() {},
    hideTalkNextIndicator() {},
    setSpeakerName() {},
    setTalk(text) {
      log.push(`${loop.frameCount} setTalk ${text}`);
      return { totalLength: [...String(text)].length, finished: Promise.resolve(), cancel() {} };
    },
    showTitle(text) {
      log.push(`${loop.frameCount} showTitle ${text}`);
      return Promise.resolve();
    },
    showLocation(name) {
      log.push(`${loop.frameCount} showLocation ${name}`);
      return loop.delay(0.5);
    },
    transitionSettings(a) {
      return { address: a };
    },
    fadeOut(_s, _c, d) {
      log.push(`${loop.frameCount} fadeOut ${d}`);
      return loop.delay(d);
    },
    fadeIn(_s, _c, d) {
      log.push(`${loop.frameCount} fadeInStart ${d}`);
      return loop.delay(d).then(() => {
        log.push(`${loop.frameCount} fadeInEnd ${d}`);
      });
    },
    fadeInLetterBox() {
      return Promise.resolve();
    },
    load() {
      return Promise.resolve();
    },
    render() {},
    renderLetterBox() {},
    dispose() {},
  };
  ui.windows.set("UIDefaultTalkWindow", makeMockTalkWindow(ui, "UIDefaultTalkWindow", true));
  ui.windows.set("UICenterTalkWindow", makeMockTalkWindow(ui, "UICenterTalkWindow", true));
  return ui;
};

test("siteEngine hideAutoIcon handles Map s.ui.windows and blocks autoIcon across setAutoMode and setTalkWindow", () => {
  const loop = new PlayerLoop(30);
  const ui = makeSiteMockUi(loop);
  const session = { ui, characters: new StoryCharacters(), disposed: false, ended: false };

  applyRenderSessionPatches(session, { siteEngine: true });

  const defWin = ui.windows.get("UIDefaultTalkWindow");
  const ctrWin = ui.windows.get("UICenterTalkWindow");
  assert.equal(defWin.part.autoIcon.activeSelf, false);
  assert.equal(ctrWin.part.autoIcon.activeSelf, false);

  ui.setAutoMode(true);
  ui.setTalkWindow("UIDefaultTalkWindow");
  assert.equal(defWin.part.autoIcon.activeSelf, false, "AutoIcon must stay hidden after setAutoMode + setTalkWindow");
  assert.equal(defWin.talk._isAutoMode, true, "auto mode flag must still be set so nextIndicator hides");
  assert.equal(defWin.part.nextIndicator.activeSelf, false);

  ui.setTalkWindow("UICenterTalkWindow");
  assert.equal(ctrWin.part.autoIcon.activeSelf, false);

  // Even a window registered after initial patching cannot display autoIcon after setTalkWindow/setAutoMode,
  // and must not even transiently activate autoIcon before setTalkWindow completes.
  const lateWin = makeMockTalkWindow(ui, "UILateWindow", true);
  let lateActivated = false;
  const origSetActive = ui.setActive.bind(ui);
  ui.setActive = (node, v) => {
    if (node === lateWin.part.autoIcon && v) lateActivated = true;
    return origSetActive(node, v);
  };
  ui.windows.set("UILateWindow", lateWin);
  ui.setTalkWindow("UILateWindow");
  assert.equal(lateWin.part.autoIcon.activeSelf, false);
  assert.equal(lateActivated, false, "late window autoIcon must never transiently activate");

  // Direct talk.setAutoMode call must also keep autoIcon inactive.
  defWin.talk.setAutoMode(true);
  assert.equal(defWin.part.autoIcon.activeSelf, false);
});

test("siteEngine holds opening showTitle past async TalkWindow and _initializeEpisodes until FadeIn finishes", async () => {
  const loop = new PlayerLoop(30);
  const log = [];
  const ui = makeSiteMockUi(loop, log);
  const session = { ui, characters: new StoryCharacters(), disposed: false, ended: false, core: { cancelled: false } };
  const patches = applyRenderSessionPatches(session, { siteEngine: true });

  // Simulate ournotes-player-site StoryPlayerCore.play() order:
  // showTitle -> TalkWindow -> async _initializeEpisodes (Bgm, Se, FadeIn IsNoWait) -> Stage -> Location -> Talk
  let titleDone = false;
  let playDone = false;
  let playErr = null;
  const playPromise = (async () => {
    await ui.fadeInLetterBox();
    ui.showTitle("Episode 1").then(() => {
      titleDone = true;
    });
    ui.setTalkWindow("UIDefaultTalkWindow");
    await Promise.resolve(); // init0: Bgm
    await Promise.resolve(); // init1: Se
    patches.onCommand({ i: -1, cmd: "FadeOut", Duration: 0 });
    await ui.fadeOut({}, {}, 0);
    patches.onCommand({ i: -1, cmd: "FadeIn", Duration: 1, IsNoWait: true });
    ui.fadeIn({}, {}, 1); // IsNoWait: does not await completion here
    patches.onCommand({ i: 0, cmd: "Stage" });
    patches.onCommand({ i: 1, cmd: "Location", AdvTextID: "loc_1" });
    ui.showLocation("Classroom");
    patches.onCommand({ i: 2, cmd: "Talk", AdvTextID: "line_1" });
  })().then(
    () => {
      playDone = true;
    },
    (e) => {
      playErr = e;
      playDone = true;
    },
  );

  // Step until the async init sequence reaches Location/Talk while the 1s FadeIn is still running
  // (fadeOut(..., 0) uses loop.delay(0), which resolves on the next Update tick).
  for (let i = 0; i < 10 && !playDone; i++) {
    await loop.step();
  }
  await playPromise;
  if (playErr) throw playErr;
  assert.equal(playDone, true, "simulated play sequence must finish within 10 frames");
  assert.equal(titleDone, false, "title must stay hidden during opening FadeIn");
  assert.ok(!log.some((e) => e.includes("showTitle")), `showTitle fired prematurely: ${log.join(", ")}`);

  // Step until the 1s FadeIn (30 frames) finishes.
  for (let i = 0; i < 40 && !titleDone; i++) {
    await loop.step();
  }
  assert.equal(titleDone, true, "title must be shown after opening FadeIn completes");
  const fadeEndEntry = log.find((e) => e.includes("fadeInEnd 1"));
  const showTitleEntry = log.find((e) => e.includes("showTitle Episode 1"));
  assert.ok(fadeEndEntry && showTitleEntry, `missing log entries: ${log.join(", ")}`);
  const fadeEndFrame = Number(fadeEndEntry.split(" ")[0]);
  const titleFrame = Number(showTitleEntry.split(" ")[0]);
  assert.ok(titleFrame >= fadeEndFrame, `title at frame ${titleFrame} before fadeInEnd at frame ${fadeEndFrame}`);

  // Subsequent showTitle calls after the opening title are not deferred.
  await ui.showTitle("Second Title");
  assert.ok(log.some((e) => e.includes("showTitle Second Title")));
});

test("siteEngine fallback releases held showTitle when Location or Talk begins if story has no opening FadeIn", async () => {
  for (const fallbackCmd of [
    { i: 2, cmd: "Location", AdvTextID: "loc_1" },
    { i: 2, cmd: "Talk", AdvTextID: "line_1" },
  ]) {
    const loop = new PlayerLoop(30);
    const log = [];
    const ui = makeSiteMockUi(loop, log);
    const session = { ui, characters: new StoryCharacters(), disposed: false, ended: false };
    const patches = applyRenderSessionPatches(session, { siteEngine: true });

    let titleResolved = false;
    const p = ui.showTitle("No Fade Title").then(() => {
      titleResolved = true;
    });

    // Empty-text Talk (hide talk box) and Stage must NOT release the title yet.
    patches.onCommand({ i: 0, cmd: "Talk", AdvTextID: "" });
    patches.onCommand({ i: 1, cmd: "Stage" });
    await Promise.resolve();
    assert.equal(titleResolved, false, "hide-talk and Stage must not release opening showTitle");

    patches.onCommand(fallbackCmd);
    await p;
    assert.equal(titleResolved, true, `${fallbackCmd.cmd} must release opening showTitle when no FadeIn exists`);
    assert.ok(log.some((e) => e.includes("showTitle No Fade Title")));
  }
});

test("siteEngine title coordinator cancel resolves pending showTitle without drawing after session ends", async () => {
  const loop = new PlayerLoop(30);
  const log = [];
  const ui = makeSiteMockUi(loop, log);
  const session = { ui, characters: new StoryCharacters(), disposed: false, ended: false };
  const patches = applyRenderSessionPatches(session, { siteEngine: true });

  let settled = false;
  const p = ui.showTitle("Cancelled Title").then(() => {
    settled = true;
  });
  patches.cancel();
  await p;
  assert.equal(settled, true);
  assert.equal(log.some((e) => e.includes("showTitle")), false);
});

test("patchSessionCharacters patches existing and late-added characters and guards missing params", () => {
  const loop = new PlayerLoop(30);
  const characters = new StoryCharacters();
  const makeChar = ({ withParams = true, hasOwnFade = false, motionSync = true } = {}) => {
    const ch = {
      params: withParams ? { ids: ["ParamArmL_layer_1", "ParamMouthOpenY"], min: [0, 0], max: [1, 1], def: [0, 0] } : null,
      isMotionSyncEnabled: motionSync,
      isLipSyncEnabled: false,
      _fade: hasOwnFade ? () => "existing" : () => "unpatched",
      setLipsAnalyzer() {},
      setLipSyncEnabled(flag) {
        this.isLipSyncEnabled = !!flag;
      },
      startTimedPseudoLipSync(len, speed) {
        this.pseudoStarted = { len, speed };
      },
      stopTimedPseudoLipSync() {
        this.pseudoStopped = true;
      },
    };
    if (hasOwnFade) ch.discreteLayerParams = new Set([0]);
    return ch;
  };

  const existing = makeChar();
  const alreadyPatched = makeChar({ hasOwnFade: true });
  characters.add("ichika", 0, existing);
  characters.add("saki", 0, alreadyPatched);

  let talkLen = 18;
  const session = {
    ui: makeSiteMockUi(loop),
    characters,
    speed: 15,
    disposed: false,
    ended: false,
  };
  const patches = applyRenderSessionPatches(session, {
    siteEngine: true,
    getTalkLength: () => talkLen,
  });

  assert.ok(existing.discreteLayerParams instanceof Set && existing.discreteLayerParams.has(0));
  assert.equal(existing._fade.name, "_fadePatched");
  assert.equal(alreadyPatched._fade(), "existing", "already-patched character must keep its _fade");

  // Character added after Session.create() via characters.add() with delayed params & no MotionSync
  const late = makeChar({ withParams: false, motionSync: false });
  characters.add("honami", 0, late);
  assert.equal(late._fade.name, "_fadePatched");
  assert.equal(late.discreteLayerParams, undefined);
  late.params = { ids: ["hand_L_1"], min: [0], max: [1], def: [0] };
  late.loop = loop;
  late.layer = { list: [] };
  late._fade();
  assert.ok(late.discreteLayerParams instanceof Set && late.discreteLayerParams.has(0));

  late.setLipsAnalyzer({ hasPcm: false });
  late.setLipSyncEnabled(true, false);
  assert.deepEqual(late.pseudoStarted, { len: 18, speed: 1.5 });

  // Character inserted directly into internal map is still picked up on onCommand()
  const bypassed = makeChar();
  characters.byKey.set("shiho-0", bypassed);
  patches.onCommand({ i: 0, cmd: "Stage" });
  assert.equal(bypassed._fade.name, "_fadePatched");
});

test(
  "real ournotes-player-site StoryPlayerCore coordinates Map windows and delayed FadeIn showTitle",
  { skip: !SITE_ENGINE_DIR },
  async () => {
    const coreUrl = pathToFileURL(path.join(SITE_ENGINE_DIR, "src/story/player-core.js")).href;
    const siteCoreMod = await import(coreUrl);
    const SiteStoryPlayerCore = siteCoreMod.StoryPlayerCore;
    const SiteCharacters = siteCoreMod.StoryCharacters;

    const loop = new PlayerLoop(30);
    const log = [];
    const ui = makeSiteMockUi(loop, log);
    const settings = {
      _initializeEpisodes: [
        { Command: 15, BgmID: 0 },
        { Command: 15, BgmID: 7 },
        { Command: 6, TargetName: "adv_transition_0001", TargetAssetName: "t1", Duration: 1, IsNoWait: true },
      ],
      _finalizeEpisodes: [],
      _targetNameSplitKey: "・",
      _waitAfterVoiceTime: 0.6,
      _waitTalkTextUnitTime: 0.04,
      _minTalkDisplayTime: 1.6,
      _defaultTransitionAssetAddress: "t1",
      _defaultFocusDataSettingsKey: "k",
      _focusDataSettingsMap: { _list: [] },
    };
    const text = { 1: { english: "Opening Title" }, 2: { english: "Hello!" }, 11000: { english: "???" }, 11001: { english: " & " } };
    const sounds = { 7: { _soundCueSheetID: 1, _cueName: "bgm", _category: 0 } };
    const cues = { bgm: { sampleRate: 48000, samples: 48000 * 10 } };
    const episode = {
      advId: 1,
      commands: [{ i: 0, cmd: "Talk", AdvTextID: "2" }],
      text,
      sounds,
      cuesheets: { 1: { _cueSheetName: "s" } },
    };
    const audio = new SilentAudio(
      (id) => ({ sheet: "s", cue: sounds[id]._cueName, category: sounds[id]._category, row: sounds[id], meta: cues.bgm }),
      loop,
      { assets: { json: () => cues } },
    );
    loop.on("update", () => audio.update());
    const ctx = createStoryContext({
      loop,
      camera: null,
      field: null,
      background: null,
      fieldRenderer: null,
      volume: { stopAlwaysUpdate() {}, markUpdateOnce() {} },
      characters: new SiteCharacters(),
      stages: new Map(),
      ui,
      audio,
      quality: {},
      lang: "en",
      playbackMode: 0,
      titleTextId: 1,
      episode,
      story: {},
      assets: { json: () => cues },
      settings: { player: settings, masterIds: { _unknownCharacterNameTextId: "11000", _splitCharacterNameTextId: "11001" } },
      localize: (id) => text[id]?.english || "",
      renderer: null,
      gl: null,
    });

    let patches;
    const core = new SiteStoryPlayerCore(ctx, {
      auto: true,
      onCommand: (c) => patches?.onCommand(c),
    });
    const session = { ui, characters: ctx.characters, core, disposed: false, ended: false };
    patches = applyRenderSessionPatches(session, { siteEngine: true });

    let done = false;
    let err = null;
    core.play().then(
      () => {
        done = true;
      },
      (e) => {
        err = e;
        done = true;
      },
    );
    for (let n = 0; n < 300 && !done; n++) await loop.step();
    if (err) throw err;
    assert.equal(done, true);

    assert.equal(ui.windows.get("UIDefaultTalkWindow").part.autoIcon.activeSelf, false);
    const fadeStart = Number(log.find((e) => e.includes("fadeInStart 1")).split(" ")[0]);
    const fadeEnd = Number(log.find((e) => e.includes("fadeInEnd 1")).split(" ")[0]);
    const titleFrame = Number(log.find((e) => e.includes("showTitle Opening Title")).split(" ")[0]);
    assert.ok(titleFrame >= fadeEnd && fadeEnd >= fadeStart + 29,
              `expected titleFrame (${titleFrame}) >= fadeEnd (${fadeEnd}), fadeStart=${fadeStart}`);
  },
);
