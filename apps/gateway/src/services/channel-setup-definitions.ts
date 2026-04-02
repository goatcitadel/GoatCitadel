import type {
  ChannelArchetype,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupFailureMapEntry,
  ChannelSetupHydrationResult,
  ChannelSetupIssue,
  ChannelSetupNoticeTone,
  ChannelSetupValidationLevel,
  IntegrationCatalogEntry,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";

interface ChannelSetupRuntimeDefinition {
  definition: ChannelSetupDefinition;
  hydrate(connection: IntegrationConnection): {
    draft: Record<string, unknown>;
    hydration: ChannelSetupHydrationResult;
  };
  normalize(draft: ChannelSetupDraft): Record<string, unknown>;
  validate(draft: ChannelSetupDraft): ChannelSetupIssue[];
}

const COMMON_FAILURES: Record<string, ChannelSetupFailureMapEntry[]> = {
  token: [
    {
      category: "credential_rejected",
      title: "Credential rejected",
      summary: "The platform rejected the credential currently stored in this draft.",
      likelyCauses: [
        "The token was copied incorrectly.",
        "The token expired or was rotated.",
        "The token belongs to another app or bot.",
      ],
      nextSteps: [
        "Copy the credential again from the provider portal.",
        "Replace the stored credential and rerun validation.",
      ],
    },
    {
      category: "permission_mismatch",
      title: "Permissions incomplete",
      summary: "The credential is valid, but the channel target cannot be reached with the current permissions.",
      likelyCauses: [
        "The bot or app is not installed in the destination.",
        "Required scopes or intents were not enabled.",
      ],
      nextSteps: [
        "Confirm the bot or app is installed in the target workspace/server/chat.",
        "Review the permissions checklist and retry the test.",
      ],
    },
  ],
};

const RUNTIME_DEFINITIONS: Record<string, ChannelSetupRuntimeDefinition> = {
  "channel.discord": createDiscordDefinition(),
  "channel.slack": createSlackDefinition(),
  "channel.telegram": createTelegramDefinition(),
  "channel.google-chat": createGoogleChatDefinition(),
  "channel.teams": createTeamsDefinition(),
  "channel.whatsapp": createWhatsAppDefinition(),
  "channel.signal": createSignalDefinition(),
  "channel.mattermost": createMattermostDefinition(),
  "channel.imessage": createIMessageDefinition(),
  "channel.nextcloud-talk": createNextcloudTalkDefinition(),
  "channel.line": createLineDefinition(),
  "channel.zalo": createZaloDefinition(),
  "channel.zalouser": createZaloUserDefinition(),
};

export function getChannelSetupDefinition(catalogId: string): ChannelSetupDefinition | undefined {
  return RUNTIME_DEFINITIONS[catalogId]?.definition;
}

export function requireChannelSetupDefinition(catalogId: string): ChannelSetupRuntimeDefinition {
  const definition = RUNTIME_DEFINITIONS[catalogId];
  if (!definition) {
    throw new Error(`No channel setup definition is available for ${catalogId}.`);
  }
  return definition;
}

export function listChannelSetupDefinitions(): ChannelSetupDefinition[] {
  return Object.values(RUNTIME_DEFINITIONS).map((item) => item.definition);
}

function createDiscordDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.discord");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bot_token_target",
      contentVersion: "2026.03.discord.v2",
      estimatedMinutes: 10,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Discord bot-token setups default to gateway mode so GoatCitadel behaves like a real online bot. Bridge remains available only as an advanced webhook-only fallback.",
      prerequisites: [
        "A Discord account with access to the target server.",
        "Permission to install bots or create an incoming webhook if you want the legacy bridge-only fallback.",
        "A sandbox channel you can safely test in.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel treats a Discord bot token as a first-class bot runtime. By default it logs the bot into the official Discord gateway so the bot can appear online, receive inbound DMs, and process allowlisted guild traffic."),
            paragraph("Bridge mode still exists for advanced webhook-only or outbound-only cases, but it is no longer the default path."),
            note("warning", "If you want the bot to appear online, do not use webhook-only bridge mode."),
          ],
        },
        {
          id: "prerequisites",
          kind: "prerequisites",
          title: "Before you start",
          checklist: [
            check("discord-account", "Discord account signed in"),
            check("server-access", "Access to the target server"),
            check("sandbox-channel", "A sandbox channel selected for testing"),
          ],
          troubleshooting: [
            troubleshoot(
              "no-admin",
              "You cannot install the bot",
              "If you do not have permission to add applications to the server, ask a server admin to complete the install step or use webhook mode instead.",
            ),
          ],
        },
        {
          id: "create-bot",
          kind: "instruction",
          title: "Create the Discord application and bot",
          body: [
            paragraph("Open the Discord Developer Portal, create a new application, then open the Bot tab and add a bot user."),
            linkBlock("Discord Developer Portal", "https://discord.com/developers/applications"),
          ],
          checklist: [
            check("app-created", "Create a new Discord application"),
            check("bot-added", "Add a bot user in the Bot section"),
            check("token-copied", "Copy the bot token or store it in an environment variable"),
          ],
        },
        {
          id: "install-bot",
          kind: "instruction",
          title: "Add the bot to your server",
          body: [
            paragraph("Use the Installation section to generate an install link with the bot scope and the minimum permissions needed in your sandbox channel. Gateway mode also needs the bot installed wherever you want inbound routing."),
          ],
          checklist: [
            check("bot-installed", "Install the bot into the target server"),
            check("channel-visible", "Confirm the bot can see the destination channel"),
            check("channel-send", "Confirm the bot can send messages in the destination channel"),
          ],
        },
        {
          id: "webhook-path",
          kind: "instruction",
          title: "Optional legacy bridge-only webhook path",
          body: [
            paragraph("If you intentionally want a webhook-only outbound connection, add a Discord webhook URL in advanced settings. That path stays on bridge mode and does not support reactions, inbound routing, or online presence."),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "botTokenEnv",
              label: "Bot token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the environment variable that stores your Discord bot token.",
              whyNeeded: "Bot-token setups default to gateway mode so GoatCitadel can create the persistent online bot session.",
              whereToFind: [paragraph("Create or reuse an env var such as DISCORD_BOT_TOKEN and store the actual token there.")],
              looksLike: "DISCORD_BOT_TOKEN",
              commonMistakes: ["Pasting the token value here instead of the env var name.", "Using an env var that is not available to the gateway process."],
              canChangeLater: true,
              placeholder: "DISCORD_BOT_TOKEN",
            },
            {
              key: "botToken",
              label: "Bot token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry for manual fallback or temporary debugging.",
              whyNeeded: "Use only if you cannot supply an env reference right now.",
              whereToFind: [paragraph("In the Discord Developer Portal, open your application, then open the Bot tab.")],
              looksLike: "A long opaque token string.",
              commonMistakes: ["Pasting the application id instead of the bot token.", "Leaving a temporary token here after you intended to switch to env-backed config."],
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste token directly only if needed",
            },
            {
              key: "defaultChannelId",
              label: "Default channel ID",
              type: "id",
              required: true,
              explanation: "The channel GoatCitadel should use when no explicit target is provided.",
              whyNeeded: "Needed for diagnostics, default sends, and as the seed channel for gateway allowlisting.",
              whereToFind: [paragraph("Enable Developer Mode in Discord, right-click the channel, then choose Copy Channel ID.")],
              looksLike: "123456789012345678",
              commonMistakes: ["Copying a message id or server id instead of the channel id."],
              canChangeLater: true,
            },
            {
              key: "defaultGuildId",
              label: "Optional server (guild) ID",
              type: "id",
              required: false,
              explanation: "An optional server id for advanced routing and troubleshooting.",
              whereToFind: [paragraph("Enable Developer Mode in Discord, right-click the server, then choose Copy Server ID.")],
              looksLike: "987654321098765432",
              canChangeLater: true,
            },
            {
              key: "webhookUrl",
              label: "Optional bridge webhook URL",
              type: "url",
              required: false,
              explanation: "Advanced legacy bridge path for outbound sends when you intentionally want webhook-only delivery.",
              whyNeeded: "Used only when you explicitly want the older bridge behavior instead of the default gateway bot runtime.",
              whereToFind: [paragraph("Open channel settings in Discord, then Integrations or Webhooks, then copy the webhook URL.")],
              looksLike: "https://discord.com/api/webhooks/...",
              commonMistakes: ["Using the channel URL instead of the webhook URL."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "inboundDmPolicy",
              label: "Gateway DM policy",
              type: "select",
              required: false,
              defaultValue: "pairing",
              explanation: "Gateway mode only. Pairing asks unknown DM senders to complete approval, open routes DMs immediately, and disabled ignores DMs.",
              options: [
                { value: "pairing", label: "pairing" },
                { value: "open", label: "open" },
                { value: "disabled", label: "disabled" },
              ],
              canChangeLater: true,
            },
            {
              key: "guildPolicy",
              label: "Gateway guild policy",
              type: "select",
              required: false,
              defaultValue: "allowlist",
              explanation: "Gateway mode only. Allowlist processes only configured guilds and channels; off ignores guild traffic entirely.",
              options: [
                { value: "allowlist", label: "allowlist" },
                { value: "off", label: "off" },
              ],
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate and test the connection",
          body: [
            paragraph("Bridge mode runs a complete probe: token auth, channel access, and an optional sandbox send/delete check. Gateway mode also reports whether the persistent Discord runtime is ready."),
          ],
          troubleshooting: definitionFailures("token"),
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph("For the normal bot-token path, setup is complete when the runtime reports a live Discord session and your sandbox channel passes the probe."),
          ],
          successCriteria: [
            "Token auth succeeds or the advanced webhook-only bridge path is intentionally configured.",
            "A default channel is configured and reachable.",
            "The Discord runtime is ready when you are using the normal bot-token path.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.03.discord.v2",
      secretFieldKeys: ["botToken", "webhookUrl"],
    },
    validation: {
      validationVersion: "2026.03.discord.v2",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.03.discord.v2",
      levels: ["live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.discord",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://discord.com/developers/applications",
      lastReviewedAt: "2026-03-29",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Gateway with bot token",
      legacyPathLabel: "Webhook-only bridge",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const explicitRuntimeMode = readString(config, "runtimeMode");
      const hydratedRuntimeMode = explicitRuntimeMode === "bridge" || explicitRuntimeMode === "gateway"
        ? explicitRuntimeMode
        : inferDiscordConfigRuntimeMode(config);
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["botToken", "botTokenEnv", "token", "tokenEnv"],
        ["webhookUrl", "webhookUrlEnv"],
      ]);
      return {
        draft: {
          runtimeMode: hydratedRuntimeMode,
          botTokenEnv: readString(config, "botTokenEnv"),
          defaultChannelId: readString(config, "defaultChannelId"),
          defaultGuildId: readString(config, "defaultGuildId"),
          inboundDmPolicy: readString(config, "inboundDmPolicy") ?? "pairing",
          guildPolicy: readString(config, "guildPolicy") ?? "allowlist",
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            runtimeMode: "configured",
            botTokenEnv: readString(config, "botTokenEnv") ? "configured" : "unknown",
            botToken: readString(config, "botToken") || readString(config, "botTokenEnv") ? "configured" : "missing",
            webhookUrl: readString(config, "webhookUrl") ? "configured" : "unknown",
            defaultChannelId: readString(config, "defaultChannelId") ? "configured" : "missing",
            defaultGuildId: readString(config, "defaultGuildId") ? "configured" : "unknown",
            inboundDmPolicy: "configured",
            guildPolicy: "configured",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const runtimeMode = resolveDiscordRuntimeMode(draft);
      return compactRecord({
        runtimeMode,
        botTokenEnv: readString(draft.draft, "botTokenEnv") ?? readLegacyString(draft, "botTokenEnv", "tokenEnv"),
        defaultChannelId: readString(draft.draft, "defaultChannelId"),
        defaultGuildId: readString(draft.draft, "defaultGuildId"),
        inboundDmPolicy: runtimeMode === "gateway" ? readString(draft.draft, "inboundDmPolicy") ?? "pairing" : undefined,
        guildPolicy: runtimeMode === "gateway" ? readString(draft.draft, "guildPolicy") ?? "allowlist" : undefined,
        botToken: readString(draft.draft, "botToken") ?? readLegacyString(draft, "botToken", "token"),
        webhookUrl: runtimeMode === "bridge"
          ? readString(draft.draft, "webhookUrl") ?? readLegacyString(draft, "webhookUrl", "webhookUrlEnv")
          : undefined,
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const runtimeMode = resolveDiscordRuntimeMode(draft);
      const defaultChannelId = readString(draft.draft, "defaultChannelId");
      const hasConfiguredBotToken = Boolean(
        readString(draft.draft, "botToken")
        || readString(draft.draft, "botTokenEnv")
        || draft.hydration?.fieldState.botToken === "configured"
        || draft.hydration?.fieldState.botTokenEnv === "configured",
      );
      const hasConfiguredWebhook = Boolean(
        readString(draft.draft, "webhookUrl")
        || draft.hydration?.fieldState.webhookUrl === "configured",
      );
      if (!defaultChannelId) {
        issues.push(requiredFieldIssue("defaultChannelId", "Default channel ID is required."));
      } else if (!/^\d{10,}$/.test(defaultChannelId)) {
        issues.push(malformedFieldIssue("defaultChannelId", "Default channel ID should look like a Discord numeric ID."));
      }
      if (runtimeMode === "gateway") {
        if (!hasConfiguredBotToken) {
          issues.push(requiredFieldIssue("botTokenEnv", "Gateway mode requires a Discord bot token or bot token env var."));
        }
      } else if (!hasConfiguredBotToken && !hasConfiguredWebhook) {
        issues.push({
          key: "discord_bridge_auth_missing",
          level: "error",
          message: "Bridge mode requires either a Discord bot token/env var or a webhook URL.",
          failureCategory: "missing_input",
          nextSteps: ["Add a bot token env var for the recommended bridge path, or provide a webhook URL for the legacy bridge-only path."],
        });
      }
      if (readString(draft.draft, "webhookUrl")) {
        const webhookUrl = readString(draft.draft, "webhookUrl");
        if (webhookUrl && !/^https:\/\/(ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\//.test(webhookUrl)) {
          issues.push(malformedFieldIssue("webhookUrl", "Webhook URL should look like a Discord webhook URL."));
        }
      }
      return issues;
    },
  };
}

function createSlackDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.slack");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "2026.03.slack.v1",
      estimatedMinutes: 10,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Connect Slack using a bot token for full workspace actions, with an optional incoming webhook fallback and a signing secret for inbound event parity.",
      prerequisites: [
        "A Slack workspace where you can install apps.",
        "Permission to add scopes and install the app into the workspace.",
        "A sandbox channel for the first test post.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel can send messages into Slack and, with a bot token, can use richer workspace-aware behavior than a plain webhook."),
            note("warning", "Use bot token mode for the best experience. Keep webhook mode only for simpler send-only routing."),
          ],
        },
        {
          id: "prerequisites",
          kind: "prerequisites",
          title: "Before you start",
          checklist: [
            check("workspace", "Choose the Slack workspace"),
            check("sandbox", "Pick a sandbox channel for the first test"),
            check("permissions", "Confirm you can install or update the Slack app"),
          ],
        },
        {
          id: "create-app",
          kind: "instruction",
          title: "Create and install the Slack app",
          body: [
            paragraph("Create a Slack app from scratch, add bot scopes such as chat:write, then install or reinstall it into the workspace."),
            linkBlock("Slack OAuth v2", "https://api.slack.com/authentication/oauth-v2"),
            linkBlock("Slack first app tutorial", "https://api.slack.com/tutorials/first-bolt-app"),
          ],
          checklist: [
            check("app", "Create the Slack app"),
            check("scope", "Add chat:write or the required bot scopes"),
            check("install", "Install or reinstall the app to the workspace"),
            check("token", "Copy the Bot User OAuth token"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "botToken",
              label: "Bot User OAuth token",
              type: "secret",
              required: false,
              explanation: "The Slack bot token used for workspace-aware API calls and live auth checks.",
              whyNeeded: "Used to validate the app installation and post as the bot.",
              whereToFind: [paragraph("Open your Slack app, then OAuth & Permissions, then copy the Bot User OAuth Token.")],
              looksLike: "xoxb-...",
              commonMistakes: ["Copying a user token instead of the bot token.", "Forgetting to reinstall the app after changing scopes."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "defaultChannel",
              label: "Default channel",
              type: "text",
              required: true,
              explanation: "The default Slack channel or id GoatCitadel should use.",
              whyNeeded: "Used for tests and default outbound sends.",
              whereToFind: [paragraph("Use the channel name like #ops-sandbox or copy the channel id for private channels if needed.")],
              looksLike: "#ops-sandbox or C0123456789",
              commonMistakes: ["Using a display title instead of the actual channel reference."],
              canChangeLater: true,
            },
            {
              key: "defaultThreadTs",
              label: "Optional default thread timestamp",
              type: "text",
              required: false,
              explanation: "Optional thread timestamp for routing messages into an existing thread.",
              looksLike: "1712109984.123456",
              canChangeLater: true,
            },
            {
              key: "webhookUrl",
              label: "Optional incoming webhook URL",
              type: "url",
              required: false,
              explanation: "Optional webhook fallback for simpler outbound posting.",
              whyNeeded: "Useful when you need a lightweight send-only path or a fallback route.",
              whereToFind: [paragraph("Enable Incoming Webhooks in your Slack app, then copy the generated webhook URL.")],
              looksLike: "https://hooks.slack.com/services/...",
              commonMistakes: ["Pasting a workspace URL instead of the incoming webhook URL."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "signingSecret",
              label: "Optional signing secret",
              type: "secret",
              required: false,
              explanation: "Slack request signing secret for verified inbound event routing.",
              whyNeeded: "Required if you want GoatCitadel to accept signed Slack Events API callbacks and reply inside Slack conversations.",
              whereToFind: [paragraph("Open your Slack app, then Basic Information, then App Credentials, and copy the Signing Secret.")],
              looksLike: "A short mixed-case secret value from Slack.",
              commonMistakes: ["Pasting a bot token here instead of the signing secret.", "Forgetting to configure the Events API request URL after saving the secret."],
              sensitive: true,
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate and test the connection",
          body: [
            paragraph("GoatCitadel validates the bot token when present and sends a sandbox message plus cleanup probe for bot-token Slack connections."),
            paragraph("Webhook-only Slack fallback connections still rely on manual confirmation after finalize."),
          ],
          troubleshooting: definitionFailures("token"),
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph("After finalizing, send a sandbox message to confirm the bot can reach the chosen channel."),
          ],
          successCriteria: [
            "A default channel is configured.",
            "The bot token validates successfully or the webhook path is confirmed manually.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.03.slack.v1",
      secretFieldKeys: ["botToken", "webhookUrl", "signingSecret"],
    },
    validation: {
      validationVersion: "2026.03.slack.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.03.slack.v1",
      levels: ["live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.slack",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://api.slack.com/authentication/oauth-v2",
      lastReviewedAt: "2026-03-29",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Bot User OAuth token",
      legacyPathLabel: "Incoming webhook fallback + optional inbound signing secret",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["botToken", "botTokenEnv", "token", "tokenEnv"],
        ["webhookUrl"],
        ["signingSecret", "signingSecretEnv"],
      ]);
      return {
        draft: {
          defaultChannel: readString(config, "defaultChannel"),
          defaultThreadTs: readString(config, "defaultThreadTs"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            botToken: readString(config, "botToken") || readString(config, "botTokenEnv") || readString(config, "token") || readString(config, "tokenEnv")
              ? "configured"
              : "missing",
            defaultChannel: readString(config, "defaultChannel") ? "configured" : "missing",
            defaultThreadTs: readString(config, "defaultThreadTs") ? "configured" : "unknown",
            webhookUrl: readString(config, "webhookUrl") ? "configured" : "unknown",
            signingSecret: readString(config, "signingSecret") || readString(config, "signingSecretEnv")
              ? "configured"
              : "unknown",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const preservedBotToken = readLegacyString(draft, "botToken", "token");
      const preservedBotTokenEnv = readLegacyString(draft, "botTokenEnv", "tokenEnv");
      const preservedWebhookUrl = readLegacyString(draft, "webhookUrl");
      const preservedSigningSecret = readLegacyString(draft, "signingSecret");
      const preservedSigningSecretEnv = readLegacyString(draft, "signingSecretEnv");
      return compactRecord({
        botToken: readString(draft.draft, "botToken") ?? preservedBotToken,
        botTokenEnv: readString(draft.draft, "botTokenEnv") ?? preservedBotTokenEnv,
        defaultChannel: readString(draft.draft, "defaultChannel"),
        defaultThreadTs: readString(draft.draft, "defaultThreadTs"),
        webhookUrl: readString(draft.draft, "webhookUrl") ?? preservedWebhookUrl,
        signingSecret: readString(draft.draft, "signingSecret") ?? preservedSigningSecret,
        signingSecretEnv: readString(draft.draft, "signingSecretEnv") ?? preservedSigningSecretEnv,
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const token = readString(draft.draft, "botToken");
      const webhookUrl = readString(draft.draft, "webhookUrl");
      const signingSecret = readString(draft.draft, "signingSecret");
      const defaultChannel = readString(draft.draft, "defaultChannel");
      const hasConfiguredToken = Boolean(
        token
        || readString(draft.draft, "botTokenEnv")
        || draft.hydration?.fieldState.botToken === "configured",
      );
      const hasConfiguredWebhook = Boolean(
        webhookUrl
        || draft.hydration?.fieldState.webhookUrl === "configured",
      );
      if (!hasConfiguredToken && !hasConfiguredWebhook) {
        issues.push({
          key: "slack_auth_missing",
          level: "error",
          message: "Provide either a Slack bot token or an incoming webhook URL.",
          failureCategory: "missing_input",
          nextSteps: ["Copy the Bot User OAuth token or the webhook URL, then rerun validation."],
        });
      }
      if (token && !/^xox[baprs]-/i.test(token)) {
        issues.push(malformedFieldIssue("botToken", "Bot token should look like a Slack OAuth token."));
      }
      if (webhookUrl && !/^https:\/\/hooks\.slack\.com\/services\//.test(webhookUrl)) {
        issues.push(malformedFieldIssue("webhookUrl", "Webhook URL should look like a Slack incoming webhook URL."));
      }
      if (signingSecret && /^xox[baprs]-/i.test(signingSecret)) {
        issues.push(malformedFieldIssue("signingSecret", "Signing secret should not look like a Slack OAuth token."));
      }
      if (!defaultChannel) {
        issues.push(requiredFieldIssue("defaultChannel", "Default channel is required."));
      }
      return issues;
    },
  };
}

function createTelegramDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.telegram");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bot_token_target",
      contentVersion: "2026.03.telegram.v1",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Connect Telegram by creating a bot with BotFather, choosing a default chat, and optionally configuring a webhook secret for inbound routing parity.",
      prerequisites: [
        "A Telegram account.",
        "Access to the target chat, group, or channel.",
        "Permission to add the bot to the destination if needed.",
        "A public HTTPS URL for the gateway if you want inbound webhook routing.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel can send messages into Telegram chats and channels using a Telegram bot token."),
          ],
        },
        {
          id: "create-bot",
          kind: "instruction",
          title: "Create the Telegram bot",
          body: [
            paragraph("Open @BotFather in Telegram, run /newbot, then follow the prompts to create your bot."),
            linkBlock("Telegram bot tutorial", "https://core.telegram.org/bots/tutorial"),
          ],
          checklist: [
            check("botfather", "Open @BotFather"),
            check("newbot", "Run /newbot and finish the prompts"),
            check("token", "Copy the bot token"),
          ],
        },
        {
          id: "destination",
          kind: "instruction",
          title: "Prepare the destination chat",
          body: [
            paragraph("Add the bot to the target group or channel and grant it permission to send messages."),
          ],
          checklist: [
            check("bot-added", "Add the bot to the target chat or channel"),
            check("permissions", "Confirm the bot can post"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "botToken",
              label: "Bot token",
              type: "secret",
              required: true,
              explanation: "The token BotFather generated for your Telegram bot.",
              whyNeeded: "Used to authenticate GoatCitadel to Telegram.",
              whereToFind: [paragraph("In the BotFather chat after you create the bot or regenerate the token.")],
              looksLike: "123456789:AA...",
              commonMistakes: ["Copying the bot username instead of the token.", "Missing the colon in the token."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "defaultChatId",
              label: "Default chat ID or @channel handle",
              type: "id",
              required: true,
              explanation: "The default destination GoatCitadel should use in Telegram.",
              whyNeeded: "Used for tests and default outbound sends.",
              whereToFind: [paragraph("Use a chat id lookup workflow or the @channel_name for public channels.")],
              looksLike: "123456789 or @channel_name",
              commonMistakes: ["Copying a message id instead of the chat id.", "Using a display name instead of the @handle."],
              canChangeLater: true,
            },
            {
              key: "parseMode",
              label: "Parse mode",
              type: "select",
              required: false,
              defaultValue: "Markdown",
              explanation: "Optional Telegram formatting mode.",
              options: [
                { value: "Markdown", label: "Markdown" },
                { value: "MarkdownV2", label: "MarkdownV2" },
                { value: "HTML", label: "HTML" },
              ],
              canChangeLater: true,
            },
            {
              key: "webhookSecretEnv",
              label: "Webhook secret ENV var",
              type: "text",
              required: false,
              explanation: "Optional. Env var name for the Telegram webhook secret token used to verify inbound Bot API webhooks.",
              whyNeeded: "Enables inbound Telegram message routing without storing the secret directly in the connection config.",
              whereToFind: [paragraph("Create a random secret token, store it in an env var such as TELEGRAM_WEBHOOK_SECRET, and configure the same token in Telegram's setWebhook call.")],
              looksLike: "TELEGRAM_WEBHOOK_SECRET",
              commonMistakes: ["Pasting the actual secret here instead of the env var name.", "Forgetting to use the same secret token when configuring the Telegram webhook."],
              canChangeLater: true,
              placeholder: "TELEGRAM_WEBHOOK_SECRET",
            },
            {
              key: "webhookSecret",
              label: "Webhook secret (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct secret-token entry for Telegram inbound webhook verification.",
              whyNeeded: "Lets GoatCitadel verify Telegram webhook deliveries when env-backed secret storage is not available yet.",
              looksLike: "A long random secret token.",
              commonMistakes: ["Reusing the bot token instead of a separate webhook secret.", "Configuring a secret here but a different secret in Telegram."],
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate and test the connection",
          body: [
            paragraph("GoatCitadel verifies the token with Telegram and sends a sandbox message plus cleanup probe before you finalize."),
          ],
          troubleshooting: definitionFailures("token"),
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph("After finalizing, send a sandbox message to confirm the bot can reach the selected chat."),
          ],
          successCriteria: [
            "The token validates successfully.",
            "A default chat target is configured.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.03.telegram.v1",
      secretFieldKeys: ["botToken", "webhookSecret"],
    },
    validation: {
      validationVersion: "2026.03.telegram.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.03.telegram.v1",
      levels: ["live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.telegram",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://core.telegram.org/bots/tutorial",
      lastReviewedAt: "2026-03-29",
      volatility: "low",
      deprecationRisk: "low",
      preferredPathLabel: "BotFather token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["botToken", "botTokenEnv", "token", "tokenEnv"],
      ]);
      return {
        draft: {
          botTokenEnv: readString(config, "botTokenEnv") ?? readString(config, "tokenEnv"),
          defaultChatId: readString(config, "defaultChatId"),
          parseMode: readString(config, "parseMode") ?? "Markdown",
          webhookSecretEnv: readString(config, "webhookSecretEnv") ?? readString(config, "secretTokenEnv"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            botToken: readString(config, "botToken") || readString(config, "botTokenEnv") || readString(config, "token") || readString(config, "tokenEnv")
              ? "configured"
              : "missing",
            botTokenEnv: readString(config, "botTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            defaultChatId: readString(config, "defaultChatId") ? "configured" : "missing",
            parseMode: "configured",
            webhookSecret: readString(config, "webhookSecret") || readString(config, "secretToken") ? "configured" : "unknown",
            webhookSecretEnv: readString(config, "webhookSecretEnv") || readString(config, "secretTokenEnv") ? "configured" : "unknown",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const preservedBotToken = readLegacyString(draft, "botToken", "token");
      const preservedBotTokenEnv = readLegacyString(draft, "botTokenEnv", "tokenEnv");
      const preservedWebhookSecret = readLegacyString(draft, "webhookSecret", "secretToken");
      const preservedWebhookSecretEnv = readLegacyString(draft, "webhookSecretEnv", "secretTokenEnv");
      return compactRecord({
        botTokenEnv: readString(draft.draft, "botTokenEnv") ?? preservedBotTokenEnv,
        botToken: readString(draft.draft, "botToken") ?? preservedBotToken,
        defaultChatId: readString(draft.draft, "defaultChatId"),
        parseMode: readString(draft.draft, "parseMode") ?? "Markdown",
        webhookSecretEnv: readString(draft.draft, "webhookSecretEnv") ?? preservedWebhookSecretEnv,
        webhookSecret: readString(draft.draft, "webhookSecret") ?? preservedWebhookSecret,
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const token = readString(draft.draft, "botToken");
      const chatId = readString(draft.draft, "defaultChatId");
      const hasConfiguredToken = Boolean(
        token
        || readString(draft.draft, "botTokenEnv")
        || draft.hydration?.fieldState.botToken === "configured"
        || draft.hydration?.fieldState.botTokenEnv === "configured",
      );
      if (!hasConfiguredToken) {
        issues.push(requiredFieldIssue("botToken", "Bot token is required."));
      } else if (token && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
        issues.push(malformedFieldIssue("botToken", "Bot token should look like a Telegram bot token."));
      }
      if (!chatId) {
        issues.push(requiredFieldIssue("defaultChatId", "Default chat ID or @channel handle is required."));
      }
      return issues;
    },
  };
}

function createGoogleChatDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.google-chat");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "webhook_destination",
      contentVersion: "2026.03.google-chat.v1",
      estimatedMinutes: 6,
      difficulty: "beginner",
      manualModePolicy: "available-secondary",
      introSummary: "Connect Google Chat using an incoming webhook and an optional thread key.",
      prerequisites: [
        "Access to the target Google Chat space.",
        "Permission to create or manage incoming webhooks for that space.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel can send outbound operator messages to a Google Chat space through an incoming webhook."),
            note("warning", "Incoming webhooks are effectively secrets. Treat the webhook URL like a token."),
          ],
        },
        {
          id: "create-webhook",
          kind: "instruction",
          title: "Create the incoming webhook",
          body: [
            paragraph("Open the target Google Chat space, create an incoming webhook, and copy the full webhook URL."),
          ],
          checklist: [
            check("space", "Open the target Google Chat space"),
            check("webhook", "Create the incoming webhook"),
            check("copied", "Copy the full webhook URL"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "webhookUrl",
              label: "Webhook URL",
              type: "url",
              required: true,
              explanation: "The full Google Chat incoming webhook URL.",
              whyNeeded: "Used for all outbound sends to the target space.",
              whereToFind: [paragraph("Copy the full URL from the Google Chat incoming webhook setup flow.")],
              looksLike: "https://chat.googleapis.com/v1/spaces/...",
              commonMistakes: ["Copying the space URL instead of the webhook URL."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "defaultThreadKey",
              label: "Optional default thread key",
              type: "text",
              required: false,
              explanation: "Optional thread key for grouping outbound messages into a stable thread.",
              looksLike: "goatcitadel-ops",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the connection",
          body: [
            paragraph("GoatCitadel validates the webhook shape and sends a sandbox webhook probe during guided test and retest flows."),
            paragraph("You still need to confirm manually that the post landed in the intended Google Chat space or thread."),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph("After finalizing, send a sandbox post and confirm it arrives in the intended space or thread."),
          ],
          successCriteria: [
            "The webhook URL is configured.",
            "A sandbox test post is confirmed manually in Google Chat.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.03.google-chat.v1",
      secretFieldKeys: ["webhookUrl"],
    },
    validation: {
      validationVersion: "2026.03.google-chat.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.03.google-chat.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.google_chat",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://developers.google.com/workspace/chat/quickstart/webhooks",
      lastReviewedAt: "2026-03-29",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Incoming webhook",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["webhookUrl"]]);
      return {
        draft: {
          defaultThreadKey: readString(config, "defaultThreadKey"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            webhookUrl: readString(config, "webhookUrl") ? "configured" : "missing",
            defaultThreadKey: readString(config, "defaultThreadKey") ? "configured" : "unknown",
          },
          warnings: hasConfiguredSecret
            ? ["Saved webhook URLs are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      return compactRecord({
        webhookUrl: readString(draft.draft, "webhookUrl"),
        defaultThreadKey: readString(draft.draft, "defaultThreadKey"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const webhookUrl = readString(draft.draft, "webhookUrl");
      if (!webhookUrl) {
        issues.push(requiredFieldIssue("webhookUrl", "Webhook URL is required."));
      } else if (!/^https:\/\/chat\.googleapis\.com\/v1\/spaces\//.test(webhookUrl)) {
        issues.push(malformedFieldIssue("webhookUrl", "Webhook URL should look like a Google Chat incoming webhook URL."));
      }
      return issues;
    },
  };
}

function createTeamsDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.teams");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "webhook_destination",
      contentVersion: "2026.03.teams.v1",
      estimatedMinutes: 6,
      difficulty: "beginner",
      manualModePolicy: "available-secondary",
      introSummary: "Connect Microsoft Teams using an incoming webhook and an optional default card title.",
      prerequisites: [
        "Access to the target Teams channel.",
        "Permission to add or manage incoming webhooks or the approved connector path in that channel.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses a Teams incoming webhook for outbound operator delivery."),
            note("warning", "Webhook URLs are secrets. Treat them like tokens and keep them out of committed config when possible."),
          ],
        },
        {
          id: "create-webhook",
          kind: "instruction",
          title: "Create the Teams webhook",
          body: [
            paragraph("Open the target Teams channel, add the incoming webhook or approved connector, then copy the full webhook URL."),
          ],
          checklist: [
            check("channel", "Open the target Teams channel"),
            check("connector", "Create or configure the incoming webhook"),
            check("copied", "Copy the full webhook URL"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "webhookUrl",
              label: "Webhook URL",
              type: "url",
              required: true,
              explanation: "The Teams incoming webhook URL GoatCitadel should call for outbound delivery.",
              whyNeeded: "Used for every outbound message to the configured Teams channel.",
              whereToFind: [paragraph("Copy the full webhook URL from the Teams connector or incoming webhook setup flow.")],
              looksLike: "https://outlook.office.com/webhook/...",
              commonMistakes: ["Copying the Teams channel URL instead of the webhook URL."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "cardTitle",
              label: "Card title",
              type: "text",
              required: false,
              explanation: "Optional default title used for outbound Teams cards.",
              looksLike: "GoatCitadel",
              canChangeLater: true,
              placeholder: "GoatCitadel",
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the connection",
          body: [
            paragraph("GoatCitadel validates the webhook shape and sends a sandbox webhook probe during guided test and retest flows."),
            paragraph("You still need to confirm manually that the card arrived in the intended Teams channel."),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph("After finalizing, send a sandbox post and confirm the card arrives in the intended Teams channel."),
          ],
          successCriteria: [
            "The webhook URL is configured.",
            "A sandbox Teams post is confirmed manually.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.03.teams.v1",
      secretFieldKeys: ["webhookUrl"],
    },
    validation: {
      validationVersion: "2026.03.teams.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.03.teams.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.teams",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using",
      lastReviewedAt: "2026-03-29",
      volatility: "medium",
      deprecationRisk: "medium",
      preferredPathLabel: "Incoming webhook",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["webhookUrl", "webhookUrlEnv"]]);
      return {
        draft: {
          cardTitle: readString(config, "cardTitle") ?? "GoatCitadel",
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            webhookUrl: readString(config, "webhookUrl") || readString(config, "webhookUrlEnv") ? "configured" : "missing",
            cardTitle: readString(config, "cardTitle") ? "configured" : "unknown",
          },
          warnings: hasConfiguredSecret
            ? ["Saved webhook URLs are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      return compactRecord({
        webhookUrl: readString(draft.draft, "webhookUrl") ?? readLegacyString(draft, "webhookUrl", "webhookUrlEnv"),
        webhookUrlEnv: readString(draft.draft, "webhookUrlEnv") ?? readLegacyString(draft, "webhookUrlEnv"),
        cardTitle: readString(draft.draft, "cardTitle") ?? "GoatCitadel",
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const webhookUrl = readString(draft.draft, "webhookUrl");
      const hasConfiguredWebhook = Boolean(
        webhookUrl
        || readString(draft.draft, "webhookUrlEnv")
        || draft.hydration?.fieldState.webhookUrl === "configured",
      );
      if (!hasConfiguredWebhook) {
        issues.push(requiredFieldIssue("webhookUrl", "Webhook URL is required."));
      } else if (webhookUrl && !/^https:\/\/(?:outlook\.office\.com|[\w.-]+\.webhook\.office\.com)\/webhook/i.test(webhookUrl)) {
        issues.push(malformedFieldIssue("webhookUrl", "Webhook URL should look like a Microsoft Teams incoming webhook URL."));
      }
      return issues;
    },
  };
}

function createWhatsAppDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.whatsapp");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "platform_api_resource_ids",
      contentVersion: "2026.04.whatsapp.v1",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Connect a WhatsApp Cloud API sender identity with a phone-number id, access token, and a default direct recipient target.",
      prerequisites: [
        "A Meta developer app with WhatsApp Cloud API access.",
        "A sender phone-number id that is already provisioned in your Meta app.",
        "A sandbox recipient or test number for manual confirmation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses the WhatsApp Cloud API for outbound sends, replies, reactions, and rich media delivery to direct recipients. It can also ingest signed inbound webhook events when you configure the webhook secret pair."),
            note("warning", "WhatsApp Cloud API delivery is still treated as planned parity work. Guided setup now runs a live sender-auth probe and can post a sandbox message to the configured default recipient, but it does not change the maturity claim."),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "accessTokenEnv",
              label: "Access token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the environment variable that stores your WhatsApp Cloud API access token.",
              whyNeeded: "Used to authenticate outbound API calls without storing the raw token in the connection draft.",
              whereToFind: [paragraph("Create or reuse an env var such as WHATSAPP_ACCESS_TOKEN and store the actual Cloud API token there.")],
              looksLike: "WHATSAPP_ACCESS_TOKEN",
              commonMistakes: ["Pasting the actual token here instead of the env var name."],
              canChangeLater: true,
              placeholder: "WHATSAPP_ACCESS_TOKEN",
            },
            {
              key: "accessToken",
              label: "Access token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry if env-backed secret storage is not ready yet.",
              looksLike: "A long Meta access token string.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "phoneNumberId",
              label: "Phone number ID",
              type: "id",
              required: true,
              explanation: "The Cloud API sender phone-number id for this WhatsApp identity.",
              whyNeeded: "Required for all outbound Cloud API calls.",
              whereToFind: [paragraph("Copy the phone-number id from the WhatsApp Cloud API sender configuration in the Meta developer console.")],
              looksLike: "123456789012345",
              commonMistakes: ["Copying the display phone number instead of the numeric phone-number id."],
              canChangeLater: true,
            },
            {
              key: "defaultTarget",
              label: "Default recipient",
              type: "text",
              required: true,
              explanation: "Fallback direct recipient for manual sends and validation follow-up checks.",
              whyNeeded: "Used when the operator does not provide an explicit recipient target.",
              whereToFind: [paragraph("Use an E.164 phone number such as +15551234567.")],
              looksLike: "+15551234567",
              commonMistakes: ["Using a group JID. The current Cloud API sender is wired for direct recipients only."],
              canChangeLater: true,
            },
            {
              key: "appSecretEnv",
              label: "App secret env var",
              type: "text",
              required: false,
              explanation: "Optional but recommended if you want signed inbound webhook routing.",
              whyNeeded: "Meta signs WhatsApp webhook deliveries with your app secret. Without it GoatCitadel stays outbound only.",
              whereToFind: [paragraph("Copy the app secret from the Meta developer app settings and store it in an env var such as WHATSAPP_APP_SECRET.")],
              looksLike: "WHATSAPP_APP_SECRET",
              commonMistakes: ["Using the access token here instead of the app secret."],
              canChangeLater: true,
              placeholder: "WHATSAPP_APP_SECRET",
            },
            {
              key: "appSecret",
              label: "App secret (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct app-secret entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "webhookVerifyTokenEnv",
              label: "Webhook verify-token env var",
              type: "text",
              required: false,
              explanation: "Optional but recommended if you want GoatCitadel to answer the Meta webhook verification challenge.",
              whyNeeded: "The verify token is compared during GET webhook subscription validation before Meta begins signed POST deliveries.",
              whereToFind: [paragraph("Choose your own random token value, store it in an env var such as WHATSAPP_WEBHOOK_VERIFY_TOKEN, and use the same value when configuring the Meta webhook subscription.")],
              looksLike: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
              canChangeLater: true,
              placeholder: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
            },
            {
              key: "webhookVerifyToken",
              label: "Webhook verify token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct verify-token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph("Guided test validates the sender identity live against the Cloud API and can post a sandbox message to the configured default recipient. If you also configure the app secret plus verify token, the runtime can answer the Meta webhook challenge and accept signed inbound deliveries, but operator proof is still manual after finalize."),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.whatsapp.v1",
      secretFieldKeys: ["accessToken", "appSecret", "webhookVerifyToken"],
    },
    validation: {
      validationVersion: "2026.04.whatsapp.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.04.whatsapp.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.whatsapp",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Cloud API access token + phone-number id",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["accessToken", "accessTokenEnv", "token", "tokenEnv"],
        ["appSecret", "appSecretEnv", "webhookSecret", "webhookSecretEnv"],
        ["webhookVerifyToken", "webhookVerifyTokenEnv", "verifyToken", "verifyTokenEnv"],
      ]);
      return {
        draft: {
          accessTokenEnv: readString(config, "accessTokenEnv") ?? readString(config, "tokenEnv"),
          appSecretEnv: readString(config, "appSecretEnv") ?? readString(config, "webhookSecretEnv"),
          webhookVerifyTokenEnv: readString(config, "webhookVerifyTokenEnv") ?? readString(config, "verifyTokenEnv"),
          phoneNumberId: readString(config, "phoneNumberId"),
          defaultTarget: readString(config, "defaultTarget"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            accessToken: readString(config, "accessToken") || readString(config, "accessTokenEnv") || readString(config, "token") || readString(config, "tokenEnv")
              ? "configured"
              : "missing",
            accessTokenEnv: readString(config, "accessTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            appSecret: readString(config, "appSecret") || readString(config, "appSecretEnv") || readString(config, "webhookSecret") || readString(config, "webhookSecretEnv")
              ? "configured"
              : "unknown",
            appSecretEnv: readString(config, "appSecretEnv") || readString(config, "webhookSecretEnv") ? "configured" : "unknown",
            webhookVerifyToken: readString(config, "webhookVerifyToken") || readString(config, "webhookVerifyTokenEnv") || readString(config, "verifyToken") || readString(config, "verifyTokenEnv")
              ? "configured"
              : "unknown",
            webhookVerifyTokenEnv: readString(config, "webhookVerifyTokenEnv") || readString(config, "verifyTokenEnv") ? "configured" : "unknown",
            phoneNumberId: readString(config, "phoneNumberId") ? "configured" : "missing",
            defaultTarget: readString(config, "defaultTarget") ? "configured" : "missing",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const preservedAccessToken = readLegacyString(draft, "accessToken", "token");
      const preservedAccessTokenEnv = readLegacyString(draft, "accessTokenEnv", "tokenEnv");
      const preservedAppSecret = readLegacyString(draft, "appSecret", "webhookSecret");
      const preservedAppSecretEnv = readLegacyString(draft, "appSecretEnv", "webhookSecretEnv");
      const preservedVerifyToken = readLegacyString(draft, "webhookVerifyToken", "verifyToken");
      const preservedVerifyTokenEnv = readLegacyString(draft, "webhookVerifyTokenEnv", "verifyTokenEnv");
      return compactRecord({
        accessTokenEnv: readString(draft.draft, "accessTokenEnv") ?? preservedAccessTokenEnv,
        accessToken: readString(draft.draft, "accessToken") ?? preservedAccessToken,
        appSecretEnv: readString(draft.draft, "appSecretEnv") ?? preservedAppSecretEnv,
        appSecret: readString(draft.draft, "appSecret") ?? preservedAppSecret,
        webhookVerifyTokenEnv: readString(draft.draft, "webhookVerifyTokenEnv") ?? preservedVerifyTokenEnv,
        webhookVerifyToken: readString(draft.draft, "webhookVerifyToken") ?? preservedVerifyToken,
        phoneNumberId: readString(draft.draft, "phoneNumberId"),
        defaultTarget: readString(draft.draft, "defaultTarget"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "accessToken")
        || readString(draft.draft, "accessTokenEnv")
        || draft.hydration?.fieldState.accessToken === "configured"
        || draft.hydration?.fieldState.accessTokenEnv === "configured",
      );
      const phoneNumberId = readString(draft.draft, "phoneNumberId");
      if (!hasConfiguredToken) {
        issues.push({
          key: "whatsapp_auth_missing",
          level: "error",
          message: "Provide either a WhatsApp access token or an env-backed token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!phoneNumberId) {
        issues.push(requiredFieldIssue("phoneNumberId", "Phone number ID is required."));
      } else if (!/^\d{6,}$/.test(phoneNumberId)) {
        issues.push(malformedFieldIssue("phoneNumberId", "Phone number ID should look like a numeric WhatsApp sender id."));
      }
      if (!readString(draft.draft, "defaultTarget")) {
        issues.push(requiredFieldIssue("defaultTarget", "Default recipient is required."));
      }
      return issues;
    },
  };
}

function createSignalDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.signal");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bridge_dependent",
      contentVersion: "2026.04.signal.v1",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Configure a Signal bridge endpoint, optional account id, and a default recipient for outbound sends.",
      prerequisites: [
        "A running Signal bridge endpoint that GoatCitadel can reach.",
        "A sandbox recipient or group for manual send confirmation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses the configured Signal bridge for outbound sends to individual recipients or groups."),
            note("warning", "Signal ships as a narrow outbound bridge. Guided setup now runs a live sandbox send against that exact send path, but it does not imply richer actions beyond the current bridge lane."),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your bridge values",
          fields: [
            {
              key: "baseUrl",
              label: "Bridge URL",
              type: "url",
              required: true,
              explanation: "HTTP or HTTPS base URL for the Signal bridge GoatCitadel should call.",
              whyNeeded: "Required for every outbound send.",
              whereToFind: [paragraph("Use the reachable base URL for your Signal bridge, such as a local signal-cli REST or JSON-RPC proxy.")],
              looksLike: "http://127.0.0.1:8080",
              commonMistakes: ["Using a browser dashboard URL instead of the API base URL."],
              canChangeLater: true,
            },
            {
              key: "accountId",
              label: "Account ID",
              type: "text",
              required: false,
              explanation: "Optional sender account identifier when the bridge exposes multiple Signal accounts.",
              looksLike: "+15551234567",
              canChangeLater: true,
            },
            {
              key: "defaultRecipient",
              label: "Default recipient",
              type: "text",
              required: true,
              explanation: "Fallback direct recipient or group target for manual sends.",
              looksLike: "+15551234567 or group identifier",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph("Guided test posts a sandbox send through the configured Signal JSON-RPC bridge path against the default recipient or group target. Manual confirmation still closes the loop because the bridge does not expose a safe cleanup path."),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.signal.v1",
      secretFieldKeys: [],
    },
    validation: {
      validationVersion: "2026.04.signal.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.signal.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.signal",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://github.com/bbernhard/signal-cli-rest-api",
      lastReviewedAt: "2026-04-01",
      volatility: "high",
      deprecationRisk: "medium",
      preferredPathLabel: "Signal bridge URL",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      return {
        draft: {
          baseUrl: readString(config, "baseUrl") ?? readString(config, "bridgeUrl"),
          accountId: readString(config, "accountId"),
          defaultRecipient: readString(config, "defaultRecipient"),
        },
        hydration: {
          status: "clean",
          fieldState: {
            baseUrl: readString(config, "baseUrl") || readString(config, "bridgeUrl") ? "configured" : "missing",
            accountId: readString(config, "accountId") ? "configured" : "unknown",
            defaultRecipient: readString(config, "defaultRecipient") ? "configured" : "missing",
          },
          warnings: [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      return compactRecord({
        baseUrl: readString(draft.draft, "baseUrl") ?? readLegacyString(draft, "baseUrl", "bridgeUrl"),
        accountId: readString(draft.draft, "accountId"),
        defaultRecipient: readString(draft.draft, "defaultRecipient"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const baseUrl = readString(draft.draft, "baseUrl") ?? readLegacyString(draft, "baseUrl", "bridgeUrl");
      if (!baseUrl) {
        issues.push(requiredFieldIssue("baseUrl", "Bridge URL is required."));
      } else if (!looksLikeHttpUrl(baseUrl)) {
        issues.push(malformedFieldIssue("baseUrl", "Bridge URL should start with http:// or https://."));
      }
      if (!readString(draft.draft, "defaultRecipient")) {
        issues.push(requiredFieldIssue("defaultRecipient", "Default recipient is required."));
      }
      return issues;
    },
  };
}

function createMattermostDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.mattermost");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "2026.04.mattermost.v1",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Connect Mattermost using a reachable server URL, a bot token, and a default channel target.",
      prerequisites: [
        "A Mattermost workspace with a bot account or bot token.",
        "A sandbox channel where the bot can post.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses Mattermost bot-token auth for outbound sends, replies, reactions, and unsend."),
            note("warning", "Mattermost still counts as planned parity work. Guided setup now runs live auth, channel access, and sandbox send/delete probes before finalize, but it does not change the maturity claim."),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "serverUrl",
              label: "Server URL",
              type: "url",
              required: true,
              explanation: "Reachable Mattermost server base URL.",
              looksLike: "https://chat.example.com",
              canChangeLater: true,
            },
            {
              key: "botTokenEnv",
              label: "Bot token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the Mattermost bot token.",
              looksLike: "MATTERMOST_BOT_TOKEN",
              canChangeLater: true,
              placeholder: "MATTERMOST_BOT_TOKEN",
            },
            {
              key: "botToken",
              label: "Bot token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct bot-token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultChannel",
              label: "Default channel",
              type: "text",
              required: true,
              explanation: "Fallback Mattermost channel slug or id.",
              looksLike: "town-square or channel-id",
              canChangeLater: true,
            },
            {
              key: "defaultTeam",
              label: "Default team",
              type: "text",
              required: false,
              explanation: "Optional team slug for channel resolution when channel names are ambiguous.",
              looksLike: "goatcitadel",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph("Guided test authenticates the bot token live, resolves the configured channel target, and posts a sandbox message that is deleted automatically when cleanup permissions are available."),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.mattermost.v1",
      secretFieldKeys: ["botToken"],
    },
    validation: {
      validationVersion: "2026.04.mattermost.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.04.mattermost.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.mattermost",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://developers.mattermost.com/integrate/reference/server/server-reference/",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Bot token + default channel",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["botToken", "botTokenEnv", "token", "tokenEnv"]]);
      return {
        draft: {
          serverUrl: readString(config, "serverUrl"),
          botTokenEnv: readString(config, "botTokenEnv") ?? readString(config, "tokenEnv"),
          defaultChannel: readString(config, "defaultChannel"),
          defaultTeam: readString(config, "defaultTeam"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            serverUrl: readString(config, "serverUrl") ? "configured" : "missing",
            botToken: readString(config, "botToken") || readString(config, "botTokenEnv") || readString(config, "token") || readString(config, "tokenEnv")
              ? "configured"
              : "missing",
            botTokenEnv: readString(config, "botTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            defaultChannel: readString(config, "defaultChannel") ? "configured" : "missing",
            defaultTeam: readString(config, "defaultTeam") ? "configured" : "unknown",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const preservedBotToken = readLegacyString(draft, "botToken", "token");
      const preservedBotTokenEnv = readLegacyString(draft, "botTokenEnv", "tokenEnv");
      return compactRecord({
        serverUrl: readString(draft.draft, "serverUrl"),
        botTokenEnv: readString(draft.draft, "botTokenEnv") ?? preservedBotTokenEnv,
        botToken: readString(draft.draft, "botToken") ?? preservedBotToken,
        defaultChannel: readString(draft.draft, "defaultChannel"),
        defaultTeam: readString(draft.draft, "defaultTeam"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const serverUrl = readString(draft.draft, "serverUrl");
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "botToken")
        || readString(draft.draft, "botTokenEnv")
        || draft.hydration?.fieldState.botToken === "configured"
        || draft.hydration?.fieldState.botTokenEnv === "configured",
      );
      if (!serverUrl) {
        issues.push(requiredFieldIssue("serverUrl", "Server URL is required."));
      } else if (!looksLikeHttpUrl(serverUrl)) {
        issues.push(malformedFieldIssue("serverUrl", "Server URL should start with http:// or https://."));
      }
      if (!hasConfiguredToken) {
        issues.push({
          key: "mattermost_auth_missing",
          level: "error",
          message: "Provide either a Mattermost bot token or an env-backed bot-token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultChannel")) {
        issues.push(requiredFieldIssue("defaultChannel", "Default channel is required."));
      }
      return issues;
    },
  };
}

function createIMessageDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.imessage");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bridge_dependent",
      contentVersion: "2026.04.imessage.v1",
      estimatedMinutes: 10,
      difficulty: "advanced",
      manualModePolicy: "available-secondary",
      introSummary: "Configure a BlueBubbles-compatible iMessage bridge URL, bridge password, and a default handle or chat target.",
      prerequisites: [
        "A reachable BlueBubbles bridge with outbound send support.",
        "A Mac-side BlueBubbles installation already paired with the account you intend to send from.",
        "A sandbox handle or chat target for manual validation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses a BlueBubbles-compatible bridge for outbound iMessage sends, replies, reactions, and unsend."),
            note("warning", "BlueBubbles-specific edge cases still apply. Guided setup now runs a live bridge query plus a sandbox send/unsend cycle, but new-handle attachment delivery can still require chat creation support and reactions or unsend still depend on Private API support."),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your bridge values",
          fields: [
            {
              key: "bridgeUrl",
              label: "Bridge URL",
              type: "url",
              required: true,
              explanation: "Reachable BlueBubbles bridge base URL.",
              looksLike: "http://127.0.0.1:3001",
              canChangeLater: true,
            },
            {
              key: "passwordEnv",
              label: "Bridge password env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the BlueBubbles bridge password.",
              looksLike: "IMESSAGE_PASSWORD",
              canChangeLater: true,
              placeholder: "IMESSAGE_PASSWORD",
            },
            {
              key: "password",
              label: "Bridge password (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct bridge-password entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultHandle",
              label: "Default handle",
              type: "text",
              required: true,
              explanation: "Fallback iMessage handle or chat identifier for manual sends.",
              looksLike: "imessage:+15551234567 or chat_guid:iMessage;-;+15551234567",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph("Guided test queries the BlueBubbles bridge live, then sends and unsends a sandbox message against the configured default handle or chat target."),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.imessage.v1",
      secretFieldKeys: ["password"],
    },
    validation: {
      validationVersion: "2026.04.imessage.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.04.imessage.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.imessage",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://bluebubbles.app/",
      lastReviewedAt: "2026-04-01",
      volatility: "high",
      deprecationRisk: "medium",
      preferredPathLabel: "BlueBubbles bridge URL + password",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["password", "passwordEnv", "apiPassword", "apiPasswordEnv"]]);
      return {
        draft: {
          bridgeUrl: readString(config, "bridgeUrl") ?? readString(config, "baseUrl") ?? readString(config, "serverUrl"),
          passwordEnv: readString(config, "passwordEnv") ?? readString(config, "apiPasswordEnv"),
          defaultHandle: readString(config, "defaultHandle"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            bridgeUrl: readString(config, "bridgeUrl") || readString(config, "baseUrl") || readString(config, "serverUrl")
              ? "configured"
              : "missing",
            password: readString(config, "password") || readString(config, "passwordEnv") || readString(config, "apiPassword") || readString(config, "apiPasswordEnv")
              ? "configured"
              : "missing",
            passwordEnv: readString(config, "passwordEnv") || readString(config, "apiPasswordEnv") ? "configured" : "unknown",
            defaultHandle: readString(config, "defaultHandle") ? "configured" : "missing",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const preservedPassword = readLegacyString(draft, "password", "apiPassword");
      const preservedPasswordEnv = readLegacyString(draft, "passwordEnv", "apiPasswordEnv");
      return compactRecord({
        bridgeUrl: readString(draft.draft, "bridgeUrl") ?? readLegacyString(draft, "bridgeUrl", "baseUrl", "serverUrl"),
        passwordEnv: readString(draft.draft, "passwordEnv") ?? preservedPasswordEnv,
        password: readString(draft.draft, "password") ?? preservedPassword,
        defaultHandle: readString(draft.draft, "defaultHandle"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const bridgeUrl = readString(draft.draft, "bridgeUrl") ?? readLegacyString(draft, "bridgeUrl", "baseUrl", "serverUrl");
      const hasConfiguredPassword = Boolean(
        readString(draft.draft, "password")
        || readString(draft.draft, "passwordEnv")
        || draft.hydration?.fieldState.password === "configured"
        || draft.hydration?.fieldState.passwordEnv === "configured",
      );
      if (!bridgeUrl) {
        issues.push(requiredFieldIssue("bridgeUrl", "Bridge URL is required."));
      } else if (!looksLikeHttpUrl(bridgeUrl)) {
        issues.push(malformedFieldIssue("bridgeUrl", "Bridge URL should start with http:// or https://."));
      }
      if (!hasConfiguredPassword) {
        issues.push({
          key: "imessage_auth_missing",
          level: "error",
          message: "Provide either an iMessage bridge password or an env-backed password reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultHandle")) {
        issues.push(requiredFieldIssue("defaultHandle", "Default handle is required."));
      }
      return issues;
    },
  };
}

function createNextcloudTalkDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.nextcloud-talk");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "2026.04.nextcloud-talk.v1",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Connect Nextcloud Talk using the public base URL, the shared bot token, and a default fallback room id.",
      prerequisites: [
        "A reachable Nextcloud Talk instance.",
        "A Talk bot token or shared webhook secret already provisioned for the integration.",
        "A fallback room id for manual sends.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses the Nextcloud Talk bot API plus signed webhooks for inbound events, outbound replies, and reactions."),
            note("info", "Nextcloud Talk already has runtime support in the gateway. This guided definition brings its setup flow into parity with the other visible channel setup wizards."),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "baseUrl",
              label: "Base URL",
              type: "url",
              required: true,
              explanation: "Public base URL for the Nextcloud instance that hosts Talk.",
              looksLike: "https://cloud.example.com",
              canChangeLater: true,
            },
            {
              key: "tokenEnv",
              label: "Token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the shared Nextcloud Talk bot token or webhook secret.",
              looksLike: "NEXTCLOUD_TALK_TOKEN",
              canChangeLater: true,
              placeholder: "NEXTCLOUD_TALK_TOKEN",
            },
            {
              key: "token",
              label: "Token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultRoomId",
              label: "Default room ID",
              type: "text",
              required: true,
              explanation: "Fallback room for manual sends and operator-delivery routing.",
              looksLike: "room-id",
              canChangeLater: true,
            },
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.nextcloud-talk.v1",
      secretFieldKeys: ["token"],
    },
    validation: {
      validationVersion: "2026.04.nextcloud-talk.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.nextcloud-talk.v1",
      levels: ["structural", "semantic", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.nextcloud_talk",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://nextcloud-talk.readthedocs.io/en/latest/bots/",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Base URL + Talk token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["token", "tokenEnv", "botSecret", "botSecretEnv", "secret", "secretEnv"]]);
      return {
        draft: {
          baseUrl: readString(config, "baseUrl"),
          tokenEnv: readString(config, "tokenEnv") ?? readString(config, "botSecretEnv") ?? readString(config, "secretEnv"),
          defaultRoomId: readString(config, "defaultRoomId"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            baseUrl: readString(config, "baseUrl") ? "configured" : "missing",
            token: readString(config, "token") || readString(config, "tokenEnv") || readString(config, "botSecret") || readString(config, "botSecretEnv") || readString(config, "secret") || readString(config, "secretEnv")
              ? "configured"
              : "missing",
            tokenEnv: readString(config, "tokenEnv") || readString(config, "botSecretEnv") || readString(config, "secretEnv") ? "configured" : "unknown",
            defaultRoomId: readString(config, "defaultRoomId") ? "configured" : "missing",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const preservedToken = readLegacyString(draft, "token", "botSecret", "secret");
      const preservedTokenEnv = readLegacyString(draft, "tokenEnv", "botSecretEnv", "secretEnv");
      return compactRecord({
        baseUrl: readString(draft.draft, "baseUrl"),
        tokenEnv: readString(draft.draft, "tokenEnv") ?? preservedTokenEnv,
        token: readString(draft.draft, "token") ?? preservedToken,
        defaultRoomId: readString(draft.draft, "defaultRoomId"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const baseUrl = readString(draft.draft, "baseUrl");
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "token")
        || readString(draft.draft, "tokenEnv")
        || draft.hydration?.fieldState.token === "configured"
        || draft.hydration?.fieldState.tokenEnv === "configured",
      );
      if (!baseUrl) {
        issues.push(requiredFieldIssue("baseUrl", "Base URL is required."));
      } else if (!looksLikeHttpUrl(baseUrl)) {
        issues.push(malformedFieldIssue("baseUrl", "Base URL should start with http:// or https://."));
      }
      if (!hasConfiguredToken) {
        issues.push({
          key: "nextcloud_talk_auth_missing",
          level: "error",
          message: "Provide either a Nextcloud Talk token or an env-backed token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultRoomId")) {
        issues.push(requiredFieldIssue("defaultRoomId", "Default room ID is required."));
      }
      return issues;
    },
  };
}

function createLineDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.line");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bot_token_target",
      contentVersion: "2026.04.line.v1",
      estimatedMinutes: 6,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Connect LINE with a channel access token and a default user, room, or group target.",
      prerequisites: [
        "A LINE Messaging API channel with a valid channel access token.",
        "A sandbox target identifier for manual confirmation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses the LINE Messaging API for outbound sends and can accept signed inbound webhook events when you configure the channel secret."),
            note("warning", "LINE still counts as planned parity work. Guided setup now runs a live token-auth probe and can post a sandbox push message to the configured default target, but it does not change the maturity claim."),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "channelAccessTokenEnv",
              label: "Channel access token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the LINE channel access token.",
              looksLike: "LINE_CHANNEL_ACCESS_TOKEN",
              canChangeLater: true,
              placeholder: "LINE_CHANNEL_ACCESS_TOKEN",
            },
            {
              key: "channelAccessToken",
              label: "Channel access token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "channelSecretEnv",
              label: "Channel secret env var",
              type: "text",
              required: false,
              explanation: "Optional but recommended if you want signed inbound webhook routing.",
              whyNeeded: "LINE signs webhook deliveries with the channel secret. Without it GoatCitadel stays outbound only.",
              looksLike: "LINE_CHANNEL_SECRET",
              canChangeLater: true,
              placeholder: "LINE_CHANNEL_SECRET",
            },
            {
              key: "channelSecret",
              label: "Channel secret (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct channel-secret entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultTarget",
              label: "Default target",
              type: "text",
              required: true,
              explanation: "Fallback LINE user, room, or group id.",
              looksLike: "userId, groupId, or roomId",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph("Guided test validates the channel access token live and can post a sandbox push message to the configured default target. Inbound webhook routing still requires the optional channel secret."),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.line.v1",
      secretFieldKeys: ["channelAccessToken", "channelSecret"],
    },
    validation: {
      validationVersion: "2026.04.line.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.04.line.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.line",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://developers.line.biz/en/docs/messaging-api/",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Channel access token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["channelAccessToken", "channelAccessTokenEnv", "accessToken", "accessTokenEnv", "token", "tokenEnv"],
        ["channelSecret", "channelSecretEnv", "secret", "secretEnv"],
      ]);
      return {
        draft: {
          channelAccessTokenEnv: readString(config, "channelAccessTokenEnv") ?? readString(config, "accessTokenEnv") ?? readString(config, "tokenEnv"),
          channelSecretEnv: readString(config, "channelSecretEnv") ?? readString(config, "secretEnv"),
          defaultTarget: readString(config, "defaultTarget"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            channelAccessToken: readString(config, "channelAccessToken") || readString(config, "channelAccessTokenEnv") || readString(config, "accessToken") || readString(config, "accessTokenEnv") || readString(config, "token") || readString(config, "tokenEnv")
              ? "configured"
              : "missing",
            channelAccessTokenEnv: readString(config, "channelAccessTokenEnv") || readString(config, "accessTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            channelSecret: readString(config, "channelSecret") || readString(config, "channelSecretEnv") || readString(config, "secret") || readString(config, "secretEnv")
              ? "configured"
              : "unknown",
            channelSecretEnv: readString(config, "channelSecretEnv") || readString(config, "secretEnv") ? "configured" : "unknown",
            defaultTarget: readString(config, "defaultTarget") ? "configured" : "missing",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const preservedToken = readLegacyString(draft, "channelAccessToken", "accessToken", "token");
      const preservedTokenEnv = readLegacyString(draft, "channelAccessTokenEnv", "accessTokenEnv", "tokenEnv");
      const preservedChannelSecret = readLegacyString(draft, "channelSecret", "secret");
      const preservedChannelSecretEnv = readLegacyString(draft, "channelSecretEnv", "secretEnv");
      return compactRecord({
        channelAccessTokenEnv: readString(draft.draft, "channelAccessTokenEnv") ?? preservedTokenEnv,
        channelAccessToken: readString(draft.draft, "channelAccessToken") ?? preservedToken,
        channelSecretEnv: readString(draft.draft, "channelSecretEnv") ?? preservedChannelSecretEnv,
        channelSecret: readString(draft.draft, "channelSecret") ?? preservedChannelSecret,
        defaultTarget: readString(draft.draft, "defaultTarget"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "channelAccessToken")
        || readString(draft.draft, "channelAccessTokenEnv")
        || draft.hydration?.fieldState.channelAccessToken === "configured"
        || draft.hydration?.fieldState.channelAccessTokenEnv === "configured",
      );
      if (!hasConfiguredToken) {
        issues.push({
          key: "line_auth_missing",
          level: "error",
          message: "Provide either a LINE channel access token or an env-backed token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultTarget")) {
        issues.push(requiredFieldIssue("defaultTarget", "Default target is required."));
      }
      return issues;
    },
  };
}

function createZaloDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.zalo");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "platform_api_resource_ids",
      contentVersion: "2026.04.zalo.v1",
      estimatedMinutes: 6,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Connect a Zalo Official Account sender with an access token and a default recipient id.",
      prerequisites: [
        "A Zalo Official Account bot token.",
        "A sandbox Zalo recipient id for manual confirmation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses the Zalo Official Account send path for outbound text delivery to the configured recipient id."),
            note("warning", "Zalo OA ships as a narrow outbound lane. Guided setup now runs a live sandbox send against the OA send endpoint, but it does not claim broader inbound or action parity."),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "accessTokenEnv",
              label: "Access token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the Zalo access token.",
              looksLike: "ZALO_ACCESS_TOKEN",
              canChangeLater: true,
              placeholder: "ZALO_ACCESS_TOKEN",
            },
            {
              key: "accessToken",
              label: "Access token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultRecipientId",
              label: "Default recipient ID",
              type: "text",
              required: true,
              explanation: "Fallback Zalo recipient id for manual sends.",
              looksLike: "zalo-user-id",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph("Guided test posts a sandbox message through the Zalo Official Account send endpoint using the configured default recipient id. Manual confirmation is still required because the API path does not expose safe cleanup here."),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.zalo.v1",
      secretFieldKeys: ["accessToken"],
    },
    validation: {
      validationVersion: "2026.04.zalo.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.zalo.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.zalo",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      officialDocsUrl: "https://developers.zalo.me/docs/api/official-account-api/thong-tin-chung-ve-official-account-api",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "medium",
      preferredPathLabel: "Official Account access token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["accessToken", "accessTokenEnv", "token", "tokenEnv"]]);
      return {
        draft: {
          accessTokenEnv: readString(config, "accessTokenEnv") ?? readString(config, "tokenEnv"),
          defaultRecipientId: readString(config, "defaultRecipientId"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            accessToken: readString(config, "accessToken") || readString(config, "accessTokenEnv") || readString(config, "token") || readString(config, "tokenEnv")
              ? "configured"
              : "missing",
            accessTokenEnv: readString(config, "accessTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            defaultRecipientId: readString(config, "defaultRecipientId") ? "configured" : "missing",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const preservedAccessToken = readLegacyString(draft, "accessToken", "token");
      const preservedAccessTokenEnv = readLegacyString(draft, "accessTokenEnv", "tokenEnv");
      return compactRecord({
        accessTokenEnv: readString(draft.draft, "accessTokenEnv") ?? preservedAccessTokenEnv,
        accessToken: readString(draft.draft, "accessToken") ?? preservedAccessToken,
        defaultRecipientId: readString(draft.draft, "defaultRecipientId"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "accessToken")
        || readString(draft.draft, "accessTokenEnv")
        || draft.hydration?.fieldState.accessToken === "configured"
        || draft.hydration?.fieldState.accessTokenEnv === "configured",
      );
      if (!hasConfiguredToken) {
        issues.push({
          key: "zalo_auth_missing",
          level: "error",
          message: "Provide either a Zalo access token or an env-backed token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultRecipientId")) {
        issues.push(requiredFieldIssue("defaultRecipientId", "Default recipient ID is required."));
      }
      return issues;
    },
  };
}

function createZaloUserDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.zalouser");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bridge_dependent",
      contentVersion: "2026.04.zalouser.v1",
      estimatedMinutes: 8,
      difficulty: "advanced",
      manualModePolicy: "available-secondary",
      introSummary: "Configure a zca bridge URL, optional bearer token, optional profile, and a default Zalo personal-session target.",
      prerequisites: [
        "A reachable zca bridge endpoint.",
        "A sandbox personal or group target for manual confirmation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses a zca-compatible personal-session bridge for outbound text sends to direct or group targets."),
            note("warning", "Zalo User remains a narrow bridge lane. Guided setup now runs a live sandbox send against the bridge text endpoint, but richer actions still depend on the separate bridge runtime and its current bounds."),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your bridge values",
          fields: [
            {
              key: "baseUrl",
              label: "Bridge URL",
              type: "url",
              required: true,
              explanation: "Reachable base URL for the zca personal-session bridge.",
              looksLike: "http://127.0.0.1:56789",
              canChangeLater: true,
            },
            {
              key: "authTokenEnv",
              label: "Bearer token env var",
              type: "text",
              required: false,
              explanation: "Optional env var name for the zca bearer token when the bridge is not local or open.",
              looksLike: "ZALOUSER_AUTH_TOKEN",
              canChangeLater: true,
              placeholder: "ZALOUSER_AUTH_TOKEN",
            },
            {
              key: "authToken",
              label: "Bearer token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct bearer-token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "profile",
              label: "Profile",
              type: "text",
              required: false,
              explanation: "Optional zca profile name when the bridge exposes multiple sessions.",
              looksLike: "work",
              canChangeLater: true,
            },
            {
              key: "defaultTarget",
              label: "Default recipient",
              type: "text",
              required: true,
              explanation: "Fallback personal-session recipient or group target.",
              looksLike: "user:u-123456789 or group:g-987654321",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph("Guided test posts a sandbox text message through the configured zca bridge profile and default target. Manual confirmation is still required because cleanup is bridge-dependent and not safely automatable here."),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.zalouser.v1",
      secretFieldKeys: ["authToken"],
    },
    validation: {
      validationVersion: "2026.04.zalouser.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.zalouser.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.zalouser",
    },
    lifecycle: {
      supportedModes: ["create", "edit", "repair", "rotate_secret", "retest"],
      supportsDrafts: true,
      supportsEdit: true,
      supportsRepair: true,
      supportsRotateSecret: true,
      supportsRetest: true,
    },
    volatility: {
      lastReviewedAt: "2026-04-01",
      volatility: "high",
      deprecationRisk: "medium",
      preferredPathLabel: "zca bridge URL + optional bearer token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["authToken", "authTokenEnv", "authorization", "authorizationEnv", "accessToken", "accessTokenEnv", "basicAuth", "basicAuthEnv"]]);
      return {
        draft: {
          baseUrl: readString(config, "baseUrl") ?? readString(config, "bridgeUrl") ?? readString(config, "serverUrl"),
          authTokenEnv: readString(config, "authTokenEnv") ?? readString(config, "authorizationEnv") ?? readString(config, "accessTokenEnv"),
          profile: readString(config, "profile"),
          defaultTarget: readString(config, "defaultTarget"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            baseUrl: readString(config, "baseUrl") || readString(config, "bridgeUrl") || readString(config, "serverUrl")
              ? "configured"
              : "missing",
            authToken: readString(config, "authToken") || readString(config, "authTokenEnv") || readString(config, "authorization") || readString(config, "authorizationEnv") || readString(config, "accessToken") || readString(config, "accessTokenEnv") || readString(config, "basicAuth") || readString(config, "basicAuthEnv")
              ? "configured"
              : "unknown",
            authTokenEnv: readString(config, "authTokenEnv") || readString(config, "authorizationEnv") || readString(config, "accessTokenEnv") || readString(config, "basicAuthEnv")
              ? "configured"
              : "unknown",
            profile: readString(config, "profile") ? "configured" : "unknown",
            defaultTarget: readString(config, "defaultTarget") ? "configured" : "missing",
          },
          warnings: hasConfiguredSecret
            ? ["Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them."]
            : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      const explicitAuthToken = readString(draft.draft, "authToken");
      const explicitAuthTokenEnv = readString(draft.draft, "authTokenEnv");
      const legacyAuthorization = !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "authorization") : undefined;
      const legacyAuthorizationEnv = !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "authorizationEnv") : undefined;
      const legacyAccessToken = !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "accessToken") : undefined;
      const legacyAccessTokenEnv = !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "accessTokenEnv") : undefined;
      const legacyBasicAuth = !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "basicAuth") : undefined;
      const legacyBasicAuthEnv = !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "basicAuthEnv") : undefined;
      return compactRecord({
        baseUrl: readString(draft.draft, "baseUrl") ?? readLegacyString(draft, "baseUrl", "bridgeUrl", "serverUrl"),
        authTokenEnv: explicitAuthTokenEnv ?? readLegacyString(draft, "authTokenEnv"),
        authToken: explicitAuthToken ?? readLegacyString(draft, "authToken"),
        authorization: legacyAuthorization,
        authorizationEnv: legacyAuthorizationEnv,
        accessToken: legacyAccessToken,
        accessTokenEnv: legacyAccessTokenEnv,
        basicAuth: legacyBasicAuth,
        basicAuthEnv: legacyBasicAuthEnv,
        profile: readString(draft.draft, "profile"),
        defaultTarget: readString(draft.draft, "defaultTarget"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const baseUrl = readString(draft.draft, "baseUrl") ?? readLegacyString(draft, "baseUrl", "bridgeUrl", "serverUrl");
      if (!baseUrl) {
        issues.push(requiredFieldIssue("baseUrl", "Bridge URL is required."));
      } else if (!looksLikeHttpUrl(baseUrl)) {
        issues.push(malformedFieldIssue("baseUrl", "Bridge URL should start with http:// or https://."));
      }
      if (!readString(draft.draft, "defaultTarget")) {
        issues.push(requiredFieldIssue("defaultTarget", "Default recipient is required."));
      }
      return issues;
    },
  };
}

function requireCatalog(catalogId: string): IntegrationCatalogEntry {
  const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === catalogId);
  if (!catalog) {
    throw new Error(`Missing integration catalog entry for ${catalogId}.`);
  }
  return catalog;
}

function baseCatalogMeta(catalog: IntegrationCatalogEntry, supportedModes: string[]): ChannelSetupDefinition["catalog"] {
  return {
    catalogId: catalog.catalogId,
    key: catalog.key,
    label: catalog.label,
    description: catalog.description,
    kind: catalog.kind,
    capabilities: catalog.capabilities,
    maturity: catalog.maturity,
    supportedModes,
  };
}

function definitionFailures(kind: keyof typeof COMMON_FAILURES) {
  return (COMMON_FAILURES[kind] ?? []).map((entry) => ({
    id: `${kind}-${entry.category}`,
    title: entry.title,
    body: `${entry.summary} ${entry.likelyCauses.join(" ")}`.trim(),
    failureCategory: entry.category,
    nextSteps: entry.nextSteps,
  }));
}

function paragraph(text: string) {
  return { kind: "paragraph", text } as const;
}

function note(tone: ChannelSetupNoticeTone, text: string) {
  return { kind: "note", tone, text } as const;
}

function linkBlock(label: string, href: string) {
  return { kind: "link", label, href, external: true } as const;
}

function check(id: string, label: string, detail?: string) {
  return { id, label, detail };
}

function troubleshoot(id: string, title: string, body: string) {
  return { id, title, body };
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function hasAnyConfiguredSecret(
  config: Record<string, unknown>,
  keyGroups: string[][],
): boolean {
  return keyGroups.some((keys) => keys.some((key) => Boolean(readString(config, key))));
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === undefined || value === null) {
        return false;
      }
      return typeof value !== "string" || value.trim().length > 0;
    }),
  );
}

function resolveDiscordRuntimeMode(draft: ChannelSetupDraft): "bridge" | "gateway" {
  const explicit = readString(draft.draft, "runtimeMode");
  if (explicit === "bridge" || explicit === "gateway") {
    return explicit;
  }
  const hasBotToken = Boolean(readString(draft.draft, "botToken") || readString(draft.draft, "botTokenEnv"));
  const hasWebhook = Boolean(readString(draft.draft, "webhookUrl"));
  if (draft.lifecycleMode === "create") {
    return hasWebhook && !hasBotToken ? "bridge" : "gateway";
  }
  return "bridge";
}

function inferDiscordConfigRuntimeMode(config: Record<string, unknown>): "bridge" | "gateway" {
  const hasBotToken = Boolean(
    readString(config, "botToken")
    || readString(config, "botTokenEnv")
    || readString(config, "token")
    || readString(config, "tokenEnv"),
  );
  const hasWebhook = Boolean(
    readString(config, "webhookUrl")
    || readString(config, "webhookUrlEnv"),
  );
  if (hasWebhook && !hasBotToken) {
    return "bridge";
  }
  if (hasBotToken) {
    return "gateway";
  }
  return "bridge";
}

function readLegacyString(draft: ChannelSetupDraft, ...keys: string[]): string | undefined {
  const legacyConfig = draft.hydration?.rawLegacyConfig;
  if (!legacyConfig || typeof legacyConfig !== "object") {
    return undefined;
  }
  for (const key of keys) {
    const value = readString(legacyConfig as Record<string, unknown>, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function requiredFieldIssue(fieldKey: string, message: string): ChannelSetupIssue {
  return {
    key: `${fieldKey}_required`,
    level: "error",
    message,
    fieldKey,
    failureCategory: "missing_input",
  };
}

function malformedFieldIssue(fieldKey: string, message: string): ChannelSetupIssue {
  return {
    key: `${fieldKey}_malformed`,
    level: "error",
    message,
    fieldKey,
    failureCategory: "malformed_value",
  };
}
