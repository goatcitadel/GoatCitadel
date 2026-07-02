import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerTelegramIntegrationRoutes } from "./integrations-telegram-routes.js";

describe("integrations Telegram route tails", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (app) {
      await app.close();
      app = null;
    }
  });

  function createApp(integrations: Record<string, unknown> = {}, settings?: Record<string, unknown>) {
    app = Fastify();
    app.decorate("services", {
      integrations,
      ...(settings ? { settings } : {}),
    } as never);
    registerTelegramIntegrationRoutes(app);
    return app;
  }

  it("keeps Telegram pairing and target-directory routes behind CodeQL-visible rate limits", () => {
    const source = fs.readFileSync(new URL("./integrations-telegram-routes.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const RATE_LIMIT_AUTH_MAX = 60/);
    expect(source).toMatch(/"\/api\/v1\/channels\/connections\/:connectionId\/target-directory",\s*channelReadRoute/);
    expect(source).toMatch(
      /"\/api\/v1\/channels\/connections\/:connectionId\/telegram\/pairing\/approve",\s*pairingMutationRoute/,
    );
  });

  it("validates Telegram target discovery input and requires a usable token source", async () => {
    createApp();

    const invalid = await app!.inject({
      method: "POST",
      url: "/api/v1/integrations/telegram/discover-targets",
      payload: { connectionId: "not-a-uuid" },
    });
    expect(invalid.statusCode).toBe(400);

    const missingToken = await app!.inject({
      method: "POST",
      url: "/api/v1/integrations/telegram/discover-targets",
      payload: {},
    });
    expect(missingToken.statusCode).toBe(400);
    expect(missingToken.json()).toEqual({
      error: "Provide a Telegram bot token, token env var, or connection id.",
    });
  });

  it("discovers Telegram targets from direct and environment token inputs", async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 10,
                text: "setup ABC123",
                chat: { id: -100123, type: "supergroup", title: "Ops Room" },
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("TELEGRAM_ROUTE_TOKEN", "env-token");
    createApp();

    const direct = await app!.inject({
      method: "POST",
      url: "/api/v1/integrations/telegram/discover-targets",
      payload: { botToken: "  direct-token  ", setupCode: "ABC123" },
    });
    expect(direct.statusCode).toBe(200);
    expect(direct.json().items[0]).toMatchObject({
      id: "telegram:-100123",
      label: "Ops Room",
      setupCodeMatched: true,
    });

    const fromEnv = await app!.inject({
      method: "POST",
      url: "/api/v1/integrations/telegram/discover-targets",
      payload: { botTokenEnv: " TELEGRAM_ROUTE_TOKEN " },
    });
    expect(fromEnv.statusCode).toBe(200);
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://api.telegram.org/botdirect-token/getUpdates", undefined);
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.telegram.org/botenv-token/getUpdates", undefined);
  });

  it("surfaces Telegram target discovery provider failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ ok: false, description: "bot was blocked" }), { status: 403 });
      }),
    );
    createApp();

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/integrations/telegram/discover-targets",
      payload: { botToken: "token" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "bot was blocked" });
  });

  it("validates and builds Telegram target directories with refresh and query resolution", async () => {
    const getIntegrationConnection = vi
      .fn()
      .mockReturnValueOnce({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "slack",
        config: {},
      })
      .mockReturnValue({
        connectionId: "11111111-1111-1111-1111-111111111111",
        key: "telegram",
        config: {
          botToken: "telegram-token",
          setupCode: "ABC123",
          targets: [{ label: "Pinned Room", chatId: "-100999" }],
        },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 10,
                  text: "setup ABC123",
                  chat: { id: -100123, type: "supergroup", title: "Ops Room" },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    createApp({ getIntegrationConnection });

    const invalid = await app!.inject({
      method: "GET",
      url: "/api/v1/channels/connections/not-a-uuid/target-directory?refresh=maybe",
    });
    expect(invalid.statusCode).toBe(400);

    const wrongConnection = await app!.inject({
      method: "GET",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/target-directory",
    });
    expect(wrongConnection.statusCode).toBe(400);
    expect(wrongConnection.json()).toEqual({
      error: "Target directory v1 is available for Telegram connections.",
    });

    const refreshed = await app!.inject({
      method: "GET",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/target-directory?refresh=true&query=Ops%20Room",
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().directory.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ targetId: "-100123", displayLabel: "Ops Room" })]),
    );
    expect(refreshed.json().resolution).toEqual(
      expect.objectContaining({ status: "resolved", entry: expect.objectContaining({ targetId: "-100123" }) }),
    );
  });

  it("does not resolve arbitrary saved Telegram botTokenEnv names during target-directory refresh", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("DATABASE_URL", "postgres://secret-token-should-not-leave-process");
    const getIntegrationConnection = vi.fn(() => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      key: "telegram",
      config: {
        botTokenEnv: "DATABASE_URL",
        targets: [{ label: "Pinned Room", chatId: "-100999" }],
      },
    }));
    createApp({ getIntegrationConnection });

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/target-directory?refresh=true",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().directory.entries).toEqual([
      expect.objectContaining({ targetId: "-100999", displayLabel: "Pinned Room" }),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces Telegram target directory service failures and personality catalogs", async () => {
    createApp(
      {
        getIntegrationConnection: vi.fn(() => {
          throw new Error("connection lookup failed");
        }),
      },
      {
        getPersonalityCatalog: vi.fn(() => ({
          items: [{ id: "ops", label: "Ops" }],
          defaultPersonalityId: "ops",
        })),
      },
    );

    const directory = await app!.inject({
      method: "GET",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/target-directory",
    });
    expect(directory.statusCode).toBe(502);
    expect(directory.json()).toEqual({ error: "connection lookup failed" });

    const personalities = await app!.inject({
      method: "GET",
      url: "/api/v1/channels/personalities",
    });
    expect(personalities.statusCode).toBe(200);
    expect(personalities.json()).toEqual({
      items: [{ id: "ops", label: "Ops" }],
      defaultPersonalityId: "ops",
    });
  });

  it("validates and rejects unavailable Telegram pairing approvals", async () => {
    const updateIntegrationConnection = vi.fn();
    const getIntegrationConnection = vi
      .fn()
      .mockReturnValueOnce({ key: "slack", config: {} })
      .mockReturnValueOnce({ key: "telegram", config: {} })
      .mockImplementationOnce(() => {
        throw new Error("connection missing");
      });
    createApp({ getIntegrationConnection, updateIntegrationConnection });

    const invalid = await app!.inject({
      method: "POST",
      url: "/api/v1/channels/connections/not-a-uuid/telegram/pairing/approve",
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);

    const wrongConnection = await app!.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/telegram/pairing/approve",
      payload: { code: "ABCDEFGH" },
    });
    expect(wrongConnection.statusCode).toBe(400);
    expect(wrongConnection.json()).toEqual({
      error: "Telegram pairing approval is only available for Telegram connections.",
    });

    const notFound = await app!.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/telegram/pairing/approve",
      payload: { code: "ABCDEFGH" },
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ error: "Pairing code was not found or has expired." });
    expect(updateIntegrationConnection).not.toHaveBeenCalled();

    const missing = await app!.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/telegram/pairing/approve",
      payload: { code: "ABCDEFGH" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "connection missing" });
  });
});
