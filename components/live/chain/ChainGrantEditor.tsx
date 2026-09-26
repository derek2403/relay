"use client";

// BundleEditor's "Blockchain (MultiBaas)" section: the relay.chain grant written with the bundle.
// Offers only what every level above allows (their intersection); the relay enforces it anyway.

import { useState } from "react";

import {
  type ChainDraft,
  GRANT_PERIODS,
  PERIOD_WORDS,
  type PathGrant,
  chainEditorModel,
  toggleCap,
  toggleContract,
  toggleMethod,
  toggleRecipient,
} from "./grant-model";

export type ChainGrantEditorProps = {
  value: ChainDraft;
  onChange: (next: ChainDraft) => void;
  /** The levels above: undefined for the company itself, null while loading. */
  above: PathGrant | null | undefined;
  /** Workspace recipient names → addresses (from the chain status), when known. */
  recipients?: Record<string, string>;
};

export function ChainGrantEditor({ value, onChange, above, recipients = {} }: ChainGrantEditorProps) {
  const model = chainEditorModel(value, above, recipients);
  const [custom, setCustom] = useState("");
  const set = (patch: Partial<ChainDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="chain-editor">
      <h4 className="live-bundle-category">Blockchain (MultiBaas)</h4>
      {model.loading ? (
        <p className="live-bundle-note">Checking what the levels above allow on chain…</p>
      ) : model.blocked && !value.on ? (
        <p className="live-bundle-note">No blockchain access to pass on: {model.blocked}.</p>
      ) : (
        <>
          <label className="chain-editor-toggle">
            <input type="checkbox" checked={value.on} onChange={(e) => set({ on: e.target.checked })} />
            <span>Give blockchain access (relay.chain)</span>
          </label>
          {value.on && (
            <div className="chain-editor-body">
              <fieldset className="chain-editor-group">
                <legend>Tools</legend>
                <div className="chain-editor-grid">
                  {model.caps.map((c) => (
                    <label key={c.id} title={c.hint}>
                      <input type="checkbox" checked={c.on} onChange={(e) => onChange(toggleCap(value, c.id, e.target.checked))} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="chain-editor-group">
                <legend>Contracts and write methods</legend>
                {model.contracts.map((k) => (
                  <div key={k.id} className="chain-editor-contract">
                    <label>
                      <input type="checkbox" checked={k.on} onChange={(e) => onChange(toggleContract(value, k.id, e.target.checked))} />
                      {k.label}
                    </label>
                    {k.on && k.methods.length > 0 && (
                      <span className="chain-editor-methods">
                        {k.methods.map((m) => (
                          <label key={m.id}>
                            <input type="checkbox" checked={m.on} onChange={(e) => onChange(toggleMethod(value, k.id, m.id, e.target.checked))} />
                            <span className="mono">{m.id}</span>
                          </label>
                        ))}
                      </span>
                    )}
                  </div>
                ))}
                <p className="live-bundle-note">Reads (view functions) of a ticked contract are always allowed with the Read tool.</p>
              </fieldset>
              <fieldset className="chain-editor-group">
                <legend>Approved recipients</legend>
                {model.recipients.length === 0 && <p className="live-bundle-note">None yet: payments are refused until one is approved.</p>}
                <div className="chain-editor-grid">
                  {model.recipients.map((r) => (
                    <label key={r.id}>
                      <input type="checkbox" checked={r.on} onChange={(e) => onChange(toggleRecipient(value, r.id, e.target.checked))} />
                      <span className="mono">{r.label}</span>
                    </label>
                  ))}
                </div>
                <div className="chain-editor-custom">
                  <input value={custom} placeholder="0x… address" aria-label="Custom recipient address" spellCheck={false} onChange={(e) => setCustom(e.target.value)} />
                  <button
                    type="button"
                    className="secondary"
                    disabled={!/^0x[0-9a-fA-F]{40}$/.test(custom.trim())}
                    onClick={() => {
                      onChange(toggleRecipient(value, custom.trim(), true));
                      setCustom("");
                    }}
                  >
                    Add
                  </button>
                </div>
              </fieldset>
              <div className="chain-editor-limits">
                <label className="limit-field">
                  <span>Per tx</span>
                  <input value={value.max} inputMode="decimal" placeholder={model.placeholders.max} aria-label="Per-transaction max (STD)" onChange={(e) => set({ max: e.target.value })} />
                  <span>STD</span>
                </label>
                <label className="limit-field">
                  <span>Limit</span>
                  <input value={value.limit} inputMode="decimal" placeholder={model.placeholders.limit} aria-label="Aggregate limit (STD)" onChange={(e) => set({ limit: e.target.value })} />
                  <select value={value.period} aria-label="Limit period" onChange={(e) => set({ period: e.target.value as ChainDraft["period"] })}>
                    {GRANT_PERIODS.map((p) => (
                      <option key={p} value={p}>
                        STD {PERIOD_WORDS[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="limit-field">
                  <span>Gas</span>
                  <input value={value.gas} inputMode="numeric" placeholder={model.placeholders.gas} aria-label="Max gas per transaction" onChange={(e) => set({ gas: e.target.value })} />
                </label>
                <label className="limit-field">
                  <span>Ends in</span>
                  <input value={value.days} inputMode="numeric" placeholder="never" aria-label="Grant expiry in days" onChange={(e) => set({ days: e.target.value })} />
                  <span>days</span>
                </label>
              </div>
              <div className="chain-editor-limits">
                <label className="limit-field">
                  <span>Approval</span>
                  <select value={value.approve} aria-label="Approval rule" onChange={(e) => set({ approve: e.target.value as ChainDraft["approve"] })}>
                    <option value="always">a human approves every tx</option>
                    <option value="above">a human approves above…</option>
                    <option value="never">no human approval</option>
                  </select>
                  {value.approve === "above" && (
                    <>
                      <input value={value.approveAbove} inputMode="decimal" aria-label="Approval threshold (STD)" onChange={(e) => set({ approveAbove: e.target.value })} />
                      <span>STD</span>
                    </>
                  )}
                </label>
                <label className="chain-editor-toggle">
                  <input type="checkbox" checked={value.delegate} onChange={(e) => set({ delegate: e.target.checked })} />
                  <span>May grant narrower access below</span>
                </label>
              </div>
              {model.notes.map((n) => (
                <small key={n} className="live-bundle-warning chain-editor-warning">
                  {n}
                </small>
              ))}
            </div>
          )}
          {model.unavailable.map((line) => (
            <p key={line} className="live-bundle-note">
              {line}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
