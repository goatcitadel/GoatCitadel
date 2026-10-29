// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDraft, DiscordSetupCheckResult } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISCORD_TOKEN_FAILED } from "./discord-setup-model";
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("keeps the last check that worked when checking again fails", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkDiscordSetup.mockResolvedValueOnce(checkResult({ messageContentIntent: false }));
    await mount();

    api.checkDiscordSetup.mockRejectedValueOnce(new Error(`Bot ${TOKEN}`));
    await run(() => current.recheck());
    expect(current.error).toBe(DISCORD_TOKEN_FAILED);
    expect(current.check?.bot.name).toBe("Goat Bot");
    expect(current.busy).toBe(false);
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
