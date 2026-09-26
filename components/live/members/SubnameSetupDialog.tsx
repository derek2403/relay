"use client";

import type { FormEvent } from "react";
import type { Address } from "viem";

import { Dialog } from "@/components/ui/Dialog";
import { useMyResolver } from "@/lib/hooks/useMyResolver";
import { useRelaySubnameSetup } from "@/lib/hooks/useRelaySetup";

import { useLive } from "../LiveContext";
import { Steps } from "../tx/Steps";
import { TxButton } from "../tx/TxButton";
import { TxStatus } from "../tx/TxStatus";
import { activeStep, subnameSteps } from "./logic";
import { DialogHead } from "./parts";

type Props = { open: boolean; name: string; parentRegistry: Address; onClose: () => void };

/**
 * "Let me add names below" (SRC SubnameSetup withResolver, F9 team leads): deploy the wallet's resolver,
 * deploy its UserRegistry for the name, setSubregistry on the parent, setParent back. Steps are read
 * from chain, so reopening resumes where it stopped.
 */
export function SubnameSetupDialog({ open, name, parentRegistry, onClose }: Props) {
  return (
    <Dialog id="liveSubnameSetupDialog" open={open} onClose={onClose}>
      {open && <SubnameSetupForm name={name} parentRegistry={parentRegistry} onClose={onClose} />}
    </Dialog>
  );
}

function SubnameSetupForm({ name, parentRegistry, onClose }: Omit<Props, "open">) {
  const live = useLive();
  const setup = useRelaySubnameSetup(name, parentRegistry);
  const my = useMyResolver();
  const needResolver = !my.deployed;

  const run = async () => {
    if (needResolver && !(await setup.deployResolver())) return;
    const ok = await setup.runAll();
    await live.refresh();
    if (ok) {
      live.select(name);
      live.toast(`You can add names below ${name} now.`);
      live.log("Names below enabled", `${name} has its own registry`);
    }
  };

  const steps = subnameSteps(name, {
    withResolver: true,
    resolverDeployed: my.deployed,
    deployed: setup.deployed,
    attached: setup.attached,
    parentOk: setup.parentOk,
  });
  const next = activeStep(steps);
  const done = setup.done && !needResolver;

  return (
    <form onSubmit={(e: FormEvent) => e.preventDefault()}>
      <DialogHead title="Add names below" onClose={onClose}>
        For a team lead: you get your own registry and resolver, then you can add people and agents under {name}.
      </DialogHead>
      <Steps steps={steps.map((s, i) => ({ label: s.label, done: s.done, active: i === next }))} />
      {setup.other && (
        <div className="form-hint">{name} already has names below it from an earlier setup. Continuing replaces them, and they stop working.</div>
      )}
      {!done && <div className="form-hint">Up to four wallet confirmations. You can stop and come back: finished steps stay done.</div>}
      <TxStatus tx={setup.tx} showEvents={false} />
      <div className="dialog-footer">
        <button type="button" className={done ? "primary" : "secondary"} onClick={onClose}>
          {done ? "Done" : "Cancel"}
        </button>
        {!done && (
          <TxButton tx={setup.tx} variant="primary" onClick={run} disabled={setup.loading || my.loading}>
            Let me add names below
          </TxButton>
        )}
      </div>
    </form>
  );
}
