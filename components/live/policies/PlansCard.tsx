"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import type { Address } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";

import { Dialog } from "@/components/ui/Dialog";
import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { useLocalJson } from "@/lib/hooks/useLocalJson";
import type { useMyResolver } from "@/lib/hooks/useMyResolver";
import { useRelayLevels } from "@/lib/hooks/useRelayLevels";
import type { RelayNode } from "@/lib/hooks/useRelayNode";
import { type Tx, useTx } from "@/lib/hooks/useTx";
import {
  type BundleDraft,
  bundleCalls,
  bundleFromDraft,
  defaultBundle,
  draftFromBundle,
  plansStorageKey,
  readBundle,
} from "@/lib/relay/browser";
import { describeListed } from "@/lib/relay/bundle";
import { CHAIN_ID } from "@/lib/wagmi";

import { BundleEditor } from "../BundleEditor";
import { useLive } from "../LiveContext";
import { TxButton } from "../tx/TxButton";
import { TxStatus } from "../tx/TxStatus";
import { DeployResolver } from "./DeployResolver";
import { parsePlanSlug, planSlugOf, planTarget, plansUnder, withPlan } from "./policy-logic";

const NO_PLANS: string[] = [];

type MyResolver = ReturnType<typeof useMyResolver>;
/** undefined = dialog closed; "" = new plan; otherwise the slug being edited. */
type PlanRequest = string | undefined;

/**
 * SRC Plans (F11). A plan is a bundle written once for a placeholder name (plan-<slug>.<you>) on
 * your resolver. Members linked to it share that one record, so editing the plan changes everyone
 * on it at once. Linking happens where a member is managed ("Use a plan", or Limits in Add a member).
 */
export function PlansCard({ myNode, my }: { myNode: RelayNode | null; my: MyResolver }) {
  const { address } = useLive();
  const tx = useTx();
  const [plans, setPlans] = useLocalJson<string[]>(my.resolver ? plansStorageKey(my.resolver) : null, NO_PLANS);
  const [request, setRequest] = useState<PlanRequest>(undefined);

  const parent = myNode?.name ?? null;
  const myPlans = plansUnder(plans, parent);

  return (
    <article className="provider-card live-policy-card">
      <span className="status-pill">Plans</span>
      <h2>{parent ? "Plans for your people" : "Plans"}</h2>
      {parent && <div className="full-name">Under {parent}</div>}
      <p>Reusable limits: change a plan once and everyone on it follows.</p>

      {!address ? (
        <p className="form-hint">Connect a wallet.</p>
      ) : !myNode || !parent ? (
        <p className="form-hint">Plans are for names you own with people under them. Finish company setup, or select such a name in the tree.</p>
      ) : !my.deployed ? (
        <DeployResolver my={my} reason="Plans live on your resolver. Deploy it first." />
      ) : (
        <>
          {myPlans.length > 0 ? (
            <ul className="live-plan-list">
              {myPlans.map((plan) => (
                <PlanRow key={plan} plan={plan} resolver={my.resolver!} onEdit={() => setRequest(planSlugOf(plan))} />
              ))}
            </ul>
          ) : (
            <p className="live-policy-empty">No plans saved in this browser yet.</p>
          )}
          <div className="live-policy-actions">
            <button type="button" className="primary" onClick={() => setRequest("")}>
              New plan
            </button>
          </div>
          <p className="form-hint">
            To put someone on a plan, select them in the team tree and use &quot;Use a plan&quot;. For plans under another name you own,
            select that name in the tree.
          </p>
          <TxStatus tx={tx} />
          <Dialog id="livePlanDialog" open={request !== undefined} onClose={() => setRequest(undefined)}>
            {request !== undefined && (
              <PlanForm
                key={request}
                initialSlug={request}
                myNode={myNode}
                parent={parent}
                resolver={my.resolver!}
                tx={tx}
                onSaved={(target) => {
                  setPlans(withPlan(plans, target));
                  setRequest(undefined);
                }}
                onClose={() => setRequest(undefined)}
              />
            )}
          </Dialog>
        </>
      )}
    </article>
  );
}

type PlanFormProps = {
  initialSlug: string;
  myNode: RelayNode;
  parent: string;
  resolver: Address;
  tx: Tx;
  onSaved: (target: string) => void;
  onClose: () => void;
};

function PlanForm({ initialSlug, myNode, parent, resolver, tx, onSaved, onClose }: PlanFormProps) {
  const { refresh, log, toast } = useLive();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const { mutateAsync } = useWriteContract();
  const [slugInput, setSlugInput] = useState(initialSlug);
  const [draft, setDraft] = useState<BundleDraft | null>(null);

  // A plan is for names under `parent`, so every level down to `parent` bounds it.
  const chain = useRelayLevels(parent);
  const above = chain.levels ?? (chain.error ? undefined : null);
  const slug = parsePlanSlug(slugInput);
  const target = planTarget(slugInput, parent);

  const existing = useQuery({
    queryKey: ["relay-bundle", resolver, target],
    queryFn: () => readBundle(client!, resolver, target!),
    enabled: !!client && !!target,
  });
  const value = draft ?? draftFromBundle(existing.data?.bundle ?? defaultBundle(myNode.bundle?.bundle ?? null, "month", above ?? undefined));
  const parsed = bundleFromDraft(value);
  const updating = !!existing.data?.bundle;

  const save = async () => {
    if (!target || !parsed.bundle) return;
    const r = await tx.run(() =>
      mutateAsync({
        address: resolver,
        abi: PermissionedResolverImplAbi,
        functionName: "multicall",
        args: [bundleCalls(target, parsed.bundle!, { plan: target })],
        chainId: CHAIN_ID,
      }),
    );
    if (!r) return;
    onSaved(target);
    await queryClient.invalidateQueries({ queryKey: ["relay-bundle", resolver] });
    await refresh();
    log(updating ? "Plan updated" : "Plan created", `${target} · ${describeListed(parsed.bundle)}`);
    toast(updating ? "Plan updated on Sepolia." : "Plan saved on Sepolia.");
  };

  const submit = (event: FormEvent<HTMLFormElement>) => event.preventDefault();

  return (
    <form id="livePlanForm" onSubmit={submit}>
      <div className="dialog-heading">
        <h2>{initialSlug ? "Edit plan" : "New plan"}</h2>
        <button type="button" className="icon-button close-dialog" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="dialog-description">
        Limits for people under {parent}. Everyone on the plan follows changes at once. Written to your resolver on Sepolia.
      </p>
      <label>
        Plan name
        <input
          value={slugInput}
          placeholder="standard"
          maxLength={40}
          onChange={(event) => {
            setSlugInput(event.target.value);
            setDraft(null);
          }}
        />
        <small>{target ? `Stored as ${target}` : "Letters, numbers and dashes"}</small>
      </label>
      <BundleEditor value={value} onChange={setDraft} parent={myNode.bundle?.bundle ?? null} parentName={parent} above={above} />
      {existing.isLoading && target && <p className="form-hint">Reading the saved plan…</p>}
      {(slug.error ?? parsed.error) && <p className="form-error">{slug.error ?? parsed.error}</p>}
      <TxStatus tx={tx} />
      <div className="dialog-footer">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <TxButton tx={tx} variant="primary" onClick={save} disabled={!target || !parsed.bundle}>
          {updating ? "Update plan" : "Create plan"}
        </TxButton>
      </div>
    </form>
  );
}

function PlanRow({ plan, resolver, onEdit }: { plan: string; resolver: Address; onEdit: () => void }) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const read = useQuery({
    queryKey: ["relay-bundle", resolver, plan],
    queryFn: () => readBundle(client!, resolver, plan),
    enabled: !!client,
  });
  return (
    <li className="live-plan-row">
      <span>
        <b>{planSlugOf(plan)}</b>
        <small>{read.isLoading ? "…" : read.error ? "Couldn't read this plan." : describeListed(read.data?.bundle ?? null)}</small>
      </span>
      <button type="button" className="secondary" onClick={onEdit}>
        Edit
      </button>
    </li>
  );
}
