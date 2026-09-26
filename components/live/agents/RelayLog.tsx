"use client";

import { AdminSignInPrompt } from "@/components/live/actions/AdminWallet";
import { useLive } from "@/components/live/LiveContext";
import { cx } from "@/lib/cx";
import { ADMIN_SIGN_IN, errorText, needsSignIn } from "@/lib/relay/browser";
import type { LogEntry } from "@/lib/relay/types";

import { logCost, logOutcome } from "./model";

/** Where the relay shows `what` to the admin only: the owner's wallet sign-in, or the relay's token page. */
export function AdminSignIn({ what }: { what: string }) {
  const { status } = useLive();
  if (status?.viewAuth === "closed") {
    return (
      <p className="form-hint agents-signin">
        The relay shows {what} only to agent tokens. Once admin sign-in is turned on for this relay,{" "}
        <a href={ADMIN_SIGN_IN} className="agents-link">
          sign in as admin
        </a>
        .
      </p>
    );
  }
  return (
    <p className="form-hint agents-signin">
      <AdminSignInPrompt what={what} />
    </p>
  );
}

/** The relay's recent decisions (SRC TryCall ActivityLog): When, Name, Call, Result, Cost (* estimated). */
export function RelayActivityLog({ entries, error }: { entries: readonly LogEntry[] | undefined; error: Error | null }) {
  const { status } = useLive();
  if (needsSignIn(error) || status?.viewAuth === "closed") return <AdminSignIn what="the log" />;
  if (error) return <p className="form-hint">Couldn&apos;t load the log: {errorText(error)}</p>;
  if (!entries) return <p className="form-hint">Loading the log…</p>;
  if (!entries.length) return <p className="form-hint">No calls yet.</p>;
  const estimated = entries.some((e) => e.estimated && e.costUsd !== null);
  return (
    <div className="activity-list agents-log-wrap">
      <table className="agents-log">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Name</th>
            <th scope="col">Call</th>
            <th scope="col">Result</th>
            <th scope="col" className="num">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => {
            const o = logOutcome(e);
            return (
              <tr key={`${e.ts}-${i}`}>
                <td className="mono nowrap">{new Date(e.ts).toLocaleTimeString()}</td>
                <td className="mono name">{e.name ?? "—"}</td>
                <td className="mono">
                  {e.provider} {e.method} {e.path}
                </td>
                <td>
                  <span className={cx("status-pill", o.tone === "refused" && "revoked")}>{o.text}</span>
                  {e.reason && <span className={cx("agents-reason", o.loud && "loud")}>{e.reason}</span>}
                </td>
                <td className="mono num nowrap">{logCost(e)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {estimated && <p className="agents-footnote">* estimated: the call ended before the provider reported usage.</p>}
    </div>
  );
}
