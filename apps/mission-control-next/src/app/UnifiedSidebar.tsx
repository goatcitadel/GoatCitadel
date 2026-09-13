import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { createPortal } from "react-dom";
import "./unified-sidebar.css";
import { DraftLeaveDialog } from "../features/native-routes/library/DraftLeaveDialog";
import { discardDirtySections, getDirtySectionKeys, withDraftLeaveDecision } from "../features/native-routes/library/use-form-dirty";

type Sidebar = {
  target: HTMLElement | null;
  setTarget: (target: HTMLElement | null) => void;
  collapsed: boolean;
  mobile: boolean;
  navOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
  detailOpen: boolean;
  activeInspectorId: string | null;
  registerInspector: (id: string, open: boolean, onClose?: () => void) => void;
};
const SidebarContext = createContext<Sidebar | null>(null);
const PREFERENCE = "goatcitadel.ui.sidebar.collapsed.v1";
export function UnifiedSidebarProvider({ children, mobile, navOpen, openNav, closeNav }: {
  children: ReactNode; mobile: boolean; navOpen: boolean; openNav: () => void; closeNav: () => void;
}) {
  const [inspectors, setInspectors] = useState<ReadonlySet<string>>(new Set());
  const [activeInspectorId, setActiveInspectorId] = useState<string | null>(null);
  const inspectorClosers = useRef(new Map<string, () => void>());
  const [pendingInspector, setPendingInspector] = useState<{ id: string; keys: readonly string[]; previous: Array<() => void>; closeNew?: () => void } | null>(null);
  const narrowDesktop = useMediaQuery("(min-width: 1180px) and (max-width: 1279px)");
  const registerInspector = useCallback((id: string, open: boolean, onClose?: () => void) => {
    if (open) {
      const previous = [...inspectorClosers.current].filter(([other]) => other !== id);
      if (onClose) inspectorClosers.current.set(id, onClose);
      const keys = getDirtySectionKeys();
      if (previous.length && keys.length) {
        setPendingInspector({ id, keys, previous: previous.map(([, close]) => close), closeNew: onClose });
      } else {
        setActiveInspectorId(id);
        for (const [, close] of previous) close();
      }
    } else {
      inspectorClosers.current.delete(id);
      setPendingInspector((current) => current?.id === id ? null : current);
      setActiveInspectorId((current) => current === id ? null : current);
    }
    setInspectors((current) => {
      if (current.has(id) === open) return current;
      const next = new Set(current); if (open) next.add(id); else next.delete(id); return next;
    });
  }, []);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem(PREFERENCE) === "true"; } catch { return false; }
  });
  const changeCollapsed = useCallback((value: boolean) => {
    setCollapsed(value);
    try { window.localStorage.setItem(PREFERENCE, String(value)); } catch { /* Presentation remains usable when storage is unavailable. */ }
  }, []);
  const effectiveCollapsed = collapsed || (narrowDesktop && inspectors.size > 0);
  const value = useMemo<Sidebar>(() => ({ target, setTarget, collapsed: effectiveCollapsed, mobile, navOpen, detailOpen: inspectors.size > 0, activeInspectorId, registerInspector,
    toggle: () => mobile ? (navOpen ? closeNav() : openNav()) : changeCollapsed(!collapsed),
    open: () => { changeCollapsed(false); if (mobile) openNav(); },
    close: () => { if (mobile) closeNav(); else changeCollapsed(true); },
  }), [changeCollapsed, closeNav, collapsed, mobile, navOpen, openNav, target, effectiveCollapsed, inspectors.size, activeInspectorId, registerInspector]);
  const continueInspector = (discard = false) => {
    if (!pendingInspector) return;
    if (discard) discardDirtySections(pendingInspector.keys);
    withDraftLeaveDecision(pendingInspector.keys, () => {
      for (const close of pendingInspector.previous) close();
      setActiveInspectorId(pendingInspector.id);
    });
    setPendingInspector(null);
  };
  return <SidebarContext.Provider value={value}>{children}<DraftLeaveDialog
    open={pendingInspector !== null} keys={pendingInspector?.keys ?? []}
    onContinue={() => continueInspector()} onDiscard={() => continueInspector(true)}
    onCancel={() => {
      if (pendingInspector) withDraftLeaveDecision(pendingInspector.keys, () => pendingInspector.closeNew?.());
      setPendingInspector(null);
    }}
  /></SidebarContext.Provider>;
}
export function useUnifiedSidebar() { return useContext(SidebarContext); }
export function UnifiedSidebarFrame({ children }: { children: ReactNode }) {
  const sidebar = useUnifiedSidebar();
  return <div className="mc-next-app-frame" data-unified-sidebar="true" data-detail-open={sidebar?.detailOpen ? "true" : undefined} data-sidebar-collapsed={sidebar?.collapsed && !sidebar.mobile ? "true" : undefined}>{children}</div>;
}
export function SidebarChatSlot() {
  const sidebar = useUnifiedSidebar();
  return <div className="mc-next-sidebar-chat" ref={sidebar?.setTarget} />;
}
export function SidebarChatPortal({ children }: { children: ReactNode }) {
  const sidebar = useUnifiedSidebar();
  if (!sidebar) return <>{children}</>;
  return sidebar.target ? createPortal(children, sidebar.target) : null;
}
