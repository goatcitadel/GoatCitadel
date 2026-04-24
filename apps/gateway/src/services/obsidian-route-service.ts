import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const obsidianRouteMethods = [
  "appendObsidianNote",
  "captureObsidianInboxEntry",
  "getObsidianIntegrationStatus",
  "readObsidianNote",
  "searchObsidianNotes",
  "testObsidianIntegration",
  "updateObsidianIntegrationConfig",
] as const;

export type ObsidianRouteMethod = (typeof obsidianRouteMethods)[number];
export type ObsidianRoutePort = RoutePort<ObsidianRouteMethod>;
export type ObsidianRouteService = RouteService<ObsidianRouteMethod>;
export type ObsidianPort = ObsidianRoutePort;

export function createObsidianRoutePort(port: ObsidianPort): ObsidianRoutePort {
  return {
    appendObsidianNote: (...args) => port.appendObsidianNote(...args),
    captureObsidianInboxEntry: (...args) => port.captureObsidianInboxEntry(...args),
    getObsidianIntegrationStatus: (...args) => port.getObsidianIntegrationStatus(...args),
    readObsidianNote: (...args) => port.readObsidianNote(...args),
    searchObsidianNotes: (...args) => port.searchObsidianNotes(...args),
    testObsidianIntegration: (...args) => port.testObsidianIntegration(...args),
    updateObsidianIntegrationConfig: (...args) => port.updateObsidianIntegrationConfig(...args),
  };
}

export function createObsidianRouteService(port: ObsidianRoutePort): ObsidianRouteService {
  return createRouteService(port, obsidianRouteMethods);
}
