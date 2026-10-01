import { useCallback, useEffect, useRef, type PointerEvent } from "react";
export const INSPECTOR_MIN_WIDTH = 360;
export const INSPECTOR_MAX_WIDTH = 480;
export function clampInspectorWidth(value: number) { return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, value)); }

export function InspectorResizeHandle({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const drag = useRef<{ id: number; x: number; width: number; element: HTMLDivElement } | null>(null);
  const stop = useCallback(() => {
    const current = drag.current; drag.current = null;
    if (current?.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id);
  }, []);
  useEffect(() => stop, [stop]);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current && current.id === event.pointerId) onChange(clampInspectorWidth(current.width + current.x - event.clientX));
  };
  return <div role="separator" aria-label="Resize inspector" aria-orientation="vertical" tabIndex={0}
    aria-valuemin={INSPECTOR_MIN_WIDTH} aria-valuemax={INSPECTOR_MAX_WIDTH} aria-valuenow={width}
    aria-valuetext={`${width} pixels`} className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none rounded focus-visible:outline-2 focus-visible:outline-accent"
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.currentTarget.focus();
      drag.current = { id: event.pointerId, x: event.clientX, width, element: event.currentTarget };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={(event) => {
      const next = event.key === "ArrowLeft" ? width + 8 : event.key === "ArrowRight" ? width - 8
        : event.key === "Home" ? INSPECTOR_MIN_WIDTH : event.key === "End" ? INSPECTOR_MAX_WIDTH : null;
      if (next !== null) { event.preventDefault(); onChange(clampInspectorWidth(next)); }
    }} />;
}
