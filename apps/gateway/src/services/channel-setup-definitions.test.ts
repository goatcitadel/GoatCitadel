import { describe, expect, it } from "vitest";
import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupFieldDefinition,
  ChannelSetupStepDefinition,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { listChannelSetupDefinitions, requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import type { ChannelSetupRuntimeDefinition } from "./channel-setup-definitions.js";
import { plainSecretLabel, requireSecureUrl, secretNameForVariable } from "./channel-setup-definitions/common.js";
import { withGuidedJourney } from "./channel-setup-definitions/guided-journey.js";
import { createLineDefinition } from "./channel-setup-definitions/line.js";
import { isAllowedSecretEnvName } from "./channel-secret-resolution.js";
import { isPermittedIntegrationSecretEnvVarName } from "./gateway/integration-secret-envvar-guard.js";

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
        "channel.mattermost",
        "channel.matrix",
        "channel.qqbot",
        "channel.wecom",
        "channel.nextcloud-talk",
        "channel.line",
        "channel.zalo",
      ]),
    );
    expect(catalogIds).not.toContain("channel.zalouser");
    expect(catalogIds).not.toContain("channel.signal");
    expect(catalogIds).not.toContain("channel.imessage");
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
    expect(JSON.stringify(testStep)).toMatch(/posts one visible test message.*deletes it/);
    expect(JSON.stringify(finishStep)).toContain("pending code");

    const defaultGuildId = collectValues?.fields?.find((field) => field.key === "defaultGuildId");
    expect(defaultGuildId).toMatchObject({ type: "id", required: true });
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
      { catalogId: "channel.line", contentVersion: "2026.08.line.v2" },
      { catalogId: "channel.mattermost", contentVersion: "2026.10.mattermost.stream.v3" },
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
        "allowedSenders",
      ]),
    );
    // The runtime always enforces the allowlist here, so the guide offers no access-mode choice.
    expect(fieldKeys).not.toContain("inboundAccessMode");
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
      "channel.mattermost",
      "channel.matrix",
      "channel.qqbot",
      "channel.wecom",
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

  it("marks the steps that are only for setting a channel up, and no others", () => {
    const setupOnly: Record<string, string[]> = {
      discord: ["overview", "prerequisites", "create-bot", "install-bot"],
      slack: ["overview", "prerequisites", "create-app"],
      telegram: [],
      ntfy: ["overview", "prepare-topic"],
      "google-chat": ["overview", "create-webhook"],
      teams: ["overview", "create-webhook"],
      whatsapp: ["overview"],
      mattermost: ["overview"],
      matrix: ["overview"],
      qqbot: ["overview"],
      wecom: ["overview"],
      "nextcloud-talk": ["overview"],
      line: ["overview", "create-account"],
      zalo: ["overview"],
    };
    const definitions = listChannelSetupDefinitions();

    expect(definitions.map((definition) => definition.catalog.key).sort()).toEqual(Object.keys(setupOnly).sort());
    for (const definition of definitions) {
      const key = definition.catalog.key;
      const createOnlyIds = definition.wizard.steps.filter((step) => step.createOnly).map((step) => step.id);
      expect(createOnlyIds, `${key} setup-only steps`).toEqual(setupOnly[key]);
    }
  });

  it("keeps Telegram's overview visible when a saved channel is changed", () => {
    const overview = requireChannelSetupDefinition("channel.telegram").definition.wizard.steps.find(
      (step) => step.id === "overview",
    );

    expect(overview?.title).toBe("What you can change here");
    expect(overview?.createOnly).toBeUndefined();
  });
});

type FieldCondition = { fieldKey: string; value: string | boolean } | undefined;

function allFields(definition: ChannelSetupDefinition): ChannelSetupFieldDefinition[] {
  return definition.wizard.steps.flatMap((step) => step.fields ?? []);
}

/** The wizard's own rule: a field's default counts until the draft sets a value. */
function shownWith(
  definition: ChannelSetupDefinition,
  condition: FieldCondition,
  values: Record<string, unknown> = {},
): boolean {
  const defaults = Object.fromEntries(
    allFields(definition)
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.key, field.defaultValue]),
  );
  const effective: Record<string, unknown> = { ...defaults, ...values };
  return !condition || effective[condition.fieldKey] === condition.value;
}

function guide(key: string): ChannelSetupDefinition {
  return requireChannelSetupDefinition(`channel.${key}`).definition;
}

function senderStep(key: string): ChannelSetupStepDefinition | undefined {
  return guide(key).wizard.steps.find((step) => step.id === "sender-access");
}

function fieldOf(key: string, fieldKey: string): ChannelSetupFieldDefinition | undefined {
  return allFields(guide(key)).find((field) => field.key === fieldKey);
}

/** Fields that name an environment variable holding a secret the guide can also take pasted. */
function secretEnvFields(definition: ChannelSetupDefinition): ChannelSetupFieldDefinition[] {
  return allFields(definition).filter(
    (field) => field.key.endsWith("Env") && definition.adapter.secretFieldKeys.includes(field.key.slice(0, -3)),
  );
}

/** Env fields the inbound webhook reads through the stricter suffix check in channel-secret-resolution.ts. */
const INBOUND_WEBHOOK_SECRET_ENV_FIELDS: Record<string, string[]> = {
  telegram: ["webhookSecretEnv"],
  whatsapp: ["appSecretEnv", "webhookVerifyTokenEnv"],
  line: ["channelSecretEnv"],
  "nextcloud-talk": ["tokenEnv"],
  qqbot: ["appSecretEnv"],
  wecom: ["callbackTokenEnv", "encodingAesKeyEnv"],
};

/** Set when a connection that was saved with open access is loaded, so the open-access choice stays on screen. */
const OPEN_MARKER_KEY = "inboundAccessWasOpen";
const OPEN_MARKER = { [OPEN_MARKER_KEY]: true };

const ENV_RULE_PATTERN =
  /The variable's name must start with ([A-Z0-9_]+)_ \(for example ([A-Z0-9_]+)\)\. Set it where GoatCitadel starts, then restart GoatCitadel\.( It must also end in (_TOKEN or _SECRET|_AES_KEY)\.)?$/u;

describe("the shared guide builder", () => {
  describe("environment-variable fields (A5)", () => {
    it("moves every environment-variable field to the expert options and states the variable's name rules", () => {
      let checked = 0;
      for (const definition of listChannelSetupDefinitions()) {
        const key = definition.catalog.key;
        for (const field of secretEnvFields(definition)) {
          checked += 1;
          const where = `${key}.${field.key}`;
          expect(field.advanced, `${where} is an expert option`).toBe(true);
          expect(field.label, where).toMatch(/ from an environment variable \(advanced\)$/u);
          expect(field.explanation, `${where} no longer calls itself the preferred path`).not.toMatch(
            /preferred path/iu,
          );
          const rule = ENV_RULE_PATTERN.exec(field.explanation);
          expect(rule, `${where} explanation ends with the name rule`).not.toBeNull();
          const [, prefix, example, , suffixes] = rule ?? [];
          expect(prefix, where).toBe(key.toUpperCase().replaceAll("-", "_"));
          // The example is the variable name a person would copy, so the Gateway must accept it.
          expect(isPermittedIntegrationSecretEnvVarName(example ?? "", definition.catalog.catalogId), where).toBe(true);
          const isInbound = INBOUND_WEBHOOK_SECRET_ENV_FIELDS[key]?.includes(field.key) ?? false;
          if (isInbound) {
            expect(isAllowedSecretEnvName(example ?? ""), `${where} example passes the inbound suffix check`).toBe(
              true,
            );
            expect(suffixes, `${where} names the suffix it needs`).toBeDefined();
            expect(
              (suffixes ?? "").split(" or ").some((suffix) => (example ?? "").endsWith(suffix)),
              `${where} example ends the way the explanation says`,
            ).toBe(true);
          } else {
            expect(suffixes, `${where} needs no suffix`).toBeUndefined();
          }
        }
      }
      expect(checked).toBeGreaterThanOrEqual(17);
    });

    it("writes the shared rule with each channel's own prefix, example and suffix", () => {
      const rule = "Set it where GoatCitadel starts, then restart GoatCitadel.";
      expect(fieldOf("line", "channelAccessTokenEnv")?.label).toBe(
        "Channel access token from an environment variable (advanced)",
      );
      expect(fieldOf("line", "channelAccessTokenEnv")?.explanation).toBe(
        `Name of the env var that stores the LINE channel access token. The variable's name must start with LINE_ (for example LINE_CHANNEL_ACCESS_TOKEN). ${rule}`,
      );
      expect(fieldOf("line", "channelSecretEnv")?.explanation).toMatch(
        new RegExp(
          `The variable's name must start with LINE_ \\(for example LINE_CHANNEL_SECRET\\)\\. ${rule.replaceAll(".", "\\.")} It must also end in _TOKEN or _SECRET\\.$`,
          "u",
        ),
      );
      expect(fieldOf("nextcloud-talk", "tokenEnv")?.explanation).toContain(
        "must start with NEXTCLOUD_TALK_ (for example NEXTCLOUD_TALK_TOKEN)",
      );
      expect(fieldOf("google-chat", "serviceAccountKeyEnv")?.explanation).toContain(
        "must start with GOOGLE_CHAT_ (for example GOOGLE_CHAT_SERVICE_ACCOUNT_KEY)",
      );
      // The WeCom key is read by its own suffix, not _TOKEN or _SECRET.
      expect(fieldOf("wecom", "encodingAesKeyEnv")?.explanation).toMatch(
        /\(for example WECOM_ENCODING_AES_KEY\)\. Set it where GoatCitadel starts, then restart GoatCitadel\. It must also end in _AES_KEY\.$/u,
      );
      expect(fieldOf("whatsapp", "accessTokenEnv")?.explanation).toMatch(/restart GoatCitadel\.$/u);
    });

    it("names an environment-variable field after its pasted twin, or after its own label when it has none", () => {
      expect(fieldOf("matrix", "accessTokenEnv")?.label).toBe("Access token from an environment variable (advanced)");
      expect(fieldOf("wecom", "secretEnv")?.label).toBe("Application secret from an environment variable (advanced)");
      expect(fieldOf("wecom", "encodingAesKeyEnv")?.label).toBe(
        "EncodingAESKey from an environment variable (advanced)",
      );
      // ntfy has no pasted twin yet, so the label keeps its own words minus "env var".
      expect(fieldOf("ntfy", "tokenEnv")?.label).toBe("Token from an environment variable (advanced)");
      // Its pasted twin is "Service-account key (paste the JSON)", but the variable holds a name, not the JSON.
      expect(fieldOf("google-chat", "serviceAccountKeyEnv")?.label).toBe(
        "Service-account key from an environment variable (advanced)",
      );
      expect(fieldOf("google-chat", "serviceAccountKey")?.label).toBe("Service-account key (paste the JSON)");
    });

    it("keeps any paste hint out of the label of the field that takes a variable name", () => {
      const labels = listChannelSetupDefinitions().flatMap((definition) =>
        definition.wizard.steps
          .flatMap((step) => step.fields ?? [])
          .filter((field) => field.key.endsWith("Env"))
          .map((field) => field.label),
      );

      expect(labels.length).toBeGreaterThanOrEqual(17);
      for (const label of labels) expect(label, label).not.toMatch(/\(paste/iu);
    });

    it("leaves every other guide's variable label as it was", () => {
      const labels = Object.fromEntries(
        listChannelSetupDefinitions().flatMap((definition) =>
          definition.wizard.steps
            .flatMap((step) => step.fields ?? [])
            .filter((field) => field.key.endsWith("Env") && definition.catalog.key !== "google-chat")
            .map((field) => [`${definition.catalog.key}.${field.key}`, field.label]),
        ),
      );

      expect(labels).toMatchObject({
        "telegram.webhookSecretEnv": "Webhook secret from an environment variable (advanced)",
        "ntfy.tokenEnv": "Token from an environment variable (advanced)",
        "nextcloud-talk.tokenEnv": "Token from an environment variable (advanced)",
        "discord.botTokenEnv": "Bot token from an environment variable (advanced)",
        "whatsapp.accessTokenEnv": "Access token from an environment variable (advanced)",
        "whatsapp.appSecretEnv": "App secret from an environment variable (advanced)",
        "whatsapp.webhookVerifyTokenEnv": "Webhook verify token from an environment variable (advanced)",
        "mattermost.botTokenEnv": "Bot token from an environment variable (advanced)",
        "matrix.accessTokenEnv": "Access token from an environment variable (advanced)",
        "qqbot.appSecretEnv": "App secret from an environment variable (advanced)",
        "wecom.secretEnv": "Application secret from an environment variable (advanced)",
        "wecom.callbackTokenEnv": "Callback token from an environment variable (advanced)",
        "wecom.encodingAesKeyEnv": "EncodingAESKey from an environment variable (advanced)",
        "line.channelAccessTokenEnv": "Channel access token from an environment variable (advanced)",
        "line.channelSecretEnv": "Channel secret from an environment variable (advanced)",
        "zalo.accessTokenEnv": "Access token from an environment variable (advanced)",
      });
    });

    it("drops a trailing paste hint, and only that, from a secret's name for its variable field", () => {
      expect(secretNameForVariable("Service-account key (paste the JSON)")).toBe("Service-account key");
      expect(secretNameForVariable("Bot token (paste it)")).toBe("Bot token");
      expect(secretNameForVariable("Access token (Paste)")).toBe("Access token");
      expect(secretNameForVariable("Access token (manual fallback)")).toBe("Access token");
      // No hint: unchanged.
      expect(secretNameForVariable("Bot token")).toBe("Bot token");
      expect(secretNameForVariable("Channel access token")).toBe("Channel access token");
      // A parenthetical that does not describe pasting stays, and so does a hint that is not at the end.
      expect(secretNameForVariable("Webhook URL (send-only)")).toBe("Webhook URL (send-only)");
      expect(secretNameForVariable("Key (paste it) for sending")).toBe("Key (paste it) for sending");
      expect(secretNameForVariable("Pasted key")).toBe("Pasted key");
      // The pasted field itself keeps its hint.
      expect(plainSecretLabel("Service-account key (paste the JSON)")).toBe("Service-account key (paste the JSON)");
    });

    it("makes the pasted secret the first choice and says where it is kept", () => {
      let checked = 0;
      for (const definition of listChannelSetupDefinitions()) {
        for (const step of definition.wizard.steps) {
          const fields = step.fields ?? [];
          for (const envField of secretEnvFields(definition)) {
            const pastedIndex = fields.findIndex((field) => field.key === envField.key.slice(0, -3));
            if (pastedIndex < 0) continue;
            checked += 1;
            const where = `${definition.catalog.key}.${envField.key.slice(0, -3)}`;
            const pasted = fields[pastedIndex]!;
            expect(pastedIndex, `${where} comes before its environment-variable twin`).toBeLessThan(
              fields.findIndex((field) => field.key === envField.key),
            );
            expect(pasted.label, where).not.toMatch(/manual fallback/iu);
            expect(pasted.explanation, where).toBe(
              "Paste it here. GoatCitadel keeps it in this computer's secure storage.",
            );
            expect(pasted.placeholder, `${where} no longer says to paste only as a last resort`).toBeUndefined();
            expect(pasted.advanced, where).not.toBe(true);
            expect(pasted.required, where).toBe(false);
          }
        }
      }
      expect(checked).toBeGreaterThanOrEqual(15);
      expect(fieldOf("matrix", "accessToken")?.label).toBe("Access token");
      expect(fieldOf("wecom", "secret")?.label).toBe("Application secret");
      expect(fieldOf("whatsapp", "webhookVerifyToken")?.label).toBe("Webhook verify token");
      const lineKeys = (stepId: string) =>
        guide("line")
          .wizard.steps.find((step) => step.id === stepId)
          ?.fields?.map((field) => field.key);
      expect(lineKeys("collect-values-identity")).toEqual(["channelAccessToken", "channelAccessTokenEnv"]);
      expect(lineKeys("receive-messages")).toEqual(["channelSecret", "channelSecretEnv"]);
    });
  });

  describe("steps that are split, kept and staged (A11, A12, A16)", () => {
    function lineWithLaterSteps(): ChannelSetupRuntimeDefinition {
      const base = createLineDefinition();
      const steps = base.definition.wizard.steps;
      // LINE writes its first field step and its "Receive messages (optional)" step itself; the fixture adds steps after them.
      const collect = steps.find((step) => step.id === "collect-values");
      const receive = steps.find((step) => step.id === "receive-messages");
      if (!collect || !receive) throw new Error("LINE has a first field step and a receive step");
      const first: ChannelSetupStepDefinition = { ...collect, createOnly: true };
      const unstagedFields: ChannelSetupStepDefinition = {
        id: "more-values",
        kind: "field-collection",
        title: "More values",
        fields: [{ key: "extra", label: "Extra", type: "text", required: false, explanation: "Extra." }],
      };
      const staged: ChannelSetupStepDefinition = {
        id: "staged-note",
        kind: "instruction",
        stage: "identity",
        title: "Already staged",
      };
      const unstaged: ChannelSetupStepDefinition = { id: "unstaged-note", kind: "instruction", title: "No stage" };
      return {
        ...base,
        definition: {
          ...base.definition,
          wizard: {
            ...base.definition.wizard,
            steps: steps.flatMap((step) =>
              step === collect ? [first] : step === receive ? [receive, unstagedFields, staged, unstaged] : [step],
            ),
          },
        },
      };
    }

    it("splits and retitles only the first field step and leaves later field steps as written", () => {
      const steps = withGuidedJourney(lineWithLaterSteps()).definition.wizard.steps;
      const byId = (id: string) => steps.find((step) => step.id === id);

      expect(steps.map((step) => step.id).slice(0, 7)).toEqual([
        "overview",
        "create-account",
        "collect-values-identity",
        "collect-values-destinations",
        "receive-messages",
        "more-values",
        "staged-note",
      ]);
      expect(byId("collect-values-identity")).toMatchObject({ title: "Connect the account", stage: "identity" });
      expect(byId("receive-messages")).toMatchObject({
        title: "Receive messages (optional)",
        stage: "destinations_access",
      });
      expect(byId("more-values")?.title).toBe("More values");
      // An unset stage on a field step comes from what it asks for, never "Before you start".
      expect(byId("more-values")?.stage).toBe("identity");
    });

    it("keeps later field steps' fields out of the required credential group but still applies the field rules", () => {
      const steps = withGuidedJourney(lineWithLaterSteps()).definition.wizard.steps;
      const identity = steps.find((step) => step.id === "collect-values-identity");
      const receive = steps.find((step) => step.id === "receive-messages");

      expect(identity?.requiredAnyOf).toEqual([["channelAccessToken", "channelAccessTokenEnv"]]);
      expect(receive?.requiredAnyOf).toBeUndefined();
      const secret = receive?.fields?.find((field) => field.key === "channelSecret");
      const secretEnv = receive?.fields?.find((field) => field.key === "channelSecretEnv");
      expect(secret?.required).toBe(false);
      expect(secret?.label).toBe("Channel secret");
      expect(secretEnv?.advanced).toBe(true);
      expect(receive?.fields?.map((field) => field.key)).toEqual(["channelSecret", "channelSecretEnv"]);
    });

    it("keeps a stage the guide set and derives only the ones it left out", () => {
      const steps = withGuidedJourney(lineWithLaterSteps()).definition.wizard.steps;
      const stageOf = (id: string) => steps.find((step) => step.id === id)?.stage;

      expect(stageOf("staged-note")).toBe("identity");
      expect(stageOf("unstaged-note")).toBe("prerequisites");
      expect(stageOf("test")).toBe("checks");
      expect(stageOf("finish")).toBe("activation");
    });

    it("keeps a setup-only flag on both halves of a split step", () => {
      const steps = withGuidedJourney(lineWithLaterSteps()).definition.wizard.steps;

      expect(steps.find((step) => step.id === "collect-values-identity")?.createOnly).toBe(true);
      expect(steps.find((step) => step.id === "collect-values-destinations")?.createOnly).toBe(true);
      expect(steps.find((step) => step.id === "receive-messages")?.createOnly).toBeUndefined();
    });

    it("leaves a guide with one field step with the same step ids, titles and stages as before", () => {
      const outline = (key: string) =>
        guide(key).wizard.steps.map((step) => `${step.id} | ${step.stage} | ${step.title}`);

      // LINE has a second field step of its own: it is split once, and the second keeps the title and stage it was written with.
      expect(outline("line")).toEqual([
        "overview | prerequisites | What this connection does",
        "create-account | prerequisites | Create the LINE Official Account",
        "collect-values-identity | identity | Connect the account",
        "collect-values-destinations | destinations_access | Choose destinations and access",
        "receive-messages | destinations_access | Receive messages (optional)",
        "sender-access | destinations_access | Who may message this bot?",
        "test | checks | Validate the draft",
        "finish | activation | Finish setup",
        "first-message | first_message | Verify the first conversation",
      ]);
      expect(outline("zalo")).toEqual([
        "overview | prerequisites | What this connection does",
        "collect-values-identity | identity | Connect the account",
        "collect-values-destinations | destinations_access | Where should messages go?",
        "test | checks | Validate the draft",
        "finish | activation | Finish setup",
        "first-message | first_message | Confirm delivery",
      ]);
      expect(outline("matrix").slice(0, 3)).toEqual([
        "overview | prerequisites | What this connection does",
        "collect-values-identity | identity | Connect the account",
        "collect-values-destinations | destinations_access | Choose destinations and access",
      ]);
    });

    it("titles the destinations step of an outbound-only channel as a question", () => {
      const destinationsTitle = (key: string) =>
        guide(key).wizard.steps.find((step) => step.id.endsWith("-destinations"))?.title;

      expect(destinationsTitle("zalo")).toBe("Where should messages go?");
      // Teams has no destinations step at all, so there is no title to change.
      expect(destinationsTitle("teams")).toBeUndefined();
      // Channels that can also receive keep the title that covers who may message them. Discord's
      // destinations step holds its direct-message and server policies, so it counts as one of them.
      for (const key of ["discord", "slack", "telegram", "whatsapp", "ntfy", "matrix", "qqbot"]) {
        expect(destinationsTitle(key), key).toBe("Choose destinations and access");
      }
    });
  });

  describe("the sender step (A7, A8)", () => {
    it("explains in each channel's own words what a sender identity looks like", () => {
      const explanations: Record<string, string> = {
        whatsapp: "Your WhatsApp number with country code, digits only, no plus (for example 15551234567).",
        matrix: "Your Matrix ID with the @ and the server, for example @alice:example.com.",
        mattermost:
          "Mattermost user IDs (26 letters and digits), not usernames. An admin sees them in System Console › User Management › Users.",
        "nextcloud-talk": "users/ followed by your Nextcloud user name, for example users/alice.",
        line: "Your LINE user ID (starts with U). For a one-to-one chat it is the same ID as Default target.",
        slack: "Your Slack member ID (starts with U).",
        ntfy: "Added for you as ntfy-topic:<subscribe topic>. If you change the topic later, change this too.",
        // These keep their current text until the "dropped message" sentence can be backed by a screen.
        telegram:
          "Telegram pairing approval adds the approved user here. A destination chat ID is not permission to message the bot.",
        "google-chat":
          "Chat app mode only: add Google Chat user resource names such as users/123456789. Webhook mode never receives messages. Empty means every inbound sender is denied.",
        qqbot:
          "Add the QQ openids (the ids QQ assigns to senders, not QQ numbers) that may start conversations. Inbound is default-deny; empty means every inbound sender is denied.",
        wecom:
          "Add the WeCom userids that may start conversations. Inbound is default-deny; empty means every inbound sender is denied.",
      };

      for (const [key, text] of Object.entries(explanations)) {
        const field = senderStep(key)?.fields?.find((item) => item.key === "allowedSenders");
        expect(field?.explanation, key).toBe(text);
      }
    });

    it("hides the sender step while the channel is not set to receive", () => {
      for (const key of ["ntfy", "matrix", "mattermost"]) {
        const condition = senderStep(key)?.visibleWhenFieldEquals;
        expect(condition, key).toEqual({ fieldKey: "inboundStreamEnabled", value: true });
        expect(shownWith(guide(key), condition, {}), `${key} off`).toBe(false);
        expect(shownWith(guide(key), condition, { inboundStreamEnabled: false }), `${key} off`).toBe(false);
        expect(shownWith(guide(key), condition, { inboundStreamEnabled: true }), `${key} on`).toBe(true);
      }
      for (const key of ["slack", "telegram", "whatsapp", "line", "nextcloud-talk", "qqbot", "wecom"]) {
        expect(senderStep(key)?.visibleWhenFieldEquals, key).toBeUndefined();
      }
    });

    it("offers no access-mode choice where the runtime always enforces the allowlist", () => {
      for (const key of ["ntfy", "mattermost", "matrix", "google-chat", "qqbot", "wecom"]) {
        const keys = senderStep(key)?.fields?.map((field) => field.key);
        expect(keys, key).toEqual(["allowedSenders"]);
        // With no mode field to compare against, the sender list is always shown.
        expect(senderStep(key)?.fields?.[0]?.visibleWhenFieldEquals, key).toBeUndefined();
        expect(
          allFields(guide(key)).map((field) => field.key),
          key,
        ).not.toContain("inboundAccessMode");
      }
    });

    it("shows the open-access choice only for a connection that was already open", () => {
      for (const key of ["slack", "telegram", "whatsapp", "line", "nextcloud-talk"]) {
        const definition = guide(key);
        const mode = senderStep(key)?.fields?.find((field) => field.key === "inboundAccessMode");
        const list = senderStep(key)?.fields?.find((field) => field.key === "allowedSenders");

        expect(
          mode?.options?.map((option) => option.value),
          key,
        ).toEqual(["allowlist", "open_legacy"]);
        expect(mode?.defaultValue, key).toBe("allowlist");
        // A new draft has no saved mode, so it never sees the choice; it goes straight to the sender list.
        expect(shownWith(definition, mode?.visibleWhenFieldEquals, {}), `${key} new draft`).toBe(false);
        expect(shownWith(definition, list?.visibleWhenFieldEquals, {}), `${key} new draft list`).toBe(true);
        expect(shownWith(definition, mode?.visibleWhenFieldEquals, { inboundAccessMode: "allowlist" }), key).toBe(
          false,
        );
        // Picking a mode does not by itself make a draft one that was saved open.
        expect(shownWith(definition, mode?.visibleWhenFieldEquals, { inboundAccessMode: "open_legacy" }), key).toBe(
          false,
        );
        // A saved open connection is marked when it is loaded, so the choice shows whatever the mode is set to.
        expect(shownWith(definition, mode?.visibleWhenFieldEquals, OPEN_MARKER), key).toBe(true);
        expect(
          shownWith(definition, mode?.visibleWhenFieldEquals, { ...OPEN_MARKER, inboundAccessMode: "allowlist" }),
          key,
        ).toBe(true);
        expect(shownWith(definition, list?.visibleWhenFieldEquals, { inboundAccessMode: "open_legacy" }), key).toBe(
          false,
        );
      }
    });

    it("describes the open-access choice for what it is when it is shown", () => {
      for (const key of ["slack", "telegram", "whatsapp", "line", "nextcloud-talk"]) {
        const mode = senderStep(key)?.fields?.find((field) => field.key === "inboundAccessMode");

        expect(mode?.explanation, key).toBe(
          "This connection lets any sender start a conversation. Choose Only allowed senders to limit it to the people you list.",
        );
        expect(
          mode?.options?.map((option) => option.label),
          key,
        ).toEqual(["Only allowed senders", "Open legacy access (advanced)"]);
      }
    });

    it("keeps the words this builder adds free of internal terms", () => {
      const banned =
        /posture|provenance|ingress|egress|sandbox message|activation plan|manual fallback|preferred path/iu;
      for (const definition of listChannelSetupDefinitions()) {
        const generated = [
          ...definition.wizard.steps.filter((step) => step.id === "sender-access"),
          ...secretEnvFields(definition),
          ...allFields(definition).filter((field) => definition.adapter.secretFieldKeys.includes(field.key)),
        ].map((item) => JSON.stringify(item));

        for (const text of generated) {
          expect(text, definition.catalog.key).not.toMatch(banned);
        }
      }
    });

    it("shows the open-access choice for a saved open connection and not for a saved allowlist", () => {
      const runtime = requireChannelSetupDefinition("channel.whatsapp");
      const mode = senderStep("whatsapp")?.fields?.find((field) => field.key === "inboundAccessMode");
      const hydratedDraft = (config: Record<string, unknown>) =>
        runtime.hydrate(createConnection({ catalogId: "channel.whatsapp", key: "whatsapp", config })).draft;

      expect(
        shownWith(
          runtime.definition,
          mode?.visibleWhenFieldEquals,
          hydratedDraft({ inboundAccessMode: "open_legacy" }),
        ),
      ).toBe(true);
      // A connection saved before the mode existed, with no senders listed, is open too.
      expect(shownWith(runtime.definition, mode?.visibleWhenFieldEquals, hydratedDraft({}))).toBe(true);
      expect(
        shownWith(
          runtime.definition,
          mode?.visibleWhenFieldEquals,
          hydratedDraft({ inboundAccessMode: "allowlist", allowedSenders: ["15551234567"] }),
        ),
      ).toBe(false);
    });

    it("keeps the open-access choice on screen after a saved open connection is switched to an allowlist", () => {
      const runtime = requireChannelSetupDefinition("channel.whatsapp");
      const mode = senderStep("whatsapp")?.fields?.find((field) => field.key === "inboundAccessMode");
      const list = senderStep("whatsapp")?.fields?.find((field) => field.key === "allowedSenders");
      const opened = runtime.hydrate(
        createConnection({
          catalogId: "channel.whatsapp",
          key: "whatsapp",
          config: { inboundAccessMode: "open_legacy" },
        }),
      ).draft;
      const switched = { ...opened, inboundAccessMode: "allowlist" };

      // The wizard hides a field when its condition fails, so the select must not vanish under the person using it.
      expect(shownWith(runtime.definition, mode?.visibleWhenFieldEquals, switched)).toBe(true);
      expect(shownWith(runtime.definition, list?.visibleWhenFieldEquals, switched)).toBe(true);
      expect(
        shownWith(runtime.definition, mode?.visibleWhenFieldEquals, { ...switched, inboundAccessMode: "open_legacy" }),
      ).toBe(true);
    });

    it("marks only a saved open connection on a channel that has the choice", () => {
      const marked = (key: string, config: Record<string, unknown>) =>
        requireChannelSetupDefinition(`channel.${key}`).hydrate(
          createConnection({ catalogId: `channel.${key}`, key, config }),
        ).draft[OPEN_MARKER_KEY];

      for (const key of ["slack", "telegram", "whatsapp", "line", "nextcloud-talk"]) {
        expect(marked(key, { inboundAccessMode: "open_legacy" }), key).toBe(true);
        expect(marked(key, { inboundAccessMode: "allowlist", allowedSenders: ["u1"] }), key).toBeUndefined();
      }
      // The runtime ignores a stored open mode on these, so a stored one is never carried over.
      for (const key of ["ntfy", "mattermost", "matrix", "google-chat", "qqbot", "wecom"]) {
        expect(marked(key, { inboundAccessMode: "open_legacy" }), key).toBeUndefined();
      }
      // These have no sender step at all.
      for (const key of ["discord", "teams", "zalo"]) {
        expect(marked(key, { inboundAccessMode: "open_legacy" }), key).toBeUndefined();
      }
    });

    it("never writes the open-connection marker into the saved configuration", () => {
      for (const definition of listChannelSetupDefinitions()) {
        const key = definition.catalog.key;
        const runtime = requireChannelSetupDefinition(definition.catalog.catalogId);
        const draft = createDraft(
          definition.catalog.catalogId,
          { ...OPEN_MARKER, inboundAccessMode: "open_legacy", allowedSenders: ["u1"] },
          "edit",
        );
        const normalized = runtime.normalize({ ...draft, connectionId: "11111111-1111-1111-1111-111111111111" });

        expect(normalized, key).not.toHaveProperty(OPEN_MARKER_KEY);
        expect(JSON.stringify(normalized), key).not.toContain(OPEN_MARKER_KEY);
      }
    });
  });

  describe("web addresses (A10)", () => {
    const message = "Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).";

    it("rejects plain http away from this computer with the message the live test would give", () => {
      expect(requireSecureUrl("http://192.168.1.5", "baseUrl", "Base URL")).toMatchObject({
        key: "baseUrl_malformed",
        level: "error",
        message,
        fieldKey: "baseUrl",
        failureCategory: "malformed_value",
      });
      expect(requireSecureUrl("http://ntfy.example.com/alerts", "baseUrl", "Base URL")?.message).toBe(message);
      expect(requireSecureUrl("ntfy.example.com", "baseUrl", "Base URL")?.message).toBe(message);
      expect(requireSecureUrl("ftp://files.example.com", "baseUrl", "Base URL")?.message).toBe(message);
    });

    it("accepts https and plain http for this computer", () => {
      expect(requireSecureUrl("https://x", "baseUrl", "Base URL")).toBeUndefined();
      expect(requireSecureUrl("https://matrix.example.com:8448/", "homeserverUrl", "Homeserver URL")).toBeUndefined();
      expect(requireSecureUrl("http://127.0.0.1:8080", "baseUrl", "Base URL")).toBeUndefined();
      expect(requireSecureUrl("http://localhost:2586", "baseUrl", "Base URL")).toBeUndefined();
    });

    it("leaves an empty value to the required-field check", () => {
      expect(requireSecureUrl(undefined, "baseUrl", "Base URL")).toBeUndefined();
      expect(requireSecureUrl("   ", "baseUrl", "Base URL")).toBeUndefined();
    });
  });
});
