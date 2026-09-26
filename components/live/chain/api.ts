// Typed client for the relay's chain routes (spec §6). Shapes follow the build spec; the routes
// are the authority, so every read is tolerant (a missing field shows as "—", never crashes).
// Agent calls carry a short-lived kr1 token made from a key in this browser.

import type { Address, Hex } from "viem";

import { getJson } from "@/lib/relay/browser";

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

export type Proposal = {
  id: string;
  requestId: string;
  agent: { name: string; node: Hex; resource: string; owner: Address };
  op: "call" | "deploy";
  network: "sepolia";
  target: { kind: "vault" | "token" | "escrow" | "deploy"; address: Address | null; label: string };
  method: string;
  args: unknown[];
  display: { summary: string; amount?: string; recipient?: Address };
  /** The unsigned tx MultiBaas prepared; null for a proposal blocked before preparation. */
  tx: { from: Address; to: Address | null; data: Hex; value: "0"; gas: string; nonce?: number; maxFeePerGas?: string; maxPriorityFeePerGas?: string; type: number } | null;
  gasEstimate: string;
  grantId: Hex;
  digest: Hex;
  approval: { required: boolean; rule: string; approver?: Address; at?: number; challengeId?: string };
  reservationId?: string;
  amountBase?: string;
  submit?: { hash: Hex; at: number };
  receipt?: { blockNumber: number; blockHash: Hex; status: "success" | "reverted"; confirmations: number; contractAddress?: Address };
  events: { at: number; state: ProposalState; detail: string }[];
  createdAt: number;
  expiresAt: number;
  /** Current state (the last event's state when the route leaves it out). */
  state?: ProposalState;
  /** Set on `blocked`: which rule refused it. */
  block?: { rule: string; reason: string };
  /** Last failure detail (failed / uncertain). */
  error?: string;
  /** Older shape of `block`. */
  rule?: string;
  reason?: string;
  /** Set when an admin round reset archived it (the list leaves those out unless asked). */
  archivedAt?: number;
  /** Optional: allowance per level after the reservation/confirmation (base units). */
  allowance?: { name: string; limit: string | null; spent: string; reserved: string; period?: string }[];
};

export type ChainStatus = {
  configured: boolean;
  network?: string;
  chainId?: number;
  block?: number | null;
  signer?: Address | null;
  /** Wei (decimal string) or ETH ("0.03"). */
  signerBalance?: string | null;
  vault?: { address: Address; balance?: string | null } | null;
  token?: { address: Address; symbol?: string; name?: string; decimals?: number } | Address | null;
  templates?: unknown;
  /** Workspace recipient names → addresses, when the route shares them. */
  recipients?: Record<string, Address>;
  problems?: string[];
};

export type PlanStep = {
  tool: "read" | "events" | "tx" | "prepare" | "deploy" | "submit" | "report";
  contract?: string;
  method?: string;
  args?: string[];
  recipient?: string;
  amount?: string;
  proposalId?: string;
  why: string;
};

export type StepResult = {
  step?: number;
  tool?: string;
  ok?: boolean;
  output?: unknown;
  /** A read's integer output as STD ("10 STD"). */
  display?: string;
  rule?: string;
  reason?: string;
  error?: string;
  proposalId?: string;
  proposal?: Proposal;
  events?: unknown[];
};

export type Finding = {
  rule: string;
  severity?: string;
  txHash: Hex;
  block?: number;
  from?: Address;
  to?: Address;
  amount?: string;
  explorerUrl?: string;
  why: string;
};

export type TaskResponse = {
  runId: string;
  plan: { steps: PlanStep[]; expected?: string } | null;
  results: StepResult[];
  proposals: Proposal[];
  findings?: Finding[];
  report: string | null;
  reportReason?: string | null;
  reason?: string | null;
};

const BASE = "/api/relay/chain";
const q = encodeURIComponent;

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

/** `[...]` or `{ proposals: [...] }`. */
const listOf = <T>(body: unknown, key: string): T[] => {
  if (Array.isArray(body)) return body as T[];
  const inner = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : null;
  return Array.isArray(inner) ? (inner as T[]) : [];
};
const itemOf = <T>(body: unknown, key: string): T => {
  const inner = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : null;
  return (inner && typeof inner === "object" ? inner : body) as T;
};

/** GET path for one proposal; `?allowance=1` asks the relay for the per-level allowance rows. */
export const proposalPath = (id: string, opts: { allowance?: boolean } = {}) => `${BASE}/proposals/${q(id)}${opts.allowance ? "?allowance=1" : ""}`;

export const chainApi = {
  status: () => getJson<ChainStatus>(`${BASE}/status`),
  /** Public portal listing (every proposal: names, targets, amounts, states). */
  proposals: async () => listOf<Proposal>(await getJson<unknown>(`${BASE}/proposals?all=1`), "proposals"),
  /** One proposal; with `allowance`, also the allowance used at every level (one ENS read on the relay). */
  proposal: async (id: string, opts: { allowance?: boolean } = {}) => itemOf<Proposal>(await getJson<unknown>(proposalPath(id, opts)), "proposal"),
  /** As an agent (kr1 token): this agent's proposals, or its whole subtree's. */
  mine: async (token: string, scope: "mine" | "subtree" = "mine") =>
    listOf<Proposal>(await getJson<unknown>(`${BASE}/proposals?scope=${scope}`, { headers: bearer(token) }), "proposals"),
  submit: async (token: string, id: string) =>
    itemOf<Proposal>(await getJson<unknown>(`${BASE}/proposals/${q(id)}/submit`, { method: "POST", headers: bearer(token), body: "{}" }), "proposal"),
  task: (token: string, task: string, as?: string) =>
    getJson<TaskResponse>(`${BASE}/task`, { method: "POST", headers: bearer(token), body: JSON.stringify(as ? { task, as } : { task }) }),
};
