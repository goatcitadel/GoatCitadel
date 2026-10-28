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

export function createMatrixDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.matrix");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "2026.10.matrix.sync.v1",
      estimatedMinutes: 10,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect a Matrix bot account using your homeserver URL and an access token, with optional inbound over the /sync long-poll.",
      prerequisites: [
        "A Matrix account for the bot on a homeserver you can reach, and an access token for it.",
        "A sandbox room the bot has joined, where it may post.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel uses the Matrix client-server API with a bot access token for text sends, replies, reactions, redactions and typing notices.",
            ),
            paragraph(
              "Optionally, GoatCitadel long-polls /sync so messages in rooms the bot has joined can start conversations. Inbound is opt-in and default-deny: only the Matrix user ids you allow (for example @alice:example.com) can start turns. The sync position is saved, so a restart resumes where it stopped (if the homeserver rejects the stored token, GoatCitadel re-primes and messages in that gap are skipped).",
            ),
            note(
              "warning",
              "Matrix is a guided beta lane. Outbound is text-only (no attachments), and the homeserver host must be in the network allowlist. End-to-end encrypted rooms are not supported: inbound ignores encrypted events and outbound sends unencrypted messages; use an unencrypted room.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "homeserverUrl",
              label: "Homeserver URL",
              type: "url",
              required: true,
              explanation: "Reachable base URL of the Matrix homeserver (client-server API).",
              looksLike: "https://matrix.example.com",
              canChangeLater: true,
            },
            {
              key: "accessTokenEnv",
              label: "Access token env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the bot's Matrix access token.",
              looksLike: "MATRIX_ACCESS_TOKEN",
              canChangeLater: true,
              placeholder: "MATRIX_ACCESS_TOKEN",
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
              key: "defaultRoomId",
              label: "Default room ID",
              type: "text",
              required: false,
              explanation:
                "Optional room used for the guided sandbox test and as a fallback target. Sends normally take the room from the target.",
              looksLike: "!roomid",
              canChangeLater: true,
            },
            {
              key: "inboundStreamEnabled",
              label: "Receive messages over /sync",
              type: "boolean",
              required: false,
              defaultValue: false,
              explanation:
                "Keep a persistent /sync long-poll open so messages in rooms the bot has joined can start conversations.",
              whyNeeded:
                "Matrix has no inbound webhook path here; /sync is how new messages reach GoatCitadel. Inbound stays off unless you opt in, and only allowed Matrix user ids can start turns.",
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
              "Guided test authenticates the access token (whoami), checks the bot has joined the default room, and sends a sandbox m.notice to that room when one is configured.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finalize saves the connection for runtime sends and, when enabled, the inbound /sync loop. After finalizing, post in the default room and confirm the bot replies before relying on this connection.",
            ),
          ],
          successCriteria: [
            "The access token authenticated against the homeserver.",
            "The bot has joined the default room, or you chose to supply the room per send.",
            "The sandbox notice arrived in the room, or you confirmed delivery manually.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.10.matrix.sync.v1",
      secretFieldKeys: ["accessToken"],
    },
    validation: {
      validationVersion: "2026.10.matrix.sync.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.10.matrix.sync.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.matrix",
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
      officialDocsUrl: "https://spec.matrix.org/latest/client-server-api/",
      lastReviewedAt: "2026-10-17",
      volatility: "low",
      deprecationRisk: "low",
      preferredPathLabel: "Bot access token + homeserver URL",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["accessToken", "accessTokenEnv"]]);
      return {
        draft: {
          homeserverUrl: readString(config, "homeserverUrl"),
          accessTokenEnv: readString(config, "accessTokenEnv"),
          defaultRoomId: readString(config, "defaultRoomId"),
          inboundStreamEnabled: isTruthyFlag(config.inboundStreamEnabled),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            homeserverUrl: readString(config, "homeserverUrl") ? "configured" : "missing",
            accessToken:
              readString(config, "accessToken") || readString(config, "accessTokenEnv") ? "configured" : "missing",
            accessTokenEnv: readString(config, "accessTokenEnv") ? "configured" : "unknown",
            defaultRoomId: readString(config, "defaultRoomId") ? "configured" : "unknown",
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
      const preservedToken = readLegacyString(draft, "accessToken");
      const preservedTokenEnv = readLegacyString(draft, "accessTokenEnv");
      const inboundStreamEnabled = isTruthyFlag(draft.draft.inboundStreamEnabled);
      return compactRecord({
        homeserverUrl: readString(draft.draft, "homeserverUrl"),
        accessTokenEnv: readString(draft.draft, "accessTokenEnv") ?? preservedTokenEnv,
        accessToken: readString(draft.draft, "accessToken") ?? preservedToken,
        defaultRoomId: readString(draft.draft, "defaultRoomId"),
        inboundStreamEnabled: inboundStreamEnabled ? true : undefined,
        // Inbound is default-deny: never inherit a legacy-open posture.
        ...(inboundStreamEnabled ? { inboundAccessMode: "allowlist" } : {}),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const homeserverUrl = readString(draft.draft, "homeserverUrl");
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "accessToken") ||
        readString(draft.draft, "accessTokenEnv") ||
        draft.hydration?.fieldState.accessToken === "configured" ||
        draft.hydration?.fieldState.accessTokenEnv === "configured",
      );
      if (!homeserverUrl) {
        issues.push(requiredFieldIssue("homeserverUrl", "Homeserver URL is required."));
      } else if (!looksLikeHttpUrl(homeserverUrl)) {
        issues.push(malformedFieldIssue("homeserverUrl", "Homeserver URL should start with http:// or https://."));
      }
      if (!hasConfiguredToken) {
        issues.push({
          key: "matrix_auth_missing",
          level: "error",
          message: "Provide either a Matrix access token or an env-backed access-token reference.",
          failureCategory: "missing_input",
        });
      }
      const roomId = readString(draft.draft, "defaultRoomId");
      if (roomId && !/^![^\s:]+(?::\S+)?$/.test(roomId)) {
        issues.push(
          malformedFieldIssue(
            "defaultRoomId",
            "Room ids start with !, for example !opaque or !opaque:example.com; #alias:example.com is not accepted.",
          ),
        );
      }
      return issues;
    },
  };
}
