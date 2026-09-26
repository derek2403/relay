// Live mode's view model: maps ENS chain state and relay answers to the shared
// presentational types (lib/view-model.ts). Pure: no React, no I/O.

import { type Address, isAddressEqual, zeroAddress } from "viem";

import type { LiveNode } from "@/components/live/LiveContext";
import type { RelayNodeKind } from "@/lib/hooks/useRelayNode";
import { type LevelBundle, isNever, limitsAbove, providerLabel, usd } from "@/lib/relay/browser";
import { type Bundle, type LevelInput, type Period, evaluate } from "@/lib/relay/bundle";
import { CATALOG, CATEGORY_LABELS, type CatalogEntry, type ProviderId, countText, isListed } from "@/lib/relay/catalog";
import type { ChildView, ChildrenResponse, LevelStatus, LevelView, LogEntry, OwnedResponse, StatusResponse } from "@/lib/relay/types";
import {
  type ActivityView,
  type GrantView,
  type MetricsView,
  type NodeStatus,
  type NodeType,
  type ProviderIndex,
  type ProviderView,
  indexProviders,
  summarizeIdentities,
} from "@/lib/view-model";
import { providerMark } from "@/lib/provider-marks";

// --- Loading the tree --------------------------------------------------------------

/** How much of the tree live mode loads: levels below the root, and names in all. */
export const LIVE_TREE_LIMITS = { maxDepth: 6, maxNodes: 300 };

/** A child from a listing, with the registry that holds it (the listed name's subregistry). */
export type ListedChild = ChildView & {
  registry: Address;
  /**
   * Namespace aliasing: the canonical name of this entry's subregistry when it isn't this name
   * (org:setup's launch.growth… points at launch.dev…'s registry). The relay refuses names under it.
   */
  aliasOf?: string | null;
};

/** Levels below the root: acme.eth 0, eng.acme.eth 1, … */
export const depthBelow = (root: string, name: string) => name.split(".").length - root.split(".").length;

/**
 * The canonical name of a subregistry (UniversalHelper.findCanonicalName): undefined while
 * unknown, null when the chain named none (or the read failed), else the name.
 */
export type CanonicalLookup = (subregistry: Address) => string | null | undefined;

export type TreePlan = {
  /** Names whose children to fetch. */
  listed: string[];
  children: ListedChild[];
  truncated: boolean;
  /** Subregistries whose canonical name must be known before the walk goes below them. */
  checks: Address[];
};

/**
 * Walks the cached children listings breadth first from the root. `listed` are the
 * names whose children to fetch (registered names with a subregistry, down to
 * maxDepth); `children` every name found so far, capped so the tree holds at most
 * maxNodes names with the root. With `canonical`, a name is only listed once its
 * subregistry's canonical name is known and is the name itself: an alias entry is
 * shown (marked) but its subtree, a second copy of another group, isn't walked.
 */
export function collectTree(
  root: string,
  get: (name: string) => ChildrenResponse | undefined,
  limits = LIVE_TREE_LIMITS,
  canonical?: CanonicalLookup,
): TreePlan {
  const listed: string[] = [];
  const children: ListedChild[] = [];
  const checks: Address[] = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const name = queue.shift()!;
    listed.push(name);
    const listing = get(name);
    if (!listing?.registry) continue;
    for (const child of listing.children) {
      if (seen.has(child.name)) continue;
      if (children.length + 1 >= limits.maxNodes) return { listed, children, truncated: true, checks };
      seen.add(child.name);
      const walk = child.status === "registered" && !!child.subregistry && depthBelow(root, child.name) < limits.maxDepth;
      if (!walk || !canonical) {
        children.push({ ...child, registry: listing.registry });
        if (walk) queue.push(child.name);
        continue;
      }
      checks.push(child.subregistry!);
      const found = canonical(child.subregistry!);
      const aliasOf = found && found !== child.name ? found : null;
      children.push({ ...child, registry: listing.registry, aliasOf });
      // Unknown yet: wait for the check rather than draw an alias's copy of another group.
      if (found !== undefined && !aliasOf) queue.push(child.name);
    }
  }
  return { listed, children, truncated: false, checks };
}

/** One name as read from the chain and the relay, before it becomes a LiveNode. */
export type RawLiveNode = {
  name: string;
  registry: Address;
  status: LevelStatus;
  /** Current owner; null unless registered. */
  owner: Address | null;
  /** Owner kept by an expired name (getState's latestOwner); zero or null once removed. */
  latestOwner: Address | null;
  /** Unix seconds. */
  expiry: number | null;
  resolver: Address | null;
  subregistry: Address | null;
  bundle: Bundle | null;
  plan?: string | null;
  /** Holds ROLE_SET_SUBREGISTRY on its own name (members do, agents don't); null while unknown. */
  member: boolean | null;
  /** An alias entry: the canonical name of its subregistry (see ListedChild.aliasOf). */
  aliasOf?: string | null;
};

// --- Nodes ---------------------------------------------------------------------------

const isSet = (address: Address | null | undefined): address is Address => !!address && address !== zeroAddress;

/** Status of a name on its own, before its ancestors are considered. */
export function ownStatus(node: Pick<RawLiveNode, "status" | "expiry" | "latestOwner" | "owner">, nowSec: number): NodeStatus {
  if (node.status === "registered") {
    return node.expiry && !isNever(node.expiry) && nowSec > 0 && node.expiry <= nowSec ? "Expired" : "Active";
  }
  // Expired names read as available but keep their owner and expiry; removed ones lose the owner.
  return isSet(node.latestOwner ?? node.owner) && (node.expiry ?? 0) > 0 ? "Expired" : "Revoked";
}

export function kindOf(root: string, node: Pick<RawLiveNode, "name" | "member">): RelayNodeKind {
  if (node.name === root) return "company";
  if (node.member !== null) return node.member ? "member" : "agent";
  // Roles not read yet: guess from the depth (users sit at depth 3, their agents below).
  return depthBelow(root, node.name) >= 4 ? "agent" : "member";
}

/** Tree card type: agents under agents are subagents; members are named by their depth. */
export function typeOf(depth: number, kind: RelayNodeKind, parentType: NodeType | null): NodeType {
  if (kind === "company" || depth === 0) return "company";
  if (kind === "agent") return parentType === "agent" || parentType === "subagent" ? "subagent" : "agent";
  return depth === 1 ? "department" : depth === 2 ? "team" : "member";
}

export function periodLabel(period: Period | null, type: NodeType): string {
  if (period === "month") return "Monthly (UTC)";
  if (period === "day") return "Daily (UTC)";
  if (period === "total") return type === "agent" || type === "subagent" ? "Entire session" : "In total";
  return "No limits set";
}

export type LiveViewInput = {
  root: string;
  raw: readonly RawLiveNode[];
  nowSec: number;
  address?: Address | null;
  /** True when this browser holds the agent key for an address. */
  hasAgentKey?: (address: Address) => boolean;
};

/** Every raw name as a LiveNode, parents before children; names whose parent isn't loaded are dropped. */
export function toLiveNodes({ root, raw, nowSec, address, hasAgentKey }: LiveViewInput): LiveNode[] {
  const ordered = [...raw]
    .filter((node) => node.name === root || node.name.endsWith(`.${root}`))
    .sort((a, b) => depthBelow(root, a.name) - depthBelow(root, b.name));
  const out = new Map<string, LiveNode>();

  for (const node of ordered) {
    const depth = depthBelow(root, node.name);
    const parentName = depth === 0 ? null : node.name.slice(node.name.indexOf(".") + 1);
    const parent = parentName ? out.get(parentName) : undefined;
    if (depth > 0 && !parent) continue;

    const kind = kindOf(root, node);
    const type = typeOf(depth, kind, parent?.type ?? null);
    const mine = ownStatus(node, nowSec);
    // Removal and expiry cascade: a name is no better off than the level above it.
    const status: NodeStatus = parent?.status === "Revoked" || mine === "Revoked" ? "Revoked" : parent?.status === "Expired" ? "Expired" : mine;
    const allowed = (node.bundle?.keys ?? []).filter(isListed);
    const providers = parent ? parent.providers.filter((id) => allowed.includes(id as ProviderId)) : [...allowed];
    const owner = isSet(node.owner) ? node.owner : isSet(node.latestOwner) ? node.latestOwner : zeroAddress;
    const badges: string[] = [];
    if (address && isSet(node.owner) && isAddressEqual(node.owner, address)) badges.push("you");
    if (kind === "agent" && isSet(owner) && hasAgentKey?.(owner)) badges.push("key in this browser");
    if (node.plan) badges.push(`plan ${node.plan}`);

    out.set(node.name, {
      id: node.name,
      name: node.name,
      label: depth === 0 ? node.name : node.name.split(".")[0],
      fullName: node.name,
      parentId: parentName,
      depth,
      type,
      owner,
      status,
      periodLabel: periodLabel(node.bundle?.period ?? null, type),
      expiry: node.expiry && !isNever(node.expiry) ? node.expiry * 1000 : null,
      providers,
      descendantCount: 0,
      badges,
      registry: node.registry,
      resolver: node.resolver,
      subregistry: node.subregistry,
      kind,
      bundle: node.bundle,
      aliasOf: node.aliasOf ?? null,
    });
  }

  const nodes = [...out.values()];
  for (const node of nodes) {
    // An alias is another path to a group already counted where it belongs.
    if (node.status === "Revoked" || node.aliasOf) continue;
    for (let id = node.parentId; id; id = out.get(id)?.parentId ?? null) {
      const ancestor = out.get(id);
      if (ancestor) ancestor.descendantCount += 1;
    }
  }
  return nodes;
}

// --- Providers -----------------------------------------------------------------------

export { providerMark };

const FEATURED = ["codex", "claude", "github", "openai-images"];

function unitOf(entry: CatalogEntry): ProviderView["unit"] {
  if (entry.dollarCaps) return "usd";
  return entry.metering.kind === "images" ? "count" : "access";
}

function providerStatus(entry: CatalogEntry, configured: boolean | undefined): string {
  // A keyless public API would be routed to its upstream; only the test API is answered by the relay.
  // (Weather is OpenWeatherMap now, with OPENWEATHER_API_KEY like any other key.)
  if (!entry.keyEnv) return entry.upstream ? "No key needed · routed" : "Built in · no key needed";
  if (configured === undefined) return "Relay not reached";
  return configured ? "Relay key set" : "No key on the relay";
}

/** The relay's API catalog, with whether the relay holds each key (from /api/relay/status). */
export function liveProviders(status: StatusResponse | undefined): ProviderView[] {
  const configured = new Map(status?.providers.map((p) => [p.id as string, p.configured]));
  return (CATALOG as readonly CatalogEntry[]).filter((entry) => isListed(entry.id)).map((entry) => {
    const set = entry.keyEnv ? configured.get(entry.id) : true;
    return {
      id: entry.id,
      name: entry.label,
      mark: providerMark(entry.id),
      unit: unitOf(entry),
      statusText: providerStatus(entry, status ? (set ?? false) : undefined),
      description: entry.note ?? `${CATEGORY_LABELS[entry.category]}. Delegated through ENS limits; the key stays in the relay.`,
      configured: set,
    };
  });
}

export function liveMetrics(opts: {
  nodes: readonly LiveNode[];
  providers: readonly ProviderView[];
  providerIndex: ProviderIndex;
  root: string | null;
  /** Dollars the company spent this period, or null when the relay didn't say. */
  rootSpend: number | null;
  rootPeriod: Period | null;
  /** The relay shows spend to nobody in the browser (viewAuth "closed"). */
  spendClosed?: boolean;
}): MetricsView {
  const summary = summarizeIdentities(opts.nodes);
  const featured = FEATURED.map((id) => opts.providerIndex[id]).filter((p): p is ProviderView => !!p);
  const period = opts.rootPeriod === "day" ? "today" : opts.rootPeriod === "total" ? "in total" : "this month";
  return {
    activeIdentities: summary.active,
    identitiesCaption: opts.root ? `under ${opts.root}` : "no company yet",
    providerCount: opts.providers.length,
    featuredProviders: featured,
    usageLabel: opts.rootSpend === null ? "—" : usd(opts.rootSpend),
    usageCaption:
      opts.rootSpend !== null ? `relay spend ${period}` : opts.spendClosed ? "relay spend (admin only)" : "relay spend (sign in to see)",
    agentSessions: summary.sessions,
    sessionsCaption: `includes ${summary.subagents} ${summary.subagents === 1 ? "subagent" : "subagents"}`,
  };
}

/** Dollars spent this period at one level, over every provider. */
export const levelSpend = (level: Pick<LevelView, "spent"> | undefined): number | null =>
  level ? Object.values(level.spent).reduce<number>((sum, n) => sum + (n ?? 0), 0) : null;

// --- Grants (detail panel) ----------------------------------------------------------

export type GrantsInput = {
  /** The selected name and every level above it, root first (bundles from the tree). */
  lineage: readonly LevelBundle[];
  /** The relay's per-level spend for the same names, or null when it couldn't be read. */
  policyLevels: readonly Pick<LevelView, "name" | "spent" | "used">[] | null;
  /** Whether the relay holds the provider's key; undefined when unknown. */
  configured: (id: ProviderId) => boolean | undefined;
};

function limitLabel(bundle: Bundle, id: ProviderId, entry: CatalogEntry): string {
  const cap = bundle.caps[id];
  const max = bundle.maxes?.[id];
  const parts = [cap !== undefined ? usd(cap) : null, max !== undefined ? countText(id, max) : null].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return entry.dollarCaps ? "No cap" : "Allowed";
}

/** One row per API the selected name's own bundle lists, with spend against its limits when the relay shares it. */
export function liveGrants({ lineage, policyLevels, configured }: GrantsInput): GrantView[] {
  const self = lineage[lineage.length - 1];
  const bundle = self?.bundle;
  if (!bundle) return [];
  const above = lineage.slice(0, -1);
  const spendOf = new Map(policyLevels?.map((level) => [level.name, level]));
  const levels: LevelInput[] | null = policyLevels
    ? lineage.map((level) => ({ name: level.name, bundle: level.bundle, spent: spendOf.get(level.name)?.spent ?? {}, used: spendOf.get(level.name)?.used ?? {} }))
    : null;
  const entries = CATALOG as readonly CatalogEntry[];

  return entries
    .filter((entry) => isListed(entry.id) && bundle.keys.includes(entry.id as ProviderId))
    .map((entry): GrantView => {
      const id = entry.id as ProviderId;
      const cap = bundle.caps[id];
      const max = bundle.maxes?.[id];
      const blockedBy = limitsAbove([...above], id).blockedBy;
      const own = spendOf.get(self.name);
      const decision = levels ? evaluate(levels, id) : null;

      let usage: GrantView["usage"];
      if (levels && cap !== undefined) {
        const spent = own?.spent[id] ?? 0;
        const left = decision?.allowed ? (decision.remaining ?? cap - spent) : Math.min(decision?.remaining ?? 0, cap - spent);
        usage = { pct: cap > 0 ? Math.min(100, (spent / cap) * 100) : 100, usedLabel: usd(spent), leftLabel: usd(Math.max(0, left)) };
      } else if (levels && max !== undefined) {
        const used = own?.used?.[id] ?? 0;
        const left = decision?.allowed ? (decision.remainingCount ?? max - used) : Math.min(decision?.remainingCount ?? 0, max - used);
        usage = { pct: max > 0 ? Math.min(100, (used / max) * 100) : 100, usedLabel: countText(id, used), leftLabel: countText(id, Math.max(0, left)) };
      }

      const key = configured(id);
      const notes = [
        !entry.keyEnv ? "No key needed" : key === undefined ? null : key ? "Relay key set" : "No key on the relay",
        blockedBy ? `blocked by ${blockedBy}` : null,
        decision && !decision.allowed && !blockedBy ? decision.reason : null,
        !levels && (cap !== undefined || max !== undefined) ? "spend hidden" : null,
      ].filter(Boolean);
      return { providerId: id, limitLabel: limitLabel(bundle, id, entry), usage, note: notes.join(" · "), blockedByParent: !!blockedBy };
    });
}

/** Bundles from the root down to `id` (root first), from the loaded tree. */
export function lineageOf(nodes: readonly LiveNode[], id: string): LevelBundle[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out: LevelBundle[] = [];
  for (let node = byId.get(id); node; node = node.parentId ? byId.get(node.parentId) : undefined) {
    out.unshift({ name: node.name, bundle: node.bundle });
  }
  return out;
}

// --- Activity ------------------------------------------------------------------------

/** A row of the workspace activity list with the time it happened, for merging. */
export type TimedActivity = ActivityView & { at: number };

function outcome(entry: LogEntry): string {
  const reason = entry.reason ?? "";
  if (/^killed/i.test(reason)) return "Cut off";
  if (/revoked/i.test(reason)) return "Revoked";
  return entry.allowed ? "Allowed" : "Refused";
}

export function logActivity(entry: LogEntry, index: number): TimedActivity {
  const cost = entry.costUsd !== null ? `${usd(entry.costUsd)}${entry.estimated ? " (estimated)" : ""}` : null;
  return {
    id: `log-${entry.ts}-${index}`,
    at: entry.ts,
    title: `${outcome(entry)} · ${providerLabel(entry.provider)}`,
    detail: [entry.name ?? "Unknown caller", `${entry.method} ${entry.path}`, entry.status ? `HTTP ${entry.status}` : null, cost, entry.reason]
      .filter(Boolean)
      .join(" · "),
    time: new Date(entry.ts).toLocaleTimeString(),
  };
}

/** Relay decisions and this session's own events, newest first. */
export function mergeActivity(log: readonly LogEntry[] | undefined, local: readonly TimedActivity[]): ActivityView[] {
  return [...(log ?? []).map(logActivity), ...local].sort((a, b) => b.at - a.at).map(({ at: _at, ...row }) => row);
}

// --- Who is connected ----------------------------------------------------------------

const ROLE_LABELS: Record<NodeType, string> = {
  company: "Workspace owner",
  department: "Department lead",
  team: "Team lead",
  member: "Member",
  agent: "Agent",
  subagent: "Subagent",
};

const DEPTH_TYPES: NodeType[] = ["company", "department", "team", "member", "agent", "subagent"];

/**
 * The connected wallet's place in the workspace: the highest name it owns in the
 * loaded tree, else in /api/ens/owned's answer (which also sees names the tree didn't load).
 */
export function roleFor(address: Address | null | undefined, nodes: readonly LiveNode[], owned?: OwnedResponse["names"]): string {
  if (!address) return "Connect a wallet";
  const mine = nodes
    .filter((node) => node.status !== "Revoked" && isSet(node.owner as Address) && isAddressEqual(node.owner as Address, address))
    .sort((a, b) => a.depth - b.depth)[0];
  if (mine) return ROLE_LABELS[mine.type];
  const top = [...(owned ?? [])].sort((a, b) => a.depth - b.depth)[0];
  if (top) {
    const known = nodes.find((node) => node.name === top.name);
    return ROLE_LABELS[known?.type ?? DEPTH_TYPES[Math.min(top.depth, DEPTH_TYPES.length - 1)]];
  }
  return "Not in this workspace";
}

/** Two letters for the profile avatar: from the ENS name, else the address. */
export function initialsFor(ensName: string | null | undefined, address: Address | null | undefined): string {
  if (ensName) return ensName.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "—";
  if (address) return address.slice(2, 4).toUpperCase();
  return "—";
}
