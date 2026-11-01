// Small HTTP helpers shared by the API and the render page server. JSON responses are UTF-8 buffers with HTML
// metacharacters escaped, so even a client that ignores the content type cannot turn a field into markup.
export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const jsonText = (body) => JSON.stringify(body).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
  .replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export const sendJson = (res, status, body, headers = {}) => {
  const buf = Buffer.from(jsonText(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(buf);
};

export const readJson = (req, limit = 20 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > limit) { reject(new HttpError(413, "request body too large")); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (!chunks.length) return resolve({});
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { reject(new HttpError(400, "request body is not valid JSON")); }
  });
  req.on("error", reject);
});

// Names that may appear in a download URL: one path segment of letters, digits, dot, underscore and dash.
export const safeName = (name) => typeof name === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(name) &&
  !name.includes("..") && name !== "." && name !== "..";
