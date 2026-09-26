"use client";

// The MultiBaas card's live part (Providers view): what the relay's chain service sees right now,
// and the capabilities ENS grants can hand out.

import { statusOf } from "@/components/live/providers/api";
import { errorText } from "@/lib/relay/browser";

import { useChainStatus } from "./hooks";
import { CHAIN_CAPABILITIES, statusRows } from "./view";

export function ChainStatusBlock() {
  const status = useChainStatus();
  const rows = statusRows(status.data);
  return (
    <div className="chain-status">
      {status.isPending ? (
        <p className="lp-subtle">Reading the chain service…</p>
      ) : status.error ? (
        <p className="form-hint">
          {statusOf(status.error) === 404 ? "This relay doesn't serve blockchain tools yet." : `Chain status unavailable: ${errorText(status.error as Error)}`}
        </p>
      ) : !status.data?.configured ? (
        <p className="form-hint">Not set up: run npm run chain:setup and set the relay signer key.</p>
      ) : (
        rows.map((row) => (
          <div className="info-row" key={row.label}>
            <span>{row.label}</span>
            {row.href ? (
              <a className="lp-mono chain-link" href={row.href} target="_blank" rel="noreferrer">
                {row.value}
              </a>
            ) : (
              <b className={row.mono ? "lp-mono" : undefined}>{row.value}</b>
            )}
          </div>
        ))
      )}
      {status.data?.problems?.map((p) => (
        <p key={p} className="form-hint chain-problem">
          {p}
        </p>
      ))}
      <ul className="chain-caps" aria-label="Blockchain capabilities">
        {CHAIN_CAPABILITIES.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <p className="chain-note">Connecting doesn&apos;t authorize anyone: grants come from ENS.</p>
    </div>
  );
}
