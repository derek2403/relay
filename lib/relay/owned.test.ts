// GET /api/ens/owned: the breadth-first walk of the company tree, on a fake reader.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Address } from "viem";

import { type ChainLevel, ScanLimitError, type TreeReader } from "./ens";
import { cachedTree, ownedIn, scanTree } from "./owned";
import type { ChildView, ChildrenResponse, LevelStatus } from "./types";

const ADMIN: Address = "0x00000000000000000000000000000000000000AD";
const DEREK: Address = "0x0000000000000000000000000000000000000DE1";
const AGENT: Address = "0x00000000000000000000000000000000000000A6";
const MIA: Address = "0x000000000000000000000000000000000000071A";
const reg = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

type Node = { owner: Address | null; status?: LevelStatus; sub?: Address; expiry?: number };

/**
 * acme.eth (admin) > eng > dev > derek > codex > research > deep (depth 6)
 *                          dev > launch (canonical home of the launch registry) > mia
 *                  marketing > growth > launch (alias: the same registry, not canonical here)
 *                          dev > old (expired, held by derek)
 */
const NODES: Record<string, Node> = {
  "acme.eth": { owner: ADMIN, sub: reg(1) },
  "eng.acme.eth": { owner: ADMIN, sub: reg(2) },
  "marketing.acme.eth": { owner: ADMIN, sub: reg(3) },
  "dev.eng.acme.eth": { owner: ADMIN, sub: reg(4) },
  "growth.marketing.acme.eth": { owner: ADMIN, sub: reg(5) },
  "derek.dev.eng.acme.eth": { owner: DEREK, sub: reg(6) },
  "old.dev.eng.acme.eth": { owner: null, status: "available" },
  "launch.dev.eng.acme.eth": { owner: ADMIN, sub: reg(7) },
  "launch.growth.marketing.acme.eth": { owner: ADMIN, sub: reg(7) },
  "mia.launch.dev.eng.acme.eth": { owner: MIA },
  "codex.derek.dev.eng.acme.eth": { owner: AGENT, sub: reg(8) },
  "research.codex.derek.dev.eng.acme.eth": { owner: DEREK, sub: reg(9) },
  "deep.research.codex.derek.dev.eng.acme.eth": { owner: DEREK },
};
// Registry -> the name it canonically serves (findCanonicalName follows parent pointers).
const CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(NODES)
    .filter(([name, n]) => n.sub && name !== "launch.growth.marketing.acme.eth")
    .map(([name, n]) => [n.sub!.toLowerCase(), name]),
);

class FakeTree implements TreeReader {
  lists: string[] = [];
  failOn = new Set<string>();

  async readLevels(_root: string, name: string): Promise<ChainLevel[]> {
    const n = NODES[name];
    return [
      {
        name,
        registry: reg(100),
        resolver: null,
        subregistry: n?.sub ?? null,
        status: n?.status ?? (n ? "registered" : "missing"),
        owner: n?.owner ?? null,
        expiry: 2_000_000_000,
        resource: "1",
        bundle: null,
        checks: { registryVerified: null, resolverVerified: null, canonical: null },
      },
    ];
  }

  async listChildren(name: string): Promise<ChildrenResponse> {
    this.lists.push(name);
    if (this.failOn.has(name)) throw new ScanLimitError(`Still scanning the registry of ${name}. Try again in a moment.`, true);
    // A name's registry lists what's under it; an alias entry shares its target's registry, so it lists the same labels.
    const sub = NODES[name]?.sub;
    const home = sub ? CANONICAL[sub.toLowerCase()] : null;
    const children: ChildView[] = Object.keys(NODES)
      .filter((child) => home && child.endsWith(`.${home}`) && !child.slice(0, -home.length - 1).includes("."))
      .map((child) => {
        const label = child.split(".")[0];
        const n = NODES[child];
        const status = n.status ?? "registered";
        return { label, name: `${label}.${name}`, status, owner: status === "registered" ? n.owner : null, expiry: n.expiry ?? 2_000_000_000, resolver: null, subregistry: n.sub ?? null, bundle: null };
      });
    return { name, registry: sub ?? null, children };
  }

  async canonical(pairs: { registry: Address; name: string }[]) {
    return pairs.map((p) => CANONICAL[p.registry.toLowerCase()] === p.name);
  }
}

test("owned: a member's names, deepest first; expired names don't count", async () => {
  const scan = await scanTree(new FakeTree(), "acme.eth");
  assert.equal(scan.complete, true, scan.problems.join("; "));
  assert.deepEqual(ownedIn(scan, DEREK), [
    // Held by derek, but under his agent: not a name the company added.
    { name: "research.codex.derek.dev.eng.acme.eth", depth: 5, expiry: 2_000_000_000, hasSubregistry: true, member: false },
    { name: "derek.dev.eng.acme.eth", depth: 3, expiry: 2_000_000_000, hasSubregistry: true, member: true },
  ]);
  assert.deepEqual(ownedIn(scan, AGENT).map((n) => [n.name, n.member]), [["codex.derek.dev.eng.acme.eth", false]]);
  assert.deepEqual(ownedIn(scan, MIA).map((n) => [n.name, n.member]), [["mia.launch.dev.eng.acme.eth", true]]);
});

test("owned: the walk stops at depth 5 below the root", async () => {
  const tree = new FakeTree();
  const scan = await scanTree(tree, "acme.eth");
  assert.ok(!scan.nodes.some((n) => n.name.startsWith("deep.")), "depth 6 is not listed");
  assert.ok(!tree.lists.includes("research.codex.derek.dev.eng.acme.eth"), "a depth-5 name's registry is not scanned");
  assert.ok(scan.nodes.every((n) => n.depth <= 5));
});

test("owned: an aliased registry is only walked under its canonical path", async () => {
  const tree = new FakeTree();
  const scan = await scanTree(tree, "acme.eth");
  // Mia sits in the shared launch registry; the alias path under growth is never listed.
  const names = scan.nodes.map((n) => n.name);
  assert.ok(names.includes("launch.growth.marketing.acme.eth"), "the alias entry itself is a registered name");
  assert.ok(!tree.lists.includes("launch.growth.marketing.acme.eth"));
  assert.ok(!names.some((n) => n.startsWith("mia.launch.growth")));
  // The admin holds company, departments, teams and the squad, deepest first.
  assert.deepEqual(ownedIn(scan, ADMIN).map((n) => [n.name, n.depth]), [
    ["launch.dev.eng.acme.eth", 3],
    ["launch.growth.marketing.acme.eth", 3],
    ["dev.eng.acme.eth", 2],
    ["growth.marketing.acme.eth", 2],
    ["eng.acme.eth", 1],
    ["marketing.acme.eth", 1],
    ["acme.eth", 0],
  ]);
  assert.deepEqual(ownedIn(scan, MIA).map((n) => [n.name, n.depth]), [["mia.launch.dev.eng.acme.eth", 4]]);
});

test("owned: a registry still being scanned leaves the walk incomplete but keeps the rest", async () => {
  const tree = new FakeTree();
  tree.failOn.add("marketing.acme.eth");
  const scan = await scanTree(tree, "acme.eth");
  assert.equal(scan.complete, false);
  assert.match(scan.problems[0], /marketing\.acme\.eth: Still scanning/);
  assert.deepEqual(ownedIn(scan, DEREK).map((n) => n.name), ["research.codex.derek.dev.eng.acme.eth", "derek.dev.eng.acme.eth"]);
});

test("owned: bounded by a deadline and a node limit", async () => {
  const slow = new FakeTree();
  const list = slow.listChildren.bind(slow);
  slow.listChildren = async (name: string) => {
    await new Promise((r) => setTimeout(r, 30));
    return list(name);
  };
  const timed = await scanTree(slow, "acme.eth", { deadlineMs: 50, concurrency: 1 });
  assert.equal(timed.complete, false);
  assert.ok(timed.problems.some((p) => /ran out of time/.test(p)));

  const capped = await scanTree(new FakeTree(), "acme.eth", { maxNodes: 4 });
  assert.equal(capped.nodes.length, 4);
  assert.equal(capped.complete, false);
});

test("owned: walks are cached briefly and shared by concurrent callers", async () => {
  const tree = new FakeTree();
  const [a, b] = await Promise.all([cachedTree(tree, "acme.eth"), cachedTree(tree, "acme.eth")]);
  assert.equal(a, b);
  const listed = tree.lists.length;
  await cachedTree(tree, "acme.eth");
  assert.equal(tree.lists.length, listed, "served from the cache");
});

test("owned: a root that isn't registered has nothing under it", async () => {
  const scan = await scanTree(new FakeTree(), "nope.eth");
  assert.deepEqual(scan.nodes.map((n) => n.status), ["missing"]);
  assert.deepEqual(ownedIn(scan, ADMIN), []);
});
