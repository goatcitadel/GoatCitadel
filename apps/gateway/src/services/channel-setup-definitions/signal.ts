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
      contentVersion: "2026.07.signal.v2",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Configure a Signal bridge endpoint, optional account id, a default recipient for outbound sends, and optional inbound polling.",
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
              "Signal ships as a narrow outbound bridge. Guided setup now runs a live sandbox send against that exact send path, but it does not imply richer actions beyond the current bridge lane. Optional inbound polling reads new messages from the same local bridge on a fixed interval — it needs the account id, applies the connection sender allowlist, and handles plain-text messages only.",
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
            {
              key: "inboundEnabled",
              label: "Enable inbound polling",
              type: "boolean",
              required: false,
              explanation:
                "When enabled, GoatCitadel polls the bridge receive endpoint for new messages so Signal becomes bidirectional. Requires the Account ID above, and inbound senders stay governed by the connection allowlist.",
              canChangeLater: true,
            },
            {
              key: "pollIntervalSeconds",
              label: "Poll interval (seconds)",
              type: "text",
              required: false,
              explanation: "How often to poll the bridge for inbound messages. Defaults to 10 seconds; minimum 5.",
              looksLike: "10",
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
      const inboundEnabled = readSignalBoolean(config, "inboundEnabled");
      return {
        draft: {
          baseUrl: readString(config, "baseUrl") ?? readString(config, "bridgeUrl"),
          accountId: readString(config, "accountId"),
          defaultRecipient: readString(config, "defaultRecipient"),
          inboundEnabled,
          pollIntervalSeconds: readSignalPollInterval(config),
        },
        hydration: {
          status: "clean",
          fieldState: {
            baseUrl: readString(config, "baseUrl") || readString(config, "bridgeUrl") ? "configured" : "missing",
            accountId: readString(config, "accountId") ? "configured" : "unknown",
            defaultRecipient: readString(config, "defaultRecipient") ? "configured" : "missing",
            inboundEnabled: inboundEnabled !== undefined ? "configured" : "unknown",
            pollIntervalSeconds: readSignalPollInterval(config) !== undefined ? "configured" : "unknown",
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
        inboundEnabled: readSignalBoolean(draft.draft, "inboundEnabled"),
        pollIntervalSeconds: readSignalPollInterval(draft.draft),
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
      const inboundEnabled = readSignalBoolean(draft.draft, "inboundEnabled");
      if (draft.draft.inboundEnabled !== undefined && inboundEnabled === undefined) {
        issues.push(malformedFieldIssue("inboundEnabled", "Inbound polling toggle must be true or false."));
      }
      if (inboundEnabled === true && !readString(draft.draft, "accountId")) {
        issues.push(
          requiredFieldIssue(
            "accountId",
            "Account ID is required when inbound polling is enabled — the bridge receive endpoint is per-account.",
          ),
        );
      }
      const rawPollInterval = draft.draft.pollIntervalSeconds;
      if (rawPollInterval !== undefined && rawPollInterval !== null && String(rawPollInterval).trim() !== "") {
        const pollInterval = readSignalPollInterval(draft.draft);
        if (pollInterval === undefined) {
          issues.push(
            malformedFieldIssue("pollIntervalSeconds", "Poll interval must be a whole number of seconds (minimum 5)."),
          );
        }
      }
      return issues;
    },
  };
}

function readSignalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

const SIGNAL_MIN_POLL_INTERVAL_SECONDS = 5;
const SIGNAL_MAX_POLL_INTERVAL_SECONDS = 3_600;

function readSignalPollInterval(record: Record<string, unknown>): number | undefined {
  const value = record.pollIntervalSeconds;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : undefined;
  if (parsed === undefined || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return undefined;
  }
  if (parsed < SIGNAL_MIN_POLL_INTERVAL_SECONDS || parsed > SIGNAL_MAX_POLL_INTERVAL_SECONDS) {
    return undefined;
  }
  return parsed;
}
