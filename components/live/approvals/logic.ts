// Pure logic behind the Approvals view: incident diffs, rule words, the "approve narrower" scope,
// who may approve (a hint; the relay decides), and error codes in words. tests/live-chain.test.ts.

import { type Address, isAddressEqual } from "viem";

import {
  CAP_LABELS,
  type ChainGrant,
  PERIOD_WORDS,
  approveText,
  grantFromObject,
  readGrant,
  recipientLabel,
  serializeGrant,
  toBase,
} from "@/components/live/chain/grant-model";
import type { Bundle } from "@/lib/relay/bundle";
import { providerLabel, usd } from "@/lib/relay/browser";

import type { AgentReport, Decision, Flag, Incident, IncidentSummary, Snapshot, Subject, Trigger } from "./api";

/** Required honesty lines (spec §7.5, Appendix B) wherever a World proof is asked for or shown. */
export const PRESENCE_NOTE = "Presence check: reported by World App, not verifiable by the relay.";
export const STAGING_NOTE = "Staging (simulator) proofs demonstrate the flow; they are not a security assurance.";

/** The notes to show next to a World step or a recorded World proof. */
export function worldNotes(world: { environment?: string | null; presence?: string | null } | null | undefined): string[] {
  if (!world) return [];
  const out: string[] = [];
  if (world.presence !== "not-requested") out.push(PRESENCE_NOTE);
  if (world.environment === "staging") out.push(STAGING_NOTE);
  return out;
}

export const subjectName = (inc: Pick<IncidentSummary, "subject">) => (typeof inc.subject === "string" ? inc.subject : (inc.subject?.name ?? "unknown"));

/** Renewal rules R1–R10 (spec §7.4) in words. */
export const RULE_WORDS: Record<string, string> = {
  R1: "New API",
  R2: "Dollar cap raised or removed",
  R3: "Request/image cap raised or removed",
  R4: "Budget period changed",
  R5: "Much longer expiry",
  R6: "Payment recipients changed",
  R7: "Recipient unknown to the workspace",
  R8: "Blockchain limit raised",
  R9: "New blockchain tool, contract or method",
  R10: "Owner or address changed",
};

export type FlagView = { rule: string; words: string; text: string; critical: boolean };

export function flagView(flag: Flag): FlagView {
  if (typeof flag === "string") {
    const rule = flag.match(/^R\d+/)?.[0] ?? flag;
    return { rule, words: RULE_WORDS[rule] ?? flag, text: flag === rule ? "" : flag, critical: rule === "R7" };
  }
  const rule = flag.id ?? flag.rule ?? "rule";
  return {
    rule,
    words: RULE_WORDS[rule] ?? rule,
    text: flag.detail ?? flag.message ?? flag.why ?? "",
    critical: flag.severity === "critical" || rule === "R7",
  };
}

const TRIGGER_WORDS: Record<string, string> = {
  "renewal-request": "Renewal request",
  drift: "Changed on ENS without an approval",
  "agent-report": "Reported by an agent",
};

/** "Renewal request (by codex.derek…)". */
export function triggerText(trigger: Trigger | undefined): string {
  if (!trigger) return "Review needed";
  if (typeof trigger === "string") return TRIGGER_WORDS[trigger] ?? trigger;
  const words = TRIGGER_WORDS[trigger.source] ?? trigger.source;
  return trigger.requestedBy ? `${words} (by ${trigger.requestedBy})` : words;
}

export const affectedNames = (affected: Incident["affected"]) => (affected ?? []).map((a) => (typeof a === "string" ? a : a.name));

export const reportText = (r: AgentReport) => r.text ?? r.explanation ?? "";
export const reportBy = (r: AgentReport) => r.by ?? r.reporter ?? null;

export const incidentStateText = (state: string) =>
  state === "open"
    ? "Paused · waiting for review"
    : state === "approving"
      ? "Approval in progress"
      : state === "resolved:approved"
        ? "Approved as requested"
        : state === "resolved:approved-narrower"
          ? "Approved (narrower)"
          : state === "resolved:rejected"
            ? "Rejected · stays paused"
            : state === "resolved:revoked"
              ? "Revoked"
              : state === "expired"
                ? "Expired · stays paused"
                : state;

export const isOpen = (state: string) => state === "open" || state === "approving";

/** A snapshot's chain grant: the record text or the object, parsed the same way. */
export const snapshotGrant = (s: Snapshot | null | undefined): ChainGrant | null =>
  !s?.chain ? null : typeof s.chain === "string" ? readGrant(s.chain) : grantFromObject(s.chain);

export type DiffRow = { field: string; before: string; after: string; expansion: boolean };

const list = (items: readonly string[] | undefined) => (items?.length ? items.join(", ") : "—");
const dateText = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toLocaleString() : "—");
/** b allows more than a (a limit removed counts as more). */
const bigger = (a: string | undefined, b: string | undefined) =>
  b === undefined ? a !== undefined : a !== undefined && (toBase(b) ?? 0n) > (toBase(a) ?? 0n);

function bundleRows(a: Bundle | null | undefined, b: Bundle | null | undefined): DiffRow[] {
  if (!a && !b) return [];
  const rows: DiffRow[] = [];
  const keysA = a?.keys ?? [];
  const keysB = b?.keys ?? [];
  rows.push({ field: "APIs", before: list(keysA.map(providerLabel)), after: list(keysB.map(providerLabel)), expansion: keysB.some((k) => !keysA.includes(k)) });
  for (const id of [...new Set([...keysA, ...keysB])]) {
    const capA = a?.caps[id];
    const capB = b?.caps[id];
    if (capA !== capB) {
      rows.push({
        field: `${providerLabel(id)} $ cap`,
        before: capA === undefined ? "no cap" : usd(capA),
        after: capB === undefined ? "no cap" : usd(capB),
        expansion: capB === undefined ? capA !== undefined : capA !== undefined && capB > capA,
      });
    }
    const maxA = a?.maxes?.[id];
    const maxB = b?.maxes?.[id];
    if (maxA !== maxB) {
      rows.push({
        field: `${providerLabel(id)} count cap`,
        before: maxA === undefined ? "no limit" : String(maxA),
        after: maxB === undefined ? "no limit" : String(maxB),
        expansion: maxB === undefined ? maxA !== undefined : maxA !== undefined && maxB > maxA,
      });
    }
  }
  if ((a?.period ?? null) !== (b?.period ?? null)) rows.push({ field: "Budget period", before: a?.period ?? "—", after: b?.period ?? "—", expansion: true });
  return rows;
}

function chainRows(a: ChainGrant | null, b: ChainGrant | null, recipients: Record<string, string>): DiffRow[] {
  if (!a && !b) return [];
  const rows: DiffRow[] = [];
  const newOnes = <T>(x: readonly T[] = [], y: readonly T[] = []) => y.some((v) => !x.includes(v));
  const push = (field: string, before: string, after: string, expansion: boolean) => {
    if (before !== after) rows.push({ field, before, after, expansion });
  };
  push("Chain tools", list(a?.caps.map((c) => CAP_LABELS[c])), list(b?.caps.map((c) => CAP_LABELS[c])), newOnes(a?.caps, b?.caps));
  push("Contracts", list(a?.contracts), list(b?.contracts), newOnes(a?.contracts, b?.contracts));
  const methods = (g: ChainGrant | null) => (g ? Object.entries(g.methods).flatMap(([k, ms]) => (ms ?? []).map((m) => `${k}.${m}`)) : []);
  push("Methods", list(methods(a)), list(methods(b)), newOnes(methods(a), methods(b)));
  const norm = (t: string) => (recipients[t] ?? t).toLowerCase();
  const toA = (a?.to ?? []).map(norm);
  push(
    "Recipients",
    list(a?.to?.map((t) => recipientLabel(t, recipients))),
    list(b?.to?.map((t) => recipientLabel(t, recipients))),
    (b?.to ?? []).some((t) => !toA.includes(norm(t))),
  );
  push("Per transaction", a?.max ? `${a.max} STD` : "no max", b?.max ? `${b.max} STD` : "no max", !!b && bigger(a?.max, b.max));
  push(
    "Chain limit",
    a?.limit ? `${a.limit} STD ${PERIOD_WORDS[a.period ?? "month"]}` : "no limit",
    b?.limit ? `${b.limit} STD ${PERIOD_WORDS[b.period ?? "month"]}` : "no limit",
    !!b && (bigger(a?.limit, b.limit) || (a?.period ?? "month") !== (b.period ?? "month")),
  );
  push("Gas per tx", a?.gas ?? "no cap", b?.gas ?? "no cap", !!b && (b.gas === undefined ? a?.gas !== undefined : a?.gas !== undefined && BigInt(b.gas) > BigInt(a.gas)));
  push("Grant expiry", dateText(a?.exp), dateText(b?.exp), !!b?.exp && (!a?.exp || b.exp > a.exp));
  push("Approval", approveText(a?.approve), approveText(b?.approve), !!b && b.approve !== a?.approve && b.approve !== "always");
  push("Delegation", a?.delegate === true ? "yes" : "no", b?.delegate === true ? "yes" : "no", a?.delegate !== true && b?.delegate === true);
  return rows;
}

/** "What would change": previous vs proposed, expansions flagged. */
export function diffRows(inc: Pick<Incident, "previous" | "proposed">, recipients: Record<string, string> = {}): DiffRow[] {
  const a = inc.previous ?? null;
  const b = inc.proposed ?? null;
  const rows = [...bundleRows(a?.bundle, b?.bundle), ...chainRows(snapshotGrant(a), snapshotGrant(b), recipients)];
  const expA = a?.expiry ?? a?.expiresAt ?? null;
  const expB = b?.expiry ?? b?.expiresAt ?? null;
  if (expA !== expB && expB) {
    rows.push({ field: "Name expiry", before: dateText(expA), after: dateText(expB), expansion: !expA || expB > expA });
  }
  if (a?.owner && b?.owner && !isAddressEqual(a.owner, b.owner)) rows.push({ field: "Owner", before: a.owner, after: b.owner, expansion: true });
  return rows;
}

// --- Approve narrower ------------------------------------------------------------------

export const NARROW_DURATIONS = [
  { label: "15 minutes", sec: 900 },
  { label: "1 hour", sec: 3_600 },
  { label: "1 day", sec: 86_400 },
] as const;

export type NarrowDraft = { recipients: string[]; amount: string; durationSec: number };

/**
 * The suggested narrower scope: the relay's own suggestion when it sent one, else previous
 * recipients, min(previous per-tx, 5) STD, one hour.
 */
export function defaultNarrow(inc: Pick<Incident, "previous" | "suggested">): NarrowDraft {
  const g = snapshotGrant(inc.previous);
  const five = "5";
  const amount = g?.max && (toBase(g.max) ?? 0n) < (toBase(five) ?? 0n) ? g.max : five;
  const draft: NarrowDraft = { recipients: [...(g?.to ?? [])], amount, durationSec: 3_600 };
  const hint = inc.suggested?.find((s) => typeof s === "object" && s.decision === "approve-narrower");
  const scope = hint && typeof hint === "object" ? hint.scope : undefined;
  const sg = scope?.chain ? snapshotGrant({ chain: scope.chain }) : null;
  if (sg?.max) draft.amount = sg.max;
  if (sg?.to) draft.recipients = sg.to.filter((t) => (g?.to ?? []).includes(t));
  if (scope?.durationSec && NARROW_DURATIONS.some((d) => d.sec === scope.durationSec)) draft.durationSec = scope.durationSec;
  return draft;
}

/** The scope sent with an "approve-narrower" challenge, or the error to show. */
export function narrowScope(inc: Pick<Incident, "previous">, d: NarrowDraft, nowSec: number): { scope: { chain?: ChainGrant; bundle?: Bundle; durationSec: number }; error: null } | { scope: null; error: string } {
  const prev = snapshotGrant(inc.previous);
  if (!Number.isInteger(d.durationSec) || d.durationSec <= 0 || d.durationSec > 86_400) return { scope: null, error: "Pick a duration of at most one day." };
  // The bundle is left out: the relay keeps the previous one for the approved scope.
  const scope: { chain?: ChainGrant; bundle?: Bundle; durationSec: number } = { durationSec: d.durationSec };
  if (prev) {
    const amount = d.amount.trim();
    const base = toBase(amount);
    if (base === null || base <= 0n) return { scope: null, error: "Enter a positive STD amount, e.g. 5." };
    if (prev.max && base > (toBase(prev.max) ?? 0n)) return { scope: null, error: `At most the previous per-transaction max (${prev.max} STD).` };
    const allowed = prev.to ?? [];
    const to = d.recipients.filter((r) => allowed.includes(r));
    if (!to.length && allowed.length) return { scope: null, error: "Keep at least one of the previous recipients, or reject instead." };
    const exp = Math.min(prev.exp ?? Number.MAX_SAFE_INTEGER, nowSec + d.durationSec);
    const chain: ChainGrant = { ...prev, methods: { ...prev.methods }, max: amount, limit: amount, exp };
    if (prev.limit && base > (toBase(prev.limit) ?? 0n)) chain.limit = prev.limit;
    if (!chain.period) chain.period = prev.period ?? "month";
    if (prev.to) chain.to = to;
    scope.chain = chain;
  }
  return { scope, error: null };
}

/** Record text of a scope's chain grant (for showing exactly what will be approved). */
export const scopeText = (scope: { chain?: ChainGrant } | null) => (scope?.chain ? serializeGrant(scope.chain) : null);

// --- Requirements, eligibility, errors -------------------------------------------------

/** Which proofs a decision needs (spec §7.2). */
export function requirements(kind: Subject["kind"], decision: Decision): { wallet: true; world: boolean } {
  return { wallet: true, world: kind === "incident" && (decision === "approve" || decision === "approve-narrower") };
}

export type EligibilityNode = { name: string; owner: string; kind: "company" | "member" | "agent"; status: string };

/**
 * Whether a wallet looks like an eligible approver for `subject`: it owns a human (non-agent)
 * level above the subject and no agent level on its path. Only a hint: the relay re-reads the chain.
 */
export function approverHint(nodes: readonly EligibilityNode[], subject: string, address: Address | undefined): { ok: boolean; why: string; level?: string } {
  if (!address) return { ok: false, why: "Connect the wallet that owns a level above this name." };
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const path: EligibilityNode[] = [];
  for (let name = subject; name.includes("."); name = name.slice(name.indexOf(".") + 1)) {
    const n = byName.get(name);
    if (n) path.unshift(n);
  }
  const mine = (n: EligibilityNode) => /^0x[0-9a-fA-F]{40}$/.test(n.owner) && isAddressEqual(n.owner as Address, address);
  if (path.some((n) => n.kind === "agent" && mine(n))) return { ok: false, why: "This wallet owns an agent on this path. Agent keys can never approve." };
  const above = path.filter((n) => n.name !== subject && n.kind !== "agent" && n.status === "Active" && mine(n));
  if (!above.length) return { ok: false, why: "This wallet doesn't own a level above this name in the loaded tree. The relay will refuse it." };
  return { ok: true, why: `You approve as the owner of ${above[above.length - 1].name}.`, level: above[above.length - 1].name };
}

const ERROR_WORDS: Record<string, string> = {
  not_eligible: "This wallet isn't an approver for this name.",
  wrong_approver: "The challenge was issued to another wallet.",
  challenge_used: "This challenge was already used. Start again.",
  incident_changed: "The incident changed since you started. Review it again.",
  proposal_changed: "The proposal changed since you started. Review it again.",
  challenge_expired: "The 5-minute window ran out. Start again.",
  wrong_person: "The World ID isn't the one linked to this approver.",
  nonce_mismatch: "The World proof was for another request.",
  signal_mismatch: "The World proof was for another decision.",
  wrong_credential: "World App didn't return a Selfie Check proof.",
  bad_signature: "The wallet signature didn't match.",
  replayed_proof: "That World proof was already used.",
  world_unreachable: "The World Developer Portal didn't answer. Try again.",
  world_not_configured: "World ID isn't set up on this relay.",
  approvals_unavailable: "The approvals store is unavailable, so nothing changes.",
  not_enrolled: "Link your World ID first.",
  already_linked: "This wallet already has a World ID linked.",
  nullifier_linked: "That World ID is linked to another approver.",
  user_rejected: "Cancelled in World App.",
  verification_rejected: "World App declined the verification.",
  credential_unavailable: "Selfie Check isn't available on this World App.",
  invalid_rp_signature: "World App rejected the relay's request signature (check WORLD_RP_SIGNING_KEY).",
  rp_signature_expired: "The request expired before World App answered. Start again.",
  connection_failed: "Couldn't reach World App. Start again.",
  widget_closed: "The World window was closed before a proof arrived.",
  incident_not_open: "This incident is no longer open.",
  proposal_not_awaiting: "This proposal is no longer waiting for approval.",
  proposal_expired: "The proposal expired. The agent has to prepare it again.",
  bad_scope: "The relay refused that scope.",
  unknown_challenge: "The relay doesn't know this challenge. Start again.",
  agent_token_refused: "Approvals are signed by a wallet, never by an agent token.",
  chain_unavailable: "Blockchain proposals aren't available on this relay.",
  ens_unreachable: "ENS couldn't be read. Start again.",
  not_linked: "No World ID is linked to this wallet.",
};

/** "incident_changed" / "world_rejected:all_verifications_failed" → words. */
export function errorWords(code: string): string {
  if (code.startsWith("world_rejected")) return `World rejected the proof (${code.split(":")[1] ?? "unknown"}).`;
  return ERROR_WORDS[code] ?? code;
}

/** Evidence as display lines, whatever shape the route used (array of log entries, or groups). */
export function evidenceLines(evidence: unknown): { key: string; text: string; refused: boolean }[] {
  const out: { key: string; text: string; refused: boolean }[] = [];
  const add = (item: unknown, group: string, i: number) => {
    if (typeof item === "string") return out.push({ key: `${group}-${i}`, text: item, refused: /refus|denied|blocked/i.test(item) });
    if (!item || typeof item !== "object") return;
    const e = item as Record<string, unknown>;
    const time = typeof e.ts === "number" ? new Date(e.ts).toLocaleTimeString() : typeof e.at === "number" ? new Date(e.at * (e.at < 1e12 ? 1000 : 1)).toLocaleTimeString() : null;
    const text = [time, e.name, e.method && e.path ? `${e.method} ${e.path}` : e.path, e.provider, e.reason ?? e.detail ?? e.why].filter(Boolean).join(" · ");
    out.push({ key: `${group}-${i}`, text: text || JSON.stringify(item), refused: e.allowed === false || !!e.rule });
  };
  if (Array.isArray(evidence)) evidence.forEach((item, i) => add(item, "e", i));
  else if (evidence && typeof evidence === "object") {
    for (const [group, items] of Object.entries(evidence)) {
      if (Array.isArray(items)) items.forEach((item, i) => add(item, group, i));
    }
  }
  return out.slice(0, 40);
}

export const suggestionText = (s: NonNullable<Incident["suggested"]>[number]) => (typeof s === "string" ? s : (s.label ?? s.text ?? s.decision ?? ""));

export const DECISION_LABELS: Record<Decision, string> = {
  reject: "Reject",
  "approve-narrower": "Approve narrower",
  approve: "Approve as requested",
  revoke: "Revoke branch",
};
