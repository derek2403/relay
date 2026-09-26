// The relay guard hooks in decide(): suspensions ("paused"), a broken
// approvals store (fail closed), approved scopes (overlays) that narrow a name
// and are metered in their own bucket, and the registered guard factory.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { namehash } from "../ens/names";
import { MAX_CHAIN_RECORD, RECORD_KEYS, parseChainRecord } from "./bundle";
import { type RelayGuard, memberLevelIndex, registerGuardFactory, relayGuard, setRelayGuard } from "./guard";
import { spendKey } from "./meter";
import { decide, relayDeps } from "./policy";
import { MemoryChain, MemoryGuard, bundle, fakeUpstream, level, makeDeps, relayJson, tempDir, tokenFor } from "./testkit";

let up: Awaited<ReturnType<typeof fakeUpstream>>;
before(async () => {
  up = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
after(() => up.close());

const admin = privateKeyToAccount(generatePrivateKey());
const user = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const USER = "derek.dev.acme.eth";
const AGENT = `codex.${USER}`;
const PAYOUT = `payout.${AGENT}`;
const WATCH = `watch.${AGENT}`;
const ALL = "codex,stripe,github,mock";

const chain = () =>
  new MemoryChain([
    level("acme.eth", admin.address, bundle(ALL)),
    level("dev.acme.eth", admin.address, bundle(ALL)),
    level(USER, user.address, bundle(ALL)),
    level(AGENT, agent.address, bundle(ALL)),
    level(PAYOUT, agent.address, bundle(ALL, { maxes: { stripe: 100 }, period: "total" }), { resource: "9" }),
    level(WATCH, agent.address, bundle(ALL)),
  ]);

const env = () => ({ RELAY_ROOT_OWNER: admin.address, STRIPE_SECRET_KEY: "sk_test_STRIPE_0123456789", RELAY_UPSTREAM_STRIPE: up.url });

function setup(guard: RelayGuard | null) {
  const d = makeDeps(chain(), env());
  d.guard = guard;
  return d;
}

test("memberLevelIndex: first level whose owner isn't the company's", () => {
  const levels = [{ owner: admin.address }, { owner: admin.address }, { owner: user.address }, { owner: agent.address }];
  assert.equal(memberLevelIndex(levels, admin.address), 2);
  assert.equal(memberLevelIndex(levels, null), 2);
  assert.equal(memberLevelIndex(levels.slice(0, 2), admin.address), -1);
});

test("relay.chain record: trimmed text, null when unset, not a string or over 4096 chars", () => {
  assert.equal(RECORD_KEYS.chain, "relay.chain");
  assert.equal(parseChainRecord('  {"v":1}\n'), '{"v":1}');
  assert.equal(parseChainRecord(""), null);
  assert.equal(parseChainRecord("   "), null);
  assert.equal(parseChainRecord(null), null);
  assert.equal(parseChainRecord(undefined), null);
  assert.equal(parseChainRecord("x".repeat(MAX_CHAIN_RECORD)), "x".repeat(MAX_CHAIN_RECORD));
  assert.equal(parseChainRecord("x".repeat(MAX_CHAIN_RECORD + 1)), null);
});

test("chain levels carry relay.chain through decide()", async () => {
  const text = '{"v":1,"caps":["read"]}';
  const d = makeDeps(new MemoryChain([...chain().levels.filter((l) => l.name !== PAYOUT), level(PAYOUT, agent.address, bundle(ALL), { chain: text })]), env());
  const out = await decide({ name: PAYOUT, provider: "stripe" }, d);
  assert.equal(out.levels.at(-1)?.chain, text);
});

test("no guard: decide() behaves as before", async () => {
  const d = await decide({ name: PAYOUT, provider: "stripe" }, setup(null));
  assert.equal(d.allowed, true, d.reason ?? "");
  assert.deepEqual(d.overlays, []);
});

test("paused: denies the subject and a descendant, not a sibling; observe() runs once per decide", async () => {
  const guard = new MemoryGuard().pause(AGENT, "inc_1");
  const deps = setup(guard);
  for (const name of [AGENT, PAYOUT]) {
    const d = await decide({ name, provider: "stripe" }, deps);
    assert.equal(d.allowed, false);
    assert.equal(d.denial, "paused");
    assert.equal(d.reason, `paused: ${AGENT} is under review (incident inc_1). An approver must review it in the portal.`);
    assert.ok(d.levels.length > 0, "levels are returned with a paused decision");
  }
  guard.pauses = [];
  guard.pause(PAYOUT, "inc_2");
  const sibling = await decide({ name: WATCH, provider: "stripe" }, deps);
  assert.equal(sibling.allowed, true, sibling.reason ?? "");
  assert.equal(guard.observed, 3);
});

test("paused over HTTP: 403 {error: paused}", async () => {
  const d = setup(new MemoryGuard().pause(PAYOUT, "inc_9"));
  const kr = await tokenFor(agent, PAYOUT);
  const r = await relayJson(d, "stripe", "/v1/charges", { kr, method: "GET" });
  assert.equal(r.status, 403);
  assert.equal(r.error, "paused");
  assert.match(r.reason ?? "", /incident inc_9/);
});

test("unavailable guard fails closed for agent names, not for company or member levels", async () => {
  const guard = new MemoryGuard();
  guard.broken = "approvals.json is corrupt";
  const deps = setup(guard);
  const d = await decide({ name: PAYOUT, provider: "stripe" }, deps);
  assert.equal(d.denial, "paused");
  assert.equal(d.reason, "approvals store unavailable: approvals.json is corrupt");
  const member = await decide({ name: USER, provider: "stripe" }, deps);
  assert.equal(member.allowed, true, member.reason ?? "");
});

test("a guard that throws counts as unavailable; observe() throwing is ignored", async () => {
  const throwing: RelayGuard = {
    paused: () => {
      throw new Error("store read failed");
    },
    overlays: () => [],
    observe: () => {
      throw new Error("drift check failed");
    },
  };
  const d = await decide({ name: PAYOUT, provider: "stripe" }, setup(throwing));
  assert.equal(d.denial, "paused");
  assert.match(d.reason ?? "", /approvals store unavailable: store read failed/);
  const quietObserve = await decide({ name: PAYOUT, provider: "stripe" }, setup({ paused: () => null, overlays: () => [], observe: () => { throw new Error("x"); } }));
  assert.equal(quietObserve.allowed, true, quietObserve.reason ?? "");
});

test("overlay narrows: the chain allows stripe, the approved scope only github", async () => {
  const guard = new MemoryGuard().overlay({ id: "ov_a", name: PAYOUT, bundle: bundle("github") });
  const deps = setup(guard);
  const stripe = await decide({ name: PAYOUT, provider: "stripe" }, deps);
  assert.equal(stripe.allowed, false);
  assert.equal(stripe.denial, "policy");
  assert.match(stripe.reason ?? "", /approved scope ov_a/);
  assert.equal(stripe.overlays.length, 1);
  const github = await decide({ name: PAYOUT, provider: "github" }, deps);
  assert.equal(github.allowed, true, github.reason ?? "");
  assert.equal(github.overlays[0].id, "ov_a");
  // levels stay the chain's levels
  assert.deepEqual(github.levels.map((l) => l.name), ["acme.eth", "dev.acme.eth", USER, AGENT, PAYOUT]);
  // A sibling isn't touched by the overlay.
  const sibling = await decide({ name: WATCH, provider: "stripe" }, deps);
  assert.equal(sibling.allowed, true);
  assert.deepEqual(sibling.overlays, []);
});

test("overlay on an ancestor also narrows its descendants", async () => {
  const deps = setup(new MemoryGuard().overlay({ id: "ov_b", name: AGENT, bundle: bundle("github") }));
  const d = await decide({ name: PAYOUT, provider: "stripe" }, deps);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? "", /approved scope ov_b/);
});

test("overlay bucket is charged and enforced (count cap in the approved scope)", async () => {
  const guard = new MemoryGuard().overlay({ id: "ov_c", name: PAYOUT, bundle: bundle("stripe", { maxes: { stripe: 2 } }) });
  const d = setup(guard);
  const kr = await tokenFor(agent, PAYOUT);
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await relayJson(d, "stripe", "/v1/charges", { kr, method: "GET" }));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 403]);
  assert.match(results[2].reason ?? "", /approved scope ov_c/);
  const bucketKey = spendKey(namehash(PAYOUT), "9", "stripe", "approval:ov_c");
  assert.equal(d.meter.used(bucketKey), 2);
  // The chain level's own (total) period is charged too.
  assert.equal(d.meter.used(spendKey(namehash(PAYOUT), "9", "stripe", "total")), 2);
});

test("expired overlay denies with a renewal hint", async () => {
  const guard = new MemoryGuard().overlay({ id: "ov_d", name: PAYOUT, bundle: bundle("stripe"), notAfter: 1_700_000_000 });
  const d = await decide({ name: PAYOUT, provider: "stripe" }, setup(guard));
  assert.equal(d.allowed, false);
  assert.equal(d.denial, "policy");
  assert.equal(d.reason, `approved scope for ${PAYOUT} ended at ${new Date(1_700_000_000_000).toISOString()}; request a renewal`);
  assert.equal(d.overlays[0].id, "ov_d");
});

test("overlay with no bundle (chain-only scope) doesn't narrow providers but is reported", async () => {
  const guard = new MemoryGuard().overlay({ id: "ov_e", name: PAYOUT, chain: '{"v":1}' });
  const d = await decide({ name: PAYOUT, provider: "stripe" }, setup(guard));
  assert.equal(d.allowed, true, d.reason ?? "");
  assert.equal(d.overlays[0].chain, '{"v":1}');
});

test("registerGuardFactory: relayDeps() uses the registered guard; a failing factory fails closed", () => {
  try {
    const g = new MemoryGuard();
    let built = 0;
    registerGuardFactory(() => {
      built++;
      return g;
    });
    assert.equal(relayGuard(), g);
    assert.equal(relayGuard(), g);
    assert.equal(built, 1);
    process.env.RELAY_DATA_DIR = tempDir();
    assert.equal(relayDeps().guard, g);

    registerGuardFactory(() => {
      throw new Error("no data dir");
    });
    const broken = relayGuard();
    assert.ok(broken);
    assert.match(broken.unavailable?.() ?? "", /could not start \(no data dir\)/);

    setRelayGuard(g);
    assert.equal(relayGuard(), g);
  } finally {
    registerGuardFactory(null);
    setRelayGuard(null);
  }
  assert.equal(relayGuard(), null);
});
