import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { unfinishedCreateDraft } from "./channel-draft-reuse";

function draft(draftId: string, extra: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId,
    catalogId: "channel.teams",
    lifecycleMode: "create",
    updatedAt: "2026-11-14T10:00:00.000Z",
    ...extra,
  } as ChannelSetupDraft;
}

describe("unfinishedCreateDraft", () => {
  it("picks the newest of two create drafts for the channel", () => {
    const found = unfinishedCreateDraft(
      [
        draft("old"),
        draft("new", { updatedAt: "2026-11-14T12:00:00.000Z" }),
        draft("mid", { updatedAt: "2026-11-14T11:00:00.000Z" }),
      ],
      "channel.teams",
    );
    expect(found?.draftId).toBe("new");
  });

  it("ignores an edit draft and a draft tied to a saved connection", () => {
    expect(
      unfinishedCreateDraft(
        [draft("edit", { lifecycleMode: "edit" }), draft("saved", { connectionId: "conn-1" })],
        "channel.teams",
      ),
    ).toBeUndefined();
  });

  it("returns nothing for another channel or when the drafts are not loaded", () => {
    expect(unfinishedCreateDraft([draft("a")], "channel.slack")).toBeUndefined();
    expect(unfinishedCreateDraft(undefined, "channel.teams")).toBeUndefined();
  });
});
