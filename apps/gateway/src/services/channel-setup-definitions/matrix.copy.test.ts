import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSetupFieldDefinition,
  ChannelSetupRichBlock,
  ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { buildIntegrationConnectionChecks } from "../integration-diagnostics-service.js";
import { guideFinish, type GuideFinishOptions } from "./guide-finish.test-support.js";

function guide() {
  return requireChannelSetupDefinition("channel.matrix");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Matrix guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Matrix guide has no field ${key}`);
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

const ROOM = "!abc123:example.com";
const HOMESERVER = "https://matrix.example.com";
const ALICE = "@alice:example.com";

/** A homeserver that knows the bot and the rooms it has joined, and accepts a message into any room. */
function homeserver(joinedRooms: string[]): NonNullable<GuideFinishOptions["fetch"]> {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/account/whoami")) return json({ user_id: "@bot:example.com" });
    if (path.endsWith("/joined_rooms")) return json({ joined_rooms: joinedRooms });
    if (init?.method === "PUT" && path.includes("/send/m.room.message/")) return json({ event_id: "$event1" });
    return new Response("{}", { status: 404 });
  };
}

const { draftOf, connectionOf, continueBlockers, port, verdictOf } = guideFinish("channel.matrix");
const inRoom = guideFinish("channel.matrix", { fetch: homeserver([ROOM]) });
const notInRoom = guideFinish("channel.matrix", { fetch: homeserver([]) });

const SEND_ONLY_VALUES = {
  homeserverUrl: HOMESERVER,
  accessToken: "secret-reference",
};
const SEND_WITH_ROOM_VALUES = {
  ...SEND_ONLY_VALUES,
  defaultRoomId: ROOM,
};
const RECEIVING_VALUES = {
  ...SEND_WITH_ROOM_VALUES,
  inboundStreamEnabled: true,
  allowedSenders: [ALICE],
};

describe("Matrix setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /posture|provenance|ingress|egress|sandbox message|activation plan/iu,
    );
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/https:\/\/<your public address>/u);
  });
});

describe("Matrix setup guide: what it says up front (item 6, R48)", () => {
  it("opens with the intro, prerequisites and first message from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Send and receive Matrix messages through a bot account on your homeserver. No public web address is needed: GoatCitadel connects out, and only hears messages while it's running.",
    );
    expect(wizard.prerequisites).toEqual([
      "A Matrix account for the bot and its access token.",
      "The bot invited to and joined in a room with encryption off. GoatCitadel can't read encrypted rooms and doesn't accept invites.",
      "Your homeserver in the hosts GoatCitadel may reach.",
    ]);
    expect(paragraphs("first-message")).toEqual([
      "Check the test notice arrived. To receive: turn on Receive messages, allow your Matrix ID (for example @alice:example.com), post in the room, and check the reply.",
    ]);
  });

  it("keeps the homeserver host field from the picker data, and no inbound webhook", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.hostFields).toEqual(["homeserverUrl"]);
    expect(wizard.inboundWebhook).toBeUndefined();
  });

  it("says in the intro that this channel sends text and does not support attachments (R48)", () => {
    expect(paragraphs("overview")).toContain("This channel sends text. Attachments aren't supported.");
  });

  it("says receiving connects out, so no public web address is needed, and only allowed IDs can start a conversation", () => {
    const text = paragraphs("overview").join("\n");

    expect(text).toContain("so no public web address is needed");
    expect(text).toContain("Only Matrix IDs you allow (for example @alice:example.com) can start conversations.");
  });

  it("tells the person where the homeserver host gets allowed, not just that it must be", () => {
    expect(textOf(step("overview").body)).toContain("the setup test has an Allow these hosts button for that");
  });

  it("hides the setup-only intro when a saved connection is changed", () => {
    expect(step("overview").createOnly).toBe(true);
  });
});

describe("Matrix setup guide: making the bot account and its room (items 1, 2 and 4)", () => {
  it("adds a setup-only step between the intro and the fields", () => {
    const create = step("create-bot");

    expect(stepIds().indexOf("create-bot")).toBeGreaterThan(stepIds().indexOf("overview"));
    expect(stepIds().indexOf("create-bot")).toBeLessThan(stepIds().indexOf("collect-values-identity"));
    expect(create.createOnly).toBe(true);
    expect(create.kind).toBe("instruction");
  });

  it("walks through the account, the token, an unencrypted room and the invite the bot must accept", () => {
    expect(step("create-bot").body).toContainEqual({
      kind: "list",
      ordered: true,
      items: [
        "Create a Matrix account for the bot and sign in as the bot.",
        "Copy the bot's access token. In Element it is under Settings › Help & About, as Your Access Token. Signing that session out makes the token stop working, and GoatCitadel doesn't renew tokens.",
        "From your own account, create a new room with encryption off and invite the bot into it. GoatCitadel can't read encrypted rooms. Element encrypts a new private room unless you turn that off when you create it.",
        "Sign in as the bot in a Matrix app and accept the invite. GoatCitadel doesn't accept invites for you.",
      ],
    });
    expect(paragraphs("create-bot")).toEqual([
      "GoatCitadel signs in as a bot account, so make one first. The menus here are Element's; other Matrix apps differ.",
    ]);
  });

  it("links the vendor pages the steps rest on", () => {
    const text = textOf(step("create-bot").body);

    expect(text).toContain("https://spec.matrix.org/latest/client-server-api/");
    expect(text).toContain("https://ems-docs.element.io/books/element-support/page/help-about");
    expect(text).toContain("https://github.com/element-hq/element-web/blob/develop/docs/e2ee.md");
  });

  it("asks only for what a person can do before continuing", () => {
    expect((step("create-bot").checklist ?? []).map((item) => item.label)).toEqual([
      "Create the bot's Matrix account and copy its access token",
      "Create a room with encryption off and invite the bot",
      "Sign in as the bot and accept the invite",
    ]);
  });

  it("does not claim a direct message is always encrypted: Element only does that when the other side has keys (R46)", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/direct message is usually encrypted/iu);
  });
});

describe("Matrix setup guide: the homeserver URL (items 3 and 7, A10)", () => {
  it("says the rule in the field, and that it is the client API address", () => {
    expect(field("homeserverUrl").explanation).toBe(
      "The address of your homeserver's client API. Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
    );
  });

  it("says the API address can differ from the server name in a Matrix ID, and where apps find it", () => {
    const text = textOf(field("homeserverUrl").whereToFind);

    expect(text).toContain(
      "Your server's admin can tell you. Matrix apps find it in the server's /.well-known/matrix/client file (m.homeserver › base_url), and it can differ from the part of your Matrix ID after the colon.",
    );
    expect(text).toContain("https://spec.matrix.org/latest/client-server-api/");
  });

  it("is still the one required field, asked first", () => {
    expect(field("homeserverUrl").required).toBe(true);
    expect(fieldKeys("collect-values-identity")[0]).toBe("homeserverUrl");
    expect(guide().validate(draftOf({ accessToken: "secret-reference" }))).toEqual([
      expect.objectContaining({ key: "homeserverUrl_required", fieldKey: "homeserverUrl" }),
    ]);
  });

  it("refuses plain http away from this computer with the message the live test would give", () => {
    const issues = guide().validate(draftOf({ ...SEND_ONLY_VALUES, homeserverUrl: "http://matrix.example.com" }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "homeserverUrl_malformed",
        fieldKey: "homeserverUrl",
        level: "error",
        message: "Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
        failureCategory: "malformed_value",
      }),
    ]);
  });

  it("refuses an address with no scheme", () => {
    const issues = guide().validate(draftOf({ ...SEND_ONLY_VALUES, homeserverUrl: "matrix.example.com" }));

    expect(issues.map((issue) => issue.key)).toEqual(["homeserverUrl_malformed"]);
  });

  it("refuses a scheme that is not http or https, even for this computer", () => {
    const issues = guide().validate(draftOf({ ...SEND_ONLY_VALUES, homeserverUrl: "ftp://localhost" }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "homeserverUrl_malformed",
        fieldKey: "homeserverUrl",
        message: "Homeserver URL should start with https://.",
      }),
    ]);
  });

  it("accepts https, and plain http for this computer only", () => {
    for (const homeserverUrl of [
      HOMESERVER,
      "https://matrix.example.com:8448/",
      "http://localhost:8008",
      "http://127.0.0.1:8008",
    ]) {
      expect(guide().validate(draftOf({ ...SEND_ONLY_VALUES, homeserverUrl })), homeserverUrl).toEqual([]);
    }
  });
});

describe("Matrix setup guide: the access token (items 1 and 7, A5)", () => {
  it("says where the token is and that a signed-out session's token stops working", () => {
    const text = textOf(field("accessToken").whereToFind);

    expect(text).toContain(
      "Sign in as the bot. In Element it is under Settings › Help & About, as Your Access Token. Signing that session out makes the token stop working.",
    );
    expect(text).toContain("https://ems-docs.element.io/books/element-support/page/help-about");
  });

  it("offers a pasted token first, then the variable name under Advanced with its name rule", () => {
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
      "Name of the env var that stores the bot's Matrix access token. The variable's name must start with MATRIX_ (for example MATRIX_ACCESS_TOKEN). Set it where GoatCitadel starts, then restart GoatCitadel.",
    );
  });
});

describe("Matrix setup guide: the default room (item 7)", () => {
  it("says where the room's internal ID is, and that a name or alias is not accepted", () => {
    const room = field("defaultRoomId");

    expect(textOf(room.whereToFind)).toContain("In Element, open the room's settings › Advanced › Internal Room ID.");
    expect(textOf(room.whereToFind)).toContain(
      "https://ems-docs.element.io/books/element-support/page/managing-a-room-room-settings",
    );
    expect(room.commonMistakes).toEqual([
      "Using the room's name or #alias:example.com. GoatCitadel needs the internal room ID.",
    ]);
  });

  it("says what the room is for, and that it can be left empty", () => {
    expect(field("defaultRoomId").explanation).toBe(
      "The room that gets the test notice and any send that names no room. Leave it empty to skip the test notice.",
    );
    expect(field("defaultRoomId").required).toBe(false);
  });

  it("is asked with the destinations", () => {
    expect(fieldKeys("collect-values-destinations")).toEqual(["defaultRoomId"]);
  });

  it("refuses a room alias, which the Gateway does not accept", () => {
    const issues = guide().validate(draftOf({ ...SEND_ONLY_VALUES, defaultRoomId: "#alias:example.com" }));

    expect(issues.map((issue) => issue.key)).toEqual(["defaultRoomId_malformed"]);
  });
});

describe("Matrix setup guide: receiving (items 5 and 6, A7, A8)", () => {
  it("is off by default and named the way the first message names it", () => {
    const receive = field("inboundStreamEnabled");

    expect(receive.label).toBe("Receive messages");
    expect(receive.defaultValue).toBe(false);
    expect(receive.explanation).toBe(
      "Listen for messages in rooms the bot has joined, so people can start conversations with it.",
    );
    expect(receive.whyNeeded).toBe(
      "GoatCitadel connects out to your homeserver to hear new messages, so no public web address is needed. Receiving stays off unless you turn it on, and only allowed Matrix IDs can start conversations.",
    );
  });

  it("shows the sender step only while receiving is on, with no access-mode choice", () => {
    const sender = step("sender-access");

    expect(sender.visibleWhenFieldEquals).toEqual({ fieldKey: "inboundStreamEnabled", value: true });
    expect(fieldKeys("sender-access")).toEqual(["allowedSenders"]);
  });

  it("says the Matrix ID format a sender must be written in", () => {
    expect(field("allowedSenders").explanation).toBe(
      "Your Matrix ID with the @ and the server, for example @alice:example.com.",
    );
  });

  it("never carries an open legacy mode over once receiving is turned on", () => {
    const open = guide().hydrate(connectionOf({ ...SEND_ONLY_VALUES, inboundAccessMode: "open_legacy" })).draft;

    expect(guide().normalize(draftOf({ ...open, inboundStreamEnabled: true }))).toMatchObject({
      inboundStreamEnabled: true,
      inboundAccessMode: "allowlist",
    });
  });
});

describe("Matrix setup guide: the test and finishing", () => {
  it("says what the test does, then asks the person to check the notice arrived", () => {
    expect(paragraphs("test")).toEqual([
      "The test checks the access token with your homeserver. If you set a Default room ID, it also checks that the bot has joined that room and posts a test notice there. Check that the notice arrived in the room.",
    ]);
  });

  it("finishes by saving for sending, and points receiving at the next step", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection so GoatCitadel can send from it. To receive messages, turn on Receive messages and allow your Matrix ID (the last step shows how).",
    ]);
    expect(step("finish").successCriteria).toEqual([
      "The homeserver accepted the access token.",
      "The bot has joined the Default room, or you chose to supply the room per send.",
      "The test notice arrived in the room, or you set no Default room ID.",
    ]);
  });
});

describe("Matrix setup guide: when the test fails (A13)", () => {
  const items = () => step("test").troubleshooting ?? [];
  const body = (id: string) => items().find((item) => item.id === id)?.body ?? "";

  it("lists the failures a Matrix setup really hits, on the test step", () => {
    expect(items().map((item) => item.id)).toEqual([
      "token-rejected",
      "not-joined",
      "room-rejected",
      "host-not-allowed",
      "variable-not-found",
      "no-reply",
    ]);
  });

  it("sends a rejected token back to the bot's own session", () => {
    expect(body("token-rejected")).toContain("Sign in as the bot");
    expect(body("token-rejected")).toContain("A token stops working when its session is signed out");
    expect(body("token-rejected")).toContain("can't renew it");
  });

  it("says the bot has to accept its invite, because GoatCitadel does not", () => {
    expect(items().find((item) => item.id === "not-joined")?.title).toBe("It says the bot hasn't joined the room");
    expect(body("not-joined")).toContain("sign in as the bot in a Matrix app and accept the invite");
    expect(body("not-joined")).toContain("GoatCitadel doesn't accept invites for you");
  });

  it("sends a refused notice to the internal room ID", () => {
    expect(body("room-rejected")).toContain("internal ID, not its name or an alias");
    expect(body("room-rejected")).toContain("Room settings › Advanced › Internal Room ID");
  });

  it("names the Allow these hosts button for the homeserver", () => {
    expect(items().find((item) => item.id === "host-not-allowed")?.title).toBe(
      "It says GoatCitadel can't reach your homeserver yet",
    );
    expect(body("host-not-allowed")).toContain("Allow these hosts");
  });

  it("points a variable that isn't found at the name rule and the restart", () => {
    expect(body("variable-not-found")).toContain("MATRIX_");
    expect(body("variable-not-found")).toContain("restart GoatCitadel");
  });

  it("points a silent bot at receiving, the allowed ID, encryption, the invite and the running Gateway", () => {
    const noReply = body("no-reply");

    expect(noReply).toContain("Receive messages must be on");
    expect(noReply).toContain("Who may message this bot");
    expect(noReply).toContain("@alice:example.com");
    expect(noReply).toContain("encryption off");
    expect(noReply).toContain("not just been invited");
    expect(noReply).toContain("only hears messages while it's running");
  });
});

describe("Matrix setup guide: asking for what is missing (A15)", () => {
  it("asks for the access token, and jumps to the pasted field", () => {
    const issues = guide().validate(draftOf({ homeserverUrl: HOMESERVER }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "matrix_auth_missing",
        fieldKey: "accessToken",
        level: "error",
        message: "Paste the Matrix access token.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("does not ask when a saved token or a variable name is already there", () => {
    // Editing a saved connection: the token is kept in secure storage and the draft only knows it is configured.
    const saved = draftOf(
      { homeserverUrl: HOMESERVER },
      { hydration: { status: "opaque-secret", fieldState: { accessToken: "configured" }, warnings: [] } },
    );
    const variable = draftOf({ homeserverUrl: HOMESERVER, accessTokenEnv: "MATRIX_ACCESS_TOKEN" });

    expect(guide().validate(saved)).toEqual([]);
    expect(guide().validate(variable)).toEqual([]);
  });
});

describe("Matrix send-only path: can it finish?", () => {
  it("lets Continue pass with just a homeserver and an access token", () => {
    expect(continueBlockers(SEND_ONLY_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(SEND_ONLY_VALUES))).toEqual([]);
  });

  it("asks for those two and nothing about receiving or a room", () => {
    expect(continueBlockers({})).toEqual([
      "Homeserver URL",
      "Access token or Access token from an environment variable (advanced)",
    ]);
  });

  it("is cleared by the setup test with no room: the token is checked and no notice is sent", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const { live, eligibility } = await inRoom.verdictOf(config);

    expect(config).not.toHaveProperty("defaultRoomId");
    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["matrix_auth", "pass"],
      ["matrix_sandbox_send", "skipped"],
    ]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("is cleared by the setup test with a room the bot has joined: it checks the token and the room, then posts a notice", async () => {
    const config = guide().normalize(draftOf(SEND_WITH_ROOM_VALUES));
    const { issues, live, deps, eligibility } = await inRoom.verdictOf(config);

    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["matrix_auth", "pass"],
      ["matrix_room", "pass"],
      ["matrix_sandbox_send", "pass"],
    ]);
    const send = vi
      .mocked(deps.fetchWithDiagnosticsTimeout)
      .mock.calls.find(([url]) => url.includes("/send/m.room.message/"));
    expect(JSON.parse(String(send?.[1]?.body))).toMatchObject({ msgtype: "m.notice" });
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("holds Finalize back while the bot has not joined the room, and the guide names the invite as the fix", async () => {
    const config = guide().normalize(draftOf(SEND_WITH_ROOM_VALUES));
    const { eligibility } = await notInRoom.verdictOf(config);

    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons.join("\n")).toContain(
      "Invite the bot account to the room and accept the invite.",
    );
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("not-joined");
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
      draftOf({ ...SEND_ONLY_VALUES, accessToken: undefined, accessTokenEnv: "MATRIX_ACCESS_TOKEN" }),
    );
    const previous = process.env.MATRIX_ACCESS_TOKEN;
    process.env.MATRIX_ACCESS_TOKEN = "matrix-test-token";
    try {
      const structural = buildIntegrationConnectionChecks(port(), connectionOf(config));

      expect(structural.filter((check) => check.status !== "pass" && check.key !== "target")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MATRIX_ACCESS_TOKEN;
      else process.env.MATRIX_ACCESS_TOKEN = previous;
    }
  });

  it("refuses to be cleared over plain http away from this computer, which the field already said", async () => {
    const config = guide().normalize(draftOf({ ...SEND_ONLY_VALUES, homeserverUrl: "http://matrix.example.com" }));
    const { eligibility } = await verdictOf(config);

    expect(eligibility.allowed).toBe(false);
  });
});

describe("Matrix receiving path: can it finish?", () => {
  it("lets Continue pass once receiving is on and a sender is listed", () => {
    expect(continueBlockers(RECEIVING_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(RECEIVING_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test with an allowed sender", async () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const { issues, eligibility } = await inRoom.verdictOf(config);

    expect(config).toMatchObject({
      inboundStreamEnabled: true,
      inboundAccessMode: "allowlist",
      allowedSenders: [ALICE],
    });
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("is still cleared before any sender is allowed: the person adds their ID after finishing", async () => {
    const { allowedSenders: _senders, ...withoutSenders } = RECEIVING_VALUES;
    const { eligibility } = await inRoom.verdictOf(guide().normalize(draftOf(withoutSenders)));

    expect(eligibility.allowed).toBe(true);
  });

  it("does not make an edit replay the setup-only steps", () => {
    expect(continueBlockers(RECEIVING_VALUES, "edit")).toEqual([]);
    expect(continueBlockers({ inboundStreamEnabled: true }, "edit")).toEqual([
      "Homeserver URL",
      "Access token or Access token from an environment variable (advanced)",
    ]);
  });
});
