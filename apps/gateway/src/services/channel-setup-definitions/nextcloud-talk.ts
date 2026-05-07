import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  readString,
  looksLikeHttpUrl,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

export function createNextcloudTalkDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.nextcloud-talk");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "2026.04.nextcloud-talk.v1",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect Nextcloud Talk using the public base URL, the shared bot token, and a default fallback room id.",
      prerequisites: [
        "A reachable Nextcloud Talk instance.",
        "A Talk bot token or shared webhook secret already provisioned for the integration.",
        "A fallback room id for manual sends.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel uses the Nextcloud Talk bot API plus signed webhooks for inbound events, outbound replies, and reactions.",
            ),
            note(
              "info",
              "Nextcloud Talk already has runtime support in the gateway. This guided definition brings its setup flow into parity with the other visible channel setup wizards.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "baseUrl",
              label: "Base URL",
              type: "url",
              required: true,
              explanation: "Public base URL for the Nextcloud instance that hosts Talk.",
              looksLike: "https://cloud.example.com",
              canChangeLater: true,
            },
            {
              key: "tokenEnv",
              label: "Token env var",
              type: "text",
              required: false,
              explanation:
                "Preferred path. Name of the env var that stores the shared Nextcloud Talk bot token or webhook secret.",
              looksLike: "NEXTCLOUD_TALK_TOKEN",
              canChangeLater: true,
              placeholder: "NEXTCLOUD_TALK_TOKEN",
            },
            {
              key: "token",
              label: "Token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultRoomId",
              label: "Default room ID",
              type: "text",
              required: true,
              explanation: "Fallback room for manual sends and operator-delivery routing.",
              looksLike: "room-id",
              canChangeLater: true,
            },
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.nextcloud-talk.v1",
      secretFieldKeys: ["token"],
    },
    validation: {
      validationVersion: "2026.04.nextcloud-talk.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.nextcloud-talk.v1",
      levels: ["structural", "semantic", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.nextcloud_talk",
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
      officialDocsUrl: "https://nextcloud-talk.readthedocs.io/en/latest/bots/",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Base URL + Talk token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["token", "tokenEnv", "botSecret", "botSecretEnv", "secret", "secretEnv"],
      ]);
      return {
        draft: {
          baseUrl: readString(config, "baseUrl"),
          tokenEnv:
            readString(config, "tokenEnv") ?? readString(config, "botSecretEnv") ?? readString(config, "secretEnv"),
          defaultRoomId: readString(config, "defaultRoomId"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            baseUrl: readString(config, "baseUrl") ? "configured" : "missing",
            token:
              readString(config, "token") ||
              readString(config, "tokenEnv") ||
              readString(config, "botSecret") ||
              readString(config, "botSecretEnv") ||
              readString(config, "secret") ||
              readString(config, "secretEnv")
                ? "configured"
                : "missing",
            tokenEnv:
              readString(config, "tokenEnv") || readString(config, "botSecretEnv") || readString(config, "secretEnv")
                ? "configured"
                : "unknown",
            defaultRoomId: readString(config, "defaultRoomId") ? "configured" : "missing",
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
      const preservedToken = readLegacyString(draft, "token", "botSecret", "secret");
      const preservedTokenEnv = readLegacyString(draft, "tokenEnv", "botSecretEnv", "secretEnv");
      return compactRecord({
        baseUrl: readString(draft.draft, "baseUrl"),
        tokenEnv: readString(draft.draft, "tokenEnv") ?? preservedTokenEnv,
        token: readString(draft.draft, "token") ?? preservedToken,
        defaultRoomId: readString(draft.draft, "defaultRoomId"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const baseUrl = readString(draft.draft, "baseUrl");
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "token") ||
        readString(draft.draft, "tokenEnv") ||
        draft.hydration?.fieldState.token === "configured" ||
        draft.hydration?.fieldState.tokenEnv === "configured",
      );
      if (!baseUrl) {
        issues.push(requiredFieldIssue("baseUrl", "Base URL is required."));
      } else if (!looksLikeHttpUrl(baseUrl)) {
        issues.push(malformedFieldIssue("baseUrl", "Base URL should start with http:// or https://."));
      }
      if (!hasConfiguredToken) {
        issues.push({
          key: "nextcloud_talk_auth_missing",
          level: "error",
          message: "Provide either a Nextcloud Talk token or an env-backed token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultRoomId")) {
        issues.push(requiredFieldIssue("defaultRoomId", "Default room ID is required."));
      }
      return issues;
    },
  };
}
