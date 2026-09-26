// Blockchain proposals: a prepared (unsigned) transaction waiting for approval,
// signing, submission and confirmation, with an explicit state machine.
//
// Idempotency: a client requestId is unique per agent name (a repeat returns
// the existing proposal, no second prepare), and a submit for a proposal that
// is already submitting/submitted/included/confirmed/uncertain returns it
// unchanged: the relay never re-signs or re-broadcasts. `uncertain` means the
// broadcast's outcome is unknown; only the tracker resolves it, by looking up
// the hash computed locally before broadcast.

import { randomBytes } from "node:crypto";

import { type Address, type Hex, keccak256, stringToHex } from "viem";

export type ProposalState =
  | "prepared"
  | "awaiting-approval"
  | "approved"
  | "submitting"
  | "submitted"
  | "included"
  | "confirmed"
  | "failed"
  | "uncertain"
  | "rejected"
  | "expired"
  | "blocked";

export type ProposalTx = {
  from: Address;
  to: Address | null;
  data: Hex;
  value: "0";
  gas: string;
  nonce?: number;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  type: number;
};

export type ProposalApproval = {
  required: boolean;
  rule: string;
  approver?: Address;
  at?: number;
  challengeId?: string;
  /** The proposal digest the approver signed; must equal the proposal's digest at submit. */
  digest?: Hex;
};

export type Proposal = {
  id: `prp_${string}`;
  /** Client idempotency key, unique per agent name. */
  requestId: string;
  agent: { name: string; node: Hex; resource: string; owner: Address };
  op: "call" | "deploy";
  network: "sepolia";
  target: { kind: "vault" | "token" | "escrow" | "deploy"; address: Address | null; label: string };
  method: string;
  args: unknown[];
  display: { summary: string; amount?: string; recipient?: Address };
  state: ProposalState;
  /** The unsigned tx MultiBaas prepared; null for a proposal blocked before preparation. */
  tx: ProposalTx | null;
  gasEstimate: string;
  grantId: Hex;
  digest: Hex;
  approval: ProposalApproval;
  /** Set on `blocked`: which rule refused it. */
  block?: { rule: string; reason: string };
  reservationId?: string;
  /** Token amount (base units) for payments. */
  amountBase?: string;
  submit?: { hash: Hex; at: number };
  receipt?: { blockNumber: number; blockHash: Hex; status: "success" | "reverted"; confirmations: number; contractAddress?: Address };
  /** Last failure detail (failed / uncertain). */
  error?: string;
  events: { at: number; state: ProposalState; detail: string }[];
  createdAt: number;
  expiresAt: number;
  /** Set by the admin round reset (unix s): kept for the audit trail, left out of lists unless asked for. */
  archivedAt?: number;
};

/** Proposals not yet submitted expire after this long. */
export const PROPOSAL_TTL_SEC = 30 * 60;

/** Legal moves. Terminal states have none. */
export const TRANSITIONS: Record<ProposalState, readonly ProposalState[]> = {
  prepared: ["awaiting-approval", "approved", "blocked", "rejected", "expired", "failed"],
  "awaiting-approval": ["approved", "rejected", "expired", "blocked", "failed"],
  approved: ["submitting", "expired", "blocked", "failed", "rejected"],
  submitting: ["submitted", "uncertain", "failed"],
  submitted: ["included", "failed"],
  uncertain: ["submitted", "included", "failed"],
  included: ["confirmed", "failed", "submitted"],
  confirmed: [],
  failed: [],
  rejected: [],
  expired: [],
  blocked: [],
};

export const TERMINAL: readonly ProposalState[] = ["confirmed", "failed", "rejected", "expired", "blocked"];
/** States after signing: a submit request returns the proposal unchanged. */
export const IN_FLIGHT: readonly ProposalState[] = ["submitting", "submitted", "included", "confirmed", "uncertain"];
/**
 * States the tracker polls. `submitting` is included: the hash is stored before
 * the broadcast, so a crash (or a failed write after it) leaves a `submitting`
 * proposal whose outcome only a lookup by hash can settle. It is never re-sent.
 */
export const PENDING: readonly ProposalState[] = ["submitting", "submitted", "included", "uncertain"];

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ProposalState,
    readonly to: ProposalState,
  ) {
    super(`proposal can't go from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Returns the proposal moved to `to` (a new object), or throws IllegalTransitionError. */
export function transition(p: Proposal, to: ProposalState, detail: string, at: number = nowSec(), patch: Partial<Proposal> = {}): Proposal {
  if (!TRANSITIONS[p.state].includes(to)) throw new IllegalTransitionError(p.state, to);
  return { ...p, ...patch, state: to, events: [...p.events, { at, state: to, detail }] };
}

export const newProposalId = (): Proposal["id"] => `prp_${randomBytes(12).toString("hex")}`;

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A client request id: 1–128 of [A-Za-z0-9_.:-]. */
export const validRequestId = (id: unknown): id is string => typeof id === "string" && REQUEST_ID.test(id);

/**
 * Canonical JSON: object keys sorted recursively, no whitespace, bigints as
 * decimal strings, 0x-hex strings lowercased. Throws on non-finite or unsafe
 * numbers, functions and undefined inside arrays.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new Error("canonicalJson: only safe integers");
      return v;
    }
    if (typeof v === "string") return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
    if (Array.isArray(v)) return v.map((x) => {
      if (x === undefined) throw new Error("canonicalJson: undefined in array");
      return walk(x);
    });
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = walk(x);
      }
      return out;
    }
    throw new Error(`canonicalJson: unsupported ${typeof v}`);
  };
  return JSON.stringify(walk(value));
}

/** keccak256 of the canonical JSON of the proposal's binding fields (what an approver signs over). */
export function proposalDigest(p: Pick<Proposal, "id" | "agent" | "network" | "target" | "method" | "args" | "tx" | "grantId">): Hex {
  const tx = p.tx ? { to: p.tx.to, data: p.tx.data, value: p.tx.value, gas: p.tx.gas } : null;
  return keccak256(
    stringToHex(canonicalJson({ v: 1, kind: "chain-proposal", id: p.id, agent: p.agent, network: p.network, target: p.target, method: p.method, args: p.args, tx, grantId: p.grantId })),
  );
}

export type NewProposal = Omit<Proposal, "id" | "state" | "digest" | "events" | "createdAt" | "expiresAt"> & { id?: Proposal["id"] };

/**
 * A new proposal in its first state: `blocked` when `block` is set, else
 * `awaiting-approval` or `approved` by `approval.required`.
 */
export function createProposal(input: NewProposal, at: number = nowSec()): Proposal {
  const id = input.id ?? newProposalId();
  const state: ProposalState = input.block ? "blocked" : input.approval.required ? "awaiting-approval" : "approved";
  const detail = input.block ? `blocked by ${input.block.rule}: ${input.block.reason}` : input.approval.required ? `prepared; approval required (${input.approval.rule})` : `prepared; no approval needed (${input.approval.rule})`;
  const base = { ...input, id };
  const digest = proposalDigest(base);
  return {
    ...base,
    state,
    digest,
    events: [
      ...(input.block ? [] : [{ at, state: "prepared" as const, detail: input.display.summary }]),
      { at, state, detail },
    ],
    createdAt: at,
    expiresAt: at + PROPOSAL_TTL_SEC,
  };
}

/** The existing proposal for this agent's requestId (idempotent create), or null. */
export function findByRequest(proposals: Iterable<Proposal>, agentName: string, requestId: string): Proposal | null {
  for (const p of proposals) if (p.agent.name === agentName && p.requestId === requestId) return p;
  return null;
}

/** Whether a not-yet-submitted proposal is past its expiry. */
export const isDue = (p: Proposal, at: number = nowSec()) => (p.state === "prepared" || p.state === "awaiting-approval" || p.state === "approved") && at >= p.expiresAt;

/** The proposal moved to `expired` if it is due, else unchanged. */
export const expireIfDue = (p: Proposal, at: number = nowSec()): Proposal => (isDue(p, at) ? transition(p, "expired", "not submitted within 30 minutes", at) : p);

/** Records an approval bound to `digest` and moves the proposal to `approved`. Throws when the digest doesn't match. */
export function approve(p: Proposal, a: { approver: Address; digest: Hex; at: number; challengeId?: string }): Proposal {
  if (a.digest.toLowerCase() !== p.digest.toLowerCase()) throw new Error("approval is for a different proposal digest");
  if (isDue(p, a.at)) throw new Error("proposal expired");
  return transition(p, "approved", `approved by ${a.approver}`, a.at, {
    approval: { ...p.approval, approver: a.approver, at: a.at, challengeId: a.challengeId, digest: a.digest },
  });
}

export type SubmitGate =
  /** Already signed/broadcast (or in progress): return it unchanged, never re-sign. */
  | { action: "return"; proposal: Proposal }
  /** May be signed and submitted now. */
  | { action: "proceed"; proposal: Proposal }
  | { action: "refuse"; status: 409 | 410 | 403; error: string; reason: string };

/** What a submit request may do with this proposal right now. */
export function submitGate(p: Proposal, at: number = nowSec()): SubmitGate {
  if (IN_FLIGHT.includes(p.state)) return { action: "return", proposal: p };
  if (isDue(p, at) || p.state === "expired") return { action: "refuse", status: 410, error: "expired", reason: "the proposal expired; prepare it again" };
  if (p.state === "awaiting-approval") return { action: "refuse", status: 403, error: "approval_required", reason: "an authorized human must approve this proposal first" };
  if (p.state !== "approved") return { action: "refuse", status: 409, error: "not_submittable", reason: `the proposal is ${p.state}` };
  if (p.approval.required && !(p.approval.approver && p.approval.digest && p.approval.digest.toLowerCase() === p.digest.toLowerCase()))
    return { action: "refuse", status: 403, error: "approval_required", reason: "the approval isn't bound to this proposal's contents" };
  return { action: "proceed", proposal: p };
}

/** A proposal's short human summary line for logs. */
export const describeProposal = (p: Proposal) => `${p.id} ${p.state}: ${p.display.summary}`;
