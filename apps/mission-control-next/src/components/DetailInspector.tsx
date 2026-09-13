import { useEffect, useId, useRef, type ReactNode } from "react";
import { Pin, PinOff, X } from "lucide-react";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useModalDialogBehavior } from "../features/threaded-surface/useModalDialogBehavior";
import { NativeButton } from "../features/native-routes/primitives";
import { useUnifiedSidebar } from "../app/UnifiedSidebar";
import "./detail-inspector.css";

/** Stable children across viewport changes; only the sheet's modality changes. */
export function DetailInspector({ open, title, subtitle, children, actions, owner = "feature", pinned = false, onTogglePinned, onClose }: {
  open: boolean; title: string; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode;
  owner?: "shell" | "feature";
  pinned?: boolean; onTogglePinned?: () => void; onClose: () => void;
}) {
  const compact = useMediaQuery("(max-width: 1179px)");
  const ref = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const headingId = useId();
  const sidebar = useUnifiedSidebar();
  const visible = open && (!sidebar || sidebar.activeInspectorId === headingId);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useModalDialogBehavior({ open: visible && compact, onClose, containerRef: ref });
  useEffect(() => {
    if (!visible || compact || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const inspector = ref.current;
    let opener = typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && ref.current?.contains(document.activeElement)) {
        event.preventDefault(); event.stopPropagation(); onCloseRef.current();
      }
    };
    const onOutsideFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && !ref.current?.contains(event.target)) opener = event.target;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onOutsideFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onOutsideFocus);
      // A viewport transition must not replace the current record opener.
      if ((!visibleRef.current || !inspector?.isConnected) && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [visible, compact]);
  const registerInspector = sidebar?.registerInspector;
  useEffect(() => { registerInspector?.(headingId, open, () => onCloseRef.current()); return () => registerInspector?.(headingId, false); }, [headingId, open, registerInspector]);
  if (!visible) return null;
  return <>
    {compact ? <div className="mc-next-detail-scrim" aria-hidden="true" onClick={onClose} /> : null}
    <aside ref={ref} className="mc-next-detail-inspector" data-inspector-owner={owner} role={compact ? "dialog" : "region"} aria-modal={compact ? true : undefined} aria-labelledby={headingId} tabIndex={-1}>
      <header><div><h2 id={headingId} ref={headingRef} tabIndex={-1}>{title}</h2>{subtitle ? <div className="mc-next-detail-subtitle">{subtitle}</div> : null}</div>
        <div className="mc-next-detail-actions">{actions}{onTogglePinned ? <NativeButton variant="ghost" aria-label={pinned ? "Unpin details" : "Pin details"} aria-pressed={pinned} onClick={onTogglePinned}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</NativeButton> : null}<NativeButton variant="ghost" aria-label="Close details" onClick={onClose}><X size={18} /></NativeButton></div>
      </header>
      <div className="mc-next-detail-body">{children}</div>
    </aside>
  </>;
}
