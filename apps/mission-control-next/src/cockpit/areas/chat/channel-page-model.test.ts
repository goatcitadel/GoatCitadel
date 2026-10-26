import type { DiscordPairingRecord, IntegrationConnection, TelegramChannelPairingList } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { approvedSenders, botIdentity, ownerActorIdsWith, ownerCandidates, postingTargets } from "./channel-page-model";

function connection(key: string, config: Record<string, unknown> = {}, label = "Telegram"): IntegrationConnection {
  return {
    connectionId: "conn-1",
    revision: "a".repeat(64),
    catalogId: `channel.${key}`,
    kind: "channel",
    key,
    label,
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-10-25T09:00:00.000Z",
    updatedAt: "2026-10-25T09:00:00.000Z",
  };
}

describe("postingTargets", () => {
  it("lists posting targets by name", () => {
    const telegram = connection("telegram", {
      targets: [
        { label: "Ops", chatId: "-1001234567890", default: true },
        { label: "Family", chatId: "55" },
      ],
    });
    expect(postingTargets(telegram).map((target) => target.label)).toEqual(["Ops", "Family"]);

    const slack = connection("slack", { targets: [{ label: "General", channel: "#general" }] }, "Slack");
    expect(postingTargets(slack).map((target) => target.label)).toEqual(["General"]);
  });

  it("marks the default target", () => {
    const telegram = connection("telegram", {
      targets: [
        { label: "Ops", chatId: "-1001234567890" },
        { label: "Family", chatId: "55", default: true },
      ],
    });
    expect(postingTargets(telegram)).toEqual([
      { label: "Ops", isDefault: false },
      { label: "Family", isDefault: true },
    ]);
  });

  it("treats the first target as the default when none is marked, like the Gateway does", () => {
    const slack = connection("slack", {
      targets: [
        { label: "General", channel: "C0123ABCD" },
        { label: "Random", channel: "C0456EFGH" },
      ],
    });
    expect(postingTargets(slack)).toEqual([
      { label: "General", isDefault: true },
      { label: "Random", isDefault: false },
    ]);
  });

  it("skips a target that does not say where to post, as the Gateway does", () => {
    const telegram = connection("telegram", { targets: [{ label: "Nowhere" }, { label: "Ops", chatId: "1" }] });
    expect(postingTargets(telegram)).toEqual([{ label: "Ops", isDefault: true }]);
  });

  it("reads targets stored as JSON text", () => {
    const telegram = connection("telegram", {
      targets: JSON.stringify([{ label: "Ops", chatId: "1", default: true }]),
    });
    expect(postingTargets(telegram)).toEqual([{ label: "Ops", isDefault: true }]);
    expect(postingTargets(connection("telegram", { targets: "{not json" }))).toEqual([]);
  });

  it("never shows a raw provider id as a name", () => {
    const labels = [
      postingTargets(connection("telegram", { targets: [{ chatId: "-1001234567890" }] })),
      postingTargets(connection("slack", { targets: [{ channel: "C0123ABCD45" }] })),
      postingTargets(connection("discord", { defaultChannelId: "1234567890123456789" })),
      postingTargets(connection("whatsapp", { defaultTarget: "447700900123" })),
    ].flatMap((targets) => targets.map((target) => target.label));
    expect(labels).toEqual(["Unnamed chat", "Unnamed channel", "Default channel", "Default contact"]);
  });

  it("keeps a readable handle or channel name when a target has no label", () => {
    expect(postingTargets(connection("telegram", { targets: [{ chatId: "@ops_group" }] }))[0]!.label).toBe(
      "@ops_group",
    );
    expect(postingTargets(connection("slack", { defaultChannel: "#alerts" }))).toEqual([
      { label: "#alerts", isDefault: true },
    ]);
  });

  it("falls back to the legacy single default only when there are no named targets", () => {
    expect(postingTargets(connection("telegram", { defaultChatId: "123456789" }))).toEqual([
      { label: "Default chat", isDefault: true },
    ]);
    expect(
      postingTargets(connection("telegram", { defaultChatId: "123456789", targets: [{ label: "Ops", chatId: "1" }] })),
    ).toEqual([{ label: "Ops", isDefault: true }]);
  });

  it("has nothing to list for a channel with no places to post", () => {
    expect(postingTargets(connection("telegram"))).toEqual([]);
    expect(postingTargets(connection("signal", { defaultTarget: "+4477" }))).toEqual([]);
  });
});

describe("ownerCandidates", () => {
  const approved = [
    { actorId: "4242", label: "Ada" },
    { actorId: "777", label: "Someone on Telegram" },
  ];

  it("lists each approved sender and flags the ones saved as you", () => {
    const telegram = connection("telegram", { ownerActorIds: ["4242"] });
    expect(ownerCandidates(telegram, approved)).toEqual([
      { actorId: "4242", label: "Ada", isOwner: true },
      { actorId: "777", label: "Someone on Telegram", isOwner: false },
    ]);
  });

  it("matches ids the way the Gateway does: trimmed and case-insensitive", () => {
    const slack = connection("slack", { ownerActorIds: [" u0abc "] }, "Slack");
    expect(ownerCandidates(slack, [{ actorId: "U0ABC", label: "Grace" }])).toEqual([
      { actorId: "U0ABC", label: "Grace", isOwner: true },
    ]);
  });

  it("keeps an account saved as you that is no longer approved, so it can be cleared", () => {
    const telegram = connection("telegram", { ownerActorIds: ["9001"] });
    expect(ownerCandidates(telegram, approved).at(-1)).toEqual({
      actorId: "9001",
      label: "Someone on Telegram",
      isOwner: true,
    });
  });

  it("lists a sender once", () => {
    const rows = ownerCandidates(connection("telegram"), [
      { actorId: "4242", label: "Ada" },
      { actorId: " 4242 ", label: "Ada again" },
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe("ownerActorIdsWith", () => {
  it("adds the sender to the saved accounts without losing the others", () => {
    const telegram = connection("telegram", { ownerActorIds: ["1"] });
    expect(ownerActorIdsWith(telegram, "4242", true)).toEqual(["1", "4242"]);
  });

  it("does not add the same account twice", () => {
    const telegram = connection("telegram", { ownerActorIds: ["abc"] });
    expect(ownerActorIdsWith(telegram, " ABC ", true)).toEqual(["abc"]);
  });

  it("removes the sender, however it was cased", () => {
    const slack = connection("slack", { ownerActorIds: ["U0ABC", "u0def"] }, "Slack");
    expect(ownerActorIdsWith(slack, "u0abc", false)).toEqual(["u0def"]);
  });

  it("starts from nothing when the saved value is not a list", () => {
    expect(ownerActorIdsWith(connection("telegram", { ownerActorIds: "4242" }), "4242", true)).toEqual(["4242"]);
  });
});

describe("approvedSenders", () => {
  it("names a Telegram sender by display name, and an unnamed one by its channel", () => {
    const telegram = connection("telegram");
    const pairings = {
      items: [
        { actorId: "4242", status: "approved", displayName: "Ada" },
        { actorId: "777", status: "approved" },
        { actorId: "55", status: "pending", code: "ABC123", displayName: "Eve" },
      ],
      allowedSenders: ["4242", "777"],
    } as TelegramChannelPairingList;
    expect(approvedSenders(telegram, { telegram: pairings })).toEqual([
      { actorId: "4242", label: "Ada" },
      { actorId: "777", label: "Someone on Telegram" },
    ]);
  });

  it("includes allowed Telegram senders that have no pairing record", () => {
    const pairings = { items: [], allowedSenders: ["888"] } as unknown as TelegramChannelPairingList;
    expect(approvedSenders(connection("telegram"), { telegram: pairings })).toEqual([
      { actorId: "888", label: "Someone on Telegram" },
    ]);
  });

  it("lists approved Discord users and skips pending and revoked ones", () => {
    const discord = connection("discord", {}, "Discord");
    const records = [
      { userId: "u1", status: "approved", displayName: "Ada" },
      { userId: "u2", status: "pending", displayName: "Eve" },
      { userId: "u3", status: "revoked", displayName: "Mallory" },
      { userId: "u4", status: "approved" },
    ] as DiscordPairingRecord[];
    expect(approvedSenders(discord, { discord: records })).toEqual([
      { actorId: "u1", label: "Ada" },
      { actorId: "u4", label: "Someone on Discord" },
    ]);
  });

  it("reads the saved allow list for a channel without pairing records", () => {
    const slack = connection("slack", { allowedSenders: ["u0abc", "U0ABC", " "] }, "Slack");
    expect(approvedSenders(slack, {})).toEqual([{ actorId: "u0abc", label: "Someone on Slack" }]);
  });
});

describe("botIdentity", () => {
  it("names the bot where the channel reports it", () => {
    expect(botIdentity(connection("telegram", { botUsername: "MyGoatBot" }), undefined)).toBe("Bot @MyGoatBot");
    expect(botIdentity(connection("telegram", { botUsername: "@MyGoatBot" }), undefined)).toBe("Bot @MyGoatBot");
    expect(botIdentity(connection("discord"), { connectedBotTag: "Goat#1234" })).toBe("Bot Goat#1234");
    expect(botIdentity(connection("slack", { slackTeamName: "Acme" }, "Slack"), undefined)).toBe("Connected to Acme");
  });

  it("says nothing when the name is not known", () => {
    expect(botIdentity(connection("telegram"), undefined)).toBeUndefined();
    expect(botIdentity(connection("discord"), {})).toBeUndefined();
    expect(botIdentity(connection("whatsapp", { botUsername: "ignored" }), undefined)).toBeUndefined();
  });
});
