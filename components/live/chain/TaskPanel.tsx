"use client";

// Agents view: "Blockchain task". An agent of this browser sends a plain-language task; the relay
// plans it (typed tools only), runs reads, turns writes into proposals, and reports.

import { type FormEvent, useState } from "react";

import { useLive } from "@/components/live/LiveContext";
import { keysUnderRoot, sessionCheck, tryTokenExpiry } from "@/components/live/agents/model";
import { Snippet } from "@/components/live/sessions/Snippet";
import { cx } from "@/lib/cx";
import { formatError } from "@/lib/ens/errors";
import { useRelayAgentKeys } from "@/lib/hooks/useRelayAgents";
import { useRelayPolicy } from "@/lib/hooks/useRelayApi";
import { type StoredAgentKey, agentToken, nowSec } from "@/lib/relay/browser";

import { type Proposal, type TaskResponse, chainApi } from "./api";
import { useProposals } from "./hooks";
import { StatePill } from "./StatePill";
import { EXAMPLE_TASKS, amountText, blockOf, callText, cliTaskCommand, findingRows, proposalState, stepViews, submittable } from "./view";

export function TaskPanel() {
  const live = useLive();
  const agents = useRelayAgentKeys();
  const named = keysUnderRoot(agents.keys, live.root);
  const [agentAddr, setAgentAddr] = useState("");
  const [task, setTask] = useState(EXAMPLE_TASKS[0].task);
  const [busy, setBusy] = useState<"run" | string | null>(null);
  const [result, setResult] = useState<TaskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const key = named.find((k) => k.address === agentAddr) ?? named[0];
  const policy = useRelayPolicy(key?.name ?? null);
  const { expiry, ended } = sessionCheck(policy.data?.levels ?? [], key?.name, nowSec());
  const proposals = useProposals(!!key);
  const ready = submittable(proposals.data ?? [], key?.name);

  const token = (k: StoredAgentKey) => agentToken(k, k.name!, tryTokenExpiry(nowSec(), expiry));

  const run = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!key?.name || !task.trim()) return;
    setBusy("run");
    setError(null);
    setResult(null);
    try {
      const res = await chainApi.task(await token(key), task.trim());
      setResult(res);
      live.log("Chain task", `${key.name}: ${task.trim().slice(0, 80)}`);
      void proposals.refetch();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async (p: Proposal) => {
    if (!key?.name) return;
    setBusy(p.id);
    setError(null);
    try {
      const next = await chainApi.submit(await token(key), p.id);
      live.toast(`Proposal ${p.id}: ${proposalState(next)}.`);
      live.log("Proposal submitted", `${key.name} · ${callText(p)}`);
      await proposals.refetch();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const cli = <Snippet label="From the agent's own machine" text={cliTaskCommand(task.trim())} />;

  if (named.length === 0) {
    return (
      <div className="provider-card agents-card chain-task">
        <p className="form-hint">
          No agent keys {live.root ? `for names under ${live.root} ` : ""}in this browser. Agents made with <code>relay login</code> run tasks from their own machine:
        </p>
        {cli}
      </div>
    );
  }

  const steps = result ? stepViews(result) : [];
  const findings = findingRows(result?.findings);

  return (
    <div className="provider-card agents-card chain-task">
      <form className="agents-form" onSubmit={(e) => void run(e)}>
        <label>
          As agent
          <select value={key?.address ?? ""} onChange={(e) => setAgentAddr(e.target.value)}>
            {named.map((k) => (
              <option key={k.address} value={k.address}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        <div className="chain-chips" role="group" aria-label="Example tasks">
          {EXAMPLE_TASKS.map((t) => (
            <button key={t.label} type="button" className={cx("chain-chip", task === t.task && "on")} onClick={() => setTask(t.task)}>
              {t.label}
            </button>
          ))}
        </div>
        <label className="agents-body-label">
          Task
          <textarea className="agents-textarea chain-task-input" value={task} onChange={(e) => setTask(e.target.value)} rows={3} maxLength={2000} />
        </label>
        {ended && <p className="form-hint">This session has ended or was removed, so the relay would refuse it.</p>}
        <p className="form-hint">The model only proposes typed steps. The relay checks every step against the ENS grants; writes wait for a human.</p>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-footer">
          <button type="submit" className="primary agents-send" disabled={!!busy || !task.trim() || ended}>
            {busy === "run" ? "Running…" : "Run"}
          </button>
        </div>
      </form>

      {ready.length > 0 && (
        <div className="chain-ready">
          <h4 className="chain-subhead">Approved, ready to submit</h4>
          {ready.map((p) => (
            <div key={p.id} className="chain-ready-row">
              <span className="mono">{callText(p)}</span>
              {amountText(p) && <b>{amountText(p)}</b>}
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void submit(p)}>
                {busy === p.id ? "Submitting…" : "Submit approved"}
              </button>
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className="agents-result chain-result" aria-live="polite">
          {result.plan?.expected && <p className="agents-why">Expected: {result.plan.expected}</p>}
          <h4 className="chain-subhead">Plan</h4>
          {steps.length === 0 ? (
            <p className="form-hint">{result.reason ?? "The planner returned no steps."}</p>
          ) : (
            <ol className="chain-steps">
              {steps.map((s) => (
                <li key={s.index} className={cx("chain-step", `is-${s.outcome}`)}>
                  <div className="chain-step-head">
                    <span className="chain-step-tool">{s.tool}</span>
                    <span className="mono">{s.target}</span>
                    {s.args && <span className="mono chain-step-args">{s.args}</span>}
                    <span className={cx("status-pill", "chain-outcome", `tone-${s.outcome}`)}>{s.outcome}</span>
                  </div>
                  <p className="chain-step-why">{s.why}</p>
                  <p className="chain-step-detail mono">{s.detail}</p>
                </li>
              ))}
            </ol>
          )}

          {result.proposals?.length > 0 && (
            <>
              <h4 className="chain-subhead">Proposals</h4>
              <ul className="chain-proposal-list">
                {result.proposals.map((p) => (
                  <li key={p.id}>
                    <StatePill state={proposalState(p)} />
                    <span className="mono">{callText(p)}</span>
                    {amountText(p) && <b>{amountText(p)}</b>}
                    {blockOf(p) && <span className="chain-rule">{blockOf(p)!.rule}</span>}
                    <button type="button" className="parent-link" onClick={() => live.openReview({ kind: "proposal", id: p.id })}>
                      Open in Approvals
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {findings.length > 0 && (
            <>
              <h4 className="chain-subhead">Findings</h4>
              <p className="form-hint">A flag is a rule match, not proof of wrongdoing.</p>
              <div className="agents-log-wrap">
                <table className="agents-log chain-findings">
                  <thead>
                    <tr>
                      <th>Transaction</th>
                      <th className="num">Amount</th>
                      <th>Recipient</th>
                      <th>Rule</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((f) => (
                      <tr key={f.key}>
                        <td className="mono">
                          <a className="chain-link" href={f.href} target="_blank" rel="noreferrer">
                            {f.tx}
                          </a>
                        </td>
                        <td className="num nowrap">{f.amount}</td>
                        <td className="mono">{f.recipient}</td>
                        <td className="nowrap">{f.rule}</td>
                        <td>{f.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h4 className="chain-subhead">Report</h4>
          {result.report ? (
            <p className="chain-report">{result.report}</p>
          ) : (
            <p className="form-hint">No written report{result.reportReason ? `: ${result.reportReason}` : ""}. The results above are the relay&apos;s own.</p>
          )}
          <p className="agents-footnote chain-run">Run {result.runId}</p>
        </div>
      )}
      <details className="chain-cli">
        <summary>Run it from the CLI instead</summary>
        {cli}
      </details>
    </div>
  );
}

