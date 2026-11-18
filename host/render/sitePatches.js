import { collectDiscreteLayerParams, fadeCharacterMotion } from "../../src/live2d/motion.js";

export const iterValues = (collection) => {
  if (!collection) return [];
  if (collection instanceof Map) return collection.values();
  if (typeof collection.values === "function") return collection.values();
  if (Symbol.iterator in Object(collection)) return collection;
  if (typeof collection === "object") return Object.values(collection);
  return [];
};

export const makePcmRmsAnalyzer = (src) => ({
  isAvailable: true,
  getOpenInfo() {
    const sr = src.sampleRate || 48000;
    const buf = src.latest(Math.max(1, Math.round(sr * 0.04)));
    if (!buf || !buf.length) return { openY: 0 };
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return { openY: rms > 0.004 ? Math.min(1, rms * 4) : 0 };
  },
});

export const patchCharacter = (
  ch,
  { siteEngine = false, crilips = null, getTalkLength = () => 12, getSpeedRate = () => 1 } = {},
) => {
  if (!ch) return;
  if (!ch.discreteLayerParams && !ch._discreteFadePatched) {
    ch._discreteFadePatched = true;
    if (ch.params?.ids?.length) {
      ch.discreteLayerParams = collectDiscreteLayerParams(ch.params);
    }
    ch._fade = function _fadePatched() {
      if (!this.discreteLayerParams && this.params?.ids?.length) {
        this.discreteLayerParams = collectDiscreteLayerParams(this.params);
      }
      return fadeCharacterMotion(this, this.discreteLayerParams);
    };
  }
  if (
    siteEngine &&
    !crilips &&
    ch.isMotionSyncEnabled === false &&
    !ch._siteLipSyncPatched &&
    typeof ch.setLipsAnalyzer === "function" &&
    typeof ch.setLipSyncEnabled === "function"
  ) {
    ch._siteLipSyncPatched = true;
    const origSetAnalyzer = ch.setLipsAnalyzer.bind(ch);
    const origSetEnabled = ch.setLipSyncEnabled.bind(ch);
    let needsPseudo = false;
    ch.setLipsAnalyzer = (analyzer) => {
      if (!analyzer) {
        needsPseudo = false;
        return origSetAnalyzer(null);
      }
      if (typeof analyzer.getOpenInfo === "function") {
        needsPseudo = false;
        return origSetAnalyzer(analyzer);
      }
      if (analyzer.hasPcm && typeof analyzer.latest === "function") {
        needsPseudo = false;
        return origSetAnalyzer(makePcmRmsAnalyzer(analyzer));
      }
      needsPseudo = true;
      origSetAnalyzer(null);
      if (ch.isLipSyncEnabled) {
        ch.startTimedPseudoLipSync(getTalkLength(), getSpeedRate(), 1);
      }
    };
    ch.setLipSyncEnabled = (flag, usePseudo = false) => {
      origSetEnabled(flag, usePseudo);
      if (flag && !usePseudo && needsPseudo) {
        ch.startTimedPseudoLipSync(getTalkLength(), getSpeedRate(), 1);
      } else if (!flag) {
        needsPseudo = false;
        ch.stopTimedPseudoLipSync();
      }
    };
  }
};

export const patchSessionCharacters = (session, opts = {}) => {
  const characters = session?.characters;
  const patchAll = () => {
    if (!characters) return;
    for (const ch of iterValues(characters)) {
      patchCharacter(ch, opts);
    }
  };
  patchAll();
  if (characters && typeof characters.add === "function" && !characters._renderAddPatched) {
    characters._renderAddPatched = true;
    const origAdd = characters.add.bind(characters);
    characters.add = (...args) => {
      const added = origAdd(...args);
      const ch = args.length >= 3 ? args[2] : args[args.length - 1];
      patchCharacter(ch, opts);
      return added;
    };
  }
  if (characters && typeof characters.set === "function" && !characters._renderSetPatched) {
    characters._renderSetPatched = true;
    const origSet = characters.set.bind(characters);
    characters.set = (key, ch, ...rest) => {
      const res = origSet(key, ch, ...rest);
      patchCharacter(ch, opts);
      return res;
    };
  }
  return patchAll;
};

const disableAutoIconNode = (ui, node) => {
  if (!node) return;
  if (typeof ui.setActive === "function") ui.setActive(node, false);
  else if ("activeSelf" in node) node.activeSelf = false;
};

const patchTalkWindow = (ui, talk, part = null) => {
  if (!talk) return;
  disableAutoIconNode(ui, talk.p?.autoIcon || part?.autoIcon || null);
  if (typeof talk._showAutoIcon === "function" && !talk._autoIconHiddenPatched) {
    talk._autoIconHiddenPatched = true;
    talk._showAutoIcon = () => {
      disableAutoIconNode(ui, talk.p?.autoIcon || part?.autoIcon || null);
      if (typeof talk._setAutoModeFlag === "function") talk._setAutoModeFlag(true);
    };
  }
};

export const installHideAutoIcon = (ui) => {
  if (!ui) return () => {};
  const enforce = () => {
    for (const w of iterValues(ui.windows)) {
      if (!w || Array.isArray(w)) continue;
      patchTalkWindow(ui, w.talk, w.part || null);
      if (w.part?.autoIcon && w.part.autoIcon !== w.talk?.p?.autoIcon) {
        disableAutoIconNode(ui, w.part.autoIcon);
      }
    }
    if (ui.talk) {
      patchTalkWindow(ui, ui.talk, ui._window?.part || null);
    }
  };
  enforce();
  if (!ui._autoIconHooksInstalled) {
    ui._autoIconHooksInstalled = true;
    if (typeof ui.setAutoMode === "function") {
      const origSetAutoMode = ui.setAutoMode.bind(ui);
      ui.setAutoMode = (on, ...rest) => {
        enforce();
        const res = origSetAutoMode(on, ...rest);
        enforce();
        return res;
      };
    }
    if (typeof ui.setTalkWindow === "function") {
      const origSetTalkWindow = ui.setTalkWindow.bind(ui);
      ui.setTalkWindow = (name, ...rest) => {
        enforce();
        const res = origSetTalkWindow(name, ...rest);
        enforce();
        return res;
      };
    }
  }
  return enforce;
};

export const installOpeningTitleCoordinator = (ui, { isInactive = () => false } = {}) => {
  if (!ui || typeof ui.fadeIn !== "function" || typeof ui.showTitle !== "function") {
    return { onCommand: () => {}, cancel: () => {} };
  }
  const origFadeIn = ui.fadeIn.bind(ui);
  const origShowTitle = ui.showTitle.bind(ui);
  let firstTitle = true;
  let initReleased = false;
  let sawInitFade = false;
  let activeInitFade = null;
  let pendingTitle = null;

  const release = (cancel = false) => {
    if (initReleased) return;
    initReleased = true;
    const pending = pendingTitle;
    pendingTitle = null;
    if (!pending) return;
    if (cancel || isInactive()) {
      pending.resolve(undefined);
      return;
    }
    try {
      Promise.resolve(origShowTitle(...pending.args)).then(pending.resolve, pending.reject);
    } catch (e) {
      pending.reject(e);
    }
  };

  const fallbackRelease = () => {
    if (!initReleased && !sawInitFade && !activeInitFade) {
      release(false);
    }
  };

  ui.fadeIn = (...args) => {
    const p = origFadeIn(...args);
    if (!initReleased) {
      sawInitFade = true;
      activeInitFade = p;
      Promise.resolve(p).then(
        () => {
          if (activeInitFade === p) {
            activeInitFade = null;
            release(false);
          }
        },
        () => {
          if (activeInitFade === p) {
            activeInitFade = null;
            release(false);
          }
        },
      );
    }
    return p;
  };

  ui.showTitle = (...args) => {
    if (!firstTitle) return origShowTitle(...args);
    firstTitle = false;
    if (initReleased || (sawInitFade && !activeInitFade)) {
      initReleased = true;
      return origShowTitle(...args);
    }
    return new Promise((resolve, reject) => {
      pendingTitle = { args, resolve, reject };
    });
  };

  if (typeof ui.showLocation === "function") {
    const origShowLocation = ui.showLocation.bind(ui);
    ui.showLocation = (...args) => {
      fallbackRelease();
      return origShowLocation(...args);
    };
  }
  if (typeof ui.setTalk === "function") {
    const origSetTalk = ui.setTalk.bind(ui);
    ui.setTalk = (...args) => {
      fallbackRelease();
      return origSetTalk(...args);
    };
  }

  return {
    onCommand(c) {
      if (!c) return;
      if (c.cmd === "Location" || (c.cmd === "Talk" && c.AdvTextID && c.AdvTextID !== "0")) {
        fallbackRelease();
      }
    },
    cancel() {
      release(true);
    },
  };
};

export const applyRenderSessionPatches = (session, { siteEngine = false, getTalkLength = () => 12 } = {}) => {
  const crilips = session?.ctx?.story?.crilips ?? session?.story?.crilips;
  const patchCharacters = patchSessionCharacters(session, {
    siteEngine,
    crilips,
    getTalkLength,
    getSpeedRate: () => (session?.speed ? session.speed / 10 : 1),
  });
  let titleCoord = { onCommand: () => {}, cancel: () => {} };
  if (siteEngine && session?.ui) {
    installHideAutoIcon(session.ui);
    titleCoord = installOpeningTitleCoordinator(session.ui, {
      isInactive: () => !!(session.disposed || session.ended || session.core?.cancelled),
    });
  }
  return {
    patchCharacters,
    onCommand(c) {
      patchCharacters();
      titleCoord.onCommand(c);
    },
    cancel() {
      titleCoord.cancel();
    },
  };
};
