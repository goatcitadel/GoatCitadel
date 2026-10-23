import { useSyncExternalStore } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import {
  getGatewayCallerScopeRevision,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { RuntimeOverview } from "./RuntimeOverview";

/** System › Runtime. Remounts on any change of access, Citadel or workspace, so no open confirmation outlives it. */
export function SystemRuntime() {
  const preferences = useUiPreferences(),
    location = useCockpitRoute();
  const workspaceId = preferences.activeWorkspaceId ?? "default";
  const callerRevision = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScopeRevision, () => 0);
  const access = useProjectAccess(
    JSON.stringify(["system-runtime", preferences.activeCitadelId, workspaceId, callerRevision]),
  );
  return (
    <RuntimeOverview
      key={access.identity + ":runtime"}
      workspaceId={workspaceId}
      sessionId={new URLSearchParams(location.search).get("sessionId") ?? undefined}
    />
  );
}
