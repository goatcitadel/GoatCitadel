import { queryOptions } from "@tanstack/react-query";
import { fetchCapabilityConnectors } from "@goatcitadel/mission-control-shared/api/capability-connectors";
import { queryKeys } from "./query-keys";

/**
 * The Capabilities connector list for one workspace. Every observer of this key must use these options (the Connectors
 * tab, and the connector panel with `enabled: false`): all observers write their options onto the one shared query, so
 * an observer that carried no `queryFn` of its own would leave the next re-read with nothing to run.
 */
export function connectorListQuery(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.capabilityConnectors(workspaceId),
    queryFn: ({ signal }) => fetchCapabilityConnectors(workspaceId, { signal }),
  });
}
