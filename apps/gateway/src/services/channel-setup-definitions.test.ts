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

    expect(catalogIds).toEqual(expect.arrayContaining([
      "channel.discord",
      "channel.slack",
      "channel.telegram",
      "channel.google-chat",
      "channel.teams",
    ]));
  });

  it("hydrates Discord connections without rehydrating configured secrets", () => {
    const definition = requireChannelSetupDefinition("channel.discord");
    const hydrated = definition.hydrate(createConnection({
      catalogId: "channel.discord",
      key: "discord",
      label: "Discord Primary",
      config: {
        botToken: "discord-secret-token",
        runtimeMode: "bridge",
        defaultChannelId: "123456789012345678",
        defaultGuildId: "987654321098765432",
      },
    }));

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
      ...createDraft("channel.discord", {
        runtimeMode: "bridge",
        defaultChannelId: "123456789012345678",
      }, "retest"),
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
    const normalized = definition.normalize(createDraft("channel.discord", {
      botTokenEnv: "DISCORD_BOT_TOKEN",
      defaultChannelId: "123456789012345678",
      defaultGuildId: "987654321098765432",
    }));

    expect(normalized).toEqual(expect.objectContaining({
      runtimeMode: "gateway",
      botTokenEnv: "DISCORD_BOT_TOKEN",
      defaultChannelId: "123456789012345678",
      inboundDmPolicy: "pairing",
      guildPolicy: "allowlist",
    }));
  });

  it("infers gateway mode for existing Discord bot-token connections that lack an explicit runtime mode", () => {
    const definition = requireChannelSetupDefinition("channel.discord");
    const hydrated = definition.hydrate(createConnection({
      catalogId: "channel.discord",
      key: "discord",
      label: "Discord Primary",
      config: {
        botToken: "discord-secret-token",
        defaultChannelId: "123456789012345678",
      },
    }));

    expect(hydrated.draft).toEqual(expect.objectContaining({
      runtimeMode: "gateway",
      defaultChannelId: "123456789012345678",
    }));
  });

  it("hydrates Telegram connections without rehydrating bot tokens", () => {
    const definition = requireChannelSetupDefinition("channel.telegram");
    const hydrated = definition.hydrate(createConnection({
      catalogId: "channel.telegram",
      key: "telegram",
      label: "Telegram Primary",
      config: {
        botToken: "123456789:telegram-secret-token",
        defaultChatId: "123456789",
        parseMode: "MarkdownV2",
      },
    }));

    expect(hydrated.hydration.status).toBe("opaque-secret");
    expect(hydrated.hydration.fieldState.botToken).toBe("configured");
    expect(hydrated.draft).toEqual({
      defaultChatId: "123456789",
      parseMode: "MarkdownV2",
    });
    expect(hydrated.draft).not.toHaveProperty("botToken");
  });

  it("accepts saved Telegram secret state during repair or retest without re-entry", () => {
    const definition = requireChannelSetupDefinition("channel.telegram");
    const issues = definition.validate({
      ...createDraft("channel.telegram", {
        defaultChatId: "123456789",
        parseMode: "Markdown",
      }, "retest"),
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
    const hydrated = definition.hydrate(createConnection({
      catalogId: "channel.telegram",
      key: "telegram",
      label: "Telegram Primary",
      config: {
        tokenEnv: "TELEGRAM_BOT_TOKEN",
        defaultChatId: "@ops_channel",
        parseMode: "MarkdownV2",
      },
    }));
    const draft = {
      ...createDraft("channel.telegram", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(expect.objectContaining({
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      defaultChatId: "@ops_channel",
      parseMode: "MarkdownV2",
    }));
  });

  it("preserves Telegram webhook secret env references during edit flows", () => {
    const definition = requireChannelSetupDefinition("channel.telegram");
    const hydrated = definition.hydrate(createConnection({
      catalogId: "channel.telegram",
      key: "telegram",
      label: "Telegram Primary",
      config: {
        tokenEnv: "TELEGRAM_BOT_TOKEN",
        webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
        defaultChatId: "@ops_channel",
        parseMode: "MarkdownV2",
      },
    }));
    const draft = {
      ...createDraft("channel.telegram", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(expect.objectContaining({
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
      defaultChatId: "@ops_channel",
    }));
  });

  it("requires a Slack auth path and a default channel", () => {
    const definition = requireChannelSetupDefinition("channel.slack");
    const issues = definition.validate(createDraft("channel.slack", {}));

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "slack_auth_missing",
        failureCategory: "missing_input",
      }),
      expect.objectContaining({
        fieldKey: "defaultChannel",
        failureCategory: "missing_input",
      }),
    ]));
  });

  it("preserves env-backed Slack auth during edit flows without forcing secret re-entry", () => {
    const definition = requireChannelSetupDefinition("channel.slack");
    const hydrated = definition.hydrate(createConnection({
      catalogId: "channel.slack",
      key: "slack",
      label: "Slack Primary",
      config: {
        tokenEnv: "SLACK_BOT_TOKEN",
        defaultChannel: "#ops-sandbox",
      },
    }));
    const draft = {
      ...createDraft("channel.slack", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(expect.objectContaining({
      botTokenEnv: "SLACK_BOT_TOKEN",
      defaultChannel: "#ops-sandbox",
    }));
  });

  it("rejects malformed Google Chat webhook URLs", () => {
    const definition = requireChannelSetupDefinition("channel.google-chat");
    const issues = definition.validate(createDraft("channel.google-chat", {
      webhookUrl: "https://chat.google.com/not-a-webhook",
    }));

    expect(issues).toEqual([
      expect.objectContaining({
        fieldKey: "webhookUrl",
        failureCategory: "malformed_value",
      }),
    ]);
  });

  it("rejects malformed Teams webhook URLs", () => {
    const definition = requireChannelSetupDefinition("channel.teams");
    const issues = definition.validate(createDraft("channel.teams", {
      webhookUrl: "https://teams.microsoft.com/l/channel/not-a-webhook",
    }));

    expect(issues).toEqual([
      expect.objectContaining({
        fieldKey: "webhookUrl",
        failureCategory: "malformed_value",
      }),
    ]);
  });

  it("preserves env-backed Teams webhooks during edit flows without forcing secret re-entry", () => {
    const definition = requireChannelSetupDefinition("channel.teams");
    const hydrated = definition.hydrate(createConnection({
      catalogId: "channel.teams",
      key: "teams",
      label: "Teams Primary",
      config: {
        webhookUrlEnv: "TEAMS_WEBHOOK_URL",
        cardTitle: "Ops Alerts",
      },
    }));
    const draft = {
      ...createDraft("channel.teams", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    };

    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toEqual(expect.objectContaining({
      webhookUrlEnv: "TEAMS_WEBHOOK_URL",
      cardTitle: "Ops Alerts",
    }));
  });

  it("advertises live-send testing for the guided smoke-probe channels", () => {
    const channels = [
      "channel.discord",
      "channel.slack",
      "channel.telegram",
      "channel.google-chat",
      "channel.teams",
    ] as const;

    for (const catalogId of channels) {
      const definition = requireChannelSetupDefinition(catalogId);
      expect(definition.definition.testing.levels).toContain("live-send");
    }
  });
});
