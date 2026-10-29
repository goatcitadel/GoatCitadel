import {
  resolveChannelOwnerActorIds,
  type ChannelSetupDefinition,
  type ChannelSetupIssue,
} from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  COMMON_FAILURES,
  PASTED_SECRET_EXPLANATION,
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

const DISCORD_QUICK_START_URL = "https://docs.discord.com/developers/quick-start/getting-started";

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
        "A test channel you can safely post in.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
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
          createOnly: true,
          title: "Before you start",
          body: [
            paragraph(
              "A test channel you can safely post in is needed if the bot will answer in a server channel, or if you use a webhook. Direct messages only needs no channel.",
            ),
          ],
          // Only the boxes every path needs: a box blocks Continue, so a path that skips a step can't be asked to tick it.
          checklist: [
            check("discord-account", "Discord account signed in"),
            check("server-access", "Access to the target server"),
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
          createOnly: true,
          title: "Create the Discord application and bot",
          body: [
            paragraph(
              "This step and the next are for a bot token. A webhook-only setup (send-only, advanced) has no bot, so skip both.",
            ),
            paragraph("Open the Discord Developer Portal and create a new application."),
            paragraph(
              "A new application already has a bot. Open Bot › Reset Token and copy the token now; Discord shows it once. On the same page, turn on Message Content Intent.",
            ),
            paragraph(
              "GoatCitadel needs Message Content Intent to read normal message text. Without it, Discord can close the bot's connection even though the token is valid.",
            ),
            linkBlock("Discord Developer Portal", "https://discord.com/developers/applications"),
            linkBlock("Discord getting-started guide", DISCORD_QUICK_START_URL),
            linkBlock("Discord Gateway intent reference", "https://docs.discord.com/developers/events/gateway"),
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
          createOnly: true,
          title: "Add the bot to your server",
          body: [
            paragraph(
              "Open Installation. Set Install Link to Discord Provided Link. Under Default Install Settings › Guild Install, add the scopes applications.commands and bot, and the permissions View Channels, Send Messages, Read Message History. Open the install link and choose Add to server.",
            ),
            paragraph("Install the bot in every server where you want it to answer."),
            paragraph(
              "To have the bot answer in a server channel, check that it can View Channel, Send Messages and Read Message History in that channel. A bot for direct messages only doesn't need that.",
            ),
            note(
              "info",
              "Add Reactions enables GoatCitadel's best-effort seen marker. Send Messages in Threads, Attach Files, and Embed Links are needed only when you want those corresponding capabilities.",
            ),
            linkBlock("Discord getting-started guide", DISCORD_QUICK_START_URL),
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
              key: "botToken",
              label: "Bot token",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whereToFind: [
                paragraph(
                  "In the Discord Developer Portal, open your application, then open the Bot page. Choose Reset Token and copy the token.",
                ),
              ],
              looksLike: "A long opaque token string.",
              commonMistakes: ["Pasting the application ID or public key instead of the bot token."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "botTokenEnv",
              label: "Bot token env var",
              type: "text",
              required: false,
              explanation: "Name of the environment variable that holds your Discord bot token.",
              whereToFind: [paragraph("Set a variable such as DISCORD_BOT_TOKEN to the real token.")],
              looksLike: "DISCORD_BOT_TOKEN",
              commonMistakes: [
                "Pasting the token value here instead of the variable name.",
                "Using a variable that is not available to the process GoatCitadel runs in.",
              ],
              canChangeLater: true,
              placeholder: "DISCORD_BOT_TOKEN",
            },
            {
              key: "webhookUrl",
              label: "Webhook URL (send-only, advanced)",
              type: "url",
              required: false,
              advanced: true,
              explanation:
                "Send-only: posts to one channel and cannot receive messages or show the bot online. You still need a Default channel ID.",
              whyNeeded: "Use it only if you want a send-only connection with no bot.",
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
              key: "guildPolicy",
              label: "Where should the bot listen?",
              type: "select",
              required: false,
              defaultValue: "allowlist",
              explanation:
                "Choose one server channel, where the bot answers when someone mentions it, or direct messages only.",
              options: [
                { value: "allowlist", label: "In one server channel, when mentioned", hint: "Recommended" },
                { value: "off", label: "Direct messages only" },
              ],
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
              key: "defaultChannelId",
              label: "Default channel ID",
              type: "id",
              required: true,
              explanation:
                "The test channel GoatCitadel should probe and use when no explicit target is provided. For server inbound, it must belong to the default server below.",
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
              required: true,
              // Only a bot listens in a server. A webhook-only setup never uses the id, so it isn't asked for it.
              requiredWhenAnyFieldSet: ["botToken", "botTokenEnv"],
              explanation:
                "Required for the recommended server allowlist path. It may be omitted only when Gateway guild traffic is off, such as a DM-only setup, or when an existing advanced connection already has explicit guild rules. A webhook-only setup doesn't use it.",
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
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate and test the connection",
          body: [
            paragraph(
              "For a bot token, Test checks the token and the channel, confirms the channel is in the server you chose, posts one visible test message, then deletes it. A new connection can't start its bot session until you finish, so that one check waits until then. When you retest a saved connection, it checks the bot session too.",
            ),
            note(
              "warning",
              "The webhook-only path sends one visible test post. A webhook can't delete it, so it stays in the channel.",
            ),
          ],
          troubleshooting: [
            ...definitionFailures("token"),
            troubleshoot(
              "token-not-found",
              "Bot token not found",
              "If you used an environment variable, check that its name starts with DISCORD_ and restart GoatCitadel after you set it. Or paste the bot token instead.",
            ),
            troubleshoot(
              "message-content-intent-disabled",
              "The token is valid but the bot never comes online",
              "Open the application's Bot page and turn on Message Content Intent. Discord can close the bot's connection without it, even when the token and channel checks pass.",
            ),
          ],
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
              "Then mention the bot in the test channel and confirm it replies. If DM policy is pairing, the first DM creates a pending code that must be approved before that sender's next message is accepted.",
            ),
            paragraph(
              "Approve DM pairing requests in Settings › Channels › this connection › Connection operations. No public web address is needed.",
            ),
          ],
          successCriteria: [
            "Token auth succeeds or the advanced webhook-only bridge path is intentionally configured.",
            "The default channel is reachable and belongs to the configured default server when a server id is set.",
            "New gateway setups defer runtime readiness until the durable connection is created; existing gateway connections must pass their current runtime check.",
            "A manual @mention in the allowlisted test channel reaches GoatCitadel; paired DMs are approved before use.",
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
      const ownerActorIds = resolveChannelOwnerActorIds(config);
      const applicationId = readString(config, "applicationId");
      return {
        draft: {
          runtimeMode: hydratedRuntimeMode,
          botTokenEnv: readString(config, "botTokenEnv"),
          defaultChannelId: readString(config, "defaultChannelId"),
          defaultGuildId: readString(config, "defaultGuildId"),
          inboundDmPolicy: readString(config, "inboundDmPolicy") ?? "pairing",
          guildPolicy: readString(config, "guildPolicy") ?? "allowlist",
          // Left out when the connection has none, as normalize leaves them out of the saved config.
          ...(ownerActorIds.length > 0 ? { ownerActorIds } : {}),
          ...(applicationId ? { applicationId } : {}),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            runtimeMode: "configured",
            botTokenEnv: readString(config, "botTokenEnv") ? "configured" : "unknown",
            botToken: readString(config, "botToken") || readString(config, "botTokenEnv") ? "configured" : "missing",
            webhookUrl: readString(config, "webhookUrl") ? "configured" : "unknown",
            defaultChannelId: readString(config, "defaultChannelId") ? "configured" : "missing",
            // A saved connection with its own server rules already has its route, so the wizard need not ask for the id again.
            defaultGuildId:
              readString(config, "defaultGuildId") || hasConfiguredGuildRules(config.guilds) ? "configured" : "unknown",
            inboundDmPolicy: "configured",
            guildPolicy: "configured",
            ownerActorIds: ownerActorIds.length > 0 ? "configured" : "unknown",
            applicationId: applicationId ? "configured" : "unknown",
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
      const ownerActorIds = resolveChannelOwnerActorIds(draft.draft);
      // ownerActorIds and applicationId are left out when the draft has none, so finalize keeps the saved
      // connection's own values instead of overwriting them with nothing.
      return compactRecord({
        runtimeMode,
        botTokenEnv: readString(draft.draft, "botTokenEnv") ?? readLegacyString(draft, "botTokenEnv", "tokenEnv"),
        defaultChannelId: readString(draft.draft, "defaultChannelId"),
        defaultGuildId: readString(draft.draft, "defaultGuildId"),
        inboundDmPolicy:
          runtimeMode === "gateway" ? (readString(draft.draft, "inboundDmPolicy") ?? "pairing") : undefined,
        guildPolicy: runtimeMode === "gateway" ? (readString(draft.draft, "guildPolicy") ?? "allowlist") : undefined,
        ownerActorIds: ownerActorIds.length > 0 ? ownerActorIds : undefined,
        applicationId: readString(draft.draft, "applicationId"),
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
      if (!defaultChannelId && !(runtimeMode === "gateway" && guildPolicy === "off")) {
        issues.push(requiredFieldIssue("defaultChannelId", "Default channel ID is required."));
      } else if (defaultChannelId && !/^\d{10,}$/.test(defaultChannelId)) {
        issues.push(
          malformedFieldIssue("defaultChannelId", "Default channel ID should look like a Discord numeric ID."),
        );
      }
      if (runtimeMode === "gateway") {
        if (!hasConfiguredBotToken) {
          // The issue keeps its key; the pasted token field is where a person goes to fix it, not the expert variable name.
          issues.push({
            ...requiredFieldIssue("botTokenEnv", "Paste the bot token."),
            fieldKey: "botToken",
          });
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
          fieldKey: "botToken",
          message: "Paste the bot token, or a webhook URL for send-only.",
          failureCategory: "missing_input",
          nextSteps: [
            "Paste the bot token from your application's Bot page, or add a webhook URL under the advanced options.",
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
