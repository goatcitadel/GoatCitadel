import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const assemblyRouteMethods = [
  "createAssemblyRun",
  "getAssemblyRunDetail",
  "listAssemblyReputations",
  "listAssemblyRuns",
] as const;

export type AssemblyRouteMethod = (typeof assemblyRouteMethods)[number];
export type AssemblyRoutePort = RoutePort<AssemblyRouteMethod>;
export type AssemblyRouteService = RouteService<AssemblyRouteMethod>;

export function createAssemblyRouteService(port: AssemblyRoutePort): AssemblyRouteService {
  return createRouteService(port, assemblyRouteMethods);
}
