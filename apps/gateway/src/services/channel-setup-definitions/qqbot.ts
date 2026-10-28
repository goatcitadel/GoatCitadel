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
  troubleshoot,
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
      estimatedMinutes: 25,
      difficulty: "advanced",
      manualModePolicy: "available-secondary",
      introSummary:
        "Send and receive QQ messages through a QQ Bot Open Platform app. Receiving needs a public HTTPS address on port 443, 8443, 80 or 8080.",
      prerequisites: [
        "The QQ Bot app's AppID and AppSecret.",
        "A public HTTPS address for this Gateway (a reverse proxy or tunnel); GoatCitadel doesn't provide one.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel gets an access token from your QQ app's AppID and AppSecret and sends text to QQ groups, one-to-one chats, guild channels and guild direct messages. QQ sends messages back to a webhook address, and GoatCitadel checks QQ's signature on each one before it accepts it.",
            ),
            paragraph(
              "QQ delivers messages only to a public HTTPS address on port 443, 8443, 80 or 8080 that you provide (a reverse proxy or tunnel to this Gateway, which listens on port 8787 by default). GoatCitadel runs no relay. Without one this connection can only send, and QQ limits unprompted messages.",
            ),
            paragraph(
              "GoatCitadel hears four kinds of message: group @-mentions (GROUP_AT_MESSAGE_CREATE), one-to-one messages (C2C_MESSAGE_CREATE), guild channel @-mentions (AT_MESSAGE_CREATE) and guild direct messages (DIRECT_MESSAGE_CREATE). In a group it hears only messages that @-mention the bot.",
            ),
            paragraph(
              "Receiving is default-deny: only the openids you allow can start conversations. An openid is the id QQ gives each sender for your app, not a QQ number. A group member's openid and a one-to-one user's openid are different, so allow each one you need.",
            ),
            paragraph(
              "Don't know your openid? Finish setup, then message the bot once. It won't answer, and System › Diagnostics lists \"Dropped a QQBot message from …\" with your openid in it. If you already know your openid, add it under Who may message this bot.",
            ),
            paragraph("This channel sends text. Attachments aren't supported."),
            note(
              "info",
              "GoatCitadel can reach QQ only once these hosts are in the hosts GoatCitadel may reach: bots.qq.com and api.bot.qq.com, plus sandbox.api.sgroup.qq.com in Test mode. The setup test has an Allow these hosts button for that.",
            ),
            note("warning", "QQ Bot is a beta channel. Reactions and unsend aren't supported."),
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
              explanation: "The AppID of your QQ Bot Open Platform app.",
              whereToFind: [
                paragraph(
                  "QQ issues the AppID and AppSecret when you create the bot on the QQ Open Platform (q.qq.com). Sign in there and open your bot's management page.",
                ),
                linkBlock("QQ Bot docs: getting started", "https://bot.q.qq.com/wiki/develop/api-v2/"),
              ],
              looksLike: "102000000",
              canChangeLater: true,
            },
            {
              key: "sandbox",
              label: "Test mode (sandbox)",
              type: "boolean",
              required: false,
              defaultValue: false,
              explanation:
                "Send through QQ's sandbox host, sandbox.api.sgroup.qq.com, instead of the live one. QQ's FAQ says features that aren't published yet can be tried in the sandbox.",
              whereToFind: [linkBlock("QQ FAQ: the sandbox", "https://q.qq.com/wiki/FAQ/robot/")],
              canChangeLater: true,
            },
            {
              key: "appSecret",
              label: "App secret",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whereToFind: [paragraph("QQ issues it with the AppID when you create the bot.")],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "appSecretEnv",
              label: "App secret env var",
              type: "text",
              required: false,
              explanation: "Name of the env var that stores the bot's AppSecret.",
              looksLike: "QQBOT_APP_SECRET",
              canChangeLater: true,
              placeholder: "QQBOT_APP_SECRET",
            },
            {
              key: "defaultTarget",
              label: "Default target",
              type: "text",
              required: false,
              explanation:
                "Leave empty on first setup. QQ often refuses a message the user didn't ask for, and that stops you finishing. Add one later, after you've messaged the bot. Format: group:<openid>, user:<openid>, channel:<id> or dm:<guild id>. Replies go to whoever messaged the bot.",
              looksLike: "user:<openid>",
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
              "The test asks QQ for an access token with your AppID and AppSecret and reads the bot's name. If you set a default target, it also sends one message there: \"GoatCitadel channel setup verification.\" The test doesn't delete it, so check that it arrived. With no default target, nothing is sent.",
            ),
            paragraph(
              "QQ limits messages a bot sends unprompted, so a refusal of that message can be a limit, not a problem with your credentials.",
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "credentials-rejected",
              "It says QQ refused the app id and secret",
              "Check that the AppID and the AppSecret come from the same bot, and paste the AppSecret again in case a space came with it. If you used a variable, check its name below.",
            ),
            troubleshoot(
              "host-not-allowed",
              "It says a QQ host is outside the network allowlist",
              "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add bots.qq.com and api.bot.qq.com (and sandbox.api.sgroup.qq.com when Test mode is on), then run the test again.",
            ),
            troubleshoot(
              "message-refused",
              "It says QQ rejected the test message",
              "QQ limits the messages a bot sends unprompted, and a person can turn them off in QQ. Leave Default target empty, run the test again and finish. Add a target later with Edit setup, after you've messaged the bot. If you keep one, check its format: group:<openid>, user:<openid>, channel:<id> or dm:<guild id>.",
            ),
            troubleshoot(
              "ip-whitelist",
              "You turned on QQ's server IP whitelist",
              "With a server IP whitelist, only the addresses on it can call the bot's API. Add this computer's public IP (search 'what is my IP'), or remove the whitelist in QQ.",
            ),
            troubleshoot(
              "variable-not-found",
              "It says the app secret is missing, and you used an environment variable",
              "A variable's name must start with QQBOT_ (for example QQBOT_APP_SECRET) and end in _TOKEN or _SECRET, and you must restart GoatCitadel after you set it. Or paste the AppSecret instead.",
            ),
            troubleshoot(
              "no-reply",
              "You message the bot and nothing comes back",
              "Check these in order. Finish setup first, then save the callback address in QQ: QQ checks it when you save, and the address only answers once the connection is finished and on. Subscribe to GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE, AT_MESSAGE_CREATE and DIRECT_MESSAGE_CREATE. Allow your openid under Who may message this bot; a group member and a one-to-one user have different openids. In a group, @-mention the bot. Your public address must reach this Gateway, and GoatCitadel must be running.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection so GoatCitadel can send from it and, once QQ is pointed at its webhook address, hear messages. The last step shows what to set in QQ.",
            ),
            paragraph("A group member's openid and a one-to-one user's openid are different: allow each one you need."),
          ],
          successCriteria: [
            "QQ issued an access token for the AppID and AppSecret.",
            "If you set a default target, the test message arrived.",
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
          fieldKey: "appSecret",
          level: "error",
          message: "Paste the QQ Bot app secret.",
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
