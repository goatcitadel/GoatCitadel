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
        "A Slack workspace where you can approve the GoatCitadel Slack app.",
        "Permission to install apps or ask an admin to approve the install.",
        "At least one sandbox channel for the first test post.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel can install into Slack through OAuth, store the workspace install, and route messages to multiple named Slack channels.",
            ),
            note(
              "info",
              "OAuth is the easiest path. Manual bot-token and webhook fields stay available below for advanced local-first fallback setups.",
            ),
          ],
        },
        {
          id: "prerequisites",
          kind: "prerequisites",
          title: "Before you start",
          checklist: [
            check("workspace", "Choose the Slack workspace"),
            check("sandbox", "Pick at least one sandbox channel for the first target"),
            check("permissions", "Confirm you can approve or request the GoatCitadel Slack app"),
          ],
        },
        {
          id: "oauth-install",
          kind: "instruction",
          title: "Connect Slack with OAuth",
          body: [
            paragraph(
              "Use Connect Slack from Mission Control to approve the hosted GoatCitadel Slack app. After approval, return here and choose the channels GoatCitadel should use.",
            ),
            linkBlock("Slack OAuth v2", "https://api.slack.com/authentication/oauth-v2"),
          ],
          checklist: [
            check("connect", "Click Connect Slack"),
            check("approve", "Approve the GoatCitadel Slack app"),
            check("workspace", "Confirm Mission Control shows the connected workspace"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Choose Slack targets",
          fields: [
            {
              key: "slackInstallId",
              label: "Connected Slack install",
              type: "text",
              required: false,
              explanation: "OAuth install identifier returned by the Slack connection flow.",
              whyNeeded: "Used to connect this setup draft to the approved workspace install.",
              whereToFind: [
                paragraph(
                  "Use the Connect Slack action in Mission Control. This field is filled automatically when possible.",
                ),
              ],
              looksLike: "slack:T0123456789",
              canChangeLater: true,
            },
            {
              key: "targets",
              label: "Slack channel targets",
              type: "textarea",
              required: true,
              explanation: "Named Slack channels this one workspace install can use.",
              whyNeeded: "Lets one Slack connection serve multiple channels without repeating setup.",
              whereToFind: [
                paragraph(
                  "Add a target for each Slack channel. Use #channel-name for public channels or C/G ids for private channels.",
                ),
              ],
              looksLike: "Default: #ops-sandbox",
              commonMistakes: [
                "Adding a private channel before inviting the app into that channel.",
                "Creating separate full connections instead of adding targets here.",
              ],
              canChangeLater: true,
            },
            {
              key: "botToken",
              label: "Advanced fallback: Bot User OAuth token",
              type: "secret",
              required: false,
              explanation: "Manual token fallback for self-owned Slack app setups.",
              whyNeeded: "Used to validate the app installation and post as the bot.",
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
              key: "defaultChannel",
              label: "Legacy default channel",
              type: "text",
              required: false,
              explanation: "Compatibility fallback for older single-channel Slack connections.",
              whyNeeded: "Used only when no target rows are configured.",
              whereToFind: [
                paragraph(
                  "Use the channel name like #ops-sandbox or copy the channel id for private channels if needed.",
                ),
              ],
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
              label: "Advanced fallback: incoming webhook URL",
              type: "url",
              required: false,
              explanation: "Optional send-only webhook fallback. Webhooks are tied to one selected Slack channel.",
              whyNeeded: "Useful when you need a lightweight send-only path or a fallback route.",
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
              label: "Optional signing secret",
              type: "secret",
              required: false,
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
              "GoatCitadel validates the bot token when present and sends a sandbox message plus cleanup probe for bot-token Slack connections.",
            ),
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
      preferredPathLabel: "Hosted Slack OAuth install",
      legacyPathLabel: "Manual bot token or incoming webhook fallback",
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
          level: "error",
          message: "Connect Slack with OAuth first, or use the advanced manual bot-token/webhook fallback.",
          failureCategory: "missing_input",
          nextSteps: ["Click Connect Slack, approve the workspace, then add channel targets and rerun validation."],
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
