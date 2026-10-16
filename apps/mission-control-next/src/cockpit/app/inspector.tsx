import {
  RESPONSIVE_BREAKPOINTS,
  RESPONSIVE_QUERIES,
} from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { Maximize2, Minimize2, X } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { IconButton } from "../ui/IconButton";
import { Dialog } from "../ui/Dialog";
import { Sheet } from "../ui/Sheet";
import { readCockpitHistory, subscribeCockpitHistory } from "./cockpit-history";
import { InspectorResizeHandle } from "./InspectorResizeHandle";
import {
  InspectorContext,
  InspectorSourceContext,
  type InspectorApi,
  type InspectorContent,
} from "./inspector-context";

// Controls that use Escape themselves. Checkboxes, radios and button-like inputs do not, so Escape still closes.
const ESCAPE_OWNERS =
  'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="listbox"], [role="combobox"]';

export function InspectorProvider({ children }: { children: ReactNode }) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const installation = getGatewayApiBaseUrl();
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const identity = JSON.stringify([installation, activeCitadelId, activeWorkspaceId, history]);
  const lifetime = useRef({ identity, alive: true });
  if (lifetime.current.identity !== identity) {
    lifetime.current.alive = false;
    lifetime.current = { identity, alive: true };
  }
  const token = lifetime.current;
  const current = useCallback(
    () =>
      token.alive &&
      lifetime.current === token &&
      getGatewayApiBaseUrl() === installation &&
      readCockpitHistory() === history,
    [token, installation, history],
  );
  useEffect(() => {
    token.alive = true;
    return () => {
      token.alive = false;
    };
  }, [token]);
  const dismissalGeneration = useRef(0);
  const getDismissalGeneration = useCallback(() => dismissalGeneration.current, []);
  const registered = useRef<{ token: typeof token; content: InspectorContent } | null>(null);
  const [selection, setSelection] = useState<{ token: typeof token; content: InspectorContent } | null>(null);
  const content = selection?.token === token && current() ? selection.content : null;
  const open = useCallback(
    (next: InspectorContent) => {
      if (!current()) return;
      registered.current = { token, content: next };
      setSelection({ token, content: next });
    },
    [current, token],
  );
  const close = useCallback(() => {
    if (current()) {
      dismissalGeneration.current += 1;
      setSelection(null);
    }
  }, [current]);
  const updateIfOpen = useCallback(
    (source: string, next: InspectorContent) => {
      if (!current()) return;
      if (registered.current?.token === token && registered.current.content.source === source)
        registered.current = { token, content: next };
      setSelection((value) =>
        value?.token === token && value.content.source === source ? { token, content: next } : value,
      );
    },
    [current, token],
  );
  const register = useCallback(
    (source: string, next: InspectorContent) => {
      if (!current() || next.source !== source) return;
      registered.current = { token, content: next };
      setSelection((value) =>
        value?.token === token && value.content.source === source ? { token, content: next } : value,
      );
    },
    [current, token],
  );
  const closeIfOpen = useCallback(
    (source: string) => {
      if (!current()) return;
      if (registered.current?.token === token && registered.current.content.source === source)
        registered.current = null;
      setSelection((value) => (value?.token === token && value.content.source === source ? null : value));
    },
    [current, token],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !current()) return;
      const modals = [
        ...document.querySelectorAll('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]'),
      ];
      if (modals.some((modal) => !modal.querySelector('[data-inspector-body="true"]'))) return;
      if (event.key === "Escape" && content) {
        // Escape in a text field, menu, listbox or combobox belongs to that control (clear, close the menu).
        if (event.target instanceof Element && event.target.closest(ESCAPE_OWNERS)) return;
        close();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "i")
        return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]'))
        return;
      const target = registered.current;
      if (!content && (!target || target.token !== token)) return;
      event.preventDefault();
      if (content) close();
      else if (target?.token === token) setSelection(target);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [content, close, current, token]);
  const api = useMemo(
    () => ({ content, open, close, register, updateIfOpen, closeIfOpen, getDismissalGeneration }),
    [content, open, close, register, updateIfOpen, closeIfOpen, getDismissalGeneration],
  );
  return (
    <InspectorSourceContext.Provider value={content?.source ?? null}>
      <InspectorContext.Provider value={api}>{children}</InspectorContext.Provider>
    </InspectorSourceContext.Provider>
  );
}

export function useInspector(): InspectorApi {
  const api = useContext(InspectorContext);
  if (!api) throw new Error("useInspector must be used inside InspectorProvider");
  return api;
}

export function InspectorPanel() {
  const { content, close } = useInspector();
  const isPhone = useMediaQuery(RESPONSIVE_QUERIES.phone);
  // SH-02: 1024–1279px laptops get a non-modal panel over the page; only narrower widths and Expand are modal.
  const modal = useMediaQuery(RESPONSIVE_QUERIES.belowDesktop);
  const overlay = useMediaQuery(`(width < ${RESPONSIVE_BREAKPOINTS.wide}px)`);
  const panel = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(384);
  const [expanded, setExpanded] = useState(false);
  const opened = useRef(false);
  const focusTarget = useRef<HTMLElement | null>(null);
  if (content && !opened.current)
    focusTarget.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  opened.current = Boolean(content);
  const shown = Boolean(content);
  useEffect(() => {
    if (shown) return;
    setExpanded(false);
    // The docked and overlay panels are not dialogs, so closing them hands focus back to the opener here.
    const active = document.activeElement;
    if ((!active || active === document.body) && focusTarget.current?.isConnected) focusTarget.current.focus();
  }, [shown]);
  const floating = shown && overlay && !modal && !expanded && !isPhone;
  useEffect(() => {
    if (floating) panel.current?.focus({ preventScroll: true });
  }, [floating]);
  if (!content) return null;
  const body = (
    <div
      role="region"
      data-inspector-body="true"
      aria-label={`Inspector: ${content.title}`}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
    >
      {content.body}
    </div>
  );
  if (isPhone)
    return (
      <Sheet
        open
        onOpenChange={(value) => {
          if (!value) close();
        }}
        title={content.title}
        closeLabel="Close inspector"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (focusTarget.current?.isConnected) focusTarget.current.focus();
        }}
      >
        {body}
      </Sheet>
    );
  if (modal || expanded)
    return (
      <Dialog
        open
        title={content.title}
        contentClassName="inset-y-4 flex max-w-5xl flex-col sm:top-4"
        closeLabel="Close inspector"
        actions={
          !modal ? (
            <IconButton
              label="Restore docked inspector"
              icon={<Minimize2 className="size-4" aria-hidden="true" />}
              onClick={() => setExpanded(false)}
            />
          ) : undefined
        }
        onOpenChange={(value) => {
          if (!value) close();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (focusTarget.current?.isConnected) focusTarget.current.focus();
        }}
      >
        {body}
      </Dialog>
    );
  return (
    <aside
      ref={panel}
      // The body region carries "Inspector: <title>"; the landmark stays generic so the two names differ.
      aria-label="Inspector"
      tabIndex={floating ? -1 : undefined}
      data-inspector-mode={floating ? "overlay" : "docked"}
      style={{ width }}
      className={`cockpit-inspector flex max-w-full shrink-0 flex-col border-l border-line-subtle bg-raised ${
        floating ? "absolute inset-y-0 right-0 z-30 shadow-overlay" : "relative"
      }`}
    >
      <InspectorResizeHandle width={width} onChange={setWidth} />
      <header className="flex h-12 items-center justify-between gap-2 border-b border-line-subtle px-3">
        <h2 title={content.title} className="min-w-0 truncate text-base font-medium text-fg">
          {content.title}
        </h2>
        <div className="flex shrink-0 gap-1">
          <IconButton
            label="Expand inspector"
            icon={<Maximize2 className="size-4" aria-hidden="true" />}
            onClick={() => setExpanded(true)}
          />
          <IconButton label="Close inspector" icon={<X className="size-4" aria-hidden="true" />} onClick={close} />
        </div>
      </header>
      {body}
    </aside>
  );
}
