"use client";

import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { type Address, isAddress, isAddressEqual, zeroAddress } from "viem";
import { useBytecode, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { Dialog } from "@/components/ui/Dialog";
import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { dnsEncode, labelId, namehash } from "@/lib/ens/names";
import { RegistryRoles } from "@/lib/ens/roles";
import { useMyResolver } from "@/lib/hooks/useMyResolver";
import { useRelayLevels } from "@/lib/hooks/useRelayLevels";
import type { RelayNode } from "@/lib/hooks/useRelayNode";
import { useTx } from "@/lib/hooks/useTx";
import {
  type BundleDraft,
  CONTRACT_OWNER_WARNING,
  MEMBER_DURATIONS,
  bundleCalls,
  bundleFromDraft,
  chainNow,
  draftFromBundle,
  emptyBundle,
  encodeSetText,
  errorText,
  funderOf,
  nowSec,
  readBundle,
  relayApi,
} from "@/lib/relay/browser";
import { chainRecords } from "@/lib/live-bundle-editor";
import { lineageOf } from "@/lib/live/view";
import { CHAIN_ID } from "@/lib/wagmi";

import { BundleEditor } from "../BundleEditor";
import { type ChainDraft, grantFromDraft, newMemberChainDraft, pathGrant, serializeGrant, withChainKey } from "../chain/grant-model";
import { useChainStatus } from "../chain/hooks";
import { useLive } from "../LiveContext";
import { Steps } from "../tx/Steps";
import { TxButton } from "../tx/TxButton";
import { TxStatus } from "../tx/TxStatus";
import { type Fund, addProblem, durationSeconds, fundText, labelBadge, memberLabel, planLabel, shortAddress } from "./logic";
import { AddressLink, DialogHead, usePlansUnder } from "./parts";

type Props = { open: boolean; parent: RelayNode; onClose: () => void };

/** "Add a member" (SRC AddMember, F5): register with ROLE_SET_SUBREGISTRY, write limits or link a plan, then fund gas. */
export function AddMemberDialog({ open, parent, onClose }: Props) {
  const [added, setAdded] = useState<string | null>(null);
  const live = useLive();
  // Show the new name once the dialog closes after a successful add.
  const close = () => {
    onClose();
    if (added) live.select(added);
    setAdded(null);
  };
  return (
    <Dialog id="liveAddMemberDialog" open={open} onClose={close}>
      {open && <AddMemberForm parent={parent} onClose={close} added={added} setAdded={setAdded} />}
    </Dialog>
  );
}

function AddMemberForm({
  parent,
  onClose,
  added,
  setAdded,
}: {
  parent: RelayNode;
  onClose: () => void;
  added: string | null;
  setAdded: (name: string | null) => void;
}) {
  const live = useLive();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync } = useWriteContract();
  const my = useMyResolver();
  const tx = useTx();
  const chain = useRelayLevels(parent.name);
  const parentName = parent.name ?? "";

  const [labelInput, setLabelInput] = useState("");
  const [ownerInput, setOwnerInput] = useState("");
  const [duration, setDuration] = useState<string>(String(MEMBER_DURATIONS[0].seconds));
  const [customDays, setCustomDays] = useState("7");
  const [plan, setPlan] = useState("");
  const [draft, setDraft] = useState<BundleDraft | null>(null);
  const [fund, setFund] = useState<Fund | null>(null);

  const myPlans = usePlansUnder(my.resolver, parentName);

  const label = memberLabel(labelInput);
  const childName = label ? `${label}.${parentName}` : null;
  const owner = isAddress(ownerInput.trim()) ? (ownerInput.trim() as Address) : null;
  const seconds = durationSeconds(duration, customDays);

  // A new member starts with nothing ticked: the admin picks what they get (SRC AddMember).
  // The levels above still hide blocked APIs and flag caps over theirs.
  const parentBundle = chain.levels ? (chain.levels[chain.levels.length - 1]?.bundle ?? null) : (parent.bundle?.bundle ?? null);
  const value = draft ?? draftFromBundle(emptyBundle("month"));
  const parsed = bundleFromDraft(value);

  // Blockchain grant (relay.chain), written with the limits: starts as what the levels above allow.
  const recipients = useChainStatus().data?.recipients ?? {};
  const [chainDraft, setChainDraft] = useState<ChainDraft | null>(null);
  const lineage = parentName ? lineageOf(live.nodes, parentName).map((l) => ({ name: l.name, chain: live.nodes.find((n) => n.name === l.name)?.chain })) : [];
  const chainAbove = lineage.length ? pathGrant(lineage, recipients) : null;
  const chainValue = chainDraft ?? newMemberChainDraft(chainAbove, nowSec());
  const chainParsed = grantFromDraft(chainValue, nowSec());
  const chainGrant = chainAbove && !chainAbove.pending ? chainParsed.grant : null;
  // A grant needs "multibaas" in relay.keys; added when the levels above allow it.
  const toWrite = parsed.bundle ? withChainKey(parsed.bundle, chainGrant, parentBundle) : null;
  const addsMultibaas = !!toWrite && !!parsed.bundle && toWrite.keys.length > parsed.bundle.keys.length;

  const state = useReadContract({
    address: parent.subregistry ?? undefined,
    abi: UserRegistryImplAbi,
    functionName: "getState",
    args: [labelId(label ?? "")],
    chainId: CHAIN_ID,
    query: { enabled: !!parent.subregistry && !!label },
  });
  const childBundle = useQuery({
    queryKey: ["relay-bundle", my.resolver, childName],
    queryFn: () => readBundle(client!, my.resolver!, childName!),
    enabled: !!client && my.deployed && !!childName,
  });
  const planRecord = useReadContract({
    address: my.resolver,
    abi: PermissionedResolverImplAbi,
    functionName: "getRecordId",
    args: [namehash(plan || "0")],
    chainId: CHAIN_ID,
    query: { enabled: my.deployed && !!plan },
  });
  const ownerCode = useBytecode({ address: owner ?? undefined, chainId: CHAIN_ID, query: { enabled: !!owner } });
  const ownerIsContract = !!ownerCode.data && ownerCode.data !== "0x";

  const s = state.data;
  const registered = s?.status === 2;
  const takenByOther = registered && (!owner || !isAddressEqual(s.latestOwner, owner));
  const hasBundle = !!childBundle.data?.bundle;
  const planMissing = !!plan && planRecord.data === 0n;
  const funder = funderOf(live.status);

  const problem = addProblem({
    labelInput,
    label,
    ownerInput,
    owner,
    seconds,
    takenByOther,
    childName,
    plan,
    bundleError: parsed.error,
    planMissing,
  });

  const register = async () => {
    const expiry = BigInt((await chainNow(client!)) + seconds);
    return tx.run(() =>
      mutateAsync({
        address: parent.subregistry!,
        abi: UserRegistryImplAbi,
        functionName: "register",
        // Members get ROLE_SET_SUBREGISTRY on their own name, so they can hang their agents under it.
        args: [label!, owner!, zeroAddress, my.resolver!, RegistryRoles.ROLE_SET_SUBREGISTRY, expiry],
        chainId: CHAIN_ID,
      }),
    );
  };

  // Plans share one record through linkToNode; otherwise the member gets its own bundle.
  const writeLimits = () =>
    tx.run(() =>
      plan
        ? mutateAsync({
            address: my.resolver!,
            abi: PermissionedResolverImplAbi,
            functionName: "linkToNode",
            args: [dnsEncode(childName!), namehash(plan)],
            chainId: CHAIN_ID,
          })
        : mutateAsync({
            address: my.resolver!,
            abi: PermissionedResolverImplAbi,
            functionName: "multicall",
            // Records outlive a removed name. Always detach first (you hold ROLE_LINK on your own
            // resolver), so these writes can't edit a plan an earlier holder was on. The chain grant
            // rides in the same multicall.
            args: [
              [
                ...bundleCalls(childName!, toWrite!, { unlink: true }),
                ...(chainGrant ? chainRecords(serializeGrant(chainGrant)).map(([key, v]) => encodeSetText(childName!, key, v)) : []),
              ],
            ],
            chainId: CHAIN_ID,
          }),
    );

  // The relay checks on-chain that the name is registered and owned by the address it pays.
  const topUp = async (name: string) => {
    setFund({ status: "sending" });
    let next: Fund;
    try {
      next = { status: "done", result: await relayApi.fund(name) };
    } catch (e) {
      next = { status: "error", message: errorText(e as Error) };
    }
    setFund(next);
    live.log("Gas top-up", `${name}: ${fundText(next)}`);
  };

  // Always writes the limits chosen here: a re-used label may still carry an old bundle.
  const add = async () => {
    if (!childName || !owner || !label || !client || !my.resolver) return;
    const name = childName;
    setFund(null);
    if (!registered && !(await register())) return;
    await state.refetch();
    if (!(await writeLimits())) return;
    setAdded(name);
    live.toast(`Added ${name} on Sepolia.`);
    live.log("Member added", `${name} → ${shortAddress(owner)}${plan ? ` · plan ${planLabel(plan)}` : ""}`);
    await Promise.all([live.refresh(), topUp(name)]);
  };

  const reset = () => {
    setLabelInput("");
    setOwnerInput("");
    setDraft(null);
    setPlan("");
    setAdded(null);
    setFund(null);
    tx.reset();
  };

  const submit = (e: FormEvent) => e.preventDefault();

  if (!my.deployed) {
    const deploy = async () => {
      await my.deploy();
      await live.refresh();
    };
    return (
      <form onSubmit={submit}>
        <DialogHead title="Add a member" onClose={onClose}>
          New names keep their limits on your resolver. Deploy it first.
        </DialogHead>
        <div className="form-hint">{my.loading ? "Checking for your resolver…" : "One wallet confirmation. You do this once per wallet."}</div>
        <TxStatus tx={my.tx} showEvents={false} />
        <div className="dialog-footer">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <TxButton tx={my.tx} variant="primary" onClick={deploy} disabled={my.loading}>
            Deploy my resolver
          </TxButton>
        </div>
      </form>
    );
  }

  if (added) {
    return (
      <form onSubmit={submit}>
        <DialogHead title={`Added ${added.split(".")[0]}`} onClose={onClose}>
          {added} can now create their agents under it.
        </DialogHead>
        {fund && <div className="form-hint">{fundText(fund)}</div>}
        <TxStatus tx={tx} showEvents={false} />
        <div className="dialog-footer">
          <button type="button" className="secondary" onClick={reset}>
            Add another
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Show {added.split(".")[0]}
          </button>
        </div>
      </form>
    );
  }

  const badge = label && s ? labelBadge(registered, takenByOther) : null;
  const showSteps = !!childName && !!owner && (registered || tx.state.status !== "idle");

  return (
    <form onSubmit={submit}>
      <DialogHead title="Add a member" onClose={onClose}>
        They get a name under {parentName} and can add their own agents below it.
      </DialogHead>
      <label>
        <span className="live-member-labelrow">
          ENS label
          {badge && <span className={`live-member-badge ${badge}`}>{badge}</span>}
        </span>
        <span className="live-member-name-input">
          <input value={labelInput} onChange={(e) => setLabelInput(e.target.value)} placeholder="derek" maxLength={60} autoComplete="off" />
          <span>.{parentName}</span>
        </span>
      </label>
      <label>
        Owner wallet
        <input value={ownerInput} onChange={(e) => setOwnerInput(e.target.value)} placeholder="0x… (what relay init printed)" autoComplete="off" />
        {ownerIsContract && !registered && <small className="live-member-warning">{CONTRACT_OWNER_WARNING}</small>}
      </label>
      <div className="form-row">
        <label>
          Duration
          <select value={duration} onChange={(e) => setDuration(e.target.value)}>
            {MEMBER_DURATIONS.map((d) => (
              <option key={d.seconds} value={d.seconds}>
                {d.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
        {duration === "custom" ? (
          <label>
            Days
            <input value={customDays} onChange={(e) => setCustomDays(e.target.value)} inputMode="decimal" />
          </label>
        ) : (
          myPlans.length > 0 && <PlanSelect plans={myPlans} plan={plan} setPlan={setPlan} />
        )}
      </div>
      {duration === "custom" && myPlans.length > 0 && <PlanSelect plans={myPlans} plan={plan} setPlan={setPlan} />}
      {!plan && (
        <BundleEditor
          value={value}
          onChange={setDraft}
          parent={parentBundle}
          parentName={parentName}
          above={chain.levels ?? (chain.error ? undefined : null)}
          chain={lineage.length ? { value: chainValue, onChange: setChainDraft, above: chainAbove, recipients } : undefined}
        />
      )}
      {!plan && addsMultibaas && <div className="form-hint">MultiBaas is added to their APIs so the blockchain grant can be used.</div>}
      {chain.error && (
        <div className="form-hint">Couldn&apos;t read what the levels above allow ({errorText(chain.error as Error)}). The relay still enforces them.</div>
      )}
      {showSteps && (
        <Steps
          steps={[
            {
              label: `Register ${childName}`,
              done: registered && !takenByOther,
              active: !registered,
              detail: registered ? (
                <>
                  {" "}
                  <AddressLink address={s?.latestOwner} />
                </>
              ) : undefined,
            },
            { label: plan ? "Link to the plan" : "Write their limits", done: hasBundle, active: registered },
          ]}
        />
      )}
      <div className="form-hint">
        Two wallet confirmations: register the name, then write its limits.
        {funder?.enabled ? " Then the relay sends them a little Sepolia ETH for gas." : ""}
      </div>
      <p className="form-error" role="alert">
        {problem ?? (!plan ? chainParsed.error : null)}
      </p>
      <TxStatus tx={tx} showEvents={false} />
      <div className="dialog-footer">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <TxButton tx={tx} variant="primary" onClick={add} disabled={!!problem || !label || !owner || (!plan && !!chainParsed.error)}>
          {registered && !takenByOther ? "Write their limits" : `Add ${childName ?? "member"}`}
        </TxButton>
      </div>
    </form>
  );
}

function PlanSelect({ plans, plan, setPlan }: { plans: string[]; plan: string; setPlan: (p: string) => void }) {
  return (
    <label>
      Limits
      <select value={plan} onChange={(e) => setPlan(e.target.value)}>
        <option value="">Set limits for this person</option>
        {plans.map((p) => (
          <option key={p} value={p}>
            Use plan {planLabel(p)}
          </option>
        ))}
      </select>
    </label>
  );
}
