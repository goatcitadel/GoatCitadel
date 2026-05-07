import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  check,
  readString,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

export function createTeamsDefinition(): ChannelSetupRuntimeDefinition {
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
            note(
              "warning",
              "Webhook URLs are secrets. Treat them like tokens and keep them out of committed config when possible.",
            ),
          ],
        },
        {
          id: "create-webhook",
          kind: "instruction",
          title: "Create the Teams webhook",
          body: [
            paragraph(
              "Open the target Teams channel, add the incoming webhook or approved connector, then copy the full webhook URL.",
            ),
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
              whereToFind: [
                paragraph("Copy the full webhook URL from the Teams connector or incoming webhook setup flow."),
              ],
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
            paragraph(
              "GoatCitadel validates the webhook shape and sends a sandbox webhook probe during guided test and retest flows.",
            ),
            paragraph("You still need to confirm manually that the card arrived in the intended Teams channel."),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "After finalizing, send a sandbox post and confirm the card arrives in the intended Teams channel.",
            ),
          ],
          successCriteria: ["The webhook URL is configured.", "A sandbox Teams post is confirmed manually."],
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
      officialDocsUrl:
        "https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using",
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
            webhookUrl:
              readString(config, "webhookUrl") || readString(config, "webhookUrlEnv") ? "configured" : "missing",
            cardTitle: readString(config, "cardTitle") ? "configured" : "unknown",
          },
          warnings: hasConfiguredSecret
            ? [
                "Saved webhook URLs are intentionally not rehydrated into the wizard. Replace them only if you need to change them.",
              ]
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
        webhookUrl ||
        readString(draft.draft, "webhookUrlEnv") ||
        draft.hydration?.fieldState.webhookUrl === "configured",
      );
      if (!hasConfiguredWebhook) {
        issues.push(requiredFieldIssue("webhookUrl", "Webhook URL is required."));
      } else if (
        webhookUrl &&
        !/^https:\/\/(?:outlook\.office\.com|[\w.-]+\.webhook\.office\.com)\/webhook/i.test(webhookUrl)
      ) {
        issues.push(
          malformedFieldIssue("webhookUrl", "Webhook URL should look like a Microsoft Teams incoming webhook URL."),
        );
      }
      return issues;
    },
  };
}
