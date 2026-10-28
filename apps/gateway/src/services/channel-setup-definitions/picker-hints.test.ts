import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChannelPickerGroup } from "@goatcitadel/contracts";
import {
  getChannelSetupDefinition,
  listChannelSetupDefinitions,
  requireChannelSetupDefinition,
} from "../channel-setup-definitions.js";
import {
  CHANNEL_CONDITIONAL_HOSTS,
  CHANNEL_HOST_FIELDS,
  CHANNEL_INBOUND_WEBHOOKS,
  CHANNEL_PICKER_HINTS,
  CHANNEL_REQUIRED_HOSTS,
  withPickerHints,
} from "./picker-hints.js";

const GROUPS: Record<ChannelPickerGroup, string[]> = {
  quickest: ["telegram", "discord", "ntfy", "slack"],
  team_chat: ["mattermost", "matrix", "teams", "google-chat"],
  phone_apps: ["whatsapp", "line", "wecom", "qqbot", "zalo", "nextcloud-talk"],
};

const NOTES: Record<string, string> = {
  slack: "Receiving needs a public web address",
  ntfy: "Needs an ntfy topic you control",
  mattermost: "Needs a Mattermost server",
  matrix: "Needs a Matrix bot account",
  teams: "Sends only",
  "google-chat": "Receiving needs a public web address",
  whatsapp: "Business account + public web address",
  line: "Receiving needs a public web address",
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
  it("offers every channel in the picker", () => {
    for (const definition of listChannelSetupDefinitions()) {
      expect(definition.wizard.picker, `${definition.catalog.key} has no picker hint`).toBeDefined();
    }
  });

  it("has no picker hint or host field for a retired channel", () => {
    for (const key of ["signal", "imessage", "zalouser"]) {
      expect(CHANNEL_PICKER_HINTS, key).not.toHaveProperty(key);
      expect(CHANNEL_HOST_FIELDS, key).not.toHaveProperty(key);
      expect(CHANNEL_REQUIRED_HOSTS, key).not.toHaveProperty(key);
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
  });

  it("only hints channels that have a setup definition", () => {
    const keys = new Set(listChannelSetupDefinitions().map((definition) => definition.catalog.key));

    for (const key of [
      ...Object.keys(CHANNEL_PICKER_HINTS),
      ...Object.keys(CHANNEL_REQUIRED_HOSTS),
      ...Object.keys(CHANNEL_HOST_FIELDS),
      ...Object.keys(CHANNEL_CONDITIONAL_HOSTS),
      ...Object.keys(CHANNEL_INBOUND_WEBHOOKS),
    ]) {
      expect(keys.has(key), `${key} has no setup definition`).toBe(true);
    }
  });

  it("returns new objects and leaves the source definition untouched", () => {
    const base = requireChannelSetupDefinition("channel.ntfy");
    // A source definition as the registry holds it before hints are applied.
    const wizard = { ...base.definition.wizard };
    delete wizard.picker;
    delete wizard.requiredHosts;
    delete wizard.hostFields;
    delete wizard.conditionalHosts;
    delete wizard.inboundWebhook;
    const source = {
      ...base,
      definition: { ...base.definition, wizard, catalog: { ...base.definition.catalog, key: "telegram" } },
    };
    const before = JSON.stringify(source.definition);

    const result = withPickerHints(source);

    expect(JSON.stringify(source.definition)).toBe(before);
    expect(source.definition.wizard).not.toHaveProperty("picker");
    expect(source.definition.wizard).not.toHaveProperty("requiredHosts");
    expect(source.definition.wizard).not.toHaveProperty("inboundWebhook");
    expect(result.definition).not.toBe(source.definition);
    expect(result.definition.wizard.picker).toEqual({ ...CHANNEL_PICKER_HINTS.telegram, order: 0 });
    expect(CHANNEL_PICKER_HINTS.telegram).not.toHaveProperty("order");
    expect(result.definition.wizard.requiredHosts).not.toBe(CHANNEL_REQUIRED_HOSTS.telegram);
    expect(result.definition.wizard.inboundWebhook).toEqual(CHANNEL_INBOUND_WEBHOOKS.telegram);
    expect(result.definition.wizard.inboundWebhook).not.toBe(CHANNEL_INBOUND_WEBHOOKS.telegram);
    expect(result.definition.wizard.inboundWebhook?.whenFieldEquals).not.toBe(
      CHANNEL_INBOUND_WEBHOOKS.telegram?.whenFieldEquals,
    );
    expect(result.hydrate).toBe(source.hydrate);
  });

  it("copies host fields and conditional hosts rather than sharing the frozen tables", () => {
    const base = requireChannelSetupDefinition("channel.google-chat");
    const wizard = { ...base.definition.wizard };
    delete wizard.hostFields;
    delete wizard.conditionalHosts;
    const source = { ...base, definition: { ...base.definition, wizard } };
    const before = JSON.stringify(source.definition);

    const result = withPickerHints(source);

    expect(JSON.stringify(source.definition)).toBe(before);
    expect(source.definition.wizard).not.toHaveProperty("hostFields");
    expect(source.definition.wizard).not.toHaveProperty("conditionalHosts");
    expect(result.definition.wizard.hostFields).toEqual(["webhookUrl"]);
    expect(result.definition.wizard.hostFields).not.toBe(CHANNEL_HOST_FIELDS["google-chat"]);
    expect(result.definition.wizard.conditionalHosts).toEqual(CHANNEL_CONDITIONAL_HOSTS["google-chat"]);
    expect(result.definition.wizard.conditionalHosts).not.toBe(CHANNEL_CONDITIONAL_HOSTS["google-chat"]);
    expect(result.definition.wizard.conditionalHosts?.[0]).not.toBe(CHANNEL_CONDITIONAL_HOSTS["google-chat"]?.[0]);
    expect(result.definition.wizard.conditionalHosts?.[0]?.whenAnyFieldSet).not.toBe(
      CHANNEL_CONDITIONAL_HOSTS["google-chat"]?.[0]?.whenAnyFieldSet,
    );
  });

  it("freezes the host and webhook tables", () => {
    for (const table of [
      CHANNEL_REQUIRED_HOSTS,
      CHANNEL_HOST_FIELDS,
      CHANNEL_CONDITIONAL_HOSTS,
      CHANNEL_INBOUND_WEBHOOKS,
    ]) {
      expect(Object.isFrozen(table)).toBe(true);
    }
    expect(Object.isFrozen(CHANNEL_REQUIRED_HOSTS["qqbot"])).toBe(true);
    expect(Object.isFrozen(CHANNEL_HOST_FIELDS["matrix"])).toBe(true);
    expect(Object.isFrozen(CHANNEL_CONDITIONAL_HOSTS["qqbot"])).toBe(true);
    expect(Object.isFrozen(CHANNEL_CONDITIONAL_HOSTS["qqbot"]?.[0])).toBe(true);
    expect(Object.isFrozen(CHANNEL_INBOUND_WEBHOOKS["telegram"])).toBe(true);
    expect(Object.isFrozen(CHANNEL_INBOUND_WEBHOOKS["telegram"]?.whenFieldEquals)).toBe(true);
  });
});

describe("channel hosts and inbound webhooks", () => {
  it("says which hosts every guided channel reaches", () => {
    for (const definition of listChannelSetupDefinitions()) {
      const { requiredHosts = [], hostFields = [] } = definition.wizard;
      expect(requiredHosts.length + hostFields.length, definition.catalog.key).toBeGreaterThan(0);
    }
  });

  it("names the webhook path of exactly the channels that have a webhook route", () => {
    const routed = fs
      .readdirSync(fileURLToPath(new URL("../../routes", import.meta.url)))
      .map((file) => /^integration-webhooks-(.+)-routes\.ts$/u.exec(file)?.[1])
      .filter((key): key is string => Boolean(key))
      .sort();
    const withWebhook = listChannelSetupDefinitions()
      .filter((definition) => definition.wizard.inboundWebhook)
      .map((definition) => definition.catalog.key)
      .sort();
    expect(withWebhook).toEqual(routed);
    for (const key of withWebhook)
      expect(requireChannelSetupDefinition(`channel.${key}`).definition.wizard.inboundWebhook?.pathTemplate).toBe(
        `/api/v1/integrations/connections/{connectionId}/${key}/webhook`,
      );
  });

  it("lists the fixed hosts each channel must be allowed to reach", () => {
    const expected: Record<string, string[] | undefined> = {
      telegram: ["api.telegram.org"],
      discord: ["discord.com"],
      slack: ["slack.com"],
      whatsapp: ["graph.facebook.com"],
      line: ["api.line.me"],
      zalo: ["openapi.zalo.me"],
      qqbot: ["bots.qq.com", "api.bot.qq.com"],
      wecom: ["qyapi.weixin.qq.com"],
      "google-chat": ["chat.googleapis.com"],
    };
    for (const definition of listChannelSetupDefinitions()) {
      expect(definition.wizard.requiredHosts, definition.catalog.key).toEqual(expected[definition.catalog.key]);
    }
  });

  it("names the URL fields whose host the operator chooses", () => {
    const expected: Record<string, string[] | undefined> = {
      discord: ["webhookUrl"],
      slack: ["webhookUrl"],
      "google-chat": ["webhookUrl"],
      teams: ["webhookUrl"],
      ntfy: ["baseUrl"],
      matrix: ["homeserverUrl"],
      mattermost: ["serverUrl"],
      "nextcloud-talk": ["baseUrl"],
    };
    for (const definition of listChannelSetupDefinitions()) {
      expect(definition.wizard.hostFields, definition.catalog.key).toEqual(expected[definition.catalog.key]);
    }
  });

  it("names every host field as a field the guide asks for, and every condition field as one the channel reads", () => {
    for (const definition of listChannelSetupDefinitions()) {
      const fieldKeys = new Set(
        definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((field) => field.key)),
      );
      // A condition may also name a saved key the channel reads but the guide doesn't ask for.
      const conditionKeys = new Set([...fieldKeys, ...definition.adapter.secretFieldKeys]);
      for (const fieldKey of definition.wizard.hostFields ?? []) {
        expect(fieldKeys.has(fieldKey), `${definition.catalog.key} ${fieldKey}`).toBe(true);
      }
      for (const rule of definition.wizard.conditionalHosts ?? []) {
        for (const fieldKey of rule.whenAnyFieldSet) {
          expect(conditionKeys.has(fieldKey), `${definition.catalog.key} ${fieldKey}`).toBe(true);
        }
      }
      for (const fieldKey of definition.wizard.inboundWebhook?.whenAnyFieldSet ?? []) {
        expect(conditionKeys.has(fieldKey), `${definition.catalog.key} ${fieldKey}`).toBe(true);
      }
    }
  });

  it("adds the QQ sandbox host only while the sandbox is on", () => {
    expect(definitionByKey("qqbot").wizard.conditionalHosts).toEqual([
      { host: "sandbox.api.sgroup.qq.com", whenAnyFieldSet: ["sandbox"], equals: true },
    ]);
  });

  it("adds Google's token host only while a service-account key is set, named or saved", () => {
    expect(definitionByKey("google-chat").wizard.conditionalHosts).toEqual([
      { host: "oauth2.googleapis.com", whenAnyFieldSet: ["serviceAccountKeyEnv", "serviceAccountKey"] },
    ]);
  });

  it("has no conditional hosts on any other channel", () => {
    for (const definition of listChannelSetupDefinitions()) {
      if (definition.catalog.key === "qqbot" || definition.catalog.key === "google-chat") continue;
      expect(definition.wizard.conditionalHosts, definition.catalog.key).toBeUndefined();
    }
  });

  it("expects Telegram's webhook only in webhook mode and the others' whenever the channel is on", () => {
    expect(definitionByKey("telegram").wizard.inboundWebhook).toEqual({
      pathTemplate: "/api/v1/integrations/connections/{connectionId}/telegram/webhook",
      whenFieldEquals: { fieldKey: "receiveMode", value: "webhook" },
    });
    for (const key of ["slack", "whatsapp", "line", "qqbot", "wecom", "google-chat", "nextcloud-talk"]) {
      expect(definitionByKey(key).wizard.inboundWebhook?.whenFieldEquals, key).toBeUndefined();
    }
  });

  it("expects Google Chat's webhook only in Chat app mode, which is when a service-account key is named or saved", () => {
    const googleChat = definitionByKey("google-chat");
    expect(googleChat.wizard.inboundWebhook).toEqual({
      pathTemplate: "/api/v1/integrations/connections/{connectionId}/google-chat/webhook",
      whenAnyFieldSet: ["serviceAccountKeyEnv", "serviceAccountKey"],
    });
    const serviceAccountKey = googleChat.wizard.steps
      .flatMap((step) => step.fields ?? [])
      .find((field) => field.key === "serviceAccountKeyEnv");
    expect(serviceAccountKey).toBeDefined();
    expect(googleChat.adapter.secretFieldKeys).toContain("serviceAccountKey");
    for (const key of ["telegram", "slack", "whatsapp", "line", "qqbot", "wecom", "nextcloud-talk"]) {
      expect(definitionByKey(key).wizard.inboundWebhook?.whenAnyFieldSet, key).toBeUndefined();
    }
  });

  it("copies the fields an inbound webhook waits for rather than sharing the frozen table", () => {
    const base = requireChannelSetupDefinition("channel.google-chat");
    const wizard = { ...base.definition.wizard };
    delete wizard.inboundWebhook;
    const result = withPickerHints({ ...base, definition: { ...base.definition, wizard } });

    expect(result.definition.wizard.inboundWebhook?.whenAnyFieldSet).toEqual([
      "serviceAccountKeyEnv",
      "serviceAccountKey",
    ]);
    expect(result.definition.wizard.inboundWebhook?.whenAnyFieldSet).not.toBe(
      CHANNEL_INBOUND_WEBHOOKS["google-chat"]?.whenAnyFieldSet,
    );
    expect(Object.isFrozen(CHANNEL_INBOUND_WEBHOOKS["google-chat"]?.whenAnyFieldSet)).toBe(true);
  });

  it("only names a Telegram receive mode the guide offers", () => {
    const receiveMode = definitionByKey("telegram")
      .wizard.steps.flatMap((step) => step.fields ?? [])
      .find((field) => field.key === "receiveMode");
    expect(receiveMode?.options?.map((option) => option.value)).toContain("webhook");
  });

  it("leaves out channels with no inbound webhook route", () => {
    for (const key of ["discord", "zalo", "teams", "ntfy", "matrix", "mattermost"]) {
      expect(definitionByKey(key).wizard.inboundWebhook, key).toBeUndefined();
    }
  });
});
