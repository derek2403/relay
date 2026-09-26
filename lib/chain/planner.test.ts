// Pure parts of the planner: the plan schema check and how events become monitor transfers.

import assert from "node:assert/strict";
import test from "node:test";

import { getAddress } from "viem";

import type { ChainWorkspace } from "./config";
import type { ChainEvent } from "./executor";
import { MAX_STEPS, PLAN_SCHEMA, parsePlan, transfersOf } from "./planner";

const step = (o: Record<string, unknown> = {}) => ({ tool: "read", contract: "vault", method: "paused", args: [], recipient: null, amount: null, proposalId: null, why: "check", ...o });

test("parsePlan accepts schema-valid plans only", () => {
  assert.deepEqual(parsePlan({ steps: [step()], expected: "e" })?.steps[0].tool, "read");
  assert.equal(parsePlan({ steps: [step({ tool: "sign_anything" })], expected: "e" }), null);
  assert.equal(parsePlan({ steps: [step({ extra: 1 })], expected: "e" }), null);
  assert.equal(parsePlan({ steps: [step()], expected: "e", tools: [] }), null);
  assert.equal(parsePlan({ steps: [step({ args: [1] })], expected: "e" }), null);
  assert.equal(parsePlan({ steps: Array.from({ length: MAX_STEPS + 1 }, () => step()), expected: "e" }), null);
  assert.equal(parsePlan("steps"), null);
  // Strict mode: every property required, optional ones nullable.
  const items = PLAN_SCHEMA.properties.steps.items;
  assert.deepEqual([...items.required].sort(), Object.keys(items.properties).sort());
  assert.equal(items.additionalProperties, false);
});

const VAULT = getAddress("0x00000000000000000000000000000000000007a1");
const ws = { vault: { address: VAULT } } as unknown as ChainWorkspace;
const ev = (name: string, inputs: [string, unknown][], tx: string, logIndex = 0): ChainEvent => ({
  txHash: `0x${tx.repeat(64)}` as `0x${string}`,
  block: 1,
  blockHash: `0x${"a".repeat(64)}`,
  logIndex,
  name,
  inputs: inputs.map(([n, value]) => ({ name: n, value })),
  contract: VAULT,
  explorerUrl: "",
});

test("transfersOf: Transfer / Paid / OwnerTransfer, mints skipped, one per tx+recipient+amount", () => {
  const to = "0x0000000000000000000000000000000000000e71";
  const out = transfersOf(
    [
      ev("Transfer", [["from", "0x0000000000000000000000000000000000000000"], ["to", VAULT], ["value", "1000"]], "1"),
      ev("OwnerTransfer", [["to", to], ["amount", "250"]], "2", 0),
      ev("Transfer", [["from", VAULT], ["to", to], ["value", "250"]], "2", 1),
      ev("Paid", [["to", to], ["amount", "3"], ["ref", "0x"], ["agent", VAULT]], "3"),
      ev("Transfer", [["from", VAULT], ["to", "not an address"], ["value", "5"]], "4"),
      ev("Approval", [["owner", VAULT]], "5"),
    ],
    ws,
  );
  assert.deepEqual(out.map((t) => [t.txHash.slice(2, 3), t.from, t.amount, t.event]), [
    ["2", VAULT, "250", "OwnerTransfer"],
    ["3", VAULT, "3", "Paid"],
  ]);
});
