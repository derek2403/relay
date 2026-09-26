// Incidents: opening one (renewal request, drift, agent report), revising it
// when the subject changes again, and applying a verified decision. Also the
// drift check the guard runs on every decide(). Everything here mutates the
// store's data inside a commit; nothing awaits.

import { randomBytes } from "node:crypto";

import { type Address, type Hex, isAddressEqual } from "viem";

import { namehash } from "../../ens/names";
import type { Bundle } from "../bundle";
import { type GuardLevel, memberLevelIndex } from "../guard";
import type { Meter } from "../meter";
import type { LogEntry } from "../types";
import { type Flag, POLICY_VERSION, type NarrowScope, RULE_TEXT, renewalFlags, suggestions } from "./rules";
import { type ScopeView, chainScopeText, readChainScope, scopeKey, scopeOf } from "./scope";
import type { ApprovalsStore, Baseline, Challenge, Incident, StoreData, StoredOverlay, WorldEvidence } from "./store";

export const REVIEW_WINDOW_SEC = 72 * 3600;
export const EXPECT_TTL_SEC = 15 * 60;
export const REPORTS_PER_HOUR = 3;
export const MAX_REPORT_CHARS = 2000;

/** A bundle that allows nothing (an approved scope for a name that had no provider access). */
export const NO_PROVIDERS: Bundle = { keys: [], caps: {}, maxes: {}, period: "total" };

export const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

/** The store key of a level: "<namehash>:<resource>". A re-registered label has a new resource. */
export const keyOf = (name: string, resource: string | null) => `${namehash(name)}:${resource ?? "0"}`;

export const parentOf = (name: string) => name.slice(name.indexOf(".") + 1);

/** Agent text as stored: control characters stripped, at most 2000 characters. Never used by any rule. */
export const untrustedText = (raw: unknown, max = MAX_REPORT_CHARS) =>
  typeof raw === "string" ? raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").slice(0, max) : "";

export type RulesCtx = { knownRecipients: () => Record<string, Address> };

/** The open incident on a key, if any. */
export const openIncidentOn = (d: StoreData, key: string): Incident | null => Object.values(d.incidents).find((i) => i.key === key && i.state === "open") ?? null;

/** The baseline for a level, created from the chain on first sight (trust on first use). */
export function ensureBaseline(d: StoreData, key: string, level: Pick<GuardLevel, "name" | "bundle" | "chain" | "expiry" | "owner">, nowSec: number): Baseline {
  const existing = d.baselines[key];
  if (existing) return existing;
  const scope = scopeOf(level);
  const b: Baseline = { name: level.name, scope, at: nowSec, chainHash: scopeKey(scope), source: "first-seen" };
  d.baselines[key] = b;
  return b;
}

/** The previous term, known only once the relay saw the scope start. */
export const prevTerm = (b: Baseline) => (b.source === "first-seen" || b.scope.expiry === null ? null : b.scope.expiry - b.at);

export function evidenceFor(meter: Meter | null, name: string): Incident["evidence"] & { affected: Incident["affected"] } {
  const recent = meter?.recent(500) ?? [];
  const mine = recent.filter((e) => e.name === name);
  const log = [...mine.filter((e) => !e.allowed), ...mine.filter((e) => e.allowed)].slice(0, 20);
  const refusedChain = mine.filter((e) => !e.allowed && e.provider === "multibaas").slice(0, 20);
  const below = [...new Set(recent.map((e) => e.name).filter((n): n is string => !!n && n.endsWith(`.${name}`)))];
  return { log, refusedChain, affected: [{ name, relation: "subject" }, ...below.map((n) => ({ name: n, relation: "below" as const }))] };
}

export function audit(d: StoreData, meter: Meter | null, e: { kind: string; by: string; subject: string | null; detail: string; incidentId?: string; allowed?: boolean }) {
  const at = Math.floor(Date.now() / 1000);
  d.audit.push({ at, kind: e.kind, by: e.by, subject: e.subject, detail: e.detail });
  if (e.incidentId && d.incidents[e.incidentId]) d.incidents[e.incidentId].events.push({ at, kind: e.kind, by: e.by, detail: e.detail });
  meter?.log({
    ts: Date.now(),
    name: e.subject,
    provider: "approvals",
    method: "POST",
    path: e.incidentId ? `/incidents/${e.incidentId}` : `/${e.kind}`,
    allowed: e.allowed ?? true,
    reason: e.detail.slice(0, 300),
    status: null,
    costUsd: null,
    estimated: false,
    signer: null,
  } satisfies LogEntry);
}

export const flagText = (flags: Flag[]) => flags.map((f) => `${f.id} ${RULE_TEXT[f.id]}`).join(", ");

export type OpenArgs = {
  root: string;
  key: string;
  level: Pick<GuardLevel, "name" | "resource" | "owner" | "bundle" | "chain" | "expiry">;
  baseline: Baseline;
  proposed: ScopeView | null;
  flags: Flag[];
  trigger: Incident["trigger"];
  chainHash: string;
  report?: { by: string; category: string; text: string } | null;
  nowSec: number;
};

/** Opens an incident and suspends the subject (and so everything below it). */
export function openIncident(d: StoreData, meter: Meter | null, a: OpenArgs): Incident {
  const id = newId("inc");
  const ev = evidenceFor(meter, a.level.name);
  const incident: Incident = {
    id,
    root: a.root,
    revision: 1,
    state: "open",
    key: a.key,
    subject: { name: a.level.name, node: namehash(a.level.name), resource: a.level.resource ?? "0", owner: a.level.owner, parent: parentOf(a.level.name) },
    trigger: a.trigger,
    previous: { ...a.baseline.scope, source: a.baseline.source },
    proposed: a.proposed,
    flags: a.flags,
    evidence: { log: ev.log, refusedChain: ev.refusedChain },
    affected: ev.affected,
    affectedPartial: true,
    agentReports: a.report ? [{ ...a.report, at: a.nowSec, untrusted: true }] : [],
    suggested: suggestions(a.baseline.scope, !!a.proposed),
    policyVersion: POLICY_VERSION,
    remediation: "not assessed",
    resolution: null,
    events: [],
    chainHash: a.chainHash,
    openedAt: a.nowSec,
    reviewBy: a.nowSec + REVIEW_WINDOW_SEC,
  };
  d.incidents[id] = incident;
  d.suspensions[a.key] = { incidentId: id, name: a.level.name, since: a.nowSec, permanent: false };
  const why = a.flags.length ? flagText(a.flags) : `agent report (unverified): ${a.report?.category ?? "report"}`;
  audit(d, meter, { kind: "incident_opened", by: a.trigger.requestedBy ?? "relay", subject: a.level.name, incidentId: id, allowed: false, detail: `incident opened (${why}); paused ${a.level.name} and everything below it` });
  return incident;
}

/** Marks every issued challenge for an incident failed (it changed; a new approval is needed). */
export function invalidateChallenges(d: StoreData, incidentId: string, why: string) {
  for (const c of Object.values(d.challenges)) {
    if (c.status === "issued" && c.subject?.kind === "incident" && c.subject.id === incidentId) {
      c.status = "failed";
      c.failure = why;
    }
  }
}

/** The subject changed again while under review: a new revision; pending approvals are void. */
export function reviseIncident(d: StoreData, meter: Meter | null, incident: Incident, scope: ScopeView, hash: string, flags: Flag[] | null, nowSec: number) {
  incident.revision += 1;
  incident.chainHash = hash;
  if (incident.trigger.source === "drift") {
    incident.proposed = scope;
    if (flags) incident.flags = flags;
  }
  invalidateChallenges(d, incident.id, "incident_changed");
  audit(d, meter, { kind: "incident_revised", by: "relay", subject: incident.subject.name, incidentId: incident.id, allowed: false, detail: `the chain changed while under review (revision ${incident.revision}); pending approvals were voided` });
  void nowSec;
}

/**
 * Drift detection for the guard: for each agent level, compare the chain's
 * scope with the baseline. First sight → baseline. A matching cleared renewal
 * or a narrowing → adopted. An expansion → incident + suspension. Map lookups
 * only; the store is written only when something changed.
 */
export function observeLevels(
  store: ApprovalsStore,
  meter: Meter | null,
  ctx: RulesCtx & { root: string; rootOwner: Address | null },
  levels: GuardLevel[],
  nowSec: number,
) {
  if (store.unavailable()) return;
  const member = memberLevelIndex(levels, ctx.rootOwner);
  if (member < 0) return;
  for (let i = member + 1; i < levels.length; i++) {
    const level = levels[i];
    if (level.status !== "registered" || !level.resource) continue;
    const key = keyOf(level.name, level.resource);
    const d = store.data;
    const scope = scopeOf(level);
    const hash = scopeKey(scope);
    const base = d.baselines[key];
    if (!base) {
      store.tryCommit((data) => void ensureBaseline(data, key, level, nowSec));
      continue;
    }
    if (base.chainHash === hash) continue;
    const open = openIncidentOn(d, key);
    if (open) {
      if (open.chainHash !== hash) {
        const flags = renewalFlags(base.scope, scope, { nowSec, prevTermSec: prevTerm(base), knownRecipients: ctx.knownRecipients() });
        store.tryCommit((data) => reviseIncident(data, meter, data.incidents[open.id], scope, hash, flags, nowSec));
      }
      continue;
    }
    if (d.suspensions[key]) continue; // rejected or revoked: stays paused, nothing to adopt
    const known = ctx.knownRecipients();
    const expect = Object.values(d.expects).find((e) => e.key === key && e.expiresAt >= nowSec && renewalFlags(e.scope, scope, { nowSec, knownRecipients: known }).length === 0);
    const flags = expect ? [] : renewalFlags(base.scope, scope, { nowSec, prevTermSec: prevTerm(base), knownRecipients: known });
    // A direct child of the member level has its records on the member's own resolver: the human
    // wrote this change with their own key (e.g. `relay login` adding multibaas and a chain grant to
    // an existing codex agent). Adopt it when it stays within the member's own ENS scope.
    const ownerWrote = flags.length > 0 && i === member + 1 && withinMember(levels[member], scope, nowSec, known);
    if (!flags.length || ownerWrote) {
      store.tryCommit((data) => {
        data.baselines[key] = { name: level.name, scope, at: nowSec, chainHash: hash, source: "cleared" };
        if (expect) delete data.expects[expect.id];
        for (const [id, o] of Object.entries(data.overlays)) if (o.key === key && o.notAfter <= nowSec) delete data.overlays[id];
        const detail = expect
          ? `cleared renewal ${expect.id} is on chain; adopted`
          : ownerWrote
            ? `${levels[member].name} changed its own agent within its own scope (${flagText(flags)}); adopted as the baseline`
            : "the chain narrowed; adopted as the baseline";
        audit(data, meter, { kind: expect ? "renewal_adopted" : ownerWrote ? "owner_changed" : "narrowed", by: "relay", subject: level.name, detail });
      });
      continue;
    }
    store.tryCommit((data) =>
      openIncident(data, meter, {
        root: ctx.root,
        key,
        level,
        baseline: base,
        proposed: scope,
        flags,
        trigger: { source: "drift", requestedBy: null, at: nowSec },
        chainHash: hash,
        nowSec,
      }),
    );
  }
}

/**
 * Whether an agent's scope is within its member's own ENS scope (bundle,
 * chain grant, expiry): every rule passes comparing the member's scope to the
 * agent's. The owner (R10) differs by design (the agent has its own key) and
 * isn't compared; an unreadable chain grant never counts as within.
 */
function withinMember(memberLevel: GuardLevel, scope: ScopeView, nowSec: number, known: Record<string, Address>): boolean {
  if (scope.chainUnreadable) return false;
  const memberScope = scopeOf(memberLevel);
  if (memberScope.chainUnreadable) return false;
  return renewalFlags(memberScope, { ...scope, owner: null }, { nowSec, knownRecipients: known }).length === 0;
}

/** The overlay an approval creates. */
function overlayFor(incident: Incident, scope: NarrowScope, notAfter: number, approver: Address, digest: Hex, nowSec: number): StoredOverlay {
  const id = newId("ov");
  const prev = incident.previous;
  const bundle = scope.bundle !== undefined ? scope.bundle : prev.bundle;
  const chain = scope.chain !== undefined ? scope.chain : prev.chain;
  return {
    id,
    key: incident.key,
    name: incident.subject.name,
    incidentId: incident.id,
    bundle: bundle ?? NO_PROVIDERS,
    chain: chain ? chainScopeText(chain) : null,
    notAfter,
    bucket: `approval:${id}`,
    approver,
    digest,
    at: nowSec,
  };
}

/**
 * Applies a verified incident decision. approve / approve-narrower: one
 * overlay for the approved scope (replacing earlier ones), the suspension
 * lifted, the baseline set to the approved scope. reject: stays paused.
 * revoke: paused permanently.
 */
export function applyIncidentDecision(
  d: StoreData,
  meter: Meter | null,
  incident: Incident,
  c: Challenge,
  world: WorldEvidence | null,
  nowSec: number,
): StoredOverlay | null {
  const decision = c.decision!;
  let overlay: StoredOverlay | null = null;
  if (decision === "approve" || decision === "approve-narrower") {
    const scope = c.scope!;
    const notAfter = c.notAfter ?? nowSec + scope.durationSec;
    overlay = overlayFor(incident, scope, notAfter, c.approver, c.digest, nowSec);
    for (const [id, o] of Object.entries(d.overlays)) if (o.key === incident.key) delete d.overlays[id];
    d.overlays[overlay.id] = overlay;
    if (d.suspensions[incident.key]?.incidentId === incident.id) delete d.suspensions[incident.key];
    const approved: ScopeView = {
      bundle: overlay.bundle,
      chain: readChainScope(overlay.chain),
      expiry: decision === "approve" ? (incident.proposed?.expiry ?? incident.previous.expiry) : incident.previous.expiry,
      owner: incident.previous.owner,
    };
    d.baselines[incident.key] = { name: incident.subject.name, scope: approved, at: nowSec, chainHash: incident.chainHash, source: "approval" };
    incident.state = decision === "approve" ? "resolved:approved" : "resolved:approved-narrower";
  } else if (decision === "reject") {
    incident.state = "resolved:rejected";
  } else {
    incident.state = "resolved:revoked";
    const s = d.suspensions[incident.key];
    d.suspensions[incident.key] = { incidentId: incident.id, name: incident.subject.name, since: s?.since ?? nowSec, permanent: true };
  }
  incident.resolution = { decision, approver: c.approver, digest: c.digest, world, at: nowSec, overlayId: overlay?.id ?? null };
  const text =
    decision === "reject"
      ? "renewal rejected; stays paused"
      : decision === "revoke"
        ? "branch revoked; paused permanently (remove it on ENS next)"
        : `approved ${decision === "approve" ? "as requested" : "narrower scope"} ${c.digest.slice(0, 10)} until ${new Date(overlay!.notAfter * 1000).toISOString()}; resumed with the approved scope only`;
  audit(d, meter, { kind: `decision_${decision}`, by: c.approver, subject: incident.subject.name, incidentId: incident.id, detail: text });
  return overlay;
}

export const sameAddress = (a: Address | null | undefined, b: Address | null | undefined) => !!a && !!b && isAddressEqual(a, b);
