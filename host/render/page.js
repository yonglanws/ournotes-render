// The page-side render job. It loads the composed story, uploads every cue file it may play, drives StorySession one
// fixed 1/30 s step at a time (no real-time audio), draws each frame to a canvas and posts it as JPEG, then reports the
// audio timeline and line timings. Nothing here depends on wall-clock speed, so the frames are deterministic.
import { loadStoryStore } from "/src/story/assets.js";
import { StoryData } from "/src/story/data.js";
import { MISSING_CUE } from "/src/engine/audio.js";
import { RecordingAudio } from "./recording-audio.js";
import { StorySession } from "/src/story/session.js";
import { collectDiscreteLayerParams, fadeCharacterMotion } from "/src/live2d/motion.js";
import { postWithRetry } from "/host/render/fetchRetry.js";
import { StreamingMp4Muxer } from "/host/render/mp4Muxer.js";

const mapLimit = async (items, limit, fn) => {
  if (!items.length) return;
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  }));
};

const post = async (url, body, headers = {}, { label = "", attempts = 3 } = {}) => {
  const response = await postWithRetry(fetch, url, body, headers, {
    label: label || url, attempts,
    onRetry: (attempt, error) =>
      console.warn(`retrying ${label || url}: attempt ${attempt} failed: ${error?.message || error}`),
  });
  // Drain the small "ok" body: an unread response keeps its connection out of Chrome's reuse pool.
  await response.arrayBuffer().catch(() => {});
  return response;
};

// A frame upload must survive a bad body, not just a bad socket. The JPEG starts as a Blob backed by Chrome's blob
// storage; under memory pressure a blob can become unreadable, and resending that same Blob fails every time (the
// production failures were three identical "Failed to fetch" in under a second while a string POST worked). Read the
// blob into an ArrayBuffer before the request and, on failure, re-encode the still-drawn canvas into a fresh Blob.
const uploadCanvasBytes = async (jobId, sourceCanvas, quality, index) => {
  let last = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const blob = await blobOf(sourceCanvas, quality);
    let bytes = null;
    try { bytes = await blob.arrayBuffer(); } catch (e) { last = e; }
    if (bytes && bytes.byteLength) {
      try {
        const response = await fetch(`/job/${jobId}/frame`, {
          method: "POST", headers: { "content-type": "image/jpeg", "x-frame": String(index) }, body: bytes,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text().catch(() => "")}`);
        await response.arrayBuffer().catch(() => {});
        return;
      } catch (e) { last = e; }
    }
    if (attempt < 4) {
      console.warn(`re-encoding frame ${index}: attempt ${attempt} failed: ${last?.message || last}`);
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  const detail = String(last?.message || last || "the canvas returned no JPEG");
  throw new Error(detail.startsWith(`frame ${index}`) ? `${detail} (after 4 encodes)` :
    `frame ${index}: ${detail} (after 4 encodes)`);
};

// The page's final report. The host learns a render's outcome only from this post, so retry it harder than a frame.
export const reportResult = (jobId, data) =>
  post(`/job/${encodeURIComponent(jobId)}/result`, JSON.stringify(data),
       { "content-type": "application/json" }, { label: `job ${jobId} result`, attempts: 4 });

// Frame progress is best effort: a failed report must never interrupt the render.
const reportProgress = (jobId, frames, storySeconds) => {
  void post(`/job/${encodeURIComponent(jobId)}/progress`,
            JSON.stringify({ frames, storySeconds: Math.round(storySeconds * 1000) / 1000 }),
            { "content-type": "application/json" }, { label: "progress", attempts: 1 }).catch(() => {});
};

const cueExtension = (file) => {
  const m = String(file || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : "bin";
  return ["wav", "m4a", "mp3", "flac", "ogg", "aac", "opus"].includes(ext) ? ext : "bin";
};

const collectCommandSoundRanks = (episode) => {
  const idRank = new Map();
  const cueRank = new Map();
  const commands = Array.isArray(episode?.commands) ? episode.commands : [];
  let seq = 0;
  const noteId = (v) => {
    if (v === null || v === undefined || v === "") return;
    const key = String(v);
    if (!idRank.has(key)) idRank.set(key, seq++);
  };
  const noteCue = (v) => {
    if (typeof v !== "string" || !v) return;
    if (!cueRank.has(v)) cueRank.set(v, seq++);
  };
  for (const row of commands) {
    if (!row || typeof row !== "object") continue;
    if (Array.isArray(row.VoiceIDs)) {
      for (const id of row.VoiceIDs) noteId(id);
    }
    if (row.SoundID !== undefined && row.SoundID !== null && row.SoundID !== 0 && row.SoundID !== "0") {
      noteId(row.SoundID);
    }
    if (row.cmd === "Bgm" || row.cmd === "Se" || row.cmd === "Voice") {
      noteCue(row.CueName);
      noteCue(row.Parameter1);
      noteCue(row.TargetAssetName);
      if (/^\d+$/.test(String(row.Parameter1 || ""))) noteId(row.Parameter1);
    }
  }
  return { idRank, cueRank };
};

const orderCueDescriptors = (episode, descriptors) => {
  if (!descriptors.length) return descriptors;
  const { idRank, cueRank } = collectCommandSoundRanks(episode);
  if (!idRank.size && !cueRank.size) {
    return descriptors.map((d) => ({ ...d, used: true }));
  }
  return descriptors
    .map((d, idx) => {
      const rank = idRank.get(d.soundId) ?? cueRank.get(d.cueName);
      const used = rank !== undefined;
      return { ...d, used, _order: used ? rank : 1_000_000 + idx };
    })
    .sort((a, b) => a._order - b._order);
};

const prepareHostCues = async (jobId, descriptors) => {
  if (!descriptors.length) return new Set();
  try {
    const response = await postWithRetry(fetch, `/job/${encodeURIComponent(jobId)}/cues-prepare`,
      JSON.stringify({
        cues: descriptors.map(({ soundId, ext, sourcePath, used }) => ({ soundId, ext, sourcePath, used: used !== false })),
      }),
      { "content-type": "application/json" }, { label: "cues-prepare", attempts: 2 });
    const data = await response.json();
    return new Set((data?.missing || []).map(String));
  } catch {
    return new Set(descriptors.map((d) => String(d.soundId)));
  }
};

const uploadMissingCues = async (jobId, store, cues, descriptors, { hostCueResolve = false } = {}) => {
  const needUpload = hostCueResolve
    ? await prepareHostCues(jobId, descriptors)
    : new Set(descriptors.map((d) => d.soundId));
  const toUpload = descriptors.filter((d) => needUpload.has(d.soundId));
  await mapLimit(toUpload, 4, async ({ soundId, ext, sourcePath, label, meta, cueName, sheetName }) => {
    let bytes;
    try { bytes = store.bytes(sourcePath); } catch { delete cues[soundId]; return; }
    await post(`/job/${jobId}/cue`, bytes, {
      "x-sound-id": soundId, "x-ext": ext, "x-cue-name": cueName,
      "x-sheet": sheetName, "x-sample-rate": String(meta.sampleRate || 48000),
      "x-samples": String(meta.samples || 0), "x-channels": String(meta.channels || 1),
      "x-categories": JSON.stringify(meta.categories || []),
      "x-loop-start": meta.loopStart == null ? "" : String(meta.loopStart),
      "x-loop-end": meta.loopEnd == null ? "" : String(meta.loopEnd),
    }, { label });
  });
  return cues;
};

const uploadCues = async (jobId, store, data, opts = {}) => {
  const cues = {};
  const descriptors = [];
  for (const [soundId, row] of Object.entries(data.episode.sounds || {})) {
    if (!row || row._cueName == null) continue;
    const sheet = data.cuesheets?.[row._soundCueSheetID];
    if (!sheet?._cueSheetName) continue;
    let meta;
    try { meta = data.cues(sheet._cueSheetName)[row._cueName]; } catch { continue; }
    if (!meta || !meta.file) continue;
    const ext = cueExtension(meta.file);
    cues[String(soundId)] = {
      file: `${soundId}.${ext}`, cue: row._cueName, sheet: sheet._cueSheetName,
      sampleRate: meta.sampleRate || 48000, samples: meta.samples || 0, channels: meta.channels || 1,
      categories: meta.categories || [], loopStart: meta.loopStart ?? null, loopEnd: meta.loopEnd ?? null,
    };
    descriptors.push({
      soundId: String(soundId), ext, sourcePath: meta.file, meta,
      cueName: row._cueName, sheetName: sheet._cueSheetName,
      label: `cue ${soundId} ${meta.file}`,
    });
  }
  return uploadMissingCues(jobId, store, cues, orderCueDescriptors(data.episode, descriptors), opts);
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
      const items = [];
      for (const id of soundIds) {
        let c;
        try { c = this.cueOf(id); } catch { continue; }
        if (!c.meta || !c.meta.file || c.category !== 2) continue;     // SOUND_CATEGORY.Voice
        items.push({ id: String(id), path: `audio/${c.sheet}/${c.meta.file}` });
      }
      await mapLimit(items, 6, async ({ id, path }) => {
        let bytes;
        try { bytes = this.assets.bytes(path); } catch { return; }
        try {
          const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
          this._decoded.set(id, { data: buffer.getChannelData(0), sampleRate: buffer.sampleRate });
        } catch { /* a codec the browser lacks: that voice stays silent for lip sync */ }
      });
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
    if (!dec) return { sampleRate: 48000, hasPcm: false, pull: () => new Float32Array(0) };
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
      hasPcm: true,
      pull: () => {
        const cur = at();
        const out = cur > last ? dec.data.subarray(last, cur) : new Float32Array(0);
        last = Math.max(last, cur);
        return out;
      },
      latest: (n) => {
        const rawCur = Math.round((startSec + Math.max(0, this.loop.time - info.t0) * speed) * sr);
        const to = Math.min(dec.data.length, rawCur);
        const from = Math.max(0, rawCur - Math.max(0, Math.round(n) || 0));
        return to > from ? dec.data.subarray(from, to) : new Float32Array(0);
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

const uploadCuesSite = async (jobId, store, cueOfOrAudio, opts = {}) => {
  const cueOf = typeof cueOfOrAudio === "function" ? cueOfOrAudio : (id) => cueOfOrAudio.cueOf(id);
  const story = store.json("story.json");
  const episode = store.json(story.episode);
  const cues = {};
  const descriptors = [];
  for (const soundId of Object.keys(episode.sounds || {})) {
    let c;
    try { c = cueOf(soundId); } catch { continue; }
    const meta = c?.meta;
    const name = meta && safeCueFile(meta.file);
    if (!name) continue;
    const sourcePath = `audio/${c.sheet}/${name}`;
    const ext = cueExtension(name);
    cues[String(soundId)] = {
      file: `${soundId}.${ext}`, cue: c.cue, sheet: c.sheet,
      sampleRate: meta.sampleRate || 48000, samples: meta.samples || 0, channels: meta.channels || 1,
      categories: meta.categories || [], loopStart: meta.loopStart ?? null, loopEnd: meta.loopEnd ?? null,
    };
    descriptors.push({
      soundId: String(soundId), ext, sourcePath, meta,
      cueName: c.cue, sheetName: c.sheet,
      label: `cue ${soundId} ${name}`,
    });
  }
  return uploadMissingCues(jobId, store, cues, orderCueDescriptors(episode, descriptors), opts);
};

const blobOf = (canvas, quality) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the canvas returned no JPEG"))), "image/jpeg", quality));

const MAX_IN_FLIGHT = 3;

const getGlRenderer = (gl) => {
  if (!gl) return "";
  try {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "") : "";
  } catch {
    return "";
  }
};

const probeWebCodecs = async ({ width, height, fps, captureMode, gpu, gl, watermark }) => {
  const mode = String(captureMode || "auto").toLowerCase();
  if (mode === "pipe" || watermark) return { useWebCodecs: false };
  if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function") return { useWebCodecs: false };
  const glRenderer = getGlRenderer(gl);
  const ua = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  const isLinux = /linux/i.test(ua);
  const isSoftwareGl = /swiftshader|llvmpipe|softpipe/i.test(glRenderer);
  if (mode === "auto") {
    if (isSoftwareGl) return { useWebCodecs: false };
    // Linux + NVIDIA (e.g. CMP 40HX without NVENC) or non-GPU hosts fall back to software OpenH264.
    if (isLinux && (!gpu || /nvidia/i.test(glRenderer))) return { useWebCodecs: false };
  }
  const bitrate = Math.max(1_500_000, Math.round(width * height * fps * 0.18));
  const codecs = ["avc1.640028", "avc1.4d4028", "avc1.42e028"];
  for (const codec of codecs) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec, width, height, bitrate, framerate: fps, hardwareAcceleration: "prefer-hardware",
      });
      if (!support?.supported || support.config?.hardwareAcceleration !== "prefer-hardware") continue;
      // Speed & hardware verification probe on 5 synthetic frames.
      const probeCanvas = Object.assign(document.createElement("canvas"), { width, height });
      const ctx = probeCanvas.getContext("2d", { alpha: false });
      let chunks = 0;
      let err = null;
      const enc = new VideoEncoder({
        output: () => { chunks++; },
        error: (e) => { err = e; },
      });
      enc.configure({
        codec, width, height, bitrate, framerate: fps,
        hardwareAcceleration: "prefer-hardware", latencyMode: "quality",
      });
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = `rgb(${i * 40}, 64, 128)`;
        ctx.fillRect(0, 0, width, height);
        const vf = new VideoFrame(probeCanvas, { timestamp: Math.round((i * 1_000_000) / fps) });
        enc.encode(vf, { keyFrame: i === 0 });
        vf.close();
      }
      await enc.flush();
      const elapsed = performance.now() - t0;
      enc.close();
      if (err || chunks < 5) continue;
      if (mode === "auto" && elapsed > 250) {
        console.log(`WebCodecs probe too slow (${elapsed.toFixed(1)} ms for 5 frames); keeping image2pipe`);
        return { useWebCodecs: false };
      }
      return { useWebCodecs: true, codec, bitrate };
    } catch { /* try next codec */ }
  }
  if (mode === "webcodecs") {
    console.warn("video.captureMode=webcodecs requested, but hardware VideoEncoder is unavailable; falling back to image2pipe");
  }
  return { useWebCodecs: false };
};

const createPipeCapture = ({ jobId, canvas, width, height, quality }) => {
  // Pool of MAX_IN_FLIGHT 2D snapshot canvases prevents tearing: frame N is synchronously blitted out of the
  // live WebGL canvas before s.render() runs for frame N+1, while JPEG encoding & HTTP upload overlap in flight.
  const freeSnapshots = Array.from({ length: MAX_IN_FLIGHT }, () => {
    const c = Object.assign(document.createElement("canvas"), { width, height });
    return { canvas: c, ctx: c.getContext("2d", { alpha: false }) };
  });
  const inFlight = new Set();
  let uploadError = null;

  return {
    mode: "pipe",
    async capture(index) {
      if (uploadError) throw uploadError;
      while (inFlight.size >= MAX_IN_FLIGHT) {
        await Promise.race(inFlight);
        if (uploadError) throw uploadError;
      }
      const snap = freeSnapshots.pop();
      snap.ctx.drawImage(canvas, 0, 0);
      const task = uploadCanvasBytes(jobId, snap.canvas, quality, index)
        .catch((e) => { if (!uploadError) uploadError = e; })
        .finally(() => {
          freeSnapshots.push(snap);
          inFlight.delete(task);
        });
      inFlight.add(task);
    },
    async finish() {
      await Promise.allSettled(inFlight);
      if (uploadError) throw uploadError;
    },
    abort() {},
  };
};

const createWebCodecsCapture = async ({ jobId, canvas, width, height, fps, codec, bitrate }) => {
  const muxer = new StreamingMp4Muxer({ width, height, fps });
  await post(`/job/${encodeURIComponent(jobId)}/mp4start`, muxer.headerBytes(),
             { "content-type": "application/octet-stream" }, { label: "mp4start", attempts: 3 });
  let chunkChain = Promise.resolve();
  let encError = null;
  let queuedChunks = 0;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const raw = new Uint8Array(chunk.byteLength);
      chunk.copyTo(raw);
      const sampleBytes = muxer.addSample({
        data: raw,
        isKey: chunk.type === "key",
        decoderConfig: meta?.decoderConfig || null,
      });
      queuedChunks++;
      const sendOp = chunkChain.then(() =>
        post(`/job/${encodeURIComponent(jobId)}/mp4chunk`, sampleBytes,
             { "content-type": "application/octet-stream" }, { label: "mp4chunk", attempts: 3 })
      ).catch((e) => {
        if (!encError) encError = e;
      }).finally(() => {
        queuedChunks--;
      });
      chunkChain = sendOp;
    },
    error: (e) => { if (!encError) encError = e; },
  });
  encoder.configure({
    codec, width, height, bitrate, framerate: fps,
    hardwareAcceleration: "prefer-hardware", latencyMode: "quality",
  });
  const gop = Math.max(1, fps * 2);

  return {
    mode: "webcodecs",
    async capture(index) {
      if (encError) throw encError;
      while (encoder.encodeQueueSize >= MAX_IN_FLIGHT || queuedChunks >= MAX_IN_FLIGHT * 2) {
        await new Promise((r) => setTimeout(r, 2));
        if (encError) throw encError;
      }
      const vf = new VideoFrame(canvas, { timestamp: Math.round((index * 1_000_000) / fps) });
      try {
        encoder.encode(vf, { keyFrame: index % gop === 0 });
      } finally {
        vf.close();
      }
    },
    async finish() {
      await encoder.flush();
      if (encoder.state !== "closed") encoder.close();
      await chunkChain;
      if (encError) throw encError;
      const { moov, mdatSizeOffset, mdatSizeBytes } = muxer.finish();
      const payload = new Uint8Array(8 + moov.length);
      payload.set(mdatSizeBytes, 0);
      payload.set(moov, 8);
      await post(`/job/${encodeURIComponent(jobId)}/mp4finish`, payload,
        { "content-type": "application/octet-stream", "x-mdat-size-offset": String(mdatSizeOffset) },
        { label: "mp4finish", attempts: 3 });
    },
    abort() {
      try { if (encoder.state !== "closed") encoder.close(); } catch { /* ignore */ }
    },
  };
};

const createCapturePipeline = async ({ jobId, canvas, width, height, fps, quality, captureMode, gpu, gl, watermark,
                                        probeOverride = null }) => {
  const probe = probeOverride || await probeWebCodecs({ width, height, fps, captureMode, gpu, gl, watermark });
  if (probe.useWebCodecs) {
    try {
      return await createWebCodecsCapture({ jobId, canvas, width, height, fps, codec: probe.codec, bitrate: probe.bitrate });
    } catch (e) {
      console.warn(`WebCodecs init failed (${e.message}); falling back to image2pipe`);
    }
  }
  return createPipeCapture({ jobId, canvas, width, height, quality });
};

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
  const capture = createPipeCapture({ jobId: job.jobId, canvas, width, height, quality: 0.85 });
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
    await capture.capture(n);
  }
  await capture.finish();
  return { frames: count, fps, width, height, ended: true, storySeconds: count / fps, events: [], cues: {}, lines: [],
           captureMode: capture.mode, seconds: Math.round((performance.now() - t0) / 100) / 10 };
};

const preloadBrowserFonts = async (store, warmedFonts = null) => {
  const fontsApi = globalThis.document?.fonts;
  if (!fontsApi) return;
  const families = new Set(['"Noto Sans SC"', '"Noto Serif SC"', '"Noto Sans JP"', '"Noto Serif JP"']);
  try {
    const doc = store?.has?.("ui/fonts.json") ? store.json("ui/fonts.json") : null;
    for (const f of Object.values(doc?.fonts || {})) {
      if (f?.browser?.family) families.add(String(f.browser.family));
    }
  } catch { /* no ui/fonts.json */ }
  const missing = warmedFonts ? [...families].filter((fam) => !warmedFonts.has(fam)) : [...families];
  if (!missing.length && warmedFonts?.size) return;
  if (typeof fontsApi.load === "function") {
    await Promise.all(missing.map((fam) =>
      Promise.resolve(fontsApi.load(`normal 64px ${fam}`, "あア漢한Aa0")).catch(() => {})
    ));
  }
  await fontsApi.ready;
  if (warmedFonts) for (const fam of missing) warmedFonts.add(fam);
};

const createGlContext = (width, height, warmState = null) => {
  let canvas = warmState?.canvas || null;
  let gl = warmState?.gl || null;
  if (canvas && gl && !gl.isContextLost?.()) {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    return { canvas, gl };
  }
  canvas = Object.assign(document.createElement("canvas"), { width, height });
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.append(canvas);
  gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false,
                                     premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("WebGL2 is not available in the browser");
  return { canvas, gl };
};

const makePcmRmsAnalyzer = (src) => ({
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

export const run = async (job, warmState = null) => {
  if (job.kind === "smoke") return runSmoke(job);
  const t0 = performance.now();
  const preset = String(job.preset || job.renderPreset || "standard").toLowerCase();
  const defaultW = preset === "best" ? 1920 : 1300;
  const defaultH = preset === "best" ? 886 : 600;
  const width = Math.max(64, Math.round(job.width || defaultW));
  const height = Math.max(64, Math.round(job.height || defaultH));
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
  const engine = siteEngine
    ? (warmState?.engine || {
      assets: await import("/site-engine/src/story/assets.js"),
      session: await import("/site-engine/src/story/session.js"),
    })
    : null;
  const store = engine
    ? await engine.assets.loadStoryStore(job.manifest, { lang: job.lang || undefined })
    : await loadStoryStore(job.manifest, { lang: job.lang || undefined });
  const hostCueResolve = job.hostCueResolve !== false;
  const siteResolve = siteEngine ? siteCueResolver(store) : null;
  // Overlap host cue resolution & FFmpeg decode warmup with browser font loading + Live2D/WebGL Session setup.
  const cuesPromise = siteEngine
    ? uploadCuesSite(job.jobId, store, siteResolve, { hostCueResolve })
    : uploadCues(job.jobId, store, new StoryData(store), { hostCueResolve });
  cuesPromise.catch(() => {});
  await preloadBrowserFonts(store, warmState?.warmedFonts);
  const { canvas, gl } = createGlContext(width, height, warmState);

  const events = [], lines = [], timeline = [];
  let uiFactory = null;
  if (job.fixtureUi && !siteEngine) {
    const fixture = await import("./fixture-ui.js");
    fixture.patchFixtureRendering();
    uiFactory = (gl, loop) => fixture.makeFixtureUI(gl, loop);
  }
  const audioFactory = siteEngine
    ? (resolve, loop, { assets }) => new SiteRecordingAudio(siteResolve, loop, { assets, sounds: true })
    : (resolve, loop, { assets }) => new RecordingAudio(resolve, loop, { assets, sounds: true });
  const Session = engine ? engine.session.StorySession : StorySession;
  let sessionRef = null;
  let currentTalkLength = 12;
  let cancelHostActions = null;
  // The site engine (0.1.8) has no HostActions of its own: the host runs a line's timed actions on its clock here.
  const scheduleSiteActions = (session, c) => {
    if (!siteEngine || !session || c.cmd !== "Talk") return;
    if (cancelHostActions) { cancelHostActions(); cancelHostActions = null; }
    if (!Array.isArray(c.HostActions) || !c.HostActions.length) return;
    const loop = session.loop, start = loop.time;
    let text = "", voice = 0;
    try { text = session.ctx.localize(c.AdvTextID) || ""; } catch { /* no text */ }
    for (const id of c.VoiceIDs || []) {
      try { const m = session.audio.cueOf(id).meta; if (m && m.sampleRate) voice = Math.max(voice, m.samples / m.sampleRate); }
      catch { /* no cue */ }
    }
    const plainText = String(text).replace(/<[^>]*>/g, "");
    const typed = [...plainText].length * 0.04;
    const body = Math.max(1.6, voice ? voice + 0.6 : typed);
    const list = [...c.HostActions].filter((a) => a && Number.isFinite(a.at)).sort((a, b) => a.at - b.at);
    let stopped = false;
    cancelHostActions = () => { stopped = true; };
    const run = async () => {
      for (const a of list) {
        while (!stopped && !session.ended && loop.time < start + Math.max(0, Math.min(1, a.at)) * body)
          await loop.yield("Update");
        if (stopped || session.ended || loop.time > start + body + 0.1) return;
        const ch = session.characters.get(a.TargetName);
        if (!ch || !ch.isShowing) continue;
        const fadeIn = a.MotionFadeIn ?? -1;
        if (a.MotionName) {
          session.core.motions.playMotion(ch, { TargetName: a.TargetName, MotionName: a.MotionName,
            ExpressionName: a.ExpressionName || "", MotionFadeIn: fadeIn }, false);
        } else if (a.ExpressionName) {
          ch.playExpression(a.ExpressionName, fadeIn);
        }
        if (a.LookTargetPosition === "stop" || a.LookTargetPosition === "Stop") {
          const dur = Math.max(0, Number(a.LookDuration ?? a.Duration ?? 0.2));
          ch.smoothChangeToLook(ch.originalLookX, ch.originalLookY, dur)
            .then(() => { if (ch.isAlive) ch.setLookEnabled(false); }).catch(() => {});
        } else if (a.LookTargetPosition) {
          const target = (session.core?.session || session.scene?.session)?.positionToCharacter?.get(a.LookTargetPosition);
          if (target && target.isAlive) {
            const head = target.headPosition(), own = ch.headPosition();
            const dur = Math.max(0, Number(a.LookDuration ?? a.Duration ?? 0.2));
            ch.setLookEnabled(true);
            ch.smoothChangeToLook(Math.min(1, Math.max(-1, (head.x - own.x) * 0.2)),
                                  Math.min(1, Math.max(-1, head.y - own.y)), dur);
          }
        }
        if (a.Look !== undefined && a.Look !== null) {
          if (a.Look === "stop" || a.Look === "Stop" || (typeof a.Look === "object" && !Array.isArray(a.Look) && a.Look.stop)) {
            const dur = Math.max(0, Number(a.Look?.duration ?? a.LookDuration ?? a.Duration ?? 0.2));
            ch.smoothChangeToLook(ch.originalLookX, ch.originalLookY, dur)
              .then(() => { if (ch.isAlive) ch.setLookEnabled(false); }).catch(() => {});
          } else {
            const lx = Array.isArray(a.Look) ? a.Look[0] : (a.Look.x ?? a.Look.Parameter1 ?? 0);
            const ly = Array.isArray(a.Look) ? a.Look[1] : (a.Look.y ?? a.Look.Parameter2 ?? 0);
            const dur = Math.max(0, Number((Array.isArray(a.Look) ? a.Look[2] : a.Look.duration) ??
              a.LookDuration ?? a.Duration ?? 0.2));
            ch.setLookEnabled(true);
            ch.smoothChangeToLook(Math.min(1, Math.max(-1, Number(lx) || 0)),
                                  Math.min(1, Math.max(-1, Number(ly) || 0)), dur);
          }
        }
        if (a.Angle !== undefined && a.Angle !== null) {
          const zDeg = Array.isArray(a.Angle) ? Number(a.Angle[0]) || 0
            : typeof a.Angle === "object" ? Number(a.Angle.zDeg ?? a.Angle.z ?? a.Angle.angle ?? 0) || 0
              : Number(a.Angle) || 0;
          const bodyDeg = typeof a.Angle === "object" && !Array.isArray(a.Angle)
            ? Number(a.Angle.body ?? a.Angle.x ?? 0) || 0 : Number(a.AngleBody ?? 0) || 0;
          const dur = Math.max(0, Number((Array.isArray(a.Angle) ? a.Angle[1] : a.Angle?.duration) ??
            a.AngleDuration ?? a.Duration ?? 0.5));
          ch.setOverrideAngleEnabled(true, true);
          ch.smoothRotateToAngle(zDeg, bodyDeg, dur);
        }
      }
    };
    run().catch(() => { /* the session ended or a model went away */ });
  };
  const s = await Session.create(gl, store, {
    lang: job.lang || undefined, auto: true, autoplay: true, voice: true, sound: true, seed: job.seed || 1,
    hideAutoIcon: true,
    width, height, audio: audioFactory, ...(uiFactory ? { ui: uiFactory } : {}),
    onCommand: (c) => {
      // The player calls this when the row actually starts, with the story clock at that moment. This is the
      // timeline the frame audit cuts against: no host-side duration model, only what the player did.
      if (c && Number.isInteger(c.i) && c.i >= 0) {
        const seconds = sessionRef ? sessionRef.time : 0;
        timeline.push({ i: c.i, cmd: c.cmd, seconds: Math.round(seconds * 1000) / 1000 });
      }
      if (c && c.cmd === "Talk" && c.AdvTextID && c.AdvTextID !== "0" && sessionRef) {
        let text = "", voiceSec = 0;
        try { text = sessionRef.ctx.localize(c.AdvTextID) || ""; } catch { /* no text */ }
        for (const id of c.VoiceIDs || []) {
          try {
            const m = sessionRef.audio.cueOf(id).meta;
            if (m && m.sampleRate) voiceSec = Math.max(voiceSec, m.samples / m.sampleRate);
          } catch { /* no cue */ }
        }
        const chars = [...String(text).replace(/<[^>]*>/g, "")].length;
        currentTalkLength = Math.max(1, chars, Math.ceil(voiceSec / 0.14));
      }
      scheduleSiteActions(sessionRef, c);
    },
    onLine: (e) => lines.push({ index: e.index, time: sessionRef ? Math.round(sessionRef.time * 1000) / 1000 : 0,
                                speaker: e.speaker, text: e.text }),
  });
  sessionRef = s;
  if (s.characters) {
    for (const ch of s.characters.values()) {
      if (!ch || ch.discreteLayerParams) continue;
      ch.discreteLayerParams = collectDiscreteLayerParams(ch.params);
      ch._fade = function _fadePatched() { return fadeCharacterMotion(this, this.discreteLayerParams); };
    }
  }
  if (siteEngine && s.ui) {
    // siteEngine (ournotes-player-site) does not read hideAutoIcon or defer opening ShowTitle past FadeIn.
    for (const w of s.ui.windows || []) {
      const talk = w?.talk;
      if (!talk) continue;
      if (talk.p?.autoIcon) s.ui.setActive(talk.p.autoIcon, false);
      if (typeof talk._showAutoIcon === "function") {
        talk._showAutoIcon = () => {
          if (talk.p?.autoIcon) s.ui.setActive(talk.p.autoIcon, false);
          talk._setAutoModeFlag(true);
        };
      }
    }
    let activeInitFade = null;
    if (typeof s.ui.fadeIn === "function" && typeof s.ui.showTitle === "function") {
      const origFadeIn = s.ui.fadeIn.bind(s.ui);
      const origShowTitle = s.ui.showTitle.bind(s.ui);
      let firstTitle = true;
      s.ui.fadeIn = (...args) => {
        const p = origFadeIn(...args);
        activeInitFade = p;
        return p;
      };
      s.ui.showTitle = async (...args) => {
        if (firstTitle) {
          firstTitle = false;
          await Promise.resolve();
          if (activeInitFade) {
            try { await activeInitFade; } finally { activeInitFade = null; }
          }
        }
        return origShowTitle(...args);
      };
    }
  }
  const crilips = s.ctx?.story?.crilips ?? s.story?.crilips;
  if (siteEngine && s.characters && !crilips) {
    for (const ch of s.characters.values()) {
      if (!ch || ch.isMotionSyncEnabled !== false) continue;
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
        if (ch.isLipSyncEnabled) ch.startTimedPseudoLipSync(currentTalkLength, s.speed ? s.speed / 10 : 1, 1);
      };
      ch.setLipSyncEnabled = (flag, usePseudo = false) => {
        origSetEnabled(flag, usePseudo);
        if (flag && !usePseudo && needsPseudo) {
          ch.startTimedPseudoLipSync(currentTalkLength, s.speed ? s.speed / 10 : 1, 1);
        } else if (!flag) {
          needsPseudo = false;
          ch.stopTimedPseudoLipSync();
        }
      };
    }
  }
  const audio = s.audio;
  let cues;
  try {
    cues = await cuesPromise;
  } catch (e) {
    try { await s.dispose(); } catch { /* ignore */ }
    if (audio && typeof audio.close === "function") { try { await audio.close(); } catch { /* already closed */ } }
    throw e;
  }
  const quality = Math.max(0.3, Math.min(1, (job.jpegQuality || 98) / 100));
  const captureMode = job.captureMode || "auto";
  const watermark = job.watermark || "";
  const probeKey = `${width}x${height}@${outFps}:${captureMode}:${!!job.gpu}`;
  const probeOverride = (!watermark && warmState?.probeKey === probeKey) ? warmState.probe : null;
  const capture = await createCapturePipeline({
    jobId: job.jobId, canvas, width, height, fps: outFps, quality,
    captureMode, gpu: !!job.gpu, gl, watermark, probeOverride,
  });
  let frames = 0, steps = 0, ended = false, storySeconds = 0, videoStart = null;
  try {
    while (!s.ended && frames < maxFrames) {
      await s.step({ draw: false });
      steps++;
      if (steps % stepPerFrame !== 0 && !s.ended) continue;
      for (let i = 0; i < settle; i++) await s.step({ draw: false });
      if (frames === 0) videoStart = s.time;                 // the story clock at the first encoded frame
      s.render();
      await capture.capture(frames);
      frames++;
      if (frames % 60 === 0) reportProgress(job.jobId, frames, s.time);
      if (frames % 300 === 0) console.log(`job ${job.jobId}: ${frames} frames, ${s.time.toFixed(1)} s of story`);
    }
    ended = s.ended;
    storySeconds = s.time;
    if (!frames) {
      if (videoStart == null) videoStart = s.time;
      s.render();
      await capture.capture(0);
      frames = 1;
    }
    await capture.finish();
  } catch (e) {
    capture.abort();
    throw e;
  } finally {
    if (cancelHostActions) cancelHostActions();
    await s.dispose();
    if (audio && typeof audio.close === "function") { try { await audio.close(); } catch { /* already closed */ } }
  }
  events.push(...(audio.events || []));
  // The MP4 starts at the first captured frame, which is later than story time 0 (model warmup and loading steps run
  // before the capture loop). The audit cuts against the video, so shift the command, line and audio clocks by that pre-roll.
  const start = videoStart == null ? 0 : videoStart;
  const toVideo = (value) => Math.max(0, Math.round((value - start) * 1000) / 1000);
  for (const entry of timeline) { entry.storySeconds = entry.seconds; entry.seconds = toVideo(entry.seconds); }
  for (const line of lines) { line.storyTime = line.time; line.time = toVideo(line.time); }
  for (const event of events) {
    event.storyT = event.t;
    if (event.t >= start) {
      event.t = +(event.t - start).toFixed(6);
    } else {
      event.offsetSeconds = +(((event.offsetSeconds || 0) + (start - event.t)).toFixed(6));
      event.t = 0;
    }
  }
  const seconds = Math.round((performance.now() - t0) / 100) / 10;
  console.log(`job ${job.jobId}: ${frames} frames, ${ended ? "ended" : "stopped at the limit"}, ${events.length} audio events`);
  return { frames, fps: outFps, width, height, ended, storySeconds: Math.round(storySeconds * 1000) / 1000,
           videoStart: Math.round(start * 1000) / 1000, events, cues, lines, timeline,
           captureMode: capture.mode, seconds };
};

export const runWarm = async (warmId) => {
  const res = await fetch(`/warm/${encodeURIComponent(warmId)}/config.json`);
  if (res.status === 410 || !res.ok) return null;
  const cfg = await res.json();
  const width = Math.max(64, Math.round(cfg.width || 1300));
  const height = Math.max(64, Math.round(cfg.height || 600));
  const fps = Math.max(1, Math.min(30, Math.round(cfg.fps || 30)));
  const outFps = 30 % fps === 0 ? fps : 30;
  const captureMode = cfg.captureMode || "auto";
  const gpu = !!cfg.gpu;
  const warmedFonts = new Set();
  const enginePromise = cfg.siteEngine
    ? Promise.all([
        import("/site-engine/src/story/assets.js"),
        import("/site-engine/src/story/session.js"),
      ]).then(([assets, session]) => ({ assets, session }))
    : Promise.resolve(null);
  const fontsPromise = preloadBrowserFonts(null, warmedFonts).catch(() => {});
  const { canvas, gl } = createGlContext(width, height);
  const probeKey = `${width}x${height}@${outFps}:${captureMode}:${gpu}`;
  // Load modules and webfonts before probing WebCodecs so main-thread parse/decode work does not skew probe timing.
  const [engine] = await Promise.all([enginePromise, fontsPromise]);
  const probeResult = await probeWebCodecs({
    width, height, fps: outFps, captureMode, gpu, gl, watermark: "",
  }).catch(() => null);
  const warmState = { engine, canvas, gl, warmedFonts, probeKey, probe: probeResult };

  let jobRes;
  try {
    jobRes = await fetch(`/warm/${encodeURIComponent(warmId)}/job`);
  } catch {
    return null;
  }
  if (jobRes.status === 410 || !jobRes.ok) return null;
  const payload = await jobRes.json();
  if (!payload?.jobId) return null;
  const jobId = payload.jobId;
  try {
    const jr = await fetch(`/job/${encodeURIComponent(jobId)}.json`);
    if (!jr.ok) throw new Error(`job: HTTP ${jr.status}`);
    const job = await jr.json();
    const result = await run(job, warmState);
    return { jobId, result };
  } catch (e) {
    if (e && typeof e === "object") e.jobId = jobId;
    throw e;
  }
};
