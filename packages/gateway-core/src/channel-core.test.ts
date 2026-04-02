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

    expect(capabilities.supportedActions).toEqual(expect.arrayContaining([
      "channel.send",
      "channel.reply",
      "channel.react",
      "channel.unsend",
      "channel.typing",
    ]));
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

  it("keeps webhook-only Discord connections outbound-only", () => {
    const capabilities = describeChannelCapabilities("discord", {
      webhookUrl: "https://discord.com/api/webhooks/123/test",
    });

    expect(capabilities.supportedActions).toEqual([
      "channel.send",
      "channel.unsend",
    ]);
    expect(capabilities.inboundModes).toEqual(["none"]);
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
    });
    expect(capabilities.runtimePolicy.typing).toBe(false);
    expect(capabilities.runtimePolicy.presence).toBe(false);
  });

  it("reports missing setup requirements for incomplete bridge configs", () => {
    const capabilities = describeChannelCapabilities("imessage", {
      defaultHandle: "imessage:+15551234567",
    });

    expect(capabilities.setupReady).toBe(false);
    expect(capabilities.setupDiagnostics).toEqual(expect.arrayContaining([
      "Missing one of: config.bridgeUrl, config.baseUrl, config.serverUrl.",
      "Missing one of: config.passwordEnv, config.password, config.apiPasswordEnv, config.apiPassword.",
    ]));
  });

  it("adds explicit reply support for channels that already support threaded replies", () => {
    const capabilities = describeChannelCapabilities("slack", {
      botTokenEnv: "SLACK_BOT_TOKEN",
      signingSecretEnv: "SLACK_SIGNING_SECRET",
      defaultChannel: "#ops",
    });

    expect(capabilities.supportedActions).toEqual(expect.arrayContaining([
      "channel.send",
      "channel.reply",
      "channel.react",
      "channel.unsend",
    ]));
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

    expect(capabilities.supportedActions).toEqual(expect.arrayContaining([
      "channel.send",
      "channel.reply",
      "channel.react",
      "channel.unsend",
      "channel.typing",
    ]));
    expect(capabilities.inboundModes).toEqual(["webhook"]);
    expect(capabilities.runtimePosture).toMatchObject({
      outboundTransport: "api",
      inboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "ready",
    });
    expect(capabilities.runtimePolicy.typing).toBe(true);
    expect(capabilities.supportNotes).toEqual(expect.arrayContaining([
      "Telegram bot connections can add reactions, delete sent messages, and emit typing indicators when the bot has access to the target chat.",
      "Telegram inbound webhook routing is enabled through the Bot API secret-token webhook path.",
    ]));
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
    expect(capabilities.supportNotes).toEqual(expect.arrayContaining([
      "WhatsApp inbound routing is enabled through the signed Cloud API webhook path when both the app secret and webhook verify token are configured.",
    ]));
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
    expect(capabilities.supportNotes).toEqual(expect.arrayContaining([
      "LINE inbound routing is enabled through the signed Messaging API webhook path when a channel secret is configured.",
    ]));
  });
});
