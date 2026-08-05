import type { RealtimeEventService } from "./realtime-event-service.js";
import { createRouteService } from "./route-service-factory.js";

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
export type RealtimeEventsRoutePort = Pick<RealtimeEventService, RealtimeEventsRouteMethod>;
export type RealtimeEventsRouteService = Readonly<RealtimeEventsRoutePort>;

export function createRealtimeEventsRouteService(port: RealtimeEventsRoutePort): RealtimeEventsRouteService {
  return createRouteService(port, realtimeEventsRouteMethods) as RealtimeEventsRouteService;
}
