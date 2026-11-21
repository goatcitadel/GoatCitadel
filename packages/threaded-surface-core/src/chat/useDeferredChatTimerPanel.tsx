import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { ChatTimerRuntime } from "./ChatTimerRuntime";
import type { useChatTimerPanel } from "./useChatTimerPanel";

type Input = Parameters<typeof useChatTimerPanel>[0];
type Panel = ReturnType<typeof useChatTimerPanel>["chatTimerPanel"];
type Runtime = typeof ChatTimerRuntime;

export function useDeferredChatTimerPanel(
  input: Input,
  selectionRevision: RefObject<number>,
  onLoadError: (error: string) => void,
) {
  const { enabled, selectedSessionId, workspaceId } = input;
  const scope = useMemo(() => ({ enabled, selectedSessionId, workspaceId }), [enabled, selectedSessionId, workspaceId]);
  const liveScope = useRef<object | null>(null);
  useLayoutEffect(() => {
    liveScope.current = scope;
    return () => {
      liveScope.current = null;
    };
  }, [scope]);
  const [Runtime, setRuntime] = useState<Runtime>();
  const [request, setRequest] = useState<{ scope: object }>();
  const [snapshot, setSnapshot] = useState<{ scope: object; panel: Panel }>();
  const publish = useCallback((panel: Panel) => setSnapshot({ scope, panel }), [scope]);
  const openChatTimerPanel = useCallback(() => {
    if (!enabled || !selectedSessionId || liveScope.current !== scope) return;
    const access = getGatewayAccessRevision();
    const caller = getGatewayCallerScopeRevision();
    const gateway = getGatewayApiBaseUrl();
    const revision = selectionRevision.current;
    const current = () =>
      liveScope.current === scope &&
      selectionRevision.current === revision &&
      access === getGatewayAccessRevision() &&
      caller === getGatewayCallerScopeRevision() &&
      gateway === getGatewayApiBaseUrl();
    const open = () => {
      if (current()) setRequest({ scope });
    };
    if (Runtime) {
      open();
      return;
    }
    void import("./ChatTimerRuntime").then(
      ({ ChatTimerRuntime }) => {
        if (!current()) return;
        setRuntime(() => ChatTimerRuntime);
        open();
      },
      () => {
        if (current()) {
          onLoadError("Chat timers could not load. Try opening them again.");
        }
      },
    );
  }, [Runtime, enabled, onLoadError, scope, selectedSessionId, selectionRevision]);
  return {
    openChatTimerPanel,
    chatTimerPanel: snapshot?.scope === scope ? snapshot.panel : undefined,
    runtime: Runtime ? (
      <Runtime input={input} request={request?.scope === scope ? request : undefined} publish={publish} />
    ) : null,
  };
}
