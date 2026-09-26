import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { type Address, type Hex, namehash } from "viem";

import { tempDir } from "../relay/testkit";
import { type NewProposal, createProposal, transition } from "./proposals";
import { ChainStore, ChainStoreError, MAX_RUNS_PER_AGENT, chainFile, chainStore, resetChainStores } from "./store";

const DEREK = "0x4444444444444444444444444444444444444444" as Address;
const E18 = 10n ** 18n;
const T0 = 1_800_000_000;

const input = (over: Partial<NewProposal> = {}): NewProposal => ({
  requestId: "req-1",
  agent: { name: "codex.derek.dev.sodalabs.eth", node: namehash("codex.derek.dev.sodalabs.eth"), resource: "9", owner: DEREK },
  op: "call",
  network: "sepolia",
  target: { kind: "vault", address: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", label: "relay-vault" },
  method: "pay",
  args: ["0x1111111111111111111111111111111111111111", "3000000000000000000", `0x${"00".repeat(32)}`],
  display: { summary: "pay 3 STD" },
  tx: { from: "0x5555555555555555555555555555555555555555", to: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", data: "0xabcdef", value: "0", gas: "90000", type: 2 },
  gasEstimate: "80000",
  grantId: `0x${"12".repeat(32)}`,
  approval: { required: false, rule: "never" },
  ...over,
});

const fresh = () => new ChainStore(path.join(tempDir("relay-chain-"), "chain.json"));

describe("ChainStore", () => {
  test("a missing file is an empty, usable store; writes are 0600 and survive a reload", () => {
    const s = fresh();
    assert.equal(s.unavailable(), null);
    assert.deepEqual(s.proposals(), []);
    const { proposal, created } = s.addProposal(createProposal(input(), T0));
    assert.ok(created);
    assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(s.file)), ["chain.json"], "no temp files left behind");
    const again = new ChainStore(s.file);
    assert.deepEqual(again.proposal(proposal.id), proposal);
  });

  test("duplicate requestId returns the existing proposal; another agent may reuse the id", () => {
    const s = fresh();
    const first = s.addProposal(createProposal(input(), T0)).proposal;
    const dup = s.addProposal(createProposal(input(), T0 + 5));
    assert.equal(dup.created, false);
    assert.equal(dup.proposal.id, first.id);
    assert.equal(s.proposals().length, 1);
    const other = s.addProposal(createProposal(input({ agent: { ...input().agent, name: "watch.codex.derek.dev.sodalabs.eth" } }), T0));
    assert.equal(other.created, true);
    assert.equal(s.findRequest("codex.derek.dev.sodalabs.eth", "req-1")?.id, first.id);
  });

  test("updateProposal is atomic: an illegal transition changes nothing", () => {
    const s = fresh();
    const p = s.addProposal(createProposal(input(), T0)).proposal;
    const before = fs.readFileSync(s.file, "utf8");
    assert.throws(() => s.updateProposal(p.id, (x) => transition(x, "confirmed", "nope")));
    assert.equal(fs.readFileSync(s.file, "utf8"), before);
    assert.equal(s.proposal(p.id)!.state, "approved");
    const next = s.updateProposal(p.id, (x) => transition(x, "submitting", "sign", T0 + 1, { submit: { hash: `0x${"cd".repeat(32)}` as Hex, at: T0 + 1 } }));
    assert.equal(next.state, "submitting");
    assert.equal(new ChainStore(s.file).proposal(p.id)!.state, "submitting");
    assert.throws(() => s.updateProposal("prp_missing", (x) => x), (e: unknown) => e instanceof ChainStoreError && e.status === 404);
  });

  test("a corrupt file fails closed and is never overwritten", () => {
    const dir = tempDir("relay-chain-");
    const file = path.join(dir, "chain.json");
    for (const body of ["{not json", JSON.stringify({ v: 1, proposals: {}, ledger: { buckets: {}, reservations: {} }, escrows: [], seen: {}, runs: {}, extra: 1 }), JSON.stringify({ v: 2 }), '{"v":1,"proposals":{"prp_x":{"id":"prp_y"}},"ledger":{"buckets":{},"reservations":{}},"escrows":[],"seen":{},"runs":{}}']) {
      fs.writeFileSync(file, body);
      const s = new ChainStore(file);
      assert.match(s.unavailable() ?? "", /damaged/);
      assert.throws(() => s.proposals(), (e: unknown) => e instanceof ChainStoreError && e.status === 503);
      assert.throws(() => s.addProposal(createProposal(input(), T0)), ChainStoreError);
      assert.throws(() => s.ledger("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa").reserve([], 1n, "r"), ChainStoreError);
      assert.throws(() => s.markSeen("k"), ChainStoreError);
      assert.equal(fs.readFileSync(file, "utf8"), body, "the damaged file is left for the operator");
    }
  });

  test("a failed write changes nothing in memory", () => {
    const dir = tempDir("relay-chain-");
    const s = new ChainStore(path.join(dir, "sub", "chain.json"));
    fs.writeFileSync(path.join(dir, "sub"), "a file where the directory should be");
    assert.throws(() => s.addProposal(createProposal(input(), T0)), (e: unknown) => e instanceof ChainStoreError && e.code === "chain_store_write_failed");
    assert.deepEqual(s.proposals(), []);
  });

  test("the ledger persists through the store", () => {
    const s = fresh();
    const L = s.ledger("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
    const lvl = [{ name: "a.eth", node: namehash("a.eth"), resource: "1", limit: { base: 10n * E18, period: "total" as const } }];
    assert.ok(L.reserve(lvl, 6n * E18, "prp_1").ok);
    assert.equal(L.reserve(lvl, 6n * E18, "prp_2").ok, false);
    assert.ok(L.commit("prp_1"));
    const reloaded = new ChainStore(s.file).ledger("0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
    assert.equal(reloaded.usage(lvl)[0].spent, 6n * E18);
    assert.equal(reloaded.reservation("prp_1")?.state, "committed");
  });

  test("escrows, seen keys and runs", () => {
    const s = fresh();
    const e = { address: "0x9999999999999999999999999999999999999999" as Address, deployedBy: "codex", proposalId: "prp_1", admin: DEREK, payee: DEREK, amount: "3", txHash: `0x${"ab".repeat(32)}` as Hex, block: 5 };
    assert.equal(s.addEscrow(e).alias, "relay-escrow-1");
    assert.equal(s.addEscrow({ ...e, block: 6 }).block, 5, "idempotent by address");
    assert.equal(s.addEscrow({ ...e, address: "0x8888888888888888888888888888888888888888" }).alias, "relay-escrow-2");
    assert.equal(s.escrows().length, 2);
    assert.equal(s.markSeen("tx:1"), true);
    assert.equal(s.markSeen("tx:1"), false);
    for (let i = 0; i < MAX_RUNS_PER_AGENT + 5; i++) s.addRun("codex", { id: `run_${i}`, at: i, task: "t", plan: null, results: [], report: null });
    const runs = s.runs("codex");
    assert.equal(runs.length, MAX_RUNS_PER_AGENT);
    assert.equal(runs[0].id, "run_5");
    assert.deepEqual(s.runs("nobody"), []);
  });

  test("chainStore() is one store per data dir", () => {
    resetChainStores();
    const dir = tempDir("relay-chain-");
    const a = chainStore({ RELAY_DATA_DIR: dir });
    assert.equal(chainStore({ RELAY_DATA_DIR: dir }), a);
    assert.equal(a.file, chainFile(dir));
    assert.notEqual(chainStore({ RELAY_DATA_DIR: tempDir("relay-chain-") }), a);
    resetChainStores();
  });
});
