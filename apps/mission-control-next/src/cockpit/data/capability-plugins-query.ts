import { queryOptions } from "@tanstack/react-query";
import {
  fetchCapabilityPluginDetail,
  fetchCapabilityPluginInspection,
  fetchCapabilityPlugins,
} from "@goatcitadel/mission-control-shared/api/capability-plugins";
import { queryKeys } from "./query-keys";

/**
 * The Capabilities plugins, with whether the operator's skip applies and whether a folder can be added. Every observer
 * of this key must use these options: all observers write their options onto the one shared query, so an observer that
 * carried no `queryFn` of its own would leave the next re-read with nothing to run.
 */
export function pluginListQuery(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.capabilityPlugins(workspaceId),
    queryFn: ({ signal }) => fetchCapabilityPlugins(workspaceId, { signal }),
  });
}

/**
 * One installed plugin and each of its pieces. Every observer of this key must use these options, for the same reason
 * as the list. `workspaceId` is the one the plugin was installed in, which its list item names.
 */
export function pluginDetailQuery(workspaceId: string, pluginId: string) {
  return queryOptions({
    queryKey: queryKeys.capabilityPluginDetail(workspaceId, pluginId),
    queryFn: ({ signal }) => fetchCapabilityPluginDetail(workspaceId, pluginId, { signal }),
  });
}

/** A kept inspection, read back by its id: an install panel opened from an address reads it this way. */
export function pluginInspectionQuery(inspectionId: string) {
  return queryOptions({
    queryKey: queryKeys.capabilityPluginInspection(inspectionId),
    queryFn: ({ signal }) => fetchCapabilityPluginInspection(inspectionId, { signal }),
  });
}
