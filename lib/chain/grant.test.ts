import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type Address, namehash } from "viem";

import type { Overlay } from "../relay/guard";
import { SIMPLE_ESCROW } from "./artifacts";
import type { ChainWorkspace } from "./config";
import {
  type GrantLevel,
  approvalRequirement,
  describeGrant,
  effectiveGrant,
  formatAmount,
  grantIdOf,
  parseAmount,
  parseGrant,
  serializeGrant,
} from "./grant";

const SUPPLIER = "0x1111111111111111111111111111111111111111" as Address;
const CONTRACTOR = "0x2222222222222222222222222222222222222222" as Address;
const OTHER = "0x3333333333333333333333333333333333333333" as Address;
const E18 = 10n ** 18n;

const ws = {
  v: 1,
  network: { name: "sepolia", chainId: 11155111, mbChain: "ethereum", explorer: "https://sepolia.etherscan.io" },
  token: { address: "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa", label: "relay-token", symbol: "STD", name: "Soda Test Dollar", decimals: 18 },
  vault: { address: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", label: "relay-vault", owner: "0x4444444444444444444444444444444444444444", deployBlock: 1 },
  signer: "0x5555555555555555555555555555555555555555",
  templates: { escrow: { label: "relay-escrow", version: "1.0", bytecodeHash: SIMPLE_ESCROW.bytecodeHash, abiHash: SIMPLE_ESCROW.abiHash, networks: ["sepolia"] } },
  recipients: { supplier: SUPPLIER, contractor: CONTRACTOR },
  monitor: { largeTransfer: "50" },
  seed: { txs: [] },
} as unknown as ChainWorkspace;

const full = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
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
    ...over,
  });

const NAMES = ["sodalabs.eth", "dev.sodalabs.eth", "derek.dev.sodalabs.eth", "codex.derek.dev.sodalabs.eth"];
const lv = (chains: (string | null)[]): GrantLevel[] =>
  chains.map((chain, i) => ({ name: NAMES[i], node: namehash(NAMES[i]), resource: String(100 + i), resolver: "0x6666666666666666666666666666666666666666", chain }));
const NOW = 1_800_000_000;

describe("parseGrant", () => {
  test("parses the spec example and resolves recipient names", () => {
    const g = parseGrant(full(), ws)!;
    assert.ok(g);
    assert.deepEqual(g.caps, ["read", "track", "prepare", "submit", "deploy", "manage"]);
    assert.deepEqual(g.to, ["supplier", "contractor"]);
    assert.deepEqual(g.recipients, [SUPPLIER, CONTRACTOR]);
    assert.equal(g.delegate, true);
    assert.equal(g.approve, "always");
  });

  test("defaults are the strict ones: no delegation, approval always", () => {
    const g = parseGrant(JSON.stringify({ v: 1, caps: ["read"] }), ws)!;
    assert.equal(g.delegate, false);
    assert.equal(g.approve, "always");
    assert.deepEqual(g.net, []);
  });

  const bad: [string, string | null][] = [
    ["missing", null],
    ["empty", ""],
    ["not JSON", "{v:1"],
    ["array", "[]"],
    ["unknown key", full({ admin: true })],
    ["wrong version", full({ v: 2 })],
    ["unknown cap", full({ caps: ["read", "sign"] })],
    ["unknown network", full({ net: ["mainnet"] })],
    ["unknown contract", full({ contracts: ["router"] })],
    ["owner method listed", full({ methods: { vault: ["pay", "setRecipient"] } })],
    ["escrow transferAdmin listed", full({ methods: { escrow: ["transferAdmin"] } })],
    ["unknown contract in methods", full({ methods: { router: ["swap"] } })],
    ["unknown recipient name", full({ to: ["supplier", "stranger"] })],
    ["non-string recipient", full({ to: [1] })],
    ["float max", full({ max: 5 })],
    ["negative max", full({ max: "-1" })],
    ["too precise", full({ max: "0.0000000000000000001" })],
    ["limit without period", JSON.stringify({ v: 1, caps: ["read"], limit: "5" })],
    ["bad period", full({ period: "week" })],
    ["bad gas", full({ gas: "1e6" })],
    ["bad exp", full({ exp: "1790000000" })],
    ["bad delegate", full({ delegate: "yes" })],
    ["bad approve", full({ approve: "sometimes" })],
    ["bad approve amount", full({ approve: "above:x" })],
    ["too long", full({ to: ["supplier"], pad: undefined }) + " ".repeat(10) + "x".repeat(4100)],
  ];
  for (const [what, text] of bad) test(`fails closed: ${what}`, () => assert.equal(parseGrant(text, ws), null));

  test("recipient names need a workspace", () => {
    assert.equal(parseGrant(full(), null), null);
    assert.ok(parseGrant(full({ to: [SUPPLIER.toLowerCase()] }), null));
  });

  test("serializeGrant is canonical and round-trips", () => {
    const g = parseGrant(full({ exp: 1790000000, approve: "above:2.5" }), ws)!;
    const text = serializeGrant(g);
    assert.equal(
      text,
      '{"v":1,"caps":["read","track","prepare","submit","deploy","manage"],"net":["sepolia"],"contracts":["token","vault","escrow"],"methods":{"vault":["pay"],"escrow":["pause","unpause","release","refund"]},"to":["supplier","contractor"],"max":"10","limit":"100","period":"month","gas":"600000","exp":1790000000,"delegate":true,"approve":"above:2.5"}',
    );
    assert.deepEqual(parseGrant(text, ws), g);
  });
});

describe("amounts", () => {
  test("parseAmount / formatAmount", () => {
    assert.equal(parseAmount("5"), 5n * E18);
    assert.equal(parseAmount("0.5"), E18 / 2n);
    assert.equal(parseAmount("1.000000000000000001"), E18 + 1n);
    for (const x of ["", "05", "1.", ".5", "-1", "1e3", " 1", "1.0000000000000000001", 5]) assert.equal(parseAmount(x), null, String(x));
    assert.equal(formatAmount(3n * E18), "3");
    assert.equal(formatAmount(E18 / 4n), "0.25");
  });
});

describe("effectiveGrant", () => {
  test("a full chain intersects to the narrowest", () => {
    const r = effectiveGrant(lv([full(), full({ limit: "60" }), full({ limit: "40" }), full({ caps: ["read", "track", "prepare", "submit"], delegate: false })]), [], ws, NOW);
    assert.equal(r.reason, null);
    const g = r.grant!;
    assert.deepEqual(g.caps, ["read", "track", "prepare", "submit"]);
    assert.equal(g.maxBase, 10n * E18);
    assert.equal(g.gas, 600000n);
    assert.deepEqual(r.perLevel.map((p) => p.limit?.base), [100n * E18, 60n * E18, 40n * E18, 100n * E18]);
    assert.deepEqual(r.perLevel.map((p) => p.name), NAMES);
  });

  const narrowing: [string, Record<string, unknown>, (g: NonNullable<ReturnType<typeof effectiveGrant>["grant"]>) => void][] = [
    ["caps", { caps: ["read", "track"] }, (g) => assert.deepEqual(g.caps, ["read", "track"])],
    ["net", { net: [] }, (g) => assert.deepEqual(g.net, [])],
    ["contracts", { contracts: ["vault"] }, (g) => (assert.deepEqual(g.contracts, ["vault"]), assert.deepEqual(g.methods.escrow, []))],
    ["methods", { methods: { vault: ["pay"], escrow: ["pause"] } }, (g) => assert.deepEqual(g.methods.escrow, ["pause"])],
    ["to", { to: ["supplier"] }, (g) => assert.deepEqual(g.recipients, [SUPPLIER])],
    ["max", { max: "3" }, (g) => assert.equal(g.maxBase, 3n * E18)],
    ["gas", { gas: "100000" }, (g) => assert.equal(g.gas, 100000n)],
    ["exp", { exp: NOW + 60 }, (g) => (assert.equal(g.exp, NOW + 60), assert.ok([NAMES[1], NAMES[3]].includes(g.expLevel!)))],
    ["approve above", { approve: "above:1" }, (g) => assert.equal(g.approve, "always")],
  ];
  for (const [field, over, check] of narrowing) {
    test(`the leaf narrows ${field}`, () => {
      const r = effectiveGrant(lv([full(), full(), full(), full(over)]), [], ws, NOW);
      check(r.grant!);
    });
    test(`an ancestor narrows ${field} for its descendants`, () => {
      const r = effectiveGrant(lv([full(), full(over), full(), full()]), [], ws, NOW);
      check(r.grant!);
    });
  }

  test("a child can't widen what a parent set", () => {
    const r = effectiveGrant(lv([full({ caps: ["read"], max: "1", gas: "1000", to: ["supplier"] }), full({ to: ["supplier", "contractor", OTHER] })]), [], ws, NOW);
    assert.deepEqual(r.grant!.caps, ["read"]);
    assert.equal(r.grant!.maxBase, E18);
    assert.equal(r.grant!.gas, 1000n);
    assert.deepEqual(r.grant!.recipients, [SUPPLIER]);
  });

  test("approval: strictest wins (always > lowest above > never)", () => {
    const at = (...rules: string[]) => effectiveGrant(lv(rules.map((approve) => full({ approve }))), [], ws, NOW).grant!.approve;
    assert.equal(at("never", "never"), "never");
    assert.equal(at("never", "above:5", "above:2"), "above:2");
    assert.equal(at("above:2", "above:5"), "above:2");
    assert.equal(at("above:2", "always", "never"), "always");
  });

  test("no `to` anywhere = no recipients", () => {
    const noTo = JSON.parse(full());
    delete noTo.to;
    const r = effectiveGrant(lv([JSON.stringify(noTo), JSON.stringify(noTo)]), [], ws, NOW);
    assert.equal(r.grant!.recipientsSet, false);
    assert.deepEqual(r.grant!.recipients, []);
    // `to` set only lower down still applies.
    const r2 = effectiveGrant(lv([JSON.stringify(noTo), full({ to: ["contractor"] })]), [], ws, NOW);
    assert.deepEqual(r2.grant!.recipients, [CONTRACTOR]);
  });

  test("no max / gas anywhere stays null (validation refuses payments and writes)", () => {
    const g = effectiveGrant(lv([JSON.stringify({ v: 1, caps: ["read"], net: ["sepolia"], delegate: true })]), [], ws, NOW).grant!;
    assert.equal(g.maxBase, null);
    assert.equal(g.gas, null);
  });

  test("delegate:false above the leaf cuts the children", () => {
    const r = effectiveGrant(lv([full(), full({ delegate: false }), full()]), [], ws, NOW);
    assert.equal(r.grant, null);
    assert.equal(r.reason, `${NAMES[1]} doesn't allow further delegation`);
    // …but the level itself keeps its access.
    assert.ok(effectiveGrant(lv([full(), full({ delegate: false })]), [], ws, NOW).grant);
  });

  test("a level without a grant (or an invalid one) means no chain access", () => {
    const r = effectiveGrant(lv([full(), null, full()]), [], ws, NOW);
    assert.equal(r.grant, null);
    assert.equal(r.reason, `${NAMES[1]} has no blockchain grant`);
    assert.equal(effectiveGrant(lv([full(), full({ bogus: 1 })]), [], ws, NOW).reason, `${NAMES[1]} has no blockchain grant`);
    assert.equal(effectiveGrant([], [], ws, NOW).grant, null);
  });

  test("an expired grant anywhere denies, naming the level", () => {
    const r = effectiveGrant(lv([full(), full({ exp: NOW }), full()]), [], ws, NOW);
    assert.equal(r.grant, null);
    assert.match(r.reason!, new RegExp(`^${NAMES[1].replace(/\./g, "\\.")}'s blockchain grant expired at `));
  });

  const overlay = (over: Partial<Overlay> = {}): Overlay => ({
    id: "inc_1",
    after: NAMES[3],
    name: NAMES[3],
    bundle: null,
    chain: full({ to: ["supplier"], max: "5", limit: "5", period: "total", delegate: false }),
    notAfter: NOW + 3600,
    bucket: "approval:inc_1",
    ...over,
  });

  test("an overlay narrows the subject and carries its own bucket", () => {
    const r = effectiveGrant(lv([full(), full(), full(), full()]), [overlay()], ws, NOW);
    assert.equal(r.reason, null);
    assert.deepEqual(r.grant!.recipients, [SUPPLIER]);
    assert.equal(r.grant!.maxBase, 5n * E18);
    const last = r.perLevel.at(-1)!;
    assert.equal(last.overlay, "inc_1");
    assert.equal(last.bucket, "approval:inc_1");
    assert.equal(last.node, namehash(NAMES[3]));
    assert.equal(last.limit!.base, 5n * E18);
  });

  test("an overlay on a middle level applies to its descendants and needs delegate", () => {
    const mid = overlay({ after: NAMES[2], name: NAMES[2] });
    assert.equal(effectiveGrant(lv([full(), full(), full(), full()]), [mid], ws, NOW).reason, `${NAMES[2]} doesn't allow further delegation`);
    const r = effectiveGrant(lv([full(), full(), full(), full()]), [{ ...mid, chain: full({ to: ["contractor"], delegate: true }) }], ws, NOW);
    assert.deepEqual(r.grant!.recipients, [CONTRACTOR]);
    assert.equal(r.perLevel[3].overlay, "inc_1");
  });

  test("an expired, unreadable or misplaced overlay denies; an approved scope without a chain grant denies chain access", () => {
    const L = lv([full(), full(), full(), full()]);
    assert.match(effectiveGrant(L, [overlay({ notAfter: NOW })], ws, NOW).reason!, /approved scope for .* ended at .*; request a renewal/);
    assert.match(effectiveGrant(L, [overlay({ chain: "{bad" })], ws, NOW).reason!, /unreadable/);
    assert.match(effectiveGrant(L, [overlay({ after: "else.eth" })], ws, NOW).reason!, /doesn't match/);
    // The approver signed "blockchain: none": the wide ENS grant below must not come back.
    const wide = lv([full(), full(), full(), full({ max: "10", limit: "200", approve: "never" })]);
    const r = effectiveGrant(wide, [overlay({ chain: null })], ws, NOW);
    assert.equal(r.grant, null);
    assert.match(r.reason!, /approved scope for .* gives no blockchain access/);
  });

  test("grantId changes when any record, resolver, resource or overlay changes", () => {
    const base = lv([full(), full(), full()]);
    const id = grantIdOf(base);
    assert.match(id, /^0x[0-9a-f]{64}$/);
    assert.equal(grantIdOf(lv([full(), full(), full()])), id);
    assert.equal(effectiveGrant(base, [], ws, NOW).grantId, id);
    const variants: GrantLevel[][] = [
      base.map((l, i) => (i === 1 ? { ...l, chain: full({ max: "9" }) } : l)),
      base.map((l, i) => (i === 0 ? { ...l, resolver: "0x7777777777777777777777777777777777777777" as Address } : l)),
      base.map((l, i) => (i === 2 ? { ...l, resource: "999" } : l)),
      base.map((l, i) => (i === 2 ? { ...l, chain: null } : l)),
    ];
    for (const v of variants) assert.notEqual(grantIdOf(v), id);
    const withOverlay = grantIdOf(base, [overlay({ after: NAMES[2] })]);
    assert.notEqual(withOverlay, id);
    assert.notEqual(grantIdOf(base, [overlay({ after: NAMES[2], chain: full({ max: "1" }) })]), withOverlay);
    // Failure results still carry the id (for logs).
    assert.equal(effectiveGrant(lv([full(), null]), [], ws, NOW).grantId, grantIdOf(lv([full(), null])));
  });
});

describe("approvalRequirement / describeGrant", () => {
  const eff = (approve: string) => effectiveGrant(lv([full({ approve })]), [], ws, NOW).grant!;
  test("always / never / above", () => {
    assert.equal(approvalRequirement(eff("always"), E18).required, true);
    assert.equal(approvalRequirement(eff("never"), 100n * E18).required, false);
    assert.equal(approvalRequirement(eff("above:2"), 2n * E18).required, false);
    assert.equal(approvalRequirement(eff("above:2"), 2n * E18 + 1n).required, true);
    assert.equal(approvalRequirement(eff("above:2"), null).required, true);
  });
  test("describeGrant names the limits", () => {
    const text = describeGrant(eff("always"));
    assert.match(text, /per-tx max: 10 STD/);
    assert.match(text, /vault\.pay/);
    assert.equal(describeGrant(null), "no blockchain access");
  });
});
