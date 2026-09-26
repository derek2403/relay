import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type Address, type Hex, namehash } from "viem";

import {
  IllegalTransitionError,
  type NewProposal,
  PROPOSAL_TTL_SEC,
  type Proposal,
  type ProposalState,
  TRANSITIONS,
  approve,
  canonicalJson,
  createProposal,
  expireIfDue,
  findByRequest,
  proposalDigest,
  submitGate,
  transition,
  validRequestId,
} from "./proposals";

const T0 = 1_800_000_000;
const DEREK = "0x4444444444444444444444444444444444444444" as Address;
const HASH = `0x${"cd".repeat(32)}` as Hex;

const input = (over: Partial<NewProposal> = {}): NewProposal => ({
  requestId: "req-1",
  agent: { name: "codex.derek.dev.sodalabs.eth", node: namehash("codex.derek.dev.sodalabs.eth"), resource: "9", owner: DEREK },
  op: "call",
  network: "sepolia",
  target: { kind: "vault", address: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", label: "relay-vault" },
  method: "pay",
  args: ["0x1111111111111111111111111111111111111111", "3000000000000000000", `0x${"00".repeat(32)}`],
  display: { summary: "pay 3 STD to supplier", amount: "3", recipient: "0x1111111111111111111111111111111111111111" },
  tx: { from: "0x5555555555555555555555555555555555555555", to: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", data: "0xabcdef", value: "0", gas: "90000", type: 2 },
  gasEstimate: "80000",
  grantId: `0x${"12".repeat(32)}`,
  approval: { required: true, rule: "always" },
  amountBase: "3000000000000000000",
  ...over,
});

const approved = (at = T0 + 10) => {
  const p = createProposal(input(), T0);
  return approve(p, { approver: DEREK, digest: p.digest, at, challengeId: "ch_1" });
};

describe("proposals", () => {
  test("create: awaiting approval, approved, or blocked", () => {
    const p = createProposal(input(), T0);
    assert.match(p.id, /^prp_[0-9a-f]{24}$/);
    assert.equal(p.state, "awaiting-approval");
    assert.deepEqual(p.events.map((e) => e.state), ["prepared", "awaiting-approval"]);
    assert.equal(p.expiresAt, T0 + PROPOSAL_TTL_SEC);
    assert.equal(p.digest, proposalDigest(p));
    assert.equal(createProposal(input({ approval: { required: false, rule: "never" } }), T0).state, "approved");
    const b = createProposal(input({ tx: null, block: { rule: "recipient", reason: "not approved" } }), T0);
    assert.equal(b.state, "blocked");
    assert.match(b.events[0].detail, /blocked by recipient/);
  });

  test("the digest binds the contents", () => {
    const p = createProposal(input({ id: "prp_fixed" }), T0);
    const same = createProposal(input({ id: "prp_fixed" }), T0 + 99);
    assert.equal(same.digest, p.digest);
    const changes: Partial<NewProposal>[] = [
      { args: ["0x2222222222222222222222222222222222222222", "3000000000000000000", `0x${"00".repeat(32)}`] },
      { tx: { ...input().tx!, data: "0xabcdee" } },
      { tx: { ...input().tx!, gas: "90001" } },
      { grantId: `0x${"13".repeat(32)}` },
      { method: "release" },
      { target: { ...input().target, address: "0x9999999999999999999999999999999999999999" } },
    ];
    for (const c of changes) assert.notEqual(createProposal(input({ id: "prp_fixed", ...c }), T0).digest, p.digest, JSON.stringify(c));
    // Hex case doesn't change it (canonical form).
    const upper = createProposal(input({ id: "prp_fixed", tx: { ...input().tx!, data: "0xABCDEF" } }), T0);
    assert.equal(upper.digest, p.digest);
  });

  test("canonicalJson sorts keys and refuses unsafe numbers", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2n, c: "0xAB" }, e: undefined }), '{"a":{"c":"0xab","d":"2"},"b":1}');
    assert.throws(() => canonicalJson({ x: 1.5 }));
    assert.throws(() => canonicalJson([undefined]));
  });

  test("illegal transitions throw and change nothing", () => {
    const p = createProposal(input(), T0);
    assert.throws(() => transition(p, "submitting", "x"), IllegalTransitionError);
    assert.throws(() => transition(p, "confirmed", "x"), IllegalTransitionError);
    const done = transition(transition(transition(transition(approved(), "submitting", "s"), "submitted", "b"), "included", "i"), "confirmed", "c");
    for (const to of Object.keys(TRANSITIONS) as ProposalState[]) assert.throws(() => transition(done, to, "x"), IllegalTransitionError, `confirmed → ${to}`);
    for (const terminal of ["failed", "rejected", "expired", "blocked"] as const) assert.equal(TRANSITIONS[terminal].length, 0);
    assert.equal(p.state, "awaiting-approval");
  });

  test("the happy path, with a reorg back to submitted", () => {
    let p = approved();
    assert.equal(p.state, "approved");
    assert.equal(p.approval.digest, p.digest);
    p = transition(p, "submitting", "signing", T0 + 20, { submit: { hash: HASH, at: T0 + 20 } });
    p = transition(p, "submitted", "broadcast", T0 + 21);
    p = transition(p, "included", "in block 10", T0 + 30);
    p = transition(p, "submitted", "reorg: block hash changed", T0 + 40);
    p = transition(p, "included", "in block 11", T0 + 50);
    p = transition(p, "confirmed", "2 confirmations", T0 + 70);
    assert.deepEqual(p.events.map((e) => e.state), ["prepared", "awaiting-approval", "approved", "submitting", "submitted", "included", "submitted", "included", "confirmed"]);
  });

  test("approval must be bound to the current digest", () => {
    const p = createProposal(input(), T0);
    assert.throws(() => approve(p, { approver: DEREK, digest: `0x${"00".repeat(32)}`, at: T0 }), /different proposal digest/);
    assert.throws(() => approve(p, { approver: DEREK, digest: p.digest, at: p.expiresAt }), /expired/);
    // A proposal whose contents changed after approval can't be submitted.
    const a = approved();
    const tampered = { ...a, digest: `0x${"77".repeat(32)}` as Hex };
    const g = submitGate(tampered, T0 + 20);
    assert.ok(g.action === "refuse" && g.error === "approval_required");
  });

  test("duplicate requestId returns the existing proposal (per agent)", () => {
    const a = createProposal(input(), T0);
    const other = createProposal(input({ agent: { ...input().agent, name: "watch.codex.derek.dev.sodalabs.eth" } }), T0);
    const list = [a, other];
    assert.equal(findByRequest(list, a.agent.name, "req-1"), a);
    assert.equal(findByRequest(list, other.agent.name, "req-1"), other);
    assert.equal(findByRequest(list, a.agent.name, "req-2"), null);
    assert.ok(validRequestId("task-1:step.2"));
    for (const bad of ["", "a b", "x".repeat(129), 5, null]) assert.equal(validRequestId(bad), false);
  });

  test("double submit: in-flight proposals come back unchanged, never re-signed", () => {
    const a = approved();
    assert.equal(submitGate(a, T0 + 20).action, "proceed");
    let p = transition(a, "submitting", "signing", T0 + 20, { submit: { hash: HASH, at: T0 + 20 } });
    for (const next of [p, (p = transition(p, "submitted", "b")), transition(p, "included", "i")]) {
      const g = submitGate(next, T0 + 9999);
      assert.equal(g.action, "return");
      assert.equal(g.action === "return" && g.proposal, next);
    }
  });

  test("uncertain: returned unchanged by submit, resolved only by the tracker", () => {
    let p = transition(approved(), "submitting", "signing", T0 + 20, { submit: { hash: HASH, at: T0 + 20 } });
    p = transition(p, "uncertain", "network error after sending", T0 + 21, { error: "ECONNRESET" });
    assert.equal(submitGate(p, T0 + 22).action, "return");
    assert.throws(() => transition(p, "submitting", "retry"), IllegalTransitionError, "never retried blindly");
    assert.throws(() => transition(p, "approved", "retry"), IllegalTransitionError);
    assert.equal(transition(p, "submitted", "tracker found the tx by hash").state, "submitted");
    assert.equal(transition(p, "included", "found in a block").state, "included");
    assert.equal(transition(p, "failed", "not found after 10 minutes").state, "failed");
    assert.equal(p.submit?.hash, HASH);
  });

  test("expiry: unsubmitted proposals expire after 30 minutes; submitted ones don't", () => {
    const p = createProposal(input(), T0);
    assert.equal(expireIfDue(p, T0 + PROPOSAL_TTL_SEC - 1), p);
    const e = expireIfDue(p, T0 + PROPOSAL_TTL_SEC);
    assert.equal(e.state, "expired");
    const g = submitGate(approved(), T0 + PROPOSAL_TTL_SEC);
    assert.ok(g.action === "refuse" && g.status === 410);
    const sent = transition(transition(approved(), "submitting", "s"), "submitted", "b");
    assert.equal(expireIfDue(sent, T0 + 10 * PROPOSAL_TTL_SEC), sent);
  });

  test("submit gate refusals", () => {
    const waiting = createProposal(input(), T0);
    const g = submitGate(waiting, T0 + 1);
    assert.ok(g.action === "refuse" && g.error === "approval_required" && g.status === 403);
    for (const s of ["rejected", "blocked", "failed"] as const) {
      const r = submitGate({ ...waiting, state: s } as Proposal, T0 + 1);
      assert.ok(r.action === "refuse" && r.status === 409, s);
    }
    const noApprovalNeeded = createProposal(input({ approval: { required: false, rule: "never" } }), T0);
    assert.equal(submitGate(noApprovalNeeded, T0 + 1).action, "proceed");
  });
});
