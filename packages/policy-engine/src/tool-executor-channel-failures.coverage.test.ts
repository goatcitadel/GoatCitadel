import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage, Storage } from "@goatcitadel/storage";

const mocked = vi.hoisted(() => ({
  isBrowserToolName: vi.fn<(name: string) => boolean>(),
  executeBrowserTool: vi.fn(),
}));

vi.mock("./browser-tools.js", () => ({
  isBrowserToolName: mocked.isBrowserToolName,
  executeBrowserTool: mocked.executeBrowserTool,
}));

import { executeTool } from "./tool-executor.js";

describe("tool executor channel failure coverage", () => {
  const priorFetch = globalThis.fetch;
  const config = createConfig();

  afterEach(() => {
    globalThis.fetch = priorFetch;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mocked.isBrowserToolName.mockReset();
    mocked.executeBrowserTool.mockReset();
  });

  it("covers Slack webhook, bot-token, reaction, and unsend failure branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://hooks.slack.com/services/T/B/C") {
        return new Response("webhook down", { status: 500 });
      }
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 });
      }
      if (url === "https://slack.com/api/reactions.add") {
        return new Response(JSON.stringify({ ok: false, error: "bad_name" }), { status: 200 });
      }
      if (url === "https://slack.com/api/chat.delete") {
        return new Response(JSON.stringify({ ok: false, error: "cant_delete" }), { status: 200 });
      }
      throw new Error(`Unexpected Slack URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "hooks.slack.com", "slack.com");

    await expectFailed(
      executeTool(
        request("slack.send", { connectionId: "slack-webhook", message: "webhook failure" }),
        commsConfig,
        commsStorage({
          connectionId: "slack-webhook",
          key: "slack-wrapper",
          config: { webhookUrl: "https://hooks.slack.com/services/T/B/C" },
        }),
      ),
      /slack\.send failed \(500\)/i,
    );

    await expectFailed(
      executeTool(
        request("slack.send", { connectionId: "slack-missing-token", message: "missing token" }),
        commsConfig,
        commsStorage({
          connectionId: "slack-missing-token",
          key: "slack",
          config: { defaultChannel: "C123" },
        }),
      ),
      /Missing Slack bot token/i,
    );

    await expectFailed(
      executeTool(
        request("slack.send", { connectionId: "slack-missing-channel", message: "missing channel" }),
        commsConfig,
        commsStorage({
          connectionId: "slack-missing-channel",
          key: "slack",
          config: { botToken: "xoxb-test" },
        }),
      ),
      /Missing Slack channel target/i,
    );

    await expectFailed(
      executeTool(
        request("slack.send", { connectionId: "slack-api-failure", message: "api failure" }),
        commsConfig,
        commsStorage({
          connectionId: "slack-api-failure",
          key: "slack",
          config: { botToken: "xoxb-test", defaultChannel: "C123" },
        }),
      ),
      /channel_not_found/i,
    );

    await expectFailed(
      executeTool(
        request("slack.send", {
          connectionId: "slack-inline-channel-name",
          message: "",
          attachments: [{ title: "evidence.txt", dataBase64: Buffer.from("evidence").toString("base64") }],
        }),
        commsConfig,
        commsStorage({
          connectionId: "slack-inline-channel-name",
          key: "slack",
          config: { botToken: "xoxb-test", defaultChannel: "#ops" },
        }),
      ),
      /inline attachment uploads require a channel ID/i,
    );

    await expectFailed(
      executeTool(
        request("slack.react", {
          connectionId: "slack-react-failure",
          messageId: "1712345678.000100",
          reaction: "bad",
        }),
        commsConfig,
        commsStorage({
          connectionId: "slack-react-failure",
          key: "slack",
          config: { botToken: "xoxb-test", defaultChannel: "C123" },
        }),
      ),
      /bad_name/i,
    );

    await expectFailed(
      executeTool(
        request("slack.react", {
          connectionId: "slack-react-missing-token",
          messageId: "1712345678.000100",
          reaction: "ok",
        }),
        commsConfig,
        commsStorage({
          connectionId: "slack-react-missing-token",
          key: "slack",
          config: { defaultChannel: "C123" },
        }),
      ),
      /Missing Slack bot token/i,
    );

    await expectFailed(
      executeTool(
        request("slack.react", {
          connectionId: "slack-react-missing-channel",
          messageId: "1712345678.000100",
          reaction: "ok",
        }),
        commsConfig,
        commsStorage({
          connectionId: "slack-react-missing-channel",
          key: "slack",
          config: { botToken: "xoxb-test" },
        }),
      ),
      /Missing Slack channel target/i,
    );

    await expectFailed(
      executeTool(
        request("slack.unsend", { connectionId: "slack-unsend-failure", messageId: "1712345678.000100" }),
        commsConfig,
        commsStorage({
          connectionId: "slack-unsend-failure",
          key: "slack",
          config: { botToken: "xoxb-test", defaultChannel: "C123" },
        }),
      ),
      /cant_delete/i,
    );

    await expectFailed(
      executeTool(
        request("slack.unsend", { connectionId: "slack-unsend-missing-token", messageId: "1712345678.000100" }),
        commsConfig,
        commsStorage({
          connectionId: "slack-unsend-missing-token",
          key: "slack",
          config: { defaultChannel: "C123" },
        }),
      ),
      /Missing Slack bot token/i,
    );

    await expectFailed(
      executeTool(
        request("slack.unsend", { connectionId: "slack-unsend-missing-channel", messageId: "1712345678.000100" }),
        commsConfig,
        commsStorage({
          connectionId: "slack-unsend-missing-channel",
          key: "slack",
          config: { botToken: "xoxb-test" },
        }),
      ),
      /Missing Slack channel target/i,
    );
  });

  it("covers Discord webhook, bot-token, reaction, unsend, and JSON body branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "https://discord.com/api/webhooks/123/abc?wait=true") {
        return new Response("webhook failed", { status: 500 });
      }
      if (url === "https://discord.com/api/v10/channels/D123/messages" && method === "POST") {
        return new Response(JSON.stringify({ id: "discord-bot-message" }), { status: 200 });
      }
      if (url === "https://discord.com/api/v10/channels/DFAIL/messages" && method === "POST") {
        return new Response("bot failed", { status: 500 });
      }
      if (url.includes("/reactions/")) {
        return new Response("bad emoji", { status: 400 });
      }
      if (url === "https://discord.com/api/v10/channels/D123/messages/msg-delete" && method === "DELETE") {
        return new Response("", { status: 200 });
      }
      if (url === "https://discord.com/api/v10/channels/D123/messages/msg-delete-fail" && method === "DELETE") {
        return new Response("delete failed", { status: 500 });
      }
      if (url === "https://discord.com/api/webhooks/123/abc/messages/msg-webhook-fail" && method === "DELETE") {
        return new Response("webhook delete failed", { status: 500 });
      }
      throw new Error(`Unexpected Discord URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "discord.com");

    await expectFailed(
      executeTool(
        request("discord.send", { connectionId: "discord-webhook-fail", message: "fail" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-webhook-fail",
          key: "discord",
          config: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
        }),
      ),
      /discord\.send failed \(500\)/i,
    );

    const botSent = await executeTool(
      request("discord.send", {
        connectionId: "discord-bot",
        message: "plain bot send",
        attachments: [{ title: "Runbook", url: "https://example.com/runbook" }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "discord-bot",
        key: "discord",
        config: { botToken: "discord-token", defaultChannelId: "D123" },
      }),
    );
    expect(botSent).toMatchObject({ status: "sent", providerMessageId: "discord-bot-message" });

    await expectFailed(
      executeTool(
        request("discord.send", { connectionId: "discord-bot-fail", message: "bot fail", target: "DFAIL" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-bot-fail",
          key: "discord",
          config: { botToken: "discord-token" },
        }),
      ),
      /discord\.send failed \(500\)/i,
    );

    await expectFailed(
      executeTool(
        request("discord.send", { connectionId: "discord-missing-token", message: "missing token" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-missing-token",
          key: "discord",
          config: { defaultChannelId: "D123" },
        }),
      ),
      /Missing Discord bot token/i,
    );

    await expectFailed(
      executeTool(
        request("discord.send", { connectionId: "discord-missing-channel", message: "missing channel" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-missing-channel",
          key: "discord",
          config: { botToken: "discord-token" },
        }),
      ),
      /Missing Discord channel target/i,
    );

    await expectFailed(
      executeTool(
        request("discord.react", { connectionId: "discord-react-fail", messageId: "msg-1", reaction: "bad emoji" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-react-fail",
          key: "discord",
          config: { botToken: "discord-token", defaultChannelId: "D123" },
        }),
      ),
      /bad emoji/i,
    );

    await expectFailed(
      executeTool(
        request("discord.react", { connectionId: "discord-react-missing-token", messageId: "msg-1", reaction: "✅" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-react-missing-token",
          key: "discord",
          config: { defaultChannelId: "D123" },
        }),
      ),
      /Missing Discord bot token/i,
    );

    await expectFailed(
      executeTool(
        request("discord.react", { connectionId: "discord-react-missing-channel", messageId: "msg-1", reaction: "✅" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-react-missing-channel",
          key: "discord",
          config: { botToken: "discord-token" },
        }),
      ),
      /Missing Discord channel target/i,
    );

    const deleted = await executeTool(
      request("discord.unsend", { connectionId: "discord-unsend", messageId: "msg-delete" }),
      commsConfig,
      commsStorage({
        connectionId: "discord-unsend",
        key: "discord",
        config: { botToken: "discord-token", defaultChannelId: "D123" },
      }),
    );
    expect(deleted).toMatchObject({ status: "sent", providerMessageId: "msg-delete" });

    await expectFailed(
      executeTool(
        request("discord.unsend", { connectionId: "discord-unsend-fail", messageId: "msg-delete-fail" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-unsend-fail",
          key: "discord",
          config: { botToken: "discord-token", defaultChannelId: "D123" },
        }),
      ),
      /delete failed/i,
    );

    await expectFailed(
      executeTool(
        request("discord.unsend", { connectionId: "discord-unsend-missing-channel", messageId: "msg-delete" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-unsend-missing-channel",
          key: "discord",
          config: { botToken: "discord-token" },
        }),
      ),
      /Missing Discord channel target/i,
    );

    await expectFailed(
      executeTool(
        request("discord.unsend", { connectionId: "discord-unsend-missing-auth", messageId: "msg-1" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-unsend-missing-auth",
          key: "discord",
          config: {},
        }),
      ),
      /Missing Discord bot token or webhook URL/i,
    );

    await expectFailed(
      executeTool(
        request("discord.unsend", { connectionId: "discord-unsend-webhook-fail", messageId: "msg-webhook-fail" }),
        commsConfig,
        commsStorage({
          connectionId: "discord-unsend-webhook-fail",
          key: "discord",
          config: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
        }),
      ),
      /webhook delete failed/i,
    );
  });

  it("covers Telegram validation, long-caption, inline upload, keyboard, reaction, and unsend branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sendMessage")) {
        if (String(init?.body ?? "").includes("text-fail")) {
          return new Response(JSON.stringify({ ok: false, description: "text denied" }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), { status: 200 });
      }
      if (url.endsWith("/sendPhoto")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1002 } }), { status: 200 });
      }
      if (url.endsWith("/sendDocument")) {
        return new Response(JSON.stringify({ ok: false, description: "document denied" }), { status: 200 });
      }
      if (url.endsWith("/deleteMessage")) {
        return new Response(JSON.stringify({ ok: false, description: "message not found" }), { status: 200 });
      }
      if (url.endsWith("/setMessageReaction")) {
        return new Response(JSON.stringify({ ok: false, description: "reaction denied" }), { status: 200 });
      }
      throw new Error(`Unexpected Telegram URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "api.telegram.org");

    await expectFailed(
      executeTool(
        request("telegram.send", {
          connectionId: "telegram-invalid-reply",
          message: "bad reply",
          replyToMessageId: "abc",
        }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-invalid-reply",
          key: "telegram",
          config: { botToken: "tg-token", defaultChatId: "-1001" },
        }),
      ),
      /Expected an integer-like reply target/i,
    );

    await expectFailed(
      executeTool(
        request("telegram.send", { connectionId: "telegram-missing-token", message: "missing token" }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-missing-token",
          key: "telegram",
          config: { defaultChatId: "-1001" },
        }),
      ),
      /Missing Telegram bot token/i,
    );

    await expectFailed(
      executeTool(
        request("telegram.send", { connectionId: "telegram-missing-chat", message: "missing chat" }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-missing-chat",
          key: "telegram",
          config: { botToken: "tg-token" },
        }),
      ),
      /Missing Telegram chat target/i,
    );

    const longCaption = await executeTool(
      request("telegram.send", {
        connectionId: "telegram-long-caption",
        message: "x".repeat(1100),
        replyToMessageId: "42",
        attachments: [
          {
            title: "photo.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("photo").toString("base64"),
          },
        ],
        interactiveActions: {
          platform: "telegram",
          buttons: [
            { label: "Open", callbackData: "open" },
            { label: "", callbackData: "skip" },
            { label: "Missing callback" },
          ],
        },
      }),
      commsConfig,
      commsStorage({
        connectionId: "telegram-long-caption",
        key: "telegram",
        config: { botToken: "tg-token", defaultChatId: "-1001", parseMode: "Markdown" },
      }),
    );
    expect(longCaption).toMatchObject({ status: "sent", providerMessageId: "1002" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottg-token/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottg-token/sendPhoto",
      expect.objectContaining({ method: "POST" }),
    );

    const shortCaption = await executeTool(
      request("telegram.send", {
        connectionId: "telegram-short-caption",
        message: "short caption",
        replyToMessageId: "43",
        attachments: [
          {
            title: "short.png",
            mimeType: "image/png",
            dataBase64: Buffer.from("photo").toString("base64"),
          },
        ],
      }),
      commsConfig,
      commsStorage({
        connectionId: "telegram-short-caption",
        key: "telegram",
        config: { botToken: "tg-token", defaultChatId: "-1001", parseMode: "Markdown" },
      }),
    );
    expect(shortCaption).toMatchObject({ status: "sent", providerMessageId: "1002" });

    const keyboardless = await executeTool(
      request("telegram.send", {
        connectionId: "telegram-keyboardless",
        message: "no telegram keyboard",
        interactiveActions: { platform: "slack", buttons: [{ label: "Ignore", callbackData: "ignore" }] },
      }),
      commsConfig,
      commsStorage({
        connectionId: "telegram-keyboardless",
        key: "telegram",
        config: { botToken: "tg-token", defaultChatId: "-1001" },
      }),
    );
    expect(keyboardless).toMatchObject({ status: "sent", providerMessageId: "1001" });

    const noButtons = await executeTool(
      request("telegram.send", {
        connectionId: "telegram-no-buttons",
        message: "no buttons",
        interactiveActions: { platform: "telegram" },
      }),
      commsConfig,
      commsStorage({
        connectionId: "telegram-no-buttons",
        key: "telegram",
        config: { botToken: "tg-token", defaultChatId: "-1001" },
      }),
    );
    expect(noButtons).toMatchObject({ status: "sent", providerMessageId: "1001" });

    await expectFailed(
      executeTool(
        request("telegram.send", { connectionId: "telegram-text-fail", message: "text-fail" }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-text-fail",
          key: "telegram",
          config: { botToken: "tg-token", defaultChatId: "-1001" },
        }),
      ),
      /text denied/i,
    );

    await expectFailed(
      executeTool(
        request("telegram.send", {
          connectionId: "telegram-document-fail",
          message: "doc",
          attachments: [{ title: "doc.txt", url: "https://example.com/doc.txt", mimeType: "text/plain" }],
        }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-document-fail",
          key: "telegram",
          config: { botToken: "tg-token", defaultChatId: "-1001" },
        }),
      ),
      /document denied/i,
    );

    await expectFailed(
      executeTool(
        request("telegram.unsend", { connectionId: "telegram-unsend-fail", messageId: "1001" }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-unsend-fail",
          key: "telegram",
          config: { botToken: "tg-token", defaultChatId: "-1001" },
        }),
      ),
      /message not found/i,
    );

    await expectFailed(
      executeTool(
        request("telegram.unsend", { connectionId: "telegram-unsend-missing-token", messageId: "1001" }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-unsend-missing-token",
          key: "telegram",
          config: { defaultChatId: "-1001" },
        }),
      ),
      /Missing Telegram bot token/i,
    );

    await expectFailed(
      executeTool(
        request("telegram.unsend", { connectionId: "telegram-unsend-missing-chat", messageId: "1001" }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-unsend-missing-chat",
          key: "telegram",
          config: { botToken: "tg-token" },
        }),
      ),
      /Missing Telegram chat target/i,
    );

    await expectFailed(
      executeTool(
        request("telegram.react", {
          connectionId: "telegram-react-fail",
          messageId: "1001",
          reaction: "👀",
          isBig: true,
        }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-react-fail",
          key: "telegram",
          config: { botToken: "tg-token", defaultChatId: "-1001" },
        }),
      ),
      /reaction denied/i,
    );

    await expectFailed(
      executeTool(
        request("telegram.react", { connectionId: "telegram-react-missing-token", messageId: "1001", reaction: "👀" }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-react-missing-token",
          key: "telegram",
          config: { defaultChatId: "-1001" },
        }),
      ),
      /Missing Telegram bot token/i,
    );

    await expectFailed(
      executeTool(
        request("telegram.react", { connectionId: "telegram-react-missing-chat", messageId: "1001", reaction: "👀" }),
        commsConfig,
        commsStorage({
          connectionId: "telegram-react-missing-chat",
          key: "telegram",
          config: { botToken: "tg-token" },
        }),
      ),
      /Missing Telegram chat target/i,
    );
  });

  it("covers LINE, Teams, and Google Chat validation and response failures", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://api.line.me/v2/bot/message/push") {
        return new Response("line down", { status: 500 });
      }
      if (url === "https://outlook.office.com/webhook/example") {
        return new Response("teams down", { status: 500 });
      }
      if (url.startsWith("https://chat.googleapis.com/v1/spaces/AAAA/messages")) {
        if (url.includes("fail")) {
          return new Response("chat down", { status: 500 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`Unexpected adapter URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "api.line.me", "outlook.office.com", "chat.googleapis.com");

    await expectFailed(
      executeTool(
        request("line.send", { connectionId: "line-missing-token", message: "line" }),
        commsConfig,
        commsStorage({
          connectionId: "line-missing-token",
          key: "line",
          config: { defaultTarget: "line:user:U123" },
        }),
      ),
      /Missing LINE channel access token/i,
    );

    await expectFailed(
      executeTool(
        request("line.send", { connectionId: "line-missing-target", message: "line" }),
        commsConfig,
        commsStorage({
          connectionId: "line-missing-target",
          key: "line",
          config: { channelAccessToken: "line-token" },
        }),
      ),
      /Missing LINE target/i,
    );

    await expectFailed(
      executeTool(
        request("line.send", { connectionId: "line-missing-message", message: "" }),
        commsConfig,
        commsStorage({
          connectionId: "line-missing-message",
          key: "line",
          config: { channelAccessToken: "line-token", defaultTarget: "line:user:U123" },
        }),
      ),
      /Missing LINE message/i,
    );

    await expectFailed(
      executeTool(
        request("line.send", { connectionId: "line-failure", message: "line" }),
        commsConfig,
        commsStorage({
          connectionId: "line-failure",
          key: "line",
          config: { channelAccessToken: "line-token", defaultTarget: "line:user:U123" },
        }),
      ),
      /line\.send failed \(500\)/i,
    );

    await expectFailed(
      executeTool(
        request("teams.send", { connectionId: "teams-missing-url", message: "teams" }),
        commsConfig,
        commsStorage({
          connectionId: "teams-missing-url",
          key: "teams",
          config: {},
        }),
      ),
      /Missing Teams webhook URL/i,
    );

    await expectFailed(
      executeTool(
        request("teams.send", { connectionId: "teams-failure", message: "teams" }),
        commsConfig,
        commsStorage({
          connectionId: "teams-failure",
          key: "teams",
          config: { webhookUrl: "https://outlook.office.com/webhook/example" },
        }),
      ),
      /teams\.send failed \(500\)/i,
    );

    await expectFailed(
      executeTool(
        request("google-chat.send", { connectionId: "google-chat-missing-url", message: "chat" }),
        commsConfig,
        commsStorage({
          connectionId: "google-chat-missing-url",
          key: "google-chat",
          config: {},
        }),
      ),
      /Missing Google Chat webhook URL/i,
    );

    await expectFailed(
      executeTool(
        request("google-chat.send", { connectionId: "google-chat-failure", message: "chat" }),
        commsConfig,
        commsStorage({
          connectionId: "google-chat-failure",
          key: "google-chat",
          config: { webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?fail=true" },
        }),
      ),
      /google-chat\.send failed \(500\)/i,
    );

    const emptyCard = await executeTool(
      request("google-chat.send", { connectionId: "google-chat-empty", message: "" }),
      commsConfig,
      commsStorage({
        connectionId: "google-chat-empty",
        key: "google-chat",
        config: { webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=test&token=test" },
      }),
    );
    expect(emptyCard).toMatchObject({ status: "sent" });
  });

  it("covers WhatsApp validation, media typing, upload failure, and reaction branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/media")) {
        return new Response(JSON.stringify({ error: { message: "media denied" } }), { status: 400 });
      }
      if (url.endsWith("/messages")) {
        const body = String(init?.body ?? "");
        if (body.includes("wa-fail")) {
          return new Response(JSON.stringify({ error: { message: "message denied" } }), { status: 400 });
        }
        return new Response(JSON.stringify({ messages: [{ id: "wa-msg" }] }), { status: 200 });
      }
      throw new Error(`Unexpected WhatsApp URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "graph.facebook.com");

    await expectFailed(
      executeTool(
        request("whatsapp.send", { connectionId: "wa-missing-token", message: "missing token" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-missing-token",
          key: "whatsapp",
          config: { phoneNumberId: "phone-1", defaultRecipient: "+15551234567" },
        }),
      ),
      /Missing WhatsApp access token/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.send", { connectionId: "wa-missing-phone", message: "missing phone" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-missing-phone",
          key: "whatsapp",
          config: { accessToken: "wa-token", defaultRecipient: "+15551234567" },
        }),
      ),
      /Missing WhatsApp phone number id/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.send", { connectionId: "wa-missing-target", message: "missing target" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-missing-target",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
        }),
      ),
      /Missing WhatsApp target/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.send", { connectionId: "wa-group", message: "group", target: "12345-67890@g.us" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-group",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
        }),
      ),
      /not group JIDs/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.send", { connectionId: "wa-empty", message: "" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-empty",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1", defaultRecipient: "+15551234567" },
        }),
      ),
      /requires a message or attachment/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.send", { connectionId: "wa-message-fail", message: "wa-fail" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-message-fail",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1", defaultRecipient: "+15551234567" },
        }),
      ),
      /message denied/i,
    );

    const richMedia = await executeTool(
      request("whatsapp.send", {
        connectionId: "wa-rich",
        message: "",
        target: "whatsapp:+1 (555) 123-4567",
        attachments: [
          { title: "clip.mp4", url: "https://example.com/clip.mp4" },
          { title: "audio.mp3", url: "https://example.com/audio.mp3" },
          { title: "photo.png", url: "https://example.com/photo.png" },
          { title: "report.pdf", url: "https://example.com/report.pdf" },
        ],
      }),
      commsConfig,
      commsStorage({
        connectionId: "wa-rich",
        key: "whatsapp",
        config: { accessToken: "wa-token", phoneNumberId: "phone-1", apiVersion: "/v99.0/" },
      }),
    );
    expect(richMedia).toMatchObject({ status: "sent", providerMessageId: "wa-msg" });
    const messageBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/messages"))
      .map(([, init]) => String((init as RequestInit | undefined)?.body ?? ""));
    expect(messageBodies.some((body) => body.includes('"type":"video"'))).toBe(true);
    expect(messageBodies.some((body) => body.includes('"type":"audio"'))).toBe(true);
    expect(messageBodies.some((body) => body.includes('"type":"image"'))).toBe(true);
    expect(messageBodies.some((body) => body.includes('"type":"document"'))).toBe(true);

    await expectFailed(
      executeTool(
        request("whatsapp.send", {
          connectionId: "wa-upload-fail",
          message: "",
          attachments: [
            { title: "inline.png", mimeType: "image/png", dataBase64: Buffer.from("png").toString("base64") },
          ],
        }),
        commsConfig,
        commsStorage({
          connectionId: "wa-upload-fail",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1", defaultRecipient: "+15551234567" },
        }),
      ),
      /media denied/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.react", { connectionId: "wa-react-missing-token", messageId: "msg-1", reaction: "👍" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-react-missing-token",
          key: "whatsapp",
          config: { phoneNumberId: "phone-1", defaultRecipient: "+15551234567" },
        }),
      ),
      /Missing WhatsApp access token/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.react", { connectionId: "wa-react-missing-phone", messageId: "msg-1", reaction: "👍" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-react-missing-phone",
          key: "whatsapp",
          config: { accessToken: "wa-token", defaultRecipient: "+15551234567" },
        }),
      ),
      /Missing WhatsApp phone number id/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.react", { connectionId: "wa-react-missing-target", messageId: "msg-1", reaction: "👍" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-react-missing-target",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
        }),
      ),
      /Missing WhatsApp target/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.react", {
          connectionId: "wa-react-group",
          messageId: "msg-1",
          reaction: "👍",
          target: "12345-67890@g.us",
        }),
        commsConfig,
        commsStorage({
          connectionId: "wa-react-group",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
        }),
      ),
      /not group JIDs/i,
    );
  });

  it("covers Mattermost validation, reactions, user targets, and API failures", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "bot-user" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/users/username/alice")) {
        return new Response(JSON.stringify({ id: "alice-user" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/channels/direct")) {
        expect(String(init?.body ?? "")).toContain("alice-user");
        return new Response(JSON.stringify({ id: "direct-channel" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/reactions")) {
        return new Response("", { status: 201 });
      }
      if (url.endsWith("/api/v4/posts/post-fail")) {
        return new Response("delete failed", { status: 500 });
      }
      if (url.endsWith("/api/v4/posts")) {
        if (String(init?.body ?? "").includes("post-fail")) {
          return new Response("post failed", { status: 500 });
        }
        return new Response(JSON.stringify({ id: "mattermost-post" }), { status: 201 });
      }
      throw new Error(`Unexpected Mattermost URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "mattermost.example.com");

    for (const [connectionId, connectionConfig, expected] of [
      ["mm-missing-server", { botToken: "mm-token", defaultChannel: "town-square" }, /Missing Mattermost server URL/i],
      [
        "mm-missing-token",
        { serverUrl: "https://mattermost.example.com", defaultChannel: "town-square" },
        /Missing Mattermost bot token/i,
      ],
      [
        "mm-missing-target",
        { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
        /Missing Mattermost target/i,
      ],
    ] as const) {
      await expectFailed(
        executeTool(
          request("mattermost.send", { connectionId, message: "mattermost" }),
          commsConfig,
          commsStorage({ connectionId, key: "mattermost", config: connectionConfig }),
        ),
        expected,
      );
    }

    const dmSent = await executeTool(
      request("mattermost.send", { connectionId: "mm-dm", message: "direct message", target: "@alice" }),
      commsConfig,
      commsStorage({
        connectionId: "mm-dm",
        key: "mattermost",
        config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
      }),
    );
    expect(dmSent).toMatchObject({ status: "sent", providerMessageId: "mattermost-post" });

    await expectFailed(
      executeTool(
        request("mattermost.send", {
          connectionId: "mm-post-fail",
          message: "post-fail",
          target: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
        commsConfig,
        commsStorage({
          connectionId: "mm-post-fail",
          key: "mattermost",
          config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
        }),
      ),
      /post failed/i,
    );

    const reacted = await executeTool(
      request("mattermost.react", { connectionId: "mm-react", messageId: "post-1", reaction: ":eyes:" }),
      commsConfig,
      commsStorage({
        connectionId: "mm-react",
        key: "mattermost",
        config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
      }),
    );
    expect(reacted).toMatchObject({ status: "sent", providerMessageId: "post-1" });

    await expectFailed(
      executeTool(
        request("mattermost.react", { connectionId: "mm-react-missing-server", messageId: "post-1", reaction: "eyes" }),
        commsConfig,
        commsStorage({
          connectionId: "mm-react-missing-server",
          key: "mattermost",
          config: { botToken: "mm-token" },
        }),
      ),
      /Missing Mattermost server URL/i,
    );

    await expectFailed(
      executeTool(
        request("mattermost.react", { connectionId: "mm-react-missing-token", messageId: "post-1", reaction: "eyes" }),
        commsConfig,
        commsStorage({
          connectionId: "mm-react-missing-token",
          key: "mattermost",
          config: { serverUrl: "https://mattermost.example.com" },
        }),
      ),
      /Missing Mattermost bot token/i,
    );

    await expectFailed(
      executeTool(
        request("mattermost.unsend", { connectionId: "mm-unsend-missing-server", messageId: "post-1" }),
        commsConfig,
        commsStorage({
          connectionId: "mm-unsend-missing-server",
          key: "mattermost",
          config: { botToken: "mm-token" },
        }),
      ),
      /Missing Mattermost server URL/i,
    );

    await expectFailed(
      executeTool(
        request("mattermost.unsend", { connectionId: "mm-unsend-missing-token", messageId: "post-1" }),
        commsConfig,
        commsStorage({
          connectionId: "mm-unsend-missing-token",
          key: "mattermost",
          config: { serverUrl: "https://mattermost.example.com" },
        }),
      ),
      /Missing Mattermost bot token/i,
    );

    await expectFailed(
      executeTool(
        request("mattermost.unsend", { connectionId: "mm-unsend-fail", messageId: "post-fail" }),
        commsConfig,
        commsStorage({
          connectionId: "mm-unsend-fail",
          key: "mattermost",
          config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
        }),
      ),
      /delete failed/i,
    );
  });

  it("covers Nextcloud Talk and Zalo validation and provider failure branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/ocs/v2.php/apps/spreed/api/v1/bot/")) {
        return new Response("nextcloud down", { status: 500 });
      }
      if (url === "https://openapi.zalo.me/v2.0/oa/message") {
        return new Response(JSON.stringify({ error: -1, message: "zalo denied" }), { status: 200 });
      }
      throw new Error(`Unexpected Nextcloud/Zalo URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "cloud.example.com", "openapi.zalo.me");

    for (const [connectionId, connectionConfig, expected] of [
      [
        "nextcloud-missing-base",
        { token: "nc-secret", defaultConversationId: "room-1" },
        /Missing Nextcloud Talk base URL/i,
      ],
      [
        "nextcloud-missing-token",
        { baseUrl: "https://cloud.example.com", defaultConversationId: "room-1" },
        /Missing Nextcloud Talk token/i,
      ],
      [
        "nextcloud-missing-target",
        { baseUrl: "https://cloud.example.com", token: "nc-secret" },
        /Missing Nextcloud Talk target/i,
      ],
    ] as const) {
      await expectFailed(
        executeTool(
          request("nextcloud-talk.send", { connectionId, message: "nextcloud" }),
          commsConfig,
          commsStorage({ connectionId, key: "nextcloud-talk", config: connectionConfig }),
        ),
        expected,
      );
    }

    await expectFailed(
      executeTool(
        request("nextcloud-talk.send", { connectionId: "nextcloud-send-fail", message: "nextcloud", replyTo: "123" }),
        commsConfig,
        commsStorage({
          connectionId: "nextcloud-send-fail",
          key: "nextcloud-talk",
          config: { baseUrl: "https://cloud.example.com", token: "nc-secret", defaultConversationId: "nc:room:room-1" },
        }),
      ),
      /nextcloud-talk\.send failed \(500\)/i,
    );

    for (const [connectionId, connectionConfig, expected] of [
      [
        "nextcloud-react-missing-base",
        { token: "nc-secret", defaultConversationId: "room-1" },
        /Missing Nextcloud Talk base URL/i,
      ],
      [
        "nextcloud-react-missing-token",
        { baseUrl: "https://cloud.example.com", defaultConversationId: "room-1" },
        /Missing Nextcloud Talk token/i,
      ],
      [
        "nextcloud-react-missing-target",
        { baseUrl: "https://cloud.example.com", token: "nc-secret" },
        /Missing Nextcloud Talk target/i,
      ],
    ] as const) {
      await expectFailed(
        executeTool(
          request("nextcloud-talk.react", { connectionId, messageId: "123", reaction: "👍" }),
          commsConfig,
          commsStorage({ connectionId, key: "nextcloud-talk", config: connectionConfig }),
        ),
        expected,
      );
    }

    await expectFailed(
      executeTool(
        request("nextcloud-talk.react", { connectionId: "nextcloud-react-fail", messageId: "123", reaction: "👍" }),
        commsConfig,
        commsStorage({
          connectionId: "nextcloud-react-fail",
          key: "nextcloud-talk",
          config: { baseUrl: "https://cloud.example.com", token: "nc-secret", defaultConversationId: "room-1" },
        }),
      ),
      /nextcloud-talk\.react failed \(500\)/i,
    );

    await expectFailed(
      executeTool(
        request("zalo.send", { connectionId: "zalo-missing-token", message: "zalo" }),
        commsConfig,
        commsStorage({
          connectionId: "zalo-missing-token",
          key: "zalo",
          config: { defaultRecipientId: "zalo:recipient-1" },
        }),
      ),
      /Missing Zalo access token/i,
    );

    await expectFailed(
      executeTool(
        request("zalo.send", { connectionId: "zalo-missing-target", message: "zalo" }),
        commsConfig,
        commsStorage({
          connectionId: "zalo-missing-target",
          key: "zalo",
          config: { accessToken: "zalo-token" },
        }),
      ),
      /Missing Zalo target/i,
    );

    await expectFailed(
      executeTool(
        request("zalo.send", { connectionId: "zalo-missing-message", message: "" }),
        commsConfig,
        commsStorage({
          connectionId: "zalo-missing-message",
          key: "zalo",
          config: { accessToken: "zalo-token", defaultRecipientId: "zalo:recipient-1" },
        }),
      ),
      /Zalo message is required/i,
    );

    await expectFailed(
      executeTool(
        request("zalo.send", { connectionId: "zalo-fail", message: "zalo" }),
        commsConfig,
        commsStorage({
          connectionId: "zalo-fail",
          key: "zalo",
          config: { accessToken: "zalo-token", defaultRecipientId: "zl:recipient-1" },
        }),
      ),
      /zalo denied/i,
    );
  });

  it("covers generic webhook, Slack, Teams, and Google Chat attachment edge branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://example.com/hook") {
        expect(String(init?.body ?? "")).toContain('"text":"No visible attachment lines"');
        return new Response("ok", { status: 200 });
      }
      if (url === "https://slack.com/api/chat.postMessage") {
        expect(String(init?.body ?? "")).toContain("https://example.com/readme.txt");
        return new Response(JSON.stringify({ ok: true, ts: "1712345678.000200", channel: "C123" }), { status: 200 });
      }
      if (url === "https://slack.com/api/files.getUploadURLExternal") {
        return new Response(JSON.stringify({ ok: true, upload_url: "https://uploads.slack.com/file", file_id: "F1" }), {
          status: 200,
        });
      }
      if (url === "https://uploads.slack.com/file") {
        return new Response("uploaded", { status: 200 });
      }
      if (url === "https://slack.com/api/files.completeUploadExternal") {
        expect(String(init?.body ?? "")).toContain('"thread_ts":"1712345678.000200"');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://outlook.office.com/webhook/example") {
        const body = String(init?.body ?? "");
        expect(body).toContain('"type":"Image"');
        expect(body).toContain("[readme.txt](https://example.com/readme.txt)");
        return new Response("ok", { status: 200 });
      }
      if (url === "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=test&token=test") {
        const body = String(init?.body ?? "");
        expect(body).toContain("imageUrl");
        expect(body).toContain("openLink");
        return new Response("ok", { status: 200 });
      }
      throw new Error(`Unexpected edge attachment URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(
      config,
      "example.com",
      "slack.com",
      "uploads.slack.com",
      "outlook.office.com",
      "chat.googleapis.com",
    );

    const genericWebhook = await executeTool(
      request("webhook.send", {
        connectionId: "generic-webhook",
        message: "No visible attachment lines",
        attachments: [{ mimeType: "text/plain" }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "generic-webhook",
        key: "generic",
        config: { webhookUrl: "https://example.com/hook" },
      }),
    );
    expect(genericWebhook).toMatchObject({ status: "sent" });

    const slackBot = await executeTool(
      request("slack.send", {
        connectionId: "slack-bot-edge",
        message: "",
        attachments: [
          { title: "ignored-without-url" },
          { url: "https://example.com/readme.txt", mimeType: "text/plain" },
          { dataBase64: Buffer.from("inline").toString("base64"), mimeType: "text/plain" },
        ],
      }),
      commsConfig,
      commsStorage({
        connectionId: "slack-bot-edge",
        key: "slack",
        config: { botToken: "xoxb-test", defaultChannel: "C123" },
      }),
    );
    expect(slackBot).toMatchObject({ status: "sent", providerMessageId: "1712345678.000200" });

    const teams = await executeTool(
      request("teams.send", {
        connectionId: "teams-urls",
        message: "urls",
        attachments: [
          { title: "skip-me" },
          { title: "dash.png", url: "https://example.com/dash.png", mimeType: "image/png" },
          { url: "https://example.com/readme.txt", mimeType: "text/plain" },
        ],
      }),
      commsConfig,
      commsStorage({
        connectionId: "teams-urls",
        key: "teams",
        config: { webhookUrl: "https://outlook.office.com/webhook/example" },
      }),
    );
    expect(teams).toMatchObject({ status: "sent" });

    const googleChat = await executeTool(
      request("google-chat.send", {
        connectionId: "google-chat-urls",
        message: "",
        attachments: [
          { title: "skip-me" },
          { title: "dash.png", url: "https://example.com/dash.png", mimeType: "image/png" },
          { url: "https://example.com/readme.txt", mimeType: "text/plain" },
        ],
      }),
      commsConfig,
      commsStorage({
        connectionId: "google-chat-urls",
        key: "google-chat",
        config: { webhookUrl: "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=test&token=test" },
      }),
    );
    expect(googleChat).toMatchObject({ status: "sent" });
  });

  it("covers WhatsApp upload success, target normalization, and malformed Zalo failures", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "media-1" }), { status: 200 });
      }
      if (url.endsWith("/messages")) {
        const body = String(init?.body ?? "");
        if (body.includes("wa-error-body")) {
          return new Response(JSON.stringify({ error: { message: "body denied" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ messages: [{}] }), { status: 200 });
      }
      if (url === "https://openapi.zalo.me/v2.0/oa/message") {
        return new Response("{malformed", { status: 500 });
      }
      throw new Error(`Unexpected WhatsApp/Zalo URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "graph.facebook.com", "openapi.zalo.me");

    const inlineUpload = await executeTool(
      request("whatsapp.send", {
        connectionId: "wa-inline-upload",
        message: "",
        target: "whatsapp:15551234567@s.whatsapp.net",
        attachments: [{ mimeType: "video/mp4", dataBase64: Buffer.from("video").toString("base64") }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "wa-inline-upload",
        key: "whatsapp",
        config: { accessToken: "wa-token", phoneNumberId: "phone-1", baseUrl: "https://graph.facebook.com/v23.0/" },
      }),
    );
    expect(inlineUpload).toMatchObject({ status: "sent" });

    const lidTarget = await executeTool(
      request("whatsapp.react", { connectionId: "wa-lid", messageId: "msg-1", reaction: "ok", target: "12345@lid" }),
      commsConfig,
      commsStorage({
        connectionId: "wa-lid",
        key: "whatsapp",
        config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
      }),
    );
    expect(lidTarget).toMatchObject({ status: "sent" });

    await expectFailed(
      executeTool(
        request("whatsapp.react", {
          connectionId: "wa-invalid-address",
          messageId: "msg-1",
          reaction: "ok",
          target: "person@example.com",
        }),
        commsConfig,
        commsStorage({
          connectionId: "wa-invalid-address",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
        }),
      ),
      /Missing WhatsApp target/i,
    );

    await expectFailed(
      executeTool(
        request("whatsapp.send", { connectionId: "wa-error-body", message: "wa-error-body" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-error-body",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1", defaultRecipient: "+15551234567" },
        }),
      ),
      /body denied/i,
    );

    await expectFailed(
      executeTool(
        request("zalo.send", { connectionId: "zalo-malformed-error", message: "zalo failure" }),
        commsConfig,
        commsStorage({
          connectionId: "zalo-malformed-error",
          key: "zalo",
          config: { accessToken: "zalo-token", defaultRecipientId: "recipient-1" },
        }),
      ),
      /zalo\.send failed \(500\)/i,
    );
  });

  it("covers Mattermost channel-name, team lookup, upload, and channel-not-found paths", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "bot-user" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/teams/name/ops")) {
        return new Response(JSON.stringify({ id: "team-ops" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/teams/team-ops/channels/name/town-square")) {
        return new Response(JSON.stringify({ id: "channel-town" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/files")) {
        return new Response(JSON.stringify({ file_infos: [{ id: "file-1" }] }), { status: 201 });
      }
      if (url.endsWith("/api/v4/posts")) {
        return new Response(JSON.stringify({ id: "mattermost-file-post" }), { status: 201 });
      }
      if (url.endsWith("/api/v4/users/bot-user/teams")) {
        return new Response(JSON.stringify([{ id: "team-a" }, { id: "team-b" }, {}]), { status: 200 });
      }
      if (
        url.endsWith("/api/v4/teams/team-a/channels/name/missing") ||
        url.endsWith("/api/v4/teams/team-b/channels/name/missing")
      ) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("/api/v4/teams/team-a/channels/name/broken")) {
        return new Response("boom", { status: 500 });
      }
      throw new Error(`Unexpected Mattermost edge URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "mattermost.example.com");

    const uploaded = await executeTool(
      request("mattermost.send", {
        connectionId: "mm-upload",
        message: "with file",
        target: "channel:#town-square",
        attachments: [{ mimeType: "text/plain", dataBase64: Buffer.from("log").toString("base64") }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "mm-upload",
        key: "mattermost",
        config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token", defaultTeam: "ops" },
      }),
    );
    expect(uploaded).toMatchObject({ status: "sent", providerMessageId: "mattermost-file-post" });

    const channelName = await executeTool(
      request("mattermost.send", {
        connectionId: "mm-channel-name",
        message: "channel name",
        target: "channel:town-square",
      }),
      commsConfig,
      commsStorage({
        connectionId: "mm-channel-name",
        key: "mattermost",
        config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token", defaultTeam: "ops" },
      }),
    );
    expect(channelName).toMatchObject({ status: "sent", providerMessageId: "mattermost-file-post" });

    await expectFailed(
      executeTool(
        request("mattermost.send", {
          connectionId: "mm-missing-channel-name",
          message: "missing",
          target: "#missing",
        }),
        commsConfig,
        commsStorage({
          connectionId: "mm-missing-channel-name",
          key: "mattermost",
          config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
        }),
      ),
      /Mattermost channel "#missing" not found/i,
    );

    await expectFailed(
      executeTool(
        request("mattermost.send", {
          connectionId: "mm-channel-lookup-error",
          message: "broken",
          target: "#broken",
        }),
        commsConfig,
        commsStorage({
          connectionId: "mm-channel-lookup-error",
          key: "mattermost",
          config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
        }),
      ),
      /mattermost\.send failed \(500\)/i,
    );
  });

  it("covers Gmail and Calendar validation and provider failure branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")) {
        return new Response("send denied", { status: 500 });
      }
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages")) {
        return new Response("read denied", { status: 500 });
      }
      if (url.includes("/calendar/v3/calendars/primary/events") && url.includes("singleEvents=true")) {
        return new Response("calendar denied", { status: 500 });
      }
      if (url.includes("/calendar/v3/calendars/primary/events")) {
        return new Response("create denied", { status: 500 });
      }
      throw new Error(`Unexpected Google failure URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "gmail.googleapis.com", "www.googleapis.com");

    await expectFailed(
      executeTool(
        request("gmail.read", { connectionId: "gmail-missing-token" }),
        commsConfig,
        commsStorage({
          connectionId: "gmail-missing-token",
          key: "gmail",
          config: { accessTokenEnv: "MISSING_GMAIL_TOKEN" },
        }),
      ),
      /requires Google sign-in/i,
    );
    await expectFailed(
      executeTool(
        request("gmail.read", { connectionId: "gmail-read-fail" }),
        commsConfig,
        commsStorage({ connectionId: "gmail-read-fail", key: "gmail", config: {} }),
        googleSignIn(),
      ),
      /gmail\.read failed \(500\)/i,
    );
    await expectFailed(
      executeTool(
        request("gmail.send", { connectionId: "gmail-send-missing-token", to: ["ops@example.com"] }),
        commsConfig,
        commsStorage({ connectionId: "gmail-send-missing-token", key: "gmail", config: {} }),
      ),
      /requires Google sign-in/i,
    );
    await expectFailed(
      executeTool(
        request("gmail.send", { connectionId: "gmail-send-missing-to", subject: "No recipient", bodyText: "Body" }),
        commsConfig,
        commsStorage({
          connectionId: "gmail-send-missing-to",
          key: "gmail",
          config: {},
        }),
        googleSignIn(),
      ),
      /gmail\.send requires args\.to/i,
    );
    await expectFailed(
      executeTool(
        request("gmail.send", {
          connectionId: "gmail-send-fail",
          to: ["ops@example.com"],
          subject: "Fail",
          bodyText: "Body",
        }),
        commsConfig,
        commsStorage({ connectionId: "gmail-send-fail", key: "gmail", config: {} }),
        googleSignIn(),
      ),
      /gmail\.send failed \(500\)/i,
    );

    await expectFailed(
      executeTool(
        request("calendar.list", { connectionId: "calendar-missing-token" }),
        commsConfig,
        commsStorage({ connectionId: "calendar-missing-token", key: "calendar", config: {} }),
      ),
      /requires Google sign-in/i,
    );
    await expectFailed(
      executeTool(
        request("calendar.list", { connectionId: "calendar-list-fail" }),
        commsConfig,
        commsStorage({
          connectionId: "calendar-list-fail",
          key: "calendar",
          config: {},
        }),
        googleSignIn(),
      ),
      /calendar\.list failed \(500\)/i,
    );
    await expectFailed(
      executeTool(
        request("calendar.create_event", {
          connectionId: "calendar-create-missing-token",
          title: "No token",
          startIso: "2026-03-22T17:00:00.000Z",
          endIso: "2026-03-22T17:30:00.000Z",
        }),
        commsConfig,
        commsStorage({ connectionId: "calendar-create-missing-token", key: "calendar", config: {} }),
      ),
      /requires Google sign-in/i,
    );
    await expectFailed(
      executeTool(
        request("calendar.create_event", {
          connectionId: "calendar-create-fail",
          title: "Fail",
          startIso: "2026-03-22T17:00:00.000Z",
          endIso: "2026-03-22T17:30:00.000Z",
        }),
        commsConfig,
        commsStorage({
          connectionId: "calendar-create-fail",
          key: "calendar",
          config: {},
        }),
        googleSignIn(),
      ),
      /calendar\.create_event failed \(500\)/i,
    );
  });

  it("covers Slack inline upload failure stages", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    let mode: "metadata" | "upload" | "complete" = "metadata";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://slack.com/api/files.getUploadURLExternal") {
        if (mode === "metadata") {
          return new Response(JSON.stringify({ ok: false, error: "metadata denied" }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, upload_url: "https://uploads.slack.com/file", file_id: "F1" }), {
          status: 200,
        });
      }
      if (url === "https://uploads.slack.com/file") {
        return mode === "upload" ? new Response("upload denied", { status: 500 }) : new Response("ok", { status: 200 });
      }
      if (url === "https://slack.com/api/files.completeUploadExternal") {
        return mode === "complete"
          ? new Response(JSON.stringify({ ok: false, error: "complete denied" }), { status: 200 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected Slack upload URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "slack.com", "uploads.slack.com");
    const runSlackUpload = (connectionId: string, mimeType: string) =>
      executeTool(
        request("slack.send", {
          connectionId,
          message: "",
          attachments: [{ mimeType, dataBase64: Buffer.from("inline").toString("base64") }],
        }),
        commsConfig,
        commsStorage({
          connectionId,
          key: "slack",
          config: { botToken: "xoxb-test", defaultChannel: "C123" },
        }),
      );

    await expectFailed(runSlackUpload("slack-upload-metadata-fail", "image/jpeg"), /metadata denied/i);
    mode = "upload";
    await expectFailed(runSlackUpload("slack-upload-body-fail", "text/"), /upload denied/i);
    mode = "complete";
    await expectFailed(runSlackUpload("slack-upload-complete-fail", "text"), /complete denied/i);
  });

  it("covers Mattermost empty-team and file-upload failure branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    let mode: "empty-teams" | "file-fail" | "file-empty" | "file-object" = "empty-teams";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "bot-user" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/users/bot-user/teams")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/api/v4/files")) {
        if (mode === "file-fail") {
          return new Response("file denied", { status: 500 });
        }
        if (mode === "file-object") {
          return new Response(JSON.stringify({ file_infos: {} }), { status: 201 });
        }
        return new Response(JSON.stringify({ file_infos: [] }), { status: 201 });
      }
      throw new Error(`Unexpected Mattermost upload failure URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "mattermost.example.com");

    await expectFailed(
      executeTool(
        request("mattermost.send", { connectionId: "mm-empty-teams", message: "teamless", target: "#town-square" }),
        commsConfig,
        commsStorage({
          connectionId: "mm-empty-teams",
          key: "mattermost",
          config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
        }),
      ),
      /not a member of any team/i,
    );

    const runMattermostUpload = (connectionId: string) =>
      executeTool(
        request("mattermost.send", {
          connectionId,
          message: "file",
          target: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
          attachments: [{ mimeType: "text/plain", dataBase64: Buffer.from("log").toString("base64") }],
        }),
        commsConfig,
        commsStorage({
          connectionId,
          key: "mattermost",
          config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
        }),
      );

    mode = "file-fail";
    await expectFailed(runMattermostUpload("mm-file-fail"), /file denied/i);
    mode = "file-empty";
    await expectFailed(runMattermostUpload("mm-file-empty"), /uploaded file id is required/i);
    mode = "file-object";
    await expectFailed(runMattermostUpload("mm-file-object"), /uploaded file id is required/i);
  });

  it("covers remaining Telegram, WhatsApp, and Mattermost normalization branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    let telegramMode: "string-id" | "fallback-id" = "string-id";
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      if (url.endsWith("/sendMessage")) {
        return telegramMode === "string-id"
          ? new Response(JSON.stringify({ ok: true, result: { message_id: "telegram-string" } }), { status: 200 })
          : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      }
      if (url.endsWith("/messages")) {
        if (body.includes("audio/mpeg")) {
          return new Response(JSON.stringify({ messages: [{ id: "wa-audio" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.endsWith("/media")) {
        return new Response(JSON.stringify({ id: "media-audio" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/users/me")) {
        return new Response(JSON.stringify({ id: "bot-user" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/channels/direct")) {
        return new Response(JSON.stringify({ id: "direct-channel" }), { status: 200 });
      }
      if (url.endsWith("/api/v4/posts")) {
        return new Response(JSON.stringify({ id: "mattermost-target-post" }), { status: 201 });
      }
      throw new Error(`Unexpected remaining normalization URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "api.telegram.org", "graph.facebook.com", "mattermost.example.com");

    const telegramStringId = await executeTool(
      request("telegram.send", { connectionId: "telegram-string-id", message: "telegram" }),
      commsConfig,
      commsStorage({
        connectionId: "telegram-string-id",
        key: "telegram",
        config: { botToken: "tg-token", defaultChatId: "-1001" },
      }),
    );
    expect(telegramStringId).toMatchObject({ status: "sent", providerMessageId: "telegram-string" });

    telegramMode = "fallback-id";
    const telegramFallback = await executeTool(
      request("telegram.send", { connectionId: "telegram-fallback-id", message: "telegram" }),
      commsConfig,
      commsStorage({
        connectionId: "telegram-fallback-id",
        key: "telegram",
        config: { botToken: "tg-token", defaultChatId: "-1001" },
      }),
    );
    expect(telegramFallback).toMatchObject({ status: "sent" });
    expect(String(telegramFallback.providerMessageId)).toMatch(/^telegram-/);

    await expectFailed(
      executeTool(
        request("whatsapp.send", { connectionId: "wa-empty-prefix", message: "empty", target: "whatsapp:" }),
        commsConfig,
        commsStorage({
          connectionId: "wa-empty-prefix",
          key: "whatsapp",
          config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
        }),
      ),
      /Missing WhatsApp target/i,
    );

    const whatsappAudio = await executeTool(
      request("whatsapp.send", {
        connectionId: "wa-audio-mime",
        message: "",
        target: "+15551234567",
        attachments: [{ mimeType: "audio/mpeg", dataBase64: Buffer.from("audio").toString("base64") }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "wa-audio-mime",
        key: "whatsapp",
        config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
      }),
    );
    expect(whatsappAudio).toMatchObject({ status: "sent" });
    expect(String(whatsappAudio.providerMessageId)).toMatch(/^whatsapp-/);

    const whatsappFallback = await executeTool(
      request("whatsapp.send", { connectionId: "wa-messages-fallback", message: "fallback", target: "+15551234567" }),
      commsConfig,
      commsStorage({
        connectionId: "wa-messages-fallback",
        key: "whatsapp",
        config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
      }),
    );
    expect(whatsappFallback).toMatchObject({ status: "sent" });
    expect(String(whatsappFallback.providerMessageId)).toMatch(/^whatsapp-/);

    const whatsappInvalidAttachmentName = await executeTool(
      request("whatsapp.send", {
        connectionId: "wa-invalid-attachment-name",
        message: "",
        target: "+15551234567",
        attachments: [{ url: "not a url", mimeType: "application/pdf" }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "wa-invalid-attachment-name",
        key: "whatsapp",
        config: { accessToken: "wa-token", phoneNumberId: "phone-1" },
      }),
    );
    expect(whatsappInvalidAttachmentName).toMatchObject({ status: "sent" });

    for (const [connectionId, target] of [
      ["mm-channel-id-target", "channel:aaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["mm-user-id-target", "user:user-1"],
      ["mm-mattermost-id-target", "mattermost:user-2"],
    ] as const) {
      const result = await executeTool(
        request("mattermost.send", { connectionId, message: "mattermost target", target }),
        commsConfig,
        commsStorage({
          connectionId,
          key: "mattermost",
          config: { serverUrl: "https://mattermost.example.com", botToken: "mm-token" },
        }),
      );
      expect(result).toMatchObject({ status: "sent", providerMessageId: "mattermost-target-post" });
    }
  });

  it("covers LINE request-id fallbacks and generic webhook delivery branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    let lineMode: "with-header" | "without-header" = "with-header";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://api.line.me/v2/bot/message/push") {
        return lineMode === "with-header"
          ? new Response("{}", { status: 200, headers: { "x-line-request-id": "line-request-1" } })
          : new Response("{}", { status: 200 });
      }
      if (url === "https://example.com/generic-ok") {
        return new Response("ok", { status: 200 });
      }
      if (url === "https://example.com/generic-fail") {
        return new Response("down", { status: 503 });
      }
      throw new Error(`Unexpected LINE/webhook URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "api.line.me", "example.com");

    const lineWithHeader = await executeTool(
      request("line.send", { connectionId: "line-with-header", message: "line message" }),
      commsConfig,
      commsStorage({
        connectionId: "line-with-header",
        key: "line",
        config: { channelAccessToken: "line-token", defaultTarget: "line:user:U123" },
      }),
    );
    expect(lineWithHeader).toMatchObject({ status: "sent", providerMessageId: "line-request-1" });

    lineMode = "without-header";
    const lineWithoutHeader = await executeTool(
      request("channel.send", { connectionId: "line-without-header", message: "line fallback id" }),
      commsConfig,
      commsStorage({
        connectionId: "line-without-header",
        key: "line",
        config: { channelAccessToken: "line-token", defaultTarget: "line:user:U123" },
      }),
    );
    expect(lineWithoutHeader).toMatchObject({ status: "sent" });
    expect(String(lineWithoutHeader.providerMessageId)).toMatch(/^line-/);

    const genericWebhook = await executeTool(
      request("channel.send", {
        connectionId: "generic-ok",
        message: "generic",
        payload: { severity: "info" },
      }),
      commsConfig,
      commsStorage({
        connectionId: "generic-ok",
        key: "custom",
        config: { webhookUrl: "https://example.com/generic-ok", defaultTarget: "ops" },
      }),
    );
    expect(genericWebhook).toMatchObject({ status: "sent" });
    expect(String(genericWebhook.providerMessageId)).toMatch(/^channel\.send-/);

    await expectFailed(
      executeTool(
        request("channel.send", { connectionId: "generic-missing-url", message: "missing url" }),
        commsConfig,
        commsStorage({
          connectionId: "generic-missing-url",
          key: "custom",
          config: {},
        }),
      ),
      /Missing webhook URL/i,
    );

    const genericFailStorage = commsStorage({
      connectionId: "generic-fail",
      key: "custom",
      config: { webhookUrl: "https://example.com/generic-fail" },
    });
    const genericFailure = await executeTool(
      request("channel.send", { connectionId: "generic-fail", message: "fail" }),
      commsConfig,
      genericFailStorage,
    );
    expect(genericFailure).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "https://example.com/generic-fail")).toHaveLength(
      1,
    );
    expect(String(genericFailure.error ?? "")).toMatch(/channel\.send failed \(503\)/i);
    expect(genericFailStorage.commsDeliveries.markFailed).toHaveBeenCalledWith(
      "delivery-generic-fail",
      expect.stringMatching(/unknown_after_send/i),
      expect.any(String),
      "manual_reconciliation_required",
    );
  });

  it("marks partial rich-channel sends for manual reconciliation in the durable ledger", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://slack.com/api/chat.postMessage") {
        return new Response(JSON.stringify({ ok: true, ts: "1712345678.000100", channel: "C123" }), { status: 200 });
      }
      if (url === "https://slack.com/api/files.getUploadURLExternal") {
        return new Response(JSON.stringify({ ok: false, error: "upload_unavailable" }), { status: 500 });
      }
      if (url.endsWith("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), { status: 200 });
      }
      if (url.endsWith("/sendPhoto")) {
        return new Response(JSON.stringify({ ok: false, description: "media down" }), { status: 500 });
      }
      if (url === "https://graph.facebook.com/v23.0/phone-1/messages") {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { type?: string };
        if (payload.type === "text") {
          return new Response(JSON.stringify({ messages: [{ id: "wamid.text-1" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { message: "media down" } }), { status: 500 });
      }
      throw new Error(`Unexpected partial-send URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "slack.com", "api.telegram.org", "graph.facebook.com");

    const slackStorage = commsStorage({
      connectionId: "slack-partial",
      key: "slack",
      config: { botToken: "xoxb-test", defaultChannel: "C123" },
    });
    const slackResult = await executeTool(
      request("slack.send", {
        connectionId: "slack-partial",
        message: "posted before upload",
        attachments: [{ title: "evidence.txt", dataBase64: Buffer.from("evidence").toString("base64") }],
      }),
      commsConfig,
      slackStorage,
    );
    expect(slackResult).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "1712345678.000100",
    });
    expect(String(slackResult.error ?? "")).toContain("partial_channel_delivery_sent");
    expect(slackStorage.commsDeliveries.markFailed).toHaveBeenCalledWith(
      "delivery-slack-partial",
      expect.stringContaining("partial_channel_delivery_sent"),
      expect.any(String),
      "manual_reconciliation_required",
      undefined,
      "1712345678.000100",
    );

    const telegramStorage = commsStorage({
      connectionId: "telegram-partial",
      key: "telegram",
      config: { botToken: "telegram-token", defaultChatId: "chat-1" },
    });
    const telegramResult = await executeTool(
      request("telegram.send", {
        connectionId: "telegram-partial",
        message: "t".repeat(1025),
        attachments: [{ url: "https://example.com/photo.png", mimeType: "image/png" }],
      }),
      commsConfig,
      telegramStorage,
    );
    expect(telegramResult).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "1001",
    });
    expect(String(telegramResult.error ?? "")).toContain("message 1001 was sent before attachment 1 failed");
    expect(telegramStorage.commsDeliveries.markFailed).toHaveBeenCalledWith(
      "delivery-telegram-partial",
      expect.stringContaining("partial_channel_delivery_sent"),
      expect.any(String),
      "manual_reconciliation_required",
      undefined,
      "1001",
    );

    const whatsappStorage = commsStorage({
      connectionId: "whatsapp-partial",
      key: "whatsapp",
      config: { accessToken: "whatsapp-token", phoneNumberId: "phone-1", defaultTarget: "+15551234567" },
    });
    const whatsappResult = await executeTool(
      request("whatsapp.send", {
        connectionId: "whatsapp-partial",
        message: "sent before media",
        attachments: [{ url: "https://example.com/photo.png", mimeType: "image/png" }],
      }),
      commsConfig,
      whatsappStorage,
    );
    expect(whatsappResult).toMatchObject({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
      providerMessageId: "wamid.text-1",
    });
    expect(String(whatsappResult.error ?? "")).toContain("message wamid.text-1 was sent before attachment 1 failed");
    expect(whatsappStorage.commsDeliveries.markFailed).toHaveBeenCalledWith(
      "delivery-whatsapp-partial",
      expect.stringContaining("partial_channel_delivery_sent"),
      expect.any(String),
      "manual_reconciliation_required",
      undefined,
      "wamid.text-1",
    );
  });

  it("covers Gmail and Calendar empty-provider-id fallbacks", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes("/calendar/v3/calendars/primary/events") && !url.includes("singleEvents=true")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`Unexpected Google fallback URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "gmail.googleapis.com", "www.googleapis.com");

    const gmailFallback = await executeTool(
      request("gmail.send", {
        connectionId: "gmail-fallback-id",
        to: ["ops@example.com"],
        subject: "Fallback",
        bodyText: "No provider id.",
      }),
      commsConfig,
      commsStorage({
        connectionId: "gmail-fallback-id",
        key: "gmail",
        config: {},
      }),
      googleSignIn(),
    );
    expect(gmailFallback).toMatchObject({ status: "sent" });
    expect(String(gmailFallback.providerMessageId)).toMatch(/^gmail-/);

    const calendarFallback = await executeTool(
      request("calendar.create_event", {
        connectionId: "calendar-fallback-id",
        title: "Fallback",
        startIso: "2026-03-22T17:00:00.000Z",
        endIso: "2026-03-22T17:30:00.000Z",
      }),
      commsConfig,
      commsStorage({
        connectionId: "calendar-fallback-id",
        key: "calendar",
        config: {},
      }),
      googleSignIn(),
    );
    expect(calendarFallback).toMatchObject({ status: "sent" });
    expect(String(calendarFallback.providerMessageId)).toMatch(/^calendar-/);
  });
});

/** The Gateway-owned Google sign-in hook; tests never put a token in connection config. */
function googleSignIn(token = "google-token") {
  return { resolveGoogleWorkspaceAccessToken: vi.fn(async () => token) };
}

function createConfig(): ToolPolicyConfig {
  return {
    profiles: {
      danger: ["*"],
    },
    tools: {
      profile: "danger",
      approvalMode: "bypass",
      allow: [],
      deny: [],
    },
    agents: {},
    sandbox: {
      writeJailRoots: [process.cwd()],
      readOnlyRoots: [process.cwd()],
      networkAllowlist: ["example.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function withAllowlist(base: ToolPolicyConfig, ...hosts: string[]): ToolPolicyConfig {
  return {
    ...base,
    sandbox: {
      ...base.sandbox,
      networkAllowlist: [...base.sandbox.networkAllowlist, ...hosts],
    },
  };
}

function request(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
  return {
    toolName,
    args,
    agentId: "agent",
    sessionId: "session",
  };
}

function commsStorage(connection: {
  connectionId: string;
  key: string;
  config: Record<string, unknown>;
}): Storage & AsyncStorage {
  return {
    integrationConnections: {
      get: vi.fn(() => connection),
    },
    commsDeliveries: {
      createQueued: vi.fn((input: Record<string, unknown>) => ({
        deliveryId: `delivery-${connection.connectionId}`,
        status: "queued",
        channelKey: input.channelKey,
        target: input.target,
        createdAt: "2026-03-22T00:00:00.000Z",
        updatedAt: "2026-03-22T00:00:00.000Z",
      })),
      markSent: vi.fn(),
      markFailed: vi.fn(),
    },
  } as unknown as Storage & AsyncStorage;
}

async function expectFailed(resultPromise: Promise<Record<string, unknown>>, errorPattern: RegExp): Promise<void> {
  const result = await resultPromise;
  expect(result).toMatchObject({ status: "failed" });
  expect(String(result.error ?? "")).toMatch(errorPattern);
}
