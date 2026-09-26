"use client";

import { explorerTx } from "@/lib/ens/contracts";
import { stringify } from "@/lib/ens/errors";
import type { Tx } from "@/lib/hooks/useTx";

import { shortHash, txStatusView } from "./txView";

/** Inline status of the latest step: awaiting signature, pending (Etherscan link), confirmed, reverted, failed (formatError text). */
export function TxStatus({ tx, showEvents = true }: { tx: Tx; /** List decoded ENSv2 events once mined (collapsed). */ showEvents?: boolean }) {
  const view = txStatusView(tx.state);
  if (!view) return null;
  const s = tx.state;
  const events = showEvents && (s.status === "success" || s.status === "reverted") ? s.events : [];
  return (
    <div className={`tx-status tone-${view.tone}`} role="status" aria-live="polite">
      <div className="tx-status-line">
        <span className={`status-pill tx-pill tone-${view.tone}`}>{view.badge}</span>
        {view.hash && (
          <a className="tx-hash" href={explorerTx(view.hash)} target="_blank" rel="noreferrer" title="View on Etherscan">
            {shortHash(view.hash)} ↗
          </a>
        )}
        {view.receipt && <span className="tx-receipt">{view.receipt}</span>}
        {!tx.busy && (
          <button type="button" className="tx-clear" onClick={tx.reset}>
            clear
          </button>
        )}
      </div>
      {view.error && (
        <p className="form-error tx-error" role="alert">
          {view.error}
        </p>
      )}
      {events.length > 0 && (
        <details className="tx-events">
          <summary>
            {events.length} {events.length === 1 ? "event" : "events"}
          </summary>
          <ul>
            {events.map((e, i) => (
              <li key={i}>
                <b>{e.eventName}</b> <span>{stringify(e.args)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
