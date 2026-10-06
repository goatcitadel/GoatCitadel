import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("fetchChatSessions activity", () => {
  it("asks for turn activity only when requested", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchChatSessions } = await import("./chat");
    await fetchChatSessions({ workspaceId: "workspace-a", includeActivity: true });
    await fetchChatSessions({ workspaceId: "workspace-a" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("includeActivity=true");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("includeActivity");
  });

  it("asks session search for turn activity only when requested", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [], query: "deploy", mode: "discovery", generatedAt: "2026-10-05T10:00:00.000Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchChatSessionSearch } = await import("./chat");
    await fetchChatSessionSearch({ query: "deploy", workspaceId: "workspace-a", includeActivity: true });
    await fetchChatSessionSearch({ query: "deploy", workspaceId: "workspace-a" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/chat/session-search?");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("includeActivity=true");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("includeActivity");
  });

  it("passes the palette's abort signal to the session search request", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse({ items: [], query: "deploy", mode: "discovery", generatedAt: "2026-10-05T10:00:00.000Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchChatSessionSearch } = await import("./chat");
    const controller = new AbortController();
    await fetchChatSessionSearch({ query: "deploy", workspaceId: "workspace-a" }, { signal: controller.signal });
    const init = fetchMock.mock.calls[0]?.[1];
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });
});
