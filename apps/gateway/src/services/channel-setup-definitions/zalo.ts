import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
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
} from "./common.js";

export function createZaloDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.zalo");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "platform_api_resource_ids",
      contentVersion: "2026.08.zalo.v2",
      estimatedMinutes: 6,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary: "Send messages from a Zalo Official Account. Sends only: Zalo can't message GoatCitadel.",
      prerequisites: [
        "A Zalo Official Account access token.",
        "The Zalo user_id of someone who has messaged your Official Account in the last 7 days.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel sends text messages from your Zalo Official Account to one Zalo user: the default OA user ID.",
            ),
            note("warning", "This channel only sends. It can't receive replies."),
            paragraph("This channel sends text. Attachments aren't supported."),
            paragraph(
              "Zalo lets an Official Account message only people who interacted with it in the last 7 days, for example by messaging it. Before you start, send your Official Account a message from the recipient's Zalo.",
            ),
            note(
              "warning",
              "A Zalo access token lasts about 25 hours, and GoatCitadel doesn't renew it. When sending stops working, paste a new token in Edit setup.",
            ),
            note(
              "info",
              "GoatCitadel can reach Zalo only once openapi.zalo.me is in the hosts GoatCitadel may reach. The setup test has an Allow these hosts button for that.",
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
              // The steps are the ones on Zalo's own page for API Explorer (developers.zalo.me › Official Account API ›
              // Get started › Authenticate and authorize an app). The same page says an OA access token is valid for 25
              // hours (R58). Its refresh token is not used here: GoatCitadel doesn't refresh Zalo tokens, so none is promised.
              whereToFind: [
                paragraph(
                  "On developers.zalo.me open API Explorer. Choose your app, set the token type to OA Access Token, choose your Official Account, allow the permissions it asks for, and copy the access token. You need to be an admin of the Official Account or of the app.",
                ),
                paragraph(
                  "Your Zalo app needs permission to send messages and notifications through the Official Account.",
                ),
                paragraph(
                  "A Zalo access token lasts about 25 hours, and GoatCitadel doesn't renew it. When sending stops working, paste a new one in Edit setup.",
                ),
                linkBlock(
                  "Zalo docs: get an access token",
                  "https://developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new",
                ),
              ],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "accessTokenEnv",
              label: "Access token env var",
              type: "text",
              required: false,
              explanation: "Name of the env var that stores the Zalo access token.",
              looksLike: "ZALO_ACCESS_TOKEN",
              canChangeLater: true,
              placeholder: "ZALO_ACCESS_TOKEN",
            },
            {
              key: "defaultRecipientId",
              label: "Default OA user ID",
              type: "text",
              required: true,
              explanation: "The user_id of the Zalo user who should get messages.",
              // Zalo says the user_id comes from its user list and user details calls, and that the user list call needs
              // the permission to manage user information. It shows no such ID in a screen GoatCitadel can point at.
              whereToFind: [
                paragraph(
                  "This is the user_id Zalo's Official Account API gives for a person. Get it from the API's user list or user details call, with an access token that may manage user information. GoatCitadel can't look it up for you.",
                ),
                paragraph(
                  "The person must have interacted with your Official Account in the last 7 days, for example by messaging it. A user_id belongs to one Official Account, so use one from the Official Account your token is for.",
                ),
                paragraph("If you can't get this ID, this channel can't be finished."),
                linkBlock(
                  "Zalo docs: get the user list",
                  "https://developers.zalo.me/docs/official-account/quan-ly/quan-ly-thong-tin-nguoi-dung/truy-xuat-danh-sach-nguoi-dung",
                ),
              ],
              // The user_id in Zalo's own examples for the send and user-list calls.
              looksLike: "2512523625412515",
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
              'The test sends one message to your default OA user ID. It starts with "[GoatCitadel Zalo probe". The test doesn\'t delete it, so check that it arrived in their Zalo.',
            ),
            paragraph(
              "Zalo only lets an Official Account message people who interacted with it in the last 7 days. If Zalo refuses, send your Official Account a message from the recipient's Zalo and run the test again. Zalo may charge for a message sent more than 48 hours after the person last interacted.",
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "token-refused",
              "It says Zalo refused the access token",
              "The token may have expired, or it belongs to another app or Official Account. Get a new access token the same way as before, paste it again, and run the test again. If you used an environment variable, see the item about a missing token below.",
            ),
            troubleshoot(
              "cant-message-person",
              "It says Zalo won't let your Official Account message that person yet",
              "Zalo only lets an Official Account message people who interacted with it in the last 7 days, and not people who blocked it. Send your Official Account a message from the recipient's Zalo, then run the test again. A user_id belongs to one Official Account, so check that yours comes from the Official Account your token is for.",
            ),
            troubleshoot(
              "app-not-allowed",
              "It says your app can't send messages for this Official Account",
              "On developers.zalo.me check that your app has the permission to send messages and notifications through the Official Account, and that the Official Account has allowed the app. Then get a new access token and paste it again.",
            ),
            troubleshoot(
              "variable-not-found",
              "It says the Zalo access token is missing, and you used an environment variable",
              "A variable's name must start with ZALO_ (for example ZALO_ACCESS_TOKEN), and you must restart GoatCitadel after you set it. Or paste the access token instead.",
            ),
            troubleshoot(
              "cant-reach-zalo",
              "It says it couldn't reach Zalo",
              "Check that this computer is online and can reach openapi.zalo.me, then run the test again.",
            ),
            troubleshoot(
              "nothing-arrived",
              "The test passed but nothing arrived in Zalo",
              "Check that the Default OA user ID is the person you meant, for the Official Account your token is for, and that they haven't blocked your Official Account.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [paragraph("Finalize saves the outbound connection. Check the test message arrived.")],
          successCriteria: [
            "Zalo accepted the test message for your default OA user ID.",
            "The test message arrived in the recipient's Zalo.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.zalo.v1",
      secretFieldKeys: ["accessToken"],
    },
    validation: {
      validationVersion: "2026.04.zalo.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.zalo.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.zalo",
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
      officialDocsUrl:
        "https://developers.zalo.me/docs/api/official-account-api/thong-tin-chung-ve-official-account-api",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "medium",
      preferredPathLabel: "Official Account access token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["accessToken", "accessTokenEnv", "token", "tokenEnv"],
      ]);
      return {
        draft: {
          accessTokenEnv: readString(config, "accessTokenEnv") ?? readString(config, "tokenEnv"),
          defaultRecipientId: readString(config, "defaultRecipientId"),
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
            defaultRecipientId: readString(config, "defaultRecipientId") ? "configured" : "missing",
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
      return compactRecord({
        accessTokenEnv: readString(draft.draft, "accessTokenEnv") ?? preservedAccessTokenEnv,
        accessToken: readString(draft.draft, "accessToken") ?? preservedAccessToken,
        defaultRecipientId: readString(draft.draft, "defaultRecipientId"),
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
      if (!hasConfiguredToken) {
        issues.push({
          key: "zalo_auth_missing",
          fieldKey: "accessToken",
          level: "error",
          message: "Paste the Zalo access token.",
          failureCategory: "missing_input",
        });
      }
      if (!readString(draft.draft, "defaultRecipientId")) {
        issues.push(requiredFieldIssue("defaultRecipientId", "Default OA user ID is required."));
      }
      return issues;
    },
  };
}
