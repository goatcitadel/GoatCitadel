import type { SessionMeta } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSessionsListRoutePort } from "./sessions-list-route-service.js";

function session(sessionId: string): SessionMeta {
  return {
    sessionId,
    sessionKey: `key-${sessionId}`,
    kind: "group",
    channel: "webchat",
    account: "operator",
    lastActivityAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    health: "healthy",
    tokenInput: 0,
    tokenOutput: 0,
    tokenCachedInput: 0,
    tokenTotal: 0,
    costUsdTotal: 0,
    budgetState: "normal",
  } as SessionMeta;
}

type ChatRecord = { sessionId: string; workspaceId?: string };

function createPort(records: Record<string, ChatRecord>, sessions: SessionMeta[]) {
  const listBySessionIds = vi.fn(
    async (ids: string[]) => new Map(ids.flatMap((id) => (records[id] ? [[id, records[id]] as const] : []))),
  );
  const get = vi.fn(async (id: string) => records[id]);
  const port = createSessionsListRoutePort({
    storage: {
      sessions: {
        list: vi.fn(async () => sessions),
        getBySessionId: vi.fn(async (id: string) => sessions.find((entry) => entry.sessionId === id)),
      },
      transcripts: { read: vi.fn() },
      chatSessionMeta: { listBySessionIds, get },
    } as never,
    getSessionSummary: vi.fn(),
    listSessionTimeline: vi.fn(),
  });
  return { port, listBySessionIds };
}

describe("sessions list route port", () => {
  it("names each listed session's Chat workspace, with one lookup per page", async () => {
    const sessions = [session("s-1"), session("s-2")];
    const { port, listBySessionIds } = createPort(
      { "s-1": { sessionId: "s-1", workspaceId: "verification" } },
      sessions,
    );

    const listed = (await port.listSessions(50, undefined)) as SessionMeta[];

    expect(listed.map((item) => item.workspaceId)).toEqual(["verification", undefined]);
    expect(listBySessionIds).toHaveBeenCalledTimes(1);
    expect(listBySessionIds).toHaveBeenCalledWith(["s-1", "s-2"]);
    expect(((await port.getSession("s-1")) as SessionMeta).workspaceId).toBe("verification");
  });

  it("adds no workspace when the Chat record has none or a blank one", async () => {
    const sessions = [session("s-1"), session("s-2")];
    const { port } = createPort(
      { "s-1": { sessionId: "s-1", workspaceId: "  " }, "s-2": { sessionId: "s-2" } },
      sessions,
    );

    const listed = (await port.listSessions(50, undefined)) as SessionMeta[];

    expect(listed.every((item) => !("workspaceId" in item))).toBe(true);
    expect("workspaceId" in ((await port.getSession("s-2")) as SessionMeta)).toBe(false);
  });

  it("does not add or drop sessions: the list is the same sessions as before", async () => {
    const sessions = [session("s-1"), session("s-2"), session("s-3")];
    const { port } = createPort({ "s-9": { sessionId: "s-9", workspaceId: "other" } }, sessions);

    const listed = (await port.listSessions(50, undefined)) as SessionMeta[];

    expect(listed.map((item) => item.sessionId)).toEqual(["s-1", "s-2", "s-3"]);
  });

  it("returns an unknown session as the storage returned it", async () => {
    const { port } = createPort({}, []);
    expect(await port.getSession("missing")).toBeUndefined();
  });
});
