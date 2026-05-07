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
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

export function createGoogleChatDefinition(): ChannelSetupRuntimeDefinition {
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
            paragraph(
              "GoatCitadel can send outbound operator messages to a Google Chat space through an incoming webhook.",
            ),
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
            paragraph(
              "GoatCitadel validates the webhook shape and sends a sandbox webhook probe during guided test and retest flows.",
            ),
            paragraph(
              "You still need to confirm manually that the post landed in the intended Google Chat space or thread.",
            ),
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
        issues.push(
          malformedFieldIssue("webhookUrl", "Webhook URL should look like a Google Chat incoming webhook URL."),
        );
      }
      return issues;
    },
  };
}
