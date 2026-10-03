import { useInfiniteQuery } from "@tanstack/react-query";
import { workspaceDurableRunsOptions } from "./work-queries";

export function useWorkspaceDurableRuns(workspaceId: string) {
  return useInfiniteQuery(workspaceDurableRunsOptions(workspaceId));
}
