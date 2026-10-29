import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import {
  DISCORD_DM_REFUSED,
  DISCORD_DRAFT_ONLY,
  DISCORD_TOKEN_REJECTED,
  DISCORD_UNREACHABLE,
  checkDiscordSetup,
} from "./channel-setup-discord-check.js";

const draftId = "11111111-1111-1111-1111-111111111111";
const TOKEN = "abc.def";
const BASE = "https://discord.com/api/v10";

type Reply = { status?: number; body?: unknown };
type Script = Record<string, Reply | ((init: RequestInit | undefined) => Reply)>;

const BOT = { id: "111", username: "goatbot", global_name: "Goat Bot" };
const APPLICATION = { id: "222", flags: 1 << 19, owner: { id: "333", username: "sam", global_name: "Sam" } };

function discordDraft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId,
    revision: 3,
    catalogId: "channel.discord",
    lifecycleMode: "create",
    draft: { runtimeMode: "gateway" },
    secretState: {},
    enabled: true,
    contentVersion: "content",
    testVersion: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as ChannelSetupDraft;
}

/** A setup host whose Discord answers from `script`, keyed `METHOD /path` below the API base. */
function fakeHost(script: Script, options: { draft?: ChannelSetupDraft; token?: string | undefined } = {}) {
  const calls: Array<{ method: string; path: string; init: RequestInit | undefined }> = [];
  const fetchWithTimeout = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    calls.push({ method, path, init });
    const entry = script[`${method} ${path}`];
    if (!entry) return new Response("{}", { status: 404 });
    const reply = typeof entry === "function" ? entry(init) : entry;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  });
  const draft = options.draft ?? discordDraft();
  const resolveConnectionSecret = vi.fn(() => ("token" in options ? options.token : TOKEN));
  const host = {
    storage: { channelSetupDrafts: { get: vi.fn(async () => draft) } },
    fetchWithTimeout,
    resolveConnectionSecret,
  } as unknown as ChannelSetupHost;
  return { host, calls, fetchWithTimeout, resolveConnectionSecret };
}

const standard = (application: unknown = APPLICATION): Script => ({
  "GET /users/@me": { body: BOT },
  "GET /applications/@me": { body: application },
  "GET /users/@me/guilds": { body: [] },
});

const check = (host: ChannelSetupHost, extra: { guildId?: string; directMessageWith?: string } = {}) =>
  checkDiscordSetup(host, { draftId, expectedRevision: 3, ...extra });

describe("Discord setup check", () => {
  it("names the bot and who made it", async () => {
    const { host, calls, resolveConnectionSecret } = fakeHost(standard());
    const result = await check(host);
    expect(result).toEqual({
      bot: { id: "111", name: "Goat Bot" },
      applicationId: "222",
      messageContentIntent: true,
      makers: [{ id: "333", name: "Sam" }],
      servers: [],
    });
    // It reads the draft's own keys, as the owner of that draft, and calls Discord in a fixed order.
    expect(resolveConnectionSecret).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: "gateway" }),
      "botToken",
      "botTokenEnv",
      "channel.discord",
      { connectionId: draftId, draftId },
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /users/@me",
      "GET /applications/@me",
      "GET /users/@me/guilds",
    ]);
    for (const call of calls) expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("falls back to the username when there is no display name", async () => {
    const { host } = fakeHost({
      ...standard({ id: "222", flags: 0, owner: { id: "333", username: "sam", global_name: null } }),
      "GET /users/@me": { body: { id: "111", username: "goatbot", global_name: null } },
    });
    const result = await check(host);
    expect(result.bot.name).toBe("goatbot");
    expect(result.makers).toEqual([{ id: "333", name: "sam" }]);
  });

  it("reports Message Content Intent off", async () => {
    for (const [flags, expected] of [
      [0, false],
      [1 << 18, true],
      [1 << 19, true],
      [(1 << 18) | (1 << 19), true],
      [1 << 12, false],
    ] as const) {
      const { host } = fakeHost(standard({ ...APPLICATION, flags }));
      expect((await check(host)).messageContentIntent).toBe(expected);
    }
    const { host } = fakeHost(standard({ ...APPLICATION, flags: undefined }));
    expect((await check(host)).messageContentIntent).toBe(false);
  });

  it("lists a team's owner first, then its accepted members", async () => {
    const member = (id: string, state: number) => ({
      membership_state: state,
      user: { id, username: `user-${id}`, global_name: id === "A" ? "Ann" : null },
    });
    const { host } = fakeHost(
      standard({
        ...APPLICATION,
        owner: { id: "B", username: "user-B" },
        team: { owner_user_id: "B", members: [member("A", 2), member("B", 2), member("C", 1)] },
      }),
    );
    expect((await check(host)).makers).toEqual([
      { id: "B", name: "user-B" },
      { id: "A", name: "Ann" },
    ]);
  });

  it("lists servers, and a server's text channels by position", async () => {
    const channels = [
      { id: "c3", name: "later", type: 0, position: 5 },
      { id: "v1", name: "voice", type: 2, position: 0 },
      { id: "cat", name: "category", type: 4, position: 0 },
      { id: "c1", name: "general", type: 0, position: 1 },
      { id: "a1", name: "announcements", type: 5, position: 2 },
      { id: "c2", name: "chat", type: 0, position: 3 },
    ];
    const { host, calls } = fakeHost({
      ...standard(),
      "GET /users/@me/guilds": {
        body: [
          { id: "1000000001", name: "Home" },
          { id: "1000000002", name: "Work" },
        ],
      },
      "GET /guilds/1000000001/channels": { body: channels },
    });
    const result = await check(host, { guildId: "1000000001" });
    expect(result.servers).toEqual([
      { id: "1000000001", name: "Home" },
      { id: "1000000002", name: "Work" },
    ]);
    expect(result.channels).toEqual([
      { id: "c1", name: "general" },
      { id: "c2", name: "chat" },
      { id: "c3", name: "later" },
    ]);
    expect(calls.map((call) => call.path).slice(-1)).toEqual(["/guilds/1000000001/channels"]);
  });

  it("leaves channels out for a server the bot is not in, without asking Discord about it", async () => {
    const { host, calls } = fakeHost({
      ...standard(),
      "GET /users/@me/guilds": { body: [{ id: "1000000001", name: "Home" }] },
    });
    const result = await check(host, { guildId: "1000000009" });
    expect(result.channels).toBeUndefined();
    expect(result).not.toHaveProperty("channels");
    expect(calls.some((call) => call.path.startsWith("/guilds/"))).toBe(false);
  });

  it("opens a DM only with someone who made the bot", async () => {
    const { host, calls } = fakeHost({
      ...standard(),
      "POST /users/@me/channels": { body: { id: "900", type: 1 } },
    });
    const result = await check(host, { directMessageWith: "333" });
    expect(result.directChannelId).toBe("900");
    const post = calls.filter((call) => call.method === "POST");
    expect(post).toHaveLength(1);
    expect(post[0]?.path).toBe("/users/@me/channels");
    expect(JSON.parse(String(post[0]?.init?.body))).toEqual({ recipient_id: "333" });
    expect((post[0]?.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const refused = fakeHost({
      ...standard(),
      "POST /users/@me/channels": { body: { id: "901" } },
    });
    await expect(check(refused.host, { directMessageWith: "999" })).rejects.toThrow(DISCORD_DM_REFUSED);
    expect(refused.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("opens a DM with a team's accepted member, and refuses one who was only invited", async () => {
    const application = {
      ...APPLICATION,
      team: {
        owner_user_id: "333",
        members: [
          { membership_state: 2, user: { id: "333", username: "sam" } },
          { membership_state: 2, user: { id: "444", username: "kim" } },
          { membership_state: 1, user: { id: "555", username: "lee" } },
        ],
      },
    };
    const script = { ...standard(application), "POST /users/@me/channels": { body: { id: "902" } } };
    expect((await check(fakeHost(script).host, { directMessageWith: "444" })).directChannelId).toBe("902");
    const invited = fakeHost(script);
    await expect(check(invited.host, { directMessageWith: "555" })).rejects.toThrow(DISCORD_DM_REFUSED);
    expect(invited.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("never opens a DM with the bot itself", async () => {
    const { host, calls } = fakeHost(standard());
    await expect(check(host, { directMessageWith: "111" })).rejects.toThrow(DISCORD_DM_REFUSED);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("says the token was rejected, and never quotes it", async () => {
    const rejected = fakeHost({
      "GET /users/@me": { status: 401, body: { message: `401: Unauthorized Bot ${TOKEN}` } },
    });
    const error = await check(rejected.host).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(DISCORD_TOKEN_REJECTED);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(rejected.calls).toHaveLength(1);

    // A 401 on a later call is the same answer.
    const late = fakeHost({ ...standard(), "GET /users/@me/guilds": { status: 401 } });
    await expect(check(late.host)).rejects.toThrow(DISCORD_TOKEN_REJECTED);

    const broken = fakeHost(standard());
    broken.fetchWithTimeout.mockRejectedValue(
      new Error(`request to ${BASE}/users/@me failed: Authorization: Bot ${TOKEN}`),
    );
    const unreachable = await check(broken.host).catch((caught: unknown) => caught);
    expect((unreachable as Error).message).toBe(DISCORD_UNREACHABLE);
    expect((unreachable as Error).message).not.toContain("abc.def");
    expect(JSON.stringify(unreachable)).not.toContain("abc.def");
  });

  it("says Discord was unreachable for any other failure, without quoting the answer", async () => {
    for (const script of [
      { ...standard(), "GET /applications/@me": { status: 500, body: { message: `boom ${TOKEN}` } } },
      { ...standard(), "GET /users/@me/guilds": { status: 403 } },
      { ...standard(), "GET /users/@me": { body: [] } },
      { ...standard(), "GET /applications/@me": { body: { flags: 1 << 18 } } },
      { ...standard(), "GET /users/@me/guilds": { body: { not: "a list" } } },
    ] as Script[]) {
      const error = await check(fakeHost(script).host).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(DISCORD_UNREACHABLE);
    }
    const garbled = fakeHost(standard());
    garbled.fetchWithTimeout.mockResolvedValue(new Response(`not json ${TOKEN}`, { status: 200 }));
    const error = await check(garbled.host).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(DISCORD_UNREACHABLE);
  });

  it("fails a failed DM open as unreachable", async () => {
    const { host } = fakeHost({ ...standard(), "POST /users/@me/channels": { status: 429 } });
    await expect(check(host, { directMessageWith: "333" })).rejects.toThrow(DISCORD_UNREACHABLE);
  });

  it("asks Discord nothing when the draft has no bot token", async () => {
    const { host, fetchWithTimeout } = fakeHost(standard(), { token: undefined });
    await expect(check(host)).rejects.toThrow(DISCORD_TOKEN_REJECTED);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("checks only Discord drafts", async () => {
    const { host, fetchWithTimeout } = fakeHost(standard(), {
      draft: discordDraft({ catalogId: "channel.telegram" }),
    });
    await expect(check(host)).rejects.toThrow(DISCORD_DRAFT_ONLY);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("fails a draft that changed before asking Discord anything", async () => {
    const { host, fetchWithTimeout } = fakeHost(standard());
    await expect(checkDiscordSetup(host, { draftId, expectedRevision: 2 })).rejects.toThrow("changed");
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
