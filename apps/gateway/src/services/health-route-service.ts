import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const healthRouteMethods = ["getDatabaseHealthSnapshot", "getConfigGenerationHealthSnapshot"] as const;

export type HealthRouteMethod = (typeof healthRouteMethods)[number];
export type HealthRoutePort = RoutePort<HealthRouteMethod>;
export type HealthRouteService = RouteService<HealthRouteMethod>;

export function createHealthRouteService(port: HealthRoutePort): HealthRouteService {
  return createRouteService(port, healthRouteMethods);
}
