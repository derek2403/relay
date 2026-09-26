"use client";

import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";
import { type ProviderId, catalogEntry } from "@/lib/relay/catalog";
import type { LevelView } from "@/lib/relay/types";

import { heldText, markFor, usageLines } from "./model";

/** How much of one API a level has used this period (SRC ProviderUsage), in the detail panel's usage style. */
export function ProviderUsage({ level, provider, dim = false }: { level: LevelView; provider: ProviderId; dim?: boolean }) {
  const lines = usageLines(level, provider);
  const held = heldText(level, provider);
  return (
    <div className={cx("agents-usage", dim && "dim")}>
      <div className="provider-label">
        <span>
          <i className="provider-logo">
            <Icon name={markFor(provider)} />
          </i>
          {catalogEntry(provider).label}
        </span>
      </div>
      {lines.map((line) => (
        <div key={line.text} className="agents-usage-line">
          <span className="usage-caption">
            <span>{line.text}</span>
          </span>
          {line.pct !== null && (
            <div className={cx("usage-track", "agents-track", line.tone)} role="meter" aria-valuenow={line.pct} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: `${line.pct}%` }}></i>
            </div>
          )}
        </div>
      ))}
      {held && <small className="agents-held">{held}</small>}
    </div>
  );
}
