"use client";

// Live mode's shared contract. LiveWorkspace (components/live/LiveWorkspace.tsx) provides this context;
// every live feature (members/, sessions/, agents/, policies/, setup/, providers/) reads it with useLive().
//
// Feature entry points (each folder owns its files and renders its own <Dialog/>s):
//   members/MemberActions.tsx      <MemberActions node={LiveNode} />   add member, edit limits, delegated cap, plan link, extend, remove, enable names below
//   sessions/SessionActions.tsx    <SessionActions node={LiveNode} />  start agent session, create subagent, agent tools / token, agent setup snippet
//   agents/AgentsView.tsx          <AgentsView />                      agent keys in this browser, try a call, relay activity log
//   policies/PoliciesView.tsx      <PoliciesView />                    plans, delegates
//   setup/SetupView.tsx            <SetupView />                       relay status, company setup checklist (register root), session minter, DNS alias
//   providers/ProvidersLiveView.tsx <ProvidersLiveView />              catalog cards, owner-signed credentials, View attestation
//   approvals/ApprovalsView.tsx    <ApprovalsView />                   incidents and blockchain proposals waiting for a human (World ID + wallet)
//   chain/TaskPanel.tsx            <TaskPanel />                       an agent's plain-language blockchain task (in the Agents view)
// Shared building blocks (components/live/tx/*, components/live/BundleEditor.tsx) are listed in their own files.

import { createContext, useContext } from "react";
import type { Address } from "viem";
import type { RelayNodeKind } from "@/lib/hooks/useRelayNode";
import type { Bundle } from "@/lib/relay/bundle";
import type { StatusResponse } from "@/lib/relay/types";
import type { OrgNodeView, ProviderIndex } from "@/lib/view-model";

export type LiveViewId = "tree" | "providers" | "agents" | "approvals" | "policies" | "setup";

/** Something the Approvals view can open for review. */
export type ReviewTarget = { kind: "incident" | "proposal"; id: string };

/** One ENS name in the live tree: the shared view model plus what live features need to act on it. */
export type LiveNode = OrgNodeView & {
  /** Normalized full ENS name; also used as the node id. */
  name: string;
  /** Registry holding this name's label (the parent's subregistry; ETHRegistry for the root). */
  registry: Address;
  resolver: Address | null;
  subregistry: Address | null;
  kind: RelayNodeKind;
  bundle: Bundle | null;
  /** The name's own `relay.chain` record (raw text); null when unset, undefined while unknown. */
  chain?: string | null;
};

export type LiveContextValue = {
  /** Company root (RELAY_ROOT_NAME, else the draft typed in this browser); null until one is known. */
  root: string | null;
  /** Saves the draft root in this browser (ignored by the relay while RELAY_ROOT_NAME is set). */
  setDraftRoot: (name: string) => void;
  status: StatusResponse | undefined;
  statusError: unknown;
  /** Every loaded node, revoked ones included. */
  nodes: readonly LiveNode[];
  providerIndex: ProviderIndex;
  treeLoading: boolean;
  selected: LiveNode | null;
  select: (id: string) => void;
  /** Connected wallet, if any, and whether it is on Sepolia. */
  address: Address | undefined;
  onSepolia: boolean;
  view: LiveViewId;
  setView: (view: LiveViewId) => void;
  /** Re-reads chain + relay data after a write (relay queries, wagmi reads and the tree). */
  refresh: () => Promise<void>;
  /** Adds a row to the workspace activity list (this browser session only). */
  log: (title: string, detail: string) => void;
  toast: (message: string) => void;
  /** Opens the Approvals view on one incident or proposal. */
  openReview: (target: ReviewTarget) => void;
  /** What openReview asked for last (the Approvals view clears it once shown). */
  review: ReviewTarget | null;
  clearReview: () => void;
};

export const LiveContext = createContext<LiveContextValue | null>(null);

export function useLive(): LiveContextValue {
  const value = useContext(LiveContext);
  if (!value) throw new Error("useLive() must be used inside <LiveWorkspace/>");
  return value;
}
