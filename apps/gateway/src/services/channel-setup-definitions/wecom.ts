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
  malformedFieldIssue,
} from "./common.js";

const SECRET_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["secret", "secretEnv"],
  ["callbackToken", "callbackTokenEnv"],
  ["encodingAesKey", "encodingAesKeyEnv"],
];

const CONCEPTS_PAGE = "https://developer.work.weixin.qq.com/document/path/90665";

export function createWecomDefinition(): ChannelSetupRuntimeDefinition {
  const catalog = requireCatalog("channel.wecom");
  const definition: ChannelSetupDefinition = {
    catalog: baseCatalogMeta(catalog, ["guided", "manual"]),
    wizard: {
      archetype: "webhook_destination",
      contentVersion: "2026.10.wecom.callback.v1",
      estimatedMinutes: 25,
      difficulty: "intermediate",
      manualModePolicy: "available-secondary",
      introSummary:
        "Send and receive WeCom messages through a self-built application. Sending needs this computer's public IP on the app's trusted IP list. Receiving needs a public web address (WeCom recommends HTTPS).",
      prerequisites: [
        "A WeCom self-built application: its CorpID, AgentId and Secret.",
        "This computer's public IP on the app's trusted IP list.",
        "To receive: a public web address (WeCom recommends HTTPS), and the Token and EncodingAESKey from the app's receive messages settings.",
      ],
      steps: [
        {
          id: "overview",
          kind: "intro",
          createOnly: true,
          title: "What this connection does",
          body: [
            paragraph(
              "GoatCitadel gets an access token from your CorpID and the app's Secret and sends text messages to users, departments or tags through the app. It can also hear text messages WeCom sends to a callback address: GoatCitadel checks WeCom's signature, decrypts the message with your EncodingAESKey and checks your CorpID before it accepts anything.",
            ),
            paragraph(
              "Sending works from this computer once its IP is trusted. Receiving needs a public web address you provide (a reverse proxy or tunnel; WeCom recommends HTTPS). GoatCitadel runs no relay.",
            ),
            paragraph(
              "Receiving is optional and default-deny: it stays off until the callback Token and EncodingAESKey are set, and only the WeCom userids you allow can start conversations.",
            ),
            paragraph("This channel sends text. Attachments aren't supported."),
            note(
              "warning",
              "WeCom only accepts calls from IPs on your app's trusted IP list. Add this computer's public IP (search 'what is my IP') under Enterprise trusted IP (企业可信IP) in the app's details in the WeCom admin console. WeCom says a new IP takes about a minute to apply. If your IP changes, sending stops with error 60020.",
            ),
            linkBlock("WeCom: error codes (60020)", "https://developer.work.weixin.qq.com/document/path/90313"),
            note(
              "info",
              "GoatCitadel can reach WeCom only once qyapi.weixin.qq.com is in the hosts GoatCitadel may reach: the setup test has an Allow these hosts button for that.",
            ),
            note("warning", "WeCom is a beta channel. Reactions and unsend aren't supported."),
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
              explanation: "The CorpID of your WeCom enterprise.",
              whereToFind: [
                paragraph(
                  "WeCom admin console › My Enterprise › Enterprise Info (我的企业 > 企业信息). You need to be an administrator.",
                ),
                linkBlock("WeCom: basic concepts", CONCEPTS_PAGE),
              ],
              looksLike: "ww1234567890abcdef",
              canChangeLater: true,
            },
            {
              key: "agentId",
              label: "Agent ID",
              type: "text",
              required: true,
              explanation: "The numeric AgentId of the self-built application.",
              whereToFind: [
                paragraph(
                  "WeCom admin console › App Management › Apps (应用管理 > 应用), then open your self-built app. Its AgentId is in its details.",
                ),
                linkBlock("WeCom: basic concepts", CONCEPTS_PAGE),
              ],
              looksLike: "1000002",
              canChangeLater: true,
            },
            {
              key: "secret",
              label: "Application secret",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whereToFind: [
                paragraph(
                  "WeCom admin console › App Management › Apps › Self-built (应用管理 > 应用 > 自建), then open your app. The Secret is shown there. Keep it private.",
                ),
                linkBlock("WeCom: basic concepts", CONCEPTS_PAGE),
              ],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "secretEnv",
              label: "Application secret env var",
              type: "text",
              required: false,
              explanation: "Name of the env var that stores the application's Secret.",
              looksLike: "WECOM_SECRET",
              canChangeLater: true,
              placeholder: "WECOM_SECRET",
            },
            {
              key: "defaultTarget",
              label: "Default target",
              type: "text",
              required: false,
              explanation:
                "Leave empty on first setup, or add the person to the app's visible range first. Format: user:<userid>, party:<departmentid>, tag:<tagid> or a bare userid. Replies to inbound messages go to the sender.",
              whereToFind: [
                paragraph(
                  "A person's userid is the Account on their details page: WeCom admin console › Contacts (通讯录), then the member.",
                ),
                linkBlock("WeCom: basic concepts", CONCEPTS_PAGE),
              ],
              looksLike: "user:zhangsan",
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
            paragraph("Skip this step if you only want to send."),
            {
              kind: "list",
              ordered: true,
              items: [
                "In the WeCom admin console open your app, then Receive messages and its Set API receive button (设置API接收). Choose a Token and an EncodingAESKey there (the Token: letters or digits, up to 32 characters; the EncodingAESKey: letters or digits, exactly 43), but don't save yet.",
                "Enter them here.",
                "Test and finish.",
                "Then enter this connection's webhook address in WeCom and save. WeCom checks the address when you save it, so it has to wait until the connection is finished and on.",
              ],
            },
            paragraph("Receiving needs a public web address that WeCom can reach. GoatCitadel doesn't provide one."),
            linkBlock("WeCom: receive messages setup", "https://developer.work.weixin.qq.com/document/path/90238"),
          ],
          fields: [
            {
              key: "callbackToken",
              label: "Callback token",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whyNeeded:
                "WeCom signs every message it sends you with the Token and encrypts it with the EncodingAESKey. Without both, GoatCitadel stays send-only.",
              whereToFind: [
                paragraph(
                  "WeCom admin console › your app › Receive messages › Set API receive (设置API接收). You choose the Token there: letters or digits, up to 32 characters.",
                ),
                linkBlock("WeCom: callback configuration", "https://developer.work.weixin.qq.com/document/path/90930"),
              ],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "callbackTokenEnv",
              label: "Callback token env var",
              type: "text",
              required: false,
              explanation: "Name of the env var that stores the callback Token.",
              looksLike: "WECOM_CALLBACK_TOKEN",
              canChangeLater: true,
              placeholder: "WECOM_CALLBACK_TOKEN",
            },
            {
              key: "encodingAesKey",
              label: "EncodingAESKey",
              type: "secret",
              required: false,
              explanation: PASTED_SECRET_EXPLANATION,
              whereToFind: [paragraph("Same place. The EncodingAESKey is exactly 43 letters or digits.")],
              commonMistakes: ["A key that isn't exactly 43 letters and digits."],
              sensitive: true,
              canChangeLater: true,
            },
            {
              key: "encodingAesKeyEnv",
              label: "EncodingAESKey env var",
              type: "text",
              required: false,
              explanation: "Name of the env var that stores the callback's EncodingAESKey.",
              looksLike: "WECOM_ENCODING_AES_KEY",
              canChangeLater: true,
              placeholder: "WECOM_ENCODING_AES_KEY",
            },
          ],
        },
        {
          id: "test",
          kind: "test",
          title: "Validate the draft",
          body: [
            paragraph(
              'The test asks WeCom for an access token with your CorpID and Secret, reads the application, and says whether the Token and EncodingAESKey are set. If you set a default target, it also sends one message there: "GoatCitadel channel setup verification." The test doesn\'t delete it, so check that it arrived. With no default target, nothing is sent.',
            ),
            paragraph(
              "The test can't check receiving. WeCom checks the callback address itself when you save it in WeCom.",
            ),
          ],
          troubleshooting: [
            troubleshoot(
              "ip-not-trusted",
              "It says WeCom refused this computer's public IP (errcode 60020)",
              "WeCom only accepts calls from IPs on your app's trusted IP list. Add this computer's public IP (search 'what is my IP') under Enterprise trusted IP (企业可信IP) in the app's details in the WeCom admin console, wait about a minute, and run the test again. If your IP changes, sending stops with error 60020 again.",
            ),
            troubleshoot(
              "credentials-rejected",
              "It says WeCom rejected the corp id or application secret",
              "Check the CorpID under My Enterprise › Enterprise Info, and the Secret under App Management › Apps › Self-built after opening your app. If you used a variable, check its name below.",
            ),
            troubleshoot(
              "application-not-found",
              "It says WeCom could not read the application",
              "Check the AgentId: App Management › Apps, then open your app. It is a number, and must come from the same app as the Secret.",
            ),
            troubleshoot(
              "host-not-allowed",
              "It says the WeCom host is outside the network allowlist",
              "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add qyapi.weixin.qq.com, then run the test again.",
            ),
            troubleshoot(
              "recipient-not-visible",
              "It says error 81013, or that the recipient is invalid",
              "The person, department or tag has to be in the app's visible range, and has to still exist. In the WeCom admin console add them to the app's visible range, or leave Default target empty, finish, and add one later with Edit setup. WeCom answers 81013 when every recipient is outside the visible range or gone.",
            ),
            troubleshoot(
              "variable-not-found",
              "It says the application secret is missing, and you used an environment variable",
              "A variable's name must start with WECOM_ (for example WECOM_SECRET), and you must restart GoatCitadel after you set it. The callback variables must also end in _TOKEN (the Token) or _AES_KEY (the EncodingAESKey): WECOM_ENCODING_KEY won't work. Or paste the values instead.",
            ),
            troubleshoot(
              "callback-not-saving",
              "WeCom won't save the callback address",
              "WeCom checks the address when you save it. Finish setup first: the address only answers once the connection is finished and on. Then check that the Token and EncodingAESKey in WeCom are the same as the ones you entered here, and that your public address reaches this Gateway and answers within a second.",
            ),
            troubleshoot(
              "no-reply",
              "You message the app and nothing comes back",
              "Check these in order. WeCom must have saved the callback address with the same Token and EncodingAESKey you entered here. Allow your WeCom userid under Who may message this bot; the userid is the Account on the member's details page in Contacts. GoatCitadel must be running, and your public address must reach this Gateway.",
            ),
          ],
        },
        {
          id: "finish",
          kind: "confirm",
          title: "Finish setup",
          body: [
            paragraph(
              "Finish saves the connection so GoatCitadel can send from it and, when the Token and EncodingAESKey are set, hear messages. The last step shows what to enter in WeCom.",
            ),
          ],
          successCriteria: [
            "WeCom issued an access token for the CorpID and Secret.",
            "WeCom found the application, so this computer's IP is trusted.",
            "If you set a default target, the test message arrived.",
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
          fieldKey: "secret",
          level: "error",
          message: "Paste the WeCom application secret.",
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
