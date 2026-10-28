import { describe, expect, it } from "vitest";
import { RETIRED_CHANNEL_REASONS } from "@goatcitadel/contracts";
import {
  describeChannelCapabilities,
  isMatrixInboundEnabled,
  listChannelRuleKeys,
  planChannelRichMessageDelivery,
  planChannelTextDelivery,
  readTelegramReceiveMode,
} from "./channel-core.js";

describe("describeChannelCapabilities", () => {
  it("advertises gateway-only Discord runtime semantics when gateway mode is configured", () => {
    const capabilities = describeChannelCapabilities("discord", {
      runtimeMode: "gateway",
      botTokenEnv: "DISCORD_BOT_TOKEN",
      defaultChannelId: "1234567890",
      inboundDmPolicy: "pairing",
      guildPolicy: "allowlist",
    });

    expect(capabilities.supportedActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"]),
    );
    expect(capabilities.inboundModes).toEqual(["gateway"]);
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundTransport: "gateway",
      lifecycle: "persistent",
      inboundReadiness: "ready",
    });
    expect(capabilities.runtimePolicy).toMatchObject({
      pairing: true,
      allowlist: true,
      mentionGating: true,
      typing: true,
      presence: true,
    });
    expect(capabilities.supportedActions).not.toContain("channel.presence");
    expect(capabilities.setupReady).toBe(true);
  });

  it("supports permissive Discord gateway policy variants", () => {
    const capabilities = describeChannelCapabilities("discord", {
      runtimeMode: "gateway",
      botToken: "token",
      inboundDmPolicy: "closed",
      guildPolicy: "open",
    });

    expect(capabilities.runtimePolicy).toMatchObject({
      pairing: false,
      allowlist: false,
      mentionGating: false,
      typing: true,
      presence: true,
    });
  });

  it("defaults Discord gateway policy to paired DMs and allowlisted guilds", () => {
    const capabilities = describeChannelCapabilities("discord", {
      runtimeMode: "gateway",
      botToken: "token",
    });

    expect(capabilities.runtimePolicy).toMatchObject({
      pairing: true,
      allowlist: true,
      mentionGating: true,
      typing: true,
      presence: true,
    });
  });

  it("keeps webhook-only Discord connections outbound-only", () => {
    const capabilities = describeChannelCapabilities("discord", {
      webhookUrl: "https://discord.com/api/webhooks/123/test",
    });

    expect(capabilities.supportedActions).toEqual(["channel.send", "channel.unsend", "channel.activity"]);
    expect(capabilities.inboundModes).toEqual(["none"]);
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
    });
    expect(capabilities.runtimePolicy.typing).toBe(false);
    expect(capabilities.runtimePolicy.activity).toBe(true);
    expect(capabilities.runtimePolicy.presence).toBe(false);
    expect(capabilities.activityCapabilities.nativeEffects).toEqual(["mission_control"]);
  });

  it("reports missing setup requirements for incomplete server configs", () => {
    const capabilities = describeChannelCapabilities("nextcloud-talk", {
      defaultRoomId: "room-1",
    });

    expect(capabilities.setupReady).toBe(false);
    expect(capabilities.setupDiagnostics).toEqual(
      expect.arrayContaining([
        "Missing one of: config.baseUrl.",
        "Missing one of: config.tokenEnv, config.token, config.botSecretEnv, config.botSecret, config.secretEnv, config.secret.",
      ]),
    );
  });

  it("adds explicit reply support for channels that already support threaded replies", () => {
    const capabilities = describeChannelCapabilities("slack", {
      botTokenEnv: "SLACK_BOT_TOKEN",
      signingSecretEnv: "SLACK_SIGNING_SECRET",
      defaultChannel: "#ops",
    });

    expect(capabilities.supportedActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.react", "channel.unsend"]),
    );
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "ready",
    });
    expect(capabilities.inboundModes).toEqual(["webhook"]);
    expect(capabilities.threadCapabilities).toMatchObject({
      rooms: true,
      threads: true,
      replies: true,
    });
  });

  it("advertises Telegram webhook ingress when a webhook secret is configured", () => {
    const capabilities = describeChannelCapabilities("telegram", {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      defaultChatId: "-1001234567890",
      webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
    });

    expect(capabilities.supportedActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"]),
    );
    expect(capabilities.inboundModes).toEqual(["webhook"]);
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "ready",
    });
    expect(capabilities.runtimePolicy.typing).toBe(true);
    expect(capabilities.supportNotes).toEqual(
      expect.arrayContaining([
        "Telegram bot connections can add reactions, delete sent messages, and emit typing indicators when the bot has access to the target chat.",
        "Telegram inbound webhook routing is enabled through the Bot API secret-token webhook path.",
      ]),
    );
  });

  it("advertises Telegram polling when the receive mode is poll", () => {
    const capabilities = describeChannelCapabilities("telegram", {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      defaultChatId: "-1001234567890",
      receiveMode: "poll",
    });

    expect(capabilities.inboundModes).toEqual(["poll"]);
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundTransport: "poll",
      lifecycle: "persistent",
      inboundReadiness: "ready",
    });
    expect(capabilities.runtimePosture.operatorSummary).toContain("asking Telegram for new messages");
    expect(capabilities.supportNotes.join(" ")).toContain("asking Telegram for new messages");
    expect(capabilities.supportNotes).not.toContain(
      "Telegram inbound routing remains disabled until a webhook secret is configured.",
    );
  });

  it("lets Telegram polling win over a leftover webhook secret", () => {
    const capabilities = describeChannelCapabilities("telegram", {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
      receiveMode: "poll",
    });

    expect(capabilities.inboundModes).toEqual(["poll"]);
    expect(capabilities.runtimePosture.inboundTransport).toBe("poll");
  });

  it("turns Telegram inbound off when the receive mode is off, even with a webhook secret", () => {
    const capabilities = describeChannelCapabilities("telegram", {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
      receiveMode: "off",
    });

    expect(capabilities.inboundModes).toEqual(["none"]);
    expect(capabilities.runtimePosture.inboundTransport).toBeUndefined();
    expect(capabilities.runtimePosture.inboundReadiness).toBe("unsupported");
    expect(capabilities.supportNotes).not.toContain(
      "Telegram inbound webhook routing is enabled through the Bot API secret-token webhook path.",
    );
  });

  it("reads only poll and off as an explicit Telegram receive mode", () => {
    expect(readTelegramReceiveMode({ receiveMode: "poll" })).toBe("poll");
    expect(readTelegramReceiveMode({ receiveMode: " off " })).toBe("off");
    expect(readTelegramReceiveMode({ receiveMode: "webhook" })).toBeUndefined();
    expect(readTelegramReceiveMode({ receiveMode: "carrier-pigeon" })).toBeUndefined();
    expect(readTelegramReceiveMode({ receiveMode: 7 })).toBeUndefined();
    expect(readTelegramReceiveMode({})).toBeUndefined();
  });

  it("keeps the secret-based Telegram behavior for webhook and missing receive modes", () => {
    const webhook = describeChannelCapabilities("telegram", {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
      receiveMode: "webhook",
    });
    expect(webhook.inboundModes).toEqual(["webhook"]);

    const webhookWithoutSecret = describeChannelCapabilities("telegram", {
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      receiveMode: "webhook",
    });
    expect(webhookWithoutSecret.inboundModes).toEqual(["none"]);
  });

  it("advertises WhatsApp webhook ingress when the verification secret pair is configured", () => {
    const capabilities = describeChannelCapabilities("whatsapp", {
      accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
      phoneNumberId: "123456789012345",
      defaultTarget: "+15551234567",
      appSecretEnv: "WHATSAPP_APP_SECRET",
      webhookVerifyTokenEnv: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    });

    expect(capabilities.inboundModes).toEqual(["webhook"]);
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "ready",
    });
    expect(capabilities.supportNotes).toEqual(
      expect.arrayContaining([
        "WhatsApp inbound routing is enabled through the signed Cloud API webhook path when both the app secret and webhook verify token are configured.",
      ]),
    );
  });

  it("advertises LINE webhook ingress when the channel secret is configured", () => {
    const capabilities = describeChannelCapabilities("line", {
      channelAccessTokenEnv: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecretEnv: "LINE_CHANNEL_SECRET",
      defaultTarget: "U1234567890",
    });

    expect(capabilities.inboundModes).toEqual(["webhook"]);
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "ready",
    });
    expect(capabilities.supportNotes).toEqual(
      expect.arrayContaining([
        "LINE inbound routing is enabled through the signed Messaging API webhook path when a channel secret is configured.",
      ]),
    );
  });

  it("covers outbound-only and partial-runtime channel capability variants", () => {
    const slackWebhook = describeChannelCapabilities("slack", { webhookUrl: "https://hooks.slack.test/1" });
    expect(slackWebhook.supportedActions).toEqual(["channel.send", "channel.activity"]);
    expect(slackWebhook.supportedAttachmentSources).toEqual(["url"]);
    expect(slackWebhook.runtimePosture).toMatchObject({
      outboundTransport: "webhook",
      inboundReadiness: "unsupported",
    });

    const slackWebhookWithIngress = describeChannelCapabilities("slack", {
      webhookUrl: "https://hooks.slack.test/1",
      signingSecret: "secret",
    });
    expect(slackWebhookWithIngress.inboundModes).toEqual(["webhook"]);
    expect(slackWebhookWithIngress.runtimePosture.inboundTransport).toBe("webhook");

    const slackBotNoIngress = describeChannelCapabilities("slack", { botToken: "token" });
    expect(slackBotNoIngress.runtimePosture.operatorSummary).toContain("inbound routing is still disabled");
    expect(slackBotNoIngress.supportNotes).toEqual(
      expect.arrayContaining(["Slack inbound routing remains disabled until a signing secret is configured."]),
    );

    const discordBridge = describeChannelCapabilities("discord", { botToken: "token" });
    expect(discordBridge.supportedActions).toEqual(expect.arrayContaining(["channel.react", "channel.unsend"]));
    expect(discordBridge.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundReadiness: "unsupported",
    });

    const discordUnconfigured = describeChannelCapabilities("discord", {});
    expect(discordUnconfigured.supportedActions).toEqual(["channel.send", "channel.activity"]);
    expect(discordUnconfigured.supportNotes).toEqual([]);

    const telegramOutbound = describeChannelCapabilities("telegram", { token: "token" });
    expect(telegramOutbound.inboundModes).toEqual(["none"]);
    expect(telegramOutbound.runtimePosture.inboundTransport).toBeUndefined();
    expect(telegramOutbound.supportNotes).toEqual(
      expect.arrayContaining(["Telegram inbound routing remains disabled until a webhook secret is configured."]),
    );

    const whatsappOutbound = describeChannelCapabilities("whatsapp", {
      accessToken: "token",
      phoneNumberId: "phone",
    });
    expect(whatsappOutbound.inboundModes).toEqual(["none"]);
    expect(whatsappOutbound.runtimePosture.inboundReadiness).toBe("unsupported");
    expect(whatsappOutbound.supportNotes).toEqual(
      expect.arrayContaining([
        "WhatsApp inbound routing remains disabled until both the app secret and webhook verify token are configured.",
      ]),
    );

    const lineOutbound = describeChannelCapabilities("line", { accessToken: "token" });
    expect(lineOutbound.inboundModes).toEqual(["none"]);
    expect(lineOutbound.supportNotes).toEqual([
      "LINE inbound routing remains disabled until a channel secret is configured.",
    ]);

    const ntfyOutbound = describeChannelCapabilities("ntfy", {
      baseUrl: "https://ntfy.example.com",
      topic: "goatcitadel-ops",
      tokenEnv: "NTFY_TOKEN",
    });
    expect(ntfyOutbound.supportedActions).toEqual(["channel.send", "channel.unsend", "channel.activity"]);
    expect(ntfyOutbound.inboundModes).toEqual(["none"]);
    expect(ntfyOutbound.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundReadiness: "unsupported",
    });
    expect(ntfyOutbound.runtimePosture.operatorSummary).toContain("outbound-only");
    expect(ntfyOutbound.supportNotes).toEqual(
      expect.arrayContaining(["Dry-run mode validates routing without publishing to the ntfy server."]),
    );
  });

  it("enables ntfy stream inbound only for an opted-in topic with a token", () => {
    const enabled = describeChannelCapabilities("ntfy", {
      baseUrl: "https://ntfy.example.com",
      topic: "goatcitadel-ops",
      tokenEnv: "NTFY_TOKEN",
      inboundStreamEnabled: true,
    });
    expect(enabled.inboundModes).toEqual(["stream"]);
    expect(enabled.runtimePosture).toMatchObject({
      lifecycle: "persistent",
      inboundTransport: "stream",
      inboundReadiness: "ready",
    });
    expect(enabled.setupReady).toBe(true);
    expect(enabled.runtimePosture.operatorSummary).toContain("JSON stream");
    // The token only gates reading: the copy must name the publish side and the restart gap.
    expect(enabled.runtimePosture.operatorSummary).toContain("anyone able to publish to the subscribed topic");
    expect(enabled.runtimePosture.operatorSummary).not.toContain("token-protected topic");
    expect(enabled.supportNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("write access (ACL) is limited to trusted publishers"),
        expect.stringContaining("no history is fetched after a gateway restart"),
      ]),
    );

    const subscribeOnly = describeChannelCapabilities("ntfy", {
      baseUrl: "https://ntfy.example.com",
      subscribeTopic: "inbox",
      token: "keychain:goatcitadel:channel-x",
      inboundStreamEnabled: "true",
    });
    expect(subscribeOnly.inboundModes).toEqual(["stream"]);

    const noToken = describeChannelCapabilities("ntfy", {
      baseUrl: "https://ntfy.example.com",
      topic: "goatcitadel-ops",
      inboundStreamEnabled: true,
    });
    expect(noToken.inboundModes).toEqual(["none"]);
    expect(noToken.runtimePosture.lifecycle).toBe("stateless");
    expect(noToken.setupDiagnostics).toContain("ntfy inbound requires a token to read the topic (tokenEnv)");
    expect(noToken.setupReady).toBe(false);

    const notOptedIn = describeChannelCapabilities("ntfy", {
      baseUrl: "https://ntfy.example.com",
      topic: "goatcitadel-ops",
      tokenEnv: "NTFY_TOKEN",
    });
    expect(notOptedIn.inboundModes).toEqual(["none"]);
    expect(notOptedIn.setupDiagnostics).toEqual([]);
  });

  it("enables Mattermost stream inbound only for an opted-in, token-backed server", () => {
    const outbound = describeChannelCapabilities("mattermost", {
      serverUrl: "https://chat.example.test",
      botTokenEnv: "MATTERMOST_TOKEN",
    });
    expect(outbound.inboundModes).toEqual(["none"]);
    expect(outbound.runtimePosture).toMatchObject({ lifecycle: "stateless", inboundReadiness: "unsupported" });
    expect(outbound.runtimePosture.operatorSummary).not.toContain("not yet wired");

    const enabled = describeChannelCapabilities("mattermost", {
      serverUrl: "https://chat.example.test",
      botTokenEnv: "MATTERMOST_TOKEN",
      inboundStreamEnabled: true,
    });
    expect(enabled.inboundModes).toEqual(["stream"]);
    expect(enabled.runtimePosture).toMatchObject({
      lifecycle: "persistent",
      inboundTransport: "stream",
      inboundReadiness: "ready",
    });
    expect(enabled.runtimePosture.operatorSummary).toContain("WebSocket");
    expect(enabled.supportNotes).toEqual(
      expect.arrayContaining([expect.stringContaining("pings the WebSocket every 30 seconds")]),
    );
    expect(enabled.supportedActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.react", "channel.unsend"]),
    );
    expect(enabled.supportNotes.join(" ")).not.toContain("not yet wired");

    const viaString = describeChannelCapabilities("mattermost", {
      serverUrl: "https://chat.example.test",
      botToken: "keychain:goatcitadel:channel-x",
      inboundStreamEnabled: "true",
    });
    expect(viaString.inboundModes).toEqual(["stream"]);

    const noToken = describeChannelCapabilities("mattermost", {
      serverUrl: "https://chat.example.test",
      inboundStreamEnabled: true,
    });
    expect(noToken.inboundModes).toEqual(["none"]);
  });

  it("describes Matrix as text-only outbound with opt-in /sync inbound", () => {
    const outbound = describeChannelCapabilities("matrix", {
      homeserverUrl: "https://matrix.example.test",
      accessTokenEnv: "MATRIX_TOKEN",
    });
    expect(outbound.setupReady).toBe(true);
    expect(outbound.inboundModes).toEqual(["none"]);
    expect(outbound.supportedActions).toEqual(
      expect.arrayContaining(["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"]),
    );
    expect(outbound.supportedAttachmentSources).toEqual([]);
    expect(outbound.chunkingMode).toBe("fallback");
    expect(outbound.runtimePosture).toMatchObject({ lifecycle: "stateless", outboundTransport: "api" });
    expect(outbound.supportNotes.join(" ")).toMatch(/text-only/i);

    const enabled = describeChannelCapabilities("matrix", {
      homeserverUrl: "https://matrix.example.test",
      accessToken: "keychain:goatcitadel:channel-x",
      inboundStreamEnabled: true,
    });
    expect(enabled.inboundModes).toEqual(["stream"]);
    expect(enabled.runtimePosture).toMatchObject({
      lifecycle: "persistent",
      inboundTransport: "stream",
      inboundReadiness: "ready",
    });
    expect(enabled.runtimePosture.operatorSummary).toBe(
      "Matrix uses the client-server API with an access token; optional inbound long-polls /sync and resumes from a stored sync token after restarts.",
    );

    const base = { homeserverUrl: "https://m.test", accessTokenEnv: "T" };
    expect(isMatrixInboundEnabled({ ...base, inboundStreamEnabled: true })).toBe(true);
    expect(isMatrixInboundEnabled({ ...base, inboundStreamEnabled: "true" })).toBe(false);
    expect(isMatrixInboundEnabled({ homeserverUrl: "https://m.test", inboundStreamEnabled: true })).toBe(false);
    expect(describeChannelCapabilities("matrix", { homeserverUrl: "https://m.test" }).setupReady).toBe(false);
  });

  it("describes QQBot as text-only with a signed webhook inbound and no typing", () => {
    const outboundOnly = describeChannelCapabilities("qqbot", { appId: "1024", defaultTarget: "group:G1" });
    expect(outboundOnly.setupReady).toBe(false);
    expect(outboundOnly.inboundModes).toEqual(["none"]);

    const configured = describeChannelCapabilities("qqbot", { appId: "1024", appSecretEnv: "QQBOT_APP_SECRET" });
    expect(configured.setupReady).toBe(true);
    expect(configured.inboundModes).toEqual(["webhook"]);
    expect(configured.supportedActions).toEqual(expect.arrayContaining(["channel.send", "channel.reply"]));
    expect(configured.supportedActions).not.toContain("channel.typing");
    expect(configured.supportedActions).not.toContain("channel.react");
    expect(configured.supportedActions).not.toContain("channel.unsend");
    expect(configured.supportedAttachmentSources).toEqual([]);
    expect(configured.platformUnsupportedActions?.["channel.typing"]).toBe(
      "QQBot has no typing indicator API for bot messages.",
    );
    expect(configured.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "ready",
    });
    expect(configured.runtimePolicy.allowlist).toBe(true);
    const notes = configured.supportNotes.join(" ");
    expect(notes).toMatch(/default-deny/);
    expect(notes).toMatch(/passive repl/i);
    expect(notes).toMatch(/quota/i);
    expect(notes).not.toMatch(/anyone can/i);
  });

  it("describes WeCom as text-only application messages with an encrypted callback inbound", () => {
    const sendOnly = describeChannelCapabilities("wecom", {
      corpId: "ww1",
      agentId: "1000002",
      secretEnv: "WECOM_SECRET",
    });
    expect(sendOnly.setupReady).toBe(true);
    expect(sendOnly.inboundModes).toEqual(["none"]);
    expect(sendOnly.runtimePosture).toMatchObject({ inboundReadiness: "unsupported", outboundTransport: "api" });
    expect(sendOnly.supportNotes.join(" ")).toMatch(/callback/i);

    const callback = describeChannelCapabilities("wecom", {
      corpId: "ww1",
      agentId: "1000002",
      secretEnv: "WECOM_SECRET",
      callbackTokenEnv: "WECOM_CALLBACK_TOKEN",
      encodingAesKeyEnv: "WECOM_ENCODING_AES_KEY",
    });
    expect(callback.inboundModes).toEqual(["webhook"]);
    expect(callback.supportedActions).toContain("channel.send");
    expect(callback.supportedActions).not.toContain("channel.typing");
    expect(callback.platformUnsupportedActions?.["channel.typing"]).toBe(
      "WeCom has no typing indicator API for app messages.",
    );
    expect(callback.runtimePosture).toMatchObject({ inboundTransport: "webhook", inboundReadiness: "ready" });
    expect(callback.runtimePolicy.allowlist).toBe(true);
    expect(callback.supportNotes.join(" ")).toMatch(/default-deny/);
    expect(callback.supportedAttachmentSources).toEqual([]);

    const missingKey = describeChannelCapabilities("wecom", {
      corpId: "ww1",
      agentId: "1",
      secretEnv: "S",
      callbackTokenEnv: "T",
    });
    expect(missingKey.inboundModes).toEqual(["none"]);
  });

  it("keeps Google Chat webhook mode outbound-only and points inbound at Chat app mode", () => {
    const webhook = describeChannelCapabilities("google-chat", {
      webhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t",
    });
    expect(webhook.setupReady).toBe(true);
    expect(webhook.inboundModes).toEqual(["none"]);
    expect(webhook.supportedActions).not.toContain("channel.unsend");
    expect(webhook.runtimePosture).toMatchObject({ outboundTransport: "webhook", inboundReadiness: "unsupported" });
    expect(webhook.runtimePosture.operatorSummary).not.toContain("inbound routing is not available");
    expect(webhook.runtimePosture.operatorSummary).toContain("inbound requires Chat app (service-account) mode");
    expect(webhook.supportNotes.join(" ")).not.toContain("does not provide inbound routing");
  });

  it("advertises Google Chat app inbound, replies and unsend in service-account mode with an audience", () => {
    const app = describeChannelCapabilities("google-chat", {
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audienceType: "project_number",
      audience: "123456789012",
    });
    expect(app.setupReady).toBe(true);
    expect(app.inboundModes).toEqual(["webhook"]);
    expect(app.supportedActions).toEqual(expect.arrayContaining(["channel.send", "channel.reply", "channel.unsend"]));
    expect(app.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "ready",
    });
    expect(app.runtimePosture.operatorSummary).toMatch(/only the app's own messages/i);
    expect(app.runtimePolicy.allowlist).toBe(true);

    const noAudience = describeChannelCapabilities("google-chat", { serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY" });
    expect(noAudience.setupReady).toBe(true);
    expect(noAudience.inboundModes).toEqual(["none"]);
    expect(noAudience.runtimePosture.outboundTransport).toBe("api");
    expect(noAudience.supportNotes.join(" ")).toContain("audience");

    const badAudienceType = describeChannelCapabilities("google-chat", {
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audienceType: "something_else",
      audience: "123456789012",
    });
    expect(badAudienceType.inboundModes).toEqual(["none"]);

    expect(describeChannelCapabilities("google-chat", {}).setupDiagnostics).toEqual([
      "Missing one of: config.webhookUrl, config.url, config.serviceAccountKeyEnv, config.serviceAccountKey.",
    ]);
  });

  it("reports a saved Zalo Personal connection as retired, with every action and readiness flag off", () => {
    const capabilities = describeChannelCapabilities("zalouser", {
      baseUrl: "https://zca.example.test",
      authToken: "configured",
    });
    expect(capabilities.supportedActions).toEqual([]);
    expect(capabilities.supportedDeliveryActions).toEqual([]);
    expect(capabilities.supportedAttachmentSources).toEqual([]);
    expect(capabilities.inboundModes).toEqual(["none"]);
    expect(capabilities.activityCapabilities.supported).toBe(false);
    expect(capabilities.setupReady).toBe(false);
    expect(capabilities.setupDiagnostics).toEqual([expect.stringMatching(/^Zalo Personal is not supported anymore/)]);
    expect(capabilities.runtimePosture.operatorSummary).toMatch(/unofficial personal-account client/);
    expect(listChannelRuleKeys()).not.toContain("zalouser");
  });

  it.each([
    ["signal", "Signal", { baseUrl: "http://127.0.0.1:8080", receiveEvents: true, defaultRecipient: "+15551234567" }],
    ["imessage", "iMessage", { bridgeUrl: "http://127.0.0.1:1234", passwordEnv: "BB_PASSWORD" }],
  ] as const)(
    "reports a saved %s connection as retired, with every action, inbound mode and readiness flag off",
    (channelKey, label, config) => {
      expect(RETIRED_CHANNEL_REASONS.has(channelKey)).toBe(true);
      const capabilities = describeChannelCapabilities(channelKey, config);
      expect(capabilities.supportedActions).toEqual([]);
      expect(capabilities.supportedDeliveryActions).toEqual([]);
      expect(capabilities.supportedAttachmentSources).toEqual([]);
      expect(capabilities.inboundModes).toEqual(["none"]);
      expect(capabilities.runtimePosture.inboundReadiness).toBe("unsupported");
      expect(capabilities.activityCapabilities.supported).toBe(false);
      expect(capabilities.setupReady).toBe(false);
      expect(capabilities.setupDiagnostics).toEqual([
        expect.stringMatching(new RegExp(`^${label} is not supported anymore`)),
      ]);
      expect(capabilities.runtimePosture.operatorSummary).toMatch(/unofficial .* can get the account banned/);
      expect(listChannelRuleKeys()).not.toContain(channelKey);
    },
  );

  it("describes static channel rules and setup diagnostics", () => {
    const staticChannels = [
      ["google-chat", { webhookUrl: "https://chat.test" }],
      ["teams", { url: "https://teams.test" }],
      ["mattermost", { serverUrl: "https://mattermost.test", botTokenEnv: "MATTERMOST_TOKEN" }],
      ["nextcloud-talk", { baseUrl: "https://cloud.test", token: "token" }],
      ["ntfy", { baseUrl: "https://ntfy.test", topic: "ops" }],
      ["zalo", { token: "token" }],
    ] as const;

    for (const [channelKey, config] of staticChannels) {
      const capabilities = describeChannelCapabilities(channelKey, config);
      expect(capabilities.channelKey).toBe(channelKey);
      expect(capabilities.setupReady).toBe(true);
      expect(capabilities.chunkingMode).toBe("fallback");
      expect(capabilities.supportedDeliveryActions).toEqual(capabilities.supportedActions);
      expect(capabilities.runtimePosture.operatorSummary.length).toBeGreaterThan(0);
    }

    const whatsappMissing = describeChannelCapabilities("whatsapp", {});
    expect(whatsappMissing.setupDiagnostics).toEqual([
      "Missing one of: config.phoneNumberId.",
      "Missing one of: config.accessTokenEnv, config.accessToken, config.tokenEnv, config.token.",
    ]);
  });

  it("falls back to default channel capabilities for unknown adapters", () => {
    const capabilities = describeChannelCapabilities("custom-channel", {});

    expect(capabilities.supportedActions).toEqual(["channel.send", "channel.activity"]);
    expect(capabilities.activityCapabilities).toMatchObject({
      supported: true,
      clearOnTerminal: true,
    });
    expect(capabilities.inboundModes).toEqual(["none"]);
    expect(capabilities.threadCapabilities).toMatchObject({
      rooms: false,
      threads: false,
      replies: false,
      direct: false,
      groups: false,
    });
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "api",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
    });
    expect(capabilities.setupReady).toBe(true);
  });

  it("treats whitespace-only config values as missing setup fields", () => {
    const capabilities = describeChannelCapabilities("teams", {
      webhookUrl: "   ",
      url: "\t",
    });

    expect(capabilities.setupReady).toBe(false);
    expect(capabilities.setupDiagnostics).toEqual(["Missing one of: config.webhookUrl, config.url."]);
  });

  it("plans channel text chunks without splitting surrogate pairs or overclaiming rich formatting", () => {
    const text = `${"a".repeat(4095)}😀${"b".repeat(4)}`;
    const telegram = planChannelTextDelivery("telegram", text, { richFormat: "html" });

    expect(telegram.chunkingMode).toBe("fallback");
    expect(telegram.chunks).toHaveLength(2);
    expect(telegram.chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(endsWithDanglingHighSurrogate(telegram.chunks[0] ?? "")).toBe(false);
    expect(startsWithDanglingLowSurrogate(telegram.chunks[1] ?? "")).toBe(false);
    expect(telegram.richFormatPosture).toBe("plain_text_fallback");
    expect(telegram.notes).toEqual(
      expect.arrayContaining([
        "Rich formatting must be flattened before chunking unless the channel adapter proves native rich chunk support.",
      ]),
    );

    const discord = planChannelTextDelivery("discord", "x".repeat(2001));
    expect(discord.chunks.map((chunk) => chunk.length)).toEqual([2000, 1]);
    expect(discord.richFormatPosture).toBe("preserved");
  });

  it("plans Telegram rich messages with caption limits and document fallback evidence", () => {
    const plan = planChannelRichMessageDelivery("telegram", {
      text: `${"a".repeat(1024)} plus body`,
      richFormat: "html",
      attachments: [
        { url: "https://example.com/photo.png", mimeType: "image/png", title: "photo.png" },
        { dataBase64: Buffer.from("report").toString("base64"), mimeType: "application/pdf", title: "report.pdf" },
      ],
    });

    expect(plan).toMatchObject({
      channelKey: "telegram",
      provider: "telegram_bot_api",
      capabilityLabel: "Telegram Bot API rich media",
      status: "degraded",
      textPosture: "separate_text_then_media",
      attachmentCount: 2,
      nativeAttachmentCount: 1,
      fallbackAttachmentCount: 1,
      blockedAttachmentCount: 0,
      evidence: {
        owner: "gateway",
        source: "channel_rich_message_plan",
        status: "degraded",
        provider: "telegram_bot_api",
      },
      attachments: [
        {
          index: 0,
          source: "url",
          mediaKind: "image",
          providerKind: "photo",
          disposition: "native_media",
        },
        {
          index: 1,
          source: "inline",
          mediaKind: "document",
          providerKind: "document",
          disposition: "document_fallback",
        },
      ],
    });
    expect(plan?.evidence.evidenceId).toMatch(/^richmsg-[a-f0-9]{8}$/);
    expect(plan?.notes.join(" ")).toContain("caption limit");
  });

  it("plans Telegram rich messages with native video and audio attachments", () => {
    const plan = planChannelRichMessageDelivery("telegram", {
      text: "Checkout the recording",
      attachments: [
        { url: "https://example.com/recording.mp4", mimeType: "video/mp4", title: "recording.mp4" },
        { url: "https://example.com/audio.mp3", mimeType: "audio/mp3", title: "audio.mp3" },
      ],
    });

    expect(plan).toMatchObject({
      channelKey: "telegram",
      provider: "telegram_bot_api",
      status: "preserved",
      attachmentCount: 2,
      nativeAttachmentCount: 2,
      fallbackAttachmentCount: 0,
      attachments: [
        {
          index: 0,
          source: "url",
          mediaKind: "video",
          providerKind: "video",
          disposition: "native_media",
        },
        {
          index: 1,
          source: "url",
          mediaKind: "audio",
          providerKind: "audio",
          disposition: "native_media",
        },
      ],
    });
  });

  it("blocks unsafe Telegram rich attachment shapes before provider send", () => {
    const metadataOnly = planChannelRichMessageDelivery("telegram", {
      text: "see attachment",
      attachments: [{ title: "missing-url.pdf", mimeType: "application/pdf" }],
    });

    expect(metadataOnly).toMatchObject({
      status: "blocked",
      blockedAttachmentCount: 1,
      attachments: [
        {
          source: "metadata_only",
          disposition: "blocked",
          reason: "Telegram rich attachments require a URL, inline data, or an attachmentId to hydrate.",
        },
      ],
    });

    const tooMany = planChannelRichMessageDelivery("telegram", {
      attachments: Array.from({ length: 11 }, (_, index) => ({
        url: `https://example.com/${index}.png`,
        mimeType: "image/png",
      })),
    });
    expect(tooMany).toMatchObject({
      status: "blocked",
      attachmentCount: 11,
      blockedAttachmentCount: 1,
    });
    expect(tooMany?.notes.join(" ")).toContain("Provider rich delivery limit is 10");
  });

  it("plans WhatsApp rich messages with direct Cloud API media labels and text fallback", () => {
    const plan = planChannelRichMessageDelivery("whatsapp", {
      text: "review these",
      richFormat: "markdown",
      attachments: [
        { url: "https://example.com/screenshot.webp", mimeType: "image/webp" },
        { title: "context note", mimeType: "text/plain" },
        { attachmentId: "11111111-1111-4111-8111-111111111111" },
      ],
    });

    expect(plan).toMatchObject({
      channelKey: "whatsapp",
      provider: "whatsapp_cloud_api",
      capabilityLabel: "WhatsApp Cloud API rich media",
      status: "degraded",
      textPosture: "separate_text_then_media",
      nativeAttachmentCount: 1,
      fallbackAttachmentCount: 1,
      pendingAttachmentIdCount: 1,
      evidence: {
        owner: "gateway",
        source: "channel_rich_message_plan",
        status: "degraded",
        provider: "whatsapp_cloud_api",
      },
      attachments: [
        {
          source: "url",
          mediaKind: "image",
          providerKind: "image",
          disposition: "native_media",
        },
        {
          source: "metadata_only",
          disposition: "text_fallback",
        },
        {
          source: "pending_attachment_id",
          disposition: "pending_hydration",
        },
      ],
    });
    expect(plan?.notes.join(" ")).toContain("does not preserve arbitrary HTML/Markdown");
  });
});

function endsWithDanglingHighSurrogate(value: string): boolean {
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function startsWithDanglingLowSurrogate(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

describe("platform-unsupported channel actions", () => {
  it("declares WhatsApp unsend as a platform limit, not a missing wire-up", () => {
    const capabilities = describeChannelCapabilities("whatsapp", { phoneNumberId: "1", accessTokenEnv: "WA_TOKEN" });
    expect(capabilities.supportedActions).not.toContain("channel.unsend");
    expect(capabilities.platformUnsupportedActions["channel.unsend"]).toMatch(/no endpoint for deleting/i);
    const text = [capabilities.runtimePosture.operatorSummary, ...capabilities.supportNotes].join(" ");
    expect(text).not.toMatch(/still incomplete|not wired|still not/i);
  });

  it("declares Slack typing as a platform limit and keeps Slack react/unsend", () => {
    const capabilities = describeChannelCapabilities("slack", { botTokenEnv: "SLACK_BOT_TOKEN" });
    expect(capabilities.supportedActions).not.toContain("channel.typing");
    expect(capabilities.platformUnsupportedActions["channel.typing"]).toMatch(/no typing indicator for bot messages/i);
    expect(capabilities.platformUnsupportedActions["channel.unsend"]).toBeUndefined();
  });

  it("declares Nextcloud Talk unsend and the ntfy react/typing limits", () => {
    expect(
      describeChannelCapabilities("nextcloud-talk", {}).platformUnsupportedActions["channel.unsend"],
    ).toBeDefined();
    const ntfy = describeChannelCapabilities("ntfy", {}).platformUnsupportedActions;
    expect(Object.keys(ntfy).sort()).toEqual(["channel.react", "channel.typing"]);
  });

  it("resolves Google Chat unsend by mode and never marks supported actions unsupported", () => {
    const webhook = describeChannelCapabilities("google-chat", {
      webhookUrl: "https://chat.googleapis.com/v1/spaces/A/messages",
    });
    expect(webhook.platformUnsupportedActions["channel.typing"]).toBeDefined();
    expect(webhook.platformUnsupportedActions["channel.unsend"]).toMatch(/webhook/i);
    const app = describeChannelCapabilities("google-chat", { serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY" });
    expect(app.platformUnsupportedActions["channel.unsend"]).toBeUndefined();
    expect(app.supportedActions).toContain("channel.unsend");
  });

  it("defaults to an empty map and never overlaps supported actions", () => {
    expect(describeChannelCapabilities("telegram", {}).platformUnsupportedActions).toEqual({});
    for (const key of ["slack", "whatsapp", "ntfy", "nextcloud-talk", "google-chat", "teams"]) {
      const c = describeChannelCapabilities(key, { botTokenEnv: "X", serviceAccountKeyEnv: "Y" });
      for (const action of Object.keys(c.platformUnsupportedActions)) {
        expect(c.supportedActions).not.toContain(action);
      }
    }
  });
});

describe("provider typing support", () => {
  it.each(["mattermost", "whatsapp"])("advertises channel.typing and a native typing effect for %s", (key) => {
    const capabilities = describeChannelCapabilities(key, {});
    expect(capabilities.supportedActions).toContain("channel.typing");
    expect(capabilities.activityCapabilities.nativeEffects).toContain("typing");
    expect(capabilities.platformUnsupportedActions?.["channel.typing"]).toBeUndefined();
  });
});

describe("inbound voice support notes", () => {
  it("tells operators how Slack and Discord voice messages are transcribed", () => {
    const slack = describeChannelCapabilities("slack", { botToken: "token", signingSecret: "secret" });
    expect(slack.supportNotes.join(" ")).toContain("Slack audio file shares are transcribed");
    const slackNoIngress = describeChannelCapabilities("slack", { botToken: "token" });
    expect(slackNoIngress.supportNotes.join(" ")).not.toContain("audio file shares are transcribed");

    const discord = describeChannelCapabilities("discord", { runtimeMode: "gateway", botToken: "token" });
    expect(discord.supportNotes.join(" ")).toContain("Discord voice messages");
  });

  it("says plainly that Nextcloud Talk voice messages are not transcribed", () => {
    const nextcloud = describeChannelCapabilities("nextcloud-talk", { baseUrl: "https://cloud.test", token: "t" });
    expect(nextcloud.supportNotes).toEqual(
      expect.arrayContaining([
        "Nextcloud Talk bots cannot download shared media, so inbound voice messages are not transcribed: the agent receives a notice that a voice message arrived instead.",
      ]),
    );
  });
});

describe("channel action matrix (#354)", () => {
  const MATRIX_ACTIONS = ["channel.react", "channel.unsend", "channel.typing"] as const;

  /**
   * Every connection mode each channel rule distinguishes. An action missing in
   * one mode but supported in another mode of the same channel is mode-gated:
   * the capability text tells the operator which connection mode to use.
   */
  const REPRESENTATIVE_CONFIGS: Record<string, Array<Record<string, unknown>>> = {
    slack: [{ botTokenEnv: "SLACK_BOT_TOKEN" }, { webhookUrl: "https://hooks.slack.com/services/A/B/C" }],
    discord: [
      { runtimeMode: "gateway", botTokenEnv: "DISCORD_BOT_TOKEN" },
      { runtimeMode: "bridge", botTokenEnv: "DISCORD_BOT_TOKEN" },
      { webhookUrl: "https://discord.com/api/webhooks/1/abc" },
    ],
    telegram: [{ botTokenEnv: "TELEGRAM_BOT_TOKEN" }],
    ntfy: [{ baseUrl: "https://ntfy.sh", topic: "goat" }],
    "google-chat": [
      { webhookUrl: "https://chat.googleapis.com/v1/spaces/A/messages" },
      { serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY" },
    ],
    teams: [{ webhookUrl: "https://example.webhook.office.com/webhookb2/x" }],
    whatsapp: [{ phoneNumberId: "1", accessTokenEnv: "WA_TOKEN" }],
    mattermost: [{ serverUrl: "https://mm.example.test", botTokenEnv: "MM_TOKEN" }],
    matrix: [
      { homeserverUrl: "https://matrix.example.test", accessTokenEnv: "MATRIX_TOKEN" },
      { homeserverUrl: "https://matrix.example.test", accessTokenEnv: "MATRIX_TOKEN", inboundStreamEnabled: true },
    ],
    qqbot: [{ appId: "1024", appSecretEnv: "QQBOT_APP_SECRET" }],
    wecom: [{ corpId: "ww1", agentId: "1000002", secretEnv: "WECOM_SECRET" }],
    "nextcloud-talk": [{ baseUrl: "https://cloud.example.test", tokenEnv: "NC_TOKEN" }],
    line: [{ channelAccessTokenEnv: "LINE_TOKEN" }],
    zalo: [{ accessTokenEnv: "ZALO_TOKEN" }],
  };

  /**
   * Channel × action cells that are neither implemented nor declared as a
   * platform limit. Each entry needs a reason; keep this list honest and short.
   */
  const SCOPE_EXCLUDED = "Excluded from the WS5 channel-actions scope (#354 covers the core channel set only).";
  const NOT_BY_ADAPTER =
    "The platform offers it but this adapter is text-send only in WS6 (not supported by this adapter).";
  const KNOWN_ACTION_GAPS: Record<string, Partial<Record<(typeof MATRIX_ACTIONS)[number], string>>> = {
    qqbot: { "channel.react": NOT_BY_ADAPTER, "channel.unsend": NOT_BY_ADAPTER },
    wecom: { "channel.react": NOT_BY_ADAPTER, "channel.unsend": NOT_BY_ADAPTER },
    line: { "channel.react": SCOPE_EXCLUDED, "channel.unsend": SCOPE_EXCLUDED, "channel.typing": SCOPE_EXCLUDED },
    zalo: { "channel.react": SCOPE_EXCLUDED, "channel.unsend": SCOPE_EXCLUDED, "channel.typing": SCOPE_EXCLUDED },
  };

  it("has representative configs for every channel rule", () => {
    expect(Object.keys(REPRESENTATIVE_CONFIGS).sort()).toEqual(listChannelRuleKeys().sort());
  });

  it.each(listChannelRuleKeys())(
    "%s implements, declares, mode-gates, or lists every react/unsend/typing cell",
    (key) => {
      const modes = (REPRESENTATIVE_CONFIGS[key] ?? [{}]).map((config) => describeChannelCapabilities(key, config));
      for (const action of MATRIX_ACTIONS) {
        const supportedInSomeMode = modes.some((capabilities) => capabilities.supportedActions.includes(action));
        for (const capabilities of modes) {
          const supported = capabilities.supportedActions.includes(action);
          const declared = capabilities.platformUnsupportedActions[action];
          expect(supported && declared !== undefined, `${key} ${action} is both supported and declared`).toBe(false);
          const knownGap = KNOWN_ACTION_GAPS[key]?.[action];
          expect(
            supported || declared !== undefined || supportedInSomeMode || knownGap !== undefined,
            `${key} ${action} is neither implemented, declared platform-unsupported, mode-gated, nor a listed gap`,
          ).toBe(true);
          if (knownGap !== undefined) {
            expect(
              supportedInSomeMode || declared !== undefined,
              `${key} ${action} is listed as a gap but resolved`,
            ).toBe(false);
          }
        }
      }
    },
  );

  it("declares the verified platform limits added for #354", () => {
    expect(describeChannelCapabilities("nextcloud-talk", {}).platformUnsupportedActions["channel.typing"]).toMatch(
      /no typing-indicator endpoint/i,
    );
    for (const config of REPRESENTATIVE_CONFIGS["google-chat"] ?? []) {
      expect(describeChannelCapabilities("google-chat", config).platformUnsupportedActions["channel.react"]).toMatch(
        /user authentication/i,
      );
    }
    const webhook = describeChannelCapabilities("discord", { webhookUrl: "https://discord.com/api/webhooks/1/abc" });
    expect(webhook.platformUnsupportedActions["channel.typing"]).toBe(
      "Discord webhooks cannot send typing indicators.",
    );
    expect(webhook.platformUnsupportedActions["channel.react"]).toBe("Discord webhooks cannot add reactions.");
    const bridge = describeChannelCapabilities("discord", { runtimeMode: "bridge", botTokenEnv: "DISCORD_BOT_TOKEN" });
    expect(bridge.supportedActions).toContain("channel.typing");
    expect(bridge.platformUnsupportedActions).toEqual({});
  });

  it("advertises ntfy unsend", () => {
    const ntfy = describeChannelCapabilities("ntfy", { baseUrl: "https://ntfy.sh", topic: "goat" });
    expect(ntfy.supportedActions).toContain("channel.unsend");
    expect(Object.keys(ntfy.platformUnsupportedActions).sort()).toEqual(["channel.react", "channel.typing"]);
  });

  it("names the media hosts Slack and Discord voice need in the network allowlist", () => {
    const slack = describeChannelCapabilities("slack", { botToken: "token", signingSecret: "secret" });
    expect(slack.supportNotes.join(" ")).toContain("files.slack.com must be in the network allowlist");
    const discord = describeChannelCapabilities("discord", { runtimeMode: "gateway", botToken: "token" });
    const discordNotes = discord.supportNotes.join(" ");
    expect(discordNotes).toContain("cdn.discordapp.com");
    expect(discordNotes).toContain("media.discordapp.net");
  });
});
