// Outbound URL policy.
//
// Two levels:
//   assertPublicHttpUrl(value)  for URLs that come from story data or API callers (media, redirects). Only http and
//                               https; the host must not be localhost / a loopback, private, link-local or otherwise
//                               reserved address; DNS names are resolved and every answer is checked, so a name that
//                               points at a private address is refused too.
//   assertServiceHttpUrl(value) for operator-configured service endpoints (LLM, TTS). Only http and https; private
//                               addresses are allowed only when security.allowPrivateServiceEndpoints is true (local
//                               GPT-SoVITS is the normal deployment). It still refuses non-http schemes and garbage.
//
// resolvePublicUrl is the asynchronous form used before an outbound fetch.
import dns from "node:dns/promises";
import net from "node:net";

const V4 = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
  [0xe0000000, 4], [0xf0000000, 4], [0xffffffff, 32],
]; // 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24,
   // 224/4 multicast, 240/4 reserved, 255.255.255.255

const v4ToInt = (ip) => ip.split(".").reduce((n, x) => ((n << 8) >>> 0) + Number(x), 0) >>> 0;

const isPrivateV4 = (ip) => {
  const n = v4ToInt(ip);
  return V4.some(([base, bits]) => ((n & (0xffffffff << (32 - bits))) >>> 0) === (base >>> 0));
};

const isPrivateV6 = (ip) => {
  const s = ip.toLowerCase().split("%")[0];
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true; // link-local fe80::/10
  if (s.startsWith("fc") || s.startsWith("fd")) return true;                                                // unique local fc00::/7
  if (s.startsWith("ff")) return true;                                                                      // multicast
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateV4(m[1]);
  return false;
};

export const isPrivateAddress = (address) => {
  if (net.isIPv4(address)) return isPrivateV4(address);
  if (net.isIPv6(address)) return isPrivateV6(address);
  return false;
};

const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

const parse = (value, what) => {
  let u;
  try { u = new URL(String(value)); } catch { throw new Error(`${what}: not a URL: ${value}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${what}: only http and https are allowed (${u.protocol})`);
  if (u.username || u.password) throw new Error(`${what}: credentials in URLs are not allowed`);
  return u;
};

// The host without brackets (URL keeps IPv6 brackets) and without the DNS root dot.
const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

const literalCheck = (u, what) => {
  const host = hostOf(u);
  if (LOCAL_NAMES.has(host) || host.endsWith(".localhost")) throw new Error(`${what}: localhost is not allowed`);
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`${what}: private, loopback or reserved address ${host} is not allowed`);
};

// Strict policy for caller- or data-supplied URLs. DNS names are resolved by resolvePublicUrl before use.
export const assertPublicHttpUrl = (value, what = "url") => {
  const u = parse(value, what);
  literalCheck(u, what);
  return u;
};

// Service endpoints from config: http(s) only; private hosts only with allowPrivate.
export const assertServiceHttpUrl = (value, { allowPrivate = true, what = "service url" } = {}) => {
  const u = parse(value, what);
  if (!allowPrivate) literalCheck(u, what);
  return u;
};

// Resolves `value` and returns the URL with every address checked. Use before fetching a caller-supplied URL.
export const resolvePublicUrl = async (value, what = "url") => {
  const u = assertPublicHttpUrl(value, what);
  const host = hostOf(u);
  if (net.isIP(host)) return u;
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`${what}: cannot resolve ${host}: ${e.message}`, { cause: e });
  }
  if (!addresses.length) throw new Error(`${what}: ${host} resolves to no address`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error(`${what}: ${host} resolves to a private, loopback or reserved address`);
  }
  return u;
};

// Hostname-only check for redirects: callers should re-run resolvePublicUrl on the Location they follow.
export const assertPublicHost = (hostname, what = "host") => {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new Error(`${what}: empty`);
  if (LOCAL_NAMES.has(host) || host.endsWith(".localhost")) throw new Error(`${what}: localhost is not allowed`);
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`${what}: private address is not allowed`);
  return host;
};
