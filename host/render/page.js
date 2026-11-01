// The page-side render job. It loads the composed story, uploads every cue file it may play, drives StorySession one
// fixed 1/30 s step at a time (no real-time audio), draws each frame to a canvas and posts it as JPEG, then reports the
// audio timeline and line timings. Nothing here depends on wall-clock speed, so the frames are deterministic.
import { loadStoryStore } from "/src/story/assets.js";
import { StoryData } from "/src/story/data.js";
import { MISSING_CUE } from "/src/engine/audio.js";
import { RecordingAudio } from "./recording-audio.js";
import { StorySession } from "/src/story/session.js";

const post = async (url, body, headers = {}) => {
  const r = await fetch(url, { method: "POST", headers, body });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${await r.text().catch(() => "")}`);
  return r;
};

const cueExtension = (file) => {
  const m = String(file || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : "bin";
  return ["wav", "m4a", "mp3", "flac", "ogg", "aac", "opus"].includes(ext) ? ext : "bin";
};

const uploadCues = async (jobId, store, data) => {
  const cues = {};
  for (const [soundId, row] of Object.entries(data.episode.sounds || {})) {
    if (!row || row._cueName == null) continue;
    const sheet = data.cuesheets?.[row._soundCueSheetID];
    if (!sheet?._cueSheetName) continue;
    let meta;
    try { meta = data.cues(sheet._cueSheetName)[row._cueName]; } catch { continue; }
    if (!meta || !meta.file) continue;
    let bytes;
    try { bytes = store.bytes(meta.file); } catch { continue; }
    const ext = cueExtension(meta.file);
    await post(`/job/${jobId}/cue`, bytes, {
      "x-sound-id": String(soundId), "x-ext": ext, "x-cue-name": row._cueName,
      "x-sheet": sheet._cueSheetName, "x-sample-rate": String(meta.sampleRate || 48000),
      "x-samples": String(meta.samples || 0), "x-channels": String(meta.channels || 1),
      "x-categories": JSON.stringify(meta.categories || []),
      "x-loop-start": meta.loopStart == null ? "" : String(meta.loopStart),
      "x-loop-end": meta.loopEnd == null ? "" : String(meta.loopEnd),
    });
    cues[String(soundId)] = {
      file: `${soundId}.${cueExtension(meta.file)}`, cue: row._cueName, sheet: sheet._cueSheetName,
      sampleRate: meta.sampleRate || 48000, samples: meta.samples || 0, channels: meta.channels || 1,
      categories: meta.categories || [], loopStart: meta.loopStart ?? null, loopEnd: meta.loopEnd ?? null,
    };
  }
  return cues;
};

// Story sites (ournotes.story-manifest/2) keep each cue sheet beside its waveform. The engine's SoundManager resolves
// a sound row to its sheet, cue name and cue metadata; the file is the sheet's own `file`, so the host can upload it
// without the product layout StoryData reads.
const safeCueFile = (file) => {
  const name = String(file || "");
  return /^[A-Za-z0-9_.-]+$/.test(name) && !name.includes("..") ? name : "";
};

// The resolver of a site story: its sound rows name a cue sheet, whose cues.json sits beside the waveform under audio/.
// The cue metadata is folded in here because the recording manager reads `meta` from the resolve result.
const siteCueResolver = (store) => {
  const story = store.json("story.json");
  const episode = store.json(story.episode);
  return (soundId) => {
    const row = episode.sounds?.[String(soundId)];
    if (!row) throw new Error(`sound ${soundId} not in the episode`);
    const sheet = episode.cuesheets?.[String(row._soundCueSheetID)];
    if (!sheet?._cueSheetName) throw new Error(`cue sheet ${row._soundCueSheetID} not in the episode`);
    let meta = MISSING_CUE;
    try { meta = store.json(`audio/${sheet._cueSheetName}/cues.json`)[row._cueName] || MISSING_CUE; } catch { /* no sheet */ }
    return { sheet: sheet._cueSheetName, cue: row._cueName, category: row._category, meta };
  };
};

// The site engine's voices are real cue waveforms; decode the voice cues once on the page so MotionSync can analyze
// them on the virtual clock. SilentAudio keeps timing and the recording log; this subclass only adds the PCM source
// that the character's lip-sync controller pulls from (the same samples the real WebAudio player would output).
class SiteRecordingAudio extends RecordingAudio {
  constructor(resolve, loop, opts) {
    super(resolve, loop, opts);
    this._ctx = null;
    this._decoded = new Map();
    this._decodeAll = null;
  }

  _audioContext() {
    if (!this._ctx) {
      const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!Offline) return null;
      try { this._ctx = new Offline(1, 1, 48000); } catch { this._ctx = null; }
    }
    return this._ctx;
  }

  decodeVoices(soundIds) {
    if (this._decodeAll) return this._decodeAll;
    this._decodeAll = (async () => {
      const ctx = this._audioContext();
      if (!ctx || typeof ctx.decodeAudioData !== "function") return;
      for (const id of soundIds) {
        let c;
        try { c = this.cueOf(id); } catch { continue; }
        if (!c.meta || !c.meta.file || c.category !== 2) continue;     // SOUND_CATEGORY.Voice
        let bytes;
        try { bytes = this.assets.bytes(`audio/${c.sheet}/${c.meta.file}`); } catch { continue; }
        try {
          const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
          this._decoded.set(String(id), { data: buffer.getChannelData(0), sampleRate: buffer.sampleRate });
        } catch { /* a codec the browser lacks: that voice stays silent for lip sync */ }
      }
    })();
    return this._decodeAll;
  }

  async preload(soundIds) {
    await super.preload(soundIds);
    await this.decodeVoices(soundIds);
  }

  // The cue's channel-0 samples output up to the current virtual loop time. `info` is the play record SilentAudio
  // made; MotionSync pulls once per frame, so each pull is that frame's slice.
  pcmSource(info) {
    const dec = this._decoded.get(String(info.soundId));
    if (!dec) return { sampleRate: 48000, pull: () => new Float32Array(0) };
    const sr = dec.sampleRate;
    const startSec = Math.max(0, Number(info.startSec) || 0);
    const speed = Number(info.speed) > 0 ? Number(info.speed) : 1;
    let last = Math.min(dec.data.length, Math.round(startSec * sr));
    const at = () => {
      const sec = startSec + Math.max(0, this.loop.time - info.t0) * speed;
      return Math.min(dec.data.length, Math.round(sec * sr));
    };
    return {
      sampleRate: sr,
      pull: () => {
        const cur = at();
        const out = cur > last ? dec.data.subarray(last, cur) : new Float32Array(0);
        last = Math.max(last, cur);
        return out;
      },
      latest: (n) => {
        const cur = at(), from = Math.max(0, cur - Math.max(0, Math.round(n) || 0));
        return dec.data.subarray(from, cur);
      },
    };
  }

  async close() {
    const ctx = this._ctx;
    this._ctx = null;
    this._decoded.clear();
    if (ctx && ctx.close) { try { await ctx.close(); } catch { /* already closed */ } }
  }
}

const uploadCuesSite = async (jobId, store, audio) => {
  const story = store.json("story.json");
  const episode = store.json(story.episode);
  const cues = {};
  for (const soundId of Object.keys(episode.sounds || {})) {
    let c;
    try { c = audio.cueOf(soundId); } catch { continue; }
    const meta = c?.meta;
    const name = meta && safeCueFile(meta.file);
    if (!name) continue;
    let bytes;
    try { bytes = store.bytes(`audio/${c.sheet}/${name}`); } catch { continue; }
    const ext = cueExtension(name);
    await post(`/job/${jobId}/cue`, bytes, {
      "x-sound-id": String(soundId), "x-ext": ext, "x-cue-name": c.cue,
      "x-sheet": c.sheet, "x-sample-rate": String(meta.sampleRate || 48000),
      "x-samples": String(meta.samples || 0), "x-channels": String(meta.channels || 1),
      "x-categories": JSON.stringify(meta.categories || []),
      "x-loop-start": meta.loopStart == null ? "" : String(meta.loopStart),
      "x-loop-end": meta.loopEnd == null ? "" : String(meta.loopEnd),
    });
    cues[String(soundId)] = {
      file: `${soundId}.${ext}`, cue: c.cue, sheet: c.sheet,
      sampleRate: meta.sampleRate || 48000, samples: meta.samples || 0, channels: meta.channels || 1,
      categories: meta.categories || [], loopStart: meta.loopStart ?? null, loopEnd: meta.loopEnd ?? null,
    };
  }
  return cues;
};

const blobOf = (canvas, quality) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the canvas returned no JPEG"))), "image/jpeg", quality));

// A dependency-free smoke job: draws a moving gradient and posts frames. It checks the browser, the job server, the
// JPEG upload path and ffmpeg without needing a game site. Used by the host's tests and by `--smoke`.
const runSmoke = async (job) => {
  const t0 = performance.now();
  const width = Math.max(64, Math.round(job.width || 640));
  const height = Math.max(64, Math.round(job.height || 360));
  const fps = Math.max(1, Math.min(30, Math.round(job.fps || 30)));
  const count = Math.max(1, Math.min(90, Math.round(job.frames || 12)));
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  for (let n = 0; n < count; n++) {
    const g = ctx.createLinearGradient(0, 0, width, height);
    const p = n / Math.max(1, count - 1);
    g.addColorStop(0, `hsl(${Math.round(200 + p * 120)}, 70%, 45%)`);
    g.addColorStop(1, `hsl(${Math.round(320 + p * 60)}, 65%, 18%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = `bold ${Math.round(height / 8)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`ournotes smoke ${n + 1}/${count}`, width / 2, height / 2);
    const blob = await blobOf(canvas, 0.85);
    await post(`/job/${job.jobId}/frame`, blob, { "content-type": "image/jpeg", "x-frame": String(n) });
  }
  return { frames: count, fps, width, height, ended: true, storySeconds: count / fps, events: [], cues: {}, lines: [],
           seconds: Math.round((performance.now() - t0) / 100) / 10 };
};

export const run = async (job) => {
  if (job.kind === "smoke") return runSmoke(job);
  const t0 = performance.now();
  const width = Math.max(64, Math.round(job.width || 1300));
  const height = Math.max(64, Math.round(job.height || 600));
  const fps = Math.max(1, Math.min(30, Math.round(job.fps || 30)));
  const stepPerFrame = 30 % fps === 0 ? 30 / fps : 1;
  const outFps = 30 % fps === 0 ? fps : 30;
  const maxFrames = Math.max(1, Math.round((job.maxDurationSec || 600) * outFps));
  const settle = Math.max(0, Math.round(job.settleFrames || 0));

  console.log(`job ${job.jobId}: loading ${job.manifest}`);
  // Two data formats: the product layout of this package (0.2) and the published story-site layout that bdon.moe's
  // player serves (ournotes.story-manifest/2). The latter is rendered by the player version that reads it, which is
  // also the version the reference player uses, so both paths use the real StorySession, UI, scene and Live2D code.
  const siteEngine = !!job.siteEngine;
  const engine = siteEngine ? {
    assets: await import("/site-engine/src/story/assets.js"),
    session: await import("/site-engine/src/story/session.js"),
  } : null;
  const store = engine
    ? await engine.assets.loadStoryStore(job.manifest, { lang: job.lang || undefined })
    : await loadStoryStore(job.manifest, { lang: job.lang || undefined });
  let cues = {};
  if (!siteEngine) cues = await uploadCues(job.jobId, store, new StoryData(store));
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.append(canvas);
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false,
                                           premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("WebGL2 is not available in the browser");

  const events = [], lines = [];
  let uiFactory = null;
  if (job.fixtureUi && !siteEngine) {
    const fixture = await import("./fixture-ui.js");
    fixture.patchFixtureRendering();
    uiFactory = (gl, loop) => fixture.makeFixtureUI(gl, loop);
  }
  const siteResolve = siteEngine ? siteCueResolver(store) : null;
  const audioFactory = siteEngine
    ? (resolve, loop, { assets }) => new SiteRecordingAudio(siteResolve, loop, { assets, sounds: true })
    : (resolve, loop, { assets }) => new RecordingAudio(resolve, loop, { assets, sounds: true });
  const Session = engine ? engine.session.StorySession : StorySession;
  let sessionRef = null;
  // The site engine (0.1.8) has no HostActions of its own: the host runs a line's timed actions on its clock here.
  const scheduleSiteActions = (session, c) => {
    if (!siteEngine || !session || c.cmd !== "Talk" || !Array.isArray(c.HostActions) || !c.HostActions.length) return;
    const loop = session.loop, start = loop.time;
    let text = "", voice = 0;
    try { text = session.ctx.localize(c.AdvTextID) || ""; } catch { /* no text */ }
    for (const id of c.VoiceIDs || []) {
      try { const m = session.audio.cueOf(id).meta; if (m && m.sampleRate) voice = Math.max(voice, m.samples / m.sampleRate); }
      catch { /* no cue */ }
    }
    const typed = [...text].length * 0.04;
    const body = Math.max(1.6, voice ? voice + 0.6 : typed);
    const list = [...c.HostActions].filter((a) => a && Number.isFinite(a.at)).sort((a, b) => a.at - b.at);
    const run = async () => {
      for (const a of list) {
        while (!session.ended && loop.time < start + Math.max(0, Math.min(1, a.at)) * body)
          await loop.yield("Update");
        if (session.ended || loop.time > start + body + 0.1) return;
        const ch = session.characters.get(a.TargetName);
        if (!ch || !ch.isShowing) continue;
        if (a.MotionName) {
          session.core.motions.playMotion(ch, { TargetName: a.TargetName, MotionName: a.MotionName,
            ExpressionName: a.ExpressionName || "", MotionFadeIn: a.MotionFadeIn || 0 }, false);
        } else if (a.ExpressionName) {
          ch.playExpression(a.ExpressionName, a.MotionFadeIn || 0);
        }
        if (a.LookTargetPosition) {
          const target = session.ctx.session.positionToCharacter.get(a.LookTargetPosition);
          if (target && target.isAlive) {
            const head = target.headPosition(), own = ch.headPosition();
            ch.setLookEnabled(true);
            ch.smoothChangeToLook(Math.min(1, Math.max(-1, (head.x - own.x) * 0.2)),
                                  Math.min(1, Math.max(-1, head.y - own.y)), 0.2);
          }
        }
      }
    };
    run().catch(() => { /* the session ended or a model went away */ });
  };
  const s = await Session.create(gl, store, {
    lang: job.lang || undefined, auto: true, autoplay: true, voice: true, sound: true, seed: job.seed || 1,
    width, height, audio: audioFactory, ...(uiFactory ? { ui: uiFactory } : {}),
    onCommand: (c) => scheduleSiteActions(sessionRef, c),
    onLine: (e) => lines.push({ index: e.index, time: sessionRef ? Math.round(sessionRef.time * 1000) / 1000 : 0,
                                speaker: e.speaker, text: e.text }),
  });
  sessionRef = s;
  const audio = s.audio;
  if (siteEngine) cues = await uploadCuesSite(job.jobId, store, audio);
  let frames = 0, steps = 0, ended = false, storySeconds = 0;
  try {
    while (!s.ended && frames < maxFrames) {
      await s.step({ draw: false });
      steps++;
      if (steps % stepPerFrame !== 0 && !s.ended) continue;
      for (let i = 0; i < settle; i++) await s.step({ draw: false });
      s.render();
      const blob = await blobOf(canvas, Math.max(0.3, Math.min(1, (job.jpegQuality || 92) / 100)));
      await post(`/job/${job.jobId}/frame`, blob, { "content-type": "image/jpeg", "x-frame": String(frames) });
      frames++;
      if (frames % 300 === 0) console.log(`job ${job.jobId}: ${frames} frames, ${s.time.toFixed(1)} s of story`);
    }
    ended = s.ended;
    storySeconds = s.time;
    if (!frames) {
      s.render();
      const blob = await blobOf(canvas, 0.9);
      await post(`/job/${job.jobId}/frame`, blob, { "content-type": "image/jpeg", "x-frame": "0" });
      frames = 1;
    }
  } finally {
    await s.dispose();
    if (audio && typeof audio.close === "function") { try { await audio.close(); } catch { /* already closed */ } }
  }
  events.push(...(audio.events || []));
  const seconds = Math.round((performance.now() - t0) / 100) / 10;
  console.log(`job ${job.jobId}: ${frames} frames, ${ended ? "ended" : "stopped at the limit"}, ${events.length} audio events`);
  return { frames, fps: outFps, width, height, ended, storySeconds: Math.round(storySeconds * 1000) / 1000,
           events, cues, lines, seconds };
};
