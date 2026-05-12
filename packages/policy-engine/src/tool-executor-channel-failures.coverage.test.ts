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
      if (url.startsWith("https://bot-api.zaloplatforms.com/")) {
        return new Response(JSON.stringify({ ok: false, description: "zalo denied" }), { status: 200 });
      }
      throw new Error(`Unexpected Nextcloud/Zalo URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const commsConfig = withAllowlist(config, "cloud.example.com", "bot-api.zaloplatforms.com");

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
