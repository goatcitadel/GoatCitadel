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

/**
 * The occ commands that install the bot again with a webhook address, for receiving. They are shown on "Add the bot to
 * Nextcloud Talk" (setup only) and again on the finish step, which an edit still shows.
 */
const RECEIVE_REINSTALL_COMMANDS = [
  "occ talk:bot:list",
  "occ talk:bot:uninstall <bot-id>",
  'occ talk:bot:install --feature webhook --feature response "GoatCitadel" "<secret>" "<webhook address>"',
  "occ talk:bot:list",
  "occ talk:bot:setup <new-bot-id> <room-token>",
].join("\n");

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
            paragraph("Sending is all a send-only setup needs:"),
            {
              kind: "list",
              ordered: true,
              items: [
                "Create the bot with occ talk:bot:create and give it a name. It gets the response feature only, so it can post messages and reactions, and it takes no webhook address. Talk sends room messages to a webhook address only for a bot with the webhook feature.",
                "Copy the bot's secret. occ prints a random one unless you give your own with --secret. It must be 40 to 128 characters, and GoatCitadel needs the same secret.",
                "Turn the bot on for the conversation with occ talk:bot:setup. Give it the bot's ID (occ talk:bot:list lists your bots) and the conversation's room token.",
              ],
            },
            {
              kind: "code",
              language: "shell",
              code: ['occ talk:bot:create "GoatCitadel"', "occ talk:bot:setup <bot-id> <room-token>"].join("\n"),
            },
            paragraph(
              "Receiving (optional), after you finish. No occ command changes a bot's webhook address, so to receive you install the bot again with this connection's address. GoatCitadel shows it after you finish: Settings › Channels › this connection.",
            ),
            note(
              "warning",
              "Talk sends every message posted in the conversation to the webhook address of a bot that has the webhook feature. Use only an address you control.",
            ),
            {
              kind: "list",
              ordered: true,
              items: [
                "Copy this connection's webhook address.",
                "Find the bot's ID with occ talk:bot:list, then uninstall the bot with occ talk:bot:uninstall and that ID.",
                "Install the bot again with occ talk:bot:install: the same name and secret, this connection's webhook address, and the features webhook and response.",
                "Look up the bot's ID again with occ talk:bot:list. A bot you install again can have a new ID, and occ talk:bot:setup must use the current one.",
                "Turn it on for the conversation again with occ talk:bot:setup, giving it that ID and the room token.",
              ],
            },
            { kind: "code", language: "shell", code: RECEIVE_REINSTALL_COMMANDS },
            linkBlock("Nextcloud Talk: occ commands", "https://nextcloud-talk.readthedocs.io/en/latest/occ/"),
            linkBlock("Nextcloud Talk: bots", "https://nextcloud-talk.readthedocs.io/en/latest/bots/"),
          ],
          // Only what every setup needs. Installing the bot again with a webhook address is for receiving, after you
          // finish: it is a list above, not a box, because each box here blocks Continue.
          checklist: [
            check("create", "Create the bot with the response feature"),
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
                  "It is the secret occ talk:bot:create printed, or the one you gave it with --secret. If you no longer have it, find the bot's ID with occ talk:bot:list, uninstall the bot with occ talk:bot:uninstall and that ID, and set it up again:",
                ),
                {
                  kind: "list",
                  items: [
                    "To send only: create it again with occ talk:bot:create, then find its ID with occ talk:bot:list (a bot you create again can have a new ID) and turn it on for the conversation with occ talk:bot:setup.",
                    "To receive: install it again with occ talk:bot:install, this connection's webhook address and the features webhook and response, then find its ID with occ talk:bot:list (a reinstalled bot can have a new ID) and turn it on for the conversation with occ talk:bot:setup.",
                  ],
                },
              ],
              commonMistakes: [
                "A secret shorter than 40 characters. occ requires 40 to 128.",
                "A different secret from the one the bot has.",
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
                  "This is the room token you give occ talk:bot:setup. Talk's own API calls it the conversation's token, and its list of your conversations gives one for each. This command asks for that list; each conversation in the answer has a token:",
                ),
                {
                  kind: "code",
                  language: "shell",
                  code: 'curl -u <user> -H "OCS-APIRequest: true" -H "Accept: application/json" "<Base URL>/ocs/v2.php/apps/spreed/api/v4/room"',
                },
                paragraph(
                  "Use your Nextcloud user name. curl asks for the password, so it isn't typed on the command line. Use a device-specific password, not your login password: create one under Personal settings › Security.",
                ),
                linkBlock(
                  "Nextcloud Talk: conversations",
                  "https://nextcloud-talk.readthedocs.io/en/latest/conversation/",
                ),
                linkBlock(
                  "Nextcloud: OCS API",
                  "https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/ocs-api-overview.html",
                ),
                linkBlock(
                  "Nextcloud: device-specific passwords",
                  "https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html",
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
              "Check these in order. The bot must have the response feature, or it can't post: a bot made with occ talk:bot:create has it. It must be turned on for this conversation with occ talk:bot:setup (occ talk:bot:list with the room token lists the bots for that conversation). The Room token must be the conversation's token, not its name. And the secret here must be the one the bot has.",
            ),
            troubleshoot(
              "secret-short",
              "occ says the secret is too short",
              "A bot secret must be 40 to 128 characters. Create the bot again with a longer one, or leave --secret out and let occ make one, and paste the same secret here.",
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
              "Check these in order. A bot made with occ talk:bot:create hears nothing: it has the response feature only. The bot must be installed with this connection's webhook address and the same secret, with the webhook feature, and turned on for the room again after any reinstall: find its ID with occ talk:bot:list, because a reinstalled bot can have a new ID, and use it with occ talk:bot:setup. Your Nextcloud server must be able to reach that address over HTTPS. Your user name must be listed as users/ followed by the name (for example users/alice) under Who may message this bot. And GoatCitadel must be running.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection so GoatCitadel can send from it. To receive messages, install the bot again with this connection's webhook address and the same secret. Talk sends every message posted in the conversation to that address, so use only an address you control.",
            ),
            // The setup-only step that first lists these is hidden when a saved channel is edited, so they are here too.
            paragraph(
              "Run these on your Nextcloud server, with your own values in place of the <…> parts. GoatCitadel shows this connection's webhook address in Settings › Channels › this connection.",
            ),
            { kind: "code", language: "shell", code: RECEIVE_REINSTALL_COMMANDS },
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
          nextSteps: ["Use the secret occ talk:bot:create printed, or the one you gave it with --secret."],
        });
      }
      if (!readString(draft.draft, "defaultRoomId")) {
        issues.push(requiredFieldIssue("defaultRoomId", "Room token is required."));
      }
      return issues;
    },
  };
}
