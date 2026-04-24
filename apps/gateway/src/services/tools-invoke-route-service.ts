import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const toolsInvokeRouteMethods = ["getDeploymentProfile", "invokeTool", "isFeatureEnabled"] as const;

export type ToolsInvokeRouteMethod = (typeof toolsInvokeRouteMethods)[number];
export type ToolsInvokeRoutePort = RoutePort<ToolsInvokeRouteMethod>;
export type ToolsInvokeRouteService = RouteService<ToolsInvokeRouteMethod>;

export function createToolsInvokeRouteService(port: ToolsInvokeRoutePort): ToolsInvokeRouteService {
  return createRouteService(port, toolsInvokeRouteMethods);
}
