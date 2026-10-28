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
  return requireChannelSetupDefinition("channel.mattermost");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Mattermost guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Mattermost guide has no field ${key}`);
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

const SERVER = "https://chat.example.com";
const BOT = "botbotbotbotbotbotbotbotbo";
const TEAM = "teamteamteamteamteamteamte";
const CHANNEL = "chanchanchanchanchanchanch";
const POST = "postpostpostpostpostpostpo";
const PERSON = "personpersonpersonperson1";
const DIRECT = "directdirectdirectdirect1";
const USER_ID = "abcdefghijklmnopqrstuvwxyz";

interface ServerBehavior {
  /** What the server answers to the bot's own lookup. */
  me?: number;
  /** The teams the bot is in. */
  teams?: string[];
  /** What the server answers to deleting the test post. */
  cleanup?: number;
}

/**
 * A Mattermost server with one team and one channel, "town-square", that the bot may post in, and one person, "alice",
 * the bot can open a direct message with.
 */
function mattermost({ me = 200, teams = [TEAM], cleanup = 200 }: ServerBehavior = {}): NonNullable<
  GuideFinishOptions["fetch"]
> {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  return async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    if (pathname === "/api/v4/users/me") return me === 200 ? json({ id: BOT }) : json({ message: "Invalid token" }, me);
    if (pathname === `/api/v4/users/${BOT}/teams`) return json(teams.map((id) => ({ id })));
    if (pathname === `/api/v4/teams/${TEAM}/channels/name/town-square`) return json({ id: CHANNEL });
    if (pathname === "/api/v4/users/username/alice") return json({ id: PERSON });
    if (method === "POST" && pathname === "/api/v4/channels/direct") return json({ id: DIRECT });
    if (method === "POST" && pathname === "/api/v4/posts") return json({ id: POST });
    if (method === "DELETE" && pathname === `/api/v4/posts/${POST}`) return json({ status: "OK" }, cleanup);
    return new Response("{}", { status: 404 });
  };
}

const { draftOf, connectionOf, continueBlockers, port } = guideFinish("channel.mattermost");
const working = guideFinish("channel.mattermost", { fetch: mattermost() });
const noTeams = guideFinish("channel.mattermost", { fetch: mattermost({ teams: [] }) });
const cannotDelete = guideFinish("channel.mattermost", { fetch: mattermost({ cleanup: 403 }) });
const badToken = guideFinish("channel.mattermost", { fetch: mattermost({ me: 401 }) });

const SEND_ONLY_VALUES = {
  serverUrl: SERVER,
  botToken: "secret-reference",
  defaultChannel: "town-square",
};
/** The test post goes to a direct message with the person, so no team or channel is involved. */
const DIRECT_MESSAGE_VALUES = {
  ...SEND_ONLY_VALUES,
  defaultChannel: "@alice",
};
const RECEIVING_VALUES = {
  ...SEND_ONLY_VALUES,
  inboundStreamEnabled: true,
  allowedSenders: [USER_ID],
};

describe("Mattermost setup copy", () => {
  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /posture|provenance|ingress|egress|sandbox message|activation plan/iu,
    );
  });

  it("never claims a public web address for GoatCitadel", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/https:\/\/<your public address>/u);
  });

  it("drops the unverified 'Copy user ID' profile action: Mattermost's docs don't document it (item 4)", () => {
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/copy user id/iu);
  });
});

describe("Mattermost setup guide: what it says up front (items 1 and 6)", () => {
  it("opens with the intro, prerequisites and first message from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Send and receive Mattermost posts through a bot account. No public web address is needed: GoatCitadel connects out, and only hears posts while it's running.",
    );
    expect(wizard.prerequisites).toEqual([
      "A bot account and its token. Only a Mattermost system admin can create bots.",
      "The bot added to the team and to each channel it should use.",
      "Your Mattermost server in the hosts GoatCitadel may reach.",
    ]);
    // Ruling R46: the audit's "(or message the bot directly)" is a Mattermost claim its docs do not make, so it is not shipped.
    // Ruling R49: the probe deletes its test post right away, so the audit's "Check the test post arrived" is not asked.
    expect(paragraphs("first-message")).toEqual([
      "Check the test passed. To receive: turn on Receive posts, allow your user ID, post in a channel the bot is in, and check the reply.",
    ]);
  });

  it("never asks the person to look for the test post: the probe deletes it right away (R49)", () => {
    const wizard = JSON.stringify(guide().definition.wizard);

    expect(wizard).not.toMatch(/check (that )?the test post arrived/iu);
    expect(paragraphs("first-message").join("\n")).not.toMatch(/arrived/iu);
  });

  it("keeps the server host field from the picker data, and no inbound webhook", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.hostFields).toEqual(["serverUrl"]);
    expect(wizard.inboundWebhook).toBeUndefined();
  });

  it("points the official docs at Mattermost's bot account page", () => {
    expect(guide().definition.volatility.officialDocsUrl).toBe(
      "https://docs.mattermost.com/developers/integrate/reference/bot-accounts",
    );
  });

  it("says receiving connects out, so no public web address is needed, and posts sent while it's down are lost", () => {
    const text = paragraphs("overview").join("\n");

    expect(text).toContain("so no public web address is needed");
    expect(text).toContain("posts sent while it isn't are not recovered");
    expect(text).toContain("Only user IDs you allow can start conversations.");
  });

  it("tells the person where the server host gets allowed, and what happens when it isn't", () => {
    const text = textOf(step("overview").body);

    expect(text).toContain("the setup test has an Allow these hosts button for that");
    expect(text).toContain("receiving stops until you allow it and restart GoatCitadel");
  });

  it("hides the setup-only intro when a saved connection is changed", () => {
    expect(step("overview").createOnly).toBe(true);
  });
});

describe("Mattermost setup guide: making the bot (item 2)", () => {
  it("adds a setup-only step between the intro and the fields", () => {
    const create = step("create-bot");

    expect(stepIds().indexOf("create-bot")).toBeGreaterThan(stepIds().indexOf("overview"));
    expect(stepIds().indexOf("create-bot")).toBeLessThan(stepIds().indexOf("collect-values-identity"));
    expect(create.createOnly).toBe(true);
    expect(create.kind).toBe("instruction");
  });

  it("says only a system admin can make a bot, then walks through the four steps", () => {
    expect(paragraphs("create-bot")).toEqual([
      "Only a Mattermost system admin can create a bot. Ask one if you aren't.",
      "Step 4 is only for channels. You can skip it if the test post goes to @your-username (a direct message) and you won't receive posts from channels.",
    ]);
    expect(step("create-bot").body).toContainEqual({
      kind: "list",
      ordered: true,
      items: [
        "In System Console › Integrations › Bot Accounts, turn on Enable Bot Account Creation.",
        "In the Product menu, open Integrations › Bot Accounts and choose Add Bot Account.",
        "Copy the token. It is shown once.",
        "Add the bot to the team and to each channel it should use. It doesn't join on its own.",
      ],
    });
    expect(textOf(step("create-bot").body)).toContain(
      "https://docs.mattermost.com/developers/integrate/reference/bot-accounts",
    );
  });

  it("asks only for what every setup needs: the team and channel step is a plain list item, not a box that blocks Continue (R50)", () => {
    expect((step("create-bot").checklist ?? []).map((item) => item.label)).toEqual([
      "Turn on bot account creation",
      "Add the bot account and copy its token",
    ]);
    expect(JSON.stringify(step("create-bot").checklist)).not.toMatch(/team|channel|member/iu);
  });
});

describe("Mattermost setup guide: the server URL (item 1, A10)", () => {
  it("says the rule in the field", () => {
    expect(field("serverUrl").explanation).toBe(
      "The address of your Mattermost server, without a team or channel. Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
    );
  });

  it("is still the one required field of the account, asked first", () => {
    expect(field("serverUrl").required).toBe(true);
    expect(fieldKeys("collect-values-identity")[0]).toBe("serverUrl");
    expect(guide().validate(draftOf({ botToken: "secret-reference", defaultChannel: "town-square" }))).toEqual([
      expect.objectContaining({ key: "serverUrl_required", fieldKey: "serverUrl" }),
    ]);
  });

  it("refuses plain http away from this computer with the message the live test would give", () => {
    const issues = guide().validate(draftOf({ ...SEND_ONLY_VALUES, serverUrl: "http://chat.example.com" }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "serverUrl_malformed",
        fieldKey: "serverUrl",
        level: "error",
        message: "Use https://. Plain http:// works only for this computer (127.0.0.1 or localhost).",
        failureCategory: "malformed_value",
      }),
    ]);
  });

  it("refuses an address with no scheme", () => {
    const issues = guide().validate(draftOf({ ...SEND_ONLY_VALUES, serverUrl: "chat.example.com" }));

    expect(issues.map((issue) => issue.key)).toEqual(["serverUrl_malformed"]);
  });

  it("refuses a scheme that is not http or https, even for this computer", () => {
    const issues = guide().validate(draftOf({ ...SEND_ONLY_VALUES, serverUrl: "ftp://localhost" }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "serverUrl_malformed",
        fieldKey: "serverUrl",
        message: "Server URL should start with https://.",
      }),
    ]);
  });

  it("accepts https, and plain http for this computer only", () => {
    for (const serverUrl of [
      SERVER,
      "https://chat.example.com:8065/",
      "http://localhost:8065",
      "http://127.0.0.1:8065",
    ]) {
      expect(guide().validate(draftOf({ ...SEND_ONLY_VALUES, serverUrl })), serverUrl).toEqual([]);
    }
  });
});

describe("Mattermost setup guide: the bot token (item 2, A5)", () => {
  it("says where the token is shown, and that it is shown once", () => {
    const token = field("botToken");

    expect(textOf(token.whereToFind)).toContain(
      "Mattermost shows it once, when you add the bot account (Product menu › Integrations › Bot Accounts › Add Bot Account). Copy it before you close that screen.",
    );
    expect(textOf(token.whereToFind)).toContain(
      "https://docs.mattermost.com/developers/integrate/reference/bot-accounts",
    );
    expect(token.commonMistakes).toEqual([
      "Closing the screen before copying the token. Mattermost doesn't show it again.",
    ]);
  });

  it("offers a pasted token first, then the variable name under Advanced with its name rule", () => {
    const keys = fieldKeys("collect-values-identity");
    const token = field("botToken");
    const env = field("botTokenEnv");

    expect(keys.indexOf("botToken")).toBeLessThan(keys.indexOf("botTokenEnv"));
    expect(token.label).toBe("Bot token");
    expect(token.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
    expect(token.advanced).not.toBe(true);
    expect(env.advanced).toBe(true);
    expect(env.label).toBe("Bot token from an environment variable (advanced)");
    expect(env.explanation).toBe(
      "Name of the env var that stores the Mattermost bot token. The variable's name must start with MATTERMOST_ (for example MATTERMOST_BOT_TOKEN). Set it where GoatCitadel starts, then restart GoatCitadel.",
    );
  });
});

describe("Mattermost setup guide: where the test post goes (item 3)", () => {
  it("asks 'Where should the test post go?' and says to use the channel name from its web address", () => {
    const channel = field("defaultChannel");

    expect(channel.label).toBe("Where should the test post go?");
    // Ruling R51: the audit's unscoped "The bot must already be a member." is scoped to a channel, because a direct
    // message to @your-username asks for no membership (R50).
    expect(channel.explanation).toBe(
      "The channel name from its web address (for example town-square), or @your-username to have the bot message you. For a channel, the bot must already be a member.",
    );
    expect(channel.looksLike).toBe("town-square");
    // A direct message to you is the same probe, so its post is deleted right away too (R49).
    expect(channel.whyNeeded).toBe(
      "GoatCitadel posts one test post here and deletes it again right away when the bot is allowed to, so you may not see it, even in a direct message. A send that names no channel goes here too.",
    );
    expect(channel.commonMistakes).toEqual([
      "Using the channel's display name (for example Town Square) instead of the name in its web address.",
    ]);
  });

  it("is still required, and asked with the destinations", () => {
    expect(field("defaultChannel").required).toBe(true);
    expect(fieldKeys("collect-values-destinations")).toEqual(["defaultChannel", "defaultTeam"]);
    expect(guide().validate(draftOf({ serverUrl: SERVER, botToken: "secret-reference" }))).toEqual([
      expect.objectContaining({ key: "defaultChannel_required", fieldKey: "defaultChannel" }),
    ]);
  });

  it("keeps the team under Advanced (item 6)", () => {
    expect(field("defaultTeam").advanced).toBe(true);
    expect(field("defaultChannel").advanced).not.toBe(true);
  });
});

describe("Mattermost setup guide: receiving (items 4 and 6, A7, A8)", () => {
  it("is off by default and named the way the first message names it", () => {
    const receive = field("inboundStreamEnabled");

    expect(receive.label).toBe("Receive posts");
    expect(receive.defaultValue).toBe(false);
    expect(receive.explanation).toBe(
      "Listen for posts in channels the bot belongs to, so people can start conversations with it.",
    );
    expect(receive.whyNeeded).toBe(
      "GoatCitadel connects out to your server to hear new posts, so no public web address is needed. Receiving stays off unless you turn it on, and only allowed user IDs can start conversations. Posts sent while GoatCitadel isn't running are not recovered.",
    );
  });

  it("shows the sender step only while receiving is on, with no access-mode choice", () => {
    const sender = step("sender-access");

    expect(sender.visibleWhenFieldEquals).toEqual({ fieldKey: "inboundStreamEnabled", value: true });
    expect(fieldKeys("sender-access")).toEqual(["allowedSenders"]);
  });

  it("says a sender is a user ID, not a username, and where an admin finds it", () => {
    expect(field("allowedSenders").explanation).toBe(
      'Mattermost user IDs (26 letters and digits), not usernames. An admin sees them in System Console › User Management › Users. Don\'t know the id? Message the bot once, then open System › Diagnostics and find "Dropped a … message from …".',
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

describe("Mattermost setup guide: the test and finishing", () => {
  it("says what the test does, and that the post is deleted again, so the result is on this step", () => {
    expect(paragraphs("test")).toEqual([
      "The test checks the bot token with your server, finds the channel you chose and posts one test post there. When the bot is allowed to, it deletes that post again right away, so read the result on this step: the post may be gone before you look.",
    ]);
  });

  it("finishes by saving for sending, and points receiving at the next step", () => {
    expect(paragraphs("finish")).toEqual([
      "Finish saves the connection so GoatCitadel can post from it. To receive posts, turn on Receive posts and allow your user ID (the last step shows how).",
    ]);
    expect(step("finish").successCriteria).toEqual([
      "Your Mattermost server accepted the bot token.",
      "The channel you chose was found and accepted the test post.",
      "The test post was deleted, or you deleted it yourself where the bot couldn't.",
    ]);
  });
});

describe("Mattermost setup guide: when the test fails (A13)", () => {
  const items = () => step("test").troubleshooting ?? [];
  const body = (id: string) => items().find((item) => item.id === id)?.body ?? "";

  it("lists the failures a Mattermost setup really hits, on the test step", () => {
    expect(items().map((item) => item.id)).toEqual([
      "token-rejected",
      "channel-not-found",
      "post-refused",
      "cleanup-failed",
      "host-not-allowed",
      "variable-not-found",
      "no-reply",
    ]);
  });

  it("sends a rejected token back to the one-time token screen", () => {
    expect(body("token-rejected")).toContain("Mattermost shows it only once");
    expect(body("token-rejected")).toContain("ask a system admin to create a new token for the bot");
  });

  it("sends a channel that isn't found to its web-address name and to the bot's membership", () => {
    expect(body("channel-not-found")).toContain("name from its web address (for example town-square)");
    expect(body("channel-not-found")).toContain("not its display name");
    expect(body("channel-not-found")).toContain("@your-username to send the test post to you in a direct message");
    expect(body("channel-not-found")).not.toContain("message you");
    expect(body("channel-not-found")).toContain("add it to the team and the channel first");
  });

  it("sends a refused post to the channel membership", () => {
    expect(body("post-refused")).toContain("member of the channel");
  });

  it("says what to do when the test post can't be deleted", () => {
    expect(items().find((item) => item.id === "cleanup-failed")?.title).toBe(
      "It says the test post was sent but couldn't be deleted",
    );
    expect(body("cleanup-failed")).toContain("Delete the test post yourself");
    expect(body("cleanup-failed")).toContain("acknowledge");
  });

  it("names the Allow these hosts button for the server", () => {
    expect(items().find((item) => item.id === "host-not-allowed")?.title).toBe(
      "It says GoatCitadel can't reach your Mattermost server yet",
    );
    expect(body("host-not-allowed")).toContain("Allow these hosts");
  });

  it("points a variable that isn't found at the name rule and the restart", () => {
    expect(body("variable-not-found")).toContain("MATTERMOST_");
    expect(body("variable-not-found")).toContain("restart GoatCitadel");
  });

  it("points a silent bot at receiving, the user ID, the channel, the running Gateway and the host", () => {
    const noReply = body("no-reply");

    expect(noReply).toContain("Receive posts must be on");
    expect(noReply).toContain("user ID (not your username)");
    expect(noReply).toContain("Who may message this bot");
    expect(noReply).toContain("member of the channel");
    expect(noReply).toContain("only hears posts while it's running");
    expect(noReply).toContain("receiving stops until you allow it and restart GoatCitadel");
  });
});

describe("Mattermost setup guide: asking for what is missing (A15)", () => {
  it("asks for the bot token, and jumps to the pasted field", () => {
    const issues = guide().validate(draftOf({ serverUrl: SERVER, defaultChannel: "town-square" }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "mattermost_auth_missing",
        fieldKey: "botToken",
        level: "error",
        message: "Paste the Mattermost bot token.",
        failureCategory: "missing_input",
      }),
    ]);
  });

  it("does not ask when a saved token or a variable name is already there", () => {
    // Editing a saved connection: the token is kept in secure storage and the draft only knows it is configured.
    const saved = draftOf(
      { serverUrl: SERVER, defaultChannel: "town-square" },
      { hydration: { status: "opaque-secret", fieldState: { botToken: "configured" }, warnings: [] } },
    );
    const variable = draftOf({ serverUrl: SERVER, defaultChannel: "town-square", botTokenEnv: "MATTERMOST_BOT_TOKEN" });

    expect(guide().validate(saved)).toEqual([]);
    expect(guide().validate(variable)).toEqual([]);
  });
});

describe("Mattermost send-only path: can it finish?", () => {
  it("lets Continue pass with a server, a bot token and a channel", () => {
    expect(continueBlockers(SEND_ONLY_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(SEND_ONLY_VALUES))).toEqual([]);
  });

  it("asks for those three and nothing about receiving", () => {
    expect(continueBlockers({})).toEqual([
      "Server URL",
      "Bot token or Bot token from an environment variable (advanced)",
      "Where should the test post go?",
    ]);
  });

  it("is cleared by the setup test end to end: token, channel, a test post and its cleanup", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const { issues, live, deps, eligibility } = await working.verdictOf(config);

    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["mattermost_token_auth", "pass"],
      ["mattermost_channel_access", "pass"],
      ["mattermost_sandbox_send", "pass"],
      ["mattermost_sandbox_cleanup", "pass"],
    ]);
    const post = vi
      .mocked(deps.fetchWithDiagnosticsTimeout)
      .mock.calls.find(([url, init]) => url.endsWith("/api/v4/posts") && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ channel_id: CHANNEL });
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("holds Finalize back while the bot is in no team, and the guide names the membership as the fix", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const { eligibility } = await noTeams.verdictOf(config);

    expect(eligibility.allowed).toBe(false);
    expect(eligibility.blockingReasons.join("\n")).toContain("Mattermost bot is not a member of any team.");
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("channel-not-found");
  });

  it("holds Finalize back for a rejected token, and the guide has an answer for it", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const { eligibility } = await badToken.verdictOf(config);

    expect(eligibility.allowed).toBe(false);
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("token-rejected");
  });

  it("asks for an acknowledgement when the bot can't delete its test post, and the guide says to delete it by hand", async () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const { eligibility } = await cannotDelete.verdictOf(config);

    expect(eligibility).toMatchObject({ allowed: false, requiresAcknowledgement: true });
    expect(step("test").troubleshooting?.map((item) => item.id)).toContain("cleanup-failed");
  });

  it("lists the attachment sources Mattermost supports, and does not call it text-only (R48 is for text-only guides)", () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    const attachments = buildIntegrationConnectionChecks(port(), connectionOf(config)).find(
      (check) => check.key === "attachments",
    );

    expect(attachments).toEqual({
      key: "attachments",
      status: "pass",
      message: "Supported attachment sources: url, inline.",
    });
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(/Attachments aren't supported/u);
  });

  it("is also cleared when the token is a variable name rather than a pasted token", () => {
    const config = guide().normalize(
      draftOf({ ...SEND_ONLY_VALUES, botToken: undefined, botTokenEnv: "MATTERMOST_BOT_TOKEN" }),
    );
    const previous = process.env.MATTERMOST_BOT_TOKEN;
    process.env.MATTERMOST_BOT_TOKEN = "mattermost-test-token";
    try {
      const structural = buildIntegrationConnectionChecks(port(), connectionOf(config));

      expect(structural.filter((check) => check.status !== "pass")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previous;
    }
  });

  it("refuses to be cleared over plain http away from this computer, which the field already said", async () => {
    const config = guide().normalize(draftOf({ ...SEND_ONLY_VALUES, serverUrl: "http://chat.example.com" }));
    const { eligibility } = await working.verdictOf(config);

    expect(eligibility.allowed).toBe(false);
  });
});

describe("Mattermost send-only path to a direct message (@your-username): can it finish? (R50)", () => {
  it("lets Continue pass with a server, a bot token and @username, with nothing about a team or channel", () => {
    expect(continueBlockers(DIRECT_MESSAGE_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(DIRECT_MESSAGE_VALUES))).toEqual([]);
  });

  it("asks this path to tick nothing about a team or channel: the setup step's boxes are the bot account and its token", () => {
    // The shared helper doesn't model checklists, so assert the step's boxes directly. Continue is blocked until each
    // box is ticked, and GoatCitadel's direct-message setup never looks up a team or channel.
    const boxes = (step("create-bot").checklist ?? []).map((item) => item.label);

    expect(boxes).toEqual(["Turn on bot account creation", "Add the bot account and copy its token"]);
    expect(boxes.join("\n")).not.toMatch(/team|channel|member/iu);
  });

  it("is cleared by the setup test even when the bot is in no team: it opens a direct message and never asks for a team", async () => {
    const config = guide().normalize(draftOf(DIRECT_MESSAGE_VALUES));
    const { issues, live, deps, eligibility } = await noTeams.verdictOf(config);

    expect(live.probe?.steps.map((candidate) => [candidate.key, candidate.status])).toEqual([
      ["mattermost_token_auth", "pass"],
      ["mattermost_channel_access", "pass"],
      ["mattermost_sandbox_send", "pass"],
      ["mattermost_sandbox_cleanup", "pass"],
    ]);
    const requests = vi.mocked(deps.fetchWithDiagnosticsTimeout).mock.calls;
    const post = requests.find(([url, init]) => url.endsWith("/api/v4/posts") && init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ channel_id: DIRECT });
    expect(requests.some(([url]) => url.includes("/teams"))).toBe(false);
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("says in the setup step that the team and channel step can be skipped for a direct message", () => {
    expect(paragraphs("create-bot").join("\n")).toContain("@your-username (a direct message)");
    expect(field("defaultChannel").explanation).toContain("@your-username to have the bot message you");
  });

  it("scopes the direct-message skip to GoatCitadel's own steps, not a Mattermost rule (R52)", () => {
    // Mattermost's API page for creating a direct channel (POST /api/v4/channels/direct) says nothing about teams, so
    // the copy says only which of this guide's steps can be skipped, and never that Mattermost needs no membership.
    expect(paragraphs("create-bot")[1]).toBe(
      "Step 4 is only for channels. You can skip it if the test post goes to @your-username (a direct message) and you won't receive posts from channels.",
    );
    expect(JSON.stringify(guide().definition.wizard)).not.toMatch(
      /direct message[^"]{0,60}(needs|requires|does not need|doesn't need) (no |any )?(team|channel|membership)/iu,
    );
  });

  it("no longer says, unscoped, that the bot must already be a member (R51)", () => {
    expect(field("defaultChannel").explanation).not.toMatch(/\. The bot must already be a member\.$/u);
    expect(field("defaultChannel").explanation).toMatch(/For a channel, the bot must already be a member\.$/u);
  });
});

describe("Mattermost receiving path: can it finish?", () => {
  it("lets Continue pass once receiving is on and a sender is listed", () => {
    expect(continueBlockers(RECEIVING_VALUES)).toEqual([]);
    expect(guide().validate(draftOf(RECEIVING_VALUES))).toEqual([]);
  });

  it("is cleared by the setup test with an allowed user ID", async () => {
    const config = guide().normalize(draftOf(RECEIVING_VALUES));
    const { issues, eligibility } = await working.verdictOf(config);

    expect(config).toMatchObject({
      inboundStreamEnabled: true,
      inboundAccessMode: "allowlist",
      allowedSenders: [USER_ID],
    });
    expect(issues).toEqual([]);
    expect(eligibility).toMatchObject({ allowed: true, blockingReasons: [] });
  });

  it("is still cleared before any sender is allowed: the person adds their ID after finishing", async () => {
    const { allowedSenders: _senders, ...withoutSenders } = RECEIVING_VALUES;
    const { eligibility } = await working.verdictOf(guide().normalize(draftOf(withoutSenders)));

    expect(eligibility.allowed).toBe(true);
  });

  it("does not make an edit replay the setup-only steps", () => {
    expect(continueBlockers(RECEIVING_VALUES, "edit")).toEqual([]);
  });
});
