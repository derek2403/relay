import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { namehash as namehashOf } from "../ens/names";
import { RECORD_KEYS, parseBundle } from "./bundle";
import { LOG_LIMIT, Meter, spendKey } from "./meter";
import { charge } from "./policy";
import type { LevelView, LogEntry } from "./types";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-meter-")), "relay.json");

const entry = (i: number): LogEntry => ({
  ts: i,
  name: "a.acme.eth",
  provider: "mock",
  method: "POST",
  path: "/v1/messages",
  allowed: true,
  reason: null,
  status: 200,
  costUsd: 0.01,
  estimated: false,
  signer: null,
});

test("meter: spend and log survive a restart (atomic write, no tmp file left)", async () => {
  const file = tmpFile();
  const a = new Meter(file, 5);
  const key = spendKey("0x01", "7", "claude", "2026-09");
  a.add(key, 0.1);
  a.add(key, 0.2);
  a.add(key, -5); // ignored
  a.log(entry(1));
  await a.flush();
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["relay.json"]);

  const b = new Meter(file);
  assert.equal(b.spent(key), 0.3);
  assert.deepEqual(b.recent(10), [entry(1)]);
});

test("meter: debounced save happens without an explicit flush", async () => {
  const file = tmpFile();
  const m = new Meter(file, 5);
  m.add("k", 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).spend.k, 1);
});

test("meter: log is a ring buffer of the last 500, newest first", async () => {
  const file = tmpFile();
  const m = new Meter(file, 5);
  for (let i = 0; i < LOG_LIMIT + 20; i++) m.log(entry(i));
  const all = m.recent(10_000);
  assert.equal(all.length, LOG_LIMIT);
  assert.equal(all[0].ts, LOG_LIMIT + 19);
  assert.equal(all[all.length - 1].ts, 20);
  assert.deepEqual(m.recent(2).map((e) => e.ts), [LOG_LIMIT + 19, LOG_LIMIT + 18]);
  assert.deepEqual(m.recent(0), []);
  await m.flush();
  assert.equal(new Meter(file).recent(10_000).length, LOG_LIMIT);
});

test("meter: a damaged or empty file makes the meter unavailable, and is never overwritten", async () => {
  for (const content of ["{not json", "", "null", '{"version":1}']) {
    const file = tmpFile();
    fs.writeFileSync(file, content);
    const m = new Meter(file, 5);
    assert.match(m.unavailable() ?? "", /damaged/, JSON.stringify(content));
    m.add("k", 1);
    m.log(entry(1));
    await m.flush();
    m.flushSync();
    assert.equal(fs.readFileSync(file, "utf8"), content, "left as it was");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["relay.json"]);
  }
});

test("meter: a failed save makes the meter unavailable until a save works", async () => {
  const file = tmpFile();
  const m = new Meter(file, 5);
  assert.equal(m.unavailable(), null);
  // A directory where the file should be: the rename fails.
  fs.mkdirSync(file);
  m.add("k", 1);
  await m.flush();
  assert.match(m.unavailable() ?? "", /can't save spend/);
  fs.rmdirSync(file);
  await m.flush();
  assert.equal(m.unavailable(), null);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).spend.k, 1);
});

test("meter: reservations count as pending until released, and release only once", () => {
  const m = new Meter(tmpFile(), 5);
  const release = m.hold(["a", "b"], 0.3);
  const release2 = m.hold(["a"], 0.2);
  assert.equal(m.pending("a"), 0.5);
  assert.equal(m.pending("b"), 0.3);
  release();
  release();
  assert.equal(m.pending("a"), 0.2);
  assert.equal(m.pending("b"), 0);
  release2();
  assert.equal(m.pending("a"), 0);
  assert.equal(m.spent("a"), 0, "a reservation is not spend");
});

test("meter: in-flight slots per name", () => {
  const m = new Meter(tmpFile(), 5);
  assert.ok(m.enter("n", 2));
  assert.ok(m.enter("n", 2));
  assert.ok(!m.enter("n", 2));
  assert.ok(m.enter("other", 2));
  m.leave("n");
  assert.equal(m.inFlight("n"), 1);
  assert.ok(m.enter("n", 2));
});

const level = (name: string, resource: string, period: string): Pick<LevelView, "name" | "resource" | "bundle"> => ({
  name,
  resource,
  bundle: parseBundle({ [RECORD_KEYS.keys]: "claude", [RECORD_KEYS.period]: period }),
});

test("period buckets: month, day and total each charge their own bucket", async () => {
  const m = new Meter(tmpFile(), 5);
  const levels = [level("acme.eth", "1", "month"), level("eng.acme.eth", "2", "day"), level("laptop.eng.acme.eth", "3", "total")];
  const sep30 = new Date("2026-09-30T23:00:00Z");
  const oct1 = new Date("2026-10-01T01:00:00Z");
  charge(levels, "claude", 1, m, sep30);
  charge(levels, "claude", 2, m, oct1);

  const key = (l: (typeof levels)[number], p: string) => spendKey(namehashOf(l.name), l.resource, "claude", p);
  assert.equal(m.spent(key(levels[0], "2026-09")), 1);
  assert.equal(m.spent(key(levels[0], "2026-10")), 2);
  assert.equal(m.spent(key(levels[1], "2026-09-30")), 1);
  assert.equal(m.spent(key(levels[1], "2026-10-01")), 2);
  assert.equal(m.spent(key(levels[2], "total")), 3);
});

test("re-registering a label (new resource) starts its meter at $0", () => {
  const m = new Meter(tmpFile(), 5);
  const now = new Date("2026-09-26T00:00:00Z");
  charge([level("bob.acme.eth", "100", "month")], "claude", 5, m, now);
  assert.equal(m.spent(spendKey(namehashOf("bob.acme.eth"), "100", "claude", "2026-09")), 5);
  assert.equal(m.spent(spendKey(namehashOf("bob.acme.eth"), "101", "claude", "2026-09")), 0);
});

