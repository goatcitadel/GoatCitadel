import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const devDiagnosticsRouteMethods = [
  "isDevDiagnosticsEnabled",
  "listDevDiagnostics",
  "subscribeDevDiagnostics",
] as const;

export type DevDiagnosticsRouteMethod = (typeof devDiagnosticsRouteMethods)[number];
export type DevDiagnosticsRoutePort = RoutePort<DevDiagnosticsRouteMethod>;
export type DevDiagnosticsRouteService = RouteService<DevDiagnosticsRouteMethod>;

export function createDevDiagnosticsRouteService(port: DevDiagnosticsRoutePort): DevDiagnosticsRouteService {
  return createRouteService(port, devDiagnosticsRouteMethods);
}
