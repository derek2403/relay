// POST /api/relay/admin/reset: clearing the meter of removed names.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Address } from "viem";

import { namehash } from "../ens/names";
import { spendKey } from "./meter";
import { charge } from "./policy";
import { resetMeter } from "./reset";
import { MemoryChain, bundle, level, makeDeps, tempDir } from "./testkit";
import type { LogEntry } from "./types";

const ADMIN: Address = "0x00000000000000000000000000000000000000AD";
const DEREK: Address = "0x0000000000000000000000000000000000000DE1";
const AGENT: Address = "0x00000000000000000000000000000000000000A6";

const USER = "derek.dev.acme.eth";
const CODEX = `codex.${USER}`;
const MONTH = new Date().toISOString().slice(0, 7);

const entry = (name: string): LogEntry => ({
  ts: Date.now(),
  name,
  provider: "codex",
  method: "POST",
  path: "/v1/responses",
  allowed: true,
  reason: null,
  status: 200,
  costUsd: 0.1,
  estimated: false,
  signer: null,
});

function setup() {
  const chain = new MemoryChain([
    level("acme.eth", ADMIN, bundle("codex")),
    level("dev.acme.eth", ADMIN, bundle("codex")),
    level(USER, DEREK, bundle("codex")),
    level(CODEX, AGENT, bundle("codex", { period: "total" })),
  ]);
  const d = makeDeps(chain);
  const levels = chain.levels;
  charge(levels, "codex", 0.25, d.meter, new Date(), 1);
  // An earlier registration of dev.acme.eth (resource 6): unreachable leftovers.
  d.meter.add(spendKey(namehash("dev.acme.eth"), "6", "codex", MONTH), 1);
  d.meter.remember(namehash("dev.acme.eth"), "dev.acme.eth");
  for (const name of ["acme.eth", USER, CODEX, CODEX, "gone.dev.acme.eth"]) d.meter.log(entry(name));
  return { chain, d };
}

test("reset: clears spend, counts, reservations and log entries of names no longer registered", async () => {
  const { chain, d } = setup();
  const held = d.meter.hold([spendKey(namehash(CODEX), "7", "codex", "total")], 0.5, 1);
  chain.remove(USER);
  const r = await resetMeter(d);
  assert.deepEqual(r.cleared.sort(), [CODEX, USER, "gone.dev.acme.eth"].sort());
  assert.equal(r.keys, 2 * 2 + 1, "derek and codex: spend + count each; dev.acme.eth's old registration");
  assert.equal(r.logEntries, 4);
  assert.deepEqual(r.skipped, []);

  assert.equal(d.meter.spent(spendKey(namehash(CODEX), "7", "codex", "total")), 0);
  assert.equal(d.meter.used(spendKey(namehash(USER), "7", "codex", MONTH)), 0);
  assert.equal(d.meter.pending(spendKey(namehash(CODEX), "7", "codex", "total")), 0, "reservations too");
  held(); // a call still running releases safely
  assert.equal(d.meter.pending(spendKey(namehash(CODEX), "7", "codex", "total")), 0);
  // Registered names keep their current spend; only the earlier registration of dev is gone.
  assert.equal(d.meter.spent(spendKey(namehash("acme.eth"), "7", "codex", MONTH)), 0.25);
  assert.equal(d.meter.used(spendKey(namehash("dev.acme.eth"), "7", "codex", MONTH)), 1);
  assert.equal(d.meter.spent(spendKey(namehash("dev.acme.eth"), "6", "codex", MONTH)), 0);
  assert.deepEqual(d.meter.recent(10).map((e) => e.name), ["acme.eth"]);
});

test("reset: keepLog (the open mode) clears spend but no log entries", async () => {
  const { chain, d } = setup();
  chain.remove(USER);
  const r = await resetMeter(d, undefined, { keepLog: true });
  assert.deepEqual(r.cleared.sort(), [CODEX, USER].sort(), "names only in the log aren't read");
  assert.equal(r.logEntries, 0);
  assert.equal(d.meter.spent(spendKey(namehash(CODEX), "7", "codex", "total")), 0);
  assert.equal(d.meter.recent(10).length, 5, "the log is untouched");
});

test("reset: an explicit list clears exactly those names, registered or not", async () => {
  const { d } = setup();
  const r = await resetMeter(d, [CODEX, "Not A Name!!"]);
  assert.deepEqual(r.cleared, [CODEX]);
  assert.deepEqual(r.skipped, [{ name: "Not A Name!!", reason: "not a valid ENS name" }]);
  assert.equal(d.meter.spent(spendKey(namehash(CODEX), "7", "codex", "total")), 0);
  assert.equal(d.meter.spent(spendKey(namehash(USER), "7", "codex", MONTH)), 0.25);
});

test("reset route: the admin token is required for a list; the automatic mode is open only in development", async () => {
  process.env.RELAY_DATA_DIR = tempDir();
  process.env.RELAY_ROOT_NAME = "acme.eth";
  process.env.RELAY_ADMIN_TOKEN = "admin-token-for-reset-test-0123456789";
  const { POST } = await import("../../app/api/relay/admin/reset/route");
  const { getMeter } = await import("./meter");
  const meter = getMeter(process.env.RELAY_DATA_DIR);
  meter.add(spendKey(namehash(CODEX), "7", "codex", "total"), 1);
  meter.remember(namehash(CODEX), CODEX);

  const call = (headers: Record<string, string>, body?: unknown) =>
    POST(new Request("http://localhost:3000/api/relay/admin/reset", { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }) as never);

  const anon = await call({}, { names: [CODEX] });
  assert.equal(anon.status, 401);
  assert.equal(meter.spent(spendKey(namehash(CODEX), "7", "codex", "total")), 1);
  assert.equal((await call({ authorization: "Bearer wrong" }, { names: [CODEX] })).status, 401);
  assert.equal((await call({ authorization: "Bearer x" }, { names: "nope" })).status, 400);

  const ok = await call({ authorization: `Bearer ${process.env.RELAY_ADMIN_TOKEN}` }, { names: [CODEX] });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).cleared, [CODEX]);
  assert.equal(meter.spent(spendKey(namehash(CODEX), "7", "codex", "total")), 0);

  // Without RELAY_ADMIN_TOKEN (development), a list still needs the admin.
  delete process.env.RELAY_ADMIN_TOKEN;
  assert.equal((await call({}, { names: [CODEX] })).status, 401);
});
