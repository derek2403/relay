"use client";

// Live Providers view: relay attestation, one card per catalog API (grouped by category) with
// its key status, owner-signed credential editing, and credential-only custom providers.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useLive } from "@/components/live/LiveContext";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";
import { CATALOG, type CatalogEntry, isListed } from "@/lib/relay/catalog";
import { apiErrorText, credentialsApi, statusOf, type CredentialsResponse, type CustomServiceView } from "./api";
import { AttestationCard } from "./Attestation";
import { CredentialDialog } from "./CredentialDialog";
import { CustomServiceDialog, type CustomDialogState } from "./CustomServiceDialog";
import { OwnerBar, useOwnerAuth } from "./OwnerAuth";
import {
  canManage,
  customPill,
  formatUpdated,
  groupCatalog,
  isKeyless,
  keysFor,
  markFor,
  secretDisplay,
  sharedWith,
  sourceText,
  statusPill,
  upstreamHost,
  type Pill,
} from "./logic";

export const CREDENTIALS_QUERY_KEY = ["relay-credentials"] as const;

type Props = {
  /** Bump to open the "Add a provider" dialog from outside (the page-heading action). */
  addRequest?: number;
};

export function ProvidersLiveView({ addRequest = 0 }: Props = {}) {
  const { status } = useLive();
  const queryClient = useQueryClient();
  const credsQuery = useQuery({
    queryKey: CREDENTIALS_QUERY_KEY,
    queryFn: credentialsApi.list,
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const creds = credsQuery.data;
  const reload = useCallback(() => queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY }), [queryClient]);
  const auth = useOwnerAuth(reload);

  const [editing, setEditing] = useState<CatalogEntry | null>(null);
  const [custom, setCustom] = useState<CustomDialogState | null>(null);
  const [seenAdd, setSeenAdd] = useState(addRequest);
  if (addRequest !== seenAdd) {
    setSeenAdd(addRequest);
    setCustom({ mode: "add" });
  }

  const authorized = canManage(creds);
  const configured = (entry: CatalogEntry): boolean | undefined => {
    const key = entry.keyEnv ? creds?.keys.find((k) => k.env === entry.keyEnv) : undefined;
    if (key) return key.set;
    return status?.providers.find((p) => p.id === entry.id)?.configured;
  };

  return (
    <div className="lp-view">
      <div className="lp-top">
        <AttestationCard />
        <article className="provider-card lp-owner-card">
          <span className="status-pill">{authorized ? "Owner" : "Read only"}</span>
          <h2>
            <span className="provider-logo">
              <Icon name="wallet" />
            </span>
            Credentials
          </h2>
          {credsQuery.isPending ? (
            <p>Reading credentials from the relay…</p>
          ) : credsQuery.error ? (
            <p className="form-error" role="alert">
              {statusOf(credsQuery.error) === 404
                ? "This relay doesn't serve a credentials API. Key status below comes from the relay status."
                : apiErrorText(credsQuery.error)}
            </p>
          ) : (
            <OwnerBar creds={creds} auth={auth} />
          )}
          <button type="button" className="secondary lp-add" onClick={() => setCustom({ mode: "add" })}>
            + Add a provider
          </button>
        </article>
      </div>

      {groupCatalog(CATALOG.filter((entry) => isListed(entry.id))).map((group) => (
        <section key={group.category} className="lp-group" aria-label={group.label}>
          <div className="lp-group-heading">
            <h3>{group.label}</h3>
            <span>
              {group.entries.length} {group.entries.length === 1 ? "API" : "APIs"}
            </span>
          </div>
          <div className="provider-grid lp-grid">
            {group.entries.map((entry) => (
              <CatalogCard
                key={entry.id}
                entry={entry}
                creds={creds}
                pill={statusPill(entry, configured(entry))}
                authorized={authorized}
                onEdit={() => {
                  auth.clearError();
                  setEditing(entry);
                }}
              />
            ))}
          </div>
        </section>
      ))}

      {creds && creds.custom.length > 0 && (
        <section className="lp-group" aria-label="Custom">
          <div className="lp-group-heading">
            <h3>Custom</h3>
            <span>Stored · not routed</span>
          </div>
          <div className="provider-grid lp-grid">
            {creds.custom.map((service) => (
              <CustomCard key={service.id} service={service} authorized={authorized} onEdit={() => setCustom({ mode: "edit", service })} />
            ))}
          </div>
        </section>
      )}

      <CredentialDialog entry={editing} creds={creds} auth={auth} reload={reload} onClose={() => setEditing(null)} />
      <CustomServiceDialog state={custom} creds={creds} auth={auth} reload={reload} onClose={() => setCustom(null)} />
    </div>
  );
}

function StatusPill({ pill }: { pill: Pill }) {
  return <span className={cx("status-pill", "lp-pill", `lp-${pill.tone}`)}>{pill.text}</span>;
}

type CardProps = {
  entry: CatalogEntry;
  creds: CredentialsResponse | undefined;
  pill: Pill;
  authorized: boolean;
  onEdit: () => void;
};

function CatalogCard({ entry, creds, pill, authorized, onEdit }: CardProps) {
  const keys = entry.keyEnv ? keysFor(entry, creds?.keys) : [];
  const shared = sharedWith(entry);
  const main = keys.find((k) => k.env === entry.keyEnv);
  return (
    <article className={cx("provider-card", "lp-card", entry.id === "codex" && "lp-featured")}>
      <StatusPill pill={pill} />
      <h2>
        <span className="provider-logo">
          <Icon name={markFor(entry.id)} />
        </span>
        {entry.label}
      </h2>
      {isKeyless(entry) ? (
        <>
          <div className="info-row">
            <span>Upstream</span>
            <b className="lp-mono">{upstreamHost(entry.upstream)}</b>
          </div>
          <div className="info-row">
            <span>Key</span>
            <b>None needed</b>
          </div>
          <div className="info-row">
            <span>Limits</span>
            <b>Requests · no $ cap</b>
          </div>
          {entry.note && <p>{entry.note}</p>}
        </>
      ) : !entry.keyEnv ? (
        <p>Answered by the relay itself. No key needed.</p>
      ) : (
        <>
          {keys.map((key) => (
            <div className="info-row" key={key.env}>
              <span className="lp-mono">{key.env}</span>
              <b className={cx(key.set && authorized && "lp-mono")}>{creds ? secretDisplay(key, authorized) : "—"}</b>
            </div>
          ))}
          {shared.length > 0 && (
            <div className="info-row">
              <span>Shared with</span>
              <b>{shared.join(", ")}</b>
            </div>
          )}
          {main?.set && main.source && (
            <div className="info-row">
              <span>Source</span>
              <b>{sourceText(main.source)}</b>
            </div>
          )}
          {creds && (
            <div className="info-row">
              <span>Updated</span>
              <b>{formatUpdated(main?.updatedAt)}</b>
            </div>
          )}
          {entry.note && <p>{entry.note}</p>}
          <button type="button" className="detail-button lp-edit" onClick={onEdit}>
            Edit credentials
          </button>
        </>
      )}
    </article>
  );
}

function CustomCard({ service, authorized, onEdit }: { service: CustomServiceView; authorized: boolean; onEdit: () => void }) {
  return (
    <article className="provider-card lp-card">
      <StatusPill pill={customPill(service.set)} />
      <h2>
        <span className="provider-logo">
          <Icon name="shield" />
        </span>
        {service.label}
      </h2>
      <div className="info-row">
        <span>API key</span>
        <b className={cx(service.set && authorized && "lp-mono")}>{secretDisplay({ ...service, secret: true }, authorized)}</b>
      </div>
      <div className="info-row">
        <span>Updated</span>
        <b>{formatUpdated(service.updatedAt)}</b>
      </div>
      <p>Stored on the relay only. Agents can't call it through the relay.</p>
      <button type="button" className="detail-button lp-edit" onClick={onEdit}>
        Edit credentials
      </button>
    </article>
  );
}
