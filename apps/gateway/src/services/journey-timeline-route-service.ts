import type { JourneyTimelinePage, JourneyTimelineQuery } from "@goatcitadel/contracts";
import type { JourneyTimelineService } from "./journey-timeline-service.js";

export const journeyTimelineRouteMethods = ["listTimeline"] as const;

export type JourneyTimelineRouteMethod = (typeof journeyTimelineRouteMethods)[number];
export type JourneyTimelineRoutePort = Pick<JourneyTimelineService, JourneyTimelineRouteMethod>;
export type JourneyTimelineRouteService = Readonly<{
  listTimeline(input: JourneyTimelineQuery): Promise<JourneyTimelinePage>;
}>;

export function createJourneyTimelineRouteService(port: JourneyTimelineRoutePort): JourneyTimelineRouteService {
  return Object.freeze({
    listTimeline: async (input) => await port.listTimeline(input),
  });
}
