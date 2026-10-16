import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import { isExplicitTrue } from "@goatcitadel/gateway-core";
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
      contentVersion: "2026.10.signal.stream.v5",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Configure a Signal bridge endpoint and a default recipient for sends, with optional inbound messages from the signal-cli HTTP daemon event stream.",
      prerequisites: [
        "A running Signal bridge endpoint that GoatCitadel can reach.",
        "A sandbox recipient or group for manual send confirmation.",
        "For inbound, a signal-cli daemon --http bridge and the sender UUIDs (or numbers) allowed to start conversations.",
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
            paragraph(
              "Optionally, GoatCitadel subscribes to the event stream of a signal-cli daemon --http bridge (/api/v1/events) so direct and group messages can start conversations. Inbound is opt-in and default-deny: only the senders you allow can start turns.",
            ),
            note(
              "warning",
              "signal-cli acknowledges messages to the Signal server itself, so messages that arrive while GoatCitadel's event stream is disconnected are not replayed and are lost. Guided setup runs a live sandbox send against the JSON-RPC send path.",
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
              key: "receiveEvents",
              label: "Receive messages from the signal-cli event stream",
              type: "boolean",
              required: false,
              defaultValue: false,
              explanation:
                "Keep a persistent subscription to the signal-cli daemon --http event stream so incoming direct and group messages can start conversations.",
              whyNeeded:
                "Inbound stays off unless you opt in, and only allowed senders can start turns. Messages that arrive while the stream is disconnected are not replayed.",
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
              "Guided test posts a sandbox send through the configured Signal JSON-RPC bridge path against the default recipient or group target. The sandbox probe does not remote-delete its test message (the bridge supports remoteDelete for channel.unsend, but the probe leaves the message for you to see), so manual confirmation still closes the loop.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finalize saves the bridge connection and, when enabled, the inbound event-stream subscription. After finalizing, confirm the sandbox message arrived on the default recipient's Signal device — the probe does not delete it, so manual confirmation closes the loop.",
            ),
          ],
          successCriteria: [
            "The bridge URL points at the Signal bridge GoatCitadel should call for sends and, when enabled, inbound events.",
            "The sandbox send through the JSON-RPC path reached the default recipient or group target.",
            "You confirmed delivery manually on a Signal device.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.10.signal.stream.v3",
      secretFieldKeys: [],
    },
    validation: {
      validationVersion: "2026.10.signal.stream.v3",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.10.signal.stream.v3",
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
      const legacyInboundEnabled = readSignalBoolean(config, "inboundEnabled") === true;
      const legacyPollIntervalConfigured = config.pollIntervalSeconds !== undefined;
      return {
        draft: {
          baseUrl: readString(config, "baseUrl") ?? readString(config, "bridgeUrl"),
          accountId: readString(config, "accountId"),
          defaultRecipient: readString(config, "defaultRecipient"),
          receiveEvents: isExplicitTrue(config.receiveEvents),
        },
        hydration: {
          status: "clean",
          fieldState: {
            baseUrl: readString(config, "baseUrl") || readString(config, "bridgeUrl") ? "configured" : "missing",
            accountId: readString(config, "accountId") ? "configured" : "unknown",
            defaultRecipient: readString(config, "defaultRecipient") ? "configured" : "missing",
            receiveEvents: config.receiveEvents === undefined ? "unknown" : "configured",
          },
          warnings:
            legacyInboundEnabled || legacyPollIntervalConfigured
              ? [
                  "Deprecated Signal inbound polling settings (inboundEnabled, pollIntervalSeconds) were found. They were replaced by receiveEvents and will be removed when this draft is finalized; enable receiveEvents to receive messages from the signal-cli event stream.",
                ]
              : [],
          rawLegacyConfig: config,
        },
      };
    },
    normalize(draft) {
      return compactRecord({
        baseUrl: readString(draft.draft, "baseUrl") ?? readLegacyString(draft, "baseUrl", "bridgeUrl"),
        accountId: readString(draft.draft, "accountId"),
        defaultRecipient: readString(draft.draft, "defaultRecipient"),
        receiveEvents: isExplicitTrue(draft.draft.receiveEvents) ? true : undefined,
        // Inbound is default-deny: never inherit a legacy-open posture.
        ...(isExplicitTrue(draft.draft.receiveEvents) ? { inboundAccessMode: "allowlist" } : {}),
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
      if (inboundEnabled === true) {
        issues.push(
          malformedFieldIssue(
            "inboundEnabled",
            "Signal inbound polling was replaced by receiveEvents; remove inboundEnabled and enable receiveEvents instead.",
          ),
        );
      }
      const rawPollInterval = draft.draft.pollIntervalSeconds;
      if (rawPollInterval !== undefined && rawPollInterval !== null && String(rawPollInterval).trim() !== "") {
        issues.push(
          malformedFieldIssue(
            "pollIntervalSeconds",
            "Signal polling was replaced by the receiveEvents event stream; remove this legacy field.",
          ),
        );
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
