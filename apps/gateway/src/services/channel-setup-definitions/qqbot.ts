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
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

const QQBOT_TARGET_PATTERN = /^(?:group|user|channel|dm):\S+$/;

export function createQqbotDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.qqbot");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "webhook_destination",
      contentVersion: "2026.10.qqbot.webhook.v1",
      estimatedMinutes: 12,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect a QQ Bot Open Platform app using its AppID and AppSecret, with a signed webhook for inbound messages.",
      prerequisites: [
        "A QQ Bot Open Platform app with its AppID and AppSecret.",
        "A public HTTPS Gateway URL that the QQ console can reach for event callbacks.",
        "The QQ sandbox members and group or user openids you will test with.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel mints an app access token from the AppID and AppSecret and sends text to group, C2C (user), guild channel and guild direct-message targets. Inbound events arrive on a webhook whose ed25519 signature is verified with the AppSecret before anything is accepted.",
            ),
            paragraph(
              "Inbound is default-deny: only the QQ openids you allow (the id QQ assigns to the sender, not a QQ number) can start turns. Replies to an inbound message are passive replies that carry its message id. QQ allows active (unprompted) group and C2C messages only within platform quotas.",
            ),
            note(
              "warning",
              "QQBot is a guided beta lane. Outbound is text-only (attachments are rejected), reactions and unsend are not supported, and the QQ hosts (bots.qq.com, api.bot.qq.com, and sandbox.api.sgroup.qq.com for the sandbox) must be in the network allowlist.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "appId",
              label: "App ID",
              type: "text",
              required: true,
              explanation: "The AppID of the QQ Bot Open Platform application.",
              looksLike: "102000000",
              canChangeLater: true,
            },
            {
              key: "appSecretEnv",
              label: "App secret env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the bot's AppSecret.",
              looksLike: "QQBOT_APP_SECRET",
              canChangeLater: true,
              placeholder: "QQBOT_APP_SECRET",
            },
            {
              key: "appSecret",
              label: "App secret (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct secret entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "defaultTarget",
              label: "Default target",
              type: "text",
              required: false,
              explanation:
                "Optional destination for the guided sandbox test and as a fallback. Use group:<openid>, user:<openid>, channel:<id> or dm:<guild id>. Replies to inbound messages use the sender's own target.",
              looksLike: "user:<openid>",
              canChangeLater: true,
            },
            {
              key: "sandbox",
              label: "Use the sandbox API",
              type: "boolean",
              required: false,
              defaultValue: false,
              explanation:
                "Send through sandbox.api.sgroup.qq.com. Apps that are not yet published can only use the sandbox.",
              canChangeLater: true,
            },
          ],
        },
        {
          id: "webhook",
          kind: "instruction",
          title: "Register the callback URL",
          body: [
            paragraph(
              "After you finalize the connection, open the QQ Bot console, choose Development > Callback configuration, and set the request URL to your public Gateway origin followed by /api/v1/integrations/connections/<connectionId>/qqbot/webhook (the connection id is created when you finalize, and the callback only works once the connection is enabled and connected). Subscribe to the group, C2C, guild-channel and direct-message events you need.",
            ),
            paragraph(
              "QQ then sends a validation request (op 13); GoatCitadel answers it with an AppSecret signature, and verifies the request signature whenever QQ includes one. Every other event must carry a valid signature, and unsigned or wrongly signed events are rejected.",
            ),
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph(
              "Guided test requests an access token with the AppID and AppSecret, reads the bot identity, and sends one active sandbox message to the default target when one is configured. QQ limits active messages, so a rejection there can be a quota, not a credential problem.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finalize saves the connection for runtime sends and the signed inbound webhook. After finalizing, register the callback URL in the QQ console and confirm it passes QQ's validation request. Then allow your QQ openid (group member_openid and C2C user_openid are different ids, so allow each scope's id), message the bot, and confirm it replies before relying on this connection.",
            ),
          ],
          successCriteria: [
            "QQ issued an access token for the AppID and AppSecret.",
            "The sandbox message arrived, or you confirmed delivery manually.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.10.qqbot.webhook.v1",
      secretFieldKeys: ["appSecret"],
    },
    validation: {
      validationVersion: "2026.10.qqbot.webhook.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.10.qqbot.webhook.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.qqbot",
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
      officialDocsUrl: "https://bot.q.qq.com/wiki/develop/api-v2/",
      lastReviewedAt: "2026-10-17",
      volatility: "medium",
      deprecationRisk: "medium",
      preferredPathLabel: "AppID + AppSecret with a signed webhook",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      // The earlier catalog form saved the secret env name as tokenEnv; show it as appSecretEnv.
      const appSecretEnv = readString(config, "appSecretEnv") ?? readString(config, "tokenEnv");
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [["appSecret", "appSecretEnv", "tokenEnv"]]);
      return {
        draft: {
          appId: readString(config, "appId"),
          appSecretEnv,
          defaultTarget: readString(config, "defaultTarget"),
          sandbox: isTruthyFlag(config.sandbox),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            appId: readString(config, "appId") ? "configured" : "missing",
            appSecret: readString(config, "appSecret") || appSecretEnv ? "configured" : "missing",
            appSecretEnv: appSecretEnv ? "configured" : "unknown",
            defaultTarget: readString(config, "defaultTarget") ? "configured" : "unknown",
            sandbox: config.sandbox === undefined ? "unknown" : "configured",
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
      const draftSecret = readString(draft.draft, "appSecret");
      const draftSecretEnv = readString(draft.draft, "appSecretEnv");
      // Keep the legacy credential only when the draft supplies neither form, so a direct-to-env
      // rotation does not leave the old secret behind.
      const keepLegacy = !draftSecret && !draftSecretEnv;
      return compactRecord({
        appId: readString(draft.draft, "appId"),
        appSecretEnv: draftSecretEnv ?? (keepLegacy ? readLegacyString(draft, "appSecretEnv", "tokenEnv") : undefined),
        appSecret: draftSecret ?? (keepLegacy ? readLegacyString(draft, "appSecret") : undefined),
        defaultTarget: readString(draft.draft, "defaultTarget"),
        sandbox: isTruthyFlag(draft.draft.sandbox) ? true : undefined,
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      if (!readString(draft.draft, "appId")) {
        issues.push(requiredFieldIssue("appId", "App ID is required."));
      }
      const hasConfiguredSecret = Boolean(
        readString(draft.draft, "appSecret") ||
        readString(draft.draft, "appSecretEnv") ||
        draft.hydration?.fieldState.appSecret === "configured" ||
        draft.hydration?.fieldState.appSecretEnv === "configured",
      );
      if (!hasConfiguredSecret) {
        issues.push({
          key: "qqbot_auth_missing",
          level: "error",
          message: "Provide either a QQBot app secret or an env-backed app-secret reference.",
          failureCategory: "missing_input",
        });
      }
      const target = readString(draft.draft, "defaultTarget");
      if (target && !QQBOT_TARGET_PATTERN.test(target)) {
        issues.push(
          malformedFieldIssue(
            "defaultTarget",
            "Targets start with group:, user:, channel: or dm: followed by the id, for example user:<openid>.",
          ),
        );
      }
      return issues;
    },
  };
}
