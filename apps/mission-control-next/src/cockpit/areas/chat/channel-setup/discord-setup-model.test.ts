import { describe, expect, it } from "vitest";
import {
  DISCORD_CATALOG_ID,
  DISCORD_DEVELOPER_PORTAL,
  DISCORD_INTENT_OFF,
  DISCORD_NO_MAKERS,
  DISCORD_TOKEN_FAILED,
  DISCORD_TURN_ON_WORDING,
  discordChannelPlace,
  discordChoiceValues,
  discordInServers,
  discordInviteHref,
  discordPostingOptions,
  discordPostingValue,
  discordTokenWorks,
  discordTurnOnChanges,
  postingFromValue,
  savedDiscordChoices,
} from "./discord-setup-model";

describe("discordInviteHref", () => {
  it("adds the bot with its commands and only the three permissions it needs", () => {
    // 68608 = View Channel (1024) + Send Messages (2048) + Read Message History (65536).
    expect(discordInviteHref("222")).toBe(
      "https://discord.com/oauth2/authorize?client_id=222&scope=bot+applications.commands&permissions=68608",
    );
  });

  it("keeps an unexpected id inside its own query value", () => {
    const href = new URL(discordInviteHref("2&permissions=8"));
    expect(href.searchParams.get("client_id")).toBe("2&permissions=8");
    expect(href.searchParams.get("permissions")).toBe("68608");
  });
});

describe("Discord's setup words", () => {
  it("names the catalog entry and the Developer Portal", () => {
    expect(DISCORD_CATALOG_ID).toBe("channel.discord");
    expect(DISCORD_DEVELOPER_PORTAL).toBe("https://discord.com/developers/applications");
  });

  it("fails a token in one sentence that blames neither the token nor the connection alone", () => {
    expect(DISCORD_TOKEN_FAILED).toBe(
      "Discord didn't accept that token, or GoatCitadel couldn't reach Discord. Check the token and try again.",
    );
  });

  it("names the bot when its token works", () => {
    expect(discordTokenWorks("Goat Bot")).toBe("Token works. Your bot is Goat Bot.");
  });

  it("tells how to turn on Message Content Intent", () => {
    expect(DISCORD_INTENT_OFF).toBe(
      "Turn on Message Content Intent: in the Developer Portal, open your app, choose Bot, and switch on Message Content Intent. Then check again.",
    );
  });
});

const ADA = { id: "333", name: "Ada" };
const SERVER = { id: "900", name: "Goat Server" };
const CHANNELS = [
  { id: "701", name: "general" },
  { id: "702", name: "bots" },
];

describe("discordTurnOnChanges", () => {
  const stays = "How it gets messages: GoatCitadel stays connected to Discord, so no public web address is needed";
  const test = "GoatCitadel sends a test message there and then removes it";

  it("lists a direct-message setup, with no host line when no host is missing", () => {
    expect(
      discordTurnOnChanges({ makerName: "Ada", posting: { kind: "direct" }, postingLabel: "", missingHosts: [] }),
    ).toEqual(["Who can message your bot: Ada, who made it", "Where it posts: direct messages with Ada", stays, test]);
  });

  it("lists a channel setup: the channel in its server, and who it answers there", () => {
    expect(
      discordTurnOnChanges({
        makerName: "Ada",
        posting: { kind: "channel", guildId: "900", channelId: "701" },
        postingLabel: "#general in Goat Server",
        missingHosts: [],
      }),
    ).toEqual([
      "Who can message your bot: Ada, who made it",
      "Where it posts: #general in Goat Server, and it answers Ada there when they mention it",
      stays,
      test,
    ]);
  });

  it("adds a line for each host that is missing, and only for those", () => {
    const lines = discordTurnOnChanges({
      makerName: "Ada",
      posting: { kind: "direct" },
      postingLabel: "",
      missingHosts: ["discord.com", "cdn.discordapp.com"],
    });
    expect(lines.slice(4)).toEqual([
      "discord.com is added to the hosts GoatCitadel may reach",
      "cdn.discordapp.com is added to the hosts GoatCitadel may reach",
    ]);
    expect(lines).toHaveLength(6);
  });
});

describe("DISCORD_TURN_ON_WORDING", () => {
  it("says Discord's own words for the button, its ending and the test message left behind", () => {
    expect(DISCORD_TURN_ON_WORDING).toEqual({
      button: "Turn on",
      working: "Turning on…",
      done: "Discord is on. Send your bot a direct message to try it.",
      doneLink: "Open Discord's page",
      cleanup: "GoatCitadel couldn't remove its test message. Delete it in Discord if you like.",
    });
  });
});

describe("the words of the invite and posting steps", () => {
  it("says what to do when Discord names no maker", () => {
    expect(DISCORD_NO_MAKERS).toBe(
      "Discord didn't say who made this bot, so GoatCitadel can't tell who to let in. Use More options in Settings instead.",
    );
  });

  it("names the server, or counts several", () => {
    expect(discordInServers([SERVER])).toBe("Your bot is in Goat Server.");
    expect(discordInServers([SERVER, { id: "901", name: "Other" }])).toBe("Your bot is in 2 servers.");
  });

  it("offers direct messages first, then each text channel as a mention", () => {
    expect(discordPostingOptions("Ada", CHANNELS)).toEqual([
      { value: "direct", label: "Direct messages with Ada" },
      { value: "channel:701", label: "#general, when Ada mentions it" },
      { value: "channel:702", label: "#bots, when Ada mentions it" },
    ]);
    expect(discordPostingOptions("Ada", null)).toEqual([{ value: "direct", label: "Direct messages with Ada" }]);
  });

  it("turns a choice into an option and back", () => {
    expect(discordPostingValue(null)).toBe("");
    expect(discordPostingValue({ kind: "direct" })).toBe("direct");
    expect(discordPostingValue({ kind: "channel", guildId: "900", channelId: "701" })).toBe("channel:701");
    expect(postingFromValue("direct", "900")).toEqual({ kind: "direct" });
    expect(postingFromValue("channel:701", "900")).toEqual({ kind: "channel", guildId: "900", channelId: "701" });
    // A channel is only ever in a server that was chosen.
    expect(postingFromValue("channel:701", null)).toBeNull();
    expect(postingFromValue("nonsense", "900")).toBeNull();
  });

  it("names a channel by its server, never by ids", () => {
    const posting = { kind: "channel", guildId: "900", channelId: "701" } as const;
    expect(discordChannelPlace(posting, [SERVER], CHANNELS)).toBe("#general in Goat Server");
    expect(discordChannelPlace(posting, [], CHANNELS)).toBeUndefined();
    expect(discordChannelPlace(posting, [SERVER], null)).toBeUndefined();
    expect(discordChannelPlace({ kind: "direct" }, [SERVER], CHANNELS)).toBeUndefined();
  });
});

describe("discordChoiceValues", () => {
  const base = { setupPage: "messaging", applicationId: "222", defaultGuildId: "old", label: "kept" };

  it("saves direct messages: the maker alone may message the bot, and the server goes", () => {
    const values = discordChoiceValues(base, "333", { kind: "direct" }, "dm-9");
    expect(values).toEqual({
      setupPage: "messaging",
      applicationId: "222",
      label: "kept",
      ownerActorIds: ["333"],
      allowedSenders: ["333"],
      inboundAccessMode: "allowlist",
      guildPolicy: "off",
      defaultChannelId: "dm-9",
    });
    expect(values).not.toHaveProperty("defaultGuildId");
    // The values given are not changed.
    expect(base.defaultGuildId).toBe("old");
  });

  it("saves a channel: the server allowlist with its server and channel", () => {
    expect(discordChoiceValues(base, "333", { kind: "channel", guildId: "900", channelId: "701" })).toEqual({
      setupPage: "messaging",
      applicationId: "222",
      label: "kept",
      ownerActorIds: ["333"],
      allowedSenders: ["333"],
      inboundAccessMode: "allowlist",
      guildPolicy: "allowlist",
      defaultGuildId: "900",
      defaultChannelId: "701",
    });
  });

  it("replaces who may message, rather than adding to them", () => {
    const values = discordChoiceValues({ ownerActorIds: ["1"], allowedSenders: ["1", "2"] }, "333", {
      kind: "channel",
      guildId: "900",
      channelId: "701",
    });
    expect(values.ownerActorIds).toEqual(["333"]);
    expect(values.allowedSenders).toEqual(["333"]);
  });
});

describe("savedDiscordChoices", () => {
  const check = { makers: [ADA, { id: "334", name: "Bo" }], servers: [SERVER] };
  const who = { ownerActorIds: ["333"], allowedSenders: ["333"], inboundAccessMode: "allowlist" };

  it("finds nothing on a draft with no choice", () => {
    expect(savedDiscordChoices({}, check)).toEqual({ makerId: null, posting: null });
    // The default server policy, with no channel, is no choice at all.
    expect(savedDiscordChoices({ guildPolicy: "allowlist" }, check)).toEqual({ makerId: null, posting: null });
  });

  it("finds direct messages and a channel as they were saved", () => {
    expect(savedDiscordChoices({ ...who, guildPolicy: "off", defaultChannelId: "dm-9" }, check)).toEqual({
      makerId: "333",
      posting: { kind: "direct" },
    });
    expect(
      savedDiscordChoices({ ...who, guildPolicy: "allowlist", defaultGuildId: "900", defaultChannelId: "701" }, check),
    ).toEqual({ makerId: "333", posting: { kind: "channel", guildId: "900", channelId: "701" } });
  });

  it("counts a maker only when all three saves are there and the person still made the bot", () => {
    expect(
      savedDiscordChoices({ ownerActorIds: ["333"], guildPolicy: "off", defaultChannelId: "dm-9" }, check),
    ).toEqual({ makerId: null, posting: null });
    expect(
      savedDiscordChoices({ ...who, ownerActorIds: ["999"], guildPolicy: "off", defaultChannelId: "dm-9" }, check),
    ).toEqual({ makerId: null, posting: null });
  });

  it("drops a channel in a server the bot is no longer in, and keeps the maker", () => {
    expect(
      savedDiscordChoices({ ...who, guildPolicy: "allowlist", defaultGuildId: "404", defaultChannelId: "701" }, check),
    ).toEqual({ makerId: "333", posting: null });
  });
});
