import assert from "node:assert/strict";
import test from "node:test";

import {
  type ChainGrant,
  chainEditorModel,
  draftFromGrant,
  emptyChainDraft,
  grantFromDraft,
  grantRows,
  newMemberChainDraft,
  pathGrant,
  readGrant,
  serializeGrant,
  strictestApprove,
  toggleCap,
  withChainKey,
} from "../components/live/chain/grant-model";
import { type Proposal, proposalPath } from "../components/live/chain/api";
import {
  amountText,
  ethText,
  findingRows,
  isPending,
  lifecycle,
  proposalState,
  sortProposals,
  statusRows,
  stdText,
  stepViews,
  submittable,
  wantsAllowance,
} from "../components/live/chain/view";
import {
  affectedNames,
  approverHint,
  defaultNarrow,
  diffRows,
  errorWords,
  evidenceLines,
  flagView,
  narrowScope,
  PRESENCE_NOTE,
  STAGING_NOTE,
  requirements,
  subjectName,
  worldNotes,
  triggerText,
} from "../components/live/approvals/logic";
import { chainRecords } from "../lib/live-bundle-editor";
import { liveChainGrant, toLiveNodes, type RawLiveNode } from "../lib/live/view";

const SUPPLIER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333" as const;
const AGENT = "0x4444444444444444444444444444444444444444" as const;

const full = (extra: Partial<ChainGrant> = {}): ChainGrant => ({
  v: 1,
  caps: ["read", "track", "prepare", "submit", "deploy", "manage"],
  net: ["sepolia"],
  contracts: ["token", "vault", "escrow"],
  methods: { vault: ["pay"], escrow: ["pause", "unpause", "release", "refund"] },
  to: ["supplier", "contractor"],
  max: "10",
  limit: "100",
  period: "month",
  gas: "600000",
  delegate: true,
  approve: "always",
  ...extra,
});

// --- grant-model ------------------------------------------------------------------------

test("readGrant parses the spec record and round-trips through serializeGrant", () => {
  const text =
    '{"v":1,"caps":["read","track","prepare","submit","deploy","manage"],"net":["sepolia"],"contracts":["token","vault","escrow"],"methods":{"vault":["pay"],"escrow":["pause","unpause","release","refund"]},"to":["0x1111111111111111111111111111111111111111"],"max":"5","limit":"20","period":"month","gas":"400000","exp":1790000000,"delegate":true,"approve":"always"}';
  const g = readGrant(text);
  assert.ok(g);
  assert.equal(g.max, "5");
  assert.equal(serializeGrant(g), text);
});

test("readGrant fails closed on unknown keys, bad values, wrong version and oversize text", () => {
  assert.equal(readGrant('{"v":1,"caps":["read"],"net":["sepolia"],"contracts":[],"extra":1}'), null);
  assert.equal(readGrant('{"v":2,"caps":["read"],"net":["sepolia"],"contracts":[]}'), null);
  assert.equal(readGrant('{"v":1,"caps":["fly"],"net":["sepolia"],"contracts":[]}'), null);
  assert.equal(readGrant('{"v":1,"caps":["read"],"net":["mainnet"],"contracts":[]}'), null);
  assert.equal(readGrant('{"v":1,"caps":["read"],"net":["sepolia"],"contracts":[],"max":"1e3"}'), null);
  assert.equal(readGrant('{"v":1,"caps":["read"],"net":["sepolia"],"contracts":[],"approve":"sometimes"}'), null);
  assert.equal(readGrant("not json"), null);
  assert.equal(readGrant(`{"v":1,"caps":[],"net":[],"contracts":[],"to":["${"a".repeat(4100)}"]}`), null);
  assert.equal(readGrant(null), null);
});

test("pathGrant intersects caps, contracts, methods, recipients and takes the tightest values", () => {
  const root = serializeGrant(full({ approve: "above:5" }));
  const member = serializeGrant(full({ caps: ["read", "track", "prepare", "submit"], methods: { vault: ["pay"], escrow: ["pause"] }, max: "5", gas: "400000", to: ["supplier"], approve: "above:2" }));
  const agent = serializeGrant(full({ caps: ["read", "track"], contracts: ["vault"], max: "8", limit: "20", approve: "never" }));
  const p = pathGrant(
    [
      { name: "acme.eth", chain: root },
      { name: "derek.acme.eth", chain: member },
      { name: "codex.derek.acme.eth", chain: agent },
    ],
    { supplier: SUPPLIER },
  );
  assert.ok(p.grant);
  assert.deepEqual(p.grant.caps, ["read", "track"]);
  assert.deepEqual(p.grant.contracts, ["vault"]);
  assert.deepEqual(p.grant.methods, { vault: ["pay"] });
  assert.deepEqual(p.grant.to, ["supplier"]);
  assert.equal(p.grant.max, "5");
  assert.equal(p.grant.gas, "400000");
  assert.equal(p.grant.approve, "above:2");
  assert.deepEqual(
    p.perLevel.map((l) => l.limit),
    ["100", "100", "20"],
  );
});

test("pathGrant: a missing level grant, delegate:false above, and unknown records", () => {
  const root = serializeGrant(full());
  assert.match(pathGrant([{ name: "acme.eth", chain: root }, { name: "b.acme.eth", chain: null }]).reason ?? "", /b\.acme\.eth has no blockchain grant/);
  const noDelegate = serializeGrant(full({ delegate: false }));
  assert.match(pathGrant([{ name: "acme.eth", chain: noDelegate }, { name: "b.acme.eth", chain: root }]).reason ?? "", /doesn't allow further delegation/);
  // delegate:false on the leaf itself is fine.
  assert.ok(pathGrant([{ name: "acme.eth", chain: root }, { name: "b.acme.eth", chain: noDelegate }]).grant);
  assert.equal(pathGrant([{ name: "acme.eth", chain: undefined }]).pending, true);
});

test("pathGrant: recipients match by workspace name or address", () => {
  const p = pathGrant(
    [
      { name: "a.eth", chain: serializeGrant(full({ to: ["supplier"] })) },
      { name: "b.a.eth", chain: serializeGrant(full({ to: [SUPPLIER, OTHER] })) },
    ],
    { supplier: SUPPLIER },
  );
  assert.deepEqual(p.grant?.to, ["supplier"]);
});

test("strictestApprove: always > above:lowest > never", () => {
  assert.equal(strictestApprove("never", "always"), "always");
  assert.equal(strictestApprove("above:5", "above:2"), "above:2");
  assert.equal(strictestApprove("never", "above:5"), "above:5");
  assert.equal(strictestApprove(undefined, "never"), "never");
});

test("grantFromDraft validates and keeps the exact expiry while the days field is untouched", () => {
  const now = 1_700_000_000;
  const original = full({ exp: now + 10 * 86_400 + 123 });
  const d = draftFromGrant(original, now);
  assert.equal(d.days, "11");
  const same = grantFromDraft(d, now, original);
  assert.equal(same.grant?.exp, original.exp);
  const changed = grantFromDraft({ ...d, days: "3" }, now, original);
  assert.equal(changed.grant?.exp, now + 3 * 86_400);
  assert.match(grantFromDraft({ ...d, max: "-1" }, now).error ?? "", /positive STD amount/);
  assert.match(grantFromDraft({ ...d, gas: "12.5" }, now).error ?? "", /Gas/);
  assert.match(grantFromDraft({ ...d, to: ["not an address!"] }, now).error ?? "", /isn't an address/);
  assert.match(grantFromDraft({ ...emptyChainDraft(), on: true }, now).error ?? "", /at least one/);
  assert.deepEqual(grantFromDraft(emptyChainDraft(), now), { grant: null, error: null });
  // Unknown methods for a contract kind are dropped (never owner functions).
  const g = grantFromDraft({ ...d, methods: { vault: ["pay", "setAgent"], escrow: ["transferAdmin", "pause"] } }, now).grant;
  assert.deepEqual(g?.methods, { vault: ["pay"], escrow: ["pause"] });
});

test("chainEditorModel hides what the levels above don't allow and warns about bigger values", () => {
  const above = pathGrant([{ name: "acme.eth", chain: serializeGrant(full({ caps: ["read", "track"], contracts: ["vault"], max: "5", limit: "20" })) }]);
  const d = { ...draftFromGrant(full({ caps: ["read"], contracts: ["vault"], max: "9", limit: "50", to: ["supplier"] }), 0), on: true };
  const m = chainEditorModel(d, above);
  assert.deepEqual(
    m.caps.map((c) => c.id),
    ["read", "track"],
  );
  assert.deepEqual(
    m.contracts.map((c) => c.id),
    ["vault"],
  );
  assert.ok(m.notes.some((n) => /capped at 5 STD/.test(n)));
  assert.ok(m.notes.some((n) => /allows 20 STD per month/.test(n)));
  assert.equal(m.placeholders.max, "≤ 5");
  // Ticked-but-blocked stays visible so it can be unticked.
  const m2 = chainEditorModel(toggleCap(d, "deploy", true), above);
  assert.ok(m2.caps.some((c) => c.id === "deploy"));
  // No grant above: blocked, with the reason.
  assert.match(chainEditorModel(d, pathGrant([{ name: "acme.eth", chain: null }])).blocked ?? "", /no blockchain grant/);
  assert.equal(chainEditorModel(d, null).loading, true);
});

test("grantRows describe the effective grant", () => {
  const p = pathGrant([{ name: "acme.eth", chain: serializeGrant(full({ to: ["supplier"], exp: 2_000_000_000 })) }]);
  const rows = grantRows(p, p.grant, { supplier: SUPPLIER }, 1_000);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel.Tools, "Read, Track, Prepare, Sign & submit, Deploy, Manage");
  assert.match(byLabel.Recipients, /^supplier \(0x111111…1111\)$/);
  assert.equal(byLabel["Per transaction"], "10 STD");
  assert.equal(byLabel.Limit, "100 STD per month");
  assert.equal(byLabel.Approval, "A human approves every transaction");
});

test("chainRecords writes relay.chain, empty to clear", () => {
  assert.deepEqual(chainRecords('{"v":1}'), [["relay.chain", '{"v":1}']]);
  assert.deepEqual(chainRecords(null), [["relay.chain", ""]]);
});

// --- live view (tree + detail panel) -----------------------------------------------------

const raw = (name: string, chain: string | null | undefined, keys = ["codex", "multibaas"]): RawLiveNode => ({
  name,
  registry: OWNER,
  status: "registered",
  owner: OWNER,
  latestOwner: OWNER,
  expiry: 2_000_000_000,
  resolver: OWNER,
  subregistry: OWNER,
  bundle: { keys: keys as never, caps: {}, maxes: {}, period: "month" },
  member: name.split(".").length <= 4,
  chain,
});

test("toLiveNodes: MultiBaas shows only with a chain grant on the whole path; badges list the tools", () => {
  const nodes = toLiveNodes({
    root: "acme.eth",
    raw: [
      raw("acme.eth", serializeGrant(full())),
      raw("dev.acme.eth", serializeGrant(full({ caps: ["read", "track"] }))),
      raw("ops.acme.eth", null),
      raw("x.acme.eth", undefined),
    ],
    nowSec: 1_000,
  });
  const by = Object.fromEntries(nodes.map((n) => [n.name, n]));
  assert.ok(by["acme.eth"].providers.includes("multibaas"));
  assert.ok(by["acme.eth"].badges?.includes("chain: all chain tools"));
  assert.ok(by["dev.acme.eth"].badges?.includes("chain: read · track"));
  assert.ok(!by["ops.acme.eth"].providers.includes("multibaas"));
  // Unknown record: unchanged (no flicker while listings load).
  assert.ok(by["x.acme.eth"].providers.includes("multibaas"));

  const detail = liveChainGrant(nodes, "ops.acme.eth");
  assert.match(detail.empty ?? "", /ops\.acme\.eth has no blockchain grant/);
  const dev = liveChainGrant(nodes, "dev.acme.eth");
  assert.equal(dev.empty, null);
  assert.ok(dev.rows.some((r) => r.label === "Record hash"));
});

// --- proposals and tasks -------------------------------------------------------------------

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: "prp_1",
  requestId: "r1",
  agent: { name: "codex.derek.acme.eth", node: "0x01", resource: "1", owner: AGENT },
  op: "call",
  network: "sepolia",
  target: { kind: "vault", address: SUPPLIER, label: "relay-vault" },
  method: "pay",
  args: [SUPPLIER, "3000000000000000000", "0xabc"],
  display: { summary: "Pay 3 STD to supplier", amount: "3", recipient: SUPPLIER },
  tx: { from: OWNER, to: SUPPLIER, data: "0x", value: "0", gas: "90000", type: 2 },
  gasEstimate: "70000",
  grantId: "0xdeadbeef",
  digest: "0x01",
  approval: { required: true, rule: "always" },
  events: [
    { at: 1, state: "prepared", detail: "" },
    { at: 2, state: "awaiting-approval", detail: "" },
  ],
  createdAt: 1,
  expiresAt: 1_800,
  ...over,
});

test("proposal state, lifecycle, amounts and ordering", () => {
  const p = proposal();
  assert.equal(proposalState(p), "awaiting-approval");
  assert.equal(proposalState({ ...p, state: "confirmed" }), "confirmed");
  assert.equal(isPending("submitted"), true);
  assert.equal(isPending("confirmed"), false);
  assert.equal(amountText(p), "3 STD");
  assert.equal(amountText({ display: { summary: "" }, amountBase: "2500000000000000000" }), "2.5 STD");
  const steps = lifecycle({ ...p, state: "included", events: [...p.events, { at: 3, state: "approved", detail: "" }, { at: 4, state: "submitted", detail: "" }, { at: 5, state: "included", detail: "" }] });
  assert.deepEqual(
    steps.map((s) => s.done),
    [true, true, true, true, false],
  );
  const sorted = sortProposals([proposal({ id: "prp_old", state: "confirmed", createdAt: 9 }), proposal({ id: "prp_wait", createdAt: 1 })]);
  assert.equal(sorted[0].id, "prp_wait");
  assert.deepEqual(
    submittable([proposal({ state: "approved" }), proposal({ id: "prp_2", state: "approved", agent: { ...p.agent, name: "other" } })], "codex.derek.acme.eth").map((x) => x.id),
    ["prp_1"],
  );
});

test("stepViews pairs plan steps with results: done, blocked with rule, proposed", () => {
  const views = stepViews({
    plan: {
      steps: [
        { tool: "events", contract: "vault", why: "recent transfers" },
        { tool: "prepare", contract: "vault", method: "pay", recipient: "0xbad", amount: "250", why: "pay" },
        { tool: "prepare", contract: "vault", method: "pay", recipient: "supplier", amount: "3", why: "pay supplier" },
        { tool: "report", why: "summarize" },
      ],
    },
    results: [
      { step: 0, ok: true, events: [1, 2, 3] },
      { step: 1, ok: false, rule: "recipient", reason: "0xbad is not an approved recipient" },
      { step: 2, ok: true, proposalId: "prp_9" },
    ],
  });
  assert.deepEqual(
    views.map((v) => v.outcome),
    ["done", "blocked", "proposed", "skipped"],
  );
  assert.equal(views[0].detail, "3 events");
  assert.equal(views[1].detail, "recipient: 0xbad is not an approved recipient");
  assert.equal(views[2].proposalId, "prp_9");
});

test("findings, balances and status rows", () => {
  const rows = findingRows([{ rule: "unapproved-recipient", txHash: `0x${"a".repeat(64)}`, to: OTHER, amount: "250", why: "not approved" }]);
  assert.equal(rows[0].rule, "Recipient not approved");
  assert.match(rows[0].href, /sepolia\.etherscan\.io\/tx\/0xa+/);
  assert.equal(ethText("30000000000000000"), "0.0300 ETH");
  assert.equal(ethText("0.03"), "0.03 ETH");
  assert.equal(stdText("1000000000000000000000"), "1000 STD");
  assert.equal(stdText("12"), "12 STD");
  const status = statusRows({ configured: true, network: "sepolia", chainId: 11155111, block: 123, signer: OWNER, signerBalance: "0.03", vault: { address: SUPPLIER, balance: "731000000000000000000" } });
  assert.deepEqual(
    status.map((r) => r.label),
    ["Network", "Latest block", "Relay signer", "Treasury vault"],
  );
  assert.equal(status[0].value, "Sepolia · 11155111");
  assert.match(status[3].value, /731 STD/);
});

// --- approvals ---------------------------------------------------------------------------

const incident = {
  id: "inc_1",
  subject: { name: "payout.codex.derek.acme.eth" },
  state: "open",
  previous: { chain: serializeGrant(full({ caps: ["read", "prepare", "submit"], to: ["supplier"], max: "20", limit: "20" })), expiresAt: 1_000 },
  proposed: { chain: full({ caps: ["read", "prepare", "submit"], to: ["supplier", OTHER], max: "200", limit: "200" }), expiresAt: 9_000_000 },
};

test("diffRows lists what would change and flags expansions", () => {
  const rows = diffRows(incident, { supplier: SUPPLIER });
  const by = Object.fromEntries(rows.map((r) => [r.field, r]));
  assert.equal(by.Recipients.expansion, true);
  assert.equal(by["Per transaction"].expansion, true);
  assert.equal(by["Chain limit"].expansion, true);
  assert.equal(by["Name expiry"].expansion, true);
  assert.equal(by["Chain tools"], undefined);
  // Same or narrower: nothing flagged.
  const narrower = diffRows({ previous: incident.previous, proposed: { chain: serializeGrant(full({ caps: ["read"], to: ["supplier"], max: "5", limit: "5" })) } });
  assert.ok(narrower.every((r) => !r.expansion));
});

test("approve narrower: defaults to previous recipients, min(previous per-tx, 5) STD, one hour", () => {
  const d = defaultNarrow(incident);
  assert.deepEqual(d, { recipients: ["supplier"], amount: "5", durationSec: 3_600 });
  const now = 100;
  const r = narrowScope(incident, d, now);
  assert.ok(r.scope?.chain);
  assert.deepEqual(r.scope.chain.to, ["supplier"]);
  assert.equal(r.scope.chain.max, "5");
  assert.equal(r.scope.chain.limit, "5");
  assert.equal(r.scope.chain.exp, now + 3_600);
  assert.equal(r.scope.durationSec, 3_600);
  assert.match(narrowScope(incident, { ...d, amount: "50" }, now).error ?? "", /previous per-transaction max/);
  assert.match(narrowScope(incident, { ...d, recipients: [OTHER] }, now).error ?? "", /previous recipients/);
  assert.match(narrowScope(incident, { ...d, durationSec: 90_000 }, now).error ?? "", /at most one day/);
  assert.equal(defaultNarrow({ previous: { chain: serializeGrant(full({ max: "2" })) } }).amount, "2");
});

test("requirements: World only for approving incidents", () => {
  assert.equal(requirements("incident", "approve-narrower").world, true);
  assert.equal(requirements("incident", "approve").world, true);
  assert.equal(requirements("incident", "reject").world, false);
  assert.equal(requirements("incident", "revoke").world, false);
  assert.equal(requirements("proposal", "approve").world, false);
});

test("approverHint: a human level above, never an agent key on the path", () => {
  const nodes = [
    { name: "acme.eth", owner: OWNER, kind: "company" as const, status: "Active" },
    { name: "derek.acme.eth", owner: OTHER, kind: "member" as const, status: "Active" },
    { name: "codex.derek.acme.eth", owner: AGENT, kind: "agent" as const, status: "Active" },
    { name: "payout.codex.derek.acme.eth", owner: AGENT, kind: "agent" as const, status: "Active" },
  ];
  assert.equal(approverHint(nodes, "payout.codex.derek.acme.eth", OTHER as `0x${string}`).ok, true);
  assert.equal(approverHint(nodes, "payout.codex.derek.acme.eth", OTHER as `0x${string}`).level, "derek.acme.eth");
  assert.equal(approverHint(nodes, "payout.codex.derek.acme.eth", AGENT).ok, false);
  assert.match(approverHint(nodes, "payout.codex.derek.acme.eth", AGENT).why, /agent/);
  assert.equal(approverHint(nodes, "payout.codex.derek.acme.eth", undefined).ok, false);
  assert.equal(approverHint(nodes, "payout.codex.derek.acme.eth", SUPPLIER as `0x${string}`).ok, false);
});

test("the relay's incident shapes: {id, detail} flags, trigger objects, affected entries, suggested scope", () => {
  assert.deepEqual(flagView({ id: "R8", detail: "limit 20 → 200", severity: "pause" }), { rule: "R8", words: "Blockchain limit raised", text: "limit 20 → 200", critical: false });
  assert.equal(triggerText({ source: "renewal-request", requestedBy: "codex.derek.acme.eth" }), "Renewal request (by codex.derek.acme.eth)");
  assert.equal(triggerText("drift"), "Changed on ENS without an approval");
  assert.deepEqual(affectedNames([{ name: "a.eth", relation: "subject" }, "b.a.eth"]), ["a.eth", "b.a.eth"]);
  const d = defaultNarrow({
    previous: incident.previous,
    suggested: [{ decision: "approve-narrower", label: "narrower", scope: { chain: full({ to: ["supplier"], max: "4" }), durationSec: 900 } }],
  });
  assert.deepEqual(d, { recipients: ["supplier"], amount: "4", durationSec: 900 });
  // Expiry comes as `expiry` from the relay.
  const rows = diffRows({ previous: { expiry: 1_000 }, proposed: { expiry: 2_000 } });
  assert.equal(rows.find((r) => r.field === "Name expiry")?.expansion, true);
});

test("flags, subjects, evidence and error words", () => {
  assert.deepEqual(flagView({ rule: "R7", message: "0x22… unknown" }), { rule: "R7", words: "Recipient unknown to the workspace", text: "0x22… unknown", critical: true });
  assert.equal(flagView("R2").words, "Dollar cap raised or removed");
  assert.equal(subjectName({ subject: "a.eth" }), "a.eth");
  assert.equal(subjectName(incident), "payout.codex.derek.acme.eth");
  const ev = evidenceLines({ log: [{ ts: 0, name: "a.eth", method: "POST", path: "/chain/proposals", allowed: false, reason: "recipient" }], refusedChain: ["blocked: amount"] });
  assert.equal(ev.length, 2);
  assert.ok(ev.every((e) => e.refused));
  assert.equal(errorWords("incident_changed"), "The incident changed since you started. Review it again.");
  assert.match(errorWords("world_rejected:all_verifications_failed"), /all_verifications_failed/);
  assert.equal(errorWords("something_new"), "something_new");
});

// --- Review fixes ------------------------------------------------------------------------

test("add member: starts with the grant the levels above allow (on), and adds multibaas to the keys", () => {
  const above = pathGrant([{ name: "acme.eth", chain: serializeGrant(full()) }, { name: "dev.acme.eth", chain: serializeGrant(full({ limit: "60" })) }]);
  const d = newMemberChainDraft(above, 1_800_000_000);
  assert.equal(d.on, true);
  const g = grantFromDraft(d, 1_800_000_000).grant!;
  assert.ok(g, "a writable grant");
  assert.deepEqual(g.caps, full().caps);
  assert.equal(g.gas, "600000");
  assert.equal(newMemberChainDraft(pathGrant([{ name: "acme.eth", chain: null }]), 0).on, false, "nothing above: off");
  assert.equal(newMemberChainDraft(null, 0).on, false);
  const b = { keys: ["codex"], caps: {}, maxes: {}, period: "month" as const };
  assert.deepEqual(withChainKey(b, g, { keys: ["codex", "multibaas"] }).keys, ["codex", "multibaas"]);
  assert.deepEqual(withChainKey(b, g, null).keys, ["codex", "multibaas"]);
  assert.deepEqual(withChainKey(b, g, { keys: ["codex"] }).keys, ["codex"], "not when the parent doesn't allow multibaas");
  assert.deepEqual(withChainKey(b, null, { keys: ["multibaas"] }).keys, ["codex"], "not without a grant");
});

test("proposal detail asks for per-level allowance only once the payment is on chain", () => {
  assert.equal(proposalPath("prp_1"), "/api/relay/chain/proposals/prp_1");
  assert.equal(proposalPath("prp_1", { allowance: true }), "/api/relay/chain/proposals/prp_1?allowance=1");
  assert.deepEqual(
    (["awaiting-approval", "approved", "submitted", "included", "confirmed", "failed"] as const).map((s) => wantsAllowance(s)),
    [false, false, true, true, true, false],
  );
});

test("World notes: presence is client-reported; staging proofs are not a security assurance", () => {
  assert.deepEqual(worldNotes({ environment: "production", presence: "client-reported" }), [PRESENCE_NOTE]);
  assert.deepEqual(worldNotes({ environment: "staging" }), [PRESENCE_NOTE, STAGING_NOTE]);
  assert.match(PRESENCE_NOTE, /not verifiable by the relay/);
  assert.match(STAGING_NOTE, /not a security assurance/);
  assert.deepEqual(worldNotes(null), []);
});
