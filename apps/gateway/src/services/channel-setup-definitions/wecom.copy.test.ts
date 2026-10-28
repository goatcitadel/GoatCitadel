import { describe, expect, it, vi } from "vitest";
import {
  evaluateChannelInboundAccess,
  type ChannelSetupFieldDefinition,
  type ChannelSetupRichBlock,
  type ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
import { describeDroppedSender } from "../channel-inbound-dispatch.js";
import { isAllowedSecretEnvName } from "../channel-secret-resolution.js";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import {
  buildIntegrationConnectionChecks,
  runIntegrationConnectionLiveChecks,
} from "../integration-diagnostics-service.js";
import { computeWecomSignature, decryptWecomMessage, encryptWecomMessageForTest } from "../wecom-webhook.js";
import { guideFinish, type GuideFinishOptions } from "./guide-finish.test-support.js";

function guide() {
  return requireChannelSetupDefinition("channel.wecom");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`WeCom guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`WeCom guide has no field ${key}`);
  return found;
}

function fieldKeys(id: string): string[] {
  return (step(id).fields ?? []).map((candidate) => candidate.key);
}

function paragraphs(id: string): string[] {
  return (step(id).body ?? []).flatMap((block) => (block.kind === "paragraph" ? [block.text] : []));
}

function textOf(blocks: readonly ChannelSetupRichBlock[] | undefined): string {
  return (blocks ?? []).map((block) => JSON.stringify(block)).join("\n");
}

function stepIds(): string[] {
  return guide().definition.wizard.steps.map((candidate) => candidate.id);
}

/** Every string the guide shows, joined: values only, not the names of fields such as a placeholder's own key. */
function wizardText(): string {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(guide().definition.wizard);
  return strings.join("\n");
}

/** What validate() says for a few typical mistakes: messages, details and next steps. */
function issueText(): string {
  const drafts = [
    {},
    { corpId: CORP_ID },
    { corpId: CORP_ID, agentId: "abc", secret: SECRET },
    { corpId: CORP_ID, agentId: AGENT_ID, secret: SECRET },
  ];
  return drafts
    .flatMap((values) => guide().validate(draftOf(values)))
    .flatMap((issue) => [issue.message, issue.detail ?? "", ...(issue.nextSteps ?? [])])
    .join("\n");
}

const CORP_ID = "ww1234567890abcdef";
const AGENT_ID = "1000002";
const SECRET = "wecom-app-secret-".padEnd(43, "x");
const ACCESS_TOKEN = "wecom-access-token";
const CALLBACK_TOKEN = "goatcitadelToken1";
// 43 letters and digits, the shape WeCom asks for.
const AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const USER_ID = "zhangsan";
const TARGET = `user:${USER_ID}`;
const TEST_MESSAGE = "GoatCitadel channel setup verification.";

type Fetcher = NonNullable<GuideFinishOptions["fetch"]>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A WeCom server that answers the token, application and send calls the setup test makes. */
function wecom(answers: { token?: object; agent?: object; send?: object; sendStatus?: number } = {}): Fetcher {
  return async (url) => {
    const { hostname, pathname } = new URL(url);
    if (hostname !== "qyapi.weixin.qq.com") return json({}, 404);
    if (pathname === "/cgi-bin/gettoken") {
      return json(answers.token ?? { errcode: 0, errmsg: "ok", access_token: ACCESS_TOKEN, expires_in: 7200 });
    }
    if (pathname === "/cgi-bin/agent/get") return json(answers.agent ?? { errcode: 0, errmsg: "ok", name: "GoatApp" });
    if (pathname === "/cgi-bin/message/send") {
      return json(answers.send ?? { errcode: 0, errmsg: "ok", msgid: "msg-1" }, answers.sendStatus ?? 200);
    }
    return json({}, 404);
  };
}

const { draftOf, connectionOf, continueBlockers, port } = guideFinish("channel.wecom");
const accepting = guideFinish("channel.wecom", { fetch: wecom() });
const untrustedIp = guideFinish("channel.wecom", {
  fetch: wecom({ agent: { errcode: 60020, errmsg: "not allow to access from your ip" } }),
});
const notVisible = guideFinish("channel.wecom", {
  fetch: wecom({ send: { errcode: 81013, errmsg: "user & party & tag all invalid" } }),
});
const wrongSecret = guideFinish("channel.wecom", {
  fetch: wecom({ token: { errcode: 40001, errmsg: "invalid secret" } }),
});

const SEND_VALUES = { corpId: CORP_ID, agentId: AGENT_ID, secret: SECRET };
const RECEIVING_VALUES = {
  ...SEND_VALUES,
  callbackToken: CALLBACK_TOKEN,
  encodingAesKey: AES_KEY,
  allowedSenders: [USER_ID],
};
const TRUSTED_IP_NOTE =
  "WeCom only accepts calls from IPs on your app's trusted IP list. Add this computer's public IP (search 'what is my IP') under Enterprise trusted IP (企业可信IP) in the app's details in the WeCom admin console. WeCom says a new IP takes about a minute to apply. If your IP changes, sending stops with error 60020.";

describe("WeCom setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /posture|provenance|ingress|egress|sandbox message|activation plan/iu,
    );
    expect(issueText()).not.toMatch(/posture|provenance|ingress|egress|sandbox message|activation plan/iu);
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(wizardText()).not.toMatch(/https:\/\/<your public address>/u);
  });

  it("no longer has a 'Register the callback URL' step: WeCom checks the address on Save, so it can only follow Finalize (item 1)", () => {
    expect(stepIds()).not.toContain("webhook");
    expect(wizardText()).not.toMatch(/Register the callback URL/u);
  });

  it("does not say WeCom requires HTTPS or can generate the key: WeCom's pages say http or https, and a key you choose (R46)", () => {
    expect(wizardText()).not.toMatch(/public HTTPS address|generate an EncodingAESKey/iu);
  });
});

describe("WeCom setup guide: what it says up front (items 2, 4, 8, R46, R48)", () => {
  it("opens with the intro and prerequisites from the audit, with HTTPS as a recommendation", () => {
    const wizard = guide().definition.wizard;

    // The audit says "a public HTTPS address". WeCom's page allows http or https and recommends https
    // (https://developer.work.weixin.qq.com/document/path/90238), so the claim is softened (R46).
    expect(wizard.introSummary).toBe(
      "Send and receive WeCom messages through a self-built application. Sending needs this computer's public IP on the app's trusted IP list. Receiving needs a public web address (WeCom recommends HTTPS).",
    );
    expect(wizard.prerequisites).toEqual([
      "A WeCom self-built application: its CorpID, AgentId and Secret.",
      "This computer's public IP on the app's trusted IP list.",
      "To receive: a public web address (WeCom recommends HTTPS), and the Token and EncodingAESKey from the app's receive messages settings.",
    ]);
  });

  it("asks for the test message only when one was sent: the probe sends nothing without a default target (R49)", () => {
    expect(paragraphs("first-message")).toEqual([
      "If you set a default target, check the test message arrived. To receive: in the app's receive messages settings enter this connection's webhook address with the same Token and EncodingAESKey, and save. Allow your WeCom userid, message the app, and check the reply.",
    ]);
  });

  it("keeps the picker data: the WeCom host and the inbound webhook", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.requiredHosts).toEqual(["qyapi.weixin.qq.com"]);
    expect(wizard.inboundWebhook).toEqual({
      pathTemplate: "/api/v1/integrations/connections/{connectionId}/wecom/webhook",
    });
  });

  it("says it takes about 25 minutes (item 8)", () => {
    expect(guide().definition.wizard.estimatedMinutes).toBe(25);
  });

  it("walks through the steps in order, with the optional receiving step before the sender step and the test", () => {
    expect(stepIds()).toEqual([
      "overview",
      "collect-values-identity",
      "collect-values-destinations",
      "receive-messages",
      "sender-access",
      "test",
      "finish",
      "first-message",
    ]);
  });

  it("warns up front that WeCom only accepts calls from the app's trusted IPs, and where to add this computer's (item 2)", () => {
    expect(step("overview").body).toContainEqual({ kind: "note", tone: "warning", text: TRUSTED_IP_NOTE });
    expect(textOf(step("overview").body)).toContain("https://developer.work.weixin.qq.com/document/path/90313");
  });

  it("says sending works once the IP is trusted and receiving needs a public address you provide (item 4)", () => {
    expect(paragraphs("overview")).toContain(
      "Sending works from this computer once its IP is trusted. Receiving needs a public web address you provide (a reverse proxy or tunnel; WeCom recommends HTTPS). GoatCitadel runs no relay.",
    );
  });

  it("says receiving is optional and default-deny", () => {
    expect(paragraphs("overview")).toContain(
      "Receiving is optional and default-deny: it stays off until the callback Token and EncodingAESKey are set, and only the WeCom userids you allow can start conversations.",
    );
  });

  it("says in the intro that this channel sends text and does not support attachments (R48)", () => {
    expect(paragraphs("overview")).toContain("This channel sends text. Attachments aren't supported.");
  });

  it("tells the person where the WeCom host gets allowed, not just that it must be (item 7)", () => {
    expect(step("overview").body).toContainEqual({
      kind: "note",
      tone: "info",
      text: "GoatCitadel can reach WeCom only once qyapi.weixin.qq.com is in the hosts GoatCitadel may reach: the setup test has an Allow these hosts button for that.",
    });
  });

  it("hides the setup-only intro when a saved connection is changed, but not the receiving step, which holds editable values", () => {
    expect(step("overview").createOnly).toBe(true);
    expect(guide().definition.wizard.steps.filter((candidate) => candidate.createOnly)).toHaveLength(1);
    expect(step("receive-messages").createOnly).toBeUndefined();
  });
});

describe("WeCom setup guide: where each value comes from (items 3, 5, 8, A5)", () => {
  it("says where the CorpID is, with WeCom's page", () => {
    const corpId = field("corpId");

    expect(corpId.required).toBe(true);
    expect(corpId.explanation).toBe("The CorpID of your WeCom enterprise.");
    expect(corpId.whereToFind).toEqual([
      {
        kind: "paragraph",
        text: "WeCom admin console › My Enterprise › Enterprise Info (我的企业 > 企业信息). You need to be an administrator.",
      },
      {
        kind: "link",
        label: "WeCom: basic concepts",
        href: "https://developer.work.weixin.qq.com/document/path/90665",
        external: true,
      },
    ]);
  });

  it("says where the AgentId is, and that it is a number", () => {
    const agentId = field("agentId");

    expect(agentId.required).toBe(true);
    expect(agentId.explanation).toBe("The numeric AgentId of the self-built application.");
    expect(agentId.whereToFind).toEqual([
      {
        kind: "paragraph",
        text: "WeCom admin console › App Management › Apps (应用管理 > 应用), then open your self-built app. Its AgentId is in its details.",
      },
      {
        kind: "link",
        label: "WeCom: basic concepts",
        href: "https://developer.work.weixin.qq.com/document/path/90665",
        external: true,
      },
    ]);
  });

  it("asks for the pasted application secret first, says where it is, and uses the shared wording (R39)", () => {
    const secret = field("secret");
    const keys = fieldKeys("collect-values-identity");

    expect(keys).toEqual(["corpId", "agentId", "secret", "secretEnv"]);
    expect(secret.type).toBe("secret");
    expect(secret.label).toBe("Application secret");
    expect(secret.required).toBe(false);
    expect(secret.sensitive).toBe(true);
    expect(secret.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
    expect(textOf(secret.whereToFind)).toContain("App Management › Apps › Self-built");
    expect(textOf(secret.whereToFind)).toContain("https://developer.work.weixin.qq.com/document/path/90665");
  });

  it("keeps the variable name under Advanced with the shared name rule (A5)", () => {
    const env = field("secretEnv");

    expect(env.advanced).toBe(true);
    expect(env.label).toBe("Application secret from an environment variable (advanced)");
    expect(env.explanation).toBe(
      "Name of the env var that stores the application's Secret. The variable's name must start with WECOM_ (for example WECOM_SECRET). Set it where GoatCitadel starts, then restart GoatCitadel.",
    );
  });

  it("says to leave Default target empty at first, or add the person to the app's visible range, and where a userid is (item 3)", () => {
    const target = field("defaultTarget");

    expect(target.required).toBe(false);
    expect(target.explanation).toBe(
      "Leave empty on first setup, or add the person to the app's visible range first. Format: user:<userid>, party:<departmentid>, tag:<tagid> or a bare userid. Replies to inbound messages go to the sender.",
    );
    expect(target.looksLike).toBe("user:zhangsan");
    expect(textOf(target.whereToFind)).toContain(
      "A person's userid is the Account on their details page: WeCom admin console › Contacts (通讯录), then the member.",
    );
    expect(fieldKeys("collect-values-destinations")).toEqual(["defaultTarget"]);
  });

  it("asks for a Corp ID, an Agent ID and either form of the secret, nothing about receiving (Continue)", () => {
    expect(continueBlockers({})).toEqual([
      "Corp ID",
      "Agent ID",
      "Application secret or Application secret from an environment variable (advanced)",
    ]);
  });
});

describe("WeCom setup guide: receiving, as an optional step (item 1, 6, A5, A12)", () => {
  it("is a field step of its own, keeps its title and id, and sits with the access steps", () => {
    const receive = step("receive-messages");

    expect(receive.title).toBe("Receive messages (optional)");
    expect(receive.kind).toBe("field-collection");
    expect(receive.stage).toBe("destinations_access");
    expect(receive.visibleWhenFieldEquals).toBeUndefined();
  });

  it("holds the four callback fields, the pasted ones first", () => {
    expect(fieldKeys("receive-messages")).toEqual([
      "callbackToken",
      "callbackTokenEnv",
      "encodingAesKey",
      "encodingAesKeyEnv",
    ]);
  });

  it("is optional all the way: no field is required and Continue never asks for one of them", () => {
    expect((step("receive-messages").fields ?? []).filter((candidate) => candidate.required)).toEqual([]);
    expect(step("receive-messages").requiredAnyOf).toBeUndefined();
    expect(continueBlockers(SEND_VALUES)).toEqual([]);
  });

  it("walks through the four steps in the order WeCom needs them, and says why the address waits", () => {
    expect(paragraphs("receive-messages")).toEqual([
      "Skip this step if you only want to send.",
      "Receiving needs a public web address that WeCom can reach. GoatCitadel doesn't provide one.",
    ]);
    expect(step("receive-messages").body).toContainEqual({
      kind: "list",
      ordered: true,
      items: [
        "In the WeCom admin console open your app, then Receive messages and its Set API receive button (设置API接收). Choose a Token and an EncodingAESKey there (the Token: letters or digits, up to 32 characters; the EncodingAESKey: letters or digits, exactly 43), but don't save yet.",
        "Enter them here.",
        "Test and finish.",
        "Then enter this connection's webhook address in WeCom and save. WeCom checks the address when you save it, so it has to wait until the connection is finished and on.",
      ],
    });
    expect(textOf(step("receive-messages").body)).toContain("https://developer.work.weixin.qq.com/document/path/90238");
  });

  it("asks for no checklist box: a send-only setup must not tick a receiving step (R50)", () => {
    const boxes = guide().definition.wizard.steps.flatMap((candidate) => candidate.checklist ?? []);

    expect(boxes).toEqual([]);
  });

  it("says why the Token matters and where it is chosen", () => {
    const token = field("callbackToken");

    expect(token.type).toBe("secret");
    expect(token.label).toBe("Callback token");
    expect(token.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
    expect(token.whyNeeded).toBe(
      "WeCom signs every message it sends you with the Token and encrypts it with the EncodingAESKey. Without both, GoatCitadel stays send-only.",
    );
    expect(textOf(token.whereToFind)).toContain(
      "WeCom admin console › your app › Receive messages › Set API receive (设置API接收). You choose the Token there: letters or digits, up to 32 characters.",
    );
    expect(textOf(token.whereToFind)).toContain("https://developer.work.weixin.qq.com/document/path/90930");
  });

  it("says the EncodingAESKey is 43 letters or digits", () => {
    const key = field("encodingAesKey");

    expect(key.type).toBe("secret");
    expect(key.label).toBe("EncodingAESKey");
    expect(textOf(key.whereToFind)).toContain("Same place. The EncodingAESKey is exactly 43 letters or digits.");
    expect(key.commonMistakes).toEqual(["A key that isn't exactly 43 letters and digits."]);
  });

  it("gives each variable its own name rule: _TOKEN for the Token, _AES_KEY for the key (item 6)", () => {
    expect(field("callbackTokenEnv").label).toBe("Callback token from an environment variable (advanced)");
    expect(field("callbackTokenEnv").explanation).toBe(
      "Name of the env var that stores the callback Token. The variable's name must start with WECOM_ (for example WECOM_CALLBACK_TOKEN). Set it where GoatCitadel starts, then restart GoatCitadel. The name must also end in _TOKEN or _SECRET.",
    );
    expect(field("encodingAesKeyEnv").label).toBe("EncodingAESKey from an environment variable (advanced)");
    expect(field("encodingAesKeyEnv").explanation).toBe(
      "Name of the env var that stores the callback's EncodingAESKey. The variable's name must start with WECOM_ (for example WECOM_ENCODING_AES_KEY). Set it where GoatCitadel starts, then restart GoatCitadel. The name must also end in _AES_KEY.",
    );
    expect(field("callbackTokenEnv").advanced).toBe(true);
    expect(field("encodingAesKeyEnv").advanced).toBe(true);
  });

  it("the example names are accepted by the Gateway's callback guard, and WECOM_ENCODING_KEY is not (item 6)", () => {
    expect(isAllowedSecretEnvName("WECOM_CALLBACK_TOKEN")).toBe(true);
    expect(isAllowedSecretEnvName("WECOM_ENCODING_AES_KEY")).toBe(true);
    expect(isAllowedSecretEnvName("WECOM_SECRET")).toBe(true);
    expect(isAllowedSecretEnvName("WECOM_ENCODING_KEY")).toBe(false);
  });
});

describe("WeCom setup guide: the sender step (A7, A8)", () => {
  it("shows no access-mode choice: WeCom inbound is always default-deny", () => {
    expect(fieldKeys("sender-access")).toEqual(["allowedSenders"]);
    expect(step("sender-access").visibleWhenFieldEquals).toBeUndefined();
  });

  it("keeps the sender help for WeCom userids and says where to find one", () => {
    const senders = step("sender-access").fields?.find((candidate) => candidate.key === "allowedSenders");

    expect(senders?.explanation).toBe(
      'Add the WeCom userids that may start conversations. Inbound is default-deny; empty means every inbound sender is denied. Don\'t know the id? Message the bot once, then open System › Diagnostics and find "Dropped a … message from …".',
    );
  });
});

describe("WeCom setup guide: the test and finishing (items 2, 8, R49)", () => {
  it("says what the test sends, only with a default target, that it stays, and that it can't check receiving", () => {
    expect(paragraphs("test")).toEqual([
      'The test asks WeCom for an access token with your CorpID and Secret, reads the application, and says whether the Token and EncodingAESKey are set. If you set a default target, it also sends one message there: "GoatCitadel channel setup verification." The test doesn\'t delete it, so check that it arrived. With no default target, nothing is sent.',
      "The test can't check receiving. WeCom checks the callback address itself when you save it in WeCom.",
    ]);
    expect(paragraphs("test")[0]).toContain(TEST_MESSAGE);
  });

  it("finishes by saving for sending, and for receiving when the Token and key are set", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection so GoatCitadel can send from it and, when the Token and EncodingAESKey are set, hear messages. The last step shows what to enter in WeCom.",
    ]);
    expect(step("finish").successCriteria).toEqual([
      "WeCom issued an access token for the CorpID and Secret.",
      "WeCom found the application, so this computer's IP is trusted.",
      "If you set a default target, the test message arrived.",
    ]);
    expect(wizardText()).not.toMatch(/confirmed delivery manually/u);
  });
});

describe("WeCom setup guide: when the test fails (A13)", () => {
  const items = () => step("test").troubleshooting ?? [];
  const body = (id: string) => items().find((item) => item.id === id)?.body ?? "";
  const title = (id: string) => items().find((item) => item.id === id)?.title ?? "";

  it("lists the failures a WeCom setup really hits, on the test step", () => {
    expect(items().map((item) => item.id)).toEqual([
      "ip-not-trusted",
      "credentials-rejected",
      "application-not-found",
      "host-not-allowed",
      "recipient-not-visible",
      "variable-not-found",
      "callback-not-saving",
      "no-reply",
    ]);
  });

  it("explains errcode 60020: the trusted IP list, where to add the IP, and that a changed IP stops sending (item 2)", () => {
    expect(title("ip-not-trusted")).toBe("It says WeCom refused this computer's public IP (errcode 60020)");
    expect(body("ip-not-trusted")).toBe(
      "WeCom only accepts calls from IPs on your app's trusted IP list. Add this computer's public IP (search 'what is my IP') under Enterprise trusted IP (企业可信IP) in the app's details in the WeCom admin console, wait about a minute, and run the test again. If your IP changes, sending stops with error 60020 again.",
    );
  });

  it("explains errcode 81013: the recipient has to be in the app's visible range (item 3)", () => {
    expect(title("recipient-not-visible")).toBe("It says error 81013, or that the recipient is invalid");
    expect(body("recipient-not-visible")).toBe(
      "The person, department or tag has to be in the app's visible range, and has to still exist. In the WeCom admin console add them to the app's visible range, or leave Default target empty, finish, and add one later with Edit setup. WeCom answers 81013 when every recipient is outside the visible range or gone.",
    );
  });

  it("points a refused Secret at the CorpID and the Secret", () => {
    expect(title("credentials-rejected")).toBe("It says WeCom rejected the corp id or application secret");
    expect(body("credentials-rejected")).toBe(
      "Check the CorpID under My Enterprise › Enterprise Info, and the Secret under App Management › Apps › Self-built after opening your app. If you used a variable, check its name below.",
    );
  });

  it("points an unreadable application at the AgentId", () => {
    expect(title("application-not-found")).toBe("It says WeCom could not read the application");
    expect(body("application-not-found")).toBe(
      "Check the AgentId: App Management › Apps, then open your app. It is a number, and must come from the same app as the Secret.",
    );
  });

  it("names the Allow these hosts button", () => {
    expect(title("host-not-allowed")).toBe("It says the WeCom host is outside the network allowlist");
    expect(body("host-not-allowed")).toBe(
      "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add qyapi.weixin.qq.com, then run the test again.",
    );
  });

  it("gives the variable name rules for all three variables and the restart (item 6)", () => {
    expect(body("variable-not-found")).toBe(
      "A variable's name must start with WECOM_ (for example WECOM_SECRET), and you must restart GoatCitadel after you set it. The callback variables must also end in _TOKEN (the Token) or _AES_KEY (the EncodingAESKey): WECOM_ENCODING_KEY won't work. Or paste the values instead.",
    );
  });

  it("says why WeCom may refuse to save the callback address, and the one-second answer WeCom waits for", () => {
    expect(title("callback-not-saving")).toBe("WeCom won't save the callback address");
    expect(body("callback-not-saving")).toBe(
      "WeCom checks the address when you save it. Finish setup first: the address only answers once the connection is finished and on. Then check that the Token and EncodingAESKey in WeCom are the same as the ones you entered here, and that your public address reaches this Gateway and answers within a second.",
    );
  });

  it("points a silent app at the saved address, the allowed userid, the running Gateway and the reachable address", () => {
    const noReply = body("no-reply");

    expect(title("no-reply")).toBe("You message the app and nothing comes back");
    expect(noReply).toContain("WeCom must have saved the callback address");
    expect(noReply).toContain("same Token and EncodingAESKey");
    expect(noReply).toContain("Allow your WeCom userid under Who may message this bot");
    expect(noReply).toContain("Account on the member's details page in Contacts");
    expect(noReply).toContain("GoatCitadel must be running");
    expect(noReply).toContain("your public address must reach this Gateway");
  });
});

describe("WeCom setup guide: asking for what is missing (A15)", () => {
  it("asks for the application secret, and jumps to the pasted field", () => {
    expect(guide().validate(draftOf({ corpId: CORP_ID, agentId: AGENT_ID }))).toEqual([
      expect.objectContaining({
        key: "wecom_auth_missing",
        fieldKey: "secret",
        level: "error",
        message: "Paste the WeCom application secret.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("does not ask when a pasted secret, a variable name or a saved secret is there", () => {
    const saved = draftOf(
      { corpId: CORP_ID, agentId: AGENT_ID },
      { hydration: { status: "opaque-secret", fieldState: { secret: "configured" }, warnings: [] } },
    );

    expect(guide().validate(draftOf(SEND_VALUES))).toEqual([]);
    expect(guide().validate(draftOf({ corpId: CORP_ID, agentId: AGENT_ID, secretEnv: "WECOM_SECRET" }))).toEqual([]);
    expect(guide().validate(saved)).toEqual([]);
  });

  it("still asks for the Corp ID and a numeric Agent ID", () => {
    expect(guide().validate(draftOf({ agentId: AGENT_ID, secret: SECRET }))).toEqual([
      expect.objectContaining({ key: "corpId_required", fieldKey: "corpId", message: "Corp ID is required." }),
    ]);
    expect(guide().validate(draftOf({ corpId: CORP_ID, agentId: "abc", secret: SECRET }))).toEqual([
      expect.objectContaining({
        key: "agentId_malformed",
        fieldKey: "agentId",
        message: "Agent ID is the numeric AgentId of the application.",
      }),
    ]);
  });
});

describe("WeCom send-only path: can it finish?", () => {
  it("lets Continue pass with a Corp ID, an Agent ID and a pasted Secret, and asks for nothing about receiving", () => {
    expect(continueBlockers(SEND_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(SEND_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test with no default target: WeCom finds the app, and nothing is sent", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { issues, live, deps, eligibility } = await accepting.verdictOf(config);
    const paths = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls.map(([url]) => new URL(url).pathname);

    expect(config).toEqual({ ...SEND_VALUES, inboundAccessMode: "allowlist" });
    expect(paths).toEqual(["/cgi-bin/gettoken", "/cgi-bin/agent/get"]);
    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["wecom_auth", "pass"],
      ["wecom_agent", "pass"],
      ["wecom_callback", "warn"],
      ["wecom_sandbox_send", "skipped"],
    ]);
    // The callback note and the missing target are not setup problems for a send-only setup. There is no note about an
    // empty sender list: WeCom has no inbound at all until the Token and EncodingAESKey are set.
    expect(issues.map((issue) => issue.key).sort()).toEqual(["target", "wecom_callback"]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("sends the test message when a default target is set, and is cleared once WeCom accepts it", async () => {
    const config = guide().normalize(draftOf({ ...SEND_VALUES, defaultTarget: TARGET }));
    const { live, deps, eligibility } = await accepting.verdictOf(config);
    const send = vi
      .mocked(deps.fetchWithDiagnosticsTimeout)
      .mock.calls.find(([url]) => url.includes("/cgi-bin/message/send"));

    expect(JSON.parse(String(send?.[1]?.body))).toMatchObject({
      touser: USER_ID,
      msgtype: "text",
      agentid: Number(AGENT_ID),
      text: { content: TEST_MESSAGE },
    });
    expect(live.probe?.steps.find((candidate) => candidate.key === "wecom_sandbox_send")).toMatchObject({
      status: "pass",
      providerMessageId: "msg-1",
    });
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
    expect(paragraphs("test")[0]).toContain("The test doesn't delete it, so check that it arrived.");
  });

  it("holds Finalize back on errcode 60020, names the IP to add, and the guide names the fix (item 2)", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { live, eligibility } = await untrustedIp.verdictOf(config);

    expect(live.probe?.steps.find((candidate) => candidate.key === "wecom_agent")).toMatchObject({
      status: "fail",
      message: "WeCom refused this computer's public IP (errcode 60020). Add it to the application's trusted IP list.",
    });
    expect(eligibility.allowed).toBe(false);
    expect(step("test").troubleshooting?.find((item) => item.id === "ip-not-trusted")?.title).toContain(
      "errcode 60020",
    );
  });

  it("holds Finalize back on errcode 81013 for the default target, and leaving the target empty is the way out (item 3)", async () => {
    const withTarget = guide().normalize(draftOf({ ...SEND_VALUES, defaultTarget: TARGET }));
    const { live, eligibility } = await notVisible.verdictOf(withTarget);

    expect(live.probe?.steps.find((candidate) => candidate.key === "wecom_sandbox_send")?.message).toContain(
      "errcode 81013",
    );
    expect(eligibility.allowed).toBe(false);
    expect(step("test").troubleshooting?.find((item) => item.id === "recipient-not-visible")?.body).toContain(
      "leave Default target empty",
    );

    const withoutTarget = guide().normalize(draftOf(SEND_VALUES));
    expect((await notVisible.verdictOf(withoutTarget)).eligibility.allowed).toBe(true);
  });

  it("holds Finalize back when WeCom rejects the Secret, and the guide names the fix", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { eligibility } = await wrongSecret.verdictOf(config);

    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons.join("\n")).toContain("WeCom rejected the corp id or application secret");
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("credentials-rejected");
  });

  it("holds Finalize back while the WeCom host is not allowed, and the guide names the button", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const deps = { ...port(), isConnectionUrlAllowlisted: vi.fn(() => false) };
    const live = await runIntegrationConnectionLiveChecks(deps, connectionOf(config), { includeSandboxSend: true });

    expect(live.checks).toEqual([
      expect.objectContaining({
        key: "wecom_network",
        status: "fail",
        message: "The WeCom host qyapi.weixin.qq.com is outside the network allowlist.",
      }),
    ]);
    expect(step("test").troubleshooting?.find((item) => item.id === "host-not-allowed")?.body).toContain(
      "Allow these hosts",
    );
  });

  it("asks this path to tick nothing: the guide has no checklist boxes at all (R50)", () => {
    const boxes = guide().definition.wizard.steps.flatMap((candidate) => candidate.checklist ?? []);

    expect(boxes).toEqual([]);
  });

  it("still tells the operator that attachments aren't supported", () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const attachments = buildIntegrationConnectionChecks(port(), connectionOf(config)).find(
      (check) => check.key === "attachments",
    );

    expect(attachments).toEqual({
      key: "attachments",
      status: "pass",
      message: "This channel sends text. Attachments aren't supported.",
    });
  });

  it("is also cleared when the secret is a variable name rather than a pasted secret", () => {
    const config = guide().normalize(draftOf({ corpId: CORP_ID, agentId: AGENT_ID, secretEnv: "WECOM_SECRET" }));
    const previous = process.env.WECOM_SECRET;
    process.env.WECOM_SECRET = SECRET;
    try {
      const structural = buildIntegrationConnectionChecks(port(), connectionOf(config));

      // Nobody is allowed to message the app yet and no target is set: not setup problems (see the test above).
      expect(
        structural.filter(
          (check) => check.status !== "pass" && !["inbound_access_allowlist_empty", "target"].includes(check.key),
        ),
      ).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.WECOM_SECRET;
      else process.env.WECOM_SECRET = previous;
    }
  });
});

describe("WeCom receiving path: can it finish?", () => {
  it("lets Continue pass with the same three values: the Token, the key and the allowed userids are optional", () => {
    expect(continueBlockers(RECEIVING_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(RECEIVING_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test, and the probe sees the Token and key are set", async () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const { issues, live, eligibility } = await accepting.verdictOf(config);

    expect(config).toMatchObject({
      callbackToken: CALLBACK_TOKEN,
      encodingAesKey: AES_KEY,
      inboundAccessMode: "allowlist",
      allowedSenders: [USER_ID],
    });
    expect(live.probe?.steps.find((candidate) => candidate.key === "wecom_callback")).toMatchObject({
      status: "pass",
      message:
        "The callback token and EncodingAESKey are configured. Register the connection webhook URL in the application's message-receiving settings; inbound is default-deny by sender userid.",
    });
    expect(issues.map((issue) => issue.key)).not.toContain("wecom_callback");
    expect(issues.map((issue) => issue.key)).not.toContain("inbound_access_allowlist_empty");
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("a Token and a 43-letter key as the guide describes them work in the Gateway's own address check (item 1)", () => {
    // WeCom's check, when you save the address, sends an echostr that is encrypted with the key and signed with the
    // Token. The Gateway checks the signature, decrypts with the key and the CorpID, and answers with the plain text.
    const timestamp = "1409659813";
    const nonce = "1372623149";
    const echostr = encryptWecomMessageForTest({
      encodingAesKey: AES_KEY,
      message: "the-plain-echo",
      receiveId: CORP_ID,
      random: Buffer.from("0123456789abcdef", "utf8"),
    });
    const signature = computeWecomSignature(CALLBACK_TOKEN, timestamp, nonce, echostr);

    expect(AES_KEY).toMatch(/^[A-Za-z0-9]{43}$/u);
    expect(computeWecomSignature("another-token", timestamp, nonce, echostr)).not.toBe(signature);
    expect(decryptWecomMessage({ encodingAesKey: AES_KEY, encrypted: echostr, expectedReceiveId: CORP_ID })).toBe(
      "the-plain-echo",
    );
  });

  it("lets a listed userid in and keeps everyone else out", () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));

    expect(evaluateChannelInboundAccess({ config, actorId: USER_ID })).toMatchObject({ allowed: true });
    expect(evaluateChannelInboundAccess({ config, actorId: "lisi" })).toMatchObject({ allowed: false });
  });

  it("tells the person where their userid is, so allowing themselves needs no later fix", () => {
    // WeCom shows a member's userid (the Account) to an administrator under Contacts. Someone who can't see
    // Contacts can read it from the dropped message's diagnostic (A6, C9), as for QQ.
    expect(textOf(field("defaultTarget").whereToFind)).toContain("Contacts");
    expect(paragraphs("first-message")[0]).toContain("Allow your WeCom userid");
    expect(wizardText()).toContain('find "Dropped a … message from …"');
    expect(describeDroppedSender("wecom", "zhangsan")).toMatch(/^Dropped a WeCom message from zhangsan: /u);
  });

  it("does not make an edit replay the setup-only steps, but still shows the receiving step", () => {
    expect(continueBlockers(RECEIVING_VALUES, "edit")).toEqual([]);
    expect(continueBlockers({}, "edit")).toEqual([
      "Corp ID",
      "Agent ID",
      "Application secret or Application secret from an environment variable (advanced)",
    ]);
    expect(step("receive-messages").createOnly).toBeUndefined();
  });
});
