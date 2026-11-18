import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { sdfTexels } from "../../src/story/browser-font.js";
import { clearFontRoutesCache, createPageServer } from "../render/pageServer.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

test("the page server serves the base site, the overlay, and package modules only", async () => {
  const site = tmpDir("ournotes-page-site-");
  const output = tmpDir("ournotes-page-out-");
  fs.writeFileSync(path.join(site, "hello.txt"), "hello site");
  const files = new Map([["composed.json", Buffer.from('{"ok":true}')]]);
  const server = await createPageServer({ site, files, core: "", outputDir: output, logger: quietLogger() });
  try {
    // Chrome keeps one connection for thousands of frame POSTs; the 5 s Node default races a slow frame.
    assert.equal(server.server.keepAliveTimeout, 120000);
    assert.ok(server.server.headersTimeout > server.server.keepAliveTimeout);
    const hello = await fetch(`${server.url}/site/hello.txt`);
    assert.equal(await hello.text(), "hello site");
    const overlay = await fetch(`${server.url}/site/composed.json`);
    assert.equal(await overlay.text(), '{"ok":true}');
    const src = await fetch(`${server.url}/src/story/session.js`);
    assert.equal(src.status, 200);
    assert.match(src.headers.get("content-type"), /javascript/);
    const siteEngine = await fetch(`${server.url}/site-engine/src/story/assets.js`);
    assert.equal(siteEngine.status, 200);
    assert.match(siteEngine.headers.get("content-type"), /javascript/);
    const forbidden = await fetch(`${server.url}/host/tests/helpers.mjs`);
    assert.equal(forbidden.status, 403);
    const traversal = await fetch(`${server.url}/site/..%2f..%2fpackage.json`);
    assert.notEqual(traversal.status, 200);
  } finally {
    await server.close();
  }
});

test("a job accepts JPEG frames and a final report", async () => {
  const output = tmpDir("ournotes-page-out-");
  const server = await createPageServer({ site: "", files: new Map(), core: "", outputDir: output, logger: quietLogger() });
  try {
    const job = server.createJob({ jobId: "job-test", manifest: "/site/x.json" });
    const config = await (await fetch(`${server.url}/job/job-test.json`)).json();
    assert.equal(config.manifest, "/site/x.json");
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01, 0x02]);
    const posted = await fetch(`${server.url}/job/job-test/frame`, {
      method: "POST", headers: { "content-type": "image/jpeg", "x-frame": "0" }, body: frame,
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(fs.readFileSync(path.join(job.framesDir, "000000.jpg")), frame);
    const cue = Buffer.from("RIFF....WAVE");
    const cuePosted = await fetch(`${server.url}/job/job-test/cue`, {
      method: "POST", headers: { "x-sound-id": "7", "x-ext": "wav" }, body: cue,
    });
    assert.equal(cuePosted.status, 200);
    assert.deepEqual(fs.readFileSync(path.join(job.cuesDir, "7.wav")), cue);
    // story sites use 13-digit sound ids
    const siteCue = await fetch(`${server.url}/job/job-test/cue`, {
      method: "POST", headers: { "x-sound-id": "3107000002001", "x-ext": "m4a" }, body: cue,
    });
    assert.equal(siteCue.status, 200);
    assert.deepEqual(fs.readFileSync(path.join(job.cuesDir, "3107000002001.m4a")), cue);
    const progress = await fetch(`${server.url}/job/job-test/progress`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames: 120, storySeconds: 4 }),
    });
    assert.equal(progress.status, 200);
    assert.deepEqual({ frames: job.progress.frames, storySeconds: job.progress.storySeconds },
                     { frames: 120, storySeconds: 4 });
    const result = fetch(`${server.url}/job/job-test/result`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, frames: 1 }),
    });
    const report = await job.result;
    assert.equal(report.frames, 1);
    assert.equal((await result).status, 200);
  } finally {
    await server.close();
  }
});

test("pageServer serves bundled webfonts cleanly, blocks traversal, and overrides browser-font.js", async () => {
  const fontsDir = tmpDir("ournotes-page-fonts-");
  const output = tmpDir("ournotes-page-out-");
  fs.writeFileSync(path.join(fontsDir, "NotoSansCJKsc-Regular.woff2"), Buffer.from("wOF2mock"));
  const server = await createPageServer({ site: "", files: new Map(), core: "", fontsDir, outputDir: output,
                                          logger: quietLogger() });
  try {
    const css = await fetch(`${server.url}/fonts.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
    const cssText = await css.text();
    assert.match(cssText, /@font-face/);
    assert.match(cssText, /url\("\/fonts\/NotoSansCJKsc-Regular\.woff2"\)/);

    const fontRes = await fetch(`${server.url}/fonts/NotoSansCJKsc-Regular.woff2`);
    assert.equal(fontRes.status, 200);
    assert.match(fontRes.headers.get("content-type"), /font\/woff2/);
    assert.deepEqual(Buffer.from(await fontRes.arrayBuffer()), Buffer.from("wOF2mock"));

    const miss = await fetch(`${server.url}/fonts/..%2fetc%2fpasswd`);
    assert.equal(miss.status, 403);

    // Patched runtime override ensures site-format uses smooth browser-font rasterization without binary alpha clip.
    const siteBrowserFont = await fetch(`${server.url}/site-engine/src/story/browser-font.js`);
    assert.equal(siteBrowserFont.status, 200);
    const body = await siteBrowserFont.text();
    assert.ok(!body.includes(">= 128 ? 1 : 0"));

    // Anti-aliased partial coverage in sdfTexels produces intermediate SDF values strictly between solid & empty.
    const solid = sdfTexels(new Uint8Array([0, 255, 255]), 3, 1, 1, 2);
    const soft = sdfTexels(new Uint8Array([0, 192, 255]), 3, 1, 1, 2);
    assert.ok(soft[1] < solid[1] && soft[1] > 128, "partial alpha refines SDF ramp smoothly");
  } finally {
    await server.close();
  }
});

test("pageServer caches font routes, sets immutable cache headers on static assets, and streams frames via onFrame", async () => {
  clearFontRoutesCache();
  const site = tmpDir("ournotes-page-cache-site-");
  const fontsDir = tmpDir("ournotes-page-cache-fonts-");
  const output = tmpDir("ournotes-page-cache-out-");
  fs.mkdirSync(path.join(site, "assets"), { recursive: true });
  fs.writeFileSync(path.join(site, "assets", "abc.json"), '{"cached":true}');
  fs.writeFileSync(path.join(fontsDir, "NotoSansCJKsc-Regular.woff2"), Buffer.from("wOF2v1"));
  const server = await createPageServer({ site, files: new Map(), core: "", fontsDir, outputDir: output,
                                          logger: quietLogger() });
  try {
    // Delete the font file on disk and spin up a second server for the same site+fontsDir: fontRoutes cache is reused.
    fs.unlinkSync(path.join(fontsDir, "NotoSansCJKsc-Regular.woff2"));
    const server2 = await createPageServer({ site, files: new Map(), core: "", fontsDir, outputDir: output,
                                             logger: quietLogger() });
    try {
      const css2 = await fetch(`${server2.url}/fonts.css`);
      assert.match(await css2.text(), /NotoSansCJKsc-Regular\.woff2/);
    } finally {
      await server2.close();
    }

    const pageRes = await fetch(`${server.url}/page.html`);
    assert.equal(pageRes.headers.get("cache-control"), "no-store");
    const renderRes = await fetch(`${server.url}/render.html`);
    assert.equal(renderRes.headers.get("cache-control"), "no-store");
    const srcRes = await fetch(`${server.url}/src/story/session.js`);
    assert.match(srcRes.headers.get("cache-control") || "", /immutable/);
    const assetRes = await fetch(`${server.url}/site/assets/abc.json`);
    assert.match(assetRes.headers.get("cache-control") || "", /immutable/);

    const streamed = [];
    const job = server.createJob({ jobId: "job-pipe-hook" }, {
      onFrame: async (n, buf) => { streamed.push([n, buf.length]); },
      onPrepareCues: async (cues) => cues.filter((c) => c.soundId !== "1").map((c) => c.soundId),
    });
    const jobJsonRes = await fetch(`${server.url}/job/job-pipe-hook.json`);
    assert.equal(jobJsonRes.headers.get("cache-control"), "no-store");

    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const postFrame = await fetch(`${server.url}/job/job-pipe-hook/frame`, {
      method: "POST", headers: { "content-type": "image/jpeg", "x-frame": "0" }, body: frame,
    });
    assert.equal(postFrame.status, 200);
    assert.deepEqual(streamed, [[0, frame.length]]);
    assert.equal(fs.existsSync(job.framesDir), false, "zero frame JPEG disk writes when onFrame is active");

    const prep = await (await fetch(`${server.url}/job/job-pipe-hook/cues-prepare`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cues: [{ soundId: "1", ext: "m4a", sourcePath: "audio/a.m4a" }, { soundId: "2", ext: "wav", sourcePath: "audio/b.wav" }] }),
    })).json();
    assert.deepEqual(prep.missing, ["2"]);
  } finally {
    clearFontRoutesCache();
    await server.close();
  }
});
