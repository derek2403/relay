"use client";

import { type Address, isAddressEqual, zeroAddress } from "viem";
import { useBytecode, useConnection, useReadContract, useWriteContract } from "wagmi";

import { ETHRegistryAbi } from "@/lib/ens/abis/ETHRegistry";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import {
  PERMISSIONED_RESOLVER_IMPL,
  USER_REGISTRY_IMPL,
  VERIFIABLE_FACTORY,
  allRolesTo,
  encodeRegistryInit,
  encodeResolverInit,
  predictProxyAddress,
  registrySalt,
  resolverSalt,
  verifiableFactoryAbi,
} from "@/lib/ens/factory";
import { labelId, namehash, splitFirst } from "@/lib/ens/names";
import { CHAIN_ID } from "@/lib/wagmi";

import { useTx } from "./useTx";

/**
 * "Let names be added below `name`": the wallet deploys its own UserRegistry
 * for the name (predictable address), attaches it to the name's entry in
 * `parentRegistry`, and points the new registry's parent back at that entry
 * so canonical-name checks pass. Each step's done state is read from chain,
 * so a reload resumes where it stopped.
 */
export function useRelaySubnameSetup(name: string | null, parentRegistry: Address | null) {
  const { address } = useConnection();
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const [label] = name ? splitFirst(name) : [""];

  const proxyLogic = useReadContract({ address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "proxyLogic", chainId: CHAIN_ID });
  const predicted =
    name && address && proxyLogic.data
      ? predictProxyAddress({ proxyLogic: proxyLogic.data, deployer: address, salt: registrySalt(namehash(name)) })
      : undefined;

  const code = useBytecode({ address: predicted, chainId: CHAIN_ID, query: { enabled: !!predicted } });
  const deployed = !!code.data && code.data !== "0x";

  const current = useReadContract({
    address: parentRegistry ?? undefined,
    abi: ETHRegistryAbi,
    functionName: "getSubregistry",
    args: [label],
    chainId: CHAIN_ID,
    query: { enabled: !!parentRegistry && !!label },
  });
  const parent = useReadContract({
    address: predicted,
    abi: UserRegistryImplAbi,
    functionName: "getParent",
    chainId: CHAIN_ID,
    query: { enabled: deployed },
  });

  const attached = !!predicted && !!current.data && isAddressEqual(current.data, predicted);
  /** Another registry is attached (e.g. from an earlier experiment); attaching replaces it. */
  const other = current.data && current.data !== zeroAddress && !attached ? current.data : null;
  const parentOk =
    !!parent.data && !!parentRegistry && isAddressEqual(parent.data[0], parentRegistry) && parent.data[1] === label;

  const deploy = async () => {
    if (!address || !name) return null;
    const r = await tx.run(() =>
      mutateAsync({
        address: VERIFIABLE_FACTORY,
        abi: verifiableFactoryAbi,
        functionName: "deployProxy",
        args: [USER_REGISTRY_IMPL, registrySalt(namehash(name)), encodeRegistryInit(allRolesTo(address))],
        chainId: CHAIN_ID,
      }),
    );
    if (r) await code.refetch();
    return r;
  };

  const attach = async () => {
    if (!parentRegistry || !predicted) return null;
    const r = await tx.run(() =>
      mutateAsync({
        address: parentRegistry,
        abi: ETHRegistryAbi,
        functionName: "setSubregistry",
        args: [labelId(label), predicted],
        chainId: CHAIN_ID,
      }),
    );
    if (r) await current.refetch();
    return r;
  };

  const linkParent = async () => {
    if (!parentRegistry || !predicted) return null;
    const r = await tx.run(() =>
      mutateAsync({
        address: predicted,
        abi: UserRegistryImplAbi,
        functionName: "setParent",
        args: [parentRegistry, label],
        chainId: CHAIN_ID,
      }),
    );
    if (r) await parent.refetch();
    return r;
  };

  /** The wallet's resolver (same call as useMyResolver.deploy, but returns the result so flows can chain). */
  const deployResolver = async () => {
    if (!address) return null;
    return tx.run(() =>
      mutateAsync({
        address: VERIFIABLE_FACTORY,
        abi: verifiableFactoryAbi,
        functionName: "deployProxy",
        args: [PERMISSIONED_RESOLVER_IMPL, resolverSalt(address), encodeResolverInit(allRolesTo(address))],
        chainId: CHAIN_ID,
      }),
    );
  };

  /** Runs whatever steps are left, in order. */
  const runAll = async () => {
    if (!deployed && !(await deploy())) return false;
    if (!attached && !(await attach())) return false;
    if (!parentOk && !(await linkParent())) return false;
    return true;
  };

  return {
    predicted,
    deployed,
    attached,
    other,
    parentOk,
    done: deployed && attached && parentOk,
    loading: proxyLogic.isLoading || code.isLoading || current.isLoading,
    deploy,
    attach,
    linkParent,
    deployResolver,
    runAll,
    tx,
  };
}
