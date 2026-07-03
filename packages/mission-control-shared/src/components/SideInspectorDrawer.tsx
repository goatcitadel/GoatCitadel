import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useMediaQuery } from "../hooks/useMediaQuery";

/**
 * Below this viewport width the drawer docks as a bottom sheet (see
 * `.mc-next-shell-inspector.side-inspector-drawer` in mission-control-next.css)
 * and drag is fully disabled. Keep this in sync with the `@media (max-width: ...)`
 * rule that sets `transform: none` on the docked drawer.
 */
export const SIDE_INSPECTOR_DOCKED_MAX_WIDTH = 1180;

interface SideInspectorDrawerProps {
  title: string;
  kicker?: string;
  subtitle?: ReactNode;
  open?: boolean;
  pinned?: boolean;
  className?: string;
  actions?: ReactNode;
  onClose?: () => void;
  onTogglePinned?: () => void;
  draggable?: boolean;
  children: ReactNode;
}

export function SideInspectorDrawer({
  title,
  kicker,
  subtitle,
  open = true,
  pinned = false,
  className,
  actions,
  onClose,
  onTogglePinned,
  draggable = false,
  children,
}: SideInspectorDrawerProps) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    startLeft: number;
    startTop: number;
    width: number;
    height: number;
  } | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const isDocked = useMediaQuery(`(max-width: ${SIDE_INSPECTOR_DOCKED_MAX_WIDTH}px)`);
  const dragEnabled = draggable && open && !isDocked;
  const style = useMemo<CSSProperties | undefined>(
    () =>
      dragEnabled
        ? ({
            "--side-inspector-drag-x": `${dragOffset.x}px`,
            "--side-inspector-drag-y": `${dragOffset.y}px`,
          } as CSSProperties)
        : undefined,
    [dragEnabled, dragOffset.x, dragOffset.y],
  );

  const resetDragState = useCallback(() => {
    dragStateRef.current = null;
    setDragging(false);
    setDragOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!open) {
      resetDragState();
    }
  }, [open, resetDragState]);

  useEffect(() => {
    // Crossing into the docked range (e.g. resizing the window mid-drag) must
    // clear any accumulated offset so resizing back above the breakpoint
    // doesn't restore a surprising off-screen position.
    if (isDocked) {
      resetDragState();
    }
  }, [isDocked, resetDragState]);

  useEffect(() => {
    if (!dragEnabled || !dragging) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      const minLeft = 16;
      const minTop = 16;
      const maxLeft = Math.max(minLeft, window.innerWidth - dragState.width - 16);
      const maxTop = Math.max(minTop, window.innerHeight - dragState.height - 16);
      const nextLeft = Math.min(maxLeft, Math.max(minLeft, dragState.startLeft + deltaX));
      const nextTop = Math.min(maxTop, Math.max(minTop, dragState.startTop + deltaY));
      setDragOffset({
        x: dragState.originX + (nextLeft - dragState.startLeft),
        y: dragState.originY + (nextTop - dragState.startTop),
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }
      dragStateRef.current = null;
      setDragging(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dragEnabled, dragging]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragEnabled || event.button !== 0) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("button, a, input, select, textarea, [role='button']")) {
        return;
      }
      const rect = drawerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: dragOffset.x,
        originY: dragOffset.y,
        startLeft: rect.left,
        startTop: rect.top,
        width: rect.width,
        height: rect.height,
      };
      setDragging(true);
      event.preventDefault();
    },
    [dragEnabled, dragOffset.x, dragOffset.y],
  );

  const handleDoubleClick = useCallback(() => {
    if (!dragEnabled) {
      return;
    }
    resetDragState();
  }, [dragEnabled, resetDragState]);

  return (
    <aside
      ref={drawerRef}
      style={style}
      className={`side-inspector-drawer${open ? " open" : " closed"}${pinned ? " pinned" : ""}${dragEnabled ? " draggable" : ""}${dragging ? " dragging" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden={!open}
    >
      <div className="side-inspector-drawer-head" onPointerDown={handlePointerDown} onDoubleClick={handleDoubleClick}>
        <div className="side-inspector-drawer-copy">
          {kicker ? <p className="side-inspector-drawer-kicker">{kicker}</p> : null}
          <h3 className="side-inspector-drawer-title">{title}</h3>
          {subtitle ? <div className="side-inspector-drawer-subtitle">{subtitle}</div> : null}
        </div>
        <div className="side-inspector-drawer-actions">
          {actions}
          {onTogglePinned ? (
            <button type="button" className="gc-nav-button gc-nav-tier-chip" onClick={onTogglePinned}>
              {pinned ? "Unpin" : "Pin"}
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className="gc-nav-button gc-nav-tier-chip" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
      </div>
      <div className="side-inspector-drawer-body">{children}</div>
    </aside>
  );
}
