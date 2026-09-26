// The approvals flow end to end at the handler level: renewals (clear /
// paused), the pause in decide(), World enrollment, challenge → confirm with
// a wallet signature and a World proof (fake Portal), replay, wrong person,
// expiry, revision, wrong approver, agent tokens refused, reject / revoke,
// approve-narrower overlays enforced by decide(), chain proposals through the
// hooks, drift, reports and a corrupt store failing closed.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { namehash } from "../../ens/names";
import { loadConfig } from "../config";
import type { ChainLevel } from "../ens";
import { Meter } from "../meter";
import { verifyEoaSignature } from "../owner-session";
import { decide } from "../policy";
import { RateLimiter, createLimits } from "../ratelimit";
import { MemoryChain, bundle, fakeUpstream, level, tempDir, tokenFor } from "../testkit";
import { hashSignal } from "../world/rp";
import * as api from "./api";
import { approvalsGuard } from "./guard";
import { hooks } from "./hooks";
import { ApprovalsStore } from "./store";
import { registerApprovalHooks } from "../../chain/executor";
import { createProposal, submitGate } from "../../chain/proposals";
import { ChainStore } from "../../chain/store";

const admin = privateKeyToAccount(generatePrivateKey());
const derek = privateKeyToAccount(generatePrivateKey());
const emma = privateKeyToAccount(generatePrivateKey());
const codex = privateKeyToAccount(generatePrivateKey());
const payout = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());

const ROOT = "acme.eth";
const DEREK = `derek.${ROOT}`;
const EMMA = `emma.${ROOT}`;
const AGENT = `codex.${DEREK}`;
const PAYOUT = `payout.${AGENT}`;
const CHILD = `leaf.${PAYOUT}`;
const SIBLING = `watch.${AGENT}`;
const SUPPLIER = "0x00000000000000000000000000000000000000a1";
const STRANGER = "0x00000000000000000000000000000000000000ff";
const N_DEREK = `0x${"0d".repeat(32)}` as Hex;
const N_OTHER = `0x${"0e".repeat(32)}` as Hex;

const GRANT = JSON.stringify({ v: 1, caps: ["read", "prepare", "submit"], net: ["sepolia"], contracts: ["vault"], methods: { vault: ["pay"] }, to: [SUPPLIER], max: "20", limit: "20", period: "month", gas: "300000" });

let portalNullifier: Hex = N_DEREK;
let portalDown = false;
let portal: Awaited<ReturnType<typeof fakeUpstream>>;
before(async () => {
  portal = await fakeUpstream((_req, res) => {
    if (portalDown) {
      res.writeHead(503, { "content-type": "text/plain" });
      return res.end("down");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, nullifier: portalNullifier, environment: "production", results: [{ identifier: "selfie", success: true, nullifier: portalNullifier }] }));
  });
});
after(() => portal.close());

type Ctx = ReturnType<typeof setup>;
let ctx: Ctx;

function setup(worldOn = true) {
  const dir = tempDir("relay-approvals-");
  const now = Math.floor(Date.now() / 1000);
  const levels: ChainLevel[] = [
    level(ROOT, admin.address, bundle("codex,mock")),
    level(DEREK, derek.address, bundle("codex,mock")),
    level(EMMA, emma.address, bundle("codex,mock")),
    level(AGENT, codex.address, bundle("codex,mock")),
    level(PAYOUT, payout.address, bundle("mock", { caps: { mock: 20 }, period: "month" }), { resource: "9", chain: GRANT, expiry: now + 20 * 86400 }),
    level(CHILD, payout.address, bundle("mock")),
    level(SIBLING, codex.address, bundle("mock")),
  ];
  const chain = new MemoryChain(levels);
  const env: Record<string, string> = {
    RELAY_ROOT_NAME: ROOT,
    RELAY_ROOT_OWNER: admin.address,
    RELAY_DATA_DIR: dir,
    ...(worldOn
      ? { WORLD_APP_ID: "app_test", WORLD_RP_ID: "rp_test", WORLD_RP_SIGNING_KEY: `0x${"22".repeat(32)}`, WORLD_ACTION: "relay-approver", WORLD_ENVIRONMENT: "production", WORLD_PORTAL_URL: portal.url }
      : {}),
  };
  const config = loadConfig(env);
  const meter = new Meter(path.join(dir, "relay.json"), 5);
  const store = new ApprovalsStore(path.join(dir, "approvals.json"));
  let clock = Date.now();
  const deps: api.ApprovalsDeps = {
    config,
    reader: chain,
    meter,
    store,
    env,
    fetch,
    verifySignature: verifyEoaSignature,
    now: () => clock,
    limits: createLimits(),
    knownRecipients: () => ({ supplier: SUPPLIER as Address }),
    confirmLimit: new RateLimiter(1000, 1000),
  };
  const guard = approvalsGuard({ store, meter: () => meter, root: () => ROOT, rootOwner: () => admin.address, knownRecipients: deps.knownRecipients });
  const policy = { config, reader: chain, meter, guard, now: () => new Date(clock) };
  return {
    dir,
    chain,
    levels,
    deps,
    store,
    guard,
    policy,
    advance: (sec: number) => void (clock += sec * 1000),
    set: (name: string, over: Partial<ChainLevel>) => {
      const i = levels.findIndex((l) => l.name === name);
      levels[i] = { ...levels[i], ...over };
    },
  };
}

beforeEach(() => {
  ctx = setup();
  portalNullifier = N_DEREK;
  portalDown = false;
  hooks.proposal = null;
  hooks.proposalApproved = null;
  hooks.proposalRejected = null;
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/relay/approvals/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function call(fn: (r: Request, d: api.ApprovalsDeps) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) {
  const res = await fn(post(body, headers), ctx.deps);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const allowed = async (name: string) => (await decide({ name, provider: "mock" }, ctx.policy)).allowed;
const decision = (name: string) => decide({ name, provider: "mock" }, ctx.policy);

async function renewWide() {
  const kr = await tokenFor(codex, AGENT);
  return call(
    api.postRenewal,
    {
      subject: PAYOUT,
      proposed: { chain: { ...JSON.parse(GRANT), to: [SUPPLIER, STRANGER], limit: "200", max: "200" }, expiresAt: Math.floor(ctx.deps.now() / 1000) + 90 * 86400 },
      reason: "Supplier moved banks.\u0007 Please approve.",
    },
    { "x-api-key": kr },
  );
}

const proof = (signal: string, nonce: string, nullifier: Hex = N_DEREK) => ({
  protocol_version: "3.0",
  nonce,
  action: "relay-approver",
  environment: "production",
  responses: [{ identifier: "selfie", signal_hash: hashSignal(signal), proof: `0x${"33".repeat(64)}`, merkle_root: `0x${"44".repeat(32)}`, nullifier }],
});

async function enroll(who = derek, name = DEREK, nullifier: Hex = N_DEREK) {
  const ch = await call(api.postEnrollChallenge, { approver: who.address, name });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  portalNullifier = nullifier;
  const signature = await who.signMessage({ message: ch.json.message });
  const res = await call(api.postEnrollConfirm, { challengeId: ch.json.challengeId, signature, world: proof(ch.json.world.signal, ch.json.world.rp_context.nonce, nullifier) });
  portalNullifier = N_DEREK;
  return res;
}

async function challenge(incidentId: string, decisionName: string, who = derek, scope?: unknown) {
  return call(api.postChallenge, { subject: { kind: "incident", id: incidentId }, decision: decisionName, approver: who.address, ...(scope ? { scope } : {}) });
}

async function confirm(ch: Record<string, any>, who = derek, nullifier: Hex = N_DEREK, over: Record<string, unknown> = {}) {
  const signature = await who.signMessage({ message: ch.message });
  const world = ch.world ? proof(ch.world.signal, ch.world.rp_context.nonce, nullifier) : undefined;
  return call(api.postConfirm, { challengeId: ch.challengeId, signature, world, ...over });
}

const NARROW = { chain: { ...JSON.parse(GRANT), max: "5", limit: "5", period: "total" }, bundle: { keys: ["mock"], caps: { mock: 1 }, period: "total" }, durationSec: 3600 };

test("a same-or-narrower renewal is clear; nothing pauses", async () => {
  const kr = await tokenFor(codex, AGENT);
  const r = await call(api.postRenewal, { subject: PAYOUT, proposed: { chain: { ...JSON.parse(GRANT), limit: "10" } } }, { "x-api-key": kr });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "clear");
  assert.match(r.json.expectId, /^exp_/);
  assert.equal(await allowed(PAYOUT), true);
});

test("a wide renewal opens an incident and pauses the subject and descendants, not a sibling", async () => {
  const r = await renewWide();
  assert.equal(r.status, 202);
  assert.equal(r.json.status, "paused");
  const flags = r.json.flags.map((f: { id: string }) => f.id).sort();
  assert.deepEqual(flags, ["R5", "R6", "R7", "R8"]);
  const d = await decision(PAYOUT);
  assert.equal(d.denial, "paused");
  assert.match(d.reason ?? "", new RegExp(`paused: ${PAYOUT} is under review \\(incident ${r.json.incident.id}\\)`));
  assert.equal((await decision(CHILD)).denial, "paused");
  assert.equal(await allowed(SIBLING), true);
  const inc = await api.getIncident(r.json.incident.id, ctx.deps).json();
  assert.equal(inc.agentReports[0].text, "Supplier moved banks. Please approve.", "control characters stripped");
  assert.match(inc.agentReports[0].label, /unverified/);
  assert.equal(inc.suggested[0].decision, "reject");
  // Renewing again attaches, doesn't lift.
  const again = await renewWide();
  assert.equal(again.json.incident.id, r.json.incident.id);
  assert.equal((await decision(PAYOUT)).denial, "paused");
  // Only agents above (or the subject itself) may ask.
  const other = await call(api.postRenewal, { subject: PAYOUT, proposed: {} }, { "x-api-key": await tokenFor(codex, SIBLING) });
  assert.equal(other.status, 403);
});

test("enrollment: links once; a World ID already linked elsewhere is refused", async () => {
  const e = await enroll();
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.equal(e.json.linked, true);
  const status = await api.getApprover(derek.address, ctx.deps).json();
  assert.equal(status.linked, true);
  assert.equal((await call(api.postEnrollChallenge, { approver: derek.address, name: DEREK })).status, 409);
  const dup = await enroll(emma, EMMA, N_DEREK);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, "nullifier_linked");
  assert.equal((await call(api.postEnrollChallenge, { approver: codex.address, name: AGENT })).status, 403, "agent keys can't enroll");
});

test("approve narrower: wallet + World → overlay enforced by decide(), bucket metered, then it ends", async () => {
  await enroll();
  const r = await renewWide();
  const id = r.json.incident.id;
  const ch = await challenge(id, "approve-narrower", derek, NARROW);
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  assert.equal(ch.json.world.signal, `relay-approve:v1:${ch.json.digest}`);
  assert.match(ch.json.message, /approve a narrower replacement/);
  const ok = await confirm(ch.json);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.paused, false);
  const d = await decision(PAYOUT);
  assert.equal(d.allowed, true, d.reason ?? "");
  assert.equal(d.overlays.length, 1);
  assert.equal(JSON.parse(d.overlays[0].chain!).max, "5", "the narrower chain grant rides on the overlay");
  assert.equal(d.remaining, 1, "the overlay's $1 cap applies, not the chain's $20");
  // Replaying the same challenge is refused.
  const replay = await confirm(ch.json);
  assert.equal(replay.status, 409);
  // After an hour the approved scope has ended.
  ctx.advance(3601);
  const ended = await decision(PAYOUT);
  assert.equal(ended.allowed, false);
  assert.match(ended.reason ?? "", /approved scope for .* ended at/);
  // The incident is resolved with World evidence; remediation untouched.
  const inc = await api.getIncident(id, ctx.deps).json();
  assert.equal(inc.state, "resolved:approved-narrower");
  assert.equal(inc.resolution.world.environment, "production");
  assert.equal(inc.resolution.world.nullifier, undefined, "the public incident never shows the approver's World nullifier");
  assert.ok(!JSON.stringify(inc).includes(N_DEREK.slice(2)));
  assert.equal(ctx.store.data.incidents[id].resolution!.world!.nullifier, N_DEREK, "kept in the store for the audit");
  assert.equal(inc.remediation, "not assessed");
});

test("12 parallel confirms: exactly one succeeds", async () => {
  await enroll();
  const id = (await renewWide()).json.incident.id;
  const ch = await challenge(id, "approve-narrower", derek, NARROW);
  const results = await Promise.all(Array.from({ length: 12 }, () => confirm(ch.json)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409));
});

test("wrong person, wrong signal, expired, cancelled, Portal down: all stay paused", async () => {
  await enroll();
  const id = (await renewWide()).json.incident.id;
  // A different human (nullifier).
  let ch = await challenge(id, "approve-narrower", derek, NARROW);
  portalNullifier = N_OTHER;
  let res = await confirm(ch.json, derek, N_OTHER);
  portalNullifier = N_DEREK;
  assert.equal(res.status, 422);
  assert.equal(res.json.error, "wrong_person");
  assert.equal((await decision(PAYOUT)).denial, "paused");
  // A proof made for another challenge.
  const ch1 = await challenge(id, "approve-narrower", derek, NARROW);
  const ch2 = await challenge(id, "approve-narrower", derek, NARROW);
  const sig = await derek.signMessage({ message: ch2.json.message });
  res = await call(api.postConfirm, { challengeId: ch2.json.challengeId, signature: sig, world: proof(ch1.json.world.signal, ch2.json.world.rp_context.nonce) });
  assert.equal(res.json.error, "signal_mismatch");
  // Expired.
  ch = await challenge(id, "approve-narrower", derek, NARROW);
  ctx.advance(301);
  res = await confirm(ch.json);
  assert.equal(res.status, 410);
  // Cancelled.
  ch = await challenge(id, "approve-narrower", derek, NARROW);
  assert.equal((await call(api.postCancel, { challengeId: ch.json.challengeId })).json.status, "cancelled");
  assert.equal((await confirm(ch.json)).status, 409);
  // Portal unreachable.
  ch = await challenge(id, "approve-narrower", derek, NARROW);
  portalDown = true;
  res = await confirm(ch.json);
  assert.equal(res.status, 502);
  assert.equal(res.json.error, "world_unreachable");
  // Bad wallet signature.
  portalDown = false;
  ch = await challenge(id, "approve-narrower", derek, NARROW);
  res = await confirm(ch.json, emma);
  assert.equal(res.json.error, "bad_signature");
  assert.equal((await decision(PAYOUT)).denial, "paused");
  assert.equal((await decision(CHILD)).denial, "paused");
});

test("incident revised after the challenge (the chain changed) → 409 incident_changed", async () => {
  await enroll();
  const id = (await renewWide()).json.incident.id;
  const ch = await challenge(id, "approve-narrower", derek, NARROW);
  ctx.set(PAYOUT, { bundle: bundle("mock,codex", { caps: { mock: 50 } }) });
  await decision(PAYOUT); // observe() sees the change
  const res = await confirm(ch.json);
  assert.equal(res.status, 409);
  assert.equal(res.json.error, "challenge_used", "the pending challenge was voided");
  const inc = await api.getIncident(id, ctx.deps).json();
  assert.equal(inc.revision, 2);
});

test("wrong approvers: agent key owner and outsiders are refused; kr1 and admin tokens can't confirm", async () => {
  await enroll();
  const id = (await renewWide()).json.incident.id;
  assert.equal((await challenge(id, "reject", codex)).status, 403);
  assert.equal((await challenge(id, "reject", outsider)).status, 403);
  assert.equal((await challenge(id, "reject", emma)).status, 403, "emma owns no level above this subject");
  assert.equal((await challenge(id, "approve-narrower", admin, NARROW)).json.error, "not_enrolled");
  const ch = await challenge(id, "reject");
  const signature = await derek.signMessage({ message: ch.json.message });
  const kr = await tokenFor(codex, AGENT);
  assert.equal((await call(api.postConfirm, { challengeId: ch.json.challengeId, signature }, { "x-api-key": kr })).status, 401);
  assert.equal((await call(api.postConfirm, { challengeId: ch.json.challengeId, signature }, { authorization: "Bearer admin-secret" })).status, 401);
  // A second approver can't confirm the first one's challenge.
  const stolen = await emma.signMessage({ message: ch.json.message });
  assert.equal((await call(api.postConfirm, { challengeId: ch.json.challengeId, signature: stolen })).json.error, "bad_signature");
});

test("reject keeps the pause (wallet only); revoke makes it permanent", async () => {
  const id = (await renewWide()).json.incident.id;
  const ch = await challenge(id, "reject");
  assert.equal(ch.json.world, null, "reject needs no World step");
  const res = await confirm(ch.json);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.paused, true);
  assert.equal((await decision(PAYOUT)).denial, "paused");
  const inc = await api.getIncident(id, ctx.deps).json();
  assert.equal(inc.state, "resolved:rejected");
  // A second incident on another agent, revoked.
  ctx = setup();
  const id2 = (await renewWide()).json.incident.id;
  const rv = await challenge(id2, "revoke", admin);
  assert.equal((await confirm(rv.json, admin)).status, 200);
  assert.equal(ctx.store.data.suspensions[`${namehash(PAYOUT)}:9`].permanent, true);
  assert.equal((await decision(CHILD)).denial, "paused");
});

test("approval that needs World on a relay without World → 503, no downgrade", async () => {
  ctx = setup(false);
  const id = (await renewWide()).json.incident.id;
  const ch = await challenge(id, "approve-narrower", derek, NARROW);
  assert.equal(ch.status, 503);
  assert.equal(ch.json.error, "world_not_configured");
  assert.equal((await challenge(id, "reject")).status, 200, "reject still works");
});

test("chain proposals: wallet-only approval through the hooks, bound to the proposal digest", async () => {
  const digest = `0x${"ab".repeat(32)}` as Hex;
  const state = { value: "awaiting-approval", digest };
  const approved: string[] = [];
  hooks.proposal = (id) =>
    id === "prp_1"
      ? { id, state: state.value, digest: state.digest, agent: { name: AGENT, node: namehash(AGENT), resource: "7", owner: codex.address }, summary: "pay 3 STD to supplier", expiresAt: Math.floor(ctx.deps.now() / 1000) + 1800 }
      : null;
  hooks.proposalApproved = (id, a) => {
    assert.equal(a.approver, derek.address);
    approved.push(id);
    state.value = "approved";
  };
  const ch = await call(api.postChallenge, { subject: { kind: "proposal", id: "prp_1" }, decision: "approve", approver: derek.address });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  assert.equal(ch.json.world, null);
  assert.match(ch.json.message, new RegExp(`Proposal digest: ${digest}`));
  // The proposal changes under the challenge → refused.
  state.digest = `0x${"cd".repeat(32)}`;
  assert.equal((await confirm(ch.json)).json.error, "proposal_changed");
  state.digest = digest;
  const ch2 = await call(api.postChallenge, { subject: { kind: "proposal", id: "prp_1" }, decision: "approve", approver: derek.address });
  assert.equal((await confirm(ch2.json)).status, 200);
  assert.deepEqual(approved, ["prp_1"]);
  assert.equal((await call(api.postChallenge, { subject: { kind: "proposal", id: "prp_1" }, decision: "approve", approver: derek.address })).status, 409);
  assert.equal((await call(api.postChallenge, { subject: { kind: "proposal", id: "prp_1" }, decision: "revoke", approver: derek.address })).status, 400);
});

test("chain proposals end to end: challenge → confirm through the real chain hooks, then submit-ready", async () => {
  const chainStore = new ChainStore(path.join(ctx.dir, "chain.json"));
  registerApprovalHooks(() => chainStore, () => null);
  const p = createProposal({
    requestId: "pay-1",
    agent: { name: AGENT, node: namehash(AGENT), resource: "7", owner: codex.address },
    op: "call",
    network: "sepolia",
    target: { kind: "vault", address: "0x00000000000000000000000000000000000007a1", label: "relay-vault" },
    method: "pay",
    args: [SUPPLIER, "3000000000000000000", `0x${"ab".repeat(32)}`],
    display: { summary: "pay 3 STD to supplier" },
    tx: { from: "0x00000000000000000000000000000000000005a0", to: "0x00000000000000000000000000000000000007a1", data: "0x1234", value: "0", gas: "90000", type: 2 },
    gasEstimate: "90000",
    grantId: `0x${"11".repeat(32)}`,
    approval: { required: true, rule: "always" },
    amountBase: "3000000000000000000",
  });
  chainStore.addProposal(p);
  const ch = await call(api.postChallenge, { subject: { kind: "proposal", id: p.id }, decision: "approve", approver: derek.address });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  assert.notEqual(ch.json.digest, p.digest, "the challenge's binding digest is not the proposal digest");
  const ok = await confirm(ch.json);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const approved = chainStore.proposal(p.id)!;
  assert.equal(approved.state, "approved");
  assert.equal(approved.approval.digest, p.digest, "bound to the proposal digest the approver's message named");
  assert.equal(approved.approval.challengeId, ch.json.challengeId);
  assert.equal(submitGate(approved).action, "proceed", "submit accepts the approval");
  // Reject goes through the same binding.
  const q = chainStore.addProposal(createProposal({ ...p, id: undefined, requestId: "pay-2" } as never)).proposal;
  const rj = await call(api.postChallenge, { subject: { kind: "proposal", id: q.id }, decision: "reject", approver: derek.address });
  assert.equal((await confirm(rj.json)).status, 200);
  assert.equal(chainStore.proposal(q.id)!.state, "rejected");
});

test("drift: a wider bundle written straight to ENS opens an incident on the next call; a narrower one is adopted", async () => {
  assert.equal(await allowed(PAYOUT), true); // first sight: baseline
  ctx.set(PAYOUT, { bundle: bundle("mock", { caps: { mock: 5 }, period: "month" }) });
  assert.equal(await allowed(PAYOUT), true, "narrower: adopted");
  ctx.set(PAYOUT, { bundle: bundle("mock,codex", { caps: { mock: 500 } }) });
  const d = await decision(PAYOUT);
  assert.equal(d.denial, "paused");
  const list = await api.listIncidents(ctx.deps).json();
  assert.equal(list.incidents[0].trigger, "drift");
  assert.deepEqual(list.paused, [{ name: PAYOUT, incidentId: list.incidents[0].id }]);
});

test("relay login widening an existing agent within the member's own scope is adopted, not paused", async () => {
  // Derek's own level allows multibaas and holds a blockchain grant.
  ctx.set(DEREK, { bundle: bundle("codex,mock,multibaas"), chain: JSON.stringify({ ...JSON.parse(GRANT), delegate: true }) });
  assert.equal(await allowed(AGENT), true); // first sight: baseline without multibaas or a chain grant
  // Re-running `relay login` rewrites the same codex agent (same key, same resource) on Derek's resolver.
  ctx.set(AGENT, { bundle: bundle("codex,mock,multibaas"), chain: GRANT });
  const d = await decision(AGENT);
  assert.equal(d.allowed, true, d.reason ?? "");
  assert.equal(Object.keys(ctx.store.data.incidents).length, 0);
  assert.ok(ctx.store.data.audit.some((a) => a.kind === "owner_changed" && a.subject === AGENT));
  // Beyond Derek's own scope is still an expansion: paused.
  ctx.set(AGENT, { bundle: bundle("codex,mock,multibaas,claude"), chain: GRANT });
  assert.equal((await decision(AGENT)).denial, "paused");
});

test("a grandchild widened within the member's scope still opens an incident", async () => {
  ctx.set(DEREK, { bundle: bundle("codex,mock,multibaas"), chain: JSON.stringify({ ...JSON.parse(GRANT), delegate: true }) });
  assert.equal(await allowed(PAYOUT), true);
  ctx.set(PAYOUT, { bundle: bundle("mock,codex", { caps: { mock: 20 }, period: "month" }) });
  assert.equal((await decision(PAYOUT)).denial, "paused");
});

test("a cleared renewal is adopted when it lands on ENS", async () => {
  await allowed(PAYOUT);
  const kr = await tokenFor(codex, AGENT);
  const expiresAt = Math.floor(ctx.deps.now() / 1000) + 30 * 86400;
  const r = await call(api.postRenewal, { subject: PAYOUT, proposed: { expiresAt } }, { "x-api-key": kr });
  assert.equal(r.json.status, "clear");
  ctx.set(PAYOUT, { expiry: expiresAt });
  assert.equal(await allowed(PAYOUT), true);
  assert.equal(Object.keys(ctx.store.data.expects).length, 0, "the expect was consumed");
});

test("agent reports: stored untrusted, may pause a name below, 3 per hour, never resolve", async () => {
  const kr = await tokenFor(codex, AGENT);
  const r = await call(api.postReport, { subject: PAYOUT, category: "possible-exfiltration", explanation: "it asked for a new wallet" }, { "x-api-key": kr });
  assert.equal(r.status, 202);
  assert.equal((await decision(PAYOUT)).denial, "paused");
  const again = await call(api.postReport, { subject: PAYOUT, category: "possible-exfiltration", explanation: "more" }, { "x-api-key": kr });
  assert.equal(again.json.status, "attached");
  assert.equal((await call(api.postReport, { subject: DEREK, category: "x", explanation: "y" }, { "x-api-key": kr })).status, 403);
  const inc = await api.getIncident(r.json.incident.id, ctx.deps).json();
  assert.equal(inc.agentReports.length, 2);
  assert.ok(inc.agentReports.every((a: { untrusted: boolean }) => a.untrusted));
});

test("a corrupt approvals file fails closed: agent names are refused, nothing is overwritten", async () => {
  const file = path.join(ctx.dir, "approvals.json");
  fs.writeFileSync(file, "{not json");
  const store = new ApprovalsStore(file);
  assert.match(store.unavailable() ?? "", /damaged/);
  const guard = approvalsGuard({ store, meter: () => null, root: () => ROOT, rootOwner: () => admin.address, knownRecipients: () => ({}) });
  const d = await decide({ name: PAYOUT, provider: "mock" }, { ...ctx.policy, guard });
  assert.equal(d.denial, "paused");
  assert.match(d.reason ?? "", /approvals store unavailable/);
  assert.throws(() => store.commit(() => 1));
  assert.equal(fs.readFileSync(file, "utf8"), "{not json");
  const res = await api.postChallenge(post({}), { ...ctx.deps, store });
  assert.equal(res.status, 503);
});

test("state survives a restart (a fresh store reads the same file)", async () => {
  const id = (await renewWide()).json.incident.id;
  const again = new ApprovalsStore(path.join(ctx.dir, "approvals.json"));
  assert.equal(again.unavailable(), null);
  assert.equal(again.data.incidents[id].state, "open");
  assert.equal((fs.statSync(path.join(ctx.dir, "approvals.json")).mode & 0o777).toString(8), "600");
});
