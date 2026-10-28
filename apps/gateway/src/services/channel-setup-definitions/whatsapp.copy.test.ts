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
  return requireChannelSetupDefinition("channel.whatsapp");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`WhatsApp guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`WhatsApp guide has no field ${key}`);
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

const { draftOf, connectionOf, continueBlockers, port, verdictOf } = guideFinish("channel.whatsapp", {
  fetch: async (url, init) =>
    init?.method === "POST" && url.endsWith("/messages")
      ? new Response(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }), { status: 200 })
      : new Response(JSON.stringify({ id: "123456789012345" }), { status: 200 }),
});

const SEND_ONLY_VALUES = {
  accessToken: "secret-reference",
  phoneNumberId: "123456789012345",
  defaultTarget: "+15551234567",
};
const RECEIVING_VALUES = {
  ...SEND_ONLY_VALUES,
  appSecret: "secret-reference",
  webhookVerifyToken: "secret-reference",
  allowedSenders: ["15551234567"],
};

describe("WhatsApp setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /posture|provenance|ingress|egress|sandbox message|activation plan/iu,
    );
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/https:\/\/<your public address>/u);
  });
});

describe("WhatsApp setup guide: what it says up front (item 7)", () => {
  it("opens with the intro, prerequisites and first message from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Send WhatsApp messages from a WhatsApp Business number through Meta's Cloud API. Receiving messages needs a public HTTPS address. Personal WhatsApp (QR code linking) isn't supported.",
    );
    expect(wizard.prerequisites).toEqual([
      "A Meta app with WhatsApp set up, its phone number ID, and a permanent System User access token.",
      "The recipient messages your business number first; WhatsApp delivers the plain-text test only in the 24 hours after that.",
      "To receive messages: a public HTTPS address with a trusted certificate, the app secret, and a verify token you choose.",
    ]);
    expect(paragraphs("first-message")).toEqual([
      "Check the test message arrived. To receive: in Meta's App Dashboard open WhatsApp › Configuration, paste this connection's webhook address and your verify token, verify, and subscribe to messages. Allow your number (digits only, no plus) under Who may message this bot, then send a message and check the reply. If the bot doesn't answer your message, open System › Diagnostics, find \"Dropped a WhatsApp message from …\", and add that id under Who may message this bot with Edit setup.",
    ]);
  });

  it("keeps the provider hosts and the inbound webhook route from the picker data", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.requiredHosts).toEqual(["graph.facebook.com"]);
    expect(wizard.inboundWebhook?.pathTemplate).toBe(
      "/api/v1/integrations/connections/{connectionId}/whatsapp/webhook",
    );
  });

  it("hides the setup-only intro when a saved connection is changed", () => {
    expect(step("overview").createOnly).toBe(true);
  });
});

describe("WhatsApp setup guide: the 24-hour window (item 1, N2 default: keep plain text)", () => {
  it("tells the person to message the business number first, where they pick the recipient", () => {
    expect(field("defaultTarget").explanation).toContain(
      "First, from the recipient's phone, send any message to your business number. That opens WhatsApp's 24-hour window. Then run the live test. GoatCitadel's test is plain text, which WhatsApp only delivers inside that window.",
    );
  });

  it("says it again on the test step, then asks them to check the message arrived", () => {
    expect(paragraphs("test")).toEqual([
      "First, from the recipient's phone, send any message to your business number. That opens WhatsApp's 24-hour window. Then run the live test. GoatCitadel's test is plain text, which WhatsApp only delivers inside that window.",
      "The test checks your access token and phone number ID with WhatsApp, then sends one test message to your Default recipient. Check that it arrived on that phone.",
    ]);
  });

  it("no longer tells the person to confirm the message after finalizing: the test sends it, not Finalize", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection so GoatCitadel can send from it. To receive messages, the webhook also has to be registered in Meta (the last step shows how).",
    ]);
    expect(JSON.stringify(step("finish"))).not.toMatch(/after finalizing|sandbox/iu);
    expect(step("finish").successCriteria).toEqual([
      "WhatsApp accepted the access token and phone number ID.",
      "The test message arrived on the Default recipient's WhatsApp.",
      "To receive messages: the app secret and the verify token are both set.",
    ]);
  });
});

describe("WhatsApp setup guide: where to find the values (items 2 and 5)", () => {
  it("points the access token at a permanent System User token, not the temporary one", () => {
    const text = textOf(field("accessToken").whereToFind);

    expect(text).toContain(
      "Use a permanent System User token, not the temporary one on the API Setup page (that one expires quickly). Business Settings › Users › System users › Add › assign your app and WhatsApp account › Generate token with whatsapp_business_messaging, whatsapp_business_management and business_management.",
    );
    expect(text).toContain("https://developers.facebook.com/docs/whatsapp/cloud-api/get-started");
  });

  it("warns against the temporary token as a common mistake", () => {
    expect(field("accessToken").commonMistakes).toContain(
      "Using the temporary token from the API Setup page. It expires quickly.",
    );
  });

  it("says where the phone number ID is", () => {
    expect(textOf(field("phoneNumberId").whereToFind)).toContain(
      "In Meta's App Dashboard open WhatsApp › API Setup. The Phone number ID is under the From number.",
    );
  });

  it("does not state where the app secret is: the location could not be checked on Meta's pages", () => {
    const text = textOf(field("appSecret").whereToFind);

    expect(text).not.toMatch(/Basic/u);
    expect(text).toContain("app secret");
  });
});

describe("WhatsApp setup guide: receiving is its own optional step (item 3, A12)", () => {
  it("puts the four inbound fields in a step of their own, ahead of the sender and test steps", () => {
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
    expect(fieldKeys("receive-messages")).toEqual([
      "appSecret",
      "appSecretEnv",
      "webhookVerifyToken",
      "webhookVerifyTokenEnv",
    ]);
    expect(fieldKeys("collect-values-identity")).toEqual(["accessToken", "accessTokenEnv", "phoneNumberId"]);
    expect(fieldKeys("collect-values-destinations")).toEqual(["defaultTarget"]);
  });

  it("keeps the step's own title, id and stage instead of 'Connect the account'", () => {
    const receive = step("receive-messages");

    expect(receive.title).toBe("Receive messages (optional)");
    expect(receive.stage).toBe("destinations_access");
    expect(receive.kind).toBe("field-collection");
  });

  it("needs nothing from the person: no field in it is required, and none counts toward the credential choice", () => {
    expect((step("receive-messages").fields ?? []).filter((candidate) => candidate.required)).toEqual([]);
    expect(step("receive-messages").requiredAnyOf).toBeUndefined();
    expect(step("collect-values-identity").requiredAnyOf).toEqual([["accessToken", "accessTokenEnv"]]);
  });

  it("says plainly that without a public address WhatsApp is send-only", () => {
    const overview = paragraphs("overview");

    expect(overview[0]).toBe(
      "Sending works from this computer. To chat with the bot, Meta must reach your Gateway over a public HTTPS address with a trusted certificate. GoatCitadel doesn't provide one; without it WhatsApp is send-only. Personal WhatsApp (QR code linking) isn't supported.",
    );
    expect(paragraphs("receive-messages")).toEqual([
      "Skip this step if you only want to send. To receive, set both the app secret and the verify token. With only one of the two, WhatsApp stays send-only.",
      "Receiving needs a public HTTPS address with a trusted certificate. GoatCitadel doesn't provide one.",
    ]);
  });

  it("describes the beta note by what the test will do, not a 'sandbox message'", () => {
    expect(textOf(step("overview").body)).toContain(
      "WhatsApp Cloud API is a guided beta lane. The setup test checks your access token live and will post a test message to your Default recipient.",
    );
  });

  it("does not hide the receive step when a saved connection is changed", () => {
    expect(step("receive-messages").createOnly).toBeUndefined();
  });
});

describe("WhatsApp setup guide: who may message the bot (item 4, A7, A8)", () => {
  it("says the sender format: country code, digits only, no plus", () => {
    const allowed = step("sender-access").fields?.find((candidate) => candidate.key === "allowedSenders");

    expect(allowed?.explanation).toBe(
      'Your WhatsApp number with country code, digits only, no plus (for example 15551234567). Don\'t know the id? Message the bot once, then open System › Diagnostics and find "Dropped a … message from …".',
    );
  });

  it("offers open legacy access only to a saved connection that was open", () => {
    const mode = step("sender-access").fields?.find((candidate) => candidate.key === "inboundAccessMode");
    const open = guide().hydrate(connectionOf({ ...SEND_ONLY_VALUES, inboundAccessMode: "open_legacy" })).draft;
    const closed = guide().hydrate(connectionOf({ ...SEND_ONLY_VALUES, allowedSenders: ["15551234567"] })).draft;

    expect(mode?.visibleWhenFieldEquals).toEqual({ fieldKey: "inboundAccessWasOpen", value: true });
    expect(open.inboundAccessWasOpen).toBe(true);
    expect(closed.inboundAccessWasOpen).toBeUndefined();
    expect(guide().normalize(draftOf(open))).not.toHaveProperty("inboundAccessWasOpen");
  });
});

describe("WhatsApp setup guide: the secret fields (A5)", () => {
  it("offers a pasted access token first, then the variable name under Advanced with its name rule", () => {
    const keys = fieldKeys("collect-values-identity");
    const token = field("accessToken");
    const env = field("accessTokenEnv");

    expect(keys.indexOf("accessToken")).toBeLessThan(keys.indexOf("accessTokenEnv"));
    expect(token.label).toBe("Access token");
    expect(token.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
    expect(token.advanced).not.toBe(true);
    expect(env.advanced).toBe(true);
    expect(env.label).toBe("Access token from an environment variable (advanced)");
    expect(env.explanation).toBe(
      "Name of the environment variable that holds your WhatsApp access token. The variable's name must start with WHATSAPP_ (for example WHATSAPP_ACCESS_TOKEN). Set it where GoatCitadel starts, then restart GoatCitadel.",
    );
  });

  it("gives the receive secrets the same treatment, and says the suffix an inbound secret needs", () => {
    expect(field("appSecret").label).toBe("App secret");
    expect(field("appSecretEnv").label).toBe("App secret from an environment variable (advanced)");
    expect(field("appSecretEnv").explanation).toBe(
      "Name of the environment variable that holds your app secret. The variable's name must start with WHATSAPP_ (for example WHATSAPP_APP_SECRET). Set it where GoatCitadel starts, then restart GoatCitadel. The name must also end in _TOKEN or _SECRET.",
    );
    expect(field("webhookVerifyToken").label).toBe("Webhook verify token");
    expect(field("webhookVerifyTokenEnv").explanation).toContain(
      "The variable's name must start with WHATSAPP_ (for example WHATSAPP_WEBHOOK_VERIFY_TOKEN).",
    );
    expect(field("webhookVerifyTokenEnv").explanation).toContain("The name must also end in _TOKEN or _SECRET.");
    for (const key of ["appSecretEnv", "webhookVerifyTokenEnv"]) {
      expect(field(key).advanced, key).toBe(true);
    }
  });

  it("says the verify token is yours to choose, and to use the same text in Meta", () => {
    expect(textOf(field("webhookVerifyToken").whereToFind)).toContain(
      "Choose any random text yourself. Use the same text when you set up the webhook in Meta.",
    );
  });
});

describe("WhatsApp setup guide: when the test fails (A13)", () => {
  const items = () => step("test").troubleshooting ?? [];
  const body = (id: string) => items().find((item) => item.id === id)?.body ?? "";

  it("lists the failures a WhatsApp setup really hits, on the test step", () => {
    expect(items().map((item) => item.id)).toEqual([
      "token-rejected",
      "phone-number-id",
      "recipient-invalid",
      "no-message",
      "host-not-allowed",
      "variable-not-found",
      "no-reply",
    ]);
  });

  it("sends a rejected token to a permanent System User token", () => {
    expect(body("token-rejected")).toContain("temporary token");
    expect(body("token-rejected")).toContain("System users");
    expect(body("token-rejected")).toContain("whatsapp_business_messaging");
  });

  it("tells a person with no message the 24-hour window is the likely cause", () => {
    expect(body("no-message")).toContain("24 hours");
    expect(body("no-message")).toContain("send any message to your business number");
  });

  it("names the host and the Allow these hosts button", () => {
    expect(items().find((item) => item.id === "host-not-allowed")?.title).toBe(
      "It says GoatCitadel can't reach graph.facebook.com yet",
    );
    expect(body("host-not-allowed")).toContain("Allow these hosts");
    expect(body("host-not-allowed")).toContain("graph.facebook.com");
  });

  it("points a variable that isn't found at the name rule and the restart", () => {
    expect(body("variable-not-found")).toContain("WHATSAPP_");
    expect(body("variable-not-found")).toContain("restart GoatCitadel");
  });

  it("points a silent bot at Meta's webhook settings, the secrets and the allowed sender", () => {
    const noReply = body("no-reply");

    expect(noReply).toContain("WhatsApp › Configuration");
    expect(noReply).toContain("verify token");
    expect(noReply).toContain("app secret");
    expect(noReply).toContain("Who may message this bot");
    expect(noReply).toContain("public HTTPS address");
  });
});

describe("WhatsApp setup guide: asking for what is missing (A15)", () => {
  it("asks for the access token, and jumps to the pasted field", () => {
    const issues = guide().validate(draftOf({ phoneNumberId: "123456789012345", defaultTarget: "+15551234567" }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "whatsapp_auth_missing",
        fieldKey: "accessToken",
        level: "error",
        message: "Paste the WhatsApp access token.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("does not ask when a saved token or a variable name is already there", () => {
    // Editing a saved connection: the token is kept in secure storage and the draft only knows it is configured.
    const saved = draftOf(
      { phoneNumberId: "123456789012345", defaultTarget: "+15551234567" },
      { hydration: { status: "opaque-secret", fieldState: { accessToken: "configured" }, warnings: [] } },
    );
    const variable = draftOf({ ...SEND_ONLY_VALUES, accessToken: undefined, accessTokenEnv: "WHATSAPP_ACCESS_TOKEN" });

    expect(guide().validate(saved)).toEqual([]);
    expect(guide().validate(variable)).toEqual([]);
  });
});

describe("WhatsApp send-only path: can it finish?", () => {
  it("lets Continue pass with just a token, a phone number ID and a recipient", () => {
    expect(continueBlockers(SEND_ONLY_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(SEND_ONLY_VALUES))).toEqual([]);
  });

  it("asks for those three and nothing about receiving", () => {
    expect(continueBlockers({})).toEqual(["Phone number ID", "Access token", "Default recipient"]);
  });

  it("is cleared by the setup test: the token check and the test message both pass", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const { deps, issues, eligibility, live } = await verdictOf(config);

    expect(config).not.toHaveProperty("appSecret");
    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["whatsapp_token_auth", "pass"],
      ["whatsapp_sandbox_send", "pass"],
    ]);
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
    // The test still sends plain text (N2 default), which is why the guide says to message the business number first.
    const send = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(send?.[1]?.body))).toMatchObject({ type: "text", to: "15551234567" });
  });

  it("is also cleared when the token is a variable name rather than a pasted token", () => {
    const config = guide().normalize(
      draftOf({ ...SEND_ONLY_VALUES, accessToken: undefined, accessTokenEnv: "WHATSAPP_ACCESS_TOKEN" }),
    );
    const previous = process.env.WHATSAPP_ACCESS_TOKEN;
    process.env.WHATSAPP_ACCESS_TOKEN = "EAAB-test-token";
    try {
      const structural = buildIntegrationConnectionChecks(port(), connectionOf(config));

      expect(structural.filter((check) => check.status !== "pass")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
      else process.env.WHATSAPP_ACCESS_TOKEN = previous;
    }
  });

  it("is not held up by an empty sender list: that is deferred until a sender is added", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));

    expect(config).toMatchObject({ inboundAccessMode: "allowlist" });
    expect((await verdictOf(config)).eligibility.allowed).toBe(true);
  });
});

describe("WhatsApp receiving path: can it finish?", () => {
  it("lets Continue pass once the receive step is filled in", () => {
    expect(continueBlockers(RECEIVING_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(RECEIVING_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test with the app secret, the verify token and an allowed sender", async () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const { issues, eligibility } = await verdictOf(config);

    expect(config).toMatchObject({
      appSecret: "secret-reference",
      webhookVerifyToken: "secret-reference",
      allowedSenders: ["15551234567"],
      inboundAccessMode: "allowlist",
    });
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("is still cleared before any sender is allowed: the person adds their number after finishing", async () => {
    const { allowedSenders: _senders, ...withoutSenders } = RECEIVING_VALUES;
    const { eligibility } = await verdictOf(guide().normalize(draftOf(withoutSenders)));

    expect(eligibility.allowed).toBe(true);
  });

  it("does not make an edit replay the vendor intro", () => {
    expect(continueBlockers(RECEIVING_VALUES, "edit")).toEqual([]);
  });
});
