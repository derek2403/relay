import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import type { MetricsView } from "@/lib/view-model";

type MetricsProps = {
  metrics: MetricsView;
  /** Shows the "Manage" button on the API catalog metric. */
  onManageProviders?: () => void;
};

function MetricLabel({ label, icon, children }: { label: string; icon: string; children?: ReactNode }) {
  return (
    <span>
      {`${label} `}
      <span className="metric-icon">
        <Icon name={icon} />
      </span>
      {children}
    </span>
  );
}

export function Metrics({ metrics, onManageProviders }: MetricsProps) {
  return (
    <div className="metrics">
      <div className="metric">
        <MetricLabel label="Active identities" icon="tree" />
        <div>
          <strong id="activeCount">{metrics.activeIdentities}</strong>
          <small>{metrics.identitiesCaption}</small>
        </div>
      </div>
      <div className="metric">
        <MetricLabel label="API catalog" icon="providers">
          {onManageProviders && (
            <button id="addProvider" className="add-provider" aria-label="Manage provider catalog" onClick={onManageProviders}>
              Manage
            </button>
          )}
        </MetricLabel>
        <div>
          <strong id="providerCount">{metrics.providerCount}</strong>
          <small className="provider-mini" id="providerMini">
            {metrics.featuredProviders.map((provider) => (
              <i key={provider.id} className="provider-logo" title={provider.name}>
                <Icon name={provider.mark} />
              </i>
            ))}
          </small>
        </div>
      </div>
      <div className="metric">
        <MetricLabel label="Estimated usage" icon="chart" />
        <div>
          <strong id="totalUsage">{metrics.usageLabel}</strong>
          <small>{metrics.usageCaption}</small>
        </div>
        <div className="metric-bar">
          <i></i>
        </div>
      </div>
      <div className="metric">
        <MetricLabel label="Active agent sessions" icon="clock" />
        <div>
          <strong id="agentCount">{metrics.agentSessions}</strong>
          <small id="subagentSummary">{metrics.sessionsCaption}</small>
        </div>
      </div>
    </div>
  );
}
