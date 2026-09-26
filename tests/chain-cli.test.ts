// The CLI's blockchain helpers (scripts/lib/chain-cli.ts) and org:seed's chain grants
// (scripts/lib/org-seed.ts): grants built from flags are valid relay.chain records (the relay's
// own parseGrant accepts them), only narrow the parent, and the spec's grants validate and write.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { parseGrant } from "../lib/chain/grant";
import type { ChainWorkspace } from "../lib/chain/config";
import {
  ChainFlagError,
  type GrantRecord,
  absoluteUrl,
  anyChainFlag,
  approveTarget,
  childGrant,
  clean,
  describeGrant,
  grantText,
  parseApprove,
  parseCaps,
  parseRecipients,
  pausedLine,
  proposalDetail,
  proposalLine,
  readGrant,
  taskReport,
  toBase,
} from "../scripts/lib/chain-cli";
import { chainNarrowingProblems, chainProblems, chainRecordText, flattenSpec, formatSpec, parseSpec, specProblems } from "../scripts/lib/org-seed";

const SUPPLIER = "0x1111111111111111111111111111111111111111";
const CONTRACTOR = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";

const ws = {
  v: 1,
  network: { name: "sepolia", chainId: 11155111, mbChain: "ethereum", explorer: "https://sepolia.etherscan.io" },
  token: { address: "0x4444444444444444444444444444444444444444", label: "relay-token", symbol: "STD", name: "Soda Test Dollar", decimals: 18 },
  vault: { address: "0x5555555555555555555555555555555555555555", label: "relay-vault", owner: OTHER, deployBlock: 1 },
  signer: "0x6666666666666666666666666666666666666666",
  templates: { escrow: { label: "relay-escrow", version: "1.0", bytecodeHash: `0x${"a".repeat(64)}`, abiHash: `0x${"b".repeat(64)}`, networks: ["sepolia"] } },
  recipients: { supplier: SUPPLIER, contractor: CONTRACTOR },
  monitor: { largeTransfer: "50" },
  seed: { txs: [] },
} as unknown as ChainWorkspace;

const member = (): GrantRecord => ({
  v: 1,
  caps: ["read", "track", "prepare", "submit", "deploy", "manage"],
  net: ["sepolia"],
  contracts: ["token", "vault", "escrow"],
  methods: { vault: ["pay"], escrow: ["pause", "unpause", "release", "refund"] },
  to: ["supplier", "contractor"],
  max: "10",
  limit: "40",
  period: "month",
  gas: "600000",
  exp: 2_000_000_000,
  delegate: true,
  approve: "always",
});

test("amounts: whole-token decimals to base units, nothing else", () => {
  assert.equal(toBase("5"), 5n * 10n ** 18n);
  assert.equal(toBase("0.5"), 5n * 10n ** 17n);
  assert.equal(toBase("1.000000000000000001"), 10n ** 18n + 1n);
  for (const bad of ["", "-1", "1e3", "01", "1.", ".5", "1.0000000000000000001", "abc"]) assert.equal(toBase(bad), null, bad);
});

test("flag parsers: caps in canonical order, recipients, approval rules", () => {
  assert.deepEqual(parseCaps("track, read"), ["read", "track"]);
  assert.throws(() => parseCaps("read,sign"), ChainFlagError);
  assert.throws(() => parseCaps(""), ChainFlagError);
  assert.deepEqual(parseRecipients(`supplier, ${SUPPLIER.toUpperCase().replace("0X", "0x")},supplier`), ["supplier", SUPPLIER]);
  assert.throws(() => parseRecipients("not a name!"), ChainFlagError);
  assert.equal(parseApprove("Always"), "always");
  assert.equal(parseApprove("above:5.50"), "above:5.5");
  assert.throws(() => parseApprove("sometimes"), ChainFlagError);
  assert.throws(() => parseApprove("above:-1"), ChainFlagError);
  assert.equal(anyChainFlag({}), false);
  assert.equal(anyChainFlag({ noDelegate: true }), true);
  assert.equal(anyChainFlag({ chainTo: "supplier" }), true);
});

test("login default: the member's grant, ending at the agent's expiry, is a record the relay accepts", () => {
  const g = childGrant(member(), {}, 1_900_000_000, "derek.cloudops.dev.sodalabs.eth");
  assert.equal(g.exp, 1_900_000_000);
  assert.deepEqual(g.caps, member().caps);
  const text = grantText(g);
  const parsed = parseGrant(text, ws);
  assert.ok(parsed, text);
  assert.deepEqual(parsed.recipients, [SUPPLIER, CONTRACTOR].map((a) => a.toLowerCase()).map((a) => parsed.recipients!.find((r) => r.toLowerCase() === a)));
  // Canonical key order (serializeGrant's).
  assert.deepEqual(Object.keys(JSON.parse(text)), ["v", "caps", "net", "contracts", "methods", "to", "max", "limit", "period", "gas", "exp", "delegate", "approve"]);
  // Never after the parent's own expiry.
  assert.equal(childGrant(member(), {}, 2_100_000_000, "m").exp, 2_000_000_000);
});

test("a read-only monitoring subagent gets read,track and no write methods", () => {
  const g = childGrant(member(), { chain: "read,track", noDelegate: true }, 1_800_000_000, "codex.derek");
  assert.deepEqual(g.caps, ["read", "track"]);
  assert.deepEqual(g.methods, {});
  assert.equal(g.delegate, false);
  assert.ok(parseGrant(grantText(g), ws));
  assert.match(describeGrant(g), /read, track .*no further delegation/);
});

test("the payout subagent: supplier only, 20 STD a month, 5 per tx", () => {
  const parent = { ...member(), limit: "60", max: "10" };
  const g = childGrant(parent, { chain: "read,track,prepare,submit", chainTo: "supplier", chainMax: "5", chainLimit: "20", chainPeriod: "month" }, 1_800_000_000, "codex");
  assert.deepEqual(g.to, ["supplier"]);
  assert.equal(g.max, "5");
  assert.equal(g.limit, "20");
  assert.equal(g.period, "month");
  assert.deepEqual(g.methods.vault, ["pay"]);
  const parsed = parseGrant(grantText(g), ws);
  assert.ok(parsed);
  assert.equal(parsed.recipients?.length, 1);
});

test("a child can't ask for more than its parent has", () => {
  const p = member();
  const bad: [Parameters<typeof childGrant>[1], RegExp][] = [
    [{ chain: "read,deploy" }, /nothing|doesn't have/],
    [{ chainMax: "11" }, /more than m's 10/],
    [{ chainLimit: "41" }, /more than m's 40/],
    [{ chainGas: "700000" }, /more than m's 600000/],
    [{ chainTo: "stranger" }, /doesn't approve stranger/],
    [{ approve: "never" }, /looser/],
    [{ chainPeriod: "week" }, /--chain-period/],
    [{ chainMax: "0" }, /positive amount/],
  ];
  const readOnly = { ...p, caps: ["read" as const] };
  assert.throws(() => childGrant(readOnly, { chain: "read,deploy" }, 1, "m"), /doesn't have deploy/);
  for (const [flags, msg] of bad.slice(1)) assert.throws(() => childGrant(p, flags, 1, "m"), msg, JSON.stringify(flags));
  assert.throws(() => childGrant({ ...p, delegate: false }, {}, 1, "m"), /doesn't allow further delegation/);
  // An address can't be compared with a parent's names offline: allowed here, the relay intersects.
  assert.deepEqual(childGrant(p, { chainTo: OTHER }, 1, "m").to, [OTHER]);
  assert.throws(() => childGrant({ ...p, to: [SUPPLIER] }, { chainTo: OTHER }, 1, "m"), /doesn't approve/);
  // Stricter is fine.
  assert.equal(childGrant({ ...p, approve: "above:5" }, { approve: "above:2" }, 1, "m").approve, "above:2");
  assert.equal(childGrant({ ...p, approve: "never" }, { approve: "always" }, 1, "m").approve, "always");
  // A limit on a parent without one gets a period, so the relay doesn't read it as invalid.
  const { limit: _l, period: _p, ...noLimit } = p;
  const g = childGrant(noLimit as GrantRecord, { chainLimit: "5" }, 1_800_000_000, "m");
  assert.equal(g.period, "month");
  assert.ok(parseGrant(grantText(g), ws));
});

test("a renewal request only applies the flags (the relay reviews wider asks)", () => {
  const current = childGrant(member(), { chain: "read,track,prepare,submit", chainTo: "supplier", chainLimit: "20" }, 1_800_000_000, "codex");
  const asked = childGrant({ ...current, delegate: true, exp: Number.MAX_SAFE_INTEGER }, { chainTo: OTHER, chainLimit: "200" }, 1_900_000_000, "payout", { checkParent: false });
  assert.deepEqual(asked.to, [OTHER]);
  assert.equal(asked.limit, "200");
  assert.equal(asked.exp, 1_900_000_000);
  assert.deepEqual(asked.methods.vault, ["pay"]);
});

test("readGrant is a loose structural read: names allowed, junk is null", () => {
  assert.deepEqual(readGrant(grantText(member())), JSON.parse(grantText(member())));
  for (const bad of [null, "", "{", "[]", '{"v":2}', '{"v":1,"caps":["read"]}']) assert.equal(readGrant(bad), null, String(bad));
});

test("printing: proposals, task runs and control characters", () => {
  const p = {
    id: "prp_abc",
    state: "awaiting-approval",
    agent: { name: "codex.derek.cloudops.dev.sodalabs.eth" },
    target: { kind: "vault", label: "relay-vault", address: "0x5555555555555555555555555555555555555555" },
    method: "pay",
    args: [SUPPLIER, "3000000000000000000", "0x00"],
    display: { summary: "Pay 3 STD to supplier" },
    gasEstimate: "80000",
    approval: { required: true, rule: "always" },
    submit: { hash: `0x${"c".repeat(64)}` },
    receipt: { blockNumber: 10, status: "success", confirmations: 2 },
    events: [{ at: 1_800_000_000, state: "prepared", detail: "ok" }],
  };
  assert.equal(proposalLine(p), "prp_abc  awaiting-approval  Pay 3 STD to supplier");
  const detail = proposalDetail(p).join("\n");
  assert.match(detail, /https:\/\/sepolia\.etherscan\.io\/tx\/0xc{64}/);
  assert.match(detail, /block {7}10 · success · 2 confirmations/);
  const blocked = { id: "prp_x", state: "blocked", approval: { rule: "recipient" }, display: { summary: "Pay 3 STD" }, events: [{ state: "blocked", detail: "not an approved recipient" }] };
  assert.equal(proposalLine(blocked), "prp_x  blocked [recipient]  Pay 3 STD — not an approved recipient");

  const run = taskReport({
    runId: "run_1",
    plan: { steps: [{ tool: "events", contract: "vault", why: "look" }, { tool: "prepare", contract: "vault", method: "pay", recipient: "supplier", amount: "3", why: "pay" }], expected: "a report" },
    results: [{ events: [1, 2] }, { blocked: true, rule: "amount", reason: "over the per-tx max" }],
    findings: [{ rule: "large", amount: "250", from: "vault", to: OTHER, block: 5, explorerUrl: "https://x/tx/1", why: "big" }],
    proposals: [p],
    report: "All good.\u001b[31m",
  }).join("\n");
  assert.match(run, /1\. events vault/);
  assert.match(run, /blocked \[amount\] over the per-tx max/);
  assert.match(run, /not proof of wrongdoing/);
  assert.match(run, /\[large\] 250 STD/);
  assert.ok(!run.includes("\u001b"));
  assert.match(taskReport({ plan: { steps: [] }, report: null, reason: "over budget" }).join("\n"), /\(none: over budget\)/);
  assert.equal(clean("a\u0007b\nc"), "ab\nc");
});

test("approve targets, portal URLs and the paused line", () => {
  assert.equal(approveTarget("prp_1a2b"), "proposal");
  assert.equal(approveTarget("inc_9"), "incident");
  assert.equal(approveTarget("chl_1"), null);
  assert.equal(approveTarget("prp_../x"), null);
  assert.equal(absoluteUrl("/approvals/inc_1", "http://localhost:3000", "/x"), "http://localhost:3000/approvals/inc_1");
  assert.equal(absoluteUrl(null, "https://relay.example", "/?view=approvals"), "https://relay.example/?view=approvals");
  assert.equal(absoluteUrl("javascript:alert(1)", "https://relay.example", "/f"), "https://relay.example/f");
  assert.equal(pausedLine("payout.codex.derek", "inc_7", "https://r/x"), "paused: payout.codex.derek is under review (incident inc_7) https://r/x");
});

// --- org:seed ------------------------------------------------------------------------------------

const committed = () => fs.readFileSync(path.join(import.meta.dirname, "..", "org", "sodalabs.json"), "utf8");

test("org/sodalabs.json: sodalabs.eth, dev, cloudops and emma carry multibaas and a chain grant that narrows", () => {
  const spec = parseSpec(committed());
  assert.deepEqual(specProblems(spec), []);
  const nodes = new Map(flattenSpec(spec).map((n) => [n.name, n]));
  const limits = { "sodalabs.eth": "100", "dev.sodalabs.eth": "60", "cloudops.dev.sodalabs.eth": "40", "emma.cloudops.dev.sodalabs.eth": "20" } as Record<string, string>;
  for (const [name, limit] of Object.entries(limits)) {
    const n = nodes.get(name)!;
    assert.ok(n.bundle.keys.includes("multibaas"), name);
    assert.equal(n.chain?.limit, limit, name);
    assert.deepEqual(n.chain?.to, ["supplier", "contractor"]);
    const text = chainRecordText(n.chain!, 2_000_000_000, ws.recipients, name);
    const g = parseGrant(text, ws);
    assert.ok(g, text);
    assert.deepEqual(g.to, [SUPPLIER, CONTRACTOR], "names resolved to addresses before writing");
    assert.equal(g.exp, 2_000_000_000);
  }
  assert.equal(nodes.get("priya.cloudops.dev.sodalabs.eth")!.chain, undefined, "only the members who need one get a grant");
  // Still exactly what formatSpec writes.
  assert.equal(formatSpec(parseSpec(committed())), committed());
});

test("spec chain grants: bad fields and widening are problems; unknown recipient names can't be written", () => {
  const spec = parseSpec(committed());
  const bundle = spec.root.bundle;
  const c = spec.root.chain!;
  assert.deepEqual(chainProblems(c, "x", bundle), []);
  const problems = chainProblems({ ...c, caps: ["fly"], max: 10, gas: "1.5", extra: 1, approve: "maybe" } as never, "x", { ...bundle, keys: ["codex"] }).join("\n");
  for (const m of [/unknown fields extra/, /chain\.caps/, /chain\.max/, /chain\.gas/, /chain\.approve/, /multibaas isn't in its keys/]) assert.match(problems, m);
  const wider = chainNarrowingProblems({ ...c, caps: [...c.caps], limit: "500", to: ["supplier", "stranger"], methods: { ...c.methods, token: ["transfer"] } }, { ...c, caps: ["read"] }, "kid", "mom").join("\n");
  for (const m of [/caps track, prepare/, /chain\.limit 500/, /stranger/, /token\.transfer/]) assert.match(wider, m);
  assert.match(chainNarrowingProblems(c, undefined, "kid", "mom").join(), /mom has none/);
  assert.match(chainNarrowingProblems(c, { ...c, delegate: false }, "kid", "mom").join(), /doesn't allow delegation/);
  assert.throws(() => chainRecordText({ ...c, to: ["nobody"] }, 1, ws.recipients, "x"), /doesn't list/);
  // A spec whose team widens its department's grant is refused as a whole.
  const widened = parseSpec(committed());
  widened.departments[0].teams[0].chain!.limit = "999";
  assert.match(specProblems(widened).join("\n"), /cloudops\.dev\.sodalabs\.eth: chain\.limit 999, dev\.sodalabs\.eth allows 60/);
});
