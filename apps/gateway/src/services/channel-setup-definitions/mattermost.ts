import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import { isExplicitTrue as isTruthyFlag } from "@goatcitadel/gateway-core";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  COMMON_FAILURES,
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

export function createMattermostDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.mattermost");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "2026.10.mattermost.stream.v3",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect Mattermost using a reachable server URL, a bot token, and a default channel target, with optional inbound posts over the bot WebSocket.",
      prerequisites: [
        "A Mattermost workspace with a bot account or bot token.",
        "A sandbox channel where the bot can post.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph("GoatCitadel uses Mattermost bot-token auth for outbound sends, replies, reactions, and unsend."),
            paragraph(
              "Optionally, GoatCitadel keeps the bot's WebSocket open so posts in channels the bot has joined can start conversations. Inbound is opt-in and default-deny: only the Mattermost user ids you allow can start turns.",
            ),
            note(
              "warning",
              "Mattermost is a guided beta lane. Guided setup now runs live auth, channel access, and sandbox send/delete probes before finalize.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "serverUrl",
              label: "Server URL",
              type: "url",
              required: true,
              explanation: "Reachable Mattermost server base URL.",
              looksLike: "https://chat.example.com",
              canChangeLater: true,
            },
            {
              key: "botTokenEnv",
              label: "Bot token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the Mattermost bot token.",
              looksLike: "MATTERMOST_BOT_TOKEN",
              canChangeLater: true,
              placeholder: "MATTERMOST_BOT_TOKEN",
            },
            {
              key: "botToken",
              label: "Bot token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct bot-token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultChannel",
              label: "Default channel",
              type: "text",
              required: true,
              explanation: "Fallback Mattermost channel slug or id.",
              looksLike: "town-square or channel-id",
              canChangeLater: true,
            },
            {
              key: "inboundStreamEnabled",
              label: "Receive posts over the bot WebSocket",
              type: "boolean",
              required: false,
              defaultValue: false,
              explanation:
                "Keep a persistent WebSocket open so posts in channels the bot belongs to can start conversations.",
              whyNeeded:
                "Mattermost has no inbound webhook path here; the bot WebSocket is how new posts reach GoatCitadel. Inbound stays off unless you opt in, and only allowed Mattermost user ids can start turns. Posts sent while the socket is disconnected are not recovered.",
              canChangeLater: true,
            },
            {
              key: "defaultTeam",
              label: "Default team",
              type: "text",
              required: false,
              explanation: "Optional team slug for channel resolution when channel names are ambiguous.",
              looksLike: "goatcitadel",
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
              "Guided test authenticates the bot token live, resolves the configured channel target, and posts a sandbox message that is deleted automatically when cleanup permissions are available.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finalize saves the connection for runtime sends and, when enabled, the inbound WebSocket. After finalizing, post a sandbox message to the default channel and confirm the bot delivers before relying on this connection.",
            ),
          ],
          successCriteria: [
            "The bot token authenticated live against the configured server URL.",
            "The configured default channel resolved and accepted the sandbox post.",
            "The sandbox message was cleaned up automatically, or you removed it manually where cleanup permissions were unavailable.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.10.mattermost.stream.v2",
      secretFieldKeys: ["botToken"],
    },
    validation: {
      validationVersion: "2026.10.mattermost.stream.v2",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.10.mattermost.stream.v2",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.mattermost",
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
      officialDocsUrl: "https://developers.mattermost.com/integrate/reference/server/server-reference/",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Bot token + default channel",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["botToken", "botTokenEnv", "token", "tokenEnv"]]);
      return {
        draft: {
          serverUrl: readString(config, "serverUrl"),
          botTokenEnv: readString(config, "botTokenEnv") ?? readString(config, "tokenEnv"),
          defaultChannel: readString(config, "defaultChannel"),
          defaultTeam: readString(config, "defaultTeam"),
          inboundStreamEnabled: isTruthyFlag(config.inboundStreamEnabled),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            serverUrl: readString(config, "serverUrl") ? "configured" : "missing",
            botToken:
              readString(config, "botToken") ||
              readString(config, "botTokenEnv") ||
              readString(config, "token") ||
              readString(config, "tokenEnv")
                ? "configured"
                : "missing",
            botTokenEnv: readString(config, "botTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            defaultChannel: readString(config, "defaultChannel") ? "configured" : "missing",
            defaultTeam: readString(config, "defaultTeam") ? "configured" : "unknown",
            inboundStreamEnabled: config.inboundStreamEnabled === undefined ? "unknown" : "configured",
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
      const preservedBotToken = readLegacyString(draft, "botToken", "token");
      const preservedBotTokenEnv = readLegacyString(draft, "botTokenEnv", "tokenEnv");
      return compactRecord({
        serverUrl: readString(draft.draft, "serverUrl"),
        botTokenEnv: readString(draft.draft, "botTokenEnv") ?? preservedBotTokenEnv,
        botToken: readString(draft.draft, "botToken") ?? preservedBotToken,
        defaultChannel: readString(draft.draft, "defaultChannel"),
        defaultTeam: readString(draft.draft, "defaultTeam"),
        inboundStreamEnabled: isTruthyFlag(draft.draft.inboundStreamEnabled) ? true : undefined,
        // Inbound is default-deny: never inherit a legacy-open posture.
        ...(isTruthyFlag(draft.draft.inboundStreamEnabled) ? { inboundAccessMode: "allowlist" } : {}),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const serverUrl = readString(draft.draft, "serverUrl");
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "botToken") ||
        readString(draft.draft, "botTokenEnv") ||
        draft.hydration?.fieldState.botToken === "configured" ||
        draft.hydration?.fieldState.botTokenEnv === "configured",
      );
      if (!serverUrl) {
        issues.push(requiredFieldIssue("serverUrl", "Server URL is required."));
      } else if (!looksLikeHttpUrl(serverUrl)) {
        issues.push(malformedFieldIssue("serverUrl", "Server URL should start with http:// or https://."));
      }
      if (!hasConfiguredToken) {
        issues.push({
          key: "mattermost_auth_missing",
          level: "error",
          message: "Provide either a Mattermost bot token or an env-backed bot-token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultChannel")) {
        issues.push(requiredFieldIssue("defaultChannel", "Default channel is required."));
      }
      return issues;
    },
  };
}
