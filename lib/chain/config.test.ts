// Workspace config: strict parsing (fail closed), file loading, signer key validation.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { getAddress } from "viem";

import { tempDir } from "../relay/testkit";
import {
  type ChainWorkspace,
  loadChainWorkspace,
  parseChainWorkspace,
  recipientName,
  resolveRecipient,
  serializeChainWorkspace,
  signerKey,
} from "./config";

const A = (n: string) => getAddress(`0x${n.padStart(40, "0")}`);

const ws = (): ChainWorkspace => ({
  v: 1,
  network: { name: "sepolia", chainId: 11155111, mbChain: "ethereum", explorer: "https://sepolia.etherscan.io" },
  token: { address: A("a1"), label: "relay-token", symbol: "STD", name: "Soda Test Dollar", decimals: 18 },
  vault: { address: A("a2"), label: "relay-vault", owner: A("a3"), deployBlock: 100 },
  signer: A("a4"),
  templates: { escrow: { label: "relay-escrow", version: "1.0", bytecodeHash: `0x${"11".repeat(32)}`, abiHash: `0x${"22".repeat(32)}`, networks: ["sepolia"] } },
  recipients: { supplier: A("b1"), contractor: A("b2") },
  monitor: { largeTransfer: "50" },
  seed: { txs: [{ what: "12 STD to the supplier", hash: `0x${"33".repeat(32)}` }] },
});

test("parseChainWorkspace accepts the setup's shape and normalises addresses", () => {
  const raw = JSON.parse(JSON.stringify(ws()));
  raw.token.address = raw.token.address.toLowerCase();
  const p = parseChainWorkspace(raw);
  assert.ok(p);
  assert.equal(p.token.address, A("a1"));
  assert.deepEqual(parseChainWorkspace(JSON.parse(serializeChainWorkspace(ws()))), ws());
});

test("parseChainWorkspace fails closed on unknown or malformed fields", () => {
  const bad: ((w: any) => void)[] = [
    (w) => (w.extra = 1),
    (w) => (w.v = 2),
    (w) => (w.network.chainId = 1),
    (w) => (w.token.decimals = 6),
    (w) => (w.token.address = A("00")),
    (w) => (w.vault.more = true),
    (w) => (w.vault.deployBlock = -1),
    (w) => (w.signer = "0x12"),
    (w) => (w.templates.escrow.bytecodeHash = "0x12"),
    (w) => (w.templates.escrow.networks = ["mainnet"]),
    (w) => (w.recipients["Bad Name"] = A("b3")),
    (w) => (w.recipients.x = "nope"),
    (w) => (w.monitor.largeTransfer = "1e3"),
    (w) => (w.monitor.largeTransfer = 50),
    (w) => (w.seed.txs[0].hash = "0x1"),
    (w) => (w.seed.txs[0].note = "x"),
  ];
  for (const f of bad) {
    const w = JSON.parse(JSON.stringify(ws()));
    f(w);
    assert.equal(parseChainWorkspace(w), null, f.toString());
  }
  assert.equal(parseChainWorkspace(null), null);
  assert.equal(parseChainWorkspace([]), null);
});

test("loadChainWorkspace reads RELAY_CHAIN_CONFIG, re-reads on change, null when absent or corrupt", () => {
  const dir = tempDir("chain-config-");
  const file = path.join(dir, "chain.json");
  const env = { RELAY_CHAIN_CONFIG: file };
  assert.equal(loadChainWorkspace(env), null);
  fs.writeFileSync(file, serializeChainWorkspace(ws()));
  assert.equal(loadChainWorkspace(env)?.vault.deployBlock, 100);
  const w = ws();
  w.vault.deployBlock = 200;
  fs.writeFileSync(file, serializeChainWorkspace(w) + " ");
  assert.equal(loadChainWorkspace(env)?.vault.deployBlock, 200);
  fs.writeFileSync(file, "{not json");
  assert.equal(loadChainWorkspace(env), null);
});

test("signerKey validates MULTIBAAS_SIGNER_PRIVATE_KEY", () => {
  assert.equal(signerKey({}), null);
  assert.equal(signerKey({ MULTIBAAS_SIGNER_PRIVATE_KEY: "0x1234" }), null);
  assert.equal(signerKey({ MULTIBAAS_SIGNER_PRIVATE_KEY: `0x${"00".repeat(32)}` }), null, "zero is not a key");
  assert.equal(signerKey({ MULTIBAAS_SIGNER_PRIVATE_KEY: ` ${"AB".repeat(32)} ` }), `0x${"ab".repeat(32)}`);
});

test("recipients resolve by name or address", () => {
  const w = ws();
  assert.equal(resolveRecipient(w, "supplier"), A("b1"));
  assert.equal(resolveRecipient(w, "constructor"), null, "no prototype lookups");
  assert.equal(resolveRecipient(w, "nobody"), null);
  assert.equal(resolveRecipient(w, A("c9")), A("c9"));
  assert.equal(recipientName(w, A("b2")), "contractor");
  assert.equal(recipientName(w, A("c9")), null);
});
