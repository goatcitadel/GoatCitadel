import { describe, expect, it, vi } from "vitest";
import {
  evaluateChannelInboundAccess,
  type ChannelSetupFieldDefinition,
  type ChannelSetupRichBlock,
  type ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
import { isAllowedSecretEnvName } from "../channel-secret-resolution.js";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import {
  buildIntegrationConnectionChecks,
  runIntegrationConnectionLiveChecks,
} from "../integration-diagnostics-service.js";
import { normalizeQqbotWebhookPayload } from "../qqbot-webhook.js";
import { guideFinish, type GuideFinishOptions } from "./guide-finish.test-support.js";

function guide() {
  return requireChannelSetupDefinition("channel.qqbot");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`QQ Bot guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`QQ Bot guide has no field ${key}`);
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
    { appId: APP_ID },
    { appId: APP_ID, appSecret: APP_SECRET, defaultTarget: "guild:1" },
    { appId: APP_ID, appSecret: APP_SECRET },
  ];
  return drafts
    .flatMap((values) => guide().validate(draftOf(values)))
    .flatMap((issue) => [issue.message, issue.detail ?? "", ...(issue.nextSteps ?? [])])
    .join("\n");
}

const APP_ID = "102000000";
const APP_SECRET = "qq-app-secret-".padEnd(32, "x");
const ACCESS_TOKEN = "qq-access-token";
const OPENID = "E2C4A9D0B1F34A7C8D5E6F708192A3B4";
const TARGET = `user:${OPENID}`;
const TEST_MESSAGE = "GoatCitadel channel setup verification.";
const EVENTS = ["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE", "AT_MESSAGE_CREATE", "DIRECT_MESSAGE_CREATE"];

type Fetcher = NonNullable<GuideFinishOptions["fetch"]>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A QQ Open Platform that answers the token, bot identity and message calls the setup test makes. */
function qq(options: { token?: number; send?: number } = {}): Fetcher {
  const apiHosts = new Set(["api.bot.qq.com", "sandbox.api.sgroup.qq.com"]);
  return async (url) => {
    const { hostname, pathname } = new URL(url);
    if (hostname === "bots.qq.com" && pathname === "/app/getAppAccessToken") {
      return options.token ? json({}, options.token) : json({ access_token: ACCESS_TOKEN, expires_in: "7200" });
    }
    if (apiHosts.has(hostname) && pathname === "/users/@me") return json({ id: "BOT1", username: "GoatBot" });
    if (apiHosts.has(hostname) && pathname.endsWith("/messages")) {
      return options.send ? json({}, options.send) : json({ id: "msg-1" });
    }
    return json({}, 404);
  };
}

const { draftOf, connectionOf, continueBlockers, port } = guideFinish("channel.qqbot");
const accepting = guideFinish("channel.qqbot", { fetch: qq() });
const refusingMessage = guideFinish("channel.qqbot", { fetch: qq({ send: 403 }) });
const refusingCredentials = guideFinish("channel.qqbot", { fetch: qq({ token: 401 }) });

const SEND_VALUES = { appId: APP_ID, appSecret: APP_SECRET };
const RECEIVING_VALUES = { ...SEND_VALUES, allowedSenders: [OPENID] };

describe("QQ Bot setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /posture|provenance|ingress|egress|sandbox message|activation plan/iu,
    );
    expect(issueText()).not.toMatch(/posture|provenance|ingress|egress|sandbox message|activation plan/iu);
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(wizardText()).not.toMatch(/https:\/\/<your public address>/u);
  });

  it("names no console menu: QQ's pages don't say where the AppID and AppSecret are, so the guide doesn't guess (R46)", () => {
    expect(wizardText()).not.toMatch(/Development settings|Callback configuration|Development >/iu);
  });

  it("does not claim QQ approves events first, or that an unpublished app can only use the sandbox (R46)", () => {
    expect(wizardText()).not.toMatch(/must approve|QQ's approval|can only use the sandbox/iu);
  });

  it("promises no screen that shows the sender's openid: none does yet (A6 waits for C9)", () => {
    expect(wizardText()).not.toMatch(/Diagnostics/u);
    expect(issueText()).not.toMatch(/Diagnostics/u);
  });
});

describe("QQ Bot setup guide: what it says up front (items 3, 6, 7, 8, R46, R48)", () => {
  it("opens with the intro and prerequisites from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Send and receive QQ messages through a QQ Bot Open Platform app. Receiving needs a public HTTPS address on port 443, 8443, 80 or 8080.",
    );
    // The audit's third line ("QQ's approval for group and direct-message events, if you want them.") is not on any
    // QQ page, so it is left out (R46).
    expect(wizard.prerequisites).toEqual([
      "The QQ Bot app's AppID and AppSecret.",
      "A public HTTPS address for this Gateway (a reverse proxy or tunnel); GoatCitadel doesn't provide one.",
    ]);
  });

  it("ends with the audit's first message, and says GoatCitadel can't show the openid yet", () => {
    // Ruling R49: this asks the person to check no test message. The audit's text is kept, with one sentence added
    // because without A6 the copy must say no screen shows the openid (item 1).
    expect(paragraphs("first-message")).toEqual([
      "In the QQ Bot console set the callback URL to this connection's webhook address and subscribe to GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE, AT_MESSAGE_CREATE and DIRECT_MESSAGE_CREATE. Message the bot once; it won't answer yet. Add your openid (see Who may message this bot) with Edit setup, then message again. GoatCitadel can't show your openid yet, so you need to know it already.",
    ]);
  });

  it("keeps the picker data: the QQ hosts, Test mode's host and the inbound webhook", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.requiredHosts).toEqual(["bots.qq.com", "api.bot.qq.com"]);
    expect(wizard.conditionalHosts).toEqual([
      { host: "sandbox.api.sgroup.qq.com", whenAnyFieldSet: ["sandbox"], equals: true },
    ]);
    expect(wizard.inboundWebhook).toEqual({
      pathTemplate: "/api/v1/integrations/connections/{connectionId}/qqbot/webhook",
    });
  });

  it("says it takes about 25 minutes and is advanced (item 8)", () => {
    expect(guide().definition.wizard.estimatedMinutes).toBe(25);
    expect(guide().definition.wizard.difficulty).toBe("advanced");
  });

  it("no longer has a 'Register the callback URL' step: it could only be done after Finalize (item 2)", () => {
    expect(stepIds()).not.toContain("webhook");
    expect(wizardText()).not.toMatch(/Register the callback URL/u);
  });

  it("walks through the steps in order, with the sender step before the test and the first message last", () => {
    expect(stepIds()).toEqual([
      "overview",
      "collect-values-identity",
      "collect-values-destinations",
      "sender-access",
      "test",
      "finish",
      "first-message",
    ]);
  });

  it("says in the intro that receiving needs a public HTTPS address, on which ports, and that there is no relay (item 3)", () => {
    expect(paragraphs("overview")).toContain(
      "QQ delivers messages only to a public HTTPS address on port 443, 8443, 80 or 8080 that you provide (a reverse proxy or tunnel to this Gateway, which listens on port 8787 by default). GoatCitadel runs no relay. Without one this connection can only send, and QQ limits unprompted messages.",
    );
  });

  it("names the four events and says a group message is heard only when the bot is @-mentioned (item 7)", () => {
    expect(paragraphs("overview")).toContain(
      "GoatCitadel hears four kinds of message: group @-mentions (GROUP_AT_MESSAGE_CREATE), one-to-one messages (C2C_MESSAGE_CREATE), guild channel @-mentions (AT_MESSAGE_CREATE) and guild direct messages (DIRECT_MESSAGE_CREATE). In a group it hears only messages that @-mention the bot.",
    );
  });

  it("says receiving is default-deny, that the openid isn't a QQ number, and that group and one-to-one openids differ", () => {
    expect(paragraphs("overview")).toContain(
      "Receiving is default-deny: only the openids you allow can start conversations. An openid is the id QQ gives each sender for your app, not a QQ number. A group member's openid and a one-to-one user's openid are different, so allow each one you need.",
    );
  });

  it("says no screen shows the openid yet, and what to do about it (item 1, without A6)", () => {
    expect(paragraphs("overview")).toContain(
      "QQ doesn't show your openid, and GoatCitadel can't show it yet either. Until it can, use this connection for sending unless you already know your openid.",
    );
  });

  it("says in the intro that this channel sends text and does not support attachments (R48)", () => {
    expect(paragraphs("overview")).toContain("This channel sends text. Attachments aren't supported.");
  });

  it("tells the person where the QQ hosts get allowed, not just that they must be (item 6)", () => {
    expect(step("overview").body).toContainEqual({
      kind: "note",
      tone: "info",
      text: "GoatCitadel can reach QQ only once these hosts are in the hosts GoatCitadel may reach: bots.qq.com and api.bot.qq.com, plus sandbox.api.sgroup.qq.com in Test mode. The setup test has an Allow these hosts button for that.",
    });
  });

  it("hides the setup-only intro when a saved connection is changed", () => {
    expect(step("overview").createOnly).toBe(true);
    expect(guide().definition.wizard.steps.filter((candidate) => candidate.createOnly)).toHaveLength(1);
  });
});

describe("QQ Bot setup guide: connecting the app (items 4, 5, 8, A5)", () => {
  it("puts Test mode next to the App ID, and the pasted secret ahead of its variable name", () => {
    expect(fieldKeys("collect-values-identity")).toEqual(["appId", "sandbox", "appSecret", "appSecretEnv"]);
    expect(fieldKeys("collect-values-destinations")).toEqual(["defaultTarget"]);
  });

  it("shows Test mode as a plain switch, off by default, and says what it does without claiming a rule QQ doesn't state (item 5)", () => {
    const testMode = field("sandbox");

    expect(testMode.label).toBe("Test mode (sandbox)");
    expect(testMode.type).toBe("boolean");
    expect(testMode.defaultValue).toBe(false);
    expect(testMode.advanced).not.toBe(true);
    expect(testMode.required).toBe(false);
    // The audit's "Turn on while your QQ app is not published yet." is a rule QQ's pages don't state, so the field
    // says what QQ's FAQ does say (R46; https://q.qq.com/wiki/FAQ/robot/).
    expect(testMode.explanation).toBe(
      "Send through QQ's sandbox host, sandbox.api.sgroup.qq.com, instead of the live one. QQ's FAQ says features that aren't published yet can be tried in the sandbox.",
    );
    expect(textOf(testMode.whereToFind)).toContain("https://q.qq.com/wiki/FAQ/robot/");
  });

  it("says where the AppID comes from, and links QQ's docs (item 8)", () => {
    const appId = field("appId");

    expect(appId.required).toBe(true);
    expect(appId.explanation).toBe("The AppID of your QQ Bot Open Platform app.");
    expect(appId.whereToFind).toEqual([
      {
        kind: "paragraph",
        text: "QQ issues the AppID and AppSecret when you create the bot. Sign in at q.qq.com and open the bot's management page to see them.",
      },
      {
        kind: "link",
        label: "QQ Bot docs: getting started",
        href: "https://bot.q.qq.com/wiki/develop/api-v2/",
        external: true,
      },
    ]);
  });

  it("asks for the pasted App secret first, with the shared wording (R39)", () => {
    const secret = field("appSecret");

    expect(secret.type).toBe("secret");
    expect(secret.label).toBe("App secret");
    expect(secret.required).toBe(false);
    expect(secret.sensitive).toBe(true);
    expect(secret.advanced).not.toBe(true);
    expect(secret.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
    expect(textOf(secret.whereToFind)).toContain("QQ issues it with the AppID");
  });

  it("keeps the variable name under Advanced, with the shared name rule (A5)", () => {
    const env = field("appSecretEnv");

    expect(env.advanced).toBe(true);
    expect(env.label).toBe("App secret from an environment variable (advanced)");
    expect(env.explanation).toBe(
      "Name of the env var that stores the bot's AppSecret. The variable's name must start with QQBOT_ (for example QQBOT_APP_SECRET). Set it where GoatCitadel starts, then restart GoatCitadel. It must also end in _TOKEN or _SECRET.",
    );
  });

  it("gives an example variable name the Gateway really accepts, and the name rule is true", () => {
    expect(isAllowedSecretEnvName("QQBOT_APP_SECRET")).toBe(true);
    expect(isAllowedSecretEnvName("APP_SECRET")).toBe(false);
  });

  it("asks for an App ID and either form of the secret, nothing else (Continue)", () => {
    expect(continueBlockers({})).toEqual([
      "App ID",
      "App secret or App secret from an environment variable (advanced)",
    ]);
  });

  it("says to leave Default target empty at first, why, and the format when you add one (item 4)", () => {
    const target = field("defaultTarget");

    expect(target.required).toBe(false);
    expect(target.explanation).toBe(
      "Leave empty on first setup. QQ often refuses a message the user didn't ask for, and that stops you finishing. Add one later, after you've messaged the bot. Format: group:<openid>, user:<openid>, channel:<id> or dm:<guild id>. Replies go to whoever messaged the bot.",
    );
    expect(target.looksLike).toBe("user:<openid>");
  });
});

describe("QQ Bot setup guide: the sender step (item 1, A7, A8)", () => {
  it("shows no access-mode choice: QQ inbound is always default-deny", () => {
    expect(fieldKeys("sender-access")).toEqual(["allowedSenders"]);
    expect(step("sender-access").visibleWhenFieldEquals).toBeUndefined();
  });

  it("keeps the sender help that says what an openid is and promises no screen (A7)", () => {
    const senders = step("sender-access").fields?.find((candidate) => candidate.key === "allowedSenders");

    expect(senders?.explanation).toBe(
      "Add the QQ openids (the ids QQ assigns to senders, not QQ numbers) that may start conversations. Inbound is default-deny; empty means every inbound sender is denied.",
    );
  });

  it("always saves an allowlist, whatever the draft says", () => {
    expect(guide().normalize(draftOf({ ...SEND_VALUES, inboundAccessMode: "open_legacy" }))).toMatchObject({
      inboundAccessMode: "allowlist",
    });
  });
});

describe("QQ Bot setup guide: the test and finishing (items 5, 8, R49)", () => {
  it("says what the test sends, only with a default target, that it stays, and what a refusal means", () => {
    expect(paragraphs("test")).toEqual([
      "The test asks QQ for an access token with your AppID and AppSecret and reads the bot's name. If you set a default target, it also sends one message there: \"GoatCitadel channel setup verification.\" The test doesn't delete it, so check that it arrived. With no default target, nothing is sent.",
      "QQ limits messages a bot sends unprompted, so a refusal of that message can be a limit, not a problem with your credentials.",
    ]);
    expect(paragraphs("test")[0]).toContain(TEST_MESSAGE);
  });

  it("finishes by saving for sending, points receiving at the last step, and tells group and one-to-one openids apart", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection so GoatCitadel can send from it and, once QQ is pointed at its webhook address, hear messages. The last step shows what to set in QQ.",
      "A group member's openid and a one-to-one user's openid are different: allow each one you need.",
    ]);
  });

  it("no longer says delivery can be confirmed by hand, which nothing checks (item 8)", () => {
    expect(step("finish").successCriteria).toEqual([
      "QQ issued an access token for the AppID and AppSecret.",
      "If you set a default target, the test message arrived.",
    ]);
    expect(wizardText()).not.toMatch(/confirmed delivery manually/u);
  });
});

describe("QQ Bot setup guide: when the test fails (A13)", () => {
  const items = () => step("test").troubleshooting ?? [];
  const body = (id: string) => items().find((item) => item.id === id)?.body ?? "";
  const title = (id: string) => items().find((item) => item.id === id)?.title ?? "";

  it("lists the failures a QQ setup really hits, on the test step", () => {
    expect(items().map((item) => item.id)).toEqual([
      "credentials-rejected",
      "host-not-allowed",
      "message-refused",
      "ip-whitelist",
      "variable-not-found",
      "no-reply",
    ]);
  });

  it("matches what the test says when QQ refuses the AppID and AppSecret", () => {
    expect(title("credentials-rejected")).toBe("It says QQ refused the app id and secret");
    expect(body("credentials-rejected")).toBe(
      "Check that the AppID and the AppSecret come from the same bot, and paste the AppSecret again in case a space came with it. If you used a variable, check its name below.",
    );
  });

  it("names the Allow these hosts button and the hosts", () => {
    expect(title("host-not-allowed")).toBe("It says a QQ host is outside the network allowlist");
    expect(body("host-not-allowed")).toBe(
      "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add bots.qq.com and api.bot.qq.com (and sandbox.api.sgroup.qq.com when Test mode is on), then run the test again.",
    );
  });

  it("sends a refused test message to an empty Default target, which is how to finish (active-message refusal)", () => {
    expect(title("message-refused")).toBe("It says QQ rejected the test message");
    expect(body("message-refused")).toBe(
      "QQ limits the messages a bot sends unprompted, and a person can turn them off in QQ. Leave Default target empty, run the test again and finish. Add a target later with Edit setup, after you've messaged the bot. If you keep one, check its format: group:<openid>, user:<openid>, channel:<id> or dm:<guild id>.",
    );
  });

  it("says QQ's server IP whitelist applies to this computer too, citing QQ's page", () => {
    expect(title("ip-whitelist")).toBe("You turned on QQ's server IP whitelist");
    expect(body("ip-whitelist")).toBe(
      "With a server IP whitelist, only the addresses on it can call the bot's API. Add this computer's public IP (search 'what is my IP'), or remove the whitelist in QQ.",
    );
  });

  it("gives the variable name rule and the restart", () => {
    expect(body("variable-not-found")).toBe(
      "A variable's name must start with QQBOT_ (for example QQBOT_APP_SECRET) and end in _TOKEN or _SECRET, and you must restart GoatCitadel after you set it. Or paste the AppSecret instead.",
    );
  });

  it("points a silent bot at the callback, the four events, the allowed openid, the @-mention, and a reachable running Gateway", () => {
    const noReply = body("no-reply");

    expect(title("no-reply")).toBe("You message the bot and nothing comes back");
    for (const event of EVENTS) expect(noReply).toContain(event);
    expect(noReply).toContain("Finish setup first, then save the callback address in QQ");
    expect(noReply).toContain("only answers once the connection is finished and on");
    expect(noReply).toContain("Allow your openid under Who may message this bot");
    expect(noReply).toContain("In a group, @-mention the bot");
    expect(noReply).toContain("GoatCitadel must be running");
  });
});

describe("QQ Bot setup guide: asking for what is missing (A15)", () => {
  it("asks for the app secret, and jumps to the pasted field", () => {
    expect(guide().validate(draftOf({ appId: APP_ID }))).toEqual([
      expect.objectContaining({
        key: "qqbot_auth_missing",
        fieldKey: "appSecret",
        level: "error",
        message: "Paste the QQ Bot app secret.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("does not ask when a pasted secret, a variable name or a saved secret is there", () => {
    const saved = draftOf(
      { appId: APP_ID },
      { hydration: { status: "opaque-secret", fieldState: { appSecret: "configured" }, warnings: [] } },
    );

    expect(guide().validate(draftOf(SEND_VALUES))).toEqual([]);
    expect(guide().validate(draftOf({ appId: APP_ID, appSecretEnv: "QQBOT_APP_SECRET" }))).toEqual([]);
    expect(guide().validate(saved)).toEqual([]);
  });

  it("still asks for the App ID and refuses a target that isn't group:, user:, channel: or dm:", () => {
    expect(guide().validate(draftOf({ appSecret: APP_SECRET }))).toEqual([
      expect.objectContaining({ key: "appId_required", fieldKey: "appId", message: "App ID is required." }),
    ]);
    expect(guide().validate(draftOf({ ...SEND_VALUES, defaultTarget: "guild:1" }))).toEqual([
      expect.objectContaining({
        key: "defaultTarget_malformed",
        fieldKey: "defaultTarget",
        message: "Targets start with group:, user:, channel: or dm: followed by the id, for example user:<openid>.",
      }),
    ]);
  });
});

describe("QQ Bot send-only path: can it finish?", () => {
  it("lets Continue pass with an App ID and a pasted App secret, and asks for nothing about receiving", () => {
    expect(continueBlockers(SEND_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(SEND_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test with no default target: QQ gives a token, and nothing is sent", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { issues, live, deps, eligibility } = await accepting.verdictOf(config);
    const requests = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls.map(([url]) => new URL(url).href);
    const tokenRequest = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls[0];

    expect(config).toEqual({ ...SEND_VALUES, inboundAccessMode: "allowlist" });
    expect(requests).toEqual(["https://bots.qq.com/app/getAppAccessToken", "https://api.bot.qq.com/users/@me"]);
    expect(JSON.parse(String(tokenRequest?.[1]?.body))).toEqual({ appId: APP_ID, clientSecret: APP_SECRET });
    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["qqbot_auth", "pass"],
      ["qqbot_bot", "pass"],
      ["qqbot_sandbox_send", "skipped"],
    ]);
    // Nobody is allowed to message the bot yet and no target is set: the Gateway doesn't hold Finalize back for either.
    expect(issues.map((issue) => issue.key).sort()).toEqual(["inbound_access_allowlist_empty", "target"]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("sends the test message when a default target is set, says so plainly, and is cleared once QQ accepts it", async () => {
    const config = guide().normalize(draftOf({ ...SEND_VALUES, defaultTarget: TARGET }));
    const { live, deps, eligibility } = await accepting.verdictOf(config);
    const send = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls.find(([url]) => url.includes("/messages"));

    expect(send?.[0]).toBe(`https://api.bot.qq.com/v2/users/${OPENID}/messages`);
    expect(JSON.parse(String(send?.[1]?.body))).toMatchObject({ content: TEST_MESSAGE });
    expect(live.probe?.steps.find((candidate) => candidate.key === "qqbot_sandbox_send")).toMatchObject({
      status: "pass",
      label: "Test message",
      message: "QQ accepted the test message. Check that it arrived.",
    });
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
    expect(paragraphs("test")[0]).toContain("The test doesn't delete it, so check that it arrived.");
  });

  it("holds Finalize back when QQ refuses the test message, says so without 'sandbox', and the guide names the way out", async () => {
    const withTarget = guide().normalize(draftOf({ ...SEND_VALUES, defaultTarget: TARGET }));
    const { live, eligibility } = await refusingMessage.verdictOf(withTarget);
    const step403 = live.probe?.steps.find((candidate) => candidate.key === "qqbot_sandbox_send");

    expect(eligibility.allowed).toBe(false);
    expect(step403).toMatchObject({
      status: "fail",
      label: "Test message",
      message:
        "QQ rejected the test message (HTTP 403). QQ limits messages a bot sends unprompted. Message the bot first, check the target, or leave Default target empty.",
    });
    expect(step("test").troubleshooting?.find((item) => item.id === "message-refused")?.body).toContain(
      "Leave Default target empty",
    );

    // That is the way out: with the target emptied the same QQ lets the setup finish.
    const withoutTarget = guide().normalize(draftOf(SEND_VALUES));
    expect((await refusingMessage.verdictOf(withoutTarget)).eligibility.allowed).toBe(true);
  });

  it("holds Finalize back when QQ refuses the AppID and AppSecret, and the guide names the fix", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { eligibility } = await refusingCredentials.verdictOf(config);

    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons.join("\n")).toContain(
      "QQBot credentials rejected: QQ refused the app id and secret.",
    );
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("credentials-rejected");
  });

  it("holds Finalize back while a QQ host is not allowed, and the guide names the button", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const deps = { ...port(), isConnectionUrlAllowlisted: vi.fn(() => false) };
    const live = await runIntegrationConnectionLiveChecks(deps, connectionOf(config), { includeSandboxSend: true });

    expect(live.checks).toEqual([
      expect.objectContaining({
        key: "qqbot_network",
        status: "fail",
        message: "The QQBot host bots.qq.com is outside the network allowlist.",
      }),
    ]);
    expect(step("test").troubleshooting?.find((item) => item.id === "host-not-allowed")?.body).toContain(
      "Allow these hosts",
    );
  });

  it("uses QQ's sandbox host for the bot name and the message in Test mode, and is cleared", async () => {
    const config = guide().normalize(draftOf({ ...SEND_VALUES, sandbox: true, defaultTarget: TARGET }));
    const { deps, eligibility } = await accepting.verdictOf(config);
    const hosts = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls.map(([url]) => new URL(url).hostname);

    expect(config).toMatchObject({ sandbox: true });
    expect(hosts).toEqual(["bots.qq.com", "sandbox.api.sgroup.qq.com", "sandbox.api.sgroup.qq.com"]);
    expect(eligibility.allowed).toBe(true);
  });

  it("asks this path to tick nothing: the guide has no checklist boxes at all (R50)", () => {
    // Continue is blocked until every checklist box is ticked. QQ needs nothing set up inside QQ before the test that
    // the person can't do on this page, so a send-only setup is never asked for a receiving step.
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
    const config = guide().normalize(draftOf({ appId: APP_ID, appSecretEnv: "QQBOT_APP_SECRET" }));
    const previous = process.env.QQBOT_APP_SECRET;
    process.env.QQBOT_APP_SECRET = APP_SECRET;
    try {
      const structural = buildIntegrationConnectionChecks(port(), connectionOf(config));

      // Nobody is allowed to message the bot yet and no target is set: not setup problems (see the test above).
      expect(
        structural.filter(
          (check) => check.status !== "pass" && !["inbound_access_allowlist_empty", "target"].includes(check.key),
        ),
      ).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.QQBOT_APP_SECRET;
      else process.env.QQBOT_APP_SECRET = previous;
    }
  });
});

describe("QQ Bot receiving path: can it finish?", () => {
  it("lets Continue pass with the same two values: the allowed openids are optional", () => {
    expect(continueBlockers(RECEIVING_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(RECEIVING_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test with an allowed openid, and no empty-list note", async () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const { issues, eligibility } = await accepting.verdictOf(config);

    // Senders are kept in lower case and matched without regard to case, so the openid can be pasted as QQ shows it.
    expect(config).toMatchObject({ inboundAccessMode: "allowlist", allowedSenders: [OPENID.toLowerCase()] });
    expect(issues.map((issue) => issue.key)).not.toContain("inbound_access_allowlist_empty");
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("tells QQ to subscribe to exactly the four events GoatCitadel hears, and ignores the rest", () => {
    const text = paragraphs("first-message")[0] ?? "";
    const author = { user_openid: OPENID, member_openid: OPENID, id: "U1" };
    const heard = EVENTS.map((t) =>
      normalizeQqbotWebhookPayload({
        connectionId: "c1",
        payload: {
          op: 0,
          t,
          id: "E1",
          d: { id: "M1", content: "hi", author, group_openid: "G1", channel_id: "CH1", guild_id: "GU1" },
        },
      }),
    );

    for (const event of EVENTS) expect(text).toContain(event);
    expect(heard.map((result) => result.kind)).toEqual(["message", "message", "message", "message"]);
    expect(
      normalizeQqbotWebhookPayload({ connectionId: "c1", payload: { op: 0, t: "GROUP_MESSAGE_CREATE", d: {} } }).kind,
    ).toBe("ignore");
  });

  it("lets a listed openid in and keeps everyone else out: a group's openid is not its members' openid", () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const groupEvent = normalizeQqbotWebhookPayload({
      connectionId: "c1",
      payload: {
        op: 0,
        t: "GROUP_AT_MESSAGE_CREATE",
        id: "E1",
        d: { id: "M1", content: "hi", group_openid: "GROUPOPENID", author: { member_openid: "MEMBEROPENID" } },
      },
    });

    expect(evaluateChannelInboundAccess({ config, actorId: OPENID })).toMatchObject({ allowed: true });
    expect(evaluateChannelInboundAccess({ config, actorId: "SOMEONEELSE" })).toMatchObject({ allowed: false });
    expect(groupEvent).toMatchObject({ kind: "message", actorId: "MEMBEROPENID", target: "group:GROUPOPENID" });
    expect(evaluateChannelInboundAccess({ config, actorId: "GROUPOPENID" })).toMatchObject({ allowed: false });
  });

  it("pins the one thing left: nothing in GoatCitadel shows a sender's openid yet, and the guide says so (C9)", () => {
    // A person who doesn't know their openid can't finish receiving. Part C item C9 (the sender id in the dropped-message
    // diagnostic, PR 4) is what fixes that; until then the guide says it plainly instead of promising a screen.
    expect(paragraphs("overview")).toContain(
      "QQ doesn't show your openid, and GoatCitadel can't show it yet either. Until it can, use this connection for sending unless you already know your openid.",
    );
    expect(paragraphs("first-message")[0]).toContain("GoatCitadel can't show your openid yet");
  });

  it("does not make an edit replay the setup-only steps", () => {
    expect(continueBlockers(RECEIVING_VALUES, "edit")).toEqual([]);
    expect(continueBlockers({}, "edit")).toEqual([
      "App ID",
      "App secret or App secret from an environment variable (advanced)",
    ]);
  });
});
