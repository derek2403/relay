// POST /api/fund: who gets gas, how often, and how much, with a fake wallet.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { type Address, type Hex, parseEther } from "viem";

import { type FundDeps, type FunderWallet, handleFund } from "./fund";
import { Meter } from "./meter";
import { ClientLimit, createLimits } from "./ratelimit";
import { MemoryChain, bundle, level, makeDeps } from "./testkit";
import type { FundResponse } from "./types";

const ADMIN: Address = "0x00000000000000000000000000000000000000AD";
const DEREK: Address = "0x0000000000000000000000000000000000000DE1";
const SAM: Address = "0x00000000000000000000000000000000000005A3";
const AGENT: Address = "0x00000000000000000000000000000000000000A6";
const FUNDER: Address = "0x00000000000000000000000000000000000000F0";

class FakeWallet implements FunderWallet {
  address = FUNDER;
  balances = new Map<string, bigint>();
  sent: { to: Address; value: bigint }[] = [];
  fail = false;
  async getBalance(a: Address) {
    return this.balances.get(a.toLowerCase()) ?? 0n;
  }
  async send(to: Address, value: bigint): Promise<Hex> {
    await new Promise((r) => setTimeout(r, 10));
    if (this.fail) throw new Error("insufficient funds for gas * price + value");
    this.sent.push({ to, value });
    return `0x${this.sent.length.toString(16).padStart(64, "0")}`;
  }
}

function setup(env: Record<string, string> = {}, over: Record<string, Partial<ReturnType<typeof level>>> = {}) {
  const levels = [
    level("acme.eth", ADMIN, bundle("codex")),
    level("dev.acme.eth", ADMIN, bundle("codex")),
    level("derek.dev.acme.eth", DEREK, bundle("codex")),
    level("codex.derek.dev.acme.eth", AGENT, bundle("codex")),
    level("sam.dev.acme.eth", SAM, bundle("codex")),
    level("f.dev.acme.eth", FUNDER, bundle("codex")),
  ].map((l) => ({ ...l, ...over[l.name] }));
  const chain = new MemoryChain(levels);
  const wallet = new FakeWallet();
  // Generous limits: the rate limit has its own test.
  const deps: FundDeps = {
    ...makeDeps(chain, env),
    wallet,
    limits: { ...createLimits(), fundChecks: new ClientLimit([1000, 1], [1000, 1]), fund: new ClientLimit([1000, 1], [1000, 1]) },
  };
  return { chain, wallet, deps };
}

async function fund(deps: FundDeps, body: unknown, client = "1.2.3.4") {
  const res = await handleFund(
    new Request("http://localhost:3000/api/fund", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": client }, body: JSON.stringify(body) }),
    deps,
  );
  return { status: res.status, body: (await res.json()) as FundResponse };
}

const reason = (r: { body: FundResponse }) => (r.body.funded ? null : r.body.reason);

test("fund: a member with an empty wallet gets FUNDER_AMOUNT_ETH once, recorded in the meter file", async () => {
  const { wallet, deps } = setup();
  const r = await fund(deps, { name: "derek.dev.acme.eth" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { funded: true, address: DEREK, amountEth: "0.01", txHash: `0x${"1".padStart(64, "0")}` });
  assert.deepEqual(wallet.sent, [{ to: DEREK, value: parseEther("0.01") }]);
  const saved = JSON.parse(fs.readFileSync(deps.meter.file, "utf8"));
  assert.equal(saved.grants.length, 1);
  assert.equal(saved.grants[0].name, "derek.dev.acme.eth");
  assert.equal(saved.grants[0].resource, "7");

  const again = await fund(deps, { name: "derek.dev.acme.eth" });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { funded: false, address: DEREK, reason: "already funded" });
  // A restarted relay remembers it.
  const restarted = { ...deps, meter: new Meter(deps.meter.file, 5) };
  assert.equal(reason(await fund(restarted, { name: "derek.dev.acme.eth" })), "already funded");
  assert.equal(wallet.sent.length, 1);
});

test("fund: concurrent requests for one name pay once", async () => {
  const { wallet, deps } = setup();
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => fund(deps, { name: "derek.dev.acme.eth" }, `10.0.0.${i}`)));
  assert.equal(results.filter((r) => r.body.funded).length, 1);
  assert.ok(results.filter((r) => !r.body.funded).every((r) => reason(r) === "already funded"));
  assert.equal(wallet.sent.length, 1);
});

test("fund: a re-registered member (new resource) can be funded again", async () => {
  const { wallet, deps } = setup();
  assert.equal((await fund(deps, { name: "derek.dev.acme.eth" })).body.funded, true);
  const readd = setup({}, { "derek.dev.acme.eth": { resource: "8" } });
  const d2 = { ...readd.deps, meter: deps.meter, wallet };
  assert.equal((await fund(d2, { name: "derek.dev.acme.eth" })).body.funded, true);
  assert.equal(wallet.sent.length, 2);
});

test("fund: no top-up while the balance is at or above FUNDER_MIN_BALANCE_ETH", async () => {
  const { wallet, deps } = setup();
  wallet.balances.set(DEREK.toLowerCase(), parseEther("0.005"));
  const r = await fund(deps, { name: "derek.dev.acme.eth" });
  assert.equal(r.status, 200);
  assert.match(reason(r)!, /already has 0\.005 ETH/);
  wallet.balances.set(DEREK.toLowerCase(), parseEther("0.0049"));
  assert.equal((await fund(deps, { name: "derek.dev.acme.eth" })).body.funded, true);
});

test("fund: refused outside the root, for the root, and for unregistered names", async () => {
  const { chain, wallet, deps } = setup();
  const outside = await fund(deps, { name: "derek.dev.other.eth" });
  assert.equal(outside.status, 403);
  assert.match(reason(outside)!, /not a member of acme\.eth/);
  assert.equal((await fund(deps, { name: "acme.eth" })).status, 403);
  assert.equal((await fund(deps, { name: "not a name!" })).status, 400);
  assert.equal((await fund(deps, {})).status, 400);

  chain.remove("derek.dev.acme.eth");
  const removed = await fund(deps, { name: "derek.dev.acme.eth" });
  assert.equal(removed.status, 403);
  assert.equal(reason(removed), "access revoked: derek.dev.acme.eth was removed or expired. Run relay login.");
  chain.restore("derek.dev.acme.eth");
  chain.remove("dev.acme.eth");
  assert.match(reason(await fund(deps, { name: "derek.dev.acme.eth" }))!, /dev\.acme\.eth was removed or expired/);
  assert.equal(wallet.sent.length, 0);
});

test("fund: only members: not agents, not company-held levels, not the funder, and not someone else's address", async () => {
  const { wallet, deps } = setup();
  const agent = await fund(deps, { name: "codex.derek.dev.acme.eth" });
  assert.equal(agent.status, 403);
  assert.match(reason(agent)!, /only members added by the company are funded; derek\.dev\.acme\.eth is not held by the company owner/);
  assert.match(reason(await fund(deps, { name: "dev.acme.eth" }))!, /held by the company owner/);
  assert.match(reason(await fund(deps, { name: "f.dev.acme.eth" }))!, /held by the funder itself/);

  const mismatch = await fund(deps, { name: "derek.dev.acme.eth", address: SAM });
  assert.equal(mismatch.status, 403);
  assert.match(reason(mismatch)!, /^owner mismatch: derek\.dev\.acme\.eth is held by 0x0+DE1, not 0x0+5A3/i);
  assert.equal((await fund(deps, { name: "derek.dev.acme.eth", address: DEREK.toLowerCase() })).body.funded, true, "a matching address is fine");
  assert.equal(wallet.sent.length, 1);
});

test("fund: a company-held name under a member is not a member (every level above must be the company's)", async () => {
  // derek (a member) holds every role on his own registry, so he can register "x" to the admin's
  // address without asking, and hang "alt" (his second wallet) below it.
  const ALT: Address = "0x0000000000000000000000000000000000000A17";
  const { wallet, deps } = setup();
  deps.reader = new MemoryChain([
    ...(deps.reader as MemoryChain).levels,
    level("x.derek.dev.acme.eth", ADMIN, bundle("codex")),
    level("alt.x.derek.dev.acme.eth", ALT, bundle("codex")),
  ]);
  const r = await fund(deps, { name: "alt.x.derek.dev.acme.eth" });
  assert.equal(r.status, 403);
  assert.match(reason(r)!, /only members added by the company are funded; derek\.dev\.acme\.eth is not held by the company owner/);
  assert.equal(wallet.sent.length, 0);
});

test("fund: once per registration even after the grant list drops old entries", async () => {
  const { wallet, deps } = setup();
  for (let i = 0; i < 2001; i++) {
    deps.meter.addGrant({ name: i ? `n${i}.dev.acme.eth` : "derek.dev.acme.eth", resource: "7", address: DEREK, amountWei: "1", txHash: "0x01", ts: 0 });
  }
  assert.ok(!deps.meter.grants().some((g) => g.name === "derek.dev.acme.eth"), "the oldest grant left the list");
  assert.equal(reason(await fund(deps, { name: "derek.dev.acme.eth" })), "already funded");
  await deps.meter.flush();
  const restarted = { ...deps, meter: new Meter(deps.meter.file, 5) };
  assert.equal(reason(await fund(restarted, { name: "derek.dev.acme.eth" })), "already funded");
  assert.equal(wallet.sent.length, 0);
});

test("fund: FUNDER_DAILY_LIMIT_ETH caps the day's total across members; yesterday's grants don't count", async () => {
  const { deps } = setup({ FUNDER_DAILY_LIMIT_ETH: "0.015" });
  assert.equal((await fund(deps, { name: "derek.dev.acme.eth" })).body.funded, true);
  const capped = await fund(deps, { name: "sam.dev.acme.eth" });
  assert.equal(capped.status, 429);
  assert.match(reason(capped)!, /daily limit \(0\.015 ETH\) is used up/);

  const nextDay = setup({ FUNDER_DAILY_LIMIT_ETH: "0.015" });
  nextDay.deps.meter.addGrant({ ...deps.meter.grants()[0], ts: Date.now() - 86_400_000 });
  assert.equal((await fund(nextDay.deps, { name: "sam.dev.acme.eth" })).body.funded, true);
});

test("fund: no funder, a failed send, and the per-client rate limit", async () => {
  const none = setup();
  none.deps.wallet = null;
  const off = await fund(none.deps, { name: "derek.dev.acme.eth" });
  assert.equal(off.status, 503);
  assert.match(reason(off)!, /FUNDER_PRIVATE_KEY/);

  const { wallet, deps } = setup();
  wallet.fail = true;
  const failed = await fund(deps, { name: "derek.dev.acme.eth" });
  assert.equal(failed.status, 502);
  assert.match(reason(failed)!, /couldn't send: insufficient funds/);
  wallet.fail = false;
  assert.equal((await fund(deps, { name: "derek.dev.acme.eth" })).body.funded, true, "a failed send isn't recorded");

  const limited = setup();
  limited.deps.limits = { ...createLimits(), fundChecks: new ClientLimit([2, 0], [100, 0]) };
  await fund(limited.deps, { name: "derek.dev.acme.eth" });
  await fund(limited.deps, { name: "derek.dev.acme.eth" });
  const third = await fund(limited.deps, { name: "derek.dev.acme.eth" });
  assert.equal(third.status, 429);
  // Without RELAY_TRUST_PROXY, X-Forwarded-For is the client's own claim: everyone is one client.
  assert.equal((await fund(limited.deps, { name: "derek.dev.acme.eth" }, "5.6.7.8")).status, 429, "a forged X-Forwarded-For doesn't get a new bucket");
  process.env.RELAY_TRUST_PROXY = "1";
  try {
    assert.equal((await fund(limited.deps, { name: "derek.dev.acme.eth" }, "5.6.7.8")).status, 200, "behind a trusted proxy, another client is not limited");
  } finally {
    delete process.env.RELAY_TRUST_PROXY;
  }
});

test("fund: refused requests don't use up the grant budget", async () => {
  const { wallet, deps } = setup();
  deps.limits = { ...createLimits(), fundChecks: new ClientLimit([1000, 0], [1000, 0]), fund: new ClientLimit([1, 0], [1, 0]) };
  for (let i = 0; i < 5; i++) {
    assert.equal((await fund(deps, { name: "codex.derek.dev.acme.eth" })).status, 403);
    assert.equal((await fund(deps, { name: "dev.acme.eth" })).status, 403);
  }
  assert.equal((await fund(deps, { name: "derek.dev.acme.eth" })).body.funded, true, "the one grant token is still there");
  assert.equal(reason(await fund(deps, { name: "derek.dev.acme.eth" })), "already funded", "already funded doesn't take a token either");
  const capped = await fund(deps, { name: "sam.dev.acme.eth" });
  assert.equal(capped.status, 429);
  assert.match(reason(capped)!, /Too many top-ups/);
  assert.equal(wallet.sent.length, 1);
});

test("fund: the funder key never appears in responses or the meter file", async () => {
  const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const { deps } = setup({ FUNDER_PRIVATE_KEY: key });
  assert.equal(deps.config.funder.address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  assert.ok(!JSON.stringify(deps.config).includes(key.slice(2)));
  const r = await fund(deps, { name: "derek.dev.acme.eth" });
  assert.ok(!JSON.stringify(r.body).includes(key.slice(2)));
  assert.ok(!fs.readFileSync(deps.meter.file, "utf8").includes(key.slice(2)));
});
