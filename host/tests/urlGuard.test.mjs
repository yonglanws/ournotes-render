import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicHttpUrl, assertServiceHttpUrl, isPrivateAddress, resolvePublicUrl } from "../net/urlGuard.js";

test("public http(s) URLs pass, private and local ones do not", () => {
  assert.equal(assertPublicHttpUrl("https://example.com/a").hostname, "example.com");
  assert.equal(assertPublicHttpUrl("http://example.com:8080/a").port, "8080");
  for (const bad of [
    "ftp://example.com/a", "file:///etc/passwd", "javascript:alert(1)",
    "http://localhost/a", "http://LOCALHOST./a", "http://foo.localhost/a",
    "http://127.0.0.1/a", "http://127.10.0.1/a", "http://0.0.0.0/a", "http://10.1.2.3/a",
    "http://172.16.0.1/a", "http://192.168.1.1/a", "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/a", "http://198.18.0.1/a", "http://203.0.113.5/a",
    "http://224.0.0.1/a", "http://255.255.255.255/a", "http://[::1]/a", "http://[fe80::1]/a",
    "http://[fc00::1]/a", "http://user:pass@example.com/a",
  ]) {
    assert.throws(() => assertPublicHttpUrl(bad), undefined, bad);
  }
});

test("service URLs allow loopback only when the operator allows private endpoints", () => {
  assert.equal(assertServiceHttpUrl("http://127.0.0.1:9880", { allowPrivate: true }).port, "9880");
  assert.throws(() => assertServiceHttpUrl("http://127.0.0.1:9880", { allowPrivate: false }));
  assert.throws(() => assertServiceHttpUrl("ftp://127.0.0.1"));
});

test("private address classification", () => {
  for (const a of ["0.0.0.0", "10.0.0.1", "100.64.1.1", "127.0.0.1", "169.254.1.1", "172.31.0.1",
                   "192.168.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
                   "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1"])
    assert.equal(isPrivateAddress(a), true, a);
  for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2001:4860:4860::8888"])
    assert.equal(isPrivateAddress(a), false, a);
});

test("a DNS name resolving to a private address is refused", async () => {
  // localhost is rejected by name before DNS
  await assert.rejects(() => resolvePublicUrl("http://localhost/x"));
  // a name with no records fails closed
  await assert.rejects(() => resolvePublicUrl("http://does-not-exist.invalid/x"));
});
