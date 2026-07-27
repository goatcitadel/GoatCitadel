import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export interface TopbarOverflowItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Accessible name when it should differ from the visible label. */
  ariaLabel?: string;
  /** Marks a toggle item as currently enabled (e.g. sounds on). */
  active?: boolean;
  onSelect: () => void;
}

/**
 * F1 (topbar density): a self-contained overflow menu that collects the
 * lower-priority topbar controls (Start Here, mode, audio, theme) at laptop
 * widths so the right cluster can never clip behind `overflow: clip`. It is
 * hand-rolled to match the shell's `CommandPalette` (the shell test harness
 * renders with react-test-renderer, where Radix portals do not mount), keeps
 * the always-visible controls — approvals, notifications, Context toggle —
 * inline, and self-closes on item select, Escape, or an outside pointer press.
 */
export function TopbarOverflowMenu({ items, label = "More" }: { items: TopbarOverflowItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open || typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return undefined;
    }
    const handlePointerDown = (event: Event) => {
      const target = event.target;
      if (containerRef.current && target instanceof Node && !containerRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (items.length === 0) {
    return null;
  }

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="mc-next-topbar-more" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`mc-next-icon-button mc-next-topbar-more-trigger${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${label} controls`}
        title={`${label} controls`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={16} />
        <span>{label}</span>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          className="mc-next-topbar-more-menu"
          aria-label={`${label} controls`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeAndFocusTrigger();
            }
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`mc-next-topbar-more-item${item.active ? " active" : ""}`}
              aria-label={item.ariaLabel ?? item.label}
              onClick={() => {
                item.onSelect();
                setOpen(false);
              }}
            >
              {item.icon ? (
                <span className="mc-next-topbar-more-icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
