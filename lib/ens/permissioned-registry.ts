// Helpers for the Permissioned Registry playground (see /ensv2/permissioned-registry).
// Everything here mirrors contracts-v2@71a3b73: src/registry/PermissionedRegistry.sol and
// src/access-control/EnhancedAccessControl.sol.

import {
  type Address,
  type Hex,
  type PublicClient,
  bytesToString,
  formatLog,
  getAbiItem,
  getAddress,
  hexToBytes,
  numberToHex,
  parseEventLogs,
  toEventSelector,
} from "viem";

import { ETHRegistryAbi } from "./abis/ETHRegistry";
import { ENSV2_SEPOLIA } from "./deployments";
import { canonicalId, labelId, parseUint256, tryNormalize, withVersion } from "./names";
import { ALL_ROLES, UNEMANCIPATED_ROLE_BITMAP } from "./roles";

/** ETHRegistry and RootRegistry are both plain PermissionedRegistry deployments; same ABI. */
export const permissionedRegistryAbi = ETHRegistryAbi;

export const STATUS = ["AVAILABLE", "RESERVED", "REGISTERED"] as const;
export type StatusName = (typeof STATUS)[number];
export const statusTone = (s: number) => (s === 2 ? "success" : s === 1 ? "warning" : "neutral") as "success" | "warning" | "neutral";

export const MAX_UINT64 = (1n << 64n) - 1n;

/** ERC-165 selectors from the interface NatSpec. */
export const INTERFACE_IDS = {
  IRegistry: "0x51f67f40",
  IOwnedRegistry: "0x63560a8e",
  ITemporalRegistry: "0x6f537c72",
  ITokenizedRegistry: "0x91b3c037",
  IStandardRegistry: "0xb844ab6c",
  IPermissionedRegistry: "0xc18bd555",
  IEnhancedAccessControl: "0x0132e43d",
  IUnsafeTransferable: "0x35aee916",
  IWrapperRegistry: "0xf5586a0b",
} as const;

export const ROOT_REGISTRY = ENSV2_SEPOLIA.RootRegistry.address;
export const ETH_REGISTRY = ENSV2_SEPOLIA.ETHRegistry.address;

/** Earliest ENSv2 deploy block; every ENSv2 registry on Sepolia was created after it. */
export const ENSV2_START_BLOCK = Object.values(ENSV2_SEPOLIA).reduce<bigint>((min, d) => {
  const b: bigint | undefined = "deployBlock" in d ? d.deployBlock : undefined;
  return b !== undefined && b < min ? b : min;
}, ENSV2_SEPOLIA.RootRegistry.deployBlock);

export type RegistryPreset = { key: string; label: string; address: Address; hint: string };


const ENSFORGE_REGISTRY: Address = "0xe364936aE304a8d19EF272bC246caC95CCBE6B78";

export const REGISTRY_PRESETS: RegistryPreset[] = [
  { key: "eth", label: "ETHRegistry", address: ETH_REGISTRY, hint: ".eth 2LDs (emancipated)" },
  { key: "root", label: "RootRegistry", address: ROOT_REGISTRY, hint: "TLDs" },
  { key: "ensforge", label: "ensforge.eth registry", address: ENSFORGE_REGISTRY, hint: "example UserRegistry proxy (someone else's)" },
];

/** Labels showing interesting states in each preset registry on Sepolia (checked 2026-09-26). */
export const EXAMPLE_LABELS: Record<string, { label: string; note: string }[]> = {
  [ETH_REGISTRY]: [
    { label: "ensforge", note: "registered" },
    { label: "nick", note: "reserved (v1 migration)" },
    { label: "rustyfish", note: "expired reservation" },
    { label: "manic", note: "registered" },
  ],
  [ROOT_REGISTRY]: [
    { label: "eth", note: "registered, never expires" },
    { label: "com", note: "reserved" },
    { label: "reverse", note: "registered" },
  ],
  [ENSFORGE_REGISTRY]: [
    { label: "branch", note: "has a subregistry" },
    { label: "profile", note: "token regenerated" },
    { label: "different-owner", note: "registered" },
  ],
};

const KNOWN: Record<string, string> = Object.fromEntries(
  Object.entries(ENSV2_SEPOLIA).map(([name, d]) => [d.address.toLowerCase(), name]),
);

/** Deployment name for ENSv2 contract addresses, e.g. "ETHRegistrar". */
export const knownName = (a?: string | null) => (a ? KNOWN[a.toLowerCase()] : undefined);

export const deployBlockOf = (registry: Address): bigint => {
  const name = knownName(registry) as keyof typeof ENSV2_SEPOLIA | undefined;
  const d = name ? ENSV2_SEPOLIA[name] : undefined;
  return (d && "deployBlock" in d ? d.deployBlock : undefined) ?? ENSV2_START_BLOCK;
};

// --- EAC bitmap math ------------------------------------------------------

/** EACBaseRolesLib.fromCounts: roles with at least one assignee. */
export const rolesFromCounts = (counts: bigint) => (counts | (counts >> 1n) | (counts >> 2n) | (counts >> 3n)) & ALL_ROLES;

/** EACBaseRolesLib.withAdminRolesApplied: admin roles imply their regular role; regular roles are dropped. */
export const withAdminRolesApplied = (bitmap: bigint) => {
  const admin = bitmap >> 128n;
  return (admin << 128n) | admin;
};

/**
 * PermissionedRegistry._getSettableRoles on a name: nothing unless the name has
 * a live owner, and only regular roles whose admin the caller holds (root or name).
 */
export const settableNameRoles = (effective: bigint, hasOwner: boolean) =>
  hasOwner ? withAdminRolesApplied(effective) >> 128n : 0n;

/** Settable/revokable on ROOT_RESOURCE, and revokable on names (not overridden). */
export const adminScope = (effective: bigint) => withAdminRolesApplied(effective);

/** Roles in `bitmap` whose assignee count in `counts` equals `count`. */
export function rolesWithCount(bitmap: bigint, counts: bigint, count: number) {
  let out = 0n;
  for (let n = 0n; n < 64n; n++) {
    const bit = 1n << (n * 4n);
    if (bitmap & bit && Number((counts >> (n * 4n)) & 0xfn) === count) out |= bit;
  }
  return out;
}

/** Roles in `bitmap` already at 15 holders: granting them reverts EACMaxAssignees. */
export const saturatedRoles = (bitmap: bigint, counts: bigint) => rolesWithCount(bitmap, counts, 15);

export const dangerousHeld = (rootCounts: bigint) => rolesFromCounts(rootCounts) & UNEMANCIPATED_ROLE_BITMAP;

// --- Inputs ---------------------------------------------------------------

export type NameRef =
  | { kind: "label"; label: string; changed: boolean; anyId: bigint }
  | { kind: "id"; anyId: bigint }
  | { kind: "name"; name: string }
  | { kind: "error"; error: string };

/**
 * A label ("nick"), a uint256 anyId (hex, or decimal with 30+ digits so short
 * numeric labels like "123" stay labels) or a full name ("nick.eth").
 */
export function parseNameRef(input: string): NameRef | null {
  const s = input.trim();
  if (!s) return null;
  if (/^0x[0-9a-fA-F]{1,64}$/.test(s) || /^\d{30,78}$/.test(s)) {
    const id = parseUint256(s);
    return id === null ? { kind: "error", error: "Not a uint256." } : { kind: "id", anyId: id };
  }
  const norm = tryNormalize(s);
  if (norm === null) return { kind: "error", error: "Not a valid ENS name/label (ENSIP-15 normalization failed)." };
  if (norm.includes(".")) return { kind: "name", name: norm };
  return { kind: "label", label: norm, changed: norm !== s, anyId: labelId(norm) };
}

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

// --- Names & time ---------------------------------------------------------

/** Decodes DNS wire format (as returned by UniversalHelper.findCanonicalName). */
export function decodeDnsName(hex: Hex): string | null {
  const b = hexToBytes(hex);
  if (b.length === 0) return null;
  const labels: string[] = [];
  let i = 0;
  while (i < b.length && b[i] !== 0) {
    const len = b[i];
    labels.push(bytesToString(b.slice(i + 1, i + 1 + len)));
    i += len + 1;
  }
  return labels.join(".");
}

/** `label` under a registry whose canonical name is `parent` ("" for the root). */
export const joinName = (label: string, parent: string | null | undefined) =>
  parent === undefined || parent === null ? null : parent === "" ? label : `${label}.${parent}`;

export function relTime(sec: bigint, now: number): string {
  if (!now) return "";
  const d = Number(sec) - now;
  const a = Math.abs(d);
  const units: [number, string][] = [
    [31557600, "y"],
    [2629800, "mo"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  let text = `${a}s`;
  for (const [n, u] of units) {
    if (a >= n) {
      text = `${(a / n).toFixed(a / n < 10 ? 1 : 0)}${u}`;
      break;
    }
  }
  return d >= 0 ? `in ${text}` : `${text} ago`;
}

export function formatTimestamp(sec: bigint): string {
  if (sec === 0n) return "0 (never set)";
  if (sec >= MAX_UINT64) return "max uint64 (never expires)";
  if (sec > 253402300799n) return sec.toString();
  return new Date(Number(sec) * 1000).toISOString().replace(".000Z", "Z");
}

/** Splits an ID into its labelhash-derived upper 224 bits and its 32-bit version. */
export const splitId = (id: bigint) => ({
  upper: (id >> 32n).toString(16).padStart(56, "0"),
  version: Number(id & 0xffffffffn),
});

export const hex256 = (v: bigint) => numberToHex(v, { size: 32 });

// --- Logs (chunked; public RPC caps eth_getLogs at 50k blocks) -------------

const CHUNK = 49_999n;

async function chunked<T>(
  from: bigint,
  to: bigint,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<T[]> {
  const out: T[] = [];
  const total = Number((to - from) / (CHUNK + 1n)) + 1;
  let i = 0;
  for (let b = from; b <= to; b += CHUNK + 1n) {
    const end = b + CHUNK > to ? to : b + CHUNK;
    out.push(...(await fetch(b, end)));
    onProgress?.(++i, total);
  }
  return out;
}

export type RoleHolder = { account: Address; roles: bigint; block: bigint };

/** Current role holders of `resource`, rebuilt from EACRolesChanged (last event per account wins). */
export async function loadRoleHolders(
  client: PublicClient,
  registry: Address,
  resource: bigint,
  fromBlock: bigint,
  onProgress?: (done: number, total: number) => void,
): Promise<RoleHolder[]> {
  const latest = await client.getBlockNumber();
  const logs = await chunked(
    fromBlock,
    latest,
    (f, t) =>
      client.getContractEvents({
        address: registry,
        abi: permissionedRegistryAbi,
        eventName: "EACRolesChanged",
        args: { resource },
        fromBlock: f,
        toBlock: t,
      }),
    onProgress,
  );
  const byAccount = new Map<string, RoleHolder>();
  for (const l of logs) {
    const account = getAddress(l.args.account!);
    byAccount.set(account, { account, roles: l.args.newRoleBitmap!, block: l.blockNumber });
  }
  return [...byAccount.values()].filter((h) => h.roles !== 0n);
}

const HISTORY_EVENTS = [
  "LabelRegistered",
  "LabelReserved",
  "LabelUnregistered",
  "ExpiryUpdated",
  "SubregistryUpdated",
  "ResolverUpdated",
  "TokenRegenerated",
  "TokenResource",
  "EACRolesChanged",
] as const;

export type HistoryEntry = {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  eventName: string;
  args: Record<string, unknown>;
};

/**
 * Every event whose first indexed topic is one of the name's token IDs or
 * resources. Both are `canonicalId | version`, so enumerating versions
 * 0..maxVersion covers the name's whole history without scanning the
 * registry's other names. (ERC1155 TransferSingle is not included: its id is
 * not indexed.)
 */
export async function loadNameHistory(
  client: PublicClient,
  registry: Address,
  anyId: bigint,
  maxVersion: number,
  fromBlock: bigint,
  onProgress?: (done: number, total: number) => void,
): Promise<HistoryEntry[]> {
  const canon = canonicalId(anyId);
  const first = Math.max(0, maxVersion - 99);
  const ids: Hex[] = [];
  for (let v = first; v <= maxVersion; v++) ids.push(hex256(withVersion(canon, v)));
  const sigs = HISTORY_EVENTS.map((name) => toEventSelector(getAbiItem({ abi: permissionedRegistryAbi, name })));
  const latest = await client.getBlockNumber();
  const raw = await chunked(
    fromBlock,
    latest,
    (f, t) =>
      client.request({
        method: "eth_getLogs",
        params: [{ address: registry, topics: [sigs, ids], fromBlock: numberToHex(f), toBlock: numberToHex(t) }],
      }),
    onProgress,
  );
  const parsed = parseEventLogs({ abi: permissionedRegistryAbi, logs: raw.map((l) => formatLog(l)) });
  return parsed.map((l) => ({
    blockNumber: l.blockNumber,
    logIndex: l.logIndex,
    transactionHash: l.transactionHash,
    eventName: l.eventName,
    args: l.args as Record<string, unknown>,
  }));
}

export type RecentLabel = { label: string; kind: "registered" | "reserved"; owner?: Address; expiry: bigint; block: bigint };

const RECENT_EVENTS = [
  getAbiItem({ abi: permissionedRegistryAbi, name: "LabelRegistered" }),
  getAbiItem({ abi: permissionedRegistryAbi, name: "LabelReserved" }),
] as const;

/** LabelRegistered / LabelReserved within the last `blocks` blocks, newest first. */
export async function loadRecentLabels(client: PublicClient, registry: Address, blocks: bigint): Promise<RecentLabel[]> {
  const latest = await client.getBlockNumber();
  const from = latest > blocks ? latest - blocks + 1n : 0n;
  const logs = await chunked(from, latest, (f, t) =>
    client.getLogs({ address: registry, events: RECENT_EVENTS, fromBlock: f, toBlock: t }),
  );
  return logs
    .map(
      (l): RecentLabel =>
        l.eventName === "LabelRegistered"
          ? { label: l.args.label!, kind: "registered", owner: l.args.owner, expiry: l.args.expiry!, block: l.blockNumber }
          : { label: l.args.label!, kind: "reserved", expiry: l.args.expiry!, block: l.blockNumber },
    )
    .reverse();
}
