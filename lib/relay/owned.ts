// Which names under the company root an address owns (GET /api/ens/owned).
//
// ENSv2 has no reverse index from owner to names, so the relay walks the
// company tree breadth-first from RELAY_ROOT_NAME: each level's subname
// registry is listed from its LabelRegistered events (the same cached,
// incremental scans /api/ens/children uses). Only registered names with their
// own registry are descended into, and only when that registry points back to
// the name (findCanonicalName): an alias (another name's registry hung under a
// second path, like launch.growth.marketing.<org>.eth) would list the same
// members under a path the relay refuses.
//
// The walk is bounded (depth, node count, deadline) and its result is cached
// for a few seconds and shared by every address, so a burst of CLI logins
// costs one walk.

import { type Address, isAddressEqual } from "viem";

import { type ChildrenBudget, type TreeReader, isChainReadError, isScanLimitError } from "./ens";
import type { LevelStatus, OwnedResponse } from "./types";

export type TreeNode = {
  name: string;
  /** 0 for the root. */
  depth: number;
  status: LevelStatus;
  owner: Address | null;
  expiry: number | null;
  subregistry: Address | null;
};

export type TreeScan = {
  nodes: TreeNode[];
  /** False when part of the tree couldn't be read in time (a scan still running, a failed read, a limit). */
  complete: boolean;
  /** Why the scan is incomplete. */
  problems: string[];
  at: number;
};

export type TreeScanOptions = { maxDepth: number; deadlineMs: number; maxNodes: number; concurrency: number };

export const DEFAULT_TREE_SCAN: TreeScanOptions = { maxDepth: 5, deadlineMs: 20_000, maxNodes: 2000, concurrency: 3 };

/** Walks the tree under `root` breadth-first, down to `maxDepth` levels below it. */
export async function scanTree(reader: TreeReader, root: string, opts: Partial<TreeScanOptions> = {}): Promise<TreeScan> {
  const o = { ...DEFAULT_TREE_SCAN, ...opts };
  const deadline = Date.now() + o.deadlineMs;
  const problems: string[] = [];
  const nodes: TreeNode[] = [];

  let rootLevel;
  try {
    [rootLevel] = await reader.readLevels(root, root);
  } catch (err) {
    if (!isChainReadError(err)) throw err;
    return { nodes, complete: false, problems: [err.message], at: Date.now() };
  }
  const rootNode: TreeNode = {
    name: root,
    depth: 0,
    status: rootLevel.status,
    owner: rootLevel.owner,
    expiry: rootLevel.expiry,
    subregistry: rootLevel.subregistry,
  };
  nodes.push(rootNode);
  const visited = new Set<string>();
  let layer = rootNode.status === "registered" && rootNode.subregistry ? [rootNode] : [];
  if (rootNode.subregistry) visited.add(rootNode.subregistry.toLowerCase());

  while (layer.length) {
    const next: TreeNode[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < layer.length) {
        const parent = layer[cursor++];
        const left = deadline - Date.now();
        if (left <= 0) {
          problems.push(`ran out of time before listing ${parent.name}`);
          continue;
        }
        const budget: ChildrenBudget = { maxChunks: 200, deadlineMs: left, maxLabels: 1000, slotWaitMs: Math.min(left, 5000) };
        try {
          const { children } = await reader.listChildren(parent.name, budget);
          for (const c of children) {
            next.push({ name: c.name, depth: parent.depth + 1, status: c.status, owner: c.owner, expiry: c.expiry, subregistry: c.subregistry });
          }
        } catch (err) {
          if (!isScanLimitError(err) && !isChainReadError(err)) throw err;
          problems.push(`${parent.name}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, layer.length)) }, worker));

    // Keep the tree's order stable (listing order within a parent, parents in layer order).
    const order = new Map(layer.map((n, i) => [n.name, i]));
    const parentOf = (n: TreeNode) => n.name.slice(n.name.indexOf(".") + 1);
    next.sort((a, b) => (order.get(parentOf(a)) ?? 0) - (order.get(parentOf(b)) ?? 0));

    const room = o.maxNodes - nodes.length;
    if (next.length > room) problems.push(`more than ${o.maxNodes} names; the rest were skipped`);
    const kept = next.slice(0, Math.max(0, room));
    nodes.push(...kept);

    const descend = kept.filter((n) => n.depth < o.maxDepth && n.status === "registered" && n.subregistry && !visited.has(n.subregistry.toLowerCase()));
    if (!descend.length || Date.now() >= deadline) {
      if (descend.length) problems.push("ran out of time before the deepest levels");
      break;
    }
    let canonical: (boolean | null)[];
    try {
      canonical = await reader.canonical(descend.map((n) => ({ registry: n.subregistry!, name: n.name })));
    } catch (err) {
      if (!isChainReadError(err)) throw err;
      problems.push(err.message);
      break;
    }
    layer = descend.filter((n, i) => {
      if (canonical[i] !== true) return false; // an alias or unknown: its members are listed under their canonical path
      const key = n.subregistry!.toLowerCase();
      if (visited.has(key)) return false;
      visited.add(key);
      return true;
    });
  }
  return { nodes, complete: problems.length === 0, problems, at: Date.now() };
}

/**
 * Registered names owned by `address`, deepest first (then in tree order).
 * `member` is true when every level above the name is held by the company
 * owner: a name the company added. Anyone who controls a registry (every
 * member does) can register names to any address without asking, so a name
 * under someone else's level isn't necessarily one its owner wants to use.
 */
export function ownedIn(scan: TreeScan, address: Address): OwnedResponse["names"] {
  const byName = new Map(scan.nodes.map((n) => [n.name, n]));
  const company = scan.nodes.find((n) => n.depth === 0)?.owner ?? null;
  const addedByCompany = (n: TreeNode) => {
    if (!company) return false;
    for (let name = n.name, d = n.depth; d > 0; d--) {
      name = name.slice(name.indexOf(".") + 1);
      const up = byName.get(name);
      if (!up || up.status !== "registered" || !up.owner || !isAddressEqual(up.owner, company)) return false;
    }
    return true;
  };
  return scan.nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.status === "registered" && n.owner && isAddressEqual(n.owner, address))
    .sort((a, b) => b.n.depth - a.n.depth || a.i - b.i)
    .map(({ n }) => ({ name: n.name, depth: n.depth, expiry: n.expiry, hasSubregistry: !!n.subregistry, member: addedByCompany(n) }));
}

// --- Cache ----------------------------------------------------------------------

/** How long a complete walk is reused. Short: a member added in the portal shows up within seconds. */
export const TREE_TTL_MS = 5_000;
/** An incomplete walk is reused only briefly, so the next call resumes the scans. */
const PARTIAL_TTL_MS = 1_000;

type CacheEntry = { scan: Promise<TreeScan>; pending: boolean; at: number; ttl: number };
const g = globalThis as unknown as { __relayTrees?: WeakMap<TreeReader, Map<string, CacheEntry>> };

/** The tree under `root`, from a recent walk when there is one; concurrent callers share one walk. */
export function cachedTree(reader: TreeReader, root: string, opts: Partial<TreeScanOptions> = {}): Promise<TreeScan> {
  g.__relayTrees ??= new WeakMap();
  let byRoot = g.__relayTrees.get(reader);
  if (!byRoot) g.__relayTrees.set(reader, (byRoot = new Map()));
  const hit = byRoot.get(root);
  if (hit && (hit.pending || Date.now() - hit.at < hit.ttl)) return hit.scan;

  const entry: CacheEntry = { scan: scanTree(reader, root, opts), pending: true, at: Date.now(), ttl: TREE_TTL_MS };
  const cache = byRoot;
  cache.set(root, entry);
  entry.scan.then(
    (scan) => {
      entry.pending = false;
      entry.at = Date.now();
      entry.ttl = scan.complete ? TREE_TTL_MS : PARTIAL_TTL_MS;
    },
    () => {
      if (cache.get(root) === entry) cache.delete(root);
    },
  );
  return entry.scan;
}
