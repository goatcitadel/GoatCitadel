import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import {
  SLACK_BOT_TOKEN_REJECTED,
  SLACK_DRAFT_ONLY,
  SLACK_HISTORY_LIMIT,
  SLACK_SAY_HI_CONVERSATIONS,
  SLACK_UNREACHABLE,
  checkSlackSetup,
} from "./channel-setup-slack-check.js";

const draftId = "11111111-1111-1111-1111-111111111111";
const BOT_TOKEN = "xoxb-1";
const APP_TOKEN = "xapp-1";
const CODE = "Ab3dEf7hJk";
const API = "https://slack.com/api/";
/** A Socket Mode address: its ticket makes it a secret, so no answer or error here may carry it. */
const SOCKET_URL = "wss://wss-primary.slack.com/link/?ticket=SECRET-TICKET&app_id=A1";

type Reply = { status?: number; body?: unknown };
type Script = Record<string, Reply | ((query: URLSearchParams, init: RequestInit | undefined) => Reply)>;
type Call = { verb: string; method: string; query: URLSearchParams; url: string; init: RequestInit | undefined };

const AUTH_TEST = { ok: true, team_id: "T1", team: "Acme", user_id: "UBOT", user: "goatcitadel" };

function slackDraft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId,
    revision: 3,
    catalogId: "channel.slack",
    lifecycleMode: "create",
    draft: { receiveMode: "socket" },
    secretState: {},
    enabled: true,
    contentVersion: "content",
    testVersion: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as ChannelSetupDraft;
}

/**
 * A setup host whose Slack answers from `script`, keyed `VERB method` (for example `GET auth.test`). A saved key reads
 * by the field it is asked for, so a missing one is a key left out of `tokens`.
 */
function fakeHost(
  script: Script,
  options: { draft?: ChannelSetupDraft; tokens?: Record<string, string | undefined> } = {},
) {
  const calls: Call[] = [];
  const fetchWithTimeout = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const verb = init?.method ?? "GET";
    const method = parsed.pathname.replace(/^\/api\//, "");
    calls.push({ verb, method, query: parsed.searchParams, url, init });
    const entry = script[`${verb} ${method}`];
    if (!entry) return new Response(JSON.stringify({ ok: false, error: "unknown_method" }), { status: 200 });
    const reply = typeof entry === "function" ? entry(parsed.searchParams, init) : entry;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  });
  const draft = options.draft ?? slackDraft();
  const tokens = options.tokens ?? { botToken: BOT_TOKEN, appToken: APP_TOKEN };
  const resolveConnectionSecret = vi.fn((_config: unknown, directKey: string) => tokens[directKey]);
  const host = {
    storage: { channelSetupDrafts: { get: vi.fn(async () => draft) } },
    fetchWithTimeout,
    resolveConnectionSecret,
  } as unknown as ChannelSetupHost;
  return { host, calls, fetchWithTimeout, resolveConnectionSecret };
}

const basic = (): Script => ({ "GET auth.test": { body: AUTH_TEST } });

const check = (host: ChannelSetupHost, extra: { checkAppToken?: true; setupCode?: string; listChannels?: true } = {}) =>
  checkSlackSetup(host, { draftId, expectedRevision: 3, ...extra });

const im = (id: string, user: string, extra: Record<string, unknown> = {}) => ({
  id,
  user,
  is_im: true,
  is_user_deleted: false,
  ...extra,
});
const hello = (user: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  user,
  text,
  ...extra,
});
const historyOf =
  (byChannel: Record<string, unknown[]>) =>
  (query: URLSearchParams): Reply => ({ body: { ok: true, messages: byChannel[query.get("channel") ?? ""] ?? [] } });
const names = (calls: Call[]) => calls.map((call) => `${call.verb} ${call.method}`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack setup check", () => {
  it("names the workspace and bot", async () => {
    const { host, calls, resolveConnectionSecret } = fakeHost(basic());
    const result = await check(host);
    expect(result).toEqual({ workspace: { id: "T1", name: "Acme" }, bot: { userId: "UBOT", name: "goatcitadel" } });
    // It reads the draft's own key, as the owner of that draft, and asks Slack once, as a plain GET.
    expect(resolveConnectionSecret).toHaveBeenCalledTimes(1);
    expect(resolveConnectionSecret).toHaveBeenCalledWith(
      expect.objectContaining({ receiveMode: "socket" }),
      "botToken",
      "botTokenEnv",
      "channel.slack",
      { connectionId: draftId, draftId },
    );
    expect(names(calls)).toEqual(["GET auth.test"]);
    expect(calls[0]?.url).toBe(`${API}auth.test`);
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("falls back to the ids when Slack names neither the workspace nor the bot", async () => {
    const { host } = fakeHost({ "GET auth.test": { body: { ok: true, team_id: "T1", user_id: "UBOT", team: " " } } });
    const result = await check(host);
    expect(result.workspace).toEqual({ id: "T1", name: "T1" });
    expect(result.bot).toEqual({ userId: "UBOT", name: "UBOT" });
  });

  it("asks Slack nothing more than who the bot is, unless asked", async () => {
    const { host, calls, resolveConnectionSecret } = fakeHost(basic());
    const result = await check(host);
    expect(names(calls)).toEqual(["GET auth.test"]);
    expect(result).not.toHaveProperty("appToken");
    expect(result).not.toHaveProperty("codeSender");
    expect(result).not.toHaveProperty("channels");
    expect(result).not.toHaveProperty("manyConversations");
    // The app-level token is not even read.
    expect(resolveConnectionSecret.mock.calls.map((call) => call[1])).toEqual(["botToken"]);
  });

  describe("the app-level token", () => {
    const open = (reply: Reply): Script => ({ ...basic(), "POST apps.connections.open": reply });

    it("checks the app-level token only when asked, without opening a socket", async () => {
      const webSocket = vi.fn();
      vi.stubGlobal("WebSocket", webSocket);

      const accepted = fakeHost(open({ body: { ok: true, url: SOCKET_URL } }));
      const ok = await check(accepted.host, { checkAppToken: true });
      expect(ok.appToken).toBe("ok");
      // It reads the draft's own app-level key, as the owner of that draft.
      expect(accepted.resolveConnectionSecret).toHaveBeenLastCalledWith(
        expect.anything(),
        "appToken",
        "appTokenEnv",
        "channel.slack",
        { connectionId: draftId, draftId },
      );
      // A POST with no body, the app-level token in the header and nothing in the address.
      expect(names(accepted.calls)).toEqual(["GET auth.test", "POST apps.connections.open"]);
      const post = accepted.calls[1];
      expect((post?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${APP_TOKEN}`);
      expect(post?.init?.body).toBeUndefined();
      expect(post?.url).toBe(`${API}apps.connections.open`);
      // The socket address is never returned, and no socket is opened.
      expect(JSON.stringify(ok)).not.toContain("SECRET-TICKET");
      expect(JSON.stringify(ok)).not.toContain("wss://");
      expect(JSON.stringify(ok)).not.toContain(APP_TOKEN);
      expect(webSocket).not.toHaveBeenCalled();

      const rejected = fakeHost(open({ body: { ok: false, error: "invalid_auth" } }));
      expect((await check(rejected.host, { checkAppToken: true })).appToken).toBe("rejected");

      // Slack refusing the token with an HTTP status is the same answer.
      const forbidden = fakeHost(open({ status: 403, body: { ok: false, error: "not_allowed_token_type" } }));
      expect((await check(forbidden.host, { checkAppToken: true })).appToken).toBe("rejected");

      const missing = fakeHost(open({ body: { ok: true, url: SOCKET_URL } }), { tokens: { botToken: BOT_TOKEN } });
      const none = await check(missing.host, { checkAppToken: true });
      expect(none.appToken).toBe("missing");
      expect(names(missing.calls)).toEqual(["GET auth.test"]);
    });

    it("does not call a busy or broken Slack a rejection", async () => {
      for (const status of [429, 500, 503]) {
        const { host } = fakeHost(open({ status, body: { ok: false, error: `ratelimited ${APP_TOKEN}` } }));
        await expect(check(host, { checkAppToken: true })).rejects.toThrow(SLACK_UNREACHABLE);
      }
      const garbled = fakeHost(basic());
      garbled.fetchWithTimeout.mockImplementation(async (url: string) =>
        url.endsWith("auth.test")
          ? new Response(JSON.stringify(AUTH_TEST))
          : new Response(`not json ${APP_TOKEN} ${SOCKET_URL}`, { status: 200 }),
      );
      await expect(check(garbled.host, { checkAppToken: true })).rejects.toThrow(SLACK_UNREACHABLE);
    });

    it("never quotes the app-level token or the socket address in an error", async () => {
      const { host, fetchWithTimeout } = fakeHost(open({ body: { ok: true, url: SOCKET_URL } }));
      fetchWithTimeout.mockImplementation(async (url: string) => {
        if (url.endsWith("auth.test")) return new Response(JSON.stringify(AUTH_TEST));
        throw new Error(`POST ${url} failed: Authorization: Bearer ${APP_TOKEN} (${SOCKET_URL})`);
      });
      const error = await check(host, { checkAppToken: true }).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(SLACK_UNREACHABLE);
      for (const text of [(error as Error).message, JSON.stringify(error)]) {
        expect(text).not.toContain(APP_TOKEN);
        expect(text).not.toContain("SECRET-TICKET");
      }
    });
  });

  describe("who sent the setup code", () => {
    const people = {
      U1: { ok: true, user: { id: "U1", name: "sam", profile: { display_name: "Sam", real_name: "Samuel Rowe" } } },
    };
    const script = (extra: Script = {}): Script => ({
      ...basic(),
      "GET conversations.list": {
        body: {
          ok: true,
          channels: [im("D1", "USLACKBOT"), im("D2", "U1"), im("D3", "U3", { is_user_deleted: true })],
        },
      },
      "GET conversations.history": historyOf({ D2: [hello("U1", " Ab3dEf7hJk ")] }),
      "GET users.info": (query) => ({ body: people[query.get("user") as keyof typeof people] ?? { ok: false } }),
      ...extra,
    });

    it("finds who sent the code in a direct message", async () => {
      const { host, calls } = fakeHost(script());
      const result = await check(host, { setupCode: CODE });
      expect(result.codeSender).toEqual({ actorId: "U1", directChannelId: "D2", displayName: "Sam" });
      expect(result).not.toHaveProperty("manyConversations");
      expect(names(calls)).toEqual([
        "GET auth.test",
        "GET conversations.list",
        "GET conversations.history",
        "GET users.info",
      ]);
      // Only direct messages, and only the one with a real person in it.
      const list = calls[1]!;
      expect(list.query.get("types")).toBe("im");
      const histories = calls.filter((call) => call.method === "conversations.history");
      expect(histories.map((call) => call.query.get("channel"))).toEqual(["D2"]);
      expect(histories[0]?.query.get("limit")).toBe(String(SLACK_HISTORY_LIMIT));
      expect(calls.at(-1)?.query.get("user")).toBe("U1");
      // Every read is a GET with the token in the header and nothing in the address.
      for (const call of calls.slice(1)) {
        expect(call.init?.body).toBeUndefined();
        expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`);
        expect(call.url).not.toContain(BOT_TOKEN);
        expect(call.url).not.toContain(CODE);
      }
      expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
    });

    it("skips Slackbot and people whose account is gone, even when the code is in their conversation", async () => {
      const everyoneSaidIt = historyOf({
        D1: [hello("USLACKBOT", CODE)],
        D3: [hello("U3", CODE)],
        D2: [hello("U1", CODE)],
      });
      const found = fakeHost(script({ "GET conversations.history": everyoneSaidIt }));
      const result = await check(found.host, { setupCode: CODE });
      expect(result.codeSender?.directChannelId).toBe("D2");
      expect(found.calls.filter((call) => call.method === "conversations.history")).toHaveLength(1);

      // Nobody sent it: only the one conversation with a real person is read.
      const nobody = fakeHost(script({ "GET conversations.history": historyOf({ D2: [hello("U1", "hi")] }) }));
      expect(await check(nobody.host, { setupCode: CODE })).not.toHaveProperty("codeSender");
      const read = nobody.calls.filter((call) => call.method === "conversations.history");
      expect(read.map((call) => call.query.get("channel"))).toEqual(["D2"]);

      // A deleted account that comes first is not mistaken for the sender.
      const deletedFirst = fakeHost(
        script({
          "GET conversations.list": {
            body: { ok: true, channels: [im("D3", "U3", { is_user_deleted: true }), im("D2", "U1")] },
          },
          "GET conversations.history": everyoneSaidIt,
        }),
      );
      expect((await check(deletedFirst.host, { setupCode: CODE })).codeSender?.actorId).toBe("U1");
    });

    it("names them from their display name, else their real name, else their user name", async () => {
      const named = async (profile: unknown, name: unknown) => {
        const { host } = fakeHost(
          script({ "GET users.info": { body: { ok: true, user: { id: "U1", name, profile } } } }),
        );
        return (await check(host, { setupCode: CODE })).codeSender?.displayName;
      };
      expect(await named({ display_name: "Sam", real_name: "Samuel Rowe" }, "sam")).toBe("Sam");
      expect(await named({ display_name: "  ", real_name: "Samuel Rowe" }, "sam")).toBe("Samuel Rowe");
      expect(await named({ display_name: "", real_name: "" }, "sam")).toBe("sam");
      expect(await named(undefined, "sam")).toBe("sam");
      expect(await named({}, undefined)).toBeUndefined();
    });

    it("ignores the bot, other codes, codes inside other text and edited messages", async () => {
      const notMatches = [
        hello("U1", CODE, { bot_id: "B1" }),
        hello("UBOT", CODE),
        hello("U1", `hello ${CODE}`),
        hello("U1", `${CODE} please`),
        hello("U1", CODE, { subtype: "message_changed" }),
        hello("U1", CODE, { subtype: "file_share" }),
        hello("U1", "ab3def7hjk"),
        hello("U1", "Other7Code9"),
        hello("U1", ""),
        { type: "message", text: CODE },
        { type: "reaction_added", user: "U1", text: CODE },
        { user: "U1", text: CODE },
        "not a message",
        null,
      ];
      for (const message of notMatches) {
        const { host, calls } = fakeHost(script({ "GET conversations.history": historyOf({ D2: [message] }) }));
        const result = await check(host, { setupCode: CODE });
        expect(result, JSON.stringify(message)).not.toHaveProperty("codeSender");
        // Nobody was named, because nobody was found.
        expect(calls.some((call) => call.method === "users.info")).toBe(false);
      }
    });

    it("finds the code after messages that are not it, and takes the person who sent it", async () => {
      const { host, calls } = fakeHost(
        script({
          "GET conversations.history": historyOf({
            D2: [hello("UBOT", CODE), hello("U1", "thanks"), hello("U1", CODE, { bot_id: "B1" }), hello("U1", CODE)],
          }),
        }),
      );
      const result = await check(host, { setupCode: ` ${CODE}\n` });
      expect(result.codeSender?.actorId).toBe("U1");
      expect(calls.filter((call) => call.method === "users.info")).toHaveLength(1);
    });

    it("asks nothing about direct messages when there is no code to look for", async () => {
      for (const setupCode of [undefined, "", "   \n"]) {
        const { host, calls } = fakeHost(script());
        const result = await check(host, { ...(setupCode === undefined ? {} : { setupCode }) });
        expect(result).not.toHaveProperty("codeSender");
        expect(names(calls)).toEqual(["GET auth.test"]);
      }
    });

    it("looks at five conversations and says when there are more", async () => {
      expect(SLACK_SAY_HI_CONVERSATIONS).toBe(5);
      const seven = Array.from({ length: 7 }, (_, index) => im(`D${index + 1}`, `U${index + 1}`));
      const { host, calls } = fakeHost(
        script({
          "GET conversations.list": { body: { ok: true, channels: seven } },
          "GET conversations.history": historyOf({}),
        }),
      );
      const result = await check(host, { setupCode: CODE });
      const histories = calls.filter((call) => call.method === "conversations.history");
      expect(histories.map((call) => call.query.get("channel"))).toEqual(["D1", "D2", "D3", "D4", "D5"]);
      expect(result.manyConversations).toBe(true);
      expect(result).not.toHaveProperty("codeSender");
    });

    it("counts only conversations it could look at, and stops reading at the person who sent the code", async () => {
      const five = [
        im("D1", "USLACKBOT"),
        ...Array.from({ length: 5 }, (_, index) => im(`D${index + 2}`, `U${index + 2}`)),
      ];
      const everyone = fakeHost(
        script({
          "GET conversations.list": { body: { ok: true, channels: five } },
          "GET conversations.history": historyOf({}),
        }),
      );
      const result = await check(everyone.host, { setupCode: CODE });
      expect(result).not.toHaveProperty("manyConversations");
      expect(everyone.calls.filter((call) => call.method === "conversations.history")).toHaveLength(5);

      const seven = Array.from({ length: 7 }, (_, index) => im(`D${index + 1}`, `U${index + 1}`));
      const early = fakeHost(
        script({
          "GET conversations.list": { body: { ok: true, channels: seven } },
          "GET conversations.history": historyOf({ D2: [hello("U1", CODE)] }),
          "GET users.info": { body: { ok: true, user: { id: "U1", name: "sam" } } },
        }),
      );
      const found = await check(early.host, { setupCode: CODE });
      expect(found.codeSender).toEqual({ actorId: "U1", directChannelId: "D2", displayName: "sam" });
      expect(early.calls.filter((call) => call.method === "conversations.history")).toHaveLength(2);
    });

    it("says there are more conversations when Slack has another page of them", async () => {
      const { host } = fakeHost(
        script({
          "GET conversations.list": {
            body: { ok: true, channels: [im("D2", "U1")], response_metadata: { next_cursor: "dXNlcjpVMDYx" } },
          },
          "GET conversations.history": historyOf({}),
        }),
      );
      expect((await check(host, { setupCode: CODE })).manyConversations).toBe(true);
    });

    it("fails any other answer to the direct-message reads as unreachable, without quoting it", async () => {
      const broken: Script[] = [
        script({ "GET conversations.list": { body: { ok: false, error: `missing_scope ${BOT_TOKEN}` } } }),
        script({ "GET conversations.list": { status: 429, body: { ok: false } } }),
        script({ "GET conversations.list": { body: { ok: true, channels: "not a list" } } }),
        script({ "GET conversations.history": { body: { ok: false, error: "channel_not_found" } } }),
        script({ "GET conversations.history": { body: { ok: true, messages: { not: "a list" } } } }),
        script({ "GET users.info": { body: { ok: false, error: "user_not_found" } } }),
        script({ "GET users.info": { status: 500 } }),
      ];
      for (const entry of broken) {
        const error = await check(fakeHost(entry).host, { setupCode: CODE }).catch((caught: unknown) => caught);
        expect((error as Error).message).toBe(SLACK_UNREACHABLE);
      }
    });
  });

  describe("channels", () => {
    const channel = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      id,
      name,
      is_member: true,
      is_private: false,
      is_archived: false,
      ...extra,
    });

    it("lists only channels the bot is in", async () => {
      const { host, calls } = fakeHost({
        ...basic(),
        "GET conversations.list": {
          body: {
            ok: true,
            channels: [
              channel("C1", "general"),
              channel("C2", "random", { is_member: false }),
              channel("G1", "secret-plans", { is_private: true }),
              channel("C3", "elsewhere", { is_member: undefined }),
              channel("C4", "ops", { is_private: undefined }),
              { id: "C5", is_member: true },
              { name: "no-id", is_member: true },
            ],
          },
        },
      });
      const result = await check(host, { listChannels: true });
      expect(result.channels).toEqual([
        { id: "C1", name: "general", private: false },
        { id: "G1", name: "secret-plans", private: true },
        { id: "C4", name: "ops", private: false },
      ]);
      const list = calls.find((call) => call.method === "conversations.list")!;
      expect(list.verb).toBe("GET");
      expect(list.query.get("types")).toBe("public_channel,private_channel");
      expect(list.query.get("exclude_archived")).toBe("true");
      expect(list.query.get("limit")).toBe("200");
      expect(list.query.has("cursor")).toBe(false);
      expect(list.url).not.toContain(BOT_TOKEN);
    });

    it("reads the next page of channels, a few times at most", async () => {
      const pages = new Map<string, Reply>([
        ["", { body: { ok: true, channels: [channel("C1", "one")], response_metadata: { next_cursor: "p2" } } }],
        [
          "p2",
          {
            body: {
              ok: true,
              channels: [channel("C2", "two", { is_member: false })],
              response_metadata: { next_cursor: "p3" },
            },
          },
        ],
        ["p3", { body: { ok: true, channels: [channel("C3", "three")], response_metadata: { next_cursor: "p4" } } }],
        ["p4", { body: { ok: true, channels: [channel("C4", "four")], response_metadata: { next_cursor: "p5" } } }],
        ["p5", { body: { ok: true, channels: [channel("C5", "five")], response_metadata: { next_cursor: "p6" } } }],
        ["p6", { body: { ok: true, channels: [channel("C6", "six")] } }],
      ]);
      const { host, calls } = fakeHost({
        ...basic(),
        "GET conversations.list": (query) => pages.get(query.get("cursor") ?? "") ?? { body: { ok: false } },
      });
      const result = await check(host, { listChannels: true });
      expect(result.channels?.map((entry) => entry.name)).toEqual(["one", "three", "four", "five"]);
      expect(
        calls.filter((call) => call.method === "conversations.list").map((call) => call.query.get("cursor")),
      ).toEqual([null, "p2", "p3", "p4", "p5"]);
    });

    it("gives an empty list when the bot is in no channel", async () => {
      const { host } = fakeHost({
        ...basic(),
        "GET conversations.list": { body: { ok: true, channels: [channel("C2", "random", { is_member: false })] } },
      });
      expect((await check(host, { listChannels: true })).channels).toEqual([]);
    });

    it("fails an unusable channel list as unreachable", async () => {
      for (const reply of [
        { body: { ok: false, error: "missing_scope" } },
        { status: 500 },
        { body: { ok: true } },
        { body: { ok: true, channels: { not: "a list" } } },
      ] as Reply[]) {
        const { host } = fakeHost({ ...basic(), "GET conversations.list": reply });
        await expect(check(host, { listChannels: true })).rejects.toThrow(SLACK_UNREACHABLE);
      }
    });

    it("answers all three checks in one reply, asking Slack for the bot first", async () => {
      const { host, calls } = fakeHost({
        ...basic(),
        "POST apps.connections.open": { body: { ok: true, url: SOCKET_URL } },
        "GET conversations.list": (query) =>
          query.get("types") === "im"
            ? { body: { ok: true, channels: [im("D2", "U1")] } }
            : { body: { ok: true, channels: [channel("C1", "general")] } },
        "GET conversations.history": historyOf({ D2: [hello("U1", CODE)] }),
        "GET users.info": { body: { ok: true, user: { id: "U1", name: "sam", profile: { display_name: "Sam" } } } },
      });
      const result = await check(host, { checkAppToken: true, setupCode: CODE, listChannels: true });
      expect(result).toEqual({
        workspace: { id: "T1", name: "Acme" },
        bot: { userId: "UBOT", name: "goatcitadel" },
        appToken: "ok",
        codeSender: { actorId: "U1", directChannelId: "D2", displayName: "Sam" },
        channels: [{ id: "C1", name: "general", private: false }],
      });
      expect(calls[0]?.method).toBe("auth.test");
    });
  });

  describe("secrets and failures", () => {
    it("never puts a token in its error", async () => {
      const rejected = fakeHost({ "GET auth.test": { body: { ok: false, error: `invalid_auth ${BOT_TOKEN}` } } });
      const refused = await check(rejected.host).catch((caught: unknown) => caught);
      expect((refused as Error).message).toBe(SLACK_BOT_TOKEN_REJECTED);
      expect((refused as Error).message).not.toContain(BOT_TOKEN);
      expect(rejected.calls).toHaveLength(1);

      const broken = fakeHost(basic());
      broken.fetchWithTimeout.mockRejectedValue(
        new Error(`request to ${API}auth.test failed: Authorization: Bearer ${BOT_TOKEN}`),
      );
      const unreachable = await check(broken.host).catch((caught: unknown) => caught);
      expect((unreachable as Error).message).toBe(SLACK_UNREACHABLE);
      expect((unreachable as Error).message).not.toContain(BOT_TOKEN);
      expect(JSON.stringify(unreachable)).not.toContain(BOT_TOKEN);
      expect(String((unreachable as Error).cause ?? "")).not.toContain(BOT_TOKEN);
    });

    it("says the token was rejected for the same refusals Slack makes with a status", async () => {
      for (const status of [401, 403]) {
        const { host } = fakeHost({ "GET auth.test": { status, body: { ok: false, error: BOT_TOKEN } } });
        await expect(check(host)).rejects.toThrow(SLACK_BOT_TOKEN_REJECTED);
      }
    });

    it("says Slack was unreachable for any other failure, without quoting the answer", async () => {
      for (const reply of [
        { status: 500, body: { ok: false, error: `boom ${BOT_TOKEN}` } },
        { status: 429, body: { ok: false, error: "ratelimited" } },
        { status: 404 },
        { body: [] },
        { body: { ok: true } },
        { body: { ok: true, team_id: "T1", team: "Acme" } },
        { body: { ok: true, user_id: "UBOT", user: "goatcitadel" } },
        { body: { ok: true, team_id: 1, team: "Acme", user_id: "UBOT", user: "goatcitadel" } },
      ] as Reply[]) {
        const error = await check(fakeHost({ "GET auth.test": reply }).host).catch((caught: unknown) => caught);
        expect((error as Error).message).toBe(SLACK_UNREACHABLE);
      }
      const garbled = fakeHost(basic());
      garbled.fetchWithTimeout.mockResolvedValue(new Response(`not json ${BOT_TOKEN}`, { status: 200 }));
      const error = await check(garbled.host).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(SLACK_UNREACHABLE);
    });

    it("asks Slack nothing when the draft has no bot token", async () => {
      const { host, fetchWithTimeout } = fakeHost(basic(), { tokens: { appToken: APP_TOKEN } });
      await expect(check(host, { checkAppToken: true, listChannels: true })).rejects.toThrow(SLACK_BOT_TOKEN_REJECTED);
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    it("asks Slack nothing when the setup host cannot reach it", async () => {
      const { host } = fakeHost(basic());
      const noFetch = { ...host, fetchWithTimeout: undefined } as unknown as ChannelSetupHost;
      await expect(check(noFetch)).rejects.toThrow(SLACK_UNREACHABLE);
      const noResolver = { ...host, resolveConnectionSecret: undefined } as unknown as ChannelSetupHost;
      await expect(check(noResolver)).rejects.toThrow(SLACK_UNREACHABLE);
    });

    it("checks only Slack drafts", async () => {
      const { host, fetchWithTimeout, resolveConnectionSecret } = fakeHost(basic(), {
        draft: slackDraft({ catalogId: "channel.discord" }),
      });
      await expect(check(host)).rejects.toThrow(SLACK_DRAFT_ONLY);
      expect(fetchWithTimeout).not.toHaveBeenCalled();
      expect(resolveConnectionSecret).not.toHaveBeenCalled();
    });

    it("fails a draft that changed before asking Slack anything", async () => {
      const { host, fetchWithTimeout } = fakeHost(basic());
      await expect(checkSlackSetup(host, { draftId, expectedRevision: 2 })).rejects.toThrow("changed");
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });
  });
});
