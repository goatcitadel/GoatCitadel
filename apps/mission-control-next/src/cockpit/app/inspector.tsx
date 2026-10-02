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
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { IconButton } from "../ui/IconButton";
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
  const [width, setWidth] = useState(384);
  if (!content) return null;
  if (isPhone)
    return (
      <Sheet
        open
        onOpenChange={(opened) => {
          if (!opened) close();
        }}
        title={content.title}
      >
        <div data-inspector-body="true" aria-label={`Inspector: ${content.title}`} className="space-y-3">
          {content.body}
        </div>
      </Sheet>
    );
  return (
    <aside
      aria-label={`Inspector: ${content.title}`}
      style={{ width }}
      className="cockpit-inspector relative flex max-w-full shrink-0 flex-col border-l border-line-subtle bg-raised max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:shadow-overlay"
    >
      <InspectorResizeHandle width={width} onChange={setWidth} />
      <header className="flex h-12 items-center justify-between border-b border-line-subtle px-3">
        <h2 className="text-sm font-medium text-fg">{content.title}</h2>
        <IconButton label="Close inspector" icon={<X className="size-4" aria-hidden="true" />} onClick={close} />
      </header>
      <div data-inspector-body="true" className="min-h-0 flex-1 overflow-y-auto p-3">
        {content.body}
      </div>
    </aside>
  );
}
