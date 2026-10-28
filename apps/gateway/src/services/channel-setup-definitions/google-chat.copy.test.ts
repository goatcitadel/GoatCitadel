import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelSetupFieldDefinition,
  ChannelSetupHostRule,
  ChannelSetupRichBlock,
  ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
import { listChannelSetupDefinitions, requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { guideFinish } from "./guide-finish.test-support.js";

function guide() {
  return requireChannelSetupDefinition("channel.google-chat");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Google Chat guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Google Chat guide has no field ${key}`);
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

const { draftOf, connectionOf, continueBlockers, verdictOf } = guideFinish("channel.google-chat");

const WEBHOOK_URL = "https://chat.googleapis.com/v1/spaces/AAAAxxxx/messages?key=synthetic-key&token=synthetic-token";
const APP_VALUES = {
  mode: "app",
  serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
  audienceType: "project_number",
  audience: "123456789012",
  defaultSpace: "spaces/AAAAxxxx",
};

describe("Google Chat setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    const text = JSON.stringify(guide().definition.wizard);

    expect(text).not.toMatch(/posture|provenance|ingress|egress|sandbox message|activation plan/iu);
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/https:\/\/<your public address>/u);
  });

  it("never says Finalize stays off, or sends a Chat app to webhook mode to get past setup", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /Finalize stays off|stays off in Chat app mode|Use webhook mode to send now/iu,
    );
  });
});

describe("Google Chat setup guide: no key-shaped example text", () => {
  // The secret scanner (trivy) flags this exact JSON key/value pair as a Google service-account key. It tolerates
  // whitespace and the backslashes a JSON.stringify adds, so this one pattern finds it in source text and in a built guide.
  const SERVICE_ACCOUNT_KEY_JSON = /type\\?"\s*:\s*\\?"service_account/u;

  it("describes the key file in plain words instead of showing key JSON", () => {
    expect(field("serviceAccountKey").looksLike).toBe(
      "The whole JSON key file from Google Cloud. It starts with { and names your project and the service account's email.",
    );
  });

  it("holds the service-account JSON pattern in no channel setup guide", () => {
    const holding = listChannelSetupDefinitions()
      .filter((definition) => SERVICE_ACCOUNT_KEY_JSON.test(JSON.stringify(definition)))
      .map((definition) => definition.catalog.key);

    expect(holding).toEqual([]);
  });

  it("holds the service-account JSON pattern in no channel setup definition source file", () => {
    const folder = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(folder).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

    const holding = sources.filter((name) => SERVICE_ACCOUNT_KEY_JSON.test(readFileSync(join(folder, name), "utf8")));

    expect(sources).toContain("google-chat.ts");
    expect(holding).toEqual([]);
  });
});

describe("Google Chat setup guide: what it says up front (item 9)", () => {
  it("opens with the intro, prerequisites and first message from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Incoming webhook: send messages into one Google Chat space (sends only). Chat app: send and receive, with a Google Cloud project and a public HTTPS address.",
    );
    expect(wizard.prerequisites).toEqual([
      "Incoming webhook: a Google Workspace Business or Enterprise account and permission to add webhooks to the space.",
      "Chat app: a Google Cloud project with the Chat API on, a service account key, and a public HTTPS address for this Gateway.",
      "Chat app: the Google user ids (users/…) allowed to message it.",
    ]);
    expect(paragraphs("first-message")).toEqual([
      "Incoming webhook: check the test message appeared in the space. Chat app: paste this connection's webhook address into the Chat app's HTTP endpoint URL, allow your users/… id, then message the app and check the reply. If the bot doesn't answer your message, open System › Diagnostics, find \"Dropped a Google Chat message from …\", and add that id under Who may message this bot with Edit setup.",
    ]);
  });
});

describe("Google Chat setup guide: one mode field (item 4)", () => {
  it("starts the connection fields with a Connect with choice between the two products", () => {
    const mode = field("mode");

    expect(fieldKeys("collect-values-identity")[0]).toBe("mode");
    expect(mode.label).toBe("Connect with");
    expect(mode.type).toBe("select");
    expect(mode.required).toBe(true);
    expect(mode.defaultValue).toBe("webhook");
    expect(mode.options).toEqual([
      { value: "webhook", label: "Incoming webhook (sends only)" },
      { value: "app", label: "Chat app (sends and receives)" },
    ]);
  });

  it("shows each field only for the mode it belongs to", () => {
    const forWebhook = { fieldKey: "mode", value: "webhook" };
    const forApp = { fieldKey: "mode", value: "app" };

    for (const key of ["webhookUrl", "defaultThreadKey"]) {
      expect(field(key).visibleWhenFieldEquals, key).toEqual(forWebhook);
    }
    for (const key of [
      "serviceAccountKey",
      "serviceAccountKeyEnv",
      "audienceType",
      "audience",
      "addOnProjectNumber",
      "defaultSpace",
    ]) {
      expect(field(key).visibleWhenFieldEquals, key).toEqual(forApp);
    }
    expect(field("mode").visibleWhenFieldEquals).toBeUndefined();
  });

  it("derives the mode of a saved connection from which keys it has", () => {
    const modeOf = (config: Record<string, unknown>) => guide().hydrate(connectionOf(config)).draft.mode;

    expect(modeOf({ webhookUrl: WEBHOOK_URL })).toBe("webhook");
    expect(modeOf({})).toBe("webhook");
    expect(modeOf({ serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audience: "123456789012" })).toBe("app");
    expect(modeOf({ serviceAccountKey: "secret-reference", audience: "123456789012" })).toBe("app");
  });

  it("does not save the mode: the keys it chose are the saved mode", () => {
    const webhook = guide().normalize(draftOf({ mode: "webhook", webhookUrl: WEBHOOK_URL }));
    const app = guide().normalize(draftOf(APP_VALUES));

    expect(webhook).not.toHaveProperty("mode");
    expect(app).not.toHaveProperty("mode");
    expect(webhook).toMatchObject({ webhookUrl: WEBHOOK_URL });
    expect(app).toMatchObject({ serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audience: "123456789012" });
  });

  it("saves only the chosen mode's fields and clears the other's (null), so a changed mind leaves no mixed connection", () => {
    const appWithOldWebhook = guide().normalize(
      draftOf({ ...APP_VALUES, webhookUrl: WEBHOOK_URL, defaultThreadKey: "ops" }),
    );
    const webhookWithOldApp = guide().normalize(draftOf({ ...APP_VALUES, mode: "webhook", webhookUrl: WEBHOOK_URL }));

    expect(appWithOldWebhook).toMatchObject({ webhookUrl: null, defaultThreadKey: null });
    expect(webhookWithOldApp).toEqual(expect.objectContaining({ webhookUrl: WEBHOOK_URL }));
    for (const key of ["serviceAccountKeyEnv", "audienceType", "audience", "defaultSpace"]) {
      expect(webhookWithOldApp[key], key).toBeNull();
    }
  });

  it("keeps a draft with no mode working: the key it holds says it is a Chat app", () => {
    const { mode: _mode, ...legacy } = APP_VALUES;

    expect(guide().validate(draftOf(legacy))).toEqual([]);
    expect(guide().normalize(draftOf(legacy))).toMatchObject({
      serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY",
      inboundAccessMode: "allowlist",
    });
    expect(guide().validate(draftOf({ webhookUrl: WEBHOOK_URL }))).toEqual([]);
  });

  it("asks who may message the app only in Chat app mode, with no access-mode choice", () => {
    const sender = step("sender-access");

    expect(sender.visibleWhenFieldEquals).toEqual({ fieldKey: "mode", value: "app" });
    expect(sender.fields?.map((candidate) => candidate.key)).toEqual(["allowedSenders"]);
  });

  it("shows the default space step only in Chat app mode, because it holds nothing else", () => {
    expect(fieldKeys("collect-values-destinations")).toEqual(["defaultSpace"]);
    expect(step("collect-values-destinations").visibleWhenFieldEquals).toEqual({ fieldKey: "mode", value: "app" });
    expect(step("collect-values-identity").visibleWhenFieldEquals).toBeUndefined();
  });

  it("hides no other guide's destinations step: only a step whose every field shares a condition is hidden", () => {
    const hidden = listChannelSetupDefinitions()
      .filter((definition) =>
        definition.wizard.steps.some(
          (candidate) => candidate.id.endsWith("-destinations") && candidate.visibleWhenFieldEquals,
        ),
      )
      .map((definition) => definition.catalog.key)
      .sort();

    expect(hidden).toEqual(["google-chat"]);
  });

  it("keeps the sender help it already had and says where to find a user's id", () => {
    const allowed = step("sender-access").fields?.find((candidate) => candidate.key === "allowedSenders");

    expect(allowed?.explanation).toBe(
      'Chat app mode only: add Google Chat user resource names such as users/123456789. Webhook mode never receives messages. Empty means every inbound sender is denied. Don\'t know the id? Message the bot once, then open System › Diagnostics and find "Dropped a … message from …".',
    );
  });
});

/** The rule `channelHosts` in Mission Control applies: a field set (and equal to `equals`, when given). */
function hostRuleHolds(rule: ChannelSetupHostRule, values: Record<string, unknown>): boolean {
  return rule.whenAnyFieldSet.some(
    (key) => Boolean(values[key]) && (rule.equals === undefined || values[key] === rule.equals),
  );
}

describe("Google Chat setup guide: the host and webhook rules agree with the mode", () => {
  it("adds Google's token host while the mode is Chat app, not while a stale key is left behind", () => {
    const rules = guide().definition.wizard.conditionalHosts ?? [];
    const tokenHost = rules.filter((rule) => rule.host === "oauth2.googleapis.com");

    expect(rules).toHaveLength(1);
    expect(tokenHost[0]).toEqual({ host: "oauth2.googleapis.com", whenAnyFieldSet: ["mode"], equals: "app" });
    expect(hostRuleHolds(tokenHost[0]!, { mode: "app" })).toBe(true);
    expect(hostRuleHolds(tokenHost[0]!, { mode: "webhook", serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY" })).toBe(false);
    expect(hostRuleHolds(tokenHost[0]!, { mode: "webhook" })).toBe(false);
  });

  it("hydrates a saved Chat app as the mode its host rule needs", () => {
    const hydrated = guide().hydrate(connectionOf({ serviceAccountKeyEnv: "GOOGLE_CHAT_SA_KEY", audience: "1234567" }));
    const [rule] = guide().definition.wizard.conditionalHosts ?? [];

    expect(hostRuleHolds(rule!, hydrated.draft)).toBe(true);
  });

  it("shows the webhook address from what a saved Chat app carries, which a saved connection has", () => {
    const inbound = guide().definition.wizard.inboundWebhook;
    const saved = guide().normalize(draftOf(APP_VALUES));
    const savedWebhook = guide().normalize(draftOf({ mode: "webhook", webhookUrl: WEBHOOK_URL }));

    expect(inbound?.whenAnyFieldSet).toEqual(["serviceAccountKeyEnv", "serviceAccountKey", "audience"]);
    expect(inbound?.whenFieldEquals).toBeUndefined();
    expect(inbound?.whenAnyFieldSet?.some((key) => Boolean(saved[key]))).toBe(true);
    expect(inbound?.whenAnyFieldSet?.some((key) => Boolean(savedWebhook[key]))).toBe(false);
  });

  it("shows it in the wizard for a Chat app whose key was pasted, which the draft values do not hold", () => {
    const inbound = guide().definition.wizard.inboundWebhook;
    const pasted = guide().hydrate(connectionOf({ serviceAccountKey: "secret-reference", audience: "123456789012" }));
    const webhook = guide().hydrate(connectionOf({ webhookUrl: WEBHOOK_URL }));

    expect(pasted.draft).not.toHaveProperty("serviceAccountKey");
    expect(inbound?.whenAnyFieldSet?.some((key) => Boolean(pasted.draft[key]))).toBe(true);
    expect(inbound?.whenAnyFieldSet?.some((key) => Boolean(webhook.draft[key]))).toBe(false);
  });

  it("keeps the webhook URL a real field the host list can read", () => {
    expect(guide().definition.wizard.hostFields).toEqual(["webhookUrl"]);
  });
});

describe("Google Chat setup guide: the incoming webhook (items 3 and 5)", () => {
  it("names the field for what it is, apart from the Chat app's webhook address", () => {
    expect(field("webhookUrl").label).toBe("Incoming webhook URL");
  });

  it("says who can make a webhook and how, on a computer", () => {
    expect(paragraphs("create-webhook")).toContain(
      "Incoming webhook. Needs a Google Workspace Business or Enterprise account, and your admin must allow webhooks. Personal Gmail accounts can't add them. On a computer: open the space › its name › Apps & integrations › Add webhooks › name it › Save › More › Copy link.",
    );
    expect(textOf(step("create-webhook").body)).toContain(
      "https://developers.google.com/workspace/chat/quickstart/webhooks",
    );
  });

  it("asks only for what a person can do before finishing", () => {
    const create = step("create-webhook");

    expect(create.createOnly).toBe(true);
    expect((create.checklist ?? []).map((item) => item.label)).toEqual([
      "Open the Google Chat space you want to use",
      "Create the incoming webhook, or create the Chat app and its service account",
      "Copy the webhook link, or download the service account's JSON key",
    ]);
    expect(JSON.stringify(create.checklist)).not.toMatch(/endpoint/iu);
  });
});

describe("Google Chat setup guide: the Chat app (items 3 and 6)", () => {
  it("lists the steps to make a Chat app, in order", () => {
    expect(step("create-webhook").body).toContainEqual({
      kind: "list",
      ordered: true,
      items: [
        "In Google Cloud, create a project and turn on the Google Chat API.",
        "On the Chat API Configuration page set the app name, avatar and description, turn on interactive features, choose HTTP endpoint URL, choose the authentication audience, and set who can see it.",
        "Create a service account and download its JSON key.",
        "Add the app to your space.",
      ],
    });
    const text = textOf(step("create-webhook").body);
    expect(text).toContain("https://developers.google.com/workspace/chat/configure-chat-api");
    expect(text).toContain("https://developers.google.com/workspace/chat/authenticate-authorize-chat-app");
  });

  it("says to pick the project number now and, after finishing, paste this connection's address and message the app", () => {
    expect(paragraphs("create-webhook")).toContain(
      "Pick Project number as the audience (the endpoint-URL audience needs this connection's address, which the Verify the first conversation step shows before you finish). After you finish, paste this connection's webhook address into the Chat app's HTTP endpoint URL, then message the app from an allowed sender and check that it replies.",
    );
  });

  it("says a Chat app needs the person's own public HTTPS address, without naming one", () => {
    expect(paragraphs("create-webhook")).toContain(
      "GoatCitadel doesn't provide a public address. A Chat app needs your own public HTTPS address (a reverse proxy or tunnel) in front of this Gateway.",
    );
  });

  it("keeps the audience fields honest about where the address is shown: before Finalize, on the step that shows it (N4)", () => {
    const addressStep = guide().definition.wizard.steps.find((candidate) => candidate.stage === "first_message");
    const named = `the ${addressStep?.title} step shows before you finish`;

    // That step is the one that shows the Chat app's address, and the address exists once the draft does.
    expect(addressStep?.id).toBe("first-message");
    expect(addressStep?.title).toBe("Verify the first conversation");
    expect(guide().definition.wizard.inboundWebhook?.pathTemplate).toBe(
      "/api/v1/integrations/connections/{connectionId}/google-chat/webhook",
    );
    expect(field("audienceType").explanation).toContain(named);
    expect(paragraphs("create-webhook").join("\n")).toContain(named);
    // Nothing still says the address has to wait for Finalize to exist.
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/only get after/iu);
    expect(field("audience").explanation).toBe(
      "The Google Cloud project number. With the endpoint URL type, use this connection's public HTTPS webhook address instead.",
    );
  });
});

describe("Google Chat setup guide: the service-account key (item 7, A5)", () => {
  it("offers a pasted key first, in a field of its own", () => {
    const key = field("serviceAccountKey");
    const keys = fieldKeys("collect-values-identity");

    expect(key.label).toBe("Service-account key (paste the JSON)");
    expect(key.type).toBe("textarea");
    expect(key.sensitive).toBe(true);
    expect(key.required).toBe(false);
    expect(key.advanced).not.toBe(true);
    expect(keys.indexOf("serviceAccountKey")).toBeLessThan(keys.indexOf("serviceAccountKeyEnv"));
    expect(key.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
  });

  it("says where the JSON key comes from", () => {
    const text = textOf(field("serviceAccountKey").whereToFind);

    expect(text).toContain("IAM & Admin");
    expect(text).toContain("Service Accounts");
    expect(text).toContain("Add key");
    expect(text).toContain("JSON");
  });

  it("moves the variable name under Advanced and says its name rule", () => {
    const env = field("serviceAccountKeyEnv");

    expect(env.advanced).toBe(true);
    // The variable holds a name, not the JSON, so its label does not say to paste anything.
    expect(env.label).toBe("Service-account key from an environment variable (advanced)");
    expect(env.explanation).toBe(
      "Name of the environment variable that holds the whole JSON key. The variable's name must start with GOOGLE_CHAT_ (for example GOOGLE_CHAT_SERVICE_ACCOUNT_KEY). Set it where GoatCitadel starts, then restart GoatCitadel.",
    );
  });

  it("lets Continue pass on a pasted key, the variable, or a webhook link", () => {
    const alternatives = step("collect-values-identity").requiredAnyOf?.[0] ?? [];

    expect(alternatives).toEqual(
      expect.arrayContaining(["webhookUrl", "webhookUrlEnv", "serviceAccountKey", "serviceAccountKeyEnv"]),
    );
  });

  it("names each way in once when Continue is blocked, without repeating the paste hint", () => {
    // How the wizard words it: the fields shown for the chosen mode, and the pasted field alone for a paste-or-variable pair.
    const webhook = continueBlockers({ mode: "webhook" });
    const app = continueBlockers({ mode: "app" });

    expect(webhook).toContain("Incoming webhook URL");
    expect(app).toContain("Service-account key (paste the JSON)");
    for (const message of [...webhook, ...app]) expect(message).not.toMatch(/environment variable|(advanced)/u);
  });

  it("accepts a Chat app whose key is pasted and kept in secure storage", () => {
    const { serviceAccountKeyEnv: _env, ...rest } = APP_VALUES;
    const pasted = draftOf(rest, { secretState: { serviceAccountKey: { configured: true, custody: "temporary" } } });

    expect(guide().validate(pasted)).toEqual([]);
    expect(guide().normalize(pasted)).toMatchObject({ inboundAccessMode: "allowlist" });
  });
});

describe("Google Chat setup guide: the test and finishing (item 9)", () => {
  it("says what the test does in each mode, and that a Chat app gets no test message but can still finish", () => {
    expect(paragraphs("test")).toEqual([
      "Incoming webhook: GoatCitadel sends one test message into the space. Check that it appears.",
      "Chat app: GoatCitadel checks that the key is set and the audience looks right. It doesn't contact Google or send a test message in this mode, so the result carries a note about that. You can still finish. After you finish, message the app from an allowed sender and check that it replies.",
    ]);
    expect(JSON.stringify(step("test").body)).not.toMatch(/sandbox/iu);
  });

  it("finishes on the message that already arrived, or on a message to the app after finishing", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection. For an incoming webhook, the test already posted a message; check that it appeared in the space. A Chat app gets no test message. After you finish, message the app from an allowed sender and check that it replies.",
    ]);
    expect(step("finish").successCriteria).toEqual([
      "An incoming webhook URL or a service-account key is set.",
      "A Chat app has an audience that matches the Chat app's setting.",
      "Incoming webhook: the test message appeared in the space.",
    ]);
  });

  it("tells one story for a Chat app everywhere: finish, then message the app and check that it replies", () => {
    const story = [paragraphs("create-webhook"), paragraphs("test"), paragraphs("finish")]
      .flat()
      .filter((text) => /message the app/u.test(text));

    expect(story).toHaveLength(3);
    for (const text of story) {
      expect(text).toContain("After you finish");
      expect(text).toContain("message the app from an allowed sender and check that it replies");
    }
  });

  it("tells a person where to find the default space", () => {
    const text = textOf(field("defaultSpace").whereToFind);

    expect(text).toContain("spaces/");
    expect(text).toContain("https://mail.google.com/mail/u/0/#chat/space/");
    expect(text).toContain("https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces");
  });
});

describe("Google Chat setup guide: when the test fails (A13)", () => {
  it("lists the failures a Google Chat setup really hits, on the test step", () => {
    const ids = (step("test").troubleshooting ?? []).map((item) => item.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "webhook-refused",
        "incomplete-url",
        "host-not-allowed",
        "message-missing",
        "app-not-checked",
        "no-reply",
        "key-not-found",
      ]),
    );
  });

  it("does not list a thread-key workaround: the thread key is optional and nothing asks for it", () => {
    const items = step("test").troubleshooting ?? [];

    expect(items.map((item) => item.id)).not.toContain("thread-key-missing");
    expect(JSON.stringify(items)).not.toMatch(/Advanced connection options|still asks for one|thread key is missing/iu);
  });

  it("points a silent Chat app at the endpoint address, the audience and the allowed sender", () => {
    const noReply = (step("test").troubleshooting ?? []).find((item) => item.id === "no-reply")?.body ?? "";

    expect(noReply).toContain("HTTP endpoint URL");
    expect(noReply).toContain("audience");
    expect(noReply).toContain("Who may message this bot");
    expect(noReply).toContain("public HTTPS address");
  });

  it("says a Chat app finishes without a test message, and how to check it afterwards (decision N3)", () => {
    // The Gateway turns the 'can't send a test message' warning into an advisory, and the 'Google Chat app path: can
    // it finish?' pin below proves a Chat app can be finished, so this item says to finish and what to check after.
    const item = (step("test").troubleshooting ?? []).find((candidate) => candidate.id === "app-not-checked");

    expect(item?.title).toBe("It says GoatCitadel can't send a test message in Chat app mode");
    expect(item?.body).toBe(
      "That is expected. GoatCitadel can't send a test message in Chat app mode, and you can still finish setup. After you finish, message the app from an allowed sender and check that it replies. If it does not reply, see: You message the app and nothing comes back.",
    );
    expect(item?.body).not.toMatch(/probe|webhook mode/iu);
    expect((step("test").troubleshooting ?? []).map((candidate) => candidate.title)).toContain(
      "You message the app and nothing comes back",
    );
  });

  it("tells a person the allowed-hosts button covers both Google hosts in Chat app mode", () => {
    const hosts = (step("test").troubleshooting ?? []).find((item) => item.id === "host-not-allowed")?.body ?? "";

    expect(hosts).toContain("Allow these hosts");
    expect(hosts).toContain("chat.googleapis.com");
    expect(hosts).toContain("oauth2.googleapis.com");
  });
});

describe("Google Chat setup guide: asking for what is missing (A15)", () => {
  it("asks an empty incoming-webhook setup for the webhook URL, and jumps to the field", () => {
    const [issue] = guide().validate(draftOf({}));

    expect(issue).toMatchObject({
      key: "webhookUrl_required",
      fieldKey: "webhookUrl",
      message: "Paste the incoming webhook URL.",
    });
  });

  it("asks a Chat app with no key for the key, and jumps to the pasted field", () => {
    const issues = guide().validate(draftOf({ mode: "app", audience: "123456789012" }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "serviceAccountKey_required",
        fieldKey: "serviceAccountKey",
        message: "Paste the service-account key (the JSON file from Google Cloud).",
      }),
    ]);
  });

  it("does not ask a webhook setup whose link is only saved to paste it again", () => {
    const saved = draftOf({}, { secretState: { webhookUrl: { configured: true, custody: "temporary" } } });

    expect(guide().validate(saved)).toEqual([]);
  });

  it("refuses to turn a draft that already holds a service-account key into a webhook connection", () => {
    const holdsKey = draftOf(
      { mode: "webhook", webhookUrl: WEBHOOK_URL },
      { secretState: { serviceAccountKey: { configured: true, custody: "temporary" } } },
    );

    expect(guide().validate(holdsKey)).toEqual([
      expect.objectContaining({
        key: "mode_conflict",
        fieldKey: "mode",
        level: "error",
        message:
          "This draft already holds a service-account key, so it is a Chat app. Choose Chat app, or start a new connection.",
      }),
    ]);
  });

  it("still rejects a link that is not a Google Chat webhook", () => {
    expect(guide().validate(draftOf({ webhookUrl: "https://chat.google.com/not-a-webhook" }))).toEqual([
      expect.objectContaining({ fieldKey: "webhookUrl", failureCategory: "malformed_value" }),
    ]);
  });

  it("does not check the incoming webhook link for a Chat app", () => {
    expect(guide().validate(draftOf({ ...APP_VALUES, webhookUrl: "not a url" }))).toEqual([]);
  });
});

describe("Google Chat incoming webhook path: can it finish?", () => {
  it("finishes with just the webhook link: the optional thread key is not asked for", async () => {
    const values = { mode: "webhook", webhookUrl: WEBHOOK_URL };
    const { issues, eligibility } = await verdictOf(guide().normalize(draftOf(values)));

    expect(continueBlockers(values)).toEqual([]);
    expect(guide().validate(draftOf(values))).toEqual([]);
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("finishes the same way with a thread key, which only groups the messages", async () => {
    const values = { mode: "webhook", webhookUrl: WEBHOOK_URL, defaultThreadKey: "goatcitadel" };
    const { issues, eligibility } = await verdictOf(guide().normalize(draftOf(values)));

    expect(guide().validate(draftOf(values))).toEqual([]);
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("keeps the thread key an optional field that only matters for webhook mode", () => {
    const threadKey = field("defaultThreadKey");

    expect(threadKey.label).toBe("Optional default thread key");
    expect(threadKey.required).toBe(false);
    expect(threadKey.explanation).toBe(
      "Optional thread key for grouping outbound webhook messages into a stable thread.",
    );
    expect(threadKey.visibleWhenFieldEquals).toEqual({ fieldKey: "mode", value: "webhook" });
  });
});

describe("Google Chat app path: can it finish?", () => {
  // A pasted key is saved as a secret reference, which the structural check counts as set.
  const { serviceAccountKeyEnv: _env, ...appWithoutEnv } = APP_VALUES;
  const PASTED_APP_VALUES = { ...appWithoutEnv, serviceAccountKey: "secret-reference" };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the guide's own validation with a key, an audience and a space", () => {
    expect(guide().validate(draftOf(APP_VALUES))).toEqual([]);
  });

  it("finishes with a key, an audience and a space, and calls the missing test message an advisory", async () => {
    const { deps, issues, eligibility } = await verdictOf(guide().normalize(draftOf(PASTED_APP_VALUES)));

    expect(continueBlockers(PASTED_APP_VALUES)).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
    expect(issues.find((issue) => issue.key === "google_chat_app_live_send")).toMatchObject({
      level: "warn",
      disposition: "advisory",
      message:
        "GoatCitadel can't send a test message in Chat app mode. After you finish, message the app from an allowed sender and check that it replies.",
    });
    expect(deps.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("holds Finalize back until Google's token host is allowed too, which a Chat app needs and a webhook does not (C7)", async () => {
    const chatHostOnly = guideFinish("channel.google-chat", { networkAllowlist: ["chat.googleapis.com"] });

    const app = await chatHostOnly.verdictOf(guide().normalize(draftOf(PASTED_APP_VALUES)));
    const webhook = await chatHostOnly.verdictOf(
      guide().normalize(draftOf({ mode: "webhook", webhookUrl: WEBHOOK_URL })),
    );

    // The Chat app signs in at oauth2.googleapis.com; the missing test message stays an advisory, this one blocks.
    expect(app.issues.find((issue) => issue.key === "provider_hosts")).toEqual({
      key: "provider_hosts",
      level: "warn",
      message:
        "Real sends need oauth2.googleapis.com on the network allowlist. Use Allow these hosts in the guide, or add it in Settings.",
      disposition: "blocking",
    });
    expect(app.eligibility.allowed).toBe(false);
    expect(app.eligibility.blockingReasons).toEqual([
      "Real sends need oauth2.googleapis.com on the network allowlist. Use Allow these hosts in the guide, or add it in Settings.",
    ]);
    expect(webhook.eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
    // Both hosts allowed, as the button leaves them, and the Chat app finishes again.
    const bothHosts = guideFinish("channel.google-chat", {
      networkAllowlist: ["chat.googleapis.com", "oauth2.googleapis.com"],
    });
    expect((await bothHosts.verdictOf(guide().normalize(draftOf(PASTED_APP_VALUES)))).eligibility.allowed).toBe(true);
  });

  it("finishes with the key in an environment variable too", async () => {
    vi.stubEnv("GOOGLE_CHAT_SA_KEY", "synthetic-service-account-key");

    const { eligibility } = await verdictOf(guide().normalize(draftOf(APP_VALUES)));

    expect(continueBlockers(APP_VALUES)).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("shows the same variable name in the example and the placeholder, and finishes with that name", async () => {
    const env = field("serviceAccountKeyEnv");
    const example = /\(for example ([A-Z0-9_]+)\)/u.exec(env.explanation)?.[1];
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_KEY", "synthetic-service-account-key");
    const values = { ...APP_VALUES, serviceAccountKeyEnv: example };

    expect(example).toBeDefined();
    expect(env.placeholder).toBe(example);
    expect(continueBlockers(values)).toEqual([]);
    expect(guide().validate(draftOf(values))).toEqual([]);
    expect((await verdictOf(guide().normalize(draftOf(values)))).eligibility).toMatchObject({
      allowed: true,
      blockingReasons: [],
    });
  });

  it("finishes with no default space, which only defers the warning about it", async () => {
    const { defaultSpace: _space, ...noSpace } = PASTED_APP_VALUES;
    const { issues, eligibility } = await verdictOf(guide().normalize(draftOf(noSpace)));

    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
    expect(issues.find((issue) => issue.key === "target")).toMatchObject({ disposition: "deferred" });
  });

  it("does not finish without an audience: the advisory waives only the missing test message", async () => {
    const { audience: _audience, ...noAudience } = PASTED_APP_VALUES;
    const { eligibility } = await verdictOf(guide().normalize(draftOf(noAudience)));

    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons).toEqual(["Google Chat app audience is missing."]);
  });
});
