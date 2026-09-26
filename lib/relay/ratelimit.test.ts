// Which client a request counts against: X-Forwarded-For only behind a trusted proxy.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DIRECT_CLIENT, clientKey, trustedProxyHops } from "./ratelimit";

const h = (headers: Record<string, string>) => new Headers(headers);

test("clientKey: without RELAY_TRUST_PROXY every caller is one client, whatever X-Forwarded-For says", () => {
  assert.equal(clientKey(h({ "x-forwarded-for": "1.2.3.4" }), 0), DIRECT_CLIENT);
  assert.equal(clientKey(h({ "x-forwarded-for": "5.6.7.8", "x-real-ip": "9.9.9.9" }), 0), DIRECT_CLIENT);
  assert.equal(clientKey(h({}), 0), DIRECT_CLIENT);
});

test("clientKey: behind N trusted proxies, the N-th X-Forwarded-For entry from the right", () => {
  // The client sent "6.6.6.6" itself; the proxy appended the address it saw.
  assert.equal(clientKey(h({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }), 1), "1.2.3.4");
  assert.equal(clientKey(h({ "x-forwarded-for": "6.6.6.6, 1.2.3.4, 10.0.0.2" }), 2), "1.2.3.4");
  assert.equal(clientKey(h({ "x-forwarded-for": "1.2.3.4" }), 3), "1.2.3.4", "fewer entries than proxies: the leftmost");
  assert.equal(clientKey(h({ "x-real-ip": "9.9.9.9" }), 1), "9.9.9.9");
  assert.equal(clientKey(h({}), 1), "unknown");
});

test("trustedProxyHops: off by default; true = 1; a number of proxies", () => {
  assert.equal(trustedProxyHops({}), 0);
  assert.equal(trustedProxyHops({ RELAY_TRUST_PROXY: "false" }), 0);
  assert.equal(trustedProxyHops({ RELAY_TRUST_PROXY: "0" }), 0);
  assert.equal(trustedProxyHops({ RELAY_TRUST_PROXY: "true" }), 1);
  assert.equal(trustedProxyHops({ RELAY_TRUST_PROXY: "2" }), 2);
  assert.equal(trustedProxyHops({ RELAY_TRUST_PROXY: "lots" }), 0);
});
