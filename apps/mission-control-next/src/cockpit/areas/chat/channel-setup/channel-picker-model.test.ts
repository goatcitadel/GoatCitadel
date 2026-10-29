import type { ChannelPickerGroup, ChannelSetupDefinition, ChannelSetupPickerHint } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  buildChannelPickerGroups,
  CHAT_ONLY_SETUP_CHANNELS,
  chatPageHref,
  chatSetupHref,
  chatSetupHrefForDraft,
  CONVERTED_SETUP_CHANNELS,
  hasChatKeyChangePage,
  KEY_CHANGE_CHANNELS,
  settingsChannelSetupHref,
} from "./channel-picker-model";

function definition(
  key: string,
  label: string,
  estimatedMinutes: number,
  picker?: ChannelSetupPickerHint,
): ChannelSetupDefinition {
  return {
    catalog: { catalogId: `channel.${key}`, key, label },
    wizard: { estimatedMinutes, ...(picker ? { picker } : {}) },
  } as unknown as ChannelSetupDefinition;
}

function hint(group: ChannelPickerGroup, order: number, extra: Partial<ChannelSetupPickerHint> = {}) {
  return { group, order, ...extra };
}

describe("channel picker model", () => {
  it("groups and orders tiles as agreed", () => {
    // Deliberately not in picker order: the route's own list order never decides the tiles.
    const groups = buildChannelPickerGroups([
      definition("whatsapp", "WhatsApp", 20, hint("phone_apps", 1)),
      definition("slack", "Slack", 10, hint("quickest", 3)),
      definition("matrix", "Matrix", 15, hint("team_chat", 1)),
      definition("telegram", "Telegram", 8, hint("quickest", 0, { minutes: 3 })),
      definition("line", "LINE", 15, hint("phone_apps", 0)),
      definition("discord", "Discord", 9, hint("quickest", 1)),
      definition("mattermost", "Mattermost", 12, hint("team_chat", 0)),
      definition("ntfy", "ntfy", 5, hint("quickest", 2)),
    ]);
    expect(groups.map((group) => [group.id, group.title])).toEqual([
      ["quickest", "Quickest"],
      ["team_chat", "Team and self-hosted chat"],
      ["phone_apps", "Phone apps"],
    ]);
    expect(groups.map((group) => group.tiles.map((tile) => tile.channelKey))).toEqual([
      ["telegram", "discord", "ntfy", "slack"],
      ["mattermost", "matrix"],
      ["line", "whatsapp"],
    ]);
  });

  it("puts groups in order even when the definitions arrive with the last group first", () => {
    const groups = buildChannelPickerGroups([
      definition("line", "LINE", 15, hint("phone_apps", 0)),
      definition("matrix", "Matrix", 15, hint("team_chat", 0)),
      definition("slack", "Slack", 10, hint("quickest", 0)),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["quickest", "team_chat", "phone_apps"]);
  });

  it("leaves out a group with no tiles", () => {
    const groups = buildChannelPickerGroups([definition("slack", "Slack", 10, hint("quickest", 0))]);
    expect(groups.map((group) => group.id)).toEqual(["quickest"]);
    expect(buildChannelPickerGroups([])).toEqual([]);
  });

  it("sends converted channels to their setup page and the rest to Settings", () => {
    const [quickest] = buildChannelPickerGroups([
      definition("telegram", "Telegram", 8, hint("quickest", 0, { minutes: 3 })),
      definition("ntfy", "ntfy", 5, hint("quickest", 1, { note: "Needs an ntfy topic" })),
    ]);
    const [telegram, ntfy] = quickest!.tiles;
    expect(CONVERTED_SETUP_CHANNELS.has("telegram")).toBe(true);
    expect(CONVERTED_SETUP_CHANNELS.has("ntfy")).toBe(false);
    expect(telegram).toEqual({
      channelKey: "telegram",
      catalogId: "channel.telegram",
      label: "Telegram",
      minutes: 3,
      href: "/chat/messaging/add/telegram",
    });
    expect(ntfy).toEqual({
      channelKey: "ntfy",
      catalogId: "channel.ntfy",
      label: "ntfy",
      minutes: 5,
      note: "Needs an ntfy topic",
      href: "/settings/connections?channel=channel.ntfy#channels",
    });
    expect(settingsChannelSetupHref("channel.ntfy")).toBe("/settings/connections?channel=channel.ntfy#channels");
  });

  it("opens Discord's and Slack's own pages from the picker, in about 5 minutes", () => {
    const [quickest] = buildChannelPickerGroups([
      definition("discord", "Discord", 9, hint("quickest", 0, { minutes: 5 })),
      definition(
        "slack",
        "Slack",
        10,
        hint("quickest", 1, { minutes: 5, note: "Receiving needs a public web address" }),
      ),
    ]);
    const [discord, slack] = quickest!.tiles;
    expect(discord).toMatchObject({ channelKey: "discord", minutes: 5, href: "/chat/messaging/add/discord" });
    expect(slack).toMatchObject({ channelKey: "slack", minutes: 5, href: "/chat/messaging/add/slack" });
  });

  it("opens WhatsApp's own page from the picker, keeping its note", () => {
    const [phoneApps] = buildChannelPickerGroups([
      definition("whatsapp", "WhatsApp", 25, hint("phone_apps", 0, { note: "Business account + public web address" })),
    ]);
    expect(phoneApps!.tiles).toEqual([
      {
        channelKey: "whatsapp",
        catalogId: "channel.whatsapp",
        label: "WhatsApp",
        minutes: 25,
        note: "Business account + public web address",
        href: "/chat/messaging/add/whatsapp",
      },
    ]);
  });

  it("leaves out definitions without a picker hint", () => {
    const groups = buildChannelPickerGroups([
      definition("zalouser", "Zalo personal", 10),
      definition("slack", "Slack", 10, hint("quickest", 0)),
    ]);
    expect(groups.flatMap((group) => group.tiles.map((tile) => tile.channelKey))).toEqual(["slack"]);
  });

  it("does not change the definitions it is given", () => {
    const definitions = [definition("b", "B", 5, hint("quickest", 1)), definition("a", "A", 5, hint("quickest", 0))];
    const before = definitions.map((entry) => entry.catalog.key);
    buildChannelPickerGroups(definitions);
    expect(definitions.map((entry) => entry.catalog.key)).toEqual(before);
  });

  it("keeps same-order tiles in a steady order by label", () => {
    const [group] = buildChannelPickerGroups([
      definition("b", "Beta", 5, hint("quickest", 0)),
      definition("a", "Alpha", 5, hint("quickest", 0)),
    ]);
    expect(group!.tiles.map((tile) => tile.label)).toEqual(["Alpha", "Beta"]);
  });
});

describe("where a channel is set up", () => {
  const telegram = definition("telegram", "Telegram", 8);
  const discord = definition("discord", "Discord", 9);
  const slack = definition("slack", "Slack", 10);
  const mattermost = definition("mattermost", "Mattermost", 12);
  const whatsapp = definition("whatsapp", "WhatsApp", 25);
  const definitions = [telegram, discord, slack, mattermost, whatsapp];

  it("lists the channels with a Chat page, the ones Settings hands over, and the ones with a key page", () => {
    expect([...CONVERTED_SETUP_CHANNELS].sort()).toEqual(["discord", "slack", "telegram", "whatsapp"]);
    expect([...CHAT_ONLY_SETUP_CHANNELS]).toEqual(["telegram"]);
    expect([...KEY_CHANGE_CHANNELS]).toEqual(["telegram", "discord", "slack"]);
  });

  it("names a converted channel's Chat page for the picker, and nothing for the rest", () => {
    expect(chatPageHref(telegram)).toBe("/chat/messaging/add/telegram");
    expect(chatPageHref(discord)).toBe("/chat/messaging/add/discord");
    expect(chatPageHref(slack)).toBe("/chat/messaging/add/slack");
    expect(chatPageHref(whatsapp)).toBe("/chat/messaging/add/whatsapp");
    expect(chatPageHref(mattermost)).toBeUndefined();
  });

  it("hands a new setup from Settings to Chat for Telegram only", () => {
    expect(chatSetupHref(telegram)).toBe("/chat/messaging/add/telegram");
    // Discord and Slack have a Chat page, but Settings still starts their other ways (webhook-only, OAuth).
    expect(chatSetupHref(discord)).toBeUndefined();
    expect(chatSetupHref(slack)).toBeUndefined();
    // Nor does it hand WhatsApp over: only a setup made on WhatsApp's Chat page goes on there.
    expect(chatSetupHref(whatsapp)).toBeUndefined();
    expect(chatSetupHref(mattermost)).toBeUndefined();
  });

  it("continues an unfinished new setup on its Chat page, naming that setup", () => {
    const draft = { draftId: "draft-1", catalogId: "channel.telegram", lifecycleMode: "create" as const, draft: {} };
    expect(chatSetupHrefForDraft(draft, definitions)).toBe("/chat/messaging/add/telegram?draft=draft-1");
  });

  it("continues a WhatsApp setup that was made on the Chat page, and no other", () => {
    const marked = {
      draftId: "draft-3",
      catalogId: "channel.whatsapp",
      lifecycleMode: "create" as const,
      draft: { setupPage: "messaging" },
    };
    expect(chatSetupHrefForDraft(marked, definitions)).toBe("/chat/messaging/add/whatsapp?draft=draft-3");
    // The same channel set up in Settings carries no mark and goes on in Settings.
    expect(chatSetupHrefForDraft({ ...marked, draft: {} }, definitions)).toBeUndefined();
    expect(chatSetupHrefForDraft({ ...marked, connectionId: "c" }, definitions)).toBeUndefined();
    expect(chatSetupHrefForDraft({ ...marked, lifecycleMode: "edit" as const }, definitions)).toBeUndefined();
  });

  it("continues a Discord or Slack setup that was made on the Chat page, and no other", () => {
    const marked = {
      draftId: "draft-2",
      catalogId: "channel.slack",
      lifecycleMode: "create" as const,
      draft: { setupPage: "messaging" },
    };
    expect(chatSetupHrefForDraft(marked, definitions)).toBe("/chat/messaging/add/slack?draft=draft-2");
    expect(chatSetupHrefForDraft({ ...marked, catalogId: "channel.discord" }, definitions)).toBe(
      "/chat/messaging/add/discord?draft=draft-2",
    );
    // The same channel set up in Settings carries no mark and goes on in Settings.
    expect(chatSetupHrefForDraft({ ...marked, draft: {} }, definitions)).toBeUndefined();
    expect(chatSetupHrefForDraft({ ...marked, draft: { setupPage: "settings" } }, definitions)).toBeUndefined();
    // The mark does not give a channel a Chat page it does not have.
    expect(chatSetupHrefForDraft({ ...marked, catalogId: "channel.mattermost" }, definitions)).toBeUndefined();
  });

  it("leaves changes to a saved channel, other channels and unknown ones in Settings", () => {
    const editing = {
      draftId: "d",
      catalogId: "channel.telegram",
      lifecycleMode: "edit" as const,
      connectionId: "conn-1",
      draft: {},
    };
    expect(chatSetupHrefForDraft(editing, definitions)).toBeUndefined();
    // A new setup that already names its connection is past the point Chat's page starts from.
    const named = {
      draftId: "d",
      catalogId: "channel.telegram",
      lifecycleMode: "create" as const,
      connectionId: "c",
      draft: {},
    };
    expect(chatSetupHrefForDraft(named, definitions)).toBeUndefined();
    const markedAndNamed = {
      draftId: "d",
      catalogId: "channel.slack",
      lifecycleMode: "create" as const,
      connectionId: "c",
      draft: { setupPage: "messaging" },
    };
    expect(chatSetupHrefForDraft(markedAndNamed, definitions)).toBeUndefined();
    const other = { draftId: "d", catalogId: "channel.mattermost", lifecycleMode: "create" as const, draft: {} };
    expect(chatSetupHrefForDraft(other, definitions)).toBeUndefined();
    const gone = { draftId: "d", catalogId: "channel.gone", lifecycleMode: "create" as const, draft: {} };
    expect(chatSetupHrefForDraft(gone, definitions)).toBeUndefined();
  });
});

describe("which connections change their key on a page in Chat", () => {
  const connection = (key: string, config: Record<string, unknown> = {}) => ({ key, config });

  it("keeps Telegram as it was: always", () => {
    expect(hasChatKeyChangePage(connection("telegram"))).toBe(true);
    expect(hasChatKeyChangePage(connection("telegram", { receiveMode: "webhook" }))).toBe(true);
  });

  it("leaves every other channel to Settings", () => {
    expect(hasChatKeyChangePage(connection("mattermost", { receiveMode: "socket", runtimeMode: "gateway" }))).toBe(
      false,
    );
  });

  describe("Discord, only when it receives through the bot", () => {
    it.each([
      ["a connection saved as gateway", { runtimeMode: "gateway" }],
      ["a gateway mode with stray spaces", { runtimeMode: " gateway " }],
      ["a bot token and no mode", { botToken: "[REDACTED]" }],
      ["a bot token variable and no mode", { botTokenEnv: "DISCORD_BOT_TOKEN" }],
      ["an older token key and no mode", { token: "[REDACTED]" }],
      ["an older token variable and no mode", { tokenEnv: "DISCORD_TOKEN" }],
      ["a webhook beside a bot token and no mode", { webhookUrl: "[REDACTED]", botToken: "[REDACTED]" }],
    ])("is true for %s", (_name, config) => {
      expect(hasChatKeyChangePage(connection("discord", config))).toBe(true);
    });

    it.each([
      ["a connection saved as bridge", { runtimeMode: "bridge" }],
      ["a bridge that also holds a bot token", { runtimeMode: "bridge", botToken: "[REDACTED]" }],
      ["a webhook and no bot token", { webhookUrl: "[REDACTED]" }],
      ["a webhook variable and no bot token", { webhookUrlEnv: "DISCORD_WEBHOOK_URL" }],
      ["nothing that says how it receives", {}],
      ["blank token settings", { botToken: "  ", botTokenEnv: "" }],
      ["a token setting that is not text", { botToken: true }],
    ])("is false for %s: it has no bot token to change", (_name, config) => {
      expect(hasChatKeyChangePage(connection("discord", config))).toBe(false);
    });
  });

  describe("Slack, only when it receives over Socket Mode", () => {
    it.each([
      ["socket", { receiveMode: "socket" }],
      ["socket with stray spaces", { receiveMode: " socket " }],
    ])("is true for %s", (_name, config) => {
      expect(hasChatKeyChangePage(connection("slack", config))).toBe(true);
    });

    it.each([
      ["a webhook connection", { receiveMode: "webhook" }],
      ["an OAuth install", { authMode: "oauth", receiveMode: "webhook", slackTeamId: "T1" }],
      ["an OAuth install saved before the choice existed", { authMode: "oauth" }],
      ["a send-only webhook", { webhookUrl: "[REDACTED]" }],
      ["nothing that says how it receives", {}],
    ])("is false for %s: it has no app-level token to change", (_name, config) => {
      expect(hasChatKeyChangePage(connection("slack", config))).toBe(false);
    });
  });
});
