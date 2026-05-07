import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  readString,
  looksLikeHttpUrl,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

export function createSignalDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.signal");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bridge_dependent",
      contentVersion: "2026.04.signal.v1",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Configure a Signal bridge endpoint, optional account id, and a default recipient for outbound sends.",
      prerequisites: [
        "A running Signal bridge endpoint that GoatCitadel can reach.",
        "A sandbox recipient or group for manual send confirmation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel uses the configured Signal bridge for outbound sends to individual recipients or groups.",
            ),
            note(
              "warning",
              "Signal ships as a narrow outbound bridge. Guided setup now runs a live sandbox send against that exact send path, but it does not imply richer actions beyond the current bridge lane.",
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
              explanation: "HTTP or HTTPS base URL for the Signal bridge GoatCitadel should call.",
              whyNeeded: "Required for every outbound send.",
              whereToFind: [
                paragraph(
                  "Use the reachable base URL for your Signal bridge, such as a local signal-cli REST or JSON-RPC proxy.",
                ),
              ],
              looksLike: "http://127.0.0.1:8080",
              commonMistakes: ["Using a browser dashboard URL instead of the API base URL."],
              canChangeLater: true,
            },
            {
              key: "accountId",
              label: "Account ID",
              type: "text",
              required: false,
              explanation: "Optional sender account identifier when the bridge exposes multiple Signal accounts.",
              looksLike: "+15551234567",
              canChangeLater: true,
            },
            {
              key: "defaultRecipient",
              label: "Default recipient",
              type: "text",
              required: true,
              explanation: "Fallback direct recipient or group target for manual sends.",
              looksLike: "+15551234567 or group identifier",
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
              "Guided test posts a sandbox send through the configured Signal JSON-RPC bridge path against the default recipient or group target. Manual confirmation still closes the loop because the bridge does not expose a safe cleanup path.",
            ),
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.signal.v1",
      secretFieldKeys: [],
    },
    validation: {
      validationVersion: "2026.04.signal.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.signal.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.signal",
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
      officialDocsUrl: "https://github.com/bbernhard/signal-cli-rest-api",
      lastReviewedAt: "2026-04-01",
      volatility: "high",
      deprecationRisk: "medium",
      preferredPathLabel: "Signal bridge URL",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      return {
        draft: {
          baseUrl: readString(config, "baseUrl") ?? readString(config, "bridgeUrl"),
          accountId: readString(config, "accountId"),
          defaultRecipient: readString(config, "defaultRecipient"),
        },
        hydration: {
          status: "clean",
          fieldState: {
            baseUrl: readString(config, "baseUrl") || readString(config, "bridgeUrl") ? "configured" : "missing",
            accountId: readString(config, "accountId") ? "configured" : "unknown",
            defaultRecipient: readString(config, "defaultRecipient") ? "configured" : "missing",
          },
          warnings: [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      return compactRecord({
        baseUrl: readString(draft.draft, "baseUrl") ?? readLegacyString(draft, "baseUrl", "bridgeUrl"),
        accountId: readString(draft.draft, "accountId"),
        defaultRecipient: readString(draft.draft, "defaultRecipient"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const baseUrl = readString(draft.draft, "baseUrl") ?? readLegacyString(draft, "baseUrl", "bridgeUrl");
      if (!baseUrl) {
        issues.push(requiredFieldIssue("baseUrl", "Bridge URL is required."));
      } else if (!looksLikeHttpUrl(baseUrl)) {
        issues.push(malformedFieldIssue("baseUrl", "Bridge URL should start with http:// or https://."));
      }
      if (!readString(draft.draft, "defaultRecipient")) {
        issues.push(requiredFieldIssue("defaultRecipient", "Default recipient is required."));
      }
      return issues;
    },
  };
}
