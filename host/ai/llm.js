// An OpenAI-compatible chat completion client. The endpoint is operator configuration, not caller input, so it is
// checked with the service policy (http/https; private hosts only when the config allows them).
import { assertServiceHttpUrl } from "../net/urlGuard.js";

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason || new Error("aborted")); }, { once: true });
});

const endpoint = (baseUrl) => {
  const u = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/(chat\/completions|responses)$/.test(u)) return u;
  if (/\/v\d+$/.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
};

export class LLMError extends Error {
  constructor(message, { status = null, retryable = false, body = "", usage = null, content = "" } = {}) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.retryable = retryable;
    this.body = body;
    this.usage = usage;
    this.content = content;
  }
}

export class LLMClient {
  constructor(config, { logger = console, allowPrivate = true } = {}) {
    this.config = config;
    this.logger = logger;
    this.url = endpoint(config.baseUrl);
    try {
      assertServiceHttpUrl(this.url, { allowPrivate, what: "llm.baseUrl" });
    } catch (e) {
      throw new Error(`llm.baseUrl: ${e.message}`, { cause: e });
    }
  }

  get available() { return !!(this.config.enabled && this.config.model); }

  // messages: [{role, content}]; opts: {temperature, maxTokens, json, timeoutMs, signal, label}
  async chat(messages, opts = {}) {
    if (!this.available) throw new LLMError("LLM is not configured (llm.enabled / llm.model)");
    const retries = Math.max(0, Number(opts.retries ?? this.config.retries ?? 2));
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (opts.signal?.aborted) throw opts.signal.reason || new Error("aborted");
      if (attempt) await sleep(Math.min(8000, 700 * 2 ** (attempt - 1)), opts.signal);
      try {
        return await this._once(messages, opts);
      } catch (e) {
        last = e;
        if (opts.signal?.aborted) throw opts.signal.reason || e;
        if (!(e instanceof LLMError) || !e.retryable || attempt === retries) throw e;
        this.logger.warn?.(`LLM ${opts.label ? `(${opts.label}) ` : ""}attempt ${attempt + 1} failed: ${e.message}; retrying`);
      }
    }
    throw last;
  }

  async _once(messages, opts) {
    const timeout = Math.max(1000, Number(opts.timeoutMs ?? this.config.timeoutMs ?? 120000));
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal.reason || new Error("aborted"));
    if (opts.signal) {
      if (opts.signal.aborted) throw opts.signal.reason || new Error("aborted");
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new LLMError(`LLM request timed out after ${Math.round(timeout / 1000)} s`,
                                                              { retryable: true })), timeout);
    const body = {
      model: this.config.model,
      messages,
      temperature: Number(opts.temperature ?? this.config.temperature ?? 0.85),
      max_tokens: Math.max(256, Number(opts.maxTokens ?? this.config.maxTokens ?? 8192)),
      stream: false,
    };
    if (opts.json) body.response_format = { type: "json_object" };
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    let response;
    try {
      response = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) throw controller.signal.reason || e;
      throw new LLMError(`LLM connection failed: ${e.message}`, { retryable: true });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener?.("abort", onAbort);
    }
    const text = await response.text();
    if (!response.ok) {
      // Some gateways reject response_format; one retry without it is done by the caller's json fallback.
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      const hint = response.status === 401 || response.status === 403 ? " (check llm.apiKeyEnv)" : "";
      throw new LLMError(`LLM HTTP ${response.status}${hint}: ${text.slice(0, 300)}`,
                         { status: response.status, retryable, body: text.slice(0, 2000) });
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new LLMError(`LLM returned non-JSON: ${text.slice(0, 200)}`, { retryable: true }); }
    if (data?.choices?.[0]?.finish_reason === "length")
      throw new LLMError("LLM answer was truncated (finish_reason=length); raise llm.maxTokens", {
        retryable: false, usage: data.usage || null,
        content: String(data?.choices?.[0]?.message?.content || "").slice(0, 20_000),
      });
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new LLMError("LLM returned an empty answer", { retryable: true });
    return { content: content.trim(), usage: data.usage || null, model: data.model || this.config.model };
  }

  // JSON answer: tries json mode, then a plain call (some gateways reject response_format).
  async json(messages, opts = {}) {
    try {
      return await this.chat(messages, { ...opts, json: true });
    } catch (e) {
      if (e instanceof LLMError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) {
        return this.chat(messages, { ...opts, json: false });
      }
      throw e;
    }
  }
}
