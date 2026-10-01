import { afterEach, expect, it, vi } from "vitest";
import { fetchChatSessionStatus } from "./chat.js";

afterEach(() => vi.unstubAllGlobals());
it("keeps a required session creation readback independent of an older status GET", async () => {
  const resolvers: Array<(value: Response) => void> = [];
  const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => resolvers.push(resolve)));
  vi.stubGlobal("fetch", fetchMock);
  const older = fetchChatSessionStatus("session/a"), coalesced = fetchChatSessionStatus("session/a");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = new AbortController().signal;
  const fresh = fetchChatSessionStatus("session/a", signal);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store", signal });
  expect(fetchMock.mock.calls[1]?.[1]?.method ?? "GET").toBe("GET");
  expect(new URL(fetchMock.mock.calls[1]![0]).pathname).toBe("/api/v1/chat/sessions/session%2Fa/status");
  resolvers[1]!(Response.json({ sessionId: "session/a", workspaceId: "current" }));
  await expect(fresh).resolves.toMatchObject({ workspaceId: "current" });
  resolvers[0]!(Response.json({ sessionId: "session/a", workspaceId: "old" }));
  expect(await Promise.all([older, coalesced])).toEqual([
    { sessionId: "session/a", workspaceId: "old" }, { sessionId: "session/a", workspaceId: "old" },
  ]);
});
