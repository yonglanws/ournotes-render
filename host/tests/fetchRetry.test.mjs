import assert from "node:assert/strict";
import { test } from "node:test";
import { postWithRetry } from "../render/fetchRetry.js";

const ok = () => ({ ok: true, status: 200, text: async () => "" });
const httpError = (status, text = "") => ({ ok: false, status, text: async () => text });

test("a transient network error is retried and the upload succeeds", async () => {
  let calls = 0;
  const retried = [];
  const response = await postWithRetry(async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return ok();
  }, "/job/x/frame", "jpeg", { "content-type": "image/jpeg" }, {
    label: "frame 12", delayMs: 1, onRetry: (attempt, error) => retried.push([attempt, error.message]),
  });
  assert.equal(response.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(retried, [[1, "Failed to fetch"]]);
});

test("a 4xx is final: retrying cannot fix a bad frame or an oversized body", async () => {
  let calls = 0;
  await assert.rejects(
    postWithRetry(async () => { calls++; return httpError(400, "not a JPEG"); }, "/job/x/frame", "x", {},
                  { delayMs: 1 }),
    /\/job\/x\/frame: HTTP 400 not a JPEG/);
  assert.equal(calls, 1);
});

test("a 5xx is retried until it works", async () => {
  let calls = 0;
  const response = await postWithRetry(async () => {
    calls++;
    return calls < 3 ? httpError(503, "busy") : ok();
  }, "/job/x/cue", "bytes", {}, { label: "cue 7 a.wav", delayMs: 1 });
  assert.equal(response.ok, true);
  assert.equal(calls, 3);
});

test("the final error names the upload, the cause and the attempt count", async () => {
  let calls = 0;
  await assert.rejects(
    postWithRetry(async () => { calls++; throw new TypeError("Failed to fetch"); }, "/job/x/result", "{}", {},
                  { label: "job x result", attempts: 3, delayMs: 1 }),
    /job x result: Failed to fetch \(after 3 attempts\)/);
  assert.equal(calls, 3);
});
