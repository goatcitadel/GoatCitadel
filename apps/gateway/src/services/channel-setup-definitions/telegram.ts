import {
  resolveChannelOwnerActorIds,
  type ChannelSetupDefinition,
  type ChannelSetupIssue,
} from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  COMMON_FAILURES,
  requireCatalog,
  baseCatalogMeta,
  definitionFailures,
  paragraph,
  linkBlock,
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

/** How GoatCitadel hears new Telegram messages. */
type TelegramReceiveMode = "poll" | "webhook" | "off";

function isTelegramReceiveMode(value: string | undefined): value is TelegramReceiveMode {
  return value === "poll" || value === "webhook" || value === "off";
}

/**
 * The receive mode an existing connection already behaves with. A stored mode wins; older connections
 * never had one and receive only when a webhook secret is set, so they hydrate as "webhook" or "off".
 * The "poll" default for new drafts never reaches this path.
 */
function hydrateTelegramReceiveMode(config: Record<string, unknown>): TelegramReceiveMode {
  const stored = readString(config, "receiveMode");
  if (isTelegramReceiveMode(stored)) {
    return stored;
  }
  return hasAnyConfiguredSecret(config, [["webhookSecret", "webhookSecretEnv", "secretToken", "secretTokenEnv"]])
    ? "webhook"
    : "off";
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
        "Change a Telegram channel that's already on: use its bot in groups or channels, choose where it posts by default, and set formatting, voice replies and how messages arrive. A new bot is set up in Chat › Messaging.",
      prerequisites: [
        "A Telegram channel that's already on. To add a new bot, go to Chat › Messaging and choose Add.",
        "For a group or channel: permission to add the bot there.",
        "A public HTTPS address only if you choose web-address delivery.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What you can change here",
          body: [
            paragraph(
              "This changes a Telegram channel that's already on. To add a new bot, go to Chat › Messaging and choose Add: that page makes the bot, checks its key and turns it on.",
            ),
            paragraph(
              "Here you can use the bot in groups or channels, choose where it posts by default, and change its formatting, voice replies, and how GoatCitadel receives its messages.",
            ),
            paragraph(
              "In Telegram the bot also answers commands such as /status, /sethome, /personality, /skills and /tools. Work started from Telegram still goes through GoatCitadel's approvals and policy.",
            ),
          ],
        },
        {
          id: "destination",
          kind: "instruction",
          title: "Add your bot to a group or channel (optional)",
          body: [
            paragraph("Skip this step if you only chat with your bot one to one."),
            paragraph(
              "In Telegram, add the bot to the group or channel, then send a message there. GoatCitadel can find a chat only after the bot has seen a message in it; the next step lists the chats it has seen.",
            ),
            paragraph(
              "In a group, Telegram passes the bot only commands (messages starting with /) and replies to it. To let it read everything, make it an admin of the group, or send /setprivacy to BotFather, turn privacy off, and then add the bot to the group again.",
            ),
            paragraph(
              "To make a chat the place where background results land, send /sethome there after you save these changes.",
            ),
            linkBlock("Telegram: what bots see in groups", "https://core.telegram.org/bots/features#privacy-mode"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Choose chats and options",
          fields: [
            {
              key: "botToken",
              label: "Bot key",
              type: "secret",
              required: true,
              explanation:
                "The key BotFather gave your bot. Leave this empty to keep the key that's saved. To change it, use Change key on the channel's page in Chat.",
              whyNeeded: "GoatCitadel uses it to sign in to Telegram as your bot.",
              whereToFind: [paragraph("In your chat with BotFather, in its reply when the bot was made.")],
              looksLike: "123456789:AA...",
              commonMistakes: ["Pasting the bot's name or username instead of its key.", "Leaving out the colon."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "botUsername",
              label: "Bot username",
              type: "text",
              required: false,
              advanced: true,
              explanation:
                "Filled in from Telegram when GoatCitadel checks the key. Change it only if you renamed the bot in BotFather.",
              whyNeeded: "Used for links that open the bot.",
              whereToFind: [paragraph("Your bot's @username, which ends in bot. It is not the bot's display name.")],
              looksLike: "@goatcitadel_bot",
              canChangeLater: true,
            },
            {
              key: "setupCode",
              label: "Setup code",
              type: "text",
              required: false,
              advanced: true,
              explanation:
                "Optional. A word to send in a group so the chat stands out when GoatCitadel looks for chats.",
              whyNeeded: "Helps tell similar group chats apart.",
              whereToFind: [paragraph("Any short word, such as goat-setup-ops.")],
              looksLike: "goat-setup-ops",
              canChangeLater: true,
            },
            {
              key: "targets",
              label: "Chats this bot can use",
              type: "textarea",
              required: true,
              explanation:
                "The chats, groups and channels this bot posts in. Your own chat with the bot is already here if you set it up in Chat.",
              whyNeeded: "One bot can serve several chats without setting it up again.",
              whereToFind: [
                paragraph(
                  "Detect Telegram chats lists the chats the bot has seen a message in. A public channel can also be added by its @name.",
                ),
              ],
              looksLike: "Default: -1001234567890 or @ops_channel",
              commonMistakes: [
                "Copying a message id instead of the chat id.",
                "Looking for a group before the bot has been added to it.",
                "Looking for a chat before anyone has sent a message there.",
              ],
              canChangeLater: true,
            },
            {
              key: "defaultChatId",
              label: "Legacy default chat ID or @channel handle",
              type: "id",
              required: false,
              advanced: true,
              explanation: "Only for older single-chat Telegram channels.",
              whyNeeded: "Used only when no chats are listed above.",
              whereToFind: [paragraph("Leave it empty and use the chats above instead.")],
              looksLike: "123456789 or @channel_name",
              commonMistakes: [
                "Copying a message id instead of the chat id.",
                "Using a display name instead of the @handle.",
              ],
              canChangeLater: true,
            },
            {
              key: "parseMode",
              label: "Formatting",
              type: "select",
              required: false,
              defaultValue: "Markdown",
              explanation: "How Telegram formats the bot's replies.",
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
              key: "receiveMode",
              label: "How GoatCitadel receives Telegram messages",
              type: "select",
              required: false,
              defaultValue: "poll",
              explanation:
                "Choose how new Telegram messages reach GoatCitadel. Asking Telegram for new messages works on any network and needs no public web address.",
              whyNeeded:
                "Receiving messages lets you chat with GoatCitadel from Telegram. Web-address delivery needs a public HTTPS address and a webhook secret.",
              options: [
                { value: "poll", label: "Ask Telegram for new messages (no public web address needed)" },
                { value: "webhook", label: "Telegram sends messages to a public web address" },
                { value: "off", label: "Don't receive messages" },
              ],
              canChangeLater: true,
            },
            {
              key: "webhookSecretEnv",
              label: "Webhook secret ENV var",
              type: "text",
              required: false,
              visibleWhenFieldEquals: { fieldKey: "receiveMode", value: "webhook" },
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
              visibleWhenFieldEquals: { fieldKey: "receiveMode", value: "webhook" },
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
          title: "Check and test",
          body: [
            paragraph(
              "GoatCitadel checks the bot key with Telegram, sends a test message to the default chat, and then removes it.",
            ),
            paragraph("If the test fails, the reason shows here. Nothing changes until you save."),
          ],
          troubleshooting: definitionFailures("token"),
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Save the changes",
          body: [
            paragraph(
              "After saving, send your bot a message to check it still answers. In a group, send /sethome where background results should land.",
            ),
          ],
          successCriteria: [
            "The bot key checks out with Telegram.",
            "At least one chat is listed, and one is the default.",
            "The test message reached the default chat.",
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
      const ownerActorIds = resolveChannelOwnerActorIds(config);
      return {
        draft: {
          botTokenEnv: readString(config, "botTokenEnv") ?? readString(config, "tokenEnv"),
          botUsername: readString(config, "botUsername"),
          setupCode: readString(config, "setupCode"),
          targets: normalizeTelegramTargets(config),
          defaultChatId: readString(config, "defaultChatId") ?? readString(config, "defaultChannelId"),
          parseMode: readString(config, "parseMode") ?? "Markdown",
          voiceReplyMode: normalizeVoiceReplyMode(readString(config, "voiceReplyMode")),
          receiveMode: hydrateTelegramReceiveMode(config),
          ownerActorIds,
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
            receiveMode: "configured",
            ownerActorIds: ownerActorIds.length > 0 ? "configured" : "unknown",
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
      const receiveMode = readString(draft.draft, "receiveMode");
      const ownerActorIds = resolveChannelOwnerActorIds(draft.draft);
      // receiveMode and ownerActorIds are left out when the draft has none, so finalize keeps the saved
      // connection's own values instead of overwriting them with a default.
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
        receiveMode: isTelegramReceiveMode(receiveMode) ? receiveMode : undefined,
        ownerActorIds: ownerActorIds.length > 0 ? ownerActorIds : undefined,
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
      const receiveMode = readString(draft.draft, "receiveMode");
      if (receiveMode && !isTelegramReceiveMode(receiveMode)) {
        issues.push(malformedFieldIssue("receiveMode", "Choose how Telegram messages are received."));
      }
      return issues;
    },
  };
}
