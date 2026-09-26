"use client";

import { type FormEvent, useState } from "react";
import { type Address, encodeFunctionData } from "viem";
import { useReadContract, useWriteContract } from "wagmi";

import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { textKeyResource } from "@/lib/ens/access";
import { ResolverRoles } from "@/lib/ens/roles";
import type { useMyResolver } from "@/lib/hooks/useMyResolver";
import type { RelayNode } from "@/lib/hooks/useRelayNode";
import { useTx } from "@/lib/hooks/useTx";
import { RECORD_KEYS } from "@/lib/relay/bundle";
import { CHAIN_ID } from "@/lib/wagmi";

import { useLive } from "../LiveContext";
import { TxButton } from "../tx/TxButton";
import { TxStatus } from "../tx/TxStatus";
import { DeployResolver } from "./DeployResolver";
import { DELEGATABLE, canSetText, coversCompany, delegateHowTo, delegateScope, parseDelegate } from "./policy-logic";

type MyResolver = ReturnType<typeof useMyResolver>;

/**
 * SRC Delegates (F12). Per-key delegation on the wallet's resolver: the delegate may change one cap
 * record and nothing else. grantRoles is disabled on PermissionedResolver; grantSetterRoles derives
 * the key's resource from an encoded setter call. The grant covers that key on every name the
 * resolver serves: the names you added, your plans, and the company's own limits if they live there too.
 */
export function DelegatesCard({ myNode, my, companyResolver }: { myNode: RelayNode | null; my: MyResolver; companyResolver: Address | null }) {
  const { address, refresh, log, toast } = useLive();
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const [who, setWho] = useState("");
  const [provider, setProvider] = useState<string>(DELEGATABLE[0]?.id ?? "");

  const account = parseDelegate(who);
  const company = coversCompany(companyResolver, my.resolver);
  const key = RECORD_KEYS.cap(provider);
  const resource = textKeyResource(key);
  const label = DELEGATABLE.find((p) => p.id === provider)?.label ?? provider;

  const roles = useReadContract({
    address: my.resolver,
    abi: PermissionedResolverImplAbi,
    functionName: "roles",
    args: [resource, account!],
    chainId: CHAIN_ID,
    query: { enabled: my.deployed && !!account },
  });
  const has = canSetText(roles.data);

  const after = async (title: string, message: string) => {
    await roles.refetch();
    await refresh();
    log(title, `${account} · the ${label} cap`);
    toast(message);
  };

  const grant = async () => {
    if (!my.resolver || !account) return;
    // Only the selector and the key matter; name and value are placeholders.
    const setter = encodeFunctionData({ abi: PermissionedResolverImplAbi, functionName: "setText", args: ["0x00", key, ""] });
    const r = await tx.run(() =>
      mutateAsync({ address: my.resolver!, abi: PermissionedResolverImplAbi, functionName: "grantSetterRoles", args: [setter, account], chainId: CHAIN_ID }),
    );
    if (r) await after("Delegate allowed", `They can change the ${label} cap now.`);
  };

  const revoke = async () => {
    if (!my.resolver || !account) return;
    const r = await tx.run(() =>
      mutateAsync({
        address: my.resolver!,
        abi: PermissionedResolverImplAbi,
        functionName: "revokeRoles",
        args: [resource, ResolverRoles.ROLE_SET_TEXT, account],
        chainId: CHAIN_ID,
      }),
    );
    if (r) await after("Delegate removed", `Taken back. They can't change the ${label} cap.`);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => event.preventDefault();

  return (
    <article className="provider-card live-policy-card">
      <span className="status-pill">Delegates</span>
      <h2>Delegates</h2>
      <p>Let someone (say, finance) change one spending cap without being able to change anything else.</p>

      {!address ? (
        <p className="form-hint">Connect a wallet.</p>
      ) : !myNode ? (
        <p className="form-hint">
          For a name you own with people under it: select it in the team tree. If someone gave you a cap to manage, select that name in the
          team tree and use &quot;Change a cap&quot;.
        </p>
      ) : !my.deployed ? (
        <DeployResolver my={my} reason={`The limits of names under ${myNode.name} live on your resolver. Deploy it first.`} />
      ) : DELEGATABLE.length === 0 ? (
        <p className="form-hint">No API in the catalog has a dollar cap to delegate.</p>
      ) : (
        <form className="live-delegate-form" onSubmit={submit}>
          <p className="inherited-note">{delegateScope(company)}</p>
          <div className="form-row">
            <label>
              Their address
              <input value={who} placeholder="0x…" spellCheck={false} autoComplete="off" onChange={(event) => setWho(event.target.value)} />
            </label>
            <label>
              May change
              <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                {DELEGATABLE.map((p) => (
                  <option key={p.id} value={p.id}>
                    the {p.label} cap
                  </option>
                ))}
              </select>
            </label>
          </div>
          {who.trim() && !account && <p className="form-error">Enter a full 0x address.</p>}
          {account && has !== undefined && (
            <div className="live-delegate-state">
              <span className={has ? "status-pill live-can" : "status-pill"}>{has ? "can change it now" : "can't change it"}</span>
            </div>
          )}
          <div className="live-policy-actions">
            <TxButton tx={tx} variant="primary" onClick={grant} disabled={!account || has === true}>
              Allow
            </TxButton>
            <TxButton tx={tx} variant="secondary" onClick={revoke} disabled={!account || has !== true}>
              Take it back
            </TxButton>
          </div>
          <p className="form-hint">{delegateHowTo(company)}</p>
          <TxStatus tx={tx} />
        </form>
      )}
    </article>
  );
}
