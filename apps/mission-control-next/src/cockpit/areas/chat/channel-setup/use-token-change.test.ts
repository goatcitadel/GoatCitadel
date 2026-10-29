// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ChannelSetupDraft,
  DiscordSetupCheckResult,
  IntegrationConnection,
  SlackSetupCheckResult,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCORD_INTENT_OFF, DISCORD_TOKEN_FAILED } from "./discord-setup-model";
import { SLACK_APP_TOKEN_FAILED, SLACK_BOT_TOKEN_FAILED } from "./slack-setup-model";
import { TOKEN_CHANGE_CHANNELS, type TokenChangeChannel } from "./token-change-channels";
import { useTokenChange, type TokenChangeState } from "./use-token-change";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelRotateSecretDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkDiscordSetup: vi.fn(),
  checkSlackSetup: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const DISCORD = TOKEN_CHANGE_CHANNELS.get("discord")!;
const SLACK = TOKEN_CHANGE_CHANNELS.get("slack")!;
const BOT_TOKEN = "NEW-DISCORD-SECRET-TOKEN";
const SLACK_BOT_TOKEN = "xoxb-NEW-SECRET-BOT-TOKEN";
const SLACK_APP_TOKEN = "xapp-1-NEW-SECRET-APP-TOKEN";
const CONNECTION_REVISION = "a".repeat(64);
const CONNECTION: Pick<IntegrationConnection, "connectionId" | "revision"> = {
  connectionId: "conn-1",
  revision: CONNECTION_REVISION,
};

function rotateDraft(catalogId: string, overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "rotate-1",
    revision: 1,
    catalogId,
    connectionId: "conn-1",
    connectionRevision: CONNECTION_REVISION,
    lifecycleMode: "rotate_secret",
    enabled: true,
    draft: { label: "kept", applicationId: "1000" },
    secretState: {},
    contentVersion: "content",
    adapterVersion: "adapter",
    validationVersion: "validation",
    testVersion: "test",
    createdAt: "2026-10-26T09:00:00.000Z",
    updatedAt: "2026-10-26T09:00:00.000Z",
    ...overrides,
  };
}

const discordDraft = (overrides: Partial<ChannelSetupDraft> = {}) => rotateDraft("channel.discord", overrides);
const slackDraft = (overrides: Partial<ChannelSetupDraft> = {}) =>
  rotateDraft("channel.slack", { draft: { label: "kept" }, ...overrides });

function discordCheck(overrides: Partial<DiscordSetupCheckResult> = {}): DiscordSetupCheckResult {
  return {
    bot: { id: "9", name: "NewBot" },
    applicationId: "2000",
    messageContentIntent: true,
    makers: [{ id: "1", name: "Ada" }],
    servers: [],
    ...overrides,
  };
}

function slackCheck(overrides: Partial<SlackSetupCheckResult> = {}): SlackSetupCheckResult {
  return {
    workspace: { id: "T1", name: "Goat Team" },
    bot: { userId: "U9", name: "newbot" },
    appToken: "ok",
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let current: TokenChangeState;

function Probe({ channel, connectionId = "conn-1" }: { channel: TokenChangeChannel; connectionId?: string }) {
  current = useTokenChange({ ...CONNECTION, connectionId }, channel);
  return null;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(channel: TokenChangeChannel, connectionId?: string) {
  await act(async () => {
    root.render(createElement(Probe, { channel, connectionId }));
  });
  await settle();
}

async function run(action: () => Promise<void>) {
  await act(async () => {
    await action();
  });
}

/** Starts a Discord check and leaves it running: the page is looking at it while it is in flight. */
async function startCheck() {
  await act(async () => {
    void current.checkTokens({ botToken: BOT_TOKEN, appToken: "" });
  });
  await settle();
}

const checkDiscordToken = (token = BOT_TOKEN) => run(() => current.checkTokens({ botToken: token, appToken: "" }));
const checkSlackTokens = (botToken = SLACK_BOT_TOKEN, appToken = SLACK_APP_TOKEN) =>
  run(() => current.checkTokens({ botToken, appToken }));

/** What the gateway does for Discord: stores the token (one version on), reads the bot, keeps what is written. */
function arrangeDiscord(result: DiscordSetupCheckResult = discordCheck()) {
  api.createChannelRotateSecretDraft.mockResolvedValue(discordDraft());
  api.submitChannelSetupDraftSecrets.mockImplementation(async (_id: string, input: { expectedRevision: number }) =>
    discordDraft({ revision: input.expectedRevision + 1, secretState: { botToken: { configured: true } } as never }),
  );
  api.checkDiscordSetup.mockResolvedValue(result);
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      discordDraft({ revision: input.expectedRevision + 1, draft: input.draft }),
  );
}

function arrangeSlack(result: SlackSetupCheckResult = slackCheck()) {
  api.createChannelRotateSecretDraft.mockResolvedValue(slackDraft());
  api.submitChannelSetupDraftSecrets.mockImplementation(async (_id: string, input: { expectedRevision: number }) =>
    slackDraft({ revision: input.expectedRevision + 1 }),
  );
  api.checkSlackSetup.mockResolvedValue(result);
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      slackDraft({ revision: input.expectedRevision + 1, draft: input.draft }),
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(discordDraft());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useTokenChange", () => {
  it("asks for nothing by being mounted", async () => {
    await mount(DISCORD);
    expect(current).toMatchObject({ draft: null, checked: null, busy: false, error: undefined });
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
  });

  describe("the draft the new tokens are stored on", () => {
    it("makes a draft for changing the key when there is none", async () => {
      arrangeDiscord();
      await mount(DISCORD);
      await checkDiscordToken();
      expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ connectionId: "conn-1" });
      expect(api.createChannelRotateSecretDraft).toHaveBeenCalledExactlyOnceWith("conn-1");
    });

    it("reuses the newest open draft for changing this channel's key instead of making another", async () => {
      arrangeDiscord();
      api.fetchChannelSetupDrafts.mockResolvedValue({
        items: [
          discordDraft({ draftId: "older", updatedAt: "2026-10-20T09:00:00.000Z" }),
          discordDraft({ draftId: "newest", revision: 4, updatedAt: "2026-10-26T09:00:00.000Z" }),
          discordDraft({ draftId: "an-edit", lifecycleMode: "edit", updatedAt: "2026-10-27T09:00:00.000Z" }),
          discordDraft({ draftId: "another-channel", connectionId: "conn-2", updatedAt: "2026-10-28T09:00:00.000Z" }),
          // Made when the channel was another version: the gateway would refuse to check it.
          discordDraft({
            draftId: "out-of-date",
            connectionRevision: "b".repeat(64),
            updatedAt: "2026-10-29T09:00:00.000Z",
          }),
          // A draft of the other channel's catalogue is not this change.
          slackDraft({ draftId: "slack-one", updatedAt: "2026-10-30T09:00:00.000Z" }),
        ],
      });
      await mount(DISCORD);
      await checkDiscordToken();

      expect(api.createChannelRotateSecretDraft).not.toHaveBeenCalled();
      expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("newest", {
        expectedRevision: 4,
        values: { botToken: BOT_TOKEN },
      });
    });

    it("keeps the same draft when the tokens are checked again", async () => {
      arrangeDiscord();
      api.checkDiscordSetup.mockRejectedValueOnce(new Error("rejected"));
      // Storing the first token moved the draft on to version 2.
      api.fetchChannelSetupDraft.mockResolvedValue(discordDraft({ revision: 2 }));
      await mount(DISCORD);
      await checkDiscordToken("first");
      await checkDiscordToken("second");

      expect(api.createChannelRotateSecretDraft).toHaveBeenCalledTimes(1);
      expect(api.fetchChannelSetupDrafts).toHaveBeenCalledTimes(1);
      expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("rotate-1", {
        expectedRevision: 2,
        values: { botToken: "second" },
      });
    });

    it("starts another draft on the next try when the channel changed under the one it held", async () => {
      arrangeDiscord();
      api.checkDiscordSetup.mockRejectedValueOnce(new Error("The channel connection changed."));
      // What the gateway holds now: a draft from before the channel changed.
      api.fetchChannelSetupDraft.mockResolvedValue(discordDraft({ connectionRevision: "b".repeat(64) }));
      await mount(DISCORD);
      await checkDiscordToken();
      expect(current.draft).toBeNull();

      api.createChannelRotateSecretDraft.mockResolvedValue(discordDraft({ draftId: "rotate-2" }));
      await checkDiscordToken();
      expect(api.createChannelRotateSecretDraft).toHaveBeenCalledTimes(2);
      expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("rotate-2", expect.anything());
      expect(current.checked).not.toBeNull();
    });
  });

  describe("Discord's one token", () => {
    it("stores the token, asks Discord who the bot is, and keeps the new application on the draft", async () => {
      arrangeDiscord();
      await mount(DISCORD);
      await checkDiscordToken();

      expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("rotate-1", {
        expectedRevision: 1,
        values: { botToken: BOT_TOKEN },
      });
      expect(api.checkDiscordSetup).toHaveBeenCalledExactlyOnceWith({ draftId: "rotate-1", expectedRevision: 2 });
      // Everything else the draft held stays as it was.
      expect(api.updateChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("rotate-1", {
        expectedRevision: 2,
        draft: { label: "kept", applicationId: "2000" },
      });
      expect(current.draft?.revision).toBe(3);
      expect(current.checked).toEqual({
        botId: "2000",
        botName: "NewBot",
        works: "Token works. Your bot is NewBot.",
      });
      expect(current.error).toBeUndefined();
      expect(current.busy).toBe(false);
    });

    it("trims the token and stores nothing when it is empty", async () => {
      arrangeDiscord();
      await mount(DISCORD);
      await checkDiscordToken("   ");
      expect(api.fetchChannelSetupDrafts).not.toHaveBeenCalled();
      await checkDiscordToken(`  ${BOT_TOKEN}\n`);
      expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("rotate-1", {
        expectedRevision: 1,
        values: { botToken: BOT_TOKEN },
      });
    });

    it("says what stands in the way when Message Content Intent is off, and still keeps the application", async () => {
      arrangeDiscord(discordCheck({ messageContentIntent: false }));
      await mount(DISCORD);
      await checkDiscordToken();
      expect(current.checked?.inTheWay).toBe(DISCORD_INTENT_OFF);
      expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    });

    it("checks the stored token again without sending it again, and without rewriting what is already kept", async () => {
      arrangeDiscord(discordCheck({ messageContentIntent: false }));
      await mount(DISCORD);
      await checkDiscordToken();
      api.checkDiscordSetup.mockResolvedValue(discordCheck());
      await run(() => current.recheck());

      expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledTimes(1);
      // The draft stood at version 3 after the application was kept.
      expect(api.checkDiscordSetup).toHaveBeenLastCalledWith({ draftId: "rotate-1", expectedRevision: 3 });
      expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
      expect(current.checked?.inTheWay).toBeUndefined();
    });

    it("has nothing to check again before a draft holds a token", async () => {
      await mount(DISCORD);
      await run(() => current.recheck());
      expect(api.checkDiscordSetup).not.toHaveBeenCalled();
    });

    it("says in one plain sentence when Discord does not take the token, never quoting it", async () => {
      arrangeDiscord();
      api.checkDiscordSetup.mockRejectedValue(new Error(`GET /users/@me with Bot ${BOT_TOKEN} failed`));
      await mount(DISCORD);
      await checkDiscordToken();

      expect(current.error).toBe(DISCORD_TOKEN_FAILED);
      expect(current.checked).toBeNull();
      expect(current.busy).toBe(false);
      expect(JSON.stringify(current)).not.toContain(BOT_TOKEN);
      expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
      // The draft is read again after a failure: storing the token moved its version on.
      expect(api.fetchChannelSetupDraft).toHaveBeenCalledWith("rotate-1");
    });

    it("takes back a check that worked when the next check fails, so the token field can come back", async () => {
      arrangeDiscord();
      await mount(DISCORD);
      await checkDiscordToken();
      expect(current.checked).not.toBeNull();

      api.checkDiscordSetup.mockRejectedValue(new Error("revoked"));
      api.fetchChannelSetupDraft.mockResolvedValue(discordDraft({ revision: 5 }));
      await run(() => current.recheck());
      expect(current.checked).toBeNull();
      expect(current.error).toBe(DISCORD_TOKEN_FAILED);
    });

    it("says so when a draft for changing the key cannot be made", async () => {
      api.createChannelRotateSecretDraft.mockRejectedValue(new Error("nope"));
      await mount(DISCORD);
      await checkDiscordToken();
      expect(current.error).toBe(DISCORD_TOKEN_FAILED);
      expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    });

    it("says so when the draft cannot be kept up to date after a good check, and shows no bot", async () => {
      arrangeDiscord();
      api.updateChannelSetupDraft.mockRejectedValue(new Error("stale"));
      api.fetchChannelSetupDraft.mockResolvedValue(discordDraft({ revision: 3 }));
      await mount(DISCORD);
      await checkDiscordToken();
      expect(current.checked).toBeNull();
      expect(current.error).toBe(DISCORD_TOKEN_FAILED);
      expect(current.draft?.revision).toBe(3);
    });
  });

  describe("Slack's two tokens", () => {
    it("stores both in one call, then asks Slack whether each is accepted", async () => {
      arrangeSlack();
      await mount(SLACK);
      await checkSlackTokens();

      expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("rotate-1", {
        expectedRevision: 1,
        values: { botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN },
      });
      expect(api.checkSlackSetup).toHaveBeenCalledExactlyOnceWith({
        draftId: "rotate-1",
        expectedRevision: 2,
        checkAppToken: true,
      });
      expect(current.checked).toEqual({
        botId: "U9",
        botName: "@newbot",
        works: "Tokens work. Your bot is @newbot in Goat Team.",
      });
    });

    it("writes nothing to the draft: the gateway takes a Slack bot and workspace only from its own receipt", async () => {
      arrangeSlack();
      await mount(SLACK);
      await checkSlackTokens();
      expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
      expect(current.draft?.revision).toBe(2);
    });

    it.each([
      ["no bot token", "", SLACK_APP_TOKEN],
      ["no app-level token", SLACK_BOT_TOKEN, "  "],
    ])("stores nothing with %s", async (_name, botToken, appToken) => {
      arrangeSlack();
      await mount(SLACK);
      await checkSlackTokens(botToken, appToken);
      expect(api.fetchChannelSetupDrafts).not.toHaveBeenCalled();
      expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    });

    it.each(["rejected", "missing"] as const)(
      "says the app-level token is not accepted when Slack answers %s, and goes no further",
      async (answer) => {
        arrangeSlack(slackCheck({ appToken: answer }));
        await mount(SLACK);
        await checkSlackTokens();
        expect(current.error).toBe(SLACK_APP_TOKEN_FAILED);
        expect(current.checked).toBeNull();
        // Both tokens are stored, which moved the draft's version on: the next try carries it.
        expect(current.draft?.revision).toBe(2);
        expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
      },
    );

    it("treats an answer that says nothing about the app-level token as not accepted", async () => {
      arrangeSlack(slackCheck({ appToken: undefined }));
      await mount(SLACK);
      await checkSlackTokens();
      expect(current.error).toBe(SLACK_APP_TOKEN_FAILED);
    });

    it("says in one plain sentence when Slack does not take the bot token, never quoting either", async () => {
      arrangeSlack();
      api.checkSlackSetup.mockRejectedValue(new Error(`auth.test with ${SLACK_BOT_TOKEN} and ${SLACK_APP_TOKEN}`));
      api.fetchChannelSetupDraft.mockResolvedValue(slackDraft({ revision: 2 }));
      await mount(SLACK);
      await checkSlackTokens();

      expect(current.error).toBe(SLACK_BOT_TOKEN_FAILED);
      expect(current.checked).toBeNull();
      expect(JSON.stringify(current)).not.toContain("SECRET");
    });
  });

  it("goes on with one check at a time", async () => {
    let release!: (draft: ChannelSetupDraft) => void;
    arrangeDiscord();
    api.submitChannelSetupDraftSecrets.mockReturnValue(new Promise((resolve) => (release = resolve)));
    await mount(DISCORD);
    await startCheck();
    expect(current.busy).toBe(true);
    await run(() => current.checkTokens({ botToken: "again", appToken: "" }));
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledTimes(1);
    await act(async () => release(discordDraft({ revision: 2 })));
    await settle();
  });

  it("starts clean for another channel, and drops a reply that arrives after the page went", async () => {
    let release!: (draft: ChannelSetupDraft) => void;
    arrangeDiscord();
    api.submitChannelSetupDraftSecrets.mockReturnValue(new Promise((resolve) => (release = resolve)));
    await mount(DISCORD);
    await startCheck();
    expect(current.busy).toBe(true);

    await mount(DISCORD, "conn-2");
    expect(current).toMatchObject({ draft: null, checked: null, busy: false });
    await act(async () => release(discordDraft({ revision: 2 })));
    await settle();
    // The reply belonged to the channel before: it changes nothing here.
    expect(current).toMatchObject({ draft: null, checked: null, busy: false });
  });
});
