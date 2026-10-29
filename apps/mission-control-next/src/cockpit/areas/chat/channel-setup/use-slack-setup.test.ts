// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDraft, SlackSetupCheckResult } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_APP_TOKEN_FAILED, SLACK_BOT_TOKEN_FAILED } from "./slack-setup-model";
import { SLACK_CATALOG_ID, useSlackSetup, type SlackSetupState } from "./use-slack-setup";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkSlackSetup: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const BOT_TOKEN = "xoxb-SECRET-BOT-TOKEN";
const APP_TOKEN = "xapp-1-SECRET-APP-TOKEN";
const TOKENS_STORED = {
  botToken: { configured: true, custody: "temporary" as const },
  appToken: { configured: true, custody: "temporary" as const },
};

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.slack",
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

/** A draft made on the Slack page in Chat, with both tokens already stored. */
function pageDraft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return draft({
    revision: 4,
    draft: { setupPage: "messaging", receiveMode: "socket", slackTeamId: "T1" },
    secretState: TOKENS_STORED,
    ...overrides,
  });
}

function checkResult(overrides: Partial<SlackSetupCheckResult> = {}): SlackSetupCheckResult {
  return {
    workspace: { id: "T1", name: "Goat Team" },
    bot: { userId: "U9", name: "goatcitadel" },
    appToken: "ok",
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let current: SlackSetupState;

function Probe({ workspaceId, resumeDraftId }: { workspaceId: string; resumeDraftId?: string }) {
  current = useSlackSetup(workspaceId, resumeDraftId);
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

/** The calls a successful first check makes: a new draft at version 1, both tokens stored at 2, the workspace named at 3. */
function arrangeCheck(result: SlackSetupCheckResult = checkResult()) {
  api.createChannelSetupDraft.mockResolvedValue(draft({ revision: 1, draft: { label: "kept" } }));
  api.submitChannelSetupDraftSecrets.mockResolvedValue(
    draft({ revision: 2, draft: { label: "kept" }, secretState: TOKENS_STORED }),
  );
  api.checkSlackSetup.mockResolvedValue(result);
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: TOKENS_STORED }),
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

describe("useSlackSetup", () => {
  it("starts with nothing: no draft, no workspace, not busy", async () => {
    await mount();
    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ catalogId: SLACK_CATALOG_ID });
    expect(SLACK_CATALOG_ID).toBe("channel.slack");
    expect(current).toMatchObject({ draft: null, workspace: null, bot: null, busy: false });
    expect(current.error).toBeUndefined();
  });

  it("stores both tokens in one call and names the bot", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));

    expect(api.createChannelSetupDraft).toHaveBeenCalledExactlyOnceWith({
      catalogId: "channel.slack",
      lifecycleMode: "create",
    });
    // One write holds both secrets, so one version moves on.
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 1,
      values: { botToken: BOT_TOKEN, appToken: APP_TOKEN },
    });
    expect(api.checkSlackSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "draft-1",
      expectedRevision: 2,
      checkAppToken: true,
    });
    // The last write merges into the draft's own values, with the version the secret write returned.
    expect(api.updateChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 2,
      draft: {
        label: "kept",
        setupPage: "messaging",
        receiveMode: "socket",
        slackTeamId: "T1",
        slackTeamName: "Goat Team",
        slackBotUserId: "U9",
      },
    });
    expect(current.draft?.revision).toBe(3);
    expect(current.draft?.draft).toMatchObject({ setupPage: "messaging", slackTeamName: "Goat Team" });
    expect(current.workspace).toEqual({ id: "T1", name: "Goat Team" });
    expect(current.bot).toEqual({ userId: "U9", name: "goatcitadel" });
    expect(current.busy).toBe(false);
    expect(current.error).toBeUndefined();
  });

  it("never keeps either token in what it returns", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkTokens(`  ${BOT_TOKEN}  `, `\n${APP_TOKEN}\t`));
    // Trimmed on the way in, and gone from everything the page can read.
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 1,
      values: { botToken: BOT_TOKEN, appToken: APP_TOKEN },
    });
    expect(JSON.stringify(current)).not.toContain("SECRET");
  });

  it("does nothing for a missing token, or while another check runs", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkTokens("   ", APP_TOKEN));
    await run(() => current.checkTokens(BOT_TOKEN, ""));
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();

    let finish: (value: ChannelSetupDraft) => void = () => undefined;
    api.createChannelSetupDraft.mockReturnValue(new Promise<ChannelSetupDraft>((resolve) => (finish = resolve)));
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = current.checkTokens(BOT_TOKEN, APP_TOKEN);
      await Promise.resolve();
    });
    expect(current.busy).toBe(true);
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    finish(draft({ revision: 1 }));
    await run(() => first);
  });

  it("stops at a rejected app-level token", async () => {
    arrangeCheck(checkResult({ appToken: "rejected" }));
    await mount();
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));

    expect(current.error).toBe(SLACK_APP_TOKEN_FAILED);
    // The bot is not announced and nothing more is saved: no draft update follows.
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(current.workspace).toBeNull();
    expect(current.bot).toBeNull();
    expect(current.busy).toBe(false);
    // Both tokens are stored, which moved the draft's version on; the next try carries it.
    expect(current.draft?.revision).toBe(2);
    expect(JSON.stringify(current)).not.toContain("SECRET");
  });

  it("treats an app-level token Slack has none of like a rejected one", async () => {
    arrangeCheck(checkResult({ appToken: "missing" }));
    await mount();
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(current.error).toBe(SLACK_APP_TOKEN_FAILED);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();

    // A check that comes back with no answer about the app-level token is not a pass either.
    api.checkSlackSetup.mockResolvedValue(checkResult({ appToken: undefined }));
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(current.error).toBe(SLACK_APP_TOKEN_FAILED);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("sends both tokens again on the same draft once the app-level token is fixed", async () => {
    arrangeCheck(checkResult({ appToken: "rejected" }));
    await mount();
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(current.error).toBe(SLACK_APP_TOKEN_FAILED);

    api.submitChannelSetupDraftSecrets.mockResolvedValue(
      draft({ revision: 3, draft: { label: "kept" }, secretState: TOKENS_STORED }),
    );
    api.checkSlackSetup.mockResolvedValue(checkResult());
    await run(() => current.checkTokens(BOT_TOKEN, "xapp-1-SECRET-FIXED"));

    // No second draft; the write carries the version the first try left; both secrets go again.
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 2,
      values: { botToken: BOT_TOKEN, appToken: "xapp-1-SECRET-FIXED" },
    });
    expect(api.updateChannelSetupDraft).toHaveBeenCalledExactlyOnceWith(
      "draft-1",
      expect.objectContaining({
        expectedRevision: 3,
      }),
    );
    expect(current.error).toBeUndefined();
    expect(current.workspace).toEqual({ id: "T1", name: "Goat Team" });
  });

  it("shows one plain sentence when Slack refuses the bot token, never what the gateway said", async () => {
    arrangeCheck();
    api.checkSlackSetup.mockRejectedValue(new Error(`HTTP 401 Authorization: Bearer ${BOT_TOKEN}`));
    await mount();
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));

    expect(current.error).toBe(SLACK_BOT_TOKEN_FAILED);
    expect(JSON.stringify(current)).not.toContain("HTTP 401");
    expect(JSON.stringify(current)).not.toContain("SECRET");
    expect(current.workspace).toBeNull();
    expect(current.busy).toBe(false);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    // The tokens were stored before the failure, which moved the draft on: the next try carries the latest version.
    expect(current.draft?.draftId).toBe("draft-1");
    expect(api.fetchChannelSetupDraft).toHaveBeenCalledWith("draft-1");
  });

  it("says the same sentence when the tokens cannot be stored or the draft cannot be saved", async () => {
    arrangeCheck();
    api.submitChannelSetupDraftSecrets.mockRejectedValueOnce(new Error("Authorization: Bearer leaked"));
    await mount();
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(current.error).toBe(SLACK_BOT_TOKEN_FAILED);
    expect(api.checkSlackSetup).not.toHaveBeenCalled();

    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("conflict"));
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(current.error).toBe(SLACK_BOT_TOKEN_FAILED);
    expect(current.workspace).toBeNull();
  });

  it("goes on with the same draft after a failure, and clears the sentence when it works", async () => {
    arrangeCheck();
    api.checkSlackSetup.mockRejectedValueOnce(new Error("offline"));
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 2, secretState: TOKENS_STORED }));
    await mount();
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(current.error).toBe(SLACK_BOT_TOKEN_FAILED);
    expect(current.draft?.revision).toBe(2);

    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 2,
      values: { botToken: BOT_TOKEN, appToken: APP_TOKEN },
    });
    expect(current.error).toBeUndefined();
    expect(current.workspace).toEqual({ id: "T1", name: "Goat Team" });
  });

  it("resumes only a setup made on this page", async () => {
    const elsewhere = draft({ draftId: "settings-1", updatedAt: "2026-10-28T11:00:00.000Z", draft: {} });
    const here = pageDraft({ draftId: "page-1", updatedAt: "2026-10-28T10:00:00.000Z" });
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [elsewhere, here] });
    api.checkSlackSetup.mockResolvedValue(checkResult());
    await mount();
    // The newer one belongs to Settings, so the page does not take it over.
    expect(current.draft?.draftId).toBe("page-1");

    // A draft the address names that was not made here is not gone on with either: the page starts fresh.
    api.checkSlackSetup.mockClear();
    await mount("default", "settings-1");
    expect(current.draft).toBeNull();
    expect(current.workspace).toBeNull();
    expect(api.checkSlackSetup).not.toHaveBeenCalled();
  });

  it("resumes the draft the address names, and checks both saved tokens again without writing", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [pageDraft({ draftId: "page-1" }), pageDraft({ draftId: "page-2", revision: 7 })],
    });
    api.checkSlackSetup.mockResolvedValue(checkResult());
    await mount("default", "page-2");
    expect(current.draft?.draftId).toBe("page-2");
    expect(api.checkSlackSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "page-2",
      expectedRevision: 7,
      checkAppToken: true,
    });
    // Resuming reads; it neither stores a token nor writes the draft.
    expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(current.workspace).toEqual({ id: "T1", name: "Goat Team" });
    expect(current.bot).toEqual({ userId: "U9", name: "goatcitadel" });
    expect(current.busy).toBe(false);
  });

  it("leaves a resumed setup unchecked unless both tokens are stored", async () => {
    const stored: ChannelSetupDraft["secretState"][] = [
      {},
      { botToken: TOKENS_STORED.botToken },
      { appToken: TOKENS_STORED.appToken },
    ];
    for (const secretState of stored) {
      api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft({ secretState })] });
      await mount();
      expect(current.draft?.draftId).toBe("draft-1");
      expect(current.workspace).toBeNull();
      expect(current.error).toBeUndefined();
      expect(current.busy).toBe(false);
    }
    expect(api.checkSlackSetup).not.toHaveBeenCalled();
  });

  it("puts the fields back, with the app-level sentence, when a saved app-level token is no longer accepted", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkSlackSetup.mockResolvedValue(checkResult({ appToken: "rejected" }));
    await mount();
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.workspace).toBeNull();
    expect(current.error).toBe(SLACK_APP_TOKEN_FAILED);
    expect(current.busy).toBe(false);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("says the plain sentence when the saved bot token no longer works", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft()] });
    api.checkSlackSetup.mockRejectedValue(new Error(`Bearer ${BOT_TOKEN}`));
    await mount();
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.workspace).toBeNull();
    expect(current.error).toBe(SLACK_BOT_TOKEN_FAILED);
    expect(JSON.stringify(current)).not.toContain("SECRET");
    expect(current.busy).toBe(false);
  });

  it("starts fresh when the drafts cannot be read", async () => {
    api.fetchChannelSetupDrafts.mockRejectedValue(new Error("offline"));
    await mount();
    expect(current).toMatchObject({ draft: null, workspace: null, bot: null, busy: false });
    expect(current.error).toBeUndefined();
  });

  it("starts over: discards the draft and forgets the workspace", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    await run(() => current.startOver());
    expect(api.discardChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", 3);
    expect(current).toMatchObject({ draft: null, workspace: null, bot: null, busy: false });
    expect(current.error).toBeUndefined();

    // The next check begins a new draft.
    api.createChannelSetupDraft.mockResolvedValue(draft({ draftId: "draft-2" }));
    api.submitChannelSetupDraftSecrets.mockResolvedValue(draft({ draftId: "draft-2", revision: 2 }));
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(2);
  });

  it("keeps the setup when it cannot be discarded", async () => {
    arrangeCheck();
    await mount();
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await run(() => current.startOver());
    expect(current.error).toBeTruthy();
    expect(current.draft?.draftId).toBe("draft-1");
    expect(current.workspace).not.toBeNull();
    expect(current.busy).toBe(false);
  });

  it("starts over with nothing to discard by only clearing", async () => {
    await mount();
    await run(() => current.startOver());
    expect(api.discardChannelSetupDraft).not.toHaveBeenCalled();
    expect(current).toMatchObject({ draft: null, workspace: null, busy: false });
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
    expect(api.checkSlackSetup).not.toHaveBeenCalled();
  });
});
