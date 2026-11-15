import type { SessionMeta } from "@goatcitadel/contracts";
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
  storage: Pick<Storage, "sessions" | "transcripts" | "chatSessionMeta">;
  getSessionSummary: (sessionId: string) => Promise<unknown>;
  listSessionTimeline: (sessionId: string, limit?: number) => Promise<unknown[]>;
}

/** The session with the workspace its Chat record names; unchanged when there is none or it is blank. */
function withWorkspace(session: SessionMeta, workspaceId: string | undefined): SessionMeta {
  const named = workspaceId?.trim();
  return named ? { ...session, workspaceId: named } : session;
}

export function createSessionsListRoutePort(deps: SessionsListRoutePortDependencies): SessionsListRoutePort {
  // Read once: every method below goes through the same storage owner.
  const storage = deps.storage;
  return {
    getSession: async (sessionId) => {
      const session = await storage.sessions.getBySessionId(sessionId);
      if (!session) return session;
      return withWorkspace(session, (await storage.chatSessionMeta.get(sessionId))?.workspaceId);
    },
    getSessionSummary: (sessionId) => deps.getSessionSummary(sessionId),
    getTranscript: (sessionId) => storage.transcripts.read(sessionId),
    listSessionTimeline: (sessionId, limit) => deps.listSessionTimeline(sessionId, limit),
    listSessions: async (limit, cursor) => {
      const sessions = await storage.sessions.list(limit, cursor);
      if (sessions.length === 0) return sessions;
      const records = await storage.chatSessionMeta.listBySessionIds(sessions.map((item) => item.sessionId));
      return sessions.map((item) => withWorkspace(item, records.get(item.sessionId)?.workspaceId));
    },
  };
}

export function createSessionsListRouteService(port: SessionsListRoutePort): SessionsListRouteService {
  return createRouteService(port, sessionsListRouteMethods);
}
