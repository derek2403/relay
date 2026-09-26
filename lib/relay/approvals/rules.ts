// Renewal rules R1–R10: does a proposed (or observed) scope expand what the
// relay last cleared or approved for an agent? Every expansion pauses; a
// same-or-narrower change is clear. Pure: no I/O, and nothing here reads what
// an agent wrote about itself.

import { type Address, isAddressEqual } from "viem";

import type { Bundle, Period } from "../bundle";
import { type ChainScope, type ScopeView, resolveRecipient, toBase } from "./scope";

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10";
export type Flag = { id: RuleId; detail: string; severity: "pause" | "critical" };

/** Code constant plus the thresholds below; part of every approval digest. */
export const MAX_RENEWAL_DAYS = 31;
export const MAX_TERM_GROWTH = 1.1;
export const POLICY_VERSION = `rp1-2026-09-27:d${MAX_RENEWAL_DAYS}:g${MAX_TERM_GROWTH}`;

/** Plain-words names of the rules (UI and logs). */
export const RULE_TEXT: Record<RuleId, string> = {
  R1: "new provider",
  R2: "dollar cap raised or removed",
  R3: "request cap raised or removed",
  R4: "limit period changed",
  R5: "longer term than policy allows",
  R6: "new payment recipient (or recipient list removed)",
  R7: "recipient outside the workspace's known recipients",
  R8: "blockchain amount, limit or gas raised or removed",
  R9: "new blockchain capability, network, contract or method",
  R10: "owner or key changed",
};

export type RuleContext = {
  nowSec: number;
  /** Length of the previous term in seconds (baseline expiry minus when it started), when known. */
  prevTermSec?: number | null;
  /** Workspace recipients by name (org/chain.json); addresses not listed trip R7. */
  knownRecipients?: Record<string, Address>;
};

/** A period change narrows only when it stops refilling ("total"). */
const periodWidens = (prev: Period, next: Period) => prev !== next && next !== "total";

function bundleFlags(prev: Bundle | null, next: Bundle | null, flags: Flag[]) {
  if (!next) return;
  const before = new Set(prev?.keys ?? []);
  const added = next.keys.filter((k) => !before.has(k));
  if (added.length) flags.push({ id: "R1", detail: `adds ${added.join(", ")}`, severity: "pause" });
  if (!prev) return;
  for (const p of next.keys.filter((k) => before.has(k))) {
    const was = prev.caps[p];
    const now = next.caps[p];
    if (was !== undefined && (now === undefined || now > was)) {
      flags.push({ id: "R2", detail: now === undefined ? `${p} dollar cap $${was} removed` : `${p} dollar cap $${was} → $${now}`, severity: "pause" });
    }
    const wasMax = prev.maxes?.[p];
    const nowMax = next.maxes?.[p];
    if (wasMax !== undefined && (nowMax === undefined || nowMax > wasMax)) {
      flags.push({ id: "R3", detail: nowMax === undefined ? `${p} count cap ${wasMax} removed` : `${p} count cap ${wasMax} → ${nowMax}`, severity: "pause" });
    }
  }
  if (periodWidens(prev.period, next.period)) flags.push({ id: "R4", detail: `period ${prev.period} → ${next.period}`, severity: "pause" });
}

const amountUp = (prev: string | undefined, next: string | undefined) => prev !== undefined && (next === undefined || toBase(next) > toBase(prev));
const intUp = (prev: string | undefined, next: string | undefined) => prev !== undefined && (next === undefined || BigInt(next) > BigInt(prev));

const APPROVE_RANK = (a: string | undefined) => (a === undefined ? 0 : a === "never" ? 0 : a === "always" ? 2 : 1);

function chainFlags(prev: ChainScope | null, next: ChainScope | null, ctx: RuleContext, flags: Flag[]) {
  if (!next) return;
  const known = ctx.knownRecipients ?? {};
  if (!prev) {
    flags.push({ id: "R9", detail: `new blockchain grant (${next.caps.join(", ") || "no capabilities"})`, severity: "pause" });
  } else {
    const newIn = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
    const caps = newIn(prev.caps, next.caps);
    const net = newIn(prev.net, next.net);
    const contracts = newIn(prev.contracts, next.contracts);
    const methods = Object.entries(next.methods).flatMap(([c, ms]) => newIn(prev.methods[c] ?? [], ms).map((m) => `${c}.${m}`));
    const parts = [
      caps.length ? `capabilities ${caps.join(", ")}` : null,
      net.length ? `networks ${net.join(", ")}` : null,
      contracts.length ? `contracts ${contracts.join(", ")}` : null,
      methods.length ? `methods ${methods.join(", ")}` : null,
      !prev.delegate && next.delegate ? "further delegation allowed" : null,
      APPROVE_RANK(next.approve) < APPROVE_RANK(prev.approve) ? `approval rule ${prev.approve ?? "unset"} → ${next.approve ?? "unset"}` : null,
    ].filter(Boolean);
    if (parts.length) flags.push({ id: "R9", detail: `adds ${parts.join("; ")}`, severity: "pause" });
    const ups = [
      amountUp(prev.max, next.max) ? `per-tx max ${prev.max} → ${next.max ?? "unlimited"} STD` : null,
      amountUp(prev.limit, next.limit) ? `limit ${prev.limit} → ${next.limit ?? "unlimited"} STD` : null,
      intUp(prev.gas, next.gas) ? `gas ${prev.gas} → ${next.gas ?? "unlimited"}` : null,
    ].filter(Boolean);
    if (ups.length) flags.push({ id: "R8", detail: ups.join("; "), severity: "pause" });
    if (prev.period && next.period && periodWidens(prev.period, next.period)) {
      flags.push({ id: "R4", detail: `blockchain limit period ${prev.period} → ${next.period}`, severity: "pause" });
    } else if (prev.period && !next.period && next.limit !== undefined) {
      flags.push({ id: "R4", detail: `blockchain limit period ${prev.period} removed`, severity: "pause" });
    }
    if (prev.exp !== undefined && (next.exp === undefined || next.exp > prev.exp)) {
      const days = next.exp === undefined ? null : (next.exp - ctx.nowSec) / 86400;
      if (days === null || days > MAX_RENEWAL_DAYS) flags.push({ id: "R5", detail: `blockchain grant expiry ${days === null ? "removed" : `${Math.round(days)} days out`}`, severity: "pause" });
    }
  }
  const prevTo = new Set((prev?.to ?? []).map((r) => resolveRecipient(r, known)));
  if (prev?.to && !next.to) {
    flags.push({ id: "R6", detail: "recipient list removed (no longer restricted at this level)", severity: "pause" });
  }
  const added = (next.to ?? []).filter((r) => !prevTo.has(resolveRecipient(r, known)));
  if (added.length) {
    flags.push({ id: "R6", detail: `new recipients ${added.join(", ")}`, severity: "pause" });
    const knownSet = new Set(Object.values(known).map((a) => a.toLowerCase()));
    const outside = added.filter((r) => !knownSet.has(resolveRecipient(r, known)));
    if (outside.length) flags.push({ id: "R7", detail: `not a known workspace recipient: ${outside.join(", ")}`, severity: "critical" });
  }
}

/**
 * Flags for moving from `prev` (the baseline) to `next`. Fields of `next` that
 * are null mean "no access" (bundle, chain) or "unknown" (expiry, owner).
 */
export function renewalFlags(prev: ScopeView, next: ScopeView, ctx: RuleContext): Flag[] {
  const flags: Flag[] = [];
  bundleFlags(prev.bundle, next.bundle, flags);
  // Fail closed: a record the rules can't read may still be one the enforcement layer accepts.
  if (next.chainUnreadable) flags.push({ id: "R9", detail: "unreadable blockchain grant (relay.chain can't be compared, so it can't be cleared)", severity: "critical" });
  else chainFlags(prev.chain, next.chain, ctx, flags);
  if (next.expiry !== null && (prev.expiry === null || next.expiry > prev.expiry)) {
    const term = next.expiry - ctx.nowSec;
    const prevTerm = ctx.prevTermSec ?? null;
    if (term > MAX_RENEWAL_DAYS * 86400) {
      flags.push({ id: "R5", detail: `expires in ${Math.round(term / 86400)} days (policy: at most ${MAX_RENEWAL_DAYS})`, severity: "pause" });
    } else if (prevTerm !== null && prevTerm > 0 && term > prevTerm * MAX_TERM_GROWTH) {
      flags.push({ id: "R5", detail: `term ${Math.round(term / 3600)} h is longer than 1.1× the previous ${Math.round(prevTerm / 3600)} h`, severity: "pause" });
    }
  }
  if (prev.owner && next.owner && !isAddressEqual(prev.owner, next.owner)) {
    flags.push({ id: "R10", detail: `owner ${prev.owner} → ${next.owner}`, severity: "pause" });
  }
  return flags;
}

export type Suggested = { decision: "reject" | "approve-narrower" | "revoke" | "approve"; label: string; scope?: NarrowScope };

/** An approve-narrower scope: at most a day, a bundle and/or a chain grant. */
export type NarrowScope = { bundle?: Bundle | null; chain?: ChainScope | null; durationSec: number };

export const MAX_NARROW_SEC = 86_400;
export const DEFAULT_NARROW_SEC = 3600;
export const DEFAULT_NARROW_MAX = "5";

const minAmount = (a: string | undefined, b: string) => (a !== undefined && toBase(a) < toBase(b) ? a : b);

/** The default narrower replacement: previous recipients, one hour, min(previous per-tx, 5) STD. */
export function defaultNarrower(prev: ScopeView): NarrowScope {
  const chain = prev.chain ? { ...prev.chain, max: minAmount(prev.chain.max, DEFAULT_NARROW_MAX), limit: minAmount(prev.chain.max, DEFAULT_NARROW_MAX), period: "total" as const } : null;
  return { bundle: prev.bundle, chain, durationSec: DEFAULT_NARROW_SEC };
}

/** Deterministic suggestions, safest first ("approve as requested" last). Never derived from agent text. */
export function suggestions(prev: ScopeView, hasProposal: boolean): Suggested[] {
  const narrow = defaultNarrower(prev);
  const out: Suggested[] = [
    { decision: "reject", label: "Reject: stay paused until the agent's name expires" },
    {
      decision: "approve-narrower",
      label: `Approve narrower: keep previous recipients, 1 hour${narrow.chain?.max ? `, ${narrow.chain.max} STD` : ""}`,
      scope: narrow,
    },
    { decision: "revoke", label: "Revoke the branch: pause permanently, then remove it on ENS" },
  ];
  if (hasProposal) out.push({ decision: "approve", label: "Approve as requested (every expansion above)" });
  return out;
}

/** Why a narrower scope isn't within previous ∪ proposed, or null when it is. */
export function narrowerProblem(scope: NarrowScope, prev: ScopeView, proposed: ScopeView | null, known: Record<string, Address> = {}): string | null {
  if (!Number.isSafeInteger(scope.durationSec) || scope.durationSec <= 0 || scope.durationSec > MAX_NARROW_SEC) return `duration must be 1 s to ${MAX_NARROW_SEC} s`;
  const bundles = [prev.bundle, proposed?.bundle].filter((b): b is Bundle => !!b);
  if (scope.bundle) {
    for (const k of scope.bundle.keys) {
      const allowing = bundles.filter((b) => b.keys.includes(k));
      if (!allowing.length) return `${k} is in neither the previous nor the requested scope`;
      const capOk = allowing.some((b) => b.caps[k] === undefined || (scope.bundle!.caps[k] !== undefined && scope.bundle!.caps[k]! <= b.caps[k]!));
      if (!capOk) return `the ${k} dollar cap is above both the previous and the requested one`;
      const maxOk = allowing.some((b) => b.maxes?.[k] === undefined || (scope.bundle!.maxes?.[k] !== undefined && scope.bundle!.maxes[k]! <= b.maxes[k]!));
      if (!maxOk) return `the ${k} count cap is above both the previous and the requested one`;
    }
  }
  if (scope.chain) {
    const chains = [prev.chain, proposed?.chain].filter((c): c is ChainScope => !!c);
    if (!chains.length) return "neither the previous nor the requested scope has a blockchain grant";
    const union = (f: (c: ChainScope) => string[]) => new Set(chains.flatMap(f));
    const within = (list: string[], allowed: Set<string>, what: string) => {
      const bad = list.filter((x) => !allowed.has(x));
      return bad.length ? `${what} ${bad.join(", ")} not in the previous or requested grant` : null;
    };
    const c = scope.chain;
    const problem =
      within(c.caps, union((g) => g.caps), "capabilities") ??
      within(c.net, union((g) => g.net), "networks") ??
      within(c.contracts, union((g) => g.contracts), "contracts") ??
      within(Object.entries(c.methods).flatMap(([k, ms]) => ms.map((m) => `${k}.${m}`)), union((g) => Object.entries(g.methods).flatMap(([k, ms]) => ms.map((m) => `${k}.${m}`))), "methods");
    if (problem) return problem;
    const toUnion = new Set(chains.flatMap((g) => (g.to ?? []).map((r) => resolveRecipient(r, known))));
    if (!c.to && chains.every((g) => g.to)) return "a narrower blockchain scope must list its recipients";
    const badTo = (c.to ?? []).filter((r) => !toUnion.has(resolveRecipient(r, known)));
    if (badTo.length) return `recipients ${badTo.join(", ")} not in the previous or requested grant`;
    const ceiling = (f: (g: ChainScope) => string | undefined) => {
      const vals = chains.map(f);
      return vals.some((v) => v === undefined) ? undefined : vals.reduce((m, v) => (toBase(v!) > toBase(m!) ? v : m));
    };
    for (const k of ["max", "limit"] as const) {
      const top = ceiling((g) => g[k]);
      if (top !== undefined && (c[k] === undefined || toBase(c[k]!) > toBase(top))) return `${k} must be at most ${top} STD`;
    }
    const gasTop = ceiling((g) => g.gas);
    if (gasTop !== undefined && (c.gas === undefined || BigInt(c.gas) > BigInt(gasTop))) return `gas must be at most ${gasTop}`;
    if (c.delegate && !chains.some((g) => g.delegate)) return "further delegation wasn't allowed before or requested";
  }
  if (!scope.bundle && !scope.chain) return "the scope must name a bundle or a blockchain grant";
  return null;
}
