import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import { isExplicitTrue as isTruthyFlag } from "@goatcitadel/gateway-core";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  COMMON_FAILURES,
  PASTED_SECRET_EXPLANATION,
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  linkBlock,
  check,
  troubleshoot,
  readString,
  looksLikeHttpUrl,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
  requireSecureUrl,
} from "./common.js";

export function createMattermostDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.mattermost");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "2026.10.mattermost.stream.v3",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Send and receive Mattermost posts through a bot account. No public web address is needed: GoatCitadel connects out, and only hears posts while it's running.",
      prerequisites: [
        "A bot account and its token. Only a Mattermost system admin can create bots.",
        "The bot added to the team and to each channel it should use.",
        "Your Mattermost server in the hosts GoatCitadel may reach.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel signs in to your Mattermost server with a bot token. It can post, reply, react, send files, show typing and delete its own posts.",
            ),
            paragraph(
              "Receiving is optional and off by default. When it is on, GoatCitadel connects out to your server and listens for posts in channels the bot belongs to, so no public web address is needed. It only hears posts while it's running, and posts sent while it isn't are not recovered. Only user IDs you allow can start conversations.",
            ),
            note(
              "warning",
              "Mattermost is a guided beta lane. The setup test checks the bot token, finds your channel and posts a test post, which it deletes again when the bot may. GoatCitadel can reach your server only once the server is in the hosts GoatCitadel may reach: the setup test has an Allow these hosts button for that. If it isn't, receiving stops until you allow it and restart GoatCitadel.",
            ),
          ],
        },
        {
          id: "create-bot",
          kind: "instruction",
          createOnly: true,
          title: "Create the bot account",
          body: [
            paragraph("Only a Mattermost system admin can create a bot. Ask one if you aren't."),
            {
              kind: "list",
              ordered: true,
              items: [
                "In System Console › Integrations › Bot Accounts, turn on Enable Bot Account Creation.",
                "In the Product menu, open Integrations › Bot Accounts and choose Add Bot Account.",
                "Copy the token. It is shown once.",
                "Add the bot to the team and to each channel it should use. It doesn't join on its own.",
              ],
            },
            linkBlock(
              "Mattermost: Bot accounts",
              "https://docs.mattermost.com/developers/integrate/reference/bot-accounts",
            ),
          ],
          checklist: [
            check("enable", "Turn on bot account creation"),
            check("add-bot", "Add the bot account and copy its token"),
            check(
              "membership",
              "Add the bot to its team and to each channel it should use (not needed for a direct message)",
            ),
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
              explanation:
                "The address of your Mattermost server, without a team or channel. Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
              looksLike: "https://chat.example.com",
              canChangeLater: true,
            },
            {
              key: "botToken",
              label: "Bot token",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded: "Lets GoatCitadel post as the bot.",
              whereToFind: [
                paragraph(
                  "Mattermost shows it once, when you add the bot account (Product menu › Integrations › Bot Accounts › Add Bot Account). Copy it before you close that screen.",
                ),
                linkBlock(
                  "Mattermost: Bot accounts",
                  "https://docs.mattermost.com/developers/integrate/reference/bot-accounts",
                ),
              ],
              commonMistakes: ["Closing the screen before copying the token. Mattermost doesn't show it again."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "botTokenEnv",
              label: "Bot token env var",
              type: "text",
              required: false,
              advanced: true,
              explanation: "Name of the env var that stores the Mattermost bot token.",
              looksLike: "MATTERMOST_BOT_TOKEN",
              canChangeLater: true,
              placeholder: "MATTERMOST_BOT_TOKEN",
            },
            {
              key: "defaultChannel",
              label: "Where should the test post go?",
              type: "text",
              required: true,
              explanation:
                "The channel name from its web address (for example town-square), or @your-username to have the bot message you. The bot must already be a member.",
              whyNeeded:
                "GoatCitadel posts one test post here and deletes it again right away when the bot may, so you may not see it, even in a direct message. A send that names no channel goes here too.",
              looksLike: "town-square",
              commonMistakes: [
                "Using the channel's display name (for example Town Square) instead of the name in its web address.",
              ],
              canChangeLater: true,
            },
            {
              key: "inboundStreamEnabled",
              label: "Receive posts",
              type: "boolean",
              required: false,
              defaultValue: false,
              explanation:
                "Listen for posts in channels the bot belongs to, so people can start conversations with it.",
              whyNeeded:
                "GoatCitadel connects out to your server to hear new posts, so no public web address is needed. Receiving stays off unless you turn it on, and only allowed user IDs can start conversations. Posts sent while GoatCitadel isn't running are not recovered.",
              canChangeLater: true,
            },
            {
              key: "defaultTeam",
              label: "Default team",
              type: "text",
              required: false,
              advanced: true,
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
            paragraph(
              "The test checks the bot token with your server, finds the channel you chose and posts one test post there. When the bot may, it deletes that post again right away, so read the result on this step: the post may be gone before you look.",
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "token-rejected",
              "Mattermost rejected the bot token",
              "Paste the bot's token. Mattermost shows it only once, when you add the bot account. If you didn't keep it, ask a system admin to create a new token for the bot.",
            ),
            troubleshoot(
              "channel-not-found",
              "It can't find the channel for the test post",
              "Use the channel name from its web address (for example town-square), not its display name, or @your-username to send the test post to you in a direct message. For a channel, the bot must already be a member of the team and the channel, so add it to the team and the channel first.",
            ),
            troubleshoot(
              "post-refused",
              "Mattermost refused the test post",
              "The bot must be a member of the channel and allowed to post in it. Add it to the channel from your own account, then run the test again.",
            ),
            troubleshoot(
              "cleanup-failed",
              "It says the test post was sent but couldn't be deleted",
              "The bot isn't allowed to delete its own post. Delete the test post yourself in Mattermost, then acknowledge it when the guide asks.",
            ),
            troubleshoot(
              "host-not-allowed",
              "It says GoatCitadel can't reach your Mattermost server yet",
              "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add your server, then run the test again.",
            ),
            troubleshoot(
              "variable-not-found",
              "It says the bot token is missing, and you used an environment variable",
              "A variable's name must start with MATTERMOST_ (for example MATTERMOST_BOT_TOKEN), and you must restart GoatCitadel after you set it. Or paste the token instead.",
            ),
            troubleshoot(
              "no-reply",
              "You post in a channel and nothing comes back",
              "Check these in order. Receive posts must be on. Your Mattermost user ID (not your username) must be listed under Who may message this bot. The bot must be a member of the channel. GoatCitadel must be running: it only hears posts while it's running. And your server must be in the hosts GoatCitadel may reach: if it isn't, receiving stops until you allow it and restart GoatCitadel.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection so GoatCitadel can post from it. To receive posts, turn on Receive posts and allow your user ID (the last step shows how).",
            ),
          ],
          successCriteria: [
            "Your Mattermost server accepted the bot token.",
            "The channel you chose was found and accepted the test post.",
            "The test post was deleted, or you deleted it yourself where the bot couldn't.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.10.mattermost.stream.v2",
      secretFieldKeys: ["botToken"],
    },
    validation: {
      validationVersion: "2026.10.mattermost.stream.v2",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.10.mattermost.stream.v2",
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
      officialDocsUrl: "https://docs.mattermost.com/developers/integrate/reference/bot-accounts",
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
          inboundStreamEnabled: isTruthyFlag(config.inboundStreamEnabled),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            serverUrl: readString(config, "serverUrl") ? "configured" : "missing",
            botToken:
              readString(config, "botToken") ||
              readString(config, "botTokenEnv") ||
              readString(config, "token") ||
              readString(config, "tokenEnv")
                ? "configured"
                : "missing",
            botTokenEnv: readString(config, "botTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            defaultChannel: readString(config, "defaultChannel") ? "configured" : "missing",
            defaultTeam: readString(config, "defaultTeam") ? "configured" : "unknown",
            inboundStreamEnabled: config.inboundStreamEnabled === undefined ? "unknown" : "configured",
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
      return compactRecord({
        serverUrl: readString(draft.draft, "serverUrl"),
        botTokenEnv: readString(draft.draft, "botTokenEnv") ?? preservedBotTokenEnv,
        botToken: readString(draft.draft, "botToken") ?? preservedBotToken,
        defaultChannel: readString(draft.draft, "defaultChannel"),
        defaultTeam: readString(draft.draft, "defaultTeam"),
        inboundStreamEnabled: isTruthyFlag(draft.draft.inboundStreamEnabled) ? true : undefined,
        // Inbound is default-deny: never inherit a legacy-open posture.
        ...(isTruthyFlag(draft.draft.inboundStreamEnabled) ? { inboundAccessMode: "allowlist" } : {}),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const serverUrl = readString(draft.draft, "serverUrl");
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "botToken") ||
        readString(draft.draft, "botTokenEnv") ||
        draft.hydration?.fieldState.botToken === "configured" ||
        draft.hydration?.fieldState.botTokenEnv === "configured",
      );
      if (!serverUrl) {
        issues.push(requiredFieldIssue("serverUrl", "Server URL is required."));
      } else {
        // Plain http is refused the same way the live test refuses it. That rule lets "ftp://localhost" through, so the
        // scheme is checked here too.
        const insecure = requireSecureUrl(serverUrl, "serverUrl", "Server URL");
        if (insecure) {
          issues.push(insecure);
        } else if (!looksLikeHttpUrl(serverUrl)) {
          issues.push(malformedFieldIssue("serverUrl", "Server URL should start with https://."));
        }
      }
      if (!hasConfiguredToken) {
        issues.push({
          key: "mattermost_auth_missing",
          // The pasted field is where a person goes to fix this, not the expert variable name.
          fieldKey: "botToken",
          level: "error",
          message: "Paste the Mattermost bot token.",
          failureCategory: "missing_input",
          nextSteps: ["Paste the bot's token. Mattermost shows it only once, when you add the bot account."],
        });
      }
      if (!readString(draft.draft, "defaultChannel")) {
        issues.push(requiredFieldIssue("defaultChannel", "Default channel is required."));
      }
      return issues;
    },
  };
}
