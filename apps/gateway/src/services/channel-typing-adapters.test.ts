import type { IntegrationConnection } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiscordRestTyping,
  emitMatrixTyping,
  emitMattermostTyping,
  emitProviderTyping,
  emitWhatsAppTyping,
  resetMatrixTypingUserCache,
  resetMattermostTypingUserCache,
  type ChannelTypingAdapterArgs,
} from "./channel-typing-adapters.js";

const CHANNEL_ID = "abcdefghijklmnopqrstuvwxyz";

type Harness = ChannelTypingAdapterArgs & { fetch: ReturnType<typeof vi.fn> };

function connection(key: string, config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: `${key}-1`,
    kind: "channel",
    key,
    catalogId: `channel.${key}`,
    label: key,
    config,
  } as unknown as IntegrationConnection;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function args(
  conn: IntegrationConnection,
  input: Partial<ChannelTypingAdapterArgs["input"]>,
  overrides: Partial<ChannelTypingAdapterArgs> = {},
): Harness {
  const fetch = vi.fn(async () => json({}));
  return {
    connection: conn,
    input: { connectionId: conn.connectionId, target: "t", ...input },
    resolveSecret: (config: Record<string, unknown>, direct: string) =>
      typeof config[direct] === "string" ? (config[direct] as string) : undefined,
    isAllowlisted: () => true,
    fetch,
    ...overrides,
  } as Harness;
}

beforeEach(() => {
  resetMattermostTypingUserCache();
  resetMatrixTypingUserCache();
});

describe("Mattermost typing", () => {
  const conn = connection("mattermost", { serverUrl: "https://mm.example.com/", botToken: "tok" });

  it("looks up the bot user once and posts the typing event", async () => {
    const a = args(conn, { target: `channel:${CHANNEL_ID}`, threadId: "root1" });
    a.fetch
      .mockResolvedValueOnce(json({ id: "bot-user" }))
      .mockResolvedValueOnce(json({ status: "OK" }))
      .mockResolvedValueOnce(json({ status: "OK" }));
    const result = await emitMattermostTyping(a);
    expect(result).toMatchObject({ status: "sent", supported: true, channelKey: "mattermost" });
    const [meUrl, meInit] = a.fetch.mock.calls[0];
    expect(meUrl).toBe("https://mm.example.com/api/v4/users/me");
    expect(new Headers(meInit.headers).get("Authorization")).toBe("Bearer tok");
    const [url, init] = a.fetch.mock.calls[1];
    expect(url).toBe("https://mm.example.com/api/v4/users/bot-user/typing");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ channel_id: CHANNEL_ID, parent_id: "root1" });
    await emitMattermostTyping(a);
    expect(a.fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://mm.example.com/api/v4/users/me",
      "https://mm.example.com/api/v4/users/bot-user/typing",
      "https://mm.example.com/api/v4/users/bot-user/typing",
    ]);
  });

  it("omits parent_id when there is no thread", async () => {
    const a = args(conn, { target: CHANNEL_ID });
    a.fetch.mockResolvedValueOnce(json({ id: "u" })).mockResolvedValueOnce(json({}));
    await emitMattermostTyping(a);
    expect(JSON.parse(a.fetch.mock.calls[1][1].body)).toEqual({ channel_id: CHANNEL_ID });
  });

  it("returns unsupported when the allowlist denies the host", async () => {
    const a = args(conn, { target: CHANNEL_ID }, { isAllowlisted: () => false });
    const result = await emitMattermostTyping(a);
    expect(result).toMatchObject({ status: "unsupported", supported: false });
    expect(result.reason).toMatch(/allowlist/i);
    expect(a.fetch).not.toHaveBeenCalled();
  });

  it("reports the HTTP status on a 4xx", async () => {
    const a = args(conn, { target: CHANNEL_ID });
    a.fetch.mockResolvedValueOnce(json({ id: "u" })).mockResolvedValueOnce(json({ message: "no" }, 403));
    const result = await emitMattermostTyping(a);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toContain("403");
  });

  it("rejects targets that are not channel ids and never throws", async () => {
    const result = await emitMattermostTyping(args(conn, { target: "town-square" }));
    expect(result.status).toBe("unsupported");
    const failing = args(conn, { target: CHANNEL_ID });
    failing.fetch.mockRejectedValue(new Error("boom"));
    expect(await emitMattermostTyping(failing)).toMatchObject({ status: "unsupported" });
  });
});

describe("typing over plain HTTP", () => {
  const cases = [
    {
      name: "Matrix",
      emit: emitMatrixTyping,
      make: (url: string) => connection("matrix", { homeserverUrl: url, accessToken: "syt_tok" }),
      target: "!room:example.com",
      identity: { user_id: "@bot:example.com" },
    },
    {
      name: "Mattermost",
      emit: emitMattermostTyping,
      make: (url: string) => connection("mattermost", { serverUrl: url, botToken: "tok" }),
      target: `channel:${CHANNEL_ID}`,
      identity: { id: "bot-user" },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: refuses a remote http server without calling fetch`, async () => {
      const a = args(c.make("http://remote.example.org"), { target: c.target });
      const result = await c.emit(a);
      expect(result.status).toBe("unsupported");
      expect(result.reason).toContain("HTTPS");
      expect(a.fetch).not.toHaveBeenCalled();
    });

    for (const url of ["http://localhost:8008", "https://remote.example.org"]) {
      it(`${c.name}: allows ${url}`, async () => {
        const a = args(c.make(url), { target: c.target });
        a.fetch.mockResolvedValueOnce(json(c.identity)).mockResolvedValueOnce(json({}));
        expect((await c.emit(a)).status).toBe("sent");
      });
    }
  }
});

describe("Matrix typing", () => {
  const conn = connection("matrix", { homeserverUrl: "https://matrix.example.com/", accessToken: "syt_tok" });
  const ROOM = "!room:example.com";

  it("resolves the bot user with whoami once, then PUTs the typing state", async () => {
    const a = args(conn, { target: ROOM });
    a.fetch
      .mockResolvedValueOnce(json({ user_id: "@bot:example.com" }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({}));
    const result = await emitMatrixTyping(a);
    expect(result).toMatchObject({ status: "sent", supported: true, channelKey: "matrix" });
    const [whoamiUrl, whoamiInit] = a.fetch.mock.calls[0];
    expect(whoamiUrl).toBe("https://matrix.example.com/_matrix/client/v3/account/whoami");
    expect(new Headers(whoamiInit.headers).get("Authorization")).toBe("Bearer syt_tok");
    const [url, init] = a.fetch.mock.calls[1];
    expect(url).toBe(
      "https://matrix.example.com/_matrix/client/v3/rooms/!room%3Aexample.com/typing/%40bot%3Aexample.com",
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ typing: true, timeout: 10000 });
    await emitMatrixTyping(a);
    expect(a.fetch.mock.calls.map((c) => c[0])).toHaveLength(3);
  });

  it("accepts a matrix: prefixed room, and denies on allowlist, bad targets and 4xx without throwing", async () => {
    const prefixed = args(conn, { target: `matrix:${ROOM}` });
    prefixed.fetch.mockResolvedValueOnce(json({ user_id: "@bot:example.com" })).mockResolvedValueOnce(json({}));
    expect((await emitMatrixTyping(prefixed)).status).toBe("sent");

    const denied = args(conn, { target: ROOM }, { isAllowlisted: () => false });
    expect(await emitMatrixTyping(denied)).toMatchObject({ status: "unsupported" });
    expect(denied.fetch).not.toHaveBeenCalled();

    const serverless = args(conn, { target: "!opaqueRoomV12" });
    serverless.fetch.mockResolvedValueOnce(json({ user_id: "@bot:example.com" })).mockResolvedValueOnce(json({}));
    expect((await emitMatrixTyping(serverless)).status).toBe("sent");
    resetMatrixTypingUserCache();

    expect((await emitMatrixTyping(args(conn, { target: "general" }))).status).toBe("unsupported");

    resetMatrixTypingUserCache();
    const forbidden = args(conn, { target: ROOM });
    forbidden.fetch
      .mockResolvedValueOnce(json({ user_id: "@bot:example.com" }))
      .mockResolvedValueOnce(json({ errcode: "M_FORBIDDEN", error: "no" }, 403));
    const result = await emitMatrixTyping(forbidden);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toContain("403");
    expect(result.reason).not.toContain("syt_tok");
  });

  it("is routed by emitProviderTyping", async () => {
    const a = args(conn, { target: ROOM });
    a.fetch.mockResolvedValueOnce(json({ user_id: "@bot:example.com" })).mockResolvedValueOnce(json({}));
    expect((await emitProviderTyping(a)).channelKey).toBe("matrix");
  });
});

describe("WhatsApp typing", () => {
  const conn = connection("whatsapp", { phoneNumberId: "555", accessToken: "wtok" });

  it("requires an inbound message id", async () => {
    const a = args(conn, { target: "15551234" });
    const result = await emitWhatsAppTyping(a);
    expect(result).toMatchObject({ status: "unsupported", supported: false });
    expect(result.reason).toBe(
      "WhatsApp typing indicators are tied to an inbound message; no message id was supplied.",
    );
    expect(a.fetch).not.toHaveBeenCalled();
  });

  it("posts a read receipt with a typing indicator", async () => {
    const a = args(conn, { target: "15551234", messageId: "wamid.X" });
    a.fetch.mockResolvedValueOnce(json({ success: true }));
    const result = await emitWhatsAppTyping(a);
    expect(result).toMatchObject({ status: "sent", supported: true, channelKey: "whatsapp" });
    const [url, init] = a.fetch.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v23.0/555/messages");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer wtok");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.X",
      typing_indicator: { type: "text" },
    });
  });

  it("denies on allowlist, 4xx and non-Meta base URLs", async () => {
    const denied = await emitWhatsAppTyping(args(conn, { messageId: "m" }, { isAllowlisted: () => false }));
    expect(denied.status).toBe("unsupported");
    const four = args(conn, { messageId: "m" });
    four.fetch.mockResolvedValueOnce(json({ error: { message: "bad" } }, 400));
    expect((await emitWhatsAppTyping(four)).reason).toContain("400");
    const evil = args(
      connection("whatsapp", { phoneNumberId: "5", accessToken: "t", baseUrl: "https://evil.example" }),
      { messageId: "m" },
    );
    expect((await emitWhatsAppTyping(evil)).status).toBe("unsupported");
    expect(evil.fetch).not.toHaveBeenCalled();
  });
});

describe("emitProviderTyping dispatch", () => {
  it("routes by channel key and rejects others", async () => {
    const a = args(connection("whatsapp", { phoneNumberId: "555", accessToken: "wtok" }), {
      target: "15551234",
      messageId: "wamid.X",
    });
    a.fetch.mockResolvedValueOnce(json({ success: true }));
    expect(await emitProviderTyping(a)).toMatchObject({ status: "sent", channelKey: "whatsapp" });
    const other = await emitProviderTyping(args(connection("slack", {}), {}));
    expect(other.status).toBe("unsupported");
  });

  it.each([
    ["signal", { baseUrl: "http://127.0.0.1:1" }, "+1"],
    ["imessage", { bridgeUrl: "http://127.0.0.1:1234", password: "bb-secret" }, "chat_guid:iMessage;-;+1"],
  ])("has no typing adapter for the retired %s channel and sends nothing", async (key, config, target) => {
    const a = args(connection(key, config), { target });
    const result = await emitProviderTyping(a);
    expect(result).toMatchObject({ status: "unsupported", supported: false, channelKey: key });
    expect(result.reason).toContain("has not wired a typing adapter yet");
    expect(a.fetch).not.toHaveBeenCalled();
  });
});

describe("Discord REST typing (bridge mode)", () => {
  const conn = connection("discord", { runtimeMode: "bridge", botToken: "bot-tok" });

  it("posts the REST typing endpoint for a channel target", async () => {
    const a = args(conn, { target: "channel:123456789012345678" });
    a.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await emitDiscordRestTyping(a);
    expect(result).toMatchObject({ status: "sent", supported: true, channelKey: "discord" });
    expect(result.expiresAt).toBeDefined();
    const [url, init] = a.fetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/channels/123456789012345678/typing");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bot bot-tok");
  });

  it("opens the DM channel first for a user target", async () => {
    const a = args(conn, { target: "user:223456789012345678" });
    a.fetch
      .mockResolvedValueOnce(json({ id: "323456789012345678" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await emitDiscordRestTyping(a)).status).toBe("sent");
    expect(a.fetch.mock.calls[0][0]).toBe("https://discord.com/api/v10/users/@me/channels");
    expect(JSON.parse(a.fetch.mock.calls[0][1].body)).toEqual({ recipient_id: "223456789012345678" });
    expect(a.fetch.mock.calls[1][0]).toBe("https://discord.com/api/v10/channels/323456789012345678/typing");
  });

  it("falls back to defaultChannelId and rejects non-snowflake targets", async () => {
    const withDefault = args(connection("discord", { botToken: "t", defaultChannelId: "123456789012345678" }), {
      target: "",
    });
    withDefault.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await emitDiscordRestTyping(withDefault)).status).toBe("sent");
    const bad = args(conn, { target: "general" });
    const result = await emitDiscordRestTyping(bad);
    expect(result).toMatchObject({ status: "unsupported", supported: false });
    expect(bad.fetch).not.toHaveBeenCalled();
  });

  it("reports webhook-only connections, allowlist denials and 4xx without throwing", async () => {
    const webhook = await emitDiscordRestTyping(
      args(connection("discord", { webhookUrl: "https://discord.com/api/webhooks/1/x" }), {
        target: "123456789012345678",
      }),
    );
    expect(webhook.reason).toMatch(/webhooks cannot send typing indicators/);
    const denied = args(conn, { target: "123456789012345678" }, { isAllowlisted: () => false });
    expect((await emitDiscordRestTyping(denied)).reason).toMatch(/not in the current outbound allowlist/);
    expect(denied.fetch).not.toHaveBeenCalled();
    const forbidden = args(conn, { target: "123456789012345678" });
    forbidden.fetch.mockResolvedValueOnce(json({ message: "Missing Access" }, 403));
    expect((await emitDiscordRestTyping(forbidden)).reason).toBe("Discord typing failed (403): Missing Access");
  });
});
