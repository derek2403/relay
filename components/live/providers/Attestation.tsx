"use client";

// Relay attestation: the relay signs a statement of what it serves (root, services, build) into a
// TDX quote's report data. This page re-hashes the statement and checks it against the quote.

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { attestationApi, apiErrorText, reasonOf, statusOf, type AttestationResponse } from "./api";
import { PHALA_EXPLORER, bytesToHex, checkBinding, formatUpdated, markFor, parseQuote, sourceLabel, strip0x, type BindingCheck } from "./logic";

export function AttestationCard() {
  const [open, setOpen] = useState(false);
  return (
    <article className="provider-card lp-attest">
      <span className="status-pill">TEE quote</span>
      <h2>
        <span className="provider-logo">
          <Icon name="shield" />
        </span>
        Relay attestation
      </h2>
      <p>
        The relay puts a hash of what it serves (company root, APIs with keys, build) into a TEE quote. Check that the quote covers
        this exact statement.
      </p>
      <button type="button" className="primary" onClick={() => setOpen(true)}>
        View attestation
      </button>
      <Dialog id="liveAttestationDialog" open={open} onClose={() => setOpen(false)}>
        {open && <AttestationBody onClose={() => setOpen(false)} />}
      </Dialog>
    </article>
  );
}

const randomNonce = () => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));

function AttestationBody({ onClose }: { onClose: () => void }) {
  const [nonce, setNonce] = useState<string | undefined>(undefined);
  const query = useQuery({
    queryKey: ["relay-attestation", nonce ?? null],
    queryFn: () => attestationApi.get(nonce),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="lp-attestation">
      <div className="dialog-heading">
        <div>
          <div className="eyebrow">Attestation</div>
          <h2>Relay attestation</h2>
        </div>
        <button type="button" className="icon-button close-dialog" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {query.isPending ? (
        <p className="dialog-description">Asking the relay for a quote…</p>
      ) : query.error ? (
        <AttestationError error={query.error} />
      ) : (
        <AttestationDetails data={query.data} nonce={nonce} />
      )}
      <div className="dialog-footer">
        {query.data && (
          <a className="secondary lp-link" href={query.data.verifyUrl || PHALA_EXPLORER} target="_blank" rel="noreferrer">
            Verify on Phala ↗
          </a>
        )}
        <button type="button" className="secondary" disabled={query.isFetching} onClick={() => setNonce(randomNonce())}>
          {query.isFetching && nonce ? "Fetching…" : "Fresh quote"}
        </button>
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function AttestationError({ error }: { error: Error }) {
  if (statusOf(error) === 503 && (reasonOf(error) === "no-tee" || /tee|dstack|simulator/i.test(error.message))) {
    return (
      <>
        <p className="dialog-description">No TEE is reachable from the relay, so there is no quote to show.</p>
        {reasonOf(error) && reasonOf(error) !== "no-tee" && <p className="form-error">{reasonOf(error)}</p>}
      </>
    );
  }
  return (
    <p className="form-error" role="alert">
      {statusOf(error) === 404 ? "This relay doesn't serve an attestation." : apiErrorText(error)}
    </p>
  );
}

function runCheck(data: AttestationResponse): { check: BindingCheck | null; checkError: string } {
  try {
    return { check: checkBinding(data), checkError: "" };
  } catch (failure) {
    return { check: null, checkError: failure instanceof Error ? failure.message : String(failure) };
  }
}

function AttestationDetails({ data, nonce }: { data: AttestationResponse; nonce: string | undefined }) {
  const { check, checkError } = useMemo(() => runCheck(data), [data]);
  const [copied, setCopied] = useState(false);
  const parsed = parseQuote(data.quote);
  const measurements = data.measurements ?? parsed?.measurements ?? null;
  const statement = data.statement;
  const teeType = parsed?.teeType ?? (typeof data.info?.tee_type === "string" ? data.info.tee_type : null);
  const quoteBytes = data.quote ? Math.floor(strip0x(data.quote).length / 2) : 0;
  // Only a quote parsed in this browser proves anything; the relay's own reportData is just its claim.
  const checked = check?.reportDataFrom === "quote";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.quote);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const issued = typeof statement.issuedAt === "number" ? formatUpdated(statement.issuedAt) : String(statement.issuedAt ?? "");
  const nonceOk = nonce ? strip0x(String(statement.nonce ?? "")) === strip0x(nonce) : null;

  return (
    <>
      <p className="dialog-description">
        The quote's report data should start with sha256 of the statement below. This page checks that itself.
      </p>

      <div className={`lp-check ${check && checked ? (check.bound ? "ok" : "bad") : ""}`} role="status">
        {checkError ? (
          <>✗ Could not check: {checkError}</>
        ) : !check ? (
          <>Checking…</>
        ) : !checked ? (
          <>Quote not parsed: this page can&apos;t check the binding</>
        ) : check.bound ? (
          <>✓ Statement bound to quote</>
        ) : (
          <>✗ Statement not bound to quote</>
        )}
        {check && (
          <small>
            sha256 <code>{check.computed}</code>
            {!checked ? (
              <>
                {" · "}the quote isn&apos;t a TDX quote this page can read. Check it with{" "}
                <a href={data.verifyUrl || PHALA_EXPLORER} target="_blank" rel="noreferrer">
                  Phala&apos;s verifier
                </a>
                .
              </>
            ) : null}
            {check.hashMatchesServer === false ? " · differs from the relay's statementHash" : ""}
          </small>
        )}
      </div>

      <div className="lp-section">
        <div className="info-row">
          <span>TEE</span>
          <b>{teeType ?? "Unknown"}</b>
        </div>
        <div className="info-row">
          <span>Source</span>
          <b className="lp-subtle">{sourceLabel(data.source)}</b>
        </div>
        {parsed && (
          <div className="info-row">
            <span>Quote version</span>
            <b>v{parsed.version}</b>
          </div>
        )}
        {nonceOk !== null && (
          <div className="info-row">
            <span>Fresh nonce</span>
            <b>{nonceOk ? "✓ matches" : "✗ does not match"}</b>
          </div>
        )}
      </div>

      <h3 className="lp-subhead">Statement</h3>
      <div className="lp-section">
        <Row label="Relay" value={statement.relay} />
        <Row label="Company root" value={statement.root ?? "Not set"} />
        {statement.rootOwner && <Row label="Root owner" value={statement.rootOwner} mono />}
        <Row label="Build" value={statement.build ?? "Not set"} />
        <Row label="Issued" value={issued} />
        {statement.nonce && <Row label="Nonce" value={String(statement.nonce)} mono />}
      </div>
      {Array.isArray(statement.services) && statement.services.length > 0 && (
        <ul className="lp-services">
          {statement.services.map((service) => (
            <li key={service.id} className={service.configured ? "on" : undefined}>
              <Icon name={markFor(service.id)} />
              {service.id}
              <small>{service.configured ? "key set" : "no key"}</small>
            </li>
          ))}
        </ul>
      )}

      {measurements && (
        <>
          <h3 className="lp-subhead">Measurements</h3>
          <div className="lp-section">
            <Row label="MRTD" value={measurements.mrtd} mono />
            <Row label="RTMR0" value={measurements.rtmr0} mono />
            <Row label="RTMR1" value={measurements.rtmr1} mono />
            <Row label="RTMR2" value={measurements.rtmr2} mono />
            <Row label="RTMR3" value={measurements.rtmr3} mono />
            <Row label="Report data" value={measurements.reportData} mono />
          </div>
        </>
      )}

      <details className="lp-quote">
        <summary>
          Quote <span>{quoteBytes} bytes</span>
        </summary>
        <pre>{strip0x(data.quote)}</pre>
        <button type="button" className="secondary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy quote"}
        </button>
      </details>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <b className={mono ? "lp-mono lp-wrap" : undefined}>{value}</b>
    </div>
  );
}
