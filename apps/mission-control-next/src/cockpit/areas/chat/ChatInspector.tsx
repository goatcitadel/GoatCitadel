import {
  hasUnsettledChatContextMutation,
  CHAT_CONTEXT_RELOAD_NOTE,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { readCockpitHistory, subscribeCockpitHistory } from "../../app/cockpit-history";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

type InspectorCode = typeof import("./ChatInspectorBody");
type InspectorProps = ComponentProps<InspectorCode["ChatInspector"]>;
// Cache code only. Selection, documents, drafts and operation attempts stay with their existing owners.
let inspectorLoad: Promise<InspectorCode> | undefined;
function loadInspectorCode() {
  inspectorLoad ??= import("./ChatInspectorBody").catch((cause) => {
    inspectorLoad = undefined;
    throw cause;
  });
  return inspectorLoad;
}
type Owner = { scope: string };
type LoadState = { owner: Owner; code: InspectorCode } | { owner: Owner; failed: true };
type ReloadReview = { owner: Owner; history: string; url: string; trigger: HTMLButtonElement };

/** Registration stores this element; code starts only when the existing inspector actually mounts it. */
export function ChatInspector(props: InspectorProps) {
  const caller = useSyncExternalStore(
    subscribeGatewayCallerScope,
    getGatewayCallerScopeRevision,
    getGatewayCallerScopeRevision,
  );
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const gateway = getGatewayApiBaseUrl();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const scope = JSON.stringify([
    gateway,
    caller,
    access,
    activeCitadelId,
    activeWorkspaceId,
    props.input.sessionRail.selectedSessionId,
    props.input.activeSessionSurfaceProps?.selectedSessionId,
    props.input.contextDockProps?.selectedSessionId,
  ]);
  const owner = useMemo<Owner>(() => ({ scope }), [scope]);
  const committedOwner = useRef(owner),
    mounted = useRef(true);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const activeReview = useRef<ReloadReview | undefined>(undefined),
    returnFocus = useRef<ReloadReview | undefined>(undefined);
  const [state, setState] = useState<LoadState>();
  const [review, setReview] = useState<ReloadReview>();
  const current = useCallback(
    () =>
      mounted.current &&
      committedOwner.current === owner &&
      getGatewayApiBaseUrl() === gateway &&
      getGatewayCallerScopeRevision() === caller &&
      getGatewayAccessRevision() === access,
    [owner, gateway, caller, access],
  );
  const currentReview = (saved: ReloadReview) =>
    saved.owner === owner && current() && readCockpitHistory() === saved.history && window.location.href === saved.url;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeReview.current = undefined;
      returnFocus.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    committedOwner.current = owner;
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview(undefined);
  }, [owner, history]);
  useEffect(() => {
    let active = true;
    void loadInspectorCode().then(
      (code) => {
        if (active && current()) setState({ owner, code });
      },
      () => {
        if (active && current()) setState({ owner, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [owner, current]);
  const ownedState = state?.owner === owner ? state : undefined;
  const code = ownedState && "code" in ownedState ? ownedState.code : undefined;
  const failed = Boolean(ownedState && "failed" in ownedState);
  const closeReview = (saved: ReloadReview | undefined) => {
    if (!saved || activeReview.current !== saved) return;
    activeReview.current = undefined;
    setReview((value) => (value === saved ? undefined : value));
  };
  const openReview = (trigger: HTMLButtonElement) => {
    if (!failed || !current() || activeReview.current) return;
    const saved = { owner, history: readCockpitHistory(), url: window.location.href, trigger };
    activeReview.current = saved;
    returnFocus.current = saved;
    setReview(saved);
  };
  const reload = (saved: ReloadReview | undefined) => {
    if (hasUnsettledChatContextMutation()) return;
    if (!saved || activeReview.current !== saved || !failed || !currentReview(saved)) return;
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview((value) => (value === saved ? undefined : value));
    window.location.reload();
  };
  return (
    <div aria-busy={!code && !failed}>
      {code ? (
        <code.ChatInspector {...props} />
      ) : failed ? (
        <div role="alert" className="min-h-24 space-y-2 text-sm">
          <p>
            Conversation details could not load. You can close the inspector and keep using Chat, or reload the app.
          </p>
          <Button size="sm" onClick={(event) => openReview(event.currentTarget)}>
            Reload app
          </Button>
        </div>
      ) : (
        <p role="status" className="min-h-24 text-sm text-fg-muted">
          Loading conversation details…
        </p>
      )}
      <Dialog
        open={Boolean(review && failed && currentReview(review))}
        title="Reload app?"
        onOpenChange={(open) => {
          if (!open) closeReview(review);
        }}
        description="Reloading keeps the recorded conversation. Unsent question answers and unsaved edits may be lost. Reloading does not submit an answer or an approval decision."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (review && activeReview.current === review && currentReview(review))
            cancelButton.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const saved = returnFocus.current;
          returnFocus.current = undefined;
          if (
            saved &&
            currentReview(saved) &&
            saved.trigger.isConnected &&
            (document.activeElement === document.body || document.activeElement === saved.trigger)
          )
            saved.trigger.focus({ preventScroll: true });
        }}
      >
        <div className="flex justify-end gap-2">
          <Button ref={cancelButton} onClick={() => closeReview(review)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={hasUnsettledChatContextMutation() || !review || !currentReview(review)}
            title={hasUnsettledChatContextMutation() ? CHAT_CONTEXT_RELOAD_NOTE : undefined}
            onClick={() => reload(review)}
          >
            Reload app
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
