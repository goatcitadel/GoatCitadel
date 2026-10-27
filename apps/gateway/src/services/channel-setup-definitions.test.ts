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
        "channel.matrix",
        "channel.qqbot",
        "channel.wecom",
        "channel.imessage",
        "channel.nextcloud-talk",
        "channel.line",
        "channel.zalo",
      ]),
    );
    expect(catalogIds).not.toContain("channel.zalouser");
  });

  it("exposes a guided test step followed by a confirm step for every guided definition", () => {
    for (const definition of listChannelSetupDefinitions()) {
      if (!definition.catalog.supportedModes.includes("guided")) {
        continue;
      }
      const steps = definition.wizard.steps;
      const testIndex = steps.findIndex((step) => step.kind === "test");
      expect(testIndex, `${definition.catalog.catalogId} has no guided test step`).toBeGreaterThanOrEqual(0);
      const confirmIndex = steps.findIndex((step) => step.kind === "confirm");
      expect(
        confirmIndex,
        `${definition.catalog.catalogId} has no guided confirm step, so Finalize is unreachable in guided mode`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        confirmIndex,
        `${definition.catalog.catalogId} places its confirm step before its test step`,
      ).toBeGreaterThan(testIndex);
    }
  });

  it("publishes a Telegram guide for changing a channel that is already on, never for making one", () => {
    const definition = requireChannelSetupDefinition("channel.telegram").definition;
    const steps = definition.wizard.steps;
    const text = (id: string) => JSON.stringify(steps.find((step) => step.id === id));
    const fields = steps.flatMap((step) => step.fields ?? []);
    const field = (key: string) => fields.find((candidate) => candidate.key === key);

    // A new bot is made in Chat › Messaging, so the guide neither makes one nor asks for one first.
    expect(definition.wizard.introSummary).toContain("Chat › Messaging");
    expect(definition.wizard.prerequisites[0]).toContain("already on");
    expect(text("overview")).toContain("Chat › Messaging");
    expect(steps.map((step) => step.id)).not.toContain("create-bot");
    // Groups are optional, come before the step that finds them, and say why a message must come first.
    const groups = steps.findIndex((step) => step.id === "destination");
    expect(groups).toBeGreaterThanOrEqual(0);
    expect(groups).toBeLessThan(steps.findIndex((step) => step.id === "collect-values-destinations"));
    expect(steps[groups]?.title).toContain("(optional)");
    expect(text("destination")).toContain("after the bot has seen a message");
    expect(text("destination")).toMatch(/\/setprivacy.*add the bot to the group again/u);
    // No step makes anyone tick boxes before they can go on.
    expect(steps.filter((step) => step.checklist?.length)).toEqual([]);
    // The saved key stays unless a new one is typed; names the setup fills in sit with the expert options.
    expect(field("botToken")?.explanation).toContain("Leave this empty to keep the key that's saved");
    expect(["botUsername", "setupCode", "defaultChatId"].map((key) => field(key)?.advanced)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("publishes complete Discord gateway setup and safety guidance", () => {
    const definition = requireChannelSetupDefinition("channel.discord").definition;
    const createBot = definition.wizard.steps.find((step) => step.id === "create-bot");
    const installBot = definition.wizard.steps.find((step) => step.id === "install-bot");
    const collectValues = definition.wizard.steps.find((step) => step.id === "collect-values-destinations");
    const testStep = definition.wizard.steps.find((step) => step.id === "test");
    const finishStep = definition.wizard.steps.find((step) => step.id === "finish");
    const content = JSON.stringify(definition.wizard);

    expect(createBot?.checklist?.map((item) => item.id)).toContain("message-content-intent");
    expect(content).toContain("Message Content Intent");
    expect(JSON.stringify(installBot)).toMatch(/View Channel.*Send Messages.*Read Message History/);
    expect(JSON.stringify(collectValues)).toContain("@mention");
    expect(JSON.stringify(testStep)).toMatch(/posts a visible sandbox message.*deletes it/);
    expect(JSON.stringify(finishStep)).toContain("pending code");

    const defaultGuildId = collectValues?.fields?.find((field) => field.key === "defaultGuildId");
    expect(defaultGuildId).toMatchObject({ type: "id", required: false });
    expect(defaultGuildId?.explanation).toMatch(/Required for the recommended server allowlist path/);
    expect(definition.validation.validationVersion).toBe("2026.08.discord.v3");
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

  it("keeps ntfy setup outbound-first with env-backed token hydration and dry-run defaults", () => {
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

  it("collects optional ntfy inbound fields, requires a token for them and seeds the topic sender", () => {
    const definition = requireChannelSetupDefinition("channel.ntfy");
    const fieldKeys = definition.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((f) => f.key));
    expect(fieldKeys).toEqual(expect.arrayContaining(["inboundStreamEnabled", "subscribeTopic"]));

    const noToken = createDraft("channel.ntfy", {
      baseUrl: "https://ntfy.example.com",
      topic: "ops",
      inboundStreamEnabled: true,
    });
    expect(definition.validate(noToken)).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldKey: "tokenEnv", failureCategory: "missing_input" })]),
    );

    const withToken = createDraft("channel.ntfy", {
      baseUrl: "https://ntfy.example.com",
      topic: "ops",
      tokenEnv: "NTFY_TOKEN",
      inboundStreamEnabled: true,
      subscribeTopic: "inbox",
    });
    expect(definition.validate(withToken)).toEqual([]);
    expect(definition.normalize(withToken)).toMatchObject({
      inboundStreamEnabled: true,
      subscribeTopic: "inbox",
      inboundAccessMode: "allowlist",
      allowedSenders: ["ntfy-topic:inbox"],
    });

    const outboundOnly = definition.normalize(
      createDraft("channel.ntfy", { baseUrl: "https://ntfy.example.com", topic: "ops" }),
    );
    expect(outboundOnly).not.toHaveProperty("inboundStreamEnabled");
    expect(outboundOnly).not.toHaveProperty("allowedSenders");
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

  it("routes guided ntfy setup through a live test step before the finalize confirmation", () => {
    const definition = requireChannelSetupDefinition("channel.ntfy").definition;

    expect(definition.wizard.steps.map((step) => step.kind)).toEqual([
      "intro",
      "instruction",
      "field-collection",
      "field-collection",
      "field-collection",
      "test",
      "confirm",
      "instruction",
    ]);
    const testStep = definition.wizard.steps.find((step) => step.kind === "test");
    expect(testStep?.title).toBe("Validate the draft");
    expect(JSON.stringify(testStep)).toMatch(/dry-run/i);
    expect(definition.wizard.contentVersion).toBe("2026.10.ntfy.stream.v3.guided-2026-10");
  });

  it("gives guided Nextcloud Talk setup a test step and a finalize confirmation step", () => {
    const definition = requireChannelSetupDefinition("channel.nextcloud-talk").definition;

    expect(definition.wizard.steps.map((step) => step.kind)).toEqual([
      "intro",
      "field-collection",
      "field-collection",
      "field-collection",
      "test",
      "confirm",
      "instruction",
    ]);
    const testStep = definition.wizard.steps.find((step) => step.kind === "test");
    expect(testStep?.title).toBe("Validate the draft");
    expect(JSON.stringify(testStep)).toMatch(/room/i);
    expect(definition.testing.levels).toContain("live-send");
    expect(definition.wizard.contentVersion).toBe("2026.08.nextcloud-talk.v2.guided-2026-10");
  });

  it("ends every previously test-terminal guided wizard on a finalize confirmation step", () => {
    const expectations = [
      { catalogId: "channel.imessage", contentVersion: "2026.08.imessage.v2" },
      { catalogId: "channel.line", contentVersion: "2026.08.line.v2" },
      { catalogId: "channel.mattermost", contentVersion: "2026.10.mattermost.stream.v3" },
      { catalogId: "channel.signal", contentVersion: "2026.10.signal.stream.v5" },
      { catalogId: "channel.whatsapp", contentVersion: "2026.08.whatsapp.v3" },
      { catalogId: "channel.zalo", contentVersion: "2026.08.zalo.v2" },
    ] as const;

    for (const { catalogId, contentVersion } of expectations) {
      const definition = requireChannelSetupDefinition(catalogId).definition;
      const steps = definition.wizard.steps;
      const finishStep = steps[steps.length - 2];
      expect(steps.at(-1)?.stage).toBe("first_message");
      expect(finishStep?.kind, `${catalogId} must end on a confirm step`).toBe("confirm");
      expect(finishStep?.id, `${catalogId} finalize step id`).toBe("finish");
      expect(steps[steps.length - 3]?.kind, `${catalogId} keeps its test step just before finalize`).toBe("test");
      expect(
        finishStep?.successCriteria?.length ?? 0,
        `${catalogId} confirm step needs success criteria`,
      ).toBeGreaterThan(0);
      expect(definition.wizard.contentVersion, `${catalogId} contentVersion must be bumped`).toBe(
        contentVersion + ".guided-2026-10",
      );
    }
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
          slackTeamId: "T123",
          slackAppId: "A123",
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
        slackTeamId: "T123",
        slackAppId: "A123",
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

  it("collects Google Chat app (service-account) fields and forces a default-deny sender allowlist", () => {
    const definition = requireChannelSetupDefinition("channel.google-chat");
    expect(definition.definition.wizard.contentVersion).toBe("2026.10.google-chat.app.v2.guided-2026-10");
    expect(definition.definition.adapter.adapterVersion).toBe("2026.10.google-chat.app.v2");
    expect(definition.definition.validation.validationVersion).toBe("2026.10.google-chat.app.v2");
    const fieldKeys = definition.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((f) => f.key));
    expect(fieldKeys).toEqual(
      expect.arrayContaining([
        "webhookUrl",
        "serviceAccountKeyEnv",
        "audienceType",
        "audience",
        "defaultSpace",
        "inboundAccessMode",
        "allowedSenders",
      ]),
    );
    expect(JSON.stringify(definition.definition)).not.toContain("cannot accept an inbound conversation");

    const appDraft = createDraft("channel.google-chat", {
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audienceType: "project_number",
      audience: "123456789012",
      defaultSpace: "spaces/AAAA",
    });
    expect(definition.validate(appDraft)).toEqual([]);
    expect(definition.normalize(appDraft)).toEqual({
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audienceType: "project_number",
      audience: "123456789012",
      defaultSpace: "spaces/AAAA",
      inboundAccessMode: "allowlist",
    });

    // An edited legacy connection hydrated as open_legacy never carries that posture into app inbound.
    const edited = {
      ...createDraft("channel.google-chat", { ...appDraft.draft, inboundAccessMode: "open_legacy" }, "edit"),
      connectionId: "11111111-1111-1111-1111-111111111111",
    };
    expect(definition.normalize(edited)).toMatchObject({ inboundAccessMode: "allowlist" });

    expect(
      definition.validate(createDraft("channel.google-chat", { serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY" })),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldKey: "audience", failureCategory: "missing_input" })]),
    );
    expect(
      definition.validate(
        createDraft("channel.google-chat", {
          serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
          audienceType: "project_number",
          audience: "not-a-number",
          defaultSpace: "rooms/x",
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldKey: "audience", failureCategory: "malformed_value" }),
        expect.objectContaining({ fieldKey: "defaultSpace", failureCategory: "malformed_value" }),
      ]),
    );
    expect(
      definition.validate(
        createDraft("channel.google-chat", {
          serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
          audienceType: "endpoint_url",
          audience: "http://insecure.example.test/hook",
        }),
      ),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldKey: "audience", failureCategory: "malformed_value" })]),
    );
    expect(definition.validate(createDraft("channel.google-chat", {}))).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldKey: "webhookUrl", failureCategory: "missing_input" })]),
    );
  });

  it("collects and validates the optional Workspace add-on project number", () => {
    const definition = requireChannelSetupDefinition("channel.google-chat");
    const fieldKeys = definition.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((f) => f.key));
    expect(fieldKeys).toContain("addOnProjectNumber");
    const endpointApp = {
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      audienceType: "endpoint_url",
      audience: "https://gateway.example.test/api/v1/integrations/connections/c/google-chat/webhook",
    };

    const addOnDraft = createDraft("channel.google-chat", { ...endpointApp, addOnProjectNumber: "987654321098" });
    expect(definition.validate(addOnDraft)).toEqual([]);
    expect(definition.normalize(addOnDraft)).toMatchObject({ addOnProjectNumber: "987654321098" });
    expect(
      definition.hydrate({ config: { ...endpointApp, addOnProjectNumber: "987654321098" } } as never).draft,
    ).toMatchObject({ addOnProjectNumber: "987654321098" });

    // A project ID (name) instead of the numeric project number is malformed.
    expect(
      definition.validate(createDraft("channel.google-chat", { ...endpointApp, addOnProjectNumber: "my-project" })),
    ).toEqual([expect.objectContaining({ fieldKey: "addOnProjectNumber", failureCategory: "malformed_value" })]);
    // Add-on Chat apps use the endpoint URL audience only.
    expect(
      definition.validate(
        createDraft("channel.google-chat", {
          serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
          audienceType: "project_number",
          audience: "123456789012",
          addOnProjectNumber: "987654321098",
        }),
      ),
    ).toEqual([expect.objectContaining({ fieldKey: "addOnProjectNumber", failureCategory: "malformed_value" })]);
    // Webhook mode never carries the add-on field.
    expect(
      definition.normalize(
        createDraft("channel.google-chat", {
          webhookUrl: "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t",
          addOnProjectNumber: "987654321098",
        }),
      ),
    ).not.toHaveProperty("addOnProjectNumber");
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

  it("advertises Signal daemon-event inbound with no-replay honesty and strips legacy polling settings", () => {
    const signal = requireChannelSetupDefinition("channel.signal");
    const wizardText = JSON.stringify(signal.definition.wizard);

    expect(signal.definition.wizard.contentVersion).toBe("2026.10.signal.stream.v5.guided-2026-10");
    expect(signal.definition.wizard.introSummary).not.toContain("outbound-only");
    expect(wizardText).not.toMatch(/outbound-only|destructive receive/i);
    expect(wizardText).toContain("signal-cli daemon --http");
    expect(wizardText).toMatch(/not replayed/);
    expect(wizardText).toContain('"key":"receiveEvents"');
    expect(wizardText).not.toContain('"key":"inboundEnabled"');
    expect(wizardText).not.toContain('"key":"pollIntervalSeconds"');

    const hydrated = signal.hydrate(
      createConnection({
        catalogId: "channel.signal",
        key: "signal",
        config: {
          baseUrl: "http://127.0.0.1:8080",
          accountId: "+15551234567",
          defaultRecipient: "+15557654321",
          inboundEnabled: true,
          pollIntervalSeconds: 5,
        },
      }),
    );

    expect(hydrated.draft).not.toHaveProperty("inboundEnabled");
    expect(hydrated.draft).not.toHaveProperty("pollIntervalSeconds");
    expect(hydrated.draft).toMatchObject({
      baseUrl: "http://127.0.0.1:8080",
      accountId: "+15551234567",
      defaultRecipient: "+15557654321",
      receiveEvents: false,
    });
    expect(hydrated.hydration.warnings).toEqual([expect.stringContaining("replaced by receiveEvents")]);
    const normalized = signal.normalize({
      ...createDraft("channel.signal", hydrated.draft, "edit"),
      hydration: hydrated.hydration,
    });
    expect(normalized).not.toHaveProperty("inboundEnabled");
    expect(normalized).not.toHaveProperty("pollIntervalSeconds");
    expect(normalized).not.toHaveProperty("receiveEvents");

    const legacyIssues = signal.validate(
      createDraft("channel.signal", {
        baseUrl: "http://127.0.0.1:8080",
        defaultRecipient: "+15557654321",
        inboundEnabled: true,
        pollIntervalSeconds: 5,
      }),
    );
    expect(legacyIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldKey: "inboundEnabled",
          failureCategory: "malformed_value",
          message: expect.stringContaining("receiveEvents"),
        }),
        expect.objectContaining({ fieldKey: "pollIntervalSeconds", failureCategory: "malformed_value" }),
      ]),
    );
    expect(
      signal.validate(
        createDraft("channel.signal", {
          baseUrl: "http://127.0.0.1:8080",
          defaultRecipient: "+15557654321",
        }),
      ),
    ).toEqual([]);
  });

  it("collects the Signal receiveEvents opt-in and forces a default-deny allowlist when it is on", () => {
    const signal = requireChannelSetupDefinition("channel.signal");
    const fieldKeys = signal.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((f) => f.key));
    expect(fieldKeys).toEqual(expect.arrayContaining(["receiveEvents", "allowedSenders"]));

    for (const legacy of [{ inboundAccessMode: "open_legacy" }, {}]) {
      const hydrated = signal.hydrate(
        createConnection({
          catalogId: "channel.signal",
          key: "signal",
          config: { baseUrl: "http://127.0.0.1:8080", defaultRecipient: "+15557654321", ...legacy },
        }),
      );
      const draft = {
        ...createDraft("channel.signal", { ...hydrated.draft, receiveEvents: true }, "edit"),
        hydration: hydrated.hydration,
      };
      expect(signal.validate(draft)).toEqual([]);
      expect(signal.normalize(draft)).toMatchObject({ receiveEvents: true, inboundAccessMode: "allowlist" });
    }
    const created = signal.normalize(
      createDraft("channel.signal", {
        baseUrl: "http://127.0.0.1:8080",
        defaultRecipient: "+15557654321",
        receiveEvents: true,
      }),
    );
    expect(created).toMatchObject({ receiveEvents: true, inboundAccessMode: "allowlist" });
    expect(created.allowedSenders ?? []).toEqual([]);
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

  it("collects the Mattermost inbound opt-in and defaults new guided setups to a default-deny allowlist", () => {
    const definition = requireChannelSetupDefinition("channel.mattermost");
    const fieldKeys = definition.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((f) => f.key));
    expect(fieldKeys).toEqual(expect.arrayContaining(["inboundStreamEnabled", "allowedSenders"]));

    const draft = createDraft("channel.mattermost", {
      serverUrl: "https://chat.example.com",
      botTokenEnv: "MATTERMOST_BOT_TOKEN",
      defaultChannel: "town-square",
      inboundStreamEnabled: true,
    });
    expect(definition.validate(draft)).toEqual([]);
    const normalized = definition.normalize(draft);
    expect(normalized).toMatchObject({ inboundStreamEnabled: true, inboundAccessMode: "allowlist" });
    expect(normalized.allowedSenders ?? []).toEqual([]);

    const outboundOnly = definition.normalize(
      createDraft("channel.mattermost", {
        serverUrl: "https://chat.example.com",
        botTokenEnv: "MATTERMOST_BOT_TOKEN",
        defaultChannel: "town-square",
      }),
    );
    expect(outboundOnly).not.toHaveProperty("inboundStreamEnabled");
  });

  it("ends in allowlist when inbound is enabled on a migration-stamped open_legacy Mattermost connection", () => {
    const definition = requireChannelSetupDefinition("channel.mattermost");
    for (const legacy of [{ inboundAccessMode: "open_legacy" }, {}]) {
      const hydrated = definition.hydrate(
        createConnection({
          catalogId: "channel.mattermost",
          key: "mattermost",
          label: "Mattermost Primary",
          config: {
            serverUrl: "https://chat.example.com",
            botTokenEnv: "MATTERMOST_BOT_TOKEN",
            defaultChannel: "town-square",
            ...legacy,
          },
        }),
      );
      const draft = {
        ...createDraft("channel.mattermost", { ...hydrated.draft, inboundStreamEnabled: true }, "edit"),
        hydration: hydrated.hydration,
      };
      expect(definition.validate(draft)).toEqual([]);
      expect(definition.normalize(draft)).toMatchObject({
        inboundStreamEnabled: true,
        inboundAccessMode: "allowlist",
      });
    }
  });

  it("collects the Matrix inbound opt-in and forces a default-deny allowlist when opted in", () => {
    const definition = requireChannelSetupDefinition("channel.matrix");
    const fieldKeys = definition.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((f) => f.key));
    expect(fieldKeys).toEqual(expect.arrayContaining(["homeserverUrl", "inboundStreamEnabled", "allowedSenders"]));

    const draft = createDraft("channel.matrix", {
      homeserverUrl: "https://matrix.example.com",
      accessTokenEnv: "MATRIX_ACCESS_TOKEN",
      inboundStreamEnabled: true,
    });
    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toMatchObject({
      homeserverUrl: "https://matrix.example.com",
      accessTokenEnv: "MATRIX_ACCESS_TOKEN",
      inboundStreamEnabled: true,
      inboundAccessMode: "allowlist",
    });

    const outboundOnly = definition.normalize(
      createDraft("channel.matrix", {
        homeserverUrl: "https://matrix.example.com",
        accessTokenEnv: "MATRIX_ACCESS_TOKEN",
      }),
    );
    expect(outboundOnly).not.toHaveProperty("inboundStreamEnabled");
  });

  it("hydrates a legacy-open Matrix connection into an allowlist once inbound is enabled", () => {
    const definition = requireChannelSetupDefinition("channel.matrix");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.matrix",
        key: "matrix",
        label: "Matrix Primary",
        config: {
          homeserverUrl: "https://matrix.example.com",
          accessTokenEnv: "MATRIX_ACCESS_TOKEN",
          inboundAccessMode: "open_legacy",
        },
      }),
    );
    const draft = {
      ...createDraft("channel.matrix", { ...hydrated.draft, inboundStreamEnabled: true }, "edit"),
      hydration: hydrated.hydration,
    };
    expect(definition.validate(draft)).toEqual([]);
    expect(definition.normalize(draft)).toMatchObject({
      accessTokenEnv: "MATRIX_ACCESS_TOKEN",
      inboundStreamEnabled: true,
      inboundAccessMode: "allowlist",
    });
  });

  it("requires a homeserver URL and an access token for Matrix", () => {
    const definition = requireChannelSetupDefinition("channel.matrix");
    const issues = definition.validate(createDraft("channel.matrix", {}));
    expect(issues.map((issue) => issue.key)).toEqual(
      expect.arrayContaining(["homeserverUrl_required", "matrix_auth_missing"]),
    );
  });

  it("hydrates a legacy QQBot tokenEnv as appSecretEnv and forces a default-deny allowlist", () => {
    const definition = requireChannelSetupDefinition("channel.qqbot");
    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.qqbot",
        key: "qqbot",
        label: "QQBot Primary",
        config: {
          appId: "102000",
          tokenEnv: "QQBOT_TOKEN",
          defaultTarget: "user:U1",
          inboundAccessMode: "open_legacy",
        },
      }),
    );
    expect(hydrated.draft).toMatchObject({ appId: "102000", appSecretEnv: "QQBOT_TOKEN", defaultTarget: "user:U1" });
    expect(hydrated.draft).not.toHaveProperty("tokenEnv");
    expect(hydrated.draft.inboundAccessMode).toBe("allowlist");
    const draft = { ...createDraft("channel.qqbot", hydrated.draft, "edit"), hydration: hydrated.hydration };
    expect(definition.validate(draft)).toEqual([]);
    const normalized = definition.normalize(draft);
    expect(normalized).toMatchObject({
      appId: "102000",
      appSecretEnv: "QQBOT_TOKEN",
      defaultTarget: "user:U1",
      inboundAccessMode: "allowlist",
    });
    expect(normalized).not.toHaveProperty("tokenEnv");
  });

  it("drops the legacy QQBot direct secret when the draft rotates to an env reference", () => {
    const definition = requireChannelSetupDefinition("channel.qqbot");
    const hydration = definition.hydrate(
      createConnection({
        catalogId: "channel.qqbot",
        key: "qqbot",
        label: "QQBot Primary",
        config: { appId: "102000", appSecret: "old-direct-secret" },
      }),
    ).hydration;
    const rotated = {
      ...createDraft("channel.qqbot", { appId: "102000", appSecretEnv: "QQBOT_NEW" }, "edit"),
      hydration,
    };
    const normalized = definition.normalize(rotated);
    expect(normalized).toMatchObject({ appSecretEnv: "QQBOT_NEW" });
    expect(normalized).not.toHaveProperty("appSecret");
    const untouched = { ...createDraft("channel.qqbot", { appId: "102000" }, "edit"), hydration };
    expect(definition.normalize(untouched)).toMatchObject({ appSecret: "old-direct-secret" });
  });

  it("drops a legacy WeCom direct value per pair when the draft supplies the env form", () => {
    const definition = requireChannelSetupDefinition("channel.wecom");
    const hydration = definition.hydrate(
      createConnection({
        catalogId: "channel.wecom",
        key: "wecom",
        label: "WeCom Primary",
        config: { corpId: "ww1", agentId: "1000002", secret: "old-direct", encodingAesKey: "k".repeat(43) },
      }),
    ).hydration;
    const rotated = {
      ...createDraft("channel.wecom", { corpId: "ww1", agentId: "1000002", secretEnv: "WECOM_NEW" }, "edit"),
      hydration,
    };
    const normalized = definition.normalize(rotated);
    expect(normalized).toMatchObject({ secretEnv: "WECOM_NEW", encodingAesKey: "k".repeat(43) });
    expect(normalized).not.toHaveProperty("secret");
  });

  it("collects QQBot values, requires an app id and secret, and validates the target prefix", () => {
    const definition = requireChannelSetupDefinition("channel.qqbot");
    const fieldKeys = definition.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((f) => f.key));
    expect(fieldKeys).toEqual(
      expect.arrayContaining(["appId", "appSecretEnv", "defaultTarget", "sandbox", "allowedSenders"]),
    );
    const ok = createDraft("channel.qqbot", { appId: "102000", appSecretEnv: "QQBOT_APP_SECRET", sandbox: true });
    expect(definition.validate(ok)).toEqual([]);
    expect(definition.normalize(ok)).toMatchObject({
      appId: "102000",
      appSecretEnv: "QQBOT_APP_SECRET",
      sandbox: true,
      inboundAccessMode: "allowlist",
    });
    const empty = definition.validate(createDraft("channel.qqbot", {}));
    expect(empty.map((issue) => issue.key)).toEqual(expect.arrayContaining(["appId_required", "qqbot_auth_missing"]));
    const badTarget = definition.validate(
      createDraft("channel.qqbot", { appId: "1", appSecretEnv: "QQBOT_APP_SECRET", defaultTarget: "guild:1" }),
    );
    expect(badTarget.map((issue) => issue.key)).toContain("defaultTarget_malformed");
    const copy = JSON.stringify(definition.definition.wizard);
    expect(copy).toContain("/qqbot/webhook");
    expect(copy).toMatch(/default-deny/);
    expect(copy).not.toMatch(/anyone can/i);
  });

  it("collects WeCom values, keeps callback credentials opaque, and forces a default-deny allowlist", () => {
    const definition = requireChannelSetupDefinition("channel.wecom");
    const fieldKeys = definition.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((f) => f.key));
    expect(fieldKeys).toEqual(
      expect.arrayContaining([
        "corpId",
        "agentId",
        "secretEnv",
        "callbackTokenEnv",
        "encodingAesKeyEnv",
        "allowedSenders",
      ]),
    );
    const ok = createDraft("channel.wecom", {
      corpId: "ww1",
      agentId: "1000002",
      secretEnv: "WECOM_SECRET",
      callbackTokenEnv: "WECOM_CALLBACK_TOKEN",
      encodingAesKeyEnv: "WECOM_ENCODING_AES_KEY",
    });
    expect(definition.validate(ok)).toEqual([]);
    expect(definition.normalize(ok)).toMatchObject({
      corpId: "ww1",
      agentId: "1000002",
      secretEnv: "WECOM_SECRET",
      callbackTokenEnv: "WECOM_CALLBACK_TOKEN",
      encodingAesKeyEnv: "WECOM_ENCODING_AES_KEY",
      inboundAccessMode: "allowlist",
    });
    const empty = definition.validate(createDraft("channel.wecom", { agentId: "abc" }));
    expect(empty.map((issue) => issue.key)).toEqual(
      expect.arrayContaining(["corpId_required", "agentId_malformed", "wecom_auth_missing"]),
    );

    const hydrated = definition.hydrate(
      createConnection({
        catalogId: "channel.wecom",
        key: "wecom",
        label: "WeCom Primary",
        config: {
          corpId: "ww1",
          agentId: 1000002,
          secretEnv: "WECOM_SECRET",
          encodingAesKey: "k".repeat(43),
          inboundAccessMode: "open_legacy",
        },
      }),
    );
    expect(hydrated.draft).toMatchObject({ corpId: "ww1", agentId: "1000002", secretEnv: "WECOM_SECRET" });
    expect(JSON.stringify(hydrated.draft)).not.toContain("kkkk");
    expect(hydrated.hydration.fieldState.encodingAesKey).toBe("configured");
    const draft = { ...createDraft("channel.wecom", hydrated.draft, "edit"), hydration: hydrated.hydration };
    expect(definition.validate(draft)).toEqual([]);
    const normalized = definition.normalize(draft);
    expect(normalized).toMatchObject({ encodingAesKey: "k".repeat(43), inboundAccessMode: "allowlist" });
    const copy = JSON.stringify(definition.definition.wizard);
    expect(copy).toContain("/wecom/webhook");
    expect(copy).toMatch(/default-deny/);
    expect(copy).not.toMatch(/anyone can/i);
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
    // Google Chat inbound is always forced allowlist, so even a legacy webhook row never hydrates as open_legacy.
    expect(googleHydrated.draft).toMatchObject({ defaultThreadKey: "ops-thread", inboundAccessMode: "allowlist" });
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
      inboundAccessMode: "allowlist",
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
      // Signal is a guided inbound channel; a draft with no saved mode defaults to the allowlist.
      inboundAccessMode: "allowlist",
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
      "channel.matrix",
      "channel.qqbot",
      "channel.wecom",
      "channel.imessage",
      "channel.line",
      "channel.zalo",
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
      "channel.matrix",
      "channel.qqbot",
      "channel.wecom",
      "channel.imessage",
      "channel.line",
    ] as const;

    for (const catalogId of channels) {
      const definition = requireChannelSetupDefinition(catalogId);
      expect(definition.definition.testing.levels).toContain("live-auth");
    }
  });

  it("keeps guided channel copy out of the old planned-parity wording for visible built-in channels", () => {
    const channels = [
      "channel.whatsapp",
      "channel.mattermost",
      "channel.matrix",
      "channel.qqbot",
      "channel.wecom",
      "channel.line",
    ] as const;

    for (const catalogId of channels) {
      const definition = requireChannelSetupDefinition(catalogId);
      expect(JSON.stringify(definition.definition)).not.toMatch(/planned parity work|still counts as planned/i);
    }
  });
});
