import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { invokeIntegrationConnectionAction, type IntegrationActionHost } from "./integration-action-service.js";

function createConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "productivity.apple-notes",
    kind: "productivity",
    key: "apple-notes",
    label: "Apple Notes",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function createHost(
  connection: IntegrationConnection,
  overrides: Partial<IntegrationActionHost> = {},
): IntegrationActionHost {
  return {
    storage: {
      integrationConnections: {
        get: vi.fn(() => connection),
      },
    },
    fetchWithDiagnosticsTimeout: vi.fn(),
    readConnectionConfigValue: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn((config: Record<string, unknown>, directKey: string, envKey: string) => {
      const direct = config[directKey];
      if (typeof direct === "string" && direct.length > 0) {
        return direct;
      }
      const envValue = config[envKey];
      return typeof envValue === "string" && envValue.length > 0 ? envValue : undefined;
    }),
    publishRealtime: vi.fn(),
    ...overrides,
  };
}

describe("integration-action-service", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dispatches local bridge actions through the configured bridge endpoint", async () => {
    const connection = createConnection({
      config: {
        bridgeUrl: "http://127.0.0.1:4040",
        authToken: "secret-token",
      },
    });
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: "bridge ok",
              output: {
                items: [{ title: "Sample note" }],
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "read");

    expect(result.status).toBe("executed");
    expect(result.message).toContain("bridge ok");
    expect(host.fetchWithDiagnosticsTimeout).toHaveBeenCalledWith(
      "http://127.0.0.1:4040/v1/integrations/actions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
        }),
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalled();
  });

  it("executes Trello read and write actions through the core-native Trello runtime", async () => {
    const connection = createConnection({
      catalogId: "productivity.trello",
      key: "trello",
      label: "Trello",
      config: {
        apiKey: "trello-key",
        token: "trello-token",
        defaultListId: "list-123",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "board-1", name: "Alpha board" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "card-1", name: "GoatCitadel operator card" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
    });

    const readResult = await invokeIntegrationConnectionAction(host, connection.connectionId, "read");
    const writeResult = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
      input: { name: "GoatCitadel operator card" },
    });

    expect(readResult.status).toBe("executed");
    expect(readResult.output?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Alpha board" })]),
    );
    expect(writeResult.status).toBe("executed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records audit-only durable envelopes for external writeback actions", async () => {
    const connection = createConnection({
      catalogId: "productivity.trello",
      key: "trello",
      label: "Trello",
      config: {
        apiKey: "trello-key",
        token: "trello-token",
        defaultListId: "list-123",
      },
    });
    const createEnvelope = vi.fn(() => ({
      envelopeId: "env-writeback-1",
      eventKind: "external_writeback",
      contentHash: "content-hash",
      payloadHash: "payload-hash",
      toolCallHashes: [],
      memoryLineage: [],
      signatureStatus: "unsigned_local",
      metadata: {},
      createdAt: "2026-04-10T12:00:00.000Z",
    }));
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "card-1", url: "https://trello.example.test/c/card-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      evidenceEnvelopeService: { createEnvelope } as never,
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
      input: { name: "Durable card" },
    });

    expect(result.durableWriteback).toEqual(
      expect.objectContaining({
        status: "recorded",
        replayPolicy: "audit_only",
        resumable: false,
        envelopeId: "env-writeback-1",
        contentHash: "content-hash",
        signatureStatus: "unsigned_local",
      }),
    );
    expect(createEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "external_writeback",
        metadata: expect.objectContaining({
          boundary: "integration_operator_action",
          externalSideEffect: true,
          replayPolicy: "audit_only",
          resumable: false,
          connectionId: connection.connectionId,
          catalogId: "productivity.trello",
          actionId: "write",
          status: "executed",
          inputKeys: ["name"],
          outputKeys: ["id", "url"],
          externalReferenceId: "id:card-1",
        }),
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "system",
      "integrations",
      expect.objectContaining({
        durableWritebackStatus: "recorded",
        durableWritebackEnvelopeId: "env-writeback-1",
      }),
    );
  });

  it("falls back between local bridge endpoints and reports the final bridge failure context", async () => {
    const connection = createConnection({
      config: {
        bridgeUrl: "http://127.0.0.1:4040/",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "legacy endpoint unavailable" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("bridge offline", { status: 503 }));
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "read", {
      input: { limit: 2 },
    });

    expect(result).toMatchObject({
      status: "failed",
      message: "bridge offline",
      output: {
        bridgeUrl: "http://127.0.0.1:4040/",
      },
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:4040/v1/integrations/actions",
      "http://127.0.0.1:4040/api/v1/integrations/actions",
    ]);
  });

  it("returns readable blocked output when GIF search is visible but not configured", async () => {
    const connection = createConnection({
      catalogId: "automation.gif-search",
      key: "gif-search",
      kind: "automation",
      label: "GIF Search",
      config: {
        provider: "tenor",
      },
    });
    const host = createHost(connection);

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "search", {
      input: { query: "goat" },
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("gif_api_key_missing");
    expect(result.message).toContain("API key");
  });

  it("normalizes Tenor and Giphy GIF search results from provider-specific payloads", async () => {
    vi.stubEnv("GOATCITADEL_TENOR_API_BASE_URL", "https://tenor.example.test");
    vi.stubEnv("GOATCITADEL_GIPHY_API_BASE_URL", "https://giphy.example.test");
    const tenorConnection = createConnection({
      catalogId: "automation.gif-search",
      key: "gif-search",
      kind: "automation",
      label: "GIF Search",
      config: {
        provider: "tenor",
        apiKey: "tenor-key",
        defaultLocale: "en_GB",
      },
    });
    const giphyConnection = createConnection({
      ...tenorConnection,
      connectionId: "22222222-2222-2222-2222-222222222222",
      config: {
        provider: "giphy",
        apiKey: "giphy-key",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "tenor-1",
                content_description: "Goat wave",
                media_formats: {
                  tinygif: { url: "https://cdn.example.test/tiny.gif" },
                  gif: { url: "https://cdn.example.test/full.gif" },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "giphy-1",
                title: "Goat salute",
                images: {
                  fixed_height: { url: "https://cdn.example.test/fixed.gif" },
                  original: { url: "https://cdn.example.test/original.gif" },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const tenor = await invokeIntegrationConnectionAction(
      createHost(tenorConnection, { fetchWithDiagnosticsTimeout: fetchMock }),
      tenorConnection.connectionId,
      "search",
      { input: { query: "ops check" } },
    );
    const giphy = await invokeIntegrationConnectionAction(
      createHost(giphyConnection, { fetchWithDiagnosticsTimeout: fetchMock }),
      giphyConnection.connectionId,
      "search",
      { input: { query: "ops check" } },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://tenor.example.test/v2/search?key=tenor-key&q=ops+check&limit=5&locale=en_GB",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://giphy.example.test/v1/gifs/search?api_key=giphy-key&q=ops+check&limit=5&rating=pg-13",
    );
    expect(tenor.output?.items).toEqual([
      {
        id: "tenor-1",
        title: "Goat wave",
        url: "https://cdn.example.test/full.gif",
      },
    ]);
    expect(giphy.output?.items).toEqual([
      {
        id: "giphy-1",
        title: "Goat salute",
        url: "https://cdn.example.test/original.gif",
      },
    ]);
  });

  it("executes Gmail read and write actions through the core-native Gmail runtime", async () => {
    const connection = createConnection({
      catalogId: "automation.gmail",
      key: "gmail",
      kind: "automation",
      label: "Gmail",
      config: {
        accessToken: "gmail-token",
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "msg-1", threadId: "thread-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "sent-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
    });

    const readResult = await invokeIntegrationConnectionAction(host, connection.connectionId, "read", {
      input: { query: "label:inbox" },
    });
    const writeResult = await invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
      input: {
        to: "ops@example.com",
        subject: "GoatCitadel operator check",
        bodyText: "This is a GoatCitadel Gmail operator check.",
      },
    });

    expect(readResult.status).toBe("executed");
    expect(readResult.output?.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "msg-1" })]));
    expect(writeResult.status).toBe("executed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks incomplete Gmail writes and surfaces provider read failures", async () => {
    const connection = createConnection({
      catalogId: "automation.gmail",
      key: "gmail",
      kind: "automation",
      label: "Gmail",
      config: {
        accessToken: "gmail-token",
      },
    });
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("quota exceeded", { status: 429 })),
    });

    await expect(
      invokeIntegrationConnectionAction(host, connection.connectionId, "write", {
        input: {
          to: "ops@example.com",
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      blockedReason: "gmail_message_incomplete",
    });
    await expect(invokeIntegrationConnectionAction(host, connection.connectionId, "read")).resolves.toMatchObject({
      status: "failed",
      message: "quota exceeded",
      output: {
        provider: "gmail",
      },
    });
  });
});
