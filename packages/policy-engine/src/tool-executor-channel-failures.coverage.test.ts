import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

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

  it("covers Zalo User target normalization, authorization, media endpoint, and error branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      if (body.includes("fail-zca")) {
        return new Response(JSON.stringify({ error: { message: "zca denied" } }), { status: 500 });
      }
      if (url.endsWith("/messages/text")) {
        return new Response(JSON.stringify({ data: { message_id: "zca-text" } }), { status: 200 });
      }
      if (url.endsWith("/messages/video")) {
        return new Response(JSON.stringify({ result: { id: 42 } }), { status: 200 });
      }
      if (url.endsWith("/messages/voice")) {
        return new Response(JSON.stringify({ message: { msg_id: "voice-1" } }), { status: 200 });
      }
      if (url.endsWith("/messages/link")) {
        return new Response(JSON.stringify({ id: "link-1" }), { status: 200 });
      }
      throw new Error(`Unexpected Zalo User URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "zca.example.com");

    await expectFailed(
      executeTool(
        request("zalouser.send", { connectionId: "zca-missing-base", message: "zca" }),
        commsConfig,
        commsStorage({
          connectionId: "zca-missing-base",
          key: "zalouser",
          config: { defaultRecipientId: "user:friend-1" },
        }),
      ),
      /Missing Zalo User bridge URL/i,
    );

    await expectFailed(
      executeTool(
        request("zalouser.send", { connectionId: "zca-missing-target", message: "zca" }),
        commsConfig,
        commsStorage({
          connectionId: "zca-missing-target",
          key: "zalouser",
          config: { baseUrl: "zca.example.com" },
        }),
      ),
      /Missing Zalo User target/i,
    );

    const text = await executeTool(
      request("zalouser.send", { connectionId: "zca-text", message: "hello", target: "zlu:dm:friend-1" }),
      commsConfig,
      commsStorage({
        connectionId: "zca-text",
        key: "zalouser",
        config: { baseUrl: "zca.example.com", basicAuth: "user:pass" },
      }),
    );
    expect(text).toMatchObject({ status: "sent", providerMessageId: "zca-text" });

    const groupVideo = await executeTool(
      request("zalouser.send", {
        connectionId: "zca-video",
        message: "video",
        target: "g:group-1",
        attachments: [{ url: "https://example.com/clip.mov" }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "zca-video",
        key: "zalouser",
        config: { baseUrl: "https://zca.example.com", authToken: "bearer-token" },
      }),
    );
    expect(groupVideo).toMatchObject({ status: "sent", providerMessageId: "42" });

    const voice = await executeTool(
      request("zalouser.send", {
        connectionId: "zca-voice",
        message: "voice",
        target: "u:friend-2",
        attachments: [{ url: "https://example.com/audio.ogg" }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "zca-voice",
        key: "zalouser",
        config: { baseUrl: "https://zca.example.com", authorization: "Bearer explicit" },
      }),
    );
    expect(voice).toMatchObject({ status: "sent", providerMessageId: "voice-1" });

    const link = await executeTool(
      request("zalouser.send", {
        connectionId: "zca-link",
        message: "link",
        target: "g-raw-group",
        attachments: [{ url: "https://example.com/readme.txt" }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "zca-link",
        key: "zalouser",
        config: { baseUrl: "https://zca.example.com" },
      }),
    );
    expect(link).toMatchObject({ status: "sent", providerMessageId: "link-1" });

    await expectFailed(
      executeTool(
        request("zalouser.send", { connectionId: "zca-fail", message: "fail-zca", target: "u-raw-user" }),
        commsConfig,
        commsStorage({
          connectionId: "zca-fail",
          key: "zalouser",
          config: { baseUrl: "https://zca.example.com" },
        }),
      ),
      /zca denied/i,
    );
  });

  it("covers iMessage validation and unresolved BlueBubbles chat branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/chat/query?password=bb-password")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.endsWith("/api/v1/chat/new?password=bb-password")) {
        return new Response(JSON.stringify({ data: { guid: "created-chat" } }), { status: 200 });
      }
      throw new Error(`Unexpected BlueBubbles URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "127.0.0.1");

    await expectFailed(
      executeTool(
        request("imessage.send", { connectionId: "imessage-missing-base", message: "missing base" }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-missing-base",
          key: "imessage",
          config: { password: "bb-password", defaultHandle: "+15551234567" },
        }),
      ),
      /Missing iMessage bridge URL/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", { connectionId: "imessage-missing-password", message: "missing password" }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-missing-password",
          key: "imessage",
          config: { bridgeUrl: "127.0.0.1:1234", defaultHandle: "+15551234567" },
        }),
      ),
      /Missing iMessage bridge password/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", { connectionId: "imessage-missing-target", message: "missing target" }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-missing-target",
          key: "imessage",
          config: { bridgeUrl: "127.0.0.1:1234", password: "bb-password" },
        }),
      ),
      /Missing iMessage target/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", { connectionId: "imessage-photon", message: "photon should not misroute" }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-photon",
          key: "imessage",
          config: {
            bridgeProvider: "photon",
            bridgeUrl: "127.0.0.1:4317",
            password: "photon-token",
            defaultHandle: "+15551234567",
          },
        }),
      ),
      /Photon iMessage provider is recognized but not runnable/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const created = await executeTool(
      request("imessage.send", {
        connectionId: "imessage-create-chat",
        message: "new chat",
        target: "sms:+15551234567",
      }),
      commsConfig,
      commsStorage({
        connectionId: "imessage-create-chat",
        key: "imessage",
        config: { bridgeUrl: "127.0.0.1:1234", password: "bb-password" },
      }),
    );
    expect(created).toMatchObject({ status: "sent", providerMessageId: "created-chat" });

    await expectFailed(
      executeTool(
        request("imessage.send", {
          connectionId: "imessage-unresolved-attachment-chat",
          message: "attachment",
          target: "auto:+15557654321",
          attachments: [{ title: "inline.txt", dataBase64: Buffer.from("inline").toString("base64") }],
        }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-unresolved-attachment-chat",
          key: "imessage",
          config: { bridgeUrl: "127.0.0.1:1234", password: "bb-password" },
        }),
      ),
      /created chat could not be resolved/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.react", {
          connectionId: "imessage-react-unresolved",
          messageId: "msg-1",
          reaction: "love",
          target: "chat_identifier:missing-chat",
        }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-react-unresolved",
          key: "imessage",
          config: { bridgeUrl: "127.0.0.1:1234", password: "bb-password" },
        }),
      ),
      /chatGuid not found/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.react", {
          connectionId: "imessage-react-missing-base",
          messageId: "msg-1",
          reaction: "love",
        }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-react-missing-base",
          key: "imessage",
          config: { password: "bb-password", defaultHandle: "+15551234567" },
        }),
      ),
      /Missing iMessage bridge URL/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.react", {
          connectionId: "imessage-react-missing-password",
          messageId: "msg-1",
          reaction: "love",
        }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-react-missing-password",
          key: "imessage",
          config: { bridgeUrl: "127.0.0.1:1234", defaultHandle: "+15551234567" },
        }),
      ),
      /Missing iMessage bridge password/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.react", {
          connectionId: "imessage-react-missing-target",
          messageId: "msg-1",
          reaction: "love",
        }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-react-missing-target",
          key: "imessage",
          config: { bridgeUrl: "127.0.0.1:1234", password: "bb-password" },
        }),
      ),
      /Missing iMessage target/i,
    );
  });

  it("covers Signal RPC error envelopes, malformed responses, empty responses, and non-ok results", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const commsConfig = withAllowlist(config, "signal.example.com");

    await expectFailed(
      executeTool(
        request("signal.send", {
          connectionId: "signal-missing-base",
          target: "signal:+15551234567",
          message: "missing",
        }),
        commsConfig,
        commsStorage({
          connectionId: "signal-missing-base",
          key: "signal",
          config: {},
        }),
      ),
      /Missing Signal base URL/i,
    );

    await expectFailed(
      executeTool(
        request("signal.send", { connectionId: "signal-missing-target", message: "missing" }),
        commsConfig,
        commsStorage({
          connectionId: "signal-missing-target",
          key: "signal",
          config: { baseUrl: "https://signal.example.com" },
        }),
      ),
      /Missing Signal target/i,
    );

    await expectFailed(
      signalSendWithResponse(commsConfig, new Response("", { status: 200 })),
      /Signal RPC empty response/i,
    );

    await expectFailed(
      signalSendWithResponse(commsConfig, new Response("{nope", { status: 200 })),
      /Signal RPC returned malformed JSON/i,
    );

    await expectFailed(
      signalSendWithResponse(
        commsConfig,
        new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "bridge failed" } }), {
          status: 200,
        }),
      ),
      /Signal RPC -32603: bridge failed/i,
    );

    await expectFailed(
      signalSendWithResponse(commsConfig, new Response(JSON.stringify({ jsonrpc: "2.0" }), { status: 200 })),
      /invalid response envelope/i,
    );

    await expectFailed(
      signalSendWithResponse(
        commsConfig,
        new Response(JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 123 } }), { status: 500 }),
      ),
      /signal\.send failed \(500\)/i,
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

  it("covers Zalo User target, attachment classification, auth headers, fallback IDs, and attachment failures", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const zcaHeaders: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      zcaHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      if (url.endsWith("/messages/text")) {
        if (body.includes("empty-error")) {
          return new Response("", { status: 500 });
        }
        if (body.includes("plain-error")) {
          return new Response("plain text denied", { status: 500 });
        }
        if (body.includes("nested-result-id")) {
          return new Response(JSON.stringify({ result: { message_id: "nested-result-message" } }), { status: 200 });
        }
        if (body.includes("numeric-id")) {
          return new Response(JSON.stringify({ message: { id: 8675309 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/messages/image")) {
        if (body.includes("fail-image")) {
          return new Response(JSON.stringify({ error: { message: "image denied" } }), { status: 500 });
        }
        return new Response(JSON.stringify({ data: { messageId: "image-1" } }), { status: 200 });
      }
      if (url.endsWith("/messages/video")) {
        if (body.includes("attachment-fallback")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ msgId: "video-1" }), { status: 200 });
      }
      if (url.endsWith("/messages/voice")) {
        return new Response(JSON.stringify({ msg_id: "voice-1" }), { status: 200 });
      }
      if (url.endsWith("/messages/link")) {
        return new Response(JSON.stringify({ id: "link-1" }), { status: 200 });
      }
      throw new Error(`Unexpected Zalo User edge URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "zca.example.com");

    await expectFailed(
      executeTool(
        request("zalouser.send", { connectionId: "zca-empty-target", message: "empty target", target: "zlu:" }),
        commsConfig,
        commsStorage({
          connectionId: "zca-empty-target",
          key: "zalouser",
          config: { baseUrl: "https://zca.example.com" },
        }),
      ),
      /Zalo User target is required/i,
    );

    for (const [connectionId, target, expectedError] of [
      ["zca-empty-group", "zlu:group:", /Zalo User target is required/i],
      ["zca-empty-group-alias", "zlu:g:", /Zalo User target is required/i],
      ["zca-empty-user", "zlu:user:", /Zalo User target is required/i],
      ["zca-empty-dm-alias", "zlu:dm:", /Zalo User target is required/i],
      ["zca-empty-user-alias", "zlu:u:", /Zalo User target is required/i],
    ] as const) {
      await expectFailed(
        executeTool(
          request("zalouser.send", { connectionId, message: "empty alias", target }),
          commsConfig,
          commsStorage({
            connectionId,
            key: "zalouser",
            config: { baseUrl: "https://zca.example.com" },
          }),
        ),
        expectedError,
      );
    }

    const fallbackText = await executeTool(
      request("zalouser.send", { connectionId: "zca-fallback-id", message: "fallback", target: "friend-raw" }),
      commsConfig,
      commsStorage({
        connectionId: "zca-fallback-id",
        key: "zalouser",
        config: { baseUrl: "https://zca.example.com" },
      }),
    );
    expect(fallbackText).toMatchObject({ status: "sent" });
    expect(String(fallbackText.providerMessageId)).toMatch(/^zalouser-/);

    for (const [connectionId, target, configOverride, expectedAuthorization] of [
      [
        "zca-group-alias",
        "zlu:g:team-alias",
        { baseUrl: "https://zca.example.com", authorization: "  Token explicit  " },
        "Token explicit",
      ],
      [
        "zca-user-alias",
        "zlu:u:friend-alias",
        { baseUrl: "https://zca.example.com", authToken: "bearer-token" },
        "Bearer bearer-token",
      ],
      [
        "zca-dm-alias",
        "zlu:dm:friend-dm",
        { baseUrl: "https://zca.example.com", basicAuth: "user:pass" },
        `Basic ${Buffer.from("user:pass", "utf8").toString("base64")}`,
      ],
      [
        "zca-raw-group-prefix",
        "g-raw-team",
        { baseUrl: "https://zca.example.com", basicAuth: "Basic already-encoded" },
        "Basic already-encoded",
      ],
      ["zca-raw-user-prefix", "u-raw-friend", { baseUrl: "https://zca.example.com" }, undefined],
    ] as const) {
      const sent = await executeTool(
        request("zalouser.send", {
          connectionId,
          message: connectionId === "zca-user-alias" ? "nested-result-id" : "alias",
          target,
        }),
        commsConfig,
        commsStorage({
          connectionId,
          key: "zalouser",
          config: configOverride,
        }),
      );
      expect(sent).toMatchObject({ status: "sent" });
      if (connectionId === "zca-user-alias") {
        expect(sent.providerMessageId).toBe("nested-result-message");
      }
      if (expectedAuthorization) {
        expect(zcaHeaders.some((headers) => headers.authorization === expectedAuthorization)).toBe(true);
      }
    }

    const numericId = await executeTool(
      request("zalouser.send", { connectionId: "zca-numeric-id", message: "numeric-id", target: "friend-number" }),
      commsConfig,
      commsStorage({
        connectionId: "zca-numeric-id",
        key: "zalouser",
        config: { baseUrl: "https://zca.example.com" },
      }),
    );
    expect(numericId).toMatchObject({ status: "sent", providerMessageId: "8675309" });

    await expectFailed(
      executeTool(
        request("zalouser.send", {
          connectionId: "zca-empty-provider-error",
          message: "empty-error",
          target: "friend-empty-error",
        }),
        commsConfig,
        commsStorage({
          connectionId: "zca-empty-provider-error",
          key: "zalouser",
          config: { baseUrl: "https://zca.example.com" },
        }),
      ),
      /zalouser\.send failed \(500\)$/i,
    );

    const image = await executeTool(
      request("zalouser.send", {
        connectionId: "zca-image",
        message: "image",
        target: "group:team-1",
        attachments: [{ title: "picture", url: "https://example.com/picture", mimeType: "image/png" }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "zca-image",
        key: "zalouser",
        config: { baseUrl: "https://zca.example.com" },
      }),
    );
    expect(image).toMatchObject({ status: "sent", providerMessageId: "image-1" });

    for (const [connectionId, attachment, providerMessageId] of [
      ["zca-image-extension", { url: "https://example.com/picture.gif" }, "image-1"],
      ["zca-video-extension", { url: "https://example.com/movie.mov" }, "video-1"],
      ["zca-attachment-fallback", { url: "https://example.com/attachment-fallback.mp4" }, /^zalouser-/],
      ["zca-audio-extension", { url: "https://example.com/voice.mp3" }, "voice-1"],
      ["zca-link-extension", { url: "https://example.com/file.txt" }, "link-1"],
    ] as const) {
      const attachmentResult = await executeTool(
        request("zalouser.send", {
          connectionId,
          message: "attachment",
          target: "friend-attachment",
          attachments: [attachment],
        }),
        commsConfig,
        commsStorage({
          connectionId,
          key: "zalouser",
          config: { baseUrl: "https://zca.example.com" },
        }),
      );
      expect(attachmentResult).toMatchObject({ status: "sent" });
      if (providerMessageId instanceof RegExp) {
        expect(String(attachmentResult.providerMessageId)).toMatch(providerMessageId);
      } else {
        expect(attachmentResult.providerMessageId).toBe(providerMessageId);
      }
    }

    await expectFailed(
      executeTool(
        request("zalouser.send", {
          connectionId: "zca-image-fail",
          message: "fail-image",
          target: "user:friend-1",
          attachments: [{ url: "https://example.com/picture.png" }],
        }),
        commsConfig,
        commsStorage({
          connectionId: "zca-image-fail",
          key: "zalouser",
          config: { baseUrl: "https://zca.example.com" },
        }),
      ),
      /image denied/i,
    );

    await expectFailed(
      executeTool(
        request("zalouser.send", {
          connectionId: "zca-plain-text-fail",
          message: "plain-error",
          target: "friend-plain",
        }),
        commsConfig,
        commsStorage({
          connectionId: "zca-plain-text-fail",
          key: "zalouser",
          config: { baseUrl: "https://zca.example.com" },
        }),
      ),
      /plain text denied/i,
    );
  });

  it("covers BlueBubbles lookup, text, multipart, reaction, unsend, and failure paths", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const queryBodies: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      if (url.endsWith("/api/v1/chat/query?password=bb-password")) {
        queryBodies.push(body);
        if (body.includes('"offset":0')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 42, guid: "chat-guid-42" },
                { identifier: "direct-identifier" },
                { guid: "iMessage;-;friend@example.com" },
                { guid: "iMessage;-;group-chat", participants: [{ address: "group@example.com" }] },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.endsWith("/api/v1/message/text?password=bb-password")) {
        if (body.includes("fail-text")) {
          return new Response("text denied", { status: 500 });
        }
        expect(body).toContain("tempGuid");
        return new Response(JSON.stringify({ data: { messageGuid: "text-message" } }), { status: 200 });
      }
      if (url.endsWith("/api/v1/attachment/upload?password=bb-password")) {
        if (String(init?.body ?? "").includes("never")) {
          return new Response("unused", { status: 500 });
        }
        return new Response(JSON.stringify({ data: { hash: "hash-1" } }), { status: 200 });
      }
      if (url.endsWith("/api/v1/message/multipart?password=bb-password")) {
        if (body.includes("fail-multipart")) {
          return new Response("multipart denied", { status: 500 });
        }
        expect(body).toContain('"subject":"Subject"');
        return new Response(JSON.stringify({ data: [{ message_guid: "multipart-message" }] }), { status: 200 });
      }
      if (url.endsWith("/api/v1/message/react?password=bb-password")) {
        if (body.includes("fail-react")) {
          return new Response("react denied", { status: 500 });
        }
        expect(body).toContain('"partIndex":2');
        expect(body).toContain("selected text");
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/api/v1/message/msg/with/slash/unsend?password=bb-password")) {
        expect(body).toContain('"partIndex":1');
        return new Response("", { status: 200 });
      }
      if (url.endsWith("/api/v1/chat/new?password=bb-password")) {
        return new Response("create denied", { status: 500 });
      }
      if (url === "https://files.example.com/missing.png") {
        return new Response("missing", { status: 404 });
      }
      throw new Error(`Unexpected BlueBubbles URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "127.0.0.1", "files.example.com");
    const blueBubblesConnection = {
      key: "imessage",
      config: { bridgeUrl: "127.0.0.1:1234", password: "bb-password" },
    };

    const byChatId = await executeTool(
      request("imessage.send", {
        connectionId: "imessage-chat-id",
        message: "chat id",
        target: "chat_id:42",
        replyToMessageGuid: "reply-guid",
        effectId: "impact",
      }),
      commsConfig,
      commsStorage({ connectionId: "imessage-chat-id", ...blueBubblesConnection }),
    );
    expect(byChatId).toMatchObject({ status: "sent", providerMessageId: "text-message" });

    const byIdentifier = await executeTool(
      request("imessage.send", {
        connectionId: "imessage-direct-identifier",
        message: "identifier",
        target: "chat_identifier:direct-identifier",
      }),
      commsConfig,
      commsStorage({ connectionId: "imessage-direct-identifier", ...blueBubblesConnection }),
    );
    expect(byIdentifier).toMatchObject({ status: "sent", providerMessageId: "text-message" });

    const byParticipant = await executeTool(
      request("imessage.send", {
        connectionId: "imessage-participant",
        message: "participant",
        target: "imessage:group@example.com",
      }),
      commsConfig,
      commsStorage({ connectionId: "imessage-participant", ...blueBubblesConnection }),
    );
    expect(byParticipant).toMatchObject({ status: "sent", providerMessageId: "text-message" });

    const multipart = await executeTool(
      request("imessage.send", {
        connectionId: "imessage-multipart",
        message: "multipart",
        target: "guid:chat-guid-42",
        subject: "Subject",
        replyTo: "reply-guid",
        partIndex: "2",
        effect: "impact",
        attachments: [{ title: "inline.txt", dataBase64: Buffer.from("inline").toString("base64") }],
      }),
      commsConfig,
      commsStorage({ connectionId: "imessage-multipart", ...blueBubblesConnection }),
    );
    expect(multipart).toMatchObject({ status: "sent", providerMessageId: "multipart-message" });

    const reacted = await executeTool(
      request("imessage.react", {
        connectionId: "imessage-react-success",
        target: "guid:chat-guid-42",
        messageGuid: "message-1",
        reaction: "love",
        partIndex: "2",
        selectedMessageText: "selected text",
      }),
      commsConfig,
      commsStorage({ connectionId: "imessage-react-success", ...blueBubblesConnection }),
    );
    expect(reacted).toMatchObject({ status: "sent", providerMessageId: "message-1" });

    const unsent = await executeTool(
      request("imessage.unsend", {
        connectionId: "imessage-unsend-success",
        messageGuid: "msg/with/slash",
        partIndex: "1",
      }),
      commsConfig,
      commsStorage({ connectionId: "imessage-unsend-success", ...blueBubblesConnection }),
    );
    expect(unsent).toMatchObject({ status: "sent", providerMessageId: "msg/with/slash" });

    await expectFailed(
      executeTool(
        request("imessage.send", {
          connectionId: "imessage-text-fail",
          message: "fail-text",
          target: "guid:chat-guid-42",
        }),
        commsConfig,
        commsStorage({ connectionId: "imessage-text-fail", ...blueBubblesConnection }),
      ),
      /text denied/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.react", {
          connectionId: "imessage-react-fail",
          target: "guid:chat-guid-42",
          messageId: "fail-react",
          reaction: "fail-react",
        }),
        commsConfig,
        commsStorage({ connectionId: "imessage-react-fail", ...blueBubblesConnection }),
      ),
      /react denied/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", {
          connectionId: "imessage-multipart-fail",
          message: "fail-multipart",
          target: "guid:chat-guid-42",
          attachments: [{ title: "inline.txt", dataBase64: Buffer.from("inline").toString("base64") }],
        }),
        commsConfig,
        commsStorage({ connectionId: "imessage-multipart-fail", ...blueBubblesConnection }),
      ),
      /multipart denied/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", {
          connectionId: "imessage-attachment-fetch-fail",
          message: "remote",
          target: "guid:chat-guid-42",
          attachments: [{ title: "missing.png", url: "https://files.example.com/missing.png" }],
        }),
        commsConfig,
        commsStorage({ connectionId: "imessage-attachment-fetch-fail", ...blueBubblesConnection }),
      ),
      /attachment fetch failed \(404\)/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", {
          connectionId: "imessage-create-fail",
          message: "create fail",
          target: "sms:+15550001111",
        }),
        commsConfig,
        commsStorage({ connectionId: "imessage-create-fail", ...blueBubblesConnection }),
      ),
      /create denied/i,
    );

    expect(queryBodies.some((body) => body.includes('"with":["participants"]'))).toBe(true);
  });

  it("covers Signal accepted responses, base URL normalization, and target variants", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      if (bodies.length === 1) {
        return new Response("", { status: 201 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 456 } }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "signal.example.com");

    const accepted = await executeTool(
      request("signal.send", {
        connectionId: "signal-accepted",
        target: "username:alice",
        message: "accepted",
      }),
      commsConfig,
      commsStorage({
        connectionId: "signal-accepted",
        key: "signal",
        config: { baseUrl: "signal.example.com", accountId: "+15550001111" },
      }),
    );
    expect(accepted).toMatchObject({ status: "sent" });
    expect(String(accepted.providerMessageId)).toMatch(/^signal-/);

    const usernameAlias = await executeTool(
      request("signal.send", {
        connectionId: "signal-username-alias",
        target: "u:bob",
        message: "timestamp",
      }),
      commsConfig,
      commsStorage({
        connectionId: "signal-username-alias",
        key: "signal",
        config: { bridgeUrl: "signal.example.com" },
      }),
    );
    expect(usernameAlias).toMatchObject({ status: "sent", providerMessageId: "456" });
    expect(bodies.some((body) => body.includes('"username":["alice"]'))).toBe(true);
    expect(bodies.some((body) => body.includes('"username":["bob"]'))).toBe(true);
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
      /Missing Gmail access token/i,
    );
    await expectFailed(
      executeTool(
        request("gmail.read", { connectionId: "gmail-read-fail" }),
        commsConfig,
        commsStorage({ connectionId: "gmail-read-fail", key: "gmail", config: { accessToken: "gmail-token" } }),
      ),
      /gmail\.read failed \(500\)/i,
    );
    await expectFailed(
      executeTool(
        request("gmail.send", { connectionId: "gmail-send-missing-token", to: ["ops@example.com"] }),
        commsConfig,
        commsStorage({ connectionId: "gmail-send-missing-token", key: "gmail", config: {} }),
      ),
      /Missing Gmail access token/i,
    );
    await expectFailed(
      executeTool(
        request("gmail.send", { connectionId: "gmail-send-missing-to", subject: "No recipient", bodyText: "Body" }),
        commsConfig,
        commsStorage({
          connectionId: "gmail-send-missing-to",
          key: "gmail",
          config: { accessToken: "gmail-token" },
        }),
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
        commsStorage({ connectionId: "gmail-send-fail", key: "gmail", config: { accessToken: "gmail-token" } }),
      ),
      /gmail\.send failed \(500\)/i,
    );

    await expectFailed(
      executeTool(
        request("calendar.list", { connectionId: "calendar-missing-token" }),
        commsConfig,
        commsStorage({ connectionId: "calendar-missing-token", key: "calendar", config: {} }),
      ),
      /Missing Calendar access token/i,
    );
    await expectFailed(
      executeTool(
        request("calendar.list", { connectionId: "calendar-list-fail" }),
        commsConfig,
        commsStorage({
          connectionId: "calendar-list-fail",
          key: "calendar",
          config: { accessToken: "calendar-token" },
        }),
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
      /Missing Calendar access token/i,
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
          config: { accessToken: "calendar-token" },
        }),
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

  it("covers additional BlueBubbles target and provider failure branches", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    let uploadMode: "missing-hash" | "http-error" = "missing-hash";
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      if (url.endsWith("/api/v1/chat/query?password=bb-password")) {
        if (body.includes('"offset":0')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 123, guid: "chat-guid-123" },
                { id: 777 },
                { guid: "chat123" },
                { guid: "iMessage;-;group-chat" },
                { identifier: "direct-only" },
                { guid: "iMessage;-;user@example.com" },
                { guid: "iMessage;-;imessage:prefixed@example.com" },
                { guid: "iMessage;-;sms:sms-prefixed@example.com" },
                { guid: "iMessage;-;auto:auto-prefixed@example.com" },
                {
                  guid: "iMessage;-;handle-group",
                  handles: ["string@example.com", null, { id: "object@example.com" }],
                },
                { guid: "iMessage;-;participant-handle-group", participantHandles: ["participant@example.com"] },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }
      if (url.endsWith("/api/v1/message/text?password=bb-password")) {
        return new Response(JSON.stringify({ id: 789 }), { status: 200 });
      }
      if (url.endsWith("/api/v1/chat/new?password=bb-password")) {
        return new Response("", { status: 200 });
      }
      if (url.includes("/api/v1/message/fail-unsend/unsend?password=bb-password")) {
        return new Response("unsend denied", { status: 500 });
      }
      if (url.endsWith("/api/v1/attachment/upload?password=bb-password")) {
        if (uploadMode === "http-error") {
          return new Response("upload denied", { status: 500 });
        }
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected BlueBubbles extra URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "127.0.0.1");
    const blueBubblesConnection = {
      key: "imessage",
      config: { bridgeUrl: "127.0.0.1:1234", password: "bb-password" },
    };

    for (const [connectionId, target] of [
      ["imessage-group-number", "group:123"],
      ["imessage-group-guid", "group:chat-guid-raw"],
      ["imessage-semicolon-guid", "iMessage;-;raw@example.com"],
      ["imessage-chat-identifier", "chat123"],
      ["imessage-guid-identifier", "chat_identifier:group-chat"],
      ["imessage-direct-identifier-extra", "chat_identifier:direct-only"],
      ["imessage-bluebubbles-prefix", "bluebubbles:auto:user@example.com"],
      ["imessage-service-chat-prefix", "auto:chat:123"],
      ["imessage-string-handles", "string@example.com"],
      ["imessage-object-handles", "object@example.com"],
      ["imessage-participant-handles", "participant@example.com"],
      ["imessage-prefixed-direct-handle", "prefixed@example.com"],
      ["imessage-sms-prefixed-direct-handle", "sms-prefixed@example.com"],
      ["imessage-auto-prefixed-direct-handle", "auto-prefixed@example.com"],
      ["imessage-default-handle", "person@example.com"],
    ] as const) {
      const result = await executeTool(
        request("imessage.send", { connectionId, message: "target", target }),
        commsConfig,
        commsStorage({ connectionId, ...blueBubblesConnection }),
      );
      expect(result).toMatchObject({ status: "sent" });
    }

    const createdUnknown = await executeTool(
      request("imessage.send", {
        connectionId: "imessage-create-empty",
        message: "create",
        target: "sms:+15550002222",
      }),
      commsConfig,
      commsStorage({ connectionId: "imessage-create-empty", ...blueBubblesConnection }),
    );
    expect(createdUnknown).toMatchObject({ status: "sent", providerMessageId: "unknown" });

    await expectFailed(
      executeTool(
        request("imessage.send", { connectionId: "imessage-missing-guid", message: "missing", target: "chat:777" }),
        commsConfig,
        commsStorage({ connectionId: "imessage-missing-guid", ...blueBubblesConnection }),
      ),
      /chatGuid not found/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", { connectionId: "imessage-missing-chat-id", message: "missing", target: "chat:999" }),
        commsConfig,
        commsStorage({ connectionId: "imessage-missing-chat-id", ...blueBubblesConnection }),
      ),
      /chatGuid not found/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", {
          connectionId: "imessage-empty-bluebubbles-prefix",
          message: "bad",
          target: "bluebubbles:",
        }),
        commsConfig,
        commsStorage({ connectionId: "imessage-empty-bluebubbles-prefix", ...blueBubblesConnection }),
      ),
      /iMessage handle is required/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", {
          connectionId: "imessage-invalid-chat-id",
          message: "bad",
          target: "chat_id:not-a-number",
        }),
        commsConfig,
        commsStorage({ connectionId: "imessage-invalid-chat-id", ...blueBubblesConnection }),
      ),
      /Invalid BlueBubbles chat_id target/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.unsend", { connectionId: "imessage-unsend-fail", messageId: "fail-unsend" }),
        commsConfig,
        commsStorage({ connectionId: "imessage-unsend-fail", ...blueBubblesConnection }),
      ),
      /unsend denied/i,
    );

    await expectFailed(
      executeTool(
        request("imessage.send", {
          connectionId: "imessage-upload-missing-hash",
          message: "hash",
          target: "guid:chat-guid-123",
          attachments: [{ title: "inline.txt", dataBase64: Buffer.from("inline").toString("base64") }],
        }),
        commsConfig,
        commsStorage({ connectionId: "imessage-upload-missing-hash", ...blueBubblesConnection }),
      ),
      /missing attachment hash/i,
    );

    uploadMode = "http-error";
    await expectFailed(
      executeTool(
        request("imessage.send", {
          connectionId: "imessage-upload-http-fail",
          message: "upload",
          target: "guid:chat-guid-123",
          attachments: [{ title: "inline.txt", dataBase64: Buffer.from("inline").toString("base64") }],
        }),
        commsConfig,
        commsStorage({ connectionId: "imessage-upload-http-fail", ...blueBubblesConnection }),
      ),
      /upload denied/i,
    );
  });

  it("covers remaining Telegram, WhatsApp, Zalo User, and Mattermost normalization branches", async () => {
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
      if (url.endsWith("/messages/video")) {
        return new Response(JSON.stringify({ data: { id: "zca-video-mime" } }), { status: 200 });
      }
      if (url.endsWith("/messages/voice")) {
        return new Response(JSON.stringify({ data: { id: "zca-audio-mime" } }), { status: 200 });
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
    const commsConfig = withAllowlist(
      config,
      "api.telegram.org",
      "graph.facebook.com",
      "zca.example.com",
      "mattermost.example.com",
    );

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

    const zcaVideoMime = await executeTool(
      request("zalouser.send", {
        connectionId: "zca-video-mime",
        message: "video",
        target: "group:team-1",
        attachments: [{ url: "https://example.com/media", mimeType: "video/mp4" }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "zca-video-mime",
        key: "zalouser",
        config: { baseUrl: "https://zca.example.com" },
      }),
    );
    expect(zcaVideoMime).toMatchObject({ status: "sent", providerMessageId: "zca-video-mime" });

    const zcaAudioMime = await executeTool(
      request("zalouser.send", {
        connectionId: "zca-audio-mime",
        message: "audio",
        target: "user:friend-1",
        attachments: [{ url: "https://example.com/media", mimeType: "audio/ogg" }],
      }),
      commsConfig,
      commsStorage({
        connectionId: "zca-audio-mime",
        key: "zalouser",
        config: { baseUrl: "https://zca.example.com" },
      }),
    );
    expect(zcaAudioMime).toMatchObject({ status: "sent", providerMessageId: "zca-audio-mime" });

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

  it("covers BlueBubbles query provider errors", async () => {
    mocked.isBrowserToolName.mockReturnValue(false);
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/chat/query?password=bb-password")) {
        return new Response("query denied", { status: 500 });
      }
      throw new Error(`Unexpected BlueBubbles query error URL: ${url}`);
    }) as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "127.0.0.1");

    await expectFailed(
      executeTool(
        request("imessage.send", { connectionId: "imessage-query-error", message: "query", target: "chat:123" }),
        commsConfig,
        commsStorage({
          connectionId: "imessage-query-error",
          key: "imessage",
          config: { bridgeUrl: "127.0.0.1:1234", password: "bb-password" },
        }),
      ),
      /chatGuid not found/i,
    );
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
    expect(slackResult).toMatchObject({ status: "failed", deliveryStatus: "manual_reconciliation_required" });
    expect(String(slackResult.error ?? "")).toContain("partial_channel_delivery_sent");
    expect(slackStorage.commsDeliveries.markFailed).toHaveBeenCalledWith(
      "delivery-slack-partial",
      expect.stringContaining("partial_channel_delivery_sent"),
      expect.any(String),
      "manual_reconciliation_required",
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
    expect(telegramResult).toMatchObject({ status: "failed", deliveryStatus: "manual_reconciliation_required" });
    expect(String(telegramResult.error ?? "")).toContain("message 1001 was sent before attachment 1 failed");
    expect(telegramStorage.commsDeliveries.markFailed).toHaveBeenCalledWith(
      "delivery-telegram-partial",
      expect.stringContaining("partial_channel_delivery_sent"),
      expect.any(String),
      "manual_reconciliation_required",
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
    expect(whatsappResult).toMatchObject({ status: "failed", deliveryStatus: "manual_reconciliation_required" });
    expect(String(whatsappResult.error ?? "")).toContain("message wamid.text-1 was sent before attachment 1 failed");
    expect(whatsappStorage.commsDeliveries.markFailed).toHaveBeenCalledWith(
      "delivery-whatsapp-partial",
      expect.stringContaining("partial_channel_delivery_sent"),
      expect.any(String),
      "manual_reconciliation_required",
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
        config: { accessToken: "gmail-token" },
      }),
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
        config: { accessToken: "calendar-token" },
      }),
    );
    expect(calendarFallback).toMatchObject({ status: "sent" });
    expect(String(calendarFallback.providerMessageId)).toMatch(/^calendar-/);
  });
});

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

function commsStorage(connection: { connectionId: string; key: string; config: Record<string, unknown> }): Storage {
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
  } as unknown as Storage;
}

async function expectFailed(resultPromise: Promise<Record<string, unknown>>, errorPattern: RegExp): Promise<void> {
  const result = await resultPromise;
  expect(result).toMatchObject({ status: "failed" });
  expect(String(result.error ?? "")).toMatch(errorPattern);
}

function signalSendWithResponse(config: ToolPolicyConfig, response: Response): Promise<Record<string, unknown>> {
  globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch;
  return executeTool(
    request("signal.send", {
      connectionId: "signal",
      target: "signal:+15551234567",
      message: "Signal failure coverage.",
    }),
    config,
    commsStorage({
      connectionId: "signal",
      key: "signal",
      config: { baseUrl: "https://signal.example.com", account: "+15550001111" },
    }),
  );
}
