// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDiscoveryResult, ChannelSetupDraft } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAY_HI_POLL_MS, SETUP_CODE_TTL_MS } from "./setup-code";
import { useTelegramSetup, type TelegramSetupState } from "./use-telegram-setup";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  discoverTelegramSetupTargets: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const TOKEN = "123456:SECRET-TOKEN";
const KEY_FAILED =
  "Telegram didn't accept that key, or GoatCitadel couldn't reach Telegram. Check the key and try again.";
const KEY_STORED = { botToken: { configured: true, custody: "temporary" as const } };

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.telegram",
    lifecycleMode: "create",
    enabled: true,
    draft: {},
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

function discovery(overrides: Partial<ChannelSetupDiscoveryResult> = {}): ChannelSetupDiscoveryResult {
  return {
    items: [],
    warnings: ["Telegram update polling is unavailable while a webhook is active."],
    webhookActive: false,
    botIdentity: { id: "42", username: "MyGoatBot", label: "My Goat Bot" },
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let current: TelegramSetupState;

function Probe({ workspaceId }: { workspaceId: string }) {
  current = useTelegramSetup(workspaceId);
  return null;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(workspaceId = "default") {
  await act(async () => {
    root.render(createElement(Probe, { workspaceId }));
  });
  await settle();
}

async function run(action: () => Promise<void>) {
  await act(async () => {
    await action();
  });
}

/** The calls a successful first check makes: a new draft at version 1, the key stored at 2, the bot named at 3. */
function arrangeCheck(discoveryResult: ChannelSetupDiscoveryResult = discovery()) {
  api.createChannelSetupDraft.mockResolvedValue(draft({ revision: 1, draft: { label: "kept" } }));
  api.submitChannelSetupDraftSecrets.mockResolvedValue(
    draft({ revision: 2, draft: { label: "kept" }, secretState: KEY_STORED }),
  );
  api.discoverTelegramSetupTargets.mockResolvedValue(discoveryResult);
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: KEY_STORED }),
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
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

describe("useTelegramSetup", () => {
  it("starts with nothing: no draft, no bot, not busy", async () => {
    await mount();
    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ catalogId: "channel.telegram" });
    expect(current).toMatchObject({ draft: null, bot: null, webhookActive: false, conflict: false, busy: false });
    expect(current.error).toBeUndefined();
  });

  it("checks a key: one draft, the key stored securely, the bot named", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkKey(TOKEN));

    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.createChannelSetupDraft).toHaveBeenCalledWith({
      catalogId: "channel.telegram",
      lifecycleMode: "create",
    });
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 1,
      values: { botToken: TOKEN },
    });
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledWith({
      source: "draft",
      draftId: "draft-1",
      expectedRevision: 2,
    });
    // The last write merges into the draft it already had, with the version the key write returned.
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 2,
      draft: { label: "kept", botUsername: "MyGoatBot", receiveMode: "poll" },
    });

    expect(current.bot).toEqual({ username: "MyGoatBot", label: "My Goat Bot" });
    expect(current.draft?.revision).toBe(3);
    expect(current.draft?.draft).toMatchObject({ botUsername: "MyGoatBot", receiveMode: "poll" });
    expect(current.webhookActive).toBe(false);
    expect(current.conflict).toBe(false);
    expect(current.busy).toBe(false);
    expect(current.error).toBeUndefined();
  });

  it("keeps the key out of the draft it sends and the state it exposes", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkKey(TOKEN));
    expect(JSON.stringify(api.updateChannelSetupDraft.mock.calls)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(api.createChannelSetupDraft.mock.calls)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify({ ...current, checkKey: undefined })).not.toContain("SECRET-TOKEN");
  });

  it("reuses its draft for the next check, with the version the last write returned", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkKey(TOKEN));
    api.submitChannelSetupDraftSecrets.mockResolvedValue(draft({ revision: 4, secretState: KEY_STORED }));
    await run(() => current.checkKey("654321:OTHER"));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 3,
      values: { botToken: "654321:OTHER" },
    });
  });

  it("does nothing for a blank key", async () => {
    await mount();
    await run(() => current.checkKey("   "));
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
    expect(current.error).toBeUndefined();
  });

  it("shows one plain sentence when the key fails", async () => {
    arrangeCheck();
    api.discoverTelegramSetupTargets.mockRejectedValue(
      new Error(`Telegram target discovery could not complete (HTTP 401) for ${TOKEN}`),
    );
    await mount();
    await run(() => current.checkKey(TOKEN));
    expect(current.error).toBe(KEY_FAILED);
    expect(current.bot).toBeNull();
    expect(current.busy).toBe(false);
    expect(JSON.stringify({ ...current, checkKey: undefined })).not.toContain("SECRET-TOKEN");
    expect(current.error).not.toContain("HTTP 401");
  });

  it("shows the same sentence when the key cannot be stored, and does not go on", async () => {
    arrangeCheck();
    api.submitChannelSetupDraftSecrets.mockRejectedValue(new Error("This changed somewhere else."));
    await mount();
    await run(() => current.checkKey(TOKEN));
    expect(current.error).toBe(KEY_FAILED);
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("clears an old failure when the next check starts", async () => {
    arrangeCheck();
    api.discoverTelegramSetupTargets.mockRejectedValueOnce(new Error("nope"));
    await mount();
    await run(() => current.checkKey(TOKEN));
    expect(current.error).toBe(KEY_FAILED);
    await run(() => current.checkKey(TOKEN));
    expect(current.error).toBeUndefined();
    expect(current.bot?.username).toBe("MyGoatBot");
  });

  it("takes the draft's version again after a failed check, so the next try is not out of date", async () => {
    arrangeCheck();
    api.discoverTelegramSetupTargets.mockRejectedValueOnce(new Error("offline"));
    // The key was stored (version 2) before Telegram could not be reached.
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 2, secretState: KEY_STORED }));
    await mount();
    await run(() => current.checkKey(TOKEN));
    expect(api.fetchChannelSetupDraft).toHaveBeenCalledWith("draft-1");
    expect(current.draft?.revision).toBe(2);

    api.submitChannelSetupDraftSecrets.mockResolvedValue(draft({ revision: 3, secretState: KEY_STORED }));
    await run(() => current.checkKey(TOKEN));
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 2,
      values: { botToken: TOKEN },
    });
    expect(current.bot?.username).toBe("MyGoatBot");
  });

  it("notes a web address that is set and another app that reads the messages", async () => {
    arrangeCheck(discovery({ webhookActive: true }));
    await mount();
    await run(() => current.checkKey(TOKEN));
    expect(current).toMatchObject({ webhookActive: true, conflict: false });
    expect(current.bot?.username).toBe("MyGoatBot");

    arrangeCheck(discovery({ updatesConflict: true }));
    await run(() => current.checkKey(TOKEN));
    expect(current).toMatchObject({ webhookActive: false, conflict: true });
  });

  it("never exposes the warnings discovery sends", async () => {
    arrangeCheck(discovery({ webhookActive: true }));
    await mount();
    await run(() => current.checkKey(TOKEN));
    expect(JSON.stringify({ ...current, checkKey: undefined })).not.toContain("Telegram update polling");
  });

  it("resumes the newest unfinished draft", async () => {
    const older = draft({
      draftId: "older",
      revision: 2,
      updatedAt: "2026-10-26T08:00:00.000Z",
      secretState: KEY_STORED,
    });
    const newest = draft({
      draftId: "newest",
      revision: 6,
      updatedAt: "2026-10-26T11:00:00.000Z",
      secretState: KEY_STORED,
    });
    // A draft for a connection that already exists is a key change, not a new setup, even though it is the newest.
    const forConnection = draft({
      draftId: "for-connection",
      connectionId: "connection-1",
      updatedAt: "2026-10-26T12:00:00.000Z",
    });
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [older, forConnection, newest] });
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
    await mount();

    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ catalogId: "channel.telegram" });
    expect(current.draft?.draftId).toBe("newest");
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledWith({
      source: "draft",
      draftId: "newest",
      expectedRevision: 6,
    });
    expect(current.bot).toEqual({ username: "MyGoatBot", label: "My Goat Bot" });
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("resumes a draft that has no key yet without asking Telegram, and checks into that draft", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [draft({ draftId: "keyless", revision: 3 })] });
    await mount();
    expect(current.draft?.draftId).toBe("keyless");
    expect(current.bot).toBeNull();
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();

    arrangeCheck();
    api.submitChannelSetupDraftSecrets.mockResolvedValue(
      draft({ draftId: "keyless", revision: 4, secretState: KEY_STORED }),
    );
    await run(() => current.checkKey(TOKEN));
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("keyless", {
      expectedRevision: 3,
      values: { botToken: TOKEN },
    });
  });

  it("keeps a resumed draft but names no bot when its key no longer works", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [draft({ revision: 3, secretState: KEY_STORED })] });
    api.discoverTelegramSetupTargets.mockRejectedValue(new Error("HTTP 401"));
    await mount();
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.bot).toBeNull();
    expect(current.error).toBe(KEY_FAILED);
    expect(current.busy).toBe(false);
  });

  it("starts empty, without an error, when the drafts cannot be read", async () => {
    api.fetchChannelSetupDrafts.mockRejectedValue(new Error("offline"));
    await mount();
    expect(current).toMatchObject({ draft: null, bot: null, busy: false });
    expect(current.error).toBeUndefined();
  });

  it("clears a webhook only when asked", async () => {
    arrangeCheck(discovery({ webhookActive: true }));
    await mount();
    await run(() => current.checkKey(TOKEN));
    for (const [input] of api.discoverTelegramSetupTargets.mock.calls) expect(input).not.toHaveProperty("clearWebhook");
    expect(current.webhookActive).toBe(true);

    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ webhookActive: false }));
    await run(() => current.stopWebAddress());
    expect(api.discoverTelegramSetupTargets).toHaveBeenLastCalledWith({
      source: "draft",
      draftId: "draft-1",
      expectedRevision: 3,
      clearWebhook: true,
    });
    expect(current.webhookActive).toBe(false);
    expect(current.conflict).toBe(false);
    expect(current.bot?.username).toBe("MyGoatBot");
    expect(current.error).toBeUndefined();
  });

  it("says so, and keeps the web address note, when stopping the web address fails", async () => {
    arrangeCheck(discovery({ webhookActive: true }));
    await mount();
    await run(() => current.checkKey(TOKEN));
    api.discoverTelegramSetupTargets.mockRejectedValue(new Error("offline"));
    await run(() => current.stopWebAddress());
    expect(current.error).toBe(KEY_FAILED);
    expect(current.webhookActive).toBe(true);
    expect(current.bot?.username).toBe("MyGoatBot");
  });

  it("does not stop a web address when there is no draft", async () => {
    await mount();
    await run(() => current.stopWebAddress());
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
  });

  it("starts over: discards the draft and forgets the bot", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkKey(TOKEN));
    await run(() => current.startOver());
    expect(api.discardChannelSetupDraft).toHaveBeenCalledWith("draft-1", 3);
    expect(current).toMatchObject({ draft: null, bot: null, webhookActive: false, conflict: false, busy: false });
    expect(current.error).toBeUndefined();

    arrangeCheck();
    await run(() => current.checkKey(TOKEN));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(2);
  });

  it("starts over with no draft without calling the gateway", async () => {
    await mount();
    await run(() => current.startOver());
    expect(api.discardChannelSetupDraft).not.toHaveBeenCalled();
    expect(current.draft).toBeNull();
  });

  it("keeps the draft and says why when it cannot be discarded", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkKey(TOKEN));
    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await run(() => current.startOver());
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.bot?.username).toBe("MyGoatBot");
    expect(current.error).toBe("This changed somewhere else.");
  });

  it("is busy while a check runs, and ignores a second check meanwhile", async () => {
    arrangeCheck();
    let finish!: (value: ChannelSetupDiscoveryResult) => void;
    api.discoverTelegramSetupTargets.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await mount();
    let first!: Promise<void>;
    await act(async () => {
      first = current.checkKey(TOKEN);
      await Promise.resolve();
    });
    expect(current.busy).toBe(true);
    await run(() => current.checkKey(TOKEN));
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(discovery());
      await first;
    });
    expect(current.busy).toBe(false);
    expect(current.bot?.username).toBe("MyGoatBot");
  });

  it("drops what it knew when the workspace changes", async () => {
    arrangeCheck();
    await mount("workspace-a");
    await run(() => current.checkKey(TOKEN));
    expect(current.bot).not.toBeNull();
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
    await mount("workspace-b");
    expect(current.draft).toBeNull();
    expect(current.bot).toBeNull();
  });
});

describe("saying hi", () => {
  const ADA = { actorId: "777", chatId: "777", displayName: "Ada Lovelace", username: "ada" };
  const CODE = /^[A-HJ-NP-Za-km-z2-9]{10}$/;
  /** What the draft holds once the key is checked: version 3, with the bot named. */
  const CHECKED_DRAFT = { label: "kept", botUsername: "MyGoatBot", receiveMode: "poll" };

  /** The key is checked (draft version 3), then time is the test's to move. */
  async function afterKeyCheck() {
    arrangeCheck();
    await mount();
    await run(() => current.checkKey(TOKEN));
    api.updateChannelSetupDraft.mockClear();
    api.discoverTelegramSetupTargets.mockClear();
    vi.useFakeTimers();
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("saves a fresh code and listens every 4 seconds", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());

    const code = current.code!;
    expect(code).toMatch(CODE);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 3,
      draft: { ...CHECKED_DRAFT, setupCode: code },
    });
    expect(current.draft?.revision).toBe(4);
    expect(current).toMatchObject({ sender: null, codeExpired: false, manyWaiting: false, busy: false });
    expect(current.error).toBeUndefined();

    // Nothing is asked of Telegram until the first 4 seconds are up, then once every 4.
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
    await advance(SAY_HI_POLL_MS - 1);
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
    await advance(1);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
    expect(api.discoverTelegramSetupTargets).toHaveBeenLastCalledWith({
      source: "draft",
      draftId: "draft-1",
      expectedRevision: 4,
      setupCode: code,
    });
    await advance(SAY_HI_POLL_MS);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(2);
    // Listening is not work the page waits on: its other buttons stay usable.
    expect(current.busy).toBe(false);
  });

  it("stops listening once someone says hi and makes them the allowed sender and owner", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    const code = current.code!;
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ codeSender: ADA }));
    await advance(SAY_HI_POLL_MS);

    // One draft write for the match, on top of the one that saved the code, carrying the version that write returned.
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 4,
      draft: {
        ...CHECKED_DRAFT,
        setupCode: code,
        allowedSenders: ["777"],
        ownerActorIds: ["777"],
        inboundAccessMode: "allowlist",
        targets: [
          {
            id: "telegram:777",
            label: "Ada Lovelace",
            chatId: "777",
            kind: "private",
            source: "recent_update",
            setupCodeMatched: true,
            default: true,
          },
        ],
      },
    });
    expect(current.sender).toEqual(ADA);
    expect(current.draft?.revision).toBe(5);
    expect(current.error).toBeUndefined();

    const asked = api.discoverTelegramSetupTargets.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(asked);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);
    // They said hi in time: the code did not expire.
    expect(current.codeExpired).toBe(false);
  });

  it("stops after 10 minutes and offers a new code", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    const first = current.code!;

    await advance(SETUP_CODE_TTL_MS);
    expect(current.codeExpired).toBe(true);
    expect(current.sender).toBeNull();
    const asked = api.discoverTelegramSetupTargets.mock.calls.length;
    expect(asked).toBeGreaterThan(0);
    await advance(SETUP_CODE_TTL_MS);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(asked);

    await run(() => current.newCode());
    expect(current.codeExpired).toBe(false);
    expect(current.code).toMatch(CODE);
    expect(current.code).not.toBe(first);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 4,
      draft: { ...CHECKED_DRAFT, setupCode: current.code },
    });
    await advance(SAY_HI_POLL_MS);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(asked + 1);
    expect(api.discoverTelegramSetupTargets).toHaveBeenLastCalledWith(
      expect.objectContaining({ setupCode: current.code, expectedRevision: 5 }),
    );
  });

  it("stops when the page closes, and ignores a reply that comes after", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    let reply!: (result: ChannelSetupDiscoveryResult) => void;
    api.discoverTelegramSetupTargets.mockReturnValue(new Promise((resolve) => (reply = resolve)));
    await advance(SAY_HI_POLL_MS);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    // The interval and the expiry are both gone.
    expect(vi.getTimerCount()).toBe(0);
    await advance(SETUP_CODE_TTL_MS);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);

    await act(async () => {
      reply(discovery({ codeSender: ADA }));
    });
    // Only the write that saved the code: nothing was written for someone who said hi to a page that is gone.
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
  });

  it("does not start listening for a code that was saved after the page closed", async () => {
    await afterKeyCheck();
    let save!: (value: ChannelSetupDraft) => void;
    api.updateChannelSetupDraft.mockReturnValueOnce(new Promise((resolve) => (save = resolve)));
    let started!: Promise<void>;
    await act(async () => {
      started = current.newCode();
      await Promise.resolve();
    });
    act(() => root.unmount());
    await act(async () => {
      save(draft({ revision: 4, draft: CHECKED_DRAFT, secretState: KEY_STORED }));
      await started;
    });
    expect(vi.getTimerCount()).toBe(0);
    await advance(SAY_HI_POLL_MS * 3);
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
  });

  it("notes a full page of waiting messages", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    expect(current.manyWaiting).toBe(false);

    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ updatesTruncated: true }));
    await advance(SAY_HI_POLL_MS);
    expect(current.manyWaiting).toBe(true);
    expect(current.sender).toBeNull();

    api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
    await advance(SAY_HI_POLL_MS);
    expect(current.manyWaiting).toBe(false);
  });

  it("does not ask again while the last question is still out", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    api.discoverTelegramSetupTargets.mockReturnValue(new Promise(() => undefined));
    await advance(SAY_HI_POLL_MS * 5);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
  });

  it("keeps listening when a question fails, and says nothing about it", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    api.discoverTelegramSetupTargets.mockRejectedValueOnce(new Error("offline"));
    await advance(SAY_HI_POLL_MS);
    expect(current.error).toBeUndefined();
    await advance(SAY_HI_POLL_MS);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(2);
  });

  it("drops a reply to the old code once a new code has been made", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    let reply!: (result: ChannelSetupDiscoveryResult) => void;
    api.discoverTelegramSetupTargets.mockReturnValue(new Promise((resolve) => (reply = resolve)));
    await advance(SAY_HI_POLL_MS);

    await run(() => current.newCode());
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);
    await act(async () => {
      reply(discovery({ codeSender: ADA }));
    });
    expect(current.sender).toBeNull();
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);
  });

  it("keeps listening, and says why, when who said hi cannot be saved; then saves it on the next try", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    const withCode = { ...CHECKED_DRAFT, setupCode: current.code };
    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("This changed somewhere else."));
    // The first write may have moved the draft on before the reply was lost: it is at version 6 now.
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 6, draft: withCode, secretState: KEY_STORED }));
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ codeSender: ADA }));
    await advance(SAY_HI_POLL_MS);

    expect(current.sender).toBeNull();
    expect(current.error).toBe("This changed somewhere else.");
    // The draft is read again, so the next try carries the version it has now.
    expect(api.fetchChannelSetupDraft).toHaveBeenCalledWith("draft-1");

    await advance(SAY_HI_POLL_MS);
    expect(current.sender).toEqual(ADA);
    expect(current.error).toBeUndefined();
    expect(current.draft?.draft).toMatchObject({ ...withCode, allowedSenders: ["777"], ownerActorIds: ["777"] });
    // The second try carried the version the draft was read at, for the questions and the write alike.
    expect(api.discoverTelegramSetupTargets).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 6 }));
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith(
      "draft-1",
      expect.objectContaining({ expectedRevision: 6 }),
    );
  });

  it("says why a code could not be saved, and does not listen for it", async () => {
    await afterKeyCheck();
    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("This changed somewhere else."));
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 3, draft: CHECKED_DRAFT, secretState: KEY_STORED }));
    await run(() => current.newCode());

    expect(current.error).toBe("This changed somewhere else.");
    expect(current.code).toBeNull();
    expect(current.busy).toBe(false);
    await advance(SAY_HI_POLL_MS * 3);
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();

    // Trying again works, and clears the message.
    await run(() => current.newCode());
    expect(current.error).toBeUndefined();
    expect(current.code).toMatch(CODE);
  });

  it("makes no code before the key has worked", async () => {
    await mount();
    await run(() => current.newCode());
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(current.code).toBeNull();
  });

  it("ignores a second request for a code while the first is being saved", async () => {
    await afterKeyCheck();
    let save!: (value: ChannelSetupDraft) => void;
    api.updateChannelSetupDraft.mockReturnValueOnce(new Promise((resolve) => (save = resolve)));
    let first!: Promise<void>;
    await act(async () => {
      first = current.newCode();
      await Promise.resolve();
    });
    expect(current.busy).toBe(true);
    await run(() => current.newCode());
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    await act(async () => {
      save(draft({ revision: 4, draft: CHECKED_DRAFT, secretState: KEY_STORED }));
      await first;
    });
    expect(current.code).toMatch(CODE);
  });

  it("stops listening and forgets the code when the operator starts over", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    await run(() => current.startOver());
    expect(api.discardChannelSetupDraft).toHaveBeenCalledWith("draft-1", 4);
    expect(current).toMatchObject({ draft: null, bot: null, code: null, sender: null, codeExpired: false });
    expect(vi.getTimerCount()).toBe(0);
    await advance(SAY_HI_POLL_MS * 3);
    expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
  });

  it("keeps listening when Start over fails", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await run(() => current.startOver());
    expect(current.error).toBe("This changed somewhere else.");
    await advance(SAY_HI_POLL_MS);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
  });

  it("stops listening and forgets the code when the key is checked again", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    await run(() => current.checkKey("654321:OTHER"));
    expect(current.code).toBeNull();
    expect(current.sender).toBeNull();
    const asked = api.discoverTelegramSetupTargets.mock.calls.length;
    await advance(SAY_HI_POLL_MS * 3);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(asked);
  });

  it("never sends the key along with the code", async () => {
    await afterKeyCheck();
    await run(() => current.newCode());
    expect(JSON.stringify(api.updateChannelSetupDraft.mock.calls)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(api.discoverTelegramSetupTargets.mock.calls)).not.toContain("SECRET-TOKEN");
  });

  describe("clearing the waiting messages", () => {
    /** Listening for a code, with a full page of waiting messages already seen. */
    async function listeningToAFullPage() {
      await afterKeyCheck();
      await run(() => current.newCode());
      api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ updatesTruncated: true }));
      await advance(SAY_HI_POLL_MS);
      expect(current.manyWaiting).toBe(true);
      api.discoverTelegramSetupTargets.mockClear();
      return current.code!;
    }

    it("asks once, with the current code, to skip what is waiting, and goes on listening", async () => {
      const code = await listeningToAFullPage();
      api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
      await run(() => current.clearWaiting());

      expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
      expect(api.discoverTelegramSetupTargets).toHaveBeenCalledWith({
        source: "draft",
        draftId: "draft-1",
        expectedRevision: 4,
        setupCode: code,
        skipWaiting: true,
      });
      expect(current).toMatchObject({ manyWaiting: false, sender: null, busy: false, code });
      expect(current.error).toBeUndefined();

      // The listener carries on, and never skips on its own.
      await advance(SAY_HI_POLL_MS);
      expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(2);
      expect(api.discoverTelegramSetupTargets.mock.calls[1]![0]).not.toHaveProperty("skipWaiting");
      expect(api.discoverTelegramSetupTargets.mock.calls[1]![0]).toMatchObject({ setupCode: code });
    });

    it("still says many are waiting while the answer is still a full page", async () => {
      await listeningToAFullPage();
      await run(() => current.clearWaiting());
      expect(current.manyWaiting).toBe(true);
      expect(current.busy).toBe(false);
    });

    it("handles a hi found in that same answer exactly as a normal match", async () => {
      const code = await listeningToAFullPage();
      api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ codeSender: ADA }));
      await run(() => current.clearWaiting());

      expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);
      expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
        expectedRevision: 4,
        draft: expect.objectContaining({
          setupCode: code,
          allowedSenders: ["777"],
          ownerActorIds: ["777"],
          inboundAccessMode: "allowlist",
        }),
      });
      expect(current).toMatchObject({ sender: ADA, manyWaiting: false, busy: false });
      expect(current.draft?.revision).toBe(5);
      expect(current.error).toBeUndefined();

      // Listening has stopped, and asking again does nothing.
      await advance(SETUP_CODE_TTL_MS);
      expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
      expect(current.codeExpired).toBe(false);
    });

    it("saves who said hi once when the listener and the click both find them", async () => {
      await listeningToAFullPage();
      let save!: (value: ChannelSetupDraft) => void;
      api.updateChannelSetupDraft.mockReturnValueOnce(new Promise((resolve) => (save = resolve)));
      api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ codeSender: ADA }));
      await advance(SAY_HI_POLL_MS);
      await run(() => current.clearWaiting());
      expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);
      await act(async () => {
        save(draft({ revision: 5, draft: CHECKED_DRAFT, secretState: KEY_STORED }));
      });
      expect(current.sender).toEqual(ADA);
      expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(2);
    });

    it("does nothing without a code to listen for", async () => {
      await afterKeyCheck();
      await run(() => current.clearWaiting());
      expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
      await run(() => current.newCode());
      await advance(SETUP_CODE_TTL_MS);
      expect(current.codeExpired).toBe(true);
      api.discoverTelegramSetupTargets.mockClear();
      await run(() => current.clearWaiting());
      expect(api.discoverTelegramSetupTargets).not.toHaveBeenCalled();
    });

    it("does nothing while something else is in progress, or while it is already asking", async () => {
      await listeningToAFullPage();
      let answer!: (result: ChannelSetupDiscoveryResult) => void;
      api.discoverTelegramSetupTargets.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      let first!: Promise<void>;
      await act(async () => {
        first = current.clearWaiting();
        await Promise.resolve();
      });
      expect(current.busy).toBe(true);
      await run(() => current.clearWaiting());
      expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
      await act(async () => {
        answer(discovery());
        await first;
      });
      expect(current).toMatchObject({ busy: false, manyWaiting: false });
    });

    it("says only the key-check sentence when it fails, and keeps listening", async () => {
      const code = await listeningToAFullPage();
      api.discoverTelegramSetupTargets.mockRejectedValueOnce(new Error(`HTTP 502 for bot${TOKEN}`));
      await run(() => current.clearWaiting());

      expect(current.error).toBe(KEY_FAILED);
      expect(JSON.stringify(current.error)).not.toContain("502");
      expect(current).toMatchObject({ busy: false, code, sender: null });

      api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
      await advance(SAY_HI_POLL_MS);
      expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(2);
      expect(current.manyWaiting).toBe(false);

      // Trying again clears the sentence.
      await run(() => current.clearWaiting());
      expect(current.error).toBeUndefined();
    });

    it("drops the answer once the page has gone", async () => {
      await listeningToAFullPage();
      let answer!: (result: ChannelSetupDiscoveryResult) => void;
      api.discoverTelegramSetupTargets.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      let asked!: Promise<void>;
      await act(async () => {
        asked = current.clearWaiting();
        await Promise.resolve();
      });
      act(() => root.unmount());
      await act(async () => {
        answer(discovery({ codeSender: ADA }));
        await asked;
      });
      expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    });
  });
});
