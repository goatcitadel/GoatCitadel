import type { Storage } from "@goatcitadel/storage";
import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const costsRouteMethods = ["costSummary", "costUsageAvailability", "runCheaper"] as const;

export type CostsRouteMethod = (typeof costsRouteMethods)[number];
export type CostsRoutePort = RoutePort<CostsRouteMethod>;
export type CostsRouteService = RouteService<CostsRouteMethod>;

export interface CostsRoutePortDependencies {
  storage: Storage;
}

export function createCostsRoutePort(deps: CostsRoutePortDependencies): CostsRoutePort {
  return {
    costSummary: (scope, from, to) => deps.storage.costLedger.summary(scope, from, to),
    costUsageAvailability: (from, to) => deps.storage.costLedger.usageAvailability(from, to),
    runCheaper: () => ({
      mode: "saver",
      actions: [
        "Switch long-running research to gpt-5-mini unless escalation is required.",
        "Batch background memory compaction outside active sessions.",
        "Prefer cached connector diagnostics for dashboard refreshes under 60 seconds.",
      ],
    }),
  };
}

export function createCostsRouteService(port: CostsRoutePort): CostsRouteService {
  return createRouteService(port, costsRouteMethods);
}
