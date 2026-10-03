import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { workspaceDurableRunsOptions, workspaceTasksOptions } from "../areas/work/work-queries";
import { preloadCockpitArea } from "./area-loaders";
import { canPreload } from "./preloadable";
import type { CockpitArea } from "./routes";

function needsFirstPage(state: { data: unknown; errorUpdatedAt: number } | undefined): boolean {
  return state?.data === undefined && !(state?.errorUpdatedAt && Date.now() - state.errorUpdatedAt < 10_000);
}

export function preloadCockpitDestination(client: QueryClient, area: CockpitArea, workspaceId: string): void {
  if (!canPreload()) return;
  preloadCockpitArea(area);
  if (area === "work" && workspaceId) {
    // The board consumes these same bounded pages, keys and freshness rules.
    // Leave visited pagination intact; its observer handles background refresh.
    const runs = workspaceDurableRunsOptions(workspaceId);
    const tasks = workspaceTasksOptions(workspaceId);
    if (needsFirstPage(client.getQueryState(runs.queryKey)))
      void client.prefetchInfiniteQuery({ ...runs, pages: 1, retry: false });
    if (needsFirstPage(client.getQueryState(tasks.queryKey)))
      void client.prefetchInfiniteQuery({ ...tasks, pages: 1, retry: false });
  }
}

export function useCockpitPreload() {
  const client = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  return (area: CockpitArea) => preloadCockpitDestination(client, area, activeWorkspaceId ?? "default");
}
