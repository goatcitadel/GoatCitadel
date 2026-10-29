import type { SlackSetupCodeSender } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  SLACK_SAY_HI_POLL_MS,
  SLACK_TURN_ON_WORDING,
  savedSlackPosting,
  savedSlackSender,
  slackDraftWithPosting,
  slackDraftWithSender,
  slackPostingFromValue,
  slackPostingOptions,
  slackPostingValue,
  slackSenderName,
  slackTurnOnChanges,
} from "./slack-setup-model";

const ADA: SlackSetupCodeSender = { actorId: "U777", directChannelId: "D777", displayName: "Ada Lovelace" };
const CHANNELS = [
  { id: "C100", name: "general", private: false },
  { id: "G200", name: "secret", private: true },
];
const DM_ROW = {
  id: "slack:D777",
  label: "Ada Lovelace",
  channel: "D777",
  kind: "private",
  source: "recent_update",
  setupCodeMatched: true,
  default: true,
};

/** Frozen all the way down: a helper that wrote to its input would throw. */
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

describe("the pace of asking", () => {
  it("is every 6 seconds, because conversations.list allows about 20 a minute", () => {
    expect(SLACK_SAY_HI_POLL_MS).toBe(6_000);
  });
});

describe("slackSenderName", () => {
  it("is the name Slack gave, else Someone", () => {
    expect(slackSenderName(ADA)).toBe("Ada Lovelace");
    expect(slackSenderName({ actorId: "U1", directChannelId: "D1", displayName: "  Bo  " })).toBe("Bo");
    expect(slackSenderName({ actorId: "U1", directChannelId: "D1", displayName: "  " })).toBe("Someone");
    expect(slackSenderName({ actorId: "U1", directChannelId: "D1" })).toBe("Someone");
  });
});

describe("slackDraftWithSender", () => {
  it("makes them the only allowed sender and an owner, with their direct messages as the default", () => {
    const next = slackDraftWithSender({ receiveMode: "socket", setupCode: "abc", setupPage: "messaging" }, ADA);
    expect(next).toEqual({
      receiveMode: "socket",
      setupCode: "abc",
      setupPage: "messaging",
      allowedSenders: ["U777"],
      ownerActorIds: ["U777"],
      inboundAccessMode: "allowlist",
      targets: [DM_ROW],
    });
  });

  it("names the direct messages Someone when Slack gave no name", () => {
    const next = slackDraftWithSender({}, { actorId: "U5", directChannelId: "D5" });
    expect((next.targets as { label: string }[])[0]!.label).toBe("Someone");
  });

  it("replaces anyone allowed before, and does not change the draft it was given", () => {
    const before = frozen({ allowedSenders: ["U1", "U2"], ownerActorIds: ["U1"], inboundAccessMode: "open_legacy" });
    const next = slackDraftWithSender(before, ADA);
    expect(next.allowedSenders).toEqual(["U777"]);
    expect(next.ownerActorIds).toEqual(["U777"]);
    expect(next.inboundAccessMode).toBe("allowlist");
    expect(before).toEqual({ allowedSenders: ["U1", "U2"], ownerActorIds: ["U1"], inboundAccessMode: "open_legacy" });
  });

  it("keeps the places already there, but only their direct messages are the default", () => {
    const next = slackDraftWithSender(
      {
        targets: [
          { id: "slack:C100", label: "#general", channel: "C100", kind: "channel", default: true },
          { id: "other", label: "Other", channel: "C300", kind: "channel" },
        ],
      },
      ADA,
    );
    const targets = next.targets as { channel: string; default: boolean }[];
    expect(targets.map((target) => target.channel)).toEqual(["C100", "C300", "D777"]);
    expect(targets.map((target) => target.default)).toEqual([false, false, true]);
  });

  it("does not add their direct messages twice, and makes the ones already there the default", () => {
    const next = slackDraftWithSender(
      { targets: [{ id: "mine", label: "Me", channel: "d777", kind: "private", default: false }] },
      ADA,
    );
    expect(next.targets).toEqual([{ id: "mine", label: "Me", channel: "d777", kind: "private", default: true }]);
  });

  it("reads places that arrived as text", () => {
    const next = slackDraftWithSender(
      { targets: JSON.stringify([{ id: "slack:C100", label: "#general", channel: "C100", default: true }]) },
      ADA,
    );
    expect((next.targets as { channel: string }[]).map((target) => target.channel)).toEqual(["C100", "D777"]);
  });
});

describe("slackDraftWithPosting", () => {
  const afterHi = () => slackDraftWithSender({ receiveMode: "socket" }, ADA);

  it("makes a channel the default place, and keeps their direct messages as a place that isn't", () => {
    const next = slackDraftWithPosting(afterHi(), { kind: "channel", channelId: "C100" }, CHANNELS);
    expect(next.targets).toEqual([
      { ...DM_ROW, default: false },
      {
        id: "slack:C100",
        label: "#general",
        channel: "C100",
        kind: "channel",
        source: "connection_config",
        default: true,
      },
    ]);
    // Who may message the bot is not touched by where it posts.
    expect(next).toMatchObject({ allowedSenders: ["U777"], ownerActorIds: ["U777"], inboundAccessMode: "allowlist" });
    expect(next.receiveMode).toBe("socket");
  });

  it("calls a private channel a group", () => {
    const next = slackDraftWithPosting(afterHi(), { kind: "channel", channelId: "G200" }, CHANNELS);
    const row = (next.targets as { channel: string; kind: string; label: string }[]).find((r) => r.channel === "G200");
    expect(row).toMatchObject({ id: "slack:G200", label: "#secret", kind: "group", source: "connection_config" });
  });

  it("goes back to their direct messages, and forgets the channel it had added", () => {
    const inChannel = slackDraftWithPosting(afterHi(), { kind: "channel", channelId: "C100" }, CHANNELS);
    const next = slackDraftWithPosting(inChannel, { kind: "direct" }, CHANNELS);
    expect(next.targets).toEqual([DM_ROW]);
  });

  it("changes from one channel to another without keeping the first", () => {
    const first = slackDraftWithPosting(afterHi(), { kind: "channel", channelId: "C100" }, CHANNELS);
    const next = slackDraftWithPosting(first, { kind: "channel", channelId: "G200" }, CHANNELS);
    const targets = next.targets as { channel: string; default: boolean }[];
    expect(targets.map((target) => [target.channel, target.default])).toEqual([
      ["D777", false],
      ["G200", true],
    ]);
  });

  it("leaves a place that someone else added alone", () => {
    const base = slackDraftWithSender(
      { targets: [{ id: "mine", label: "Mine", channel: "C900", kind: "channel", source: "recent_update" }] },
      ADA,
    );
    const next = slackDraftWithPosting(base, { kind: "channel", channelId: "C100" }, CHANNELS);
    expect((next.targets as { channel: string }[]).map((target) => target.channel)).toEqual(["C900", "D777", "C100"]);
    const back = slackDraftWithPosting(next, { kind: "direct" }, CHANNELS);
    expect((back.targets as { channel: string; default: boolean }[]).map((t) => [t.channel, t.default])).toEqual([
      ["C900", false],
      ["D777", true],
    ]);
  });

  it("does not change the draft it was given", () => {
    const before = frozen(afterHi());
    const copy = structuredClone(before);
    slackDraftWithPosting(before, { kind: "channel", channelId: "C100" }, CHANNELS);
    expect(before).toEqual(copy);
  });

  it("changes nothing for a channel it was not told about, or direct messages with nobody", () => {
    const before = afterHi();
    expect(slackDraftWithPosting(before, { kind: "channel", channelId: "C404" }, CHANNELS)).toEqual(before);
    expect(slackDraftWithPosting({ receiveMode: "socket" }, { kind: "direct" }, CHANNELS)).toEqual({
      receiveMode: "socket",
    });
  });
});

describe("when a second person says hi", () => {
  const BO: SlackSetupCodeSender = { actorId: "U888", directChannelId: "D888", displayName: "Bo" };
  const someoneElses = { id: "mine", label: "Mine", channel: "C900", kind: "channel", source: "recent_update" };

  it("keeps only their direct messages from a hi, and leaves places anyone else added", () => {
    const afterAda = slackDraftWithSender({ targets: [someoneElses] }, ADA);
    const before = frozen(slackDraftWithPosting(afterAda, { kind: "channel", channelId: "C100" }, CHANNELS));
    const copy = structuredClone(before);

    const afterBo = slackDraftWithSender(before, BO);

    expect(before).toEqual(copy);
    const targets = afterBo.targets as { channel: string; default: boolean; setupCodeMatched?: boolean }[];
    expect(targets.filter((target) => target.setupCodeMatched === true).map((target) => target.channel)).toEqual([
      "D888",
    ]);
    expect(targets.map((target) => [target.channel, target.default])).toEqual([
      ["C900", false],
      ["C100", false],
      ["D888", true],
    ]);
    expect(savedSlackSender(afterBo)).toEqual(BO);
    expect(afterBo).toMatchObject({ allowedSenders: ["U888"], ownerActorIds: ["U888"] });
  });

  it("makes the newest sender's direct messages the default when direct messages are chosen", () => {
    const afterAda = slackDraftWithSender({}, ADA);
    const afterBo = slackDraftWithSender(afterAda, BO);
    const inChannel = slackDraftWithPosting(afterBo, { kind: "channel", channelId: "C100" }, CHANNELS);
    const before = frozen(inChannel);
    const copy = structuredClone(before);

    const direct = slackDraftWithPosting(before, { kind: "direct" }, CHANNELS);

    expect(before).toEqual(copy);
    const targets = direct.targets as { channel: string; default: boolean }[];
    expect(targets.map((target) => [target.channel, target.default])).toEqual([["D888", true]]);
    expect(savedSlackPosting(direct, savedSlackSender(direct))).toEqual({ kind: "direct" });
    expect(savedSlackSender(direct)).toEqual(BO);
  });
});

describe("savedSlackSender and savedSlackPosting", () => {
  it("give back who slackDraftWithSender saved, from the owner and the direct messages the code came from", () => {
    expect(savedSlackSender(slackDraftWithSender({}, ADA))).toEqual(ADA);
    expect(savedSlackSender(slackDraftWithSender({}, { actorId: "U5", directChannelId: "D5" }))).toEqual({
      actorId: "U5",
      directChannelId: "D5",
      displayName: "Someone",
    });
  });

  it("are nobody before anyone has said hi", () => {
    expect(savedSlackSender({})).toBeNull();
    expect(savedSlackSender({ ownerActorIds: ["U777"] })).toBeNull();
    expect(savedSlackSender({ ownerActorIds: ["  "], targets: [DM_ROW] })).toBeNull();
    expect(savedSlackSender({ targets: [DM_ROW] })).toBeNull();
    expect(savedSlackPosting({}, ADA)).toBeNull();
  });

  it("read where it posts from the default place", () => {
    const direct = slackDraftWithSender({}, ADA);
    expect(savedSlackPosting(direct, ADA)).toEqual({ kind: "direct" });
    const channel = slackDraftWithPosting(direct, { kind: "channel", channelId: "C100" }, CHANNELS);
    expect(savedSlackPosting(channel, ADA)).toEqual({ kind: "channel", channelId: "C100" });
    expect(savedSlackPosting({ ...direct, targets: [{ ...DM_ROW, default: false }] }, ADA)).toBeNull();
  });
});

describe("the choices for where it posts", () => {
  it("offers direct messages first, then each channel by name, answering the same person", () => {
    expect(slackPostingOptions("Ada Lovelace", CHANNELS)).toEqual([
      { value: "direct", label: "Direct messages with Ada Lovelace" },
      { value: "channel:C100", label: "#general, when Ada Lovelace mentions it" },
      { value: "channel:G200", label: "#secret, when Ada Lovelace mentions it (private)" },
    ]);
    expect(slackPostingOptions("Ada", null)).toEqual([{ value: "direct", label: "Direct messages with Ada" }]);
  });

  it("turns a choice into a posting and back", () => {
    expect(slackPostingValue(null)).toBe("");
    expect(slackPostingValue({ kind: "direct" })).toBe("direct");
    expect(slackPostingValue({ kind: "channel", channelId: "C100" })).toBe("channel:C100");
    expect(slackPostingFromValue("direct")).toEqual({ kind: "direct" });
    expect(slackPostingFromValue("channel:C100")).toEqual({ kind: "channel", channelId: "C100" });
    expect(slackPostingFromValue("channel:")).toBeNull();
    expect(slackPostingFromValue("nonsense")).toBeNull();
  });
});

describe("slackTurnOnChanges", () => {
  const HOW = "How it gets messages: GoatCitadel keeps a connection open to Slack, so no public web address is needed";
  const TEST = "GoatCitadel sends a test message there and then removes it";

  it("says what turning on does for direct messages", () => {
    expect(slackTurnOnChanges({ senderName: "Ada", posting: { kind: "direct" }, missingHosts: [] })).toEqual([
      "Who can message your bot: Ada",
      "Where it posts: direct messages with Ada",
      HOW,
      TEST,
    ]);
  });

  it("names the channel and who it answers there", () => {
    expect(
      slackTurnOnChanges({
        senderName: "Ada",
        posting: { kind: "channel", channelId: "C100" },
        channelName: "general",
        missingHosts: [],
      }),
    ).toEqual([
      "Who can message your bot: Ada",
      "Where it posts: #general, and it answers Ada there when they mention it",
      HOW,
      TEST,
    ]);
  });

  it("adds a line for each host that is not yet allowed", () => {
    const lines = slackTurnOnChanges({
      senderName: "Ada",
      posting: { kind: "direct" },
      missingHosts: ["slack.com", "files.slack.com"],
    });
    expect(lines.slice(4)).toEqual([
      "slack.com is added to the hosts GoatCitadel may reach",
      "files.slack.com is added to the hosts GoatCitadel may reach",
    ]);
  });
});

describe("SLACK_TURN_ON_WORDING", () => {
  it("is Discord's button and working words with Slack's ending", () => {
    expect(SLACK_TURN_ON_WORDING).toEqual({
      button: "Turn on",
      working: "Turning on…",
      done: "Slack is on. Send your bot a message to try it.",
      doneLink: "Open Slack's page",
      cleanup: "GoatCitadel couldn't remove its test message. Delete it in Slack if you like.",
    });
  });
});
