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
      contentVersion: "2026.08.discord.v3",
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
            paragraph(
              "In Privileged Gateway Intents, enable Message Content Intent. GoatCitadel identifies with that intent so it can receive normal message text; Discord can reject the gateway session when the intent is not enabled for the application.",
            ),
            linkBlock("Discord Developer Portal", "https://discord.com/developers/applications"),
            linkBlock("Discord Gateway intent reference", "https://docs.discord.com/developers/events/gateway"),
          ],
          checklist: [
            check("app-created", "Create a new Discord application"),
            check("bot-added", "Add a bot user in the Bot section"),
            check("message-content-intent", "Enable Message Content Intent under Privileged Gateway Intents"),
            check("token-copied", "Copy the bot token or store it in an environment variable"),
          ],
          troubleshooting: [
            troubleshoot(
              "message-content-intent-disabled",
              "Gateway login fails even though the token is valid",
              "Confirm Message Content Intent is enabled on the application's Bot page. A disabled or unapproved privileged intent can close the Discord gateway session even when REST token and channel probes pass.",
            ),
          ],
        },
        {
          id: "install-bot",
          kind: "instruction",
          title: "Add the bot to your server",
          body: [
            paragraph(
              "Use the Installation section to create a server install with the bot scope. Discord currently includes the applications.commands scope with bot installs. Give the bot View Channel, Send Messages, and Read Message History in the sandbox channel. Gateway mode needs the bot installed in every server where you want inbound routing.",
            ),
            note(
              "info",
              "Add Reactions enables GoatCitadel's best-effort seen marker. Send Messages in Threads, Attach Files, and Embed Links are needed only when you want those corresponding capabilities.",
            ),
          ],
          checklist: [
            check("bot-scope", "Use a server install with the bot scope and application commands enabled"),
            check("bot-installed", "Install the bot into the target server"),
            check("channel-visible", "Grant View Channel in the destination channel"),
            check("channel-send", "Grant Send Messages in the destination channel"),
            check("channel-history", "Grant Read Message History in the destination channel"),
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
          body: [
            note(
              "warning",
              "With the recommended server allowlist policy, the default server and channel form one inbound route. Any member who can use that channel may invoke normal messages by mentioning the bot unless you later add narrower user or role rules. Slash commands still follow the server/channel allowlist, but do not require an @mention.",
            ),
          ],
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
                paragraph(
                  "Create or reuse an env var such as DISCORD_BOT_TOKEN and store the actual token there. If you add or change the process environment, restart GoatCitadel before testing so the Gateway can read it.",
                ),
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
              explanation:
                "The sandbox channel GoatCitadel should probe and use when no explicit target is provided. For server inbound, it must belong to the default server below.",
              whyNeeded:
                "Needed for diagnostics, default sends, and as the channel half of the default gateway allowlist route.",
              whereToFind: [
                paragraph("Enable Developer Mode in Discord, right-click the channel, then choose Copy Channel ID."),
              ],
              looksLike: "123456789012345678",
              commonMistakes: [
                "Copying a message id or server id instead of the channel id.",
                "Choosing a channel that belongs to a different server than the server id below.",
              ],
              canChangeLater: true,
            },
            {
              key: "defaultGuildId",
              label: "Default server (guild) ID",
              type: "id",
              required: false,
              explanation:
                "Required for the recommended server allowlist path. It may be omitted only when Gateway guild traffic is off, such as a DM-only setup, or when an existing advanced connection already has explicit guild rules.",
              whyNeeded:
                "Pairs with the default channel to create the wizard's inbound guild route and enables immediate guild-scoped slash-command synchronization.",
              whereToFind: [
                paragraph("Enable Developer Mode in Discord, right-click the server, then choose Copy Server ID."),
              ],
              looksLike: "987654321098765432",
              commonMistakes: [
                "Copying the channel id instead of the server id.",
                "Using a server that does not contain the default channel.",
              ],
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
                "Gateway mode only. Pairing gives an unknown DM sender a pending code that an operator must approve before messages are accepted. Open accepts DMs immediately; disabled ignores them.",
              options: [
                { value: "pairing", label: "Require pairing approval", hint: "Recommended" },
                { value: "open", label: "Accept all DMs", hint: "Any reachable Discord user may start a DM route" },
                { value: "disabled", label: "Disable DMs" },
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
                "Gateway mode only. Allowlist accepts the configured server/channel route; the default route requires an @mention for normal messages. Off ignores guild traffic and is appropriate for DM-only setups.",
              options: [
                { value: "allowlist", label: "Allow selected server and channel", hint: "Recommended" },
                { value: "off", label: "Disable server messages", hint: "DM-only setup" },
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
              "For bot-token setups, Test checks token auth and channel access, confirms the channel belongs to the configured server, posts a visible sandbox message, then deletes it. A new gateway connection cannot start its persistent runtime until it has been saved, so that one readiness check is explicitly deferred until Finish creates the durable connection. Retests of existing gateway connections still check current runtime readiness.",
            ),
            note(
              "warning",
              "The webhook-only bridge fallback is structurally validated but does not receive an automatic live webhook send. Confirm that path manually in Discord.",
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
              "Finish saves the connection and starts the normal bot-token gateway runtime. After the pre-save probes pass, confirm that the saved connection reaches ready state; any login failure remains visible in connection diagnostics for repair.",
            ),
            paragraph(
              "Then mention the bot in the sandbox channel and confirm it replies. If DM policy is pairing, the first DM creates a pending code that must be approved before that sender's next message is accepted.",
            ),
          ],
          successCriteria: [
            "Token auth succeeds or the advanced webhook-only bridge path is intentionally configured.",
            "The default channel is reachable and belongs to the configured default server when a server id is set.",
            "New gateway setups defer runtime readiness until the durable connection is created; existing gateway connections must pass their current runtime check.",
            "A manual @mention in the allowlisted sandbox channel reaches GoatCitadel; paired DMs are approved before use.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.03.discord.v2",
      secretFieldKeys: ["botToken", "webhookUrl"],
    },
    validation: {
      validationVersion: "2026.08.discord.v3",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.08.discord.v3",
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
      lastReviewedAt: "2026-08-07",
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
        // Do NOT fall back to webhookUrlEnv for webhookUrl — that leaks the env-var NAME into the
        // literal URL field. Preserve webhookUrlEnv as its own field so env-backed bridge
        // delivery (resolved via secretFrom(config,"webhookUrl","webhookUrlEnv")) still works.
        webhookUrl:
          runtimeMode === "bridge"
            ? (readString(draft.draft, "webhookUrl") ?? readLegacyString(draft, "webhookUrl"))
            : undefined,
        webhookUrlEnv:
          runtimeMode === "bridge"
            ? (readString(draft.draft, "webhookUrlEnv") ?? readLegacyString(draft, "webhookUrlEnv"))
            : undefined,
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const runtimeMode = resolveDiscordRuntimeMode(draft);
      const defaultChannelId = readString(draft.draft, "defaultChannelId");
      const defaultGuildId = readString(draft.draft, "defaultGuildId");
      const guildPolicy = readString(draft.draft, "guildPolicy") ?? "allowlist";
      const hasSavedExplicitGuildRules = hasConfiguredGuildRules(draft.hydration?.rawLegacyConfig?.guilds);
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
        if (guildPolicy === "allowlist" && !defaultGuildId && !hasSavedExplicitGuildRules) {
          issues.push(
            requiredFieldIssue(
              "defaultGuildId",
              "Default server (guild) ID is required when Gateway guild policy uses the allowlist. Choose guild policy off for a DM-only setup.",
            ),
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
      if (defaultGuildId && !/^\d{10,}$/.test(defaultGuildId)) {
        issues.push(
          malformedFieldIssue("defaultGuildId", "Default server (guild) ID should look like a Discord numeric ID."),
        );
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

function hasConfiguredGuildRules(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}
