import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import {
  collectTree,
  initialsFor,
  kindOf,
  levelSpend,
  lineageOf,
  liveGrants,
  liveMetrics,
  liveProviders,
  logActivity,
  mergeActivity,
  ownStatus,
  providerMark,
  roleFor,
  toLiveNodes,
  typeOf,
  type RawLiveNode,
} from "../lib/live/view";
import type { Bundle } from "../lib/relay/bundle";
import type { ChildrenResponse, ChildView, LogEntry, StatusResponse } from "../lib/relay/types";
import { indexProviders, visibleNodes } from "../lib/view-model";

const addr = (c: string) => `0x${c.repeat(40)}` as Address;
const ZERO = addr("0");
const OWNER = addr("a");
const LEAD = addr("b");
const AGENT = addr("c");
const REG = addr("1");
const NOW = 1_800_000_000;

const bundle = (keys: Bundle["keys"], caps: Bundle["caps"] = {}, extra: Partial<Bundle> = {}): Bundle => ({ keys, caps, maxes: {}, period: "month", ...extra });

function raw(name: string, over: Partial<RawLiveNode> = {}): RawLiveNode {
  return {
    name,
    registry: REG,
    status: "registered",
    owner: OWNER,
    latestOwner: OWNER,
    expiry: NOW + 86_400,
    resolver: null,
    subregistry: null,
    bundle: bundle(["codex", "mock"]),
    member: true,
    ...over,
  };
}

const child = (name: string, over: Partial<ChildView> = {}): ChildView => ({
  label: name.split(".")[0],
  name,
  status: "registered",
  owner: OWNER,
  expiry: NOW + 86_400,
  resolver: null,
  subregistry: null,
  bundle: null,
  ...over,
});

test("collectTree walks listings breadth first and only lists registered names with a subregistry", () => {
  const listings: Record<string, ChildrenResponse> = {
    "acme.eth": {
      name: "acme.eth",
      registry: addr("2"),
      children: [child("eng.acme.eth", { subregistry: addr("3") }), child("ops.acme.eth", { status: "available", owner: null, subregistry: addr("4") })],
    },
    "eng.acme.eth": { name: "eng.acme.eth", registry: addr("3"), children: [child("dev.eng.acme.eth")] },
  };
  const plan = collectTree("acme.eth", (name) => listings[name]);
  assert.deepEqual(plan.listed, ["acme.eth", "eng.acme.eth"]);
  assert.deepEqual(
    plan.children.map((c) => [c.name, c.registry]),
    [
      ["eng.acme.eth", addr("2")],
      ["ops.acme.eth", addr("2")],
      ["dev.eng.acme.eth", addr("3")],
    ],
  );
  assert.equal(plan.truncated, false);

  // Not yet listed: the plan stops at the root until its listing arrives.
  assert.deepEqual(collectTree("acme.eth", () => undefined).listed, ["acme.eth"]);
});

test("collectTree waits for canonical names and doesn't walk alias entries", () => {
  const LAUNCH = addr("7");
  const listings: Record<string, ChildrenResponse> = {
    "acme.eth": {
      name: "acme.eth",
      registry: addr("2"),
      children: [child("dev.acme.eth", { subregistry: addr("3") }), child("growth.acme.eth", { subregistry: addr("4") })],
    },
    "dev.acme.eth": { name: "dev.acme.eth", registry: addr("3"), children: [child("launch.dev.acme.eth", { subregistry: LAUNCH })] },
    "growth.acme.eth": { name: "growth.acme.eth", registry: addr("4"), children: [child("launch.growth.acme.eth", { subregistry: LAUNCH })] },
    "launch.dev.acme.eth": { name: "launch.dev.acme.eth", registry: LAUNCH, children: [child("mia.launch.dev.acme.eth")] },
    "launch.growth.acme.eth": { name: "launch.growth.acme.eth", registry: LAUNCH, children: [child("mia.launch.growth.acme.eth")] },
  };
  const canonicalNames: Record<string, string | null> = {
    [addr("3")]: "dev.acme.eth",
    [addr("4")]: "growth.acme.eth",
    [LAUNCH]: "launch.dev.acme.eth",
  };

  // Nothing known yet: the children show, but nothing below them is listed.
  const waiting = collectTree("acme.eth", (name) => listings[name], undefined, () => undefined);
  assert.deepEqual(waiting.listed, ["acme.eth"]);
  assert.deepEqual(waiting.checks, [addr("3"), addr("4")]);

  const plan = collectTree("acme.eth", (name) => listings[name], undefined, (sub) => canonicalNames[sub]);
  assert.deepEqual(plan.listed, ["acme.eth", "dev.acme.eth", "growth.acme.eth", "launch.dev.acme.eth"]);
  const alias = plan.children.find((c) => c.name === "launch.growth.acme.eth")!;
  assert.equal(alias.aliasOf, "launch.dev.acme.eth");
  assert.equal(plan.children.find((c) => c.name === "launch.dev.acme.eth")!.aliasOf, null);
  assert.deepEqual(
    plan.children.map((c) => c.name),
    ["dev.acme.eth", "growth.acme.eth", "launch.dev.acme.eth", "launch.growth.acme.eth", "mia.launch.dev.acme.eth"],
    "the alias's copy of mia isn't drawn",
  );

  // A failed or empty canonical read (null) doesn't hide anything.
  const unknown = collectTree("acme.eth", (name) => listings[name], undefined, () => null);
  assert.equal(unknown.listed.includes("launch.growth.acme.eth"), true);
});

test("alias entries are drawn but not counted", () => {
  const nodes = toLiveNodes({
    root: "acme.eth",
    raw: [raw("acme.eth", { member: null }), raw("growth.acme.eth"), raw("launch.growth.acme.eth", { aliasOf: "launch.dev.acme.eth" })],
    nowSec: NOW,
  });
  const alias = nodes.find((n) => n.name === "launch.growth.acme.eth")!;
  assert.equal(alias.aliasOf, "launch.dev.acme.eth");
  assert.equal(alias.status, "Active");
  assert.equal(nodes.find((n) => n.name === "growth.acme.eth")!.descendantCount, 0);
  assert.equal(nodes.find((n) => n.name === "acme.eth")!.descendantCount, 1);
  assert.equal(visibleNodes(nodes, "all").length, 3);
  assert.equal(liveMetrics({ nodes, providers: [], providerIndex: {}, root: "acme.eth", rootSpend: null, rootPeriod: null }).activeIdentities, 2);
});

test("collectTree respects the depth and node limits", () => {
  const deep = (name: string): ChildrenResponse => ({ name, registry: addr("5"), children: [child(`x.${name}`, { subregistry: addr("6") })] });
  const plan = collectTree("acme.eth", deep, { maxDepth: 2, maxNodes: 100 });
  // Names at maxDepth are shown but not listed further.
  assert.deepEqual(plan.listed, ["acme.eth", "x.acme.eth"]);
  assert.deepEqual(
    plan.children.map((c) => c.name),
    ["x.acme.eth", "x.x.acme.eth"],
  );

  const wide: ChildrenResponse = { name: "acme.eth", registry: addr("5"), children: ["a", "b", "c", "d"].map((l) => child(`${l}.acme.eth`)) };
  const capped = collectTree("acme.eth", () => wide, { maxDepth: 6, maxNodes: 3 });
  assert.equal(capped.children.length, 2);
  assert.equal(capped.truncated, true);
});

test("ownStatus tells active, expired and removed names apart", () => {
  assert.equal(ownStatus(raw("a.acme.eth"), NOW), "Active");
  assert.equal(ownStatus(raw("a.acme.eth", { expiry: NOW - 1 }), NOW), "Expired");
  // Before the clock ticks (now = 0) nothing reads as expired.
  assert.equal(ownStatus(raw("a.acme.eth", { expiry: NOW - 1 }), 0), "Active");
  assert.equal(ownStatus(raw("a.acme.eth", { status: "available", owner: null, latestOwner: LEAD, expiry: NOW - 10 }), NOW), "Expired");
  assert.equal(ownStatus(raw("a.acme.eth", { status: "available", owner: null, latestOwner: ZERO, expiry: null }), NOW), "Revoked");
  assert.equal(ownStatus(raw("a.acme.eth", { status: "available", owner: null, latestOwner: null, expiry: null }), NOW), "Revoked");
});

test("kind and type follow the SRC rules", () => {
  assert.equal(kindOf("acme.eth", { name: "acme.eth", member: null }), "company");
  assert.equal(kindOf("acme.eth", { name: "a.b.c.d.acme.eth", member: null }), "agent");
  assert.equal(kindOf("acme.eth", { name: "c.d.acme.eth", member: null }), "member");
  assert.equal(kindOf("acme.eth", { name: "c.d.acme.eth", member: false }), "agent");
  assert.equal(typeOf(1, "member", "company"), "department");
  assert.equal(typeOf(2, "member", "department"), "team");
  assert.equal(typeOf(3, "member", "team"), "member");
  assert.equal(typeOf(5, "member", "member"), "member");
  assert.equal(typeOf(4, "agent", "member"), "agent");
  assert.equal(typeOf(5, "agent", "agent"), "subagent");
  assert.equal(typeOf(6, "agent", "subagent"), "subagent");
});

function sampleTree(): RawLiveNode[] {
  return [
    raw("acme.eth", { bundle: bundle(["codex", "claude", "mock"], { codex: 50 }), member: null, plan: "gold" }),
    raw("eng.acme.eth", { bundle: bundle(["codex", "mock"], { codex: 20 }), owner: LEAD }),
    raw("dev.eng.acme.eth", { bundle: bundle(["codex", "claude"]) }),
    raw("amy.dev.eng.acme.eth", { bundle: bundle(["codex"], {}, { period: "day" }) }),
    raw("bot.amy.dev.eng.acme.eth", { member: false, owner: AGENT, latestOwner: AGENT, bundle: bundle(["codex"], {}, { period: "total" }) }),
    raw("sub.bot.amy.dev.eng.acme.eth", { member: false, owner: AGENT, latestOwner: AGENT, bundle: bundle(["codex"]) }),
    raw("old.dev.eng.acme.eth", { status: "available", owner: null, latestOwner: ZERO, expiry: null }),
    raw("gone.old.dev.eng.acme.eth"), // parent removed, so it cascades
    raw("late.eng.acme.eth", { expiry: NOW - 5 }),
    raw("kid.late.eng.acme.eth"),
    raw("orphan.nowhere.acme.eth"), // parent not loaded: dropped
  ];
}

test("toLiveNodes builds the view: types, cascade, providers, counts and badges", () => {
  const nodes = toLiveNodes({ root: "acme.eth", raw: sampleTree(), nowSec: NOW, address: OWNER, hasAgentKey: (a) => a === AGENT });
  const by = (name: string) => nodes.find((n) => n.name === name)!;

  assert.equal(nodes.length, 10);
  assert.equal(by("acme.eth").type, "company");
  assert.equal(by("acme.eth").label, "acme.eth");
  assert.equal(by("acme.eth").parentId, null);
  assert.equal(by("eng.acme.eth").type, "department");
  assert.equal(by("dev.eng.acme.eth").type, "team");
  assert.equal(by("amy.dev.eng.acme.eth").type, "member");
  assert.equal(by("bot.amy.dev.eng.acme.eth").type, "agent");
  assert.equal(by("bot.amy.dev.eng.acme.eth").kind, "agent");
  assert.equal(by("sub.bot.amy.dev.eng.acme.eth").type, "subagent");
  assert.equal(by("amy.dev.eng.acme.eth").label, "amy");

  // Every ancestor must allow a provider (claude is dropped at eng); the built-in test API isn't listed.
  assert.deepEqual(by("acme.eth").providers, ["codex", "claude"]);
  assert.deepEqual(by("dev.eng.acme.eth").providers, ["codex"]);
  // Missing bundle = no access below it.
  assert.deepEqual(toLiveNodes({ root: "acme.eth", raw: [raw("acme.eth", { bundle: null }), raw("x.acme.eth")], nowSec: NOW })[1].providers, []);

  assert.equal(by("old.dev.eng.acme.eth").status, "Revoked");
  assert.equal(by("gone.old.dev.eng.acme.eth").status, "Revoked");
  assert.equal(by("late.eng.acme.eth").status, "Expired");
  assert.equal(by("kid.late.eng.acme.eth").status, "Expired");

  // Descendants not removed: amy, bot, sub under dev; late + kid + dev subtree under eng.
  assert.equal(by("dev.eng.acme.eth").descendantCount, 3);
  assert.equal(by("eng.acme.eth").descendantCount, 6);
  assert.equal(by("acme.eth").descendantCount, 7);
  assert.equal(visibleNodes(nodes, "all").length, 8);

  assert.deepEqual(by("acme.eth").badges, ["you", "plan gold"]);
  assert.deepEqual(by("eng.acme.eth").badges, []);
  assert.deepEqual(by("bot.amy.dev.eng.acme.eth").badges, ["key in this browser"]);

  assert.equal(by("acme.eth").periodLabel, "Monthly (UTC)");
  assert.equal(by("amy.dev.eng.acme.eth").periodLabel, "Daily (UTC)");
  assert.equal(by("bot.amy.dev.eng.acme.eth").periodLabel, "Entire session");
  assert.equal(by("amy.dev.eng.acme.eth").expiry, (NOW + 86_400) * 1000);
  assert.equal(by("old.dev.eng.acme.eth").owner, ZERO);
});

test("toLiveNodes treats never-expiring names as no expiry", () => {
  const [root] = toLiveNodes({ root: "acme.eth", raw: [raw("acme.eth", { expiry: 2 ** 62 })], nowSec: NOW });
  assert.equal(root.expiry, null);
  assert.equal(root.status, "Active");
});

test("liveProviders covers the catalog with marks and key status", () => {
  const status = {
    root: "acme.eth",
    providers: [
      { id: "codex", label: "OpenAI Codex", configured: true, metered: true },
      { id: "claude", label: "Anthropic Claude", configured: false, metered: true },
      { id: "weather", label: "Weather (OpenWeatherMap)", configured: true, metered: false },
    ],
  } as unknown as StatusResponse;
  const providers = liveProviders(status);
  const by = (id: string) => providers.find((p) => p.id === id)!;
  assert.ok(providers.length >= 15);
  assert.equal(by("codex").statusText, "Relay key set");
  assert.equal(by("codex").configured, true);
  assert.equal(by("claude").statusText, "No key on the relay");
  assert.equal(by("claude").mark, "anthropic");
  assert.equal(by("openai-images").mark, "openai");
  assert.equal(by("openai-images").unit, "usd"); // priced per image, so dollar caps apply
  assert.equal(by("github").unit, "access");
  assert.equal(by("codex").unit, "usd");
  assert.equal(providers.find((p) => p.id === "mock"), undefined, "the built-in test API isn't listed");
  assert.equal(by("weather").statusText, "Relay key set"); // OPENWEATHER_API_KEY, like any other key
  assert.equal(by("weather").mark, "weather");
  assert.equal(by("weather").unit, "access"); // count caps only
  assert.equal(by("weather").configured, true);
  assert.equal(by("weather").description, "Current weather and forecasts by city: /data/2.5/weather?q=Tokyo&units=metric.");
  assert.equal(liveProviders({ ...status, providers: [] }).find((p) => p.id === "weather")!.statusText, "No key on the relay");
  assert.equal(providerMark("github"), "github");
  assert.equal(liveProviders(undefined).find((p) => p.id === "codex")!.statusText, "Relay not reached");
});

test("liveGrants shows limits, spend and parent blocks", () => {
  const nodes = toLiveNodes({ root: "acme.eth", raw: sampleTree(), nowSec: NOW });
  const lineage = lineageOf(nodes, "dev.eng.acme.eth");
  assert.deepEqual(
    lineage.map((l) => l.name),
    ["acme.eth", "eng.acme.eth", "dev.eng.acme.eth"],
  );
  const configured = (id: string) => (id === "codex" ? true : false);

  const hidden = liveGrants({ lineage, policyLevels: null, configured });
  assert.deepEqual(
    hidden.map((g) => [g.providerId, g.limitLabel, g.blockedByParent]),
    [
      ["claude", "No cap", true],
      ["codex", "No cap", false],
    ],
  );
  assert.equal(hidden[0].note, "No key on the relay · blocked by eng.acme.eth");
  assert.equal(hidden[1].usage, undefined);

  // With spend: eng caps codex at $20 and spent $15, so $5 is left for dev (which has no cap of its own).
  const eng = liveGrants({
    lineage: lineageOf(nodes, "eng.acme.eth"),
    policyLevels: [
      { name: "acme.eth", spent: { codex: 30 } },
      { name: "eng.acme.eth", spent: { codex: 15 } },
    ],
    configured,
  });
  const codex = eng.find((g) => g.providerId === "codex")!;
  assert.equal(codex.limitLabel, "$20.00");
  assert.deepEqual(codex.usage, { pct: 75, usedLabel: "$15.00", leftLabel: "$5.00" });
  assert.equal(codex.note, "Relay key set");
  assert.equal(eng.find((g) => g.providerId === "mock"), undefined, "the built-in test API isn't listed");

  // Over the cap: nothing left, and the reason says who stopped it.
  const spent = liveGrants({
    lineage: lineageOf(nodes, "eng.acme.eth"),
    policyLevels: [
      { name: "acme.eth", spent: { codex: 30 } },
      { name: "eng.acme.eth", spent: { codex: 25 } },
    ],
    configured,
  }).find((g) => g.providerId === "codex")!;
  assert.equal(spent.usage?.leftLabel, "$0.00");
  assert.equal(spent.usage?.pct, 100);
  assert.match(spent.note, /eng\.acme\.eth has used its codex cap/);

  // Count caps.
  const counted = liveGrants({
    lineage: [{ name: "acme.eth", bundle: bundle(["openai-images"], {}, { maxes: { "openai-images": 10 } }) }],
    policyLevels: [{ name: "acme.eth", spent: {}, used: { "openai-images": 4 } }],
    configured,
  })[0];
  assert.equal(counted.limitLabel, "10 images");
  assert.deepEqual(counted.usage, { pct: 40, usedLabel: "4 images", leftLabel: "6 images" });

  const unpriced = liveGrants({ lineage: [{ name: "acme.eth", bundle: bundle(["github"]) }], policyLevels: null, configured })[0];
  assert.equal(unpriced.limitLabel, "Allowed");
  assert.equal(unpriced.note, "No key on the relay");

  assert.deepEqual(liveGrants({ lineage: [{ name: "acme.eth", bundle: null }], policyLevels: null, configured }), []);
});

test("liveGrants: weather notes whether the relay holds its key and shows a request count", () => {
  const bundle = (keys: string[], maxes: Record<string, number> = {}): Bundle => ({ keys: keys as never, caps: {}, maxes, period: "month" });
  const lineage = [
    { name: "acme.eth", bundle: bundle(["weather", "codex"]) },
    { name: "derek.acme.eth", bundle: bundle(["weather"], { weather: 20 }) },
  ];
  const [weather] = liveGrants({
    lineage,
    policyLevels: [
      { name: "acme.eth", spent: {} },
      { name: "derek.acme.eth", spent: {}, used: { weather: 5 } },
    ],
    configured: (id) => (id === "weather" ? true : undefined),
  });
  assert.equal(weather.providerId, "weather");
  assert.equal(weather.note, "Relay key set");
  assert.deepEqual(weather.usage, { pct: 25, usedLabel: "5 requests", leftLabel: "15 requests" });
  const [noKey] = liveGrants({ lineage, policyLevels: null, configured: () => false });
  assert.equal(noKey.note, "No key on the relay · spend hidden");
});

test("liveMetrics and levelSpend", () => {
  const nodes = toLiveNodes({ root: "acme.eth", raw: sampleTree(), nowSec: NOW });
  const providers = liveProviders(undefined);
  const metrics = liveMetrics({ nodes, providers, providerIndex: indexProviders(providers), root: "acme.eth", rootSpend: 12.5, rootPeriod: "month" });
  assert.equal(metrics.activeIdentities, 6);
  assert.equal(metrics.identitiesCaption, "under acme.eth");
  assert.equal(metrics.usageLabel, "$12.50");
  assert.equal(metrics.usageCaption, "relay spend this month");
  assert.equal(metrics.agentSessions, 2);
  assert.equal(metrics.sessionsCaption, "includes 1 subagent");
  assert.deepEqual(
    metrics.featuredProviders.map((p) => p.id),
    ["codex", "claude", "github", "openai-images"],
  );
  assert.equal(liveMetrics({ nodes: [], providers, providerIndex: {}, root: null, rootSpend: null, rootPeriod: null }).usageLabel, "—");
  assert.equal(liveMetrics({ nodes: [], providers, providerIndex: {}, root: null, rootSpend: null, rootPeriod: null }).usageCaption, "relay spend (sign in to see)");
  assert.equal(
    liveMetrics({ nodes: [], providers, providerIndex: {}, root: null, rootSpend: null, rootPeriod: null, spendClosed: true }).usageCaption,
    "relay spend (admin only)",
  );
  assert.equal(levelSpend({ spent: { codex: 1.5, claude: 2 } }), 3.5);
  assert.equal(levelSpend(undefined), null);
});

test("activity merges relay decisions with local events, newest first", () => {
  const entry = (ts: number, over: Partial<LogEntry> = {}): LogEntry => ({
    ts,
    name: "bot.amy.dev.eng.acme.eth",
    provider: "codex",
    method: "POST",
    path: "/v1/responses",
    allowed: true,
    reason: null,
    status: 200,
    costUsd: 0.012,
    estimated: false,
    signer: null,
    ...over,
  });
  const row = logActivity(entry(1000), 0);
  assert.match(row.title, /^Allowed · /);
  assert.equal(row.detail, "bot.amy.dev.eng.acme.eth · POST /v1/responses · HTTP 200 · $0.012");
  assert.match(logActivity(entry(1, { allowed: false, reason: "killed: access revoked", status: null, costUsd: null }), 0).title, /^Cut off/);
  assert.match(logActivity(entry(1, { allowed: false, reason: "access revoked: x", costUsd: null }), 0).title, /^Revoked/);
  assert.match(logActivity(entry(1, { allowed: false, reason: "no bundle", costUsd: null }), 0).title, /^Refused/);

  const merged = mergeActivity([entry(3000), entry(1000)], [{ id: "local", at: 2000, title: "Saved", detail: "on Sepolia", time: "t" }]);
  assert.deepEqual(
    merged.map((r) => r.title.split(" ")[0]),
    ["Allowed", "Saved", "Allowed"],
  );
  assert.equal("at" in merged[1], false);
  assert.deepEqual(mergeActivity(undefined, []), []);
});

test("roleFor derives the connected wallet's place", () => {
  const nodes = toLiveNodes({ root: "acme.eth", raw: sampleTree(), nowSec: NOW });
  assert.equal(roleFor(undefined, nodes), "Connect a wallet");
  assert.equal(roleFor(OWNER, nodes), "Workspace owner");
  assert.equal(roleFor(LEAD, nodes), "Department lead");
  assert.equal(roleFor(AGENT, nodes), "Agent");
  assert.equal(roleFor(addr("d"), nodes), "Not in this workspace");
  // Names the tree didn't load come from /api/ens/owned.
  assert.equal(roleFor(addr("d"), nodes, [{ name: "x.y.dev.eng.acme.eth", depth: 5, expiry: null, hasSubregistry: false }]), "Subagent");
  assert.equal(roleFor(addr("d"), nodes, [{ name: "dev.eng.acme.eth", depth: 2, expiry: null, hasSubregistry: true }]), "Team lead");
});

test("initialsFor", () => {
  assert.equal(initialsFor("derek.eth", undefined), "DE");
  assert.equal(initialsFor(null, addr("a")), "AA");
  assert.equal(initialsFor(null, undefined), "—");
});
