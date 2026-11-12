// Retrying the render page's uploads. The page posts one JPEG per frame to its local job server; Chrome reports a
// reset keep-alive socket as TypeError("Failed to fetch"), and before this helper one such blip aborted an otherwise
// healthy ten-minute render. Frame and cue posts are safe to repeat: the server keys each write by frame number or
// sound id, so a retry overwrites the same file instead of appending a duplicate. HTTP 4xx is not retried (a bad frame
// number or an oversized body fails the same way again), 5xx and network errors are.
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const postWithRetry = async (fetchImpl, url, body, headers = {},
                                    { attempts = 3, label = "", delayMs = 250, sleep = defaultSleep,
                                      onRetry = null } = {}) => {
  const total = Math.max(1, Math.round(attempts));
  let last = null;
  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      const response = await fetchImpl(url, { method: "POST", headers, body });
      if (response.ok) return response;
      const text = await response.text().catch(() => "");
      const error = new Error(`HTTP ${response.status}${text ? ` ${text}` : ""}`);
      error.status = response.status;
      if (response.status < 500) {
        error.message = `${label || url}: ${error.message}`;
        throw error;
      }
      last = error;
    } catch (e) {
      if (Number.isInteger(e?.status) && e.status < 500) throw e;
      last = e;
    }
    if (attempt < total) {
      try { onRetry?.(attempt, last); } catch { /* diagnostics must not stop the retry */ }
      await sleep(Math.min(2000, delayMs * 2 ** (attempt - 1)));
    }
  }
  const detail = last?.message || String(last || "unknown error");
  throw new Error(`${label || url}: ${detail} (after ${total} attempt${total === 1 ? "" : "s"})`);
};
