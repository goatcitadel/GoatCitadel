// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDiscoveryResult, ChannelSetupDraft } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
