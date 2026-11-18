// A headless Chrome (or Chromium, or Edge) of the story author's own: a temporary profile, driven over the DevTools
// protocol with Node's WebSocket. WebGL2 runs on SwiftShader unless `gpu` is set, so pictures come out the same on
// machines without a GPU. close() ends this browser only and removes its profile.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = {
  win32: [
    ...["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].filter((v) => process.env[v]).flatMap((v) => [
      path.join(process.env[v], "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env[v], "Chromium", "Application", "chrome.exe"),
      path.join(process.env[v], "Microsoft", "Edge", "Application", "msedge.exe"),
    ]),
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
           "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"],
};

const onPath = (name) => {
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    const f = path.join(d, name);
    if (d && fs.existsSync(f)) return f;
  }
  return null;
};

// The browser executable: `given` (a path), else CHROME_PATH, else the first installed of CANDIDATES. Throws when
// none is found.
export const findBrowser = (given = process.env.CHROME_PATH) => {
  if (given) {
    if (!fs.existsSync(given)) throw new Error(`browser not found: ${given}`);
    return given;
  }
  for (const c of CANDIDATES[process.platform] || CANDIDATES.linux) {
    const f = path.isAbsolute(c) ? (fs.existsSync(c) ? c : null) : onPath(c);
    if (f) return f;
  }
  throw new Error("no Chrome, Chromium or Edge found: pass --chrome <path> or set CHROME_PATH");
};

const waitFor = async (what, test, ms) => {
  const t0 = Date.now();
  for (;;) {
    const v = test();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`the browser did not ${what} within ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

export class Browser {
  constructor() {
    // Resolves when the process exits or the DevTools socket closes. The renderer races it against the page's
    // result so a crashed browser fails the task immediately instead of waiting for render.taskTimeoutMs.
    this.closedSignal = new Promise((resolve) => { this._resolveClosed = resolve; });
  }

  /** resolves once the browser process or its DevTools connection is gone */
  onClosed() { return this.closedSignal; }

  // opts: executable, gpu, width / height (window size), extraArgs (operator Chrome flags, e.g. --use-angle=vulkan on
  // a Linux host whose default ANGLE device is SwiftShader), onConsole(type, text): the page's console and its
  // uncaught errors, onNetworkError(errorText, resourceType): Chrome's own reason for a failed request,
  // onExit(code, signal, stderrTail): an unexpected browser exit and the end of its stderr
  static async launch({ executable = findBrowser(), gpu = false, width = 1300, height = 600, extraArgs = [],
                        onConsole = null, onNetworkError = null, onExit = null } = {}) {
    const b = new Browser();
    b.profile = fs.mkdtempSync(path.join(os.tmpdir(), "story-author-"));
    const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${b.profile}`, "--no-first-run",
                  "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--hide-scrollbars",
                  "--enable-logging=stderr", `--window-size=${width},${height}`,
                  ...(gpu ? [] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]),
                  ...extraArgs, "about:blank"];
    b.proc = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    b.stderrTail = () => stderrTail;
    b.proc.stderr?.on("data", (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-16384); });
    b.exited = new Promise((r) => b.proc.once("exit", (code, signal) => {
      // close() ends the browser on purpose; only an exit the host did not ask for is worth a warning.
      if (!b._closing && onExit) {
        try { onExit(code, signal, stderrTail); } catch { /* diagnostics must not mask the exit */ }
      }
      r(code);
    }));
    b.exited.then(() => b._resolveClosed?.());
    b.proc.once("error", () => {});
    try {
      const portFile = path.join(b.profile, "DevToolsActivePort");
      const port = await waitFor("start", () => {
        if (b.proc.exitCode !== null) throw new Error(`the browser exited (${b.proc.exitCode}): ${executable}`);
        if (!fs.existsSync(portFile)) return null;
        const p = fs.readFileSync(portFile, "utf8").split("\n")[0];
        return p ? Number(p) : null;
      }, 30000);
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (!page) throw new Error("the browser has no page");
      await b._connect(page.webSocketDebuggerUrl, onConsole, onNetworkError);
      b.browserUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch (e) {
      await b.close();
      throw e;
    }
    return b;
  }

  async _connect(url, onConsole, onNetworkError = null) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("cannot connect to the browser")), { once: true });
    });
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
        return;
      }
      if (onConsole && m.method === "Runtime.consoleAPICalled")
        onConsole(m.params.type, m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || "")).join(" "));
      if (onConsole && m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        onConsole("error", (d.exception && d.exception.description) || d.text);
      }
      if (onNetworkError && m.method === "Network.loadingFailed" && !m.params.canceled)
        onNetworkError(m.params.errorText || "unknown error", m.params.type || "");
      if (onConsole && m.method === "Inspector.targetCrashed")
        onConsole("error", "the render page crashed");
      if (onConsole && m.method === "Inspector.detached")
        onConsole("error", `the render page detached: ${m.params.reason || "unknown"}`);
      for (const w of [...this.waiters]) if (w.method === m.method) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m.params); }
    });
    this.ws.addEventListener("close", () => {
      if (onConsole && !this._closing) {
        const code = this.proc?.exitCode, sig = this.proc?.signalCode;
        const tail = this.stderrTail ? this.stderrTail().trim() : "";
        onConsole("error", `DevTools socket closed (process exitCode=${code}, signal=${sig || "-"})` +
                           (tail ? `\n${tail}` : ""));
      }
      for (const p of this.pending.values()) p.reject(new Error("the browser closed"));
      this.pending.clear();
      this._resolveClosed?.();
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    try { await this.send("Inspector.enable"); }
    catch (e) { onConsole?.("error", `Inspector.enable failed: ${e.message}`); }
    // Off by default: on this host, enabling the Network domain makes Chrome close the DevTools session partway
    // through a three-model story's cue uploads (the browser process stays alive, so the render dies with "browser
    // closed"). It reproduced with and without buffer caps and stopped once the domain was not enabled. Set
    // OURNOTES_CDP_NETWORK=1 only while debugging a specific failed request.
    if (onNetworkError && process.env.OURNOTES_CDP_NETWORK === "1") await this.send("Network.enable", {
      maxTotalBufferSize: 8 * 1024 * 1024,
      maxResourceBufferSize: 1 * 1024 * 1024,
      maxPostDataSize: 1 * 1024 * 1024,
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  event(method) { return new Promise((resolve) => this.waiters.push({ method, resolve })); }

  async navigate(url) {
    const loaded = this.event("Page.loadEventFired");
    const r = await this.send("Page.navigate", { url });
    if (r.errorText) throw new Error(`${url}: ${r.errorText}`);
    await loaded;
  }

  // the value of an expression (a promise is awaited); throws the page's exception, or after `timeout` seconds
  async evaluate(expression, timeout = 0) {
    let timer = null;
    const run = this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const limit = timeout > 0 ? new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the page did not finish within ${timeout} s`)), timeout * 1000);
    }) : null;
    try {
      const r = await (limit ? Promise.race([run, limit]) : run);
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      return r.result.value;
    } finally { clearTimeout(timer); }
  }

  // ends the browser (Browser.close, then the process if it is still running) and removes its profile
  async close() {
    if (this.closed) return;
    this.closed = true;
    this._closing = true;
    try { if (this.ws) this.ws.close(); } catch (_) { /* already closed */ }
    if (this.proc && this.proc.exitCode === null) {
      if (this.browserUrl) {
        try {
          const ws = new WebSocket(this.browserUrl);
          await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
          ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        } catch (_) { /* the process is ended below */ }
      }
      const done = await Promise.race([this.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
      if (!done) { this.proc.kill(); await this.exited; }
    }
    for (let i = 0; i < 20 && this.profile && fs.existsSync(this.profile); i++) {
      try { await fs.promises.rm(this.profile, { recursive: true, force: true }); break; }
      catch (_) { await new Promise((r) => setTimeout(r, 250)); }
    }
  }
}

const cdpSend = (ws, idRef, pending, method, params = {}) => new Promise((resolve, reject) => {
  const id = ++idRef.id;
  pending.set(id, { resolve, reject, method });
  ws.send(JSON.stringify({ id, method, params }));
});

const openCdpWs = async (url) => {
  const ws = new WebSocket(url);
  const idRef = { id: 0 };
  const pending = new Map();
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("cannot connect to the browser")), { once: true });
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (!m.id) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
    else p.resolve(m.result);
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) p.reject(new Error("the browser closed"));
    pending.clear();
  });
  return {
    send: (method, params = {}) => cdpSend(ws, idRef, pending, method, params),
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
};

// Reusable warm Chrome process pool: each job gets a fresh isolated BrowserContext + page target and disposes it
// on completion, recycling the browser on crash/disconnect, after maxJobsPerBrowser, or on idle timeout.
export class BrowserPool {
  constructor({ maxJobsPerBrowser = 12, idleTimeoutMs = 300000 } = {}) {
    this.maxJobsPerBrowser = Math.max(1, maxJobsPerBrowser);
    this.idleTimeoutMs = Math.max(0, idleTimeoutMs);
    this._entries = new Map();
    this._launchLocks = new Map();
    this._closed = false;
    this._beforeExitHandler = () => { void this.close(); };
    process.once("beforeExit", this._beforeExitHandler);
  }

  _keyOf({ executable, gpu, extraArgs }) {
    return JSON.stringify({ executable: executable || "", gpu: !!gpu, extraArgs: extraArgs || [] });
  }

  async _launchEntry({ key, executable, gpu, width, height, extraArgs }) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "story-author-pool-"));
    const args = [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--hide-scrollbars",
      "--enable-logging=stderr", `--window-size=${width},${height}`,
      ...(gpu ? [] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]),
      ...extraArgs, "about:blank",
    ];
    const proc = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.unref();
    proc.stderr?.unref?.();
    let stderrTail = "";
    proc.stderr?.on("data", (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-16384); });
    const entry = {
      key,
      profile,
      proc,
      stderrTail: () => stderrTail,
      port: 0,
      browserUrl: "",
      jobs: 0,
      activeCount: 0,
      closed: false,
      idleTimer: null,
      activeExits: new Set(),
      exited: null,
    };
    entry.exited = new Promise((resolve) => {
      proc.once("exit", (code, signal) => {
        if (!entry.closed) {
          for (const cb of entry.activeExits) {
            try { cb(code, signal, stderrTail); } catch { /* diagnostics */ }
          }
        }
        entry.closed = true;
        if (this._entries.get(key) === entry) this._entries.delete(key);
        resolve(code);
      });
    });
    proc.once("error", () => {});

    try {
      const portFile = path.join(profile, "DevToolsActivePort");
      const port = await waitFor("start", () => {
        if (proc.exitCode !== null) throw new Error(`the browser exited (${proc.exitCode}): ${executable}`);
        if (!fs.existsSync(portFile)) return null;
        const p = fs.readFileSync(portFile, "utf8").split("\n")[0];
        return p ? Number(p) : null;
      }, 30000);
      entry.port = port;
      entry.browserUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
      return entry;
    } catch (e) {
      await this._closeEntry(entry);
      throw e;
    }
  }

  async _closeEntry(entry) {
    if (!entry || entry.closed) {
      if (entry?.profile && fs.existsSync(entry.profile)) {
        for (let i = 0; i < 10; i++) {
          try { await fs.promises.rm(entry.profile, { recursive: true, force: true }); break; }
          catch { await new Promise((r) => setTimeout(r, 150)); }
        }
      }
      return;
    }
    entry.closed = true;
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    if (this._entries.get(entry.key) === entry) this._entries.delete(entry.key);
    if (entry.proc && entry.proc.exitCode === null) {
      if (entry.browserUrl) {
        try {
          const ctrl = await openCdpWs(entry.browserUrl);
          await ctrl.send("Browser.close").catch(() => {});
          ctrl.close();
        } catch { /* kill fallback */ }
      }
      const done = await Promise.race([entry.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
      if (!done) {
        try { entry.proc.kill(); } catch { /* gone */ }
        await entry.exited;
      }
    }
    for (let i = 0; i < 20 && entry.profile && fs.existsSync(entry.profile); i++) {
      try { await fs.promises.rm(entry.profile, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }

  async _getEntry(opts) {
    const executable = findBrowser(opts.executable);
    const key = this._keyOf({ executable, gpu: opts.gpu, extraArgs: opts.extraArgs });
    const existing = this._entries.get(key);
    if (existing && !existing.closed && existing.proc.exitCode === null &&
        existing.jobs < this.maxJobsPerBrowser) {
      if (existing.idleTimer) { clearTimeout(existing.idleTimer); existing.idleTimer = null; }
      return existing;
    }
    if (this._launchLocks.has(key)) return this._launchLocks.get(key);
    const launchOp = (async () => {
      if (existing && existing.activeCount === 0) await this._closeEntry(existing);
      const created = await this._launchEntry({ ...opts, executable, key });
      this._entries.set(key, created);
      return created;
    })().finally(() => {
      if (this._launchLocks.get(key) === launchOp) this._launchLocks.delete(key);
    });
    this._launchLocks.set(key, launchOp);
    return launchOp;
  }

  async acquire({ executable = findBrowser(), gpu = false, width = 1300, height = 600, extraArgs = [],
                  onConsole = null, onNetworkError = null, onExit = null, signal = null } = {}) {
    if (this._closed) throw new Error("BrowserPool is closed");
    const checkAborted = () => {
      if (signal?.aborted) throw (signal.reason || new Error("aborted"));
    };
    const raceAbort = (promise) => {
      if (!signal) return promise;
      checkAborted();
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
          (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
          (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
        );
      });
    };

    checkAborted();
    let entry = await raceAbort(this._getEntry({ executable, gpu, width, height, extraArgs }));
    checkAborted();
    let ctrl;
    try {
      ctrl = await raceAbort(openCdpWs(entry.browserUrl));
    } catch (e) {
      if (signal?.aborted) throw e;
      // Pooled browser disconnected while idle: recycle and relaunch once cleanly.
      await this._closeEntry(entry);
      entry = await raceAbort(this._getEntry({ executable, gpu, width, height, extraArgs }));
      ctrl = await raceAbort(openCdpWs(entry.browserUrl));
    }

    let browserContextId = null;
    let targetId = null;
    const disposeTarget = async () => {
      try {
        const c = await openCdpWs(entry.browserUrl);
        if (targetId) await c.send("Target.closeTarget", { targetId }).catch(() => {});
        if (browserContextId) await c.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
        c.close();
      } catch { /* ignore */ }
    };
    try {
      const ctx = await raceAbort(ctrl.send("Target.createBrowserContext", { disposeOnDetach: false }));
      browserContextId = ctx.browserContextId;
      const tgt = await raceAbort(ctrl.send("Target.createTarget", {
        url: "about:blank", browserContextId, width, height,
      }));
      targetId = tgt.targetId;
    } catch (e) {
      ctrl.close();
      await disposeTarget();
      throw e;
    }
    ctrl.close();

    let targets;
    try {
      targets = await raceAbort((await fetch(`http://127.0.0.1:${entry.port}/json/list`, signal ? { signal } : undefined)).json());
    } catch (e) {
      await disposeTarget();
      throw e;
    }
    const pageTarget = targets.find((t) => t.id === targetId);
    const pageWsUrl = pageTarget?.webSocketDebuggerUrl || `ws://127.0.0.1:${entry.port}/devtools/page/${targetId}`;

    const page = new Browser();
    page.proc = entry.proc;
    page.stderrTail = entry.stderrTail;
    page.browserUrl = entry.browserUrl;
    entry.activeCount++;
    if (onExit) entry.activeExits.add(onExit);
    const onEntryExit = entry.exited.then(() => page._resolveClosed?.());
    void onEntryExit;

    try {
      await raceAbort(page._connect(pageWsUrl, onConsole, onNetworkError));
      await raceAbort(page.send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: false,
      }).catch(() => {}));
      checkAborted();
    } catch (e) {
      entry.activeCount = Math.max(0, entry.activeCount - 1);
      if (onExit) entry.activeExits.delete(onExit);
      page._closing = true;
      try { page.ws?.close(); } catch { /* ignore */ }
      await disposeTarget();
      throw e;
    }

    page.close = async () => {
      if (page.closed) return;
      page.closed = true;
      page._closing = true;
      try { if (page.ws) page.ws.close(); } catch { /* closed */ }
      if (onExit) entry.activeExits.delete(onExit);
      entry.activeCount = Math.max(0, entry.activeCount - 1);
      entry.jobs++;

      if (!entry.closed && entry.proc.exitCode === null) {
        try {
          const c = await openCdpWs(entry.browserUrl);
          if (targetId) await c.send("Target.closeTarget", { targetId }).catch(() => {});
          if (browserContextId) await c.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
          c.close();
        } catch {
          await this._closeEntry(entry);
          return;
        }
      }
      if (entry.jobs >= this.maxJobsPerBrowser && entry.activeCount === 0) {
        await this._closeEntry(entry);
      } else if (this.idleTimeoutMs > 0 && entry.activeCount === 0 && !entry.closed) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => {
          if (entry.activeCount === 0) void this._closeEntry(entry);
        }, this.idleTimeoutMs);
        entry.idleTimer.unref?.();
      }
    };

    return page;
  }

  async close() {
    this._closed = true;
    process.removeListener("beforeExit", this._beforeExitHandler);
    const list = [...this._entries.values()];
    this._entries.clear();
    await Promise.all(list.map((e) => this._closeEntry(e)));
  }
}
