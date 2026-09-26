// What an agent may do, as the approvals rules compare it: its provider
// bundle, its blockchain grant (the `relay.chain` record), its ENS expiry and
// its owner. Pure: no I/O.
//
// The chain grant is read here only to compare two grants field by field
// (lib/chain/grant.ts is the authority that enforces it). Parsing is strict in
// the same way: an unknown key or a malformed field makes the grant unreadable,
// which compares as "no chain access".

import { type Address, isAddress } from "viem";

import { type Bundle, PERIODS, type Period, isProviderId } from "../bundle";

/** The fields of a `relay.chain` grant (see lib/chain/grant.ts). Amounts are decimal strings in STD. */
export type ChainScope = {
  v: 1;
  caps: string[];
  net: string[];
  contracts: string[];
  methods: Record<string, string[]>;
  /** Recipients: lowercase 0x addresses or workspace names, as written. Absent = this level sets none. */
  to?: string[];
  max?: string;
  limit?: string;
  period?: Period;
  gas?: string;
  exp?: number;
  delegate?: boolean;
  approve?: string;
};

/** The scope of one agent level. */
export type ScopeView = {
  bundle: Bundle | null;
  chain: ChainScope | null;
  /**
   * The level has a non-empty `relay.chain` record the rules can't read. The
   * enforcement parser may still accept it, so this never compares as "no
   * access": the rules flag it (critical R9). Absent when readable or empty.
   */
  chainUnreadable?: true;
  /** ENS expiry, unix seconds. */
  expiry: number | null;
  owner: Address | null;
};

const GRANT_KEYS = ["v", "caps", "net", "contracts", "methods", "to", "max", "limit", "period", "gas", "exp", "delegate", "approve"] as const;
// The same bounds as lib/chain/grant.ts parseGrant (AMOUNT / INT): a record the enforcement layer
// accepts must be readable here, or an expansion could slip past the rules.
const DECIMAL = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;
const INT = /^(?:0|[1-9]\d{0,29})$/;

const strList = (v: unknown, max = 64): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 80) ? [...new Set(v.map((s: string) => s.trim().toLowerCase()))] : null;

/** Parses a grant object (or its JSON text); null when it isn't a readable grant. */
export function readChainScope(input: unknown): ChainScope | null {
  let obj: unknown = input;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text || text.length > 4096) return null;
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (Object.keys(o).some((k) => !(GRANT_KEYS as readonly string[]).includes(k))) return null;
  if (o.v !== 1) return null;
  const caps = strList(o.caps);
  const net = strList(o.net);
  const contracts = strList(o.contracts);
  if (!caps || !net || !contracts) return null;
  const methods: Record<string, string[]> = {};
  if (o.methods !== undefined) {
    if (!o.methods || typeof o.methods !== "object" || Array.isArray(o.methods)) return null;
    for (const [k, v] of Object.entries(o.methods as Record<string, unknown>)) {
      const list = v === undefined ? [] : Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 80) ? [...new Set(v as string[])] : null;
      if (!list) return null;
      methods[k.toLowerCase()] = list;
    }
  }
  const out: ChainScope = { v: 1, caps, net, contracts, methods };
  if (o.to !== undefined) {
    const to = strList(o.to);
    if (!to) return null;
    out.to = to;
  }
  for (const k of ["max", "limit"] as const) {
    if (o[k] === undefined) continue;
    const s = typeof o[k] === "number" ? String(o[k]) : o[k];
    if (typeof s !== "string" || !DECIMAL.test(s)) return null;
    out[k] = s;
  }
  if (o.gas !== undefined) {
    const s = typeof o.gas === "number" ? String(o.gas) : o.gas;
    if (typeof s !== "string" || !INT.test(s)) return null;
    out.gas = s;
  }
  if (o.period !== undefined) {
    if (typeof o.period !== "string" || !(PERIODS as readonly string[]).includes(o.period)) return null;
    out.period = o.period as Period;
  }
  if (o.exp !== undefined) {
    if (typeof o.exp !== "number" || !Number.isSafeInteger(o.exp) || o.exp < 0) return null;
    out.exp = o.exp;
  }
  if (o.delegate !== undefined) {
    if (typeof o.delegate !== "boolean") return null;
    out.delegate = o.delegate;
  }
  if (o.approve !== undefined) {
    if (typeof o.approve !== "string" || !/^(always|never|above:(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?)$/.test(o.approve)) return null;
    out.approve = o.approve;
  }
  return out;
}

/** Compact JSON in the canonical key order (the `relay.chain` record text for an approved scope). */
export function chainScopeText(s: ChainScope): string {
  const o: Record<string, unknown> = {};
  for (const k of GRANT_KEYS) if (s[k] !== undefined) o[k] = s[k];
  return JSON.stringify(o);
}

/** STD decimal string → base units (18 decimals). */
export function toBase(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18) || "0");
}

/** A recipient as compared: lowercase address, or a workspace name resolved to one when known. */
export function resolveRecipient(r: string, known: Record<string, Address>): string {
  const lower = r.toLowerCase();
  if (isAddress(lower, { strict: false })) return lower;
  const hit = Object.entries(known).find(([name]) => name.toLowerCase() === lower);
  return hit ? hit[1].toLowerCase() : lower;
}

/** The scope of a chain level as the rules see it. */
export function scopeOf(level: { bundle: Bundle | null; chain?: string | null; expiry: number | null; owner: Address | null }): ScopeView {
  const chain = readChainScope(level.chain ?? null);
  const present = typeof level.chain === "string" && level.chain.trim() !== "";
  return { bundle: level.bundle, chain, ...(present && !chain ? { chainUnreadable: true as const } : {}), expiry: level.expiry, owner: level.owner };
}

/** Stable JSON of a scope (sorted keys), for equality and hashing. */
export function scopeKey(s: ScopeView): string {
  return stableJson({
    bundle: s.bundle ? { keys: [...s.bundle.keys].sort(), caps: s.bundle.caps, maxes: s.bundle.maxes ?? {}, period: s.bundle.period } : null,
    chain: s.chain,
    chainUnreadable: s.chainUnreadable || undefined,
    expiry: s.expiry,
    owner: s.owner?.toLowerCase() ?? null,
  });
}

/** JSON with object keys sorted at every depth (arrays keep their order). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** Parses a bundle object from a request body; null when malformed (unknown providers, negative limits). */
export function readBundle(input: unknown): Bundle | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (!Array.isArray(o.keys) || !o.keys.every((k) => typeof k === "string" && isProviderId(k))) return null;
  const period = o.period ?? "month";
  if (typeof period !== "string" || !(PERIODS as readonly string[]).includes(period)) return null;
  const limits = (raw: unknown, int: boolean): Record<string, number> | null => {
    if (raw === undefined) return {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!isProviderId(k) || typeof v !== "number" || !Number.isFinite(v) || v < 0 || (int && !Number.isInteger(v))) return null;
      out[k] = v;
    }
    return out;
  };
  const caps = limits(o.caps, false);
  const maxes = limits(o.maxes, true);
  if (!caps || !maxes) return null;
  return { keys: [...new Set(o.keys as Bundle["keys"])], caps, maxes, period: period as Period };
}
