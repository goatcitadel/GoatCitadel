import { queryOptions } from "@tanstack/react-query";
import {
  fetchCapabilityToolUsage,
  fetchCapabilityTools,
} from "@goatcitadel/mission-control-shared/api/capability-tools";
import { queryKeys } from "./query-keys";

/**
 * The Capabilities tool groups for one workspace. Every observer of this key must use these options (the Tools tab, and
 * the group panel with `enabled: false`): all observers write their options onto the one shared query, so an observer
 * that carried no `queryFn` of its own would leave the next re-read with nothing to run.
 */
export function toolListQuery(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.capabilityTools(workspaceId),
    queryFn: ({ signal }) => fetchCapabilityTools(workspaceId, { signal }),
  });
}

/**
 * A year of tool call counts. They change slowly and the Gateway caches them for ten minutes, so a minute is fresh
 * enough. A manual refresh asks the Gateway to re-count through `fetchCapabilityToolUsage({ refresh: true })`.
 */
export function toolUsageQuery() {
  return queryOptions({
    queryKey: queryKeys.capabilityToolUsage(),
    queryFn: ({ signal }) => fetchCapabilityToolUsage({ signal }),
    staleTime: 60_000,
  });
}
