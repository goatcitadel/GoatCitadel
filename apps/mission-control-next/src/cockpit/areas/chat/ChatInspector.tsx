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
import {
  createDeferredDialogRuntime,
  useDeferredDialogRuntime,
} from "@goatcitadel/mission-control-shared/components/ui/deferred-dialog";

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
const failureLoader = createDeferredDialogRuntime(() =>
  import("./ChatInspectorLoadFailure").then(({ ChatInspectorLoadFailure }) => ChatInspectorLoadFailure),
);

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
  const [state, setState] = useState<LoadState>();
  const current = useCallback(
    () =>
      mounted.current &&
      committedOwner.current === owner &&
      getGatewayApiBaseUrl() === gateway &&
      getGatewayCallerScopeRevision() === caller &&
      getGatewayAccessRevision() === access,
    [owner, gateway, caller, access],
  );
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    committedOwner.current = owner;
  }, [owner]);
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
  const { runtime: Failure } = useDeferredDialogRuntime(failed, failureLoader);
  return (
    <div aria-busy={!code && !failed}>
      {code ? (
        <code.ChatInspector {...props} />
      ) : failed ? (
        <div role="alert" className="min-h-24 space-y-2 text-sm">
          <p>
            Conversation details could not load. You can close the inspector and keep using Chat, or reload the app.
          </p>
          {Failure ? <Failure key={history} current={current} /> : null}
        </div>
      ) : (
        <p role="status" className="min-h-24 text-sm text-fg-muted">
          Loading conversation details…
        </p>
      )}
    </div>
  );
}
