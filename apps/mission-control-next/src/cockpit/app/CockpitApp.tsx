import { useCockpitRoute } from "./use-cockpit-route";
import { useNotificationPresenceLease } from "../../hooks/useNotificationPresenceLease";
import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useState, useRef, useMemo, useSyncExternalStore, Activity } from "react";
import { UiPreferencesProvider, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import {
  getGatewayAccessRevision,
  subscribeGatewayAccessChange,
} from "@goatcitadel/mission-control-shared/api/client-core";
import { useGatewayAccess } from "../../app/use-gateway-access";
import { createCockpitQueryClient } from "../data/query-client";
import { useCockpitRealtime } from "../data/realtime";
import { AreaErrorBoundary } from "../ui/AreaErrorBoundary";
import { CockpitToaster } from "../ui/Toaster";
import { CockpitAccessGate } from "./CockpitAccessGate";
import { applyCockpitAppearance } from "./cockpit-appearance";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";
import { CockpitShell } from "./CockpitShell";
import { useGatewayReachability } from "./use-gateway-reachability";

function GatedCockpit() {
  const { activeWorkspaceId, notifications, theme, density } = useUiPreferences();
  useLayoutEffect(() => applyCockpitAppearance(theme, density), [theme, density]);
  const { gatewayAccess, gatewayBusy, callerScope, retryGatewayAccess } = useGatewayAccess();
  const accessRevision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  const queryClient = useMemo(createCockpitQueryClient, [callerScope]);
  const route = useCockpitRoute();
  const [visibleSession, setVisibleSession] = useState<{ workspaceId: string; sessionId?: string }>();
  const workspaceId = activeWorkspaceId ?? "default";
  const setVisibleSessionId = useCallback(
    (sessionId: string | undefined) => setVisibleSession({ workspaceId, sessionId }),
    [workspaceId],
  );
  const visibleSessionId =
    route.resolution.kind === "native" && route.area === "chat" && route.rest[0] !== "projects" && visibleSession?.workspaceId === workspaceId
      ? visibleSession.sessionId
      : undefined;
  const ready = gatewayAccess.status === "ready";
  useNotificationPresenceLease(ready ? (activeWorkspaceId ?? "default") : "", visibleSessionId);
  const streamState = useCockpitRealtime({
    queryClient,
    enabled: ready,
    workspaceId: activeWorkspaceId ?? "default",
    notificationPreferences: notifications,
    visibleSessionId,
  });
  const gatewayReachability = useGatewayReachability(ready, streamState);
  const hasMounted = useRef(false);
  if (ready) hasMounted.current = true;
  useLayoutEffect(() => {
    // Keep draft-owning React components alive, but prevent stale caller cache reuse.
    if (!ready) {
      void queryClient.cancelQueries();
      queryClient.clear();
    }
    return () => {
      void queryClient.cancelQueries();
      queryClient.clear();
    };
  }, [ready, queryClient, accessRevision]);
  return (
    <QueryClientProvider client={queryClient}>
      {!ready ? (
        <CockpitAccessGate access={gatewayAccess} busy={gatewayBusy} onRetry={() => void retryGatewayAccess()} />
      ) : null}
      {hasMounted.current ? (
        <div data-cockpit-ready={ready ? "true" : "false"} hidden={!ready} inert={!ready} aria-hidden={!ready}>
          <Activity mode={ready ? "visible" : "hidden"}>
            <AreaErrorBoundary key={callerScope} label="Mission Control" resetKey="cockpit">
              <CockpitShell
                streamState={streamState}
                gatewayReachability={gatewayReachability}
                onVisibleSessionChange={setVisibleSessionId}
              />
            </AreaErrorBoundary>
          </Activity>
        </div>
      ) : null}
      <CockpitToaster />
    </QueryClientProvider>
  );
}

export function CockpitApp() {
  return (
    <UiPreferencesProvider>
      <CockpitNavigationProvider>
        <GatedCockpit />
      </CockpitNavigationProvider>
    </UiPreferencesProvider>
  );
}
