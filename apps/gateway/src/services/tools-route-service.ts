import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const toolsRouteMethods = [
  "activatePermissionProfile",
  "archivePermissionProfile",
  "createLocalOperatorOverride",
  "createPermissionProfile",
  "createToolGrant",
  "evaluateToolAccess",
  "listActiveLocalOperatorOverrides",
  "listPermissionProfiles",
  "listToolCatalog",
  "listToolGrants",
  "resolveToolPolicyContext",
  "revokeLocalOperatorOverride",
  "revokeToolGrant",
  "updatePermissionProfile",
] as const;

export type ToolsRouteMethod = (typeof toolsRouteMethods)[number];
export type ToolsRoutePort = RoutePort<ToolsRouteMethod>;
export type ToolsRouteService = RouteService<ToolsRouteMethod>;

export function createToolsRouteService(port: ToolsRoutePort): ToolsRouteService {
  return createRouteService(port, toolsRouteMethods);
}
