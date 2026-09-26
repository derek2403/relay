"use client";

import { useBytecode, useConnection, useReadContract, useWriteContract } from "wagmi";

import {
  PERMISSIONED_RESOLVER_IMPL,
  VERIFIABLE_FACTORY,
  allRolesTo,
  encodeResolverInit,
  predictProxyAddress,
  resolverSalt,
  verifiableFactoryAbi,
} from "@/lib/ens/factory";
import { CHAIN_ID } from "@/lib/wagmi";

import { useTx } from "./useTx";

/**
 * The connected account's own PermissionedResolver: one proxy per account,
 * deployed through the Verifiable Factory at a predictable address.
 */
export function useMyResolver() {
  const { address } = useConnection();
  const { mutateAsync } = useWriteContract();
  const tx = useTx();

  const proxyLogic = useReadContract({
    address: VERIFIABLE_FACTORY,
    abi: verifiableFactoryAbi,
    functionName: "proxyLogic",
    chainId: CHAIN_ID,
  });

  const resolver =
    address && proxyLogic.data
      ? predictProxyAddress({ proxyLogic: proxyLogic.data, deployer: address, salt: resolverSalt(address) })
      : undefined;

  const code = useBytecode({ address: resolver, chainId: CHAIN_ID, query: { enabled: !!resolver } });
  const deployed = !!code.data && code.data !== "0x";

  const deploy = async () => {
    if (!address) return;
    const r = await tx.run(() =>
      mutateAsync({
        address: VERIFIABLE_FACTORY,
        abi: verifiableFactoryAbi,
        functionName: "deployProxy",
        args: [PERMISSIONED_RESOLVER_IMPL, resolverSalt(address), encodeResolverInit(allRolesTo(address))],
        chainId: CHAIN_ID,
      }),
    );
    if (r) await code.refetch();
  };

  return { resolver, deployed, loading: code.isLoading || proxyLogic.isLoading, deploy, tx };
}
