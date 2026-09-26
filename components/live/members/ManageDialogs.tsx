"use client";

import { type FormEvent, useState } from "react";
import { usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { Dialog } from "@/components/ui/Dialog";
import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { dnsEncode, labelId, namehash } from "@/lib/ens/names";
import { useRelayLevels } from "@/lib/hooks/useRelayLevels";
import { chainRecords } from "@/lib/live-bundle-editor";
import { lineageOf } from "@/lib/live/view";
import type { RelayNode } from "@/lib/hooks/useRelayNode";
import { type TxResult, useTx } from "@/lib/hooks/useTx";
import {
  type BundleDraft,
  EXTEND_BY,
  bundleCalls,
  bundleFromDraft,
  chainNow,
  defaultBundle,
  draftFromBundle,
  encodeSetText,
  formatDate,
  nowSec,
  providerLabel,
} from "@/lib/relay/browser";
import { RECORD_KEYS, describeListed } from "@/lib/relay/bundle";
import { CHAIN_ID } from "@/lib/wagmi";

import { type ChainDraft, draftFromGrant, grantFromDraft, pathGrant, readGrant, serializeGrant } from "../chain/grant-model";
import { useChainStatus } from "../chain/hooks";
import { BundleEditor } from "../BundleEditor";
import { useLive } from "../LiveContext";
import { TxButton } from "../tx/TxButton";
import { TxStatus } from "../tx/TxStatus";
import { capValid, editRules, extendedExpiry, planLabel } from "./logic";
import { DialogHead, usePlansUnder } from "./parts";

type DialogProps = { open: boolean; node: RelayNode; onClose: () => void };

const prevent = (e: FormEvent) => e.preventDefault();

/** Refresh, re-select, toast and log after a confirmed write; closes the dialog. */
function useAfterWrite(node: RelayNode, onClose: () => void) {
  const live = useLive();
  return async (r: TxResult | null, toast: string, title: string, detail = node.name ?? "") => {
    if (!r) return false;
    await live.refresh();
    if (node.name) live.select(node.name);
    live.toast(toast);
    live.log(title, detail);
    onClose();
    return true;
  };
}

// --- Edit permissions ------------------------------------------------------------------

/** "Edit permissions" (SRC ManageChild "Edit limits", F6): multicall detach + setText, agent address rewritten. */
export function EditLimitsDialog({ open, node, onClose }: DialogProps) {
  return (
    <Dialog id="liveEditLimitsDialog" open={open} onClose={onClose}>
      {open && <EditLimitsForm node={node} onClose={onClose} />}
    </Dialog>
  );
}

function EditLimitsForm({ node, onClose }: { node: RelayNode; onClose: () => void }) {
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const after = useAfterWrite(node, onClose);
  const chain = useRelayLevels(node.name);
  const [draft, setDraft] = useState<BundleDraft | null>(null);
  // Blockchain grant (relay.chain), edited only once the tree has read this name's record.
  const live = useLive();
  const recipients = useChainStatus().data?.recipients ?? {};
  const [chainDraft, setChainDraft] = useState<ChainDraft | null>(null);
  const lineage = node.name ? lineageOf(live.nodes, node.name).map((l) => ({ name: l.name, chain: live.nodes.find((n) => n.name === l.name)?.chain })) : [];
  const currentChain = lineage[lineage.length - 1]?.chain;
  const chainKnown = lineage.length > 0 && currentChain !== undefined;
  const chainOriginal = readGrant(currentChain);
  const chainValue = chainDraft ?? draftFromGrant(chainOriginal, nowSec());
  const chainParsed = grantFromDraft(chainValue, nowSec(), chainOriginal);

  const current = node.bundle?.bundle ?? null;
  const linkedPlan = node.bundle?.plan ?? null;
  // Every level above this name, company first: the editor won't offer more than they allow.
  const above = chain.levels ? chain.levels.slice(0, -1) : undefined;
  const parentLevel = above?.[above.length - 1];
  const parentBundle = parentLevel?.bundle ?? null;
  const value = draft ?? draftFromBundle(current ?? defaultBundle(parentBundle, node.kind === "agent" ? "total" : "month", above));
  const parsed = bundleFromDraft(value);

  // Writes must not depend on a read that is still loading or failed.
  const readError = node.bundleError ?? node.kindError;
  const reading = !readError && (node.bundleLoading || node.kind === null);
  const readOk = !readError && !reading;
  const { canDetach, stuckOnPlan } = editRules({ canLink: node.canLink, canSetAddress: node.canSetAddress, kind: node.kind, readOk, linkedPlan });

  const save = async () => {
    if (!node.resolver || !node.name || !parsed.bundle || !readOk || stuckOnPlan || chainParsed.error) return;
    const calls = bundleCalls(node.name, parsed.bundle, {
      // Always detach first (whatever the read said): if the name shares a plan's record,
      // setText would otherwise change the limits of everyone on the plan.
      unlink: canDetach,
      // Detaching starts a fresh record, so an agent's address is written again.
      agent: canDetach && node.kind === "agent" && node.owner ? node.owner : undefined,
    });
    // The chain grant rides in the same multicall: edited → the new text; untouched → rewritten as
    // is after a detach (a fresh record would otherwise drop it).
    const chainText = chainDraft ? (chainParsed.grant ? serializeGrant(chainParsed.grant) : null) : (currentChain ?? null);
    if (chainKnown && (chainDraft || (canDetach && currentChain))) {
      for (const [key, value] of chainRecords(chainText)) calls.push(encodeSetText(node.name, key, value));
    }
    const r = await tx.run(() =>
      mutateAsync({ address: node.resolver!, abi: PermissionedResolverImplAbi, functionName: "multicall", args: [calls], chainId: CHAIN_ID }),
    );
    await after(r, "Limits saved on Sepolia.", "Limits saved", `${node.name}: ${describeListed(parsed.bundle)}`);
  };

  return (
    <form onSubmit={prevent}>
      <DialogHead title="Edit permissions" onClose={onClose}>
        What {node.name} may use. It can never get more than the levels above allow.
      </DialogHead>
      {readError ? (
        <div className="form-hint">Couldn&apos;t read the current limits of {node.name}, so saving is turned off. Refresh and try again.</div>
      ) : reading ? (
        <div className="form-hint">Reading the current limits…</div>
      ) : null}
      {linkedPlan && (
        <div className="form-hint">
          {node.name} uses plan {planLabel(linkedPlan)}.{" "}
          {canDetach ? "Saving here gives it its own limits instead." : "This wallet can't take it off the plan, so saving here is turned off."}
        </div>
      )}
      <BundleEditor
        value={value}
        onChange={setDraft}
        parent={parentBundle}
        parentName={parentLevel?.name ?? node.parent}
        above={chain.levels ? above : chain.error ? undefined : null}
        chain={chainKnown ? { value: chainValue, onChange: setChainDraft, above: lineage.length > 1 ? pathGrant(lineage.slice(0, -1), recipients) : undefined, recipients } : undefined}
      />
      <p className="form-error" role="alert">
        {parsed.error ?? chainParsed.error}
      </p>
      <TxStatus tx={tx} showEvents={false} />
      <div className="dialog-footer">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <TxButton tx={tx} variant="primary" onClick={save} disabled={!parsed.bundle || !readOk || stuckOnPlan || !!chainParsed.error}>
          Save limits
        </TxButton>
      </div>
    </form>
  );
}

// --- Change a cap (delegated) ----------------------------------------------------------

/** "Change a cap" (SRC ManageChild delegated caps, F9): setText relay.cap.<api> with a key-scoped role. */
export function CapDialog({ open, node, onClose }: DialogProps) {
  return (
    <Dialog id="liveCapDialog" open={open} onClose={onClose}>
      {open && <CapForm node={node} onClose={onClose} />}
    </Dialog>
  );
}

function CapForm({ node, onClose }: { node: RelayNode; onClose: () => void }) {
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const after = useAfterWrite(node, onClose);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const current = node.bundle?.bundle ?? null;
  const linkedPlan = node.bundle?.plan ?? null;
  const readError = node.bundleError ?? node.kindError;
  const readOk = !readError && !node.bundleLoading && node.kind !== null;

  const save = async (provider: string) => {
    if (!node.resolver || !node.name) return;
    const v = (inputs[provider] ?? "").trim();
    const r = await tx.run(() =>
      mutateAsync({
        address: node.resolver!,
        abi: PermissionedResolverImplAbi,
        functionName: "setText",
        args: [dnsEncode(node.name!), RECORD_KEYS.cap(provider), v],
        chainId: CHAIN_ID,
      }),
    );
    await after(r, "Cap saved on Sepolia.", "Cap changed", `${node.name}: ${providerLabel(provider)} ${v ? `$${v}` : "no cap"}`);
  };

  return (
    <form onSubmit={prevent}>
      <DialogHead title="Change a cap" onClose={onClose}>
        These caps were delegated to you. Leave one empty for no cap at this level.
      </DialogHead>
      {readError && <div className="form-hint">Couldn&apos;t read the current limits of {node.name}, so saving is turned off.</div>}
      {node.isRoot && <div className="form-hint">This is the company-wide cap: nobody under {node.name} can spend more.</div>}
      {linkedPlan && <div className="form-hint">This name uses plan {planLabel(linkedPlan)}: the change applies to everyone on that plan.</div>}
      {node.delegatedCaps.map((p) => {
        const v = inputs[p] ?? (current?.caps[p] !== undefined ? String(current.caps[p]) : "");
        return (
          <div key={p} className="live-member-cap">
            <label>
              {providerLabel(p)} cap (USD)
              <input value={v} onChange={(e) => setInputs({ ...inputs, [p]: e.target.value })} placeholder="no cap" inputMode="decimal" />
            </label>
            <TxButton tx={tx} variant="secondary" onClick={() => save(p)} disabled={!capValid(v) || inputs[p] === undefined || !readOk}>
              Save
            </TxButton>
          </div>
        );
      })}
      <TxStatus tx={tx} showEvents={false} />
      <div className="dialog-footer">
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </form>
  );
}

// --- Use a plan ------------------------------------------------------------------------

/** "Use a plan" (SRC ManageChild, F8): linkToNode(name → plan record). */
export function PlanDialog({ open, node, onClose }: DialogProps) {
  return (
    <Dialog id="livePlanDialog" open={open} onClose={onClose}>
      {open && <PlanForm node={node} onClose={onClose} />}
    </Dialog>
  );
}

function PlanForm({ node, onClose }: { node: RelayNode; onClose: () => void }) {
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const after = useAfterWrite(node, onClose);
  const [plan, setPlan] = useState("");
  const plans = usePlansUnder(node.resolver, node.parent);
  const linkedPlan = node.bundle?.plan ?? null;
  const planRecord = useReadContract({
    address: node.resolver ?? undefined,
    abi: PermissionedResolverImplAbi,
    functionName: "getRecordId",
    args: [namehash(plan || "0")],
    chainId: CHAIN_ID,
    query: { enabled: !!node.resolver && !!plan },
  });
  const empty = !!plan && planRecord.data === 0n;

  const apply = async () => {
    if (!node.resolver || !node.name || !plan) return;
    const r = await tx.run(() =>
      mutateAsync({
        address: node.resolver!,
        abi: PermissionedResolverImplAbi,
        functionName: "linkToNode",
        args: [dnsEncode(node.name!), namehash(plan)],
        chainId: CHAIN_ID,
      }),
    );
    await after(r, "Plan linked on Sepolia.", "Plan linked", `${node.name} → plan ${planLabel(plan)}`);
  };

  return (
    <form onSubmit={prevent}>
      <DialogHead title="Use a plan" onClose={onClose}>
        {node.name} shares the plan&apos;s limits. Changing the plan changes everyone on it.
      </DialogHead>
      {plans.length === 0 ? (
        <div className="form-hint">No plans yet for names under {node.parent}. Create one in Policies.</div>
      ) : (
        <label>
          Plan
          <select value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="">Pick a plan</option>
            {plans.map((p) => (
              <option key={p} value={p}>
                {planLabel(p)}
                {p === linkedPlan ? " (current)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {empty && <div className="form-hint">That plan has no limits written yet.</div>}
      <TxStatus tx={tx} showEvents={false} />
      <div className="dialog-footer">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <TxButton tx={tx} variant="primary" onClick={apply} disabled={!plan || planRecord.data === 0n || plan === linkedPlan}>
          Use this plan
        </TxButton>
      </div>
    </form>
  );
}

// --- Extend / Bring back ---------------------------------------------------------------

/** "Extend" / "Bring back" (SRC ManageChild, F6): renew(labelId, max(now, expiry) + EXTEND_BY). */
export function ExtendDialog({ open, node, onClose }: DialogProps) {
  return (
    <Dialog id="liveExtendDialog" open={open} onClose={onClose}>
      {open && <ExtendForm node={node} onClose={onClose} />}
    </Dialog>
  );
}

function ExtendForm({ node, onClose }: { node: RelayNode; onClose: () => void }) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const after = useAfterWrite(node, onClose);
  const [by, setBy] = useState<string>(String(EXTEND_BY[0].seconds));
  // Rendered only while the dialog is open (client-side), so reading the clock here is hydration-safe.
  const preview = extendedExpiry(nowSec(), node.expiry, Number(by));

  const extend = async () => {
    if (!node.registry || !client) return;
    const expiry = extendedExpiry(await chainNow(client), node.expiry, Number(by));
    const r = await tx.run(() =>
      mutateAsync({
        address: node.registry!,
        abi: UserRegistryImplAbi,
        functionName: "renew",
        args: [labelId(node.label), BigInt(expiry)],
        chainId: CHAIN_ID,
      }),
    );
    await after(r, node.expired ? `${node.name} is back.` : "Extended on Sepolia.", node.expired ? "Name brought back" : "Name extended", `${node.name} until ${formatDate(expiry)}`);
  };

  return (
    <form onSubmit={prevent}>
      <DialogHead title={node.expired ? "Bring back" : "Extend"} onClose={onClose}>
        {node.expired ? `${node.name} has ended. Renewing brings it back with the same owner and limits.` : `${node.name} ends ${node.expiry ? formatDate(node.expiry) : "—"}.`}
      </DialogHead>
      <label>
        Add
        <select value={by} onChange={(e) => setBy(e.target.value)}>
          {EXTEND_BY.map((d) => (
            <option key={d.seconds} value={d.seconds}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <div className="form-hint">New end: {formatDate(preview)}. One wallet confirmation.</div>
      <TxStatus tx={tx} showEvents={false} />
      <div className="dialog-footer">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <TxButton tx={tx} variant="primary" onClick={extend}>
          Extend to {formatDate(preview)}
        </TxButton>
      </div>
    </form>
  );
}

// --- Remove ----------------------------------------------------------------------------

/** "Remove name & descendants" (SRC ManageChild remove, F6): unregister(labelId). Opening the dialog is the first confirm. */
export function RemoveDialog({ open, node, onClose }: DialogProps) {
  return (
    <Dialog id="liveRemoveDialog" open={open} onClose={onClose}>
      {open && <RemoveForm node={node} onClose={onClose} />}
    </Dialog>
  );
}

function RemoveForm({ node, onClose }: { node: RelayNode; onClose: () => void }) {
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const after = useAfterWrite(node, onClose);

  const remove = async () => {
    if (!node.registry) return;
    const r = await tx.run(() =>
      mutateAsync({ address: node.registry!, abi: UserRegistryImplAbi, functionName: "unregister", args: [labelId(node.label)], chainId: CHAIN_ID }),
    );
    await after(r, `Removed ${node.name}.`, "Name removed", `${node.name} and everything under it`);
  };

  return (
    <form onSubmit={prevent}>
      <DialogHead title="Remove access?" onClose={onClose} />
      <p>{node.name} stops working right away, and so does every name and agent under it.</p>
      <div className="form-hint">One wallet confirmation on Sepolia. The level above can add it again later.</div>
      <TxStatus tx={tx} showEvents={false} />
      <div className="dialog-footer">
        <button type="button" className="secondary" onClick={onClose}>
          Keep access
        </button>
        <TxButton tx={tx} variant="danger" onClick={remove}>
          Yes, remove it
        </TxButton>
      </div>
    </form>
  );
}
