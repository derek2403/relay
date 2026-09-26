import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Address } from "viem";

import { namehash } from "../ens/names";
import { RECORD_KEYS, parseBundle, periodKey } from "./bundle";
import { loadConfig } from "./config";
import type { ChainLevel, ChainReader } from "./ens";
import { Meter, spendKey } from "./meter";
import { type PolicyDeps, available, charge, decide, reserve } from "./policy";

const AGENT: Address = "0x00000000000000000000000000000000000000A1";
const OTHER: Address = "0x00000000000000000000000000000000000000B2";
const REG = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const bundle = (keys: string, caps: Record<string, number> = {}, period = "month") =>
  parseBundle({
    [RECORD_KEYS.keys]: keys,
    [RECORD_KEYS.period]: period,
    ...Object.fromEntries(Object.entries(caps).map(([p, v]) => [RECORD_KEYS.cap(p), String(v)])),
  });

function lvl(name: string, over: Partial<ChainLevel> = {}): ChainLevel {
  const isRoot = name === "acme.eth";
  return {
    name,
    registry: isRoot ? REG(1) : REG(name.length),
    resolver: REG(100 + name.length),
    subregistry: null,
    status: "registered",
    owner: OTHER,
    expiry: 2_000_000_000,
    resource: "1",
    bundle: bundle("claude,codex,github,mock"),
    checks: { registryVerified: isRoot ? null : true, resolverVerified: true, canonical: isRoot ? null : true },
    ...over,
  };
}

/** A company tree acme.eth > eng > derek > laptop (agent session). */
function tree(over: Record<string, Partial<ChainLevel>> = {}): Record<string, ChainLevel> {
  const base: Record<string, ChainLevel> = {
    "acme.eth": lvl("acme.eth", { bundle: bundle("claude,codex,github,mock", { claude: 1000 }) }),
    "eng.acme.eth": lvl("eng.acme.eth", { bundle: bundle("claude,github,mock", { claude: 50 }) }),
    "derek.eng.acme.eth": lvl("derek.eng.acme.eth", { bundle: bundle("claude,codex,mock", { claude: 20 }) }),
    "laptop.derek.eng.acme.eth": lvl("laptop.derek.eng.acme.eth", { owner: AGENT, bundle: bundle("claude,mock", { claude: 5 }, "total") }),
  };
  for (const [name, patch] of Object.entries(over)) base[name] = { ...base[name], ...patch };
  return base;
}

class FakeReader implements ChainReader {
  calls = 0;
  constructor(private readonly levels: Record<string, ChainLevel>) {}
  async readLevels(root: string, name: string): Promise<ChainLevel[]> {
    this.calls++;
    const labels = name.split(".");
    const depth = labels.length - root.split(".").length;
    const out: ChainLevel[] = [];
    for (let i = depth; i >= 0; i--) {
      const n = labels.slice(i).join(".");
      out.push(this.levels[n] ?? lvl(n, { status: "missing", registry: null, resolver: null, owner: null, bundle: null, resource: null }));
    }
    return out;
  }
}

function deps(levels = tree(), env: Record<string, string> = {}): PolicyDeps & { reader: FakeReader } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-"));
  return {
    config: loadConfig({ RELAY_ROOT_NAME: "acme.eth", RELAY_DATA_DIR: dir, ...env }),
    reader: new FakeReader(levels),
    meter: new Meter(path.join(dir, "relay.json"), 5),
    now: () => new Date("2026-09-26T12:00:00Z"),
  };
}

const LEAF = "laptop.derek.eng.acme.eth";

test("allowed: every level allows claude; remaining is the tightest cap; owner matches", async () => {
  const d = await decide({ name: LEAF, provider: "claude", signer: AGENT }, deps());
  assert.equal(d.allowed, true, d.reason ?? "");
  assert.equal(d.denial, null);
  assert.equal(d.remaining, 5);
  assert.equal(d.root, "acme.eth");
  assert.deepEqual(d.levels.map((l) => l.name), ["acme.eth", "eng.acme.eth", "derek.eng.acme.eth", LEAF]);
  assert.equal(d.levels[3].spent.claude, 0);
});

test("provider missing at a middle level denies with that level's name", async () => {
  const d = await decide({ name: "derek.eng.acme.eth", provider: "codex" }, deps());
  assert.equal(d.allowed, false);
  assert.equal(d.denial, "policy");
  assert.match(d.reason!, /^eng\.acme\.eth does not allow codex/);
});

test("exhausted parent cap denies even though the child's own cap has room", async () => {
  const x = deps();
  const eng = tree()["eng.acme.eth"];
  x.meter.add(spendKey(namehash("eng.acme.eth"), eng.resource, "claude", periodKey("month", x.now!())), 50);
  const d = await decide({ name: LEAF, provider: "claude", signer: AGENT }, x);
  assert.equal(d.allowed, false);
  assert.equal(d.remaining, 0);
  assert.match(d.reason!, /eng\.acme\.eth has used its claude cap \(\$50\)/);
  assert.equal(d.levels[1].spent.claude, 50);
});

test("charge adds to every level, each in its own period, and shows up in the next decision", async () => {
  const x = deps();
  const first = await decide({ name: LEAF, provider: "claude", signer: AGENT }, x);
  charge(first.levels, "claude", 1.5, x.meter, x.now!());
  const next = await decide({ name: LEAF, provider: "claude", signer: AGENT }, x);
  assert.deepEqual(next.levels.map((l) => l.spent.claude), [1.5, 1.5, 1.5, 1.5]);
  assert.equal(next.remaining, 3.5);
  // The agent's bundle is period "total"; the others are monthly.
  assert.equal(x.meter.spent(spendKey(namehash(LEAF), "1", "claude", "total")), 1.5);
  assert.equal(x.meter.spent(spendKey(namehash("acme.eth"), "1", "claude", "2026-09")), 1.5);
});

test("an unregistered (revoked) middle level cuts off everything below it", async () => {
  const d = await decide(
    { name: LEAF, provider: "claude", signer: AGENT },
    deps(tree({ "eng.acme.eth": { status: "available", owner: null, subregistry: null } })),
  );
  assert.equal(d.allowed, false);
  assert.equal(d.denial, "not-registered");
  assert.equal(d.reason, "access revoked: eng.acme.eth was removed or expired. Run ./relay login.");
});

test("a level missing from the walk (parent has no registry) is denied", async () => {
  const levels = tree();
  delete levels["derek.eng.acme.eth"];
  delete levels[LEAF];
  const d = await decide({ name: LEAF, provider: "claude", signer: AGENT }, deps(levels));
  assert.equal(d.denial, "not-registered");
  // The first level that isn't registered is named, not the leaf.
  assert.equal(d.reason, "access revoked: derek.eng.acme.eth was removed or expired. Run ./relay login.");
});

test("owner mismatch: the token signer must own the leaf name", async () => {
  const d = await decide({ name: LEAF, provider: "claude", signer: OTHER }, deps());
  assert.equal(d.allowed, false);
  assert.equal(d.denial, "not-owner");
  // Without a signer (policy endpoint) there is no owner check.
  assert.equal((await decide({ name: LEAF, provider: "claude" }, deps())).allowed, true);
});

test("names outside the root are refused without reading the chain", async () => {
  const x = deps();
  const d = await decide({ name: "laptop.derek.other.eth", provider: "claude", signer: AGENT }, x);
  assert.equal(d.denial, "outside-root");
  assert.equal(x.reader.calls, 0);
  assert.equal((await decide({ name: "notacme.eth", provider: "claude" }, x)).denial, "outside-root");
  assert.equal((await decide({ name: "not a name!!", provider: "claude" }, x)).denial, "invalid-name");
  assert.equal((await decide({ name: LEAF, provider: "claude" }, deps(tree(), { RELAY_ROOT_NAME: "" }))).denial, "no-root");
});

test("failed verification: fake registry or resolver anywhere in the path denies", async () => {
  const reg = await decide(
    { name: LEAF, provider: "claude", signer: AGENT },
    deps(tree({ "derek.eng.acme.eth": { checks: { registryVerified: false, resolverVerified: true, canonical: true } } })),
  );
  assert.equal(reg.denial, "unverified");
  assert.match(reg.reason!, /registry holding derek\.eng\.acme\.eth is not a genuine ENSv2 UserRegistry/);

  const res = await decide(
    { name: LEAF, provider: "claude", signer: AGENT },
    deps(tree({ "acme.eth": { checks: { registryVerified: null, resolverVerified: false, canonical: null } } })),
  );
  assert.equal(res.denial, "unverified");
  assert.match(res.reason!, /resolver for acme\.eth/);
});

test("non-canonical registry: denied by default, allowed with RELAY_REQUIRE_CANONICAL=false", async () => {
  const levels = tree({ "eng.acme.eth": { checks: { registryVerified: true, resolverVerified: true, canonical: false } } });
  const strict = await decide({ name: LEAF, provider: "claude", signer: AGENT }, deps(levels));
  assert.equal(strict.denial, "not-canonical");
  assert.match(strict.reason!, /doesn't point back to acme\.eth/);
  const relaxed = await decide({ name: LEAF, provider: "claude", signer: AGENT }, deps(levels, { RELAY_REQUIRE_CANONICAL: "false" }));
  assert.equal(relaxed.allowed, true);
});

test("unknown provider still returns the levels (policy view)", async () => {
  const d = await decide({ name: LEAF, provider: "fax" }, deps());
  assert.equal(d.denial, "unknown-provider");
  assert.equal(d.provider, null);
  assert.equal(d.levels.length, 4);
});

test("DNS alias: x.acme.com is checked as x.acme.eth", async () => {
  const d = await decide({ name: "laptop.derek.eng.acme.com", provider: "claude", signer: AGENT }, deps(tree(), { RELAY_DNS_ALIAS: "acme.com=acme.eth" }));
  assert.equal(d.allowed, true, d.reason ?? "");
  assert.equal(d.name, LEAF);
});

test("reserve: checks every cap and holds atomically, so two calls can't both take the last of a budget", async () => {
  const x = deps();
  const d = await decide({ name: LEAF, provider: "claude", signer: AGENT }, x);
  const now = x.now!();
  assert.equal(available(d.levels, "claude", x.meter, now), 5);
  const a = reserve(d.levels, "claude", 3, x.meter, now);
  const b = reserve(d.levels, "claude", 3, x.meter, now);
  assert.ok(a.ok);
  assert.ok(!b.ok);
  assert.match(b.reason, /laptop\.derek\.eng\.acme\.eth has \$2\.0000 of its claude cap left/);
  // Reservations count against the budget in the next decision, but show apart from settled spend.
  const during = await decide({ name: LEAF, provider: "claude", signer: AGENT }, x);
  assert.deepEqual(during.levels.map((l) => l.spent.claude), [0, 0, 0, 0]);
  assert.deepEqual(during.levels.map((l) => l.reserved?.claude), [3, 3, 3, 3]);
  assert.equal(during.remaining, 2);
  a.reservation.settle(0.25);
  a.reservation.settle(99); // only the first settle counts
  const after = await decide({ name: LEAF, provider: "claude", signer: AGENT }, x);
  assert.deepEqual(after.levels.map((l) => l.spent.claude), [0.25, 0.25, 0.25, 0.25]);
  assert.deepEqual(after.levels.map((l) => l.reserved?.claude), [undefined, undefined, undefined, undefined], "nothing held once settled");
  assert.equal(available(after.levels, "codex", x.meter, now), null, "no level caps codex");
});

test("reserve: a level that is already at its cap refuses even a free-looking call", () => {
  const x = deps();
  const levels = Object.values(tree());
  x.meter.add(spendKey(namehash("eng.acme.eth"), "1", "claude", "2026-09"), 50);
  const r = reserve(levels, "claude", 0.000001, x.meter, x.now!());
  assert.ok(!r.ok);
  assert.match(r.reason, /eng\.acme\.eth has used its claude cap/);
});

test("RELAY_ROOT_OWNER: calls are refused when the root is held by anyone else", async () => {
  const ok = await decide({ name: LEAF, provider: "claude", signer: AGENT }, deps(tree(), { RELAY_ROOT_OWNER: OTHER }));
  assert.equal(ok.allowed, true, ok.reason ?? "");
  const lost = await decide({ name: LEAF, provider: "claude", signer: AGENT }, deps(tree(), { RELAY_ROOT_OWNER: AGENT }));
  assert.equal(lost.denial, "root-mismatch");
  assert.match(lost.reason!, /acme\.eth is held by 0x0+B2, not 0x0+A1/i);
  const invalid = await decide({ name: LEAF, provider: "claude", signer: AGENT }, deps(tree(), { RELAY_ROOT_OWNER: "nope" }));
  assert.equal(invalid.denial, "no-root");
  assert.match(invalid.reason!, /RELAY_ROOT_OWNER/);
});

test("chain problems are reported before a missing provider (ownership check alone)", async () => {
  const revoked = await decide({ name: LEAF, provider: null, signer: AGENT }, deps(tree({ "eng.acme.eth": { status: "available", owner: null } })));
  assert.equal(revoked.denial, "not-registered");
  const fine = await decide({ name: LEAF, provider: null, signer: AGENT }, deps());
  assert.equal(fine.denial, "unknown-provider");
  const stranger = await decide({ name: LEAF, provider: null, signer: OTHER }, deps());
  assert.equal(stranger.denial, "not-owner");
});
