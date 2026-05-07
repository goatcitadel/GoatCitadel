import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  COMMON_FAILURES,
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  readString,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
} from "./common.js";

export function createZaloDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.zalo");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "platform_api_resource_ids",
      contentVersion: "2026.04.zalo.v1",
      estimatedMinutes: 6,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Connect a Zalo Official Account sender with an access token and a default recipient id.",
      prerequisites: ["A Zalo Official Account bot token.", "A sandbox Zalo recipient id for manual confirmation."],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel uses the Zalo Official Account send path for outbound text delivery to the configured recipient id.",
            ),
            note(
              "warning",
              "Zalo OA ships as a narrow outbound lane. Guided setup now runs a live sandbox send against the OA send endpoint, but it does not claim broader inbound or action parity.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "accessTokenEnv",
              label: "Access token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the Zalo access token.",
              looksLike: "ZALO_ACCESS_TOKEN",
              canChangeLater: true,
              placeholder: "ZALO_ACCESS_TOKEN",
            },
            {
              key: "accessToken",
              label: "Access token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultRecipientId",
              label: "Default recipient ID",
              type: "text",
              required: true,
              explanation: "Fallback Zalo recipient id for manual sends.",
              looksLike: "zalo-user-id",
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
              "Guided test posts a sandbox message through the Zalo Official Account send endpoint using the configured default recipient id. Manual confirmation is still required because the API path does not expose safe cleanup here.",
            ),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.zalo.v1",
      secretFieldKeys: ["accessToken"],
    },
    validation: {
      validationVersion: "2026.04.zalo.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.zalo.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.zalo",
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
        "https://developers.zalo.me/docs/api/official-account-api/thong-tin-chung-ve-official-account-api",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "medium",
      preferredPathLabel: "Official Account access token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["accessToken", "accessTokenEnv", "token", "tokenEnv"],
      ]);
      return {
        draft: {
          accessTokenEnv: readString(config, "accessTokenEnv") ?? readString(config, "tokenEnv"),
          defaultRecipientId: readString(config, "defaultRecipientId"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            accessToken:
              readString(config, "accessToken") ||
              readString(config, "accessTokenEnv") ||
              readString(config, "token") ||
              readString(config, "tokenEnv")
                ? "configured"
                : "missing",
            accessTokenEnv:
              readString(config, "accessTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            defaultRecipientId: readString(config, "defaultRecipientId") ? "configured" : "missing",
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
      const preservedAccessToken = readLegacyString(draft, "accessToken", "token");
      const preservedAccessTokenEnv = readLegacyString(draft, "accessTokenEnv", "tokenEnv");
      return compactRecord({
        accessTokenEnv: readString(draft.draft, "accessTokenEnv") ?? preservedAccessTokenEnv,
        accessToken: readString(draft.draft, "accessToken") ?? preservedAccessToken,
        defaultRecipientId: readString(draft.draft, "defaultRecipientId"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "accessToken") ||
        readString(draft.draft, "accessTokenEnv") ||
        draft.hydration?.fieldState.accessToken === "configured" ||
        draft.hydration?.fieldState.accessTokenEnv === "configured",
      );
      if (!hasConfiguredToken) {
        issues.push({
          key: "zalo_auth_missing",
          level: "error",
          message: "Provide either a Zalo access token or an env-backed token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultRecipientId")) {
        issues.push(requiredFieldIssue("defaultRecipientId", "Default recipient ID is required."));
      }
      return issues;
    },
  };
}
