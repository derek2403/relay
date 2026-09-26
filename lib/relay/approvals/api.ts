// HTTP handlers for /api/relay/approvals/* (the route files are thin wrappers).
//
// Agents (kr1 tokens) may ask for renewals and file reports; neither can
// resolve anything. Humans decide through challenge → confirm: the server
// builds the exact binding and wallet message, the approver signs it (and for
// approvals that grant authority, proves with World ID Selfie Check that they
// are the person who linked their World ID), and confirm re-checks every
// piece before it changes anything. Every failure leaves the subject paused.

import { type Address, type Hex, createPublicClient, getAddress, http, isAddress, isAddressEqual, isHex, keccak256, stringToBytes } from "viem";
import { sepolia } from "viem/chains";

import { tryNormalize } from "../../ens/names";
import { type Viewer, viewerFor } from "../auth";
import { type RelayConfig, applyDnsAlias } from "../config";
import { type ChainReader, type TreeReader, isChainReadError } from "../ens";
import { memberLevelIndex } from "../guard";
import type { Meter } from "../meter";
import { cachedTree, ownedIn } from "../owned";
import { type VerifySignature, verifyEoaSignature } from "../owner-session";
import { RateLimiter, type RelayLimits, clientKey } from "../ratelimit";
import { TOKEN_PREFIX, tokenFromHeaders } from "../token";
import { type WorldConfig, worldConfig } from "../world/config";
import { runPreflight } from "../world/preflight";
import { signRpContext } from "../world/rp";
import { verifyWorldProof } from "../world/verify";
import { type Binding, approvalMessage, approveSignal, bindingDigest, enrollMessage, enrollSignal, iso, unlinkMessage } from "./binding";
import { hooks } from "./hooks";
import {
  EXPECT_TTL_SEC,
  REPORTS_PER_HOUR,
  applyIncidentDecision,
  audit,
  ensureBaseline,
  flagText,
  keyOf,
  newId,
  openIncident,
  openIncidentOn,
  prevTerm,
  untrustedText,
} from "./incidents";
import { DECISIONS, eligibilityProblem, isAgentLevel, requiredFactors } from "./requirements";
import { MAX_NARROW_SEC, type NarrowScope, POLICY_VERSION, narrowerProblem, renewalFlags } from "./rules";
import { type ScopeView, readBundle, readChainScope, scopeKey, scopeOf } from "./scope";
import type { ApprovalsStore, Challenge, Decision, Incident, Subject, WorldEvidence } from "./store";

export const CHALLENGE_TTL_SEC = 300;

export type ApprovalsDeps = {
  config: RelayConfig;
  reader: ChainReader;
  meter: Meter;
  store: ApprovalsStore;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  verifySignature: VerifySignature;
  /** Milliseconds. */
  now: () => number;
  limits: RelayLimits;
  knownRecipients: () => Record<string, Address>;
  /** Confirms per client (they cost a chain read and maybe a Portal call). */
  confirmLimit: RateLimiter;
};

const NO_STORE = { "cache-control": "no-store" };
const ok = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const err = (status: number, error: string, reason: string, extra: Record<string, unknown> = {}) => Response.json({ error, reason, ...extra }, { status, headers: NO_STORE });

const nowSec = (deps: ApprovalsDeps) => Math.floor(deps.now() / 1000);

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => "");
  if (text.length > 64_000) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** EOA signatures locally, then ERC-1271 / ERC-6492 smart accounts through the RPC. */
export function signatureVerifier(rpcUrl: string): VerifySignature {
  return async (args) => {
    if (await verifyEoaSignature(args)) return true;
    try {
      const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { timeout: 10_000 }) });
      return await client.verifyMessage(args);
    } catch {
      return false;
    }
  };
}

export function incidentUrl(config: RelayConfig, id: string) {
  return `${config.publicUrl}/?view=approvals&incident=${encodeURIComponent(id)}`;
}

const unavailable = (deps: ApprovalsDeps) => {
  const why = deps.store.unavailable();
  return why ? err(503, "approvals_unavailable", why) : null;
};

const normName = (deps: ApprovalsDeps, raw: unknown): string | null => {
  if (typeof raw !== "string" || raw.length > 255) return null;
  const n = tryNormalize(raw.trim());
  return n ? applyDnsAlias(n, deps.config.dnsAlias) : null;
};

const inSubtree = (name: string, top: string) => name === top || name.endsWith(`.${top}`);

async function agentViewer(request: Request, deps: ApprovalsDeps): Promise<Extract<Viewer, { kind: "agent" }> | Response> {
  if (!tokenFromHeaders(request.headers)) return err(401, "not signed in", "send the agent's kr1 token (x-api-key or Authorization: Bearer)");
  const v = await viewerFor(request, { config: deps.config, reader: deps.reader, meter: deps.meter, guard: null }, deps.limits);
  if (v instanceof Response) return v;
  if (v.kind !== "agent") return err(401, "not signed in", "an agent token is required");
  return v;
}

async function levelsFor(deps: ApprovalsDeps, name: string) {
  return deps.reader.readLevels(deps.config.rootName ?? "", name);
}

function chainErr(e: unknown): Response {
  if (isChainReadError(e)) return err(502, "ens_unreachable", e instanceof Error ? e.message : "ENS read failed");
  throw e;
}

// --- Renewals --------------------------------------------------------------------------------------------

/**
 * POST /renewals {subject, proposed: {bundle?, chain?, expiresAt?, owner?}, reason?}
 * with the kr1 token of the subject or an agent above it. Compared with the
 * baseline (never with the agent's description): any expansion opens an
 * incident and pauses the subject (202); same-or-narrower is clear (200).
 */
export async function postRenewal(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const down = unavailable(deps);
  if (down) return down;
  const viewer = await agentViewer(request, deps);
  if (viewer instanceof Response) return viewer;
  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "send JSON");
  const subject = normName(deps, body.subject);
  if (!subject) return err(400, "bad_request", "subject must be an ENS name");
  if (!inSubtree(subject, viewer.name)) return err(403, "not_in_subtree", `${viewer.name} can only renew itself or names below it`);
  const p = body.proposed;
  if (!p || typeof p !== "object" || Array.isArray(p)) return err(400, "bad_request", "proposed must be an object");
  const prop = p as Record<string, unknown>;
  const unknownKey = Object.keys(prop).find((k) => !["bundle", "chain", "expiresAt", "owner"].includes(k));
  if (unknownKey) return err(400, "bad_request", `unknown field proposed.${unknownKey}`);

  let levels;
  try {
    levels = await levelsFor(deps, subject);
  } catch (e) {
    return chainErr(e);
  }
  const leaf = levels[levels.length - 1];
  if (!leaf || leaf.status !== "registered" || !leaf.resource) return err(404, "not_registered", `${subject} is not registered`);
  if (!isAgentLevel(levels, deps.config.rootOwner)) return err(403, "not_an_agent", `${subject} is a human level; renewals are for agents`);

  const now = nowSec(deps);
  const key = keyOf(subject, leaf.resource);
  const d = deps.store.data;
  const baseline = d.baselines[key] ?? { name: subject, scope: scopeOf(leaf), at: now, chainHash: scopeKey(scopeOf(leaf)), source: "first-seen" as const };

  let bundle = baseline.scope.bundle;
  if (prop.bundle !== undefined) {
    bundle = prop.bundle === null ? null : readBundle(prop.bundle);
    if (prop.bundle !== null && !bundle) return err(400, "bad_request", "proposed.bundle is malformed");
  }
  let chain = baseline.scope.chain;
  if (prop.chain !== undefined) {
    chain = prop.chain === null ? null : readChainScope(prop.chain);
    if (prop.chain !== null && !chain) return err(400, "bad_request", "proposed.chain is not a valid relay.chain grant");
  }
  let expiry = baseline.scope.expiry;
  if (prop.expiresAt !== undefined) {
    if (typeof prop.expiresAt !== "number" || !Number.isSafeInteger(prop.expiresAt) || prop.expiresAt <= now) return err(400, "bad_request", "proposed.expiresAt must be a future unix time");
    expiry = prop.expiresAt;
  }
  let owner = baseline.scope.owner;
  if (prop.owner !== undefined) {
    if (typeof prop.owner !== "string" || !isAddress(prop.owner, { strict: false })) return err(400, "bad_request", "proposed.owner must be an address");
    owner = getAddress(prop.owner);
  }
  const proposed: ScopeView = { bundle, chain, expiry, owner };
  const reason = untrustedText(body.reason);

  const suspended = d.suspensions[key];
  const open = openIncidentOn(d, key);
  if (open || suspended) {
    const incident = open ?? d.incidents[suspended!.incidentId];
    if (open && reason) {
      deps.store.commit((data) => {
        data.incidents[open.id].agentReports.push({ by: viewer.name, category: "renewal-reason", text: reason, at: now, untrusted: true });
        audit(data, deps.meter, { kind: "renewal_attached", by: viewer.name, subject, incidentId: open.id, allowed: false, detail: "renewal request attached to the open incident; still paused" });
      });
    }
    return ok({ status: "paused", incident: { id: incident?.id ?? suspended!.incidentId, url: incidentUrl(deps.config, incident?.id ?? suspended!.incidentId) }, reason: `paused: ${subject} is under review (incident ${incident?.id ?? suspended!.incidentId})` }, 202);
  }

  const flags = renewalFlags(baseline.scope, proposed, { nowSec: now, prevTermSec: prevTerm(baseline), knownRecipients: deps.knownRecipients() });
  if (flags.length) {
    const incident = deps.store.commit((data) => {
      const base = ensureBaseline(data, key, leaf, now);
      return openIncident(data, deps.meter, {
        root: deps.config.rootName ?? "",
        key,
        level: leaf,
        baseline: base,
        proposed,
        flags,
        trigger: { source: "renewal-request", requestedBy: viewer.name, at: now },
        chainHash: base.chainHash,
        report: reason ? { by: viewer.name, category: "renewal-reason", text: reason } : null,
        nowSec: now,
      });
    });
    return ok(
      {
        status: "paused",
        incident: { id: incident.id, url: incidentUrl(deps.config, incident.id) },
        flags,
        reason: `paused: ${subject} is under review (incident ${incident.id}): ${flagText(flags)}`,
      },
      202,
    );
  }
  const expectId = newId("exp");
  deps.store.commit((data) => {
    ensureBaseline(data, key, leaf, now);
    data.expects[expectId] = { id: expectId, key, name: subject, scope: proposed, expiresAt: now + EXPECT_TTL_SEC, requestedBy: viewer.name };
    audit(data, deps.meter, { kind: "renewal_clear", by: viewer.name, subject, detail: `renewal is same-or-narrower; cleared (${expectId}, 15 min)` });
  });
  return ok({ status: "clear", expectId, expiresAt: now + EXPECT_TTL_SEC });
}

// --- Reports ---------------------------------------------------------------------------------------------

/**
 * POST /reports {subject, category, explanation, evidence?} with a kr1 token.
 * Stored as untrusted text. May open an incident and pause a name in the
 * reporter's subtree (3 per hour per reporter); never resolves anything.
 */
export async function postReport(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const down = unavailable(deps);
  if (down) return down;
  const viewer = await agentViewer(request, deps);
  if (viewer instanceof Response) return viewer;
  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "send JSON");
  const subject = normName(deps, body.subject);
  if (!subject) return err(400, "bad_request", "subject must be an ENS name");
  if (!inSubtree(subject, viewer.name)) return err(403, "not_in_subtree", `${viewer.name} can only report itself or names below it`);
  const category = typeof body.category === "string" && /^[a-z0-9-]{1,40}$/.test(body.category) ? body.category : null;
  if (!category) return err(400, "bad_request", "category must be a short lowercase slug, e.g. possible-exfiltration");
  const evidence = Array.isArray(body.evidence) ? body.evidence.slice(0, 10).map((e) => untrustedText(typeof e === "string" ? e : JSON.stringify(e), 300)) : [];
  const text = untrustedText([untrustedText(body.explanation), ...evidence].filter(Boolean).join("\n"));
  if (!text) return err(400, "bad_request", "explanation is required");

  let levels;
  try {
    levels = await levelsFor(deps, subject);
  } catch (e) {
    return chainErr(e);
  }
  const leaf = levels[levels.length - 1];
  if (!leaf || leaf.status !== "registered" || !leaf.resource) return err(404, "not_registered", `${subject} is not registered`);
  if (!isAgentLevel(levels, deps.config.rootOwner)) return err(403, "not_an_agent", `${subject} is a human level`);
  const now = nowSec(deps);
  const key = keyOf(subject, leaf.resource);
  const d = deps.store.data;
  const report = { by: viewer.name, category, text, at: now, untrusted: true as const };
  const open = openIncidentOn(d, key);
  if (open) {
    deps.store.commit((data) => {
      data.incidents[open.id].agentReports.push(report);
      audit(data, deps.meter, { kind: "agent_report", by: viewer.name, subject, incidentId: open.id, detail: "agent report received (unverified)" });
    });
    return ok({ status: "attached", incident: { id: open.id, url: incidentUrl(deps.config, open.id) } });
  }
  if (d.suspensions[key]) {
    const id = d.suspensions[key].incidentId;
    return ok({ status: "paused", incident: { id, url: incidentUrl(deps.config, id) } });
  }
  const recent = (d.reports[viewer.name] ?? []).filter((t) => t > now - 3600);
  if (recent.length >= REPORTS_PER_HOUR) return err(429, "too_many_reports", `${viewer.name} may open ${REPORTS_PER_HOUR} incidents per hour`);
  const incident = deps.store.commit((data) => {
    data.reports[viewer.name] = [...recent, now];
    const base = ensureBaseline(data, key, leaf, now);
    return openIncident(data, deps.meter, {
      root: deps.config.rootName ?? "",
      key,
      level: leaf,
      baseline: base,
      proposed: null,
      flags: [],
      trigger: { source: "agent-report", requestedBy: viewer.name, at: now },
      chainHash: base.chainHash,
      report: { by: viewer.name, category, text },
      nowSec: now,
    });
  });
  return ok({ status: "paused", incident: { id: incident.id, url: incidentUrl(deps.config, incident.id) } }, 202);
}

// --- Incidents (read) ------------------------------------------------------------------------------------

const incidentSummary = (i: Incident, now: number) => ({
  id: i.id,
  subject: i.subject.name,
  state: i.state,
  trigger: i.trigger.source,
  flags: i.flags,
  openedAt: i.openedAt,
  reviewBy: i.reviewBy,
  overdue: i.state === "open" && now > i.reviewBy,
  revision: i.revision,
  ...(i.archivedAt ? { archivedAt: i.archivedAt } : {}),
});

/** GET /incidents: the public list (no evidence). Incidents an admin round reset archived only with `archived`. */
export function listIncidents(deps: ApprovalsDeps, opts: { archived?: boolean } = {}): Response {
  const now = nowSec(deps);
  const d = deps.store.data;
  const incidents = Object.values(d.incidents)
    .filter((i) => opts.archived || !i.archivedAt)
    .sort((a, b) => (a.state === "open" ? 0 : 1) - (b.state === "open" ? 0 : 1) || b.openedAt - a.openedAt)
    .slice(0, 200)
    .map((i) => incidentSummary(i, now));
  return ok({ incidents, paused: pausedList(deps.store), unavailable: deps.store.unavailable() });
}

/** GET /incidents/[id]: the full record; agent text is labeled unverified. */
export function getIncident(id: string, deps: ApprovalsDeps): Response {
  const i = deps.store.data.incidents[id];
  if (!i) return err(404, "unknown_incident", `no incident ${id}`);
  const now = nowSec(deps);
  const overlay = i.resolution?.overlayId ? (deps.store.data.overlays[i.resolution.overlayId] ?? null) : null;
  // Public, unauthenticated: the approver's World nullifier (their enrolled continuity id) never leaves the relay.
  const resolution = i.resolution && {
    ...i.resolution,
    world: i.resolution.world && { environment: i.resolution.world.environment, presence: i.resolution.world.presence, verifiedAt: i.resolution.world.verifiedAt },
  };
  return ok({
    ...i,
    resolution,
    agentReports: i.agentReports.map((r) => ({ ...r, label: `Written by ${r.by}: unverified. It may be mistaken or manipulated.` })),
    overdue: i.state === "open" && now > i.reviewBy,
    paused: !!deps.store.data.suspensions[i.key],
    overlay: overlay && { id: overlay.id, bundle: overlay.bundle, chain: overlay.chain, notAfter: overlay.notAfter, active: overlay.notAfter > now },
    url: incidentUrl(deps.config, i.id),
  });
}

/** Names paused right now (for /api/relay/status). */
export function pausedList(store: ApprovalsStore): { name: string; incidentId: string }[] {
  return Object.values(store.data.suspensions).map((s) => ({ name: s.name, incidentId: s.incidentId }));
}

// --- Challenge -------------------------------------------------------------------------------------------

type SubjectInfo = {
  name: string;
  node: Hex;
  resource: string;
  owner: Address | null;
  revision: number;
  subjectLine: string;
  proposalDigest?: Hex;
};

function subjectInfo(subject: Subject, deps: ApprovalsDeps): SubjectInfo | Response {
  if (subject.kind === "incident") {
    const i = deps.store.data.incidents[subject.id];
    if (!i) return err(404, "unknown_incident", `no incident ${subject.id}`);
    if (i.state !== "open") return err(409, "incident_not_open", `incident ${i.id} is ${i.state}`);
    return {
      name: i.subject.name,
      node: i.subject.node,
      resource: i.subject.resource,
      owner: i.subject.owner,
      revision: i.revision,
      subjectLine: `Incident ${i.id} revision ${i.revision}: ${i.subject.name}`,
    };
  }
  if (!hooks.proposal) return err(503, "chain_unavailable", "blockchain proposals aren't available on this relay");
  const p = hooks.proposal(subject.id);
  if (!p) return err(404, "unknown_proposal", `no proposal ${subject.id}`);
  if (p.state !== "awaiting-approval") return err(409, "proposal_not_awaiting", `proposal ${p.id} is ${p.state}`);
  if (p.expiresAt <= nowSec(deps)) return err(410, "proposal_expired", `proposal ${p.id} expired`);
  return {
    name: p.agent.name,
    node: p.agent.node,
    resource: p.agent.resource,
    owner: p.agent.owner,
    revision: 0,
    subjectLine: `Blockchain proposal ${p.id} by ${p.agent.name}: ${untrustedText(p.summary, 300)}`,
    proposalDigest: p.digest,
  };
}

const parseSubject = (raw: unknown): Subject | null => {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if ((s.kind !== "incident" && s.kind !== "proposal") || typeof s.id !== "string" || !/^[a-z]{3}_[A-Za-z0-9_-]{1,64}$/.test(s.id)) return null;
  return { kind: s.kind, id: s.id };
};

function bindingOf(c: Challenge, info: SubjectInfo, root: string): Binding {
  return {
    v: 1,
    root,
    subject: { ...c.subject!, revision: c.revision ?? 0 },
    target: { name: info.name, node: info.node, resource: info.resource, owner: info.owner },
    decision: c.decision!,
    ...(c.subject!.kind === "incident" ? { scope: c.scope ?? null, notAfter: c.notAfter ?? null } : { proposalDigest: c.proposalDigest }),
    policyVersion: POLICY_VERSION,
    approver: c.approver,
    challengeId: c.id,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
  };
}

const untilLine = (c: Challenge) =>
  c.notAfter ? `Until: ${iso(c.notAfter)}${c.scope ? ` (${Math.round(Math.max(0, c.notAfter - c.issuedAt) / 60)} min)` : ""}` : null;

/** Parses and checks an approve / approve-narrower scope against the incident. */
function scopeFor(decision: Decision, raw: unknown, incident: Incident, now: number, subjectExpiry: number | null): { scope: NarrowScope; notAfter: number } | Response {
  const cap = (t: number) => (subjectExpiry ? Math.min(t, subjectExpiry) : t);
  if (decision === "approve") {
    if (!incident.proposed) return err(422, "bad_scope", "this incident has no requested scope to approve; approve a narrower one");
    const notAfter = cap(incident.proposed.expiry ?? subjectExpiry ?? now + MAX_NARROW_SEC);
    return { scope: { bundle: incident.proposed.bundle, chain: incident.proposed.chain, durationSec: Math.max(1, notAfter - now) }, notAfter };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return err(422, "bad_scope", "approve-narrower needs a scope {bundle?, chain?, durationSec}");
  const s = raw as Record<string, unknown>;
  const unknownKey = Object.keys(s).find((k) => !["bundle", "chain", "durationSec"].includes(k));
  if (unknownKey) return err(422, "bad_scope", `unknown scope field ${unknownKey}`);
  const bundle = s.bundle === undefined ? incident.previous.bundle : s.bundle === null ? null : readBundle(s.bundle);
  if (s.bundle !== undefined && s.bundle !== null && !bundle) return err(422, "bad_scope", "scope.bundle is malformed");
  const chain = s.chain === undefined ? incident.previous.chain : s.chain === null ? null : readChainScope(s.chain);
  if (s.chain !== undefined && s.chain !== null && !chain) return err(422, "bad_scope", "scope.chain is not a valid relay.chain grant");
  const durationSec = typeof s.durationSec === "number" ? s.durationSec : NaN;
  const scope: NarrowScope = { bundle, chain, durationSec };
  const problem = narrowerProblem(scope, incident.previous, incident.proposed);
  if (problem) return err(422, "bad_scope", problem);
  return { scope, notAfter: cap(now + durationSec) };
}

function worldFor(deps: ApprovalsDeps): WorldConfig | null {
  return worldConfig(deps.env).config;
}

/**
 * POST /challenge {subject:{kind,id}, decision, approver, scope?} → the exact
 * message to sign (and the World request when World is required).
 */
export async function postChallenge(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const down = unavailable(deps) ?? issueProblem(request, deps);
  if (down) return down;
  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "send JSON");
  const subject = parseSubject(body.subject);
  if (!subject) return err(400, "bad_request", "subject must be {kind: incident|proposal, id}");
  const decision = body.decision as Decision;
  if (!DECISIONS[subject.kind].includes(decision)) return err(400, "bad_request", `decision must be one of ${DECISIONS[subject.kind].join(", ")}`);
  if (typeof body.approver !== "string" || !isAddress(body.approver, { strict: false })) return err(400, "bad_request", "approver must be an address");
  const approver = getAddress(body.approver);
  const info = subjectInfo(subject, deps);
  if (info instanceof Response) return info;

  const factors = requiredFactors(subject.kind, decision);
  const world = factors.world ? worldFor(deps) : null;
  if (factors.world && !world) return err(503, "world_not_configured", "this decision needs World ID verification, which isn't set up on this relay (no downgrade)");
  if (factors.world && !deps.store.data.approvers[approver.toLowerCase()]) {
    return err(403, "not_enrolled", `${approver} hasn't linked a World ID yet. Link it first (Your approver identity).`);
  }

  let levels;
  try {
    levels = await levelsFor(deps, info.name);
  } catch (e) {
    return chainErr(e);
  }
  const problem = eligibilityProblem(levels, approver, deps.config.rootOwner);
  if (problem) return err(403, "not_eligible", problem);
  const leaf = levels[levels.length - 1];
  if (leaf.resource !== info.resource) return err(409, subject.kind === "incident" ? "incident_changed" : "proposal_changed", `${info.name} was re-registered`);

  const now = nowSec(deps);
  let scope: NarrowScope | null = null;
  let notAfter: number | null = null;
  if (subject.kind === "incident" && (decision === "approve" || decision === "approve-narrower")) {
    const s = scopeFor(decision, body.scope, deps.store.data.incidents[subject.id], now, leaf.expiry);
    if (s instanceof Response) return s;
    scope = s.scope;
    notAfter = s.notAfter;
  }

  const id = newId("ch");
  const c: Challenge = {
    id,
    kind: "decision",
    approver,
    status: "issued",
    message: "",
    digest: "0x",
    issuedAt: now,
    expiresAt: now + CHALLENGE_TTL_SEC,
    subject,
    revision: info.revision,
    decision,
    scope,
    notAfter,
    ...(info.proposalDigest ? { proposalDigest: info.proposalDigest } : {}),
    world: null,
  };
  const binding = bindingOf(c, info, deps.config.rootName ?? "");
  c.digest = bindingDigest(binding);
  c.message = approvalMessage(binding, c.digest, { subjectLine: info.subjectLine, untilLine: untilLine(c) });
  let worldRequest: Record<string, unknown> | null = null;
  if (world) {
    const rp = await signRpContext(world, { nowSec: now });
    c.world = { signal: approveSignal(c.digest), rpNonce: rp.nonce };
    worldRequest = { app_id: world.appId, action: world.action, rp_context: rp, signal: c.world.signal, environment: world.environment, require_user_presence: true };
  }
  deps.store.commit((d) => {
    d.challenges[id] = c;
    audit(d, deps.meter, {
      kind: "approval_started",
      by: approver,
      subject: info.name,
      incidentId: subject.kind === "incident" ? subject.id : undefined,
      detail: `${decision} started by ${approver} (challenge ${id})`,
    });
  });
  return ok({ challengeId: id, digest: c.digest, message: c.message, expiresAt: c.expiresAt, factors, notAfter, world: worldRequest });
}

// --- Confirm ---------------------------------------------------------------------------------------------

/** Refuses agent and admin credentials: an approval's only authentication is the wallet signature. */
function credentialProblem(request: Request): Response | null {
  const auth = request.headers.get("authorization");
  const apiKey = request.headers.get("x-api-key");
  if (tokenFromHeaders(request.headers) || apiKey?.startsWith(`${TOKEN_PREFIX}.`) || auth) {
    return err(401, "agent_token_refused", "approvals are authenticated by the approver's wallet signature; agent and admin tokens are refused here");
  }
  return null;
}

/** Locks an issued challenge (synchronously) or explains why it can't be used. */
function lockChallenge(deps: ApprovalsDeps, id: unknown, kind: Challenge["kind"]): Challenge | Response {
  if (typeof id !== "string") return err(400, "bad_request", "challengeId is required");
  const c = deps.store.data.challenges[id];
  if (!c || c.kind !== kind) return err(404, "unknown_challenge", "no such challenge");
  if (c.status !== "issued") return err(409, "challenge_used", `this challenge is ${c.status}; start again`);
  if (nowSec(deps) > c.expiresAt) {
    deps.store.tryCommit((d) => void (d.challenges[c.id].status = "expired"));
    return err(410, "challenge_expired", "the challenge expired (5 minutes); start again");
  }
  deps.store.commit((d) => void (d.challenges[c.id].status = "verifying"));
  return deps.store.data.challenges[c.id];
}

function failChallenge(deps: ApprovalsDeps, c: Challenge, status: number, code: string, reason: string, subjectName: string | null): Response {
  deps.store.tryCommit((d) => {
    const cur = d.challenges[c.id];
    if (cur && cur.status === "verifying") {
      cur.status = "failed";
      cur.failure = code;
    }
    audit(d, deps.meter, {
      kind: "approval_failed",
      by: c.approver,
      subject: subjectName,
      incidentId: c.subject?.kind === "incident" ? c.subject.id : undefined,
      allowed: false,
      detail: `approval failed: ${code}${c.subject?.kind === "incident" ? "; still paused" : ""}`,
    });
  });
  return err(status, code, reason, { stillPaused: c.subject?.kind === "incident" });
}

const MAX_CHALLENGES = 5000;

/** Challenge creation is unauthenticated (the signature comes later), so it is rate limited and capped. */
function issueProblem(request: Request, deps: ApprovalsDeps): Response | null {
  if (!deps.confirmLimit.take(clientKey(request.headers), deps.now())) return err(429, "too_many_requests", "wait a minute and try again");
  if (Object.keys(deps.store.data.challenges).length >= MAX_CHALLENGES) return err(429, "too_many_challenges", "too many open challenges; try again later");
  return null;
}

const validSignature = (s: unknown): s is Hex => typeof s === "string" && isHex(s) && s.length >= 4 && s.length <= 20_000;

/**
 * POST /confirm {challengeId, signature, world?}. In order: challenge issued,
 * unexpired → locked; subject unchanged; binding rebuilt and equal; wallet
 * signature; eligibility re-read from chain; World (local checks, Portal,
 * same nullifier as enrolled); then one synchronous commit to disk.
 */
export async function postConfirm(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const cred = credentialProblem(request);
  if (cred) return cred;
  const client = clientKey(request.headers);
  if (!deps.confirmLimit.take(client, deps.now())) return err(429, "too_many_requests", "wait a minute and try again");
  const down = unavailable(deps);
  if (down) return down;
  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "send JSON");
  const locked = lockChallenge(deps, body.challengeId, "decision");
  if (locked instanceof Response) return locked;
  const c = locked;
  const subject = c.subject!;
  const incident = subject.kind === "incident" ? deps.store.data.incidents[subject.id] : null;
  const fail = (status: number, code: string, reason: string) => failChallenge(deps, c, status, code, reason, incident?.subject.name ?? null);
  try {
    // Subject unchanged.
    const info = subjectInfo(subject, deps);
    if (info instanceof Response) {
      const j = (await info.json()) as { error: string; reason: string };
      return fail(409, subject.kind === "incident" ? "incident_changed" : "proposal_changed", j.reason);
    }
    if (info.revision !== c.revision || (subject.kind === "proposal" && info.proposalDigest !== c.proposalDigest)) {
      return fail(409, subject.kind === "incident" ? "incident_changed" : "proposal_changed", "the subject changed after this challenge was issued; start again");
    }
    if (incident && !deps.store.data.suspensions[incident.key]) return fail(409, "incident_changed", "the subject is no longer paused");
    // Binding.
    const binding = bindingOf(c, info, deps.config.rootName ?? "");
    const digest = bindingDigest(binding);
    const message = approvalMessage(binding, digest, { subjectLine: info.subjectLine, untilLine: untilLine(c) });
    if (digest !== c.digest || message !== c.message) return fail(409, "incident_changed", "the approval no longer matches what was issued; start again");
    // Wallet.
    if (!validSignature(body.signature)) return fail(400, "bad_signature", "signature must be 0x hex");
    if (!(await deps.verifySignature({ address: c.approver, message: c.message, signature: body.signature }))) {
      return fail(422, "bad_signature", "the signature doesn't match the approver and message");
    }
    // Chain re-check.
    let levels;
    try {
      levels = await deps.reader.readLevels(deps.config.rootName ?? "", info.name);
    } catch (e) {
      if (isChainReadError(e)) return fail(502, "ens_unreachable", "ENS couldn't be read; start again");
      throw e;
    }
    const problem = eligibilityProblem(levels, c.approver, deps.config.rootOwner);
    if (problem) return fail(403, "not_eligible", problem);
    if (levels[levels.length - 1].resource !== info.resource) return fail(409, "incident_changed", `${info.name} was re-registered`);
    // World.
    let worldEvidence: WorldEvidence | null = null;
    if (c.world) {
      const cfg = worldFor(deps);
      if (!cfg) return fail(503, "world_not_configured", "World ID isn't configured on this relay");
      const linked = deps.store.data.approvers[c.approver.toLowerCase()];
      if (!linked) return fail(403, "not_enrolled", `${c.approver} has no linked World ID`);
      const v = await verifyWorldProof(cfg, body.world, { signal: c.world.signal, nonce: c.world.rpNonce, action: cfg.action }, deps.fetch);
      if (!v.ok) return fail(v.status, v.code, v.detail);
      if (v.nullifier !== linked.nullifier) return fail(422, "wrong_person", "this World ID isn't the one linked to this approver");
      worldEvidence = { nullifier: v.nullifier, environment: v.environment, presence: v.presence === true ? "client-reported" : "not-requested", verifiedAt: nowSec(deps) };
    }
    // Commit.
    const now = nowSec(deps);
    // The chain layer binds an approval to the PROPOSAL digest the wallet message named (checked
    // above against the live proposal); the challenge's binding digest and id stay in the audit trail.
    const approval = { approver: c.approver, digest: (subject.kind === "proposal" ? c.proposalDigest : c.digest) as Hex, at: now, challengeId: c.id };
    const result = deps.store.commit((d) => {
      const cur = d.challenges[c.id];
      if (cur.status !== "verifying") throw new ConflictError();
      if (subject.kind === "incident") {
        const inc = d.incidents[subject.id];
        if (inc.state !== "open" || inc.revision !== c.revision) throw new ConflictError();
        cur.status = "consumed";
        const overlay = applyIncidentDecision(d, deps.meter, inc, cur, worldEvidence, now);
        return { overlay };
      }
      cur.status = "consumed";
      // The chain layer marks the proposal; if it can't, nothing here is saved.
      const hook = c.decision === "approve" ? hooks.proposalApproved : hooks.proposalRejected;
      if (!hook) throw new Error("the blockchain layer isn't loaded");
      hook(subject.id, approval);
      audit(d, deps.meter, { kind: `proposal_${c.decision}`, by: c.approver, subject: info.name, detail: `proposal ${subject.id} ${c.decision === "approve" ? "approved; the agent submits next" : "rejected"} (${c.digest.slice(0, 10)})` });
      return { overlay: null };
    });
    return ok({
      ok: true,
      subject,
      decision: c.decision,
      digest: c.digest,
      world: worldEvidence,
      overlay: result.overlay && { id: result.overlay.id, notAfter: result.overlay.notAfter, bundle: result.overlay.bundle, chain: result.overlay.chain },
      paused: incident ? !!deps.store.data.suspensions[incident.key] : false,
    });
  } catch (e) {
    if (e instanceof ConflictError) return fail(409, "incident_changed", "the subject changed while this approval was being verified");
    const why = e instanceof Error ? e.message : String(e);
    return fail(503, "approvals_unavailable", why.slice(0, 200));
  }
}

class ConflictError extends Error {}

/** POST /cancel {challengeId}: the approver closed the flow; the subject stays as it is. */
export async function postCancel(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const down = unavailable(deps);
  if (down) return down;
  const body = await readJson(request);
  const id = body?.challengeId;
  if (typeof id !== "string") return err(400, "bad_request", "challengeId is required");
  const c = deps.store.data.challenges[id];
  if (!c) return err(404, "unknown_challenge", "no such challenge");
  if (c.status !== "issued") return ok({ status: c.status });
  deps.store.commit((d) => {
    d.challenges[id].status = "cancelled";
    audit(d, deps.meter, {
      kind: "approval_cancelled",
      by: c.approver,
      subject: c.subject?.kind === "incident" ? (d.incidents[c.subject.id]?.subject.name ?? null) : null,
      incidentId: c.subject?.kind === "incident" ? c.subject.id : undefined,
      allowed: false,
      detail: "approval cancelled; still paused",
    });
  });
  return ok({ status: "cancelled" });
}

// --- Enrollment ------------------------------------------------------------------------------------------

async function approverProblem(deps: ApprovalsDeps, approver: Address, name: string | null): Promise<string | null> {
  const root = deps.config.rootName ?? "";
  if (deps.config.rootOwner && isAddressEqual(deps.config.rootOwner, approver)) return null;
  if (name) {
    if (!(name === root || name.endsWith(`.${root}`))) return `${name} is not under ${root}`;
    const levels = await deps.reader.readLevels(root, name);
    const leaf = levels[levels.length - 1];
    if (levels.some((l) => l.status !== "registered")) return `${name} is not registered`;
    if (!leaf.owner || !isAddressEqual(leaf.owner, approver)) return `${approver} doesn't own ${name}`;
    const member = memberLevelIndex(levels, deps.config.rootOwner);
    if (member !== -1 && levels.length - 1 > member) return `${name} is an agent level; agents never approve`;
    return null;
  }
  const tree = deps.reader as Partial<TreeReader>;
  if (typeof tree.listChildren !== "function") return "name the level you own (name)";
  const scan = await cachedTree(tree as TreeReader, root);
  if (ownedIn(scan, approver).some((n) => n.member)) return null;
  return `${approver} doesn't own a human level under ${root}`;
}

/** POST /enroll/challenge {approver, name?}: message to sign + World request to link a World ID. */
export async function postEnrollChallenge(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const down = unavailable(deps) ?? issueProblem(request, deps);
  if (down) return down;
  const world = worldFor(deps);
  if (!world) return err(503, "world_not_configured", "World ID isn't configured on this relay");
  const body = await readJson(request);
  if (!body || typeof body.approver !== "string" || !isAddress(body.approver, { strict: false })) return err(400, "bad_request", "approver must be an address");
  const approver = getAddress(body.approver);
  const name = body.name === undefined ? null : normName(deps, body.name);
  if (body.name !== undefined && !name) return err(400, "bad_request", "name must be an ENS name");
  if (deps.store.data.approvers[approver.toLowerCase()]) return err(409, "already_linked", "already linked; replacing it needs the company owner (unlink first)");
  let problem: string | null;
  try {
    problem = await approverProblem(deps, approver, name);
  } catch (e) {
    return chainErr(e);
  }
  if (problem) return err(403, "not_eligible", problem);
  const now = nowSec(deps);
  const id = newId("ch");
  const expiresAt = now + CHALLENGE_TTL_SEC;
  const message = enrollMessage(approver, deps.config.rootName ?? "", id, expiresAt);
  const rp = await signRpContext(world, { nowSec: now });
  const signal = enrollSignal(approver, id);
  deps.store.commit((d) => {
    d.challenges[id] = { id, kind: "enroll", approver, status: "issued", message, digest: keccak256(stringToBytes(message)), issuedAt: now, expiresAt, world: { signal, rpNonce: rp.nonce } };
  });
  return ok({
    challengeId: id,
    message,
    expiresAt,
    world: { app_id: world.appId, action: world.action, rp_context: rp, signal, environment: world.environment, require_user_presence: true },
  });
}

/** POST /enroll/confirm {challengeId, signature, world}: links the verified nullifier to the wallet (once). */
export async function postEnrollConfirm(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const cred = credentialProblem(request);
  if (cred) return cred;
  if (!deps.confirmLimit.take(clientKey(request.headers), deps.now())) return err(429, "too_many_requests", "wait a minute and try again");
  const down = unavailable(deps);
  if (down) return down;
  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "send JSON");
  const locked = lockChallenge(deps, body.challengeId, "enroll");
  if (locked instanceof Response) return locked;
  const c = locked;
  const fail = (status: number, code: string, reason: string) => failChallenge(deps, c, status, code, reason, null);
  try {
    const cfg = worldFor(deps);
    if (!cfg || !c.world) return fail(503, "world_not_configured", "World ID isn't configured on this relay");
    if (!validSignature(body.signature)) return fail(400, "bad_signature", "signature must be 0x hex");
    if (!(await deps.verifySignature({ address: c.approver, message: c.message, signature: body.signature }))) return fail(422, "bad_signature", "the signature doesn't match the approver and message");
    const v = await verifyWorldProof(cfg, body.world, { signal: c.world.signal, nonce: c.world.rpNonce, action: cfg.action }, deps.fetch);
    if (!v.ok) return fail(v.status, v.code, v.detail);
    const now = nowSec(deps);
    const addr = c.approver.toLowerCase();
    const d = deps.store.data;
    const other = d.nullifierIndex[v.nullifier];
    if (other && other.toLowerCase() !== addr) return fail(409, "nullifier_linked", "this World ID is already linked to another approver");
    if (d.approvers[addr]) return fail(409, "already_linked", "already linked; replacing it needs the company owner");
    deps.store.commit((data) => {
      const cur = data.challenges[c.id];
      if (cur.status !== "verifying" || data.approvers[addr] || (data.nullifierIndex[v.nullifier] && data.nullifierIndex[v.nullifier].toLowerCase() !== addr)) throw new ConflictError();
      cur.status = "consumed";
      data.approvers[addr] = { nullifier: v.nullifier, linkedAt: now, linkSig: body.signature as Hex, challengeId: c.id };
      data.nullifierIndex[v.nullifier] = c.approver;
      audit(data, deps.meter, { kind: "approver_linked", by: c.approver, subject: null, detail: `approver ${c.approver} linked a World ID (${v.environment})` });
    });
    return ok({ linked: true, address: c.approver, linkedAt: now, environment: v.environment });
  } catch (e) {
    if (e instanceof ConflictError) return fail(409, "already_linked", "linked concurrently; start again");
    return fail(503, "approvals_unavailable", (e instanceof Error ? e.message : String(e)).slice(0, 200));
  }
}

/**
 * POST /enroll/unlink {address} → a message for the company owner
 * (RELAY_ROOT_OWNER) to sign; then {challengeId, signature} unlinks it and
 * voids that approver's pending challenges.
 */
export async function postUnlink(request: Request, deps: ApprovalsDeps): Promise<Response> {
  const down = unavailable(deps);
  if (down) return down;
  const owner = deps.config.rootOwner;
  if (!owner) return err(503, "no_root_owner", "set RELAY_ROOT_OWNER: only the company owner can unlink an approver");
  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "send JSON");
  if (body.challengeId === undefined) {
    const limited = issueProblem(request, deps);
    if (limited) return limited;
    if (typeof body.address !== "string" || !isAddress(body.address, { strict: false })) return err(400, "bad_request", "address must be an address");
    const target = getAddress(body.address);
    if (!deps.store.data.approvers[target.toLowerCase()]) return err(404, "not_linked", `${target} has no linked World ID`);
    const now = nowSec(deps);
    const id = newId("ch");
    const message = unlinkMessage(target, id);
    deps.store.commit((d) => {
      d.challenges[id] = { id, kind: "unlink", approver: owner, status: "issued", message, digest: keccak256(stringToBytes(message)), issuedAt: now, expiresAt: now + CHALLENGE_TTL_SEC, target };
    });
    return ok({ challengeId: id, message, signer: owner, expiresAt: now + CHALLENGE_TTL_SEC });
  }
  const cred = credentialProblem(request);
  if (cred) return cred;
  const locked = lockChallenge(deps, body.challengeId, "unlink");
  if (locked instanceof Response) return locked;
  const c = locked;
  if (!validSignature(body.signature) || !(await deps.verifySignature({ address: owner, message: c.message, signature: body.signature }))) {
    return failChallenge(deps, c, 422, "bad_signature", "the company owner must sign the unlink message", null);
  }
  const target = c.target!.toLowerCase();
  deps.store.commit((d) => {
    d.challenges[c.id].status = "consumed";
    const linked = d.approvers[target];
    if (linked) delete d.nullifierIndex[linked.nullifier];
    delete d.approvers[target];
    for (const other of Object.values(d.challenges)) {
      if (other.status === "issued" && other.approver.toLowerCase() === target) {
        other.status = "failed";
        other.failure = "approver_unlinked";
      }
    }
    audit(d, deps.meter, { kind: "approver_unlinked", by: owner, subject: null, detail: `approver ${c.target} unlinked by the company owner` });
  });
  return ok({ unlinked: true, address: c.target });
}

/** GET /approvers/[address] → {linked, linkedAt}. */
export function getApprover(address: string, deps: ApprovalsDeps): Response {
  if (!isAddress(address, { strict: false })) return err(400, "bad_request", "not an address");
  const a = deps.store.data.approvers[address.toLowerCase()];
  return ok({ address: getAddress(address), linked: !!a, linkedAt: a?.linkedAt ?? null });
}

// --- Preflight -------------------------------------------------------------------------------------------

const g = globalThis as unknown as { __relayWorldPreflight?: { at: number; value: Awaited<ReturnType<typeof runPreflight>> } };

/** GET /world/preflight: config problems + the fake-proof probe (cached one minute). */
export async function getPreflight(deps: ApprovalsDeps): Promise<Response> {
  const hit = g.__relayWorldPreflight;
  if (hit && deps.now() - hit.at < 60_000) return ok(hit.value);
  const value = await runPreflight(deps.env, deps.fetch);
  g.__relayWorldPreflight = { at: deps.now(), value };
  return ok(value);
}

