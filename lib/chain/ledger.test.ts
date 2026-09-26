import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { namehash } from "viem";

import { Ledger, type LedgerLevel, ledgerKey, memoryLedgerIO } from "./ledger";

const TOKEN = "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const E18 = 10n ** 18n;
const NOW = new Date("2026-09-27T12:00:00Z");

const level = (name: string, limit: bigint | null, period: "month" | "day" | "total" = "month", bucket?: string): LedgerLevel => ({
  name,
  node: namehash(name),
  resource: "7",
  limit: limit === null ? null : { base: limit, period },
  bucket,
});
const root = level("sodalabs.eth", 100n * E18);
const dev = level("dev.sodalabs.eth", 60n * E18);
const derek = level("derek.dev.sodalabs.eth", 40n * E18);
const codex = level("codex.derek.dev.sodalabs.eth", null);
const payout = level("payout.codex.derek.dev.sodalabs.eth", 20n * E18);

describe("Ledger", () => {
  test("reserves at every limited level, keyed per node/resource/token/period", () => {
    const io = memoryLedgerIO();
    const l = new Ledger(io, TOKEN);
    const r = l.reserve([root, dev, derek, codex], 3n * E18, "prp_a", NOW);
    assert.deepEqual(r, { ok: true, id: "prp_a", replay: false });
    const keys = Object.keys(io.data.buckets).sort();
    assert.equal(keys.length, 3, "unlimited levels aren't tracked");
    assert.ok(keys.includes(ledgerKey(namehash("dev.sodalabs.eth"), "7", TOKEN, "2026-09")));
    assert.ok(keys.every((k) => k.startsWith("chain:0x") && k.includes(TOKEN.toLowerCase()) && k.endsWith(":2026-09")));
    const usage = l.usage([root, dev, derek], NOW);
    assert.deepEqual(usage.map((u) => [u.name, u.reserved, u.remaining]), [
      ["sodalabs.eth", 3n * E18, 97n * E18],
      ["dev.sodalabs.eth", 3n * E18, 57n * E18],
      ["derek.dev.sodalabs.eth", 3n * E18, 37n * E18],
    ]);
  });

  test("refuses when any level would go over, and reserves nowhere", () => {
    const io = memoryLedgerIO();
    const l = new Ledger(io, TOKEN);
    assert.ok(l.reserve([root, dev, derek], 38n * E18, "a", NOW).ok);
    const r = l.reserve([root, dev, derek], 3n * E18, "b", NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.level, "derek.dev.sodalabs.eth");
    assert.equal(r.remaining, 2n * E18);
    assert.equal(r.limit, 40n * E18);
    assert.equal(l.usage([root], NOW)[0].reserved, 38n * E18, "the root wasn't touched by the refused reservation");
    assert.equal(l.reservation("b"), null);
  });

  test("two concurrent reservations that each fit alone but not together: exactly one succeeds", async () => {
    const l = new Ledger(memoryLedgerIO(), TOKEN);
    const attempt = async (id: string) => {
      await Promise.resolve();
      return l.reserve([root, payout], 15n * E18, id, NOW);
    };
    const results = await Promise.all([attempt("x"), attempt("y"), attempt("z")]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(l.usage([payout], NOW)[0].reserved, 15n * E18);
  });

  test("a parent limit shared by two agents is not multiplied", () => {
    const l = new Ledger(memoryLedgerIO(), TOKEN);
    const parent = level("derek.dev.sodalabs.eth", 10n * E18);
    const a = level("a.derek.dev.sodalabs.eth", 10n * E18);
    const b = level("b.derek.dev.sodalabs.eth", 10n * E18);
    assert.ok(l.reserve([parent, a], 7n * E18, "a1", NOW).ok);
    const r = l.reserve([parent, b], 7n * E18, "b1", NOW);
    assert.ok(!r.ok && r.level === "derek.dev.sodalabs.eth" && r.remaining === 3n * E18);
    assert.ok(l.reserve([parent, b], 3n * E18, "b2", NOW).ok);
  });

  test("commit and release are idempotent; spent stays within the limit", () => {
    const io = memoryLedgerIO();
    const l = new Ledger(io, TOKEN);
    assert.ok(l.reserve([payout], 5n * E18, "c", NOW).ok);
    assert.ok(l.reserve([payout], 4n * E18, "d", NOW).ok);
    assert.equal(l.commit("c"), true);
    assert.equal(l.commit("c"), true, "second commit is a no-op");
    assert.equal(l.release("c"), false, "a committed reservation can't be released");
    assert.equal(l.release("d"), true);
    assert.equal(l.release("d"), true, "second release is a no-op");
    assert.equal(l.commit("d"), false, "a released reservation can't be committed");
    assert.equal(l.commit("nope"), false);
    const [u] = l.usage([payout], NOW);
    assert.equal(u.spent, 5n * E18);
    assert.equal(u.reserved, 0n);
    assert.equal(u.remaining, 15n * E18);
  });

  test("replaying a reservation id doesn't reserve twice", () => {
    const l = new Ledger(memoryLedgerIO(), TOKEN);
    assert.deepEqual(l.reserve([payout], 5n * E18, "r", NOW), { ok: true, id: "r", replay: false });
    assert.deepEqual(l.reserve([payout], 5n * E18, "r", NOW), { ok: true, id: "r", replay: true });
    assert.equal(l.usage([payout], NOW)[0].reserved, 5n * E18);
    assert.equal(l.reserve([payout], 6n * E18, "r", NOW).ok, false, "same id, other amount");
    l.release("r");
    assert.equal(l.reserve([payout], 5n * E18, "r", NOW).ok, false, "a released id isn't reused");
  });

  test("periods roll over; total never does; overlay buckets are separate", () => {
    const l = new Ledger(memoryLedgerIO(), TOKEN);
    const daily = level("d.eth", 5n * E18, "day");
    const total = level("t.eth", 5n * E18, "total");
    assert.ok(l.reserve([daily, total], 5n * E18, "p1", NOW).ok);
    const tomorrow = new Date("2026-09-28T00:00:01Z");
    assert.ok(l.reserve([daily], 5n * E18, "p2", tomorrow).ok, "a new day has a fresh bucket");
    assert.equal(l.reserve([total], 1n, "p3", tomorrow).ok, false);
    // An overlay bucket for the same node is its own ledger.
    const overlay = level("d.eth", 5n * E18, "total", "approval:inc_1");
    assert.ok(l.reserve([overlay], 5n * E18, "p4", NOW).ok);
    assert.equal(l.reserve([overlay], 1n, "p5", NOW).ok, false);
    assert.equal(l.usage([overlay], NOW)[0].period, "approval");
  });

  test("the same bucket listed twice is reserved once, against the smaller limit", () => {
    const io = memoryLedgerIO();
    const l = new Ledger(io, TOKEN);
    const a = level("x.eth", 10n * E18);
    const b = { ...a, limit: { base: 4n * E18, period: "month" as const } };
    assert.equal(l.reserve([a, b], 5n * E18, "s1", NOW).ok, false);
    assert.ok(l.reserve([a, b], 4n * E18, "s2", NOW).ok);
    assert.equal(Object.values(io.data.buckets)[0].reserved, (4n * E18).toString());
  });

  test("bad input and a failing write change nothing", () => {
    const io = memoryLedgerIO();
    const l = new Ledger(io, TOKEN);
    assert.equal(l.reserve([payout], 0n, "z1", NOW).ok, false);
    assert.equal(l.reserve([payout], 1n, "bad id!", NOW).ok, false);
    const broken = new Ledger({ read: io.read, write: () => { throw new Error("disk full"); } }, TOKEN);
    assert.throws(() => broken.reserve([payout], 1n, "z2", NOW), /disk full/);
    assert.deepEqual(io.data, { buckets: {}, reservations: {} });
  });
});
