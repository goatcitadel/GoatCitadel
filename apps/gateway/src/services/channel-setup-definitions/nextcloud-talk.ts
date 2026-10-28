import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";
import {
  PASTED_SECRET_EXPLANATION,
  requireCatalog,
  baseCatalogMeta,
  paragraph,
  note,
  linkBlock,
  check,
  troubleshoot,
  readString,
  looksLikeHttpUrl,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
  requireSecureUrl,
} from "./common.js";

export function createNextcloudTalkDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.nextcloud-talk");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "workspace_server_token",
      contentVersion: "2026.08.nextcloud-talk.v2",
      estimatedMinutes: 8,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Send Nextcloud Talk messages through a Talk bot. Receiving needs an HTTPS address your Nextcloud server can reach.",
      prerequisites: [
        "Shell access to your Nextcloud server, to add a bot with occ.",
        "A bot secret of 40 to 128 characters.",
        "The room token of the conversation the bot should use.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel sends text and reactions to a Nextcloud Talk conversation as a bot, and can hear messages from it through signed webhooks.",
            ),
            paragraph(
              "Sending works without a public address. Receiving needs an HTTPS address your Nextcloud server can reach.",
            ),
            paragraph(
              "Receiving is optional. Only people you allow (written users/ followed by their user name, for example users/alice) can start conversations.",
            ),
            paragraph("This channel sends text. Attachments aren't supported."),
            note(
              "info",
              "GoatCitadel can reach your Nextcloud server only once the server is in the hosts GoatCitadel may reach: the setup test has an Allow these hosts button for that.",
            ),
          ],
        },
        {
          id: "install-bot",
          kind: "instruction",
          createOnly: true,
          title: "Add the bot to Nextcloud Talk",
          body: [
            paragraph(
              "GoatCitadel posts to Talk as a bot. Talk only lets you add a bot from the command line, so you need shell access to your Nextcloud server. Run occ the way you usually do there.",
            ),
            {
              kind: "list",
              ordered: true,
              items: [
                "Make up a secret of 40 to 128 characters and keep it. GoatCitadel needs the same secret.",
                "Install the bot with occ talk:bot:install. Give it a name, the secret, a webhook address, and the features webhook and response. Without the response feature the bot can't post.",
                "For now, use any web address as the webhook address. You only need the real one to receive messages (see below).",
                "Turn the bot on for the conversation with occ talk:bot:setup. Give it the bot's ID (occ talk:bot:list lists your bots) and the conversation's room token.",
              ],
            },
            {
              kind: "code",
              language: "shell",
              code: [
                'occ talk:bot:install --feature webhook --feature response "GoatCitadel" "<secret>" "<webhook address>"',
                "occ talk:bot:setup <bot-id> <room-token>",
              ].join("\n"),
            },
            paragraph(
              "Sending: install the bot with a placeholder address, turn it on for the room, test, and finish.",
            ),
            paragraph(
              "Receiving (optional), after you finish: Talk fixes a bot's webhook address when the bot is installed, and occ has no command to change it. So copy this connection's webhook address (you get it after you finish: Settings › Channels › this connection), uninstall the bot with occ talk:bot:uninstall, install it again with that address and the same secret, then turn it on for the room again.",
            ),
            linkBlock("Nextcloud Talk: occ commands", "https://nextcloud-talk.readthedocs.io/en/latest/occ/"),
            linkBlock("Nextcloud Talk: bots", "https://nextcloud-talk.readthedocs.io/en/latest/bots/"),
          ],
          // Only what every setup needs. Reinstalling the bot with a webhook address is for receiving, after you finish:
          // it is a paragraph above, not a box, because each box here blocks Continue.
          checklist: [
            check("install", "Install the bot with the webhook and response features"),
            check("setup-room", "Turn the bot on for the conversation"),
          ],
        },
        {
          id: "collect-values",
          kind: "field-collection",
          title: "Paste your connection values",
          fields: [
            {
              key: "baseUrl",
              label: "Base URL",
              type: "url",
              required: true,
              explanation:
                "The address of your Nextcloud server. Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
              looksLike: "https://cloud.example.com",
              canChangeLater: true,
            },
            {
              key: "token",
              label: "Bot secret",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded: "GoatCitadel signs what it sends to Talk with it, and checks what Talk sends back with it.",
              whereToFind: [
                paragraph(
                  "It is the secret you gave occ talk:bot:install. If you no longer have it, uninstall the bot and install it again with a new secret.",
                ),
              ],
              commonMistakes: [
                "A secret shorter than 40 characters. occ requires 40 to 128.",
                "A different secret from the one the bot was installed with.",
              ],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "tokenEnv",
              label: "Token env var",
              type: "text",
              required: false,
              explanation: "Name of the env var that stores the bot secret.",
              looksLike: "NEXTCLOUD_TALK_TOKEN",
              canChangeLater: true,
              placeholder: "NEXTCLOUD_TALK_TOKEN",
            },
            {
              key: "defaultRoomId",
              label: "Room token",
              type: "text",
              required: true,
              explanation:
                "The token Talk gives the conversation. The test message and any send that names no room go to this conversation.",
              whereToFind: [
                paragraph(
                  "This is the room token you give occ talk:bot:setup. Talk's own API calls it the conversation's token. If you can't see it in your Talk app, ask your Nextcloud admin.",
                ),
                linkBlock(
                  "Nextcloud Talk: conversations",
                  "https://nextcloud-talk.readthedocs.io/en/latest/conversation/",
                ),
              ],
              looksLike: "a1b2c3d4",
              commonMistakes: ["Using the conversation's name instead of its token."],
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
              "The test signs one message with your bot secret and posts it into the room as the bot: check that \"GoatCitadel channel setup verification.\" arrived in the conversation. The test doesn't delete it. It can't check receiving, because it only sends.",
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "bot-rejected",
              "It says Nextcloud Talk rejected the signed room send",
              "Check these in order. The bot must be installed with both the webhook and response features: without response it can't post. It must be turned on for this conversation with occ talk:bot:setup (occ talk:bot:list followed by the room token lists the bots set up for it). The Room token must be the conversation's token, not its name. And the secret here must be the one the bot was installed with.",
            ),
            troubleshoot(
              "secret-short",
              "occ says the secret is too short",
              "A bot secret must be 40 to 128 characters. Make a longer one, install the bot again with it, and paste the same secret here.",
            ),
            troubleshoot(
              "host-not-allowed",
              "It says GoatCitadel can't reach your Nextcloud server yet",
              "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add your Nextcloud server, then run the test again.",
            ),
            troubleshoot(
              "variable-not-found",
              "It says the bot secret is missing, and you used an environment variable",
              "A variable's name must start with NEXTCLOUD_TALK_ and end in _TOKEN or _SECRET (for example NEXTCLOUD_TALK_TOKEN), and you must restart GoatCitadel after you set it. Or paste the secret instead.",
            ),
            troubleshoot(
              "send-uncertain",
              "It says the send outcome is uncertain",
              "Open the conversation and see whether the test message arrived before you run the test again. If it didn't, check that your Nextcloud server is up and that GoatCitadel can reach it.",
            ),
            troubleshoot(
              "no-reply",
              "You message the bot and nothing comes back",
              "Check these in order. The bot must be installed with this connection's webhook address and the same secret, with the webhook feature, and turned on for the room again after any reinstall. Your Nextcloud server must be able to reach that address over HTTPS. Your user name must be listed as users/ followed by the name (for example users/alice) under Who may message this bot. And GoatCitadel must be running.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection so GoatCitadel can send from it. To receive messages, install the bot again with this connection's webhook address and the same secret (the last step shows how).",
            ),
          ],
          successCriteria: ["Nextcloud accepted the signed test message.", "The test message arrived in the room."],
        },
      ],
    },
    adapter: {
      adapterVersion: "2026.04.nextcloud-talk.v1",
      secretFieldKeys: ["token"],
    },
    validation: {
      validationVersion: "2026.04.nextcloud-talk.v1",
      levels: ["structural", "semantic"],
    },
    testing: {
      testVersion: "2026.04.nextcloud-talk.v1",
      levels: ["structural", "semantic", "live-send", "manual-confirm"],
      safePreFinalize: true,
      supportsManualConfirmation: true,
    },
    troubleshooting: {
      commonFailures: [],
    },
    telemetry: {
      tier: "tier_2",
      namespace: "channel_setup.nextcloud_talk",
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
      officialDocsUrl: "https://nextcloud-talk.readthedocs.io/en/latest/bots/",
      lastReviewedAt: "2026-04-01",
      volatility: "medium",
      deprecationRisk: "low",
      preferredPathLabel: "Base URL + Talk token",
    },
  };

  return {
    definition,
    hydrate(connection) {
      const config = connection.config;
      const hasConfiguredSecret = hasAnyConfiguredSecret(config, [
        ["token", "tokenEnv", "botSecret", "botSecretEnv", "secret", "secretEnv"],
      ]);
      return {
        draft: {
          baseUrl: readString(config, "baseUrl"),
          tokenEnv:
            readString(config, "tokenEnv") ?? readString(config, "botSecretEnv") ?? readString(config, "secretEnv"),
          defaultRoomId: readString(config, "defaultRoomId"),
        },
        hydration: {
          status: hasConfiguredSecret ? "opaque-secret" : "clean",
          fieldState: {
            baseUrl: readString(config, "baseUrl") ? "configured" : "missing",
            token:
              readString(config, "token") ||
              readString(config, "tokenEnv") ||
              readString(config, "botSecret") ||
              readString(config, "botSecretEnv") ||
              readString(config, "secret") ||
              readString(config, "secretEnv")
                ? "configured"
                : "missing",
            tokenEnv:
              readString(config, "tokenEnv") || readString(config, "botSecretEnv") || readString(config, "secretEnv")
                ? "configured"
                : "unknown",
            defaultRoomId: readString(config, "defaultRoomId") ? "configured" : "missing",
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
      const preservedToken = readLegacyString(draft, "token", "botSecret", "secret");
      const preservedTokenEnv = readLegacyString(draft, "tokenEnv", "botSecretEnv", "secretEnv");
      return compactRecord({
        baseUrl: readString(draft.draft, "baseUrl"),
        tokenEnv: readString(draft.draft, "tokenEnv") ?? preservedTokenEnv,
        token: readString(draft.draft, "token") ?? preservedToken,
        defaultRoomId: readString(draft.draft, "defaultRoomId"),
      });
    },
    validate(draft) {
      const issues: ChannelSetupIssue[] = [];
      const baseUrl = readString(draft.draft, "baseUrl");
      const hasConfiguredToken = Boolean(
        readString(draft.draft, "token") ||
        readString(draft.draft, "tokenEnv") ||
        draft.hydration?.fieldState.token === "configured" ||
        draft.hydration?.fieldState.tokenEnv === "configured",
      );
      if (!baseUrl) {
        issues.push(requiredFieldIssue("baseUrl", "Base URL is required."));
      } else {
        // Plain http is refused the same way the live test refuses it. That rule lets "ftp://localhost" through, so the
        // scheme is checked here too.
        const insecure = requireSecureUrl(baseUrl, "baseUrl", "Base URL");
        if (insecure) {
          issues.push(insecure);
        } else if (!looksLikeHttpUrl(baseUrl)) {
          issues.push(malformedFieldIssue("baseUrl", "Base URL should start with https://."));
        }
      }
      if (!hasConfiguredToken) {
        issues.push({
          key: "nextcloud_talk_auth_missing",
          // The pasted field is where a person goes to fix this, not the expert variable name.
          fieldKey: "token",
          level: "error",
          message: "Paste the Nextcloud Talk bot secret.",
          failureCategory: "missing_input",
          nextSteps: ["Use the secret you gave occ talk:bot:install."],
        });
      }
      if (!readString(draft.draft, "defaultRoomId")) {
        issues.push(requiredFieldIssue("defaultRoomId", "Room token is required."));
      }
      return issues;
    },
  };
}
