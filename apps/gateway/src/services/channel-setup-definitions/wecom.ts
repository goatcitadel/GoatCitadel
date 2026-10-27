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
  malformedFieldIssue,
} from "./common.js";

const SECRET_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["secret", "secretEnv"],
  ["callbackToken", "callbackTokenEnv"],
  ["encodingAesKey", "encodingAesKeyEnv"],
];

export function createWecomDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.wecom");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "webhook_destination",
      contentVersion: "2026.10.wecom.callback.v1",
      estimatedMinutes: 15,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect a WeCom self-built application using its CorpID, AgentId and Secret, with an encrypted callback for inbound messages.",
      prerequisites: [
        "A WeCom self-built application with its CorpID, AgentId and Secret.",
        "The gateway host's public IP added to the application's trusted IP list (otherwise sends fail with errcode 60020).",
        "For inbound, the callback Token and EncodingAESKey set in the application's message-receiving settings, and a public HTTPS Gateway URL.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel gets a corp access token from the CorpID and application Secret and sends text messages to users, departments or tags through the application. Inbound text messages arrive on an encrypted callback: GoatCitadel checks the SHA-1 signature, decrypts with the EncodingAESKey and verifies the CorpID before anything is accepted.",
            ),
            paragraph(
              "Inbound is opt-in by configuration and default-deny: it stays off until the callback Token and EncodingAESKey are set, and only the WeCom userids you allow can start turns.",
            ),
            note(
              "warning",
              "WeCom is a guided beta lane. Outbound is text-only (attachments are rejected), reactions and unsend are not supported, and qyapi.weixin.qq.com must be in the network allowlist.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "corpId",
              label: "Corp ID",
              type: "text",
              required: true,
              explanation: "The CorpID shown under My Enterprise in the WeCom admin console.",
              looksLike: "ww1234567890abcdef",
              canChangeLater: true,
            },
            {
              key: "agentId",
              label: "Agent ID",
              type: "text",
              required: true,
              explanation: "The numeric AgentId of the self-built application.",
              looksLike: "1000002",
              canChangeLater: true,
            },
            {
              key: "secretEnv",
              label: "Application secret env var",
              type: "text",
              required: false,
              explanation: "Preferred path. Name of the env var that stores the application's Secret.",
              looksLike: "WECOM_SECRET",
              canChangeLater: true,
              placeholder: "WECOM_SECRET",
            },
            {
              key: "secret",
              label: "Application secret (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct secret entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "callbackTokenEnv",
              label: "Callback token env var",
              type: "text",
              required: false,
              explanation:
                "Name of the env var that stores the callback Token. Inbound stays off until this and the EncodingAESKey are set.",
              looksLike: "WECOM_CALLBACK_TOKEN",
              canChangeLater: true,
              placeholder: "WECOM_CALLBACK_TOKEN",
            },
            {
              key: "callbackToken",
              label: "Callback token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "encodingAesKeyEnv",
              label: "EncodingAESKey env var",
              type: "text",
              required: false,
              explanation: "Name of the env var that stores the callback's 43-character EncodingAESKey.",
              looksLike: "WECOM_ENCODING_AES_KEY",
              canChangeLater: true,
              placeholder: "WECOM_ENCODING_AES_KEY",
            },
            {
              key: "encodingAesKey",
              label: "EncodingAESKey (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct key entry if env-backed storage is not ready yet.",
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
                "Optional recipient for the guided sandbox test and as a fallback: user:<userid>, party:<departmentid>, tag:<tagid> or a bare userid. Replies to inbound messages go to the sender.",
              looksLike: "user:zhangsan",
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
              "After you finalize the connection, open the application's message-receiving settings in the WeCom admin console and set the URL to your public Gateway origin followed by /api/v1/integrations/connections/<connectionId>/wecom/webhook (the connection id is created when you finalize, and the callback only works once the connection is enabled and connected). Enter the same Token and EncodingAESKey you stored here.",
            ),
            paragraph(
              "WeCom then sends a verification request with an encrypted echostr; GoatCitadel verifies the signature, decrypts it and answers with the plaintext. Save the URL in WeCom only after the connection is enabled.",
            ),
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph(
              "Guided test requests an access token, reads the application, reports whether the callback Token and EncodingAESKey are set, and sends one sandbox text to the default target when one is configured.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finalize saves the connection for runtime sends and, when the callback credentials are set, the encrypted inbound callback. After finalizing, allow your WeCom userid, message the application, and confirm it replies before relying on this connection.",
            ),
          ],
          successCriteria: [
            "WeCom issued an access token for the CorpID and Secret.",
            "The application was found and this server's IP is trusted.",
            "The sandbox message arrived, or you confirmed delivery manually.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.10.wecom.callback.v1",
      secretFieldKeys: ["secret", "callbackToken", "encodingAesKey"],
    },
    validation: {
      validationVersion: "2026.10.wecom.callback.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.10.wecom.callback.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.wecom",
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
      officialDocsUrl: "https://developer.work.weixin.qq.com/document/path/90664",
      lastReviewedAt: "2026-10-17",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Self-built application with an encrypted callback",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(
        config,
        SECRET_GROUPS.map((group) => [...group]),
      );
      const state = (direct: string, env: string) =>
        readString(config, direct) || readString(config, env) ? "configured" : "missing";
      return {
        draft: {
          corpId: readString(config, "corpId"),
          agentId: readAgentId(config),
          secretEnv: readString(config, "secretEnv"),
          callbackTokenEnv: readString(config, "callbackTokenEnv"),
          encodingAesKeyEnv: readString(config, "encodingAesKeyEnv"),
          defaultTarget: readString(config, "defaultTarget"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            corpId: readString(config, "corpId") ? "configured" : "missing",
            agentId: readAgentId(config) ? "configured" : "missing",
            secret: state("secret", "secretEnv"),
            secretEnv: readString(config, "secretEnv") ? "configured" : "unknown",
            callbackToken: state("callbackToken", "callbackTokenEnv"),
            callbackTokenEnv: readString(config, "callbackTokenEnv") ? "configured" : "unknown",
            encodingAesKey: state("encodingAesKey", "encodingAesKeyEnv"),
            encodingAesKeyEnv: readString(config, "encodingAesKeyEnv") ? "configured" : "unknown",
            defaultTarget: readString(config, "defaultTarget") ? "configured" : "unknown",
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
      const value = (direct: string, env: string) => {
        const draftDirect = readString(draft.draft, direct);
        const draftEnv = readString(draft.draft, env);
        // Per pair: keep the legacy value only when the draft supplies neither form.
        const keepLegacy = !draftDirect && !draftEnv;
        return {
          [env]: draftEnv ?? (keepLegacy ? readLegacyString(draft, env) : undefined),
          [direct]: draftDirect ?? (keepLegacy ? readLegacyString(draft, direct) : undefined),
        };
      };
      return compactRecord({
        corpId: readString(draft.draft, "corpId"),
        agentId: readString(draft.draft, "agentId"),
        ...value("secret", "secretEnv"),
        ...value("callbackToken", "callbackTokenEnv"),
        ...value("encodingAesKey", "encodingAesKeyEnv"),
        defaultTarget: readString(draft.draft, "defaultTarget"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      if (!readString(draft.draft, "corpId")) {
        issues.push(requiredFieldIssue("corpId", "Corp ID is required."));
      }
      const agentId = readString(draft.draft, "agentId");
      if (!agentId) {
        issues.push(requiredFieldIssue("agentId", "Agent ID is required."));
      } else if (!/^\d+$/.test(agentId)) {
        issues.push(malformedFieldIssue("agentId", "Agent ID is the numeric AgentId of the application."));
      }
      const hasConfiguredSecret = Boolean(
        readString(draft.draft, "secret") ||
        readString(draft.draft, "secretEnv") ||
        draft.hydration?.fieldState.secret === "configured" ||
        draft.hydration?.fieldState.secretEnv === "configured",
      );
      if (!hasConfiguredSecret) {
        issues.push({
          key: "wecom_auth_missing",
          level: "error",
          message: "Provide either the WeCom application secret or an env-backed secret reference.",
          failureCategory: "missing_input",
        });
      }
      return issues;
    },
  };
}

function readAgentId(config: Record<string, unknown>): string | undefined {
  const text = readString(config, "agentId");
  if (text) return text;
  return typeof config.agentId === "number" && Number.isFinite(config.agentId) ? String(config.agentId) : undefined;
}
