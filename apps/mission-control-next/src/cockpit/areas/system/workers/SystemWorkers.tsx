import { useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import {
  getGatewayCallerScopeRevision,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import { useRemoteWorkerRegistry } from "@goatcitadel/mission-control-shared/hooks/useRemoteWorkerRegistry";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { useWorkspaceName } from "../../../data/use-workspace-name";
import { AreaHeader } from "../../../ui/AreaHeader";
import { AREA_PAGE } from "../../../ui/area-layout";
import { Button } from "../../../ui/Button";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { WorkerDetail } from "./WorkerDetail";
import { WorkerList } from "./WorkerList";
import { readWorkerSelection } from "./worker-copy";

const PATH = "/system/runtime/workers";

function WorkersPage({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const location = useCockpitRoute();
  const registry = useRemoteWorkerRegistry(workspaceId);
  const selection = readWorkerSelection(location.search);
  // Selection lives in the URL, so links, Back and bookmarks open the same worker and assignment.
  const go = (next: { workerId?: string | null; assignmentId?: string | null }) => {
    const params = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    location.navigate(PATH + (params.size ? "?" + params : "") + location.hash);
  };
  const recovery = new URLSearchParams(location.search);
  recovery.delete("workerId");
  recovery.delete("assignmentId");
  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Workers"
        description="Remote workers, their assignments and spending budgets."
        actions={
          <Button size="sm" disabled={registry.loading} onClick={() => void registry.reload()}>
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh<span className="sr-only"> workers</span>
          </Button>
        }
      />
      {selection.invalid ? (
        <div role="alert" className="text-sm text-fg-secondary">
          <p>This link does not identify one worker and its assignment.</p>
          <NativeOwnerLink
            href={PATH + (recovery.size ? "?" + recovery : "") + location.hash}
            scope={[workspaceId, location.search, location.hash]}
            className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
          >
            Open worker records
          </NativeOwnerLink>
        </div>
      ) : selection.workerId ? (
        <WorkerDetail
          key={selection.workerId}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workerId={selection.workerId}
          assignmentId={selection.assignmentId}
          listed={registry.page?.items.find((item) => item.workerId === selection.workerId)}
          reloadRegistry={registry.reload}
          onBack={() => go({ workerId: null, assignmentId: null })}
          onOpenAssignment={(assignmentId) => go({ assignmentId })}
          onCloseAssignment={() => go({ assignmentId: null })}
        />
      ) : (
        <WorkerList registry={registry} onSelect={(workerId) => go({ workerId, assignmentId: null })} />
      )}
    </section>
  );
}

/** System › Runtime › Workers. Remounts on any change of access or workspace, so no worker or draft outlives it. */
export function SystemWorkers() {
  const preferences = useUiPreferences();
  const workspaceId = preferences.activeWorkspaceId ?? "default";
  const callerRevision = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScopeRevision, () => 0);
  const access = useProjectAccess(
    JSON.stringify(["system-workers", preferences.activeCitadelId, workspaceId, callerRevision]),
  );
  const workspaceName = useWorkspaceName(preferences.activeCitadelId ?? undefined, workspaceId) ?? "this workspace";
  return (
    <WorkersPage key={access.identity + ":" + workspaceId} workspaceId={workspaceId} workspaceName={workspaceName} />
  );
}
