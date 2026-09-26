// npm run verify:live: checks the live company on Sepolia (ENSv2) from on-chain values alone,
// in well under a minute, with nothing but Node and this repo (no keys, no env).
//
//   1. Live org        every name from the root down (org/<label>.json plus anything the live relay
//                      lists), its owner, expiry, limits and the relay's own per-level checks
//                      (lib/relay/ens.ts ViemChainReader.readLevels, the code the relay runs)
//   2. Limits          a member holds no role on the resolver that stores their limits (the admin's)
//   3. Reverts         a write to those limits, a self-grant, re-pointing the resolver and removing a
//                      teammate, each simulated from the member's address with eth_call: each reverts
//                      with an access-control error (and the admin's same write doesn't)
//   4. Alias           the relay's decide() (lib/relay/policy.ts) run here: the canonical path is
//                      allowed, the alias path (org/<label>.json "aliases") refused as not canonical
//
// Nothing is sent: every write is an eth_call. Flags: --root, --rpc (or RELAY_RPC_URL; default
// Tenderly's public gateway, then publicnode), --relay, --no-relay, --spec, --member. Reads go
// through Multicall3 with bounded parallelism, and every network call has a timeout.

import path from "node:path";
import { parseArgs } from "node:util";

import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  encodeFunctionData,
  fallback,
  http,
  isAddressEqual,
  parseAbi,
  parseAbiItem,
  zeroAddress,
} from "viem";
import { sepolia } from "viem/chains";

import { PermissionedResolverImplAbi } from "../lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "../lib/ens/abis/UserRegistryImpl";
import { textKeyResource } from "../lib/ens/access";
import { ENSV2_SEPOLIA } from "../lib/ens/deployments";
import { decodeEnsError } from "../lib/ens/errors";
import { PERMISSIONED_RESOLVER_IMPL, USER_REGISTRY_IMPL, VERIFIABLE_FACTORY } from "../lib/ens/factory";
import { ROOT_REGISTRY } from "../lib/ens/hierarchy";
import { dnsEncode, labelId, tryNormalize } from "../lib/ens/names";
import { REGISTRY_ROLE_TABLE, RESOLVER_ROLE_TABLE, ROOT_RESOURCE, RegistryRoles, ResolverRoles } from "../lib/ens/roles";
import { RECORD_KEYS, bundleRecordKeys } from "../lib/relay/bundle";
import { loadConfig } from "../lib/relay/config";
import { type ChainLevel, ETH_REGISTRY, TOKEN_NBF_KEY, UNIVERSAL_HELPER, ViemChainReader } from "../lib/relay/ens";
import type { Meter } from "../lib/relay/meter";
import { type PolicyDecision, decide } from "../lib/relay/policy";
import type { ChildrenResponse, LevelStatus, StatusResponse } from "../lib/relay/types";
import { DEFAULT_RPC_URL, TENDERLY_RPC_URL, readTexts, resolverAddress, shortError } from "./lib/ensv2";
import { type OrgSpec, flattenSpec, readSpec, specAliases, specPath } from "./lib/org-seed";
import {
  type NameKind,
  type Style,
  addressUrl,
  bitmapHex,
  describeBitmap,
  describeRevert,
  dnsDecode,
  formatChecks,
  formatElapsed,
  formatExpiry,
  formatLimits,
  formatRecords,
  isAccessDenied,
  kindByDepth,
  layoutTree,
  levelPasses,
  makeStyle,
  mapPool,
  pickMember,
  short,
  shortHex,
  tokenUrl,
  wantsColor,
  wrapParts,
} from "./lib/verify-live";

const DEFAULT_ROOT = "sodalabs.eth";
const DEFAULT_RELAY = "https://relay.derek2403.win";
/**
 * Time the relay may take, in all, to list children (its /api/ens/children shares one rate limit
 * with every visitor); per depth it gets at most RELAY_DEPTH_MS. What it hasn't listed by then is
 * read from the registries' logs (one eth_getLogs per depth).
 */
const RELAY_BUDGET_MS = 6_000;
const RELAY_DEPTH_MS = 3_000;
/** A run that hangs past this is stopped (the goal is well under a minute). */
const HARD_LIMIT_MS = 110_000;
/** The provider the checks below use (every seeded member may use it). */
const PROVIDER = "codex";

const started = performance.now();
const s: Style = makeStyle(wantsColor(process.stdout, process.env));
const width = Math.max(80, Math.min(process.stdout.columns || 120, 160));
const say = (line = "") => console.log(line);
let failures = 0;
/** ✓ when `ok`, else ✗ (and the run exits 1). */
const mark = (ok: boolean) => {
  if (!ok) failures++;
  return ok ? s.ok : s.bad;
};
const heading = (n: number, title: string) => say(`\n${s.bold(`${n}. ${title}`)}`);
const note = (text: string, indent = "   ") => say(`${indent}${s.dim(text)}`);

const HELP = `npm run verify:live [-- options]
Reads the live company on Sepolia ENSv2 and checks it the way the relay does. Sends nothing.

  --root <name>     Company root (default ${DEFAULT_ROOT})
  --rpc <url>       Sepolia RPC (default RELAY_RPC_URL, else ${TENDERLY_RPC_URL}; needs wide eth_getLogs
                    only when the relay can't list names)
  --relay <url>     Live relay used to list names added after seeding (default ${DEFAULT_RELAY})
  --no-relay        Don't ask the relay; list names from the registries' logs
  --spec <file>     Org spec (default org/<label>.json)
  --member <name>   Member whose limits sections 2 and 3 try to raise`;

type Opts = { root?: string; rpc?: string; relay?: string; "no-relay"?: boolean; spec?: string; member?: string; help?: boolean };

function options(): Opts {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        root: { type: "string" },
        rpc: { type: "string" },
        relay: { type: "string" },
        "no-relay": { type: "boolean" },
        spec: { type: "string" },
        member: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }).values as Opts;
  } catch (err) {
    throw new Error(`${(err as Error).message} (see npm run verify:live -- --help)`);
  }
}

// --- ABIs --------------------------------------------------------------------------------------------

const registryAbi = parseAbi([
  "function getTokenId(uint256 anyId) view returns (uint256)",
  "function getSubregistry(string label) view returns (address)",
  "function getParent() view returns (address parent, string label)",
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
  "function roles(uint256 anyId, address account) view returns (uint256)",
  "function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)",
]);
const resolverAbi = parseAbi([
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function decodeSetter(bytes setter) view returns (bytes arg, uint256 resource, uint256 roleBitmap)",
]);
const helperAbi = parseAbi([
  "function findRegistries(bytes name) view returns (address[])",
  "function findCanonicalName(address registry) view returns (bytes)",
]);
const LABEL_EVENTS = [
  parseAbiItem("event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)"),
  parseAbiItem("event LabelReserved(uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender)"),
] as const;

type Read = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

/** Many view calls in one Multicall3 round trip; a failed call is null. */
async function readAll(pub: PublicClient, calls: Read[]): Promise<unknown[]> {
  if (!calls.length) return [];
  const out = (await pub.multicall({ contracts: calls, allowFailure: true, batchSize: 8_192 } as never)) as { status: string; result?: unknown }[];
  return out.map((r) => (r.status === "success" ? r.result : null));
}

// --- Discovery: the spec's names plus what the relay (or the registries' logs) lists ---------------------

type Listed = { name: string; label: string; parent: string; status: LevelStatus; subregistry: Address | null };

type TreeNode = {
  name: string;
  label: string;
  parent: string | null;
  kind: NameKind;
  inSpec: boolean;
  /** Found registered on chain (relay listing or logs). */
  listed: boolean;
  /** For an alias: the name whose registry it shares. */
  aliasOf: string | null;
  children: string[];
};

type Discovery = {
  tree: Map<string, TreeNode>;
  relayLevels: number;
  logLevels: number;
  notes: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** GET a relay JSON endpoint, waiting out 429/503 (briefly) until `deadline`. */
async function relayGet<T>(url: string, deadline: number): Promise<T | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const left = deadline - Date.now();
    if (left < 400) return null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(8_000, left)), headers: { accept: "application/json" } });
      if (res.ok) return (await res.json()) as T;
      if (res.status !== 429 && res.status !== 503) return null;
      await res.body?.cancel().catch(() => {});
      // The children endpoint shares one rate limit with every visitor: wait a moment, not the full retry-after.
      await sleep(Math.min(Number(res.headers.get("retry-after")) * 1000 || 1000, 1200 + Math.random() * 600, deadline - Date.now() - 400));
    } catch {
      return null;
    }
  }
  return null;
}

/** Labels registered in each registry, from its LabelRegistered/LabelReserved events, with their current state. */
async function listFromLogs(pub: PublicClient, parents: { name: string; registry: Address }[]): Promise<Map<string, Listed[]>> {
  const logs = await pub.getLogs({
    address: parents.map((p) => p.registry),
    events: LABEL_EVENTS,
    fromBlock: ENSV2_SEPOLIA.RootRegistry.deployBlock,
    toBlock: "latest",
  });
  const labels = new Map<string, Set<string>>();
  for (const log of logs) {
    const label = (log.args as { label?: string }).label;
    if (typeof label !== "string") continue;
    const key = log.address.toLowerCase();
    if (!labels.has(key)) labels.set(key, new Set());
    labels.get(key)!.add(label);
  }
  const rows = parents.flatMap((p) => [...(labels.get(p.registry.toLowerCase()) ?? [])].map((label) => ({ parent: p, label })));
  const reads = await readAll(
    pub,
    rows.flatMap(({ parent, label }) => [
      { address: parent.registry, abi: registryAbi, functionName: "getState", args: [labelId(label)] },
      { address: parent.registry, abi: registryAbi, functionName: "getSubregistry", args: [label] },
    ]),
  );
  const out = new Map<string, Listed[]>(parents.map((p) => [p.name, []]));
  rows.forEach(({ parent, label }, i) => {
    const state = reads[i * 2] as { status: number } | null;
    const sub = reads[i * 2 + 1] as Address | null;
    out.get(parent.name)!.push({
      name: `${label}.${parent.name}`,
      label,
      parent: parent.name,
      status: state ? (state.status === 2 ? "registered" : state.status === 1 ? "reserved" : "available") : "missing",
      subregistry: sub && !isAddressEqual(sub, zeroAddress) ? sub : null,
    });
  });
  return out;
}

/**
 * Walks the tree breadth first. Each level's children come from the relay's GET /api/ens/children
 * (the listing its portal uses) while the relay answers within its budget, else from the
 * registries' logs (one eth_getLogs per depth). A listed name whose registry points back at
 * another name is an alias: noted, not walked (its names are the other name's).
 */
async function discover(pub: PublicClient, root: string, spec: OrgSpec | null, relay: string | null): Promise<Discovery> {
  const d: Discovery = { tree: new Map(), relayLevels: 0, logLevels: 0, notes: [] };
  const add = (n: Omit<TreeNode, "children">) => {
    if (d.tree.has(n.name)) return;
    d.tree.set(n.name, { ...n, children: [] });
    if (n.parent) d.tree.get(n.parent)?.children.push(n.name);
  };
  // The spec first, so its order is the tree's order.
  if (spec) {
    for (const n of flattenSpec(spec)) add({ name: n.name, label: n.label, parent: n.parent, kind: n.kind, inSpec: true, listed: false, aliasOf: null });
    for (const a of specAliases(spec)) add({ name: a.name, label: a.label, parent: a.parent, kind: "alias", inSpec: true, listed: false, aliasOf: a.target });
  } else {
    add({ name: root, label: root.split(".")[0], parent: null, kind: "company", inSpec: false, listed: false, aliasOf: null });
  }
  const specAliasNames = new Set(spec ? specAliases(spec).map((a) => a.name) : []);

  const [rootLabel] = root.split(".");
  const rootRegistry = root.endsWith(".eth") && root.split(".").length === 2 ? ETH_REGISTRY : null;
  const [rootSub] = rootRegistry ? ((await readAll(pub, [{ address: rootRegistry, abi: registryAbi, functionName: "getSubregistry", args: [rootLabel] }])) as (Address | null)[]) : [null];

  let frontier: { name: string; registry: Address | null }[] = [{ name: root, registry: rootSub }];
  const relayDeadline = Date.now() + RELAY_BUDGET_MS;
  let relayGaveUp = !relay;
  for (let depth = 0; frontier.length && depth < 8; depth++) {
    const answers = new Map<string, Listed[]>();
    if (!relayGaveUp) {
      const depthDeadline = Math.min(relayDeadline, Date.now() + RELAY_DEPTH_MS);
      const got = await mapPool(frontier, 3, (f) => relayGet<ChildrenResponse>(`${relay}/api/ens/children?name=${encodeURIComponent(f.name)}`, depthDeadline));
      got.forEach((body, i) => {
        if (!body || !Array.isArray(body.children)) return;
        d.relayLevels++;
        const parent = frontier[i].name;
        answers.set(
          parent,
          body.children.map((c) => ({ name: c.name, label: c.label, parent, status: c.status, subregistry: c.subregistry })),
        );
      });
      if (Date.now() >= relayDeadline - 400) relayGaveUp = true;
    }
    const rest = frontier.filter((f) => !answers.has(f.name) && f.registry) as { name: string; registry: Address }[];
    if (rest.length) {
      try {
        for (const [name, kids] of await listFromLogs(pub, rest)) answers.set(name, kids);
        d.logLevels += rest.length;
      } catch (err) {
        d.notes.push(`couldn't read the registry logs for ${rest.map((r) => r.name).join(", ")} (${shortError(err)}): only the spec's names are shown there`);
      }
    }

    const walkable: Listed[] = [];
    for (const kids of answers.values()) {
      for (const k of kids) {
        if (k.status !== "registered") continue;
        const existing = d.tree.get(k.name);
        if (existing) existing.listed = true;
        else add({ name: k.name, label: k.label, parent: k.parent, kind: kindByDepth(k.name, root), inSpec: false, listed: true, aliasOf: null });
        if (k.subregistry) walkable.push(k);
      }
    }
    // A registry that points back at another name makes this one an alias of it: don't walk it twice.
    const canonical = (await readAll(
      pub,
      walkable.map((k) => ({ address: UNIVERSAL_HELPER, abi: helperAbi, functionName: "findCanonicalName", args: [k.subregistry!] })),
    )) as (Hex | null)[];
    frontier = [];
    walkable.forEach((k, i) => {
      const node = d.tree.get(k.name)!;
      const points = canonical[i] ? dnsDecode(canonical[i]!) : "";
      if (specAliasNames.has(k.name) || (points && points !== k.name)) {
        node.kind = "alias";
        node.aliasOf ??= points || null;
        return;
      }
      frontier.push({ name: k.name, registry: k.subregistry });
    });
  }
  if (relay && !d.relayLevels) d.notes.push(`the relay at ${relay} didn't list any level in time; names were read from the registries' logs`);
  return d;
}

// --- Eth_call simulations ----------------------------------------------------------------------------

type Sim = { reverted: false } | { reverted: true; error: { name: string; args?: readonly unknown[] } | null; text: string };

/** Revert data anywhere on a viem error's cause chain. */
function revertData(err: unknown): Hex | null {
  for (let e = err as { data?: unknown; raw?: unknown; cause?: unknown } | undefined, i = 0; e && i < 8; e = e.cause as typeof e, i++) {
    for (const v of [e.raw, e.data]) if (typeof v === "string" && v.startsWith("0x") && v.length >= 10) return v as Hex;
  }
  return null;
}

/** eth_call of `data` on `to` from `from`: nothing is signed or sent. */
async function simulate(pub: PublicClient, from: Address, to: Address, data: Hex): Promise<Sim> {
  try {
    await pub.call({ account: from, to, data });
    return { reverted: false };
  } catch (err) {
    const raw = revertData(err);
    const decoded = raw ? decodeEnsError(raw) : null;
    if (!raw && !/revert/i.test(shortError(err))) throw err; // an RPC failure, not a revert
    return { reverted: true, error: decoded, text: decoded?.message ?? shortError(err) };
  }
}

// --- The run -------------------------------------------------------------------------------------------

async function main() {
  const opts = options();
  if (opts.help) return say(HELP);
  const root = tryNormalize(opts.root ?? DEFAULT_ROOT);
  if (!root || !root.includes(".")) throw new Error(`--root "${opts.root}" is not an ENS name like ${DEFAULT_ROOT}`);
  const chosen = opts.rpc?.trim() || process.env.RELAY_RPC_URL?.trim() || "";
  // The default is Tenderly's public gateway (wide eth_getLogs), with publicnode behind it when it rate-limits.
  const rpcs = chosen ? [chosen] : [TENDERLY_RPC_URL, DEFAULT_RPC_URL];
  const rpc = rpcs[0];
  const relay = opts["no-relay"] ? null : (opts.relay?.trim() || DEFAULT_RELAY).replace(/\/+$/, "").replace(/\/api\/relay$/, "");
  const specFile = opts.spec ?? specPath(root.split(".")[0]);
  let spec: OrgSpec | null = null;
  try {
    spec = readSpec(specFile);
  } catch (err) {
    say(`${s.bad} ${specFile}: ${(err as Error).message}`);
  }
  if (spec && `${spec.label}.eth` !== root) spec = null;

  say(s.bold(`Keyless Relay: live check of ${root} on Sepolia (ENSv2)`));
  note(`rpc ${rpc}${rpcs.length > 1 ? ` (then ${rpcs.slice(1).join(", ")})` : ""} · relay ${relay ?? "off (--no-relay)"} · spec ${spec ? path.relative(process.cwd(), specFile) || specFile : "none"}`, "");
  note("Every value below is read from the chain now; every write is an eth_call simulation. Nothing is signed or sent.", "");

  const transports = rpcs.map((url) => http(url, { timeout: 15_000, retryCount: 2 }));
  const client = createPublicClient({ chain: sepolia, transport: transports.length > 1 ? fallback(transports) : transports[0] }) as PublicClient;
  // The relay's own reader (lib/relay/ens.ts), on the same RPC.
  const reader = new ViemChainReader(client);
  const [chainId, status] = await Promise.all([
    client.getChainId().catch((err) => {
      throw new Error(`can't reach the RPC ${rpc}: ${shortError(err)}`);
    }),
    relay ? relayGet<StatusResponse>(`${relay}/api/relay/status`, Date.now() + 6_000) : Promise.resolve(null),
  ]);
  if (chainId !== sepolia.id) throw new Error(`${rpc} serves chain ${chainId}, not Sepolia (${sepolia.id})`);
  const relayRoot = status?.root ?? null;
  if (relay) {
    note(
      status
        ? `live relay: root ${relayRoot}${relayRoot === root ? "" : ` (not ${root}: its settings aren't used below)`} · RELAY_ROOT_OWNER ${status.rootOwner ?? "not pinned"} · canonical names required: ${status.requireCanonical ? "yes" : "no"}`
        : `the relay didn't answer /api/relay/status; its settings aren't shown (the checks below don't need it)`,
      "",
    );
  }
  const now = Math.floor(Date.now() / 1000);

  // --- 1. Live org ---
  heading(1, "Live org");
  const t1 = performance.now();
  const levelOf = new Map<string, ChainLevel>();
  const readFailures = new Map<string, string>();
  /** readLevels on each name (deepest first), skipping names an earlier read already returned: each read returns every level above too. */
  const readNames = (names: string[]) =>
    mapPool([...names].sort((a, b) => b.split(".").length - a.split(".").length), 6, async (name) => {
      if (levelOf.has(name)) return;
      try {
        for (const l of await reader.readLevels(root, name)) if (!levelOf.has(l.name)) levelOf.set(l.name, l);
        readFailures.delete(name);
      } catch (err) {
        readFailures.set(name, shortError(err));
      }
    });
  // The spec's names are read while the tree is being listed; names found live are read after.
  const specNames = spec ? [...flattenSpec(spec).filter((n) => !n.children.length).map((n) => n.name), ...specAliases(spec).map((a) => a.name)] : [root];
  const [found] = await Promise.all([discover(client, root, spec, relay), readNames(specNames)]);
  const { tree } = found;
  await readNames([...tree.keys()]);
  const named = [...tree.values()].map((n) => ({ n, l: levelOf.get(n.name) })).filter((x): x is { n: TreeNode; l: ChainLevel } => !!x.l && !!x.l.registry);
  const tokens = (await readAll(
    client,
    named.map(({ n, l }) => ({ address: l.registry!, abi: registryAbi, functionName: "getTokenId", args: [labelId(n.label)] })),
  )) as (bigint | null)[];
  const tokenOf = new Map(named.map(({ n }, i) => [n.name, tokens[i]]));
  const rootOwner = levelOf.get(root)?.owner ?? null;

  const specCount = [...tree.values()].filter((n) => n.inSpec).length;
  const extra = [...tree.values()].filter((n) => !n.inSpec);
  const sources = [
    found.relayLevels ? `${found.relayLevels} from the relay's /api/ens/children` : null,
    found.logLevels ? `${found.logLevels} from registry logs${relay ? " (the relay didn't answer those in time)" : ""}` : null,
  ].filter(Boolean);
  note(
    `${tree.size} names: ${
      spec
        ? `${specCount} in the spec${extra.length ? `, ${extra.length} more added live (${extra.map((n) => n.name).join(", ")})` : ", none added live"}`
        : `all found on chain (no org spec for ${root})`
    } · read in ${formatElapsed(performance.now() - t1)}`,
  );
  note(`subname lists of ${found.relayLevels + found.logLevels} levels: ${sources.join(", ") || "none"}`);
  for (const n of found.notes) note(`! ${n}`);
  for (const [name, why] of readFailures) say(`   ${mark(false)} couldn't read ${name}: ${why}`);
  say(
    s.dim(
      `   Checks per name, as lib/relay/ens.ts readLevels makes them: registered = getState().status is 2 in the registry holding it;\n` +
        `   UserRegistry / PermissionedResolver proxy = VerifiableFactory ${short(VERIFIABLE_FACTORY)}.verifyContract() returns ${short(USER_REGISTRY_IMPL)} / ${short(PERMISSIONED_RESOLVER_IMPL)};\n` +
        `   canonical = UniversalHelper.findCanonicalName(registry) is the parent's name. Limits = the relay.* text records on the resolver of\n` +
        `   the name's entry, i.e. the level above's resolver, parsed with parseBundle.`,
    ),
  );
  say("");
  const coreRegistry = (a: string) => (isAddressEqual(a as Address, ETH_REGISTRY) ? "ETHRegistry" : isAddressEqual(a as Address, ROOT_REGISTRY) ? "RootRegistry" : null);
  let passing = 0;
  let checked = 0;
  for (const row of layoutTree(root, (name) => tree.get(name)?.children ?? [])) {
    const n = tree.get(row.name)!;
    const l = levelOf.get(n.name);
    const tag = [n.kind, spec && !n.inSpec ? "added live" : null, n.aliasOf ? `of ${n.aliasOf}` : null].filter(Boolean).join(" · ");
    // A spec alias that isn't registered yet is pending (section 4), not a failure.
    const pending = n.kind === "alias" && l?.status !== "registered";
    const pass = !!l && levelPasses(l);
    if (!pending) {
      checked++;
      if (pass) passing++;
    }
    const icon = pending ? s.na : pass ? s.ok : s.bad;
    say(`${row.head}${icon} ${s.bold(n.name)}  ${s.dim(tag)}${l && !pending ? `  ${formatExpiry(l.expiry, now)}` : ""}`);
    const line = (label: string, text: string) => say(`${row.body}${s.dim(label.padEnd(7))}${text}`);
    if (!l) {
      line("", "couldn't be read");
      continue;
    }
    if (pending) {
      line("", `not on chain yet (the spec lists it; npm run org:seed adds it)`);
      continue;
    }
    if (l.owner) line("owner", `${short(l.owner)}${rootOwner && isAddressEqual(l.owner, rootOwner) ? " (admin)" : ""}  ${s.dim(addressUrl(l.owner))}`);
    const token = tokenOf.get(n.name);
    if (l.registry && token && l.status === "registered") line("token", s.dim(tokenUrl(l.registry, token)));
    const limits = n.kind === "alias" ? [`shares ${n.aliasOf}'s registry ${l.subregistry ? short(l.subregistry) : "?"}; no limits of its own`] : wrapParts(formatLimits(l.bundle).split(" · "), width - row.body.length - 8);
    limits.forEach((text, i) => line(i ? "" : "limits", text));
    line("checks", formatChecks(l, s, coreRegistry));
  }
  say(`\n   ${mark(passing === checked)} ${passing} of ${checked} names pass every check the relay makes${passing === checked ? "" : " (✗ above)"}`);

  // Sections 2-4 read in parallel while nothing else is printed.
  const memberPick = pickMember(
    [...tree.values()].map((n) => ({ name: n.name, kind: n.kind, registered: levelOf.get(n.name)?.status === "registered" })),
    root,
    opts.member ? tryNormalize(opts.member) : null,
  );
  // A section whose reads fail says so and the run goes on.
  const settle = <T>(p: Promise<T>) => p.then((value) => ({ value, error: null }), (err: unknown) => ({ value: null, error: shortError(err) }));
  const [member, alias] = await Promise.all([
    settle(memberPick ? memberEvidence(client, reader, root, memberPick.name, tree, levelOf, tokenOf) : Promise.resolve(null)),
    settle(aliasEvidence(client, reader, root, spec, tree, levelOf, status?.root === root ? (status.rootOwner ?? null) : null)),
  ]);

  // --- 2. A member can't raise his own limits ---
  heading(2, "A member can't raise his own limits");
  if (member.error) say(`   ${mark(false)} couldn't read ${memberPick?.name}'s roles: ${member.error} (try again, or another --rpc)`);
  else if (!memberPick || !member.value) say(`   ${mark(false)} no registered member to test${memberPick ? ` (${memberPick.name} isn't registered)` : ""}`);
  else printMember(member.value, memberPick.why);

  // --- 3. A forbidden write reverts ---
  heading(3, "A forbidden write reverts (eth_call from the member's address: no signature, nothing sent)");
  if (!member.value) say(`   ${mark(false)} skipped: no member${member.error ? " (section 2 couldn't be read)" : ""}`);
  else printSims(member.value);

  // --- 4. An alias is refused ---
  heading(4, "An alias is refused");
  if (alias.error || !alias.value) say(`   ${mark(false)} couldn't read the alias evidence: ${alias.error} (try again, or another --rpc)`);
  else printAlias(alias.value);

  // --- Footer ---
  const elapsed = formatElapsed(performance.now() - started);
  say(`\n${s.bold(failures ? `${s.bad} ${failures} check${failures === 1 ? "" : "s"} failed` : `${s.ok} Every check passed`)} in ${elapsed}.`);
  say("Nothing was sent: every write above was an eth_call simulation.");
  note(`Re-run: npm run verify:live -- --root <name>.eth --rpc <sepolia rpc url> --relay <relay url> --member <name> (or --no-relay)`, "");
  process.exitCode = failures ? 1 : 0;
}

// --- 2 and 3: the member --------------------------------------------------------------------------------

type MemberFacts = Awaited<ReturnType<typeof memberEvidence>>;

async function memberEvidence(
  pub: PublicClient,
  reader: ViemChainReader,
  root: string,
  name: string,
  tree: Map<string, TreeNode>,
  levelOf: Map<string, ChainLevel>,
  tokenOf: Map<string, bigint | null>,
) {
  // A --member outside the tree is read on its own.
  const levels = levelOf.has(name) ? null : await reader.readLevels(root, name).catch(() => null);
  const level = levelOf.get(name) ?? levels?.at(-1) ?? null;
  const parentName = name.slice(name.indexOf(".") + 1);
  const team = levelOf.get(parentName) ?? levels?.at(-2) ?? null;
  if (!level || level.status !== "registered" || !level.owner || !level.registry || !level.resolver || !team?.owner) return null;
  const memberAddr = level.owner;
  const admin = team.owner;
  const resolver = level.resolver;
  const registry = level.registry;
  const [label] = name.split(".");
  // A sibling to try to remove: another registered name in the same registry (a seeded one first).
  const siblings = (tree.get(parentName)?.children ?? []).filter((c) => c !== name && levelOf.get(c)?.status === "registered" && tree.get(c)?.kind !== "alias");
  const sibling = siblings.find((c) => tree.get(c)?.inSpec) ?? siblings[0] ?? null;

  const keys = [...bundleRecordKeys(), TOKEN_NBF_KEY];
  const capKey = RECORD_KEYS.cap(PROVIDER);
  const setText = encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dnsEncode(name), capKey, "1000000"] });
  const [adminResolver, ownResolver, texts, reads] = await Promise.all([
    resolverAddress(pub, admin),
    resolverAddress(pub, memberAddr),
    readTexts(pub, resolver, name, keys),
    readAll(pub, [
      { address: resolver, abi: resolverAbi, functionName: "hasRootRoles", args: [ResolverRoles.ROLE_SET_TEXT, admin] },
      { address: resolver, abi: resolverAbi, functionName: "roles", args: [ROOT_RESOURCE, admin] },
      { address: resolver, abi: resolverAbi, functionName: "hasRootRoles", args: [ResolverRoles.ROLE_SET_TEXT, memberAddr] },
      { address: resolver, abi: resolverAbi, functionName: "roles", args: [ROOT_RESOURCE, memberAddr] },
      { address: resolver, abi: resolverAbi, functionName: "decodeSetter", args: [setText] },
      { address: registry, abi: registryAbi, functionName: "getState", args: [labelId(label)] },
      { address: registry, abi: registryAbi, functionName: "roles", args: [ROOT_RESOURCE, memberAddr] },
      ...keys.flatMap((k) => [
        { address: resolver, abi: resolverAbi, functionName: "roles", args: [textKeyResource(k), memberAddr] },
        { address: resolver, abi: resolverAbi, functionName: "hasRoles", args: [textKeyResource(k), ResolverRoles.ROLE_SET_TEXT, memberAddr] },
      ]),
    ]),
  ]);
  const [adminCanWrite, adminRoot, memberCanWriteRoot, memberRoot, setter, state, memberRegistryRoot, ...perKey] = reads as [
    boolean | null,
    bigint | null,
    boolean | null,
    bigint | null,
    readonly [Hex, bigint, bigint] | null,
    { tokenId: bigint; resource: bigint } | null,
    bigint | null,
    ...unknown[],
  ];
  const tokenId = state?.tokenId ?? tokenOf.get(name) ?? null;
  const resource = state?.resource ?? null;
  const [tokenRoles, canSetResolver] = resource !== null && tokenId !== null
    ? ((await readAll(pub, [
        { address: registry, abi: registryAbi, functionName: "roles", args: [resource, memberAddr] },
        { address: registry, abi: registryAbi, functionName: "hasRoles", args: [tokenId, RegistryRoles.ROLE_SET_RESOLVER, memberAddr] },
      ])) as [bigint | null, boolean | null])
    : [null, null];
  const keyRoles = keys.map((k, i) => ({ key: k, resource: textKeyResource(k), roles: perKey[i * 2] as bigint | null, can: perKey[i * 2 + 1] as boolean | null }));

  // --- 3: the simulations (all eth_call) ---
  const siblingToken = sibling ? tokenOf.get(sibling) ?? null : null;
  const sims = await Promise.all([
    simulate(pub, memberAddr, resolver, setText),
    simulate(pub, memberAddr, resolver, encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "grantRootRoles", args: [ResolverRoles.ROLE_SET_TEXT, memberAddr] })),
    tokenId !== null
      ? simulate(pub, memberAddr, registry, encodeFunctionData({ abi: UserRegistryImplAbi, functionName: "setResolver", args: [tokenId, ownResolver] }))
      : Promise.resolve(null),
    siblingToken !== null
      ? simulate(pub, memberAddr, registry, encodeFunctionData({ abi: UserRegistryImplAbi, functionName: "unregister", args: [siblingToken] }))
      : Promise.resolve(null),
    simulate(pub, admin, resolver, setText),
  ]);

  return {
    name,
    parentName,
    label,
    member: memberAddr,
    admin,
    resolver,
    registry,
    team,
    level,
    adminResolver,
    ownResolver,
    texts,
    adminCanWrite,
    adminRoot,
    memberCanWriteRoot,
    memberRoot,
    setter,
    capKey,
    tokenId,
    resource,
    memberRegistryRoot,
    tokenRoles,
    canSetResolver,
    keyRoles,
    sibling,
    siblingResource: sibling ? (levelOf.get(sibling)?.resource ?? null) : null,
    sims: { setText: sims[0], selfGrant: sims[1], setResolver: sims[2], unregister: sims[3], adminSetText: sims[4] },
  };
}

function printMember(m: NonNullable<MemberFacts>, why: string) {
  say(`   member   ${s.bold(m.name)}  ${s.dim(`(${why})`)}`);
  say(`            owner ${m.member}  ${s.dim(addressUrl(m.member))}`);
  say(`   admin    ${m.admin} owns ${m.parentName}  ${s.dim(addressUrl(m.admin))}`);
  say(`   limits   ${formatLimits(m.level.bundle)}`);
  for (const line of wrapParts(formatRecords(m.texts), width - 12, "  ")) note(line, "            ");
  say(`   stored   on resolver ${m.resolver}: getResolver("${m.label}") in ${m.parentName}'s registry ${short(m.registry)}  ${s.dim(addressUrl(m.resolver))}`);

  const isAdmins = isAddressEqual(m.resolver, m.adminResolver);
  const teamToo = !!m.team.resolver && isAddressEqual(m.team.resolver, m.resolver);
  say(
    `   ${mark(isAdmins)} it is the admin's resolver: the Verifiable Factory address of ${short(m.admin)}'s own PermissionedResolver is ${m.adminResolver}` +
      `${teamToo ? `, and ${m.parentName}'s entry uses it too` : ""}`,
  );
  say(`   ${mark(m.adminCanWrite === true)} the admin can write it: hasRootRoles(ROLE_SET_TEXT, admin) = ${m.adminCanWrite} · roles(ROOT_RESOURCE, admin) = ${m.adminRoot === null ? "?" : describeBitmap(m.adminRoot, RESOLVER_ROLE_TABLE)}`);
  const setterOk = !!m.setter && m.setter[1] === textKeyResource(m.capKey) && m.setter[2] === ResolverRoles.ROLE_SET_TEXT;
  say(
    `   ${mark(setterOk)} what a write needs, per the resolver itself: decodeSetter(setText(${m.label}, "${m.capKey}", …)) = resource ${m.setter ? shortHex(m.setter[1]) : "?"}` +
      ` (keccak256("${m.capKey}")), roleBitmap ${m.setter ? bitmapHex(m.setter[2]) : "?"} (ROLE_SET_TEXT): held on that key's resource or on ROOT_RESOURCE; there is no per-name resource`,
  );
  say(`   ${mark(m.memberRoot === 0n && m.memberCanWriteRoot === false)} ${m.label} holds nothing on it at the root: roles(ROOT_RESOURCE, ${m.label}) = ${m.memberRoot === null ? "?" : bitmapHex(m.memberRoot)} · hasRootRoles(ROLE_SET_TEXT, ${m.label}) = ${m.memberCanWriteRoot}`);
  const cap = m.keyRoles.find((k) => k.key === m.capKey)!;
  const held = m.keyRoles.filter((k) => k.roles !== 0n || k.can !== false);
  say(`   ${mark(cap.roles === 0n && cap.can === false)} …nor on that limit's key: roles(resource("${m.capKey}"), ${m.label}) = ${cap.roles === null ? "?" : bitmapHex(cap.roles)} · hasRoles(…, ROLE_SET_TEXT, ${m.label}) = ${cap.can}`);
  say(
    `   ${mark(!held.length)} …nor on any of the ${m.keyRoles.length} relay.* keys the relay reads (relay.keys, relay.period, relay.cap.*, relay.max.*, relay.nbf): ` +
      (held.length ? `holds ${held.map((k) => `${k.key}=${k.roles === null ? "?" : bitmapHex(k.roles)}`).join(", ")}` : `every roles() = 0x0, every hasRoles(ROLE_SET_TEXT) = false`),
  );
  say(
    `   ${mark(m.canSetResolver === false && m.memberRegistryRoot === 0n)} nor point the name at a resolver of the member's own: in ${m.parentName}'s registry, roles(token resource, ${m.label}) = ` +
      `${m.tokenRoles === null ? "?" : describeBitmap(m.tokenRoles, REGISTRY_ROLE_TABLE)} · hasRoles(token, ROLE_SET_RESOLVER, ${m.label}) = ${m.canSetResolver} · root roles ${m.memberRegistryRoot === null ? "?" : bitmapHex(m.memberRegistryRoot)}`,
  );
}

function printSims(m: NonNullable<MemberFacts>) {
  const resources = new Map<bigint, string>([[textKeyResource(m.capKey), `resource("${m.capKey}")`]]);
  if (m.resource !== null) resources.set(m.resource, `${m.label}'s token resource`);
  if (m.sibling && m.siblingResource) resources.set(BigInt(m.siblingResource), `${m.sibling.split(".")[0]}'s token resource`);
  const accounts = new Map([
    [m.member.toLowerCase(), m.label],
    [m.admin.toLowerCase(), "admin"],
  ]);
  const show = (title: string, sim: Sim | null, table = RESOLVER_ROLE_TABLE, why = "") => {
    if (!sim) return say(`   ${s.na} ${title}: skipped${why ? ` (${why})` : ""}`);
    const denied = sim.reverted && isAccessDenied(sim.error?.name);
    say(`   ${mark(denied)} ${title}`);
    if (!sim.reverted) return say(`       ${s.red("did NOT revert")}`);
    say(`       reverted: ${sim.error ? describeRevert(sim.error, { table, resources, accounts }) : sim.text}`);
  };
  show(`setText("${m.name}", "${m.capKey}", "1000000") on the resolver ${short(m.resolver)}, from ${m.label} ${short(m.member)}`, m.sims.setText);
  show(`grantRootRoles(ROLE_SET_TEXT, ${m.label}) on the same resolver, from ${m.label} (grant the role to ${m.label})`, m.sims.selfGrant);
  show(
    `setResolver(${m.label}'s token, ${m.label}'s own resolver ${short(m.ownResolver)}) on ${m.parentName}'s registry, from ${m.label} (move the limits somewhere ${m.label} can write)`,
    m.sims.setResolver,
    REGISTRY_ROLE_TABLE,
    "token id unknown",
  );
  show(
    m.sibling ? `unregister(${m.sibling.split(".")[0]}'s token) on ${m.parentName}'s registry, from ${m.label} (remove a teammate)` : "unregister a teammate",
    m.sims.unregister,
    REGISTRY_ROLE_TABLE,
    "no other registered member in the team",
  );
  const control = m.sims.adminSetText;
  say(`   ${mark(!control.reverted)} control: the same setText from the admin ${short(m.admin)} ${control.reverted ? `reverted too (${control.text})` : "succeeds (eth_call returned; not sent)"}`);
}

// --- 4: the alias ------------------------------------------------------------------------------------------

type AliasFacts = Awaited<ReturnType<typeof aliasEvidence>>;

/** A no-op meter: decide() only reads spend and counts, and this run can't see the relay's. */
const NO_SPEND = { spent: () => 0, pending: () => 0, used: () => 0, pendingCount: () => 0 } satisfies Pick<Meter, "spent" | "pending" | "used" | "pendingCount">;

async function aliasEvidence(
  pub: PublicClient,
  reader: ViemChainReader,
  root: string,
  spec: OrgSpec | null,
  tree: Map<string, TreeNode>,
  levelOf: Map<string, ChainLevel>,
  rootOwner: string | null,
) {
  const specAlias = spec ? specAliases(spec)[0] : undefined;
  const liveAlias = [...tree.values()].find((n) => n.kind === "alias" && n.aliasOf);
  const alias = specAlias ?? (liveAlias ? { name: liveAlias.name, label: liveAlias.label, parent: liveAlias.parent!, target: liveAlias.aliasOf!, days: 0 } : null);
  if (!alias) return { alias: null } as const;
  const aliasLevel = levelOf.get(alias.name) ?? null;
  const target = levelOf.get(alias.target) ?? null;
  const targetRegistry = target?.subregistry ?? null;
  /** The registry the alias's label lives in (the parent's subname registry). */
  const holder = levelOf.get(alias.parent)?.subregistry ?? aliasLevel?.registry ?? null;
  // A member of the target to try through both paths (a seeded one first).
  const kids = (tree.get(alias.target)?.children ?? []).filter((c) => levelOf.get(c)?.status === "registered");
  const canonicalName = kids.find((c) => tree.get(c)?.inSpec) ?? kids[0] ?? null;
  const aliasName = canonicalName ? `${canonicalName.split(".")[0]}.${alias.name}` : null;
  const present = aliasLevel?.status === "registered";

  const config = loadConfig({ RELAY_ROOT_NAME: root, RELAY_REQUIRE_CANONICAL: "true", RELAY_ROOT_OWNER: rootOwner ?? "" });
  const deps = { config, reader, meter: NO_SPEND as unknown as Meter };
  const run = (name: string | null) => (name ? decide({ name, provider: PROVIDER }, deps).catch((err: unknown) => err as Error) : Promise.resolve(null));
  // The target's side (its registry's parent pointer and canonical name) is there before the alias is.
  const [canonical, viaAlias, raw] = await Promise.all([
    run(canonicalName),
    present ? run(aliasName) : Promise.resolve(null),
    targetRegistry && holder
      ? readAll(pub, [
          { address: holder, abi: registryAbi, functionName: "getSubregistry", args: [alias.label] },
          { address: targetRegistry, abi: registryAbi, functionName: "getParent" },
          { address: UNIVERSAL_HELPER, abi: helperAbi, functionName: "findCanonicalName", args: [targetRegistry] },
          ...(canonicalName && aliasName
            ? [
                { address: UNIVERSAL_HELPER, abi: helperAbi, functionName: "findRegistries", args: [dnsEncode(canonicalName)] },
                { address: UNIVERSAL_HELPER, abi: helperAbi, functionName: "findRegistries", args: [dnsEncode(aliasName)] },
              ]
            : []),
        ])
      : Promise.resolve(null),
  ]);
  return { alias, aliasLevel, target, targetRegistry, holder, present, canonicalName, aliasName, canonical, viaAlias, raw, config };
}

function describeDecision(d: PolicyDecision) {
  if (d.allowed) {
    return `allowed${d.remaining !== null ? ` · tightest ${PROVIDER} cap on the way down: $${d.remaining}` : ""} ${s.dim("(the relay's spend isn't visible here, so none is counted)")}`;
  }
  return `refused · denial "${d.denial}" · reason: "${d.reason}"`;
}

function printAlias(a: AliasFacts) {
  if (!a.alias) {
    say(`   ${s.na} the spec lists no alias and none was found on chain`);
    return;
  }
  const { alias } = a;
  const targetLabel = alias.target.split(".")[0];
  const targetParent = alias.target.slice(alias.target.indexOf(".") + 1);
  say(`   alias    ${s.bold(alias.name)}: "${alias.label}" under ${alias.parent}, with ${alias.target}'s registry ${a.targetRegistry ? short(a.targetRegistry) : "?"} as its subregistry`);
  say(`            ${s.dim(`so every name under ${alias.target} also resolves as <name>.${alias.name}: the same registry entries under a second name`)}`);
  if (!a.present) say(`   ${s.na} not set up yet — run ADMIN_PRIVATE_KEY=… npm run org:seed (it sends the one registration the spec lists)`);
  if (a.raw) {
    const [sub, parent, canonicalBytes, regsCanonical, regsAlias] = a.raw as [
      Address | null,
      readonly [Address, string] | null,
      Hex | null,
      readonly Address[] | null,
      readonly Address[] | null,
    ];
    const targetHolder = a.target?.registry ?? null;
    const attached = !!sub && !!a.targetRegistry && isAddressEqual(sub, a.targetRegistry);
    say(`   evidence (read now):`);
    const subText = `${alias.parent}'s registry ${short(a.holder!)}.getSubregistry("${alias.label}") = ${sub ?? "?"}`;
    if (a.present) say(`     ${mark(attached)} ${subText}${attached ? ` = ${alias.target}'s registry` : `, not ${alias.target}'s ${a.targetRegistry}`}`);
    else say(`     ${s.na} ${subText} (nothing yet; org:seed sets it to ${a.targetRegistry})`);
    const parentOk = !!parent && !!targetHolder && isAddressEqual(parent[0], targetHolder) && parent[1] === targetLabel;
    say(`     ${mark(parentOk)} ${short(a.targetRegistry!)}.getParent() = (${parent ? `${parent[0]}, "${parent[1]}"` : "?"}): ${targetParent}'s registry and "${targetLabel}", not ${alias.parent}`);
    const canonicalText = canonicalBytes ? dnsDecode(canonicalBytes) : "?";
    say(`     ${mark(canonicalText === alias.target)} UniversalHelper.findCanonicalName(${short(a.targetRegistry!)}) = "${canonicalText}": the only name the relay accepts for it`);
    if (a.present && regsCanonical && regsAlias && a.canonicalName && a.aliasName) {
      const same = !!regsCanonical[1] && !!regsAlias[1] && isAddressEqual(regsCanonical[1], regsAlias[1]);
      say(`     ${mark(same)} UniversalHelper.findRegistries: ${a.aliasName} and ${a.canonicalName} are both held by ${regsAlias[1] ? short(regsAlias[1]) : "?"} (one entry, two names)`);
    }
  }
  const decisionLine = (name: string | null, d: PolicyDecision | Error | null, expect: "allowed" | "not-canonical") => {
    if (!name || !d) return;
    if (d instanceof Error) return say(`   ${mark(false)} ${name} · ${PROVIDER}: couldn't decide (${shortError(d)})`);
    const ok = expect === "allowed" ? d.allowed || d.denial === "policy" : !d.allowed && d.denial === "not-canonical";
    say(`   ${mark(ok)} ${s.bold(name)} · ${PROVIDER} → ${describeDecision(d)}`);
  };
  say(`   the relay's decision, made here by its own code: lib/relay/policy.ts decide() reading this RPC through ViemChainReader,`);
  say(`   ${s.dim(`config RELAY_ROOT_NAME=${a.config.rootName} RELAY_REQUIRE_CANONICAL=true${a.config.rootOwner ? ` RELAY_ROOT_OWNER=${a.config.rootOwner}` : ""}`)}`);
  decisionLine(a.canonicalName, a.canonical, "allowed");
  if (a.present) decisionLine(a.aliasName, a.viaAlias, "not-canonical");
  else if (a.aliasName) say(`   ${s.na} ${a.aliasName} · ${PROVIDER} → checked once the alias exists (expected: refused, "not-canonical")`);
}

const watchdog = setTimeout(() => {
  console.error(`\nverify:live is still running after ${HARD_LIMIT_MS / 1000} s; stopping. Try another RPC with --rpc.`);
  process.exit(2);
}, HARD_LIMIT_MS);
watchdog.unref();

main().catch((err) => {
  console.error(`\n${s.bad} ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.DEBUG) console.error(err);
  process.exitCode = 1;
});
