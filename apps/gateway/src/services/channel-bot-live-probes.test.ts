import { describe, expect, it, vi } from "vitest";
import {
  runDiscordBotLiveChecks,
  runSlackBotLiveChecks,
  runTelegramBotLiveChecks,
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
    expect(result.probe.steps.map((step) => step.key)).toEqual([
      "slack_token_auth",
    ]);
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
    const sendCall = fetcher.mock.calls.find((call) => String(call[0]).includes("/messages") && call[1]?.method === "POST");
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
});
