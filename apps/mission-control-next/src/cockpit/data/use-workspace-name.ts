import { useQuery } from "@tanstack/react-query";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "./query-keys";

type WorkspaceItem = { workspaceId: string; name?: string };

/**
 * Names workspaces from the sidebar's workspace list query (same key, so no extra request).
 * Returns undefined for ids outside the active Citadel; callers keep the raw id only in a detail.
 */
export function useWorkspaceNameLookup(citadelId: string | undefined, enabled = true): (workspaceId?: string) => string | undefined {
  const workspaces = useQuery({
    queryKey: queryKeys.workspaces(citadelId),
    queryFn: () => fetchWorkspaces("active", 200, citadelId),
    enabled,
  });
  const items = (workspaces.data as { items?: WorkspaceItem[] } | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return (workspaceId) => (workspaceId ? list.find((item) => item.workspaceId === workspaceId)?.name : undefined);
}

export function useWorkspaceName(citadelId: string | undefined, workspaceId: string | undefined, enabled = true) {
  return useWorkspaceNameLookup(citadelId, enabled)(workspaceId);
}

/** The active workspace's display name, or a plain fallback; never the raw id. */
export function useActiveWorkspaceLabel(): string {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const name = useWorkspaceName(activeCitadelId, activeWorkspaceId, Boolean(activeWorkspaceId));
  if (!activeWorkspaceId) return "No workspace selected";
  return name ?? "Current workspace";
}
