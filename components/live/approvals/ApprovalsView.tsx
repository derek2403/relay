"use client";

// Live "Approvals": incidents (paused agents) and blockchain proposals waiting for a human.
// Each item opens a review dialog; decisions are signed by the approver's wallet (and, for
// approving a paused agent, verified with World ID).

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useLive, type ReviewTarget } from "@/components/live/LiveContext";
import type { Proposal } from "@/components/live/chain/api";
import { useProposals } from "@/components/live/chain/hooks";
import { StatePill } from "@/components/live/chain/StatePill";
import { amountText, blockOf, callText, proposalState, sortProposals } from "@/components/live/chain/view";
import { DialogHead } from "@/components/live/members/parts";
import { statusOf } from "@/components/live/providers/api";
import { SectionHeading } from "@/components/shell/SectionHeading";
import { Dialog } from "@/components/ui/Dialog";
import { cx } from "@/lib/cx";
import { errorText } from "@/lib/relay/browser";

import { type IncidentSummary, approvalsApi } from "./api";
import { IdentityCard } from "./IdentityCard";
import { IncidentReview } from "./IncidentReview";
import { flagView, incidentStateText, isOpen, subjectName, triggerText } from "./logic";
import { ProposalReview } from "./ProposalReview";

const when = (unix: number | undefined) => (unix ? new Date(unix * (unix < 1e12 ? 1000 : 1)).toLocaleString() : "");

const missing = (e: unknown) => statusOf(e) === 404;

export function ApprovalsView() {
  const live = useLive();
  const incidents = useQuery({
    queryKey: ["relay-incidents"],
    queryFn: approvalsApi.incidents,
    retry: false,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
  });
  const proposals = useProposals();
  const [open, setOpen] = useState<ReviewTarget | null>(null);

  // "Open in Approvals" from elsewhere (the Agents task panel).
  const { review, clearReview } = live;
  useEffect(() => {
    if (!review) return;
    setOpen(review);
    clearReview();
  }, [review, clearReview]);

  const incidentList = [...(incidents.data ?? [])].sort((a, b) => Number(isOpen(b.state)) - Number(isOpen(a.state)) || (b.openedAt ?? 0) - (a.openedAt ?? 0));
  const proposalList = sortProposals(proposals.data ?? []);
  const proposalById = new Map(proposalList.map((p) => [p.id, p]));

  return (
    <div className="appr-view">
      <IdentityCard />

      <section className="agents-section">
        <SectionHeading title="Incidents" subtitle="Agents paused by the relay after asking for more. Open first." />
        {incidents.isPending ? (
          <p className="form-hint">Reading incidents…</p>
        ) : incidents.error ? (
          <p className="form-hint">{missing(incidents.error) ? "This relay doesn't serve approvals yet." : `Couldn't read incidents: ${errorText(incidents.error as Error)}`}</p>
        ) : incidentList.length === 0 ? (
          <p className="form-hint appr-empty">No incidents. Nothing is paused.</p>
        ) : (
          <ul className="appr-list">
            {incidentList.map((inc) => (
              <IncidentItem key={inc.id} inc={inc} onOpen={() => setOpen({ kind: "incident", id: inc.id })} />
            ))}
          </ul>
        )}
      </section>

      <section className="agents-section">
        <SectionHeading title="Blockchain proposals" subtitle="Transactions agents prepared. Nothing is signed until a human approves and the relay rechecks." />
        {proposals.isPending ? (
          <p className="form-hint">Reading proposals…</p>
        ) : proposals.error ? (
          <p className="form-hint">{missing(proposals.error) ? "This relay doesn't serve blockchain proposals yet." : `Couldn't read proposals: ${errorText(proposals.error as Error)}`}</p>
        ) : proposalList.length === 0 ? (
          <p className="form-hint appr-empty">No proposals yet. Run a task from the Agents view or with relay chain task.</p>
        ) : (
          <ul className="appr-list">
            {proposalList.map((p) => (
              <ProposalItem key={p.id} p={p} onOpen={() => setOpen({ kind: "proposal", id: p.id })} />
            ))}
          </ul>
        )}
      </section>

      <Dialog id="liveApprovalDialog" open={!!open} onClose={() => setOpen(null)}>
        {open && (
          <div className="appr-dialog">
            <DialogHead title={open.kind === "incident" ? "Review incident" : "Review proposal"} onClose={() => setOpen(null)} />
            {open.kind === "incident" ? <IncidentReview key={open.id} id={open.id} /> : <ProposalReview key={open.id} id={open.id} initial={proposalById.get(open.id)} />}
          </div>
        )}
      </Dialog>
    </div>
  );
}

function IncidentItem({ inc, onOpen }: { inc: IncidentSummary; onOpen: () => void }) {
  const flags = (inc.flags ?? []).map(flagView);
  const openNow = isOpen(inc.state);
  return (
    <li className={cx("appr-item", openNow && "is-open")}>
      <button type="button" className="appr-item-button" onClick={onOpen}>
        <span className={cx("status-pill", "chain-pill", openNow ? "tone-live" : "tone-idle")}>{incidentStateText(inc.state)}</span>
        <span className="appr-item-main">
          <b className="appr-wrap">{subjectName(inc)}</b>
          <small>
            {flags.length ? flags.map((f) => f.words).join(" · ") : triggerText(inc.trigger)}
            {inc.openedAt ? ` · opened ${when(inc.openedAt)}` : ""}
          </small>
        </span>
        <span className="appr-item-go">Review</span>
      </button>
    </li>
  );
}

function ProposalItem({ p, onOpen }: { p: Proposal; onOpen: () => void }) {
  const state = proposalState(p);
  return (
    <li className={cx("appr-item", state === "awaiting-approval" && "is-open")}>
      <button type="button" className="appr-item-button" onClick={onOpen}>
        <StatePill state={state} />
        <span className="appr-item-main">
          <b className="appr-wrap">{p.display?.summary ?? callText(p)}</b>
          <small>
            {[p.agent?.name, amountText(p), blockOf(p) ? `rule ${blockOf(p)!.rule}` : null, when(p.createdAt)].filter(Boolean).join(" · ")}
          </small>
        </span>
        <span className="appr-item-go">{state === "awaiting-approval" ? "Review" : "Open"}</span>
      </button>
    </li>
  );
}
