// The render page's local HTTP server: the package's modules, the story site with an in-memory overlay (the composed
// story, its fonts and TTS sounds), the page itself, and the job endpoints the page posts frames, cue audio and its
// report to. Binds 127.0.0.1 only.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = path.resolve(HOST_DIR, "../..");
export const CUBISM_CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";

const require = createRequire(import.meta.url);
// Resolve the published site-format engine through Node rather than assuming host/node_modules: npm workspaces,
// pnpm and a global install all put it somewhere else. The page imports it from the stable /site-engine/ prefix.
export const SITE_ENGINE_DIR = (() => {
  try {
    return path.resolve(path.dirname(require.resolve("ournotes-player-site")), "..");
  } catch {
    return "";
  }
})();
const SITE_ENGINE_PREFIX = "/site-engine/";

const TYPES = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".html": "text/html",
  ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".glsl": "text/plain", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".aac": "audio/aac", ".map": "application/json", ".bin": "application/octet-stream",
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] || "application/octet-stream";
const encOf = (p) => (p.endsWith(".gz") ? "gzip" : p.endsWith(".br") ? "br" : null);
const JW = /^[a-z0-9][a-z0-9-]{2,80}$/;
const SOUND_EXT = new Set(["wav", "m4a", "mp3", "flac", "ogg", "aac", "opus", "bin"]);

const below = (dir, rel) => {
  const parts = String(rel).split("/");
  if (parts.some((x) => x === ".." || x === "." || x.includes("\\") || x.includes("\0"))) return null;
  return path.join(dir, ...parts.filter(Boolean));
};

const readBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > limit) { reject(new Error(`body larger than ${limit} bytes`)); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => resolve(Buffer.concat(chunks)));
  req.on("error", reject);
});

const send = (res, code, body, type = "text/plain", extra = {}) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra });
  res.end(body);
};

const sendFile = (res, file, type = null) => {
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return send(res, 404, "not found");
    const headers = { "content-type": type || typeOf(file), "content-length": st.size, "cache-control": "no-store" };
    const enc = encOf(file);
    if (enc) headers["content-encoding"] = enc;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
};

// opts: { site, files: Map(logical site path -> Buffer|string), core, motionsync, outputDir, logger }
// -> { url, jobsDir, createJob(config), close() }
export const createPageServer = ({ site = "", files = new Map(), core = CUBISM_CORE_URL, motionsync = "",
                                   outputDir, logger = console }) => new Promise((resolve, reject) => {
  const jobs = new Map();
  const coreFile = core && !/^https?:\/\//i.test(core) ? path.resolve(core) : null;
  const motionFile = motionsync && !/^https?:\/\//i.test(motionsync) ? path.resolve(motionsync) : null;
  // an empty core string means "load none" (the smoke page needs no Live2D runtime)
  const coreUrl = core === "" ? "" : coreFile ? "/core.js" : (core || CUBISM_CORE_URL);
  const motionUrl = motionFile ? "/motionsync.js" : (motionsync || "");
  const jobsDir = path.join(outputDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>ournotes render</title>` +
    `<link rel="icon" href="data:,"><style>html,body{margin:0;background:#000}canvas{display:block}</style></head>` +
    `<body>` + (coreUrl ? `<script src="${escapeAttr(coreUrl)}"></script>` : "") +
    (motionUrl ? `<script src="${escapeAttr(motionUrl)}"></script>` : "") +
    `<script type="module">import { run } from "/host/render/page.js";` +
    `const id = new URLSearchParams(location.search).get("job") || "";` +
    `fetch("/job/"+encodeURIComponent(id)+".json").then(r=>{if(!r.ok)throw new Error("job: HTTP "+r.status);return r.json()})` +
    `.then(job=>run(job)).then(r=>fetch("/job/"+encodeURIComponent(id)+"/result",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ok:true,...r})}))` +
    `.catch(e=>{console.error(e&&e.stack||String(e));return fetch("/job/"+encodeURIComponent(id)+"/result",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ok:false,error:String(e&&e.message||e),stack:String(e&&e.stack||"")})}).catch(()=>{})})` +
    `;</script></body></html>`;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    try {
      // ---- job endpoints -----------------------------------------------------------------------------------
      const jobMatch = p.match(/^\/job\/([a-z0-9-]+)(\/[a-z]+)?(?:\.json)?$/);
      if (jobMatch) {
        const [, jobId, what] = jobMatch;
        const job = jobs.get(jobId);
        if (!job) return send(res, 404, "unknown job", "text/plain");
        if (p.endsWith(".json") && req.method === "GET") return send(res, 200, JSON.stringify(job.config), "application/json");
        if (what === "/frame" && req.method === "POST") {
          const n = Number(req.headers["x-frame"]);
          if (!Number.isInteger(n) || n < 0 || n > 2_000_000) return send(res, 400, "bad frame number");
          const body = await readBody(req, 16 * 1024 * 1024);
          if (!body.length || body[0] !== 0xff || body[1] !== 0xd8) return send(res, 400, "not a JPEG");
          fs.writeFileSync(path.join(job.framesDir, `${String(n).padStart(6, "0")}.jpg`), body);
          job.frames = Math.max(job.frames, n + 1);
          return send(res, 200, "ok");
        }
        if (what === "/cue" && req.method === "POST") {
          const soundId = String(req.headers["x-sound-id"] || "");
          if (!/^\d{1,16}$/.test(soundId)) return send(res, 400, "bad sound id");
          const ext = String(req.headers["x-ext"] || "bin").toLowerCase();
          if (!SOUND_EXT.has(ext)) return send(res, 400, "bad extension");
          const body = await readBody(req, 64 * 1024 * 1024);
          fs.writeFileSync(path.join(job.cuesDir, `${soundId}.${ext}`), body);
          return send(res, 200, "ok");
        }
        if (what === "/progress" && req.method === "POST") {
          const body = await readBody(req, 16 * 1024);
          let data;
          try { data = JSON.parse(body.toString("utf8")); } catch { return send(res, 400, "bad JSON"); }
          const frames = Math.max(0, Math.min(2_000_000, Math.round(Number(data.frames) || 0)));
          const storySeconds = Math.max(0, Math.min(86_400, Number(data.storySeconds) || 0));
          job.progress = { frames, storySeconds, at: Date.now() };
          return send(res, 200, "ok");
        }
        if (what === "/result" && req.method === "POST") {
          const body = await readBody(req, 8 * 1024 * 1024);
          let data;
          try { data = JSON.parse(body.toString("utf8")); } catch { return send(res, 400, "bad JSON"); }
          if (job.settled) return send(res, 409, "already reported");
          job.settled = true;
          send(res, 200, "ok");
          if (data.ok) job.resolve(data); else job.reject(new Error(data.error || "render page failed"));
          return;
        }
        return send(res, 404, "not found");
      }

      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
      if (p === "/page.html") return send(res, 200, page, "text/html");
      if (p === "/core.js" && coreFile) return sendFile(res, coreFile);
      if (p === "/motionsync.js" && motionFile) return sendFile(res, motionFile);

      // ---- the site: overlay first, then the base site -------------------------------------------------------
      if (p.startsWith("/site/")) {
        const rel = decodeURIComponent(p.slice(6));
        if (files.has(rel)) {
          const body = files.get(rel);
          return send(res, 200, body, typeOf(rel));
        }
        const f = site ? below(site, rel) : null;
        return f ? sendFile(res, f) : send(res, 404, "not found");
      }

      // ---- the published site-format engine, wherever the package manager put it -----------------------------
      if (p.startsWith(SITE_ENGINE_PREFIX)) {
        const rel = decodeURIComponent(p.slice(SITE_ENGINE_PREFIX.length));
        const f = SITE_ENGINE_DIR ? below(SITE_ENGINE_DIR, rel) : null;
        return f ? sendFile(res, f) : send(res, 404, "site engine is not installed");
      }

      // ---- package files: the player sources, the page module and the site-format engine only ---------------
      // The site engine is the published package the reference player uses; only that package's source is served.
      const rel = decodeURIComponent(p.slice(1));
      if (!/^(src\/|host\/render\/|tests\/unit\/)/.test(rel))
        return send(res, 403, "forbidden");
      const f = below(PACKAGE_DIR, rel);
      return f ? sendFile(res, f) : send(res, 403, "forbidden");
    } catch (e) {
      logger.warn?.(`render page server: ${e.message}`);
      if (!res.headersSent) send(res, 500, e.message);
      else res.destroy();
    }
  });
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({
      url, jobsDir,
      createJob(config) {
        const id = config.jobId || `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
        if (!JW.test(id)) throw new Error(`bad job id ${id}`);
        const dir = path.join(jobsDir, id);
        const framesDir = path.join(dir, "frames"), cuesDir = path.join(dir, "cues");
        fs.mkdirSync(framesDir, { recursive: true });
        fs.mkdirSync(cuesDir, { recursive: true });
        let resolveResult, rejectResult;
        const result = new Promise((r, j) => { resolveResult = r; rejectResult = j; });
        const job = { id, dir, framesDir, cuesDir, config: { ...config, jobId: id }, frames: 0, progress: null,
                      settled: false, result, resolve: resolveResult, reject: rejectResult };
        jobs.set(id, job);
        return job;
      },
      removeJob(job) { jobs.delete(job.id); },
      close() {
        return new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
      },
      server,
    });
  });
});
