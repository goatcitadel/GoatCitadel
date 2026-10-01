import { afterEach, expect, it, vi } from "vitest";
import { fetchChatMessages } from "./chat.js";

afterEach(() => vi.unstubAllGlobals());
it("keeps a required latest-message context read independent of an older message GET", async () => {
  const resolvers: Array<(value: Response) => void> = [];
  const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => resolvers.push(resolve)));
  vi.stubGlobal("fetch", fetchMock);
  const older = fetchChatMessages("session/a", 1), coalesced = fetchChatMessages("session/a", 1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = new AbortController().signal;
  const fresh = fetchChatMessages("session/a", 1, undefined, signal);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store", signal });
  expect(fetchMock.mock.calls[1]?.[1]?.method ?? "GET").toBe("GET");
  expect(new URL(fetchMock.mock.calls[1]![0]).pathname).toBe("/api/v1/chat/sessions/session%2Fa/messages");
  const message = { messageId: "m", sessionId: "session/a", role: "assistant", actorType: "agent", actorId: "fixture", sourceAuthority: "agent_proposed", content: "Current context", timestamp: "2026-10-01T00:00:00.000Z" };
  const current = { items: [message] }, previous = { items: [{ ...message, messageId: "old", content: "Old context" }] };
  resolvers[1]!(Response.json(current)); await expect(fresh).resolves.toEqual(current);
  resolvers[0]!(Response.json(previous)); expect(await Promise.all([older, coalesced])).toEqual([previous, previous]);
});
