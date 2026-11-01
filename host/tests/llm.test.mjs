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
