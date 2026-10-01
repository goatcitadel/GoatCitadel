import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

function clampPaneWidth(value: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
}

export function useHorizontalPaneResize({
  direction,
  initialWidth,
  maxWidth,
  minWidth,
}: {
  direction: "left" | "right";
  initialWidth: number;
  maxWidth: number;
  minWidth: number;
}) {
  const [width, setWidth] = useState(initialWidth);
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const resizeBy = useCallback(
    (delta: number) => {
      setWidth((current) => clampPaneWidth(current + delta, minWidth, maxWidth));
    },
    [maxWidth, minWidth],
  );

  const reset = useCallback(() => {
    setWidth(initialWidth);
  }, [initialWidth]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || typeof window === "undefined" || window.innerWidth < 1024) {
        return;
      }
      dragStateRef.current = {
        pointerId: event.pointerId,
        startWidth: width,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging(true);
      event.preventDefault();
    },
    [width],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        resizeBy(-24);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        resizeBy(24);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setWidth(minWidth);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setWidth(maxWidth);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        reset();
      }
    },
    [maxWidth, minWidth, reset, resizeBy],
  );

  useEffect(() => {
    if (!dragging || typeof window === "undefined") {
      return undefined;
    }
    const eventTarget = window;

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      const deltaX = event.clientX - dragState.startX;
      const directedDelta = direction === "right" ? deltaX : -deltaX;
      setWidth(clampPaneWidth(dragState.startWidth + directedDelta, minWidth, maxWidth));
    };

    const handlePointerUp = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      dragStateRef.current = null;
      setDragging(false);
    };

    eventTarget.addEventListener("pointermove", handlePointerMove);
    eventTarget.addEventListener("pointerup", handlePointerUp);
    eventTarget.addEventListener("pointercancel", handlePointerUp);
    return () => {
      eventTarget.removeEventListener("pointermove", handlePointerMove);
      eventTarget.removeEventListener("pointerup", handlePointerUp);
      eventTarget.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [direction, dragging, maxWidth, minWidth]);

  return {
    dragging,
    handleKeyDown,
    handlePointerDown,
    reset,
    width,
  };
}

export function PaneResizeHandle({
  ariaLabel,
  className,
  dragging,
  maxWidth,
  minWidth,
  onDoubleClick,
  onKeyDown,
  onPointerDown,
  width,
}: {
  ariaLabel: string;
  className: string;
  dragging: boolean;
  maxWidth: number;
  minWidth: number;
  onDoubleClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  width: number;
}) {
  return (
    <button
      type="button"
      role="separator"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemax={maxWidth}
      aria-valuemin={minWidth}
      aria-valuenow={Math.round(width)}
      className={`mc-next-threaded-resize-handle ${className}${dragging ? " dragging" : ""}`}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      title="Drag to resize. Double-click to reset."
    />
  );
}
