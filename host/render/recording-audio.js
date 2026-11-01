// The story session's audio manager for a visual-only render: SilentAudio keeps the game-time timing (a line waits
// for its voice's cue length, a BGM loops until stopped) and this subclass records every play/stop so the host can
// rebuild the real audio track later. No WebAudio is used, so the render is not tied to wall-clock playback.
import { SOUND_CATEGORY } from "../../src/engine/audio.js";
import { SilentAudio } from "../../src/story/silent-audio.js";

export class RecordingAudio extends SilentAudio {
  constructor(resolve, loop, opts) {
    super(resolve, loop, opts);
    this.events = [];
    this._meta = new Map();
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

  stop(id, fadeOut = false, dur = 0.3) {
    const info = this.playing.get(id);
    if (info) this.events.push({ type: "stop", t: this.loop.time, id, soundId: info.soundId, fadeOut: !!fadeOut, dur });
    return super.stop(id, fadeOut, dur);
  }

  stopAll(category, fadeOut = false, dur = 0.3) {
    for (const info of [...this.playing.values()]) {
      if (category !== SOUND_CATEGORY.All && info.category !== category) continue;
      this.events.push({ type: "stop", t: this.loop.time, id: info.id, soundId: info.soundId, fadeOut: !!fadeOut, dur, all: true });
    }
    return super.stopAll(category, fadeOut, dur);
  }

  _kill(info) {
    if (!info.stopped) this.events.push({ type: "end", t: this.loop.time, id: info.id, soundId: info.soundId });
    return super._kill(info);
  }
}
