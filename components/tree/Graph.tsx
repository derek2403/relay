import { EMPTY_GRAPH, type OrgNodeView, type ProviderIndex, type TreeLayout } from "@/lib/view-model";
import { Connections } from "./Connections";
import { GraphNode } from "./GraphNode";
import { LevelLabels } from "./LevelLabels";

type GraphProps = {
  /** The drawn nodes; `layout` holds their positions. */
  nodes: readonly OrgNodeView[];
  layout: TreeLayout | null;
  /** The selected node and its ancestors. */
  path: ReadonlySet<string>;
  selectedId: string;
  /** Lower-case search text; other nodes are dimmed. */
  filter: string;
  providerIndex: ProviderIndex;
  zoom: number;
  /** Node whose provider list is open. */
  expandedId: string | null;
  onSelect: (id: string) => void;
  onToggleProviders: (id: string, trigger: HTMLButtonElement) => void;
};

export function Graph({ nodes, layout, path, selectedId, filter, providerIndex, zoom, expandedId, onSelect, onToggleProviders }: GraphProps) {
  const { width, height } = layout ?? EMPTY_GRAPH;
  return (
    <div className="graph" id="graph" style={{ width, height, zoom }}>
      <Connections nodes={nodes} layout={layout} path={path} width={width} height={height} />
      <div id="nodes">
        {layout && (
          <>
            {nodes.map((node) => {
              const position = layout.positions[node.id];
              if (!position) return null;
              return (
                <GraphNode
                  key={node.id}
                  node={node}
                  position={position}
                  selected={node.id === selectedId}
                  onPath={path.has(node.id)}
                  dimmed={Boolean(filter) && !node.fullName.includes(filter)}
                  providerIndex={providerIndex}
                  providersOpen={node.id === expandedId}
                  onSelect={onSelect}
                  onToggleProviders={onToggleProviders}
                />
              );
            })}
            <LevelLabels />
          </>
        )}
      </div>
    </div>
  );
}
