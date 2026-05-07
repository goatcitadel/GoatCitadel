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

export function createLineDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.line");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bot_token_target",
      contentVersion: "2026.04.line.v1",
      estimatedMinutes: 6,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Connect LINE with a channel access token and a default user, room, or group target.",
      prerequisites: [
        "A LINE Messaging API channel with a valid channel access token.",
        "A sandbox target identifier for manual confirmation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel uses the LINE Messaging API for outbound sends and can accept signed inbound webhook events when you configure the channel secret.",
            ),
            note(
              "warning",
              "LINE is a guided beta lane. Guided setup now runs a live token-auth probe and can post a sandbox push message to the configured default target before finalize.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "channelAccessTokenEnv",
              label: "Channel access token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the LINE channel access token.",
              looksLike: "LINE_CHANNEL_ACCESS_TOKEN",
              canChangeLater: true,
              placeholder: "LINE_CHANNEL_ACCESS_TOKEN",
            },
            {
              key: "channelAccessToken",
              label: "Channel access token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "channelSecretEnv",
              label: "Channel secret env var",
              type: "text",
              required: false,
              explanation: "Optional but recommended if you want signed inbound webhook routing.",
              whyNeeded:
                "LINE signs webhook deliveries with the channel secret. Without it GoatCitadel stays outbound only.",
              looksLike: "LINE_CHANNEL_SECRET",
              canChangeLater: true,
              placeholder: "LINE_CHANNEL_SECRET",
            },
            {
              key: "channelSecret",
              label: "Channel secret (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct channel-secret entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultTarget",
              label: "Default target",
              type: "text",
              required: true,
              explanation: "Fallback LINE user, room, or group id.",
              looksLike: "userId, groupId, or roomId",
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
              "Guided test validates the channel access token live and can post a sandbox push message to the configured default target. Inbound webhook routing still requires the optional channel secret.",
            ),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.line.v1",
      secretFieldKeys: ["channelAccessToken", "channelSecret"],
    },
    validation: {
      validationVersion: "2026.04.line.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.04.line.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.line",
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
      officialDocsUrl: "https://developers.line.biz/en/docs/messaging-api/",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Channel access token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["channelAccessToken", "channelAccessTokenEnv", "accessToken", "accessTokenEnv", "token", "tokenEnv"],
        ["channelSecret", "channelSecretEnv", "secret", "secretEnv"],
      ]);
      return {
        draft: {
          channelAccessTokenEnv:
            readString(config, "channelAccessTokenEnv") ??
            readString(config, "accessTokenEnv") ??
            readString(config, "tokenEnv"),
          channelSecretEnv: readString(config, "channelSecretEnv") ?? readString(config, "secretEnv"),
          defaultTarget: readString(config, "defaultTarget"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            channelAccessToken:
              readString(config, "channelAccessToken") ||
              readString(config, "channelAccessTokenEnv") ||
              readString(config, "accessToken") ||
              readString(config, "accessTokenEnv") ||
              readString(config, "token") ||
              readString(config, "tokenEnv")
                ? "configured"
                : "missing",
            channelAccessTokenEnv:
              readString(config, "channelAccessTokenEnv") ||
              readString(config, "accessTokenEnv") ||
              readString(config, "tokenEnv")
                ? "configured"
                : "unknown",
            channelSecret:
              readString(config, "channelSecret") ||
              readString(config, "channelSecretEnv") ||
              readString(config, "secret") ||
              readString(config, "secretEnv")
                ? "configured"
                : "unknown",
            channelSecretEnv:
              readString(config, "channelSecretEnv") || readString(config, "secretEnv") ? "configured" : "unknown",
            defaultTarget: readString(config, "defaultTarget") ? "configured" : "missing",
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
      const preservedToken = readLegacyString(draft, "channelAccessToken", "accessToken", "token");
      const preservedTokenEnv = readLegacyString(draft, "channelAccessTokenEnv", "accessTokenEnv", "tokenEnv");
      const preservedChannelSecret = readLegacyString(draft, "channelSecret", "secret");
      const preservedChannelSecretEnv = readLegacyString(draft, "channelSecretEnv", "secretEnv");
      return compactRecord({
        channelAccessTokenEnv: readString(draft.draft, "channelAccessTokenEnv") ?? preservedTokenEnv,
        channelAccessToken: readString(draft.draft, "channelAccessToken") ?? preservedToken,
        channelSecretEnv: readString(draft.draft, "channelSecretEnv") ?? preservedChannelSecretEnv,
        channelSecret: readString(draft.draft, "channelSecret") ?? preservedChannelSecret,
        defaultTarget: readString(draft.draft, "defaultTarget"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "channelAccessToken") ||
        readString(draft.draft, "channelAccessTokenEnv") ||
        draft.hydration?.fieldState.channelAccessToken === "configured" ||
        draft.hydration?.fieldState.channelAccessTokenEnv === "configured",
      );
      if (!hasConfiguredToken) {
        issues.push({
          key: "line_auth_missing",
          level: "error",
          message: "Provide either a LINE channel access token or an env-backed token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultTarget")) {
        issues.push(requiredFieldIssue("defaultTarget", "Default target is required."));
      }
      return issues;
    },
  };
}
