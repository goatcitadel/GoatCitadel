import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const mediaRouteMethods = [
  "createMediaJob",
  "getChatAttachmentPreview",
  "getMediaJob",
  "issueMediaPlaybackToken",
  "listMediaJobs",
  "validateMediaPlaybackToken",
] as const;

export type MediaRouteMethod = (typeof mediaRouteMethods)[number];
export type MediaRoutePort = RoutePort<MediaRouteMethod>;
export type MediaRouteService = RouteService<MediaRouteMethod>;

export function createMediaRouteService(port: MediaRoutePort): MediaRouteService {
  return createRouteService(port, mediaRouteMethods);
}
