import type { ChannelSetupDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import { isExplicitTrue as isTruthyFlag } from "@goatcitadel/gateway-core";
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
  looksLikeHttpUrl,
  hasAnyConfiguredSecret,
  compactRecord,
  readLegacyString,
  requiredFieldIssue,
  malformedFieldIssue,
  requireSecureUrl,
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
        "Send and receive Matrix messages through a bot account on your homeserver. No public web address is needed: GoatCitadel connects out, and only hears messages while it's running.",
      prerequisites: [
        "A Matrix account for the bot and its access token.",
        "The bot invited to and joined in a room with encryption off. GoatCitadel can't read encrypted rooms and doesn't accept invites.",
        "Your homeserver in the hosts GoatCitadel may reach.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel signs in to your Matrix homeserver as a bot account. It can send text, replies, reactions and message removals, and show typing.",
            ),
            paragraph(
              "Receiving is optional and off by default. When it is on, GoatCitadel connects out to your homeserver and listens for new messages in rooms the bot has joined, so no public web address is needed. It only hears messages while it's running. If the homeserver rejects the saved sync position, GoatCitadel starts a fresh sync and the messages in between are skipped. Only Matrix IDs you allow (for example @alice:example.com) can start conversations.",
            ),
            paragraph("This channel sends text. Attachments aren't supported."),
            note(
              "warning",
              "Matrix is a guided beta lane. GoatCitadel can't read encrypted rooms and sends unencrypted messages, so use a room with encryption off. It can reach your homeserver only once the homeserver is in the hosts GoatCitadel may reach: the setup test has an Allow these hosts button for that.",
            ),
          ],
        },
        {
          id: "create-bot",
          kind: "instruction",
          createOnly: true,
          title: "Make the bot account and a room for it",
          body: [
            paragraph(
              "GoatCitadel signs in as a bot account, so make one first. The menus here are Element's; other Matrix apps differ.",
            ),
            paragraph(
              "Steps 3 and 4 are only for a room. You can skip them and leave Default room ID empty, but the bot can post only in rooms it has joined.",
            ),
            {
              kind: "list",
              ordered: true,
              items: [
                "Create a Matrix account for the bot and sign in as the bot.",
                "Copy the bot's access token. In Element it is under Settings › Help & About, as Your Access Token. Signing that session out makes the token stop working, and GoatCitadel doesn't renew tokens.",
                "From your own account, create a new room with encryption off and invite the bot into it. GoatCitadel can't read encrypted rooms. Element encrypts a new private room unless you turn that off when you create it.",
                "Sign in as the bot in a Matrix app and accept the invite. GoatCitadel doesn't accept invites for you.",
              ],
            },
            linkBlock("Matrix: Client-Server API (login)", "https://spec.matrix.org/latest/client-server-api/"),
            linkBlock("Element: Help & About", "https://ems-docs.element.io/books/element-support/page/help-about"),
            linkBlock(
              "Element: encryption defaults",
              "https://github.com/element-hq/element-web/blob/develop/docs/e2ee.md",
            ),
          ],
          // Only what every setup needs. The room steps are list items above: a send-only setup with no room is supported,
          // and each box here blocks Continue.
          checklist: [check("account", "Create the bot's Matrix account and copy its access token")],
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
              explanation:
                "The address of your homeserver's client API. Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
              whereToFind: [
                paragraph(
                  "Your server's admin can tell you. Matrix apps find it in the server's /.well-known/matrix/client file (m.homeserver › base_url), and it can differ from the part of your Matrix ID after the colon.",
                ),
                linkBlock("Matrix: Server discovery", "https://spec.matrix.org/latest/client-server-api/"),
              ],
              looksLike: "https://matrix.example.com",
              canChangeLater: true,
            },
            {
              key: "accessToken",
              label: "Access token",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded: "Lets GoatCitadel send as the bot account.",
              whereToFind: [
                paragraph(
                  "Sign in as the bot. In Element it is under Settings › Help & About, as Your Access Token. Signing that session out makes the token stop working.",
                ),
                linkBlock("Element: Help & About", "https://ems-docs.element.io/books/element-support/page/help-about"),
              ],
              commonMistakes: ["Copying the token, then signing that session out. A signed-out token stops working."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "accessTokenEnv",
              label: "Access token env var",
              type: "text",
              required: false,
              advanced: true,
              explanation: "Name of the env var that stores the bot's Matrix access token.",
              looksLike: "MATRIX_ACCESS_TOKEN",
              canChangeLater: true,
              placeholder: "MATRIX_ACCESS_TOKEN",
            },
            {
              key: "defaultRoomId",
              label: "Default room ID",
              type: "text",
              required: false,
              explanation:
                "The room that gets the test notice and any send that names no room. Leave it empty to skip the test notice.",
              whereToFind: [
                paragraph("In Element, open the room's settings › Advanced › Internal Room ID."),
                linkBlock(
                  "Element: Room settings",
                  "https://ems-docs.element.io/books/element-support/page/managing-a-room-room-settings",
                ),
              ],
              looksLike: "!roomid:example.com",
              commonMistakes: ["Using the room's name or #alias:example.com. GoatCitadel needs the internal room ID."],
              canChangeLater: true,
            },
            {
              key: "inboundStreamEnabled",
              label: "Receive messages",
              type: "boolean",
              required: false,
              defaultValue: false,
              explanation:
                "Listen for messages in rooms the bot has joined, so people can start conversations with it.",
              whyNeeded:
                "GoatCitadel connects out to your homeserver to hear new messages, so no public web address is needed. Receiving stays off unless you turn it on, and only allowed Matrix IDs can start conversations.",
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
              "The test checks the access token with your homeserver. If you set a Default room ID, it also checks that the bot has joined that room and posts a test notice there: check that the notice arrived in that room. If you left Default room ID empty, the test sends nothing.",
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "token-rejected",
              "The homeserver rejected the access token",
              "Sign in as the bot and copy its access token again. A token stops working when its session is signed out, and GoatCitadel can't renew it. If you made a new one, paste the newest.",
            ),
            troubleshoot(
              "not-joined",
              "It says the bot hasn't joined the room",
              "Invite the bot from your own account, then sign in as the bot in a Matrix app and accept the invite. GoatCitadel doesn't accept invites for you. Then run the test again.",
            ),
            troubleshoot(
              "room-rejected",
              "The homeserver refused the test notice",
              "Check the Default room ID. Use the room's internal ID, not its name or an alias (in Element: Room settings › Advanced › Internal Room ID). The bot must have joined the room and be allowed to post in it.",
            ),
            troubleshoot(
              "host-not-allowed",
              "It says GoatCitadel can't reach your homeserver yet",
              "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add your homeserver, then run the test again.",
            ),
            troubleshoot(
              "variable-not-found",
              "It says the access token is missing, and you used an environment variable",
              "A variable's name must start with MATRIX_ (for example MATRIX_ACCESS_TOKEN), and you must restart GoatCitadel after you set it. Or paste the token instead.",
            ),
            troubleshoot(
              "no-reply",
              "You post in the room and nothing comes back",
              "Check these in order. Receive messages must be on. Your Matrix ID, with the @ and the server (for example @alice:example.com), must be listed under Who may message this bot. The room must have encryption off, because GoatCitadel can't read encrypted rooms. The bot must have joined the room, not just been invited. And GoatCitadel must be running: it only hears messages while it's running.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection so GoatCitadel can send from it. To receive messages, turn on Receive messages and allow your Matrix ID (the last step shows how).",
            ),
          ],
          successCriteria: [
            "The homeserver accepted the access token.",
            "The bot has joined the Default room, or you chose to supply the room per send.",
            "The test notice arrived in the room, or you set no Default room ID.",
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
      } else {
        // Plain http is refused the same way the live test refuses it. That rule lets "ftp://localhost" through, so the
        // scheme is checked here too.
        const insecure = requireSecureUrl(homeserverUrl, "homeserverUrl", "Homeserver URL");
        if (insecure) {
          issues.push(insecure);
        } else if (!looksLikeHttpUrl(homeserverUrl)) {
          issues.push(malformedFieldIssue("homeserverUrl", "Homeserver URL should start with https://."));
        }
      }
      if (!hasConfiguredToken) {
        issues.push({
          key: "matrix_auth_missing",
          // The pasted field is where a person goes to fix this, not the expert variable name.
          fieldKey: "accessToken",
          level: "error",
          message: "Paste the Matrix access token.",
          failureCategory: "missing_input",
          nextSteps: ["Sign in as the bot and copy its access token."],
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
