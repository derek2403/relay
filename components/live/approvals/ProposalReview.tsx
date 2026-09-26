"use client";

// Review of one blockchain proposal: exactly what the relay signer would send, then
// Approve / Reject (challenge → wallet signature → confirm). Approving doesn't send anything:
// the agent submits next, and the relay rechecks everything then.

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";

import { useLive } from "@/components/live/LiveContext";
import { type Proposal } from "@/components/live/chain/api";
import { approveText, fromBase, isApproveRule, shortHex } from "@/components/live/chain/grant-model";
import { useProposal } from "@/components/live/chain/hooks";
import { StatePill } from "@/components/live/chain/StatePill";
import { addressUrl, amountText, argsText, blockOf, isOnChain, lifecycle, proposalState, txUrl } from "@/components/live/chain/view";
import { Steps } from "@/components/live/tx/Steps";
import { errorText } from "@/lib/relay/browser";

import { approvalsApi, type Decision } from "./api";
import { FlowSteps } from "./FlowSteps";
import { approverHint } from "./logic";
import { useSignedFlow } from "./useSignedFlow";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info-row appr-row">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

const Addr = ({ address }: { address: string | null | undefined }) =>
  address ? (
    <a className="chain-link mono" href={addressUrl(address)} target="_blank" rel="noreferrer" title={address}>
      {shortHex(address)}
    </a>
  ) : (
    <>—</>
  );

export function ProposalReview({ id, initial }: { id: string; initial?: Proposal }) {
  const live = useLive();
  const queryClient = useQueryClient();
  const query = useProposal(id);
  const p = query.data ?? initial;
  const decisionRef = useRef<Decision>("approve");
  const [decision, setDecision] = useState<Decision>("approve");
  const flow = useSignedFlow({
    issue: () => approvalsApi.challenge({ subject: { kind: "proposal", id }, decision: decisionRef.current, approver: live.address! }),
    confirm: (c, signature) => approvalsApi.confirm({ challengeId: c.id, signature }),
    onDone: () => {
      void query.refetch();
      void queryClient.invalidateQueries({ queryKey: ["relay-chain-proposals"] });
      live.log(decisionRef.current === "approve" ? "Proposal approved" : "Proposal rejected", id);
    },
  });

  if (!p) return <p className="form-hint">{query.error ? `Couldn't read ${id}: ${errorText(query.error as Error)}` : "Loading the proposal…"}</p>;

  const state = proposalState(p);
  const hint = approverHint(live.nodes, p.agent?.name ?? "", live.address);
  const busy = flow.phase !== "idle" && flow.phase !== "done" && flow.phase !== "failed";
  const run = (d: Decision) => {
    decisionRef.current = d;
    setDecision(d);
    void flow.start();
  };

  return (
    <div className="appr-review">
      <div className="appr-review-head">
        <StatePill state={state} />
        <span className="mono">{p.id}</span>
      </div>
      <h3 className="appr-title">{p.display?.summary ?? `${p.target?.label}.${p.method}`}</h3>
      {state === "blocked" && (
        <p className="appr-outcome bad">
          Blocked before anything was signed{blockOf(p) ? ` · rule ${blockOf(p)!.rule}: ${blockOf(p)!.reason}` : ""}
        </p>
      )}
      {p.error && (state === "failed" || state === "uncertain") && <p className="appr-outcome bad">{p.error}</p>}
      <div className="appr-grid">
        <Row label="Network">Sepolia</Row>
        <Row label="Signing wallet">
          <Addr address={p.tx?.from} /> <small className="lp-subtle">relay signer</small>
        </Row>
        <Row label="Target">
          {p.target?.label ?? p.target?.kind} <Addr address={p.target?.address ?? p.tx?.to} />
        </Row>
        <Row label="Function">
          <span className="mono">
            {p.op === "deploy" ? "constructor" : p.method}
            {argsText(p.args, true)}
          </span>
        </Row>
        {amountText(p) && <Row label="Amount">{amountText(p)}</Row>}
        {p.display?.recipient && (
          <Row label="Recipient">
            <Addr address={p.display.recipient} />
          </Row>
        )}
        <Row label="Estimated gas">{p.gasEstimate ? Number(p.gasEstimate).toLocaleString("en-US") : "—"} {p.tx?.gas ? <small className="lp-subtle">(limit {Number(p.tx.gas).toLocaleString("en-US")})</small> : null}</Row>
        <Row label="Grant id">
          <span className="mono" title={p.grantId}>
            {p.grantId ? shortHex(p.grantId) : "—"}
          </span>
        </Row>
        <Row label="Requested by">
          <span className="appr-wrap">{p.agent?.name ?? "—"}</span>
        </Row>
        <Row label="Approval rule">{p.approval?.required === false ? "No human approval needed" : isApproveRule(p.approval?.rule) ? approveText(p.approval.rule) : (p.approval?.rule ?? "A human approves")}</Row>
        {p.approval?.approver && (
          <Row label="Approved by">
            <Addr address={p.approval.approver} />
          </Row>
        )}
        <Row label="Proposal expires">{p.expiresAt ? new Date(p.expiresAt * (p.expiresAt < 1e12 ? 1000 : 1)).toLocaleTimeString() : "—"}</Row>
      </div>

      {state !== "blocked" && (
        <>
          <h4 className="chain-subhead">Progress</h4>
          <Steps steps={lifecycle(p).map((s) => ({ label: s.label, done: s.done, detail: s.at ? <span className="live-why">{new Date(s.at * (s.at < 1e12 ? 1000 : 1)).toLocaleTimeString()}</span> : undefined }))} />
        </>
      )}

      {isOnChain(state) && p.submit?.hash && (
        <div className="appr-grid">
          <Row label="Transaction">
            <a className="chain-link mono" href={txUrl(p.submit.hash)} target="_blank" rel="noreferrer">
              {shortHex(p.submit.hash, 10, 8)}
            </a>
          </Row>
          {p.receipt && (
            <>
              <Row label="Block">{p.receipt.blockNumber.toLocaleString("en-US")}</Row>
              <Row label="Confirmations">{p.receipt.confirmations}</Row>
              <Row label="Result">{p.receipt.status === "success" ? "Succeeded" : "Reverted"}</Row>
              {p.receipt.contractAddress && (
                <Row label="Deployed at">
                  <Addr address={p.receipt.contractAddress} />
                </Row>
              )}
            </>
          )}
        </div>
      )}

      {p.allowance && p.allowance.length > 0 && (
        <>
          <h4 className="chain-subhead">Allowance per level</h4>
          <div className="appr-grid">
            {p.allowance.map((a) => (
              <Row key={a.name} label={a.name}>
                {fromBase(a.spent)} spent{a.reserved !== "0" ? ` + ${fromBase(a.reserved)} reserved` : ""}
                {a.limit ? ` of ${fromBase(a.limit)} STD` : " STD"}
              </Row>
            ))}
          </div>
        </>
      )}

      {state === "awaiting-approval" && flow.phase !== "done" && (
        <div className="appr-decide">
          <p className={hint.ok ? "form-hint" : "form-hint appr-warn"}>{hint.why}</p>
          <p className="form-hint">Your signature approves exactly this transaction (its digest). Anything that changes needs a new approval, and the relay rechecks the grant before it signs.</p>
          <div className="appr-actions">
            <button type="button" className="primary" disabled={busy || !live.address} onClick={() => run("approve")}>
              Approve
            </button>
            <button type="button" className="secondary" disabled={busy || !live.address} onClick={() => run("reject")}>
              Reject
            </button>
            {busy && (
              <button type="button" className="parent-link" onClick={() => void flow.cancel()}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      <FlowSteps
        flow={flow}
        world={false}
        doneText={decision === "reject" ? "Rejected. Nothing will be sent." : "Approved. The agent submits next; the relay rechecks and reserves the allowance first."}
        failedText="Nothing changed"
      />
      {state === "approved" && flow.phase !== "done" && <p className="appr-outcome ok">Approved. The agent submits next.</p>}
    </div>
  );
}
