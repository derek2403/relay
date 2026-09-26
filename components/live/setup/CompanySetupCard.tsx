"use client";

import { type ReactNode, useState } from "react";
import { isAddressEqual } from "viem";
import { useWriteContract } from "wagmi";

import { BundleEditor } from "@/components/live/BundleEditor";
import { useLive } from "@/components/live/LiveContext";
import { type Step, Steps } from "@/components/live/tx/Steps";
import { TxButton } from "@/components/live/tx/TxButton";
import { TxStatus } from "@/components/live/tx/TxStatus";
import { ETHRegistryAbi } from "@/lib/ens/abis/ETHRegistry";
import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { addresses, explorerAddress } from "@/lib/ens/contracts";
import { labelId } from "@/lib/ens/names";
import { useMyResolver } from "@/lib/hooks/useMyResolver";
import { useRelayNode } from "@/lib/hooks/useRelayNode";
import { useRelaySubnameSetup } from "@/lib/hooks/useRelaySetup";
import { useTx } from "@/lib/hooks/useTx";
import { type BundleDraft, bundleCalls, bundleFromDraft, draftFromBundle } from "@/lib/relay/browser";
import { describeBundle } from "@/lib/relay/bundle";
import { CHAIN_ID } from "@/lib/wagmi";

import { Pill, SetupCard, Why, useOnTxSuccess } from "./bits";
import { RegisterRoot } from "./RegisterRoot";
import { companyDefault, companyReady, companySteps } from "./setup-model";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** SRC CompanySetup: own the root, deploy the resolver, point the root at it, write limits, let people be added. */
export function CompanySetupCard() {
  const { root, status, address, refresh, log, toast, setDraftRoot } = useLive();
  const { mutateAsync } = useWriteContract();
  const node = useRelayNode(root ? { name: root, registry: addresses.ETHRegistry } : null);
  const my = useMyResolver();
  const setup = useRelaySubnameSetup(root, addresses.ETHRegistry);
  const tx = useTx();
  const [draft, setDraft] = useState<BundleDraft | null>(null);
  const [editing, setEditing] = useState(false);

  const isEth2ld = !!root && /^[^.]+\.eth$/.test(root);
  const owns = node.iOwn;
  const pointed = !!node.resolver && !!my.resolver && my.deployed && isAddressEqual(node.resolver, my.resolver);
  const current = pointed ? (node.bundle?.bundle ?? null) : null;
  const value = draft ?? draftFromBundle(current ?? companyDefault(status));
  const parsed = bundleFromDraft(value);
  const chain = { owns, resolverDeployed: my.deployed, pointed, hasLimits: !!current, editingLimits: editing, subnamesDone: setup.done };
  const [sOwn, sResolver, sPoint, sLimits, sSubnames] = companySteps(chain);
  const allDone = companyReady(chain);

  const onRegistered = (name: string) => {
    if (!status?.root) setDraftRoot(name);
  };

  useOnTxSuccess(my.tx, () => {
    log("Resolver deployed", `${my.resolver ?? ""} will hold the company's limits`);
    toast("Resolver deployed on Sepolia.");
    void refresh();
  });

  const pointAtMyResolver = async () => {
    if (!root || !my.resolver) return;
    const resolver = my.resolver;
    const r = await tx.run(() =>
      mutateAsync({ address: addresses.ETHRegistry, abi: ETHRegistryAbi, functionName: "setResolver", args: [labelId(node.label), resolver], chainId: CHAIN_ID }),
    );
    if (r) {
      await refresh();
      log("Resolver set", `${root} now uses ${resolver}`);
      toast("Saved on Sepolia.");
    }
  };

  const saveBundle = async () => {
    if (!root || !my.resolver || !parsed.bundle) return;
    const resolver = my.resolver;
    const bundle = parsed.bundle;
    const r = await tx.run(() =>
      mutateAsync({ address: resolver, abi: PermissionedResolverImplAbi, functionName: "multicall", args: [bundleCalls(root, bundle)], chainId: CHAIN_ID }),
    );
    if (r) {
      setDraft(null);
      setEditing(false);
      await refresh();
      log("Company limits saved", `${root}: ${describeBundle(bundle)}`);
      toast("Company limits saved on Sepolia.");
    }
  };

  const enableAdding = async () => {
    const ok = await setup.runAll();
    await refresh();
    if (ok && root) {
      log("People can be added", `${root} has its own registry`);
      toast("People can now be added.");
    }
  };

  const ownDetail = (): ReactNode => {
    if (owns || !root) return null;
    if (!address) return <Why>Connect the wallet that owns {root}.</Why>;
    if (node.loading) return <Why>Checking…</Why>;
    if (node.active && node.owner)
      return (
        <Why>
          {root} belongs to{" "}
          <a href={explorerAddress(node.owner)} target="_blank" rel="noreferrer" className="live-setup-mono">
            {short(node.owner)}
          </a>
          . Connect that wallet to set it up.
        </Why>
      );
    if (node.expired) return <Why>{root} has expired. Renew it before setting it up.</Why>;
    if (isEth2ld) return <RegisterRoot onRegistered={onRegistered} />;
    return <Why>{root} isn&apos;t registered. Only .eth names can be registered here.</Why>;
  };

  const limitsDetail = (): ReactNode => {
    if (!pointed) return null;
    if (current && !editing)
      return (
        <div className="live-setup-actions">
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      );
    return (
      <div className="live-setup-limits">
        <Why>Nobody in the company can go beyond these. Leave a cap empty for no cap at this level.</Why>
        <BundleEditor value={value} onChange={setDraft} />
        {parsed.error && (
          <p className="form-error" role="alert">
            {parsed.error}
          </p>
        )}
        <div className="live-setup-actions">
          <TxButton tx={tx} variant="primary" onClick={() => void saveBundle()} disabled={!parsed.bundle}>
            Save company limits
          </TxButton>
          {editing && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setEditing(false);
                setDraft(null);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  };

  const subnameSteps: [boolean, string][] = [
    [setup.deployed, `Create a place for names under ${root ?? "the company"}`],
    [setup.attached, `Connect it to ${root ?? "the company"}`],
    [setup.parentOk, `Confirm it belongs to ${root ?? "the company"} (so the relay trusts it)`],
  ];

  const steps: Step[] = root
    ? [
        { ...sOwn, label: `Own ${root}`, detail: ownDetail() },
        {
          ...sResolver,
          label: "Deploy your resolver (it holds the company's limits)",
          detail:
            owns && !my.deployed && !my.loading ? (
              <div className="live-setup-actions">
                <TxButton tx={my.tx} onClick={() => void my.deploy()}>
                  Deploy my resolver
                </TxButton>
              </div>
            ) : undefined,
        },
        {
          ...sPoint,
          label: `Point ${root} at your resolver`,
          detail:
            owns && my.deployed && !pointed ? (
              <div className="live-setup-actions">
                <TxButton tx={tx} onClick={() => void pointAtMyResolver()}>
                  Use my resolver for {root}
                </TxButton>
              </div>
            ) : undefined,
        },
        { ...sLimits, label: current ? `Company limits: ${describeBundle(current)}` : "Write the company limits", detail: limitsDetail() },
        {
          ...sSubnames,
          label: "Let people be added under the company",
          detail:
            owns && !setup.done ? (
              <div className="live-setup-subname">
                <ul className="live-setup-ticks">
                  {subnameSteps.map(([done, text]) => (
                    <li key={text} className={done ? "done" : undefined}>
                      {done ? "✓" : "○"} {text}
                    </li>
                  ))}
                </ul>
                {setup.other && (
                  <p className="form-error">
                    {root} already has names below it from an earlier setup. Continuing replaces them, and they stop working.
                  </p>
                )}
                <div className="live-setup-actions">
                  <TxButton tx={setup.tx} onClick={() => void enableAdding()} disabled={setup.loading || my.loading}>
                    Enable adding people
                  </TxButton>
                </div>
                <TxStatus tx={setup.tx} />
              </div>
            ) : undefined,
        },
      ]
    : [];

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <SetupCard
      id="setupCompany"
      index="03"
      title="Company setup"
      pill={<Pill tone={allDone ? "ok" : "warn"}>{root ? (allDone ? "Ready" : `${doneCount} of 5 done`) : "No company"}</Pill>}
      description="For the owner of the company name. Each tick is read from the chain, so you can stop and come back."
    >
      {!root ? (
        <>
          <div className="form-hint">Type your company name in Relay status above, or register a new .eth name here.</div>
          <RegisterRoot onRegistered={onRegistered} />
        </>
      ) : (
        <Steps steps={steps} />
      )}
      <TxStatus tx={my.tx} />
      <TxStatus tx={tx} />
      {allDone && <div className="form-hint">The company is set up. Add people and agents in the team tree.</div>}
    </SetupCard>
  );
}
