import type { KeyboardEvent } from "react";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";
import { nodeIcon, type OrgNodeView, type Point, type ProviderIndex } from "@/lib/view-model";
import { ProviderCircles } from "./ProviderCircles";

type GraphNodeProps = {
  node: OrgNodeView;
  position: Point;
  selected: boolean;
  onPath: boolean;
  dimmed: boolean;
  providerIndex: ProviderIndex;
  providersOpen: boolean;
  onSelect: (id: string) => void;
  onToggleProviders: (id: string, trigger: HTMLButtonElement) => void;
};

export function GraphNode({ node, position, selected, onPath, dimmed, providerIndex, providersOpen, onSelect, onToggleProviders }: GraphNodeProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onSelect(node.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={cx("node", selected && "selected", onPath && "path-parent", node.status !== "Active" && "revoked", dimmed && "match-dim", node.aliasOf && "alias")}
      style={{ left: position.x, top: position.y }}
      aria-label={`${node.fullName}, ${node.aliasOf ? `alias of ${node.aliasOf}` : node.type}`}
      aria-pressed={selected}
      onClick={() => onSelect(node.id)}
      onKeyDown={onKeyDown}
    >
      <div className="node-top">
        <span className="node-icon">
          <Icon name={nodeIcon(node.type)} />
        </span>
        <span className="node-name">{node.label}</span>
        <span className="node-status"></span>
      </div>
      <div className="node-sub" title={node.aliasOf ? `${node.fullName}: alias of ${node.aliasOf}` : node.fullName}>
        {node.aliasOf ? `alias of ${node.aliasOf}` : node.fullName}
      </div>
      <div className="node-foot provider-stack">
        <ProviderCircles
          ids={node.providers}
          ownerLabel={node.label}
          providerIndex={providerIndex}
          expanded={providersOpen}
          onToggle={(trigger) => onToggleProviders(node.id, trigger)}
        />
      </div>
      <i className="node-port"></i>
    </div>
  );
}
