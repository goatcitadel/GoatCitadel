import type { IntegrationConnection } from "@goatcitadel/mission-control-shared/api/types";
import { describe, expect, it } from "vitest";
import { newestTelegramConnection } from "./use-new-connection-href";

function connection(
  connectionId: string,
  config: Record<string, unknown>,
  overrides: Partial<IntegrationConnection> = {},
): IntegrationConnection {
  return {
    connectionId,
    revision: "1",
    catalogId: "channel.telegram",
    kind: "channel",
    key: "telegram",
    label: "Telegram",
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
    ...overrides,
  } as IntegrationConnection;
}

describe("newestTelegramConnection", () => {
  it("takes the newest Telegram connection for the bot, whatever its @ or case", () => {
    const found = newestTelegramConnection(
      [
        connection("old", { botUsername: "@MyGoatBot" }, { createdAt: "2026-10-01T00:00:00.000Z" }),
        connection("new", { botUsername: "mygoatbot" }, { createdAt: "2026-10-26T00:00:00.000Z" }),
        connection("mid", { botUsername: "@MYGOATBOT" }, { createdAt: "2026-10-10T00:00:00.000Z" }),
      ],
      "MyGoatBot",
    );
    expect(found?.connectionId).toBe("new");
  });

  it("accepts a bot name given with the @", () => {
    expect(
      newestTelegramConnection([connection("one", { botUsername: "@MyGoatBot" })], "@MyGoatBot")?.connectionId,
    ).toBe("one");
  });

  it("passes over another bot, another channel, and a connection that names no bot", () => {
    const found = newestTelegramConnection(
      [
        connection("other-bot", { botUsername: "@Other" }),
        connection("discord", { botUsername: "@MyGoatBot" }, { key: "discord" }),
        connection("no-bot", {}),
        connection("number", { botUsername: 42 }),
      ],
      "MyGoatBot",
    );
    expect(found).toBeUndefined();
  });

  it("finds nothing in an empty list", () => {
    expect(newestTelegramConnection([], "MyGoatBot")).toBeUndefined();
  });
});
