import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
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
  normalizeSlackTargets,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

export function createSlackDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.slack");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "2026.03.slack.v1",
      estimatedMinutes: 10,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect Slack with OAuth first, then choose one or more workspace channel targets for GoatCitadel to use.",
      prerequisites: [
        "A Slack workspace where you can approve your Slack app.",
        "Permission to install apps or ask an admin to approve the install.",
        "At least one test channel for the first test post.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel posts to the Slack channels you choose, as a bot from your own Slack app. One connection can serve several channels.",
            ),
            note(
              "info",
              "Paste a bot token from your own Slack app. Installing with OAuth is an advanced option: it needs your own Slack app, a public HTTPS redirect address and four settings on the Gateway.",
            ),
            note(
              "warning",
              "In this version Slack can receive messages only from an app installed with OAuth here, with message history scopes (set GOATCITADEL_SLACK_OAUTH_SCOPES) and a public HTTPS address. A pasted bot token can send but not receive.",
            ),
          ],
        },
        {
          id: "prerequisites",
          kind: "prerequisites",
          createOnly: true,
          title: "Before you start",
          body: [
            paragraph(
              "With a bot token, pick at least one test channel for the first target. An incoming webhook posts to its own channel, so a webhook-only setup needs none.",
            ),
          ],
          // Only the boxes every path needs: a box blocks Continue, so a webhook-only setup can't be asked to tick a channel.
          checklist: [
            check("workspace", "Choose the Slack workspace"),
            check("permissions", "Confirm you can approve or request your Slack app"),
          ],
        },
        {
          id: "create-app",
          kind: "instruction",
          createOnly: true,
          title: "Create your Slack app and copy its bot token",
          body: [
            {
              kind: "list",
              ordered: true,
              items: [
                "Open api.slack.com/apps › Create New App › From scratch, and pick your workspace.",
                "Open OAuth & Permissions. Under Bot Token Scopes add chat:write. Add chat:write.public if you won't invite the bot to the channel.",
                "Click Install to Workspace and allow it.",
                "Copy the Bot User OAuth Token (it starts with xoxb-).",
                "For a private channel, type /invite @your-app in that channel.",
              ],
            },
            linkBlock("Your Slack apps", "https://api.slack.com/apps"),
          ],
        },
        {
          id: "oauth-install",
          kind: "instruction",
          // Authored so an edit guide, which skips the steps above, opens on "Connect account" and shows the Connect Slack controls.
          stage: "identity",
          title: "Connect Slack with OAuth",
          body: [
            paragraph("This step is advanced and optional. Skip it if you paste a bot token on the next step."),
            paragraph(
              "Connecting with OAuth is the only way, in this version, for GoatCitadel to receive messages from Slack. It needs your own Slack app and a public HTTPS redirect address.",
            ),
            paragraph("Set these four variables where GoatCitadel starts, then restart GoatCitadel:"),
            {
              kind: "list",
              items: [
                "GOATCITADEL_SLACK_OAUTH_CLIENT_ID",
                "GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET",
                "GOATCITADEL_SLACK_OAUTH_REDIRECT_URI",
                "GOATCITADEL_SLACK_OAUTH_STATE_SECRET",
              ],
            },
            paragraph(
              "Then choose Connect Slack with OAuth below, approve your Slack app, and check the workspace it shows.",
            ),
            linkBlock("Slack OAuth v2", "https://api.slack.com/authentication/oauth-v2"),
          ],
          troubleshooting: [
            troubleshoot(
              "oauth-needs-configuration",
              "It says Slack OAuth needs configuration",
              "One of the four variables above is not set. Set it where GoatCitadel starts, then restart GoatCitadel.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Choose Slack targets",
          fields: [
            {
              key: "botToken",
              label: "Bot token",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded: "Lets GoatCitadel check your Slack app and post as the bot.",
              whereToFind: [
                paragraph("Open your Slack app, then OAuth & Permissions, then copy the Bot User OAuth Token."),
              ],
              looksLike: "xoxb-...",
              commonMistakes: [
                "Copying a user token instead of the bot token.",
                "Forgetting to reinstall the app after changing scopes.",
              ],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "slackInstallId",
              label: "Connected Slack install (OAuth only)",
              type: "text",
              required: false,
              explanation:
                "Filled in for you when you connect Slack with OAuth. Leave it empty if you paste a bot token.",
              whyNeeded: "Used to connect this setup draft to the approved workspace install.",
              whereToFind: [
                paragraph("Use the Connect Slack with OAuth button. This field is filled automatically when possible."),
              ],
              looksLike: "slack:T0123456789",
              canChangeLater: true,
            },
            {
              key: "targets",
              label: "Slack channel targets",
              type: "textarea",
              // Not required here: an incoming webhook is bound to its own channel. A bot-token setup without a channel is
              // caught by validate() (`targets_required`), which names this field so the wizard jumps back to it.
              required: false,
              explanation:
                "Named Slack channels this one workspace install can use. Needed with a bot token. Leave this empty for a webhook-only setup.",
              whyNeeded: "Lets one Slack connection serve multiple channels without repeating setup.",
              whereToFind: [
                paragraph(
                  "Add a target for each Slack channel. Use #channel-name for public channels or C/G ids for private channels.",
                ),
              ],
              looksLike: "Default: #ops-test",
              commonMistakes: [
                "Adding a private channel before inviting the app into that channel.",
                "Creating separate full connections instead of adding targets here.",
              ],
              canChangeLater: true,
            },
            {
              key: "defaultChannel",
              label: "Legacy default channel",
              type: "text",
              required: false,
              explanation: "Compatibility fallback for older single-channel Slack connections.",
              whyNeeded: "Used only when no target rows are configured.",
              whereToFind: [
                paragraph("Use the channel name like #ops-test or copy the channel id for private channels if needed."),
              ],
              looksLike: "#ops-test or C0123456789",
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
              label: "Incoming webhook URL (send-only)",
              type: "url",
              required: false,
              explanation:
                "Send-only. A webhook posts to the one Slack channel it was made for, so you don't need to add a channel target.",
              whyNeeded: "Useful for a simple send-only setup without a bot token.",
              whereToFind: [
                paragraph("Enable Incoming Webhooks in your Slack app, then copy the generated webhook URL."),
              ],
              looksLike: "https://hooks.slack.com/services/...",
              commonMistakes: ["Pasting a workspace URL instead of the incoming webhook URL."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "signingSecret",
              label: "Signing secret (OAuth installs that receive messages)",
              type: "secret",
              required: false,
              // The Slack events route needs the team and app a Connect Slack install records, so a pasted token has no use for it.
              visibleWhenFieldEquals: { fieldKey: "authMode", value: "oauth" },
              explanation: "Slack request signing secret for verified inbound event routing.",
              whyNeeded:
                "Required if you want GoatCitadel to accept signed Slack Events API callbacks and reply inside Slack conversations.",
              whereToFind: [
                paragraph(
                  "Open your Slack app, then Basic Information, then App Credentials, and copy the Signing Secret.",
                ),
              ],
              looksLike: "A short mixed-case secret value from Slack.",
              commonMistakes: [
                "Pasting a bot token here instead of the signing secret.",
                "Forgetting to configure the Events API request URL after saving the secret.",
              ],
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
            paragraph(
              "With a bot token, Test checks the token, posts one test message in your default channel, then deletes it.",
            ),
            paragraph("The webhook-only path sends one test post that stays in the channel."),
          ],
          troubleshooting: [
            ...definitionFailures("token"),
            troubleshoot(
              "not-in-channel",
              "Slack says the app is not in the channel",
              "Type /invite @your-app in the channel. Or add the chat:write.public scope under OAuth & Permissions and reinstall the app.",
            ),
            troubleshoot(
              "channel-not-found",
              "Slack can't find the channel",
              "Use a channel name like #ops, or paste the channel ID. A private channel needs its ID.",
            ),
            troubleshoot(
              "missing-scope",
              "Slack says a scope is missing",
              "Add the missing scope under OAuth & Permissions, then reinstall the app and copy the bot token again.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection. With a bot token, the test posts a message and deletes it, so check that the test passed. With only an incoming webhook, the test post stays in the channel, so check that it arrived there.",
            ),
          ],
          successCriteria: [
            "A bot token or an incoming webhook URL is set.",
            "A channel target is set when you use a bot token.",
            "The test passed. With only an incoming webhook, the test post arrived in Slack.",
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
      testVersion: "2026.05.slack.targets.v1",
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
      lastReviewedAt: "2026-05-02",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Bot token from your own Slack app",
      legacyPathLabel: "Incoming webhook (send-only) or OAuth install (advanced)",
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
      const authMode = readString(config, "authMode");
      return {
        draft: {
          // Kept so the signing-secret field, which only an OAuth install uses, stays on screen when that install is edited.
          ...(authMode ? { authMode } : {}),
          slackInstallId: readString(config, "slackInstallId"),
          targets: normalizeSlackTargets(config),
          defaultChannel: readString(config, "defaultChannel"),
          defaultThreadTs: readString(config, "defaultThreadTs"),
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
            slackInstallId: readString(config, "slackInstallId") ? "configured" : "unknown",
            targets: normalizeSlackTargets(config).length > 0 ? "configured" : "missing",
            defaultChannel: readString(config, "defaultChannel") ? "configured" : "unknown",
            defaultThreadTs: readString(config, "defaultThreadTs") ? "configured" : "unknown",
            webhookUrl: readString(config, "webhookUrl") ? "configured" : "unknown",
            signingSecret:
              readString(config, "signingSecret") || readString(config, "signingSecretEnv") ? "configured" : "unknown",
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
      const preservedWebhookUrl = readLegacyString(draft, "webhookUrl");
      const preservedSigningSecret = readLegacyString(draft, "signingSecret");
      const preservedSigningSecretEnv = readLegacyString(draft, "signingSecretEnv");
      const targets = normalizeSlackTargets(draft.draft);
      const defaultTarget = targets.find((target) => target.default) ?? targets[0];
      return compactRecord({
        authMode: readString(draft.draft, "authMode") ?? readLegacyString(draft, "authMode"),
        slackInstallerUserId:
          readString(draft.draft, "slackInstallerUserId") ?? readLegacyString(draft, "slackInstallerUserId"),
        oauthConnectedAt: readString(draft.draft, "oauthConnectedAt") ?? readLegacyString(draft, "oauthConnectedAt"),
        slackInstallId: readString(draft.draft, "slackInstallId") ?? readLegacyString(draft, "slackInstallId"),
        slackTeamId: readString(draft.draft, "slackTeamId") ?? readLegacyString(draft, "slackTeamId"),
        slackTeamName: readString(draft.draft, "slackTeamName") ?? readLegacyString(draft, "slackTeamName"),
        slackAppId: readString(draft.draft, "slackAppId") ?? readLegacyString(draft, "slackAppId"),
        slackBotUserId: readString(draft.draft, "slackBotUserId") ?? readLegacyString(draft, "slackBotUserId"),
        slackScopes: readString(draft.draft, "slackScopes") ?? readLegacyString(draft, "slackScopes"),
        targets,
        botToken: readString(draft.draft, "botToken") ?? preservedBotToken,
        botTokenEnv: readString(draft.draft, "botTokenEnv") ?? preservedBotTokenEnv,
        defaultChannel: defaultTarget?.channel ?? readString(draft.draft, "defaultChannel"),
        defaultThreadTs: defaultTarget?.threadTs ?? readString(draft.draft, "defaultThreadTs"),
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
      const targets = normalizeSlackTargets(draft.draft);
      const defaultChannel = targets[0]?.channel ?? readString(draft.draft, "defaultChannel");
      const hasConfiguredToken = Boolean(
        token || readString(draft.draft, "botTokenEnv") || draft.hydration?.fieldState.botToken === "configured",
      );
      const hasConfiguredWebhook = Boolean(webhookUrl || draft.hydration?.fieldState.webhookUrl === "configured");
      if (!hasConfiguredToken && !hasConfiguredWebhook) {
        issues.push({
          key: "slack_auth_missing",
          fieldKey: "botToken",
          level: "error",
          message: "Paste the bot token (starts with xoxb-), or a webhook URL for send-only.",
          failureCategory: "missing_input",
          nextSteps: [
            "Paste the Bot User OAuth Token from your Slack app's OAuth & Permissions page, or an incoming webhook URL for a send-only setup, then validate again.",
          ],
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
      // An incoming webhook is bound to one channel already, so a webhook-only setup needs no target of its own.
      const webhookOnly = hasConfiguredWebhook && !hasConfiguredToken;
      if (!defaultChannel && !webhookOnly) {
        issues.push(requiredFieldIssue("targets", "Add at least one Slack channel target."));
      }
      for (const target of targets) {
        if (!target.channel) {
          issues.push(malformedFieldIssue("targets", "Every Slack target needs a channel name or id."));
        }
      }
      return issues;
    },
  };
}
