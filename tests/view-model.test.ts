import assert from "node:assert/strict";
import test from "node:test";
import {
  ancestorIds,
  connectorPath,
  formatExpiry,
  indexProviders,
  layoutTree,
  nodeIcon,
  providerOf,
  shortAddress,
  summarizeIdentities,
  visibleNodes,
  type NodeStatus,
  type NodeType,
  type OrgNodeView,
} from "../lib/view-model";

function node(id: string, parentId: string | null, type: NodeType, status: NodeStatus = "Active"): OrgNodeView {
  return {
    id,
    label: id,
    fullName: id,
    parentId,
    depth: 0,
    type,
    owner: "0x" + "1".repeat(40),
    status,
    periodLabel: "Monthly (UTC)",
    expiry: null,
    providers: [],
    descendantCount: 0,
  };
}

// root ─┬─ a ─┬─ a1
//       │     └─ a2 ── a2x (revoked)
//       └─ b ─── b1 (expired)
const tree = [
  node("root", null, "company"),
  node("a", "root", "department"),
  node("a1", "a", "team"),
  node("a2", "a", "team"),
  node("a2x", "a2", "member", "Revoked"),
  node("b", "root", "department"),
  node("b1", "b", "team", "Expired"),
];

test("layoutTree places leaves side by side and centres parents over their children", () => {
  const layout = layoutTree(tree, "root")!;
  assert.deepEqual(layout.positions.a1, { x: 120, y: 310 });
  assert.deepEqual(layout.positions.a2x, { x: 340, y: 455 });
  assert.deepEqual(layout.positions.a2, { x: 340, y: 310 });
  assert.deepEqual(layout.positions.a, { x: 230, y: 165 });
  assert.deepEqual(layout.positions.b1, { x: 560, y: 310 });
  assert.deepEqual(layout.positions.root, { x: 395, y: 20 });
  assert.equal(layout.width, 780);
  assert.equal(layout.height, 880);
});

test("layoutTree grows the canvas for deep or wide trees and needs a root", () => {
  const levels = ["company", "department", "team", "member", "agent", "subagent", "subagent"] as const;
  const deep = levels.map((type, depth) => node("n" + depth, depth ? "n" + (depth - 1) : null, type));
  assert.equal(layoutTree(deep, "n0")!.height, 20 + 6 * 145 + 135);
  assert.equal(layoutTree(deep, "n0")!.width, 650);
  const wide = [node("root", null, "company"), ...[1, 2, 3, 4].map((i) => node("d" + i, "root", "department"))];
  assert.equal(layoutTree(wide, "root")!.width, 120 + 4 * 220);
  assert.equal(layoutTree(tree, "missing"), null);
});

test("visibleNodes hides revoked nodes and keeps the root inside a branch", () => {
  assert.deepEqual(
    visibleNodes(tree, "all").map((n) => n.id),
    ["root", "a", "a1", "a2", "b", "b1"],
  );
  assert.deepEqual(
    visibleNodes(tree, "a").map((n) => n.id),
    ["root", "a", "a1", "a2"],
  );
});

test("ancestorIds walks from the node to the root", () => {
  assert.deepEqual(ancestorIds(tree, "a2x"), ["a2x", "a2", "a", "root"]);
  assert.deepEqual(ancestorIds(tree, "missing"), []);
});

test("connectorPath joins the bottom centre of the parent to the top centre of the child", () => {
  assert.equal(connectorPath({ x: 230, y: 165 }, { x: 120, y: 310 }), "M322.5,270 C322.5,290 212.5,290 212.5,310");
});

test("summarizeIdentities counts active identities and sessions", () => {
  const nodes = [...tree, node("agent", "a1", "agent"), node("sub", "agent", "subagent"), node("old", "agent", "subagent", "Expired")];
  assert.deepEqual(summarizeIdentities(nodes), { active: 7, sessions: 2, subagents: 1 });
});

test("formatting helpers", () => {
  assert.equal(shortAddress("0x1234000000000000000000000000000000005678"), "0x1234…5678");
  assert.equal(formatExpiry(null), "No expiry");
  assert.equal(nodeIcon("team"), "department");
  assert.equal(nodeIcon("agent"), "agent");
});

test("providerOf falls back to a generic provider for unknown ids", () => {
  const index = indexProviders([{ id: "codex", name: "Codex", mark: "codex", unit: "usd", statusText: "", description: "" }]);
  assert.equal(providerOf(index, "codex").name, "Codex");
  assert.deepEqual(providerOf(index, "mock"), { id: "mock", name: "mock", mark: "mock", unit: "access", statusText: "", description: "" });
});
