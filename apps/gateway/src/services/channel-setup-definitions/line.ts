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
  check,
  troubleshoot,
  readString,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
} from "./common.js";

export function createLineDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.line");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "bot_token_target",
      contentVersion: "2026.08.line.v2",
      estimatedMinutes: 6,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Send LINE messages from your LINE Official Account. Receiving needs a public HTTPS address. Every message is a push message, which counts toward your plan's monthly limit.",
      prerequisites: [
        "A LINE Official Account with the Messaging API on, and its long-lived channel access token.",
        "Your LINE user ID (Developers Console › your channel › Basic settings).",
        "To receive: a public HTTPS address and the channel secret.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel sends messages from your LINE Official Account through the Messaging API. LINE can send you messages only if it can reach your Gateway over public HTTPS. GoatCitadel doesn't provide that; without it this connection is send-only.",
            ),
            paragraph("This channel sends text. Attachments aren't supported."),
            paragraph(
              "Every message GoatCitadel sends is a push message. Push messages count toward your plan's monthly limit, and the free plan's limit depends on your country.",
            ),
            linkBlock("LINE: Messaging API pricing", "https://developers.line.biz/en/docs/messaging-api/pricing/"),
            note(
              "warning",
              "LINE is a guided beta lane. The setup test checks your channel access token live and will post a test message to your Default target.",
            ),
          ],
        },
        {
          id: "create-account",
          kind: "instruction",
          createOnly: true,
          title: "Create the LINE Official Account",
          body: [
            paragraph(
              "You can't create a Messaging API channel straight from the LINE Developers Console any more. It starts from an Official Account.",
            ),
            {
              kind: "list",
              ordered: true,
              items: [
                "In LINE Official Account Manager, create an Official Account.",
                "Open its settings › Messaging API and turn it on.",
                "In LINE Developers Console, open the channel's Messaging API tab and issue a long-lived channel access token.",
              ],
            },
            linkBlock(
              "LINE: Getting started with the Messaging API",
              "https://developers.line.biz/en/docs/messaging-api/getting-started/",
            ),
          ],
          checklist: [
            check("account", "Create a LINE Official Account"),
            check("messaging-api", "Turn on the Messaging API in its settings"),
            check("token", "Issue a long-lived channel access token"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "channelAccessToken",
              label: "Channel access token",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded: "Lets GoatCitadel send messages from your LINE Official Account.",
              whereToFind: [
                paragraph(
                  "Messaging API tab › Channel access token (long-lived). GoatCitadel can't renew short-lived tokens.",
                ),
                linkBlock(
                  "LINE: Channel access tokens",
                  "https://developers.line.biz/en/docs/basics/channel-access-token/",
                ),
              ],
              looksLike: "A long opaque token string.",
              commonMistakes: ["Using a short-lived channel access token. It expires and GoatCitadel can't renew it."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "channelAccessTokenEnv",
              label: "Channel access token env var",
              type: "text",
              required: false,
              advanced: true,
              explanation: "Name of the env var that stores the LINE channel access token.",
              looksLike: "LINE_CHANNEL_ACCESS_TOKEN",
              canChangeLater: true,
              placeholder: "LINE_CHANNEL_ACCESS_TOKEN",
            },
            {
              key: "defaultTarget",
              label: "Default target",
              type: "text",
              required: true,
              explanation: "The LINE user, room or group that gets the test message and any send that names no one.",
              whereToFind: [
                paragraph(
                  "For a one-to-one chat use your own user ID: LINE Developers Console › your channel › Basic settings › Your user ID (starts with U). Group and room IDs only appear in webhook events.",
                ),
                paragraph("If Your user ID isn't shown there, link your Business ID to your LINE account first."),
                linkBlock(
                  "LINE: Getting user IDs",
                  "https://developers.line.biz/en/docs/messaging-api/getting-user-ids/",
                ),
              ],
              looksLike: "userId, groupId, or roomId",
              commonMistakes: ["Using the channel ID or the channel secret instead of a user ID."],
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
              "Skip this step if you only want to send. To receive, set the channel secret: LINE signs every message it sends you with it.",
            ),
            paragraph(
              "Receiving also needs a public HTTPS address with a trusted certificate. GoatCitadel doesn't provide one.",
            ),
          ],
          fields: [
            {
              key: "channelSecret",
              label: "Channel secret",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded:
                "LINE signs every message it sends you with the channel secret. Without it GoatCitadel stays send-only.",
              whereToFind: [
                paragraph("LINE Developers Console › your channel › Basic settings tab › Channel secret."),
                linkBlock(
                  "LINE: Verifying signatures",
                  "https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/",
                ),
              ],
              commonMistakes: ["Using the channel access token here instead of the channel secret."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "channelSecretEnv",
              label: "Channel secret env var",
              type: "text",
              required: false,
              advanced: true,
              explanation: "Name of the environment variable that holds your channel secret.",
              looksLike: "LINE_CHANNEL_SECRET",
              canChangeLater: true,
              placeholder: "LINE_CHANNEL_SECRET",
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph(
              "The test checks your channel access token with LINE, then sends one test message to your Default target. Check that it arrived in LINE.",
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "token-rejected",
              "LINE rejected the channel access token",
              "Paste the long-lived channel access token from the channel's Messaging API tab. A short-lived token expires, and GoatCitadel can't renew it. If you issued a new token, paste the newest one.",
            ),
            troubleshoot(
              "target-rejected",
              "LINE couldn't send to the Default target",
              "Use your own user ID from Basic settings › Your user ID (it starts with U), not the channel ID. A group or room ID works only after the bot has joined that group, and it appears only in webhook events.",
            ),
            troubleshoot(
              "host-not-allowed",
              "It says GoatCitadel can't reach api.line.me yet",
              "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add api.line.me, then run the test again.",
            ),
            troubleshoot(
              "variable-not-found",
              "It says the channel access token is missing, and you used an environment variable",
              "A variable's name must start with LINE_ (for example LINE_CHANNEL_ACCESS_TOKEN), and you must restart GoatCitadel after you set it. Or paste the token instead.",
            ),
            troubleshoot(
              "no-reply",
              "You message the bot and nothing comes back",
              "Check these in order. In LINE Developers Console › Messaging API, the Webhook URL must be this connection's webhook address, Verify must show Success, and Use webhook must be on. In Official Account Manager, auto-reply and greeting messages must be off. The channel secret must be set here. Your LINE user ID must be listed under Who may message this bot. And this Gateway must be reachable at a public HTTPS address with a trusted certificate.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection so GoatCitadel can send from it. To receive messages, the webhook also has to be set up in LINE (the last step shows how).",
            ),
          ],
          successCriteria: [
            "LINE accepted the channel access token.",
            "The test message arrived at the Default target.",
            "To receive messages: the channel secret is set.",
          ],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.line.v1",
      secretFieldKeys: ["channelAccessToken", "channelSecret"],
    },
    validation: {
      validationVersion: "2026.04.line.v1",
      levels: ["structural", "semantic", "live-auth"],
    },
    testing: {
      testVersion: "2026.04.line.v1",
      levels: ["structural", "semantic", "live-auth", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: COMMON_FAILURES.token ?? [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.line",
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
      officialDocsUrl: "https://developers.line.biz/en/docs/messaging-api/",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Channel access token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["channelAccessToken", "channelAccessTokenEnv", "accessToken", "accessTokenEnv", "token", "tokenEnv"],
        ["channelSecret", "channelSecretEnv", "secret", "secretEnv"],
      ]);
      return {
        draft: {
          channelAccessTokenEnv:
            readString(config, "channelAccessTokenEnv") ??
            readString(config, "accessTokenEnv") ??
            readString(config, "tokenEnv"),
          channelSecretEnv: readString(config, "channelSecretEnv") ?? readString(config, "secretEnv"),
          defaultTarget: readString(config, "defaultTarget"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            channelAccessToken:
              readString(config, "channelAccessToken") ||
              readString(config, "channelAccessTokenEnv") ||
              readString(config, "accessToken") ||
              readString(config, "accessTokenEnv") ||
              readString(config, "token") ||
              readString(config, "tokenEnv")
                ? "configured"
                : "missing",
            channelAccessTokenEnv:
              readString(config, "channelAccessTokenEnv") ||
              readString(config, "accessTokenEnv") ||
              readString(config, "tokenEnv")
                ? "configured"
                : "unknown",
            channelSecret:
              readString(config, "channelSecret") ||
              readString(config, "channelSecretEnv") ||
              readString(config, "secret") ||
              readString(config, "secretEnv")
                ? "configured"
                : "unknown",
            channelSecretEnv:
              readString(config, "channelSecretEnv") || readString(config, "secretEnv") ? "configured" : "unknown",
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
      const preservedToken = readLegacyString(draft, "channelAccessToken", "accessToken", "token");
      const preservedTokenEnv = readLegacyString(draft, "channelAccessTokenEnv", "accessTokenEnv", "tokenEnv");
      const preservedChannelSecret = readLegacyString(draft, "channelSecret", "secret");
      const preservedChannelSecretEnv = readLegacyString(draft, "channelSecretEnv", "secretEnv");
      return compactRecord({
        channelAccessTokenEnv: readString(draft.draft, "channelAccessTokenEnv") ?? preservedTokenEnv,
        channelAccessToken: readString(draft.draft, "channelAccessToken") ?? preservedToken,
        channelSecretEnv: readString(draft.draft, "channelSecretEnv") ?? preservedChannelSecretEnv,
        channelSecret: readString(draft.draft, "channelSecret") ?? preservedChannelSecret,
        defaultTarget: readString(draft.draft, "defaultTarget"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "channelAccessToken") ||
        readString(draft.draft, "channelAccessTokenEnv") ||
        draft.hydration?.fieldState.channelAccessToken === "configured" ||
        draft.hydration?.fieldState.channelAccessTokenEnv === "configured",
      );
      if (!hasConfiguredToken) {
        issues.push({
          key: "line_auth_missing",
          // The pasted field is where a person goes to fix this, not the expert variable name.
          fieldKey: "channelAccessToken",
          level: "error",
          message: "Paste the LINE channel access token.",
          failureCategory: "missing_input",
          nextSteps: ["Paste the long-lived channel access token from the channel's Messaging API tab."],
        });
      }
      if (!readString(draft.draft, "defaultTarget")) {
        issues.push(requiredFieldIssue("defaultTarget", "Default target is required."));
      }
      return issues;
    },
  };
}
