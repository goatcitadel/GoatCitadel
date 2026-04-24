import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";
import type { HooksService } from "./hooks-service.js";

export const hooksRouteMethods = [
  "createWorkspaceHook",
  "deleteWorkspaceHook",
  "listWorkspaceHookRuns",
  "listWorkspaceHooks",
  "updateWorkspaceHook",
] as const;

export type HooksRouteMethod = (typeof hooksRouteMethods)[number];
export type HooksRoutePort = RoutePort<HooksRouteMethod>;
export type HooksRouteService = RouteService<HooksRouteMethod>;

export interface HooksRoutePortDependencies {
  hooksService: HooksService;
  normalizeWorkspaceId: (workspaceId?: string) => string;
}

export function createHooksRoutePort(deps: HooksRoutePortDependencies): HooksRoutePort {
  return {
    createWorkspaceHook: (input) =>
      deps.hooksService.createWorkspaceHook({
        ...input,
        workspaceId: deps.normalizeWorkspaceId(input.workspaceId),
      }),
    deleteWorkspaceHook: (workspaceId, hookId) =>
      deps.hooksService.deleteWorkspaceHook(deps.normalizeWorkspaceId(workspaceId), hookId),
    listWorkspaceHookRuns: (workspaceId, limit) =>
      deps.hooksService.listWorkspaceHookRuns(deps.normalizeWorkspaceId(workspaceId), limit),
    listWorkspaceHooks: (workspaceId, limit) =>
      deps.hooksService.listWorkspaceHooks(deps.normalizeWorkspaceId(workspaceId), limit),
    updateWorkspaceHook: (workspaceId, hookId, input) =>
      deps.hooksService.updateWorkspaceHook(deps.normalizeWorkspaceId(workspaceId), hookId, input),
  };
}

export function createHooksRouteService(port: HooksRoutePort): HooksRouteService {
  return createRouteService(port, hooksRouteMethods);
}
