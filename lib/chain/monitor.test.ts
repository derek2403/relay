import assert from "node:assert/strict";
import { test } from "node:test";

import { type Address, type Hex, getAddress, namehash } from "viem";

import { SIMPLE_ESCROW } from "./artifacts";
import type { ChainWorkspace } from "./config";
import { effectiveGrant } from "./grant";
import { FLAG_CAVEAT, type TransferLike, flagTransfers } from "./monitor";

const SUPPLIER = "0x1111111111111111111111111111111111111111" as Address;
const CONTRACTOR = "0x2222222222222222222222222222222222222222" as Address;
const STRANGER = "0x3333333333333333333333333333333333333333" as Address;
const GRANTED = "0x7777777777777777777777777777777777777777" as Address;
const VAULT = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const E18 = 10n ** 18n;

const ws = {
  v: 1,
  network: { name: "sepolia", chainId: 11155111, mbChain: "ethereum", explorer: "https://sepolia.etherscan.io" },
  token: { address: getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), label: "relay-token", symbol: "STD", name: "Soda Test Dollar", decimals: 18 },
  vault: { address: VAULT, label: "relay-vault", owner: SUPPLIER, deployBlock: 1 },
  signer: "0x5555555555555555555555555555555555555555",
  templates: { escrow: { label: "relay-escrow", version: "1.0", bytecodeHash: SIMPLE_ESCROW.bytecodeHash, abiHash: SIMPLE_ESCROW.abiHash, networks: ["sepolia"] } },
  recipients: { supplier: SUPPLIER, contractor: CONTRACTOR },
  monitor: { largeTransfer: "50" },
  seed: { txs: [] },
} as unknown as ChainWorkspace;

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const tx = (n: number, from: Address, to: Address, std: bigint, extra: Partial<TransferLike> = {}): TransferLike => ({ txHash: h(n), block: 100 + n, from, to, amount: std * E18, ...extra });

test("flags the large payment to an unapproved address, and only that", () => {
  const events = [
    tx(3, VAULT, STRANGER, 250n, { event: "OwnerTransfer" }),
    tx(1, VAULT, SUPPLIER, 12n),
    tx(2, VAULT, CONTRACTOR, 7n),
  ];
  const f = flagTransfers(events, ws, null);
  assert.deepEqual(f.map((x) => [x.rule, x.severity, x.txHash]), [
    ["large", "medium", h(3)],
    ["unapproved-recipient", "high", h(3)],
  ]);
  assert.equal(f[0].amount, "250");
  assert.equal(f[0].explorerUrl, `https://sepolia.etherscan.io/tx/${h(3)}`);
  assert.equal(f[1].to, STRANGER);
  assert.match(f[1].why, /OwnerTransfer of 250 STD from the vault to 0x3333…3333 \(block 103\)/);
  assert.match(f[1].why, /not an approved recipient/);
  for (const x of f) assert.ok(x.why.endsWith(FLAG_CAVEAT));
});

test("the threshold is inclusive; a large transfer to an approved recipient is flagged only as large", () => {
  const f = flagTransfers([tx(1, VAULT, SUPPLIER, 50n), tx(2, VAULT, SUPPLIER, 49n)], ws, null);
  assert.deepEqual(f.map((x) => [x.rule, x.txHash]), [["large", h(1)]]);
});

test("grant recipients count as approved; incoming transfers aren't recipient-flagged", () => {
  const eff = effectiveGrant(
    [{ name: "a.eth", node: namehash("a.eth"), resource: "1", resolver: null, chain: JSON.stringify({ v: 1, caps: ["track"], to: [GRANTED] }) }],
    [],
    ws,
    1,
  ).grant;
  assert.deepEqual(flagTransfers([tx(1, VAULT, GRANTED, 1n)], ws, eff), []);
  assert.equal(flagTransfers([tx(1, VAULT, GRANTED, 1n)], ws, null)[0].rule, "unapproved-recipient");
  assert.deepEqual(flagTransfers([tx(1, STRANGER, VAULT, 5n)], ws, null), []);
});

test("deterministic: sorted, de-duplicated, malformed input skipped, string amounts accepted", () => {
  const events: TransferLike[] = [
    tx(5, VAULT, STRANGER, 1n),
    tx(4, VAULT, STRANGER, 1n),
    tx(4, VAULT, STRANGER, 1n),
    { txHash: h(6), block: 106, from: VAULT, to: STRANGER, amount: (2n * E18).toString() },
    { txHash: h(7), block: 107, from: VAULT, to: STRANGER, amount: "-5" },
    { txHash: h(8), block: 108, from: "nope" as Address, to: STRANGER, amount: 1n },
  ];
  const a = flagTransfers(events, ws, null);
  assert.deepEqual(a.map((x) => x.txHash), [h(4), h(5), h(6)]);
  assert.equal(a[2].amount, "2");
  assert.deepEqual(flagTransfers([...events].reverse(), ws, null), a);
});
