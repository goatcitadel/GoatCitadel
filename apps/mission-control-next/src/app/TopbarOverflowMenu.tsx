import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openingEdge = useRef<"first" | "last">("first");
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!buttons?.length) return;
    buttons[openingEdge.current === "first" ? 0 : buttons.length - 1]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return undefined;
    }
    const eventTarget = document;
    const handlePointerDown = (event: Event) => {
      const target = event.target;
      if (containerRef.current && target instanceof Node && !containerRef.current.contains(target)) {
        setOpen(false);
      }
    };
    eventTarget.addEventListener("pointerdown", handlePointerDown);
    return () => eventTarget.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (items.length === 0) {
    return null;
  }

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      className="mc-next-topbar-more"
      ref={containerRef}
      data-shell-escape-owner={open ? "overflow-menu" : undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`mc-next-icon-button mc-next-topbar-more-trigger${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${label} controls`}
        title={`${label} controls`}
        onClick={() => {
          openingEdge.current = "first";
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (open && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeAndFocusTrigger();
          } else if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openingEdge.current = event.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={16} />
        <span>{label}</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          className="mc-next-topbar-more-menu"
          aria-label={`${label} controls`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeAndFocusTrigger();
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
            if (!buttons.length) return;
            event.preventDefault();
            const index = buttons.findIndex((button) => button === document.activeElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (Math.max(index, 0) + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`mc-next-topbar-more-item${item.active ? " active" : ""}`}
              aria-label={item.ariaLabel ?? item.label}
              onClick={() => {
                closeAndFocusTrigger();
                item.onSelect();
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
