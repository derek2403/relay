// Pure helpers for the CLI's blockchain commands (scripts/relay.ts): the `relay.chain` grant a
// login or `subagent create` writes, built from the parent's grant and the --chain* flags, and the
// text the chain, approval and renewal commands print. No I/O, so tests/chain-cli.test.ts covers it.
//
// The grant format is the relay's (lib/chain/grant.ts, spec §4.1): compact JSON written by the
// parent on the parent's resolver, as serializeGrant writes it. The relay's parseGrant decides
// whether it counts (unknown keys, bad values → no chain access); it needs the workspace config to
// resolve recipient names, which the installed CLI doesn't have, so reading a parent's grant here
// is a loose structural read (readGrant). This file only produces records, it never authorizes.

import { type ChainGrant, serializeGrant } from "../../lib/chain/grant";

export const CHAIN_CAPS = ["read", "track", "prepare", "submit", "deploy", "manage"] as const;
export type ChainCap = (typeof CHAIN_CAPS)[number];
export const CHAIN_PERIODS = ["month", "day", "total"] as const;
export type ChainPeriod = (typeof CHAIN_PERIODS)[number];

/** A `relay.chain` record as JSON (spec §4.1). Amounts are whole-token decimal strings ("5", "0.5"). */
export type GrantRecord = {
  v: 1;
  caps: ChainCap[];
  net: string[];
  contracts: string[];
  methods: Record<string, string[]>;
  to?: string[];
  max?: string;
  limit?: string;
  period?: ChainPeriod;
  gas?: string;
  exp: number;
  delegate: boolean;
  approve: string;
};

/** The flags `login`, `subagent create` and `subagent renew` take (all raw strings, unchecked). */
export type ChainFlags = {
  chain?: string;
  chainTo?: string;
  chainMax?: string;
  chainLimit?: string;
  chainPeriod?: string;
  chainGas?: string;
  noDelegate?: boolean;
  approve?: string;
};

export class ChainFlagError extends Error {}

/** Any --chain* flag (or --no-delegate / --approve) given. */
export const anyChainFlag = (f: ChainFlags) =>
  f.chain !== undefined || f.chainTo !== undefined || f.chainMax !== undefined || f.chainLimit !== undefined ||
  f.chainPeriod !== undefined || f.chainGas !== undefined || !!f.noDelegate || f.approve !== undefined;

const DECIMAL = /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/;

/** Whole-token decimal string → base units (18 decimals), or null when it isn't one. */
export function toBase(amount: string): bigint | null {
  const s = amount.trim();
  if (!DECIMAL.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((frac.slice(0) + "0".repeat(18)).slice(0, 18) || "0");
}

/** "5.50" → "5.5", "3.0" → "3": the form the record stores. */
function tidyAmount(s: string): string {
  const t = s.trim();
  return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
}

function amountFlag(raw: string, flag: string): string {
  const s = raw.trim().replace(/ ?STD$/i, "");
  const base = toBase(s);
  if (base === null || base <= 0n) throw new ChainFlagError(`${flag} must be a positive amount of STD like 5 or 0.5 (got "${raw}").`);
  return tidyAmount(s);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RECIPIENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** "supplier,0xAbc…" → ["supplier", "0xabc…"]: workspace names as given, addresses lowercased. */
export function parseRecipients(raw: string): string[] {
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new ChainFlagError(`--chain-to needs at least one recipient: a workspace name like supplier, or an address.`);
  const out: string[] = [];
  for (const item of items) {
    const v = item.toLowerCase();
    if (!ADDRESS.test(item) && !RECIPIENT_NAME.test(v)) throw new ChainFlagError(`--chain-to: "${item}" is neither an address nor a recipient name like supplier.`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** "read,track" → ["read","track"] in canonical order; unknown capabilities are an error. */
export function parseCaps(raw: string): ChainCap[] {
  const items = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = items.filter((c) => !(CHAIN_CAPS as readonly string[]).includes(c));
  if (bad.length) throw new ChainFlagError(`--chain: unknown capability ${bad.join(", ")} (use ${CHAIN_CAPS.join(",")}).`);
  if (!items.length) throw new ChainFlagError(`--chain needs at least one capability (${CHAIN_CAPS.join(",")}).`);
  return CHAIN_CAPS.filter((c) => items.includes(c));
}

/** always | never | above:N (N in STD). */
export function parseApprove(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === "always" || s === "never") return s;
  const m = s.match(/^above:(.+)$/);
  if (m) return `above:${amountFlag(m[1], "--approve above:")}`;
  throw new ChainFlagError(`--approve must be always, never or above:<STD> (got "${raw}").`);
}

/** Lower number = stricter (always > above:lowest > never). */
function approveRank(a: string): bigint {
  if (a === "always") return 0n;
  if (a === "never") return 2n ** 255n;
  const b = a.startsWith("above:") ? toBase(a.slice(6)) : null;
  return b === null ? 0n : b + 1n;
}

/** Reads a `relay.chain` record loosely (enough to derive a child's grant from it); null when unset or not a grant. */
export function readGrant(text: string | null | undefined): GrantRecord | null {
  if (!text?.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const g = raw as Partial<GrantRecord> | null;
  if (!g || typeof g !== "object" || g.v !== 1 || !Array.isArray(g.caps) || !Array.isArray(g.net) || !Array.isArray(g.contracts)) return null;
  if (typeof g.methods !== "object" || !g.methods || typeof g.exp !== "number" || typeof g.delegate !== "boolean" || typeof g.approve !== "string") return null;
  return g as GrantRecord;
}

/** The record text: serializeGrant's canonical key order, optional fields only when set. */
export function grantText(g: GrantRecord): string {
  return serializeGrant(g as unknown as ChainGrant);
}

/**
 * A child's grant: the parent's, narrowed by the flags, ending at `exp` (never after the parent's).
 * Asking for more than the parent has (a capability, a higher amount, a recipient it doesn't list)
 * is an error here rather than a record the relay would quietly narrow. `parentName` is for messages.
 * `checkParent: false` (a renewal request, which the relay reviews) only applies the flags.
 */
export function childGrant(
  parent: GrantRecord,
  flags: ChainFlags,
  exp: number,
  parentName: string,
  opts: { checkParent?: boolean; recipients?: Record<string, string> } = {},
): GrantRecord {
  const check = opts.checkParent !== false;
  if (check && !parent.delegate) throw new ChainFlagError(`${parentName} doesn't allow further delegation of its blockchain grant.`);
  const caps = flags.chain !== undefined ? parseCaps(flags.chain) : [...parent.caps];
  const extra = caps.filter((c) => !parent.caps.includes(c));
  if (check && extra.length) throw new ChainFlagError(`--chain: ${parentName} doesn't have ${extra.join(", ")} (it has ${parent.caps.join(",") || "none"}).`);

  let to = parent.to ? [...parent.to] : undefined;
  if (flags.chainTo !== undefined) {
    // Workspace names ("supplier") become addresses when the relay published them, so the record
    // matches the parent's (org:seed writes addresses).
    const names = Object.fromEntries(Object.entries(opts.recipients ?? {}).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
    to = parseRecipients(flags.chainTo).map((r) => names[r] ?? r);
    // A name the workspace doesn't resolve can't be compared with a list of addresses (or the
    // reverse); only same-form entries are checked here, and the relay intersects either way.
    if (check && parent.to) {
      const theirs = parent.to.map((x) => (names[x.toLowerCase()] ?? x).toLowerCase());
      const sameForm = (r: string) => theirs.some((x) => ADDRESS.test(x) === ADDRESS.test(r));
      const missing = to.filter((r) => sameForm(r) && !theirs.includes(r));
      if (missing.length) throw new ChainFlagError(`--chain-to: ${parentName} doesn't approve ${missing.join(", ")} (it approves ${parent.to.join(", ")}).`);
    }
  }

  const narrower = (raw: string | undefined, flag: string, above: string | undefined): string | undefined => {
    if (raw === undefined) return above;
    const mine = amountFlag(raw, flag);
    if (check && above !== undefined && toBase(mine)! > (toBase(above) ?? 0n)) throw new ChainFlagError(`${flag} ${mine} is more than ${parentName}'s ${above}.`);
    return mine;
  };
  const max = narrower(flags.chainMax, "--chain-max", parent.max);
  const limit = narrower(flags.chainLimit, "--chain-limit", parent.limit);

  // A limit always says its period (the relay refuses a limit without one).
  let period = parent.period ?? (limit !== undefined ? "month" : undefined);
  if (flags.chainPeriod !== undefined) {
    const p = flags.chainPeriod.trim().toLowerCase();
    if (!(CHAIN_PERIODS as readonly string[]).includes(p)) throw new ChainFlagError(`--chain-period must be ${CHAIN_PERIODS.join(", ")} (got "${flags.chainPeriod}").`);
    period = p as ChainPeriod;
  }

  let gas = parent.gas;
  if (flags.chainGas !== undefined) {
    const g = flags.chainGas.trim();
    if (!/^[1-9]\d{0,9}$/.test(g)) throw new ChainFlagError(`--chain-gas must be a whole number of gas units (got "${flags.chainGas}").`);
    if (check && parent.gas !== undefined && BigInt(g) > BigInt(parent.gas)) throw new ChainFlagError(`--chain-gas ${g} is more than ${parentName}'s ${parent.gas}.`);
    gas = g;
  }

  let approve = parent.approve;
  if (flags.approve !== undefined) {
    const mine = parseApprove(flags.approve);
    if (check && approveRank(mine) > approveRank(parent.approve)) throw new ChainFlagError(`--approve ${mine} is looser than ${parentName}'s ${parent.approve}.`);
    approve = mine;
  }

  // Write methods only for capabilities that use them: a read/track-only grant lists none.
  // (A renewal keeps the methods it has: dropping them isn't what a limit change asks for.)
  const writes = !check || caps.some((c) => c === "prepare" || c === "submit" || c === "manage" || c === "deploy");
  const methods: Record<string, string[]> = {};
  if (writes) for (const [k, v] of Object.entries(parent.methods)) methods[k] = [...v];

  const g: GrantRecord = {
    v: 1,
    caps,
    net: [...parent.net],
    contracts: [...parent.contracts],
    methods,
    exp: Math.min(Math.floor(exp), parent.exp),
    delegate: parent.delegate && !flags.noDelegate,
    approve,
  };
  if (to !== undefined) g.to = to;
  if (max !== undefined) g.max = max;
  if (limit !== undefined) g.limit = limit;
  if (period !== undefined) g.period = period;
  if (gas !== undefined) g.gas = gas;
  return g;
}

/** "read, track, prepare · to supplier · 3 STD per tx, 20 STD per month · approval always". */
export function describeGrant(g: GrantRecord): string {
  const parts = [g.caps.join(", ") || "no capabilities"];
  if (g.to?.length) parts.push(`to ${g.to.join(", ")}`);
  const amounts = [g.max ? `${g.max} STD per tx` : null, g.limit ? `${g.limit} STD per ${g.period === "total" ? "term" : (g.period ?? "month")}` : null].filter(Boolean);
  if (amounts.length) parts.push(amounts.join(", "));
  parts.push(`approval ${g.approve}`);
  if (!g.delegate) parts.push("no further delegation");
  return parts.join(" · ");
}

// --- Printing relay answers -------------------------------------------------------------------------

type Loose = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Relay text is data, never terminal control: strip control characters before printing. */
export const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** One line for a proposal: id, state, what it does. */
export function proposalLine(p: Loose): string {
  const display = (p.display ?? {}) as Loose;
  const target = (p.target ?? {}) as Loose;
  const approval = (p.approval ?? {}) as Loose;
  const summary = str(display.summary) || `${str(target.label) || str(target.kind)}.${str(p.method)}(${Array.isArray(p.args) ? p.args.map(str).join(", ") : ""})`;
  const blocked = p.state === "blocked" && approval.rule ? ` [${str(approval.rule)}]` : "";
  const reason = p.state === "blocked" ? lastDetail(p) : "";
  return clean(`${str(p.id)}  ${str(p.state)}${blocked}  ${clip(summary)}${reason ? ` — ${clip(reason)}` : ""}`);
}

const lastDetail = (p: Loose) => {
  const events = Array.isArray(p.events) ? (p.events as Loose[]) : [];
  return str(events.at(-1)?.detail);
};

/** The proposal in full: target, call, gas, approval, tx and timeline. */
export function proposalDetail(p: Loose, explorer = "https://sepolia.etherscan.io"): string[] {
  const target = (p.target ?? {}) as Loose;
  const approval = (p.approval ?? {}) as Loose;
  const submit = (p.submit ?? null) as Loose | null;
  const receipt = (p.receipt ?? null) as Loose | null;
  const agent = (p.agent ?? {}) as Loose;
  const lines = [
    proposalLine(p),
    `  requested by ${str(agent.name)} · network ${str(p.network) || "sepolia"}`,
    `  target      ${str(target.label) || str(target.kind)}${target.address ? ` ${str(target.address)}` : ""}`,
    `  call        ${str(p.method)}(${Array.isArray(p.args) ? p.args.map(str).join(", ") : ""})`,
    `  gas         ${str(p.gasEstimate) || "-"}`,
    `  approval    ${approval.required ? `required (${str(approval.rule)})${approval.approver ? `, approved by ${str(approval.approver)}` : ""}` : "not required"}`,
  ];
  if (submit?.hash) lines.push(`  tx          ${explorer}/tx/${str(submit.hash)}`);
  if (receipt) lines.push(`  block       ${str(receipt.blockNumber)} · ${str(receipt.status)} · ${str(receipt.confirmations)} confirmations${receipt.contractAddress ? ` · contract ${str(receipt.contractAddress)}` : ""}`);
  for (const e of Array.isArray(p.events) ? (p.events as Loose[]) : []) {
    const at = typeof e.at === "number" ? new Date(e.at * (e.at > 1e12 ? 1 : 1000)).toISOString().slice(11, 19) : "";
    lines.push(`    ${at} ${str(e.state)}${e.detail ? `: ${clip(str(e.detail), 200)}` : ""}`);
  }
  return lines.map(clean);
}

/** What `relay chain task` prints: plan, results, findings, proposals, report. */
export function taskReport(r: Loose): string[] {
  const lines: string[] = [];
  const plan = (r.plan ?? {}) as Loose;
  const steps = Array.isArray(plan.steps) ? (plan.steps as Loose[]) : [];
  const results = Array.isArray(r.results) ? (r.results as Loose[]) : [];
  lines.push(`Plan${r.runId ? ` (${str(r.runId)})` : ""}:`);
  if (!steps.length) lines.push("  (no steps)");
  steps.forEach((s, i) => {
    const target = [str(s.contract), str(s.method)].filter(Boolean).join(".");
    const args = Array.isArray(s.args) && s.args.length ? `(${s.args.map(str).join(", ")})` : "";
    const extra = [s.recipient ? `to ${str(s.recipient)}` : "", s.amount ? `${str(s.amount)} STD` : "", s.proposalId ? str(s.proposalId) : ""].filter(Boolean).join(" ");
    lines.push(`  ${i + 1}. ${str(s.tool)} ${target}${args}${extra ? ` ${extra}` : ""}`);
    if (s.why) lines.push(`     why: ${clip(str(s.why), 200)}`);
    const res = results.find((x) => x && x.step === i) ?? (results.some((x) => x && typeof x.step === "number") ? undefined : results[i]);
    if (res) lines.push(`     → ${resultText(res)}`);
  });
  if (plan.expected) lines.push(`  expected: ${clip(str(plan.expected), 300)}`);

  const findings = Array.isArray(r.findings) ? (r.findings as Loose[]) : [];
  if (findings.length) {
    lines.push("", "Findings (a flag is a rule match, not proof of wrongdoing):");
    for (const f of findings) {
      lines.push(`  [${str(f.rule)}] ${str(f.amount)} STD ${str(f.from)} → ${str(f.to)} · block ${str(f.block)}`);
      if (f.explorerUrl) lines.push(`    ${str(f.explorerUrl)}`);
      if (f.why) lines.push(`    why: ${clip(str(f.why), 300)}`);
    }
  }
  const proposals = Array.isArray(r.proposals) ? (r.proposals as Loose[]) : [];
  if (proposals.length) {
    lines.push("", "Proposals:");
    for (const p of proposals) lines.push(`  ${proposalLine(p)}`);
  }
  lines.push("", "Report:");
  if (typeof r.report === "string" && r.report.trim()) lines.push(...r.report.trim().split("\n").map((l) => `  ${l}`));
  else lines.push(`  (none${r.reportReason || r.reportError || r.reason ? `: ${str(r.reportReason ?? r.reportError ?? r.reason)}` : ""})`);
  return lines.map(clean);
}

function resultText(res: Loose): string {
  if (res.blocked || res.ok === false || res.rule) {
    const rule = res.rule ? `[${str(res.rule)}] ` : "";
    return `blocked ${rule}${clip(str(res.reason ?? res.error ?? res.blocked), 200)}`;
  }
  if (res.proposal && typeof res.proposal === "object") return `proposal ${proposalLine(res.proposal as Loose)}`;
  const body = res.display ?? res.output ?? res.events ?? res.result ?? res.status ?? res;
  return clip(str(body), 200);
}

// --- Approvals and renewals -------------------------------------------------------------------------

/** What an id passed to `relay approve` is. */
export function approveTarget(id: string): "proposal" | "incident" | null {
  if (/^prp_[A-Za-z0-9_-]+$/.test(id)) return "proposal";
  if (/^inc_[A-Za-z0-9_-]+$/.test(id)) return "incident";
  return null;
}

/** An absolute portal URL from what the relay returned (it may be a path). */
export function absoluteUrl(url: unknown, base: string, fallbackPath: string): string {
  const raw = typeof url === "string" && url.trim() ? url.trim() : fallbackPath;
  try {
    const u = new URL(raw, `${base}/`);
    return /^https?:$/.test(u.protocol) ? u.href : new URL(fallbackPath, `${base}/`).href;
  } catch {
    return new URL(fallbackPath, `${base}/`).href;
  }
}

/** The line a paused renewal prints (SKILL.md tells Codex to stop on `paused:`). */
export function pausedLine(name: string, incidentId: string, url: string): string {
  return clean(`paused: ${name} is under review (incident ${incidentId}) ${url}`);
}
