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

export function createIMessageDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.imessage");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bridge_dependent",
      contentVersion: "2026.04.imessage.v1",
      estimatedMinutes: 10,
      difficulty: "advanced",
      manualModePolicy: "available-secondary",
      introSummary:
        "Configure a BlueBubbles-compatible iMessage bridge URL, bridge password, and a default handle or chat target.",
      prerequisites: [
        "A reachable BlueBubbles bridge with outbound send support.",
        "A Mac-side BlueBubbles installation already paired with the account you intend to send from.",
        "A sandbox handle or chat target for manual validation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel uses a BlueBubbles-compatible bridge for outbound iMessage sends, replies, reactions, and unsend.",
            ),
            note(
              "warning",
              "BlueBubbles-specific edge cases still apply. Guided setup now runs a live bridge query plus a sandbox send/unsend cycle, but new-handle attachment delivery can still require chat creation support and reactions or unsend still depend on Private API support.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your bridge values",
          fields: [
            {
              key: "bridgeUrl",
              label: "Bridge URL",
              type: "url",
              required: true,
              explanation: "Reachable BlueBubbles bridge base URL.",
              looksLike: "http://127.0.0.1:3001",
              canChangeLater: true,
            },
            {
              key: "passwordEnv",
              label: "Bridge password env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the BlueBubbles bridge password.",
              looksLike: "IMESSAGE_PASSWORD",
              canChangeLater: true,
              placeholder: "IMESSAGE_PASSWORD",
            },
            {
              key: "password",
              label: "Bridge password (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct bridge-password entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultHandle",
              label: "Default handle",
              type: "text",
              required: true,
              explanation: "Fallback iMessage handle or chat identifier for manual sends.",
              looksLike: "imessage:+15551234567 or chat_guid:iMessage;-;+15551234567",
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
              "Guided test queries the BlueBubbles bridge live, then sends and unsends a sandbox message against the configured default handle or chat target.",
            ),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.imessage.v1",
      secretFieldKeys: ["password"],
    },
    validation: {
      validationVersion: "2026.04.imessage.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.04.imessage.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.imessage",
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
      officialDocsUrl: "https://bluebubbles.app/",
      lastReviewedAt: "2026-04-01",
      volatility: "high",
      deprecationRisk: "medium",
      preferredPathLabel: "BlueBubbles bridge URL + password",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["password", "passwordEnv", "apiPassword", "apiPasswordEnv"],
      ]);
      return {
        draft: {
          bridgeUrl:
            readString(config, "bridgeUrl") ?? readString(config, "baseUrl") ?? readString(config, "serverUrl"),
          passwordEnv: readString(config, "passwordEnv") ?? readString(config, "apiPasswordEnv"),
          defaultHandle: readString(config, "defaultHandle"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            bridgeUrl:
              readString(config, "bridgeUrl") || readString(config, "baseUrl") || readString(config, "serverUrl")
                ? "configured"
                : "missing",
            password:
              readString(config, "password") ||
              readString(config, "passwordEnv") ||
              readString(config, "apiPassword") ||
              readString(config, "apiPasswordEnv")
                ? "configured"
                : "missing",
            passwordEnv:
              readString(config, "passwordEnv") || readString(config, "apiPasswordEnv") ? "configured" : "unknown",
            defaultHandle: readString(config, "defaultHandle") ? "configured" : "missing",
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
      const preservedPassword = readLegacyString(draft, "password", "apiPassword");
      const preservedPasswordEnv = readLegacyString(draft, "passwordEnv", "apiPasswordEnv");
      return compactRecord({
        bridgeUrl: readString(draft.draft, "bridgeUrl") ?? readLegacyString(draft, "bridgeUrl", "baseUrl", "serverUrl"),
        passwordEnv: readString(draft.draft, "passwordEnv") ?? preservedPasswordEnv,
        password: readString(draft.draft, "password") ?? preservedPassword,
        defaultHandle: readString(draft.draft, "defaultHandle"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const bridgeUrl =
        readString(draft.draft, "bridgeUrl") ?? readLegacyString(draft, "bridgeUrl", "baseUrl", "serverUrl");
      const hasConfiguredPassword = Boolean(
        readString(draft.draft, "password") ||
        readString(draft.draft, "passwordEnv") ||
        draft.hydration?.fieldState.password === "configured" ||
        draft.hydration?.fieldState.passwordEnv === "configured",
      );
      if (!bridgeUrl) {
        issues.push(requiredFieldIssue("bridgeUrl", "Bridge URL is required."));
      } else if (!looksLikeHttpUrl(bridgeUrl)) {
        issues.push(malformedFieldIssue("bridgeUrl", "Bridge URL should start with http:// or https://."));
      }
      if (!hasConfiguredPassword) {
        issues.push({
          key: "imessage_auth_missing",
          level: "error",
          message: "Provide either an iMessage bridge password or an env-backed password reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultHandle")) {
        issues.push(requiredFieldIssue("defaultHandle", "Default handle is required."));
      }
      return issues;
    },
  };
}
