// The story session's audio manager for a visual-only render: SilentAudio keeps the game-time timing (a line waits
// for its voice's cue length, a BGM loops until stopped) and this subclass records every play/stop so the host can
// rebuild the real audio track later. No WebAudio is used, so the render is not tied to wall-clock playback.
import { SilentAudio } from "../../src/story/silent-audio.js";

export class RecordingAudio extends SilentAudio {
  constructor(resolve, loop, opts) {
    super(resolve, loop, opts);
    this.events = [];
    this._meta = new Map();
    this._lastVolumes = new Map();
  }

  _recordVolume(name) {
    const key = String(name || "");
    const volume = this.getVolume(name);
    if (this._lastVolumes.get(key) === volume) return;
    this._lastVolumes.set(key, volume);
    this.events.push({ type: "volume", t: this.loop.time, category: key, volume });
  }

  changeVolume(name, v) {
    super.changeVolume(name, v);
    this._recordVolume(name);
  }

  restoreVolume(name) {
    super.restoreVolume(name);
    this._recordVolume(name);
  }

  _cue(soundId) {
    if (this._meta.has(soundId)) return this._meta.get(soundId);
    let c = null;
    try {
      const v = this.cueOf(soundId);
      c = { sheet: v.sheet, cue: v.cue, category: v.category, meta: v.meta || null };
    } catch { c = null; }
    this._meta.set(soundId, c);
    return c;
  }

  play(soundId, opts = {}) {
    const c = this._cue(soundId);
    const id = super.play(soundId, opts);
    if (id >= 0) {
      this.events.push({ type: "play", t: this.loop.time, id, soundId,
        startSec: opts.startSec || 0, loop: !!opts.loop, speed: opts.speed || 1,
        crossFade: opts.crossFade ?? 0.3, isAutoCrossFade: !!opts.isAutoCrossFade,
        forceFadeIn: !!opts.forceFadeIn, volume: opts.volume ?? 1,
        category: c ? c.category : null, sheet: c ? c.sheet : null, cue: c ? c.cue : null,
        cueCategories: c && c.meta ? c.meta.categories || [] : [],
        sampleRate: c && c.meta ? c.meta.sampleRate : null, samples: c && c.meta ? c.meta.samples : null,
        channels: c && c.meta ? c.meta.channels : null });
    }
    return id;
  }

  // Route stop, stopAll, and SilentAudio.play(isAutoCrossFade) through _stopInfo so automatic BGM swaps record "stop".
  _stopInfo(info, fadeOut = false, dur = 0.3) {
    if (info && !info.stopped) {
      this.events.push({ type: "stop", t: this.loop.time, id: info.id, soundId: info.soundId, fadeOut: !!fadeOut, dur });
    }
    return super._stopInfo(info, fadeOut, dur);
  }

  _kill(info) {
    if (!info.stopped) this.events.push({ type: "end", t: this.loop.time, id: info.id, soundId: info.soundId });
    return super._kill(info);
  }
}
