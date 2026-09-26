"use client";

// What a manager does to names below them (SRC NameActions + AddMember + ManageChild + SubnameSetup).
// Each entry button is gated on the same useRelayNode flags SRC uses (see memberGates in ./logic).

import { useState, useSyncExternalStore } from "react";

import { useRelayNode } from "@/lib/hooks/useRelayNode";

import type { LiveNode } from "../LiveContext";
import { useLive } from "../LiveContext";
import { AddMemberDialog } from "./AddMemberDialog";
import { memberGates } from "./logic";
import { CapDialog, EditLimitsDialog, ExtendDialog, PlanDialog, RemoveDialog } from "./ManageDialogs";
import { SubnameSetupDialog } from "./SubnameSetupDialog";

type Open = "add" | "edit" | "cap" | "plan" | "extend" | "remove" | "below" | null;

const noop = () => () => {};

export function MemberActions({ node }: { node: LiveNode }) {
  const live = useLive();
  // Wallet state only exists in the browser: render nothing wallet-dependent until mounted.
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const rn = useRelayNode({ name: node.name, registry: node.registry });
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);

  if (!mounted) return null;
  if (rn.loading) return <p className="live-member-note">Reading {node.name} on Sepolia…</p>;

  const g = memberGates({
    connected: !!live.address,
    isRoot: rn.isRoot,
    kind: rn.kind,
    active: rn.active,
    expired: rn.expired,
    iOwn: rn.iOwn,
    subregistry: rn.subregistry,
    expiry: rn.expiry,
    canAddBelow: rn.canAddBelow,
    canRemove: rn.canRemove,
    canRenew: rn.canRenew,
    canWriteBundle: rn.canWriteBundle,
    canLink: rn.canLink,
    delegatedCaps: rn.delegatedCaps,
  });

  return (
    <div className="live-member-actions">
      {g.add && (
        <button type="button" className="detail-button" data-live-action="add-member" onClick={() => setOpen("add")}>
          Add a member
        </button>
      )}
      {g.editLimits && (
        <button type="button" className="detail-button" onClick={() => setOpen("edit")}>
          Edit permissions
        </button>
      )}
      {g.changeCap && (
        <button type="button" className="detail-button" onClick={() => setOpen("cap")}>
          Change a cap
        </button>
      )}
      {g.usePlan && (
        <button type="button" className="detail-button" onClick={() => setOpen("plan")}>
          Use a plan
        </button>
      )}
      {g.extend && (
        <button type="button" className="detail-button" onClick={() => setOpen("extend")}>
          {g.revive ? "Bring back" : "Extend"}
        </button>
      )}
      {g.enableBelow && (
        <button type="button" className="detail-button" onClick={() => setOpen("below")}>
          Let me add names below
        </button>
      )}
      {g.remove && (
        <button type="button" className="revoke-button" onClick={() => setOpen("remove")}>
          {"Remove name & descendants"}
        </button>
      )}

      {g.registryNotMine && <p className="live-member-note">Names below {node.name} were set up by another wallet, so you can&apos;t add names there.</p>}
      {g.needsCompanySetup && <p className="live-member-note">Finish company setup to add people.</p>}
      {g.removed && <p className="live-member-note">{node.name} was removed. The level above can add it again.</p>}
      {g.endedForGood && <p className="live-member-note">{node.name} has ended. Only the level above can bring it back.</p>}
      {g.nothingToDo && <p className="live-member-note">Nothing to do here with this wallet: only the level above {node.name} can change it.</p>}

      <AddMemberDialog open={open === "add"} parent={rn} onClose={close} />
      <EditLimitsDialog open={open === "edit"} node={rn} onClose={close} />
      <CapDialog open={open === "cap"} node={rn} onClose={close} />
      <PlanDialog open={open === "plan"} node={rn} onClose={close} />
      <ExtendDialog open={open === "extend"} node={rn} onClose={close} />
      <RemoveDialog open={open === "remove"} node={rn} onClose={close} />
      {rn.registry && <SubnameSetupDialog open={open === "below"} name={node.name} parentRegistry={rn.registry} onClose={close} />}
    </div>
  );
}
