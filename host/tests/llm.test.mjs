import assert from "node:assert/strict";
import { test } from "node:test";
import { LLMClient } from "../ai/llm.js";
import { extractJson } from "../ai/json.js";
import { quietLogger } from "./helpers.mjs";

test("extractJson handles fences, prose and trailing commas", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('here you go: {"a":[1,2,],} done'), { a: [1, 2] });
  assert.equal(extractJson("no json"), null);
  assert.deepEqual(extractJson('{"a":"}"}'), { a: "}" }, "a brace inside a string does not end the object");
  // some gateways return the JSON object as a JSON string
  assert.deepEqual(extractJson(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
  assert.deepEqual(extractJson('"{\\"a\\":\\"b\\"}"'), { a: "b" });
});

test("the LLM client posts to /chat/completions with the bearer key and retries 429", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body), auth: opts.headers.authorization });
    if (calls.length === 1) return new Response("busy", { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }], model: "test" }), { status: 200 });
  };
  try {
    const client = new LLMClient({
      enabled: true, baseUrl: "https://api.example.com/v1", model: "test", apiKey: "test-key",
      temperature: 0.2, maxTokens: 512, timeoutMs: 5000, retries: 1,
    }, { logger: quietLogger() });
    const r = await client.chat([{ role: "user", content: "hi" }]);
    assert.equal(r.content, "hello");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
    assert.equal(calls[0].auth, "Bearer test-key");
    assert.equal(calls[0].body.model, "test");
    assert.equal(calls[0].body.temperature, 0.2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the LLM client refuses a private endpoint when private services are disabled", () => {
  assert.throws(() => new LLMClient({
    enabled: true, baseUrl: "http://127.0.0.1:11434/v1", model: "x", apiKey: "", retries: 0,
  }, { logger: quietLogger(), allowPrivate: false }), /private/);
  assert.ok(new LLMClient({
    enabled: true, baseUrl: "http://127.0.0.1:11434/v1", model: "x", apiKey: "", retries: 0,
  }, { logger: quietLogger(), allowPrivate: true }));
});

test("the thinking effort is sent as reasoning_effort and omitted when unset", async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "gemini-3.8-flash" }),
                        { status: 200 });
  };
  try {
    const base = { enabled: true, baseUrl: "https://api.example.com/v1", model: "gemini-3.8-flash", apiKey: "k",
                   retries: 0 };
    await new LLMClient({ ...base, reasoningEffort: "medium" }, { logger: quietLogger() })
      .chat([{ role: "user", content: "hi" }]);
    await new LLMClient({ ...base, reasoningEffort: "" }, { logger: quietLogger() })
      .chat([{ role: "user", content: "hi" }]);
    assert.equal(bodies[0].model, "gemini-3.8-flash");
    assert.equal(bodies[0].reasoning_effort, "medium");
    assert.equal("reasoning_effort" in bodies[1], false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a truncated answer is retried with a larger budget", async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }),
                          { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "complete" }, finish_reason: "stop" }] }),
                        { status: 200 });
  };
  try {
    const client = new LLMClient({
      enabled: true, baseUrl: "https://api.example.com/v1", model: "test", apiKey: "k",
      maxTokens: 1000, timeoutMs: 5000, retries: 1,
    }, { logger: quietLogger() });
    const result = await client.chat([{ role: "user", content: "write" }]);
    assert.equal(result.content, "complete");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].max_tokens, 1000);
    assert.equal(bodies[1].max_tokens, 1500);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("LLM requests wait in a FIFO window instead of all leaving at once", async () => {
  const gates = [];
  let active = 0;
  let peak = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => gates.push(resolve));
    active--;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
                        { status: 200 });
  };
  try {
    const client = new LLMClient({
      enabled: true, baseUrl: "https://api.example.com/v1", model: "test", apiKey: "k",
      concurrency: 2, maxTokens: 512, timeoutMs: 5000, retries: 0,
    }, { logger: quietLogger() });
    const running = [1, 2, 3].map(() => client.chat([{ role: "user", content: "hi" }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.activeRequests, 2);
    assert.equal(client.waitingRequests, 1);
    gates.shift()();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.activeRequests, 2, "the waiting request takes the released slot");
    while (gates.length) gates.shift()();
    await Promise.all(running);
    assert.equal(peak, 2);
    assert.equal(client.activeRequests, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
