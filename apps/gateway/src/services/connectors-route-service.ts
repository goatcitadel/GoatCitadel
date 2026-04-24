import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const connectorsRouteMethods = ["listConnectorRecords"] as const;

export type ConnectorsRouteMethod = (typeof connectorsRouteMethods)[number];
export type ConnectorsRoutePort = RoutePort<ConnectorsRouteMethod>;
export type ConnectorsRouteService = RouteService<ConnectorsRouteMethod>;

export function createConnectorsRouteService(port: ConnectorsRoutePort): ConnectorsRouteService {
  return createRouteService(port, connectorsRouteMethods);
}
