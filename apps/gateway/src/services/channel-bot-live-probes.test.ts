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

describe("channel bot live probes", () => {
  it("runs Slack auth, send, and cleanup probes", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://slack.com/api/auth.test") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(JSON.stringify({ ok: true, ts: "1712.100", channel: "C123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const result = await runSlackBotLiveChecks({
      token: "xoxb-test",
      channel: "C123",
      includeSandboxSend: true,
      checkedAt: "2026-03-29T20:10:00.000Z",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.probe.steps.map((step) => step.key)).toEqual([
      "slack_token_auth",
      "slack_sandbox_send",
      "slack_sandbox_cleanup",
    ]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("runs Telegram auth, send, and cleanup probes", async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    const result = await runTelegramBotLiveChecks({
      token: "123:test",
      chatId: "999",
      parseMode: "MarkdownV2",
      includeSandboxSend: true,
      checkedAt: "2026-03-29T20:10:00.000Z",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.probe.steps.map((step) => step.key)).toEqual([
      "telegram_token_auth",
      "telegram_sandbox_send",
      "telegram_sandbox_cleanup",
    ]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    const sendCall = fetcher.mock.calls.find((call) => String(call[0]).includes("/sendMessage"));
    const sendInit = sendCall?.[1];
    expect(sendInit).toBeDefined();
    expect(JSON.parse(String(sendInit?.body))).toEqual({
      chat_id: "999",
      text: "[GoatCitadel Telegram probe 2026-03-29T20:10:00.000Z] Channel setup smoke check. Delete me if I remain.",
    });
  });

  it("keeps non-destructive bot diagnostics auth-only", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await runSlackBotLiveChecks({
      token: "xoxb-test",
      channel: "C123",
      includeSandboxSend: false,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.probe.steps.map((step) => step.key)).toEqual(["slack_token_auth"]);
  });

  it("reports cleanup failures as warnings after a successful Slack sandbox send", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://slack.com/api/auth.test") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(JSON.stringify({ ok: true, ts: "1712.100", channel: "C123" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: "missing_scope" }), { status: 403 });
    });

    const result = await runSlackBotLiveChecks({
      token: "xoxb-test",
      channel: "C123",
      includeSandboxSend: true,
      fetcher,
    });

    expect(result.probe.steps).toEqual([
      expect.objectContaining({ key: "slack_token_auth", status: "pass" }),
      expect.objectContaining({ key: "slack_sandbox_send", status: "pass" }),
      expect.objectContaining({ key: "slack_sandbox_cleanup", status: "warn" }),
    ]);
  });

  it("reports Slack transport failures and missing cleanup handles without retrying destructive probes", async () => {
    const authFailure = await runSlackBotLiveChecks({
      token: "xoxb-test",
      channel: "C123",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    expect(authFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "slack_token_auth",
        status: "warn",
        failureCategory: "platform_unavailable",
        message: expect.stringContaining("network down"),
      }),
    ]);

    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://slack.com/api/auth.test") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, channel: "C123" }), { status: 200 });
    });

    const missingTimestamp = await runSlackBotLiveChecks({
      token: "xoxb-test",
      channel: "C123",
      includeSandboxSend: true,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(missingTimestamp.probe.steps).toEqual([
      expect.objectContaining({ key: "slack_token_auth", status: "pass" }),
      expect.objectContaining({ key: "slack_sandbox_send", status: "pass" }),
      expect.objectContaining({
        key: "slack_sandbox_cleanup",
        status: "warn",
        failureCategory: "unknown",
      }),
    ]);
  });

  it("runs Discord auth, channel access, sandbox send, cleanup, and runtime probes", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://discord.com/api/v10/users/@me") {
        return new Response(JSON.stringify({ id: "bot_1" }), { status: 200 });
      }
      if (url === "https://discord.com/api/v10/channels/channel_1") {
        return new Response(JSON.stringify({ id: "channel_1" }), { status: 200 });
      }
      if (url === "https://discord.com/api/v10/channels/channel_1/messages" && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "message_1" }), { status: 200 });
      }
      if (url === "https://discord.com/api/v10/channels/channel_1/messages/message_1" && init?.method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "channel_1",
      runtimeMode: "gateway",
      includeSandboxSend: true,
      runtimeStatus: {
        ready: true,
        connectedBotTag: "GoatBot#1234",
      },
      checkedAt: "2026-03-31T20:10:00.000Z",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.probe.steps.map((step) => step.key)).toEqual([
      "discord_token_auth",
      "discord_channel_access",
      "discord_sandbox_send",
      "discord_sandbox_cleanup",
      "discord_runtime_ready",
    ]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    const sendCall = fetcher.mock.calls.find(
      (call) => String(call[0]).includes("/messages") && call[1]?.method === "POST",
    );
    const sendInit = sendCall?.[1];
    expect(sendInit).toBeDefined();
    expect(JSON.parse(String(sendInit?.body))).toEqual({
      content: "[GoatCitadel Discord probe 2026-03-31T20:10:00.000Z] Bridge health check. Delete me if I remain.",
    });
  });

  it("treats webhook-only Discord bridge paths as auth-skipped without sandbox send", async () => {
    const fetcher = vi.fn();

    const result = await runDiscordBotLiveChecks({
      runtimeMode: "bridge",
      webhookUrl: "https://discord.com/api/webhooks/test",
      includeSandboxSend: true,
      fetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "skipped" }),
      expect.objectContaining({ key: "discord_channel_access", status: "skipped" }),
      expect.objectContaining({ key: "discord_sandbox_send", status: "skipped" }),
    ]);
  });

  it("reports Discord runtime readiness warnings after successful bridge probes", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://discord.com/api/v10/users/@me") {
        return new Response(JSON.stringify({ id: "bot_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "channel_1" }), { status: 200 });
    });

    const result = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "channel_1",
      runtimeMode: "gateway",
      includeSandboxSend: false,
      runtimeStatus: {
        ready: false,
        lastError: "Gateway login timed out",
      },
      fetcher,
    });

    expect(result.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({ key: "discord_channel_access", status: "pass" }),
      expect.objectContaining({
        key: "discord_runtime_ready",
        status: "warn",
        message: "Gateway runtime is not ready: Gateway login timed out",
      }),
    ]);
  });

  it("classifies Discord token failures without attempting channel or sandbox probes", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "401: Unauthorized" }), {
          status: 401,
        }),
    );

    const result = await runDiscordBotLiveChecks({
      token: "bad-token",
      channelId: "channel_1",
      runtimeMode: "gateway",
      includeSandboxSend: true,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.probe.steps).toEqual([
      expect.objectContaining({
        key: "discord_token_auth",
        status: "fail",
        message: "Discord returned HTTP 401.",
        failureCategory: "credential_rejected",
      }),
      expect.objectContaining({
        key: "discord_runtime_ready",
        status: "fail",
        failureCategory: "bridge_unavailable",
      }),
    ]);
  });

  it("runs Mattermost auth, channel access, sandbox send, and cleanup probes", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://chat.example.com/api/v4/users/me") {
        return new Response(JSON.stringify({ id: "bot-user-1" }), { status: 200 });
      }
      if (url === "https://chat.example.com/api/v4/teams/name/ops") {
        return new Response(JSON.stringify({ id: "team-1" }), { status: 200 });
      }
      if (url === "https://chat.example.com/api/v4/teams/team-1/channels/name/town-square") {
        return new Response(JSON.stringify({ id: "channel-1" }), { status: 200 });
      }
      if (url === "https://chat.example.com/api/v4/posts" && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "post-1" }), { status: 201 });
      }
      if (url === "https://chat.example.com/api/v4/posts/post-1" && init?.method === "DELETE") {
        return new Response("", { status: 200 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com",
      token: "mattermost-token",
      defaultChannel: "town-square",
      defaultTeam: "ops",
      includeSandboxSend: true,
      checkedAt: "2026-04-02T12:00:00.000Z",
      fetcher,
    });

    expect(result.probe.steps.map((step) => step.key)).toEqual([
      "mattermost_token_auth",
      "mattermost_channel_access",
      "mattermost_sandbox_send",
      "mattermost_sandbox_cleanup",
    ]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("runs WhatsApp auth and sandbox send probes", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("fields=id%2Cdisplay_phone_number%2Cverified_name")) {
        return new Response(JSON.stringify({ id: "123456789012345" }), { status: 200 });
      }
      if (url === "https://graph.facebook.com/v23.0/123456789012345/messages" && init?.method === "POST") {
        return new Response(JSON.stringify({ messages: [{ id: "wamid.12345" }] }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runWhatsAppCloudLiveChecks({
      accessToken: "wa-token",
      phoneNumberId: "123456789012345",
      defaultTarget: "+15551234567",
      includeSandboxSend: true,
      checkedAt: "2026-04-02T12:00:00.000Z",
      fetcher,
    });

    expect(result.probe.steps.map((step) => step.key)).toEqual(["whatsapp_token_auth", "whatsapp_sandbox_send"]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("runs LINE auth and sandbox send probes", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.line.me/v2/bot/info") {
        return new Response(JSON.stringify({ userId: "line-bot-1" }), { status: 200 });
      }
      if (url === "https://api.line.me/v2/bot/message/push" && init?.method === "POST") {
        return new Response("", { status: 200, headers: { "x-line-request-id": "line-request-1" } });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runLineBotLiveChecks({
      channelAccessToken: "line-token",
      defaultTarget: "user-123",
      includeSandboxSend: true,
      checkedAt: "2026-04-02T12:00:00.000Z",
      fetcher,
    });

    expect(result.probe.steps.map((step) => step.key)).toEqual(["line_token_auth", "line_sandbox_send"]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("runs iMessage bridge auth, sandbox send, and cleanup probes", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://127.0.0.1:1234/api/v1/chat/query?password=bb-password") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url === "http://127.0.0.1:1234/api/v1/chat/new?password=bb-password" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { guid: "bb-msg-123" } }), { status: 200 });
      }
      if (
        url === "http://127.0.0.1:1234/api/v1/message/bb-msg-123/unsend?password=bb-password" &&
        init?.method === "POST"
      ) {
        return new Response(JSON.stringify({ data: { guid: "bb-msg-123" } }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runIMessageBridgeLiveChecks({
      bridgeUrl: "http://127.0.0.1:1234",
      password: "bb-password",
      defaultHandle: "imessage:+15551234567",
      includeSandboxSend: true,
      checkedAt: "2026-04-02T12:00:00.000Z",
      fetcher,
    });

    expect(result.probe.steps.map((step) => step.key)).toEqual([
      "imessage_bridge_auth",
      "imessage_sandbox_send",
      "imessage_sandbox_cleanup",
    ]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("runs Signal bridge sandbox send probes against the JSON-RPC send path", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://signal.example.com/api/v1/rpc" && init?.method === "POST") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 1712345678 } }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runSignalBridgeLiveChecks({
      baseUrl: "https://signal.example.com",
      accountId: "+15557654321",
      defaultTarget: "group:group-123",
      includeSandboxSend: true,
      checkedAt: "2026-04-02T12:00:00.000Z",
      fetcher,
    });

    expect(result.probe.steps).toEqual([expect.objectContaining({ key: "signal_sandbox_send", status: "pass" })]);
    const sendCall = fetcher.mock.calls[0];
    expect(sendCall?.[0]).toBe("https://signal.example.com/api/v1/rpc");
    expect(JSON.parse(String(sendCall?.[1]?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "send",
      params: {
        groupId: "group-123",
        account: "+15557654321",
        message: "[GoatCitadel Signal probe 2026-04-02T12:00:00.000Z] Channel setup smoke check.",
      },
    });
  });

  it("runs Zalo OA sandbox send probes against the official account send path", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://bot-api.zaloplatforms.com/botzalo-token/sendMessage" && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, result: { message_id: "msg-123" } }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runZaloBotLiveChecks({
      accessToken: "zalo-token",
      defaultTarget: "zalo:chat-123",
      includeSandboxSend: true,
      checkedAt: "2026-04-02T12:00:00.000Z",
      fetcher,
    });

    expect(result.probe.steps).toEqual([expect.objectContaining({ key: "zalo_sandbox_send", status: "pass" })]);
    const sendCall = fetcher.mock.calls[0];
    expect(sendCall?.[0]).toBe("https://bot-api.zaloplatforms.com/botzalo-token/sendMessage");
    expect(JSON.parse(String(sendCall?.[1]?.body))).toEqual({
      chat_id: "chat-123",
      text: "[GoatCitadel Zalo probe 2026-04-02T12:00:00.000Z] Channel setup smoke check.",
    });
  });

  it("runs Zalo User sandbox send probes against the zca text path", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://127.0.0.1:56789/work/messages/text" && init?.method === "POST") {
        return new Response(JSON.stringify({ messageId: "zca-msg-123" }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runZaloUserBridgeLiveChecks({
      baseUrl: "http://127.0.0.1:56789",
      authorizationHeader: "Bearer zlu-token",
      profile: "work",
      defaultTarget: "group:g-987654321",
      includeSandboxSend: true,
      checkedAt: "2026-04-02T12:00:00.000Z",
      fetcher,
    });

    expect(result.probe.steps).toEqual([expect.objectContaining({ key: "zalouser_sandbox_send", status: "pass" })]);
    const sendCall = fetcher.mock.calls[0];
    expect(sendCall?.[0]).toBe("http://127.0.0.1:56789/work/messages/text");
    expect(sendCall?.[1]?.headers).toBeDefined();
    const headers = new Headers(sendCall?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer zlu-token");
    expect(JSON.parse(String(sendCall?.[1]?.body))).toEqual({
      threadId: "g-987654321",
      message: "[GoatCitadel Zalo User probe 2026-04-02T12:00:00.000Z] Channel setup smoke check.",
      isGroup: true,
    });
  });

  it("maps Slack provider errors to actionable diagnostic messages", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), {
          status: 200,
        }),
    );

    const result = await runSlackBotLiveChecks({
      token: "xoxb-test",
      channel: "C123",
      includeSandboxSend: true,
      fetcher,
    });

    expect(result.probe.steps).toEqual([
      expect.objectContaining({
        key: "slack_token_auth",
        status: "fail",
        message: expect.stringContaining("Invite the app"),
        failureCategory: "unknown",
      }),
    ]);
    expect(result.checks).toEqual([
      expect.objectContaining({
        key: "slack_token_auth",
        status: "fail",
        message: expect.stringContaining("Token auth:"),
      }),
    ]);
  });

  it("fails Telegram sandbox sends when a destructive probe lacks a target chat", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 }));

    const result = await runTelegramBotLiveChecks({
      token: "123:test",
      includeSandboxSend: true,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.probe.steps).toEqual([
      expect.objectContaining({ key: "telegram_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "telegram_sandbox_send",
        status: "fail",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("normalizes WhatsApp recipient targets and rejects non-direct destinations", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("fields=id%2Cdisplay_phone_number%2Cverified_name")) {
        return new Response(JSON.stringify({ id: "123456789012345" }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ messages: [{ id: "wamid.12345" }] }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const sent = await runWhatsAppCloudLiveChecks({
      accessToken: "wa-token",
      phoneNumberId: "123456789012345",
      defaultTarget: "whatsapp: +1 (555) 123-4567",
      baseUrl: "https://graph.facebook.com/v99.0/",
      includeSandboxSend: true,
      fetcher,
    });
    const sendBody = JSON.parse(String(fetcher.mock.calls.find((call) => call[1]?.method === "POST")?.[1]?.body));
    expect(sent.probe.steps.at(-1)).toMatchObject({ key: "whatsapp_sandbox_send", status: "pass" });
    expect(sendBody.to).toBe("15551234567");

    const rejected = await runWhatsAppCloudLiveChecks({
      accessToken: "wa-token",
      phoneNumberId: "123456789012345",
      defaultTarget: "whatsapp:team@example.test",
      includeSandboxSend: true,
      fetcher,
    });
    expect(rejected.probe.steps.at(-1)).toMatchObject({
      key: "whatsapp_sandbox_send",
      status: "fail",
      failureCategory: "destination_mismatch",
    });
  });

  it("handles iMessage chat-guid targets and warns when cleanup cannot identify a message", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://127.0.0.1:1234/api/v1/chat/query?password=bb-password") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url === "http://127.0.0.1:1234/api/v1/message/text?password=bb-password" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runIMessageBridgeLiveChecks({
      bridgeUrl: "127.0.0.1:1234/",
      password: "bb-password",
      defaultHandle: "bluebubbles:chat_guid:chat-ABC",
      includeSandboxSend: true,
      fetcher,
    });

    expect(result.probe.steps).toEqual([
      expect.objectContaining({ key: "imessage_bridge_auth", status: "pass" }),
      expect.objectContaining({ key: "imessage_sandbox_send", status: "pass" }),
      expect.objectContaining({
        key: "imessage_sandbox_cleanup",
        status: "warn",
        failureCategory: "unknown",
      }),
    ]);
    const sendBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(sendBody).toMatchObject({
      chatGuid: "chat-ABC",
    });
  });

  it("resolves Mattermost direct-message and team fallback targets before sandbox send", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://chat.example.com/api/v4/users/me") {
        return new Response(JSON.stringify({ id: "bot-user-1" }), { status: 200 });
      }
      if (url === "https://chat.example.com/api/v4/users/username/alex") {
        return new Response(JSON.stringify({ id: "user-alex" }), { status: 200 });
      }
      if (url === "https://chat.example.com/api/v4/channels/direct" && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "dm-channel" }), { status: 201 });
      }
      if (url === "https://chat.example.com/api/v4/posts" && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "post-1" }), { status: 201 });
      }
      if (url === "https://chat.example.com/api/v4/posts/post-1" && init?.method === "DELETE") {
        return new Response("", { status: 403 });
      }
      throw new Error(`unexpected probe call: ${init?.method ?? "GET"} ${url}`);
    });

    const result = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com/",
      token: "mattermost-token",
      defaultChannel: "@alex",
      includeSandboxSend: true,
      fetcher,
    });

    expect(result.probe.steps).toEqual([
      expect.objectContaining({ key: "mattermost_token_auth", status: "pass" }),
      expect.objectContaining({ key: "mattermost_channel_access", status: "pass" }),
      expect.objectContaining({ key: "mattermost_sandbox_send", status: "pass" }),
      expect.objectContaining({
        key: "mattermost_sandbox_cleanup",
        status: "warn",
        failureCategory: "permission_mismatch",
      }),
    ]);
    expect(
      JSON.parse(String(fetcher.mock.calls.find((call) => String(call[0]).endsWith("/channels/direct"))?.[1]?.body)),
    ).toEqual(["bot-user-1", "user-alex"]);
  });

  it("surfaces Mattermost team-membership fallback failures during channel access", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://chat.example.com/api/v4/users/me") {
        return new Response(JSON.stringify({ id: "bot-user-1" }), { status: 200 });
      }
      if (url === "https://chat.example.com/api/v4/users/bot-user-1/teams") {
        return new Response(JSON.stringify([{ id: "" }, null, { name: "ops" }]), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${url}`);
    });

    const result = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com/",
      token: "mattermost-token",
      defaultChannel: "#town-square",
      includeSandboxSend: true,
      fetcher,
    });

    expect(result.probe.steps).toEqual([
      expect.objectContaining({ key: "mattermost_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "mattermost_channel_access",
        status: "fail",
        message: "Mattermost bot is not a member of any team.",
        failureCategory: "destination_mismatch",
      }),
    ]);
  });

  it("shapes Signal, LINE, and Zalo target failures without sending malformed probes", async () => {
    const signalFetcher = vi.fn(
      async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 }),
    );
    const signal = await runSignalBridgeLiveChecks({
      baseUrl: "https://signal.example.com/",
      defaultTarget: "username:operator",
      includeSandboxSend: true,
      fetcher: signalFetcher,
    });
    expect(signal.probe.steps).toEqual([expect.objectContaining({ key: "signal_sandbox_send", status: "pass" })]);
    expect(JSON.parse(String(signalFetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      params: { username: ["operator"] },
    });

    const lineFetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const line = await runLineBotLiveChecks({
      channelAccessToken: "line-token",
      defaultTarget: "   ",
      includeSandboxSend: true,
      fetcher: lineFetcher,
    });
    expect(line.probe.steps.at(-1)).toMatchObject({
      key: "line_sandbox_send",
      status: "fail",
      failureCategory: "destination_mismatch",
    });

    const zaloFetcher = vi.fn();
    const zalo = await runZaloBotLiveChecks({
      accessToken: "zalo-token",
      defaultTarget: " ",
      includeSandboxSend: true,
      fetcher: zaloFetcher,
    });
    expect(zaloFetcher).not.toHaveBeenCalled();
    expect(zalo.probe.steps).toEqual([
      expect.objectContaining({
        key: "zalo_sandbox_send",
        status: "fail",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("classifies provider auth and send failures without continuing destructive probes", async () => {
    const telegramAuthFailure = await runTelegramBotLiveChecks({
      token: "bad-token",
      chatId: "12345",
      includeSandboxSend: true,
      fetcher: vi.fn(
        async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }),
      ),
    });
    expect(telegramAuthFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "telegram_token_auth",
        status: "fail",
        failureCategory: "credential_rejected",
      }),
    ]);

    const telegramCleanupFailureFetcher = vi.fn(async (url: string) => {
      if (url.includes("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
      }
      if (url.includes("/deleteMessage")) {
        return new Response(JSON.stringify({ ok: false, description: "Forbidden" }), { status: 403 });
      }
      throw new Error(`unexpected Telegram probe call: ${url}`);
    });
    const telegramCleanupFailure = await runTelegramBotLiveChecks({
      token: "telegram-token",
      chatId: "12345",
      includeSandboxSend: true,
      fetcher: telegramCleanupFailureFetcher,
    });
    expect(telegramCleanupFailure.probe.steps).toEqual([
      expect.objectContaining({ key: "telegram_token_auth", status: "pass" }),
      expect.objectContaining({ key: "telegram_sandbox_send", status: "pass" }),
      expect.objectContaining({
        key: "telegram_sandbox_cleanup",
        status: "warn",
        failureCategory: "permission_mismatch",
      }),
    ]);

    const whatsappTransportFailure = await runWhatsAppCloudLiveChecks({
      accessToken: "wa-token",
      phoneNumberId: "123456789012345",
      defaultTarget: "+15551234567",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => {
        throw new Error("graph offline");
      }),
    });
    expect(whatsappTransportFailure.probe.steps).toEqual([
      expect.objectContaining({
        key: "whatsapp_token_auth",
        status: "warn",
        failureCategory: "platform_unavailable",
      }),
    ]);

    const imessageMissingHandle = await runIMessageBridgeLiveChecks({
      bridgeUrl: "http://127.0.0.1:1234",
      password: "bb-password",
      includeSandboxSend: true,
      fetcher: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    });
    expect(imessageMissingHandle.probe.steps).toEqual([
      expect.objectContaining({ key: "imessage_bridge_auth", status: "pass" }),
      expect.objectContaining({
        key: "imessage_sandbox_send",
        status: "fail",
        failureCategory: "destination_mismatch",
      }),
    ]);
  });

  it("surfaces missing sandbox destinations before destructive channel sends", async () => {
    const slackFetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const slack = await runSlackBotLiveChecks({
      token: "xoxb-test",
      includeSandboxSend: true,
      fetcher: slackFetcher,
    });
    expect(slackFetcher).toHaveBeenCalledTimes(1);
    expect(slack.probe.steps).toEqual([
      expect.objectContaining({ key: "slack_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "slack_sandbox_send",
        status: "fail",
        failureCategory: "missing_input",
      }),
    ]);

    const discordFetcher = vi.fn(async () => new Response(JSON.stringify({ id: "bot_1" }), { status: 200 }));
    const discord = await runDiscordBotLiveChecks({
      token: "discord-token",
      runtimeMode: "gateway",
      runtimeStatus: { ready: false, lastError: "not logged in" },
      includeSandboxSend: true,
      fetcher: discordFetcher,
    });
    expect(discordFetcher).toHaveBeenCalledTimes(1);
    expect(discord.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "discord_channel_access",
        status: "fail",
        failureCategory: "destination_mismatch",
      }),
      expect.objectContaining({
        key: "discord_sandbox_send",
        status: "fail",
        failureCategory: "destination_mismatch",
      }),
      expect.objectContaining({
        key: "discord_runtime_ready",
        status: "warn",
        message: "Gateway runtime is not ready: not logged in",
      }),
    ]);

    const mattermostFetcher = vi.fn(async () => new Response(JSON.stringify({ id: "bot-user-1" }), { status: 200 }));
    const mattermost = await runMattermostBotLiveChecks({
      serverUrl: "https://chat.example.com/",
      token: "mattermost-token",
      includeSandboxSend: true,
      fetcher: mattermostFetcher,
    });
    expect(mattermostFetcher).toHaveBeenCalledTimes(1);
    expect(mattermost.probe.steps).toEqual([
      expect.objectContaining({ key: "mattermost_token_auth", status: "pass" }),
      expect.objectContaining({
        key: "mattermost_channel_access",
        status: "fail",
        failureCategory: "destination_mismatch",
      }),
      expect.objectContaining({
        key: "mattermost_sandbox_send",
        status: "fail",
        failureCategory: "destination_mismatch",
      }),
    ]);
  });
});
