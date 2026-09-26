"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { type Address, zeroAddress } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";

import { ETHRegistryAbi } from "@/lib/ens/abis/ETHRegistry";
import { UniversalHelperAbi } from "@/lib/ens/abis/UniversalHelper";
import { addresses } from "@/lib/ens/contracts";
import { labelId } from "@/lib/ens/names";
import { decodeDnsName } from "@/lib/ens/permissioned-registry";
import { RegistryRoles } from "@/lib/ens/roles";
import { childrenQuery } from "@/lib/hooks/useRelayApi";
import { useRelayNode } from "@/lib/hooks/useRelayNode";
import { RelayApiError } from "@/lib/relay/browser";
import type { ChildrenResponse } from "@/lib/relay/types";
import { CHAIN_ID } from "@/lib/wagmi";

import { type CanonicalLookup, LIVE_TREE_LIMITS, type RawLiveNode, collectTree } from "./view";

/** Cache key of a subregistry's canonical name (per address, so a growing tree only reads new ones). */
const canonicalKey = (subregistry: Address) => ["relay-canonical", subregistry.toLowerCase()] as const;

// The first listing of a registry answers 503 "still scanning"; a big tree can also hit the
// relay's per-client budget (429). Both clear up on their own, so keep trying for a while.
const retryListing = (count: number, err: Error) =>
  err instanceof RelayApiError && (err.status === 503 || err.status === 429) ? count < 10 : count < 1;

const batchQuery = (enabled: boolean) => ({ enabled, staleTime: 30_000, refetchOnWindowFocus: false });

/**
 * The whole company tree under `root`: the root from the chain (useRelayNode), every
 * level below from /api/ens/children (breadth first, cached per name like the SRC team
 * tree), then two multicalls: getState for names that aren't registered (expired or
 * removed?) and hasRoles(ROLE_SET_SUBREGISTRY) for member vs agent.
 */
export function useLiveTree(root: string | null) {
  const queryClient = useQueryClient();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const rootNode = useRelayNode(root ? { name: root, registry: addresses.ETHRegistry } : null);

  // Namespace aliasing (SRC TeamTree): an entry can point at another group's registry. Its
  // canonical name says which path the relay accepts; the walk waits for it before going below.
  const canonical: CanonicalLookup = (subregistry) => {
    const state = queryClient.getQueryState<string | null>(canonicalKey(subregistry));
    if (state?.status === "success") return state.data ?? null;
    // Couldn't tell (e.g. RPC limits): show the names below like any other.
    if (state?.status === "error") return null;
    return undefined;
  };

  // Re-planned on every render from the cache: when a listing (or a canonical name) arrives,
  // useQueries re-renders and the names under it join the plan.
  const plan = root
    ? collectTree(root, (name) => queryClient.getQueryData<ChildrenResponse>(childrenQuery(name).queryKey), LIVE_TREE_LIMITS, client ? canonical : undefined)
    : { listed: [], children: [], truncated: false, checks: [] };
  const lists = useQueries({ queries: plan.listed.map((name) => ({ ...childrenQuery(name), retry: retryListing })) });
  // Parallel reads go out as one multicall (wagmi batches the public client).
  useQueries({
    queries: plan.checks.map((subregistry) => ({
      queryKey: canonicalKey(subregistry),
      queryFn: async () => {
        const raw = await client!.readContract({
          address: addresses.UniversalHelper,
          abi: UniversalHelperAbi,
          functionName: "findCanonicalName",
          args: [subregistry],
        });
        return (raw && raw !== "0x" ? decodeDnsName(raw) : null) || null;
      },
      enabled: !!client,
      retry: 1,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    })),
  });

  const gone = plan.children.filter((child) => child.status !== "registered");
  const states = useReadContracts({
    contracts: gone.map((child) => ({
      address: child.registry,
      abi: ETHRegistryAbi,
      functionName: "getState" as const,
      args: [labelId(child.label)] as const,
      chainId: CHAIN_ID,
    })),
    query: batchQuery(gone.length > 0),
  });
  const latest = new Map<string, { latestOwner: Address; expiry: number }>();
  gone.forEach((child, i) => {
    const state = states.data?.[i]?.result as { latestOwner: Address; expiry: bigint } | undefined;
    if (state) latest.set(child.name, { latestOwner: state.latestOwner, expiry: Number(state.expiry) });
  });

  // Roles stay on an expired name's token, so its latest owner still tells member from agent.
  const withOwner = plan.children
    .map((child) => ({ child, owner: child.owner ?? latest.get(child.name)?.latestOwner ?? null }))
    .filter((entry): entry is { child: (typeof plan.children)[number]; owner: Address } => !!entry.owner && entry.owner !== zeroAddress);
  const roles = useReadContracts({
    contracts: withOwner.map(({ child, owner }) => ({
      address: child.registry,
      abi: ETHRegistryAbi,
      functionName: "hasRoles" as const,
      args: [labelId(child.label), RegistryRoles.ROLE_SET_SUBREGISTRY, owner] as const,
      chainId: CHAIN_ID,
    })),
    query: batchQuery(withOwner.length > 0),
  });
  const member = new Map<string, boolean>();
  withOwner.forEach(({ child }, i) => {
    const result = roles.data?.[i]?.result;
    if (typeof result === "boolean") member.set(child.name, result);
  });

  const raw: RawLiveNode[] = [];
  if (root && rootNode.state) {
    raw.push({
      name: root,
      registry: addresses.ETHRegistry,
      status: rootNode.active ? "registered" : "available",
      owner: rootNode.owner,
      latestOwner: rootNode.state.latestOwner,
      expiry: rootNode.expiry,
      resolver: rootNode.resolver,
      subregistry: rootNode.subregistry,
      bundle: rootNode.bundle?.bundle ?? null,
      plan: rootNode.bundle?.plan ?? null,
      member: null,
    });
  }
  for (const child of plan.children) {
    const state = latest.get(child.name);
    raw.push({
      name: child.name,
      registry: child.registry,
      status: child.status,
      owner: child.owner,
      latestOwner: child.owner ?? state?.latestOwner ?? null,
      expiry: child.expiry ?? (state && state.expiry > 0 ? state.expiry : null),
      resolver: child.resolver,
      subregistry: child.subregistry,
      bundle: child.bundle,
      member: member.get(child.name) ?? null,
      aliasOf: child.aliasOf ?? null,
    });
  }

  const listError = lists.find((list) => list.error)?.error ?? null;
  return {
    rootNode,
    raw,
    /** Names the tree lists (their children listings); for polling. */
    listed: plan.listed,
    /** The first read of the root, or of any listing, is still in flight. */
    loading: rootNode.loading || lists.some((list) => list.isLoading),
    /** Root read failed (e.g. RPC limit); the tree can't be drawn. */
    error: rootNode.error,
    /** A listing failed; that part of the tree is missing. */
    listError,
    listErrorName: listError ? plan.listed[lists.findIndex((list) => list.error)] : null,
    /** The tree hit LIVE_TREE_LIMITS and shows only part of the company. */
    truncated: plan.truncated,
  };
}

export type LiveTree = ReturnType<typeof useLiveTree>;
