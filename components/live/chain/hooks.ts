"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";

import { RECORD_KEYS } from "@/lib/relay/bundle";
import { readTexts } from "@/lib/relay/browser";
import { CHAIN_ID } from "@/lib/wagmi";

import { type Proposal, chainApi } from "./api";
import { isPending, proposalState, wantsAllowance } from "./view";

/** GET /api/relay/chain/status (public), re-read every 30 s while shown. */
export function useChainStatus(enabled = true) {
  return useQuery({
    queryKey: ["relay-chain-status"],
    queryFn: chainApi.status,
    enabled,
    retry: false,
    staleTime: 20_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** Every proposal (portal listing); every 4 s while any is still moving, else every 15 s. */
export function useProposals(enabled = true) {
  return useQuery({
    queryKey: ["relay-chain-proposals"],
    queryFn: chainApi.proposals,
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.some((p) => isPending(proposalState(p))) ? 4_000 : 15_000),
    refetchOnWindowFocus: false,
  });
}

/**
 * One proposal, every 4 s while it is pending. Once it is on chain the relay is asked for the
 * allowance used at every level too (one ENS read, so not while it only awaits approval).
 */
export function useProposal(id: string | null) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ["relay-chain-proposal", id],
    queryFn: () => {
      const known = client.getQueryData<Proposal>(["relay-chain-proposal", id]) ?? client.getQueryData<Proposal[]>(["relay-chain-proposals"])?.find((p) => p.id === id);
      return chainApi.proposal(id!, { allowance: !!known && wantsAllowance(proposalState(known)) });
    },
    enabled: !!id,
    retry: false,
    refetchInterval: (query) => (query.state.data && !isPending(proposalState(query.state.data)) ? false : 4_000),
    refetchOnWindowFocus: false,
  });
}

/**
 * The company root's `relay.chain` record, read from its resolver (children listings carry the
 * record for every lower name). undefined while loading, null when unset.
 */
export function useRootChainRecord(root: string | null, resolver: Address | null) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const query = useQuery({
    queryKey: ["relay-root-chain", resolver, root],
    queryFn: async () => {
      const texts = await readTexts(client!, resolver!, root!, [RECORD_KEYS.chain]);
      const text = (texts[RECORD_KEYS.chain] ?? "").trim();
      return text && text.length <= 4096 ? text : null;
    },
    enabled: !!client && !!resolver && !!root,
    retry: 1,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  if (root && !resolver) return null;
  return query.isSuccess ? query.data : query.isError ? null : undefined;
}
