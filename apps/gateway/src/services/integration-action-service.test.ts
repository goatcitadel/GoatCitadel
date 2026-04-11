import { describe, expect, it, vi } from "vitest";
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

function createHost(connection: IntegrationConnection, overrides: Partial<IntegrationActionHost> = {}): IntegrationActionHost {
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
  it("dispatches local bridge actions through the configured bridge endpoint", async () => {
    const connection = createConnection({
      config: {
        bridgeUrl: "http://127.0.0.1:4040",
        authToken: "secret-token",
      },
    });
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        new Response(JSON.stringify({
          message: "bridge ok",
          output: {
            items: [{ title: "Sample note" }],
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
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
    const fetchMock = vi.fn()
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
    expect(readResult.output?.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Alpha board" })]));
    expect(writeResult.status).toBe("executed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
});
