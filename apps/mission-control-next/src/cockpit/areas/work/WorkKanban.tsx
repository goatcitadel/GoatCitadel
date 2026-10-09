import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { buildAppHref } from "../../../app/route-model";
import { KanbanRoutePage } from "../../../features/native-routes/ops/KanbanRoutePage";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { WorkArchive } from "./WorkArchive";

/** Reuse the revision-aware action owner and its self-contained native styles. */
export function WorkKanban() {
  const { activeWorkspaceId, activeCitadelId, setActiveWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const { navigate } = useCockpitRoute();
  return <section className="min-w-0">
    <p className="p-4 text-sm text-fg-secondary">Advanced operator task actions. Runtime runs retain their recorded state; task edits do not prove execution. <NativeOwnerLink href="/work/archive" scope={workspaceId}>Archived tasks</NativeOwnerLink></p>
    <KanbanRoutePage activeWorkspaceId={workspaceId} activeWorkspaceName={workspaceId} activeCitadelId={activeCitadelId ?? undefined} pendingApprovals={0} setActiveWorkspaceId={setActiveWorkspaceId} route={{ area: "ops", section: "kanban" }} navigate={route => navigate(buildAppHref(route))} />
  </section>;
}

export { WorkArchive };
