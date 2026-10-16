import type { IntegrationConnection } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitBlueBubblesTyping,
  emitDiscordRestTyping,
  emitMattermostTyping,
  emitProviderTyping,
  emitSignalTyping,
  emitWhatsAppTyping,
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

beforeEach(() => resetMattermostTypingUserCache());

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

describe("Signal typing", () => {
  const conn = connection("signal", { baseUrl: "http://127.0.0.1:8080/", account: "+15550001" });

  it("sends a sendTyping RPC to a recipient", async () => {
    const a = args(conn, { target: "signal:+15551234" });
    a.fetch.mockResolvedValueOnce(json({ jsonrpc: "2.0", result: {}, id: "1" }));
    const result = await emitSignalTyping(a);
    expect(result).toMatchObject({ status: "sent", supported: true, channelKey: "signal" });
    const [url, init] = a.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8080/api/v1/rpc");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ jsonrpc: "2.0", method: "sendTyping" });
    expect(body.params).toEqual({ account: "+15550001", recipient: ["+15551234"] });
  });

  it("uses groupId for group: targets", async () => {
    const a = args(conn, { target: "group:abc==" });
    a.fetch.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const result = await emitSignalTyping(a);
    expect(result.status).toBe("sent");
    expect(JSON.parse(a.fetch.mock.calls[0][1].body).params).toEqual({ account: "+15550001", groupId: "abc==" });
  });

  it("denies on allowlist, 4xx and RPC errors", async () => {
    const denied = await emitSignalTyping(args(conn, { target: "+1" }, { isAllowlisted: () => false }));
    expect(denied.status).toBe("unsupported");
    const four = args(conn, { target: "+1" });
    four.fetch.mockResolvedValueOnce(json({}, 404));
    expect((await emitSignalTyping(four)).reason).toContain("404");
    const rpc = args(conn, { target: "+1" });
    rpc.fetch.mockResolvedValueOnce(json({ error: { message: "nope" } }));
    expect((await emitSignalTyping(rpc)).status).toBe("unsupported");
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
    const a = args(connection("signal", { baseUrl: "http://127.0.0.1:1" }), { target: "+1" });
    a.fetch.mockResolvedValueOnce(json({ result: {} }));
    expect((await emitProviderTyping(a)).channelKey).toBe("signal");
    const other = await emitProviderTyping(args(connection("slack", {}), {}));
    expect(other.status).toBe("unsupported");
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

describe("BlueBubbles iMessage typing", () => {
  const conn = connection("imessage", { bridgeUrl: "127.0.0.1:1234", password: "bb-secret" });

  it("posts the chat typing endpoint with the password query", async () => {
    const a = args(conn, { target: "chat_guid:iMessage;-;+15551234567" });
    a.fetch.mockResolvedValueOnce(json({ status: 200, message: "Successfully started typing!" }));
    const result = await emitBlueBubblesTyping(a);
    expect(result).toMatchObject({ status: "sent", supported: true, channelKey: "imessage" });
    const [url, init] = a.fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1234/api/v1/chat/iMessage%3B-%3B%2B15551234567/typing?password=bb-secret");
    expect(init.method).toBe("POST");
  });

  it("accepts a raw group chat GUID", async () => {
    const a = args(conn, { target: "iMessage;+;chat123456" });
    a.fetch.mockResolvedValueOnce(json({}));
    expect((await emitBlueBubblesTyping(a)).status).toBe("sent");
  });

  it("requires a chat GUID target and never leaks the password in reasons", async () => {
    const handle = args(conn, { target: "imessage:+15551234567" });
    expect((await emitBlueBubblesTyping(handle)).reason).toMatch(/needs a chat GUID target/);
    expect(handle.fetch).not.toHaveBeenCalled();
    const denied = args(conn, { target: "chat_guid:iMessage;-;+1555" }, { isAllowlisted: () => false });
    const deniedResult = await emitBlueBubblesTyping(denied);
    expect(deniedResult.reason).toMatch(/not in the current outbound allowlist: http:\/\/127\.0\.0\.1:1234$/);
    expect(deniedResult.reason).not.toContain("bb-secret");
    const privateApiOff = args(conn, { target: "chat_guid:iMessage;-;+1555" });
    privateApiOff.fetch.mockResolvedValueOnce(json({ message: "iMessage Private API Helper is not connected!" }, 500));
    const failed = await emitBlueBubblesTyping(privateApiOff);
    expect(failed.reason).toMatch(/BlueBubbles typing failed \(500\).*Private API/);
    expect(failed.reason).not.toContain("bb-secret");
  });

  it("refuses non-BlueBubbles providers and missing passwords", async () => {
    const photon = await emitBlueBubblesTyping(
      args(connection("imessage", { bridgeUrl: "http://h", password: "p", bridgeProvider: "photon" }), {
        target: "chat_guid:iMessage;-;+1",
      }),
    );
    expect(photon.reason).toMatch(/needs the BlueBubbles provider/);
    const noPassword = await emitBlueBubblesTyping(
      args(connection("imessage", { bridgeUrl: "http://h" }), { target: "chat_guid:iMessage;-;+1" }),
    );
    expect(noPassword.reason).toMatch(/missing a BlueBubbles password/);
  });
});
