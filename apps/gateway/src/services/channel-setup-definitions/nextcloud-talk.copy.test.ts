import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateChannelInboundAccess,
  type ChannelSetupFieldDefinition,
  type ChannelSetupRichBlock,
  type ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { buildIntegrationConnectionChecks } from "../integration-diagnostics-service.js";
import { normalizeNextcloudTalkWebhookPayload, verifyNextcloudTalkSignature } from "../nextcloud-talk-webhook.js";
import { guideFinish, type GuideFinishOptions } from "./guide-finish.test-support.js";

function guide() {
  return requireChannelSetupDefinition("channel.nextcloud-talk");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Nextcloud Talk guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Nextcloud Talk guide has no field ${key}`);
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

function stepIds(): string[] {
  return guide().definition.wizard.steps.map((candidate) => candidate.id);
}

const NEXTCLOUD = "https://cloud.example.com";
const ROOM = "a1b2c3d4";
// A bot secret is 40 to 128 characters.
const SECRET = "bot-secret-".padEnd(48, "x");
const TEST_MESSAGE = "GoatCitadel channel setup verification.";

type Fetcher = NonNullable<GuideFinishOptions["fetch"]>;

/** A Nextcloud server whose Talk bot API answers a signed room message with the given status. */
function talk(status: number): Fetcher {
  return async (url) => {
    if (!new URL(url).pathname.endsWith(`/ocs/v2.php/apps/spreed/api/v1/bot/${ROOM}/message`)) {
      return new Response("{}", { status: 404 });
    }
    const ok = status >= 200 && status < 300;
    return new Response(
      JSON.stringify({
        ocs: { meta: { status: ok ? "ok" : "failure", statuscode: status }, data: ok ? { id: 42 } : {} },
      }),
      { status },
    );
  };
}

const { draftOf, connectionOf, continueBlockers, port, verdictOf } = guideFinish("channel.nextcloud-talk");
const botInstalled = guideFinish("channel.nextcloud-talk", { fetch: talk(201) });
const botMissing = guideFinish("channel.nextcloud-talk", { fetch: talk(401) });

const SEND_VALUES = {
  baseUrl: NEXTCLOUD,
  token: SECRET,
  defaultRoomId: ROOM,
};
const RECEIVING_VALUES = {
  ...SEND_VALUES,
  allowedSenders: ["users/alice"],
};

describe("Nextcloud Talk setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /posture|provenance|ingress|egress|sandbox message|activation plan/iu,
    );
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/https:\/\/<your public address>/u);
  });

  it("never says where the room token is in a web address: no official page confirms it (R46)", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/\/call\//u);
  });

  it("no longer shows the internal note about bringing setup into parity (item 9)", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/parity|already has runtime support/iu);
  });
});

describe("Nextcloud Talk setup guide: what it says up front (items 6 and 9, R48)", () => {
  it("opens with the intro, prerequisites and first message from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Send Nextcloud Talk messages through a Talk bot. Receiving needs an HTTPS address your Nextcloud server can reach.",
    );
    expect(wizard.prerequisites).toEqual([
      "Shell access to your Nextcloud server, to add a bot with occ.",
      "A bot secret of 40 to 128 characters.",
      "The room token of the conversation the bot should use.",
    ]);
    // Ruling R49: the test posts one visible message into the room and does not delete it, so asking for it is true.
    expect(paragraphs("first-message")).toEqual([
      "Check the test message arrived. To receive: reinstall the bot with this connection's webhook address and the same secret, turn it on for the room again, allow users/<your user name>, and send a message.",
    ]);
  });

  it("keeps the Nextcloud host field and the inbound webhook from the picker data", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.hostFields).toEqual(["baseUrl"]);
    expect(wizard.inboundWebhook).toEqual({
      pathTemplate: "/api/v1/integrations/connections/{connectionId}/nextcloud-talk/webhook",
    });
  });

  it("says in the intro that sending needs no public address and receiving needs an HTTPS one (item 6)", () => {
    expect(paragraphs("overview")).toContain(
      "Sending works without a public address. Receiving needs an HTTPS address your Nextcloud server can reach.",
    );
  });

  it("says receiving is optional and that senders are written users/<name>", () => {
    expect(paragraphs("overview")).toContain(
      "Receiving is optional. Only people you allow (written users/ followed by their user name, for example users/alice) can start conversations.",
    );
  });

  it("says in the intro that this channel sends text and does not support attachments (R48)", () => {
    expect(paragraphs("overview")).toContain("This channel sends text. Attachments aren't supported.");
  });

  it("tells the person where the Nextcloud host gets allowed, not just that it must be (item 5)", () => {
    expect(textOf(step("overview").body)).toContain(
      "GoatCitadel can reach your Nextcloud server only once the server is in the hosts GoatCitadel may reach: the setup test has an Allow these hosts button for that.",
    );
  });

  it("hides the setup-only intro when a saved connection is changed", () => {
    expect(step("overview").createOnly).toBe(true);
  });
});

describe("Nextcloud Talk setup guide: adding the bot (items 1 and 2)", () => {
  it("adds a setup-only instruction step between the intro and the fields", () => {
    const install = step("install-bot");

    expect(stepIds().indexOf("install-bot")).toBeGreaterThan(stepIds().indexOf("overview"));
    expect(stepIds().indexOf("install-bot")).toBeLessThan(stepIds().indexOf("collect-values-identity"));
    expect(install.createOnly).toBe(true);
    expect(install.kind).toBe("instruction");
    expect(install.title).toBe("Add the bot to Nextcloud Talk");
  });

  it("starts with shell access, because a bot can only be added from the command line", () => {
    expect(paragraphs("install-bot")[0]).toBe(
      "GoatCitadel posts to Talk as a bot. Talk only lets you add a bot from the command line, so you need shell access to your Nextcloud server. Run occ the way you usually do there.",
    );
  });

  it("sends: creates a response-only bot that takes no webhook address, copies its secret, and turns it on for the room (R53)", () => {
    expect(step("install-bot").body).toContainEqual({
      kind: "list",
      ordered: true,
      items: [
        "Create the bot with occ talk:bot:create and give it a name. It gets the response feature only, so it can post messages and reactions, and it takes no webhook address. Talk sends room messages to a webhook address only for a bot with the webhook feature.",
        "Copy the bot's secret. occ prints a random one unless you give your own with --secret. It must be 40 to 128 characters, and GoatCitadel needs the same secret.",
        "Turn the bot on for the conversation with occ talk:bot:setup. Give it the bot's ID (occ talk:bot:list lists your bots) and the conversation's room token.",
      ],
    });
    // The send-only commands name no webhook address and no webhook feature.
    expect(step("install-bot").body).toContainEqual({
      kind: "code",
      language: "shell",
      code: ['occ talk:bot:create "GoatCitadel"', "occ talk:bot:setup <bot-id> <room-token>"].join("\n"),
    });
  });

  it("receives: warns that Talk posts every room message to the webhook address, then installs the bot again with this connection's address (R53)", () => {
    const body = step("install-bot").body ?? [];

    expect(body).toContainEqual({
      kind: "note",
      tone: "warning",
      text: "Talk sends every message posted in the conversation to the webhook address of a bot that has the webhook feature. Use only an address you control.",
    });
    expect(body).toContainEqual({
      kind: "list",
      ordered: true,
      items: [
        "Copy this connection's webhook address.",
        "Uninstall the bot with occ talk:bot:uninstall and its bot ID.",
        "Install the bot again with occ talk:bot:install: the same name and secret, this connection's webhook address, and the features webhook and response.",
        "Turn it on for the conversation again with occ talk:bot:setup.",
      ],
    });
    expect(body).toContainEqual({
      kind: "code",
      language: "shell",
      code: [
        "occ talk:bot:uninstall <bot-id>",
        'occ talk:bot:install --feature webhook --feature response "GoatCitadel" "<secret>" "<webhook address>"',
        "occ talk:bot:setup <bot-id> <room-token>",
      ].join("\n"),
    });
  });

  it("gives the two phases as a short sending line and a receiving paragraph, with no run-on instructions (R53)", () => {
    expect(paragraphs("install-bot").slice(1)).toEqual([
      "Sending is all a send-only setup needs:",
      "Receiving (optional), after you finish. No occ command changes a bot's webhook address, so to receive you install the bot again with this connection's address. GoatCitadel shows it after you finish: Settings › Channels › this connection.",
    ]);
    // Every instruction is a numbered list item; no paragraph is a chain of steps.
    expect((step("install-bot").body ?? []).filter((block) => block.kind === "list")).toHaveLength(2);
  });

  it("never says any web address works, never suggests a placeholder, and never calls it harmless (R53)", () => {
    expect(wizardText()).not.toMatch(
      /any web address|any address|any https|placeholder|doesn't matter|does not matter|harmless/iu,
    );
  });

  it("repeats the warning where an edit still sees it: the finish step is not setup-only (R53)", () => {
    expect(step("finish").createOnly).toBeUndefined();
    expect(paragraphs("finish")[0]).toContain(
      "Talk sends every message posted in the conversation to that address, so use only an address you control.",
    );
  });

  it("links the vendor pages the steps rest on", () => {
    const text = textOf(step("install-bot").body);

    expect(text).toContain("https://nextcloud-talk.readthedocs.io/en/latest/occ/");
    expect(text).toContain("https://nextcloud-talk.readthedocs.io/en/latest/bots/");
  });

  it("asks only for what every setup needs: the receiving reinstall is a list, not a box that blocks Continue (R50)", () => {
    const boxes = (step("install-bot").checklist ?? []).map((item) => item.label);

    expect(boxes).toEqual(["Create the bot with the response feature", "Turn the bot on for the conversation"]);
    expect(boxes.join("\n")).not.toMatch(/receiv|again|webhook address|public/iu);
  });

  it("does not guess a web address for the placeholder or the webhook: the only addresses are the vendor's pages", () => {
    const blocks = step("install-bot").body ?? [];
    const written = blocks.filter((block) => block.kind !== "link").map((block) => JSON.stringify(block));
    const links = blocks.flatMap((block) => (block.kind === "link" ? [block.href] : []));

    expect(written.join("\n")).not.toMatch(/https?:\/\//iu);
    expect(links).toEqual([
      "https://nextcloud-talk.readthedocs.io/en/latest/occ/",
      "https://nextcloud-talk.readthedocs.io/en/latest/bots/",
    ]);
  });
});

describe("Nextcloud Talk setup guide: the base URL (item 5, A10, N8)", () => {
  it("says the rule in the field: https, or this computer only", () => {
    expect(field("baseUrl").explanation).toBe(
      "The address of your Nextcloud server. Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
    );
  });

  it("is still required, asked first", () => {
    expect(field("baseUrl").required).toBe(true);
    expect(fieldKeys("collect-values-identity")[0]).toBe("baseUrl");
    expect(guide().validate(draftOf({ token: SECRET, defaultRoomId: ROOM }))).toEqual([
      expect.objectContaining({ key: "baseUrl_required", fieldKey: "baseUrl" }),
    ]);
  });

  it("refuses plain http away from this computer with the message the live test would give", () => {
    const issues = guide().validate(draftOf({ ...SEND_VALUES, baseUrl: "http://cloud.example.com" }));

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
    const issues = guide().validate(draftOf({ ...SEND_VALUES, baseUrl: "cloud.example.com" }));

    expect(issues.map((issue) => issue.key)).toEqual(["baseUrl_malformed"]);
  });

  it("refuses a scheme that is not http or https, even for this computer", () => {
    const issues = guide().validate(draftOf({ ...SEND_VALUES, baseUrl: "ftp://localhost" }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "baseUrl_malformed",
        fieldKey: "baseUrl",
        message: "Base URL should start with https://.",
      }),
    ]);
  });

  it("accepts https, and plain http for this computer only", () => {
    for (const baseUrl of [
      NEXTCLOUD,
      "https://cloud.example.com/nextcloud",
      "http://localhost:8080",
      "http://127.0.0.1",
    ]) {
      expect(guide().validate(draftOf({ ...SEND_VALUES, baseUrl })), baseUrl).toEqual([]);
    }
  });
});

describe("Nextcloud Talk setup guide: the bot secret and the room token (items 3 and 7, A5)", () => {
  it("names the pasted field Bot secret and offers it first, then the variable name under Advanced with its name rule", () => {
    const keys = fieldKeys("collect-values-identity");
    const token = field("token");
    const env = field("tokenEnv");

    expect(keys.indexOf("token")).toBeLessThan(keys.indexOf("tokenEnv"));
    expect(token.label).toBe("Bot secret");
    expect(token.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
    expect(token.advanced).not.toBe(true);
    expect(token.required).toBe(false);
    expect(env.advanced).toBe(true);
    expect(env.label).toBe("Bot secret from an environment variable (advanced)");
    expect(env.explanation).toBe(
      "Name of the env var that stores the bot secret. The variable's name must start with NEXTCLOUD_TALK_ (for example NEXTCLOUD_TALK_TOKEN). Set it where GoatCitadel starts, then restart GoatCitadel. It must also end in _TOKEN or _SECRET.",
    );
  });

  it("says where the secret comes from and what makes one wrong", () => {
    expect(textOf(field("token").whereToFind)).toContain(
      "It is the secret occ talk:bot:create printed, or the one you gave it with --secret. If you no longer have it, uninstall the bot and create it again.",
    );
    expect(field("token").commonMistakes).toEqual([
      "A secret shorter than 40 characters. occ requires 40 to 128.",
      "A different secret from the one the bot has.",
    ]);
  });

  it("calls the room field Room token and says how to list it yourself, not who to ask (R53)", () => {
    const room = field("defaultRoomId");

    expect(room.label).toBe("Room token");
    expect(room.explanation).toBe(
      "The token Talk gives the conversation. The test message and any send that names no room go to this conversation.",
    );
    expect(textOf(room.whereToFind)).toContain(
      "This is the room token you give occ talk:bot:setup. Talk's own API calls it the conversation's token, and its list of your conversations shows one for each: GET /ocs/v2.php/apps/spreed/api/v4/room on your Nextcloud address, signed in as yourself.",
    );
    // The person has shell access to the server, so telling them to ask an admin would send them in a circle.
    expect(textOf(room.whereToFind)).not.toMatch(/admin/iu);
    expect(textOf(room.whereToFind)).toContain("https://nextcloud-talk.readthedocs.io/en/latest/conversation/");
    expect(room.commonMistakes).toEqual(["Using the conversation's name instead of its token."]);
  });

  it("asks for the room token with the destinations, and still requires it", () => {
    expect(fieldKeys("collect-values-destinations")).toEqual(["defaultRoomId"]);
    expect(field("defaultRoomId").required).toBe(true);
    expect(guide().validate(draftOf({ baseUrl: NEXTCLOUD, token: SECRET }))).toEqual([
      expect.objectContaining({
        key: "defaultRoomId_required",
        fieldKey: "defaultRoomId",
        message: "Room token is required.",
      }),
    ]);
  });
});

describe("Nextcloud Talk setup guide: receiving (items 4 and 6, A7, A8)", () => {
  it("says the sender format: users/ followed by the user name", () => {
    expect(fieldKeys("sender-access")).toContain("allowedSenders");
    const senders = step("sender-access").fields?.find((candidate) => candidate.key === "allowedSenders");

    expect(senders?.explanation).toBe("users/ followed by your Nextcloud user name, for example users/alice.");
  });

  it("matches the id Talk sends, users/alice, and not a bare name", () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const event = normalizeNextcloudTalkWebhookPayload({
      connectionId: "11111111-1111-1111-1111-111111111111",
      payload: {
        type: "Create",
        actor: { type: "Person", id: "users/alice", name: "Alice" },
        object: { id: "7", content: JSON.stringify({ message: "hello", parameters: {} }) },
        target: { id: ROOM, name: "Ops" },
      },
    });
    const actor = event.kind === "message" ? event.actorId : undefined;

    expect(actor).toBe("users/alice");
    expect(evaluateChannelInboundAccess({ config, actorId: actor })).toMatchObject({ allowed: true });
    expect(evaluateChannelInboundAccess({ config, actorId: "alice" })).toMatchObject({
      allowed: false,
      reason: "sender_not_allowlisted",
    });
  });

  it("shows the sender step for everyone, because there is no receive switch", () => {
    expect(step("sender-access").visibleWhenFieldEquals).toBeUndefined();
  });

  it("offers the open-access choice only for a connection that was saved open", () => {
    const mode = step("sender-access").fields?.find((candidate) => candidate.key === "inboundAccessMode");

    expect(mode?.options?.map((option) => option.value)).toEqual(["allowlist", "open_legacy"]);
    expect(mode?.visibleWhenFieldEquals).toEqual({ fieldKey: "inboundAccessWasOpen", value: true });
  });

  it("receives on the Gateway webhook route and needs no receive switch of its own", () => {
    expect(fieldKeys("collect-values-identity")).not.toContain("inboundStreamEnabled");
    expect(guide().definition.wizard.inboundWebhook?.pathTemplate).toContain("/nextcloud-talk/webhook");
  });
});

describe("Nextcloud Talk setup guide: the test and finishing (item 10, R49)", () => {
  it("says what the test posts, that it stays in the room, and that it can't check receiving", () => {
    expect(paragraphs("test")).toEqual([
      "The test signs one message with your bot secret and posts it into the room as the bot: check that \"GoatCitadel channel setup verification.\" arrived in the conversation. The test doesn't delete it. It can't check receiving, because it only sends.",
    ]);
    expect(paragraphs("test")[0]).toContain(TEST_MESSAGE);
  });

  it("finishes by saving for sending, and points receiving at the next step", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection so GoatCitadel can send from it. To receive messages, install the bot again with this connection's webhook address and the same secret (the last step shows how). Talk sends every message posted in the conversation to that address, so use only an address you control.",
    ]);
    expect(step("finish").successCriteria).toEqual([
      "Nextcloud accepted the signed test message.",
      "The test message arrived in the room.",
    ]);
  });
});

describe("Nextcloud Talk setup guide: when the test fails (A13)", () => {
  const items = () => step("test").troubleshooting ?? [];
  const body = (id: string) => items().find((item) => item.id === id)?.body ?? "";

  it("lists the failures a Nextcloud Talk setup really hits, on the test step", () => {
    expect(items().map((item) => item.id)).toEqual([
      "bot-rejected",
      "secret-short",
      "host-not-allowed",
      "variable-not-found",
      "send-uncertain",
      "no-reply",
    ]);
  });

  it("covers a bot that lacks the response feature, isn't on for the room, or has another secret", () => {
    expect(items().find((item) => item.id === "bot-rejected")?.title).toBe(
      "It says Nextcloud Talk rejected the signed room send",
    );
    expect(body("bot-rejected")).toBe(
      "Check these in order. The bot must have the response feature, or it can't post: a bot made with occ talk:bot:create has it. It must be turned on for this conversation with occ talk:bot:setup (occ talk:bot:list with the room token lists the bots for that conversation). The Room token must be the conversation's token, not its name. And the secret here must be the one the bot has.",
    );
  });

  it("says a secret under 40 characters can't be used", () => {
    expect(items().find((item) => item.id === "secret-short")?.title).toBe("occ says the secret is too short");
    expect(body("secret-short")).toBe(
      "A bot secret must be 40 to 128 characters. Create the bot again with a longer one, or leave --secret out and let occ make one, and paste the same secret here.",
    );
  });

  it("names the Allow these hosts button for the Nextcloud server", () => {
    expect(items().find((item) => item.id === "host-not-allowed")?.title).toBe(
      "It says GoatCitadel can't reach your Nextcloud server yet",
    );
    expect(body("host-not-allowed")).toContain("Allow these hosts");
  });

  it("gives the variable name rule, prefix and suffix, and the restart", () => {
    expect(body("variable-not-found")).toBe(
      "A variable's name must start with NEXTCLOUD_TALK_ and end in _TOKEN or _SECRET (for example NEXTCLOUD_TALK_TOKEN), and you must restart GoatCitadel after you set it. Or paste the secret instead.",
    );
  });

  it("tells a person with an uncertain send to look in the room before testing again", () => {
    expect(items().find((item) => item.id === "send-uncertain")?.title).toBe("It says the send outcome is uncertain");
    expect(body("send-uncertain")).toContain("see whether the test message arrived before you run the test again");
  });

  it("points a silent bot at the reinstall, the HTTPS address, the sender format and the running Gateway", () => {
    const noReply = body("no-reply");

    expect(noReply).toContain("A bot made with occ talk:bot:create hears nothing: it has the response feature only.");
    expect(noReply).toContain("installed with this connection's webhook address and the same secret");
    expect(noReply).toContain("turned on for the room again after any reinstall");
    expect(noReply).toContain("over HTTPS");
    expect(noReply).toContain("users/alice");
    expect(noReply).toContain("Who may message this bot");
    expect(noReply).toContain("GoatCitadel must be running");
  });
});

describe("Nextcloud Talk setup guide: asking for what is missing (A15)", () => {
  it("asks for the bot secret, and jumps to the pasted field", () => {
    const issues = guide().validate(draftOf({ baseUrl: NEXTCLOUD, defaultRoomId: ROOM }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "nextcloud_talk_auth_missing",
        fieldKey: "token",
        level: "error",
        message: "Paste the Nextcloud Talk bot secret.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("does not ask when a saved secret or a variable name is already there", () => {
    const saved = draftOf(
      { baseUrl: NEXTCLOUD, defaultRoomId: ROOM },
      { hydration: { status: "opaque-secret", fieldState: { token: "configured" }, warnings: [] } },
    );
    const variable = draftOf({ baseUrl: NEXTCLOUD, defaultRoomId: ROOM, tokenEnv: "NEXTCLOUD_TALK_TOKEN" });

    expect(guide().validate(saved)).toEqual([]);
    expect(guide().validate(variable)).toEqual([]);
  });
});

describe("Nextcloud Talk send-only path: can it finish?", () => {
  it("lets Continue pass with an address, a bot secret and a room token", () => {
    expect(continueBlockers(SEND_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(SEND_VALUES))).toEqual([]);
  });

  it("asks for those three and nothing about receiving", () => {
    expect(continueBlockers({})).toEqual([
      "Base URL",
      "Bot secret or Bot secret from an environment variable (advanced)",
      "Room token",
    ]);
  });

  it("is cleared by the setup test once the bot is created and turned on for the room", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { issues, live, eligibility } = await botInstalled.verdictOf(config);

    expect(config).toEqual({ baseUrl: NEXTCLOUD, token: SECRET, defaultRoomId: ROOM, inboundAccessMode: "allowlist" });
    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["nextcloud_sandbox_send", "pass"],
    ]);
    // The only note is that nobody is allowed to message the bot yet. The Gateway does not hold Finalize back for it:
    // a send-only setup has no senders, and the person adds theirs after finishing.
    expect(issues.map((issue) => issue.key)).toEqual(["inbound_access_allowlist_empty"]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("signs the test message with the bot secret, the one occ talk:bot:create printed", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { deps } = await botInstalled.verdictOf(config);
    const send = vi
      .mocked(deps.fetchWithDiagnosticsTimeout)
      .mock.calls.find(([url]) => url.includes("/ocs/v2.php/apps/spreed/api/v1/bot/"));
    const headers = new Headers(send?.[1]?.headers);
    const random = headers.get("x-nextcloud-talk-bot-random") ?? "";

    expect(send?.[0]).toBe(`${NEXTCLOUD}/ocs/v2.php/apps/spreed/api/v1/bot/${ROOM}/message`);
    expect(JSON.parse(String(send?.[1]?.body))).toEqual({ message: TEST_MESSAGE });
    expect(random).not.toBe("");
    expect(headers.get("x-nextcloud-talk-bot-signature")).toBe(
      createHmac("sha256", SECRET)
        .update(random + TEST_MESSAGE)
        .digest("hex"),
    );
  });

  it("holds Finalize back while the bot is not set up for the room, and the guide names the fixes", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const { eligibility } = await botMissing.verdictOf(config);

    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons.join("\n")).toContain("Verify bot registration, token and room membership.");
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("bot-rejected");
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("secret-short");
  });

  it("holds Finalize back while the Nextcloud host is not allowed, and the guide names the button", async () => {
    const config = guide().normalize(draftOf(SEND_VALUES));
    const deps = { ...port(), isConnectionUrlAllowlisted: vi.fn(() => false) };
    const url = buildIntegrationConnectionChecks(deps, connectionOf(config)).find((check) => check.key === "url");

    expect(url).toMatchObject({
      status: "warn",
      message: "Nextcloud base URL host is not in the current outbound allowlist.",
    });
    expect(step("test").troubleshooting?.find((item) => item.id === "host-not-allowed")?.body).toContain(
      "Allow these hosts",
    );
  });

  it("asks this path to tick nothing it doesn't need: the setup step's boxes are the install and the room (R50)", () => {
    // The shared helper doesn't model checklists, so assert the step's boxes directly. Continue is blocked until each
    // box is ticked, and a send-only setup installs the bot and turns it on for one room, nothing more.
    const boxes = (step("install-bot").checklist ?? []).map((item) => item.label);

    expect(continueBlockers(SEND_VALUES)).toEqual([]);
    expect(boxes).toHaveLength(2);
    expect(boxes.join("\n")).not.toMatch(/receiv|webhook address|again/iu);
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
    const config = guide().normalize(draftOf({ ...SEND_VALUES, token: undefined, tokenEnv: "NEXTCLOUD_TALK_TOKEN" }));
    const previous = process.env.NEXTCLOUD_TALK_TOKEN;
    process.env.NEXTCLOUD_TALK_TOKEN = SECRET;
    try {
      const structural = buildIntegrationConnectionChecks(port(), connectionOf(config));

      // Nobody is allowed to message the bot yet: that is not a setup problem (see the send-only test above).
      expect(
        structural.filter((check) => check.status !== "pass" && check.key !== "inbound_access_allowlist_empty"),
      ).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.NEXTCLOUD_TALK_TOKEN;
      else process.env.NEXTCLOUD_TALK_TOKEN = previous;
    }
  });

  it("refuses to be cleared over plain http away from this computer, which the field already said", async () => {
    const config = guide().normalize(draftOf({ ...SEND_VALUES, baseUrl: "http://cloud.example.com" }));
    const { eligibility } = await verdictOf(config);

    expect(eligibility.allowed).toBe(false);
  });
});

describe("Nextcloud Talk receiving path: can it finish?", () => {
  it("lets Continue pass with a sender listed, and with none", () => {
    expect(continueBlockers(RECEIVING_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(RECEIVING_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test with an allowed sender: receiving needs nothing before you finish", async () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const { issues, eligibility } = await botInstalled.verdictOf(config);

    expect(config).toMatchObject({ inboundAccessMode: "allowlist", allowedSenders: ["users/alice"] });
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("is still cleared before any sender is allowed: the person adds their ID after finishing", async () => {
    const { eligibility } = await botInstalled.verdictOf(guide().normalize(draftOf(SEND_VALUES)));

    expect(eligibility.allowed).toBe(true);
  });

  it("verifies what Talk posts with the same secret the bot has", () => {
    const body = Buffer.from(JSON.stringify({ type: "Create" }), "utf8");
    const random = "r".repeat(64);
    const signature = createHmac("sha256", SECRET)
      .update(Buffer.concat([Buffer.from(random, "utf8"), body]))
      .digest("hex");

    expect(verifyNextcloudTalkSignature(random, signature, body, SECRET)).toBe(true);
    expect(verifyNextcloudTalkSignature(random, signature, body, `${SECRET}-other`)).toBe(false);
  });

  it("does not make an edit replay the setup-only steps", () => {
    expect(step("install-bot").createOnly).toBe(true);
    expect(continueBlockers(RECEIVING_VALUES, "edit")).toEqual([]);
    expect(continueBlockers({}, "edit")).toEqual([
      "Base URL",
      "Bot secret or Bot secret from an environment variable (advanced)",
      "Room token",
    ]);
  });
});
