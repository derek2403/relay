"use client";

// TEE attestation, fresh on every open: this page makes a nonce and asks the relay for a quote.
// - From the attestation service on Phala Cloud (RELAY_ATTESTATION_URL): the nonce is REPORTDATA.
//   This page checks the quote bytes itself (TDX, nonce, compose hash in MRCONFIGID) and shows
//   Phala's public verifier's verdict on Intel's signature.
// - From dstack next to the relay: the relay binds a statement of what it serves; this page
//   re-hashes the statement and checks it against the quote.

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { type RemoteAttestationResponse, remoteChecks } from "@/lib/relay/attestation-core";
import { attestationApi, apiErrorText, reasonOf, statusOf, type DstackAttestationResponse } from "./api";
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
        TEE attestation
      </h2>
      <p>A fresh Intel TDX quote with a nonce made in your browser. This page checks the quote itself and shows what it covers.</p>
      <button type="button" className="primary" onClick={() => setOpen(true)}>
        View attestation
      </button>
      <Dialog id="liveAttestationDialog" open={open} onClose={() => setOpen(false)}>
        {open && <AttestationBody onClose={() => setOpen(false)} />}
      </Dialog>
    </article>
  );
}

const randomNonce = () => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));

function AttestationBody({ onClose }: { onClose: () => void }) {
  // A new nonce on every open and every "Fresh quote": each quote is made for this request.
  const [nonce, setNonce] = useState<string>(randomNonce);
  const query = useQuery({
    queryKey: ["relay-attestation", nonce],
    queryFn: () => attestationApi.get(nonce),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="lp-attestation">
      <div className="dialog-heading">
        <div>
          <div className="eyebrow">Attestation</div>
          <h2>TEE attestation</h2>
        </div>
        <button type="button" className="icon-button close-dialog" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {query.isPending ? (
        <p className="dialog-description">Asking for a fresh quote…</p>
      ) : query.error ? (
        <AttestationError error={query.error} />
      ) : query.data.source === "remote" ? (
        <RemoteDetails data={query.data} nonce={nonce} />
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
          {query.isFetching ? "Fetching…" : "Fresh quote"}
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
  if (statusOf(error) === 502) {
    return (
      <p className="form-error" role="alert">
        {`Couldn't get a quote from the attestation service: ${reasonOf(error) ?? apiErrorText(error)}`}
      </p>
    );
  }
  return (
    <p className="form-error" role="alert">
      {statusOf(error) === 404 ? "This relay doesn't serve an attestation." : apiErrorText(error)}
    </p>
  );
}

function Check({ ok, children, detail }: { ok: boolean | null; children: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className={`lp-check ${ok === true ? "ok" : ok === false ? "bad" : ""}`} role="status">
      {ok === true ? "✓ " : ok === false ? "✗ " : "– "}
      {children}
      {detail && <small>{detail}</small>}
    </div>
  );
}

const when = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? formatUpdated(Date.parse(iso)) : "");

function RemoteDetails({ data, nonce }: { data: RemoteAttestationResponse; nonce: string }) {
  // Everything below "checked here" is read from the quote bytes in this browser, not taken from the relay.
  const checks = useMemo(() => remoteChecks(data.quote, nonce, data.service.composeHash), [data, nonce]);
  const parsed = parseQuote(data.quote);
  const m = checks.tdx ? data.measurements : null;
  const [copied, setCopied] = useState(false);
  const quoteBytes = Math.floor(strip0x(data.quote).length / 2);
  const intel = data.intel;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.quote);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <p className="dialog-description">
        A fresh quote from the attestation service on Phala Cloud, running in an Intel TDX confidential VM. It covers that service&apos;s
        code, pinned by its compose hash. The relay API runs on its own server.
      </p>

      <Check ok={checks.tdx} detail={parsed ? `Quote v${parsed.version}, read in this browser.` : undefined}>
        Intel TDX quote
      </Check>
      <Check ok={checks.nonceInQuote} detail={<>Nonce <code>{nonce}</code></>}>
        {checks.nonceInQuote ? "Made for this request: your nonce is in the quote" : "Your nonce is not in the quote"}
      </Check>
      <Check
        ok={checks.composeHashInQuote}
        detail={data.service.composeHash ? <>Compose hash <code>{data.service.composeHash}</code> in MRCONFIGID</> : "The service reported no compose hash."}
      >
        {checks.composeHashInQuote === null ? "Compose hash not checked" : checks.composeHashInQuote ? "The quote pins the service's compose file" : "The quote's compose hash differs from the service's"}
      </Check>
      <Check
        ok={intel ? intel.verified : null}
        detail={
          intel?.verified ? (
            <>
              Checked by Phala&apos;s public verifier{intel.verifiedAt ? ` at ${when(intel.verifiedAt)}` : ""}.{" "}
              {intel.reportUrl && (
                <a href={intel.reportUrl} target="_blank" rel="noreferrer">
                  Open the report ↗
                </a>
              )}
            </>
          ) : (
            intel?.error ?? "Paste the quote into Phala's explorer to check it."
          )
        }
      >
        {intel?.verified ? "Intel signature and certificate chain verified" : intel ? "Intel signature not verified" : "Intel signature not checked"}
      </Check>

      <h3 className="lp-subhead">Attested service</h3>
      <div className="lp-section">
        <Row label="URL" value={data.service.url} mono />
        {data.service.image && <Row label="Image" value={data.service.image} mono />}
        {data.service.appId && <Row label="Phala app" value={data.service.appId} mono />}
        {data.service.instanceId && <Row label="Instance" value={data.service.instanceId} mono />}
        {data.service.osImageHash && <Row label="OS image" value={data.service.osImageHash} mono />}
        <Row label="Fetched" value={when(data.fetchedAt)} />
      </div>

      {m && (
        <>
          <h3 className="lp-subhead">Measurements</h3>
          <div className="lp-section">
            <Row label="MRTD" value={m.mrtd} mono />
            <Row label="MRCONFIGID" value={m.mrConfigId} mono />
            <Row label="RTMR0" value={m.rtmr0} mono />
            <Row label="RTMR1" value={m.rtmr1} mono />
            <Row label="RTMR2" value={m.rtmr2} mono />
            <Row label="RTMR3" value={m.rtmr3} mono />
            <Row label="Report data" value={m.reportData} mono />
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

      <h3 className="lp-subhead">Check it yourself</h3>
      <pre className="lp-quote lp-cmd">{`curl -s "${data.service.url}/attestation?nonce=$(openssl rand -hex 32)"`}</pre>
    </>
  );
}

function runCheck(data: DstackAttestationResponse): { check: BindingCheck | null; checkError: string } {
  try {
    return { check: checkBinding(data), checkError: "" };
  } catch (failure) {
    return { check: null, checkError: failure instanceof Error ? failure.message : String(failure) };
  }
}

function AttestationDetails({ data, nonce }: { data: DstackAttestationResponse; nonce: string | undefined }) {
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
