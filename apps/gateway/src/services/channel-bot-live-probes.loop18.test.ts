import { describe, expect, it, vi } from "vitest";
import {
  runDiscordBotLiveChecks,
  runIMessageBridgeLiveChecks,
  runLineBotLiveChecks,
  runMattermostBotLiveChecks,
  runSignalBridgeLiveChecks,
  runSlackBotLiveChecks,
  runTelegramBotLiveChecks,
  runWhatsAppCloudLiveChecks,
  runZaloBotLiveChecks,
  runZaloUserBridgeLiveChecks,
} from "./channel-bot-live-probes.js";

describe("channel bot live probes loop 18 failure coverage", () => {
  it("classifies Slack sandbox send failures and transport errors after auth succeeds", async () => {
    const sendFailure = await runSlackBotLiveChecks({
      token: "xoxb-test",
      channel: "C123",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string) => {
        if (url === "https://slack.com/api/auth.test") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 });
      }),
    });

    expect(sendFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "slack_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "slack_sandbox_send",
        status: "fail",
        failureCategory: "unknown",
        message: expect.stringContaining("not in that channel"),
      }),
    ]);

    const sendTransportFailure = await runSlackBotLiveChecks({
      token: "xoxb-test",
      channel: "C123",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string) => {
        if (url === "https://slack.com/api/auth.test") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error("chat.postMessage timeout");
      }),
    });

    expect(sendTransportFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "slack_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "slack_sandbox_send",
        status: "warn",
        failureCategory: "platform_unavailable",
        message: expect.stringContaining("chat.postMessage timeout"),
      }),
    ]);
  });

  it("covers Telegram auth-only, transport, send, and missing-cleanup decisions", async () => {
    const authOnlyFetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const authOnly = await runTelegramBotLiveChecks({
      token: "123:test",
      chatId: "999",
      includeSandboxSend: false,
      fetcher: authOnlyFetcher,
    });
    expect(authOnlyFetcher).toHaveBeenCalledTimes(1);
    expect(authOnly.probe.steps).toEqual([expect.objectContaining({ key: "telegram_token_auth", status: "pass" })]);

    const authTransportFailure = await runTelegramBotLiveChecks({
      token: "123:test",
      chatId: "999",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("telegram dns failure");
      }),
    });
    expect(authTransportFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "telegram_token_auth",
        status: "warn",
        failureCategory: "platform_unavailable",
        message: expect.stringContaining("telegram dns failure"),
      }),
    ]);

    const sendFailure = await runTelegramBotLiveChecks({
      token: "123:test",
      chatId: "999",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string) => {
        if (url.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 404 });
      }),
    });
    expect(sendFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "telegram_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "telegram_sandbox_send",
        status: "fail",
        failureCategory: "destination_mismatch",
        message: "chat not found",
      }),
    ]);

    const missingCleanupId = await runTelegramBotLiveChecks({
      token: "123:test",
      chatId: "999",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string) => {
        if (url.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }),
    });
    expect(missingCleanupId.probe.steps).toEqual([
      expect.objectContaining({ key: "telegram_token_auth", status: "pass" }),
      expect.objectContaining({ key: "telegram_sandbox_send", status: "pass" }),
      expect.objectContaining({
        key: "telegram_sandbox_cleanup",
        status: "warn",
        failureCategory: "unknown",
      }),
    ]);
  });

  it("reports Discord gateway failures without hiding runtime status", async () => {
    const missingToken = await runDiscordBotLiveChecks({
      runtimeMode: "gateway",
      includeSandboxSend: true,
      fetcher: vi.fn(),
    });
    expect(missingToken.probe.steps).toEqual([
      expect.objectContaining({
        key: "discord_token_auth",
        status: "fail",
        failureCategory: "credential_rejected",
      }),
      expect.objectContaining({ key: "discord_channel_access", status: "skipped" }),
      expect.objectContaining({ key: "discord_sandbox_send", status: "skipped" }),
      expect.objectContaining({
        key: "discord_runtime_ready",
        status: "fail",
        failureCategory: "bridge_unavailable",
      }),
    ]);

    const channelFailure = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "missing-channel",
      runtimeMode: "gateway",
      includeSandboxSend: true,
      runtimeStatus: { ready: true },
      fetcher: vi.fn(async (url: string) => {
        if (url.endsWith("/users/@me")) {
          return new Response(JSON.stringify({ id: "bot_1" }), { status: 200 });
        }
        return new Response(JSON.stringify({ message: "Unknown Channel" }), { status: 404 });
      }),
    });
    expect(channelFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "discord_channel_access",
        status: "fail",
        failureCategory: "destination_mismatch",
      }),
      expect.objectContaining({ key: "discord_runtime_ready", status: "pass", message: "Gateway runtime is ready." }),
    ]);

    const missingMessageId = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "channel_1",
      runtimeMode: "gateway",
      includeSandboxSend: true,
      runtimeStatus: { ready: false },
      fetcher: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/users/@me") || url.endsWith("/channels/channel_1")) {
          return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
        }
        if (init?.method === "POST") {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error(`unexpected Discord cleanup: ${url}`);
      }),
    });
    expect(missingMessageId.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({ key: "discord_channel_access", status: "pass" }),
      expect.objectContaining({ key: "discord_sandbox_send", status: "pass" }),
      expect.objectContaining({
        key: "discord_sandbox_cleanup",
        status: "warn",
        failureCategory: "unknown",
      }),
      expect.objectContaining({
        key: "discord_runtime_ready",
        status: "warn",
        message: "Gateway runtime has not reached Discord ready state yet.",
      }),
    ]);
  });

  it("covers Mattermost parser branches, send failures, and cleanup id warnings", async () => {
    const authFailure = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com/",
      token: "mattermost-token",
      defaultChannel: "#town-square",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => new Response(JSON.stringify({ message: "invalid token" }), { status: 401 })),
    });
    expect(authFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "mattermost_token_auth",
        status: "fail",
        failureCategory: "credential_rejected",
        message: "invalid token",
      }),
    ]);

    const channelId = "abcdefghijklmnopqrstuvwx12";
    const missingPostId = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com/",
      token: "mattermost-token",
      defaultChannel: `channel:${channelId}`,
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/users/me")) {
          return new Response(JSON.stringify({ id: "bot-user-1" }), { status: 200 });
        }
        if (url.endsWith("/posts") && init?.method === "POST") {
          return new Response(JSON.stringify({}), { status: 201 });
        }
        throw new Error(`unexpected Mattermost call: ${init?.method ?? "GET"} ${url}`);
      }),
    });
    expect(missingPostId.probe.steps).toEqual([
      expect.objectContaining({ key: "mattermost_token_auth", status: "pass" }),
      expect.objectContaining({ key: "mattermost_channel_access", status: "pass" }),
      expect.objectContaining({ key: "mattermost_sandbox_send", status: "pass" }),
      expect.objectContaining({
        key: "mattermost_sandbox_cleanup",
        status: "warn",
        failureCategory: "unknown",
      }),
    ]);

    const sendTransportFailure = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com/",
      token: "mattermost-token",
      defaultChannel: `channel:${channelId}`,
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/users/me")) {
          return new Response(JSON.stringify({ id: "bot-user-1" }), { status: 200 });
        }
        if (url.endsWith("/posts") && init?.method === "POST") {
          throw new Error("mattermost post timeout");
        }
        throw new Error(`unexpected Mattermost call: ${init?.method ?? "GET"} ${url}`);
      }),
    });
    expect(sendTransportFailure.probe.steps.at(-1)).toMatchObject({
      key: "mattermost_sandbox_send",
      status: "warn",
      failureCategory: "platform_unavailable",
    });
  });

  it("covers WhatsApp, LINE, Signal, Zalo, and Zalo User send failures", async () => {
    const whatsappAuthOnlyFetcher = vi.fn(
      async () => new Response(JSON.stringify({ id: "123456789012345" }), { status: 200 }),
    );
    const whatsappAuthOnly = await runWhatsAppCloudLiveChecks({
      accessToken: "wa-token",
      phoneNumberId: "123456789012345",
      includeSandboxSend: false,
      fetcher: whatsappAuthOnlyFetcher,
    });
    expect(whatsappAuthOnly.probe.steps).toEqual([
      expect.objectContaining({ key: "whatsapp_token_auth", status: "pass" }),
    ]);
    expect(whatsappAuthOnlyFetcher).toHaveBeenCalledTimes(1);

    const whatsappSendFailure = await runWhatsAppCloudLiveChecks({
      accessToken: "wa-token",
      phoneNumberId: "123456789012345",
      defaultTarget: "+15551234567",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ error: { message: "recipient blocked" } }), { status: 403 });
        }
        return new Response(JSON.stringify({ id: "123456789012345" }), { status: 200 });
      }),
    });
    expect(whatsappSendFailure.probe.steps.at(-1)).toMatchObject({
      key: "whatsapp_sandbox_send",
      status: "fail",
      failureCategory: "permission_mismatch",
      message: "recipient blocked",
    });

    const lineSendFailure = await runLineBotLiveChecks({
      channelAccessToken: "line-token",
      defaultTarget: "line:user:U123",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/bot/info")) {
          return new Response(JSON.stringify({ userId: "bot" }), { status: 200 });
        }
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ message: "invalid user" }), { status: 400 });
      }),
    });
    expect(lineSendFailure.probe.steps.at(-1)).toMatchObject({
      key: "line_sandbox_send",
      status: "fail",
      failureCategory: "unknown",
      message: "invalid user",
    });

    const signalSkipped = await runSignalBridgeLiveChecks({
      baseUrl: "https://signal.example.com/",
      includeSandboxSend: false,
      fetcher: vi.fn(),
    });
    expect(signalSkipped.probe.steps).toEqual([
      expect.objectContaining({ key: "signal_sandbox_send", status: "skipped" }),
    ]);

    const signalFailure = await runSignalBridgeLiveChecks({
      baseUrl: "https://signal.example.com/",
      defaultTarget: "u:operator",
      includeSandboxSend: true,
      fetcher: vi.fn(
        async () => new Response(JSON.stringify({ error: { message: "unknown recipient" } }), { status: 200 }),
      ),
    });
    expect(signalFailure.probe.steps.at(-1)).toMatchObject({
      key: "signal_sandbox_send",
      status: "fail",
      message: "unknown recipient",
    });

    const zaloSkipped = await runZaloBotLiveChecks({
      accessToken: "zalo-token",
      includeSandboxSend: false,
      fetcher: vi.fn(),
    });
    expect(zaloSkipped.probe.steps).toEqual([expect.objectContaining({ key: "zalo_sandbox_send", status: "skipped" })]);

    const zaloFailure = await runZaloBotLiveChecks({
      accessToken: "zalo-token",
      defaultTarget: "zalo:oa:chat-1",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => new Response(JSON.stringify({ ok: false, message: "rate limited" }), { status: 429 })),
    });
    expect(zaloFailure.probe.steps.at(-1)).toMatchObject({
      key: "zalo_sandbox_send",
      status: "fail",
      message: "rate limited",
    });

    const zaloUserSkipped = await runZaloUserBridgeLiveChecks({
      baseUrl: "https://zalo-user.example.com/",
      includeSandboxSend: false,
      fetcher: vi.fn(),
    });
    expect(zaloUserSkipped.probe.steps).toEqual([
      expect.objectContaining({ key: "zalouser_sandbox_send", status: "skipped" }),
    ]);

    const zaloUserFailure = await runZaloUserBridgeLiveChecks({
      baseUrl: "https://zalo-user.example.com/",
      authorizationHeader: "Bearer bridge-token",
      profile: "default",
      defaultTarget: "group:ops",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => new Response(JSON.stringify({ error: "bridge offline" }), { status: 503 })),
    });
    expect(zaloUserFailure.probe.steps.at(-1)).toMatchObject({
      key: "zalouser_sandbox_send",
      status: "warn",
      failureCategory: "platform_unavailable",
      message: "bridge offline",
    });
  });

  it("covers BlueBubbles auth, send, cleanup, and target parsing failures", async () => {
    const authFailure = await runIMessageBridgeLiveChecks({
      bridgeUrl: "127.0.0.1:1234",
      password: "bb-password",
      defaultHandle: "bluebubbles:handle:operator@example.test",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad password" } }), { status: 401 })),
    });
    expect(authFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "imessage_bridge_auth",
        status: "fail",
        failureCategory: "credential_rejected",
        message: "bad password",
      }),
    ]);

    const sendFailure = await runIMessageBridgeLiveChecks({
      bridgeUrl: "http://127.0.0.1:1234/",
      password: "bb-password",
      defaultHandle: "sms:+1 (555) 123-4567",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/chat/query")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ message: "send denied" }), { status: 403 });
      }),
    });
    expect(sendFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "imessage_bridge_auth", status: "pass" }),
      expect.objectContaining({
        key: "imessage_sandbox_send",
        status: "fail",
        failureCategory: "permission_mismatch",
        message: "send denied",
      }),
    ]);

    const cleanupFailureFetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/chat/query")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.includes("/chat/new")) {
        return new Response(JSON.stringify({ data: { guid: "msg/with/slash" } }), { status: 200 });
      }
      expect(url).toContain("/message/msg/with/slash/unsend");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ error: { error_user_msg: "unsend disabled" } }), { status: 403 });
    });
    const cleanupFailure = await runIMessageBridgeLiveChecks({
      bridgeUrl: "http://127.0.0.1:1234/",
      password: "bb-password",
      defaultHandle: "bluebubbles:operator@example.test",
      includeSandboxSend: true,
      fetcher: cleanupFailureFetcher,
    });
    expect(cleanupFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "imessage_bridge_auth", status: "pass" }),
      expect.objectContaining({ key: "imessage_sandbox_send", status: "pass" }),
      expect.objectContaining({
        key: "imessage_sandbox_cleanup",
        status: "warn",
        failureCategory: "permission_mismatch",
        message: "unsend disabled",
      }),
    ]);
  });

  it("covers Discord transport, send, and cleanup failure tails", async () => {
    const authTransportFailure = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "channel_1",
      runtimeMode: "gateway",
      runtimeStatus: { ready: true, connectedBotTag: "GoatBot#1234" },
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("discord auth socket closed");
      }),
    });
    expect(authTransportFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "discord_token_auth",
        status: "warn",
        failureCategory: "platform_unavailable",
        message: expect.stringContaining("discord auth socket closed"),
      }),
      expect.objectContaining({ key: "discord_runtime_ready", status: "pass" }),
    ]);

    const channelTransportFailure = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "channel_1",
      runtimeMode: "gateway",
      runtimeStatus: { ready: true },
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string) => {
        if (url.endsWith("/users/@me")) {
          return new Response(JSON.stringify({ id: "bot_1" }), { status: 200 });
        }
        throw new Error("channel lookup timeout");
      }),
    });
    expect(channelTransportFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "discord_channel_access",
        status: "warn",
        failureCategory: "platform_unavailable",
        message: expect.stringContaining("channel lookup timeout"),
      }),
      expect.objectContaining({ key: "discord_runtime_ready", status: "pass" }),
    ]);

    const sendFailure = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "channel_1",
      runtimeMode: "gateway",
      runtimeStatus: { ready: true },
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/users/@me") || url.endsWith("/channels/channel_1")) {
          return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
        }
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ message: "Missing Permissions" }), { status: 403 });
      }),
    });
    expect(sendFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({ key: "discord_channel_access", status: "pass" }),
      expect.objectContaining({
        key: "discord_sandbox_send",
        status: "fail",
        failureCategory: "permission_mismatch",
      }),
      expect.objectContaining({ key: "discord_runtime_ready", status: "pass" }),
    ]);

    const cleanupFailure = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "channel_1",
      runtimeMode: "gateway",
      runtimeStatus: { ready: true },
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/users/@me") || url.endsWith("/channels/channel_1")) {
          return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
        }
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ id: "message_1" }), { status: 200 });
        }
        return new Response(JSON.stringify({ message: "delete failed" }), { status: 500 });
      }),
    });
    expect(cleanupFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({ key: "discord_channel_access", status: "pass" }),
      expect.objectContaining({ key: "discord_sandbox_send", status: "pass" }),
      expect.objectContaining({
        key: "discord_sandbox_cleanup",
        status: "warn",
        failureCategory: "platform_unavailable",
      }),
      expect.objectContaining({ key: "discord_runtime_ready", status: "pass" }),
    ]);
  });

  it("covers Mattermost, WhatsApp, and LINE transport or auth-only tails", async () => {
    const mattermostTransportFailure = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com/",
      token: "mattermost-token",
      defaultChannel: "#town-square",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("mattermost auth timeout");
      }),
    });
    expect(mattermostTransportFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "mattermost_token_auth",
        status: "warn",
        failureCategory: "platform_unavailable",
      }),
    ]);

    const mattermostAuthOnly = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com/",
      token: "mattermost-token",
      defaultChannel: "channel:abcdefghijklmnopqrstuvwx12",
      includeSandboxSend: false,
      fetcher: vi.fn(async () => new Response(JSON.stringify({ id: "bot-user-1" }), { status: 200 })),
    });
    expect(mattermostAuthOnly.probe.steps).toEqual([
      expect.objectContaining({ key: "mattermost_token_auth", status: "pass" }),
      expect.objectContaining({ key: "mattermost_channel_access", status: "pass" }),
    ]);

    const whatsappAuthFailure = await runWhatsAppCloudLiveChecks({
      accessToken: "wa-token",
      phoneNumberId: "123456789012345",
      defaultTarget: "+15551234567",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => new Response(JSON.stringify({ message: "bad sender" }), { status: 404 })),
    });
    expect(whatsappAuthFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "whatsapp_token_auth",
        status: "fail",
        failureCategory: "destination_mismatch",
        message: "bad sender",
      }),
    ]);

    const whatsappSendTransportFailure = await runWhatsAppCloudLiveChecks({
      accessToken: "wa-token",
      phoneNumberId: "123456789012345",
      defaultTarget: "+15551234567",
      includeSandboxSend: true,
      fetcher: vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          throw new Error("graph send timeout");
        }
        return new Response(JSON.stringify({ id: "123456789012345" }), { status: 200 });
      }),
    });
    expect(whatsappSendTransportFailure.probe.steps.at(-1)).toMatchObject({
      key: "whatsapp_sandbox_send",
      status: "warn",
      failureCategory: "platform_unavailable",
    });

    const lineAuthFailure = await runLineBotLiveChecks({
      channelAccessToken: "line-token",
      defaultTarget: "U123",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => new Response(JSON.stringify({ message: "bad token" }), { status: 401 })),
    });
    expect(lineAuthFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "line_token_auth",
        status: "fail",
        failureCategory: "credential_rejected",
        message: "bad token",
      }),
    ]);

    const lineTransportFailure = await runLineBotLiveChecks({
      channelAccessToken: "line-token",
      defaultTarget: "U123",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("line api timeout");
      }),
    });
    expect(lineTransportFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "line_token_auth",
        status: "warn",
        failureCategory: "platform_unavailable",
      }),
    ]);
  });

  it("covers bridge missing-target and send transport tails", async () => {
    const imessageAuthTransportFailure = await runIMessageBridgeLiveChecks({
      bridgeUrl: "127.0.0.1:1234",
      password: "bb-password",
      defaultHandle: "operator@example.test",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("bluebubbles unavailable");
      }),
    });
    expect(imessageAuthTransportFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "imessage_bridge_auth",
        status: "warn",
        failureCategory: "platform_unavailable",
      }),
    ]);

    const imessageAuthOnly = await runIMessageBridgeLiveChecks({
      bridgeUrl: "127.0.0.1:1234",
      password: "bb-password",
      defaultHandle: "operator@example.test",
      includeSandboxSend: false,
      fetcher: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    });
    expect(imessageAuthOnly.probe.steps).toEqual([
      expect.objectContaining({ key: "imessage_bridge_auth", status: "pass" }),
    ]);

    const imessageSendTransportFailure = await runIMessageBridgeLiveChecks({
      bridgeUrl: "127.0.0.1:1234",
      password: "bb-password",
      defaultHandle: "operator@example.test",
      includeSandboxSend: true,
      fetcher: vi.fn(async (url: string) => {
        if (url.includes("/chat/query")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        throw new Error("bluebubbles send timeout");
      }),
    });
    expect(imessageSendTransportFailure.probe.steps.at(-1)).toMatchObject({
      key: "imessage_sandbox_send",
      status: "warn",
      failureCategory: "platform_unavailable",
    });

    const signalMissingTarget = await runSignalBridgeLiveChecks({
      baseUrl: "https://signal.example.com/",
      defaultTarget: " ",
      includeSandboxSend: true,
      fetcher: vi.fn(),
    });
    expect(signalMissingTarget.probe.steps).toEqual([
      expect.objectContaining({
        key: "signal_sandbox_send",
        status: "fail",
        failureCategory: "missing_input",
      }),
    ]);

    const signalTransportFailure = await runSignalBridgeLiveChecks({
      baseUrl: "https://signal.example.com/",
      defaultTarget: "group:ops",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("signal bridge offline");
      }),
    });
    expect(signalTransportFailure.probe.steps.at(-1)).toMatchObject({
      key: "signal_sandbox_send",
      status: "warn",
      failureCategory: "platform_unavailable",
    });

    const zaloTransportFailure = await runZaloBotLiveChecks({
      accessToken: "zalo-token",
      defaultTarget: "chat-1",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("zalo timeout");
      }),
    });
    expect(zaloTransportFailure.probe.steps.at(-1)).toMatchObject({
      key: "zalo_sandbox_send",
      status: "warn",
      failureCategory: "platform_unavailable",
    });

    const zaloUserMissingTarget = await runZaloUserBridgeLiveChecks({
      baseUrl: "https://zalo-user.example.com/",
      defaultTarget: " ",
      includeSandboxSend: true,
      fetcher: vi.fn(),
    });
    expect(zaloUserMissingTarget.probe.steps).toEqual([
      expect.objectContaining({
        key: "zalouser_sandbox_send",
        status: "fail",
        failureCategory: "missing_input",
      }),
    ]);

    const zaloUserTransportFailure = await runZaloUserBridgeLiveChecks({
      baseUrl: "https://zalo-user.example.com/",
      defaultTarget: "user:operator",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("zalo user bridge timeout");
      }),
    });
    expect(zaloUserTransportFailure.probe.steps.at(-1)).toMatchObject({
      key: "zalouser_sandbox_send",
      status: "warn",
      failureCategory: "platform_unavailable",
    });
  });
});
