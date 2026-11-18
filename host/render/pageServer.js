// The render page's local HTTP server: the package's modules, the story site with an in-memory overlay (the composed
// story, its fonts and TTS sounds), the page itself, and the job endpoints the page posts frames, cue audio and its
// report to. Binds 127.0.0.1 only.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
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
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".ttc": "font/collection",
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] || "application/octet-stream";
const encOf = (p) => (p.endsWith(".gz") ? "gzip" : p.endsWith(".br") ? "br" : null);
const JW = /^[a-z0-9][a-z0-9-]{2,80}$/;
const SOUND_EXT = new Set(["wav", "m4a", "mp3", "flac", "ogg", "aac", "opus", "bin"]);
const FONT_EXT_FORMAT = new Map([
  [".woff2", "woff2"], [".woff", "woff"], [".ttf", "truetype"], [".otf", "opentype"], [".ttc", "truetype"],
]);

const FONT_MATCHERS = [
  { re: /^NotoSansSC[-_.]|^NotoSansCJKsc[-_.]/i, family: "Noto Sans SC" },
  { re: /^NotoSerifSC[-_.]|^NotoSerifCJKsc[-_.]/i, family: "Noto Serif SC" },
  { re: /^NotoSansJP[-_.]|^NotoSansCJKjp[-_.]/i, family: "Noto Sans JP" },
  { re: /^NotoSerifJP[-_.]|^NotoSerifCJKjp[-_.]/i, family: "Noto Serif JP" },
  { re: /^NotoSansTC[-_.]|^NotoSansCJKtc[-_.]/i, family: "Noto Sans TC" },
  { re: /^NotoSerifTC[-_.]|^NotoSerifCJKtc[-_.]/i, family: "Noto Serif TC" },
  { re: /^NotoSansKR[-_.]|^NotoSansCJKkr[-_.]/i, family: "Noto Sans KR" },
  { re: /^NotoSerifKR[-_.]|^NotoSerifCJKkr[-_.]/i, family: "Noto Serif KR" },
  { re: /^NotoSans[-_.]/i, family: "Noto Sans" },
  { re: /^NotoSerif[-_.]/i, family: "Noto Serif" },
  { re: /^SourceHanSansSC/i, family: "Noto Sans SC", fallback: true },
  { re: /^SourceHanSansJP|^SourceHanSans/i, family: "Noto Sans JP", fallback: true },
  { re: /^SourceHanSerifSC/i, family: "Noto Serif SC", fallback: true },
  { re: /^SourceHanSerifJP|^SourceHanSerif/i, family: "Noto Serif JP", fallback: true },
  { re: /^MiSans/i, family: "Noto Sans SC", fallback: true },
  { re: /^NotoSansCJK/i, family: "Noto Sans SC", fallback: true },
];

const inferFontFace = (filename, explicit = false) => {
  const ext = path.extname(filename).toLowerCase();
  const format = FONT_EXT_FORMAT.get(ext);
  if (!format) return null;
  for (const m of FONT_MATCHERS) {
    if (m.re.test(filename)) return { family: m.family, format, fallback: !!m.fallback };
  }
  if (!explicit) return null;
  const stem = path.basename(filename, ext).replace(/[-_](VF|Regular|Bold|Medium|Light|Normal)$/i, "");
  return { family: stem.replace(/[_-]+/g, " ").trim() || "CustomCJK", format, fallback: false };
};

const weightOfFont = (filename) => {
  if (/[-_.]VF\b|Variable/i.test(filename)) return "100 900";
  if (/Bold/i.test(filename)) return "700";
  if (/Medium/i.test(filename)) return "500";
  return "400";
};

const scanFontDir = (dir, { explicit = false, depth = 0, maxDepth = 2, out = [] } = {}) => {
  if (!dir || depth > maxDepth || !fs.existsSync(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth) scanFontDir(full, { explicit, depth: depth + 1, maxDepth, out });
    } else if (e.isFile()) {
      const info = inferFontFace(e.name, explicit);
      if (info) out.push({ name: e.name, file: full, ...info });
    }
  }
  return out;
};

const fontRoutesCache = new Map();
export const clearFontRoutesCache = () => fontRoutesCache.clear();

const buildFontRoutes = ({ site = "", fontsDir = "" } = {}) => {
  const cacheKey = `${site ? path.resolve(site) : ""}\0${fontsDir ? path.resolve(fontsDir) : ""}`;
  if (fontRoutesCache.has(cacheKey)) return fontRoutesCache.get(cacheKey);
  const localDirs = [
    fontsDir ? path.resolve(fontsDir) : "",
    site ? path.join(site, "fonts") : "",
    path.join(PACKAGE_DIR, "host", "assets", "fonts"),
    path.join(PACKAGE_DIR, "resources", "fonts"),
    path.join(PACKAGE_DIR, "cache", "fonts"),
  ].filter(Boolean);
  const sysDirs = process.platform === "win32"
    ? [
        path.join(process.env.WINDIR || "C:\\Windows", "Fonts"),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts") : "",
      ].filter(Boolean)
    : process.platform === "darwin"
      ? ["/Library/Fonts", "/System/Library/Fonts", path.join(os.homedir(), "Library", "Fonts")]
      : ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".local", "share", "fonts"),
         path.join(os.homedir(), ".fonts")];

  const found = [];
  for (const dir of localDirs) scanFontDir(dir, { explicit: true, maxDepth: 2, out: found });
  for (const dir of sysDirs) scanFontDir(dir, { explicit: false, maxDepth: 3, out: found });

  const primaryFamilies = new Set(found.filter((f) => !f.fallback).map((f) => f.family));
  const files = new Map();
  const seenFamily = new Set();
  const rules = [];
  for (const item of found) {
    if (item.fallback && primaryFamilies.has(item.family)) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(item.name)) continue;
    const dedupKey = `${item.family}:${weightOfFont(item.name)}`;
    if (seenFamily.has(dedupKey)) continue;
    seenFamily.add(dedupKey);
    let routeName = item.name;
    if (files.has(routeName) && files.get(routeName) !== item.file) {
      const ext = path.extname(item.name);
      routeName = `${path.basename(item.name, ext)}-${files.size}${ext}`;
    }
    files.set(routeName, item.file);
    const safeFamily = item.family.replace(/["\\]/g, "");
    rules.push(
      `@font-face { font-family: "${safeFamily}"; src: url("/fonts/${encodeURIComponent(routeName)}") ` +
      `format("${item.format}"); font-weight: ${weightOfFont(item.name)}; font-style: normal; font-display: block; }`
    );
  }
  const result = { files, css: rules.join("\n") };
  fontRoutesCache.set(cacheKey, result);
  return result;
};

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

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

const send = (res, code, body, type = "text/plain", extra = {}, cacheControl = "no-store") => {
  res.writeHead(code, { "content-type": type, "cache-control": cacheControl, ...extra });
  res.end(body);
};

const sendFile = (res, file, type = null, cacheControl = "no-store") => {
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return send(res, 404, "not found");
    const headers = { "content-type": type || typeOf(file), "content-length": st.size, "cache-control": cacheControl };
    const enc = encOf(file);
    if (enc) headers["content-encoding"] = enc;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
};

// opts: { site, files: Map(logical site path -> Buffer|string), core, motionsync, outputDir, fontsDir, logger }
// -> { url, jobsDir, createJob(config), close() }
export const createPageServer = ({ site = "", files = new Map(), core = CUBISM_CORE_URL, motionsync = "",
                                   outputDir, fontsDir = "", logger = console }) => new Promise((resolve, reject) => {
  const jobs = new Map();
  const coreFile = core && !/^https?:\/\//i.test(core) ? path.resolve(core) : null;
  const motionFile = motionsync && !/^https?:\/\//i.test(motionsync) ? path.resolve(motionsync) : null;
  // an empty core string means "load none" (the smoke page needs no Live2D runtime)
  const coreUrl = core === "" ? "" : coreFile ? "/core.js" : (core || CUBISM_CORE_URL);
  const motionUrl = motionFile ? "/motionsync.js" : (motionsync || "");
  const fontRoutes = buildFontRoutes({ site, fontsDir });
  const jobsDir = path.join(outputDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>ournotes render</title>` +
    `<link rel="icon" href="data:,"><link rel="stylesheet" href="/fonts.css">` +
    `<style>html,body{margin:0;background:#000}canvas{display:block}</style></head>` +
    `<body>` + (coreUrl ? `<script src="${escapeAttr(coreUrl)}"></script>` : "") +
    (motionUrl ? `<script src="${escapeAttr(motionUrl)}"></script>` : "") +
    `<script type="module">import { run, reportResult } from "/host/render/page.js";` +
    `const id = new URLSearchParams(location.search).get("job") || "";` +
    `fetch("/job/"+encodeURIComponent(id)+".json").then(r=>{if(!r.ok)throw new Error("job: HTTP "+r.status);return r.json()})` +
    `.then(job=>run(job)).then(r=>reportResult(id,{ok:true,...r}))` +
    `.catch(e=>{console.error(e&&e.stack||String(e));return reportResult(id,{ok:false,error:String(e&&e.message||e),stack:String(e&&e.stack||"")}).catch(()=>{})})` +
    `;</script></body></html>`;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    try {
      // ---- job endpoints -----------------------------------------------------------------------------------
      const jobMatch = p.match(/^\/job\/([a-z0-9-]+)(\/[a-z0-9-]+)?(?:\.json)?$/);
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
          if (job.onFrame) {
            await job.onFrame(n, body);
            if (job.keepFrames) {
              await fs.promises.writeFile(path.join(job.framesDir, `${String(n).padStart(6, "0")}.jpg`), body);
            }
          } else {
            fs.writeFileSync(path.join(job.framesDir, `${String(n).padStart(6, "0")}.jpg`), body);
          }
          job.frames = Math.max(job.frames, n + 1);
          return send(res, 200, "ok");
        }
        if (what === "/cues-prepare" && req.method === "POST") {
          const body = await readBody(req, 4 * 1024 * 1024);
          let data;
          try { data = JSON.parse(body.toString("utf8")); } catch { return send(res, 400, "bad JSON"); }
          const cuesList = Array.isArray(data?.cues) ? data.cues : [];
          const missing = job.onPrepareCues
            ? await job.onPrepareCues(cuesList)
            : cuesList.map((c) => String(c?.soundId ?? ""));
          return send(res, 200, JSON.stringify({ ok: true, missing }), "application/json");
        }
        if (what === "/mp4start" && req.method === "POST") {
          const body = await readBody(req, 1024 * 1024);
          if (job.mp4Handle) { try { await job.mp4Handle.close(); } catch { /* ignore */ } }
          job.mp4Handle = await fs.promises.open(job.mp4File, "w");
          job.mp4Pos = 0;
          job.mp4Ready = false;
          job.mp4WriteChain = Promise.resolve();
          await job.mp4Handle.write(body, 0, body.length, 0);
          job.mp4Pos = body.length;
          return send(res, 200, "ok");
        }
        if (what === "/mp4chunk" && req.method === "POST") {
          if (!job.mp4Handle) return send(res, 409, "mp4 not started");
          const body = await readBody(req, 64 * 1024 * 1024);
          const writeOp = job.mp4WriteChain.then(async () => {
            if (!job.mp4Handle) throw new Error("mp4 closed");
            await job.mp4Handle.write(body, 0, body.length, job.mp4Pos);
            job.mp4Pos += body.length;
          });
          job.mp4WriteChain = writeOp.catch(() => {});
          await writeOp;
          return send(res, 200, "ok");
        }
        if (what === "/mp4finish" && req.method === "POST") {
          if (!job.mp4Handle) return send(res, 409, "mp4 not started");
          const mdatSizeOffset = Number(req.headers["x-mdat-size-offset"]);
          if (!Number.isInteger(mdatSizeOffset) || mdatSizeOffset < 8) return send(res, 400, "bad mdat offset");
          const body = await readBody(req, 32 * 1024 * 1024);
          if (body.length < 16) return send(res, 400, "bad finish payload");
          const mdatSizeBytes = body.subarray(0, 8);
          const moovBytes = body.subarray(8);
          const finishOp = job.mp4WriteChain.then(async () => {
            if (!job.mp4Handle) throw new Error("mp4 closed");
            await job.mp4Handle.write(moovBytes, 0, moovBytes.length, job.mp4Pos);
            job.mp4Pos += moovBytes.length;
            await job.mp4Handle.write(mdatSizeBytes, 0, 8, mdatSizeOffset);
            await job.mp4Handle.close();
            job.mp4Handle = null;
            job.mp4Ready = true;
          });
          job.mp4WriteChain = finishOp.catch(() => {});
          await finishOp;
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
          if (data.ok) job.resolve(data);
          else {
            // A bare "Failed to fetch" from the page is opaque; keep its stack in the host log for the next failure.
            logger.warn?.(`render page failed: ${data.error || "unknown error"}${data.stack ? `\n${data.stack}` : ""}`);
            job.reject(new Error(data.error || "render page failed"));
          }
          return;
        }
        return send(res, 404, "not found");
      }

      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
      if (p === "/page.html" || p === "/render.html") return send(res, 200, page, "text/html", {}, "no-store");
      if (p === "/fonts.css") return send(res, 200, fontRoutes.css, "text/css; charset=utf-8", {}, "public, max-age=3600");
      if (p.startsWith("/fonts/")) {
        const name = decodeURIComponent(p.slice(7));
        if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0"))
          return send(res, 403, "forbidden");
        const f = fontRoutes.files.get(name);
        return f ? sendFile(res, f, null, IMMUTABLE_CACHE) : send(res, 404, "font not found");
      }
      if (p === "/core.js" && coreFile) return sendFile(res, coreFile, null, IMMUTABLE_CACHE);
      if (p === "/motionsync.js" && motionFile) return sendFile(res, motionFile, null, IMMUTABLE_CACHE);

      // ---- the site: overlay first, then the base site -------------------------------------------------------
      if (p.startsWith("/site/")) {
        const rel = decodeURIComponent(p.slice(6));
        if (files.has(rel)) {
          const body = files.get(rel);
          return send(res, 200, body, typeOf(rel), {}, "no-store");
        }
        const f = site ? below(site, rel) : null;
        const siteCache = rel.startsWith("assets/") ? IMMUTABLE_CACHE : "no-store";
        return f ? sendFile(res, f, null, siteCache) : send(res, 404, "not found");
      }

      // ---- the published site-format engine, wherever the package manager put it -----------------------------
      if (p.startsWith(SITE_ENGINE_PREFIX)) {
        const rel = decodeURIComponent(p.slice(SITE_ENGINE_PREFIX.length));
        if (!SITE_ENGINE_DIR) return send(res, 404, "site engine is not installed");
        if (rel === "src/story/browser-font.js") {
          return sendFile(res, path.join(PACKAGE_DIR, "src", "story", "browser-font.js"), null, IMMUTABLE_CACHE);
        }
        const f = below(SITE_ENGINE_DIR, rel);
        return f ? sendFile(res, f, null, IMMUTABLE_CACHE) : send(res, 404, "site engine is not installed");
      }

      // ---- package files: the player sources, the page module and the site-format engine only ---------------
      // The site engine is the published package the reference player uses; only that package's source is served.
      const rel = decodeURIComponent(p.slice(1));
      if (!/^(src\/|host\/render\/|tests\/unit\/)/.test(rel))
        return send(res, 403, "forbidden");
      const f = below(PACKAGE_DIR, rel);
      return f ? sendFile(res, f, null, IMMUTABLE_CACHE) : send(res, 403, "forbidden");
    } catch (e) {
      logger.warn?.(`render page server: ${e.message}`);
      if (!res.headersSent) send(res, 500, e.message);
      else res.destroy();
    }
  });
  // The page reuses one connection for thousands of frame POSTs while the GPU is busy. Node's 5 s keep-alive closes
  // an idle socket just as Chrome picks it for the next upload, which fetch reports as "Failed to fetch" (observed
  // once in production, eight minutes into a render). Keep the socket far longer than any frame gap; headers must stay
  // above keep-alive so Node does not cut the connection while a request is being read.
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({
      url, jobsDir,
      createJob(config, hooks = {}) {
        const id = config.jobId || `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
        if (!JW.test(id)) throw new Error(`bad job id ${id}`);
        const dir = path.join(jobsDir, id);
        const framesDir = path.join(dir, "frames"), cuesDir = path.join(dir, "cues");
        const mp4File = path.join(dir, "video.mp4");
        if (!hooks.onFrame || hooks.keepFrames) fs.mkdirSync(framesDir, { recursive: true });
        fs.mkdirSync(cuesDir, { recursive: true });
        let resolveResult, rejectResult;
        const result = new Promise((r, j) => { resolveResult = r; rejectResult = j; });
        const job = {
          id, dir, framesDir, cuesDir, mp4File,
          config: { ...config, jobId: id }, frames: 0, progress: null,
          onFrame: hooks.onFrame || null,
          keepFrames: !!hooks.keepFrames,
          onPrepareCues: hooks.onPrepareCues || null,
          mp4Handle: null, mp4Pos: 0, mp4Ready: false, mp4WriteChain: Promise.resolve(),
          settled: false, result, resolve: resolveResult, reject: rejectResult,
        };
        jobs.set(id, job);
        return job;
      },
      removeJob(job) {
        if (job?.mp4Handle) {
          try { void job.mp4Handle.close().catch(() => {}); } catch { /* ignore */ }
          job.mp4Handle = null;
        }
        jobs.delete(job.id);
      },
      close() {
        return new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
      },
      server,
    });
  });
});
