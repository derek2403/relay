"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { zeroAddress } from "viem";
import { usePublicClient, useReadContract } from "wagmi";

import { ETHRegistryAbi } from "@/lib/ens/abis/ETHRegistry";
import { addresses } from "@/lib/ens/contracts";
import { splitFirst } from "@/lib/ens/names";
import { type LevelBundle, chainNames, readBundle } from "@/lib/relay/browser";
import { CHAIN_ID } from "@/lib/wagmi";

import { childrenQuery } from "./useRelayApi";

/**
 * The bundle of every level from the company root down to `name` (root
 * first, `name` included), for editors that must not offer more than the
 * levels above allow. Public reads only: the root's bundle from the chain and
 * each lower level's from its parent's children listing (usually already
 * cached by the team tree). `levels` is null until every read is in.
 */
export function useRelayLevels(name: string | null) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const names = name ? chainNames(name) : [];
  const root = names[0] ?? null;
  const [rootLabel] = root ? splitFirst(root) : [""];

  const rootResolver = useReadContract({
    address: addresses.ETHRegistry,
    abi: ETHRegistryAbi,
    functionName: "getResolver",
    args: [rootLabel],
    chainId: CHAIN_ID,
    query: { enabled: !!root },
  });
  const resolver = rootResolver.data && rootResolver.data !== zeroAddress ? rootResolver.data : null;
  // Same key as useRelayNode's bundle read, so the company row and the editors share it.
  const rootBundle = useQuery({
    queryKey: ["relay-bundle", resolver, root],
    queryFn: () => readBundle(client!, resolver!, root!),
    enabled: !!client && !!resolver && !!root,
    retry: 1,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const lists = useQueries({ queries: names.slice(0, -1).map((parent) => childrenQuery(parent)) });

  const rootDone = rootResolver.isSuccess && (!resolver || rootBundle.isSuccess);
  const error = rootResolver.error ?? rootBundle.error ?? lists.find((l) => l.error)?.error ?? null;
  const ready = !!root && rootDone && lists.every((l) => l.isSuccess);

  const levels: LevelBundle[] | null = ready
    ? names.map((n, i) => ({
        name: n,
        bundle: i === 0 ? (rootBundle.data?.bundle ?? null) : (lists[i - 1].data?.children.find((c) => c.name === n)?.bundle ?? null),
      }))
    : null;

  return { levels, loading: !!root && !ready && !error, error };
}
