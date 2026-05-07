import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  COMMON_FAILURES,
  requireCatalog,
  baseCatalogMeta,
  definitionFailures,
  paragraph,
  note,
  linkBlock,
  check,
  troubleshoot,
  readString,
  hasAnyConfiguredSecret,
  compactRecord,
  resolveDiscordRuntimeMode,
  inferDiscordConfigRuntimeMode,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

export function createDiscordDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.discord");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bot_token_target",
      contentVersion: "2026.03.discord.v2",
      estimatedMinutes: 10,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Discord bot-token setups default to gateway mode so GoatCitadel behaves like a real online bot. Bridge remains available only as an advanced webhook-only fallback.",
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
            paragraph(
              "GoatCitadel treats a Discord bot token as a first-class bot runtime. By default it logs the bot into the official Discord gateway so the bot can appear online, receive inbound DMs, and process allowlisted guild traffic.",
            ),
            paragraph(
              "Bridge mode still exists for advanced webhook-only or outbound-only cases, but it is no longer the default path.",
            ),
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
            paragraph(
              "Open the Discord Developer Portal, create a new application, then open the Bot tab and add a bot user.",
            ),
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
            paragraph(
              "Use the Installation section to generate an install link with the bot scope and the minimum permissions needed in your sandbox channel. Gateway mode also needs the bot installed wherever you want inbound routing.",
            ),
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
            paragraph(
              "If you intentionally want a webhook-only outbound connection, add a Discord webhook URL in advanced settings. That path stays on bridge mode and does not support reactions, inbound routing, or online presence.",
            ),
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
              whyNeeded:
                "Bot-token setups default to gateway mode so GoatCitadel can create the persistent online bot session.",
              whereToFind: [
                paragraph("Create or reuse an env var such as DISCORD_BOT_TOKEN and store the actual token there."),
              ],
              looksLike: "DISCORD_BOT_TOKEN",
              commonMistakes: [
                "Pasting the token value here instead of the env var name.",
                "Using an env var that is not available to the gateway process.",
              ],
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
              whereToFind: [
                paragraph("In the Discord Developer Portal, open your application, then open the Bot tab."),
              ],
              looksLike: "A long opaque token string.",
              commonMistakes: [
                "Pasting the application id instead of the bot token.",
                "Leaving a temporary token here after you intended to switch to env-backed config.",
              ],
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
              whereToFind: [
                paragraph("Enable Developer Mode in Discord, right-click the channel, then choose Copy Channel ID."),
              ],
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
              whereToFind: [
                paragraph("Enable Developer Mode in Discord, right-click the server, then choose Copy Server ID."),
              ],
              looksLike: "987654321098765432",
              canChangeLater: true,
            },
            {
              key: "webhookUrl",
              label: "Optional bridge webhook URL",
              type: "url",
              required: false,
              explanation:
                "Advanced legacy bridge path for outbound sends when you intentionally want webhook-only delivery.",
              whyNeeded:
                "Used only when you explicitly want the older bridge behavior instead of the default gateway bot runtime.",
              whereToFind: [
                paragraph(
                  "Open channel settings in Discord, then Integrations or Webhooks, then copy the webhook URL.",
                ),
              ],
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
              explanation:
                "Gateway mode only. Pairing asks unknown DM senders to complete approval, open routes DMs immediately, and disabled ignores DMs.",
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
              explanation:
                "Gateway mode only. Allowlist processes only configured guilds and channels; off ignores guild traffic entirely.",
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
            paragraph(
              "Bridge mode runs a complete probe: token auth, channel access, and an optional sandbox send/delete check. Gateway mode also reports whether the persistent Discord runtime is ready.",
            ),
          ],
          troubleshooting: definitionFailures("token"),
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "For the normal bot-token path, setup is complete when the runtime reports a live Discord session and your sandbox channel passes the probe.",
            ),
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
      const hydratedRuntimeMode =
        explicitRuntimeMode === "bridge" || explicitRuntimeMode === "gateway"
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
            ? [
                "Saved secrets are intentionally not rehydrated into the wizard. Replace them only if you need to change them.",
              ]
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
        inboundDmPolicy:
          runtimeMode === "gateway" ? (readString(draft.draft, "inboundDmPolicy") ?? "pairing") : undefined,
        guildPolicy: runtimeMode === "gateway" ? (readString(draft.draft, "guildPolicy") ?? "allowlist") : undefined,
        botToken: readString(draft.draft, "botToken") ?? readLegacyString(draft, "botToken", "token"),
        webhookUrl:
          runtimeMode === "bridge"
            ? (readString(draft.draft, "webhookUrl") ?? readLegacyString(draft, "webhookUrl", "webhookUrlEnv"))
            : undefined,
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const runtimeMode = resolveDiscordRuntimeMode(draft);
      const defaultChannelId = readString(draft.draft, "defaultChannelId");
      const hasConfiguredBotToken = Boolean(
        readString(draft.draft, "botToken") ||
        readString(draft.draft, "botTokenEnv") ||
        draft.hydration?.fieldState.botToken === "configured" ||
        draft.hydration?.fieldState.botTokenEnv === "configured",
      );
      const hasConfiguredWebhook = Boolean(
        readString(draft.draft, "webhookUrl") || draft.hydration?.fieldState.webhookUrl === "configured",
      );
      if (!defaultChannelId) {
        issues.push(requiredFieldIssue("defaultChannelId", "Default channel ID is required."));
      } else if (!/^\d{10,}$/.test(defaultChannelId)) {
        issues.push(
          malformedFieldIssue("defaultChannelId", "Default channel ID should look like a Discord numeric ID."),
        );
      }
      if (runtimeMode === "gateway") {
        if (!hasConfiguredBotToken) {
          issues.push(
            requiredFieldIssue("botTokenEnv", "Gateway mode requires a Discord bot token or bot token env var."),
          );
        }
      } else if (!hasConfiguredBotToken && !hasConfiguredWebhook) {
        issues.push({
          key: "discord_bridge_auth_missing",
          level: "error",
          message: "Bridge mode requires either a Discord bot token/env var or a webhook URL.",
          failureCategory: "missing_input",
          nextSteps: [
            "Add a bot token env var for the recommended bridge path, or provide a webhook URL for the legacy bridge-only path.",
          ],
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
