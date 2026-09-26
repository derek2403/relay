// Typed client for the relay's approvals routes (spec §7). The wallet signature over the
// server's message is the only auth on confirm; World results are forwarded unchanged.

import type { Address, Hex } from "viem";

import type { Bundle } from "@/lib/relay/bundle";
import { getJson } from "@/lib/relay/browser";

export type Subject = { kind: "incident" | "proposal"; id: string };
export type Decision = "approve" | "approve-narrower" | "reject" | "revoke";

/** What IDKit needs, as the server signed it (spec §7.3/§7.5). */
export type WorldRequest = {
  app_id: `app_${string}`;
  action: string;
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
  signal: string;
  environment: "production" | "staging" | "sandbox";
  /** Optional: the server may say whether to ask World App for a presence check. */
  require_user_presence?: boolean;
};

export type Challenge = {
  id: string;
  digest: Hex;
  /** The exact text the wallet signs. */
  message: string;
  approver: Address;
  subject?: Subject;
  revision?: number | string;
  decision?: Decision;
  scope?: unknown;
  status?: "issued" | "verifying" | "consumed" | "failed" | "cancelled" | "expired";
  expiresAt: number;
  world?: WorldRequest | null;
};

export type IncidentState = "open" | "approving" | "resolved:approved" | "resolved:approved-narrower" | "resolved:rejected" | "resolved:revoked" | "expired" | string;

/** A permissions snapshot in an incident: the bundle, the chain grant (object or record text) and the ENS expiry. */
export type Snapshot = { bundle?: Bundle | null; chain?: unknown; expiry?: number | null; expiresAt?: number | null; owner?: Address | null };

/** A rule match: `{id, detail, severity}` from the relay (older shapes tolerated). */
export type Flag = { id?: string; rule?: string; severity?: string; detail?: string; message?: string; why?: string } | string;

/** Agent-written text: untrusted, shown as such. */
export type AgentReport = { by?: string; reporter?: string; category?: string; text?: string; explanation?: string; at?: number; label?: string };

export type Trigger = string | { source: string; requestedBy?: string | null; at?: number };

export type IncidentSummary = {
  id: string;
  subject: string | { name: string; node?: Hex; resource?: string; owner?: Address };
  state: IncidentState;
  flags?: Flag[];
  openedAt?: number;
  reviewBy?: number;
  trigger?: Trigger;
  overdue?: boolean;
};

export type Incident = IncidentSummary & {
  previous?: Snapshot | null;
  proposed?: Snapshot | null;
  evidence?: unknown;
  affected?: (string | { name: string; relation?: string })[];
  agentReports?: AgentReport[];
  suggested?: (string | { decision?: Decision; label?: string; text?: string; scope?: { chain?: unknown; bundle?: Bundle | null; durationSec?: number } })[];
  policyVersion?: string | number;
  reason?: string;
  resolution?: {
    decision?: Decision;
    approver?: Address;
    at?: number;
    overlayId?: string;
    /** World evidence as the public incident shows it (never the nullifier). */
    world?: { environment?: string; presence?: "client-reported" | "not-requested"; verifiedAt?: number } | null;
  } | null;
  revision?: number | string;
  /** The approved scope the relay resumed, if any. */
  overlay?: { id: string; notAfter: number; active: boolean; chain?: string | null } | null;
  paused?: boolean;
};

export type ConfirmResponse = { ok?: boolean; status?: string; incident?: Incident; proposal?: unknown; linkedAt?: number; [key: string]: unknown };

const BASE = "/api/relay/approvals";
const q = encodeURIComponent;

const post = <T>(path: string, body: unknown) =>
  getJson<T>(`${BASE}${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const listOf = <T>(body: unknown, key: string): T[] => {
  if (Array.isArray(body)) return body as T[];
  const inner = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : null;
  return Array.isArray(inner) ? (inner as T[]) : [];
};
const itemOf = <T>(body: unknown, key: string): T => {
  const inner = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : null;
  return (inner && typeof inner === "object" ? inner : body) as T;
};

/** `{challenge: {...}}` or the challenge itself; `challengeId` accepted for `id`. */
function challengeOf(body: unknown): Challenge {
  const c = itemOf<Challenge & { challengeId?: string }>(body, "challenge");
  return { ...c, id: c.id ?? c.challengeId ?? "" };
}

export const approvalsApi = {
  incidents: async () => listOf<IncidentSummary>(await getJson<unknown>(`${BASE}/incidents`), "incidents"),
  incident: async (id: string) => itemOf<Incident>(await getJson<unknown>(`${BASE}/incidents/${q(id)}`), "incident"),
  challenge: async (body: { subject: Subject; decision: Decision; approver: Address; scope?: unknown }) => challengeOf(await post<unknown>("/challenge", body)),
  confirm: (body: { challengeId: string; signature: Hex; world?: unknown }) => post<ConfirmResponse>("/confirm", body),
  cancel: (challengeId: string) => post<unknown>("/cancel", { challengeId }),
  enrollChallenge: async (approver: Address) => challengeOf(await post<unknown>("/enroll/challenge", { approver })),
  enrollConfirm: (body: { challengeId: string; signature: Hex; world: unknown }) => post<ConfirmResponse>("/enroll/confirm", body),
  approver: (address: Address) => getJson<{ linked: boolean; linkedAt?: number | null }>(`${BASE}/approvers/${q(address)}`),
};
