import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const settingsRouteMethods = ["getAuthRuntimeSettings", "getSettings", "updateSettings"] as const;

export type SettingsRouteMethod = (typeof settingsRouteMethods)[number];
export type SettingsRoutePort = RoutePort<SettingsRouteMethod>;
export type SettingsRouteService = RouteService<SettingsRouteMethod>;

export function createSettingsRouteService(port: SettingsRoutePort): SettingsRouteService {
  return createRouteService(port, settingsRouteMethods);
}
