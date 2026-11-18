import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BrowserPool, findBrowser } from "../../scripts/lib/story-author/chrome.js";
import { StreamingMp4Muxer } from "../render/mp4Muxer.js";
import { Renderer } from "../render/renderer.js";
import { quietLogger, tmpDir } from "./helpers.mjs";

const parseColrBox = (moovBuf) => {
  const buf = Buffer.from(moovBuf);
  const idx = buf.indexOf("colr");
  assert.ok(idx >= 4, "moov must contain colr box");
  return {
    type: buf.toString("ascii", idx + 4, idx + 8),
    primaries: buf.readUInt16BE(idx + 8),
    transfer: buf.readUInt16BE(idx + 10),
    matrix: buf.readUInt16BE(idx + 12),
    fullRange: buf[idx + 14],
  };
};

class MockVideoColorSpace {
  constructor(opts) { this._opts = opts; }
  get primaries() { return this._opts.primaries; }
  get transfer() { return this._opts.transfer; }
  get matrix() { return this._opts.matrix; }
  get fullRange() { return this._opts.fullRange; }
}

test("StreamingMp4Muxer preserves prototype-getter VideoColorSpace and fullRange flag", () => {
  for (const [fullRangeBool, expectedByte] of [[true, 0x80], [false, 0x00]]) {
    const muxer = new StreamingMp4Muxer({ width: 1300, height: 600, fps: 30 });
    muxer.addSample({
      data: new Uint8Array([0, 0, 0, 2, 0x65, 0x88]),
      isKey: true,
      decoderConfig: {
        description: new Uint8Array([1, 100, 0, 41, 255]),
        colorSpace: new MockVideoColorSpace({
          primaries: "bt709",
          transfer: "iec61966-2-1",
          matrix: "bt709",
          fullRange: fullRangeBool,
        }),
      },
    });
    const { moov } = muxer.finish();
    const colr = parseColrBox(moov);
    assert.deepEqual(colr, {
      type: "nclx",
      primaries: 1,
      transfer: 13,
      matrix: 1,
      fullRange: expectedByte,
    });
  }
});

let browser = "";
try { browser = findBrowser(); } catch { /* no Chrome */ }
const skip = process.env.OURNOTES_SKIP_BROWSER ? "OURNOTES_SKIP_BROWSER" : browser ? false : "no Chrome/Edge";

test("Renderer.warm aborts cleanly without leaking BrowserPool slots", { skip, timeout: 120000 }, async () => {
  const output = tmpDir();
  const pool = new BrowserPool({ maxJobsPerBrowser: 4, idleTimeoutMs: 60000 });
  const config = {
    paths: { output, cache: output, site: "", siteFormat: "" },
    video: { width: 640, height: 360, fps: 30, captureMode: "auto", audioSampleRate: 48000 },
    render: { gpu: false, chrome: browser, chromeArgs: [], core: "", taskTimeoutMs: 60000 },
  };
  const renderer = new Renderer({ config, logger: quietLogger(), browserPool: pool });
  try {
    const ac = new AbortController();
    const warm = renderer.warm({ siteEngine: true, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 80));
    ac.abort(new Error("cancelled"));
    await warm.dispose();
    for (const entry of pool._entries.values()) {
      assert.equal(entry.activeCount, 0, "aborted warm must release its BrowserContext activeCount");
    }
    assert.equal(fs.existsSync(path.join(output, "jobs")), true);
  } finally {
    await renderer.close();
    await pool.close();
  }
});
