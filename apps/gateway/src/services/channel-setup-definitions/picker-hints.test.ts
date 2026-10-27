import { describe, expect, it } from "vitest";
import type { ChannelPickerGroup } from "@goatcitadel/contracts";
import {
  getChannelSetupDefinition,
  listChannelSetupDefinitions,
  requireChannelSetupDefinition,
} from "../channel-setup-definitions.js";
import { CHANNEL_PICKER_HINTS, CHANNEL_REQUIRED_HOSTS, withPickerHints } from "./picker-hints.js";

const GROUPS: Record<ChannelPickerGroup, string[]> = {
  quickest: ["telegram", "discord", "ntfy", "slack"],
  team_chat: ["mattermost", "matrix", "teams", "google-chat"],
  phone_apps: ["signal", "whatsapp", "line", "imessage", "wecom", "qqbot", "zalo", "nextcloud-talk"],
};

const NOTES: Record<string, string> = {
  slack: "Receiving needs a public web address",
  ntfy: "Needs an ntfy topic you control",
  mattermost: "Needs a Mattermost server",
  matrix: "Needs a Matrix bot account",
  teams: "Sends only",
  "google-chat": "Receiving needs a public web address",
  signal: "Needs signal-cli",
  whatsapp: "Business account + public web address",
  line: "Receiving needs a public web address",
  imessage: "Sends only, through BlueBubbles on a Mac",
  wecom: "Receiving needs a public web address",
  qqbot: "Needs a public web address",
  zalo: "Sends only, from a Zalo Official Account",
  "nextcloud-talk": "Receiving needs a public web address",
};

function definitionByKey(key: string) {
  const definition = listChannelSetupDefinitions().find((item) => item.catalog.key === key);
  if (!definition) {
    throw new Error(`No setup definition for ${key}.`);
  }
  return definition;
}

describe("channel setup picker hints", () => {
  it("offers every channel except the Zalo personal bridge", () => {
    const definitions = listChannelSetupDefinitions();

    expect(definitions).toHaveLength(17);
    for (const definition of definitions) {
      if (definition.catalog.key === "zalouser") {
        expect(definition.wizard.picker).toBeUndefined();
      } else {
        expect(definition.wizard.picker, `${definition.catalog.key} has no picker hint`).toBeDefined();
      }
    }
  });

  it("groups channels as agreed", () => {
    // Picker order is the hint table's insertion order; the definitions list keeps its own ranking.
    const hinted = Object.entries(CHANNEL_PICKER_HINTS);
    const definitions = listChannelSetupDefinitions();

    for (const [group, keys] of Object.entries(GROUPS)) {
      const inPickerOrder = hinted.filter(([, hint]) => hint.group === group).map(([key]) => key);
      expect(inPickerOrder, `${group} channels`).toEqual(keys);

      const inDefinitions = definitions
        .filter((definition) => definition.wizard.picker?.group === group)
        .map((definition) => definition.catalog.key);
      expect([...inDefinitions].sort(), `${group} definitions`).toEqual([...keys].sort());
    }
  });

  it("numbers each group's channels from 0 in the agreed order", () => {
    const definitions = listChannelSetupDefinitions();

    for (const [group, keys] of Object.entries(GROUPS)) {
      const ranked = definitions
        .filter((definition) => definition.wizard.picker?.group === group)
        .map((definition) => ({ key: definition.catalog.key, order: definition.wizard.picker?.order }))
        .sort((left, right) => (left.order ?? -1) - (right.order ?? -1));

      expect(
        ranked.map((item) => item.key),
        `${group} channels by order`,
      ).toEqual(keys);
      expect(
        ranked.map((item) => item.order),
        `${group} order values`,
      ).toEqual(keys.map((_key, index) => index));
    }
    expect(definitionByKey("telegram").wizard.picker?.order).toBe(0);
    expect(definitionByKey("discord").wizard.picker?.order).toBe(1);
    expect(definitionByKey("ntfy").wizard.picker?.order).toBe(2);
    expect(definitionByKey("slack").wizard.picker?.order).toBe(3);
  });

  it("Telegram takes about three minutes and needs api.telegram.org", () => {
    const telegram = definitionByKey("telegram");

    expect(telegram.wizard.picker?.minutes).toBe(3);
    expect(telegram.wizard.requiredHosts).toEqual(["api.telegram.org"]);
    expect(telegram.wizard.estimatedMinutes).toBe(8);
  });

  it("says what each channel needs", () => {
    for (const definition of listChannelSetupDefinitions()) {
      const key = definition.catalog.key;
      expect(definition.wizard.picker?.note, `${key} note`).toBe(NOTES[key]);
    }
  });

  it("carries the hints on the single-definition lookups too", () => {
    expect(getChannelSetupDefinition("channel.telegram")?.wizard.picker?.group).toBe("quickest");
    expect(requireChannelSetupDefinition("channel.telegram").definition.wizard.requiredHosts).toEqual([
      "api.telegram.org",
    ]);
    expect(requireChannelSetupDefinition("channel.zalouser").definition.wizard.picker).toBeUndefined();
  });

  it("only hints channels that have a setup definition", () => {
    const keys = new Set(listChannelSetupDefinitions().map((definition) => definition.catalog.key));

    for (const key of [...Object.keys(CHANNEL_PICKER_HINTS), ...Object.keys(CHANNEL_REQUIRED_HOSTS)]) {
      expect(keys.has(key), `${key} has no setup definition`).toBe(true);
    }
  });

  it("returns new objects and leaves the source definition untouched", () => {
    const base = requireChannelSetupDefinition("channel.zalouser");
    const source = {
      ...base,
      definition: { ...base.definition, catalog: { ...base.definition.catalog, key: "telegram" } },
    };
    const before = JSON.stringify(source.definition);

    const result = withPickerHints(source);

    expect(JSON.stringify(source.definition)).toBe(before);
    expect(source.definition.wizard).not.toHaveProperty("picker");
    expect(source.definition.wizard).not.toHaveProperty("requiredHosts");
    expect(result.definition).not.toBe(source.definition);
    expect(result.definition.wizard.picker).toEqual({ ...CHANNEL_PICKER_HINTS.telegram, order: 0 });
    expect(CHANNEL_PICKER_HINTS.telegram).not.toHaveProperty("order");
    expect(result.definition.wizard.requiredHosts).not.toBe(CHANNEL_REQUIRED_HOSTS.telegram);
    expect(result.hydrate).toBe(source.hydrate);
  });
});
