import assert from "node:assert/strict";
import { test } from "node:test";
import { QueueFullError, TaskQueue } from "../queue/taskQueue.js";
import { quietLogger } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("concurrency is respected and a wait list keeps priority then order", async () => {
  const q = new TaskQueue({ concurrency: 1, maxSize: 5, taskTimeoutMs: 5000, retentionMs: 1000,
                            cleanupIntervalMs: 60000, logger: quietLogger() });
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = q.submit({ label: "a", priority: 10, run: async () => { order.push("a"); await gate; return "a"; } });
  const b = q.submit({ label: "b", priority: 0, run: async () => { order.push("b"); return "b"; } });
  const c = q.submit({ label: "c", priority: 5, run: async () => { order.push("c"); return "c"; } });
  await sleep(20);
  assert.equal(q.running.size, 1);
  assert.deepEqual(q.pending.map((t) => t.label), ["c", "b"]);
  release();
  await Promise.all([a.promise, b.promise, c.promise]);
  assert.deepEqual(order, ["a", "c", "b"]);
  assert.equal(q.summary().completed, 3);
  await q.close();
});

test("the queue refuses work beyond maxSize", async () => {
  const q = new TaskQueue({ concurrency: 1, maxSize: 2, taskTimeoutMs: 5000, retentionMs: 1000,
                            cleanupIntervalMs: 60000, logger: quietLogger() });
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = q.submit({ run: async () => { await gate; } });
  q.submit({ run: async () => {} });
  assert.throws(() => q.submit({ run: async () => {} }), (e) => e instanceof QueueFullError);
  release();
  await a.promise;
  await q.close();
});

test("a queued task can be cancelled; a running task is aborted", async () => {
  const q = new TaskQueue({ concurrency: 1, maxSize: 5, taskTimeoutMs: 5000, retentionMs: 1000,
                            cleanupIntervalMs: 60000, logger: quietLogger() });
  let release;
  const gate = new Promise((r) => { release = r; });
  const aborted = ({ signal }) => new Promise((_, reject) => {
    gate.then(() => reject(new Error("gate released")));
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const a = q.submit({ run: aborted });
  const b = q.submit({ run: async () => {} });
  assert.equal(q.cancel(b.id), true);
  await assert.rejects(() => b.promise, /cancelled/);
  assert.equal(q.view(b.id).status, "cancelled");
  assert.equal(q.cancel(a.id), true);
  await assert.rejects(() => a.promise, /cancelled/);
  assert.equal(q.view(a.id).status, "cancelled");
  assert.equal(q.summary().cancelled, 2, "queued and running cancellations are both counted");
  release();
  await q.close();
});

test("a task that exceeds its timeout fails", async () => {
  const q = new TaskQueue({ concurrency: 1, maxSize: 2, taskTimeoutMs: 80, retentionMs: 1000,
                            cleanupIntervalMs: 60000, logger: quietLogger() });
  const t = q.submit({ run: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  await assert.rejects(() => t.promise, /timed out/);
  assert.equal(q.view(t.id).status, "failed");
  await q.close();
});

test("progress and queue positions are visible", async () => {
  const q = new TaskQueue({ concurrency: 1, maxSize: 3, taskTimeoutMs: 5000, retentionMs: 1000,
                            cleanupIntervalMs: 60000, logger: quietLogger() });
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = q.submit({ run: async () => { await gate; } });
  const b = q.submit({ run: async ({ progress }) => { progress("writing", 0.5, "half"); } });
  await sleep(10);
  assert.equal(q.view(b.id).queuePosition, 1);
  release();
  await a.promise;
  await b.promise;
  assert.equal(q.view(b.id).status, "completed");
  assert.equal(q.view(b.id).progress, 1);
  await q.close();
});
