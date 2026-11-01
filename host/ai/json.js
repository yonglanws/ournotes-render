// Pulling one JSON value out of an LLM answer: fenced blocks, prose before/after, and trailing commas are common.
export const extractJson = (text) => {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (!s) return null;
  // ```json ... ``` or ``` ... ```
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Some gateways double-encode the answer as a JSON string: "{\"format\":...}". Unwrap it and try again.
  if (s.startsWith('"')) {
    try {
      const once = JSON.parse(s);
      if (typeof once === "string") return extractJson(once);
    } catch { /* not a complete JSON string; fall through */ }
  }
  // find the first { or [ and take the balanced value from there
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start], close = open === "{" ? "}" : "]";
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  const body = s.slice(start, end);
  let value = null;
  try {
    value = JSON.parse(body);
  } catch {
    // trailing commas before a closing bracket / brace
    try { value = JSON.parse(body.replace(/,\s*([}\]])/g, "$1")); } catch { return null; }
  }
  return typeof value === "string" ? extractJson(value) : value;
};
