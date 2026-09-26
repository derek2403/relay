"use client";

// Review of one incident: a paused agent asked for more. The approver sees what would change,
// the evidence and the agent's (unverified) account, and picks a decision. Approvals need the
// wallet signature AND a Selfie Check from the approver's linked World ID; reject/revoke need
// the wallet only. Any failure keeps the agent paused.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";

import { useLive } from "@/components/live/LiveContext";
import { useChainStatus } from "@/components/live/chain/hooks";
import { recipientLabel } from "@/components/live/chain/grant-model";
import { cx } from "@/lib/cx";
import { errorText } from "@/lib/relay/browser";

import { type Decision, approvalsApi } from "./api";
import { FlowSteps } from "./FlowSteps";
import {
  DECISION_LABELS,
  NARROW_DURATIONS,
  type NarrowDraft,
  affectedNames,
  approverHint,
  defaultNarrow,
  diffRows,
  evidenceLines,
  flagView,
  incidentStateText,
  isOpen,
  narrowScope,
  reportBy,
  reportText,
  requirements,
  scopeText,
  snapshotGrant,
  subjectName,
  suggestionText,
  triggerText,
  worldNotes,
} from "./logic";
import { useSignedFlow } from "./useSignedFlow";

const when = (unix: number | undefined) => (unix ? new Date(unix * (unix < 1e12 ? 1000 : 1)).toLocaleString() : "—");

export function IncidentReview({ id }: { id: string }) {
  const live = useLive();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["relay-incident", id], queryFn: () => approvalsApi.incident(id), retry: false, refetchInterval: 10_000, refetchOnWindowFocus: false });
  const inc = query.data;
  const recipients = (useChainStatus().data?.recipients ?? {}) as Record<string, string>;
  const [choice, setChoice] = useState<Decision | null>(null);
  const [narrow, setNarrow] = useState<NarrowDraft | null>(null);
  const pending = useRef<{ decision: Decision; scope?: unknown }>({ decision: "reject" });

  const flow = useSignedFlow({
    issue: () => approvalsApi.challenge({ subject: { kind: "incident", id }, decision: pending.current.decision, approver: live.address!, scope: pending.current.scope }),
    confirm: (c, signature, world) => approvalsApi.confirm({ challengeId: c.id, signature, world }),
    onDone: () => {
      void query.refetch();
      void queryClient.invalidateQueries({ queryKey: ["relay-incidents"] });
      void queryClient.invalidateQueries({ queryKey: ["relay-status"] });
      live.log(`Incident ${DECISION_LABELS[pending.current.decision].toLowerCase()}`, id);
    },
  });

  if (!inc) return <p className="form-hint">{query.error ? `Couldn't read ${id}: ${errorText(query.error as Error)}` : "Loading the incident…"}</p>;

  const name = subjectName(inc);
  const rows = diffRows(inc, recipients);
  const flags = (inc.flags ?? []).map(flagView);
  const evidence = evidenceLines(inc.evidence);
  const draft = narrow ?? defaultNarrow(inc);
  const prevGrant = snapshotGrant(inc.previous);
  const narrowed = narrowScope(inc, draft, Math.floor(Date.now() / 1000));
  const hint = approverHint(live.nodes, name, live.address);
  const worldStatus = live.status?.world;
  const busy = flow.phase !== "idle" && flow.phase !== "done" && flow.phase !== "failed";
  const open = isOpen(inc.state);
  const needsWorld = choice ? requirements("incident", choice).world : false;

  const go = (decision: Decision) => {
    const scope = decision === "approve-narrower" ? narrowed.scope ?? undefined : undefined;
    if (decision === "approve-narrower" && !narrowed.scope) return;
    pending.current = { decision, scope };
    void flow.start();
  };

  return (
    <div className="appr-review">
      <div className="appr-review-head">
        <span className={cx("status-pill", open ? "chain-pill tone-live" : "chain-pill tone-idle")}>{incidentStateText(inc.state)}</span>
        <span className="mono">{inc.id}</span>
      </div>
      <h3 className="appr-title appr-wrap">{name}</h3>
      <div className="appr-grid">
        <div className="info-row appr-row">
          <span>Trigger</span>
          <b>{triggerText(inc.trigger)}</b>
        </div>
        <div className="info-row appr-row">
          <span>Opened</span>
          <b>{when(inc.openedAt)}</b>
        </div>
        <div className="info-row appr-row">
          <span>Review by</span>
          <b>{when(inc.reviewBy)}</b>
        </div>
        {inc.policyVersion !== undefined && (
          <div className="info-row appr-row">
            <span>Policy version</span>
            <b className="mono">{String(inc.policyVersion)}</b>
          </div>
        )}
      </div>

      {flags.length > 0 && (
        <ul className="appr-flags">
          {flags.map((f) => (
            <li key={`${f.rule}-${f.text}`} className={cx(f.critical && "critical")}>
              <b>{f.words}</b> <span className="mono">{f.rule}</span>
              {f.text && <span> · {f.text}</span>}
            </li>
          ))}
        </ul>
      )}

      <h4 className="chain-subhead">What would change</h4>
      {rows.length === 0 ? (
        <p className="form-hint">No differences recorded.</p>
      ) : (
        <div className="agents-log-wrap">
          <table className="agents-log appr-diff">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Now</th>
                <th>Asked for</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.field} className={cx(r.expansion && "expansion")}>
                  <td>{r.field}</td>
                  <td>{r.before}</td>
                  <td>
                    {r.after}
                    {r.expansion && <span className="appr-more">more</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {affectedNames(inc.affected).length > 0 && (
        <>
          <h4 className="chain-subhead">Paused with it</h4>
          <p className="appr-affected mono">{affectedNames(inc.affected).join(", ")}</p>
        </>
      )}
      {inc.overlay && (
        <p className="appr-outcome ok">
          Approved scope {inc.overlay.active ? "active" : "ended"}: until {when(inc.overlay.notAfter)}.
        </p>
      )}
      {inc.resolution?.world && (
        <div className="appr-world-evidence">
          <p className="live-why">
            Verified with World ID {inc.resolution.world.environment && <span className={`status-pill appr-env env-${inc.resolution.world.environment}`}>{inc.resolution.world.environment}</span>}
          </p>
          {worldNotes(inc.resolution.world).map((n) => (
            <p key={n} className="live-why appr-note">
              {n}
            </p>
          ))}
        </div>
      )}

      {evidence.length > 0 && (
        <details className="appr-evidence">
          <summary>Evidence ({evidence.length} recent relay decisions)</summary>
          <ul>
            {evidence.map((e) => (
              <li key={e.key} className={cx(e.refused && "refused")}>
                {e.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      {inc.agentReports && inc.agentReports.length > 0 && (
        <div className="appr-reports">
          <h4 className="chain-subhead">Reported by agent (unverified: may be mistaken or manipulated)</h4>
          {inc.agentReports.map((r, i) => (
            <blockquote key={i}>
              {r.category && <b>{r.category}: </b>}
              {reportText(r)}
              {reportBy(r) && <small> · {reportBy(r)}</small>}
            </blockquote>
          ))}
        </div>
      )}

      {inc.suggested && inc.suggested.length > 0 && (
        <p className="form-hint">Suggested: {inc.suggested.map(suggestionText).filter(Boolean).join(" · ")}</p>
      )}

      {open && flow.phase !== "done" && (
        <>
          <h4 className="chain-subhead">Decide</h4>
          <p className={hint.ok ? "form-hint" : "form-hint appr-warn"}>{hint.why}</p>
          <div className="appr-decisions" role="radiogroup" aria-label="Decision">
            <DecisionCard id="reject" choice={choice} onPick={setChoice} note="Stays paused until its ENS name expires. Wallet signature only." />
            <DecisionCard id="approve-narrower" choice={choice} onPick={setChoice} note="Resume only a smaller scope, for a short time. Wallet + World ID.">
              {choice === "approve-narrower" && (
                <div className="appr-narrow">
                  {prevGrant?.to && prevGrant.to.length > 0 && (
                    <fieldset>
                      <legend>Recipients (from the current grant)</legend>
                      {prevGrant.to.map((t) => (
                        <label key={t} className="appr-check">
                          <input
                            type="checkbox"
                            checked={draft.recipients.includes(t)}
                            onChange={(e) => setNarrow({ ...draft, recipients: e.target.checked ? [...draft.recipients, t] : draft.recipients.filter((x) => x !== t) })}
                          />
                          {recipientLabel(t, recipients)}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <div className="form-row">
                    {prevGrant && (
                      <label>
                        Amount (STD)
                        <input value={draft.amount} inputMode="decimal" onChange={(e) => setNarrow({ ...draft, amount: e.target.value })} />
                      </label>
                    )}
                    <label>
                      For
                      <select value={draft.durationSec} onChange={(e) => setNarrow({ ...draft, durationSec: Number(e.target.value) })}>
                        {NARROW_DURATIONS.map((d) => (
                          <option key={d.sec} value={d.sec}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {narrowed.error ? <p className="form-error">{narrowed.error}</p> : scopeText(narrowed.scope) && <pre className="appr-scope mono">{scopeText(narrowed.scope)}</pre>}
                </div>
              )}
            </DecisionCard>
            <DecisionCard id="approve" choice={choice} onPick={setChoice} note="Everything asked for. Wallet + World ID.">
              {choice === "approve" && rows.some((r) => r.expansion) && (
                <ul className="appr-expansions">
                  {rows
                    .filter((r) => r.expansion)
                    .map((r) => (
                      <li key={r.field}>
                        {r.field}: {r.before} → <b>{r.after}</b>
                      </li>
                    ))}
                </ul>
              )}
            </DecisionCard>
            <DecisionCard id="revoke" choice={choice} onPick={setChoice} note="Paused for good. Then remove the name in the tree. Wallet signature only." />
          </div>
          {needsWorld && worldStatus && !worldStatus.configured && <p className="form-error">World ID isn&apos;t set up on this relay, so approvals can&apos;t be verified.</p>}
          <div className="appr-actions">
            <button
              type="button"
              className={choice === "revoke" || choice === "reject" ? "secondary" : "primary"}
              disabled={!choice || busy || !live.address || (choice === "approve-narrower" && !narrowed.scope)}
              onClick={() => choice && go(choice)}
            >
              {flow.phase === "failed" ? "Start again" : choice ? `${DECISION_LABELS[choice]}${needsWorld ? " · sign + World ID" : " · sign"}` : "Pick a decision"}
            </button>
            {busy && (
              <button type="button" className="parent-link" onClick={() => void flow.cancel()}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
      <FlowSteps
        flow={flow}
        world={needsWorld}
        doneText={
          pending.current.decision === "approve-narrower"
            ? "Approved narrower. The relay resumes only this scope, until it ends."
            : pending.current.decision === "approve"
              ? "Approved. The relay resumes the requested scope."
              : pending.current.decision === "reject"
                ? "Rejected. It stays paused."
                : "Revoked. Remove the name in the tree to finish."
        }
        failedText={`Still paused: ${name}`}
      />
    </div>
  );
}

function DecisionCard({ id, choice, onPick, note, children }: { id: Decision; choice: Decision | null; onPick: (d: Decision) => void; note: string; children?: ReactNode }) {
  return (
    <div className={cx("appr-decision", choice === id && "on", id === "revoke" && "danger-card")}>
      <label>
        <input type="radio" name="appr-decision" checked={choice === id} onChange={() => onPick(id)} />
        <b>{DECISION_LABELS[id]}</b>
      </label>
      <p>{note}</p>
      {children}
    </div>
  );
}

