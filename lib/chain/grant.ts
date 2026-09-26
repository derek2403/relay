// The `relay.chain` record: what a name may do on-chain, written by the level
// above (on the parent's resolver, like the bundle). A child's effective grant
// is the intersection of every grant from the root down to it, plus any
// relay-side approved scope (a guard overlay) as an extra virtual level.
//
// Parsing fails closed: a missing, oversized, unparseable record, or one with an
// unknown key, value or method, reads as "no blockchain access" (null).
// Amounts are whole-token decimal strings in the record ("5", "0.5") and bigint
// base units everywhere a check is made.

import { type Address, type Hex, concat, encodePacked, getAddress, isAddress, isAddressEqual, keccak256, stringToHex, zeroAddress } from "viem";

import { type Period, PERIODS } from "../relay/bundle";
import type { Overlay } from "../relay/guard";
import type { ChainWorkspace } from "./config";

export const CAPS = ["read", "track", "prepare", "submit", "deploy", "manage"] as const;
export type ChainCap = (typeof CAPS)[number];
export const NETWORKS = ["sepolia"] as const;
export type ChainNetwork = (typeof NETWORKS)[number];
export const CONTRACT_KINDS = ["token", "vault", "escrow"] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/**
 * The write methods a grant may ever list, per contract kind. Owner/admin
 * functions (vault.setRecipient, escrow.transferAdmin, token.mint…) are never
 * grantable: a record listing one is invalid.
 */
export const WRITE_METHODS: Record<ContractKind, readonly string[]> = {
  token: ["transfer"],
  vault: ["pay"],
  escrow: ["pause", "unpause", "release", "refund"],
};

/** Longest record accepted (same bound as lib/relay/bundle MAX_CHAIN_RECORD). */
export const MAX_GRANT_TEXT = 4096;
/** Token decimals when no workspace is known (STD has 18). */
export const DEFAULT_DECIMALS = 18;

export type ApproveRule = "always" | "never" | `above:${string}`;

/** A parsed, valid `relay.chain` record. Field order here is the canonical serialization order. */
export type ChainGrant = {
  v: 1;
  caps: ChainCap[];
  net: ChainNetwork[];
  contracts: ContractKind[];
  methods: Partial<Record<ContractKind, string[]>>;
  /** Approved payment recipients as written (addresses or workspace names); absent = this level doesn't restrict. */
  to?: string[];
  /** Per-transaction maximum, STD decimal string. */
  max?: string;
  /** Aggregate limit per `period`, STD decimal string; checked against this level's own ledger. */
  limit?: string;
  period?: Period;
  /** Max gas per transaction (decimal integer string). */
  gas?: string;
  /** Unix seconds. */
  exp?: number;
  /** May children receive chain grants. Absent = false. */
  delegate: boolean;
  approve: ApproveRule;
  /** Resolved `to` (checksummed); not serialized. */
  recipients?: Address[];
};

const KEYS = ["v", "caps", "net", "contracts", "methods", "to", "max", "limit", "period", "gas", "exp", "delegate", "approve"] as const;
const AMOUNT = /^(0|[1-9]\d{0,29})(\.\d{1,18})?$/;
const INT = /^(0|[1-9]\d{0,29})$/;

/** A decimal token amount ("5", "0.5") in base units; null when malformed or more precise than `decimals`. */
export function parseAmount(text: unknown, decimals = DEFAULT_DECIMALS): bigint | null {
  if (typeof text !== "string" || !AMOUNT.test(text)) return null;
  const [whole, digits = ""] = text.split(".");
  if (digits.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + (digits ? BigInt(digits.padEnd(decimals, "0")) : 0n);
}

/** Base units as a trimmed decimal string ("3", "0.5"). */
export function formatAmount(base: bigint, decimals = DEFAULT_DECIMALS): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const decimalsOf = (ws: ChainWorkspace | null | undefined) => ws?.token.decimals ?? DEFAULT_DECIMALS;

function stringSet<T extends string>(raw: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(raw) || raw.length > 32) return null;
  const out: T[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || !(allowed as readonly string[]).includes(x)) return null;
    if (!out.includes(x as T)) out.push(x as T);
  }
  return out;
}

/** A recipient entry: an address, or a workspace recipient name. Null when neither. */
export function resolveRecipient(entry: string, ws: ChainWorkspace | null | undefined): Address | null {
  if (isAddress(entry, { strict: false })) return getAddress(entry);
  const named = ws?.recipients && Object.hasOwn(ws.recipients, entry) ? ws.recipients[entry] : undefined;
  return named && isAddress(named, { strict: false }) ? getAddress(named) : null;
}

/**
 * Parses a `relay.chain` record. Null (= no chain access) when missing, too
 * long, not JSON, or when any key, value, method or recipient is unknown.
 */
export function parseGrant(text: string | null | undefined, ws: ChainWorkspace | null | undefined): ChainGrant | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_GRANT_TEXT) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !(KEYS as readonly string[]).includes(k))) return null;
  if (o.v !== 1) return null;

  const caps = stringSet(o.caps, CAPS);
  const net = o.net === undefined ? [] : stringSet(o.net, NETWORKS);
  const contracts = o.contracts === undefined ? [] : stringSet(o.contracts, CONTRACT_KINDS);
  if (!caps || !net || !contracts) return null;

  const methods: Partial<Record<ContractKind, string[]>> = {};
  if (o.methods !== undefined) {
    if (!o.methods || typeof o.methods !== "object" || Array.isArray(o.methods)) return null;
    for (const [kind, list] of Object.entries(o.methods as Record<string, unknown>)) {
      if (!(CONTRACT_KINDS as readonly string[]).includes(kind)) return null;
      const ms = stringSet(list, WRITE_METHODS[kind as ContractKind]);
      if (!ms) return null;
      methods[kind as ContractKind] = ms;
    }
  }

  const g: ChainGrant = { v: 1, caps, net, contracts, methods, delegate: false, approve: "always" };

  if (o.to !== undefined) {
    if (!Array.isArray(o.to) || o.to.length > 32) return null;
    const to: string[] = [];
    const recipients: Address[] = [];
    for (const e of o.to) {
      if (typeof e !== "string") return null;
      const a = resolveRecipient(e, ws);
      if (!a) return null;
      const entry = isAddress(e, { strict: false }) ? a : e;
      if (!to.includes(entry)) to.push(entry);
      if (!recipients.some((r) => isAddressEqual(r, a))) recipients.push(a);
    }
    g.to = to;
    g.recipients = recipients;
  }

  const dec = decimalsOf(ws);
  if (o.max !== undefined) {
    if (parseAmount(o.max, dec) === null) return null;
    g.max = o.max as string;
  }
  if (o.limit !== undefined) {
    if (parseAmount(o.limit, dec) === null) return null;
    if (o.period === undefined) return null; // a limit must say its period
    g.limit = o.limit as string;
  }
  if (o.period !== undefined) {
    if (typeof o.period !== "string" || !(PERIODS as readonly string[]).includes(o.period)) return null;
    g.period = o.period as Period;
  }
  if (o.gas !== undefined) {
    if (typeof o.gas !== "string" || !INT.test(o.gas)) return null;
    g.gas = o.gas;
  }
  if (o.exp !== undefined) {
    if (typeof o.exp !== "number" || !Number.isSafeInteger(o.exp) || o.exp <= 0) return null;
    g.exp = o.exp;
  }
  if (o.delegate !== undefined) {
    if (typeof o.delegate !== "boolean") return null;
    g.delegate = o.delegate;
  }
  if (o.approve !== undefined) {
    if (parseApprove(o.approve, dec) === null) return null;
    g.approve = o.approve as ApproveRule;
  }
  return g;
}

type ApproveParsed = { kind: "always" } | { kind: "never" } | { kind: "above"; base: bigint };

function parseApprove(raw: unknown, decimals: number): ApproveParsed | null {
  if (raw === "always") return { kind: "always" };
  if (raw === "never") return { kind: "never" };
  if (typeof raw === "string" && raw.startsWith("above:")) {
    const base = parseAmount(raw.slice(6), decimals);
    return base === null ? null : { kind: "above", base };
  }
  return null;
}

/** The record text for a grant: compact JSON, canonical key order, optional fields only when set. */
export function serializeGrant(g: Omit<ChainGrant, "recipients">): string {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    const v = (g as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (k === "methods") {
      const m: Record<string, string[]> = {};
      for (const kind of CONTRACT_KINDS) if ((v as Record<string, string[]>)[kind]) m[kind] = (v as Record<string, string[]>)[kind];
      out[k] = m;
    } else out[k] = v;
  }
  return JSON.stringify(out);
}

// --- Effective grant -----------------------------------------------------------------------------

/** One level of the path as the chain layer sees it (root first). `node` = namehash(name). */
export type GrantLevel = { name: string; node: Hex; resource: string | null; resolver: Address | null; chain: string | null | undefined };

/** A level's own aggregate allowance, checked against that level's own ledger. */
export type LevelAllowance = {
  name: string;
  node: Hex;
  resource: string | null;
  grant: ChainGrant;
  /** Per-tx max at this level, base units (null = not set here). */
  max: bigint | null;
  /** Aggregate limit at this level, base units, with its period; null = no aggregate limit here. */
  limit: { base: bigint; period: Period } | null;
  /** Overlay bucket ("approval:<id>") instead of a calendar period; set only for overlay levels. */
  bucket: string | null;
  /** Overlay id when this is a relay-approved scope, not an ENS level. */
  overlay: string | null;
};

export type EffectiveGrant = {
  caps: ChainCap[];
  net: ChainNetwork[];
  contracts: ContractKind[];
  /** Allowed write methods per contract kind (only kinds in `contracts`). */
  methods: Record<ContractKind, string[]>;
  /** Approved recipients (intersection over levels that set `to`); empty when none set = payments denied. */
  recipients: Address[];
  /** Whether any level set `to` at all. */
  recipientsSet: boolean;
  /** Smallest per-tx max, base units; null = none set anywhere (payments denied). */
  maxBase: bigint | null;
  /** Smallest gas cap; null = none set anywhere (writes denied). */
  gas: bigint | null;
  /** Earliest expiry (unix s) and the level it comes from. */
  exp: number | null;
  expLevel: string | null;
  /** Strictest approval rule. */
  approve: ApproveRule;
  decimals: number;
};

export type EffectiveResult = {
  grant: EffectiveGrant | null;
  reason: string | null;
  grantId: Hex;
  perLevel: LevelAllowance[];
};

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const OVERLAY_TAG = keccak256(stringToHex("relay:overlay"));

/**
 * grantId = keccak256(concat per level: node ‖ resolver ‖ resource ‖ keccak256(utf8(record)))
 * with each overlay contributing (tag ‖ keccak256(id) ‖ keccak256(chain text) ‖ notAfter) at its position.
 */
export function grantIdOf(levels: GrantLevel[], overlays: Overlay[] = []): Hex {
  const parts: Hex[] = [];
  const placed = new Set<string>();
  const overlayPart = (o: Overlay) =>
    encodePacked(["bytes32", "bytes32", "bytes32", "uint64"], [OVERLAY_TAG, keccak256(stringToHex(o.id)), keccak256(stringToHex(o.chain ?? "")), BigInt(Math.max(0, Math.floor(o.notAfter)))]);
  for (const l of levels) {
    const resource = l.resource && /^\d+$/.test(l.resource) ? BigInt(l.resource) : 0n;
    parts.push(
      encodePacked(["bytes32", "address", "uint256", "bytes32"], [l.node, l.resolver ?? zeroAddress, resource, keccak256(stringToHex(l.chain ?? ""))]),
    );
    for (const o of overlays) if (o.after === l.name && !placed.has(o.id)) (placed.add(o.id), parts.push(overlayPart(o)));
  }
  for (const o of overlays) if (!placed.has(o.id)) parts.push(overlayPart(o)); // unplaced overlays still change the id
  return keccak256(parts.length ? concat(parts) : "0x");
}

const intersect = <T extends string>(a: T[], b: T[]) => a.filter((x) => b.includes(x));
const RANK = (r: ApproveParsed) => (r.kind === "always" ? 2 : r.kind === "above" ? 1 : 0);

/**
 * The effective grant for the last level of `levels` (root first), with guard
 * overlays applied as extra virtual levels after their `after` level. Null
 * grant with a reason when any level lacks a valid grant, a level above the
 * leaf doesn't delegate, a grant or overlay has expired, or an overlay is
 * unreadable.
 */
export function effectiveGrant(levels: GrantLevel[], overlays: Overlay[], ws: ChainWorkspace | null | undefined, nowSec: number): EffectiveResult {
  const grantId = grantIdOf(levels, overlays);
  const fail = (reason: string): EffectiveResult => ({ grant: null, reason, grantId, perLevel: [] });
  if (!levels.length) return fail("no levels");
  const dec = decimalsOf(ws);

  // Build the chain of grants (ENS levels + overlays) in order.
  type Step = { name: string; node: Hex; resource: string | null; grant: ChainGrant; overlay: Overlay | null; ensIndex: number };
  const steps: Step[] = [];
  for (const o of overlays) {
    if (!levels.some((l) => l.name === o.after)) return fail(`approved scope ${o.id} doesn't match ${levels[levels.length - 1].name}`);
    if (!(o.notAfter > nowSec)) return fail(`approved scope for ${o.name} ended at ${iso(o.notAfter)}; request a renewal`);
  }
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    const g = parseGrant(l.chain, ws);
    if (!g) return fail(`${l.name} has no blockchain grant`);
    steps.push({ name: l.name, node: l.node, resource: l.resource, grant: g, overlay: null, ensIndex: i });
    for (const o of overlays) {
      if (o.after !== l.name) continue;
      // An approved scope with no blockchain grant means no blockchain access (like a null bundle
      // meaning no providers), never "the ENS grant still applies".
      if (o.chain === null) return fail(`the approved scope for ${o.name} gives no blockchain access`);
      const og = parseGrant(o.chain, ws);
      if (!og) return fail(`approved scope for ${o.name} is unreadable`);
      steps.push({ name: o.name, node: l.node, resource: l.resource, grant: og, overlay: o, ensIndex: i });
    }
  }

  const leafIndex = levels.length - 1;
  // Delegation: a grant at a step above the leaf (or an overlay before the leaf) must allow children.
  for (const s of steps) {
    const isLeafStep = s.ensIndex === leafIndex;
    if (!isLeafStep && !s.grant.delegate) return fail(`${s.name} doesn't allow further delegation`);
  }

  let caps = [...CAPS] as ChainCap[];
  let net = [...NETWORKS] as ChainNetwork[];
  let contracts = [...CONTRACT_KINDS] as ContractKind[];
  const methods: Record<ContractKind, string[]> = { token: [...WRITE_METHODS.token], vault: [...WRITE_METHODS.vault], escrow: [...WRITE_METHODS.escrow] };
  let recipients: Address[] | null = null;
  let maxBase: bigint | null = null;
  let gas: bigint | null = null;
  let exp: number | null = null;
  let expLevel: string | null = null;
  let approve: ApproveParsed = { kind: "never" };
  let approveText: ApproveRule = "never";
  const perLevel: LevelAllowance[] = [];

  for (const s of steps) {
    const g = s.grant;
    caps = intersect(caps, g.caps);
    net = intersect(net, g.net);
    contracts = intersect(contracts, g.contracts);
    for (const k of CONTRACT_KINDS) methods[k] = intersect(methods[k], g.methods[k] ?? []);
    if (g.recipients) recipients = recipients === null ? [...g.recipients] : recipients.filter((r) => g.recipients!.some((x) => isAddressEqual(x, r)));
    const max = g.max !== undefined ? parseAmount(g.max, dec) : null;
    if (max !== null && (maxBase === null || max < maxBase)) maxBase = max;
    if (g.gas !== undefined) {
      const gv = BigInt(g.gas);
      if (gas === null || gv < gas) gas = gv;
    }
    if (g.exp !== undefined) {
      if (g.exp <= nowSec) return fail(`${s.name}'s blockchain grant expired at ${iso(g.exp)}`);
      if (exp === null || g.exp < exp) (exp = g.exp), (expLevel = s.name);
    }
    const a = parseApprove(g.approve, dec)!;
    if (RANK(a) > RANK(approve) || (a.kind === "above" && approve.kind === "above" && a.base < approve.base)) (approve = a), (approveText = g.approve);
    const limitBase = g.limit !== undefined ? parseAmount(g.limit, dec) : null;
    perLevel.push({
      name: s.name,
      node: s.node,
      resource: s.resource,
      grant: g,
      max,
      limit: limitBase !== null && g.period ? { base: limitBase, period: g.period } : null,
      bucket: s.overlay ? s.overlay.bucket : null,
      overlay: s.overlay ? s.overlay.id : null,
    });
  }
  for (const k of CONTRACT_KINDS) if (!contracts.includes(k)) methods[k] = [];

  return {
    grant: {
      caps,
      net,
      contracts,
      methods,
      recipients: recipients ?? [],
      recipientsSet: recipients !== null,
      maxBase,
      gas,
      exp,
      expLevel,
      approve: approveText,
      decimals: dec,
    },
    reason: null,
    grantId,
    perLevel,
  };
}

/** Whether a write of `amountBase` (null = not a payment) needs a human approval under the effective rule. */
export function approvalRequirement(eff: EffectiveGrant, amountBase: bigint | null): { required: boolean; rule: string } {
  const a = parseApprove(eff.approve, eff.decimals);
  if (!a || a.kind === "always") return { required: true, rule: "always" };
  if (a.kind === "never") return { required: false, rule: "never" };
  if (amountBase === null) return { required: true, rule: `${eff.approve} (not a payment)` };
  return amountBase > a.base ? { required: true, rule: eff.approve } : { required: false, rule: eff.approve };
}

/** One-paragraph plain-text summary of an effective grant (planner prompt, CLI, logs). */
export function describeGrant(eff: EffectiveGrant | null): string {
  if (!eff) return "no blockchain access";
  const methods = CONTRACT_KINDS.filter((k) => eff.methods[k].length)
    .map((k) => `${k}.${eff.methods[k].join("/")}`)
    .join(", ");
  return [
    `capabilities: ${eff.caps.join(", ") || "none"}`,
    `networks: ${eff.net.join(", ") || "none"}`,
    `contracts: ${eff.contracts.join(", ") || "none"}`,
    `write methods: ${methods || "none"}`,
    `recipients: ${eff.recipientsSet ? eff.recipients.join(", ") || "none (intersection is empty)" : "none approved"}`,
    `per-tx max: ${eff.maxBase === null ? "not set (payments refused)" : `${formatAmount(eff.maxBase, eff.decimals)} STD`}`,
    `gas cap: ${eff.gas === null ? "not set (writes refused)" : eff.gas.toString()}`,
    `expires: ${eff.exp === null ? "never" : iso(eff.exp)}`,
    `approval: ${eff.approve}`,
  ].join("; ");
}

/** Short grant id for logs/UI ("0x1234abcd"). */
export const shortGrantId = (id: Hex) => id.slice(0, 10);
