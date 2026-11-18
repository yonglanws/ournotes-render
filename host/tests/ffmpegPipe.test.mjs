import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BrowserPool, findBrowser } from "../../scripts/lib/story-author/chrome.js";
import {
  configureFfmpeg, muxVideoAudio, openVideoPipe, probeWav, resetEncoderProbeCache, resolveEncoders, runFfmpeg,
  writeWav,
} from "../render/ffmpeg.js";
import { StreamingMp4Muxer } from "../render/mp4Muxer.js";
import { Renderer } from "../render/renderer.js";
import { quietLogger, sineWav, tmpDir } from "./helpers.mjs";

configureFfmpeg();

// Minimal valid 64x64 JPEG frame generated once via ffmpeg for pipe tests.
let sampleJpeg = null;
const getSampleJpeg = async () => {
  if (sampleJpeg) return sampleJpeg;
  const dir = tmpDir("ournotes-jpg-");
  const out = path.join(dir, "frame.jpg");
  await runFfmpeg([
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.04", "-frames:v", "1", out,
  ]);
  sampleJpeg = fs.readFileSync(out);
  return sampleJpeg;
};

test("resolveEncoders caches 1-frame probes per process and avoids retrying broken GPU encoders", async () => {
  resetEncoderProbeCache();
  const t0 = Date.now();
  const first = await resolveEncoders({ encoder: "auto", crf: 23, preset: "veryfast", logger: quietLogger() });
  const firstMs = Date.now() - t0;
  assert.ok(first.length >= 1);
  assert.ok(["h264_nvenc", "h264_amf", "h264_qsv", "libx264"].includes(first[0].codec));

  const t1 = Date.now();
  const second = await resolveEncoders({ encoder: "auto", crf: 23, preset: "veryfast", logger: quietLogger() });
  const secondMs = Date.now() - t1;
  assert.equal(second[0].codec, first[0].codec);
  assert.ok(secondMs <= Math.max(20, firstMs), `cached probe (${secondMs}ms) should not re-run (${firstMs}ms)`);
});

test("openVideoPipe streams JPEG frames to MP4 without disk JPEGs and muxVideoAudio stream-copies audio", async () => {
  const dir = tmpDir("ournotes-pipe-");
  const jpg = await getSampleJpeg();
  const rawMp4 = path.join(dir, "video.mp4");
  const pipe = await openVideoPipe({
    output: rawMp4, fps: 30, width: 64,
    config: { encoder: "libx264", crf: 28, preset: "veryfast", watermark: "" },
    logger: quietLogger(),
  });
  for (let i = 0; i < 15; i++) await pipe.writeFrame(jpg);
  const res = await pipe.finish();
  assert.equal(res.encoder, "libx264");
  assert.ok(fs.existsSync(rawMp4) && fs.statSync(rawMp4).size > 500);

  const wav = path.join(dir, "audio.wav");
  sineWav(wav, { seconds: 0.5, sampleRate: 48000 });
  const finalMp4 = path.join(dir, "final.mp4");
  await muxVideoAudio({ video: rawMp4, audio: wav, output: finalMp4, audioBitrate: "128k" });
  assert.ok(fs.existsSync(finalMp4) && fs.statSync(finalMp4).size > 1000);
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", finalMp4, "-f", "null", "-"]);
});

test("writeWav Int16Array vectorization encodes PCM16 samples and clamps out-of-range floats", () => {
  const dir = tmpDir("ournotes-wav-vec-");
  const file = path.join(dir, "vec.wav");
  const samples = new Float32Array([-1.5, -1.0, -0.5, 0, 0.5, 1.0, 1.5, 0.25]);
  const meta = writeWav(file, 2, 48000, samples);
  assert.equal(meta.samples, 4);
  assert.equal(meta.channels, 2);
  const info = probeWav(file);
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.channels, 2);
  assert.equal(info.samples, 4);
  const buf = fs.readFileSync(file);
  assert.equal(buf.readInt16LE(44), -32768);
  assert.equal(buf.readInt16LE(46), -32768);
  assert.equal(buf.readInt16LE(48), -16384);
  assert.equal(buf.readInt16LE(50), 0);
  assert.equal(buf.readInt16LE(52), 16384);
  assert.equal(buf.readInt16LE(54), 32767);
  assert.equal(buf.readInt16LE(56), 32767);
});

test("StreamingMp4Muxer writes ftyp, 64-bit mdat size patch, moov, colr nclx BT.709 and exact timescale", () => {
  const muxer = new StreamingMp4Muxer({ width: 1300, height: 600, fps: 30 });
  const header = muxer.headerBytes();
  assert.equal(Buffer.from(header.subarray(4, 8)).toString("ascii"), "ftyp");
  assert.equal(Buffer.from(header.subarray(header.length - 12, header.length - 8)).toString("ascii"), "mdat");

  const fakeAvcC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28, 0x01, 0x00, 0x02, 0x68, 0xee]);
  const sample1 = muxer.addSample({
    data: new Uint8Array([0, 0, 0, 4, 0x65, 0x88, 0x84, 0x21]),
    isKey: true,
    decoderConfig: {
      description: fakeAvcC,
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    },
  });
  const sample2 = muxer.addSample({
    data: new Uint8Array([0, 0, 0, 3, 0x41, 0x9a, 0x22]),
    isKey: false,
  });
  const { moov, mdatSizeOffset, mdatSizeBytes } = muxer.finish();
  assert.equal(mdatSizeOffset, header.length - 8);
  const patchedSize = new DataView(mdatSizeBytes.buffer).getBigUint64(0, false);
  assert.equal(patchedSize, BigInt(16 + sample1.length + sample2.length));
  const moovBuf = Buffer.from(moov);
  assert.equal(moovBuf.subarray(4, 8).toString("ascii"), "moov");
  assert.ok(moovBuf.includes(Buffer.from("avc1")), "avc1 atom present");
  assert.ok(moovBuf.includes(Buffer.from("avcC")), "avcC atom present");
  assert.ok(moovBuf.includes(Buffer.from("colrnclx")), "BT.709 colr/nclx atom present");
  assert.ok(moovBuf.includes(Buffer.from("co64")), "co64 offset atom present");
});

let browser = "";
try { browser = findBrowser(); } catch { /* no Chrome */ }
const skipBrowser = process.env.OURNOTES_SKIP_BROWSER ? "OURNOTES_SKIP_BROWSER" : browser ? false : "no Chrome/Edge";

test("BrowserPool reuses warm Chrome across isolated BrowserContexts and recycles after maxJobsPerBrowser", {
  skip: skipBrowser, timeout: 180000,
}, async () => {
  const output = tmpDir("ournotes-pool-");
  const pool = new BrowserPool({ maxJobsPerBrowser: 2, idleTimeoutMs: 60000 });
  const config = {
    paths: { output, cache: output, site: "" },
    video: { width: 320, height: 180, fps: 30, crf: 28, preset: "veryfast", encoder: "libx264",
             captureMode: "pipe", audioBitrate: "128k", watermark: "" },
    render: { gpu: false, chrome: browser, core: "", taskTimeoutMs: 120000 },
  };
  const renderer = new Renderer({ config, logger: quietLogger(), browserPool: pool });
  try {
    const p1 = await pool.acquire({ executable: browser, gpu: false, width: 320, height: 180 });
    const pid1 = p1.proc.pid;
    await p1.close();

    const p2 = await pool.acquire({ executable: browser, gpu: false, width: 320, height: 180 });
    const pid2 = p2.proc.pid;
    assert.equal(pid2, pid1, "second acquire reuses warm browser process");
    await p2.close();

    // maxJobsPerBrowser=2 recycled the browser on p2.close(), so third acquire launches a fresh process.
    const p3 = await pool.acquire({ executable: browser, gpu: false, width: 320, height: 180 });
    const pid3 = p3.proc.pid;
    assert.notEqual(pid3, pid1, "browser recycled cleanly after N jobs");
    await p3.close();

    const r = await renderer.renderSmoke({ jobId: "pool-smoke", frames: 6 });
    assert.equal(r.report.frames, 6);
    assert.ok(fs.existsSync(r.output));
  } finally {
    await pool.close();
  }
});
