// Renewal rules R1–R10, same-or-narrower = clear, the narrower-scope check,
// the canonical binding and the chain-grant reader.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Address } from "viem";

import { bundle } from "../testkit";
import { approvalMessage, bindingDigest, canonicalJson } from "./binding";
import { eligibilityProblem } from "./requirements";
import { defaultNarrower, narrowerProblem, renewalFlags } from "./rules";
import { parseGrant } from "../../chain/grant";
import { type ChainScope, type ScopeView, chainScopeText, readChainScope, readBundle, scopeKey, scopeOf } from "./scope";

const SUPPLIER = "0x00000000000000000000000000000000000000a1" as Address;
const CONTRACTOR = "0x00000000000000000000000000000000000000a2" as Address;
const STRANGER = "0x00000000000000000000000000000000000000ff";
const known = { supplier: SUPPLIER, contractor: CONTRACTOR };
const NOW = 1_800_000_000;
const DAY = 86400;

const grant = (over: Partial<ChainScope> = {}): ChainScope => ({
  v: 1,
  caps: ["read", "prepare", "submit"],
  net: ["sepolia"],
  contracts: ["vault"],
  methods: { vault: ["pay"] },
  to: ["supplier"],
  max: "20",
  limit: "20",
  period: "month",
  gas: "300000",
  ...over,
});

const base = (over: Partial<ScopeView> = {}): ScopeView => ({
  bundle: bundle("codex,mock", { caps: { codex: 20 }, maxes: { mock: 300 }, period: "month" }),
  chain: grant(),
  expiry: NOW + 20 * DAY,
  owner: "0x0000000000000000000000000000000000000001",
  ...over,
});

const ids = (next: ScopeView, prev = base(), prevTermSec: number | null = 30 * DAY) =>
  renewalFlags(prev, next, { nowSec: NOW, prevTermSec, knownRecipients: known }).map((f) => f.id);

test("same scope, a renewal of the same term and narrower changes are clear", () => {
  assert.deepEqual(ids(base()), []);
  assert.deepEqual(ids(base({ expiry: NOW + 30 * DAY })), []);
  assert.deepEqual(ids(base({ bundle: bundle("codex", { caps: { codex: 5 }, period: "total" }) })), []);
  assert.deepEqual(ids(base({ chain: grant({ max: "5", limit: "5", to: ["supplier"], caps: ["read"] }) })), []);
  assert.deepEqual(ids(base({ chain: null, bundle: null })), []);
});

test("R1–R10 each fire on their expansion", () => {
  assert.deepEqual(ids(base({ bundle: bundle("codex,mock,claude", { caps: { codex: 20 }, maxes: { mock: 300 } }) })), ["R1"]);
  assert.deepEqual(ids(base({ bundle: bundle("codex,mock", { caps: { codex: 60 }, maxes: { mock: 300 } }) })), ["R2"]);
  assert.deepEqual(ids(base({ bundle: bundle("codex,mock", { maxes: { mock: 300 } }) })), ["R2"], "cap removed");
  assert.deepEqual(ids(base({ bundle: bundle("codex,mock", { caps: { codex: 20 } }) })), ["R3"], "count cap removed");
  assert.deepEqual(ids(base({ bundle: bundle("codex,mock", { caps: { codex: 20 }, maxes: { mock: 300 }, period: "day" }) })), ["R4"]);
  assert.deepEqual(ids(base({ expiry: NOW + 90 * DAY })), ["R5"]);
  assert.deepEqual(ids(base({ expiry: NOW + 20 * DAY }), base({ expiry: NOW + 5 * DAY }), 10 * DAY), ["R5"], "longer than 1.1x the previous term");
  assert.deepEqual(ids(base({ chain: grant({ to: ["supplier", "contractor"] }) })), ["R6"], "known new recipient");
  assert.deepEqual(ids(base({ chain: grant({ to: ["supplier", STRANGER] }) })), ["R6", "R7"], "unknown recipient is critical");
  const r7 = renewalFlags(base(), base({ chain: grant({ to: [STRANGER] }) }), { nowSec: NOW, knownRecipients: known }).find((f) => f.id === "R7");
  assert.equal(r7?.severity, "critical");
  assert.deepEqual(ids(base({ chain: grant({ to: undefined }) })), ["R6"], "recipient list removed");
  assert.deepEqual(ids(base({ chain: grant({ limit: "200" }) })), ["R8"]);
  assert.deepEqual(ids(base({ chain: grant({ max: undefined }) })), ["R8"]);
  assert.deepEqual(ids(base({ chain: grant({ caps: ["read", "prepare", "submit", "deploy"] }) })), ["R9"]);
  assert.deepEqual(ids(base({ chain: grant({ methods: { vault: ["pay", "ownerTransfer"] } }) })), ["R9"]);
  assert.deepEqual(ids(base({ chain: grant() }), base({ chain: null })), ["R9", "R6"], "a new grant (with its recipients)");
  assert.deepEqual(ids(base({ owner: "0x0000000000000000000000000000000000000002" })), ["R10"]);
});

test("a record the enforcement parser accepts is never adopted unflagged by the rules", () => {
  const prevText = JSON.stringify({ ...grant({ max: "1", limit: "20", delegate: false, approve: "always" }) });
  // A parent agent widens its subagent: new recipient, max 1 → 10, limit 20 → 200, delegation, no
  // approval, and a 25-digit gas value that the rules parser used to reject (so it read as "no access").
  const nextText = JSON.stringify({ ...grant({ to: ["supplier", "contractor"], max: "10", limit: "200", delegate: true, approve: "never" }), gas: "1000000000000000000000000" });
  assert.ok(parseGrant(nextText, { recipients: known, token: { decimals: 18 } } as never), "enforcement accepts it");
  const prev = scopeOf({ bundle: null, chain: prevText, expiry: null, owner: null });
  const next = scopeOf({ bundle: null, chain: nextText, expiry: null, owner: null });
  const flags = renewalFlags(prev, next, { nowSec: NOW, knownRecipients: known }).map((f) => f.id);
  assert.ok(flags.includes("R8") && flags.includes("R9") && flags.includes("R6"), flags.join(","));
  // Any non-empty record the rules can't read fails closed as a critical R9, never "no access".
  const longName = "x".repeat(81);
  const odd = JSON.stringify({ v: 1, caps: ["read"], net: ["sepolia"], contracts: ["vault"], to: [longName] });
  assert.ok(parseGrant(odd, { recipients: { [longName]: SUPPLIER }, token: { decimals: 18 } } as never), "enforcement accepts it");
  const unreadable = scopeOf({ bundle: null, chain: odd, expiry: null, owner: null });
  assert.equal(unreadable.chain, null);
  assert.equal(unreadable.chainUnreadable, true);
  const f = renewalFlags(prev, unreadable, { nowSec: NOW, knownRecipients: known });
  assert.deepEqual(f.map((x) => [x.id, x.severity]), [["R9", "critical"]]);
  assert.notEqual(scopeKey(unreadable), scopeKey(scopeOf({ bundle: null, chain: null, expiry: null, owner: null })));
  // An empty record is simply "no grant".
  assert.equal(scopeOf({ bundle: null, chain: "  ", expiry: null, owner: null }).chainUnreadable, undefined);
});

test("the demo renewal (new recipient, 200 STD/month, 90 days) trips R5, R6, R7, R8", () => {
  const next = base({ chain: grant({ to: ["supplier", STRANGER], limit: "200", max: "200" }), expiry: NOW + 90 * DAY });
  assert.deepEqual(ids(next).sort(), ["R5", "R6", "R7", "R8"]);
});

test("readChainScope: strict (unknown keys, bad amounts), canonical text round-trips", () => {
  const g = grant({ to: [SUPPLIER], exp: 1_790_000_000, delegate: true, approve: "always" });
  const text = chainScopeText(g);
  assert.ok(text.startsWith('{"v":1,"caps":'));
  assert.deepEqual(readChainScope(text), { ...g, to: [SUPPLIER.toLowerCase()] });
  assert.equal(readChainScope('{"v":1,"caps":[],"net":[],"contracts":[],"evil":1}'), null);
  assert.equal(readChainScope('{"v":1,"caps":[],"net":[],"contracts":[],"max":"-1"}'), null);
  assert.equal(readChainScope('{"v":2,"caps":[],"net":[],"contracts":[]}'), null);
  assert.equal(readChainScope("not json"), null);
  assert.equal(readBundle({ keys: ["nope"] }), null);
  assert.deepEqual(readBundle({ keys: ["codex"], caps: { codex: 2 } }), { keys: ["codex"], caps: { codex: 2 }, maxes: {}, period: "month" });
});

test("narrowerProblem: within previous ∪ proposed, at most a day; the default narrower passes", () => {
  const prev = base();
  const proposed = base({ chain: grant({ to: ["supplier", STRANGER], limit: "200", max: "200" }) });
  const d = defaultNarrower(prev);
  assert.equal(d.chain?.max, "5");
  assert.equal(d.durationSec, 3600);
  assert.equal(narrowerProblem(d, prev, proposed, known), null);
  assert.match(narrowerProblem({ ...d, durationSec: 2 * DAY }, prev, proposed, known) ?? "", /duration/);
  assert.match(narrowerProblem({ ...d, chain: grant({ to: ["contractor"] }) }, prev, proposed, known) ?? "", /recipients/);
  assert.match(narrowerProblem({ ...d, chain: grant({ max: "500" }) }, prev, proposed, known) ?? "", /max/);
  assert.match(narrowerProblem({ ...d, chain: grant({ caps: ["deploy"] }) }, prev, proposed, known) ?? "", /capabilities/);
  assert.match(narrowerProblem({ ...d, bundle: bundle("claude") }, prev, proposed, known) ?? "", /claude/);
  assert.equal(narrowerProblem({ ...d, chain: grant({ to: [STRANGER], max: "5" }) }, prev, proposed, known), null, "a requested recipient may be approved");
});

test("binding: canonical (sorted keys, strings, lowercase addresses) and bound to every field", () => {
  const b = {
    v: 1 as const,
    root: "acme.eth",
    subject: { kind: "incident" as const, id: "inc_1", revision: 2 },
    target: { name: "p.acme.eth", node: `0x${"1".repeat(64)}` as const, resource: "7", owner: "0x00000000000000000000000000000000000000AB" as Address },
    decision: "approve-narrower" as const,
    scope: defaultNarrower(base()),
    notAfter: NOW + 3600,
    policyVersion: "p",
    approver: "0x00000000000000000000000000000000000000CD" as Address,
    challengeId: "ch_1",
    issuedAt: NOW,
    expiresAt: NOW + 300,
  };
  const json = canonicalJson(b);
  assert.ok(json.includes('"0x00000000000000000000000000000000000000ab"'));
  assert.ok(json.includes('"revision":"2"'));
  assert.ok(json.indexOf('"approver"') < json.indexOf('"challengeId"'));
  const d = bindingDigest(b);
  assert.notEqual(bindingDigest({ ...b, subject: { ...b.subject, revision: 3 } }), d);
  assert.notEqual(bindingDigest({ ...b, notAfter: NOW + 3601 }), d);
  const msg = approvalMessage(b, d, { subjectLine: "Incident inc_1 revision 2: p.acme.eth" });
  assert.match(msg, /Decision: approve a narrower replacement/);
  assert.match(msg, /max 5 STD per tx/);
  assert.ok(msg.endsWith(`Digest: ${d}`));
});

test("eligibility: human levels above the subject; agent keys never", () => {
  const A = "0x00000000000000000000000000000000000000a0" as Address;
  const M = "0x00000000000000000000000000000000000000b0" as Address;
  const G = "0x00000000000000000000000000000000000000c0" as Address;
  const lv = (name: string, owner: Address) => ({ name, owner, status: "registered" as const });
  const levels = [lv("acme.eth", A), lv("m.acme.eth", M), lv("a.m.acme.eth", G), lv("s.a.m.acme.eth", G)];
  assert.equal(eligibilityProblem(levels, A, A), null, "the company owner");
  assert.equal(eligibilityProblem(levels, M, A), null, "the member");
  assert.match(eligibilityProblem(levels, G, A) ?? "", /agent level/);
  assert.match(eligibilityProblem(levels, "0x00000000000000000000000000000000000000ee", A) ?? "", /doesn't own/);
  assert.match(eligibilityProblem(levels.slice(0, 2), M, A) ?? "", /doesn't own a human level above/, "a member can't approve itself");
});
