import { describe, expect, it } from "vitest";
import { describeChannelCapabilities } from "./channel-core.js";

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

  it("reports missing setup requirements for incomplete bridge configs", () => {
    const capabilities = describeChannelCapabilities("imessage", {
      defaultHandle: "imessage:+15551234567",
    });

    expect(capabilities.setupReady).toBe(false);
    expect(capabilities.setupDiagnostics).toEqual(
      expect.arrayContaining([
        "Missing one of: config.bridgeUrl, config.baseUrl, config.serverUrl.",
        "Missing one of: config.passwordEnv, config.password, config.apiPasswordEnv, config.apiPassword.",
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
    expect(ntfyOutbound.supportedActions).toEqual(["channel.send", "channel.activity"]);
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

  it("describes static channel rules and setup diagnostics", () => {
    const staticChannels = [
      ["google-chat", { webhookUrl: "https://chat.test" }],
      ["teams", { url: "https://teams.test" }],
      ["signal", { baseUrl: "http://127.0.0.1:8080" }],
      ["mattermost", { serverUrl: "https://mattermost.test", botTokenEnv: "MATTERMOST_TOKEN" }],
      ["imessage", { bridgeUrl: "http://127.0.0.1:1234", password: "pass" }],
      ["nextcloud-talk", { baseUrl: "https://cloud.test", token: "token" }],
      ["ntfy", { baseUrl: "https://ntfy.test", topic: "ops" }],
      ["zalo", { token: "token" }],
      ["zalouser", { bridgeUrl: "http://127.0.0.1:4545", authToken: "token" }],
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
    const capabilities = describeChannelCapabilities("signal", {
      baseUrl: "   ",
      bridgeUrl: "\t",
    });

    expect(capabilities.setupReady).toBe(false);
    expect(capabilities.setupDiagnostics).toEqual(["Missing one of: config.baseUrl, config.bridgeUrl."]);
  });
});
