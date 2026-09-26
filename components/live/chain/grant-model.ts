// The `relay.chain` record (blockchain grant) as the portal shows and edits it (spec §4.1).
// Pure and browser-safe. This is a display/editing model only: the relay's own parser
// (lib/chain/grant.ts) is the authority, and every chain request is checked there.

import { type Address, formatUnits, getAddress, isAddress, parseUnits } from "viem";

export const CHAIN_CAPS = ["read", "track", "prepare", "submit", "deploy", "manage"] as const;
export type ChainCap = (typeof CHAIN_CAPS)[number];
export const CHAIN_NETS = ["sepolia"] as const;
export type ChainNet = (typeof CHAIN_NETS)[number];
export const CONTRACT_KINDS = ["token", "vault", "escrow"] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];
export const GRANT_PERIODS = ["month", "day", "total"] as const;
export type GrantPeriod = (typeof GRANT_PERIODS)[number];

/** The write methods the relay can ever allow per contract kind (owner functions and transferAdmin never). */
export const WRITE_METHODS: Record<ContractKind, readonly string[]> = {
  token: ["transfer"],
  vault: ["pay"],
  escrow: ["pause", "unpause", "release", "refund"],
};

export const CAP_LABELS: Record<ChainCap, string> = {
  read: "Read",
  track: "Track",
  prepare: "Prepare",
  submit: "Sign & submit",
  deploy: "Deploy",
  manage: "Manage",
};

export const CAP_HINTS: Record<ChainCap, string> = {
  read: "Call view functions of allowed contracts.",
  track: "Read events and follow transactions.",
  prepare: "Turn a task into an unsigned transaction proposal.",
  submit: "Have the relay signer sign and send approved proposals.",
  deploy: "Deploy the approved escrow template.",
  manage: "Call allowed admin functions (pause, unpause…).",
};

export const CONTRACT_LABELS: Record<ContractKind, string> = { token: "STD token", vault: "Treasury vault", escrow: "Escrows (approved template)" };
export const PERIOD_WORDS: Record<GrantPeriod, string> = { month: "per month", day: "per day", total: "in total" };

/** STD has 18 decimals; amounts in records are whole-token decimal strings ("5", "0.5"). */
export const STD_DECIMALS = 18;

export type ApproveRule = "always" | "never" | `above:${string}`;

/** A parsed grant, as written in the record. `to` holds addresses or workspace recipient names. */
export type ChainGrant = {
  v: 1;
  caps: ChainCap[];
  net: ChainNet[];
  contracts: ContractKind[];
  methods: Partial<Record<ContractKind, string[]>>;
  to?: string[];
  max?: string;
  limit?: string;
  period?: GrantPeriod;
  gas?: string;
  exp?: number;
  delegate?: boolean;
  approve?: ApproveRule;
};

const KEYS = ["v", "caps", "net", "contracts", "methods", "to", "max", "limit", "period", "gas", "exp", "delegate", "approve"] as const;
const DECIMAL = /^(0|[1-9]\d{0,20})(\.\d{1,18})?$/;
const INTEGER = /^[1-9]\d{0,15}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const subsetOf = <T extends string>(values: string[], allowed: readonly T[]): values is T[] => values.every((v) => (allowed as readonly string[]).includes(v));
const uniq = <T>(items: readonly T[]) => [...new Set(items)];

/** A decimal STD amount → base units; null when malformed. */
export function toBase(amount: string | undefined | null): bigint | null {
  const text = (amount ?? "").trim();
  if (!DECIMAL.test(text)) return null;
  try {
    return parseUnits(text, STD_DECIMALS);
  } catch {
    return null;
  }
}

/** Base units (bigint or decimal string) → "12.5". */
export function fromBase(base: bigint | string, decimals = STD_DECIMALS): string {
  try {
    return formatUnits(typeof base === "bigint" ? base : BigInt(base), decimals);
  } catch {
    return String(base);
  }
}

export function isApproveRule(v: unknown): v is ApproveRule {
  return v === "always" || v === "never" || (typeof v === "string" && v.startsWith("above:") && toBase(v.slice(6)) !== null);
}

/**
 * Parses a `relay.chain` record for display. Mirrors the relay's rules (unknown keys, bad
 * values or more than 4096 characters → null) so the portal never shows a grant the relay ignores.
 */
export function readGrant(text: string | null | undefined): ChainGrant | null {
  if (typeof text !== "string" || !text.trim() || text.length > 4096) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return grantFromObject(raw);
}

/** The same checks for an already-parsed object (e.g. an incident's `proposed.chain`). */
export function grantFromObject(raw: unknown): ChainGrant | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !(KEYS as readonly string[]).includes(k))) return null;
  if (o.v !== 1) return null;
  if (!isStrings(o.caps) || !subsetOf(o.caps, CHAIN_CAPS)) return null;
  const net = o.net ?? [];
  const contracts = o.contracts ?? [];
  if (!isStrings(net) || !subsetOf(net, CHAIN_NETS)) return null;
  if (!isStrings(contracts) || !subsetOf(contracts, CONTRACT_KINDS)) return null;
  const methods: Partial<Record<ContractKind, string[]>> = {};
  if (o.methods !== undefined) {
    if (!o.methods || typeof o.methods !== "object" || Array.isArray(o.methods)) return null;
    for (const [kind, list] of Object.entries(o.methods as Record<string, unknown>)) {
      if (!(CONTRACT_KINDS as readonly string[]).includes(kind) || !isStrings(list) || !subsetOf(list, WRITE_METHODS[kind as ContractKind])) return null;
      methods[kind as ContractKind] = uniq(list);
    }
  }
  // Absent delegate means "no further delegation" and absent approve means "always", as in the relay.
  const grant: ChainGrant = { v: 1, caps: uniq(o.caps), net: uniq(net), contracts: uniq(contracts), methods, delegate: false, approve: "always" };
  if (o.to !== undefined) {
    if (!isStrings(o.to) || o.to.length > 32 || !o.to.every((t) => isAddress(t, { strict: false }) || NAME.test(t))) return null;
    grant.to = uniq(o.to);
  }
  for (const key of ["max", "limit"] as const) {
    if (o[key] === undefined) continue;
    if (typeof o[key] !== "string" || toBase(o[key] as string) === null) return null;
    grant[key] = o[key] as string;
  }
  if (o.period !== undefined) {
    if (typeof o.period !== "string" || !(GRANT_PERIODS as readonly string[]).includes(o.period)) return null;
    grant.period = o.period as GrantPeriod;
  }
  // A limit must say its period.
  if (grant.limit !== undefined && grant.period === undefined) return null;
  if (o.gas !== undefined) {
    if (typeof o.gas !== "string" || !INTEGER.test(o.gas)) return null;
    grant.gas = o.gas;
  }
  if (o.exp !== undefined) {
    if (typeof o.exp !== "number" || !Number.isSafeInteger(o.exp) || o.exp <= 0) return null;
    grant.exp = o.exp;
  }
  if (o.delegate !== undefined) {
    if (typeof o.delegate !== "boolean") return null;
    grant.delegate = o.delegate;
  }
  if (o.approve !== undefined) {
    if (!isApproveRule(o.approve)) return null;
    grant.approve = o.approve;
  }
  return grant;
}

/** Canonical record text (the spec's key order; empty/absent fields left out). */
export function serializeGrant(g: ChainGrant): string {
  const out: Record<string, unknown> = { v: 1, caps: g.caps, net: g.net, contracts: g.contracts };
  const methods = Object.fromEntries(CONTRACT_KINDS.filter((k) => g.methods[k]?.length).map((k) => [k, g.methods[k]]));
  if (Object.keys(methods).length) out.methods = methods;
  if (g.to !== undefined) out.to = g.to;
  for (const key of ["max", "limit", "period", "gas", "exp", "delegate", "approve"] as const) {
    if (g[key] !== undefined) out[key] = g[key];
  }
  return JSON.stringify(out);
}

// --- Along the path ------------------------------------------------------------------

/** One level's record, root first. `chain` undefined = not read yet. */
export type ChainLevel = { name: string; chain: string | null | undefined };

const minDecimal = (a: string | undefined, b: string | undefined) => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (toBase(a) ?? 0n) <= (toBase(b) ?? 0n) ? a : b;
};
const minInt = (a: string | undefined, b: string | undefined) => (a === undefined ? b : b === undefined ? a : BigInt(a) <= BigInt(b) ? a : b);

/** always > above:lowest > never. */
export function strictestApprove(a: ApproveRule | undefined, b: ApproveRule | undefined): ApproveRule | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a === "always" || b === "always") return "always";
  if (a === "never") return b;
  if (b === "never") return a;
  return (toBase(a.slice(6)) ?? 0n) <= (toBase(b.slice(6)) ?? 0n) ? a : b;
}

export type PathGrant = {
  /** The intersection along the path; null when some level has no grant (or delegation is cut). */
  grant: ChainGrant | null;
  /** Why there is no effective grant, naming the level. */
  reason: string | null;
  /** Some level's record isn't known yet. */
  pending: boolean;
  /** Per-level aggregate limits (each checked against that level's own ledger by the relay). */
  perLevel: { name: string; limit?: string; period?: GrantPeriod; max?: string }[];
};

/**
 * What a name may do on chain: the intersection of every level's grant from the root down
 * (spec §4.1 effectiveGrant, display version). `recipients` maps workspace names to addresses
 * so "supplier" and its address intersect.
 */
export function pathGrant(levels: readonly ChainLevel[], recipients: Record<string, string> = {}): PathGrant {
  const perLevel: PathGrant["perLevel"] = [];
  if (levels.length === 0) return { grant: null, reason: "no levels", pending: false, perLevel };
  if (levels.some((l) => l.chain === undefined)) return { grant: null, reason: null, pending: true, perLevel };
  const norm = (t: string) => (recipients[t] ?? t).toLowerCase();
  let acc: ChainGrant | null = null;
  let to: string[] | undefined;
  for (const [i, level] of levels.entries()) {
    const g = readGrant(level.chain);
    if (!g) return { grant: null, reason: `${level.name} has no blockchain grant`, pending: false, perLevel };
    if (i < levels.length - 1 && g.delegate !== true) {
      return { grant: null, reason: `${level.name} doesn't allow further delegation`, pending: false, perLevel };
    }
    perLevel.push({ name: level.name, limit: g.limit, period: g.period, max: g.max });
    if (g.to) to = to === undefined ? [...g.to] : to.filter((t) => g.to!.some((u) => norm(u) === norm(t)));
    if (!acc) {
      acc = { ...g, methods: { ...g.methods } };
      continue;
    }
    const contracts: ContractKind[] = acc.contracts.filter((c) => g.contracts.includes(c));
    acc = {
      v: 1,
      caps: acc.caps.filter((c) => g.caps.includes(c)),
      net: acc.net.filter((n) => g.net.includes(n)),
      contracts,
      methods: Object.fromEntries(
        contracts.map((k) => [k, (acc!.methods[k] ?? []).filter((m) => (g.methods[k] ?? []).includes(m))]),
      ) as Partial<Record<ContractKind, string[]>>,
      max: minDecimal(acc.max, g.max),
      limit: g.limit ?? acc.limit,
      period: g.period ?? acc.period,
      gas: minInt(acc.gas, g.gas),
      exp: acc.exp === undefined ? g.exp : g.exp === undefined ? acc.exp : Math.min(acc.exp, g.exp),
      delegate: g.delegate,
      approve: strictestApprove(acc.approve, g.approve),
    };
  }
  if (acc) {
    for (const k of CONTRACT_KINDS) if (!acc.contracts.includes(k)) delete acc.methods[k];
    if (to !== undefined) acc.to = to;
    else delete acc.to;
  }
  return { grant: acc, reason: null, pending: false, perLevel };
}

/** The tightest aggregate limit along the path (for "at most N STD per month" lines). */
export function tightestLimit(perLevel: PathGrant["perLevel"]): { name: string; limit: string; period?: GrantPeriod } | null {
  let best: { name: string; limit: string; period?: GrantPeriod } | null = null;
  for (const l of perLevel) {
    if (l.limit === undefined) continue;
    if (!best || (toBase(l.limit) ?? 0n) < (toBase(best.limit) ?? 0n)) best = { name: l.name, limit: l.limit, period: l.period };
  }
  return best;
}

// --- Display -------------------------------------------------------------------------

export const shortHex = (hex: string, lead = 6, tail = 4) => (hex.length > lead + tail + 2 ? `${hex.slice(0, lead + 2)}…${hex.slice(-tail)}` : hex);

/** "supplier", or 0x12…abcd; names from the workspace shown with their address. */
export function recipientLabel(to: string, recipients: Record<string, string> = {}): string {
  if (recipients[to]) return `${to} (${shortHex(recipients[to])})`;
  const named = Object.entries(recipients).find(([, addr]) => addr.toLowerCase() === to.toLowerCase());
  if (named) return `${named[0]} (${shortHex(to)})`;
  return isAddress(to, { strict: false }) ? shortHex(getAddress(to)) : to;
}

export function approveText(rule: ApproveRule | undefined): string {
  if (!rule || rule === "always") return "A human approves every transaction";
  if (rule === "never") return "No human approval needed";
  return `A human approves above ${rule.slice(6)} STD`;
}

/** Short cap list for badges: "read · track · prepare", or "all chain tools". */
export function capsText(caps: readonly ChainCap[]): string {
  if (caps.length === CHAIN_CAPS.length) return "all chain tools";
  return caps.length ? caps.map((c) => CAP_LABELS[c].toLowerCase()).join(" · ") : "no chain tools";
}

export type GrantRow = { label: string; value: string };

/** DetailPanel "Blockchain permissions" rows for an effective grant. */
export function grantRows(p: PathGrant, own: ChainGrant | null, recipients: Record<string, string> = {}, nowSec = Math.floor(Date.now() / 1000)): GrantRow[] {
  const g = p.grant;
  if (!g) return [];
  const methods = g.contracts
    .map((k) => `${k}: ${(g.methods[k] ?? []).length ? g.methods[k]!.join(", ") : "reads only"}`)
    .join(" · ");
  const limit = tightestLimit(p.perLevel);
  const rows: GrantRow[] = [
    { label: "Tools", value: g.caps.length ? g.caps.map((c) => CAP_LABELS[c]).join(", ") : "None" },
    { label: "Networks", value: g.net.length ? g.net.map((n) => n[0].toUpperCase() + n.slice(1)).join(", ") : "None" },
    { label: "Contracts", value: g.contracts.length ? g.contracts.map((k) => CONTRACT_LABELS[k]).join(", ") : "None" },
    { label: "Methods", value: methods || "None" },
    { label: "Recipients", value: g.to === undefined ? "None approved (payments refused)" : g.to.length ? g.to.map((t) => recipientLabel(t, recipients)).join(", ") : "None in common above" },
    { label: "Per transaction", value: g.max !== undefined ? `${g.max} STD` : "No per-tx max" },
    { label: "Limit", value: limit ? `${limit.limit} STD ${PERIOD_WORDS[limit.period ?? "month"]}${p.perLevel.length > 1 ? ` (set by ${limit.name})` : ""}` : "No aggregate limit" },
    { label: "Gas per tx", value: g.gas !== undefined ? Number(g.gas).toLocaleString("en-US") : "No gas cap" },
    { label: "Grant expiry", value: g.exp ? `${new Date(g.exp * 1000).toLocaleString()}${g.exp <= nowSec ? " (ended)" : ""}` : "No expiry" },
    { label: "Delegation", value: own?.delegate === true ? "May grant narrower access below" : "Can't pass chain access down" },
    { label: "Approval", value: approveText(g.approve) },
  ];
  return rows;
}

// --- Editor draft --------------------------------------------------------------------

export type ChainDraft = {
  on: boolean;
  caps: ChainCap[];
  contracts: ContractKind[];
  methods: Partial<Record<ContractKind, string[]>>;
  /** Addresses or workspace names. */
  to: string[];
  max: string;
  limit: string;
  period: GrantPeriod;
  gas: string;
  /** Days from now; empty = no expiry. */
  days: string;
  delegate: boolean;
  approve: "always" | "never" | "above";
  approveAbove: string;
};

export const emptyChainDraft = (): ChainDraft => ({
  on: false,
  caps: [],
  contracts: [],
  methods: {},
  to: [],
  max: "",
  limit: "",
  period: "month",
  gas: "",
  days: "",
  delegate: true,
  approve: "always",
  approveAbove: "",
});

export function draftFromGrant(g: ChainGrant | null, nowSec: number): ChainDraft {
  if (!g) return emptyChainDraft();
  return {
    on: true,
    caps: [...g.caps],
    contracts: [...g.contracts],
    methods: Object.fromEntries(Object.entries(g.methods).map(([k, v]) => [k, [...(v ?? [])]])),
    to: [...(g.to ?? [])],
    max: g.max ?? "",
    limit: g.limit ?? "",
    period: g.period ?? "month",
    gas: g.gas ?? "",
    days: g.exp ? String(Math.max(1, Math.ceil((g.exp - nowSec) / 86_400))) : "",
    delegate: g.delegate === true,
    approve: !g.approve || g.approve === "always" ? "always" : g.approve === "never" ? "never" : "above",
    approveAbove: g.approve?.startsWith("above:") ? g.approve.slice(6) : "",
  };
}

/** A default grant for a child: what the levels above allow, minus delegation (like defaultBundle). */
export function draftFromAbove(above: ChainGrant | null, nowSec: number): ChainDraft {
  if (!above) return emptyChainDraft();
  const d = draftFromGrant(above, nowSec);
  return { ...d, on: false };
}

/**
 * A new member's starting grant (Add a member): what the levels above allow, switched on, so a
 * member added for the blockchain demo can `relay login --chain` without a second transaction.
 * Off when nothing above grants blockchain access.
 */
export function newMemberChainDraft(above: PathGrant | null | undefined, nowSec: number): ChainDraft {
  const g = above?.grant ?? null;
  if (!g) return emptyChainDraft();
  return { ...draftFromGrant(g, nowSec), on: true };
}

/**
 * The bundle to write with a chain grant: a grant is useless without "multibaas" in relay.keys,
 * so it is added when the grant is on and the parent allows multibaas (or nothing above limits it).
 */
export function withChainKey<B extends { keys: readonly string[] }>(bundle: B, grant: ChainGrant | null, parent: { keys: readonly string[] } | null): B {
  if (!grant || bundle.keys.includes("multibaas")) return bundle;
  if (parent && !parent.keys.includes("multibaas")) return bundle;
  return { ...bundle, keys: [...bundle.keys, "multibaas"] } as B;
}

/** The grant a draft describes (null when switched off), or the error to show. */
export function grantFromDraft(
  d: ChainDraft,
  nowSec: number,
  /** The grant being edited: its exact expiry is kept while the days field is untouched. */
  original?: ChainGrant | null,
): { grant: ChainGrant | null; error: null } | { grant: null; error: string } {
  if (!d.on) return { grant: null, error: null };
  if (d.caps.length === 0) return { grant: null, error: "Pick at least one blockchain tool, or turn blockchain access off." };
  const grant: ChainGrant = {
    v: 1,
    caps: CHAIN_CAPS.filter((c) => d.caps.includes(c)),
    net: ["sepolia"],
    contracts: CONTRACT_KINDS.filter((k) => d.contracts.includes(k)),
    methods: {},
  };
  for (const k of grant.contracts) {
    const list = (d.methods[k] ?? []).filter((m) => WRITE_METHODS[k].includes(m));
    if (list.length) grant.methods[k] = list;
  }
  const to = uniq(d.to.map((t) => t.trim()).filter(Boolean));
  for (const t of to) {
    if (!isAddress(t, { strict: false }) && !NAME.test(t)) return { grant: null, error: `${t} isn't an address or a workspace recipient name.` };
  }
  if (to.length) grant.to = to.map((t) => (isAddress(t, { strict: false }) ? getAddress(t) : t));
  for (const [key, label] of [
    ["max", "per-transaction max"],
    ["limit", "limit"],
  ] as const) {
    const v = d[key].trim();
    if (!v) continue;
    const base = toBase(v);
    if (base === null || base <= 0n) return { grant: null, error: `The ${label} must be a positive STD amount like 5 or 0.5.` };
    grant[key] = v;
  }
  if (grant.limit !== undefined) grant.period = d.period;
  const gas = d.gas.trim();
  if (gas) {
    if (!INTEGER.test(gas)) return { grant: null, error: "Gas must be a whole number, e.g. 400000." };
    grant.gas = gas;
  }
  const days = d.days.trim();
  if (days) {
    const n = Number(days);
    if (!Number.isInteger(n) || n <= 0 || n > 3650) return { grant: null, error: "Expiry must be a whole number of days (1–3650)." };
    grant.exp = original?.exp && draftFromGrant(original, nowSec).days === days ? original.exp : nowSec + n * 86_400;
  }
  grant.delegate = d.delegate;
  if (d.approve === "above") {
    const v = d.approveAbove.trim();
    if (toBase(v) === null) return { grant: null, error: "Enter the STD amount above which a human approves." };
    grant.approve = `above:${v}`;
  } else grant.approve = d.approve;
  return { grant, error: null };
}

export type ChainEditorModel = {
  /** The levels above are still loading. */
  loading: boolean;
  /** No grant above (or delegation cut): the section explains instead of offering options. */
  blocked: string | null;
  caps: { id: ChainCap; label: string; hint: string; on: boolean }[];
  contracts: { id: ContractKind; label: string; on: boolean; methods: { id: string; on: boolean }[] }[];
  recipients: { id: string; label: string; on: boolean }[];
  /** Hidden options, in words ("Deploy isn't available: dev.acme.eth doesn't allow it."). */
  unavailable: string[];
  /** Warnings about values above the parent's. */
  notes: string[];
  placeholders: { max: string; limit: string; gas: string };
};

/**
 * What the chain section offers: only what every level above allows (their intersection);
 * anything already ticked but blocked stays visible so it can be unticked.
 */
export function chainEditorModel(d: ChainDraft, above: PathGrant | null | undefined, recipients: Record<string, string> = {}): ChainEditorModel {
  const loading = above === null || !!above?.pending;
  // undefined = the company itself: no level above limits it.
  const a = above === undefined ? null : above?.grant ?? null;
  const blocked = above && !above.pending && !above.grant ? (above.reason ?? "The levels above give no blockchain access.") : null;
  const capOk = (c: ChainCap) => !a || a.caps.includes(c);
  const kindOk = (k: ContractKind) => !a || a.contracts.includes(k);
  const methodOk = (k: ContractKind, m: string) => !a || (a.methods[k] ?? []).includes(m);
  const unavailable: string[] = [];
  const hiddenCaps = CHAIN_CAPS.filter((c) => !capOk(c) && !d.caps.includes(c));
  if (a && hiddenCaps.length && hiddenCaps.length < CHAIN_CAPS.length) {
    unavailable.push(`${hiddenCaps.map((c) => CAP_LABELS[c]).join(", ")}: not allowed above.`);
  }
  const caps = CHAIN_CAPS.filter((c) => capOk(c) || d.caps.includes(c)).map((id) => ({ id, label: CAP_LABELS[id], hint: CAP_HINTS[id], on: d.caps.includes(id) }));
  const contracts = CONTRACT_KINDS.filter((k) => kindOk(k) || d.contracts.includes(k)).map((id) => ({
    id,
    label: CONTRACT_LABELS[id],
    on: d.contracts.includes(id),
    methods: WRITE_METHODS[id].filter((m) => methodOk(id, m) || (d.methods[id] ?? []).includes(m)).map((m) => ({ id: m, on: (d.methods[id] ?? []).includes(m) })),
  }));
  // Recipients: the ones allowed above (else the workspace's names), plus any already chosen.
  const offered = a?.to ?? Object.keys(recipients);
  const recipientIds = uniq([...offered, ...d.to]);
  const recipientRows = recipientIds.map((id) => ({ id, label: recipientLabel(id, recipients), on: d.to.includes(id) }));
  const notes: string[] = [];
  if (a && d.on) {
    if (a.max && d.max && (toBase(d.max) ?? 0n) > (toBase(a.max) ?? 0n)) notes.push(`Per-transaction max is capped at ${a.max} STD above.`);
    const tight = above ? tightestLimit(above.perLevel) : null;
    if (tight && d.limit && (toBase(d.limit) ?? 0n) > (toBase(tight.limit) ?? 0n)) notes.push(`${tight.name} allows ${tight.limit} STD ${PERIOD_WORDS[tight.period ?? "month"]}; that still applies.`);
    if (a.gas && d.gas && /^\d+$/.test(d.gas) && BigInt(d.gas) > BigInt(a.gas)) notes.push(`Gas is capped at ${a.gas} above.`);
    const norm = (t: string) => (recipients[t] ?? t).toLowerCase();
    const extra = a.to ? d.to.filter((t) => !a.to!.some((u) => norm(u) === norm(t))) : [];
    if (extra.length) notes.push(`${extra.join(", ")} ${extra.length === 1 ? "isn't" : "aren't"} approved above, so payments there are refused.`);
  }
  return {
    loading,
    blocked,
    caps,
    contracts,
    recipients: recipientRows,
    unavailable,
    notes,
    placeholders: {
      max: a?.max ? `≤ ${a.max}` : "no max",
      limit: above && tightestLimit(above.perLevel) ? `≤ ${tightestLimit(above.perLevel)!.limit}` : "no limit",
      gas: a?.gas ? `≤ ${a.gas}` : "no cap",
    },
  };
}

// Immutable draft edits.
const toggle = <T>(list: readonly T[], item: T, on: boolean): T[] => (on ? (list.includes(item) ? [...list] : [...list, item]) : list.filter((x) => x !== item));
export const toggleCap = (d: ChainDraft, c: ChainCap, on: boolean): ChainDraft => ({ ...d, caps: toggle(d.caps, c, on) });
export const toggleContract = (d: ChainDraft, k: ContractKind, on: boolean): ChainDraft => ({ ...d, contracts: toggle(d.contracts, k, on) });
export const toggleMethod = (d: ChainDraft, k: ContractKind, m: string, on: boolean): ChainDraft => ({ ...d, methods: { ...d.methods, [k]: toggle(d.methods[k] ?? [], m, on) } });
export const toggleRecipient = (d: ChainDraft, t: string, on: boolean): ChainDraft => ({ ...d, to: toggle(d.to, t, on) });

export const asAddress = (v: string): Address | null => (isAddress(v, { strict: false }) ? getAddress(v) : null);
