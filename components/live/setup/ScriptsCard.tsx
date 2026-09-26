"use client";

import { useState } from "react";

import { useLive } from "@/components/live/LiveContext";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { ADMIN_SIGN_IN, errorText, getJson } from "@/lib/relay/browser";

import { CopyBlock, Pill, SetupCard, Why } from "./bits";
import { useAdminState } from "./RelayStatusCard";
import { SCRIPT_COMMANDS, type ResetResult, resetSummary } from "./setup-model";

/** The org:seed / demo:reset scripts, and the relay's spend reset (POST /api/relay/admin/reset) for the signed-in admin. */
export function ScriptsCard() {
  const { refresh, log, toast } = useLive();
  const admin = useAdminState();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ResetResult | null>(null);
  const canReset = admin === "signed-in" || admin === "open";

  const reset = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await getJson<ResetResult>("/api/relay/admin/reset", { method: "POST" });
      setResult(r);
      setConfirming(false);
      await refresh();
      log("Relay spend reset", resetSummary(r));
      toast("Spend cleared for removed names.");
    } catch (e) {
      setError(e instanceof Error ? errorText(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SetupCard
      id="setupScripts"
      index="06"
      title="Scripts"
      pill={<Pill>CLI</Pill>}
      description="Run these from the repo to build the company on Sepolia, and to remove names added under it."
    >
      {SCRIPT_COMMANDS.map((c) => (
        <section key={c.command} className="live-setup-sub">
          <h3>{c.title}</h3>
          <p className="live-setup-muted">{c.what}</p>
          <CopyBlock text={c.command} />
          <Why>Needs {c.env}.</Why>
        </section>
      ))}

      <section className="live-setup-sub">
        <h3>Clear spend for removed names</h3>
        <p className="live-setup-muted">
          Drops the relay&apos;s spend, counts and log entries of names that are no longer registered. Names still registered keep their spend.
        </p>
        {canReset ? (
          <>
            {admin === "open" && <Why>Development mode: this clears spend and counts only. The log stays.</Why>}
            <div className="live-setup-actions">
              <button type="button" className="danger" onClick={() => setConfirming(true)}>
                Reset spend
              </button>
            </div>
          </>
        ) : admin === "signed-out" ? (
          <Why>
            <a href={ADMIN_SIGN_IN}>Sign in as the relay admin</a> to reset spend from here.
          </Why>
        ) : (
          <Why>Only the relay admin can reset spend. Set RELAY_ADMIN_TOKEN on the relay, then sign in.</Why>
        )}
        {result && <div className="form-hint">{resetSummary(result)}</div>}
        {result && result.skipped.length > 0 && (
          <ul className="live-setup-ticks">
            {result.skipped.slice(0, 8).map((s) => (
              <li key={s.name}>
                <span className="live-setup-mono">{s.name}</span>: {s.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog id="setupResetDialog" open={confirming} onClose={() => setConfirming(false)}>
        <div className="dialog-heading">
          <h2>Reset spend?</h2>
          <button type="button" className="icon-button close-dialog" aria-label="Close" onClick={() => setConfirming(false)}>
            <Icon name="close" />
          </button>
        </div>
        <p className="dialog-description">
          The relay forgets spend, counts and reservations of names that are no longer registered
          {admin === "open" ? "." : ", and removes their log entries."} No transaction is sent.
        </p>
        <div className="form-hint">To also remove the names themselves, run npm run demo:reset.</div>
        <p className="form-error" role="alert">
          {error}
        </p>
        <div className="dialog-footer">
          <button type="button" className="secondary close-dialog" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => void reset()} disabled={busy}>
            {busy ? "Resetting…" : "Reset spend"}
          </button>
        </div>
      </Dialog>
    </SetupCard>
  );
}
