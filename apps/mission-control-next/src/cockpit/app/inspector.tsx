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
import { InspectorContext, type InspectorApi, type InspectorContent } from "./inspector-context";

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
  return <InspectorContext.Provider value={api}>{children}</InspectorContext.Provider>;
}

export function useInspector(): InspectorApi {
  const api = useContext(InspectorContext);
  if (!api) throw new Error("useInspector must be used inside InspectorProvider");
  return api;
}

export function InspectorPanel() {
  const { content, close } = useInspector();
  const isPhone = useMediaQuery("(width < 640px)");
  const overlay = useMediaQuery("(width < 1280px)");
  const [width, setWidth] = useState(384);
  const [expanded, setExpanded] = useState(false);
  const opened = useRef(false);
  const focusTarget = useRef<HTMLElement | null>(null);
  if (content && !opened.current)
    focusTarget.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  opened.current = Boolean(content);
  useEffect(() => {
    if (!content) setExpanded(false);
  }, [content]);
  if (!content) return null;
  const body = (
    <div
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
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (focusTarget.current?.isConnected) focusTarget.current.focus();
        }}
      >
        {body}
      </Sheet>
    );
  if (overlay || expanded)
    return (
      <Dialog
        open
        title={content.title}
        description="Review the selected details."
        contentClassName="inset-y-4 flex max-w-5xl flex-col"
        closeLabel="Close inspector"
        actions={
          !overlay ? (
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
      aria-label={`Inspector: ${content.title}`}
      style={{ width }}
      className="cockpit-inspector relative flex max-w-full shrink-0 flex-col border-l border-line-subtle bg-raised"
    >
      <InspectorResizeHandle width={width} onChange={setWidth} />
      <header className="flex h-12 items-center justify-between border-b border-line-subtle px-3">
        <h2 className="text-sm font-medium text-fg">{content.title}</h2>
        <div className="flex gap-1">
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
