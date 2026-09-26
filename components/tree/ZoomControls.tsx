import { Icon } from "@/components/ui/Icon";

type ZoomControlsProps = {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
};

export function ZoomControls({ zoom, onZoomIn, onZoomOut, onFit }: ZoomControlsProps) {
  return (
    <div className="zoom">
      <button id="zoomOut" aria-label="Zoom out" onClick={onZoomOut}>
        <Icon name="minus" />
      </button>
      <span id="zoomValue">{`${Math.round(zoom * 100)}%`}</span>
      <button id="zoomIn" aria-label="Zoom in" onClick={onZoomIn}>
        <Icon name="plus" />
      </button>
      <button id="fit" aria-label="Fit tree" title="Fit tree" onClick={onFit}>
        <Icon name="fit" />
      </button>
    </div>
  );
}
