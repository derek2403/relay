// Hooks the blockchain layer (lib/chain, WP-D) sets at module load so the
// shared challenge → confirm flow can approve or reject its proposals without
// the approvals module importing the chain code.

import type { Address, Hex } from "viem";

/** What approvals needs to know about a chain proposal. */
export type ProposalView = {
  id: string;
  /** Only "awaiting-approval" can be decided. */
  state: string;
  /** keccak256 of the proposal's canonical JSON (what the approver binds to). */
  digest: Hex;
  agent: { name: string; node: Hex; resource: string; owner: Address };
  /** Human text for the wallet message, e.g. "pay 3 STD to supplier 0x…". */
  summary: string;
  expiresAt: number;
};

export type ProposalApproval = { approver: Address; digest: Hex; at: number; challengeId: string };

export type ApprovalHooks = {
  /** Looks up a proposal; null when unknown. */
  proposal: null | ((id: string) => ProposalView | null);
  /** Called once an approval is verified, before it is stored; must mark the proposal approved (throwing fails the confirm). */
  proposalApproved: null | ((id: string, approval: ProposalApproval) => void);
  /** Called once a rejection is verified, before it is stored. */
  proposalRejected: null | ((id: string, approval: ProposalApproval) => void);
};

// On globalThis: Next may load this module once per bundle, and every copy must see the hooks WP-D set.
const g = globalThis as unknown as { __relayApprovalHooks?: ApprovalHooks };

export const hooks: ApprovalHooks = (g.__relayApprovalHooks ??= { proposal: null, proposalApproved: null, proposalRejected: null });
