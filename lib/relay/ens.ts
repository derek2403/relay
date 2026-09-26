// Reads the relay's view of ENSv2: every level from the company root down to
// a name, with registry state, bundle and hardening checks, in three RPC
// round trips (Multicall3), all at the same block:
//   1. UniversalHelper.findRegistries(name): the registry walk from RootRegistry
//      (same getSubregistry chain the Universal Resolver follows).
//   2. getState + getResolver for every level.
//   3. Every level's bundle (one resolve(name, multicall(text...)) per level),
//      plus verifyContract / findCanonicalName checks for every level.
//
// Results are cached per (name, latest block): a new block means a fresh read,
// so an unregister takes effect on the first request after it is mined, while
// a burst of requests within one block costs one eth_blockNumber each (shared
// by concurrent requests) instead of three round trips.

import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  isAddressEqual,
  parseAbi,
  parseAbiItem,
  zeroAddress,
} from "viem";
import { sepolia } from "viem/chains";

import { ENSV2_SEPOLIA } from "../ens/deployments";
import { PERMISSIONED_RESOLVER_IMPL, USER_REGISTRY_IMPL, VERIFIABLE_FACTORY, verifiableFactoryAbi } from "../ens/factory";
import { ROOT_REGISTRY } from "../ens/hierarchy";
import { dnsEncode, labelId, namehash, splitLabels } from "../ens/names";
import { type Bundle, RECORD_PREFIX, bundleRecordKeys, parseBundle } from "./bundle";
import type { ChildView, ChildrenResponse, LevelStatus, LevelView } from "./types";

/** A level as read from the chain (LevelView minus spend, which the meter adds). */
export type ChainLevel = Omit<LevelView, "spent">;

export interface ChainReader {
  /**
   * Every level from `root` down to `name`, root first. `name` must be `root`
   * or a name under it (both normalized).
   */
  readLevels(root: string, name: string): Promise<ChainLevel[]>;
}

/** Lists and checks subnames (the relay's ViemChainReader; fakes in tests). */
export interface TreeReader extends ChainReader {
  /** Names registered directly under `name`. Throws ScanLimitError when the scan can't finish within `budget`. */
  listChildren(name: string, budget?: ChildrenBudget): Promise<ChildrenResponse>;
  /**
   * For each pair, whether `registry` points back to `name` (UniversalHelper.findCanonicalName):
   * false for an alias (another name's registry hung under a second path), null when unknown.
   */
  canonical(pairs: { registry: Address; name: string }[]): Promise<(boolean | null)[]>;
}

export class ChainReadError extends Error {
  override name = "ChainReadError";
}

/** Thrown when /api/ens/children can't finish within its budget; progress is kept for the next call. */
export class ScanLimitError extends Error {
  override name = "ScanLimitError";
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

// Checked by name: after a dev-server reload, errors can come from an older copy of this module.
export const isChainReadError = (e: unknown): e is ChainReadError => e instanceof Error && e.name === "ChainReadError";
export const isScanLimitError = (e: unknown): e is ScanLimitError => e instanceof Error && e.name === "ScanLimitError";

export const ETH_REGISTRY = ENSV2_SEPOLIA.ETHRegistry.address;
export const UNIVERSAL_HELPER = ENSV2_SEPOLIA.UniversalHelper.address;
const MULTICALL3 = sepolia.contracts.multicall3.address;

const multicall3Abi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
]);

const helperAbi = parseAbi([
  "function findRegistries(bytes name) view returns (address[])",
  "function findCanonicalName(address registry) view returns (bytes)",
]);

const registryAbi = parseAbi([
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
  "function getResolver(string label) view returns (address)",
  "function getSubregistry(string label) view returns (address)",
]);

const resolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function multicall(bytes[] calls) returns (bytes[] results)",
]);

const proxyDeployedEvent = parseAbiItem(
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
);
const labelEvents = [
  parseAbiItem("event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)"),
  parseAbiItem("event LabelReserved(uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender)"),
] as const;

const orNull = (a: Address | null | undefined) => (!a || isAddressEqual(a, zeroAddress) ? null : a);
const same = (a: Address | null, b: Address) => !!a && isAddressEqual(a, b);

export const statusFromCode = (code: number): LevelStatus => (code === 2 ? "registered" : code === 1 ? "reserved" : "available");

// --- Multicall3 plumbing ------------------------------------------------------

type Call<T> = { target: Address; callData: Hex; decode: (data: Hex) => T };

/** Runs calls through Multicall3.aggregate3 (at `blockNumber` when given). A reverting call yields null; a transport error throws. */
async function aggregate<T>(client: PublicClient, calls: Call<T>[], blockNumber?: bigint, chunkSize = 150, concurrency = 4): Promise<(T | null)[]> {
  const chunks: Call<T>[][] = [];
  for (let i = 0; i < calls.length; i += chunkSize) chunks.push(calls.slice(i, i + chunkSize));
  const results: (T | null)[][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const idx = next++;
      const chunk = chunks[idx];
      const raw = await client.readContract({
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: "aggregate3",
        args: [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      });
      results[idx] = raw.map((r, i) => {
        if (!r.success || r.returnData === "0x") return null;
        try {
          return chunk[i].decode(r.returnData);
        } catch {
          return null;
        }
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return results.flat();
}

const getStateCall = (registry: Address, label: string): Call<{ status: number; expiry: bigint; latestOwner: Address; resource: bigint }> => ({
  target: registry,
  callData: encodeFunctionData({ abi: registryAbi, functionName: "getState", args: [labelId(label)] }),
  decode: (data) => decodeFunctionResult({ abi: registryAbi, functionName: "getState", data }),
});

const addressCall = (registry: Address, fn: "getResolver" | "getSubregistry", label: string): Call<Address | null> => ({
  target: registry,
  callData: encodeFunctionData({ abi: registryAbi, functionName: fn, args: [label] }),
  decode: (data) => orNull(decodeFunctionResult({ abi: registryAbi, functionName: fn, data })),
});

const verifyCall = (proxy: Address): Call<Address> => ({
  target: VERIFIABLE_FACTORY,
  callData: encodeFunctionData({ abi: verifiableFactoryAbi, functionName: "verifyContract", args: [proxy] }),
  decode: (data) => decodeFunctionResult({ abi: verifiableFactoryAbi, functionName: "verifyContract", data }),
});

const canonicalCall = (registry: Address): Call<Hex> => ({
  target: UNIVERSAL_HELPER,
  callData: encodeFunctionData({ abi: helperAbi, functionName: "findCanonicalName", args: [registry] }),
  decode: (data) => decodeFunctionResult({ abi: helperAbi, functionName: "findCanonicalName", data }),
});

/**
 * Text record (unix seconds) the level above can set on a name to refuse
 * every token for it issued earlier: revokes leaked tokens without
 * re-registering the name.
 */
export const TOKEN_NBF_KEY = `${RECORD_PREFIX}.nbf`;

type NameRecords = { bundle: Bundle | null; nbf: number | null };

const parseNbf = (raw: string | null | undefined) => {
  const n = Number((raw ?? "").trim());
  return raw && raw.trim() && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * One call that returns a whole bundle (plus the token nbf record):
 * PermissionedResolver.resolve() accepts multicall(text(node, key)...) and
 * answers with abi.encode(bytes[]), each entry an abi-encoded string (or
 * revert data for a failed sub-call).
 */
function bundleCall(resolver: Address, name: string): Call<NameRecords> {
  const keys = [...bundleRecordKeys(), TOKEN_NBF_KEY];
  const node = namehash(name);
  const inner = keys.map((key) => encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [node, key] }));
  return {
    target: resolver,
    callData: encodeFunctionData({
      abi: resolverAbi,
      functionName: "resolve",
      args: [dnsEncode(name), encodeFunctionData({ abi: resolverAbi, functionName: "multicall", args: [inner] })],
    }),
    decode: (data) => {
      const encoded = decodeFunctionResult({ abi: resolverAbi, functionName: "resolve", data });
      const [items] = decodeAbiParameters([{ type: "bytes[]" }], encoded);
      const texts: Record<string, string | null> = {};
      keys.forEach((key, i) => {
        try {
          texts[key] = decodeAbiParameters([{ type: "string" }], items[i])[0];
        } catch {
          texts[key] = null;
        }
      });
      return { bundle: parseBundle(texts), nbf: parseNbf(texts[TOKEN_NBF_KEY]) };
    },
  };
}

// --- Reader -------------------------------------------------------------------

const LOG_CHUNK = 50_000n;
const MIN_LOG_CHUNK = 5_000n;
/** First ENSv2 deployment block; the label scan starts here for registries not made by the VerifiableFactory. */
const ENSV2_START_BLOCK = ENSV2_SEPOLIA.RootRegistry.deployBlock;
/** Cached level reads (all for the latest block) before the cache is dropped. */
const MAX_CACHED_READS = 2000;
/** Registries whose label scans are remembered; the least recently used idle one is dropped beyond this. */
const MAX_SCANS = 256;
/** Label scans (getLogs loops) running at once across all registries. */
const MAX_ACTIVE_SCANS = 3;

type ScanState = {
  factoryScannedTo: bigint | null;
  creationBlock: bigint | null;
  scannedTo: bigint | null;
  labels: string[];
  seen: Set<string>;
  busy: Promise<unknown>;
  running: boolean;
};

export type ChildrenBudget = {
  maxChunks: number;
  deadlineMs: number;
  maxLabels: number;
  /** How long to wait for a free scan slot before giving up (default 0: fail at once when busy). */
  slotWaitMs?: number;
};

export const DEFAULT_CHILDREN_BUDGET: ChildrenBudget = { maxChunks: 40, deadlineMs: 20_000, maxLabels: 1000 };

type LevelDraft = {
  index: number;
  name: string;
  label: string;
  parent: string;
  registry: Address | null;
  subregistry: Address | null;
};

export class ViemChainReader implements TreeReader {
  private scans = new Map<string, ScanState>();
  private activeScans = 0;
  private reads = new Map<string, Promise<ChainLevel[]>>();
  private readsBlock: bigint | null = null;
  private blockInFlight: Promise<bigint> | null = null;

  constructor(readonly client: PublicClient) {}

  /** The latest block number; concurrent callers share one eth_blockNumber. */
  private latestBlock(): Promise<bigint> {
    this.blockInFlight ??= this.client.getBlockNumber({ cacheTime: 0 }).finally(() => {
      this.blockInFlight = null;
    });
    return this.blockInFlight;
  }

  /** registries[i] is the registry OF labels[i..] (its subregistry); the last entry is RootRegistry. */
  private async findRegistries(name: string, blockNumber?: bigint): Promise<(Address | null)[]> {
    try {
      const out = await this.client.readContract({
        address: UNIVERSAL_HELPER,
        abi: helperAbi,
        functionName: "findRegistries",
        args: [dnsEncode(name)],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      });
      return out.map((a) => orNull(a));
    } catch (err) {
      throw new ChainReadError(`Could not walk the registry tree for ${name}: ${shortError(err)}`);
    }
  }

  async readLevels(root: string, name: string): Promise<ChainLevel[]> {
    if (name !== root && !name.endsWith(`.${root}`)) throw new ChainReadError(`${name} is not under ${root}`);
    let block: bigint;
    try {
      block = await this.latestBlock();
    } catch (err) {
      throw new ChainReadError(`Could not read the latest block: ${shortError(err)}`);
    }
    if (block !== this.readsBlock || this.reads.size > MAX_CACHED_READS) {
      this.reads.clear();
      this.readsBlock = block;
    }
    const key = `${root}|${name}`;
    let read = this.reads.get(key);
    if (!read) {
      const started = this.readAt(root, name, block);
      read = started;
      this.reads.set(key, started);
      started.catch(() => {
        if (this.reads.get(key) === started) this.reads.delete(key);
      });
    }
    try {
      return await read;
    } catch {
      // A load-balanced RPC can route the pinned read to a node that hasn't seen this block yet.
      return this.readAt(root, name, undefined);
    }
  }

  private async readAt(root: string, name: string, blockNumber: bigint | undefined): Promise<ChainLevel[]> {
    const labels = splitLabels(name);
    const first = labels.length - splitLabels(root).length;
    const registries = await this.findRegistries(name, blockNumber);

    const drafts: LevelDraft[] = [];
    for (let i = first; i >= 0; i--) {
      drafts.push({
        index: i,
        name: labels.slice(i).join("."),
        label: labels[i],
        parent: labels.slice(i + 1).join("."),
        registry: registries[i + 1] ?? null,
        subregistry: registries[i] ?? null,
      });
    }

    try {
      // Round 2: state and resolver of every reachable level.
      const reachable = drafts.filter((d) => d.registry);
      const [states, resolvers] = await Promise.all([
        aggregate(this.client, reachable.map((d) => getStateCall(d.registry!, d.label)), blockNumber),
        aggregate(this.client, reachable.map((d) => addressCall(d.registry!, "getResolver", d.label)), blockNumber),
      ]);
      const stateOf = new Map(reachable.map((d, i) => [d.index, states[i]]));
      const resolverOf = new Map(reachable.map((d, i) => [d.index, resolvers[i]]));

      // Round 3: bundles and hardening checks, re-checked on every read (a proxy upgrade or a
      // setParent change shows up in the next block).
      type Job = { level: number; kind: "bundle" | "registry" | "resolver" | "canonical"; call: Call<unknown> };
      const jobs: Job[] = [];
      const levelChecks = drafts.map(() => ({ registryVerified: null, resolverVerified: null, canonical: null }) as ChainLevel["checks"]);
      drafts.forEach((d, li) => {
        const resolver = resolverOf.get(d.index) ?? null;
        if (resolver) jobs.push({ level: li, kind: "bundle", call: bundleCall(resolver, d.name) });
        // Only the company root may live in ETHRegistry (or RootRegistry). Anywhere below it, a
        // subregistry pointed at ETHRegistry would make "<x>.member.acme.eth" resolve as "<x>.eth",
        // which anyone can register, so every lower level must sit in a genuine, canonical UserRegistry.
        const rootInCoreRegistry = li === 0 && !!d.registry && (same(d.registry, ETH_REGISTRY) || same(d.registry, ROOT_REGISTRY));
        if (d.registry && !rootInCoreRegistry) {
          jobs.push({ level: li, kind: "registry", call: verifyCall(d.registry) });
          jobs.push({ level: li, kind: "canonical", call: canonicalCall(d.registry) });
        }
        if (resolver) jobs.push({ level: li, kind: "resolver", call: verifyCall(resolver) });
      });
      const results = await aggregate(this.client, jobs.map((j) => j.call), blockNumber);
      const records = new Map<number, NameRecords | null>();
      jobs.forEach((job, i) => {
        const r = results[i];
        const d = drafts[job.level];
        if (job.kind === "bundle") {
          records.set(job.level, (r as NameRecords | null) ?? null);
          return;
        }
        let ok: boolean;
        if (job.kind === "canonical") ok = r === dnsEncode(d.parent);
        else ok = !!r && isAddressEqual(r as Address, job.kind === "registry" ? USER_REGISTRY_IMPL : PERMISSIONED_RESOLVER_IMPL);
        if (job.kind === "registry") levelChecks[job.level].registryVerified = ok;
        else if (job.kind === "resolver") levelChecks[job.level].resolverVerified = ok;
        else levelChecks[job.level].canonical = ok;
      });

      return drafts.map((d, li): ChainLevel => {
        const state = stateOf.get(d.index) ?? null;
        const status: LevelStatus = !d.registry || !state ? "missing" : statusFromCode(state.status);
        return {
          name: d.name,
          registry: d.registry,
          resolver: resolverOf.get(d.index) ?? null,
          subregistry: d.subregistry,
          status,
          owner: status === "registered" && state ? orNull(state.latestOwner) : null,
          expiry: state && state.expiry > 0n ? Number(state.expiry) : null,
          resource: state ? state.resource.toString() : null,
          bundle: records.get(li)?.bundle ?? null,
          nbf: records.get(li)?.nbf ?? null,
          checks: levelChecks[li],
        };
      });
    } catch (err) {
      if (isChainReadError(err)) throw err;
      throw new ChainReadError(`Could not read ENS for ${name}: ${shortError(err)}`);
    }
  }

  async canonical(pairs: { registry: Address; name: string }[]): Promise<(boolean | null)[]> {
    if (!pairs.length) return [];
    try {
      const names = await aggregate(this.client, pairs.map((p) => canonicalCall(p.registry)));
      return names.map((n, i) => (n === null ? null : n === dnsEncode(pairs[i].name)));
    } catch (err) {
      throw new ChainReadError(`Could not check canonical names: ${shortError(err)}`);
    }
  }

  /** Names registered directly under `name`, from its subname registry's LabelRegistered/LabelReserved events. */
  async listChildren(name: string, budget: ChildrenBudget = DEFAULT_CHILDREN_BUDGET): Promise<ChildrenResponse> {
    const [registry] = await this.findRegistries(name);
    if (!registry) return { name, registry: null, children: [] };

    const labels = await this.scanLabels(registry, budget);
    try {
      const rows = await aggregate(
        this.client,
        labels.flatMap((label) => [getStateCall(registry, label), addressCall(registry, "getResolver", label), addressCall(registry, "getSubregistry", label)] as Call<unknown>[]),
      );
      const partial = labels.map((label, i) => {
        const state = rows[i * 3] as Awaited<ReturnType<ReturnType<typeof getStateCall>["decode"]>> | null;
        const status = state ? statusFromCode(state.status) : "missing";
        return {
          label,
          name: `${label}.${name}`,
          status,
          owner: status === "registered" && state ? orNull(state.latestOwner) : null,
          expiry: state && state.expiry > 0n ? Number(state.expiry) : null,
          resolver: (rows[i * 3 + 1] as Address | null) ?? null,
          subregistry: (rows[i * 3 + 2] as Address | null) ?? null,
        };
      });
      const withResolver = partial.filter((c) => c.resolver);
      const bundles = await aggregate(this.client, withResolver.map((c) => bundleCall(c.resolver!, c.name)));
      const bundleOf = new Map(withResolver.map((c, i) => [c.label, bundles[i]?.bundle ?? null]));
      const children: ChildView[] = partial.map((c) => ({ ...c, bundle: bundleOf.get(c.label) ?? null }));
      return { name, registry, children };
    } catch (err) {
      throw new ChainReadError(`Could not read the subnames of ${name}: ${shortError(err)}`);
    }
  }

  /**
   * Scans are serialized per registry and resume where the last one stopped.
   * At most MAX_ACTIVE_SCANS run at once, and only the MAX_SCANS most recently
   * used registries are remembered.
   */
  private scanLabels(registry: Address, budget: ChildrenBudget): Promise<string[]> {
    const key = registry.toLowerCase();
    let state = this.scans.get(key);
    if (state) {
      this.scans.delete(key); // re-insert: Map order is the LRU order
    } else {
      state = { factoryScannedTo: null, creationBlock: null, scannedTo: null, labels: [], seen: new Set(), busy: Promise.resolve(), running: false };
    }
    this.scans.set(key, state);
    for (const [k, v] of this.scans) {
      if (this.scans.size <= MAX_SCANS) break;
      if (!v.running && k !== key) this.scans.delete(k);
    }
    const s = state;
    const run = s.busy.catch(() => {}).then(() => this.scan(s, registry, budget));
    s.busy = run;
    return run;
  }

  private async scan(state: ScanState, registry: Address, budget: ChildrenBudget): Promise<string[]> {
    const waitUntil = Date.now() + (budget.slotWaitMs ?? 0);
    while (this.activeScans >= MAX_ACTIVE_SCANS && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 100));
    if (this.activeScans >= MAX_ACTIVE_SCANS) {
      throw new ScanLimitError("The relay is busy reading other subname lists. Try again in a moment.", true);
    }
    this.activeScans++;
    state.running = true;
    try {
      return await this.scanLogs(state, registry, budget);
    } finally {
      this.activeScans--;
      state.running = false;
    }
  }

  private async scanLogs(state: ScanState, registry: Address, budget: ChildrenBudget): Promise<string[]> {
    const deadline = Date.now() + budget.deadlineMs;
    let chunks = 0;
    let latest: bigint;
    try {
      latest = await this.client.getBlockNumber({ cacheTime: 0 });
    } catch (err) {
      throw new ChainReadError(`Could not read the latest block: ${shortError(err)}`);
    }
    const spend = (from: bigint) => {
      if (chunks >= budget.maxChunks || Date.now() > deadline) {
        throw new ScanLimitError(`Still scanning ${registry} (at block ${from} of ${latest}). Try again in a moment.`, true);
      }
      chunks++;
    };
    // Public RPCs rate-limit and cap getLogs ranges: back off and shrink the range on errors.
    let chunk = LOG_CHUNK;
    const range = async <T>(from: bigint, get: (to: bigint) => Promise<T>): Promise<{ to: bigint; logs: T }> => {
      for (let attempt = 0; ; attempt++) {
        const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
        try {
          return { to, logs: await get(to) };
        } catch (err) {
          if (attempt >= 4 || Date.now() + 400 * 2 ** attempt > deadline) {
            throw new ChainReadError(`Could not read logs: ${shortError(err)}`);
          }
          if (chunk > MIN_LOG_CHUNK) chunk /= 2n;
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
      }
    };

    // Where the registry was created: its ProxyDeployed event, filtered by the indexed proxy address.
    if (state.creationBlock === null) {
      let from = state.factoryScannedTo !== null ? state.factoryScannedTo + 1n : ENSV2_SEPOLIA.VerifiableFactory.deployBlock;
      while (state.creationBlock === null && from <= latest) {
        spend(from);
        const { to, logs } = await range(from, (to) =>
          this.client.getLogs({ address: VERIFIABLE_FACTORY, event: proxyDeployedEvent, args: { proxyAddress: registry }, fromBlock: from, toBlock: to }),
        );
        state.factoryScannedTo = to;
        if (logs.length) state.creationBlock = logs[0].blockNumber;
        from = to + 1n;
      }
      // Not a factory proxy (e.g. ETHRegistry): scan from the first ENSv2 block.
      if (state.creationBlock === null) state.creationBlock = ENSV2_START_BLOCK;
    }

    let from = state.scannedTo !== null ? state.scannedTo + 1n : state.creationBlock;
    while (from <= latest) {
      spend(from);
      const { to, logs } = await range(from, (to) => this.client.getLogs({ address: registry, events: labelEvents, fromBlock: from, toBlock: to }));
      for (const log of logs) {
        const label = (log.args as { label?: string }).label;
        if (typeof label === "string" && !state.seen.has(label)) {
          state.seen.add(label);
          state.labels.push(label);
        }
      }
      state.scannedTo = to;
      if (state.labels.length > budget.maxLabels) {
        throw new ScanLimitError(`${registry} has more than ${budget.maxLabels} subnames; too many to list.`, false);
      }
      from = to + 1n;
    }
    return [...state.labels];
  }
}

function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage || e?.message || String(err)).split("\n")[0];
}

export function createChainReader(rpcUrl: string): ViemChainReader {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: 15_000 }) });
  return new ViemChainReader(client as PublicClient);
}

// One reader per RPC URL, kept on globalThis so its caches survive dev-server reloads of other
// modules. A reload of this module brings a new class, and the old instance is replaced.
const g = globalThis as unknown as { __relayReaders?: Map<string, ViemChainReader> };

export function getChainReader(rpcUrl: string): ViemChainReader {
  g.__relayReaders ??= new Map();
  let reader = g.__relayReaders.get(rpcUrl);
  if (!(reader instanceof ViemChainReader)) {
    reader = createChainReader(rpcUrl);
    g.__relayReaders.set(rpcUrl, reader);
  }
  return reader;
}
