import { afterEach, describe, expect, it, vi } from "vitest";
import { TuiApiClient } from "./api-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("TuiApiClient loop20 tails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends basic auth headers and treats 204 responses as empty objects", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const client = new TuiApiClient({
      baseUrl: "http://127.0.0.1:8787///",
      auth: { mode: "basic", username: "operator", password: "secret" },
      readOnly: false,
    });

    await expect(client.health()).resolves.toEqual({});
    expect(client.baseUrl).toBe("http://127.0.0.1:8787");
    expect(client.streamHeaders()).toEqual({
      Authorization: `Basic ${Buffer.from("operator:secret").toString("base64")}`,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((init as RequestInit).headers as Headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("operator:secret").toString("base64")}`,
    );
  });

  it("surfaces non-ok JSON request and streaming responses", async () => {
    const jsonFailure = vi.fn(async () => new Response("bad config", { status: 418 }));
    vi.stubGlobal("fetch", jsonFailure as unknown as typeof fetch);
    const client = new TuiApiClient({
      baseUrl: "http://127.0.0.1:8787",
      auth: { mode: "none" },
      readOnly: false,
    });

    await expect(client.health()).rejects.toThrow("GET /health failed (418): bad config");

    const streamFailure = vi.fn(async () => new Response("stream failed", { status: 503 }));
    vi.stubGlobal("fetch", streamFailure as unknown as typeof fetch);
    await expect(collectStream(client.streamChatMessage("session-1", { content: "hi" }))).rejects.toThrow(
      "POST /api/v1/chat/sessions/session-1/agent-send/stream failed (503): stream failed",
    );

    const readOnly = new TuiApiClient({
      baseUrl: "http://127.0.0.1:8787",
      auth: { mode: "none" },
      readOnly: true,
    });
    expect(readOnly.streamHeaders()).toEqual({});
    await expect(collectStream(readOnly.streamChatMessage("session-1", { content: "blocked" }))).rejects.toThrow(
      "Read-only mode is enabled",
    );
  });

  it("skips non-data SSE frames and errors on truncated final frames with previews", async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse([": keepalive\n\n", "event: ping\n\n", "data:   \n\n", 'data: {"type":"delta"}\n\n']),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const client = new TuiApiClient({
      baseUrl: "http://127.0.0.1:8787",
      auth: { mode: "none" },
      readOnly: false,
    });

    await expect(
      collectStream(client.streamChatMessage("session-1", { content: "hi", agentMode: true })),
    ).resolves.toEqual([{ type: "delta" }]);

    const [, streamInit] = fetchMock.mock.calls[0]!;
    expect((streamInit as RequestInit).body).toBe(JSON.stringify({ content: "hi" }));

    const longTail = "data: " + "x".repeat(260);
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([longTail])) as unknown as typeof fetch);
    await expect(collectStream(client.streamChatMessage("session-1", { content: "hi" }))).rejects.toThrow(
      /Streaming response ended before a complete SSE event was received: data: x{100,}\.\.\./,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(["data: " + "x".repeat(260_000)])) as unknown as typeof fetch,
    );
    await expect(collectStream(client.streamChatMessage("session-1", { content: "hi" }))).rejects.toThrow(
      "Streaming response exceeded the SSE buffer limit",
    );
  });

  it("covers less common endpoint wrappers with their query and mutation payloads", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/dev/diagnostics")) {
        expect(url).toContain("limit=50");
        return jsonResponse({ items: [] });
      }
      if (url.includes("/api/v1/skills/sources?")) {
        expect(url).toContain("q=browser+automation");
        expect(url).toContain("limit=100");
        return jsonResponse({ items: [] });
      }
      if (url.includes("/api/v1/chat/sessions/session-1/messages")) {
        expect(url).toContain("limit=25");
        expect(url).toContain("cursor=cursor-1");
        return jsonResponse({ items: [], nextCursor: undefined });
      }
      if (url.includes("/api/v1/chat/sessions?")) {
        expect(url).toContain("workspaceId=workspace-1");
        expect(url).toContain("projectId=project-1");
        expect(url).toContain("scope=external");
        expect(url).toContain("view=archived");
        expect(url).toContain("q=search");
        return jsonResponse({ items: [], nextCursor: undefined });
      }
      if (url.includes("/api/v1/memory/items?")) {
        expect(url).toContain("namespace=work");
        expect(url).toContain("status=forgotten");
        expect(url).toContain("query=needle");
        return jsonResponse({ items: [] });
      }
      if (url.includes("/api/v1/tools/grants?")) {
        expect(url).toContain("scope=session");
        expect(url).toContain("scopeRef=session-1");
        expect(url).toContain("limit=25");
        return jsonResponse({ items: [] });
      }
      if (url.includes("/api/v1/skills/import/history")) {
        expect(url).toContain("limit=300");
        return jsonResponse({ items: [] });
      }
      if (url.includes("/api/v1/skills/by-id/state")) {
        expect(init?.method).toBe("PATCH");
        expect(init?.body).toBe(JSON.stringify({ state: "enabled", note: "ok", skillId: "skill-1" }));
        return jsonResponse({ skillId: "skill-1", state: "enabled" });
      }
      if (url.includes("/api/v1/llm/models/preview")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ items: [{ id: "model-preview" }] });
      }
      if (url.includes("/api/v1/llm/models")) {
        expect(url).toContain("providerId=openai");
        return jsonResponse({ items: [{ id: "gpt-test" }] });
      }
      if (url.includes("/api/v1/llm/config")) {
        return jsonResponse({ activeProviderId: "openai" });
      }
      if (url.includes("/api/v1/mcp/templates/discovery")) {
        return jsonResponse({ items: [{ templateId: "discovered" }] });
      }
      if (url.includes("/api/v1/mcp/templates")) {
        return jsonResponse({ items: [{ templateId: "node", installed: false }] });
      }
      if (url.includes("/api/v1/mcp/servers")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ serverId: "server-1" });
      }
      if (url.includes("/api/v1/voice/google-meet/prerequisites")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const client = new TuiApiClient({
      baseUrl: "http://127.0.0.1:8787",
      auth: { mode: "token", token: "secret" },
      readOnly: false,
    });

    await expect(client.devDiagnostics(999)).resolves.toEqual({ items: [] });
    await expect(client.googleMeetPrerequisites()).resolves.toEqual({ ok: true });
    await expect(
      client.listChatSessions({
        limit: 10,
        workspaceId: "workspace-1",
        projectId: "project-1",
        scope: "external",
        view: "archived",
        q: "search",
      }),
    ).resolves.toEqual({ items: [], nextCursor: undefined });
    await expect(client.listChatMessages("session-1", 25, "cursor-1")).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });
    await expect(client.listSkillSources(" browser automation ", 999)).resolves.toEqual({ items: [] });
    await expect(client.fetchSkillImportHistory(999)).resolves.toEqual({ items: [] });
    await expect(client.updateSkillState("skill-1", { state: "enabled", note: "ok" })).resolves.toMatchObject({
      skillId: "skill-1",
    });
    await expect(client.fetchLlmConfig()).resolves.toEqual({ activeProviderId: "openai" });
    await expect(client.listLlmModels("openai")).resolves.toEqual({ items: [{ id: "gpt-test" }] });
    await expect(client.fetchLlmModels("openai")).resolves.toEqual({ items: [{ id: "gpt-test" }] });
    await expect(
      client.previewLlmModels({
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).resolves.toEqual({ items: [{ id: "model-preview" }] });
    await expect(client.fetchMcpTemplates()).resolves.toEqual({ items: [{ templateId: "node", installed: false }] });
    await expect(client.fetchMcpTemplateDiscovery()).resolves.toEqual({ items: [{ templateId: "discovered" }] });
    await expect(
      client.createMcpServer({
        label: "Node",
        transport: "stdio",
        command: "node",
      }),
    ).resolves.toEqual({ serverId: "server-1" });
    await expect(
      client.listMemoryItems({
        namespace: "work",
        status: "forgotten",
        query: "needle",
        limit: 5,
      }),
    ).resolves.toEqual({ items: [] });
    await expect(
      client.toolsListGrants({
        scope: "session",
        scopeRef: "session-1",
        limit: 25,
      }),
    ).resolves.toEqual({ items: [] });
  });
});

async function collectStream(stream: AsyncIterable<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
