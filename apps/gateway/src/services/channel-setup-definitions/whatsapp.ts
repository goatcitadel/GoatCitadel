import {
  resolveChannelOwnerActorIds,
  type ChannelSetupDefinition,
  type ChannelSetupIssue,
} from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  COMMON_FAILURES,
  PASTED_SECRET_EXPLANATION,
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  linkBlock,
  troubleshoot,
  readString,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
} from "./common.js";

/** The shape of Meta's numeric IDs (phone number, app, WhatsApp Business Account): digits only, six or more. */
const NUMERIC_ID_PATTERN = /^\d{6,}$/;

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
        "Send WhatsApp messages from a WhatsApp Business number through Meta's Cloud API. Receiving messages needs a public HTTPS address. Personal WhatsApp (QR code linking) isn't supported.",
      prerequisites: [
        "A Meta app with WhatsApp set up, its phone number ID, and a permanent System User access token.",
        "The recipient messages your business number first; WhatsApp delivers the plain-text test only in the 24 hours after that.",
        "To receive messages: a public HTTPS address with a trusted certificate, the app secret, and a verify token you choose.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "Sending works from this computer. To chat with the bot, Meta must reach your Gateway over a public HTTPS address with a trusted certificate. GoatCitadel doesn't provide one; without it WhatsApp is send-only. Personal WhatsApp (QR code linking) isn't supported.",
            ),
            note(
              "warning",
              "WhatsApp Cloud API is a guided beta lane. The setup test checks your access token live and will post a test message to your Default recipient.",
            ),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "accessToken",
              label: "Access token",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded: "Lets GoatCitadel send messages from your WhatsApp number.",
              whereToFind: [
                paragraph(
                  "Use a permanent System User token, not the temporary one on the API Setup page (that one expires quickly). Business Settings › Users › System users › Add › assign your app and WhatsApp account › Generate token with whatsapp_business_messaging, whatsapp_business_management and business_management.",
                ),
                linkBlock(
                  "Meta: Get started with the Cloud API",
                  "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
                ),
              ],
              looksLike: "A long Meta access token string.",
              commonMistakes: ["Using the temporary token from the API Setup page. It expires quickly."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "accessTokenEnv",
              label: "Access token env var",
              type: "text",
              required: false,
              advanced: true,
              explanation: "Name of the environment variable that holds your WhatsApp access token.",
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
              key: "phoneNumberId",
              label: "Phone number ID",
              type: "id",
              required: true,
              explanation: "The Cloud API sender phone-number id for this WhatsApp identity.",
              whyNeeded: "Required for all outbound Cloud API calls.",
              whereToFind: [
                paragraph(
                  "In Meta's App Dashboard open WhatsApp › API Setup. The Phone number ID is under the From number.",
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
              explanation:
                "The WhatsApp number that gets the test message and any send that names no one. First, from the recipient's phone, send any message to your business number. That opens WhatsApp's 24-hour window. Then run the live test. GoatCitadel's test is plain text, which WhatsApp only delivers inside that window.",
              whyNeeded: "Used when the operator does not provide an explicit recipient target.",
              whereToFind: [paragraph("Use an E.164 phone number such as +15551234567.")],
              looksLike: "+15551234567",
              commonMistakes: [
                "Using a group JID. The current Cloud API sender is wired for direct recipients only.",
                "Choosing a recipient who has not messaged your business number in the last 24 hours.",
              ],
              canChangeLater: true,
            },
          ],
        },
        {
          id: "receive-messages",
          kind: "field-collection",
          // Receiving is optional and comes after the destination fields, so it keeps the stage it is written with.
          stage: "destinations_access",
          title: "Receive messages (optional)",
          body: [
            paragraph(
              "Skip this step if you only want to send. To receive, set both the app secret and the verify token. With only one of the two, WhatsApp stays send-only.",
            ),
            paragraph(
              "Receiving needs a public HTTPS address with a trusted certificate. GoatCitadel doesn't provide one.",
            ),
          ],
          fields: [
            {
              key: "appSecret",
              label: "App secret",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded:
                "Meta signs every message it sends you with your app secret. Without it GoatCitadel stays send-only, even if the verify token is set.",
              whereToFind: [
                paragraph("Copy the app secret from your Meta app in the App Dashboard. It is not the access token."),
              ],
              commonMistakes: ["Using the access token here instead of the app secret."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "appSecretEnv",
              label: "App secret env var",
              type: "text",
              required: false,
              advanced: true,
              explanation: "Name of the environment variable that holds your app secret.",
              whereToFind: [
                paragraph("Store the app secret in an env var such as WHATSAPP_APP_SECRET and give its name here."),
              ],
              looksLike: "WHATSAPP_APP_SECRET",
              commonMistakes: ["Using the access token here instead of the app secret."],
              canChangeLater: true,
              placeholder: "WHATSAPP_APP_SECRET",
            },
            {
              key: "appId",
              label: "App ID",
              type: "id",
              required: false,
              explanation: "The ID of your Meta app. It is a number, and it is not secret.",
              whyNeeded: "Optional. Chat › Messaging keeps it with this connection when you set WhatsApp up there.",
              whereToFind: [paragraph("Copy the App ID from your Meta app's Basic settings in the App Dashboard.")],
              looksLike: "123456789012345",
              commonMistakes: ["Pasting the app secret or the access token here. The App ID is digits only."],
              canChangeLater: true,
            },
            {
              key: "businessAccountId",
              label: "WhatsApp Business Account ID",
              type: "id",
              required: false,
              explanation: "The ID of the WhatsApp Business Account your phone number belongs to. It is a number.",
              whyNeeded: "Optional. Chat › Messaging keeps it with this connection when you set WhatsApp up there.",
              whereToFind: [
                paragraph(
                  "In Meta's App Dashboard open WhatsApp › API Setup and copy the WhatsApp Business Account ID.",
                ),
              ],
              looksLike: "123456789012345",
              commonMistakes: ["Using the Phone number ID. It is a different number."],
              canChangeLater: true,
            },
            {
              key: "webhookVerifyToken",
              label: "Webhook verify token",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded:
                "Meta sends this text when you register the webhook, and GoatCitadel checks it matches. Without it GoatCitadel stays send-only, even if the app secret is set.",
              whereToFind: [
                paragraph("Choose any random text yourself. Use the same text when you set up the webhook in Meta."),
                linkBlock(
                  "Meta: Webhooks getting started",
                  "https://developers.facebook.com/docs/graph-api/webhooks/getting-started",
                ),
              ],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "webhookVerifyTokenEnv",
              label: "Webhook verify-token env var",
              type: "text",
              required: false,
              advanced: true,
              explanation: "Name of the environment variable that holds your webhook verify token.",
              whereToFind: [
                paragraph(
                  "Store the text you chose in an env var such as WHATSAPP_WEBHOOK_VERIFY_TOKEN and give its name here.",
                ),
              ],
              looksLike: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
              canChangeLater: true,
              placeholder: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph(
              "First, from the recipient's phone, send any message to your business number. That opens WhatsApp's 24-hour window. Then run the live test. GoatCitadel's test is plain text, which WhatsApp only delivers inside that window.",
            ),
            paragraph(
              "The test checks your access token and phone number ID with WhatsApp, then sends one test message to your Default recipient. Check that it arrived on that phone.",
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "token-rejected",
              "WhatsApp rejected the access token",
              "The usual cause is the temporary token from the API Setup page, which expires quickly. Make a permanent System User token (Business Settings › Users › System users) with whatsapp_business_messaging, whatsapp_business_management and business_management, paste it, and run the test again. The System User also needs your WhatsApp account assigned to it.",
            ),
            troubleshoot(
              "phone-number-id",
              "WhatsApp couldn't find the phone number ID",
              "Copy the Phone number ID from WhatsApp › API Setup, under the From number. It is a long number, not the phone number people see in WhatsApp, and not the WhatsApp Business Account ID.",
            ),
            troubleshoot(
              "recipient-invalid",
              "It says the default recipient is missing or isn't a direct recipient",
              "Use one person's phone number with country code, such as +15551234567. Group IDs don't work with this sender.",
            ),
            troubleshoot(
              "no-message",
              "The test passed but nothing arrived, or WhatsApp refused the message",
              "WhatsApp delivers plain text only in the 24 hours after the recipient messaged your business number. From the recipient's phone, send any message to your business number, then run the test again. Also check that the phone you are looking at is the Default recipient.",
            ),
            troubleshoot(
              "host-not-allowed",
              "It says GoatCitadel can't reach graph.facebook.com yet",
              "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add graph.facebook.com, then run the test again.",
            ),
            troubleshoot(
              "variable-not-found",
              "It says the access token is missing, and you used an environment variable",
              "A variable's name must start with WHATSAPP_ (for example WHATSAPP_ACCESS_TOKEN), and you must restart GoatCitadel after you set it. Or paste the token instead.",
            ),
            troubleshoot(
              "no-reply",
              "You message the number and nothing comes back",
              "Check these in order. In Meta's App Dashboard, WhatsApp › Configuration must show this connection's webhook address, verified with your verify token, with messages subscribed. Here, both the app secret and the verify token must be set, and the verify token must match the one in Meta. Your number (digits only, no plus) must be listed under Who may message this bot. And this Gateway must be reachable at a public HTTPS address with a trusted certificate.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection so GoatCitadel can send from it. To receive messages, the webhook also has to be registered in Meta (the last step shows how).",
            ),
          ],
          successCriteria: [
            "WhatsApp accepted the access token and phone number ID.",
            "The test message arrived on the Default recipient's WhatsApp.",
            "To receive messages: the app secret and the verify token are both set.",
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
      const appId = readString(config, "appId");
      const businessAccountId = readString(config, "businessAccountId");
      const ownerActorIds = resolveChannelOwnerActorIds(config);
      return {
        draft: {
          accessTokenEnv: readString(config, "accessTokenEnv") ?? readString(config, "tokenEnv"),
          appSecretEnv: readString(config, "appSecretEnv") ?? readString(config, "webhookSecretEnv"),
          webhookVerifyTokenEnv: readString(config, "webhookVerifyTokenEnv") ?? readString(config, "verifyTokenEnv"),
          phoneNumberId: readString(config, "phoneNumberId"),
          defaultTarget: readString(config, "defaultTarget"),
          // Left out when the connection has none, as normalize leaves them out of the saved config.
          ...(appId ? { appId } : {}),
          ...(businessAccountId ? { businessAccountId } : {}),
          ...(ownerActorIds.length > 0 ? { ownerActorIds } : {}),
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
            appId: appId ? "configured" : "unknown",
            businessAccountId: businessAccountId ? "configured" : "unknown",
            ownerActorIds: ownerActorIds.length > 0 ? "configured" : "unknown",
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
      const ownerActorIds = resolveChannelOwnerActorIds(draft.draft);
      // appId, businessAccountId and ownerActorIds are left out when the draft has none, so finalize keeps the saved
      // connection's own values instead of overwriting them with nothing.
      return compactRecord({
        accessTokenEnv: readString(draft.draft, "accessTokenEnv") ?? preservedAccessTokenEnv,
        accessToken: readString(draft.draft, "accessToken") ?? preservedAccessToken,
        appSecretEnv: readString(draft.draft, "appSecretEnv") ?? preservedAppSecretEnv,
        appSecret: readString(draft.draft, "appSecret") ?? preservedAppSecret,
        webhookVerifyTokenEnv: readString(draft.draft, "webhookVerifyTokenEnv") ?? preservedVerifyTokenEnv,
        webhookVerifyToken: readString(draft.draft, "webhookVerifyToken") ?? preservedVerifyToken,
        phoneNumberId: readString(draft.draft, "phoneNumberId"),
        defaultTarget: readString(draft.draft, "defaultTarget"),
        appId: readString(draft.draft, "appId"),
        businessAccountId: readString(draft.draft, "businessAccountId"),
        ownerActorIds: ownerActorIds.length > 0 ? ownerActorIds : undefined,
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
          // The pasted field is where a person goes to fix this, not the expert variable name.
          fieldKey: "accessToken",
          level: "error",
          message: "Paste the WhatsApp access token.",
          failureCategory: "missing_input",
          nextSteps: [
            "Paste a permanent System User token from Meta (Business Settings › Users › System users), not the temporary one.",
          ],
        });
      }
      if (!phoneNumberId) {
        issues.push(requiredFieldIssue("phoneNumberId", "Phone number ID is required."));
      } else if (!NUMERIC_ID_PATTERN.test(phoneNumberId)) {
        issues.push(
          malformedFieldIssue("phoneNumberId", "Phone number ID should look like a numeric WhatsApp sender id."),
        );
      }
      if (!readString(draft.draft, "defaultTarget")) {
        issues.push(requiredFieldIssue("defaultTarget", "Default recipient is required."));
      }
      // Both IDs are optional. The messages name the Meta page to copy from and never repeat what was typed.
      const appId = readString(draft.draft, "appId");
      if (appId && !NUMERIC_ID_PATTERN.test(appId)) {
        issues.push(malformedFieldIssue("appId", "Use the App ID from your Meta app's Basic settings: digits only."));
      }
      const businessAccountId = readString(draft.draft, "businessAccountId");
      if (businessAccountId && !NUMERIC_ID_PATTERN.test(businessAccountId)) {
        issues.push(
          malformedFieldIssue("businessAccountId", "Use the WhatsApp Business Account ID from API Setup: digits only."),
        );
      }
      return issues;
    },
  };
}
