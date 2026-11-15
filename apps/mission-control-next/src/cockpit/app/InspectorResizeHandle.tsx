import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import { clampInspectorWidth, INSPECTOR_MAX_WIDTH, INSPECTOR_MIN_WIDTH } from "./inspector-width-preference";

export function InspectorResizeHandle({
  width,
  onChange,
  onCommit,
}: {
  width: number;
  onChange: (width: number) => void;
  /** Called once when a drag ends and after each keyboard step, so the width is stored once, not on every move. */
  onCommit?: (width: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; width: number; last: number; element: HTMLDivElement } | null>(null);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });
  const stop = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id);
    if (current && current.last !== current.width) commit.current?.(current.last);
  }, []);
  useEffect(() => stop, [stop]);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current && current.id === event.pointerId) {
      current.last = clampInspectorWidth(current.width + current.x - event.clientX);
      onChange(current.last);
    }
  };
  return (
    <div
      role="separator"
      aria-label="Resize inspector"
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuemin={INSPECTOR_MIN_WIDTH}
      aria-valuemax={INSPECTOR_MAX_WIDTH}
      aria-valuenow={width}
      aria-valuetext={`Inspector width: ${inspectorWidthName(width)}`}
      // A 24px hit area on the border, three quarters over the inspector so it covers less of the main pane (and its
      // scrollbar); the grip appears on hover and keyboard focus.
      className="group absolute inset-y-0 left-0 z-10 flex w-6 -translate-x-1/4 cursor-col-resize touch-none items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { id: event.pointerId, x: event.clientX, width, last: width, element: event.currentTarget };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? width + 8
            : event.key === "ArrowRight"
              ? width - 8
              : event.key === "Home"
                ? INSPECTOR_MIN_WIDTH
                : event.key === "End"
                  ? INSPECTOR_MAX_WIDTH
                  : null;
        if (next !== null) {
          event.preventDefault();
          onChange(clampInspectorWidth(next));
          onCommit?.(clampInspectorWidth(next));
        }
      }}
    >
      <span
        aria-hidden="true"
        className="h-10 w-1 rounded-full bg-line-strong opacity-40 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </div>
  );
}

function inspectorWidthName(width: number): string {
  const third = (INSPECTOR_MAX_WIDTH - INSPECTOR_MIN_WIDTH) / 3;
  if (width < INSPECTOR_MIN_WIDTH + third) return "narrow";
  return width < INSPECTOR_MAX_WIDTH - third ? "medium" : "wide";
}
