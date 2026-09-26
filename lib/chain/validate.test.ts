import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type Address, type Hex, decodeFunctionData, getAddress, namehash, zeroAddress } from "viem";

import { POLICY_VAULT, SIMPLE_ESCROW } from "./artifacts";
import type { ChainWorkspace } from "./config";
import { type EffectiveGrant, effectiveGrant } from "./grant";
import type { DeployedEscrow } from "./store";
import { type ChainAction, type ValidateContext, checkGas, paymentRef, requireCap, validateAction } from "./validate";

const SUPPLIER = "0x1111111111111111111111111111111111111111" as Address;
const CONTRACTOR = "0x2222222222222222222222222222222222222222" as Address;
const STRANGER = "0x3333333333333333333333333333333333333333" as Address;
const DEREK = "0x4444444444444444444444444444444444444444" as Address;
const SIGNER = "0x5555555555555555555555555555555555555555" as Address;
const VAULT = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const TOKEN = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const ESCROW = "0x9999999999999999999999999999999999999999" as Address;
const E18 = 10n ** 18n;

const ws = {
  v: 1,
  network: { name: "sepolia", chainId: 11155111, mbChain: "ethereum", explorer: "https://sepolia.etherscan.io" },
  token: { address: TOKEN, label: "relay-token", symbol: "STD", name: "Soda Test Dollar", decimals: 18 },
  vault: { address: VAULT, label: "relay-vault", owner: DEREK, deployBlock: 1 },
  signer: SIGNER,
  templates: { escrow: { label: "relay-escrow", version: "1.0", bytecodeHash: SIMPLE_ESCROW.bytecodeHash, abiHash: SIMPLE_ESCROW.abiHash, networks: ["sepolia"] } },
  recipients: { supplier: SUPPLIER, contractor: CONTRACTOR },
  monitor: { largeTransfer: "50" },
  seed: { txs: [] },
} as unknown as ChainWorkspace;

const deployed: DeployedEscrow[] = [
  { address: ESCROW, deployedBy: "codex.derek.dev.sodalabs.eth", proposalId: "prp_1", admin: DEREK, payee: SUPPLIER, amount: "3", txHash: `0x${"ab".repeat(32)}`, block: 10 },
];
const ctx: ValidateContext = { admins: [DEREK], branch: "derek.dev.sodalabs.eth" };

const grant = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    caps: ["read", "track", "prepare", "submit", "deploy", "manage"],
    net: ["sepolia"],
    contracts: ["token", "vault", "escrow"],
    methods: { vault: ["pay"], escrow: ["pause", "unpause", "release", "refund"] },
    to: ["supplier", "contractor"],
    max: "5",
    limit: "20",
    period: "month",
    gas: "400000",
    delegate: true,
    approve: "always",
    ...over,
  });
const eff = (over: Record<string, unknown> = {}): EffectiveGrant =>
  effectiveGrant([{ name: "a.eth", node: namehash("a.eth"), resource: "1", resolver: null, chain: grant(over) }], [], ws, 1_800_000_000).grant!;

const pay = (to: string, amount: string | bigint, extra: Partial<Extract<ChainAction, { op: "call" }>> = {}): ChainAction => ({
  op: "call",
  contract: "vault",
  method: "pay",
  args: [to, typeof amount === "bigint" ? amount.toString() : amount, paymentRef("r1")],
  ...extra,
});
const deploy = (args: Record<string, unknown> = {}): ChainAction =>
  ({ op: "deploy", template: "escrow", args: { payer: VAULT, payee: SUPPLIER, amount: "3", admin: DEREK, ...args } }) as ChainAction;

function refused(r: ReturnType<typeof validateAction>, rule: string, reason?: RegExp) {
  assert.equal(r.ok, false, `expected refusal by ${rule}`);
  if (r.ok) return;
  assert.equal(r.rule, rule, r.reason);
  if (reason) assert.match(r.reason, reason);
}

describe("validateAction: allowed actions", () => {
  test("vault.pay to an approved recipient within max", () => {
    const r = validateAction(pay(SUPPLIER.toLowerCase(), 3n * E18), eff(), ws, deployed, ctx);
    assert.ok(r.ok);
    if (!r.ok || r.normalized.op !== "call") return;
    assert.equal(r.normalized.amountBase, 3n * E18);
    assert.equal(r.normalized.recipient, SUPPLIER);
    assert.deepEqual(r.normalized.contract, { kind: "vault", address: VAULT, label: "relay-vault" });
    assert.deepEqual(r.normalized.args, [SUPPLIER, (3n * E18).toString(), paymentRef("r1")]);
    const decoded = decodeFunctionData({ abi: POLICY_VAULT.abi, data: r.normalized.data });
    assert.equal(decoded.functionName, "pay");
    assert.deepEqual(decoded.args, [SUPPLIER, 3n * E18, paymentRef("r1")]);
  });

  test("exactly the max is allowed", () => assert.ok(validateAction(pay(SUPPLIER, 5n * E18), eff(), ws, deployed, ctx).ok));

  test("read: a view function with typed args", () => {
    const r = validateAction({ op: "read", contract: "token", method: "balanceOf", args: [VAULT] }, eff(), ws, deployed, ctx);
    assert.ok(r.ok);
    assert.ok(validateAction({ op: "read", contract: VAULT, method: "remainingInPeriod", args: [] }, eff(), ws, deployed, ctx).ok);
    assert.ok(validateAction({ op: "read", contract: ESCROW, method: "paused", args: [] }, eff(), ws, deployed, ctx).ok);
  });

  test("events and tx lookups", () => {
    const r = validateAction({ op: "events", contract: "vault", event: "Paid", limit: 20 }, eff(), ws, deployed, ctx);
    assert.ok(r.ok && r.normalized.op === "events" && r.normalized.event === "Paid" && r.normalized.limit === 20);
    assert.ok(validateAction({ op: "tx", hash: `0x${"AB".repeat(32)}` as Hex }, eff(), ws, deployed, ctx).ok);
  });

  test("escrow management on a relay-deployed escrow", () => {
    const r = validateAction({ op: "call", contract: ESCROW, method: "pause", args: [] }, eff(), ws, deployed, ctx);
    assert.ok(r.ok && r.normalized.op === "call" && r.normalized.contract.kind === "escrow" && r.normalized.amountBase === null);
  });

  test("deploy from the approved template with valid constructor args", () => {
    const r = validateAction(deploy(), eff(), ws, deployed, ctx);
    assert.ok(r.ok);
    if (!r.ok || r.normalized.op !== "deploy") return;
    assert.deepEqual(r.normalized.callArgs, [TOKEN, VAULT, SUPPLIER, 3n * E18, DEREK]);
    assert.ok(r.normalized.data.startsWith(SIMPLE_ESCROW.bytecode));
    assert.ok(validateAction(deploy({ payer: DEREK }), eff(), ws, deployed, ctx).ok, "payer may be the admin");
  });
});

describe("validateAction: refusals", () => {
  test("no grant", () => refused(validateAction(pay(SUPPLIER, E18), null, ws, deployed, ctx), "grant"));

  test("a read-only agent attempting a write is refused at prepare", () => {
    const ro = eff({ caps: ["read", "track"] });
    refused(validateAction(pay(SUPPLIER, E18), ro, ws, deployed, ctx), "cap:prepare");
    refused(validateAction(deploy(), ro, ws, deployed, ctx), "cap:deploy");
    assert.ok(validateAction({ op: "events", contract: "vault" }, ro, ws, deployed, ctx).ok);
    refused(validateAction({ op: "read", contract: "vault", method: "paused", args: [] }, eff({ caps: ["track"] }), ws, deployed, ctx), "cap:read");
    refused(validateAction({ op: "events", contract: "vault" }, eff({ caps: ["read"] }), ws, deployed, ctx), "cap:track");
  });

  test("escrow management needs manage", () => {
    refused(validateAction({ op: "call", contract: ESCROW, method: "pause", args: [] }, eff({ caps: ["read", "prepare"] }), ws, deployed, ctx), "cap:manage");
  });

  test("network", () => {
    refused(validateAction({ ...pay(SUPPLIER, E18), network: "mainnet" } as ChainAction, eff(), ws, deployed, ctx), "network");
    refused(validateAction(pay(SUPPLIER, E18), eff({ net: [] }), ws, deployed, ctx), "network");
  });

  test("contract", () => {
    refused(validateAction({ ...pay(SUPPLIER, E18), contract: STRANGER } as ChainAction, eff(), ws, deployed, ctx), "contract", /not a workspace contract/);
    refused(validateAction({ ...pay(SUPPLIER, E18), contract: "escrow" as Address } as ChainAction, eff(), ws, deployed, ctx), "contract");
    refused(validateAction(pay(SUPPLIER, E18), eff({ contracts: ["token"] }), ws, deployed, ctx), "contract");
    refused(validateAction({ op: "call", contract: ESCROW, method: "pause", args: [] }, eff({ contracts: ["vault"] }), ws, deployed, ctx), "contract");
    refused(validateAction({ op: "call", contract: ESCROW, method: "pause", args: [] }, eff(), ws, [], ctx), "contract");
  });

  test("another branch's escrow doesn't resolve: no release, refund, pause or read across branches", () => {
    const BOB = "0x6666666666666666666666666666666666666666" as Address;
    const bobs: DeployedEscrow[] = [{ ...deployed[0], deployedBy: "codex.bob.dev.sodalabs.eth", admin: BOB }];
    for (const method of ["release", "refund", "pause"]) {
      refused(validateAction({ op: "call", contract: ESCROW, method, args: [] }, eff(), ws, bobs, ctx), "contract", /belongs to another branch/);
    }
    refused(validateAction({ op: "read", contract: ESCROW, method: "paused", args: [] }, eff(), ws, bobs, ctx), "contract");
    // Deployed inside the branch but with an admin who isn't above this agent: refused too.
    const foreignAdmin: DeployedEscrow[] = [{ ...deployed[0], admin: BOB }];
    refused(validateAction({ op: "call", contract: ESCROW, method: "release", args: [] }, eff(), ws, foreignAdmin, ctx), "contract");
    // A sibling member whose name ends like ours doesn't count as inside the branch.
    const lookalike: DeployedEscrow[] = [{ ...deployed[0], deployedBy: "codex.xderek.dev.sodalabs.eth" }];
    refused(validateAction({ op: "call", contract: ESCROW, method: "release", args: [] }, eff(), ws, lookalike, ctx), "contract");
    // No branch known: nothing resolves.
    refused(validateAction({ op: "call", contract: ESCROW, method: "pause", args: [] }, eff(), ws, deployed, { ...ctx, branch: null }), "contract");
  });

  test("method: unknown, not granted, never delegable, or a write via read", () => {
    refused(validateAction({ op: "call", contract: "vault", method: "drain", args: [] }, eff(), ws, deployed, ctx), "method");
    refused(validateAction({ op: "call", contract: "vault", method: "setRecipient", args: [STRANGER, true] }, eff(), ws, deployed, ctx), "method", /never delegated/);
    refused(validateAction({ op: "call", contract: "vault", method: "ownerTransfer", args: [STRANGER, "1"] }, eff(), ws, deployed, ctx), "method");
    refused(validateAction({ op: "call", contract: ESCROW, method: "transferAdmin", args: [STRANGER] }, eff(), ws, deployed, ctx), "method");
    refused(validateAction({ op: "call", contract: "token", method: "transfer", args: [SUPPLIER, "1"] }, eff(), ws, deployed, ctx), "method", /doesn't allow token\.transfer/);
    refused(validateAction(pay(SUPPLIER, E18), eff({ methods: { escrow: ["pause"] } }), ws, deployed, ctx), "method");
    refused(validateAction({ op: "read", contract: "vault", method: "pay", args: [SUPPLIER, "1", paymentRef("x")] }, eff(), ws, deployed, ctx), "method", /view/);
    refused(validateAction({ op: "call", contract: "vault", method: "paused", args: [] }, eff(), ws, deployed, ctx), "method", /use read/);
    refused(validateAction({ op: "events", contract: "vault", event: "Stolen" }, eff(), ws, deployed, ctx), "method");
  });

  test("args: ABI arity and types", () => {
    refused(validateAction({ op: "call", contract: "vault", method: "pay", args: [SUPPLIER, "1"] }, eff(), ws, deployed, ctx), "args", /takes 3/);
    refused(validateAction(pay("supplier", E18), eff(), ws, deployed, ctx), "args", /address/);
    refused(validateAction(pay(SUPPLIER, "1.5"), eff(), ws, deployed, ctx), "args");
    refused(validateAction(pay(SUPPLIER, "-1"), eff(), ws, deployed, ctx), "args");
    refused(validateAction({ ...pay(SUPPLIER, E18), args: [SUPPLIER, "1", "ref"] } as ChainAction, eff(), ws, deployed, ctx), "args", /32 bytes/);
    refused(validateAction({ op: "events", contract: "vault", limit: 1000 }, eff(), ws, deployed, ctx), "args");
    refused(validateAction({ op: "tx", hash: "0x1234" as Hex }, eff(), ws, deployed, ctx), "args");
    refused(validateAction({ op: "nuke" } as unknown as ChainAction, eff(), ws, deployed, ctx), "args");
  });

  test("recipient: ABI-valid but unapproved", () => {
    refused(validateAction(pay(STRANGER, E18), eff(), ws, deployed, ctx), "recipient", /not an approved recipient/);
    const noTo = JSON.parse(grant());
    delete noTo.to;
    const e = effectiveGrant([{ name: "a.eth", node: namehash("a.eth"), resource: "1", resolver: null, chain: JSON.stringify(noTo) }], [], ws, 1).grant!;
    refused(validateAction(pay(SUPPLIER, E18), e, ws, deployed, ctx), "recipient", /no approved recipients anywhere above/);
  });

  test("amount: zero, over max, or no max", () => {
    refused(validateAction(pay(SUPPLIER, 0n), eff(), ws, deployed, ctx), "amount");
    refused(validateAction(pay(SUPPLIER, 5n * E18 + 1n), eff(), ws, deployed, ctx), "amount", /over the per-transaction maximum of 5 STD/);
    const noMax = JSON.parse(grant());
    delete noMax.max;
    const e = effectiveGrant([{ name: "a.eth", node: namehash("a.eth"), resource: "1", resolver: null, chain: JSON.stringify(noMax) }], [], ws, 1).grant!;
    refused(validateAction(pay(SUPPLIER, E18), e, ws, deployed, ctx), "amount", /no per-transaction maximum/);
  });

  test("value: any ETH is refused", () => refused(validateAction(pay(SUPPLIER, E18, { value: "1" }), eff(), ws, deployed, ctx), "value"));

  test("gas: over the cap, or no cap", () => {
    refused(validateAction(pay(SUPPLIER, E18, { gas: "400001" }), eff(), ws, deployed, ctx), "gas");
    assert.ok(validateAction(pay(SUPPLIER, E18, { gas: "400000" }), eff(), ws, deployed, ctx).ok);
    const noGas = JSON.parse(grant());
    delete noGas.gas;
    const e = effectiveGrant([{ name: "a.eth", node: namehash("a.eth"), resource: "1", resolver: null, chain: JSON.stringify(noGas) }], [], ws, 1).grant!;
    refused(validateAction(pay(SUPPLIER, E18), e, ws, deployed, ctx), "gas");
    refused(validateAction(deploy(), e, ws, deployed, ctx), "gas");
    assert.equal(checkGas(eff(), 500000n)?.rule, "gas");
    assert.equal(checkGas(eff(), 1n), null);
  });

  test("template: unknown, hash mismatch, tampered bytecode, network", () => {
    refused(validateAction({ ...deploy(), template: "router" } as unknown as ChainAction, eff(), ws, deployed, ctx), "template");
    const badHash = { ...ws, templates: { escrow: { ...ws.templates.escrow, bytecodeHash: `0x${"00".repeat(32)}` } } } as ChainWorkspace;
    refused(validateAction(deploy(), eff(), badHash, deployed, ctx), "template", /bytecode hash/);
    const tampered: ValidateContext = { ...ctx, artifacts: { token: SIMPLE_ESCROW, vault: SIMPLE_ESCROW, escrow: { ...SIMPLE_ESCROW, bytecode: `${SIMPLE_ESCROW.bytecode}00` as Hex } } };
    refused(validateAction(deploy(), eff(), ws, deployed, tampered), "template");
    const badAbi = { ...ws, templates: { escrow: { ...ws.templates.escrow, abiHash: `0x${"11".repeat(32)}` } } } as ChainWorkspace;
    refused(validateAction(deploy(), eff(), badAbi, deployed, ctx), "template", /ABI/);
    const otherNet = { ...ws, templates: { escrow: { ...ws.templates.escrow, networks: [] } } } as unknown as ChainWorkspace;
    refused(validateAction(deploy(), eff(), otherNet, deployed, ctx), "template");
    refused(validateAction(deploy(), eff({ contracts: ["vault"] }), ws, deployed, ctx), "contract");
  });

  test("ctor: constructor constraints", () => {
    refused(validateAction(deploy({ token: STRANGER }), eff(), ws, deployed, ctx), "ctor", /workspace token/);
    assert.ok(validateAction(deploy({ token: TOKEN }), eff(), ws, deployed, ctx).ok);
    refused(validateAction(deploy({ payee: STRANGER }), eff(), ws, deployed, ctx), "ctor", /approved recipient/);
    refused(validateAction(deploy({ amount: "6" }), eff(), ws, deployed, ctx), "ctor", /maximum/);
    refused(validateAction(deploy({ amount: "0" }), eff(), ws, deployed, ctx), "ctor");
    refused(validateAction(deploy({ admin: SIGNER }), eff(), ws, deployed, { admins: [DEREK, SIGNER], branch: ctx.branch }), "ctor", /relay signer/);
    refused(validateAction(deploy({ admin: STRANGER }), eff(), ws, deployed, ctx), "ctor", /not an owner above/);
    refused(validateAction(deploy(), eff(), ws, deployed, { admins: [], branch: ctx.branch }), "ctor");
    refused(validateAction(deploy({ payer: STRANGER }), eff(), ws, deployed, ctx), "ctor", /payer/);
    refused(validateAction(deploy({ payee: zeroAddress }), eff(), ws, deployed, ctx), "ctor", /zero/);
    refused(validateAction(deploy({ amount: 3 }), eff(), ws, deployed, ctx), "args");
    refused(validateAction(deploy({ extra: 1 }), eff(), ws, deployed, ctx), "args");
    refused(validateAction(deploy({ admin: "derek" }), eff(), ws, deployed, ctx), "args");
  });
});

test("requireCap", () => {
  assert.equal(requireCap(null, "read")?.rule, "grant");
  assert.equal(requireCap(eff({ caps: ["read"] }), "submit")?.rule, "cap:submit");
  assert.equal(requireCap(eff(), "submit"), null);
});
