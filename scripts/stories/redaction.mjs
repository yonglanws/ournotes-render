// Secret scrubbing at the evaluation boundary: reports, failure records and
// console lines must never carry the configured key or a provider-looking token.
export const SECRET_PATTERNS = Object.freeze([
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]"],
  [/\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s"',}]+/gi, "[REDACTED]"],
  [/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@"],
]);

export const redactText = (value, secrets = []) => {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
};

export const redactValue = (value, secrets = []) => {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
  }
  return value;
};

export const redactingLogger = (logger = console, secrets = []) => ({
  log: (message) => logger.log?.(redactText(message, secrets)),
  info: (message) => logger.info?.(redactText(message, secrets)),
  warn: (message) => logger.warn?.(redactText(message, secrets)),
  error: (message) => logger.error?.(redactText(message, secrets)),
});
