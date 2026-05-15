import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { DiscordRuntimeService } from "./discord-runtime-service.js";

describe("DiscordRuntimeService loop25 runtime status", () => {
  it("persists fallback status for enabled gateway connections that have no bot token", async () => {
    const service = createService({
      listConnections: () => [createConnection({ botToken: "", botTokenEnv: "MISSING_DISCORD_TOKEN_FOR_LOOP25" })],
    });

    await service.sync();

    expect(service.getConnectionStatus("discord-loop25")).toEqual({
      connectionId: "discord-loop25",
      runtimeMode: "gateway",
      enabled: true,
      ready: false,
      guildIds: [],
      lastError: "Discord gateway mode requires a bot token or env-backed bot token.",
    });
  });

  it("records login errors in the connection status without throwing from sync", async () => {
    const service = createService({
      listConnections: () => [createConnection({ botToken: "token-loop25" })],
    });
    const runtime = {
      token: "token-loop25",
      client: {
        destroy: vi.fn(),
      },
      connectionIds: new Set(["discord-loop25"]),
      guildIds: [],
      ready: false,
    };
    (service as unknown as { createManagedRuntime: () => typeof runtime }).createManagedRuntime = () => runtime;
    (service as unknown as { loginRuntime: () => Promise<void> }).loginRuntime = vi.fn(async () => {
      throw new Error("gateway login rejected");
    });

    await service.sync();
    await Promise.resolve();

    expect(service.getConnectionStatus("discord-loop25")).toMatchObject({
      connectionId: "discord-loop25",
      runtimeMode: "gateway",
      enabled: true,
      ready: false,
      guildIds: [],
      lastError: "gateway login rejected",
    });
  });

  it("clears stale runtime status when all managed runtimes are closed", async () => {
    const service = createService();
    const destroy = vi.fn(async () => undefined);
    (service as unknown as { runtimesByToken: Map<string, unknown> }).runtimesByToken.set("token-loop25", {
      token: "token-loop25",
      client: { destroy },
      connectionIds: new Set(["discord-loop25"]),
      guildIds: ["guild-loop25"],
      ready: true,
    });
    (service as unknown as { updateStatusSnapshot: (runtime: unknown) => void }).updateStatusSnapshot(
      (service as unknown as { runtimesByToken: Map<string, unknown> }).runtimesByToken.get("token-loop25"),
    );

    await service.close();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(service.getConnectionStatus("discord-loop25")).toBeUndefined();
  });
});

function createConnection(config: Record<string, unknown> = {}): IntegrationConnection {
  return {
    connectionId: "discord-loop25",
    catalogId: "channel.discord",
    kind: "channel",
    key: "discord",
    label: "Discord Loop25",
    enabled: true,
    status: "connected",
    config: {
      runtimeMode: "gateway",
      guildPolicy: "allowlist",
      guilds: {},
      ...config,
    },
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}

function createService(overrides: Partial<ConstructorParameters<typeof DiscordRuntimeService>[0]> = {}) {
  return new DiscordRuntimeService({
    listConnections: () => [],
    findApprovedPairing: () => undefined,
    ensurePendingPairing: () => {
      throw new Error("unexpected pairing request");
    },
    touchPairing: () => {},
    onInboundMessage: vi.fn(),
    onSlashCommand: vi.fn(async () => "ok"),
    listModelSuggestions: vi.fn(async () => []),
    publishDiagnostic: vi.fn(),
    ...overrides,
  });
}
