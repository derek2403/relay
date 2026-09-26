import { cx } from "@/lib/cx";
import { connectorPath, type OrgNodeView, type TreeLayout } from "@/lib/view-model";

type ConnectionsProps = {
  nodes: readonly OrgNodeView[];
  layout: TreeLayout | null;
  path: ReadonlySet<string>;
  width: number;
  height: number;
};

export function Connections({ nodes, layout, path, width, height }: ConnectionsProps) {
  return (
    <svg className="connections" id="connections" width={width} height={height} aria-hidden="true">
      {layout &&
        nodes.map((node) => {
          const from = node.parentId ? layout.positions[node.parentId] : undefined;
          const to = layout.positions[node.id];
          if (!from || !to) return null;
          const className = cx(path.has(node.id) && "onpath", node.status !== "Active" && "off");
          return <path key={node.id} className={className} d={connectorPath(from, to)} />;
        })}
    </svg>
  );
}
