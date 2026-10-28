import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSetupFieldDefinition,
  ChannelSetupRichBlock,
  ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { buildIntegrationConnectionChecks } from "../integration-diagnostics-service.js";
import { guideFinish } from "./guide-finish.test-support.js";

function guide() {
  return requireChannelSetupDefinition("channel.line");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`LINE guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`LINE guide has no field ${key}`);
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

const { draftOf, connectionOf, continueBlockers, port, verdictOf } = guideFinish("channel.line");

const USER_ID = "U0123456789abcdef0123456789abcdef";
const SEND_ONLY_VALUES = {
  channelAccessToken: "secret-reference",
  defaultTarget: USER_ID,
};
const RECEIVING_VALUES = {
  ...SEND_ONLY_VALUES,
  channelSecret: "secret-reference",
  allowedSenders: [USER_ID],
};

describe("LINE setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /posture|provenance|ingress|egress|sandbox message|activation plan/iu,
    );
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/https:\/\/<your public address>/u);
  });
});

describe("LINE setup guide: what it says up front (items 4 and 6)", () => {
  it("opens with the intro, prerequisites and first message from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Send LINE messages from your LINE Official Account. Receiving needs a public HTTPS address. Every message is a push message, which counts toward your plan's monthly limit.",
    );
    expect(wizard.prerequisites).toEqual([
      "A LINE Official Account with the Messaging API on, and its long-lived channel access token.",
      // Ruling R46: the audit's "with the Official Account added as a friend" is unverified, so it is not shipped.
      "Your LINE user ID (Developers Console › your channel › Basic settings).",
      "To receive: a public HTTPS address and the channel secret.",
    ]);
    expect(paragraphs("first-message")).toEqual([
      "Check the test message arrived. To receive: in LINE Developers Console › Messaging API set Webhook URL to this connection's webhook address, click Verify, turn on Use webhook, and turn off auto-reply and greeting messages in Official Account Manager. Allow your LINE user ID under Who may message this bot.",
    ]);
  });

  it("keeps the provider host and the inbound webhook route from the picker data", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.requiredHosts).toEqual(["api.line.me"]);
    expect(wizard.inboundWebhook?.pathTemplate).toBe("/api/v1/integrations/connections/{connectionId}/line/webhook");
  });

  it("says in the intro that receiving needs public HTTPS, and that every message counts toward the limit", () => {
    expect(paragraphs("overview")).toEqual([
      "GoatCitadel sends messages from your LINE Official Account through the Messaging API. LINE can send you messages only if it can reach your Gateway over public HTTPS. GoatCitadel doesn't provide that; without it this connection is send-only.",
      "This channel sends text. Attachments aren't supported.",
      "Every message GoatCitadel sends is a push message. Push messages count toward your plan's monthly limit, and the free plan's limit depends on your country.",
    ]);
    expect(textOf(step("overview").body)).toContain("https://developers.line.biz/en/docs/messaging-api/pricing/");
  });

  it("says once, in the overview, that this channel sends text and does not support attachments (R48)", () => {
    const sentence = "This channel sends text. Attachments aren't supported.";

    expect(paragraphs("overview")).toContain(sentence);
    expect(JSON.stringify(guide().definition.wizard).split(sentence).length - 1).toBe(1);
  });

  it("describes the beta note by what the test will do, not a 'sandbox push message'", () => {
    expect(textOf(step("overview").body)).toContain(
      "LINE is a guided beta lane. The setup test checks your channel access token live and will post a test message to your Default target.",
    );
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/sandbox/iu);
  });

  it("hides the setup-only intro when a saved connection is changed", () => {
    expect(step("overview").createOnly).toBe(true);
  });
});

describe("LINE setup guide: making the Official Account (item 2)", () => {
  it("adds a setup-only step before the fields that walks through the three vendor steps", () => {
    const create = step("create-account");

    expect(stepIds().indexOf("create-account")).toBeGreaterThan(stepIds().indexOf("overview"));
    expect(stepIds().indexOf("create-account")).toBeLessThan(stepIds().indexOf("collect-values-identity"));
    expect(create.createOnly).toBe(true);
    expect(create.kind).toBe("instruction");
    expect(create.body).toContainEqual({
      kind: "list",
      ordered: true,
      items: [
        "In LINE Official Account Manager, create an Official Account.",
        "Open its settings › Messaging API and turn it on.",
        "In LINE Developers Console, open the channel's Messaging API tab and issue a long-lived channel access token.",
      ],
    });
    expect(paragraphs("create-account")).toEqual([
      "You can't create a Messaging API channel straight from the LINE Developers Console any more. It starts from an Official Account.",
    ]);
    expect(textOf(create.body)).toContain("https://developers.line.biz/en/docs/messaging-api/getting-started/");
  });

  it("asks only for what a person can do before continuing", () => {
    expect((step("create-account").checklist ?? []).map((item) => item.label)).toEqual([
      "Create a LINE Official Account",
      "Turn on the Messaging API in its settings",
      "Issue a long-lived channel access token",
    ]);
  });

  it("says where the long-lived token is and that short-lived ones can't be renewed", () => {
    const text = textOf(field("channelAccessToken").whereToFind);

    expect(text).toContain(
      "Messaging API tab › Channel access token (long-lived). GoatCitadel can't renew short-lived tokens.",
    );
    expect(text).toContain("https://developers.line.biz/en/docs/basics/channel-access-token/");
  });

  it("says the channel secret is on the Basic settings tab", () => {
    expect(textOf(field("channelSecret").whereToFind)).toContain(
      "LINE Developers Console › your channel › Basic settings tab › Channel secret.",
    );
  });
});

describe("LINE setup guide: the default target (item 1)", () => {
  it("tells a person where to find their own user ID, which is what a one-to-one chat needs", () => {
    const text = textOf(field("defaultTarget").whereToFind);

    expect(text).toContain(
      "For a one-to-one chat use your own user ID: LINE Developers Console › your channel › Basic settings › Your user ID (starts with U). Group and room IDs only appear in webhook events.",
    );
    expect(text).toContain("If Your user ID isn't shown there, link your Business ID to your LINE account first.");
    expect(text).toContain("https://developers.line.biz/en/docs/messaging-api/getting-user-ids/");
  });

  it("does not claim the friend requirement anywhere in the guide: LINE's docs do not state it for push messages (R46)", () => {
    expect(textOf(field("defaultTarget").whereToFind)).not.toMatch(/friend|QR/iu);
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/friend|QR code/iu);
  });

  it("is asked with the destinations, and still required", () => {
    expect(fieldKeys("collect-values-destinations")).toEqual(["defaultTarget"]);
    expect(field("defaultTarget").required).toBe(true);
    expect(guide().validate(draftOf({ channelAccessToken: "secret-reference" }))).toEqual([
      expect.objectContaining({ key: "defaultTarget_required", fieldKey: "defaultTarget" }),
    ]);
  });
});

describe("LINE setup guide: receiving is its own optional step (items 3 and 5, A12)", () => {
  it("puts the channel secret in a step of its own, ahead of the sender and test steps", () => {
    expect(stepIds()).toEqual([
      "overview",
      "create-account",
      "collect-values-identity",
      "collect-values-destinations",
      "receive-messages",
      "sender-access",
      "test",
      "finish",
      "first-message",
    ]);
    expect(fieldKeys("receive-messages")).toEqual(["channelSecret", "channelSecretEnv"]);
    expect(fieldKeys("collect-values-identity")).toEqual(["channelAccessToken", "channelAccessTokenEnv"]);
  });

  it("keeps the step's own title, id and stage instead of 'Connect the account'", () => {
    const receive = step("receive-messages");

    expect(receive.title).toBe("Receive messages (optional)");
    expect(receive.stage).toBe("destinations_access");
    expect(receive.kind).toBe("field-collection");
  });

  it("needs nothing from the person: the channel secret is not part of the credential choice", () => {
    expect((step("receive-messages").fields ?? []).filter((candidate) => candidate.required)).toEqual([]);
    expect(step("receive-messages").requiredAnyOf).toBeUndefined();
    expect(step("collect-values-identity").requiredAnyOf).toEqual([["channelAccessToken", "channelAccessTokenEnv"]]);
  });

  it("says plainly what receiving needs", () => {
    expect(paragraphs("receive-messages")).toEqual([
      "Skip this step if you only want to send. To receive, set the channel secret: LINE signs every message it sends you with it.",
      "Receiving also needs a public HTTPS address with a trusted certificate. GoatCitadel doesn't provide one.",
    ]);
  });

  it("does not hide the receive step when a saved connection is changed", () => {
    expect(step("receive-messages").createOnly).toBeUndefined();
  });

  it("says the sender format and offers open legacy access only to a saved connection that was open", () => {
    const allowed = step("sender-access").fields?.find((candidate) => candidate.key === "allowedSenders");
    const mode = step("sender-access").fields?.find((candidate) => candidate.key === "inboundAccessMode");
    const open = guide().hydrate(connectionOf({ ...SEND_ONLY_VALUES, inboundAccessMode: "open_legacy" })).draft;

    expect(allowed?.explanation).toBe(
      'Your LINE user ID (starts with U). For a one-to-one chat it is the same ID as Default target. Don\'t know the id? Message the bot once, then open System › Diagnostics and find "Dropped a … message from …".',
    );
    expect(mode?.visibleWhenFieldEquals).toEqual({ fieldKey: "inboundAccessWasOpen", value: true });
    expect(open.inboundAccessWasOpen).toBe(true);
    expect(guide().normalize(draftOf(open))).not.toHaveProperty("inboundAccessWasOpen");
  });
});

describe("LINE setup guide: the secret fields (A5)", () => {
  it("offers a pasted channel access token first, then the variable name under Advanced with its name rule", () => {
    const keys = fieldKeys("collect-values-identity");
    const token = field("channelAccessToken");
    const env = field("channelAccessTokenEnv");

    expect(keys.indexOf("channelAccessToken")).toBeLessThan(keys.indexOf("channelAccessTokenEnv"));
    expect(token.label).toBe("Channel access token");
    expect(token.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
    expect(token.advanced).not.toBe(true);
    expect(env.advanced).toBe(true);
    expect(env.label).toBe("Channel access token from an environment variable (advanced)");
    expect(env.explanation).toBe(
      "Name of the env var that stores the LINE channel access token. The variable's name must start with LINE_ (for example LINE_CHANNEL_ACCESS_TOKEN). Set it where GoatCitadel starts, then restart GoatCitadel.",
    );
  });

  it("gives the channel secret the same treatment, and says the suffix an inbound secret needs", () => {
    expect(field("channelSecret").label).toBe("Channel secret");
    expect(field("channelSecret").explanation).toBe(
      "Paste it here. GoatCitadel keeps it in this computer's secure storage.",
    );
    expect(field("channelSecretEnv").advanced).toBe(true);
    expect(field("channelSecretEnv").label).toBe("Channel secret from an environment variable (advanced)");
    expect(field("channelSecretEnv").explanation).toBe(
      "Name of the environment variable that holds your channel secret. The variable's name must start with LINE_ (for example LINE_CHANNEL_SECRET). Set it where GoatCitadel starts, then restart GoatCitadel. The name must also end in _TOKEN or _SECRET.",
    );
  });
});

describe("LINE setup guide: the test and finishing (item 6)", () => {
  it("says what the test does, then asks the person to check the message arrived", () => {
    expect(paragraphs("test")).toEqual([
      "The test checks your channel access token with LINE, then sends one test message to your Default target. Check that it arrived in LINE.",
    ]);
  });

  it("no longer tells the person to confirm the push after finalizing: the test sends it, not Finalize", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection so GoatCitadel can send from it. To receive messages, the webhook also has to be set up in LINE (the last step shows how).",
    ]);
    expect(JSON.stringify(step("finish"))).not.toMatch(/after finalizing/iu);
    expect(step("finish").successCriteria).toEqual([
      "LINE accepted the channel access token.",
      "The test message arrived at the Default target.",
      "To receive messages: the channel secret is set.",
    ]);
  });
});

describe("LINE setup guide: when the test fails (A13)", () => {
  const items = () => step("test").troubleshooting ?? [];
  const body = (id: string) => items().find((item) => item.id === id)?.body ?? "";

  it("lists the failures a LINE setup really hits, on the test step", () => {
    expect(items().map((item) => item.id)).toEqual([
      "token-rejected",
      "target-rejected",
      "host-not-allowed",
      "variable-not-found",
      "no-reply",
    ]);
  });

  it("sends a rejected token to the long-lived token on the Messaging API tab", () => {
    expect(body("token-rejected")).toContain("long-lived channel access token");
    expect(body("token-rejected")).toContain("Messaging API tab");
    expect(body("token-rejected")).toContain("can't renew it");
  });

  it("sends a rejected target to the user ID on the Basic settings tab", () => {
    expect(body("target-rejected")).toContain("Basic settings › Your user ID");
    expect(body("target-rejected")).toContain("not the channel ID");
  });

  it("names the host and the Allow these hosts button", () => {
    expect(items().find((item) => item.id === "host-not-allowed")?.title).toBe(
      "It says GoatCitadel can't reach api.line.me yet",
    );
    expect(body("host-not-allowed")).toContain("Allow these hosts");
    expect(body("host-not-allowed")).toContain("api.line.me");
  });

  it("points a variable that isn't found at the name rule and the restart", () => {
    expect(body("variable-not-found")).toContain("LINE_");
    expect(body("variable-not-found")).toContain("restart GoatCitadel");
  });

  it("points a silent bot at the webhook settings, auto-reply, the secret and the allowed sender", () => {
    const noReply = body("no-reply");

    expect(noReply).toContain("Use webhook");
    expect(noReply).toContain("Verify");
    expect(noReply).toContain("auto-reply and greeting messages");
    expect(noReply).toContain("channel secret");
    expect(noReply).toContain("Who may message this bot");
    expect(noReply).toContain("public HTTPS address");
  });
});

describe("LINE setup guide: asking for what is missing (A15)", () => {
  it("asks for the channel access token, and jumps to the pasted field", () => {
    const issues = guide().validate(draftOf({ defaultTarget: USER_ID }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "line_auth_missing",
        fieldKey: "channelAccessToken",
        level: "error",
        message: "Paste the LINE channel access token.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("does not ask when a saved token or a variable name is already there", () => {
    // Editing a saved connection: the token is kept in secure storage and the draft only knows it is configured.
    const saved = draftOf(
      { defaultTarget: USER_ID },
      { hydration: { status: "opaque-secret", fieldState: { channelAccessToken: "configured" }, warnings: [] } },
    );
    const variable = draftOf({ defaultTarget: USER_ID, channelAccessTokenEnv: "LINE_CHANNEL_ACCESS_TOKEN" });

    expect(guide().validate(saved)).toEqual([]);
    expect(guide().validate(variable)).toEqual([]);
  });
});

describe("LINE send-only path: can it finish?", () => {
  it("lets Continue pass with just a channel access token and a target", () => {
    expect(continueBlockers(SEND_ONLY_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(SEND_ONLY_VALUES))).toEqual([]);
  });

  it("asks for those two and nothing about receiving", () => {
    expect(continueBlockers({})).toEqual([
      "Channel access token or Channel access token from an environment variable (advanced)",
      "Default target",
    ]);
  });

  it("passes the setup test's own checks: the token check and the test message", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const { deps, live } = await verdictOf(config);

    expect(config).not.toHaveProperty("channelSecret");
    expect(live.checks.filter((check) => check.status !== "pass")).toEqual([]);
    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["line_token_auth", "pass"],
      ["line_sandbox_send", "pass"],
    ]);
    const send = vi
      .mocked(deps.fetchWithDiagnosticsTimeout)
      .mock.calls.find(([url]) => url === "https://api.line.me/v2/bot/message/push");
    expect(JSON.parse(String(send?.[1]?.body))).toMatchObject({ to: USER_ID });
  });

  it("is cleared by the setup test end to end: LINE sends text, and that does not hold Finalize back (R45)", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const { issues, eligibility } = await verdictOf(config);

    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("still tells the operator that attachments aren't supported", () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const attachments = buildIntegrationConnectionChecks(port(), connectionOf(config)).find(
      (check) => check.key === "attachments",
    );

    expect(attachments).toEqual({
      key: "attachments",
      status: "pass",
      message: "This channel sends text. Attachments aren't supported.",
    });
  });

  it("is also cleared when the token is a variable name rather than a pasted token", () => {
    const config = guide().normalize(
      draftOf({
        ...SEND_ONLY_VALUES,
        channelAccessToken: undefined,
        channelAccessTokenEnv: "LINE_CHANNEL_ACCESS_TOKEN",
      }),
    );
    const previous = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-test-token";
    try {
      const structural = buildIntegrationConnectionChecks(port(), connectionOf(config));

      expect(structural.filter((check) => check.status !== "pass")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      else process.env.LINE_CHANNEL_ACCESS_TOKEN = previous;
    }
  });

  it("is not held up by an empty sender list: that is deferred until a sender is added", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));

    expect(config).toMatchObject({ inboundAccessMode: "allowlist" });
    expect((await verdictOf(config)).eligibility.allowed).toBe(true);
  });
});

describe("LINE receiving path: can it finish?", () => {
  it("lets Continue pass once the receive step is filled in", () => {
    expect(continueBlockers(RECEIVING_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(RECEIVING_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test with the channel secret and an allowed sender", async () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const { issues, eligibility } = await verdictOf(config);

    expect(config).toMatchObject({
      channelSecret: "secret-reference",
      allowedSenders: [USER_ID.toLowerCase()],
      inboundAccessMode: "allowlist",
    });
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("is still cleared before any sender is allowed: the person adds their ID after finishing", async () => {
    const { allowedSenders: _senders, ...withoutSenders } = RECEIVING_VALUES;
    const { eligibility } = await verdictOf(guide().normalize(draftOf(withoutSenders)));

    expect(eligibility.allowed).toBe(true);
  });

  it("does not make an edit replay the setup-only steps", () => {
    expect(continueBlockers(RECEIVING_VALUES, "edit")).toEqual([]);
  });
});
