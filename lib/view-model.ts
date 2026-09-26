// Shared view model: what the presentational workspace components render (lib/live/view.ts builds it from ENS and the relay).

export type NodeType = "company" | "department" | "team" | "member" | "agent" | "subagent";
export type NodeStatus = "Active" | "Revoked" | "Expired";
export type ProviderUnit = "usd" | "count" | "access";

export type ProviderView = {
  id: string;
  name: string;
  /** Icon key for <Icon/>: a brand mark or a stroke icon. */
  mark: string;
  unit: ProviderUnit;
  statusText: string;
  description: string;
  configured?: boolean;
};

export type ProviderIndex = Readonly<Record<string, ProviderView>>;

export type GrantView = {
  providerId: string;
  limitLabel: string;
  /** Omitted for access-only or uncapped grants. Labels are amounts such as "$1.50". */
  usage?: { pct: number; usedLabel: string; leftLabel: string };
  note: string;
  blockedByParent: boolean;
};

export type OrgNodeView = {
  id: string;
  label: string;
  fullName: string;
  parentId: string | null;
  depth: number;
  type: NodeType;
  owner: string;
  /** Revoked nodes stay in the list for the detail panel but are not drawn in the tree. */
  status: NodeStatus;
  periodLabel: string;
  /** Epoch milliseconds; null means no expiry. */
  expiry: number | null;
  /** Providers allowed by every ancestor. */
  providers: string[];
  /** Descendants that have not been removed. */
  descendantCount: number;
  badges?: string[];
  /**
   * Set on an alias entry: another name's group reached through a second path. Drawn, but not
   * counted as an identity (the relay refuses names under it).
   */
  aliasOf?: string | null;
};

export type ActivityView = { id: string; title: string; detail: string; time: string };

export type MetricsView = {
  activeIdentities: number;
  identitiesCaption: string;
  providerCount: number;
  featuredProviders: ProviderView[];
  usageLabel: string;
  usageCaption: string;
  agentSessions: number;
  sessionsCaption: string;
};

export type Point = { x: number; y: number };
export type TreeLayout = { positions: Readonly<Record<string, Point>>; width: number; height: number };

export const ALL_BRANCHES = "all";
export const LEVEL_LABELS = ["COMPANY", "DEPARTMENT", "TEAM", "USER", "AGENT", "SUBAGENT"] as const;
export const LEVEL_GAP = 145;
export const NODE_WIDTH = 185;
export const NODE_HEIGHT = 105;
/** The stylesheet's default .graph size, used until there is a tree to lay out. */
export const EMPTY_GRAPH = { width: 900, height: 770 } as const;

const LEAF_START = 120;
const LEAF_GAP = 220;
const TOP_OFFSET = 20;

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatExpiry(expiry: number | null): string {
  return expiry ? new Date(expiry).toLocaleString() : "No expiry";
}

export function nodeIcon(type: NodeType): string {
  return type === "team" ? "department" : type;
}

export function indexProviders(providers: readonly ProviderView[]): ProviderIndex {
  return Object.fromEntries(providers.map((provider) => [provider.id, provider]));
}

export function providerOf(index: ProviderIndex, id: string): ProviderView {
  return index[id] ?? { id, name: id, mark: id, unit: "access", statusText: "", description: "" };
}

function lineage(byId: ReadonlyMap<string, OrgNodeView>, node: OrgNodeView | undefined): OrgNodeView[] {
  const result: OrgNodeView[] = [];
  for (let current = node; current; current = current.parentId ? byId.get(current.parentId) : undefined) {
    result.push(current);
  }
  return result;
}

function indexNodes(nodes: readonly OrgNodeView[]): Map<string, OrgNodeView> {
  return new Map(nodes.map((node) => [node.id, node]));
}

/** Ids from the node up to the root, the node included. */
export function ancestorIds(nodes: readonly OrgNodeView[], id: string): string[] {
  const byId = indexNodes(nodes);
  return lineage(byId, byId.get(id)).map((node) => node.id);
}

/** Nodes drawn in the tree: not revoked, and inside the chosen branch (the root always shows). */
export function visibleNodes(nodes: readonly OrgNodeView[], branch: string): OrgNodeView[] {
  const byId = indexNodes(nodes);
  return nodes.filter(
    (node) =>
      node.status !== "Revoked" &&
      (branch === ALL_BRANCHES || node.parentId === null || lineage(byId, node).some((p) => p.id === branch)),
  );
}

/** Leaves sit side by side; each parent is centred over its first and last child. */
export function layoutTree(nodes: readonly OrgNodeView[], rootId: string): TreeLayout | null {
  const root = nodes.find((node) => node.id === rootId);
  if (!root) return null;
  const positions: Record<string, Point> = {};
  let cursor = LEAF_START;
  const visit = (node: OrgNodeView, depth: number) => {
    const children = nodes.filter((child) => child.parentId === node.id);
    const y = TOP_OFFSET + depth * LEVEL_GAP;
    if (!children.length) {
      positions[node.id] = { x: cursor, y };
      cursor += LEAF_GAP;
      return;
    }
    children.forEach((child) => visit(child, depth + 1));
    const first = positions[children[0].id];
    const last = positions[children[children.length - 1].id];
    positions[node.id] = { x: (first.x + last.x) / 2, y };
  };
  visit(root, 0);
  const lowest = Math.max(...Object.values(positions).map((point) => point.y));
  return { positions, width: Math.max(650, cursor), height: Math.max(880, lowest + 135) };
}

/** Bezier from the bottom centre of the parent card to the top centre of the child card. */
export function connectorPath(parent: Point, child: Point): string {
  const sx = parent.x + NODE_WIDTH / 2;
  const sy = parent.y + NODE_HEIGHT;
  const ex = child.x + NODE_WIDTH / 2;
  const ey = child.y;
  const mid = (sy + ey) / 2;
  return `M${sx},${sy} C${sx},${mid} ${ex},${mid} ${ex},${ey}`;
}

export function summarizeIdentities(nodes: readonly OrgNodeView[]) {
  const active = nodes.filter((node) => node.status === "Active" && !node.aliasOf);
  return {
    active: active.length,
    sessions: active.filter((node) => node.type === "agent" || node.type === "subagent").length,
    subagents: active.filter((node) => node.type === "subagent").length,
  };
}
