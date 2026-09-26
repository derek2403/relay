import { useEffect, useEffectEvent, useLayoutEffect, useState, type RefObject } from "react";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.1;
const FIT_MARGIN = 24;

type Size = { width: number; height: number };

const clamp = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/**
 * Zoom of the tree canvas. While fitted, the tree is refitted whenever the canvas or the tree
 * changes size; zooming by hand stops that until the next fit. A new `fitRequest` value always fits.
 */
export function useFitZoom(scrollRef: RefObject<HTMLElement | null>, size: Size | null, fitRequest: number) {
  const [{ zoom, fitted }, setZoom] = useState({ zoom: 1, fitted: true });

  const fit = () => {
    const box = scrollRef.current;
    if (!box?.clientWidth || !size) return;
    const scale = Math.min(1, (box.clientWidth - FIT_MARGIN) / size.width, (box.clientHeight - FIT_MARGIN) / size.height);
    setZoom({ zoom: clamp(scale), fitted: true });
    box.scrollTo(0, 0);
  };

  const refit = useEffectEvent((force: boolean) => {
    if (force || fitted) fit();
  });

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => refit(false));
    observer.observe(box);
    return () => observer.disconnect();
  }, [scrollRef]);

  const width = size?.width;
  const height = size?.height;
  useLayoutEffect(() => {
    refit(false);
  }, [width, height]);

  useLayoutEffect(() => {
    refit(true);
  }, [fitRequest]);

  const zoomBy = (step: number) => setZoom((current) => ({ zoom: clamp(current.zoom + step), fitted: false }));

  return { zoom, fitted, fit, zoomIn: () => zoomBy(ZOOM_STEP), zoomOut: () => zoomBy(-ZOOM_STEP) };
}
