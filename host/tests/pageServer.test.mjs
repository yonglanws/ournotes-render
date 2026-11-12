import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createPageServer } from "../render/pageServer.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

test("the page server serves the base site, the overlay, and package modules only", async () => {
  const site = tmpDir("ournotes-page-site-");
  const output = tmpDir("ournotes-page-out-");
  fs.writeFileSync(path.join(site, "hello.txt"), "hello site");
  const files = new Map([["composed.json", Buffer.from('{"ok":true}')]]);
  const server = await createPageServer({ site, files, core: "", outputDir: output, logger: quietLogger() });
  try {
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
