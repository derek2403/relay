"use client";

import { useState } from "react";
import { type Address, isAddress, zeroAddress } from "viem";
import { useDeployContract, useReadContract, useWriteContract } from "wagmi";

import { useLive } from "@/components/live/LiveContext";
import { TxButton } from "@/components/live/tx/TxButton";
import { TxStatus } from "@/components/live/tx/TxStatus";
import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { addresses, explorerAddress } from "@/lib/ens/contracts";
import { RegistryRoles, adminOf } from "@/lib/ens/roles";
import { useMyResolver } from "@/lib/hooks/useMyResolver";
import { MINTER_RESOLVER_ROLES, useRelayMinter } from "@/lib/hooks/useRelayMinter";
import { useRelayNode } from "@/lib/hooks/useRelayNode";
import { useTx } from "@/lib/hooks/useTx";
import { SessionMinterAbi, SessionMinterBytecode } from "@/lib/relay/sessionMinter";
import { CHAIN_ID } from "@/lib/wagmi";

import { Pill, SetupCard, Why } from "./bits";

/**
 * SRC SessionMinterCard: one shared contract that registers an agent name and writes its records in one
 * transaction. It re-checks the caller's roles on every call, so granting it roles never lets anyone do more.
 * Acts on "your level": the selected name if this wallet owns it with names below, else the company root.
 */
export function SessionMinterCard() {
  const { root, selected, address, refresh, log, toast } = useLive();
  const { mutateAsync } = useWriteContract();
  const { mutateAsync: deployContract } = useDeployContract();
  const my = useMyResolver();
  const tx = useTx();
  const [pasted, setPasted] = useState("");

  const rootNode = useRelayNode(root ? { name: root, registry: addresses.ETHRegistry } : null);
  const selectedNode = useRelayNode(selected && selected.name !== root ? { name: selected.name, registry: selected.registry } : null);
  const myNode =
    selectedNode.name && selectedNode.iOwn && selectedNode.subregistry
      ? selectedNode
      : rootNode.iOwn && rootNode.subregistry
        ? rootNode
        : null;

  const registry = myNode?.subregistry ?? null;
  const resolver = my.deployed ? (my.resolver ?? null) : null;
  const m = useRelayMinter(registry, resolver);
  const wallet = (address ?? zeroAddress) as Address;

  // Granting a role needs its admin role; the wallet that deployed its registry and resolver has all of them.
  const canGrantRegistry = useReadContract({
    address: registry ?? undefined,
    abi: UserRegistryImplAbi,
    functionName: "hasRootRoles",
    args: [adminOf(RegistryRoles.ROLE_REGISTRAR), wallet],
    chainId: CHAIN_ID,
    query: { enabled: !!registry && !!address },
  });
  const canGrantResolver = useReadContract({
    address: resolver ?? undefined,
    abi: PermissionedResolverImplAbi,
    functionName: "hasRootRoles",
    args: [adminOf(MINTER_RESOLVER_ROLES), wallet],
    chainId: CHAIN_ID,
    query: { enabled: !!resolver && !!address },
  });
  const canGrant = canGrantRegistry.data === true && canGrantResolver.data === true;

  const deploy = async () => {
    const r = await tx.run(() => deployContract({ abi: SessionMinterAbi, bytecode: SessionMinterBytecode, chainId: CHAIN_ID }));
    if (r?.receipt.contractAddress) {
      m.save(r.receipt.contractAddress);
      log("Session Minter deployed", r.receipt.contractAddress);
      toast("Session Minter deployed on Sepolia.");
    }
  };

  const setRoles = async (enable: boolean) => {
    if (!m.minter || !registry || !resolver) return;
    const minter = m.minter;
    const fn = enable ? "grantRootRoles" : "revokeRootRoles";
    if (enable ? !m.onRegistry : m.onRegistry) {
      const r = await tx.run(() =>
        mutateAsync({ address: registry, abi: UserRegistryImplAbi, functionName: fn, args: [RegistryRoles.ROLE_REGISTRAR, minter], chainId: CHAIN_ID }),
      );
      if (!r) return;
    }
    if (enable ? !m.onResolver : m.onResolver) {
      const r = await tx.run(() =>
        mutateAsync({ address: resolver, abi: PermissionedResolverImplAbi, functionName: fn, args: [MINTER_RESOLVER_ROLES, minter], chainId: CHAIN_ID }),
      );
      if (!r) return;
    }
    await m.refetch();
    await refresh();
    log(enable ? "Session Minter enabled" : "Session Minter disabled", `for names under ${myNode?.name ?? ""}`);
    toast(enable ? "One-click sessions are on." : "One-click sessions are off.");
  };

  const pill = !m.minter ? (
    <Pill>Not set</Pill>
  ) : m.ready ? (
    <Pill tone="ok">Enabled</Pill>
  ) : m.deployed ? (
    <Pill tone="warn">Not enabled</Pill>
  ) : m.loading ? (
    <Pill>Checking</Pill>
  ) : (
    <Pill tone="bad">No contract</Pill>
  );

  return (
    <SetupCard
      id="setupMinter"
      index="04"
      title="Session Minter"
      pill={pill}
      description="Starting an agent session normally takes two confirmations. The Session Minter does both in one, and re-checks your roles every time, so it can never do more than you could."
    >
      {!m.minter ? (
        <>
          <Why>No Session Minter yet. Deploy one (anyone can share it), or paste one someone already deployed.</Why>
          <div className="live-setup-actions">
            <TxButton tx={tx} onClick={() => void deploy()}>
              Deploy Session Minter
            </TxButton>
          </div>
          <label className="live-setup-field">
            Existing minter
            <span className="live-setup-inline">
              <input value={pasted} onChange={(e) => setPasted(e.target.value.trim())} placeholder="0x…" spellCheck={false} autoComplete="off" />
              <button type="button" className="secondary" disabled={!isAddress(pasted)} onClick={() => m.save(pasted as Address)}>
                Use this one
              </button>
            </span>
          </label>
        </>
      ) : (
        <>
          <div className="live-setup-row">
            <span>Minter</span>
            <a className="live-setup-mono" href={explorerAddress(m.minter)} target="_blank" rel="noreferrer">
              {m.minter}
            </a>
          </div>
          <div className="live-setup-row">
            <span>{m.fromEnv ? "Shared with your team" : "Saved in this browser"}</span>
            {!m.fromEnv && (
              <button type="button" className="parent-link" onClick={() => m.save(null)}>
                Forget
              </button>
            )}
          </div>
          {!m.fromEnv && (
            <Why>
              To share it with your team, set <code>NEXT_PUBLIC_SESSION_MINTER={m.minter}</code> on the relay.
            </Why>
          )}

          {!myNode || !registry ? (
            <div className="form-hint">Enable it for a name you own with people under it: finish company setup, or select such a name in the tree.</div>
          ) : !resolver ? (
            <div className="form-hint">Deploy your resolver first.</div>
          ) : (
            <>
              <p className="live-setup-muted">
                For names under <b className="live-setup-mono">{myNode.name}</b>. To change, select another name you own in the tree.
              </p>
              <div className="live-setup-chips">
                <span className={`live-setup-chip ${m.onRegistry ? "ok" : ""}`}>{m.onRegistry ? "✓" : "○"} May register names</span>
                <span className={`live-setup-chip ${m.onResolver ? "ok" : ""}`}>{m.onResolver ? "✓" : "○"} May write limits and addresses</span>
              </div>
              {!canGrant && (canGrantRegistry.data === false || canGrantResolver.data === false) && (
                <Why>Only the wallet that set up this registry and resolver can enable it.</Why>
              )}
              <div className="live-setup-actions">
                {!m.ready && (
                  <TxButton tx={tx} onClick={() => void setRoles(true)} disabled={!m.deployed || !canGrant}>
                    Enable for my names
                  </TxButton>
                )}
                {(m.onRegistry || m.onResolver) && (
                  <TxButton tx={tx} variant="secondary" onClick={() => void setRoles(false)} disabled={!canGrant}>
                    Disable
                  </TxButton>
                )}
              </div>
              {m.ready && <Why>Enabled: a browser agent session now takes one confirmation.</Why>}
            </>
          )}
        </>
      )}
      <TxStatus tx={tx} />
    </SetupCard>
  );
}
