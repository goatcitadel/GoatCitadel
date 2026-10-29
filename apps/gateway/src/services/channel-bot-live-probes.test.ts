import { evaluateChannelSetupEligibility } from "./channel-setup-eligibility.js";
import type { ChannelSetupTestResult, IntegrationConnection } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  runDiscordBotLiveChecks,
  runLineBotLiveChecks,
  runMattermostBotLiveChecks,
  runSlackBotLiveChecks,
  runTelegramBotLiveChecks,
  runWhatsAppCloudLiveChecks,
  runZaloBotLiveChecks,
} from "./channel-bot-live-probes.js";

describe("channel bot live probes", () => {
  it("keeps an implicitly skipped required send blocking rather than fabricating a deferred pass", async () => {
    const result = await runDiscordBotLiveChecks({
      runtimeMode: "bridge",
      webhookUrl: "https://discord.example.test/webhook",
      includeSandboxSend: true,
      fetcher: vi.fn(),
    });
    expect(result.probe.steps.find((step) => step.key === "discord_sandbox_send")).toMatchObject({
      status: "skipped",
      disposition: "blocking",
    });
    const test: ChannelSetupTestResult = {
      draftId: "draft",
      draftRevision: 1,
      status: "ok",
      levels: [],
      issues: [],
      checkedAt: new Date().toISOString(),
      probe: result.probe,
    };
    expect(evaluateChannelSetupEligibility(test, { key: "discord", config: {} } as IntegrationConnection).allowed).toBe(
      false,
    );
  });
  it("authenticates DM-only Discord while deferring destination and delivery proof", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "bot", username: "bot" })));
    const result = await runDiscordBotLiveChecks({
      token: "test-token",
      runtimeMode: "gateway",
      runtimeReadiness: "deferred",
      deferDestination: true,
      includeSandboxSend: true,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.probe.steps.find((step) => step.key === "discord_token_auth")?.status).toBe("pass");
    expect(result.probe.steps.find((step) => step.key === "discord_sandbox_send")).toMatchObject({
      status: "skipped",
      disposition: "deferred",
    });
    expect(result.probe.steps.find((step) => step.key === "discord_channel_access")).toMatchObject({
      status: "skipped",
      disposition: "deferred",
    });
  });
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

  describe("Slack app-level token check", () => {
    const BOT_TOKEN = "xoxb-111-222-botsecret";
    const APP_TOKEN = "xapp-1-A0123-456-appsecret";
    const SOCKET_URL = "wss://wss-primary.slack.com/link/?ticket=ticket-secret-123&app_id=A0123";
    const SECRETS = [BOT_TOKEN, APP_TOKEN, SOCKET_URL, "ticket-secret-123"];

    function slackFetcher(open: () => Response | Promise<Response>) {
      return vi.fn(async (url: string, _init?: RequestInit) => {
        if (url === "https://slack.com/api/apps.connections.open") {
          return open();
        }
        if (url === "https://slack.com/api/chat.postMessage") {
          return new Response(JSON.stringify({ ok: true, ts: "1712.100", channel: "C123" }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
    }

    const accepted = () => new Response(JSON.stringify({ ok: true, url: SOCKET_URL }), { status: 200 });

    function expectNoSecret(value: unknown) {
      const text = JSON.stringify(value);
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret);
      }
    }

    it("asks Slack to open a Socket Mode connection with the app-level token, reads only ok, and opens no socket", async () => {
      const socket = vi.fn();
      vi.stubGlobal("WebSocket", socket);
      try {
        const fetcher = slackFetcher(accepted);

        const result = await runSlackBotLiveChecks({
          token: BOT_TOKEN,
          appToken: APP_TOKEN,
          includeSandboxSend: false,
          fetcher,
        });

        expect(result.probe.steps).toEqual([
          expect.objectContaining({ key: "slack_token_auth", status: "pass" }),
          expect.objectContaining({ key: "slack_socket_auth", label: "App-level token", status: "pass" }),
        ]);
        expect(result.checks.every((check) => check.status === "pass")).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(2);
        const [url, init] = fetcher.mock.calls[1] ?? [];
        expect(url).toBe("https://slack.com/api/apps.connections.open");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ Authorization: `Bearer ${APP_TOKEN}` });
        expect(socket).not.toHaveBeenCalled();
        expectNoSecret(result);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("fails with a fixed sentence when Slack does not accept the app-level token, and sends nothing", async () => {
      const fetcher = slackFetcher(
        () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 }),
      );

      const result = await runSlackBotLiveChecks({
        token: BOT_TOKEN,
        appToken: APP_TOKEN,
        channel: "C123",
        includeSandboxSend: true,
        fetcher,
      });

      expect(result.probe.steps).toEqual([
        expect.objectContaining({ key: "slack_token_auth", status: "pass" }),
        expect.objectContaining({
          key: "slack_socket_auth",
          label: "App-level token",
          status: "fail",
          message: "Slack didn't accept the app-level token.",
          failureCategory: "credential_rejected",
        }),
      ]);
      expect(result.checks.at(-1)).toEqual({
        key: "slack_socket_auth",
        status: "fail",
        message: "App-level token: Slack didn't accept the app-level token.",
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expectNoSecret(result);
    });

    it("says the same thing when Slack refuses the token with an HTTP error", async () => {
      const result = await runSlackBotLiveChecks({
        token: BOT_TOKEN,
        appToken: APP_TOKEN,
        includeSandboxSend: false,
        fetcher: slackFetcher(() => new Response("Unauthorized", { status: 401 })),
      });

      expect(result.probe.steps.at(-1)).toMatchObject({
        key: "slack_socket_auth",
        status: "fail",
        message: "Slack didn't accept the app-level token.",
        failureCategory: "credential_rejected",
      });
    });

    it("warns, rather than blaming the token, when Slack is busy or down", async () => {
      for (const status of [429, 503]) {
        const result = await runSlackBotLiveChecks({
          token: BOT_TOKEN,
          appToken: APP_TOKEN,
          includeSandboxSend: false,
          fetcher: slackFetcher(() => new Response("{}", { status })),
        });

        expect(result.probe.steps.at(-1), String(status)).toMatchObject({
          key: "slack_socket_auth",
          status: "warn",
          message: "Slack couldn't check the app-level token right now. Try again in a minute.",
          failureCategory: "platform_unavailable",
        });
      }
    });

    it("never builds its message from an error, a reply or the address Slack returns", async () => {
      const quoting = await runSlackBotLiveChecks({
        token: BOT_TOKEN,
        appToken: APP_TOKEN,
        includeSandboxSend: false,
        fetcher: slackFetcher(() => {
          throw new Error(`fetch failed: POST https://slack.com/api/apps.connections.open Bearer ${APP_TOKEN}`);
        }),
      });
      const echoing = await runSlackBotLiveChecks({
        token: BOT_TOKEN,
        appToken: APP_TOKEN,
        includeSandboxSend: false,
        fetcher: slackFetcher(
          () =>
            new Response(
              JSON.stringify({ ok: false, error: `bad token ${APP_TOKEN} for ${SOCKET_URL}`, url: SOCKET_URL }),
              { status: 200 },
            ),
        ),
      });
      const html = await runSlackBotLiveChecks({
        token: BOT_TOKEN,
        appToken: APP_TOKEN,
        includeSandboxSend: false,
        fetcher: slackFetcher(() => new Response(`<html>${APP_TOKEN} ${SOCKET_URL}</html>`, { status: 400 })),
      });

      expect(quoting.probe.steps.at(-1)).toMatchObject({
        key: "slack_socket_auth",
        status: "warn",
        message: "Couldn't reach Slack to check the app-level token.",
        failureCategory: "platform_unavailable",
      });
      expect(echoing.probe.steps.at(-1)).toMatchObject({
        status: "fail",
        message: "Slack didn't accept the app-level token.",
      });
      expect(html.probe.steps.at(-1)).toMatchObject({
        status: "fail",
        message: "Slack didn't accept the app-level token.",
      });
      for (const result of [quoting, echoing, html]) {
        expectNoSecret(result);
      }
    });

    it("keeps going to the test send when the app-level token is accepted", async () => {
      const fetcher = slackFetcher(accepted);

      const result = await runSlackBotLiveChecks({
        token: BOT_TOKEN,
        appToken: APP_TOKEN,
        channel: "C123",
        includeSandboxSend: true,
        fetcher,
      });

      expect(result.probe.steps.map((step) => step.key)).toEqual([
        "slack_token_auth",
        "slack_socket_auth",
        "slack_sandbox_send",
        "slack_sandbox_cleanup",
      ]);
      expect(result.checks.every((check) => check.status === "pass")).toBe(true);
      expectNoSecret(result);
    });

    it("does not check the app-level token when the bot token is refused", async () => {
      const fetcher = vi.fn(
        async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 }),
      );

      const result = await runSlackBotLiveChecks({
        token: BOT_TOKEN,
        appToken: APP_TOKEN,
        includeSandboxSend: false,
        fetcher,
      });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.probe.steps.map((step) => step.key)).toEqual(["slack_token_auth"]);
    });

    it("fails a Socket Mode connection that has no app-level token, without asking Slack", async () => {
      const fetcher = slackFetcher(accepted);

      const result = await runSlackBotLiveChecks({
        token: BOT_TOKEN,
        requireAppToken: true,
        includeSandboxSend: false,
        fetcher,
      });

      expect(result.probe.steps.at(-1)).toMatchObject({
        key: "slack_socket_auth",
        label: "App-level token",
        status: "fail",
        message: "Socket Mode needs the app-level token.",
        failureCategory: "missing_input",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("leaves a connection without an app-level token exactly as it was", async () => {
      const fetcher = slackFetcher(accepted);

      const result = await runSlackBotLiveChecks({ token: BOT_TOKEN, includeSandboxSend: false, fetcher });

      expect(result.probe.steps.map((step) => step.key)).toEqual(["slack_token_auth"]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it("runs Discord auth, channel access, sandbox send, cleanup, and runtime probes", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://discord.com/api/v10/users/@me") {
        return new Response(JSON.stringify({ id: "bot_1" }), { status: 200 });
      }
      if (url === "https://discord.com/api/v10/channels/channel_1") {
        return new Response(JSON.stringify({ id: "channel_1", guild_id: "guild_1" }), { status: 200 });
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
      guildId: "guild_1",
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
      "discord_channel_access_guild_match",
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
      content: "[GoatCitadel Discord probe 2026-03-31T20:10:00.000Z] Setup check. Delete me if I remain.",
    });
  });

  it("rejects a Discord channel from a different configured server before sandbox send", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://discord.com/api/v10/users/@me") {
        return new Response(JSON.stringify({ id: "bot_1" }), { status: 200 });
      }
      if (url === "https://discord.com/api/v10/channels/channel_1") {
        return new Response(JSON.stringify({ id: "channel_1", guild_id: "guild_actual" }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${url}`);
    });

    const result = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "channel_1",
      guildId: "guild_expected",
      runtimeMode: "gateway",
      includeSandboxSend: true,
      runtimeStatus: { ready: true, connectedBotTag: "GoatBot#1234" },
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({ key: "discord_channel_access", status: "pass" }),
      expect.objectContaining({
        key: "discord_channel_access_guild_match",
        status: "fail",
        failureCategory: "destination_mismatch",
        message: "The configured channel belongs to server guild_actual, not configured server guild_expected.",
      }),
      expect.objectContaining({ key: "discord_sandbox_send", status: "skipped" }),
      expect.objectContaining({ key: "discord_runtime_ready", status: "pass" }),
    ]);
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "discord_channel_access_guild_match", status: "fail" })]),
    );
  });

  it("defers gateway readiness while a Discord setup draft has no durable connection", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://discord.com/api/v10/users/@me") {
        return new Response(JSON.stringify({ id: "bot_1" }), { status: 200 });
      }
      if (url === "https://discord.com/api/v10/channels/channel_1") {
        return new Response(JSON.stringify({ id: "channel_1" }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${url}`);
    });

    const result = await runDiscordBotLiveChecks({
      token: "discord-token",
      channelId: "channel_1",
      runtimeMode: "gateway",
      runtimeReadiness: "deferred",
      includeSandboxSend: false,
      fetcher,
    });

    expect(result.probe.steps).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({ key: "discord_channel_access", status: "pass" }),
      expect.objectContaining({
        key: "discord_runtime_ready",
        status: "skipped",
        message: "Gateway runtime readiness will be checked after this draft creates a durable connection.",
      }),
    ]);
    expect(result.checks).toEqual([
      expect.objectContaining({ key: "discord_token_auth", status: "pass" }),
      expect.objectContaining({ key: "discord_channel_access", status: "pass" }),
    ]);
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

  it("runs Zalo OA sandbox send probes against the official account send path", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://openapi.zalo.me/v3.0/oa/message/cs" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: 0, message: "Success", data: { message_id: "msg-123" } }), {
          status: 200,
        });
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
    expect(sendCall?.[0]).toBe("https://openapi.zalo.me/v3.0/oa/message/cs");
    expect(sendCall?.[1]?.headers).toMatchObject({ access_token: "zalo-token" });
    expect(JSON.parse(String(sendCall?.[1]?.body))).toEqual({
      recipient: { user_id: "chat-123" },
      message: { text: "[GoatCitadel Zalo probe 2026-04-02T12:00:00.000Z] Channel setup smoke check." },
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

  it("shapes LINE and Zalo target failures without sending malformed probes", async () => {
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
