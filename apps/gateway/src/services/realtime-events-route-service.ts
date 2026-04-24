import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const realtimeEventsRouteMethods = [
  "closeRealtimeStreamLease",
  "getRealtimeEventSequenceBounds",
  "listRealtimeEvents",
  "listRealtimeEventsAfterSequence",
  "openRealtimeStreamLease",
  "subscribeRealtime",
  "touchRealtimeStreamLease",
] as const;

export type RealtimeEventsRouteMethod = (typeof realtimeEventsRouteMethods)[number];
export type RealtimeEventsRoutePort = RoutePort<RealtimeEventsRouteMethod>;
export type RealtimeEventsRouteService = RouteService<RealtimeEventsRouteMethod>;

export function createRealtimeEventsRouteService(port: RealtimeEventsRoutePort): RealtimeEventsRouteService {
  return createRouteService(port, realtimeEventsRouteMethods);
}
