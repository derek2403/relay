import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { ADMIN_COOKIE, canView, isAdmin, viewerFor } from "./auth";
import { RECORD_KEYS, parseBundle } from "./bundle";
import { loadConfig } from "./config";
import type { ChainLevel, ChainReader } from "./ens";
import { Meter } from "./meter";
import type { PolicyDeps } from "./policy";
import { ClientLimit, RateLimiter, createLimits } from "./ratelimit";
import { createToken } from "./token";

const agent = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const LEAF = "laptop.acme.eth";
const ADMIN = "admin-secret-token-0123456789";

const level = (name: string, owner: Address): ChainLevel => ({
  name,
  registry: "0x0000000000000000000000000000000000000001",
  resolver: "0x0000000000000000000000000000000000000002",
  subregistry: null,
  status: "registered",
  owner,
  expiry: 2_000_000_000,
  resource: "1",
  bundle: parseBundle({ [RECORD_KEYS.keys]: "mock" }),
  checks: { registryVerified: true, resolverVerified: true, canonical: true },
});

function deps(env: Record<string, string> = {}): PolicyDeps {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-auth-"));
  const levels = [level("acme.eth", other.address), level(LEAF, agent.address)];
  const reader: ChainReader = { readLevels: async (_r, name) => levels.filter((l) => name === l.name || name.endsWith(`.${l.name}`)) };
  return { config: loadConfig({ RELAY_ROOT_NAME: "acme.eth", RELAY_DATA_DIR: dir, ...env }), reader, meter: new Meter(path.join(dir, "relay.json"), 5) };
}

const req = (headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/relay/log", { headers });
const kr = (signer = agent, name = LEAF) => createToken(signer, { name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 });

test("viewAuth: open in development, closed in production, token when RELAY_ADMIN_TOKEN is set", () => {
  assert.equal(loadConfig({}).viewAuth, "open");
  assert.equal(loadConfig({ NODE_ENV: "production" }).viewAuth, "closed");
  assert.equal(loadConfig({ NODE_ENV: "production", RELAY_ADMIN_TOKEN: ADMIN }).viewAuth, "token");
  // The admin token never appears on a serialized config.
  assert.ok(!JSON.stringify(loadConfig({ RELAY_ADMIN_TOKEN: ADMIN })).includes(ADMIN));
});

test("admin: Bearer token or the session cookie", () => {
  const d = deps({ RELAY_ADMIN_TOKEN: ADMIN });
  assert.ok(isAdmin(req({ authorization: `Bearer ${ADMIN}` }), d));
  assert.ok(!isAdmin(req({ authorization: "Bearer wrong" }), d));
  const cookie = d.config.admin.cookie()!;
  assert.notEqual(cookie, ADMIN, "the cookie is not the token");
  assert.ok(isAdmin(req({ cookie: `a=1; ${ADMIN_COOKIE}=${cookie}` }), d));
  assert.ok(!isAdmin(req({ cookie: `${ADMIN_COOKIE}=${cookie.slice(1)}` }), d));
  assert.ok(!isAdmin(req({ authorization: `Bearer ${ADMIN}` }), deps()), "no admin without RELAY_ADMIN_TOKEN");
});

test("viewerFor: admin, open, agent (own names only) and refusals", async () => {
  const limits = createLimits();
  const open = await viewerFor(req(), deps(), limits);
  assert.deepEqual(open, { kind: "open" });

  const locked = deps({ RELAY_ADMIN_TOKEN: ADMIN });
  const anon = await viewerFor(req(), locked, limits);
  assert.ok(anon instanceof Response && anon.status === 401);
  assert.deepEqual(await viewerFor(req({ authorization: `Bearer ${ADMIN}` }), locked, limits), { kind: "admin" });

  const closed = await viewerFor(req(), deps({ NODE_ENV: "production" }), limits);
  assert.ok(closed instanceof Response && closed.status === 401);
  assert.match((await closed.json()).reason, /RELAY_ADMIN_TOKEN/);

  const me = await viewerFor(req({ "x-api-key": await kr() }), locked, limits);
  assert.ok(!(me instanceof Response));
  assert.equal(me.kind, "agent");
  assert.ok(canView(me, LEAF));
  assert.ok(canView(me, `sub.${LEAF}`));
  assert.ok(!canView(me, "acme.eth"));
  assert.ok(!canView(me, `x${LEAF}`));
  assert.ok(!canView(me, null));

  const forged = await viewerFor(req({ "x-api-key": await kr(other) }), locked, limits);
  assert.ok(forged instanceof Response && forged.status === 401);
});

test("viewerFor: forged tokens use up the client's failure budget", async () => {
  const limits = { ...createLimits(), failures: new ClientLimit([1, 0], [100, 0]) };
  const d = deps({ RELAY_ADMIN_TOKEN: ADMIN });
  const first = await viewerFor(req({ "x-api-key": await kr(other) }), d, limits);
  assert.ok(first instanceof Response && first.status === 401);
  const second = await viewerFor(req({ "x-api-key": await kr(other) }), d, limits);
  assert.ok(second instanceof Response && second.status === 429);
});

test("RateLimiter: refills over time and forgets the oldest keys", () => {
  const l = new RateLimiter(2, 1, 2);
  assert.ok(l.take("a", 0));
  assert.ok(l.take("a", 0));
  assert.ok(!l.take("a", 0));
  assert.ok(l.take("a", 1000));
  l.take("b", 1000);
  l.take("c", 1000); // evicts "a"
  assert.ok(l.has("a", 1000), "a fresh bucket for a forgotten key");
});
