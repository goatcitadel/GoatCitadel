import {
  RESPONSIVE_BREAKPOINTS,
  RESPONSIVE_QUERIES,
} from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { X } from "lucide-react";
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
import { getGatewayAccessRevision, subscribeGatewayAccessChange } from "@goatcitadel/mission-control-shared/api/access-scope";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { IconButton } from "../ui/IconButton";
import {
  createDeferredDialogRuntime,
  PendingDialog,
  useDeferredDialogRuntime,
} from "@goatcitadel/mission-control-shared/components/ui/deferred-dialog";
import { readCockpitHistory, subscribeCockpitHistory } from "./cockpit-history";
import {
  InspectorContext,
  InspectorSourceContext,
  type InspectorApi,
  type InspectorContent,
} from "./inspector-context";

// Controls that use Escape themselves. Checkboxes, radios and button-like inputs do not, so Escape still closes.
const ESCAPE_OWNERS =
  'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="listbox"], [role="combobox"]';
/** The docked or overlay panel (its header and body), or the body inside the phone sheet or expanded dialog. */
const INSPECTOR_SURFACE = '[data-inspector-mode], [data-inspector-body="true"]';
const controlsLoader = createDeferredDialogRuntime(() => import("./inspector-panel-controls"));

export function InspectorProvider({ children }: { children: ReactNode }) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const installation = getGatewayApiBaseUrl();
  const accessRevision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const identity = JSON.stringify([installation, accessRevision, activeCitadelId, activeWorkspaceId, history]);
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
      getGatewayAccessRevision() === accessRevision &&
      readCockpitHistory() === history,
    [token, installation, accessRevision, history],
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
        // SH-09: Escape pressed elsewhere on the page belongs to that page; only Escape inside the inspector closes it.
        if (!(event.target instanceof Element) || !event.target.closest(INSPECTOR_SURFACE)) return;
        // Escape in a text field, menu, listbox or combobox belongs to that control (clear, close the menu).
        if (event.target.closest(ESCAPE_OWNERS)) return;
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
  const { runtime: controls, failed } = useDeferredDialogRuntime(shown, controlsLoader);
  const handoff = useRef(false);
  handoff.current = shown && Boolean(controls);
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
  if (isPhone || modal || expanded) {
    const returnFocus = (event: Event) => {
      event.preventDefault();
      if (focusTarget.current?.isConnected) focusTarget.current.focus();
    };
    return controls ? (
      <controls.InspectorModal
        title={content.title}
        close={close}
        phone={isPhone}
        restore={modal ? undefined : () => setExpanded(false)}
        returnFocus={returnFocus}
      >
        {body}
      </controls.InspectorModal>
    ) : (
      <PendingDialog
        title={content.title}
        closeLabel="Close inspector"
        className="cockpit-dialog cockpit-pending-dialog fixed inset-x-4 top-4 m-0 mx-auto w-auto max-w-xl border-line bg-overlay p-4 text-fg shadow-overlay backdrop:bg-scrim"
        onDismiss={close}
        onCloseAutoFocus={returnFocus}
        handoff={handoff}
      >
        <p data-inspector-body="true" role={failed ? "alert" : "status"} className="text-sm text-fg-muted">
          {failed ? "Inspector controls could not load. Close the inspector to keep using the app." : "Loading inspector…"}
        </p>
      </PendingDialog>
    );
  }
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
      {controls ? <controls.InspectorResizeHandle width={width} onChange={setWidth} /> : null}
      <header className="flex h-12 items-center justify-between gap-2 border-b border-line-subtle px-3">
        <h2 title={content.title} className="min-w-0 truncate text-base font-medium text-fg">
          {content.title}
        </h2>
        <div className="flex shrink-0 gap-1">
          {controls ? <controls.InspectorExpandButton onExpand={() => setExpanded(true)} /> : null}
          <IconButton label="Close inspector" icon={<X className="size-4" aria-hidden="true" />} onClick={close} />
        </div>
      </header>
      {failed ? (
        <p className="px-3 pt-2 text-sm text-fg-muted">
          Resize and expand controls could not load. The selected details are still available.
        </p>
      ) : null}
      {body}
    </aside>
  );
}
