import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

/**
 * Route facade for the autonomy control surface (cross-cutting kill-switch &
 * rollback). Exposes the operator-facing status read, the unified "revert
 * autonomous changes since T" action, and the master kill-switch toggle.
 */
export const autonomyControlRouteMethods = [
  "getStatus",
  "revertAutonomousChangesSince",
  "setKillSwitch",
] as const;

export type AutonomyControlRouteMethod = (typeof autonomyControlRouteMethods)[number];
export type AutonomyControlRoutePort = RoutePort<AutonomyControlRouteMethod>;
export type AutonomyControlRouteService = RouteService<AutonomyControlRouteMethod>;

export function createAutonomyControlRouteService(
  port: AutonomyControlRoutePort,
): AutonomyControlRouteService {
  return createRouteService(port, autonomyControlRouteMethods);
}
