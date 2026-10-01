import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { UiPreferencesProvider, useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useGatewayAccess } from "../../app/use-gateway-access";
import { createCockpitQueryClient } from "../data/query-client";
import { useCockpitRealtime } from "../data/realtime";
import { CockpitToaster } from "../ui/Toaster";
import { CockpitAccessGate } from "./CockpitAccessGate";
import { CockpitNavigationProvider } from "./CockpitNavigationProvider";
import { CockpitShell } from "./CockpitShell";
import { useGatewayReachability } from "./use-gateway-reachability";

function GatedCockpit() {
  const { activeWorkspaceId, notifications } = useUiPreferences();
  const { gatewayAccess, gatewayBusy, retryGatewayAccess } = useGatewayAccess();
  const [queryClient] = useState(createCockpitQueryClient);
  const [visibleSessionId, setVisibleSessionId] = useState<string | undefined>();
  const ready = gatewayAccess.status === "ready";
  const streamState = useCockpitRealtime({
    queryClient,
    enabled: ready,
    workspaceId: activeWorkspaceId ?? "default",
    notificationPreferences: notifications,
    visibleSessionId,
  });
  const gatewayReachability = useGatewayReachability(ready, streamState);
  if (!ready)
    return <CockpitAccessGate access={gatewayAccess} busy={gatewayBusy} onRetry={() => void retryGatewayAccess()} />;
  return (
    <QueryClientProvider client={queryClient}>
      <div data-cockpit-ready="true">
        <CockpitShell
          streamState={streamState}
          gatewayReachability={gatewayReachability}
          onVisibleSessionChange={setVisibleSessionId}
        />
      </div>
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
