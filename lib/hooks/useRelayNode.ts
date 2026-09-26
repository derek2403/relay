"use client";

import { useQuery } from "@tanstack/react-query";
import { type Address, isAddressEqual, zeroAddress } from "viem";
import { useConnection, usePublicClient, useReadContract, useReadContracts } from "wagmi";

import { ETHRegistryAbi } from "@/lib/ens/abis/ETHRegistry";
import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { textKeyResource } from "@/lib/ens/access";
import { addresses } from "@/lib/ens/contracts";
import { labelId, splitFirst } from "@/lib/ens/names";
import { RegistryRoles, ResolverRoles } from "@/lib/ens/roles";
import { readBundle } from "@/lib/relay/browser";
import { PROVIDERS, type ProviderId, RECORD_KEYS } from "@/lib/relay/bundle";
import { CHAIN_ID } from "@/lib/wagmi";

const orNull = (a: Address | undefined) => (a && a !== zeroAddress ? a : null);

const METERED = PROVIDERS.filter((p) => p.metered).map((p) => p.id) as ProviderId[];

/** A name and the registry that holds its label (ETHRegistry for the company root). */
export type RelayNodeRef = { name: string; registry: Address };

export type RelayNodeKind = "company" | "member" | "agent";

/**
 * Live chain state of one name in the tree, plus what the connected wallet
 * may do with it. Every action panel derives its availability from this, so
 * users see why something isn't possible instead of a revert.
 */
export function useRelayNode(ref: RelayNodeRef | null) {
  const { address } = useConnection();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const name = ref?.name ?? null;
  const registry = ref?.registry;
  const [label, parent] = name ? splitFirst(name) : ["", ""];
  const id = labelId(label);
  const isRoot = !!registry && isAddressEqual(registry, addresses.ETHRegistry);
  const on = { enabled: !!registry && !!label };

  const state = useReadContract({ address: registry, abi: ETHRegistryAbi, functionName: "getState", args: [id], chainId: CHAIN_ID, query: on });
  const resolverRead = useReadContract({ address: registry, abi: ETHRegistryAbi, functionName: "getResolver", args: [label], chainId: CHAIN_ID, query: on });
  const subRead = useReadContract({ address: registry, abi: ETHRegistryAbi, functionName: "getSubregistry", args: [label], chainId: CHAIN_ID, query: on });

  const s = state.data;
  const active = s?.status === 2;
  const owner = active ? s.latestOwner : null;
  // Expired names read as available but keep their owner; unregistered names lose it.
  const expired = !!s && !active && s.latestOwner !== zeroAddress && s.expiry > 0n;
  const resolver = orNull(resolverRead.data);
  const subregistry = orNull(subRead.data);
  const iOwn = !!owner && !!address && isAddressEqual(owner, address);

  // Members are registered with ROLE_SET_SUBREGISTRY on their name, agents with no roles.
  // Roles stay on an expired name's token until the label is registered again.
  const ownerRoles = useReadContract({
    address: registry,
    abi: ETHRegistryAbi,
    functionName: "hasRoles",
    args: [id, RegistryRoles.ROLE_SET_SUBREGISTRY, (owner ?? s?.latestOwner ?? zeroAddress) as Address],
    chainId: CHAIN_ID,
    query: { enabled: !!registry && !isRoot && !!s && s.latestOwner !== zeroAddress },
  });

  const wallet = (address ?? zeroAddress) as Address;
  const withWallet = { enabled: !!address && !!registry && !isRoot };
  const canRemove = useReadContract({
    address: registry,
    abi: UserRegistryImplAbi,
    functionName: "hasRootRoles",
    args: [RegistryRoles.ROLE_UNREGISTER, wallet],
    chainId: CHAIN_ID,
    query: withWallet,
  });
  const canRenew = useReadContract({
    address: registry,
    abi: UserRegistryImplAbi,
    functionName: "hasRootRoles",
    args: [RegistryRoles.ROLE_RENEW, wallet],
    chainId: CHAIN_ID,
    query: withWallet,
  });
  const resolverRoles = useReadContract({
    address: resolver ?? undefined,
    abi: PermissionedResolverImplAbi,
    functionName: "roles",
    args: [0n, wallet],
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!resolver },
  });
  const canAddBelow = useReadContract({
    address: subregistry ?? undefined,
    abi: UserRegistryImplAbi,
    functionName: "hasRootRoles",
    args: [RegistryRoles.ROLE_REGISTRAR, wallet],
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!subregistry },
  });

  // Key-scoped delegation: which caps the wallet may change without holding ROLE_SET_TEXT on root.
  const capRoles = useReadContracts({
    contracts: METERED.map((p) => ({
      address: resolver ?? undefined,
      abi: PermissionedResolverImplAbi,
      functionName: "roles" as const,
      args: [textKeyResource(RECORD_KEYS.cap(p)), wallet] as const,
      chainId: CHAIN_ID,
    })),
    query: { enabled: !!address && !!resolver },
  });
  const delegatedCaps = METERED.filter(
    (_, i) => ((capRoles.data?.[i]?.result as bigint | undefined) ?? 0n) & ResolverRoles.ROLE_SET_TEXT,
  );

  const bundle = useQuery({
    queryKey: ["relay-bundle", resolver, name],
    queryFn: () => readBundle(client!, resolver!, name!),
    enabled: !!client && !!resolver && !!name,
    retry: 1,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const rootRoles = resolverRoles.data ?? 0n;
  // By roles alone, and unknown (null) until they are read: a name can gain a subregistry
  // without becoming a member, and treating an agent as a member would offer it plans.
  const kind: RelayNodeKind | null = isRoot
    ? "company"
    : ownerRoles.data === undefined
      ? null
      : ownerRoles.data
        ? "member"
        : "agent";

  return {
    name,
    label,
    parent,
    registry: registry ?? null,
    isRoot,
    kind,
    state: s,
    active,
    expired,
    owner,
    expiry: s ? Number(s.expiry) : null,
    resolver,
    subregistry,
    iOwn,
    /** Wallet can remove this name (ROLE_UNREGISTER on the registry that holds it). */
    canRemove: canRemove.data === true,
    /** Wallet can extend this name, including reviving it after expiry. */
    canRenew: canRenew.data === true,
    /** Wallet can write this name's bundle (ROLE_SET_TEXT on the resolver that serves it). */
    canWriteBundle: (rootRoles & ResolverRoles.ROLE_SET_TEXT) !== 0n,
    canSetAddress: (rootRoles & ResolverRoles.ROLE_SET_ADDRESS) !== 0n,
    canLink: (rootRoles & ResolverRoles.ROLE_LINK) !== 0n,
    /** Wallet can register names under this one. */
    canAddBelow: canAddBelow.data === true,
    /** Metered providers whose cap the wallet may change here through a per-key delegation. */
    delegatedCaps,
    bundle: bundle.data ?? null,
    /** The bundle read is in flight; `bundle` being null doesn't mean "no access" yet. */
    bundleLoading: bundle.isLoading,
    /** The bundle couldn't be read (e.g. the RPC rate-limited us); don't treat it as "no access". */
    bundleError: bundle.error,
    /** The owner-roles read failed, so `kind` stays null. */
    kindError: ownerRoles.error,
    loading: state.isLoading || resolverRead.isLoading || subRead.isLoading,
    error: state.error ?? resolverRead.error ?? subRead.error ?? null,
    refetch: async () => {
      await Promise.all([state.refetch(), resolverRead.refetch(), subRead.refetch()]);
      await Promise.all([
        ownerRoles.refetch(),
        canRemove.refetch(),
        canRenew.refetch(),
        resolverRoles.refetch(),
        canAddBelow.refetch(),
        capRoles.refetch(),
        bundle.refetch(),
      ]);
    },
  };
}

export type RelayNode = ReturnType<typeof useRelayNode>;
