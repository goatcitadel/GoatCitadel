import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const gatewayEventsRouteMethods = ["ingestEvent"] as const;

export type GatewayEventsRouteMethod = (typeof gatewayEventsRouteMethods)[number];
export type GatewayEventsRoutePort = RoutePort<GatewayEventsRouteMethod>;
export type GatewayEventsRouteService = RouteService<GatewayEventsRouteMethod>;

export function createGatewayEventsRouteService(port: GatewayEventsRoutePort): GatewayEventsRouteService {
  return createRouteService(port, gatewayEventsRouteMethods);
}
