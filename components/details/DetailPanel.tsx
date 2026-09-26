import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";
import { formatExpiry, nodeIcon, providerOf, shortAddress, type GrantView, type OrgNodeView, type ProviderIndex } from "@/lib/view-model";

type DetailPanelProps = {
  node: OrgNodeView | null;
  grants: readonly GrantView[];
  /** Label of the parent node; null for the root. */
  parentLabel: string | null;
  providerIndex: ProviderIndex;
  /** Text after the shield icon, under the info rows. */
  note: string;
  /** Mode-specific buttons at the bottom of the panel. */
  actions?: ReactNode;
  onSelectParent: () => void;
};

function GrantRow({ grant, providerIndex }: { grant: GrantView; providerIndex: ProviderIndex }) {
  const provider = providerOf(providerIndex, grant.providerId);
  return (
    <div className="provider-row">
      <div className="provider-label">
        <span>
          <i className="provider-logo">
            <Icon name={provider.mark} />
          </i>
          {provider.name}
        </span>
        <b>{grant.limitLabel}</b>
      </div>
      {grant.usage && (
        <>
          <div className="usage-track">
            <i style={{ width: `${grant.usage.pct}%` }}></i>
          </div>
          <div className="usage-caption">
            <span>{`${grant.usage.usedLabel} used`}</span>
            <span>{`${grant.usage.leftLabel} left`}</span>
          </div>
        </>
      )}
      <small className="api-status">{grant.note}</small>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

export function DetailPanel({ node, grants, parentLabel, providerIndex, note, actions, onSelectParent }: DetailPanelProps) {
  return (
    <aside id="details" className="detail-panel" aria-label="Selected identity details">
      {node && (
        <>
          <div className="detail-topline">
            {`${node.type.toUpperCase()} DETAILS `}
            <span className={cx("status-pill", node.status !== "Active" && "revoked")}>{node.status}</span>
          </div>
          <div className="detail-icon">
            <Icon name={nodeIcon(node.type)} />
          </div>
          <h2>{node.label}</h2>
          <div className="full-name">{node.fullName}</div>
          <div className="owner-row">
            <span>Owner wallet</span>
            <b title={node.owner}>{shortAddress(node.owner)}</b>
          </div>
          <div className="detail-section">
            <div className="detail-section-title">
              {"API permissions "}
              <span>{`${grants.length} ${grants.length === 1 ? "API" : "APIs"}`}</span>
            </div>
            {grants.map((grant) => (
              <GrantRow key={grant.providerId} grant={grant} providerIndex={providerIndex} />
            ))}
          </div>
          <div className="detail-section">
            <InfoRow label="Parent">
              {parentLabel === null ? (
                <b>Root</b>
              ) : (
                <button id="selectParent" className="parent-link" onClick={onSelectParent}>
                  {parentLabel}
                </button>
              )}
            </InfoRow>
            <InfoRow label="Budget period">
              <b>{node.periodLabel}</b>
            </InfoRow>
            <InfoRow label="Expiry">
              <b>{formatExpiry(node.expiry)}</b>
            </InfoRow>
            <InfoRow label="Descendants">
              <b>{node.descendantCount}</b>
            </InfoRow>
          </div>
          <div className="inherited-note">
            <Icon name="shield" />
            {` ${note}`}
          </div>
          {actions}
        </>
      )}
    </aside>
  );
}
