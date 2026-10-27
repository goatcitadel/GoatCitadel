import type { ChannelPickerGroup, ChannelSetupDefinition, ChannelSetupPickerHint } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { buildChannelPickerGroups, CONVERTED_SETUP_CHANNELS, settingsChannelSetupHref } from "./channel-picker-model";

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
      definition("signal", "Signal", 25, hint("phone_apps", 0)),
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
      ["signal", "whatsapp"],
    ]);
  });

  it("puts groups in order even when the definitions arrive with the last group first", () => {
    const groups = buildChannelPickerGroups([
      definition("signal", "Signal", 25, hint("phone_apps", 0)),
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
      definition("slack", "Slack", 10, hint("quickest", 1, { note: "Receiving needs a public web address" })),
    ]);
    const [telegram, slack] = quickest!.tiles;
    expect(CONVERTED_SETUP_CHANNELS.has("telegram")).toBe(true);
    expect(CONVERTED_SETUP_CHANNELS.has("slack")).toBe(false);
    expect(telegram).toEqual({
      channelKey: "telegram",
      catalogId: "channel.telegram",
      label: "Telegram",
      minutes: 3,
      href: "/chat/messaging/add/telegram",
    });
    expect(slack).toEqual({
      channelKey: "slack",
      catalogId: "channel.slack",
      label: "Slack",
      minutes: 10,
      note: "Receiving needs a public web address",
      href: "/settings/connections?channel=channel.slack#channels",
    });
    expect(settingsChannelSetupHref("channel.slack")).toBe("/settings/connections?channel=channel.slack#channels");
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
