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

export function createZaloUserDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.zalouser");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bridge_dependent",
      contentVersion: "2026.08.zalouser.v2",
      estimatedMinutes: 8,
      difficulty: "advanced",
      manualModePolicy: "available-secondary",
      introSummary:
        "Configure a zca bridge URL, optional bearer token, optional profile, and a default Zalo personal-session target.",
      prerequisites: [
        "A reachable zca bridge endpoint.",
        "A sandbox personal or group target for manual confirmation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel uses a zca-compatible personal-session bridge for outbound text sends to direct or group targets.",
            ),
            note(
              "warning",
              "Zalo User remains a narrow bridge lane. Guided setup now runs a live sandbox send against the bridge text endpoint, but richer actions still depend on the separate bridge runtime and its current bounds.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your bridge values",
          fields: [
            {
              key: "baseUrl",
              label: "Bridge URL",
              type: "url",
              required: true,
              explanation: "Reachable base URL for the zca personal-session bridge.",
              looksLike: "http://127.0.0.1:56789",
              canChangeLater: true,
            },
            {
              key: "authTokenEnv",
              label: "Bearer token env var",
              type: "text",
              required: false,
              explanation: "Optional env var name for the zca bearer token when the bridge is not local or open.",
              looksLike: "ZALOUSER_AUTH_TOKEN",
              canChangeLater: true,
              placeholder: "ZALOUSER_AUTH_TOKEN",
            },
            {
              key: "authToken",
              label: "Bearer token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct bearer-token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "profile",
              label: "Profile",
              type: "text",
              required: false,
              explanation: "Optional zca profile name when the bridge exposes multiple sessions.",
              looksLike: "work",
              canChangeLater: true,
            },
            {
              key: "defaultTarget",
              label: "Default recipient",
              type: "text",
              required: true,
              explanation: "Fallback personal-session recipient or group target.",
              looksLike: "user:u-123456789 or group:g-987654321",
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
              "Guided test posts a sandbox text message through the configured zca bridge profile and default target. Manual confirmation is still required because cleanup is bridge-dependent and not safely automatable here.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finalize saves the bridge connection. After finalizing, confirm the sandbox text arrived at the default target — manual confirmation closes the loop because cleanup is bridge-dependent here.",
            ),
          ],
          successCriteria: [
            "The zca bridge URL is reachable with the configured profile and optional bearer token.",
            "The sandbox text send reached the default personal or group target.",
            "You confirmed delivery manually in the Zalo conversation.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.zalouser.v1",
      secretFieldKeys: ["authToken"],
    },
    validation: {
      validationVersion: "2026.04.zalouser.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.zalouser.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.zalouser",
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
      lastReviewedAt: "2026-04-01",
      volatility: "high",
      deprecationRisk: "medium",
      preferredPathLabel: "zca bridge URL + optional bearer token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        [
          "authToken",
          "authTokenEnv",
          "authorization",
          "authorizationEnv",
          "accessToken",
          "accessTokenEnv",
          "basicAuth",
          "basicAuthEnv",
        ],
      ]);
      return {
        draft: {
          baseUrl: readString(config, "baseUrl") ?? readString(config, "bridgeUrl") ?? readString(config, "serverUrl"),
          authTokenEnv:
            readString(config, "authTokenEnv") ??
            readString(config, "authorizationEnv") ??
            readString(config, "accessTokenEnv"),
          profile: readString(config, "profile"),
          defaultTarget: readString(config, "defaultTarget"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            baseUrl:
              readString(config, "baseUrl") || readString(config, "bridgeUrl") || readString(config, "serverUrl")
                ? "configured"
                : "missing",
            authToken:
              readString(config, "authToken") ||
              readString(config, "authTokenEnv") ||
              readString(config, "authorization") ||
              readString(config, "authorizationEnv") ||
              readString(config, "accessToken") ||
              readString(config, "accessTokenEnv") ||
              readString(config, "basicAuth") ||
              readString(config, "basicAuthEnv")
                ? "configured"
                : "unknown",
            authTokenEnv:
              readString(config, "authTokenEnv") ||
              readString(config, "authorizationEnv") ||
              readString(config, "accessTokenEnv") ||
              readString(config, "basicAuthEnv")
                ? "configured"
                : "unknown",
            profile: readString(config, "profile") ? "configured" : "unknown",
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
      const explicitAuthToken = readString(draft.draft, "authToken");
      const explicitAuthTokenEnv = readString(draft.draft, "authTokenEnv");
      const legacyAuthorization =
        !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "authorization") : undefined;
      const legacyAuthorizationEnv =
        !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "authorizationEnv") : undefined;
      const legacyAccessToken =
        !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "accessToken") : undefined;
      const legacyAccessTokenEnv =
        !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "accessTokenEnv") : undefined;
      const legacyBasicAuth =
        !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "basicAuth") : undefined;
      const legacyBasicAuthEnv =
        !explicitAuthToken && !explicitAuthTokenEnv ? readLegacyString(draft, "basicAuthEnv") : undefined;
      return compactRecord({
        baseUrl: readString(draft.draft, "baseUrl") ?? readLegacyString(draft, "baseUrl", "bridgeUrl", "serverUrl"),
        authTokenEnv: explicitAuthTokenEnv ?? readLegacyString(draft, "authTokenEnv"),
        authToken: explicitAuthToken ?? readLegacyString(draft, "authToken"),
        authorization: legacyAuthorization,
        authorizationEnv: legacyAuthorizationEnv,
        accessToken: legacyAccessToken,
        accessTokenEnv: legacyAccessTokenEnv,
        basicAuth: legacyBasicAuth,
        basicAuthEnv: legacyBasicAuthEnv,
        profile: readString(draft.draft, "profile"),
        defaultTarget: readString(draft.draft, "defaultTarget"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const baseUrl =
        readString(draft.draft, "baseUrl") ?? readLegacyString(draft, "baseUrl", "bridgeUrl", "serverUrl");
      if (!baseUrl) {
        issues.push(requiredFieldIssue("baseUrl", "Bridge URL is required."));
      } else if (!looksLikeHttpUrl(baseUrl)) {
        issues.push(malformedFieldIssue("baseUrl", "Bridge URL should start with http:// or https://."));
      }
      if (!readString(draft.draft, "defaultTarget")) {
        issues.push(requiredFieldIssue("defaultTarget", "Default recipient is required."));
      }
      return issues;
    },
  };
}
