// The blockchain workspace: which network, token, treasury vault, relay signer, approved deploy
// template and named recipients the relay works with. Written by `npm run chain:setup` to
// org/chain.json (committed; addresses and hashes only, never keys) and loaded here.
//
// Loading fails closed: a missing file, bad JSON, an unknown field or a malformed value all give
// null (no chain features). The relay signer's key is only in MULTIBAAS_SIGNER_PRIVATE_KEY.

import fs from "node:fs";
import path from "node:path";

import { type Address, type Hex, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type ContractKind = "token" | "vault" | "escrow";
export const CONTRACT_KINDS: readonly ContractKind[] = ["token", "vault", "escrow"];

export type ChainWorkspace = {
  v: 1;
  network: { name: "sepolia"; chainId: 11155111; mbChain: "ethereum"; explorer: "https://sepolia.etherscan.io" };
  token: { address: Address; label: "relay-token"; symbol: "STD"; name: "Soda Test Dollar"; decimals: 18 };
  vault: { address: Address; label: "relay-vault"; owner: Address; deployBlock: number };
  /** The relay signer's address (its key: MULTIBAAS_SIGNER_PRIVATE_KEY). */
  signer: Address;
  templates: { escrow: { label: "relay-escrow"; version: string; bytecodeHash: Hex; abiHash: Hex; networks: ["sepolia"] } };
  /** Named payment recipients, e.g. { supplier: "0x…", contractor: "0x…" }. */
  recipients: Record<string, Address>;
  /** Whole-token thresholds for the monitor, e.g. { largeTransfer: "50" }. */
  monitor: { largeTransfer: string };
  /** Seed transactions (evidence for the README). */
  seed: { txs: { what: string; hash: Hex }[] };
};

export const NETWORK: ChainWorkspace["network"] = {
  name: "sepolia",
  chainId: 11155111,
  mbChain: "ethereum",
  explorer: "https://sepolia.etherscan.io",
};
export const TOKEN_META = { label: "relay-token", symbol: "STD", name: "Soda Test Dollar", decimals: 18 } as const;
export const VAULT_LABEL = "relay-vault" as const;
export const ESCROW_LABEL = "relay-escrow" as const;

/** Default location, relative to the working directory (override: RELAY_CHAIN_CONFIG). */
export const CHAIN_CONFIG_FILE = "org/chain.json";

/** A recipient name: lowercase label, e.g. "supplier". */
export const RECIPIENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A whole-token decimal amount, e.g. "5" or "0.5" (≤ 18 decimals). */
export const TOKEN_AMOUNT = /^(0|[1-9]\d{0,29})(\.\d{1,18})?$/;
const HEX32 = /^0x[0-9a-f]{64}$/;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
/** Exactly these keys (fail closed on unknown fields). */
const keysAre = (o: Json, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const addr = (v: unknown): Address | null => (typeof v === "string" && isAddress(v, { strict: false }) && BigInt(v) !== 0n ? getAddress(v) : null);
const hash32 = (v: unknown): Hex | null => (typeof v === "string" && HEX32.test(v.toLowerCase()) ? (v.toLowerCase() as Hex) : null);

/** Validates a parsed org/chain.json; null on anything unexpected. */
export function parseChainWorkspace(raw: unknown): ChainWorkspace | null {
  if (!isObj(raw) || !keysAre(raw, ["v", "network", "token", "vault", "signer", "templates", "recipients", "monitor", "seed"]) || raw.v !== 1) return null;

  const n = raw.network;
  if (!isObj(n) || !keysAre(n, ["name", "chainId", "mbChain", "explorer"])) return null;
  if (n.name !== NETWORK.name || n.chainId !== NETWORK.chainId || n.mbChain !== NETWORK.mbChain || n.explorer !== NETWORK.explorer) return null;

  const t = raw.token;
  if (!isObj(t) || !keysAre(t, ["address", "label", "symbol", "name", "decimals"])) return null;
  const tokenAddress = addr(t.address);
  if (!tokenAddress || t.label !== TOKEN_META.label || t.symbol !== TOKEN_META.symbol || t.name !== TOKEN_META.name || t.decimals !== TOKEN_META.decimals) return null;

  const v = raw.vault;
  if (!isObj(v) || !keysAre(v, ["address", "label", "owner", "deployBlock"])) return null;
  const vaultAddress = addr(v.address);
  const vaultOwner = addr(v.owner);
  if (!vaultAddress || !vaultOwner || v.label !== VAULT_LABEL) return null;
  if (typeof v.deployBlock !== "number" || !Number.isSafeInteger(v.deployBlock) || v.deployBlock < 0) return null;

  const signer = addr(raw.signer);
  if (!signer) return null;

  const tpl = raw.templates;
  if (!isObj(tpl) || !keysAre(tpl, ["escrow"]) || !isObj(tpl.escrow)) return null;
  const e = tpl.escrow;
  if (!keysAre(e, ["label", "version", "bytecodeHash", "abiHash", "networks"]) || e.label !== ESCROW_LABEL) return null;
  if (typeof e.version !== "string" || !/^[0-9A-Za-z._-]{1,32}$/.test(e.version)) return null;
  const bytecodeHash = hash32(e.bytecodeHash);
  const abiHash = hash32(e.abiHash);
  if (!bytecodeHash || !abiHash) return null;
  if (!Array.isArray(e.networks) || e.networks.length !== 1 || e.networks[0] !== "sepolia") return null;

  if (!isObj(raw.recipients)) return null;
  const recipients: Record<string, Address> = {};
  for (const [name, a] of Object.entries(raw.recipients)) {
    const address = addr(a);
    if (!RECIPIENT_NAME.test(name) || !address) return null;
    recipients[name] = address;
  }
  if (Object.keys(recipients).length > 32) return null;

  const m = raw.monitor;
  if (!isObj(m) || !keysAre(m, ["largeTransfer"]) || typeof m.largeTransfer !== "string" || !TOKEN_AMOUNT.test(m.largeTransfer)) return null;

  const s = raw.seed;
  if (!isObj(s) || !keysAre(s, ["txs"]) || !Array.isArray(s.txs) || s.txs.length > 64) return null;
  const txs: { what: string; hash: Hex }[] = [];
  for (const x of s.txs) {
    if (!isObj(x) || !keysAre(x, ["what", "hash"]) || typeof x.what !== "string" || x.what.length > 200) return null;
    const h = hash32(x.hash);
    if (!h) return null;
    txs.push({ what: x.what, hash: h });
  }

  return {
    v: 1,
    network: { ...NETWORK },
    token: { address: tokenAddress, ...TOKEN_META },
    vault: { address: vaultAddress, label: VAULT_LABEL, owner: vaultOwner, deployBlock: v.deployBlock },
    signer,
    templates: { escrow: { label: ESCROW_LABEL, version: e.version, bytecodeHash, abiHash, networks: ["sepolia"] } },
    recipients,
    monitor: { largeTransfer: m.largeTransfer },
    seed: { txs },
  };
}

/** The workspace file's path: RELAY_CHAIN_CONFIG, else org/chain.json in the working directory. */
export function chainConfigPath(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.RELAY_CHAIN_CONFIG?.trim() || CHAIN_CONFIG_FILE);
}

let cache: { file: string; mtimeMs: number; size: number; ws: ChainWorkspace | null } | null = null;

/** Reads org/chain.json (or RELAY_CHAIN_CONFIG); null if absent or invalid. Re-read when the file changes. */
export function loadChainWorkspace(env: Record<string, string | undefined> = process.env): ChainWorkspace | null {
  const file = chainConfigPath(env);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > 256 * 1024) return null;
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.ws;
  let ws: ChainWorkspace | null = null;
  try {
    ws = parseChainWorkspace(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    ws = null;
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, ws };
  return ws;
}

/** The workspace as the committed file's text (stable key order, trailing newline). */
export function serializeChainWorkspace(ws: ChainWorkspace): string {
  const checked = parseChainWorkspace(JSON.parse(JSON.stringify(ws)));
  if (!checked) throw new Error("invalid chain workspace");
  return `${JSON.stringify(checked, null, 2)}\n`;
}

/** MULTIBAAS_SIGNER_PRIVATE_KEY as 0x + 64 lowercase hex, or null when unset or not a valid key. */
export function signerKey(env: Record<string, string | undefined> = process.env): Hex | null {
  const raw = env.MULTIBAAS_SIGNER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`).toLowerCase();
  if (!HEX32.test(key)) return null;
  try {
    privateKeyToAccount(key as Hex);
  } catch {
    return null;
  }
  return key as Hex;
}

/** The workspace address of a contract kind (escrows are deployed at runtime: null). */
export function contractAddress(ws: ChainWorkspace, kind: ContractKind): Address | null {
  return kind === "token" ? ws.token.address : kind === "vault" ? ws.vault.address : null;
}

/** A named recipient's address, or a checksummed address as given; null otherwise. */
export function resolveRecipient(ws: ChainWorkspace, nameOrAddress: string): Address | null {
  const s = nameOrAddress.trim();
  if (RECIPIENT_NAME.test(s)) return Object.hasOwn(ws.recipients, s) ? ws.recipients[s] : null;
  return addr(s);
}

/** The recipient's name when it is a named one. */
export function recipientName(ws: ChainWorkspace, address: string): string | null {
  const a = address.toLowerCase();
  for (const [name, r] of Object.entries(ws.recipients)) if (r.toLowerCase() === a) return name;
  return null;
}

export const explorerTx = (ws: Pick<ChainWorkspace, "network">, hash: string) => `${ws.network.explorer}/tx/${hash}`;
export const explorerAddress = (ws: Pick<ChainWorkspace, "network">, a: string) => `${ws.network.explorer}/address/${a}`;
