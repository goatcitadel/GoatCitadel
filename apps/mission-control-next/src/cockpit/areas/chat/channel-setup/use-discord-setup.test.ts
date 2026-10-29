// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDraft, DiscordSetupCheckResult } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCORD_TOKEN_FAILED, DISCORD_UNREACHABLE } from "./discord-setup-model";
import { SAY_HI_POLL_MS, SETUP_CODE_TTL_MS } from "./setup-code";
import { useDiscordSetup, type DiscordSetupState } from "./use-discord-setup";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkDiscordSetup: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const TOKEN = "MTIzNDU2.SECRET.TOKEN";
const TOKEN_STORED = { botToken: { configured: true, custody: "temporary" as const } };

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.discord",
    lifecycleMode: "create",
    enabled: true,
    draft: {},
    secretState: {},
    contentVersion: "content",
    adapterVersion: "adapter",
    validationVersion: "validation",
    testVersion: "test",
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
    ...overrides,
  };
}

/** A draft made on the Discord page in Chat, with its token already stored. */
function pageDraft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return draft({
    revision: 4,
    draft: { setupPage: "messaging", applicationId: "222" },
    secretState: TOKEN_STORED,
    ...overrides,
  });
}

function checkResult(overrides: Partial<DiscordSetupCheckResult> = {}): DiscordSetupCheckResult {
  return {
    bot: { id: "111", name: "Goat Bot" },
    applicationId: "222",
    messageContentIntent: true,
    makers: [{ id: "333", name: "Ada" }],
    servers: [],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let current: DiscordSetupState;

function Probe({ workspaceId, resumeDraftId }: { workspaceId: string; resumeDraftId?: string }) {
  current = useDiscordSetup(workspaceId, resumeDraftId);
  return null;
}

async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Lets fake time pass, with every question that falls due asked and answered. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(workspaceId = "default", resumeDraftId?: string) {
  await act(async () => {
    root.render(createElement(Probe, { workspaceId, resumeDraftId }));
  });
  await settle();
}

async function run(action: () => Promise<void>) {
  await act(async () => {
    await action();
  });
}

/** The calls a successful first check makes: a new draft at version 1, the token stored at 2, the bot named at 3. */
function arrangeCheck(result: DiscordSetupCheckResult = checkResult()) {
  api.createChannelSetupDraft.mockResolvedValue(draft({ revision: 1, draft: { label: "kept" } }));
  api.submitChannelSetupDraftSecrets.mockResolvedValue(
    draft({ revision: 2, draft: { label: "kept" }, secretState: TOKEN_STORED }),
  );
  api.checkDiscordSetup.mockResolvedValue(result);
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: TOKEN_STORED }),
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(draft());
  api.discardChannelSetupDraft.mockResolvedValue({ draftId: "draft-1", deleted: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
});

describe("useDiscordSetup", () => {
  it("starts with nothing: no draft, no bot, not busy", async () => {
    await mount();
    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ catalogId: "channel.discord" });
    expect(current).toMatchObject({ draft: null, check: null, busy: false });
    expect(current.error).toBeUndefined();
  });

  it("checks a token: one draft, the token stored securely, the bot named", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkToken(TOKEN));

    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.createChannelSetupDraft).toHaveBeenCalledWith({
      catalogId: "channel.discord",
      lifecycleMode: "create",
    });
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledTimes(1);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 1,
      values: { botToken: TOKEN },
    });
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(1);
    expect(api.checkDiscordSetup).toHaveBeenCalledWith({ draftId: "draft-1", expectedRevision: 2 });
    // The last write merges into the draft's own values, with the version the token write returned.
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 2,
      draft: {
        label: "kept",
        setupPage: "messaging",
        runtimeMode: "gateway",
        applicationId: "222",
        inboundDmPolicy: "pairing",
      },
    });
    expect(current.draft?.revision).toBe(3);
    expect(current.draft?.draft).toMatchObject({ applicationId: "222", setupPage: "messaging" });
    expect(current.check).toEqual(checkResult());
    expect(current.busy).toBe(false);
    expect(current.error).toBeUndefined();
  });

  it("never keeps the token in what it returns", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkToken(`  ${TOKEN}  `));
    // Trimmed on the way in, and gone from everything the page can read.
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 1,
      values: { botToken: TOKEN },
    });
    expect(JSON.stringify(current)).not.toContain("SECRET");
  });

  it("does nothing for an empty token, or while another check runs", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkToken("   "));
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();

    let finish: (value: ChannelSetupDraft) => void = () => undefined;
    api.createChannelSetupDraft.mockReturnValue(new Promise<ChannelSetupDraft>((resolve) => (finish = resolve)));
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = current.checkToken(TOKEN);
      await Promise.resolve();
    });
    expect(current.busy).toBe(true);
    await run(() => current.checkToken(TOKEN));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    finish(draft({ revision: 1 }));
    await run(() => first);
  });

  it("shows one plain sentence when the token fails", async () => {
    arrangeCheck();
    api.checkDiscordSetup.mockRejectedValue(new Error(`HTTP 401 Authorization: Bot ${TOKEN}`));
    await mount();
    await run(() => current.checkToken(TOKEN));

    // The gateway's own message is never shown, and neither is anything it quoted.
    expect(current.error).toBe(DISCORD_TOKEN_FAILED);
    expect(JSON.stringify(current)).not.toContain("HTTP 401");
    expect(JSON.stringify(current)).not.toContain("SECRET");
    expect(current.check).toBeNull();
    expect(current.busy).toBe(false);
    // The token was stored before the failure, which moved the draft on: the next try carries the latest version.
    expect(current.draft?.draftId).toBe("draft-1");
    expect(api.fetchChannelSetupDraft).toHaveBeenCalledWith("draft-1");
  });

  it("says the same sentence when the token cannot be stored or the draft cannot be saved", async () => {
    arrangeCheck();
    api.submitChannelSetupDraftSecrets.mockRejectedValueOnce(new Error("Authorization: Bot leaked"));
    await mount();
    await run(() => current.checkToken(TOKEN));
    expect(current.error).toBe(DISCORD_TOKEN_FAILED);
    expect(api.checkDiscordSetup).not.toHaveBeenCalled();

    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("conflict"));
    await run(() => current.checkToken(TOKEN));
    expect(current.error).toBe(DISCORD_TOKEN_FAILED);
    expect(current.check).toBeNull();
  });

  it("goes on with the same draft after a failure, and clears the sentence when it works", async () => {
    arrangeCheck();
    api.checkDiscordSetup.mockRejectedValueOnce(new Error("offline"));
    // The draft as the gateway has it after the failed try: the token was stored, which moved its version on.
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 2, secretState: TOKEN_STORED }));
    await mount();
    await run(() => current.checkToken(TOKEN));
    expect(current.error).toBe(DISCORD_TOKEN_FAILED);
    expect(current.draft?.revision).toBe(2);

    await run(() => current.checkToken(TOKEN));
    // No second draft, and the write carries the version the failed try left behind.
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 2,
      values: { botToken: TOKEN },
    });
    expect(current.error).toBeUndefined();
    expect(current.check).toEqual(checkResult());
  });

  it("resumes only a setup made on this page", async () => {
    arrangeCheck();
    const elsewhere = draft({ draftId: "settings-1", updatedAt: "2026-10-28T11:00:00.000Z", draft: {} });
    const here = pageDraft({ draftId: "page-1", updatedAt: "2026-10-28T10:00:00.000Z" });
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [elsewhere, here] });
    await mount();
    // The newer one belongs to Settings, so the page does not take it over.
    expect(current.draft?.draftId).toBe("page-1");

    // A draft the address names that was not made here is not gone on with either: the page starts fresh.
    api.checkDiscordSetup.mockClear();
    await mount("default", "settings-1");
    expect(current.draft).toBeNull();
    expect(current.check).toBeNull();
    expect(api.checkDiscordSetup).not.toHaveBeenCalled();
  });

  it("resumes the draft the address names, and checks its saved token again", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [pageDraft({ draftId: "page-1" }), pageDraft({ draftId: "page-2", revision: 7 })],
    });
    api.checkDiscordSetup.mockResolvedValue(checkResult());
    await mount("default", "page-2");
    expect(current.draft?.draftId).toBe("page-2");
    // Resuming reads; it neither stores a token nor writes the draft.
    expect(api.checkDiscordSetup).toHaveBeenCalledExactlyOnceWith({ draftId: "page-2", expectedRevision: 7 });
    expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(current.check).toEqual(checkResult());
    expect(current.busy).toBe(false);
  });

  it("leaves a resumed setup without a stored token unchecked", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft({ secretState: {} })] });
    await mount();
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.check).toBeNull();
    expect(api.checkDiscordSetup).not.toHaveBeenCalled();
    expect(current.busy).toBe(false);
  });

  it("says the plain sentence when the saved token no longer works", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkDiscordSetup.mockRejectedValue(new Error(`Bot ${TOKEN}`));
    await mount();
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.check).toBeNull();
    expect(current.error).toBe(DISCORD_TOKEN_FAILED);
    expect(current.busy).toBe(false);
  });

  it("starts fresh when the drafts cannot be read", async () => {
    api.fetchChannelSetupDrafts.mockRejectedValue(new Error("offline"));
    await mount();
    expect(current).toMatchObject({ draft: null, check: null, busy: false });
    expect(current.error).toBeUndefined();
  });

  it("checks again with the saved token", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkDiscordSetup.mockResolvedValueOnce(checkResult({ messageContentIntent: false }));
    await mount();
    expect(current.check?.messageContentIntent).toBe(false);

    api.checkDiscordSetup.mockResolvedValueOnce(checkResult({ messageContentIntent: true }));
    await run(() => current.recheck());

    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(2);
    expect(api.checkDiscordSetup).toHaveBeenLastCalledWith({ draftId: "draft-1", expectedRevision: 4 });
    // The token is not sent again, and nothing is written.
    expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(current.check?.messageContentIntent).toBe(true);
    expect(current.error).toBeUndefined();
    expect(current.busy).toBe(false);
  });

  it("asks for a new token when checking again fails, and takes it on the same draft", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkDiscordSetup.mockResolvedValueOnce(checkResult({ messageContentIntent: false }));
    await mount();
    expect(current.check?.bot.name).toBe("Goat Bot");

    // The token was revoked or reset in the meantime.
    api.checkDiscordSetup.mockRejectedValueOnce(new Error(`Bot ${TOKEN}`));
    await run(() => current.recheck());
    expect(current.error).toBe(DISCORD_TOKEN_FAILED);
    expect(JSON.stringify(current)).not.toContain("SECRET");
    // No bot is known any more, which is what puts the token field back.
    expect(current.check).toBeNull();
    expect(current.busy).toBe(false);
    expect(current.draft?.draftId).toBe("draft-1");

    // A new token goes to the same draft and clears the sentence.
    api.submitChannelSetupDraftSecrets.mockResolvedValue(draft({ revision: 5, secretState: TOKEN_STORED }));
    api.checkDiscordSetup.mockResolvedValue(checkResult());
    api.updateChannelSetupDraft.mockImplementation(
      async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
        draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: TOKEN_STORED }),
    );
    await run(() => current.checkToken("MTIzNDU2.NEW.TOKEN"));
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 4,
      values: { botToken: "MTIzNDU2.NEW.TOKEN" },
    });
    expect(current.error).toBeUndefined();
    expect(current.check?.bot.name).toBe("Goat Bot");
  });

  it("does not check again with no setup, or while busy", async () => {
    await mount();
    await run(() => current.recheck());
    expect(api.checkDiscordSetup).not.toHaveBeenCalled();
  });

  it("starts over: discards the draft and forgets the bot", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkToken(TOKEN));
    await run(() => current.startOver());
    expect(api.discardChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", 3);
    expect(current).toMatchObject({ draft: null, check: null, busy: false });
    expect(current.error).toBeUndefined();

    // The next check begins a new draft.
    api.createChannelSetupDraft.mockResolvedValue(draft({ draftId: "draft-2" }));
    api.submitChannelSetupDraftSecrets.mockResolvedValue(draft({ draftId: "draft-2", revision: 2 }));
    await run(() => current.checkToken(TOKEN));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(2);
  });

  it("keeps the setup when it cannot be discarded", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkToken(TOKEN));
    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await run(() => current.startOver());
    expect(current.error).toBeTruthy();
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.check).not.toBeNull();
    expect(current.busy).toBe(false);
  });

  it("starts over with nothing to discard by only clearing", async () => {
    await mount();
    await run(() => current.startOver());
    expect(api.discardChannelSetupDraft).not.toHaveBeenCalled();
    expect(current).toMatchObject({ draft: null, check: null, busy: false });
  });

  it("drops a slow reply once the workspace has changed", async () => {
    let finish: (value: { items: ChannelSetupDraft[] }) => void = () => undefined;
    api.fetchChannelSetupDrafts.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await mount("one");
    expect(current.busy).toBe(true);

    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
    await mount("two");
    await act(async () => {
      finish({ items: [pageDraft({ draftId: "old-workspace" })] });
      await Promise.resolve();
    });
    await settle();
    expect(current.draft).toBeNull();
    expect(api.checkDiscordSetup).not.toHaveBeenCalled();
  });
});

const ADA = { id: "333", name: "Ada" };
const BO = { id: "334", name: "Bo" };
const SERVER = { id: "900", name: "Goat Server" };
const SIDE_SERVER = { id: "901", name: "Side Server" };
const CHANNELS = [
  { id: "701", name: "general" },
  { id: "702", name: "bots" },
];
/** What a person who made the bot has already saved on a draft: they alone may message it. */
const WHO = { ownerActorIds: ["333"], allowedSenders: ["333"], inboundAccessMode: "allowlist" };

/**
 * The gateway once the bot is in its servers: the server's text channels when one is asked about, and the channel
 * Discord opens with the person asked for when a direct message is.
 */
function arrangeServers(overrides: Partial<DiscordSetupCheckResult> = {}) {
  api.checkDiscordSetup.mockImplementation(async (input: { guildId?: string; directMessageWith?: string }) =>
    checkResult({
      servers: [SERVER],
      ...overrides,
      ...(input.guildId ? { channels: CHANNELS } : {}),
      ...(input.directMessageWith ? { directChannelId: `dm-${input.directMessageWith}` } : {}),
    }),
  );
}

/** The gateway keeps whatever draft it is sent, one version on. */
function echoUpdates() {
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: TOKEN_STORED }),
  );
}

const questions = () => api.checkDiscordSetup.mock.calls.map(([input]) => input);
const directQuestions = () => questions().filter((input) => input.directMessageWith !== undefined);
const lastUpdate = () =>
  api.updateChannelSetupDraft.mock.lastCall as [string, { expectedRevision: number; draft: Record<string, unknown> }];

describe("useDiscordSetup, waiting for the bot to join a server", () => {
  beforeEach(echoUpdates);

  /** Mounts on a setup whose bot is in no server. Returns how many timers are pending when nothing is waiting. */
  async function mountWaitingForServer(): Promise<number> {
    vi.useFakeTimers();
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkDiscordSetup.mockResolvedValue(checkResult());
    await mount();
    expect(current.check?.servers).toEqual([]);
    expect(current.waitingForServer).toBe(false);
    return vi.getTimerCount();
  }

  it("waits for a server every 4 seconds and stops when one shows up", async () => {
    const idle = await mountWaitingForServer();
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(1);

    act(() => current.waitForServer());
    expect(current.waitingForServer).toBe(true);
    expect(current.serverWaitExpired).toBe(false);
    // One timer asks, another ends the wait.
    expect(vi.getTimerCount()).toBe(idle + 2);

    await advance(SAY_HI_POLL_MS - 1);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(2);
    expect(api.checkDiscordSetup).toHaveBeenLastCalledWith({ draftId: "draft-1", expectedRevision: 4 });
    await advance(SAY_HI_POLL_MS);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(3);
    expect(current.waitingForServer).toBe(true);

    // A question that fails is asked again with the next one, and says nothing.
    api.checkDiscordSetup.mockRejectedValueOnce(new Error(`Bot ${TOKEN}`));
    await advance(SAY_HI_POLL_MS);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(4);
    expect(current.waitingForServer).toBe(true);
    expect(current.error).toBeUndefined();

    arrangeServers();
    await advance(SAY_HI_POLL_MS);
    await settle();
    expect(current.waitingForServer).toBe(false);
    expect(current.serverWaitExpired).toBe(false);
    expect(current.check?.servers).toEqual([SERVER]);

    // Nothing is asked once a server has shown up, however long the page stays, and no timer is left running.
    expect(vi.getTimerCount()).toBe(idle);
    const asked = api.checkDiscordSetup.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(asked);
  });

  it("is one wait however often it is asked for, and none once a server is there", async () => {
    const idle = await mountWaitingForServer();
    act(() => current.waitForServer());
    act(() => current.waitForServer());
    expect(vi.getTimerCount()).toBe(idle + 2);
    await advance(SAY_HI_POLL_MS);
    // The resume check and one question, not two.
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(2);

    arrangeServers();
    await advance(SAY_HI_POLL_MS);
    await settle();
    expect(current.check?.servers).toEqual([SERVER]);
    const asked = api.checkDiscordSetup.mock.calls.length;
    act(() => current.waitForServer());
    expect(current.waitingForServer).toBe(false);
    await advance(SAY_HI_POLL_MS * 3);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(asked);
  });

  it("does not wait with no setup, or until the intent is on", async () => {
    vi.useFakeTimers();
    await mount();
    act(() => current.waitForServer());
    expect(current.waitingForServer).toBe(false);

    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkDiscordSetup.mockResolvedValue(checkResult({ messageContentIntent: false }));
    await mount("other");
    act(() => current.waitForServer());
    expect(current.waitingForServer).toBe(false);
  });

  it("stops waiting after 10 minutes and when the page closes", async () => {
    const idle = await mountWaitingForServer();
    act(() => current.waitForServer());

    await advance(SETUP_CODE_TTL_MS);
    expect(current.waitingForServer).toBe(false);
    expect(current.serverWaitExpired).toBe(true);
    expect(vi.getTimerCount()).toBe(idle);
    const asked = api.checkDiscordSetup.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(asked);

    // Asking again starts a new wait.
    act(() => current.waitForServer());
    expect(current.waitingForServer).toBe(true);
    expect(current.serverWaitExpired).toBe(false);
    await advance(SAY_HI_POLL_MS);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(asked + 1);

    // The page goes: nothing is asked for it after, and no timer is left running.
    await act(async () => {
      root.render(createElement("div"));
    });
    expect(vi.getTimerCount()).toBe(idle);
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(asked + 1);
  });

  it("stops waiting when the operator starts over", async () => {
    const idle = await mountWaitingForServer();
    act(() => current.waitForServer());
    await advance(SAY_HI_POLL_MS);
    const asked = api.checkDiscordSetup.mock.calls.length;

    await run(() => current.startOver());
    expect(current).toMatchObject({ draft: null, check: null, waitingForServer: false, serverWaitExpired: false });
    expect(vi.getTimerCount()).toBe(idle);
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(asked);
  });

  it("drops an answer that arrives after the operator started over", async () => {
    await mountWaitingForServer();
    act(() => current.waitForServer());
    let answer: (result: DiscordSetupCheckResult) => void = () => undefined;
    api.checkDiscordSetup.mockReturnValueOnce(new Promise<DiscordSetupCheckResult>((resolve) => (answer = resolve)));
    await advance(SAY_HI_POLL_MS);
    await run(() => current.startOver());
    await act(async () => {
      answer(checkResult({ servers: [SERVER] }));
    });
    await settle();
    expect(current.draft).toBeNull();
    expect(current.check).toBeNull();
    // It saved nothing for a setup that was discarded.
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });
});

describe("useDiscordSetup, choosing where the bot posts", () => {
  beforeEach(echoUpdates);

  const resumeAt = (values: Record<string, unknown> = {}) =>
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [pageDraft({ draft: { setupPage: "messaging", applicationId: "222", ...values } })],
    });

  it("posts in direct messages by default, saved once with the one person who made the bot", async () => {
    resumeAt({ guildPolicy: "allowlist", defaultGuildId: "old" });
    arrangeServers();
    await mount();

    // Direct messages need the channel Discord opens with the person who made the bot.
    expect(directQuestions()).toEqual([{ draftId: "draft-1", expectedRevision: 4, directMessageWith: "333" }]);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    const [, saved] = lastUpdate();
    expect(saved).toEqual({
      expectedRevision: 4,
      draft: {
        setupPage: "messaging",
        applicationId: "222",
        ownerActorIds: ["333"],
        allowedSenders: ["333"],
        inboundAccessMode: "allowlist",
        guildPolicy: "off",
        defaultChannelId: "dm-333",
      },
    });
    expect(saved.draft).not.toHaveProperty("defaultGuildId");
    expect(current).toMatchObject({ makerId: "333", posting: { kind: "direct" }, serverId: "900", busy: false });
    expect(current.channels).toEqual(CHANNELS);
    expect(current.draft?.revision).toBe(5);
    expect(current.error).toBeUndefined();
  });

  it("saves a chosen channel", async () => {
    resumeAt();
    arrangeServers();
    await mount();

    await run(() => current.choosePosting({ kind: "channel", guildId: "900", channelId: "701" }));
    // A channel needs no direct-message channel: only the first save asked for one.
    expect(directQuestions()).toHaveLength(1);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);
    expect(lastUpdate()).toEqual([
      "draft-1",
      {
        expectedRevision: 5,
        draft: {
          setupPage: "messaging",
          applicationId: "222",
          ownerActorIds: ["333"],
          allowedSenders: ["333"],
          inboundAccessMode: "allowlist",
          guildPolicy: "allowlist",
          defaultGuildId: "900",
          defaultChannelId: "701",
        },
      },
    ]);
    expect(current.posting).toEqual({ kind: "channel", guildId: "900", channelId: "701" });
    expect(current.draft?.revision).toBe(6);

    // And back to direct messages: the server goes from the draft again.
    await run(() => current.choosePosting({ kind: "direct" }));
    expect(directQuestions()).toHaveLength(2);
    expect(lastUpdate()[1].draft).not.toHaveProperty("defaultGuildId");
    expect(lastUpdate()[1].draft).toMatchObject({ guildPolicy: "off", defaultChannelId: "dm-333" });
    expect(current.posting).toEqual({ kind: "direct" });
  });

  it("does not save a channel that is not one of the server's", async () => {
    resumeAt();
    arrangeServers();
    await mount();
    const saves = api.updateChannelSetupDraft.mock.calls.length;
    await run(() => current.choosePosting({ kind: "channel", guildId: "900", channelId: "999" }));
    await run(() => current.choosePosting({ kind: "channel", guildId: "901", channelId: "701" }));
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(saves);
    expect(current.posting).toEqual({ kind: "direct" });
  });

  it("chooses for you when one person made the bot, and asks when a team did", async () => {
    // A team: nobody is chosen, nothing is saved, and nothing can be posted for nobody.
    resumeAt();
    arrangeServers({ makers: [ADA, BO] });
    await mount();
    expect(current.makerId).toBeNull();
    expect(current.posting).toBeNull();
    expect(directQuestions()).toHaveLength(0);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    await run(() => current.choosePosting({ kind: "direct" }));
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    // Someone who did not make the bot cannot be chosen.
    await run(() => current.chooseMaker("999"));
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();

    await run(() => current.chooseMaker("334"));
    expect(directQuestions()).toEqual([{ draftId: "draft-1", expectedRevision: 4, directMessageWith: "334" }]);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(lastUpdate()[1].draft).toMatchObject({
      ownerActorIds: ["334"],
      allowedSenders: ["334"],
      inboundAccessMode: "allowlist",
      guildPolicy: "off",
      defaultChannelId: "dm-334",
    });
    expect(current).toMatchObject({ makerId: "334", posting: { kind: "direct" } });

    // A channel already chosen stays when another person is chosen, and only who may message changes.
    await run(() => current.choosePosting({ kind: "channel", guildId: "900", channelId: "702" }));
    await run(() => current.chooseMaker("333"));
    expect(directQuestions()).toHaveLength(1);
    expect(lastUpdate()[1].draft).toMatchObject({
      ownerActorIds: ["333"],
      allowedSenders: ["333"],
      guildPolicy: "allowlist",
      defaultGuildId: "900",
      defaultChannelId: "702",
    });
    expect(current).toMatchObject({ makerId: "333", posting: { kind: "channel", channelId: "702" } });
  });

  it("chooses nobody, and saves nothing, when Discord names nobody who made the bot", async () => {
    resumeAt();
    arrangeServers({ makers: [] });
    await mount();
    expect(current.check?.makers).toEqual([]);
    expect(current.makerId).toBeNull();
    expect(current.posting).toBeNull();
    expect(directQuestions()).toHaveLength(0);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(current.error).toBeUndefined();
  });

  it("asks which server only when the bot is in several, and lists a server's channels once it is chosen", async () => {
    resumeAt();
    arrangeServers({ servers: [SERVER, SIDE_SERVER] });
    await mount();
    // Direct messages are the default whichever server: no server is picked and no channel list is asked for.
    expect(current).toMatchObject({ makerId: "333", posting: { kind: "direct" }, serverId: null, channels: null });
    expect(questions().some((input) => input.guildId !== undefined)).toBe(false);
    const saves = api.updateChannelSetupDraft.mock.calls.length;

    await run(() => current.chooseServer("999"));
    expect(questions().some((input) => input.guildId === "999")).toBe(false);

    await run(() => current.chooseServer("901"));
    expect(questions().at(-1)).toEqual({ draftId: "draft-1", expectedRevision: 5, guildId: "901" });
    expect(current).toMatchObject({ serverId: "901", posting: { kind: "direct" } });
    expect(current.channels).toEqual(CHANNELS);
    // Looking at a server's channels saves nothing.
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(saves);
  });

  it("goes back to direct messages when another server is chosen after a channel", async () => {
    resumeAt();
    arrangeServers({ servers: [SERVER, SIDE_SERVER] });
    await mount();
    await run(() => current.chooseServer("901"));
    await run(() => current.choosePosting({ kind: "channel", guildId: "901", channelId: "701" }));
    expect(current.posting).toEqual({ kind: "channel", guildId: "901", channelId: "701" });

    await run(() => current.chooseServer("900"));
    expect(current).toMatchObject({ serverId: "900", posting: { kind: "direct" } });
    expect(lastUpdate()[1].draft).toMatchObject({ guildPolicy: "off", defaultChannelId: "dm-333" });
    expect(lastUpdate()[1].draft).not.toHaveProperty("defaultGuildId");
  });

  it("says one plain sentence when a server's channels cannot be listed", async () => {
    resumeAt();
    arrangeServers({ servers: [SERVER, SIDE_SERVER] });
    await mount();
    api.checkDiscordSetup.mockRejectedValueOnce(new Error(`Bot ${TOKEN}`));
    await run(() => current.chooseServer("901"));
    expect(current.error).toBe(DISCORD_UNREACHABLE);
    expect(JSON.stringify(current)).not.toContain("SECRET");
    expect(current.channels).toBeNull();
    expect(current.posting).toEqual({ kind: "direct" });
    expect(current.busy).toBe(false);
  });

  /** The gateway when it can name the servers but not list one's channels, as when Discord answers 429. */
  function arrangeUnreadableChannels() {
    api.checkDiscordSetup.mockImplementation(async (input: { guildId?: string; directMessageWith?: string }) => {
      if (input.guildId) throw new Error(`HTTP 429 Authorization: Bot ${TOKEN}`);
      return checkResult({
        servers: [SERVER],
        ...(input.directMessageWith ? { directChannelId: `dm-${input.directMessageWith}` } : {}),
      });
    });
  }

  it("keeps a saved channel, says why, and writes nothing, when its server's channels cannot be read", async () => {
    resumeAt({ ...WHO, guildPolicy: "allowlist", defaultGuildId: "900", defaultChannelId: "702" });
    arrangeUnreadableChannels();
    await mount();

    // An unread list says nothing about the saved channel: it stays, and the draft is left as it was.
    expect(current).toMatchObject({
      makerId: "333",
      serverId: "900",
      posting: { kind: "channel", guildId: "900", channelId: "702" },
      channels: null,
      busy: false,
    });
    expect(current.error).toBe(DISCORD_UNREACHABLE);
    expect(JSON.stringify(current)).not.toContain("SECRET");
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(directQuestions()).toHaveLength(0);
    // A channel cannot be chosen from a list that was not read.
    await run(() => current.choosePosting({ kind: "channel", guildId: "900", channelId: "701" }));
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();

    // Asking for the list again, for the server the channel is in, brings it back and clears the sentence.
    arrangeServers();
    await run(() => current.chooseServer("900"));
    expect(questions().at(-1)).toEqual({ draftId: "draft-1", expectedRevision: 4, guildId: "900" });
    expect(current.channels).toEqual(CHANNELS);
    expect(current.error).toBeUndefined();
    expect(current.posting).toEqual({ kind: "channel", guildId: "900", channelId: "702" });
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("goes back to direct messages when the list, read on a second try, lacks the saved channel", async () => {
    resumeAt({ ...WHO, guildPolicy: "allowlist", defaultGuildId: "900", defaultChannelId: "777" });
    arrangeUnreadableChannels();
    await mount();
    expect(current.posting).toEqual({ kind: "channel", guildId: "900", channelId: "777" });
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();

    arrangeServers();
    await run(() => current.chooseServer("900"));
    // Now it is known to be gone.
    expect(current.posting).toEqual({ kind: "direct" });
    expect(lastUpdate()[1].draft).toMatchObject({ guildPolicy: "off", defaultChannelId: "dm-333" });
    expect(lastUpdate()[1].draft).not.toHaveProperty("defaultGuildId");
    expect(current.error).toBeUndefined();
  });

  it("says the same sentence beside the saved default when the only server's channels cannot be read", async () => {
    resumeAt();
    arrangeUnreadableChannels();
    await mount();

    // Direct messages are still chosen and saved; saving them does not clear what is wrong with the list.
    expect(current.posting).toEqual({ kind: "direct" });
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(current).toMatchObject({ serverId: "900", channels: null });
    expect(current.error).toBe(DISCORD_UNREACHABLE);

    arrangeServers();
    await run(() => current.chooseServer("900"));
    expect(current.channels).toEqual(CHANNELS);
    expect(current.error).toBeUndefined();
    expect(current.posting).toEqual({ kind: "direct" });
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
  });

  it("goes on with what is already saved, and writes nothing", async () => {
    resumeAt({ ...WHO, guildPolicy: "off", defaultChannelId: "dm-333" });
    arrangeServers();
    await mount();
    expect(current).toMatchObject({ makerId: "333", posting: { kind: "direct" } });
    expect(directQuestions()).toHaveLength(0);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("goes on with a saved channel, listing the channels it is in", async () => {
    resumeAt({ ...WHO, guildPolicy: "allowlist", defaultGuildId: "900", defaultChannelId: "702" });
    arrangeServers({ servers: [SERVER, SIDE_SERVER] });
    await mount();
    expect(current).toMatchObject({
      makerId: "333",
      serverId: "900",
      posting: { kind: "channel", guildId: "900", channelId: "702" },
    });
    expect(current.channels).toEqual(CHANNELS);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("falls back to direct messages when the saved channel is gone", async () => {
    resumeAt({ ...WHO, guildPolicy: "allowlist", defaultGuildId: "900", defaultChannelId: "777" });
    arrangeServers();
    await mount();
    expect(current.posting).toEqual({ kind: "direct" });
    expect(lastUpdate()[1].draft).toMatchObject({ guildPolicy: "off", defaultChannelId: "dm-333" });
  });

  it("says one plain sentence when Discord won't open the direct-message channel, and tries again on a click", async () => {
    resumeAt();
    api.checkDiscordSetup.mockImplementation(async (input: { directMessageWith?: string; guildId?: string }) => {
      if (input.directMessageWith) throw new Error(`Authorization: Bot ${TOKEN}`);
      return checkResult({ servers: [SERVER], ...(input.guildId ? { channels: CHANNELS } : {}) });
    });
    await mount();
    expect(current.error).toBe(DISCORD_UNREACHABLE);
    expect(JSON.stringify(current)).not.toContain("SECRET");
    expect(current.posting).toBeNull();
    expect(current.busy).toBe(false);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();

    arrangeServers();
    await run(() => current.choosePosting({ kind: "direct" }));
    expect(current.error).toBeUndefined();
    expect(current.posting).toEqual({ kind: "direct" });
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
  });

  it("reads the draft again, and says why, when it cannot be saved", async () => {
    resumeAt();
    arrangeServers();
    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("This changed somewhere else."));
    api.fetchChannelSetupDraft.mockResolvedValue(pageDraft({ revision: 6 }));
    await mount();
    expect(current.error).toContain("This changed somewhere else.");
    expect(current.posting).toBeNull();
    expect(current.draft?.revision).toBe(6);

    await run(() => current.choosePosting({ kind: "direct" }));
    expect(lastUpdate()[1].expectedRevision).toBe(6);
    expect(current.error).toBeUndefined();
    expect(current.posting).toEqual({ kind: "direct" });
  });

  it("chooses the defaults as soon as a first check finds the bot already in a server", async () => {
    arrangeCheck();
    arrangeServers();
    await mount();
    await run(() => current.checkToken(TOKEN));
    expect(current.check?.servers).toEqual([SERVER]);
    expect(current).toMatchObject({ makerId: "333", posting: { kind: "direct" }, busy: false });
    // The bot was named at revision 3, and the default came after it.
    expect(lastUpdate()[1].expectedRevision).toBe(3);
    expect(lastUpdate()[1].draft).toMatchObject({ ownerActorIds: ["333"], guildPolicy: "off" });
  });

  it("chooses the defaults when checking again finds a server, and forgets them when that check fails", async () => {
    resumeAt();
    api.checkDiscordSetup.mockResolvedValueOnce(checkResult({ messageContentIntent: false }));
    await mount();
    expect(current.posting).toBeNull();
    arrangeServers();
    await run(() => current.recheck());
    expect(current.posting).toEqual({ kind: "direct" });

    // A failed look forgets the bot and what was chosen for it; the draft still holds the choice.
    api.checkDiscordSetup.mockRejectedValueOnce(new Error("offline"));
    await run(() => current.recheck());
    expect(current).toMatchObject({ check: null, makerId: null, posting: null, serverId: null, channels: null });
    expect(current.waitingForServer).toBe(false);
  });
});
