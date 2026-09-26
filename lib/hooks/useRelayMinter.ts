"use client";

import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { useBytecode, useReadContract } from "wagmi";

import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { RegistryRoles, ResolverRoles } from "@/lib/ens/roles";
import { MINTER_STORAGE } from "@/lib/relay/browser";
import { CHAIN_ID } from "@/lib/wagmi";

import { useLocalJson } from "./useLocalJson";

/** Roles the minter needs on the caller's resolver to write an agent's records. */
export const MINTER_RESOLVER_ROLES = ResolverRoles.ROLE_SET_TEXT | ResolverRoles.ROLE_SET_ADDRESS;

const ENV_MINTER = process.env.NEXT_PUBLIC_SESSION_MINTER;

/**
 * The SessionMinter address (NEXT_PUBLIC_SESSION_MINTER, else one saved in
 * this browser) and whether it may act on `registry` and `resolver`.
 */
export function useRelayMinter(registry: Address | null, resolver: Address | null) {
  const [saved, setSaved] = useLocalJson<string | null>(MINTER_STORAGE, null);
  const envMinter = ENV_MINTER && isAddress(ENV_MINTER) ? getAddress(ENV_MINTER) : null;
  const minter = envMinter ?? (saved && isAddress(saved) ? getAddress(saved) : null);

  const code = useBytecode({ address: minter ?? undefined, chainId: CHAIN_ID, query: { enabled: !!minter } });
  const deployed = !!code.data && code.data !== "0x";
  const who = (minter ?? zeroAddress) as Address;

  const onRegistry = useReadContract({
    address: registry ?? undefined,
    abi: UserRegistryImplAbi,
    functionName: "hasRootRoles",
    args: [RegistryRoles.ROLE_REGISTRAR, who],
    chainId: CHAIN_ID,
    query: { enabled: deployed && !!registry },
  });
  const onResolver = useReadContract({
    address: resolver ?? undefined,
    abi: PermissionedResolverImplAbi,
    functionName: "hasRootRoles",
    args: [MINTER_RESOLVER_ROLES, who],
    chainId: CHAIN_ID,
    query: { enabled: deployed && !!resolver },
  });

  return {
    minter,
    fromEnv: !!envMinter,
    deployed,
    onRegistry: onRegistry.data === true,
    onResolver: onResolver.data === true,
    /** One-transaction sessions are possible for this registry + resolver. */
    ready: deployed && onRegistry.data === true && onResolver.data === true,
    loading: code.isLoading,
    save: (address: Address | null) => setSaved(address),
    refetch: async () => {
      await code.refetch();
      await Promise.all([onRegistry.refetch(), onResolver.refetch()]);
    },
  };
}
