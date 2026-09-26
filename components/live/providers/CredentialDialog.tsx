"use client";

// Edit one catalog API's credentials. Secrets are write-only: password inputs start empty
// (empty = keep), "Clear" deletes the stored value, and nothing typed is kept after saving.

import { useState, type FormEvent } from "react";
import { useLive } from "@/components/live/LiveContext";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import type { CatalogEntry } from "@/lib/relay/catalog";
import { apiErrorText, credentialsApi, type CredentialKeyView, type CredentialsResponse } from "./api";
import { signInLabel, type OwnerAuth } from "./OwnerAuth";
import { canManage, fieldValue, formatUpdated, isSecret, keysFor, markFor, planChanges, secretDisplay, sharedWith, sourceText } from "./logic";

type Props = {
  entry: CatalogEntry | null;
  creds: CredentialsResponse | undefined;
  auth: OwnerAuth;
  reload: () => Promise<unknown>;
  onClose: () => void;
};

export function CredentialDialog({ entry, creds, auth, reload, onClose }: Props) {
  return (
    <Dialog id="liveCredentialDialog" open={!!entry} onClose={onClose}>
      {entry && <CredentialForm key={entry.id} entry={entry} creds={creds} auth={auth} reload={reload} onClose={onClose} />}
    </Dialog>
  );
}

function CredentialForm({ entry, creds, auth, reload, onClose }: Props & { entry: CatalogEntry }) {
  const { address, refresh, log, toast } = useLive();
  const keys = keysFor(entry, creds?.keys);
  const authorized = canManage(creds);
  const shared = sharedWith(entry);
  // Only what the owner typed: plain settings (e.g. the Mailchimp URL) show their current value
  // through fieldValue, which may only arrive after signing in from this dialog.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changes = planChanges(keys, inputs, cleared);

  const toggleClear = (env: string) =>
    setCleared((current) => {
      const next = new Set(current);
      if (next.has(env)) next.delete(env);
      else next.add(env);
      return next;
    });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!changes.length) return;
    setError("");
    setSaving(true);
    try {
      for (const change of changes) {
        if (change.action === "put") await credentialsApi.putKey(change.env, change.value);
        else await credentialsApi.clearKey(change.env);
      }
      // Drop everything typed before anything re-renders with the new state.
      setInputs({});
      setCleared(new Set());
      await reload();
      await refresh();
      log("Credentials saved", `${entry.label}: ${changes.map((c) => `${c.env} ${c.action === "put" ? "set" : "cleared"}`).join(", ")}.`);
      toast("Saved on the relay.");
      onClose();
    } catch (failure) {
      setError(apiErrorText(failure));
      await reload().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} autoComplete="off">
      <div className="dialog-heading">
        <h2 className="lp-dialog-title">
          <span className="provider-logo">
            <Icon name={markFor(entry.id)} />
          </span>
          {entry.label}
        </h2>
        <button type="button" className="icon-button close-dialog" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="dialog-description">
        Keys are encrypted on the relay and never shown again. Leave a key empty to keep it.
      </p>
      {shared.length > 0 && entry.keyEnv && (
        <div className="form-hint">
          <code>{entry.keyEnv}</code> is also used by {shared.join(", ")}. Changing it here changes it there too.
        </div>
      )}

      {!creds ? (
        <p className="form-error" role="alert">
          The relay's credentials API is not reachable.
        </p>
      ) : !creds.secretConfigured ? (
        <div className="form-hint">
          Credential editing is off. Set <code>RELAY_SECRET</code> on the relay and restart it.
        </div>
      ) : !authorized ? (
        <>
          <div className="form-hint">
            Only the wallet that owns the company root can edit credentials. Sign in with it; your wallet asks you to sign a short
            message. No transaction is sent.
          </div>
          {auth.error && (
            <p className="form-error" role="alert">
              {auth.error}
            </p>
          )}
          <div className="dialog-footer">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={!!auth.busy} onClick={() => void auth.signIn()}>
              {signInLabel(auth, !!address)}
            </button>
          </div>
        </>
      ) : null}

      {creds?.secretConfigured && authorized && (
        <>
          {keys.map((key) => (
            <KeyField
              key={key.env}
              field={key}
              value={fieldValue(key, inputs)}
              cleared={cleared.has(key.env)}
              disabled={saving}
              onChange={(value) => setInputs((current) => ({ ...current, [key.env]: value }))}
              onToggleClear={() => toggleClear(key.env)}
            />
          ))}
          {entry.note && <div className="form-hint">{entry.note}</div>}
          <p className="form-error" role="alert">
            {error}
          </p>
          <div className="dialog-footer">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={saving || changes.length === 0}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

type KeyFieldProps = {
  field: CredentialKeyView;
  value: string;
  cleared: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onToggleClear: () => void;
};

function KeyField({ field, value, cleared, disabled, onChange, onToggleClear }: KeyFieldProps) {
  const secret = isSecret(field);
  const inputId = `lp-field-${field.env}`;
  const current = secretDisplay(field, true);
  return (
    <div className="lp-field">
      <label htmlFor={inputId}>
        {field.label}
        <small>
          <code>{field.env}</code> · {current}
          {field.set && field.source ? ` · ${sourceText(field.source)}` : ""}
          {field.updatedAt ? ` · ${formatUpdated(field.updatedAt)}` : ""}
        </small>
      </label>
      <div className="lp-field-row">
        <input
          id={inputId}
          type={secret ? "password" : "text"}
          autoComplete={secret ? "new-password" : "off"}
          spellCheck={false}
          placeholder={cleared ? "Will be cleared" : secret && field.set ? "Leave empty to keep" : field.placeholder || (secret ? "Paste the key" : "")}
          value={cleared ? "" : value}
          disabled={disabled || cleared}
          onChange={(event) => onChange(event.target.value)}
        />
        {field.set && field.source !== "env" && (
          <button type="button" className="secondary" disabled={disabled} onClick={onToggleClear}>
            {cleared ? "Undo" : "Clear"}
          </button>
        )}
      </div>
      {field.source === "env" && (
        <small className="lp-field-note">Comes from the relay's environment. Saving here overrides it.</small>
      )}
    </div>
  );
}
