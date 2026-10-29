// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDraft, SlackSetupCheckResult } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_CODE_TTL_MS } from "./setup-code";
import {
  SLACK_APP_TOKEN_FAILED,
  SLACK_BOT_TOKEN_FAILED,
  SLACK_SAY_HI_POLL_MS,
  SLACK_UNREACHABLE,
  slackDraftWithPosting,
  slackDraftWithSender,
} from "./slack-setup-model";
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
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Lets fake time pass, with every question that falls due asked and answered. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
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
  // Unmounted while the fake timers are still installed, so what the hook scheduled is cleared from them.
  act(() => root.unmount());
  vi.useRealTimers();
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

const ADA = { actorId: "U777", directChannelId: "D777", displayName: "Ada Lovelace" };
const CHANNELS = [
  { id: "C100", name: "general", private: false },
  { id: "G200", name: "secret", private: true },
];

/** A page whose two tokens have checked out, on a draft at version 3, under fake time. */
async function mountReady() {
  vi.useFakeTimers();
  arrangeCheck();
  await mount();
  await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
  api.checkSlackSetup.mockReset();
  api.checkSlackSetup.mockResolvedValue(checkResult());
}

/** Gets a code, lets the first question be asked, and has Ada say hi in answer to it. The draft is then at version 5. */
async function sayHi() {
  await run(() => current.newCode());
  api.checkSlackSetup.mockResolvedValue(checkResult({ codeSender: ADA }));
  await advance(SLACK_SAY_HI_POLL_MS);
}

describe("useSlackSetup, saying hi", () => {
  it("saves a fresh code and asks every 6 seconds", async () => {
    await mountReady();
    expect(current.code).toBeNull();
    await run(() => current.newCode());

    const code = current.code!;
    expect(code).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 3,
      draft: expect.objectContaining({ setupCode: code, receiveMode: "socket", slackTeamId: "T1" }),
    });
    expect(current.draft?.revision).toBe(4);
    expect(current.codeExpired).toBe(false);
    expect(current.sender).toBeNull();

    expect(SLACK_SAY_HI_POLL_MS).toBe(6_000);
    await advance(SLACK_SAY_HI_POLL_MS - 1);
    expect(api.checkSlackSetup).not.toHaveBeenCalled();
    await advance(1);
    // Only the code is asked about: the channel list shares conversations.list's budget and waits for step 4.
    expect(api.checkSlackSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "draft-1",
      expectedRevision: 4,
      setupCode: code,
    });
    await advance(SLACK_SAY_HI_POLL_MS * 2);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(3);
    for (const [input] of api.checkSlackSetup.mock.calls) {
      expect(input).not.toHaveProperty("listChannels");
      expect(input).not.toHaveProperty("checkAppToken");
    }
  });

  it("stops once someone says hi and makes them the allowed sender", async () => {
    await mountReady();
    await run(() => current.newCode());
    const before = current.draft!;
    api.checkSlackSetup.mockResolvedValue(checkResult({ codeSender: ADA }));
    await advance(SLACK_SAY_HI_POLL_MS);

    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: before.revision,
      draft: slackDraftWithSender(before.draft, ADA),
    });
    expect(api.updateChannelSetupDraft.mock.lastCall![1].draft).toMatchObject({
      allowedSenders: ["U777"],
      ownerActorIds: ["U777"],
      inboundAccessMode: "allowlist",
    });
    expect(current.sender).toEqual(ADA);
    // Direct messages with them are where it posts until the operator chooses otherwise.
    expect(current.posting).toEqual({ kind: "direct" });
    expect(current.draft?.revision).toBe(before.revision + 1);
    expect(current.manyConversations).toBe(false);
    expect(current.error).toBeUndefined();

    // Nobody is asked after that, and nothing is left scheduled.
    const asked = api.checkSlackSetup.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(asked);
    expect(vi.getTimerCount()).toBe(0);
    expect(current.codeExpired).toBe(false);
  });

  it("stops after 10 minutes and offers a new code", async () => {
    await mountReady();
    await run(() => current.newCode());
    const first = current.code!;
    await advance(SETUP_CODE_TTL_MS);

    expect(current.codeExpired).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const asked = api.checkSlackSetup.mock.calls.length;
    expect(asked).toBeGreaterThan(50);
    await advance(SLACK_SAY_HI_POLL_MS * 5);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(asked);

    // A new code replaces the old one, is saved, and is listened for.
    await run(() => current.newCode());
    expect(current.code).not.toBe(first);
    expect(current.codeExpired).toBe(false);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith(
      "draft-1",
      expect.objectContaining({ draft: expect.objectContaining({ setupCode: current.code }) }),
    );
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(asked + 1);
    expect(api.checkSlackSetup).toHaveBeenLastCalledWith(expect.objectContaining({ setupCode: current.code }));
  });

  it("stops when the page closes", async () => {
    await mountReady();
    await run(() => current.newCode());
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(1);
  });

  it("drops a hi that arrives after the page has closed", async () => {
    await mountReady();
    await run(() => current.newCode());
    let answer!: (result: SlackSetupCheckResult) => void;
    api.checkSlackSetup.mockReturnValue(new Promise<SlackSetupCheckResult>((resolve) => (answer = resolve)));
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    const writes = api.updateChannelSetupDraft.mock.calls.length;
    await act(async () => {
      answer(checkResult({ codeSender: ADA }));
    });
    await settle();
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(writes);
  });

  it("notes many conversations, and takes the note back once the hi is seen", async () => {
    await mountReady();
    await run(() => current.newCode());
    api.checkSlackSetup.mockResolvedValue(checkResult({ manyConversations: true }));
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(current.manyConversations).toBe(true);
    expect(current.sender).toBeNull();
    expect(current.error).toBeUndefined();

    api.checkSlackSetup.mockResolvedValue(checkResult({ manyConversations: true, codeSender: ADA }));
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(current.sender).toEqual(ADA);
    expect(current.manyConversations).toBe(false);
  });

  it("ignores a question that fails and asks again with the next one", async () => {
    await mountReady();
    await run(() => current.newCode());
    api.checkSlackSetup.mockRejectedValueOnce(new Error(`Bearer ${BOT_TOKEN} rate limited`));
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(current.error).toBeUndefined();
    expect(current.sender).toBeNull();

    api.checkSlackSetup.mockResolvedValue(checkResult({ codeSender: ADA }));
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(current.sender).toEqual(ADA);
    expect(JSON.stringify(current)).not.toContain("SECRET");
  });

  it("tries to save the same hi again, with the draft as it is now, when saving it failed", async () => {
    await mountReady();
    await run(() => current.newCode());
    api.checkSlackSetup.mockResolvedValue(checkResult({ codeSender: ADA }));
    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("This changed somewhere else."));
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 6, draft: { setupCode: "x" } }));
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(current.sender).toBeNull();
    expect(current.error).toBeTruthy();
    expect(current.draft?.revision).toBe(6);

    await advance(SLACK_SAY_HI_POLL_MS);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith(
      "draft-1",
      expect.objectContaining({ expectedRevision: 6 }),
    );
    expect(current.sender).toEqual(ADA);
    expect(current.error).toBeUndefined();
  });

  it("says why when the code cannot be saved, and offers no code", async () => {
    await mountReady();
    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("This changed somewhere else."));
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 3 }));
    await run(() => current.newCode());
    expect(current.code).toBeNull();
    expect(current.error).toBeTruthy();
    expect(current.busy).toBe(false);
    await advance(SLACK_SAY_HI_POLL_MS * 3);
    expect(api.checkSlackSetup).not.toHaveBeenCalled();

    await run(() => current.newCode());
    expect(current.code).not.toBeNull();
    expect(current.error).toBeUndefined();
  });

  it("asks for no code before the tokens work", async () => {
    vi.useFakeTimers();
    await mount();
    await run(() => current.newCode());
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(current.code).toBeNull();
  });

  it("starts the code and the asking again from nothing when the tokens are checked anew", async () => {
    await mountReady();
    await sayHi();
    expect(current.sender).toEqual(ADA);

    api.submitChannelSetupDraftSecrets.mockResolvedValue(
      draft({ revision: 6, draft: current.draft!.draft, secretState: TOKENS_STORED }),
    );
    await run(() => current.checkTokens(BOT_TOKEN, APP_TOKEN));
    expect(current.sender).toBeNull();
    expect(current.posting).toBeNull();
    expect(current.channels).toBeNull();
    expect(current.code).toBeNull();
  });

  it("stops and forgets everything when the operator starts over", async () => {
    await mountReady();
    await run(() => current.newCode());
    await advance(SLACK_SAY_HI_POLL_MS);
    await run(() => current.startOver());

    expect(current).toMatchObject({ draft: null, workspace: null, sender: null, code: null, posting: null });
    expect(vi.getTimerCount()).toBe(0);
    const asked = api.checkSlackSetup.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(asked);
  });

  it("asks nothing while the setup is being discarded", async () => {
    await mountReady();
    await run(() => current.newCode());
    let finish!: (result: unknown) => void;
    api.discardChannelSetupDraft.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    let discarding: Promise<void> = Promise.resolve();
    await act(async () => {
      discarding = current.startOver();
      await Promise.resolve();
    });
    expect(current.busy).toBe(true);
    await advance(SLACK_SAY_HI_POLL_MS * 2);
    expect(api.checkSlackSetup).not.toHaveBeenCalled();

    finish({ draftId: "draft-1", deleted: true });
    await run(() => discarding);
    expect(current.draft).toBeNull();
  });

  it("keeps listening when starting over could not discard the setup", async () => {
    await mountReady();
    await run(() => current.newCode());
    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await run(() => current.startOver());
    expect(current.error).toBeTruthy();
    expect(current.code).not.toBeNull();
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(1);
  });
});

describe("useSlackSetup, where it posts", () => {
  it("lists channels on Refresh channels and saves a chosen one", async () => {
    await mountReady();
    await sayHi();
    expect(current.channels).toBeNull();
    const asked = api.checkSlackSetup.mock.calls.length;

    api.checkSlackSetup.mockResolvedValue(checkResult({ channels: CHANNELS }));
    await run(() => current.refreshChannels());
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(asked + 1);
    expect(api.checkSlackSetup).toHaveBeenLastCalledWith({
      draftId: "draft-1",
      expectedRevision: 5,
      listChannels: true,
    });
    expect(current.channels).toEqual(CHANNELS);
    expect(current.busy).toBe(false);
    expect(current.error).toBeUndefined();

    const before = current.draft!;
    await run(() => current.choosePosting({ kind: "channel", channelId: "G200" }));
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: before.revision,
      draft: slackDraftWithPosting(before.draft, { kind: "channel", channelId: "G200" }, CHANNELS),
    });
    expect(current.posting).toEqual({ kind: "channel", channelId: "G200" });
    expect(current.draft?.revision).toBe(before.revision + 1);
    expect(current.error).toBeUndefined();
    // Choosing asks nothing of Slack: the list was read once.
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(asked + 1);

    await run(() => current.choosePosting({ kind: "direct" }));
    expect(current.posting).toEqual({ kind: "direct" });
    expect(current.draft?.draft.targets).toEqual([expect.objectContaining({ channel: "D777", default: true })]);
  });

  it("chooses no channel the list does not have", async () => {
    await mountReady();
    await sayHi();
    api.checkSlackSetup.mockResolvedValue(checkResult({ channels: CHANNELS }));
    await run(() => current.refreshChannels());
    const writes = api.updateChannelSetupDraft.mock.calls.length;
    await run(() => current.choosePosting({ kind: "channel", channelId: "C404" }));
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(writes);
    expect(current.posting).toEqual({ kind: "direct" });
  });

  it("chooses nothing before anyone has said hi", async () => {
    await mountReady();
    const writes = api.updateChannelSetupDraft.mock.calls.length;
    await run(() => current.choosePosting({ kind: "direct" }));
    await run(() => current.refreshChannels());
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(writes);
    expect(api.checkSlackSetup).not.toHaveBeenCalled();
  });

  it("says one plain sentence when the channels cannot be listed, and keeps what was chosen", async () => {
    await mountReady();
    await sayHi();
    api.checkSlackSetup.mockRejectedValue(new Error(`HTTP 429 Authorization: Bearer ${BOT_TOKEN}`));
    await run(() => current.refreshChannels());
    expect(current.error).toBe(SLACK_UNREACHABLE);
    expect(current.channels).toBeNull();
    expect(current.posting).toEqual({ kind: "direct" });
    expect(current.busy).toBe(false);
    expect(JSON.stringify(current)).not.toContain("HTTP 429");
    expect(JSON.stringify(current)).not.toContain("SECRET");

    // A reply with no list is no list.
    api.checkSlackSetup.mockResolvedValue(checkResult());
    await run(() => current.refreshChannels());
    expect(current.error).toBe(SLACK_UNREACHABLE);
    expect(current.channels).toBeNull();

    api.checkSlackSetup.mockResolvedValue(checkResult({ channels: CHANNELS }));
    await run(() => current.refreshChannels());
    expect(current.error).toBeUndefined();
    expect(current.channels).toEqual(CHANNELS);
  });

  it("says why when the choice cannot be saved, and leaves the old choice standing", async () => {
    await mountReady();
    await sayHi();
    api.checkSlackSetup.mockResolvedValue(checkResult({ channels: CHANNELS }));
    await run(() => current.refreshChannels());
    api.updateChannelSetupDraft.mockRejectedValueOnce(new Error("This changed somewhere else."));
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 9, draft: current.draft!.draft }));
    await run(() => current.choosePosting({ kind: "channel", channelId: "C100" }));
    expect(current.error).toBeTruthy();
    expect(current.posting).toEqual({ kind: "direct" });
    expect(current.draft?.revision).toBe(9);
    expect(current.busy).toBe(false);
  });

  it("falls back to direct messages when a saved channel is no longer among the bot's channels", async () => {
    vi.useFakeTimers();
    const saved = slackDraftWithPosting(
      slackDraftWithSender({ setupPage: "messaging", receiveMode: "socket" }, ADA),
      { kind: "channel", channelId: "C100" },
      CHANNELS,
    );
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft({ draft: saved })] });
    api.checkSlackSetup.mockResolvedValue(checkResult());
    api.updateChannelSetupDraft.mockImplementation(
      async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
        draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: TOKENS_STORED }),
    );
    await mount();
    expect(current.posting).toEqual({ kind: "channel", channelId: "C100" });

    // The bot was taken out of #general: the list read now doesn't have it.
    api.checkSlackSetup.mockResolvedValue(checkResult({ channels: [CHANNELS[1]!] }));
    await run(() => current.refreshChannels());
    expect(current.channels).toEqual([CHANNELS[1]]);
    expect(current.posting).toEqual({ kind: "direct" });
    expect(api.updateChannelSetupDraft.mock.lastCall![1].draft.targets).toEqual([
      expect.objectContaining({ channel: "D777", default: true }),
    ]);
  });
});

describe("useSlackSetup, coming back to a setup", () => {
  it("goes on from who said hi and where it posts, without a new code or any asking", async () => {
    vi.useFakeTimers();
    const saved = slackDraftWithPosting(
      slackDraftWithSender({ setupPage: "messaging", receiveMode: "socket" }, ADA),
      { kind: "channel", channelId: "C100" },
      CHANNELS,
    );
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft({ draft: saved })] });
    api.checkSlackSetup.mockResolvedValue(checkResult());
    await mount();

    expect(current.sender).toEqual(ADA);
    expect(current.posting).toEqual({ kind: "channel", channelId: "C100" });
    expect(current.code).toBeNull();
    expect(current.channels).toBeNull();
    expect(api.checkSlackSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "draft-1",
      expectedRevision: 4,
      checkAppToken: true,
    });
    await advance(SLACK_SAY_HI_POLL_MS * 3);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(1);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("knows no sender when the tokens no longer work, so the fields come back first", async () => {
    vi.useFakeTimers();
    const saved = slackDraftWithSender({ setupPage: "messaging" }, ADA);
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [pageDraft({ draft: saved })] });
    api.checkSlackSetup.mockResolvedValue(checkResult({ appToken: "rejected" }));
    await mount();
    expect(current.workspace).toBeNull();
    expect(current.sender).toBeNull();
    expect(current.posting).toBeNull();
    expect(current.error).toBe(SLACK_APP_TOKEN_FAILED);
  });
});
