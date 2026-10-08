import { useQuery } from "@tanstack/react-query";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import { queryKeys } from "../../data/query-keys";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { buildAppHref, type AppRoute } from "../../../app/route-model";
import { LibraryKnowledgeSection } from "../../../features/native-routes/library/LibraryKnowledgeSection";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import "./LibraryKnowledgeArea.css";

export function LibraryKnowledgeArea() {
  const prefs = useUiPreferences();
  const { navigate, search } = useCockpitRoute();
  const workspaceId = prefs.activeWorkspaceId ?? "default";
  const workspaces = useQuery({
    queryKey: queryKeys.workspaces(prefs.activeCitadelId),
    queryFn: ({ signal }) => fetchWorkspaces("active", 200, prefs.activeCitadelId, { signal }),
  });
  const workspaceName =
    workspaces.data?.items.find((item) => item.workspaceId === workspaceId && item.citadelId === prefs.activeCitadelId)
      ?.name ?? "Current workspace";
  const route: AppRoute = {
    area: "library",
    section: "knowledge",
    view: new URLSearchParams(search).get("view") ?? undefined,
  };
  return (
    <section className="cockpit-knowledge min-w-0 flex-1 space-y-4 overflow-y-auto p-4" aria-label="Knowledge">
      <header className="space-y-1">
        <h1 className="font-display text-lg font-semibold text-fg">Knowledge</h1>
        <p className="text-sm text-fg-muted">Context sources and governed imports for {workspaceName}.</p>
      </header>
      <LibraryKnowledgeSection
        key={JSON.stringify([prefs.activeCitadelId, workspaceId])}
        route={route}
        activeWorkspaceId={workspaceId}
        activeWorkspaceName={workspaceName}
        activeCitadelId={prefs.activeCitadelId}
        pendingApprovals={0}
        setActiveWorkspaceId={prefs.setActiveWorkspaceId}
        navigate={(target) => {
          if (target.approvalId) {
            navigate(
              `/inbox?item=approval:${encodeURIComponent(target.approvalId)}&workspaceId=${encodeURIComponent(workspaceId)}&shell=cockpit`,
            );
            return;
          }
          const url = new URL(buildAppHref(target), window.location.origin);
          url.searchParams.set("shell", "cockpit");
          navigate(url.pathname + url.search + url.hash);
        }}
      />
    </section>
  );
}
