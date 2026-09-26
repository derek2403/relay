"use client";

// "Create a subagent" (new in live mode): SRC SubnameSetup's steps for the agent's name
// (deploy a registry via the VerifiableFactory, setSubregistry, setParent), then the subagent
// is registered in it exactly like a session (SessionForm): owner = new key, resolver = yours.

import { type Address, zeroAddress } from "viem";
import { useConnection, useReadContract } from "wagmi";

import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { labelId, splitFirst } from "@/lib/ens/names";
import { RegistryRoles } from "@/lib/ens/roles";
import { useRelaySubnameSetup } from "@/lib/hooks/useRelaySetup";
import type { Bundle } from "@/lib/relay/bundle";
import { CHAIN_ID } from "@/lib/wagmi";

import { useLive } from "../LiveContext";
import type { Step } from "../tx/Steps";
import { reservedSubagentLabels, subagentCommand, subagentGate } from "./logic";
import { SessionForm } from "./SessionForm";
import { Snippet } from "./Snippet";

export type SubagentAgent = {
  name: string;
  /** Registry holding the agent's label. */
  registry: Address;
  subregistry: Address | null;
  bundle: Bundle | null;
  /** Unix seconds. */
  expiry: number | null;
  active: boolean;
  /** Wallet holds ROLE_REGISTRAR on the agent's subregistry. */
  canAddBelow: boolean;
};

export function SubagentForm({ agent, onDone, onCancel }: { agent: SubagentAgent; onDone: (name: string) => void; onCancel: () => void }) {
  const live = useLive();
  const { address } = useConnection();
  const setup = useRelaySubnameSetup(agent.name, agent.registry);
  const [label, parent] = splitFirst(agent.name);

  // setSubregistry on the agent's token: token roles or root roles in the registry that holds it.
  const canSetSub = useReadContract({
    address: agent.registry,
    abi: UserRegistryImplAbi,
    functionName: "hasRoles",
    args: [labelId(label), RegistryRoles.ROLE_SET_SUBREGISTRY, (address ?? zeroAddress) as Address],
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  });

  const gate = subagentGate(
    {
      active: agent.active,
      subregistry: agent.subregistry,
      predicted: setup.predicted ?? null,
      canRegisterBelow: agent.canAddBelow,
      canSetSubregistry: canSetSub.data === true,
      loading: !!address && (canSetSub.isLoading || setup.loading),
    },
    agent.name,
  );
  const cli = (l: string | null, b: Bundle | null, s: number) => subagentCommand(l, b, s);

  if (!address) return <p className="form-hint">Connect a wallet to create a subagent.</p>;
  if (gate.mode === "loading") return <p className="form-hint">Checking what this wallet may do under {agent.name}…</p>;
  if (gate.mode === "blocked") {
    return (
      <>
        <p className="form-hint">{gate.reason}</p>
        <p className="dialog-description">On the machine that holds {agent.name}&apos;s key, the relay CLI can create one instead:</p>
        <Snippet text={subagentCommand(null, agent.bundle, 20 * 60)} />
        <div className="dialog-footer">
          <button type="button" className="secondary" onClick={onCancel}>
            Close
          </button>
        </div>
      </>
    );
  }

  const prepSteps: Step[] =
    gate.mode === "setup"
      ? [
          { label: `Deploy a registry for ${agent.name}`, done: setup.deployed, active: !setup.deployed },
          { label: `Attach it under ${agent.name}`, done: setup.attached, active: setup.deployed && !setup.attached },
          { label: `Point it back at ${parent}`, done: setup.parentOk, active: setup.attached && !setup.parentOk },
        ]
      : [];

  const prepare = async () => {
    if (gate.mode !== "setup" || setup.done) return true;
    const ok = await setup.runAll();
    if (ok) live.log("Subagents enabled", `${agent.name} has its own registry`);
    return ok;
  };

  return (
    <SessionForm
      kind="subagent"
      parentName={agent.name}
      parentBundle={agent.bundle}
      registry={gate.registry as Address}
      registryLive={gate.mode === "ready" || setup.deployed}
      maxExpiry={agent.expiry}
      reserved={reservedSubagentLabels(agent.name)}
      prepSteps={prepSteps}
      prepare={prepare}
      prepTx={setup.tx}
      cli={cli}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}
