// Shared ENSv2 plumbing for the demo scripts (./relay, org-setup, demo-reset):
// clients, reads, CREATE2 address predictions, bundle diffs, the org tree, and
// a small transaction runner that sends steps whose prerequisites are already
// mined together (consecutive nonces) instead of waiting a block for each.
//
// Relative imports only (no "@/"): the CLI also runs from demo-workspace/,
// where tsx would not find the repo's path aliases, and esbuild bundles it
// (npm run build:cli) into the installable `relay`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
  concat,
  createPublicClient,
  decodeAbiParameters,
  encodeFunctionData,
  formatEther,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  stringToBytes,
  stringToHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { PermissionedResolverImplAbi } from "../../lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "../../lib/ens/abis/UserRegistryImpl";
import { ENSV2_SEPOLIA } from "../../lib/ens/deployments";
import { formatError } from "../../lib/ens/errors";
import {
  PERMISSIONED_RESOLVER_IMPL,
  USER_REGISTRY_IMPL,
  VERIFIABLE_FACTORY,
  allRolesTo,
  encodeRegistryInit,
  encodeResolverInit,
  predictProxyAddress,
  registrySalt,
  resolverSalt,
  verifiableFactoryAbi,
} from "../../lib/ens/factory";
import { dnsEncode, labelId, namehash, splitLabels } from "../../lib/ens/names";
import { type Bundle, PROVIDER_IDS, bundleToRecords } from "../../lib/relay/bundle";

/** This repo. Meaningless inside the bundled CLI (public/cli/relay.mjs), which never uses it. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
/** Tenderly's public Sepolia gateway: the CLI's default RPC (publicnode rate-limits; this one also takes wide log ranges). */
export const TENDERLY_RPC_URL = "https://sepolia.gateway.tenderly.co";

export const ETH_REGISTRY = ENSV2_SEPOLIA.ETHRegistry.address;
export const ETH_REGISTRAR = ENSV2_SEPOLIA.ETHRegistrar.address;
export const MOCK_USDC = ENSV2_SEPOLIA.MockUSDC.address;
export const UNIVERSAL_HELPER = ENSV2_SEPOLIA.UniversalHelper.address;

/** A failure to print as one line, without a stack trace. */
export class UserError extends Error {}

export function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage || e?.message || String(err)).split("\n")[0];
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const nowSec = () => Math.floor(Date.now() / 1000);

// --- Settings ------------------------------------------------------------------

/**
 * Copies the given keys from the repo's .env.local / .env into process.env
 * (a variable already set wins, even when empty). Only these keys are read, so
 * provider keys never enter the CLI's process.
 */
export function loadEnvFiles(keys: string[]) {
  for (const file of [".env.local", ".env"]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || !keys.includes(m[1]) || m[1] in process.env) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
      if (value) process.env[m[1]] = value;
    }
  }
}

export const envRpc = () => process.env.RELAY_RPC_URL?.trim() || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL?.trim() || "";

// --- Clients ---------------------------------------------------------------------

export type Chain = { pub: PublicClient; rpc: string; local: boolean };

/** Transport settings a script may override (org-seed retries longer and counts rate limits). */
export type ConnectOptions = { retryCount?: number; retryDelay?: number; onFetchResponse?: (response: Response) => void };

export async function connect(rpc: string, options: ConnectOptions = {}): Promise<Chain> {
  const pub = createPublicClient({
    chain: sepolia,
    transport: http(rpc, { timeout: 30_000, retryCount: 4, ...options }),
    batch: { multicall: { wait: 10 } },
  }) as PublicClient;
  let chainId: number;
  try {
    chainId = await pub.getChainId();
  } catch (err) {
    throw new UserError(`Could not reach the Sepolia RPC at ${rpc} (${shortError(err)}).`);
  }
  if (chainId !== sepolia.id) throw new UserError(`${rpc} serves chain ${chainId}, not Sepolia (11155111).`);
  let local = false;
  try {
    const version = (await pub.request({ method: "web3_clientVersion" } as never)) as string;
    local = /anvil|hardhat/i.test(version);
  } catch {}
  return { pub, rpc, local };
}

export const hasCode = async (pub: PublicClient, address: Address) => {
  const code = await pub.getCode({ address });
  return !!code && code !== "0x";
};

/** "Now" for new expiries: the later of this clock and the latest block (a fork's clock may run ahead). */
export async function chainNow(pub: PublicClient): Promise<number> {
  try {
    const block = await pub.getBlock({ blockTag: "latest" });
    return Math.max(nowSec(), Number(block.timestamp));
  } catch {
    return nowSec();
  }
}

// --- Addresses the Verifiable Factory will deploy to ---------------------------------

let proxyLogicCache: Address | null = null;

async function proxyLogic(pub: PublicClient): Promise<Address> {
  proxyLogicCache ??= await pub.readContract({ address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "proxyLogic" });
  return proxyLogicCache;
}

/** The account's own PermissionedResolver (salt version 0, the scheme the portal uses too). */
export const resolverAddress = async (pub: PublicClient, owner: Address) =>
  predictProxyAddress({ proxyLogic: await proxyLogic(pub), deployer: owner, salt: resolverSalt(owner) });

/** The UserRegistry `deployer` deploys for `name` (salt from the name's namehash). */
export const registryAddress = async (pub: PublicClient, deployer: Address, name: string) =>
  predictProxyAddress({ proxyLogic: await proxyLogic(pub), deployer, salt: registrySalt(namehash(name)) });

// --- Transactions (calldata) ------------------------------------------------------------

export type TxCall = { to: Address; data: Hex; value?: bigint };

const registryCall = (registry: Address, data: Hex): TxCall => ({ to: registry, data });

export const tx = {
  deployResolver: (owner: Address): TxCall => ({
    to: VERIFIABLE_FACTORY,
    data: encodeFunctionData({
      abi: verifiableFactoryAbi,
      functionName: "deployProxy",
      args: [PERMISSIONED_RESOLVER_IMPL, resolverSalt(owner), encodeResolverInit(allRolesTo(owner))],
    }),
  }),
  deployRegistry: (deployer: Address, name: string): TxCall => ({
    to: VERIFIABLE_FACTORY,
    data: encodeFunctionData({
      abi: verifiableFactoryAbi,
      functionName: "deployProxy",
      args: [USER_REGISTRY_IMPL, registrySalt(namehash(name)), encodeRegistryInit(allRolesTo(deployer))],
    }),
  }),
  register: (registry: Address, label: string, owner: Address, subregistry: Address, resolver: Address, roles: bigint, expiry: number) =>
    registryCall(
      registry,
      encodeFunctionData({ abi: UserRegistryImplAbi, functionName: "register", args: [label, owner, subregistry, resolver, roles, BigInt(expiry)] }),
    ),
  setSubregistry: (registry: Address, label: string, subregistry: Address) =>
    registryCall(registry, encodeFunctionData({ abi: UserRegistryImplAbi, functionName: "setSubregistry", args: [labelId(label), subregistry] })),
  setResolver: (registry: Address, label: string, resolver: Address) =>
    registryCall(registry, encodeFunctionData({ abi: UserRegistryImplAbi, functionName: "setResolver", args: [labelId(label), resolver] })),
  setParent: (registry: Address, parent: Address, label: string) =>
    registryCall(registry, encodeFunctionData({ abi: UserRegistryImplAbi, functionName: "setParent", args: [parent, label] })),
  unregister: (registry: Address, label: string) =>
    registryCall(registry, encodeFunctionData({ abi: UserRegistryImplAbi, functionName: "unregister", args: [labelId(label)] })),
  renew: (registry: Address, label: string, expiry: number) =>
    registryCall(registry, encodeFunctionData({ abi: UserRegistryImplAbi, functionName: "renew", args: [labelId(label), BigInt(expiry)] })),
  resolverMulticall: (resolver: Address, calls: Hex[]): TxCall => ({
    to: resolver,
    data: encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "multicall", args: [calls] }),
  }),
};

// --- Reads ---------------------------------------------------------------------------------

const helperAbi = parseAbi(["function findRegistries(bytes name) view returns (address[])"]);

const resolverReadAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
  "function multicall(bytes[] calls) returns (bytes[] results)",
]);

const orNull = (a: Address | null | undefined) => (!a || isAddressEqual(a, zeroAddress) ? null : a);

export type Entry = {
  /** 0 available (also expired or removed), 1 reserved, 2 registered. */
  status: number;
  registered: boolean;
  owner: Address | null;
  /** Unix seconds; after unregister it is the time of removal. */
  expiry: number;
  /** EAC resource; changes when the label is registered again (the relay keys spend by it). */
  resource: bigint;
  resolver: Address | null;
  subregistry: Address | null;
};

const EMPTY_ENTRY: Entry = { status: 0, registered: false, owner: null, expiry: 0, resource: 0n, resolver: null, subregistry: null };

/** A label's entry in a registry (ETHRegistry shares these functions). An undeployed registry reads as empty. */
export async function readEntry(pub: PublicClient, registry: Address, label: string): Promise<Entry> {
  try {
    const [state, resolver, subregistry] = await Promise.all([
      pub.readContract({ address: registry, abi: UserRegistryImplAbi, functionName: "getState", args: [labelId(label)] }),
      pub.readContract({ address: registry, abi: UserRegistryImplAbi, functionName: "getResolver", args: [label] }),
      pub.readContract({ address: registry, abi: UserRegistryImplAbi, functionName: "getSubregistry", args: [label] }),
    ]);
    const registered = state.status === 2;
    return {
      status: state.status,
      registered,
      owner: registered ? orNull(state.latestOwner) : null,
      expiry: Number(state.expiry),
      resource: state.resource,
      resolver: orNull(resolver),
      subregistry: orNull(subregistry),
    };
  } catch (err) {
    if (!(await hasCode(pub, registry).catch(() => true))) return EMPTY_ENTRY;
    throw new UserError(`Could not read "${label}" in registry ${registry}: ${shortError(err)}`);
  }
}

/** The registry's parent pointer (set with setParent), or null when unset or not deployed. */
export async function readParent(pub: PublicClient, registry: Address): Promise<{ parent: Address; label: string } | null> {
  try {
    const [parent, label] = await pub.readContract({ address: registry, abi: UserRegistryImplAbi, functionName: "getParent" });
    return orNull(parent) ? { parent, label } : null;
  } catch {
    return null;
  }
}

export const parentIs = (p: { parent: Address; label: string } | null, parent: Address, label: string) =>
  !!p && isAddressEqual(p.parent, parent) && p.label === label;

export async function hasRootRoles(pub: PublicClient, registry: Address, roles: bigint, account: Address): Promise<boolean> {
  try {
    return await pub.readContract({ address: registry, abi: UserRegistryImplAbi, functionName: "hasRootRoles", args: [roles, account] });
  } catch {
    return false;
  }
}

/**
 * Text records in one call: PermissionedResolver.resolve accepts a multicall
 * of text() calls. An undeployed resolver or a name without records reads as "".
 */
export async function readTexts(pub: PublicClient, resolver: Address, name: string, keys: string[]): Promise<Record<string, string>> {
  const node = namehash(name);
  const texts: Record<string, string> = Object.fromEntries(keys.map((k) => [k, ""]));
  try {
    const calls = keys.map((key) => encodeFunctionData({ abi: resolverReadAbi, functionName: "text", args: [node, key] }));
    const raw = await pub.readContract({
      address: resolver,
      abi: resolverReadAbi,
      functionName: "resolve",
      args: [dnsEncode(name), encodeFunctionData({ abi: resolverReadAbi, functionName: "multicall", args: [calls] })],
    });
    const [results] = decodeAbiParameters([{ type: "bytes[]" }], raw);
    keys.forEach((key, i) => {
      try {
        texts[key] = results[i] && results[i] !== "0x" ? decodeAbiParameters([{ type: "string" }], results[i])[0] : "";
      } catch {}
    });
  } catch {}
  return texts;
}

export async function readAddr(pub: PublicClient, resolver: Address, name: string): Promise<Address | null> {
  try {
    const raw = await pub.readContract({
      address: resolver,
      abi: resolverReadAbi,
      functionName: "resolve",
      args: [dnsEncode(name), encodeFunctionData({ abi: resolverReadAbi, functionName: "addr", args: [namehash(name)] })],
    });
    return orNull(decodeAbiParameters([{ type: "address" }], raw)[0]);
  } catch {
    return null;
  }
}

/**
 * The resolver calls that make `name`'s records match `bundle` (and, for an
 * agent, addr(name) = its key): only records that differ are written, so
 * re-running is cheap and an old bundle on a re-used label is cleared.
 * PermissionedResolver setters take the DNS-encoded name.
 */
export async function bundleWrites(pub: PublicClient, resolver: Address, name: string, bundle: Bundle, agent?: Address): Promise<Hex[]> {
  const desired = bundleToRecords(bundle);
  const current = await readTexts(pub, resolver, name, desired.map(([k]) => k));
  const dns = dnsEncode(name);
  const calls = desired
    .filter(([k, v]) => (current[k] ?? "") !== v)
    .map(([k, v]) => encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: [dns, k, v] }));
  if (agent) {
    const now = await readAddr(pub, resolver, name);
    if (!now || !isAddressEqual(now, agent)) {
      calls.push(encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setAddress", args: [dns, 60n, agent] }));
    }
  }
  return calls;
}

export type WalkLevel = { name: string; label: string; registry: Address | null; entry: Entry | null };

/**
 * Every level from the .eth name down to `name`, following getSubregistry from
 * the root (UniversalHelper.findRegistries, the path the relay walks).
 * `broken` is the highest level that is not registered or can't be reached:
 * an unregistered or expired name has no subregistry, so nothing below it is reachable.
 */
export async function walkName(pub: PublicClient, name: string): Promise<{ levels: WalkLevel[]; broken: WalkLevel | null }> {
  let registries: readonly Address[];
  try {
    registries = await pub.readContract({ address: UNIVERSAL_HELPER, abi: helperAbi, functionName: "findRegistries", args: [dnsEncode(name)] });
  } catch (err) {
    throw new UserError(`Could not read ENS for ${name}: ${shortError(err)}`);
  }
  const labels = splitLabels(name);
  const levels: WalkLevel[] = [];
  // registries[i] is the registry of labels[i..]; the registry holding labels[i] is registries[i + 1].
  for (let i = labels.length - 2; i >= 0; i--) {
    levels.push({ name: labels.slice(i).join("."), label: labels[i], registry: orNull(registries[i + 1]), entry: null });
  }
  await Promise.all(levels.map(async (l) => l.registry && (l.entry = await readEntry(pub, l.registry, l.label))));
  const broken = levels.find((l) => !l.registry || !l.entry?.registered) ?? null;
  return { levels, broken };
}

// --- Sending ------------------------------------------------------------------------------

export type Log = (line: string) => void;

export type Step = {
  id: string;
  title: string;
  /** Steps that must be mined first. */
  deps?: string[];
  /** True when the chain already reflects this step. */
  done: () => Promise<boolean>;
  /** The transaction, built once its deps are mined; null means nothing to send. */
  tx: () => Promise<TxCall | null> | TxCall | null;
};

/**
 * Public Sepolia nodes a signed transaction is also offered to when the configured RPC refuses it.
 * Some hosted RPCs reject valid raw transactions (Alchemy answered "Missing or invalid parameters"
 * to a resolver multicall that estimates and mines fine elsewhere); the hash is the same everywhere.
 */
export const BROADCAST_FALLBACK_RPCS = [TENDERLY_RPC_URL, DEFAULT_RPC_URL];

/** The configured RPC first, then each fallback that isn't the same endpoint (trailing slashes and case ignored). */
export function broadcastRpcs(primary: string, fallbacks: readonly string[] = BROADCAST_FALLBACK_RPCS): string[] {
  const key = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  const seen = new Set<string>();
  return [primary, ...fallbacks].filter((u) => !seen.has(key(u)) && !!seen.add(key(u)));
}

/** The node's own words for an RPC failure, e.g. "Missing or invalid parameters (… the node's details …)". */
export function rpcErrorText(err: unknown): string {
  const base = formatError(err);
  let e = err as { details?: string; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 5; depth++, e = e.cause as typeof e) {
    if (e.details && !base.includes(e.details)) return `${base} (${e.details})`;
  }
  return base;
}

/** Nodes allow an EIP-7702 delegated account (e.g. a MetaMask smart account) one pending transaction at a time. */
const IN_FLIGHT_LIMIT = /in-flight transaction limit/i;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export class Sender {
  private nonce: number | null = null;
  private readonly broadcasters: { rpc: string; client: PublicClient }[];
  /** True when the sender is an EIP-7702 delegated account: it then sends strictly one transaction at a time. */
  private delegated: boolean | null = null;

  /** `log` is called with a step's title once its transaction is mined. */
  constructor(
    readonly chain: Chain,
    readonly account: LocalAccount,
    readonly log: Log,
  ) {
    // Transactions are signed here and sent raw: viem's wallet path first asks the node to fill the
    // transaction (eth_fillTransaction), one more hosted-RPC call that can fail for no good reason.
    const rpcs = chain.local ? [chain.rpc] : broadcastRpcs(chain.rpc);
    this.broadcasters = rpcs.map((rpc) => ({
      rpc,
      client: rpc === chain.rpc ? chain.pub : (createPublicClient({ chain: sepolia, transport: http(rpc, { timeout: 30_000, retryCount: 1 }) }) as PublicClient),
    }));
  }

  get address() {
    return this.account.address;
  }

  /**
   * Sends independent transactions back to back and waits for all of them.
   * Each is estimated first (so a revert shows its reason before anything is
   * sent); every prerequisite must already be mined.
   */
  async sendAll(items: { title: string; call: TxCall }[]): Promise<TransactionReceipt[]> {
    if (!items.length) return [];
    const { pub } = this.chain;
    const gases = await Promise.all(
      items.map(async ({ title, call }) => {
        try {
          // The address, not the local account: a plain eth_estimateGas (see the constructor).
          const gas = await pub.estimateGas({ account: this.account.address, to: call.to, data: call.data, value: call.value });
          return gas + gas / 4n + 20_000n;
        } catch (err) {
          throw new UserError(`${title}: ${rpcErrorText(err)}`);
        }
      }),
    );
    const fees = await pub.estimateFeesPerGas();
    const pendingNonce = await pub.getTransactionCount({ address: this.address, blockTag: "pending" });
    let nonce = Math.max(this.nonce ?? 0, pendingNonce);
    let balance = await pub.getBalance({ address: this.address });
    let committed = 0n;
    const receipts: TransactionReceipt[] = [];
    let inflight: { title: string; hash: Hex }[] = [];

    const flush = async () => {
      const got = await Promise.all(inflight.map((t) => this.receipt(t.hash)));
      got.forEach((r, i) => {
        if (r.status !== "success") throw new UserError(`${inflight[i].title}: the transaction reverted (${r.transactionHash}).`);
        this.log(inflight[i].title);
      });
      receipts.push(...got);
      inflight = [];
    };

    this.delegated ??= ((await pub.getCode({ address: this.address }).catch(() => undefined)) ?? "").toLowerCase().startsWith("0xef0100");
    for (let i = 0; i < items.length; i++) {
      const { title, call } = items[i];
      if (this.delegated) {
        // One in flight at a time: wait for the previous transaction and for the node to drop it from its pool.
        if (inflight.length) await flush();
        nonce = await this.waitIdle();
      }
      const cost = gases[i] * fees.maxFeePerGas + (call.value ?? 0n);
      // Nodes refuse queued transactions that together cost more than the balance.
      if (committed + cost > balance && inflight.length) {
        await flush();
        balance = await pub.getBalance({ address: this.address });
        committed = 0n;
      }
      if (cost > balance) {
        throw new UserError(
          `Not enough Sepolia ETH in ${this.address} to ${title.toLowerCase()}: needs up to ${formatEther(cost)} ETH, has ${formatEther(balance)}.`,
        );
      }
      let hash: Hex;
      try {
        const signed = await this.account.signTransaction({
          chainId: sepolia.id,
          type: "eip1559",
          to: call.to,
          data: call.data,
          value: call.value ?? 0n,
          gas: gases[i],
          nonce,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        hash = await this.broadcast(signed);
      } catch (err) {
        await flush().catch(() => {});
        throw new UserError(`${title}: ${err instanceof UserError ? err.message : rpcErrorText(err)}`);
      }
      this.nonce = ++nonce;
      committed += cost;
      inflight.push({ title, hash });
    }
    await flush();
    return receipts;
  }

  /**
   * Sends a signed transaction to the configured RPC, then to the fallbacks if it refuses. A node
   * that errors may still have taken it, so the hash is looked up before trying the next one.
   */
  private async broadcast(signed: Hex): Promise<Hex> {
    const hash = keccak256(signed);
    const refusals: string[] = [];
    for (const { rpc, client } of this.broadcasters) {
      for (let attempt = 1; ; attempt++) {
        try {
          await client.sendRawTransaction({ serializedTransaction: signed });
          return hash;
        } catch (err) {
          if (await this.chain.pub.getTransaction({ hash }).catch(() => null)) return hash;
          // A delegated account's previous transaction can still count as pending for a few seconds after it is mined.
          if (IN_FLIGHT_LIMIT.test(rpcErrorText(err)) && attempt < 10) {
            await sleep(3000 * Math.min(attempt, 4));
            continue;
          }
          refusals.push(`${new URL(rpc).host}: ${rpcErrorText(err)}`);
          break;
        }
      }
    }
    throw new UserError(`every RPC refused the transaction. ${refusals.join(" · ")}`);
  }

  /** Waits until the node has no pending transaction from this account (bounded) and returns the next nonce. */
  private async waitIdle(): Promise<number> {
    const { pub } = this.chain;
    const deadline = Date.now() + 2 * 60_000;
    for (;;) {
      const [latest, pending] = await Promise.all([
        pub.getTransactionCount({ address: this.address, blockTag: "latest" }),
        pub.getTransactionCount({ address: this.address, blockTag: "pending" }),
      ]);
      if (pending <= latest || Date.now() > deadline) return Math.max(latest, this.nonce ?? 0);
      await sleep(this.chain.local ? 100 : 2000);
    }
  }

  /** Polls for a receipt (viem's waiter can miss an automined transaction on anvil). */
  async receipt(hash: Hex): Promise<TransactionReceipt> {
    const interval = this.chain.local ? 100 : 1500;
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const r = await this.chain.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (r) return r;
      await new Promise((res) => setTimeout(res, interval));
    }
    throw new UserError(`Transaction ${hash} was not mined within 5 minutes. Check https://sepolia.etherscan.io/tx/${hash}`);
  }
}

/**
 * Runs steps in rounds: every step whose deps are mined goes out in the same
 * round. Steps already finished on chain (per `done()`) are skipped and
 * reported through `skipped`, so a re-run resumes where the last one stopped.
 */
export async function runSteps(sender: Sender, steps: Step[], opts: { skipped?: (title: string) => void } = {}): Promise<number> {
  const done = new Set<string>();
  const first = await Promise.all(steps.map((s) => s.done().catch(() => false)));
  steps.forEach((s, i) => {
    if (!first[i]) return;
    done.add(s.id);
    opts.skipped?.(s.title);
  });
  let sent = 0;
  while (done.size < steps.length) {
    const ready = steps.filter((s) => !done.has(s.id) && (s.deps ?? []).every((d) => done.has(d)));
    if (!ready.length) throw new Error(`steps can't start: ${steps.filter((s) => !done.has(s.id)).map((s) => s.id).join(", ")}`);
    // An earlier round may have finished some already (e.g. register also sets the subregistry).
    const again = await Promise.all(ready.map((s) => s.done().catch(() => false)));
    const todo = ready.filter((s, i) => !again[i]);
    ready.forEach((s, i) => again[i] && done.add(s.id));
    if (!todo.length) continue;
    const calls = await Promise.all(todo.map((s) => s.tx()));
    const items = todo.flatMap((s, i) => (calls[i] ? [{ title: s.title, call: calls[i] as TxCall }] : []));
    await sender.sendAll(items);
    sent += items.length;
    todo.forEach((s) => done.add(s.id));
  }
  return sent;
}

// --- The demo org ------------------------------------------------------------------------------

export type OrgLevel = {
  name: string;
  label: string;
  /** Parent name, or null for the company. */
  parent: string | null;
  kind: "company" | "department" | "team" | "squad";
  bundle: Bundle;
};

/**
 * mia's key is derived from the admin's key, so only the admin (and tests that
 * have it) can sign as her. Her budget is $10 of Codex.
 */
export const miaAccount = (adminKey: Hex) => privateKeyToAccount(keccak256(concat([adminKey, stringToHex("mia")])));

/** mia's first key was keccak256("mia"), which anyone can compute; org-setup replaces a mia still held by it. */
export const LEGACY_MIA = privateKeyToAccount(keccak256(stringToBytes("mia"))).address;

/**
 * The pre-generated tree (scripts/org-setup.ts). One admin wallet owns every
 * level down to the teams; the launch squad is also reachable, non-canonically,
 * as launch.growth.marketing.<org>.eth.
 */
export function orgPlan(org: string, miaOwner: Address) {
  const root = `${org}.eth`;
  const lvl = (label: string, parent: string | null, kind: OrgLevel["kind"], bundle: Omit<Bundle, "period">): OrgLevel => ({
    name: parent ? `${label}.${parent}` : root,
    label,
    parent,
    kind,
    bundle: { period: "month", ...bundle },
  });
  const eng = `eng.${root}`;
  const marketing = `marketing.${root}`;
  const business = `business.${root}`;
  const dev = `dev.${eng}`;
  const growth = `growth.${marketing}`;
  const levels: OrgLevel[] = [
    lvl(org, null, "company", { keys: [...PROVIDER_IDS], caps: { claude: 1000, codex: 2000, gemini: 500 }, maxes: { "openai-images": 1000, stripe: 10000 } }),
    lvl("eng", root, "department", {
      keys: ["claude", "codex", "openai-images", "gemini", "github", "railway", "vercel", "linear", "mock"],
      caps: { claude: 500, codex: 1000, gemini: 200 },
      maxes: { "openai-images": 200 },
    }),
    lvl("dev", eng, "team", { keys: ["codex", "openai-images", "github", "vercel", "linear", "mock"], caps: { codex: 300 }, maxes: { "openai-images": 50 } }),
    lvl("platform", eng, "team", { keys: ["claude", "github", "railway", "vercel"], caps: { claude: 200 } }),
    lvl("marketing", root, "department", {
      keys: ["codex", "openai-images", "gemini", "canva", "hubspot", "mailchimp"],
      caps: { codex: 200, gemini: 100 },
      maxes: { "openai-images": 500 },
    }),
    lvl("content", marketing, "team", { keys: ["codex", "openai-images", "canva"], caps: { codex: 50 }, maxes: { "openai-images": 300 } }),
    lvl("growth", marketing, "team", { keys: ["codex", "hubspot", "mailchimp", "gemini"], caps: { codex: 50, gemini: 50 } }),
    lvl("business", root, "department", { keys: ["stripe", "notion", "slack", "hubspot", "codex"], caps: { codex: 100 }, maxes: { stripe: 5000 } }),
    lvl("sales", business, "team", { keys: ["hubspot", "slack", "notion"], caps: {} }),
    lvl("finance", business, "team", { keys: ["stripe", "notion"], caps: {}, maxes: { stripe: 1000 } }),
    lvl("launch", dev, "squad", { keys: ["codex", "openai-images"], caps: { codex: 50 }, maxes: { "openai-images": 20 } }),
  ];
  const launch = `launch.${dev}`;
  return {
    root,
    levels,
    teams: levels.filter((l) => l.kind === "team"),
    launch,
    /** An entry in growth's registry whose subregistry is the launch squad's registry. */
    alias: { name: `launch.${growth}`, label: "launch", parent: growth, target: launch, bundle: { keys: ["codex"], caps: { codex: 10 }, period: "month" } as Bundle },
    mia: { name: `mia.${launch}`, label: "mia", parent: launch, owner: miaOwner, bundle: { keys: ["codex"], caps: { codex: 10 }, period: "month" } as Bundle },
    /** Labels demo-reset keeps, per registry owner's name. */
    keep: new Map<string, Set<string>>([
      [dev, new Set(["launch"])],
      [growth, new Set(["launch"])],
      [launch, new Set(["mia"])],
    ]),
  };
}

export type OrgPlan = ReturnType<typeof orgPlan>;
