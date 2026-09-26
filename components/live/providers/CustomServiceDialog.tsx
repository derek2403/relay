"use client";

// "Add a provider" in live mode: a credential-only custom service. The relay stores the key
// encrypted and shows it redacted; it does not route calls to it.

import { useState, type FormEvent } from "react";
import { useLive } from "@/components/live/LiveContext";
import { Dialog } from "@/components/ui/Dialog";
import { apiErrorText, credentialsApi, type CredentialsResponse, type CustomServiceView } from "./api";
import { signInLabel, type OwnerAuth } from "./OwnerAuth";
import { canManage, formatUpdated, secretDisplay } from "./logic";

export type CustomDialogState = { mode: "add" } | { mode: "edit"; service: CustomServiceView };

type Props = {
  state: CustomDialogState | null;
  creds: CredentialsResponse | undefined;
  auth: OwnerAuth;
  reload: () => Promise<unknown>;
  onClose: () => void;
};

export function CustomServiceDialog({ state, ...rest }: Props) {
  return (
    <Dialog id="liveProviderDialog" open={!!state} onClose={rest.onClose}>
      {state && <CustomForm key={state.mode === "edit" ? state.service.id : "add"} state={state} {...rest} />}
    </Dialog>
  );
}

function CustomForm({ state, creds, auth, reload, onClose }: Props & { state: CustomDialogState }) {
  const { address, refresh, log, toast } = useLive();
  const editing = state.mode === "edit" ? state.service : null;
  const [label, setLabel] = useState(editing?.label ?? "");
  const [value, setValue] = useState("");
  const [note, setNote] = useState(editing?.note ?? "");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState("");
  const authorized = canManage(creds);

  const finish = async (title: string, detail: string, message: string) => {
    setValue("");
    await reload();
    await refresh();
    log(title, detail);
    toast(message);
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = label.trim();
    const key = value.trim();
    if (!name) return setError("Give the provider a name.");
    if (!editing && !key) return setError("Paste the API key.");
    setError("");
    setBusy("save");
    try {
      if (editing) {
        const body: { label?: string; value?: string; note?: string | null } = {};
        if (name !== editing.label) body.label = name;
        if (key) body.value = key;
        if (note.trim() !== (editing.note ?? "")) body.note = note.trim() || null;
        if (Object.keys(body).length === 0) return onClose();
        await credentialsApi.putCustom(editing.id, body);
        await finish("Provider updated", `${name}: stored on the relay, not routed.`, "Saved on the relay.");
      } else {
        await credentialsApi.addCustom(note.trim() ? { label: name, value: key, note: note.trim() } : { label: name, value: key });
        await finish("Provider added", `${name}: stored on the relay, not routed.`, `${name} added. Stored, not routed.`);
      }
    } catch (failure) {
      setError(apiErrorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!editing) return;
    setError("");
    setBusy("remove");
    try {
      await credentialsApi.clearCustom(editing.id);
      await finish("Provider removed", `${editing.label}: key deleted from the relay.`, `${editing.label} removed.`);
    } catch (failure) {
      setError(apiErrorText(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form onSubmit={submit} autoComplete="off">
      <div className="dialog-heading">
        <h2>{editing ? "Edit provider" : "Add provider"}</h2>
        <button type="button" className="icon-button close-dialog" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="dialog-description">
        Store a key for a service the relay does not route yet. It is encrypted on the relay and shown only as a hint.
      </p>

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
          <div className="form-hint">Only the wallet that owns the company root can add providers. Sign in with it first.</div>
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
      ) : (
        <>
          <label>
            Provider name
            <input required maxLength={40} placeholder="e.g. Perplexity" value={label} disabled={!!busy} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            API key
            {editing && (
              <small>
                {secretDisplay({ ...editing, secret: true }, true)}
                {editing.updatedAt ? ` · ${formatUpdated(editing.updatedAt)}` : ""}
              </small>
            )}
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={editing ? "Leave empty to keep" : "Paste the key"}
              value={value}
              disabled={!!busy}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <label>
            Base URL or note <small>Optional, not secret.</small>
            <input maxLength={200} placeholder="e.g. https://api.perplexity.ai" value={note} disabled={!!busy} onChange={(e) => setNote(e.target.value)} />
          </label>
          <p className="form-error" role="alert">
            {error}
          </p>
          <div className="form-hint">Stored only. Agents can't call it through the relay, and it can't be added to anyone's limits.</div>
          <div className="dialog-footer">
            {editing && (
              <button type="button" className="danger lp-remove" disabled={!!busy} onClick={() => void remove()}>
                {busy === "remove" ? "Removing…" : "Remove"}
              </button>
            )}
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={!!busy}>
              {busy === "save" ? "Saving…" : editing ? "Save" : "Add provider"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
