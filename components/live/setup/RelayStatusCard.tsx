"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useLive } from "@/components/live/LiveContext";
import { explorerAddress } from "@/lib/ens/contracts";
import { useLocalJson } from "@/lib/hooks/useLocalJson";
import { ADMIN_SIGN_IN, DRAFT_ROOT_STORAGE, RelayApiError, errorText, relayApi } from "@/lib/relay/browser";

import { CopyBlock, Pill, SetupCard } from "./bits";
import { adminState, draftRootProblem, formatTtl, providerSplit, setupEnvTemplate } from "./setup-model";

/** Whether this browser holds the admin cookie (only asked when the relay uses admin sign-in). */
export function useAdminState() {
  const { status } = useLive();
  const viewAuth = status?.viewAuth;
  const probe = useQuery({
    queryKey: ["relay-admin-probe"],
    queryFn: () => relayApi.log(1),
    enabled: viewAuth === "token",
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const failed = probe.error instanceof RelayApiError ? probe.error.status : null;
  return adminState(viewAuth, { ok: probe.isSuccess, status: failed });
}

/** SRC StatusLine: what the relay serves, or exactly what to configure. */
export function RelayStatusCard() {
  const { status, statusError, setDraftRoot } = useLive();
  const admin = useAdminState();
  const [stored] = useLocalJson<string>(DRAFT_ROOT_STORAGE, "");
  const [typed, setTyped] = useState<string | null>(null);
  const draft = typed ?? stored;
  const problem = draftRootProblem(draft);

  const onDraft = (value: string) => {
    setTyped(value);
    setDraftRoot(value);
  };

  const nameInput = (
    <label className="live-setup-field">
      Company name
      <input value={draft} onChange={(e) => onDraft(e.target.value)} placeholder="yourcompany.eth" spellCheck={false} autoComplete="off" />
      {problem && (
        <span className="form-error" role="alert">
          {problem}
        </span>
      )}
    </label>
  );

  if (!status && !statusError) {
    return (
      <SetupCard id="setupStatus" index="01" title="Relay status" pill={<Pill>Checking</Pill>}>
        <p className="live-setup-muted">Checking the relay…</p>
      </SetupCard>
    );
  }

  if (!status) {
    return (
      <SetupCard id="setupStatus" index="01" title="Relay status" pill={<Pill tone="bad">Unreachable</Pill>}>
        <div className="form-hint">
          {statusError instanceof Error ? errorText(statusError) : "No response"} (GET /api/relay/status). Chain actions below still work on the
          company name you type here.
        </div>
        {nameInput}
      </SetupCard>
    );
  }

  const { withKey, noKey } = providerSplit(status);
  const providers = (
    <div className="live-setup-row">
      <span>API keys</span>
      <div className="live-setup-chips">
        {withKey.map((p) => (
          <span key={p.id} className="live-setup-chip ok">
            {p.label}
          </span>
        ))}
        {withKey.length === 0 && <span className="live-setup-chip warn">No API keys yet</span>}
        {noKey.length > 0 && (
          <span className="live-setup-chip" title={noKey.map((p) => p.label).join(", ")}>
            {noKey.length} more without a key
          </span>
        )}
      </div>
    </div>
  );

  if (!status.root) {
    return (
      <SetupCard
        id="setupStatus"
        index="01"
        title="Relay status"
        pill={<Pill tone="warn">No company name</Pill>}
        description="The relay doesn't know your company name yet."
      >
        <p className="live-setup-muted">
          Put this in <code>.env.local</code> (only the keys you have) and restart the relay. You can set up the name below first.
        </p>
        {nameInput}
        <CopyBlock text={setupEnvTemplate(draft)} />
        {providers}
      </SetupCard>
    );
  }

  return (
    <SetupCard
      id="setupStatus"
      index="01"
      title="Relay status"
      pill={<Pill tone={status.meterError ? "bad" : status.rootWarning ? "warn" : "ok"}>{status.meterError ? "Spend unavailable" : "Serving"}</Pill>}
      description={
        <>
          Relay for <b className="live-setup-mono">{status.root}</b>.
        </>
      }
    >
      {providers}
      <div className="live-setup-row">
        <span>Base URL</span>
        <b className="live-setup-mono">{status.baseUrl}</b>
      </div>
      {status.rootOwner !== undefined && (
        <div className="live-setup-row">
          <span>Root owner</span>
          {status.rootOwner ? (
            <a className="live-setup-mono" href={explorerAddress(status.rootOwner)} target="_blank" rel="noreferrer">
              {status.rootOwner}
            </a>
          ) : (
            <b>Not pinned</b>
          )}
        </div>
      )}
      {status.maxTokenTtlSec !== undefined && (
        <div className="live-setup-row">
          <span>Longest agent token</span>
          <b>{formatTtl(status.maxTokenTtlSec)}</b>
        </div>
      )}
      {status.rejectedRequests !== undefined && (
        <div className="live-setup-row">
          <span>Refused before sign-in</span>
          <b>{status.rejectedRequests} since start</b>
        </div>
      )}
      {status.dnsAlias && (
        <div className="live-setup-row">
          <span>DNS alias</span>
          <b className="live-setup-mono">
            {status.dnsAlias.from} → {status.dnsAlias.to}
          </b>
        </div>
      )}
      <div className="live-setup-row">
        <span>Spend and log</span>
        <b>
          {admin === "open" && "Open to anyone (development)"}
          {admin === "closed" && "Agents only"}
          {admin === "signed-in" && "Admin signed in"}
          {admin === "signed-out" && "Admin sign-in needed"}
          {admin === "unknown" && (status.viewAuth === "token" ? "Checking…" : "Unknown")}
        </b>
      </div>
      {status.viewAuth === "token" && (
        <p className="live-setup-muted">
          {/* A route handler that serves its own HTML, not a Next page, so it needs a full page load. */}
          <a href={ADMIN_SIGN_IN}>{admin === "signed-in" ? "Admin sign-out" : "Admin sign-in"}</a>
          {admin !== "signed-in" && " to see spend and the log here."}
        </p>
      )}
      {status.viewAuth === "closed" && <p className="live-setup-muted">Set RELAY_ADMIN_TOKEN on the relay to see spend and the log here.</p>}
      {status.rootWarning && <div className="form-hint">{status.rootWarning}</div>}
      {status.meterError && (
        <p className="form-error" role="alert">
          {status.meterError}
        </p>
      )}
    </SetupCard>
  );
}
