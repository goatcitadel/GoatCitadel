import { describe, expect, it } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { listChannelSetupDefinitions, requireChannelSetupDefinition } from "./channel-setup-definitions.js";

function createConnection(overrides: Partial<IntegrationConnection>): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "channel.discord",
    kind: "channel",
    key: "discord",
    label: "Primary Channel",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
    ...overrides,
  };
}

function createDraft(
  catalogId: string,
  draft: Record<string, unknown>,
  lifecycleMode: ChannelSetupDraft["lifecycleMode"] = "create",
): ChannelSetupDraft {
  return {
    draftId: "22222222-2222-2222-2222-222222222222",
    catalogId,
    lifecycleMode,
    enabled: true,
    draft,
    contentVersion: "content.v1",
    adapterVersion: "adapter.v1",
    validationVersion: "validation.v1",
    testVersion: "test.v1",
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
  };
}

describe("channel setup definitions", () => {
  it("lists the guided definitions for the supported rollout channels", () => {
    const catalogIds = listChannelSetupDefinitions().map((definition) => definition.catalog.catalogId);

    expect(catalogIds).toEqual(
      expect.arrayContaining([
        "channel.discord",
        "channel.slack",
        "channel.telegram",
        "channel.ntfy",
        "channel.google-chat",
        "channel.teams",
        "channel.whatsapp",
        "channel.signal",
        "channel.mattermost",
        "channel.imessage",
        "channel.nextcloud-talk",
        "channel.line",
        "channel.zalo",
        "channel.zalouser",
      ]),
    );
  });

  it("hydrates Discord connections without rehydrating configured secrets", () => {
    const definition = requireChannelSetupDefinition("channel.discord");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.discord",
        key: "discord",
        label: "Discord Primary",
        config: {
          botToken: "discord-secret-token",
          runtimeMode: "bridge",
          defaultChannelId: "123456789012345678",
          defaultGuildId: "987654321098765432",
        },
      }),
    );

    expect(hydrated.hydration.status).toBe("opaque-secret");
    expect(hydrated.hydration.fieldState.botToken).toBe("configured");
    expect(hydrated.hydration.fieldState.botTokenEnv).toBe("unknown");
    expect(hydrated.draft).toEqual({
      runtimeMode: "bridge",
      inboundDmPolicy: "pairing",
      guildPolicy: "allowlist",
      defaultChannelId: "123456789012345678",
      defaultGuildId: "987654321098765432",
    });
    expect(hydrated.draft).not.toHaveProperty("botToken");
  });

  it("accepts saved Discord secret state during repair or retest without re-entry", () => {
    const definition = requireChannelSetupDefinition("channel.discord");
    const issues = definition.validate({
      ...createDraft(
        "channel.discord",
        {
          runtimeMode: "bridge",
          defaultChannelId: "123456789012345678",
        },
        "retest",
      ),
      hydration: {
        status: "opaque-secret",
        warnings: [],
        fieldState: {
          botToken: "configured",
          botTokenEnv: "missing",
        },
      },
    });

    expect(issues).toEqual([]);
  });

  it("defaults new Discord bot-token drafts to gateway mode without asking for runtime selection", () => {
    const definition = requireChannelSetupDefinition("channel.discord");
    const normalized = definition.normalize(
      createDraft("channel.discord", {
        botTokenEnv: "DISCORD_BOT_TOKEN",
        defaultChannelId: "123456789012345678",
        defaultGuildId: "987654321098765432",
      }),
    );

    expect(normalized).toEqual(
      expect.objectContaining({
        runtimeMode: "gateway",
        botTokenEnv: "DISCORD_BOT_TOKEN",
        defaultChannelId: "123456789012345678",
        inboundDmPolicy: "pairing",
        guildPolicy: "allowlist",
      }),
    );
  });

  it("infers gateway mode for existing Discord bot-token connections that lack an explicit runtime mode", () => {
    const definition = requireChannelSetupDefinition("channel.discord");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.discord",
        key: "discord",
        label: "Discord Primary",
        config: {
          botToken: "discord-secret-token",
          defaultChannelId: "123456789012345678",
        },
      }),
    );

    expect(hydrated.draft).toEqual(
      expect.objectContaining({
        runtimeMode: "gateway",
        defaultChannelId: "123456789012345678",
      }),
    );
  });

  it("hydrates Telegram connections without rehydrating bot tokens", () => {
    const definition = requireChannelSetupDefinition("channel.telegram");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.telegram",
        key: "telegram",
        label: "Telegram Primary",
        config: {
          botToken: "123456789:telegram-secret-token",
          defaultChatId: "123456789",
          parseMode: "MarkdownV2",
        },
      }),
    );

    expect(hydrated.hydration.status).toBe("opaque-secret");
    expect(hydrated.hydration.fieldState.botToken).toBe("configured");
    expect(hydrated.draft).toEqual(
      expect.objectContaining({
        defaultChatId: "123456789",
        parseMode: "MarkdownV2",
        targets: [
          expect.objectContaining({
            id: "default",
            label: "Telegram default",
            chatId: "123456789",
            default: true,
          }),
        ],
      }),
    );
    expect(hydrated.draft).not.toHaveProperty("botToken");
  });

  it("accepts saved Telegram secret state during repair or retest without re-entry", () => {
    const definition = requireChannelSetupDefinition("channel.telegram");
    const issues = definition.validate({
      ...createDraft(
        "channel.telegram",
        {
          defaultChatId: "123456789",
          parseMode: "Markdown",
        },
        "retest",
      ),
      hydration: {
        status: "opaque-secret",
        warnings: [],
        fieldState: {
          botToken: "configured",
          botTokenEnv: "unknown",
        },
      },
    });

    expect(issues).toEqual([]);
  });

  it("preserves env-backed Telegram auth during edit flows without forcing secret re-entry", () => {
    const definition = requireChannelSetupDefinition("channel.telegram");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.telegram",
        key: "telegram",
        label: "Telegram Primary",
        config: {
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          defaultChatId: "@ops_channel",
          parseMode: "MarkdownV2",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.telegram", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        defaultChatId: "@ops_channel",
        parseMode: "MarkdownV2",
      }),
    );
  });

  it("preserves Telegram webhook secret env references during edit flows", () => {
    const definition = requireChannelSetupDefinition("channel.telegram");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.telegram",
        key: "telegram",
        label: "Telegram Primary",
        config: {
          tokenEnv: "TELEGRAM_BOT_TOKEN",
          webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
          defaultChatId: "@ops_channel",
          parseMode: "MarkdownV2",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.telegram", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
        defaultChatId: "@ops_channel",
      }),
    );
  });

  it("keeps ntfy setup outbound-only with env-backed token hydration and dry-run defaults", () => {
    const definition = requireChannelSetupDefinition("channel.ntfy");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.ntfy",
        key: "ntfy",
        label: "ntfy Ops",
        config: {
          baseUrl: "https://ntfy.example.com",
          topic: "goatcitadel-ops",
          tokenEnv: "NTFY_TOKEN",
          priority: "4",
          dryRun: true,
        },
      }),
    );
    const draft = {
      ...createDraft("channel.ntfy", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(hydrated.hydration.status).toBe("opaque-secret");
    expect(hydrated.hydration.fieldState.token).toBe("configured");
    expect(hydrated.draft).not.toHaveProperty("token");
    expect(definition.definition.catalog.supportedModes).toEqual(["guided", "manual"]);
    expect(JSON.stringify(definition.definition)).toMatch(/send-only|outbound-only/i);
    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        baseUrl: "https://ntfy.example.com",
        topic: "goatcitadel-ops",
        tokenEnv: "NTFY_TOKEN",
        priority: "4",
        dryRun: true,
      }),
    );
  });

  it("rejects malformed ntfy topic and priority values", () => {
    const definition = requireChannelSetupDefinition("channel.ntfy");
    const issues = definition.validate(
      createDraft("channel.ntfy", {
        baseUrl: "ntfy.local",
        topic: "bad/topic",
        priority: "9",
      }),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldKey: "baseUrl", failureCategory: "malformed_value" }),
        expect.objectContaining({ fieldKey: "topic", failureCategory: "malformed_value" }),
        expect.objectContaining({ fieldKey: "priority", failureCategory: "malformed_value" }),
      ]),
    );
  });

  it("requires a Slack auth path and a default channel", () => {
    const definition = requireChannelSetupDefinition("channel.slack");
    const issues = definition.validate(createDraft("channel.slack", {}));

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "slack_auth_missing",
          failureCategory: "missing_input",
        }),
        expect.objectContaining({
          fieldKey: "targets",
          failureCategory: "missing_input",
        }),
      ]),
    );
  });

  it("preserves env-backed Slack auth during edit flows without forcing secret re-entry", () => {
    const definition = requireChannelSetupDefinition("channel.slack");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.slack",
        key: "slack",
        label: "Slack Primary",
        config: {
          tokenEnv: "SLACK_BOT_TOKEN",
          defaultChannel: "#ops-sandbox",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.slack", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        botTokenEnv: "SLACK_BOT_TOKEN",
        defaultChannel: "#ops-sandbox",
      }),
    );
  });

  it("rejects malformed Google Chat webhook URLs", () => {
    const definition = requireChannelSetupDefinition("channel.google-chat");
    const issues = definition.validate(
      createDraft("channel.google-chat", {
        webhookUrl: "https://chat.google.com/not-a-webhook",
      }),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        fieldKey: "webhookUrl",
        failureCategory: "malformed_value",
      }),
    ]);
  });

  it("rejects malformed Teams webhook URLs", () => {
    const definition = requireChannelSetupDefinition("channel.teams");
    const issues = definition.validate(
      createDraft("channel.teams", {
        webhookUrl: "https://teams.microsoft.com/l/channel/not-a-webhook",
      }),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        fieldKey: "webhookUrl",
        failureCategory: "malformed_value",
      }),
    ]);
  });

  it("preserves env-backed Teams webhooks during edit flows without forcing secret re-entry", () => {
    const definition = requireChannelSetupDefinition("channel.teams");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.teams",
        key: "teams",
        label: "Teams Primary",
        config: {
          webhookUrlEnv: "TEAMS_WEBHOOK_URL",
          cardTitle: "Ops Alerts",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.teams", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        webhookUrlEnv: "TEAMS_WEBHOOK_URL",
        cardTitle: "Ops Alerts",
      }),
    );
  });

  it("requires WhatsApp auth, phone number id, and a default recipient", () => {
    const definition = requireChannelSetupDefinition("channel.whatsapp");
    const issues = definition.validate(createDraft("channel.whatsapp", {}));

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "whatsapp_auth_missing",
          failureCategory: "missing_input",
        }),
        expect.objectContaining({
          fieldKey: "phoneNumberId",
          failureCategory: "missing_input",
        }),
        expect.objectContaining({
          fieldKey: "defaultTarget",
          failureCategory: "missing_input",
        }),
      ]),
    );
  });

  it("preserves WhatsApp webhook secret env references during edit flows", () => {
    const definition = requireChannelSetupDefinition("channel.whatsapp");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.whatsapp",
        key: "whatsapp",
        label: "WhatsApp Primary",
        config: {
          accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
          appSecretEnv: "WHATSAPP_APP_SECRET",
          webhookVerifyTokenEnv: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
          phoneNumberId: "123456789012345",
          defaultTarget: "+15551234567",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.whatsapp", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        accessTokenEnv: "WHATSAPP_ACCESS_TOKEN",
        appSecretEnv: "WHATSAPP_APP_SECRET",
        webhookVerifyTokenEnv: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
        phoneNumberId: "123456789012345",
        defaultTarget: "+15551234567",
      }),
    );
  });

  it("rejects incomplete Signal bridge drafts", () => {
    const definition = requireChannelSetupDefinition("channel.signal");
    const issues = definition.validate(
      createDraft("channel.signal", {
        baseUrl: "not-a-url",
      }),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldKey: "baseUrl",
          failureCategory: "malformed_value",
        }),
        expect.objectContaining({
          fieldKey: "defaultRecipient",
          failureCategory: "missing_input",
        }),
      ]),
    );
  });

  it("preserves env-backed Mattermost auth during edit flows", () => {
    const definition = requireChannelSetupDefinition("channel.mattermost");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.mattermost",
        key: "mattermost",
        label: "Mattermost Primary",
        config: {
          serverUrl: "https://chat.example.com",
          botTokenEnv: "MATTERMOST_BOT_TOKEN",
          defaultChannel: "town-square",
          defaultTeam: "goatcitadel",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.mattermost", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        serverUrl: "https://chat.example.com",
        botTokenEnv: "MATTERMOST_BOT_TOKEN",
        defaultChannel: "town-square",
        defaultTeam: "goatcitadel",
      }),
    );
  });

  it("preserves env-backed iMessage bridge auth during edit flows", () => {
    const definition = requireChannelSetupDefinition("channel.imessage");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.imessage",
        key: "imessage",
        label: "iMessage Primary",
        config: {
          bridgeProvider: "bluebubbles",
          bridgeUrl: "http://127.0.0.1:3001",
          passwordEnv: "IMESSAGE_PASSWORD",
          defaultHandle: "imessage:+15551234567",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.imessage", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        bridgeProvider: "bluebubbles",
        bridgeUrl: "http://127.0.0.1:3001",
        passwordEnv: "IMESSAGE_PASSWORD",
        defaultHandle: "imessage:+15551234567",
      }),
    );
  });

  it("preserves Photon iMessage provider metadata while warning that runtime sends are adapter-gated", () => {
    const definition = requireChannelSetupDefinition("channel.imessage");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.imessage",
        key: "imessage",
        label: "Photon iMessage",
        config: {
          bridgeProvider: "photon",
          bridgeUrl: "http://127.0.0.1:4317",
          passwordEnv: "PHOTON_AUTH_TOKEN",
          photonSidecarUrl: "http://127.0.0.1:4317",
          photonAuthEnv: "PHOTON_AUTH_TOKEN",
          defaultHandle: "imessage:+15551234567",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.imessage", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "imessage_photon_preview",
          level: "warn",
          fieldKey: "bridgeProvider",
        }),
      ]),
    );
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        bridgeProvider: "photon",
        photonSidecarUrl: "http://127.0.0.1:4317",
        photonAuthEnv: "PHOTON_AUTH_TOKEN",
      }),
    );
  });

  it("preserves env-backed Nextcloud Talk auth during edit flows", () => {
    const definition = requireChannelSetupDefinition("channel.nextcloud-talk");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.nextcloud-talk",
        key: "nextcloud-talk",
        label: "Nextcloud Talk Primary",
        config: {
          baseUrl: "https://cloud.example.com",
          tokenEnv: "NEXTCLOUD_TALK_TOKEN",
          defaultRoomId: "ops-room",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.nextcloud-talk", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        baseUrl: "https://cloud.example.com",
        tokenEnv: "NEXTCLOUD_TALK_TOKEN",
        defaultRoomId: "ops-room",
      }),
    );
  });

  it("preserves LINE channel secret env references during edit flows", () => {
    const definition = requireChannelSetupDefinition("channel.line");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.line",
        key: "line",
        label: "LINE Primary",
        config: {
          channelAccessTokenEnv: "LINE_CHANNEL_ACCESS_TOKEN",
          channelSecretEnv: "LINE_CHANNEL_SECRET",
          defaultTarget: "U1234567890",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.line", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(
      expect.objectContaining({
        channelAccessTokenEnv: "LINE_CHANNEL_ACCESS_TOKEN",
        channelSecretEnv: "LINE_CHANNEL_SECRET",
        defaultTarget: "U1234567890",
      }),
    );
  });

  it("rejects malformed Zalo User bridge drafts", () => {
    const definition = requireChannelSetupDefinition("channel.zalouser");
    const issues = definition.validate(
      createDraft("channel.zalouser", {
        baseUrl: "zca.local",
      }),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldKey: "baseUrl",
          failureCategory: "malformed_value",
        }),
        expect.objectContaining({
          fieldKey: "defaultTarget",
          failureCategory: "missing_input",
        }),
      ]),
    );
  });

  it("hydrates and normalizes the bridge and webhook tails without exposing saved secrets", () => {
    const googleChat = requireChannelSetupDefinition("channel.google-chat");
    const googleHydrated = googleChat.hydrate(
      createConnection({
        catalogId: "channel.google-chat",
        key: "google-chat",
        config: {
          webhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=key&token=token",
          defaultThreadKey: "ops-thread",
        },
      }),
    );
    expect(googleHydrated.hydration.status).toBe("opaque-secret");
    expect(googleHydrated.hydration.fieldState.webhookUrl).toBe("configured");
    expect(googleHydrated.draft).toEqual({ defaultThreadKey: "ops-thread" });
    expect(
      googleChat.normalize(
        createDraft("channel.google-chat", {
          webhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=key&token=token",
          defaultThreadKey: "ops-thread",
        }),
      ),
    ).toEqual({
      webhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=key&token=token",
      defaultThreadKey: "ops-thread",
    });
    expect(
      googleChat.validate(
        createDraft("channel.google-chat", {
          webhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=key&token=token",
        }),
      ),
    ).toEqual([]);

    const signal = requireChannelSetupDefinition("channel.signal");
    const signalHydrated = signal.hydrate(
      createConnection({
        catalogId: "channel.signal",
        key: "signal",
        config: {
          bridgeUrl: "http://127.0.0.1:8080",
          accountId: "+15551234567",
          defaultRecipient: "+15557654321",
        },
      }),
    );
    expect(signalHydrated.hydration.status).toBe("clean");
    expect(signalHydrated.hydration.fieldState.baseUrl).toBe("configured");
    expect(
      signal.normalize({
        ...createDraft("channel.signal", { defaultRecipient: "+15557654321" }, "edit"),
        hydration: signalHydrated.hydration,
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:8080",
      defaultRecipient: "+15557654321",
    });
    expect(
      signal.validate({
        ...createDraft("channel.signal", { defaultRecipient: "+15557654321" }, "edit"),
        hydration: signalHydrated.hydration,
      }),
    ).toEqual([]);

    const zalo = requireChannelSetupDefinition("channel.zalo");
    const zaloHydrated = zalo.hydrate(
      createConnection({
        catalogId: "channel.zalo",
        key: "zalo",
        config: {
          tokenEnv: "ZALO_ACCESS_TOKEN",
          defaultRecipientId: "oa-user-1",
        },
      }),
    );
    expect(zaloHydrated.hydration.status).toBe("opaque-secret");
    expect(zaloHydrated.hydration.fieldState.accessToken).toBe("configured");
    expect(
      zalo.normalize({
        ...createDraft("channel.zalo", { defaultRecipientId: "oa-user-1" }, "edit"),
        hydration: zaloHydrated.hydration,
      }),
    ).toEqual({
      accessTokenEnv: "ZALO_ACCESS_TOKEN",
      defaultRecipientId: "oa-user-1",
    });
    expect(
      zalo.validate({
        ...createDraft("channel.zalo", { defaultRecipientId: "oa-user-1" }, "edit"),
        hydration: zaloHydrated.hydration,
      }),
    ).toEqual([]);

    const zaloUser = requireChannelSetupDefinition("channel.zalouser");
    const zaloUserHydrated = zaloUser.hydrate(
      createConnection({
        catalogId: "channel.zalouser",
        key: "zalouser",
        config: {
          bridgeUrl: "http://127.0.0.1:56789",
          authorizationEnv: "ZALOUSER_AUTHORIZATION",
          profile: "work",
          defaultTarget: "user:u-123456789",
        },
      }),
    );
    expect(zaloUserHydrated.hydration.status).toBe("opaque-secret");
    expect(zaloUserHydrated.hydration.fieldState.authToken).toBe("configured");
    expect(
      zaloUser.normalize({
        ...createDraft("channel.zalouser", { defaultTarget: "user:u-123456789" }, "edit"),
        hydration: zaloUserHydrated.hydration,
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:56789",
      authorizationEnv: "ZALOUSER_AUTHORIZATION",
      defaultTarget: "user:u-123456789",
    });
    expect(
      zaloUser.validate({
        ...createDraft("channel.zalouser", { defaultTarget: "user:u-123456789" }, "edit"),
        hydration: zaloUserHydrated.hydration,
      }),
    ).toEqual([]);
  });

  it("normalizes target arrays and legacy targets used by Slack and Telegram setup", () => {
    const slack = requireChannelSetupDefinition("channel.slack");
    const slackNormalized = slack.normalize(
      createDraft("channel.slack", {
        botTokenEnv: "SLACK_BOT_TOKEN",
        targets: JSON.stringify([
          {
            target: "#ops",
            threadTs: "1712109984.100000",
            default: "true",
          },
        ]),
      }),
    );
    expect(slackNormalized).toEqual(
      expect.objectContaining({
        botTokenEnv: "SLACK_BOT_TOKEN",
        targets: [
          expect.objectContaining({
            id: "slack-target-1",
            label: "#ops",
            channel: "#ops",
            threadTs: "1712109984.100000",
            default: true,
          }),
        ],
      }),
    );

    const telegram = requireChannelSetupDefinition("channel.telegram");
    const telegramNormalized = telegram.normalize(
      createDraft("channel.telegram", {
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        targets: [
          {
            defaultChatId: "ops_channel",
            messageThreadId: "42",
            kind: "topic",
          },
        ],
      }),
    );
    expect(telegramNormalized).toEqual(
      expect.objectContaining({
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        targets: [
          expect.objectContaining({
            id: "telegram-target-1",
            label: "ops_channel",
            chatId: "ops_channel",
            threadId: "42",
            kind: "topic",
            default: true,
          }),
        ],
      }),
    );
  });

  it("advertises live-send testing for the guided smoke-probe channels", () => {
    const channels = [
      "channel.discord",
      "channel.slack",
      "channel.telegram",
      "channel.google-chat",
      "channel.teams",
      "channel.ntfy",
      "channel.whatsapp",
      "channel.signal",
      "channel.mattermost",
      "channel.imessage",
      "channel.line",
      "channel.zalo",
      "channel.zalouser",
    ] as const;

    for (const catalogId of channels) {
      const definition = requireChannelSetupDefinition(catalogId);
      expect(definition.definition.testing.levels).toContain("live-send");
    }
  });

  it("advertises live-auth testing for the guided probe-backed channels", () => {
    const channels = [
      "channel.discord",
      "channel.whatsapp",
      "channel.mattermost",
      "channel.imessage",
      "channel.line",
    ] as const;

    for (const catalogId of channels) {
      const definition = requireChannelSetupDefinition(catalogId);
      expect(definition.definition.testing.levels).toContain("live-auth");
    }
  });

  it("keeps guided channel copy out of the old planned-parity wording for visible built-in channels", () => {
    const channels = ["channel.whatsapp", "channel.mattermost", "channel.line"] as const;

    for (const catalogId of channels) {
      const definition = requireChannelSetupDefinition(catalogId);
      expect(JSON.stringify(definition.definition)).not.toMatch(/planned parity work|still counts as planned/i);
    }
  });
});
