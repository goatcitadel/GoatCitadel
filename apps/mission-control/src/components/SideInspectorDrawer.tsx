import type { ReactNode } from "react";

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
  children,
}: SideInspectorDrawerProps) {
  return (
    <aside
      className={`side-inspector-drawer${open ? " open" : " closed"}${pinned ? " pinned" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden={!open}
    >
      <div className="side-inspector-drawer-head">
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
