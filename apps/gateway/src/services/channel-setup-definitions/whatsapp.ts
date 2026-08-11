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

export function createWhatsAppDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.whatsapp");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "platform_api_resource_ids",
      contentVersion: "2026.08.whatsapp.v3",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Connect a WhatsApp Cloud API sender identity with a phone-number id, access token, and a default direct recipient target.",
      prerequisites: [
        "A Meta developer app with WhatsApp Cloud API access.",
        "A sender phone-number id that is already provisioned in your Meta app.",
        "A sandbox recipient or test number for manual confirmation.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel uses the WhatsApp Cloud API for outbound sends, replies, reactions, and rich media delivery to direct recipients. It can also ingest signed inbound webhook events, but inbound routing stays disabled until BOTH the app secret and the webhook verify token are configured. With only one of the two, the connection remains outbound-only.",
            ),
            paragraph(
              "Rich sends are preflighted before delivery: native media labels, text fallbacks, pending attachment hydration, provider evidence, and attachment-count limits are recorded before the Cloud API send.",
            ),
            note(
              "warning",
              "WhatsApp Cloud API is a guided beta lane. Guided setup now runs a live sender-auth probe and can post a sandbox message to the configured default recipient before finalize.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "accessTokenEnv",
              label: "Access token env var",
              type: "text",
              required: false,
              explanation:
                "Preferred path. Name of the environment variable that stores your WhatsApp Cloud API access token.",
              whyNeeded:
                "Used to authenticate outbound API calls without storing the raw token in the connection draft.",
              whereToFind: [
                paragraph(
                  "Create or reuse an env var such as WHATSAPP_ACCESS_TOKEN and store the actual Cloud API token there.",
                ),
              ],
              looksLike: "WHATSAPP_ACCESS_TOKEN",
              commonMistakes: ["Pasting the actual token here instead of the env var name."],
              canChangeLater: true,
              placeholder: "WHATSAPP_ACCESS_TOKEN",
            },
            {
              key: "accessToken",
              label: "Access token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct token entry if env-backed secret storage is not ready yet.",
              looksLike: "A long Meta access token string.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "phoneNumberId",
              label: "Phone number ID",
              type: "id",
              required: true,
              explanation: "The Cloud API sender phone-number id for this WhatsApp identity.",
              whyNeeded: "Required for all outbound Cloud API calls.",
              whereToFind: [
                paragraph(
                  "Copy the phone-number id from the WhatsApp Cloud API sender configuration in the Meta developer console.",
                ),
              ],
              looksLike: "123456789012345",
              commonMistakes: ["Copying the display phone number instead of the numeric phone-number id."],
              canChangeLater: true,
            },
            {
              key: "defaultTarget",
              label: "Default recipient",
              type: "text",
              required: true,
              explanation: "Fallback direct recipient for manual sends and validation follow-up checks.",
              whyNeeded: "Used when the operator does not provide an explicit recipient target.",
              whereToFind: [paragraph("Use an E.164 phone number such as +15551234567.")],
              looksLike: "+15551234567",
              commonMistakes: ["Using a group JID. The current Cloud API sender is wired for direct recipients only."],
              canChangeLater: true,
            },
            {
              key: "appSecretEnv",
              label: "App secret env var",
              type: "text",
              required: false,
              explanation:
                "Optional but recommended if you want signed inbound webhook routing. Inbound is only enabled when BOTH this app secret and the webhook verify token are configured.",
              whyNeeded:
                "Meta signs WhatsApp webhook deliveries with your app secret. Without it GoatCitadel stays outbound only, even if the verify token is set.",
              whereToFind: [
                paragraph(
                  "Copy the app secret from the Meta developer app settings and store it in an env var such as WHATSAPP_APP_SECRET.",
                ),
              ],
              looksLike: "WHATSAPP_APP_SECRET",
              commonMistakes: ["Using the access token here instead of the app secret."],
              canChangeLater: true,
              placeholder: "WHATSAPP_APP_SECRET",
            },
            {
              key: "appSecret",
              label: "App secret (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct app-secret entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
            {
              key: "webhookVerifyTokenEnv",
              label: "Webhook verify-token env var",
              type: "text",
              required: false,
              explanation:
                "Optional but recommended if you want GoatCitadel to answer the Meta webhook verification challenge. Inbound is only enabled when BOTH this verify token and the app secret are configured.",
              whyNeeded:
                "The verify token is compared during GET webhook subscription validation before Meta begins signed POST deliveries. Without it GoatCitadel stays outbound only, even if the app secret is set.",
              whereToFind: [
                paragraph(
                  "Choose your own random token value, store it in an env var such as WHATSAPP_WEBHOOK_VERIFY_TOKEN, and use the same value when configuring the Meta webhook subscription.",
                ),
              ],
              looksLike: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
              canChangeLater: true,
              placeholder: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
            },
            {
              key: "webhookVerifyToken",
              label: "Webhook verify token (manual fallback)",
              type: "secret",
              required: false,
              explanation: "Optional direct verify-token entry if env-backed storage is not ready yet.",
              sensitive: true,
              canChangeLater: true,
              placeholder: "Paste only if you cannot use an env var",
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph(
              "Guided test validates the sender identity live against the Cloud API and can post a sandbox message to the configured default recipient. If you also configure BOTH the app secret and the verify token, the runtime can answer the Meta webhook challenge and accept signed inbound deliveries; with only one of the two, inbound stays disabled. Operator proof is still manual after finalize.",
            ),
            paragraph(
              "Runtime rich-message evidence records whether media is native, text fallback, pending hydration, or blocked before provider delivery.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finalize saves the connection for runtime sends. After finalizing, confirm the sandbox message arrived on the default recipient's WhatsApp; inbound routing stays disabled unless both the app secret and the webhook verify token are configured.",
            ),
          ],
          successCriteria: [
            "The sender identity passed the live Cloud API auth probe.",
            "The sandbox message reached the configured default recipient.",
            "Both the app secret and the webhook verify token are configured when you want signed inbound routing.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.whatsapp.v1",
      secretFieldKeys: ["accessToken", "appSecret", "webhookVerifyToken"],
    },
    validation: {
      validationVersion: "2026.04.whatsapp.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.04.whatsapp.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_1",
      namespace: "channel_setup.whatsapp",
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
      officialDocsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Cloud API access token + phone-number id",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["accessToken", "accessTokenEnv", "token", "tokenEnv"],
        ["appSecret", "appSecretEnv", "webhookSecret", "webhookSecretEnv"],
        ["webhookVerifyToken", "webhookVerifyTokenEnv", "verifyToken", "verifyTokenEnv"],
      ]);
      return {
        draft: {
          accessTokenEnv: readString(config, "accessTokenEnv") ?? readString(config, "tokenEnv"),
          appSecretEnv: readString(config, "appSecretEnv") ?? readString(config, "webhookSecretEnv"),
          webhookVerifyTokenEnv: readString(config, "webhookVerifyTokenEnv") ?? readString(config, "verifyTokenEnv"),
          phoneNumberId: readString(config, "phoneNumberId"),
          defaultTarget: readString(config, "defaultTarget"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            accessToken:
              readString(config, "accessToken") ||
              readString(config, "accessTokenEnv") ||
              readString(config, "token") ||
              readString(config, "tokenEnv")
                ? "configured"
                : "missing",
            accessTokenEnv:
              readString(config, "accessTokenEnv") || readString(config, "tokenEnv") ? "configured" : "unknown",
            appSecret:
              readString(config, "appSecret") ||
              readString(config, "appSecretEnv") ||
              readString(config, "webhookSecret") ||
              readString(config, "webhookSecretEnv")
                ? "configured"
                : "unknown",
            appSecretEnv:
              readString(config, "appSecretEnv") || readString(config, "webhookSecretEnv") ? "configured" : "unknown",
            webhookVerifyToken:
              readString(config, "webhookVerifyToken") ||
              readString(config, "webhookVerifyTokenEnv") ||
              readString(config, "verifyToken") ||
              readString(config, "verifyTokenEnv")
                ? "configured"
                : "unknown",
            webhookVerifyTokenEnv:
              readString(config, "webhookVerifyTokenEnv") || readString(config, "verifyTokenEnv")
                ? "configured"
                : "unknown",
            phoneNumberId: readString(config, "phoneNumberId") ? "configured" : "missing",
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
      const preservedAccessToken = readLegacyString(draft, "accessToken", "token");
      const preservedAccessTokenEnv = readLegacyString(draft, "accessTokenEnv", "tokenEnv");
      const preservedAppSecret = readLegacyString(draft, "appSecret", "webhookSecret");
      const preservedAppSecretEnv = readLegacyString(draft, "appSecretEnv", "webhookSecretEnv");
      const preservedVerifyToken = readLegacyString(draft, "webhookVerifyToken", "verifyToken");
      const preservedVerifyTokenEnv = readLegacyString(draft, "webhookVerifyTokenEnv", "verifyTokenEnv");
      return compactRecord({
        accessTokenEnv: readString(draft.draft, "accessTokenEnv") ?? preservedAccessTokenEnv,
        accessToken: readString(draft.draft, "accessToken") ?? preservedAccessToken,
        appSecretEnv: readString(draft.draft, "appSecretEnv") ?? preservedAppSecretEnv,
        appSecret: readString(draft.draft, "appSecret") ?? preservedAppSecret,
        webhookVerifyTokenEnv: readString(draft.draft, "webhookVerifyTokenEnv") ?? preservedVerifyTokenEnv,
        webhookVerifyToken: readString(draft.draft, "webhookVerifyToken") ?? preservedVerifyToken,
        phoneNumberId: readString(draft.draft, "phoneNumberId"),
        defaultTarget: readString(draft.draft, "defaultTarget"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "accessToken") ||
        readString(draft.draft, "accessTokenEnv") ||
        draft.hydration?.fieldState.accessToken === "configured" ||
        draft.hydration?.fieldState.accessTokenEnv === "configured",
      );
      const phoneNumberId = readString(draft.draft, "phoneNumberId");
      if (!hasConfiguredToken) {
        issues.push({
          key: "whatsapp_auth_missing",
          level: "error",
          message: "Provide either a WhatsApp access token or an env-backed token reference.",
          failureCategory: "missing_input",
        });
      }
      if (!phoneNumberId) {
        issues.push(requiredFieldIssue("phoneNumberId", "Phone number ID is required."));
      } else if (!/^\d{6,}$/.test(phoneNumberId)) {
        issues.push(
          malformedFieldIssue("phoneNumberId", "Phone number ID should look like a numeric WhatsApp sender id."),
        );
      }
      if (!readString(draft.draft, "defaultTarget")) {
        issues.push(requiredFieldIssue("defaultTarget", "Default recipient is required."));
      }
      return issues;
    },
  };
}
