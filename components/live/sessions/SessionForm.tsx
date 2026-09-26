"use client";

// The body of "Start an agent session" and "Create a subagent": SRC app/_components/StartSession.tsx
// in khaki. Renders as direct children of the dialog's <form> so the dialog label styles apply.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Address, isAddress, zeroAddress } from "viem";
import { useBytecode, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { labelId, tryNormalize } from "@/lib/ens/names";
import { RegistryRoles } from "@/lib/ens/roles";
import { useMyResolver } from "@/lib/hooks/useMyResolver";
import { useRelayAgentKeys } from "@/lib/hooks/useRelayAgents";
import { useRelayLevels } from "@/lib/hooks/useRelayLevels";
import { useRelayMinter } from "@/lib/hooks/useRelayMinter";
import { type Tx, useTx } from "@/lib/hooks/useTx";
import {
  AGENT_CLI,
  type BundleDraft,
  CONTRACT_OWNER_WARNING,
  DEMO_KEY_WARNING,
  SESSION_DURATIONS,
  type StoredAgentKey,
  bundleCalls,
  bundleFromDraft,
  chainNow,
  defaultBundle,
  draftFromBundle,
  formatDate,
  newAgentKey,
  readBundle,
} from "@/lib/relay/browser";
import type { Bundle } from "@/lib/relay/bundle";
import { SessionMinterAbi } from "@/lib/relay/sessionMinter";
import { shortAddress } from "@/lib/view-model";
import { CHAIN_ID } from "@/lib/wagmi";

import { BundleEditor } from "../BundleEditor";
import { useLive } from "../LiveContext";
import { type Step, Steps } from "../tx/Steps";
import { TxButton } from "../tx/TxButton";
import { TxStatus } from "../tx/TxStatus";
import { durationSeconds, isResumable, sessionExpiry, sessionLabel, sessionPath, sessionProblem } from "./logic";
import { Snippet } from "./Snippet";

type KeyMode = "generate" | "paste";

export type SessionFormProps = {
  kind: "session" | "subagent";
  parentName: string;
  parentBundle: Bundle | null;
  /** Registry the new label is registered in. */
  registry: Address | null;
  /** The registry exists on chain; false while `prepare` still has to deploy it. */
  registryLive: boolean;
  /** Unix seconds the new name may not outlive (a subagent's agent). */
  maxExpiry?: number | null;
  reserved?: readonly string[];
  /** Steps that run before registering (subagents: the agent's registry setup). */
  prepSteps?: Step[];
  prepare?: () => Promise<boolean>;
  prepTx?: Tx;
  /** A ./relay command doing the same from the agent's machine. */
  cli?: (label: string | null, bundle: Bundle | null, seconds: number) => string;
  onDone: (name: string) => void;
  onCancel: () => void;
};

export function SessionForm(props: SessionFormProps) {
  const { kind, parentName, parentBundle, registry, registryLive, maxExpiry, reserved = [], prepSteps = [], prepare, prepTx, cli, onDone, onCancel } = props;
  const live = useLive();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync } = useWriteContract();
  const my = useMyResolver();
  const agents = useRelayAgentKeys();
  const minter = useRelayMinter(registryLive ? registry : null, my.resolver ?? null);
  const tx = useTx();
  // The levels above: the parent and everything over it, company first.
  const chain = useRelayLevels(parentName);
  const above = chain.levels ?? (chain.error ? undefined : null);

  const [labelInput, setLabelInput] = useState("");
  const [keyMode, setKeyMode] = useState<KeyMode>("generate");
  const [pasted, setPasted] = useState("");
  const [duration, setDuration] = useState<string>(String(SESSION_DURATIONS[kind === "subagent" ? 0 : 1].seconds));
  const [customMinutes, setCustomMinutes] = useState(kind === "subagent" ? "20" : "30");
  const [draft, setDraft] = useState<BundleDraft | null>(null);
  const [pendingKey, setPendingKey] = useState<StoredAgentKey | null>(null);
  const [running, setRunning] = useState(false);

  const normalized = tryNormalize(labelInput);
  const label = sessionLabel(normalized, reserved);
  const childName = label ? `${label}.${parentName}` : null;
  const seconds = durationSeconds(duration, customMinutes);

  // Sessions default to a one-off budget ("total"), inside whatever the parent allows.
  const value = draft ?? draftFromBundle(defaultBundle(parentBundle, "total", above ?? undefined));
  const parsed = bundleFromDraft(value);

  const readable = !!registry && registryLive && !!label;
  const state = useReadContract({
    address: registry ?? undefined,
    abi: UserRegistryImplAbi,
    functionName: "getState",
    args: [labelId(label ?? "")],
    chainId: CHAIN_ID,
    query: { enabled: readable },
  });
  const childBundle = useQuery({
    queryKey: ["relay-bundle", my.resolver, childName],
    queryFn: () => readBundle(client!, my.resolver!, childName!),
    enabled: !!client && my.deployed && !!childName,
  });

  const s = registryLive ? state.data : undefined;
  const registered = s?.status === 2;
  const pastedOk = isAddress(pasted);

  const ownerIsMember = useReadContract({
    address: registry ?? undefined,
    abi: UserRegistryImplAbi,
    functionName: "hasRoles",
    args: [labelId(label ?? ""), RegistryRoles.ROLE_SET_SUBREGISTRY, s?.latestOwner ?? zeroAddress],
    chainId: CHAIN_ID,
    query: { enabled: readable && registered },
  });
  const pastedCode = useBytecode({ address: pastedOk ? (pasted as Address) : undefined, chainId: CHAIN_ID, query: { enabled: pastedOk } });
  const pastedIsContract = !!pastedCode.data && pastedCode.data !== "0x";

  const resumeKey = registered ? s.latestOwner : null;
  const checking = (readable && state.isLoading) || (registered && (childBundle.isLoading || ownerIsMember.isLoading));
  const resumable = isResumable({
    registered,
    bundleRead: childBundle.isSuccess,
    hasBundle: !!childBundle.data?.bundle,
    onPlan: !!childBundle.data?.plan,
    ownerIsMember: ownerIsMember.data,
    ownerKeyHere: !!agents.find(resumeKey),
  });
  const path = sessionPath({
    minterReady: minter.ready,
    registryLive,
    registered,
    bundleRead: childBundle.isSuccess,
    onPlan: !!childBundle.data?.plan,
  });
  const oneTx = path === "one-tx";

  const problem = sessionProblem({
    labelInput,
    label,
    reserved: !!normalized && reserved.includes(normalized),
    childName,
    checking,
    registered,
    readFailed: childBundle.isError,
    resumable,
    seconds,
    pasteMode: keyMode === "paste",
    pastedOk,
    pasted,
    bundleError: parsed.error,
  });

  const noun = kind === "subagent" ? "subagent" : "session";

  const start = async () => {
    if (!label || !childName || !parsed.bundle || !my.resolver || !registry || !client) return;
    setRunning(true);
    try {
      let agent: Address;
      if (resumeKey) agent = resumeKey;
      else if (keyMode === "paste") agent = pasted as Address;
      else {
        // Saved before any transaction, so a reload never loses a key that may end up owning a name.
        const key = pendingKey?.name === childName ? pendingKey : newAgentKey(childName);
        if (key !== pendingKey) {
          setPendingKey(key);
          agents.add(key);
        }
        agent = key.address;
      }
      if (prepare && !(await prepare())) return;
      const expiry = BigInt(sessionExpiry(await chainNow(client), seconds, maxExpiry));

      if (oneTx) {
        const calls = bundleCalls(childName, parsed.bundle, { agent });
        const r = await tx.run(() =>
          mutateAsync({
            address: minter.minter!,
            abi: SessionMinterAbi,
            functionName: "startSession",
            args: [registry, my.resolver!, label, agent, expiry, calls],
            chainId: CHAIN_ID,
          }),
        );
        if (!r) return;
      } else {
        if (!registered) {
          const r = await tx.run(() =>
            mutateAsync({
              address: registry,
              abi: UserRegistryImplAbi,
              functionName: "register",
              // Agents get no roles on their own name: they can't re-point, transfer or extend it.
              args: [label, agent, zeroAddress, my.resolver!, 0n, expiry],
              chainId: CHAIN_ID,
            }),
          );
          if (!r) return;
          await state.refetch();
        }
        // Always detach first (you hold ROLE_LINK on your own resolver): a re-used label's old
        // record may be a plan's shared record, and the read that says otherwise may have failed.
        const calls = bundleCalls(childName, parsed.bundle, { agent, unlink: true });
        const r = await tx.run(() =>
          mutateAsync({ address: my.resolver!, abi: PermissionedResolverImplAbi, functionName: "multicall", args: [calls], chainId: CHAIN_ID }),
        );
        if (!r) return;
      }
      setPendingKey(null);
      await live.refresh();
      live.log(kind === "subagent" ? "Subagent created" : "Agent session started", `${childName} · ends ${formatDate(Number(expiry))}`);
      live.toast(`${childName} is live on Sepolia.`);
      onDone(childName);
    } finally {
      setRunning(false);
    }
  };

  if (!my.deployed && my.loading && live.address) return <p className="form-hint">Checking your resolver…</p>;
  if (!my.deployed) {
    return (
      <>
        <p className="form-hint">Agent limits live on your own resolver. Deploy it first (one transaction).</p>
        <TxStatus tx={my.tx} />
        <div className="dialog-footer">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <TxButton tx={my.tx} variant="primary" onClick={() => void my.deploy().then(() => live.refresh())} disabled={my.loading}>
            Deploy my resolver
          </TxButton>
        </div>
      </>
    );
  }

  const badge = !label || (!s && registryLive) ? null : checking ? "checking…" : registered && !resumable ? "taken" : registered ? "half done" : "free";
  const steps: Step[] = [
    ...prepSteps,
    ...(oneTx
      ? [{ label: `Start ${childName ?? noun} in one transaction`, done: false, active: true }]
      : [
          { label: `Register ${childName ?? noun} to the agent key`, done: registered, active: !registered && prepSteps.every((p) => p.done) },
          { label: "Write its limits and address", done: !!childBundle.data?.bundle, active: registered },
        ]),
  ];
  const showSteps = prepSteps.some((p) => !p.done) || registered || tx.state.status !== "idle";

  return (
    <>
      <div className="form-row live-session-row">
        <label>
          {kind === "subagent" ? "Subagent label" : "Session label"}
          <span className="live-session-name">
            <input value={labelInput} onChange={(e) => setLabelInput(e.target.value)} placeholder={kind === "subagent" ? "research" : "laptop"} maxLength={40} />
            <small>.{parentName}</small>
          </span>
          {badge && <span className={`live-session-badge ${badge === "taken" ? "is-bad" : badge === "free" ? "is-good" : ""}`}>{badge}</span>}
        </label>
        <label>
          Ends after
          <select value={duration} onChange={(e) => setDuration(e.target.value)}>
            {SESSION_DURATIONS.map((d) => (
              <option key={d.seconds} value={d.seconds}>
                {d.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
      </div>
      {duration === "custom" && (
        <label>
          Minutes
          <input value={customMinutes} onChange={(e) => setCustomMinutes(e.target.value)} inputMode="numeric" />
        </label>
      )}
      {maxExpiry ? <p className="form-hint">A subagent never outlives its agent: it ends by {formatDate(maxExpiry)} at the latest.</p> : null}

      {resumable && resumeKey ? (
        <p className="form-hint">
          This {noun} was registered to <b title={resumeKey}>{shortAddress(resumeKey)}</b> but its limits were never written. Finish it below.
        </p>
      ) : (
        <fieldset className="live-session-keys">
          <legend>Agent key</legend>
          <label className="live-session-radio">
            <input type="radio" name="keyMode" checked={keyMode === "generate"} onChange={() => setKeyMode("generate")} />
            <span>
              Generate a key in this browser <small>({DEMO_KEY_WARNING})</small>
            </span>
          </label>
          <label className="live-session-radio">
            <input type="radio" name="keyMode" checked={keyMode === "paste"} onChange={() => setKeyMode("paste")} />
            <span>Use the agent&apos;s own key (paste its address; the agent signs its own tokens)</span>
          </label>
          {keyMode === "paste" && (
            <div className="live-session-paste">
              <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="0x… agent address" aria-label="Agent address" />
              {pastedIsContract && <p className="form-hint">{CONTRACT_OWNER_WARNING}</p>}
              <Snippet label="On the agent's machine, first (prints the address to paste here)" text={AGENT_CLI.newKey} />
              <Snippet
                label="Then, once it has started (sets up Claude Code and Codex to go through the relay)"
                text={AGENT_CLI.env(childName ?? `<name>.${parentName}`, live.status?.baseUrl)}
              />
            </div>
          )}
        </fieldset>
      )}

      <BundleEditor value={value} onChange={setDraft} parent={parentBundle} parentName={parentName} above={above} fixedPeriod />

      {showSteps && <Steps steps={steps} />}
      <p className="form-hint">
        {prepSteps.some((p) => !p.done)
          ? "A few wallet confirmations: set up names below the agent, then register the subagent and write its limits."
          : oneTx
            ? "One wallet confirmation (Session Minter is enabled for your names)."
            : `Two wallet confirmations: register the name, then write its limits.${kind === "session" ? " Enable the Session Minter in Setup to make it one." : ""}`}
      </p>
      {cli && (
        <details className="live-session-cli">
          <summary>Or from the agent&apos;s machine</summary>
          <Snippet text={cli(label, parsed.bundle, seconds)} />
        </details>
      )}
      <p className="form-error" role="alert">
        {problem}
      </p>
      {prepTx && <TxStatus tx={prepTx} />}
      <TxStatus tx={tx} />
      <div className="dialog-footer">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <TxButton tx={tx} variant="primary" onClick={() => void start()} disabled={!!problem || !label || checking || running || !!prepTx?.busy}>
          {resumable ? `Finish the ${noun}` : `Start ${childName ?? noun}`}
        </TxButton>
      </div>
    </>
  );
}
