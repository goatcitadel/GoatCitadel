import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const sessionsListRouteMethods = [
  "getSession",
  "getSessionSummary",
  "getTranscript",
  "listSessionTimeline",
  "listSessions",
] as const;

export type SessionsListRouteMethod = (typeof sessionsListRouteMethods)[number];
export type SessionsListRoutePort = RoutePort<SessionsListRouteMethod>;
export type SessionsListRouteService = RouteService<SessionsListRouteMethod>;

export interface SessionsListRoutePortDependencies {
  storage: Pick<Storage, "sessions" | "transcripts">;
  getSessionSummary: (sessionId: string) => Promise<unknown>;
  listSessionTimeline: (sessionId: string, limit?: number) => Promise<unknown[]>;
}

export function createSessionsListRoutePort(deps: SessionsListRoutePortDependencies): SessionsListRoutePort {
  return {
    getSession: (sessionId) => deps.storage.sessions.getBySessionId(sessionId),
    getSessionSummary: (sessionId) => deps.getSessionSummary(sessionId),
    getTranscript: (sessionId) => deps.storage.transcripts.read(sessionId),
    listSessionTimeline: (sessionId, limit) => deps.listSessionTimeline(sessionId, limit),
    listSessions: (limit, cursor) => deps.storage.sessions.list(limit, cursor),
  };
}

export function createSessionsListRouteService(port: SessionsListRoutePort): SessionsListRouteService {
  return createRouteService(port, sessionsListRouteMethods);
}
