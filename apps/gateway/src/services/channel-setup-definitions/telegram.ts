import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  COMMON_FAILURES,
  requireCatalog,
  baseCatalogMeta,
  definitionFailures,
  paragraph,
  linkBlock,
  check,
  readString,
  normalizeTelegramTargets,
  normalizeTelegramUsername,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

/** B2b voice replies: accepted per-connection modes; anything else normalizes to "off". */
const VOICE_REPLY_MODES: ReadonlySet<string> = new Set(["off", "voice_on_voice", "always"]);

function normalizeVoiceReplyMode(value: string | undefined): "off" | "voice_on_voice" | "always" {
  if (value === "voice_on_voice" || value === "always") {
    return value;
  }
  return "off";
}

export function createTelegramDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.telegram");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bot_token_target",
      contentVersion: "2026.07.telegram.channel-ux.v2",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect Telegram with a bot-native flow: create a BotFather bot, send a setup message, choose detected chats, then set a home channel for background delivery.",
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
            paragraph(
              "Telegram v1 also supports channel-native commands such as /status, /sethome, /personality, /skills, and /tools. Terminal-capable work can be requested remotely, but it still runs through GoatCitadel approvals and policy.",
            ),
            paragraph(
              "Rich sends are preflighted before delivery: photo/document attachment posture, caption fallback, provider evidence, and attachment-count limits are recorded before the Bot API send.",
            ),
          ],
        },
        {
          id: "create-bot",
          kind: "instruction",
          title: "Create the Telegram bot in BotFather",
          body: [
            paragraph("Open @BotFather in Telegram, run /newbot, then follow the prompts to create your bot."),
            paragraph(
              "After creation, open the bot and send /start. For groups, add the bot to the group and send a setup message there.",
            ),
            linkBlock("Telegram bot tutorial", "https://core.telegram.org/bots/tutorial"),
            linkBlock("Open BotFather", "https://t.me/BotFather"),
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
          title: "Prepare destination chats",
          body: [
            paragraph(
              "Add the bot to each chat, group, supergroup, or channel you want GoatCitadel to use. If group privacy blocks regular messages, send a command or make the bot an admin.",
            ),
            paragraph(
              "After setup, use /sethome in the chat where background results, scheduled work, and cross-platform delivery should land by default.",
            ),
          ],
          checklist: [
            check("bot-added", "Add the bot to every target chat or channel"),
            check("setup-message", "Send /start or a setup code in each target"),
            check("permissions", "Confirm the bot can post in each target"),
            check("home-channel", "Plan which chat should become the home channel"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Choose Telegram targets",
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
              key: "botUsername",
              label: "Bot username",
              type: "text",
              required: false,
              explanation: "The @username BotFather assigned to your bot.",
              whyNeeded: "Used for open/add helper links and operator-visible setup clarity.",
              whereToFind: [paragraph("BotFather shows the bot username after /newbot completes.")],
              looksLike: "@goatcitadel_bot",
              canChangeLater: true,
            },
            {
              key: "setupCode",
              label: "Setup code",
              type: "text",
              required: false,
              explanation: "Optional code to send in Telegram so GoatCitadel can identify setup messages.",
              whyNeeded: "Helps auto-detected chats become obvious during setup.",
              whereToFind: [paragraph("Use any short memorable code, such as goat-setup-home or goat-setup-ops.")],
              looksLike: "goat-setup-ops",
              canChangeLater: true,
            },
            {
              key: "targets",
              label: "Telegram chat targets",
              type: "textarea",
              required: true,
              explanation: "Named Telegram chats, groups, or channels this bot can use.",
              whyNeeded: "Lets one Telegram bot serve multiple chats without repeating setup.",
              whereToFind: [
                paragraph(
                  "Use auto-detected chats from recent bot updates, or add chat ids / @channel handles manually.",
                ),
              ],
              looksLike: "Default: -1001234567890 or @ops_channel",
              commonMistakes: [
                "Copying a message id instead of the chat id.",
                "Adding a group before the bot has been added to that group.",
                "Forgetting to send /start or the setup code before using target discovery.",
              ],
              canChangeLater: true,
            },
            {
              key: "defaultChatId",
              label: "Legacy default chat ID or @channel handle",
              type: "id",
              required: false,
              explanation: "Compatibility fallback for older single-chat Telegram connections.",
              whyNeeded: "Used only when no target rows are configured.",
              whereToFind: [paragraph("Use a chat id lookup workflow or the @channel_name for public channels.")],
              looksLike: "123456789 or @channel_name",
              commonMistakes: [
                "Copying a message id instead of the chat id.",
                "Using a display name instead of the @handle.",
              ],
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
              key: "voiceReplyMode",
              label: "Voice replies",
              type: "select",
              required: false,
              defaultValue: "off",
              explanation:
                "Optionally attach a synthesized voice note to assistant replies in this chat. The text reply is always sent; audio is additive.",
              whyNeeded:
                "Lets audio-first chats hear replies as Telegram voice notes without changing text delivery. Requires the gateway voice-reply feature flag and the managed Piper TTS runtime.",
              options: [
                { value: "off", label: "Off (text only)" },
                { value: "voice_on_voice", label: "Voice note when the inbound message was a voice message" },
                { value: "always", label: "Voice note on every reply" },
              ],
              canChangeLater: true,
            },
            {
              key: "webhookSecretEnv",
              label: "Webhook secret ENV var",
              type: "text",
              required: false,
              explanation:
                "Optional. Env var name for the Telegram webhook secret token used to verify inbound Bot API webhooks.",
              whyNeeded:
                "Enables inbound Telegram message routing without storing the secret directly in the connection config.",
              whereToFind: [
                paragraph(
                  "Create a random secret token, store it in an env var such as TELEGRAM_WEBHOOK_SECRET, and configure the same token in Telegram's setWebhook call.",
                ),
              ],
              looksLike: "TELEGRAM_WEBHOOK_SECRET",
              commonMistakes: [
                "Pasting the actual secret here instead of the env var name.",
                "Forgetting to use the same secret token when configuring the Telegram webhook.",
              ],
              canChangeLater: true,
              placeholder: "TELEGRAM_WEBHOOK_SECRET",
            },
            {
              key: "webhookSecret",
              label: "Webhook secret (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct secret-token entry for Telegram inbound webhook verification.",
              whyNeeded:
                "Lets GoatCitadel verify Telegram webhook deliveries when env-backed secret storage is not available yet.",
              looksLike: "A long random secret token.",
              commonMistakes: [
                "Reusing the bot token instead of a separate webhook secret.",
                "Configuring a secret here but a different secret in Telegram.",
              ],
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
            paragraph(
              "GoatCitadel verifies the token with Telegram and sends a sandbox message plus cleanup probe before you finalize.",
            ),
            paragraph(
              "Runtime rich-message evidence records whether media is native, document fallback, pending hydration, or blocked before provider delivery.",
            ),
            paragraph(
              "The strongest setup proof is: token validates, the intended chat appears in target discovery, a sandbox message can be sent, and /sethome confirms the delivery target.",
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
              "After finalizing, send /status in Telegram, then /sethome in the chat that should receive background results.",
            ),
          ],
          successCriteria: [
            "The token validates successfully.",
            "A default chat target is configured.",
            "The intended Telegram chat is detected or manually configured.",
            "The operator has chosen or intentionally skipped the home channel.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.07.telegram.channel-ux.v2",
      secretFieldKeys: ["botToken", "webhookSecret"],
    },
    validation: {
      validationVersion: "2026.07.telegram.channel-ux.v2",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.05.telegram.targets.v1",
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
      lastReviewedAt: "2026-05-02",
      volatility: "low",
      deprecationRisk: "low",
      preferredPathLabel: "BotFather token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["botToken", "botTokenEnv", "token", "tokenEnv"]]);
      return {
        draft: {
          botTokenEnv: readString(config, "botTokenEnv") ?? readString(config, "tokenEnv"),
          botUsername: readString(config, "botUsername"),
          setupCode: readString(config, "setupCode"),
          targets: normalizeTelegramTargets(config),
          defaultChatId: readString(config, "defaultChatId") ?? readString(config, "defaultChannelId"),
          parseMode: readString(config, "parseMode") ?? "Markdown",
          voiceReplyMode: normalizeVoiceReplyMode(readString(config, "voiceReplyMode")),
          webhookSecretEnv: readString(config, "webhookSecretEnv") ?? readString(config, "secretTokenEnv"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            botToken:
              readString(config, "botToken") ||
              readString(config, "botTokenEnv") ||
              readString(config, "token") ||
              readString(config, "tokenEnv")
                ? "configured"
                : "missing",
            botTokenEnv: readString(config, "botTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            botUsername: readString(config, "botUsername") ? "configured" : "unknown",
            setupCode: readString(config, "setupCode") ? "configured" : "unknown",
            targets: normalizeTelegramTargets(config).length > 0 ? "configured" : "missing",
            defaultChatId:
              readString(config, "defaultChatId") || readString(config, "defaultChannelId") ? "configured" : "unknown",
            parseMode: "configured",
            voiceReplyMode: "configured",
            webhookSecret:
              readString(config, "webhookSecret") || readString(config, "secretToken") ? "configured" : "unknown",
            webhookSecretEnv:
              readString(config, "webhookSecretEnv") || readString(config, "secretTokenEnv") ? "configured" : "unknown",
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
      const preservedBotToken = readLegacyString(draft, "botToken", "token");
      const preservedBotTokenEnv = readLegacyString(draft, "botTokenEnv", "tokenEnv");
      const preservedWebhookSecret = readLegacyString(draft, "webhookSecret", "secretToken");
      const preservedWebhookSecretEnv = readLegacyString(draft, "webhookSecretEnv", "secretTokenEnv");
      const targets = normalizeTelegramTargets(draft.draft);
      const defaultTarget = targets.find((target) => target.default) ?? targets[0];
      return compactRecord({
        botTokenEnv: readString(draft.draft, "botTokenEnv") ?? preservedBotTokenEnv,
        botToken: readString(draft.draft, "botToken") ?? preservedBotToken,
        botUsername: normalizeTelegramUsername(readString(draft.draft, "botUsername")),
        setupCode: readString(draft.draft, "setupCode"),
        targets,
        defaultChannelId: defaultTarget?.chatId ?? readString(draft.draft, "defaultChatId"),
        defaultChatId: defaultTarget?.chatId ?? readString(draft.draft, "defaultChatId"),
        parseMode: readString(draft.draft, "parseMode") ?? "Markdown",
        voiceReplyMode: normalizeVoiceReplyMode(readString(draft.draft, "voiceReplyMode")),
        webhookSecretEnv: readString(draft.draft, "webhookSecretEnv") ?? preservedWebhookSecretEnv,
        webhookSecret: readString(draft.draft, "webhookSecret") ?? preservedWebhookSecret,
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const token = readString(draft.draft, "botToken");
      const targets = normalizeTelegramTargets(draft.draft);
      const chatId = targets[0]?.chatId ?? readString(draft.draft, "defaultChatId");
      const hasConfiguredToken = Boolean(
        token ||
        readString(draft.draft, "botTokenEnv") ||
        draft.hydration?.fieldState.botToken === "configured" ||
        draft.hydration?.fieldState.botTokenEnv === "configured",
      );
      if (!hasConfiguredToken) {
        issues.push(requiredFieldIssue("botToken", "Bot token is required."));
      } else if (token && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
        issues.push(malformedFieldIssue("botToken", "Bot token should look like a Telegram bot token."));
      }
      if (!chatId) {
        issues.push(requiredFieldIssue("targets", "Add at least one Telegram chat target."));
      }
      for (const target of targets) {
        if (!target.chatId) {
          issues.push(malformedFieldIssue("targets", "Every Telegram target needs a chat id or @channel handle."));
        }
      }
      const voiceReplyMode = readString(draft.draft, "voiceReplyMode");
      if (voiceReplyMode && !VOICE_REPLY_MODES.has(voiceReplyMode)) {
        issues.push(
          malformedFieldIssue("voiceReplyMode", "Voice replies must be one of off, voice_on_voice, or always."),
        );
      }
      return issues;
    },
  };
}
