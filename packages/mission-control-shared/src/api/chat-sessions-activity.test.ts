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
});
