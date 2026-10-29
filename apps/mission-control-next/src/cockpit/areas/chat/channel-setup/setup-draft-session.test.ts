import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_SETUP_PAGE, chatSetupToResume, isChatSetupDraft, latestDraft } from "./setup-draft-session";

const api = vi.hoisted(() => ({ fetchChannelSetupDraft: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.discord",
    lifecycleMode: "create",
    enabled: true,
    draft: { setupPage: CHAT_SETUP_PAGE },
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

beforeEach(() => {
  api.fetchChannelSetupDraft.mockReset();
});

describe("isChatSetupDraft", () => {
  it("is true for a draft the Chat page made, and false for any other", () => {
    expect(CHAT_SETUP_PAGE).toBe("messaging");
    expect(isChatSetupDraft(draft())).toBe(true);
    expect(isChatSetupDraft(draft({ draft: {} }))).toBe(false);
    expect(isChatSetupDraft(draft({ draft: { setupPage: "settings" } }))).toBe(false);
    expect(isChatSetupDraft(draft({ draft: { setupPage: true } }))).toBe(false);
  });

  it("does not fail on a draft that has no values", () => {
    expect(isChatSetupDraft({ draft: undefined } as unknown as ChannelSetupDraft)).toBe(false);
    expect(isChatSetupDraft({ draft: null } as unknown as ChannelSetupDraft)).toBe(false);
  });
});

describe("chatSetupToResume", () => {
  const CATALOG = "channel.discord";

  it("skips a draft the Chat page did not make", () => {
    const drafts = [draft({ draftId: "settings", draft: {} }), draft({ draftId: "other", draft: { setupPage: "x" } })];
    expect(chatSetupToResume(drafts, CATALOG)).toBeNull();
  });

  it("skips a draft that belongs to a saved connection", () => {
    expect(chatSetupToResume([draft({ connectionId: "conn-1" })], CATALOG)).toBeNull();
  });

  it("skips another channel's draft", () => {
    expect(chatSetupToResume([draft({ catalogId: "channel.slack" })], CATALOG)).toBeNull();
  });

  it("skips a draft that is not a new setup", () => {
    expect(chatSetupToResume([draft({ lifecycleMode: "edit" })], CATALOG)).toBeNull();
  });

  it("finds nothing in an empty list", () => {
    expect(chatSetupToResume([], CATALOG)).toBeNull();
    expect(chatSetupToResume([], CATALOG, "draft-1")).toBeNull();
  });

  it("takes the newest unfinished setup when none is named", () => {
    const drafts = [
      draft({ draftId: "old", updatedAt: "2026-10-26T09:00:00.000Z" }),
      draft({ draftId: "new", updatedAt: "2026-10-28T09:00:00.000Z" }),
      draft({ draftId: "mid", updatedAt: "2026-10-27T09:00:00.000Z" }),
      // Newer than all of them, but not one this page can go on with.
      draft({ draftId: "settings", draft: {}, updatedAt: "2026-10-29T09:00:00.000Z" }),
    ];
    expect(chatSetupToResume(drafts, CATALOG)?.draftId).toBe("new");
  });

  it("takes the named setup when it qualifies, even when a newer one exists", () => {
    const drafts = [
      draft({ draftId: "named", updatedAt: "2026-10-26T09:00:00.000Z" }),
      draft({ draftId: "newer", updatedAt: "2026-10-28T09:00:00.000Z" }),
    ];
    expect(chatSetupToResume(drafts, CATALOG, "named")?.draftId).toBe("named");
  });

  it("goes on with nothing when the named setup is gone or does not qualify, never with another one", () => {
    const drafts = [
      draft({ draftId: "newer" }),
      draft({ draftId: "settings", draft: {} }),
      draft({ draftId: "saved", connectionId: "conn-1" }),
    ];
    expect(chatSetupToResume(drafts, CATALOG, "gone")).toBeNull();
    expect(chatSetupToResume(drafts, CATALOG, "settings")).toBeNull();
    expect(chatSetupToResume(drafts, CATALOG, "saved")).toBeNull();
  });

  it("does not change the list it is given", () => {
    const drafts = [draft({ draftId: "a" }), draft({ draftId: "b", updatedAt: "2026-10-29T09:00:00.000Z" })];
    const before = drafts.map((entry) => entry.draftId);
    chatSetupToResume(drafts, CATALOG);
    expect(drafts.map((entry) => entry.draftId)).toEqual(before);
  });
});

describe("latestDraft", () => {
  it("returns the draft as the gateway has it now", async () => {
    const fresh = draft({ revision: 4 });
    api.fetchChannelSetupDraft.mockResolvedValue(fresh);
    await expect(latestDraft("draft-1")).resolves.toBe(fresh);
    expect(api.fetchChannelSetupDraft).toHaveBeenCalledWith("draft-1");
  });

  it("returns null when it cannot be read", async () => {
    api.fetchChannelSetupDraft.mockRejectedValue(new Error("offline"));
    await expect(latestDraft("draft-1")).resolves.toBeNull();
  });
});
