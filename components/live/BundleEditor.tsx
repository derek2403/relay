"use client";

import { ChainGrantEditor, type ChainGrantEditorProps } from "@/components/live/chain/ChainGrantEditor";
import { Icon } from "@/components/ui/Icon";
import { type BundleEditorModel, PERIOD_LABELS, bundleEditorModel, levelsAbove, setCap, setMax, setPeriod, toggleKey } from "@/lib/live-bundle-editor";
import type { BundleDraft, LevelBundle } from "@/lib/relay/browser";
import { type Bundle, PERIODS, type Period } from "@/lib/relay/bundle";

export type BundleEditorProps = {
  value: BundleDraft;
  onChange: (next: BundleDraft) => void;
  /** Bundle of the level above, for defaults and warnings ("blocked above", "parent caps it at $X / N"). */
  parent?: Bundle | null;
  parentName?: string;
  /**
   * Every level above, company first (SRC semantics; wins over `parent`): undefined for the company itself,
   * null while loading. A level with a null bundle allows nothing (the relay's default deny).
   */
  above?: LevelBundle[] | null;
  /** Hide the period select (e.g. sessions fix it to "total"). */
  fixedPeriod?: boolean;
  /** Fieldset legend; defaults to "API permissions". */
  legend?: string;
  /** Locks every input (e.g. while a transaction is running). */
  disabled?: boolean;
  /** Adds the "Blockchain (MultiBaas)" section (the relay.chain grant, written with the bundle). */
  chain?: ChainGrantEditorProps;
};

/** Catalog checkboxes with $ caps (dollarCaps APIs only), count caps (relay.max.*), and the period — SRC BundleEditor semantics. */
export function BundleEditor({ value, onChange, parent, parentName, above, fixedPeriod, legend = "API permissions", disabled, chain }: BundleEditorProps) {
  const model: BundleEditorModel = bundleEditorModel(value, levelsAbove({ above, parent, parentName }));
  return (
    <fieldset className="bundle-editor live-bundle" disabled={disabled}>
      <legend>{legend}</legend>
      {model.loading && <p className="live-bundle-note">Checking what the levels above allow…</p>}
      {model.groups.map((group) => (
        <div key={group.category} className="live-bundle-group">
          <h4 className="live-bundle-category">{group.label}</h4>
          {group.rows.map((row) => (
            <div key={row.id} className={`permission-item live-bundle-row${row.on ? " on" : ""}`}>
              <label>
                <input type="checkbox" checked={row.on} onChange={(e) => onChange(toggleKey(value, row.id, e.target.checked))} />
                <Icon name={row.icon} />
                <span>{row.label}</span>
              </label>
              {row.showCap ? (
                <label className="limit-field" title="Dollar cap for the period (empty: no cap at this level)">
                  <span>$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={row.cap}
                    placeholder={row.capPlaceholder}
                    disabled={!row.on}
                    aria-label={`${row.label} dollar cap`}
                    onChange={(e) => onChange(setCap(value, row.id, e.target.value))}
                  />
                </label>
              ) : (
                <span className="live-bundle-na" title="The relay can't price this API, so only a count limit applies.">
                  no $ cap
                </span>
              )}
              <label className="limit-field" title={`Most ${row.unit} for the period (empty: no limit at this level)`}>
                <input
                  type="text"
                  inputMode="numeric"
                  value={row.max}
                  placeholder={row.maxPlaceholder}
                  disabled={!row.on}
                  aria-label={`${row.label} ${row.unit} limit`}
                  onChange={(e) => onChange(setMax(value, row.id, e.target.value))}
                />
                <span>{row.unit}</span>
              </label>
              {row.notes.map((note) => (
                <small key={note} className="live-bundle-warning">
                  {note}
                </small>
              ))}
            </div>
          ))}
        </div>
      ))}
      {model.unavailable.map((line) => (
        <p key={line} className="live-bundle-note">
          {line}
        </p>
      ))}
      {fixedPeriod ? (
        <p className="live-bundle-note">Limits apply {PERIOD_LABELS[value.period]}.</p>
      ) : (
        <label className="live-bundle-period">
          <span>Limits reset</span>
          <select value={value.period} onChange={(e) => onChange(setPeriod(value, e.target.value as Period))}>
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="live-bundle-note">Empty = no cap at this level. Every level above is checked too.</p>
      {chain && <ChainGrantEditor {...chain} />}
    </fieldset>
  );
}
