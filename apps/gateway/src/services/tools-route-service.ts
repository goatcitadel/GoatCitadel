import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const toolsRouteMethods = [
  "createToolGrant",
  "evaluateToolAccess",
  "listToolCatalog",
  "listToolGrants",
  "revokeToolGrant",
] as const;

export type ToolsRouteMethod = (typeof toolsRouteMethods)[number];
export type ToolsRoutePort = RoutePort<ToolsRouteMethod>;
export type ToolsRouteService = RouteService<ToolsRouteMethod>;

export function createToolsRouteService(port: ToolsRoutePort): ToolsRouteService {
  return createRouteService(port, toolsRouteMethods);
}
