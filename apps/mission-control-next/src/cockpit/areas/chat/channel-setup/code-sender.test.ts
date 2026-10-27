import type { ChannelSetupCodeSender } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { draftWithSender, senderName } from "./code-sender";

const ADA: ChannelSetupCodeSender = { actorId: "777", chatId: "777", displayName: "Ada Lovelace", username: "ada" };

describe("senderName", () => {
  it("prefers the name they gave Telegram", () => {
    expect(senderName(ADA)).toBe("Ada Lovelace");
  });

  it("falls back to their @username", () => {
    expect(senderName({ actorId: "1", chatId: "1", username: "ada" })).toBe("@ada");
    expect(senderName({ actorId: "1", chatId: "1", displayName: "  ", username: "@ada" })).toBe("@ada");
  });

  it("says Someone when Telegram gave neither", () => {
    expect(senderName({ actorId: "1", chatId: "1" })).toBe("Someone");
  });
});

describe("draftWithSender", () => {
  it("makes them the only allowed sender and the owner, with their own chat as the default", () => {
    const next = draftWithSender({ botUsername: "MyGoatBot", receiveMode: "poll", setupCode: "abc" }, ADA);
    expect(next).toEqual({
      botUsername: "MyGoatBot",
      receiveMode: "poll",
      setupCode: "abc",
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
    });
  });

  it("replaces anyone allowed before, and does not change the draft it was given", () => {
    const before = { allowedSenders: ["1", "2"], ownerActorIds: ["1"], inboundAccessMode: "open_legacy" };
    const next = draftWithSender(before, ADA);
    expect(next.allowedSenders).toEqual(["777"]);
    expect(next.ownerActorIds).toEqual(["777"]);
    expect(next.inboundAccessMode).toBe("allowlist");
    expect(before).toEqual({ allowedSenders: ["1", "2"], ownerActorIds: ["1"], inboundAccessMode: "open_legacy" });
  });

  it("keeps the chats already there, but only their chat is the default", () => {
    const next = draftWithSender(
      {
        targets: [
          { id: "group", label: "Team", chatId: "-100", kind: "group", default: true },
          { id: "other", label: "Other", chatId: "-200", kind: "group" },
        ],
      },
      ADA,
    );
    const targets = next.targets as { chatId: string; default: boolean }[];
    expect(targets.map((target) => target.chatId)).toEqual(["-100", "-200", "777"]);
    expect(targets.map((target) => target.default)).toEqual([false, false, true]);
  });

  it("does not add their chat twice, and makes the one already there the default", () => {
    const next = draftWithSender(
      { targets: [{ id: "mine", label: "Me", chatId: "777", kind: "private", default: false }] },
      ADA,
    );
    expect(next.targets).toEqual([{ id: "mine", label: "Me", chatId: "777", kind: "private", default: true }]);
  });

  it("reads chats that arrived as text", () => {
    const next = draftWithSender(
      { targets: JSON.stringify([{ id: "group", label: "Team", chatId: "-100", default: true }]) },
      ADA,
    );
    expect((next.targets as { chatId: string }[]).map((target) => target.chatId)).toEqual(["-100", "777"]);
  });

  it("labels their chat with their @username, or Someone, when they gave no name", () => {
    const named = draftWithSender({}, { actorId: "5", chatId: "5", username: "grace" });
    expect((named.targets as { label: string }[])[0]!.label).toBe("@grace");
    const unnamed = draftWithSender({}, { actorId: "5", chatId: "5" });
    expect((unnamed.targets as { label: string }[])[0]!.label).toBe("Someone");
  });
});
