import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

const { draftOf, connectionOf, verdictOf } = guideFinish("channel.google-chat");

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
      "Incoming webhook: check the test message appeared in the space. Chat app: paste this connection's webhook address into the Chat app's HTTP endpoint URL, allow your users/… id, then message the app and check the reply.",
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

  it("keeps the sender help it already had", () => {
    const allowed = step("sender-access").fields?.find((candidate) => candidate.key === "allowedSenders");

    expect(allowed?.explanation).toBe(
      "Chat app mode only: add Google Chat user resource names such as users/123456789. Webhook mode never receives messages. Empty means every inbound sender is denied.",
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

  it("says to pick the project number now and paste this connection's address after finishing", () => {
    expect(paragraphs("create-webhook")).toContain(
      "Pick Project number as the audience (the endpoint-URL audience needs this connection's address, which you only get after finishing). After you finish, paste this connection's webhook address into the Chat app's HTTP endpoint URL.",
    );
  });

  it("says a Chat app needs the person's own public HTTPS address, without naming one", () => {
    expect(paragraphs("create-webhook")).toContain(
      "GoatCitadel doesn't provide a public address. A Chat app needs your own public HTTPS address (a reverse proxy or tunnel) in front of this Gateway.",
    );
  });

  it("keeps the audience fields honest about the address that does not exist yet", () => {
    expect(field("audienceType").explanation).toContain("only get after you finish");
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
    const step1 = step("collect-values-identity");
    // How the wizard words it: the labels of the alternatives that have a field, joined with " or ".
    const shown = (step1.requiredAnyOf?.[0] ?? []).flatMap((key) => {
      const found = guide()
        .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
        .find((candidate) => candidate.key === key);
      return found ? [found.label] : [];
    });

    expect(shown.join(" or ")).toBe(
      "Incoming webhook URL or Service-account key (paste the JSON) or Service-account key from an environment variable (advanced)",
    );
  });

  it("accepts a Chat app whose key is pasted and kept in secure storage", () => {
    const { serviceAccountKeyEnv: _env, ...rest } = APP_VALUES;
    const pasted = draftOf(rest, { secretState: { serviceAccountKey: { configured: true, custody: "temporary" } } });

    expect(guide().validate(pasted)).toEqual([]);
    expect(guide().normalize(pasted)).toMatchObject({ inboundAccessMode: "allowlist" });
  });
});

describe("Google Chat setup guide: the test and finishing (item 9)", () => {
  it("says what the test does in each mode, and not to expect a Google check for a Chat app", () => {
    expect(paragraphs("test")).toEqual([
      "Incoming webhook: GoatCitadel sends one test message into the space. Check that it appears.",
      "Chat app: GoatCitadel checks that the key is set and the audience looks right; it doesn't contact Google in this mode. After you finish, message the app from an allowed sender and check its reply.",
    ]);
    expect(JSON.stringify(step("test").body)).not.toMatch(/sandbox/iu);
  });

  it("finishes on the message that already arrived, or on a message to the app", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection. For an incoming webhook, the test already posted a message; check that it appeared in the space. For a Chat app, finish first, then message the app from an allowed sender and check its reply.",
    ]);
    expect(step("finish").successCriteria).toEqual([
      "An incoming webhook URL or a service-account key is set.",
      "A Chat app has an audience that matches the Chat app's setting.",
      "The test message appeared in the space, or the Chat app replied.",
    ]);
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
        "thread-key-missing",
        "app-not-checked",
        "no-reply",
        "key-not-found",
      ]),
    );
  });

  it("points a silent Chat app at the endpoint address, the audience and the allowed sender", () => {
    const noReply = (step("test").troubleshooting ?? []).find((item) => item.id === "no-reply")?.body ?? "";

    expect(noReply).toContain("HTTP endpoint URL");
    expect(noReply).toContain("audience");
    expect(noReply).toContain("Who may message this bot");
    expect(noReply).toContain("public HTTPS address");
  });

  it("says what Chat app mode does today: Finalize stays off, so it doesn't call that expected or say to finish (R61)", () => {
    // Until PR 4 (C2b, decision N3) turns the Gateway's 'no probe' warning into an advisory, a Chat app can't be
    // finalized, and the 'Google Chat app path: can it finish?' pin below says so. PR 4 changes this text and that pin together.
    const item = (step("test").troubleshooting ?? []).find((candidate) => candidate.id === "app-not-checked");

    expect(item?.title).toBe("It says Chat app mode has no probe");
    expect(item?.body).toBe(
      "GoatCitadel can't check a Chat app yet, so Finalize stays off in Chat app mode for now. Use webhook mode to send now.",
    );
    expect(item?.body).not.toMatch(/expected|Finish setup/u);
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
  it("finishes when the optional thread key is filled in (the workaround the test step names)", async () => {
    const config = guide().normalize(
      draftOf({ mode: "webhook", webhookUrl: WEBHOOK_URL, defaultThreadKey: "goatcitadel" }),
    );
    const { issues, eligibility } = await verdictOf(config);

    expect(
      guide().validate(draftOf({ mode: "webhook", webhookUrl: WEBHOOK_URL, defaultThreadKey: "goatcitadel" })),
    ).toEqual([]);
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("is held back without a thread key by a Gateway check that Part C (C2, PR 4) removes", async () => {
    const config = guide().normalize(draftOf({ mode: "webhook", webhookUrl: WEBHOOK_URL }));
    const { eligibility } = await verdictOf(config);

    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons).toEqual(["Default Google Chat thread key is missing."]);
  });

  it("names that workaround on the test step", () => {
    const item = (step("test").troubleshooting ?? []).find((candidate) => candidate.id === "thread-key-missing");

    expect(item?.body).toContain("Advanced connection options");
    expect(item?.body).toContain("Optional default thread key");
  });
});

describe("Google Chat app path: can it finish?", () => {
  it("passes the guide's own validation with a key, an audience and a space", () => {
    expect(guide().validate(draftOf(APP_VALUES))).toEqual([]);
  });

  it("is held back by the Gateway's 'no probe' warning that Part C (C2b, PR 4, decision N3) turns into an advisory", async () => {
    // A pasted key is saved as a secret reference, which the structural check counts as set.
    const { serviceAccountKeyEnv: _env, ...rest } = APP_VALUES;
    const config = guide().normalize(draftOf({ ...rest, serviceAccountKey: "secret-reference" }));
    const { eligibility } = await verdictOf(config);

    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons).toEqual([
      "Chat app (service-account) mode can't send a test message. Message the app from an allowed sender and confirm its reply in Google Chat.",
    ]);
  });
});
