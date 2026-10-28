import { describe, expect, it, vi } from "vitest";
import {
  evaluateChannelInboundAccess,
  type ChannelSetupFieldDefinition,
  type ChannelSetupRichBlock,
  type ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { buildIntegrationConnectionChecks } from "../integration-diagnostics-service.js";
import { guideFinish, type GuideFinishOptions } from "./guide-finish.test-support.js";

function guide() {
  return requireChannelSetupDefinition("channel.ntfy");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`ntfy guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`ntfy guide has no field ${key}`);
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

const TOPIC = "ops-9f3a1c7e2b";
const SELF_HOSTED = "https://ntfy.example.com";
const TOKEN = "tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2";
const PUBLIC_WARNING =
  "Receiving is only safe on a topic nobody else can post to: one on your own ntfy server with access control, or a reserved topic that others can't write to. On public ntfy.sh, anyone who knows an unreserved topic's name can post and start conversations. Use a long random topic name.";

type Fetcher = NonNullable<GuideFinishOptions["fetch"]>;

/** An ntfy server that accepts a publish to any topic, or answers with the given status. */
function ntfyServer(status = 200): Fetcher {
  return async () => new Response(JSON.stringify({ id: "msg1", event: "message" }), { status });
}

const { draftOf, connectionOf, continueBlockers, port, verdictOf } = guideFinish("channel.ntfy");
const accepting = guideFinish("channel.ntfy", { fetch: ntfyServer() });
const refusing = guideFinish("channel.ntfy", { fetch: ntfyServer(401) });

const SEND_VALUES = { topic: TOPIC };
const RECEIVING_VALUES = { ...SEND_VALUES, token: TOKEN, inboundStreamEnabled: true };

describe("ntfy setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /posture|provenance|ingress|egress|sandbox message|activation plan/iu,
    );
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/https:\/\/<your public address>/u);
  });

  it("no longer says the token gates reading the topic as if that made inbound safe (item 3)", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/token gates reading/iu);
  });
});

describe("ntfy setup guide: what it says up front (items 1, 3, 7, R49)", () => {
  it("opens with the intro and prerequisites from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Send notifications to an ntfy topic. Optionally, messages posted to a topic can start conversations; only do that on a topic nobody else can post to. No public web address is needed.",
    );
    expect(wizard.prerequisites).toEqual([
      "An ntfy server (ntfy.sh or your own) and a topic name.",
      "The ntfy app subscribed to that topic, to see the test.",
      "To receive: an access token that can read the topic.",
    ]);
  });

  it("asks for the test notification only when something was sent: with dry run on the probe sends nothing (R49)", () => {
    expect(paragraphs("first-message")).toEqual([
      "If dry run is off, check the test notification arrived. If dry run is on, nothing was sent: turn it off in Edit setup and test again. To receive: post to the subscribe topic from another device and check the reply.",
    ]);
  });

  it("keeps the ntfy server host field from the picker data, and no inbound webhook", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.hostFields).toEqual(["baseUrl"]);
    expect(wizard.inboundWebhook).toBeUndefined();
  });

  it("splits the long intro note into Sending, Receiving (optional) and Limits", () => {
    const text = paragraphs("overview");

    expect(text).toEqual([
      "Sending. ntfy is send-only unless you turn on Receive messages. GoatCitadel publishes notifications to a topic with ntfy's HTTP publish API. No public web address is needed.",
      "Receiving (optional). With Receive messages on, GoatCitadel connects out to the topic's stream and starts a conversation from each message posted there. It needs an access token that can read the topic. ntfy messages carry no sender identity: the topic is the sender, so anyone who can post to the topic can start conversations. Messages posted while GoatCitadel isn't running, or is restarting, are skipped. GoatCitadel's own notifications are tagged and ignored on the way back in.",
      "Limits. Webhooks and remote commands aren't supported. The test notification stays on the topic.",
    ]);
  });

  it("warns, and only warns, that receiving on public ntfy.sh lets anyone who knows the topic start conversations (N9)", () => {
    const warning = step("overview").body?.find((block) => block.kind === "note" && block.tone === "warning");

    expect(warning).toEqual({ kind: "note", tone: "warning", text: PUBLIC_WARNING });
    expect(guide().validate(draftOf({ baseUrl: "https://ntfy.sh", ...RECEIVING_VALUES }))).toEqual([]);
  });

  it("tells the person where the ntfy host gets allowed, not just that it must be (item 1)", () => {
    expect(textOf(step("overview").body)).toContain(
      "GoatCitadel can reach your ntfy server only once the server is in the hosts GoatCitadel may reach: the setup test has an Allow these hosts button for that.",
    );
  });

  it("hides the setup-only intro when a saved connection is changed", () => {
    expect(step("overview").createOnly).toBe(true);
    expect(step("prepare-topic").createOnly).toBe(true);
  });
});

describe("ntfy setup guide: preparing the topic (items 3 and 7, R50)", () => {
  it("says a topic name is its own password on public ntfy.sh, and what a name may contain", () => {
    expect(paragraphs("prepare-topic")).toEqual([
      "Choose an ntfy topic, and whether it lives on the public ntfy.sh service or on a server of your own.",
      "On public ntfy.sh a topic name works like a password: anyone who knows it can read and post. Pick a long random name, using letters, numbers, _ and -, up to 64 characters.",
      "If the topic needs a token, have it ready. Receiving always needs one that can read the topic.",
    ]);
  });

  it("asks only for what every setup needs: the token is plain guidance, not a box that blocks Continue (R50)", () => {
    const boxes = (step("prepare-topic").checklist ?? []).map((item) => item.label);

    expect(boxes).toEqual([
      "Choose the base URL, such as https://ntfy.sh or your self-hosted origin",
      "Choose the exact topic GoatCitadel may publish to",
    ]);
    expect(boxes.join("\n")).not.toMatch(/token/iu);
  });

  it("links the vendor pages the steps rest on", () => {
    const text = textOf(step("prepare-topic").body);

    expect(text).toContain("https://docs.ntfy.sh/publish/");
    expect(text).toContain("https://docs.ntfy.sh/config/");
  });
});

describe("ntfy setup guide: the server address and the topic (items 1, 4, A10, N8)", () => {
  it("says the rule in the field: https, or this computer only", () => {
    expect(field("baseUrl").explanation).toBe(
      "The address of your ntfy server. Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
    );
    expect(field("baseUrl").defaultValue).toBe("https://ntfy.sh");
    expect(field("baseUrl").required).toBe(true);
  });

  it("refuses plain http away from this computer with the message the live test would give", () => {
    const issues = guide().validate(draftOf({ ...SEND_VALUES, baseUrl: "http://ntfy.example.com" }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "baseUrl_malformed",
        fieldKey: "baseUrl",
        level: "error",
        message: "Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
        failureCategory: "malformed_value",
      }),
    ]);
  });

  it("refuses an address with no scheme", () => {
    expect(
      guide()
        .validate(draftOf({ ...SEND_VALUES, baseUrl: "ntfy.example.com" }))
        .map((issue) => issue.key),
    ).toEqual(["baseUrl_malformed"]);
  });

  it("refuses a scheme that is not http or https, even for this computer", () => {
    expect(guide().validate(draftOf({ ...SEND_VALUES, baseUrl: "ftp://localhost" }))).toEqual([
      expect.objectContaining({
        key: "baseUrl_malformed",
        fieldKey: "baseUrl",
        message: "Base URL should start with https://.",
      }),
    ]);
  });

  it("accepts https, and plain http for this computer only", () => {
    for (const baseUrl of ["https://ntfy.sh", SELF_HOSTED, "http://localhost:2586", "http://127.0.0.1:2586"]) {
      expect(guide().validate(draftOf({ ...SEND_VALUES, baseUrl })), baseUrl).toEqual([]);
    }
  });

  it("says what a topic may contain, and warns against a guessable one", () => {
    expect(field("topic").explanation).toBe(
      "The ntfy topic GoatCitadel publishes to. Use letters, numbers, _ and -, up to 64 characters.",
    );
    expect(field("topic").commonMistakes).toEqual([
      "A short, guessable name on public ntfy.sh. Anyone who knows the name can read and post to it.",
      "A dot or a space in the name. ntfy topics use letters, numbers, _ and - only.",
    ]);
  });

  it("accepts letters, numbers, _ and - up to 64 characters, for the topic and the subscribe topic", () => {
    for (const topic of ["ops", "Ops_9-b", "a".repeat(64)]) {
      expect(guide().validate(draftOf({ topic, subscribeTopic: topic })), topic).toEqual([]);
    }
  });

  it("refuses a dot, a space, a slash or more than 64 characters with the audit's message", () => {
    for (const topic of ["ops.alerts", "my topic", "a/b", "a".repeat(65)]) {
      expect(guide().validate(draftOf({ topic })), topic).toEqual([
        expect.objectContaining({
          key: "topic_malformed",
          fieldKey: "topic",
          level: "error",
          message: "Topics use letters, numbers, _ and -, up to 64 characters.",
          failureCategory: "malformed_value",
        }),
      ]);
      expect(guide().validate(draftOf({ topic: "ops", subscribeTopic: topic })), topic).toEqual([
        expect.objectContaining({
          key: "subscribeTopic_malformed",
          fieldKey: "subscribeTopic",
          message: "Topics use letters, numbers, _ and -, up to 64 characters.",
        }),
      ]);
    }
  });

  it("still asks for the topic", () => {
    expect(field("topic").required).toBe(true);
    expect(guide().validate(draftOf({}))).toEqual([
      expect.objectContaining({ key: "topic_required", fieldKey: "topic" }),
    ]);
  });
});

describe("ntfy setup guide: the access token (items 2 and 7, A5, A15)", () => {
  it("adds a pasted access token, first, with where to get one", () => {
    const keys = fieldKeys("collect-values-identity");
    const token = field("token");

    expect(keys.indexOf("token")).toBeGreaterThan(-1);
    expect(keys.indexOf("token")).toBeLessThan(keys.indexOf("tokenEnv"));
    expect(token.type).toBe("secret");
    expect(token.label).toBe("Access token");
    expect(token.required).toBe(false);
    expect(token.sensitive).toBe(true);
    expect(token.advanced).not.toBe(true);
    expect(token.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
    expect(token.whyNeeded).toBe(
      "A protected topic needs one to publish. Receiving needs one that can read the topic: GoatCitadel won't listen without a token.",
    );
    expect(textOf(token.whereToFind)).toContain(
      "Create one with ntfy token add <user> on your server, or in the ntfy web app under Account when you're logged in. It starts with tk_.",
    );
    expect(textOf(token.whereToFind)).toContain("https://docs.ntfy.sh/publish/#access-tokens");
    expect(token.commonMistakes).toEqual([
      "Pasting your account password. This field takes an access token (it starts with tk_).",
    ]);
  });

  it("keeps the variable name under Advanced with its name rule", () => {
    const env = field("tokenEnv");

    expect(env.advanced).toBe(true);
    expect(env.label).toBe("Access token from an environment variable (advanced)");
    expect(env.explanation).toBe(
      "Name of the env var that stores the ntfy access token. The variable's name must start with NTFY_ (for example NTFY_TOKEN). Set it where GoatCitadel starts, then restart GoatCitadel.",
    );
  });

  it("does not make the token a requirement for sending: Continue never asks for one", () => {
    expect(step("collect-values-identity").requiredAnyOf).toBeUndefined();
    expect(continueBlockers({ topic: TOPIC })).toEqual([]);
  });

  it("asks for the token when receiving is on, and jumps to the pasted field", () => {
    const issues = guide().validate(draftOf({ ...SEND_VALUES, inboundStreamEnabled: true }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "token_required",
        fieldKey: "token",
        level: "error",
        message: "Paste the ntfy access token. Receiving needs one that can read the topic.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("does not ask when a pasted token, a variable name or a saved token is there", () => {
    const saved = draftOf(
      { ...SEND_VALUES, inboundStreamEnabled: true },
      {
        hydration: {
          status: "opaque-secret",
          fieldState: {},
          warnings: [],
          rawLegacyConfig: { token: "keychain:ref" },
        },
      },
    );

    expect(guide().validate(draftOf({ ...SEND_VALUES, inboundStreamEnabled: true, token: TOKEN }))).toEqual([]);
    expect(guide().validate(draftOf({ ...SEND_VALUES, inboundStreamEnabled: true, tokenEnv: "NTFY_TOKEN" }))).toEqual(
      [],
    );
    expect(guide().validate(saved)).toEqual([]);
  });
});

describe("ntfy setup guide: receiving and dry run (items 3, 5, 6, A7, A8)", () => {
  it("names the switch and warns about who can post, in the field itself", () => {
    const receive = field("inboundStreamEnabled");

    expect(receive.label).toBe("Receive messages from the topic");
    expect(receive.defaultValue).toBe(false);
    expect(receive.explanation).toBe(
      `Listen to the topic so messages posted to it start conversations. Needs an access token that can read the topic. ${PUBLIC_WARNING} Messages posted while GoatCitadel isn't running are skipped.`,
    );
    expect(receive.whyNeeded).toBe(
      "ntfy carries no sender identity, so the topic is the sender and anyone who can post to it can start a conversation. Receiving stays off unless you turn it on.",
    );
  });

  it("says the subscribe topic's characters", () => {
    expect(field("subscribeTopic").explanation).toBe(
      "Topic to receive from, if it isn't the publish topic. Use letters, numbers, _ and -, up to 64 characters.",
    );
    expect(field("subscribeTopic").advanced).toBe(true);
  });

  it("says that dry run sends nothing and should be turned off after testing", () => {
    expect(field("dryRun").explanation).toBe(
      "Check the settings without sending a notification. With dry run on, nothing is ever sent. Turn it off after testing.",
    );
    expect(field("dryRun").advanced).toBe(true);
    expect(field("dryRun").defaultValue).toBe(false);
  });

  it("shows the sender step only while receiving is on, with no access-mode choice", () => {
    const sender = step("sender-access");

    expect(sender.visibleWhenFieldEquals).toEqual({ fieldKey: "inboundStreamEnabled", value: true });
    expect(fieldKeys("sender-access")).toEqual(["allowedSenders"]);
  });

  it("says the sender is added for you, and what to do if the topic changes", () => {
    const senders = step("sender-access").fields?.find((candidate) => candidate.key === "allowedSenders");

    expect(senders?.explanation).toBe(
      "Added for you as ntfy-topic:<subscribe topic>. If you change the topic later, change this too.",
    );
  });

  it("adds the topic as the allowed sender, and matches what the stream reports", () => {
    const config = guide().normalize(draftOf({ ...RECEIVING_VALUES, subscribeTopic: "inbox" }));

    expect(config).toMatchObject({ inboundAccessMode: "allowlist", allowedSenders: ["ntfy-topic:inbox"] });
    expect(evaluateChannelInboundAccess({ config, actorId: "ntfy-topic:inbox" })).toMatchObject({ allowed: true });
    expect(evaluateChannelInboundAccess({ config, actorId: "ntfy-topic:other" })).toMatchObject({ allowed: false });
  });

  it("keeps a saved sender when the topic changes, which is why the sender help says to change it too", () => {
    const config = guide().normalize(
      draftOf({ ...RECEIVING_VALUES, topic: "new-topic-name", allowedSenders: ["ntfy-topic:old-topic-name"] }),
    );

    expect(config.allowedSenders).toEqual(["ntfy-topic:old-topic-name"]);
  });
});

describe("ntfy setup guide: the test and finishing (items 5 and 7, R49)", () => {
  it("says what the test sends, that it stays on the topic, and that dry run sends nothing", () => {
    expect(paragraphs("test")).toEqual([
      'The test publishes one notification titled "GoatCitadel channel setup probe" to the topic and doesn\'t delete it, so it stays on the topic: check that it arrived in your ntfy app. With dry run on, the test sends nothing.',
    ]);
  });

  it("finishes by saving for publishing, and says dry run sends nothing", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection so GoatCitadel can publish to the topic. With dry run on, nothing is ever sent. Turn it off after testing.",
    ]);
    expect(step("finish").successCriteria).toEqual([
      "The server address is https, or http for this computer only.",
      "A topic is set.",
      "Dry run is off once you've tested, so notifications are really sent.",
      "Receiving is on only for a topic nobody else can post to, with an access token that can read it.",
    ]);
  });
});

describe("ntfy setup guide: when the test fails (A13)", () => {
  const items = () => step("test").troubleshooting ?? [];
  const body = (id: string) => items().find((item) => item.id === id)?.body ?? "";

  it("lists the failures an ntfy setup really hits, on the test step", () => {
    expect(items().map((item) => item.id)).toEqual([
      "token-rejected",
      "host-not-allowed",
      "topic-rejected",
      "nothing-arrived",
      "variable-not-found",
      "no-reply",
    ]);
  });

  it("sends a refused publish to an access token that can publish", () => {
    expect(items().find((item) => item.id === "token-rejected")?.title).toBe(
      "ntfy refused the notification (401 or 403)",
    );
    expect(body("token-rejected")).toBe(
      "The topic needs an access token that can publish to it. Paste one (it starts with tk_), or set the variable your token is in. Create one with ntfy token add <user> on your server, or in the ntfy web app under Account.",
    );
  });

  it("names the Allow these hosts button for the ntfy server", () => {
    expect(items().find((item) => item.id === "host-not-allowed")?.title).toBe(
      "It says GoatCitadel can't reach your ntfy server yet",
    );
    expect(body("host-not-allowed")).toBe(
      "GoatCitadel only reaches hosts you allow. Use Allow these hosts on this step to add your ntfy server (ntfy.sh if you use the public one), then run the test again.",
    );
  });

  it("repeats the topic rule", () => {
    expect(body("topic-rejected")).toBe(
      "Topics use letters, numbers, _ and -, up to 64 characters. Remove dots, spaces and slashes.",
    );
  });

  it("points a test that passed with nothing on the phone at the subscription and dry run", () => {
    expect(body("nothing-arrived")).toBe(
      "Check that the ntfy app is subscribed to this exact topic on this server, and that dry run is off: with dry run on, nothing is sent.",
    );
  });

  it("gives the variable name rule and the restart", () => {
    expect(body("variable-not-found")).toBe(
      "A variable's name must start with NTFY_ (for example NTFY_TOKEN), and you must restart GoatCitadel after you set it. Or paste the token instead.",
    );
  });

  it("points a silent topic at receiving, the token, the sender entry, the running Gateway and the host", () => {
    const noReply = body("no-reply");

    expect(noReply).toContain("Receive messages from the topic must be on");
    expect(noReply).toContain("access token that can read the topic");
    expect(noReply).toContain("ntfy-topic: followed by the subscribe topic");
    expect(noReply).toContain("if you changed the topic, change it there too");
    expect(noReply).toContain("messages posted while it isn't are skipped");
    expect(noReply).toContain("hosts GoatCitadel may reach");
  });
});

describe("ntfy send-only path: can it finish?", () => {
  it("lets Continue pass with just a topic: the address is pre-filled and no token is needed", () => {
    expect(continueBlockers(SEND_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(SEND_VALUES))).toEqual([]);
  });

  it("asks for the topic and nothing about a token or receiving", () => {
    expect(continueBlockers({})).toEqual(["Topic"]);
  });

  it("is cleared by the setup test once the notification is accepted, and says the message stays on the topic", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { issues, live, deps, eligibility } = await accepting.verdictOf(config);
    const publish = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls[0];
    const headers = new Headers(publish?.[1]?.headers);

    expect(config).toMatchObject({ baseUrl: "https://ntfy.sh", topic: TOPIC, priority: "3", dryRun: false });
    expect(config).not.toHaveProperty("token");
    expect(publish?.[0]).toBe(`https://ntfy.sh/${TOPIC}`);
    expect(headers.get("title")).toBe("GoatCitadel channel setup probe");
    expect(headers.has("authorization")).toBe(false);
    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status, candidate.message])).toEqual([
      ["ntfy_sandbox_send", "pass", "ntfy accepted the test message. Check that it arrived on the topic."],
      ["ntfy_sandbox_cleanup", "skipped", "The test message stays on the topic."],
    ]);
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("sends a pasted access token as a bearer token for a protected topic", async () => {
    const config = guide().normalize(draftOf({ ...SEND_VALUES, token: TOKEN }));
    const { deps, eligibility } = await accepting.verdictOf(config);
    const headers = new Headers(vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls[0]?.[1]?.headers);

    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(eligibility.allowed).toBe(true);
  });

  it("holds Finalize back while ntfy refuses the publish, and the guide names the token fix", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { eligibility } = await refusing.verdictOf(config);

    expect(eligibility.allowed).toBe(false);
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("token-rejected");
  });

  it("holds Finalize back while the ntfy host is not allowed, and the guide names the button", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const deps = { ...port(), isConnectionUrlAllowlisted: vi.fn(() => false) };
    const url = buildIntegrationConnectionChecks(deps, connectionOf(config)).find((check) => check.key === "url");

    expect(url).toMatchObject({
      status: "warn",
      message: "ntfy server URL host is not in the current outbound allowlist.",
    });
    expect(step("test").troubleshooting?.find((item) => item.id === "host-not-allowed")?.body).toContain(
      "Allow these hosts",
    );
  });

  it("can finish with dry run on, but nothing is sent, and the guide says to turn it off", async () => {
    const config = guide().normalize(draftOf({ ...SEND_VALUES, dryRun: true }));
    const { live, deps, eligibility } = await accepting.verdictOf(config);

    expect(deps.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["ntfy_sandbox_send", "skipped"],
    ]);
    expect(eligibility.allowed).toBe(true);
    expect(paragraphs("first-message")[0]).toContain(
      "If dry run is on, nothing was sent: turn it off in Edit setup and test again.",
    );
  });

  it("asks this path to tick nothing it doesn't need: the setup step's boxes are the address and the topic (R50)", () => {
    // The shared helper doesn't model checklists, so assert the step's boxes directly. Continue is blocked until each
    // box is ticked, and a send-only setup on a topic with no token is a supported path.
    const boxes = (step("prepare-topic").checklist ?? []).map((item) => item.label);

    expect(continueBlockers(SEND_VALUES)).toEqual([]);
    expect(boxes).toHaveLength(2);
    expect(boxes.join("\n")).not.toMatch(/token|receiv/iu);
  });

  it("refuses to be cleared over plain http away from this computer, which the field already said", async () => {
    const config = guide().normalize(draftOf({ ...SEND_VALUES, baseUrl: "http://ntfy.example.com" }));
    const { eligibility } = await verdictOf(config);

    expect(eligibility.allowed).toBe(false);
  });

  it("is also cleared when the token is a variable name rather than a pasted token", () => {
    const config = guide().normalize(draftOf({ ...SEND_VALUES, tokenEnv: "NTFY_TOKEN" }));
    const previous = process.env.NTFY_TOKEN;
    process.env.NTFY_TOKEN = TOKEN;
    try {
      const structural = buildIntegrationConnectionChecks(port(), connectionOf(config));

      expect(structural.filter((check) => check.status !== "pass")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.NTFY_TOKEN;
      else process.env.NTFY_TOKEN = previous;
    }
  });
});

describe("ntfy receiving path: can it finish?", () => {
  it("lets Continue pass once receiving is on with an access token", () => {
    expect(continueBlockers(RECEIVING_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(RECEIVING_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test, with the topic added as the allowed sender", async () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const { issues, eligibility } = await accepting.verdictOf(config);

    expect(config).toMatchObject({
      inboundStreamEnabled: true,
      inboundAccessMode: "allowlist",
      allowedSenders: [`ntfy-topic:${TOPIC}`],
    });
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("still warns, and only warns, when the server is public ntfy.sh", async () => {
    const config = guide().normalize(draftOf({ ...RECEIVING_VALUES, baseUrl: "https://ntfy.sh" }));
    const { eligibility } = await accepting.verdictOf(config);

    expect(eligibility.allowed).toBe(true);
    expect(paragraphs("overview").join("\n")).toContain("anyone who can post to the topic can start conversations");
  });

  it("does not make an edit replay the setup-only steps", () => {
    expect(continueBlockers(RECEIVING_VALUES, "edit")).toEqual([]);
    expect(continueBlockers({}, "edit")).toEqual(["Topic"]);
  });
});
