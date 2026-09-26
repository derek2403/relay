import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";
import { ancestorIds, layoutTree, visibleNodes, type OrgNodeView, type ProviderIndex } from "@/lib/view-model";
import { Graph } from "./Graph";
import { ProviderPopover } from "./ProviderPopover";
import { TreeToolbar } from "./TreeToolbar";
import { useFitZoom } from "./useFitZoom";
import { ZoomControls } from "./ZoomControls";

type TreeViewProps = {
  /** Every node, revoked ones included (they are not drawn but can stay selected). */
  nodes: readonly OrgNodeView[];
  providerIndex: ProviderIndex;
  rootName: string;
  selectedId: string;
  onSelect: (id: string) => void;
  branch: string;
  onBranchChange: (branch: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Changing this number fits the tree to the canvas. */
  fitRequest: number;
  toolbarActions?: ReactNode;
  /** The detail panel beside the canvas. */
  details: ReactNode;
};

type OpenList = { nodeId: string; trigger: HTMLButtonElement };

export function TreeView({
  nodes,
  providerIndex,
  rootName,
  selectedId,
  onSelect,
  branch,
  onBranchChange,
  query,
  onQueryChange,
  fitRequest,
  toolbarActions,
  details,
}: TreeViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [openList, setOpenList] = useState<OpenList | null>(null);

  const visible = useMemo(() => visibleNodes(nodes, branch), [nodes, branch]);
  const layout = useMemo(() => {
    const root = visible.find((node) => node.parentId === null);
    return root ? layoutTree(visible, root.id) : null;
  }, [visible]);
  const path = useMemo(() => new Set(ancestorIds(nodes, selectedId)), [nodes, selectedId]);
  const branches = useMemo(() => nodes.filter((node) => node.type === "department"), [nodes]);
  const { zoom, fitted, fit, zoomIn, zoomOut } = useFitZoom(scrollRef, layout, fitRequest);

  // Redrawing the tree closes the provider list, which belongs to the node it was opened from.
  useLayoutEffect(() => {
    setOpenList(null);
  }, [nodes, selectedId, query, branch]);

  const toggleProviders = (nodeId: string, trigger: HTMLButtonElement) =>
    setOpenList((current) => (current?.nodeId === nodeId ? null : { nodeId, trigger }));
  const listNode = openList && visible.find((node) => node.id === openList.nodeId);

  return (
    <div className="tree-shell">
      <TreeToolbar
        rootName={rootName}
        branches={branches}
        branch={branch}
        onBranchChange={onBranchChange}
        query={query}
        onQueryChange={onQueryChange}
        actions={toolbarActions}
      />
      <div className="tree-body">
        <div className="graph-panel">
          <div className="graph-legend">
            <span>
              <i className="legend-line"></i>Inherited access
            </span>
            <span>
              <i className="legend-dot"></i>Selected path
            </span>
          </div>
          <div className={cx("graph-scroll", fitted && "is-fitted")} id="graphScroll" ref={scrollRef}>
            <Graph
              nodes={visible}
              layout={layout}
              path={path}
              selectedId={selectedId}
              filter={query.toLowerCase().trim()}
              providerIndex={providerIndex}
              zoom={zoom}
              expandedId={openList?.nodeId ?? null}
              onSelect={onSelect}
              onToggleProviders={toggleProviders}
            />
          </div>
          <div className="canvas-footer">
            <span>
              <i className="live-dot"></i>
              {" Permissions inherited from parent"}
            </span>
            <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fit} />
          </div>
        </div>
        {details}
      </div>
      <div className="tree-bottom">
        <span>
          <Icon name="shield" />
          <strong>Access only narrows.</strong>
          {" Children can never exceed their parent’s permissions."}
        </span>
      </div>
      {openList && listNode && (
        <ProviderPopover node={listNode} providerIndex={providerIndex} trigger={openList.trigger} onClose={() => setOpenList(null)} />
      )}
    </div>
  );
}
