import { describe, expect, it } from "vitest";
import {
  resolveChannelOwnerActorIds,
  type ChannelSetupDraft,
  type ChannelSetupFieldDefinition,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { createTelegramDefinition } from "./telegram.js";

const telegram = requireChannelSetupDefinition("channel.telegram");

function connection(config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "channel.telegram",
    kind: "channel",
    key: "telegram",
    label: "Telegram",
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
}

function draftOf(draft: Record<string, unknown>): ChannelSetupDraft {
  return {
    draftId: "22222222-2222-2222-2222-222222222222",
    revision: 1,
    catalogId: "channel.telegram",
    lifecycleMode: "create",
    enabled: true,
    draft,
    secretState: {},
    contentVersion: "content.v1",
    adapterVersion: "adapter.v1",
    validationVersion: "validation.v1",
    testVersion: "test.v1",
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = telegram.definition.wizard.steps
    .flatMap((step) => step.fields ?? [])
    .find((entry) => entry.key === key);
  if (!found) {
    throw new Error(`Telegram setup has no ${key} field`);
  }
  return found;
}

const BASE_CONFIG = { botTokenEnv: "TELEGRAM_BOT_TOKEN", defaultChatId: "-1001234567890" };

describe("Telegram receive mode setup", () => {
  it("new drafts default to asking Telegram for messages", () => {
    const receiveMode = field("receiveMode");

    expect(receiveMode.type).toBe("select");
    expect(receiveMode.defaultValue).toBe("poll");
    expect(receiveMode.options).toEqual([
      { value: "poll", label: "Ask Telegram for new messages (no public web address needed)" },
      { value: "webhook", label: "Telegram sends messages to a public web address" },
      { value: "off", label: "Don't receive messages" },
    ]);
    expect(telegram.normalize(draftOf({ ...BASE_CONFIG, receiveMode: "poll" })).receiveMode).toBe("poll");
  });

  it("places the receive mode before the webhook fields", () => {
    const keys = telegram.definition.wizard.steps.flatMap((step) => (step.fields ?? []).map((entry) => entry.key));

    expect(keys.indexOf("receiveMode")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("receiveMode")).toBeLessThan(keys.indexOf("webhookSecretEnv"));
    expect(keys.indexOf("receiveMode")).toBeLessThan(keys.indexOf("webhookSecret"));
  });

  it("leaves receiveMode out when the draft has none", () => {
    const normalized = telegram.normalize(draftOf(BASE_CONFIG));

    expect(normalized).not.toHaveProperty("receiveMode");
  });

  it("leaves receiveMode out when the draft value is not a known mode", () => {
    const normalized = telegram.normalize(draftOf({ ...BASE_CONFIG, receiveMode: "carrier-pigeon" }));

    expect(normalized).not.toHaveProperty("receiveMode");
  });

  it("flags an unknown receive mode during validation", () => {
    const issues = telegram.validate(
      draftOf({
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        defaultChatId: "-1001234567890",
        receiveMode: "carrier-pigeon",
      }),
    );

    expect(issues).toEqual([expect.objectContaining({ fieldKey: "receiveMode", level: "error" })]);
  });

  it("hydrates older connections as they behave today", () => {
    expect(telegram.hydrate(connection({ ...BASE_CONFIG, webhookSecret: "s3cret" })).draft.receiveMode).toBe("webhook");
    expect(telegram.hydrate(connection({ ...BASE_CONFIG, secretToken: "s3cret" })).draft.receiveMode).toBe("webhook");
    expect(telegram.hydrate(connection({ ...BASE_CONFIG, webhookSecretEnv: "TG_SECRET" })).draft.receiveMode).toBe(
      "webhook",
    );
    expect(telegram.hydrate(connection({ ...BASE_CONFIG, secretTokenEnv: "TG_SECRET" })).draft.receiveMode).toBe(
      "webhook",
    );
    expect(telegram.hydrate(connection(BASE_CONFIG)).draft.receiveMode).toBe("off");
    expect(telegram.hydrate(connection({ ...BASE_CONFIG, receiveMode: "poll" })).draft.receiveMode).toBe("poll");
  });

  it("keeps a stored receive mode over the webhook secret fallback", () => {
    const hydrated = telegram.hydrate(connection({ ...BASE_CONFIG, webhookSecret: "s3cret", receiveMode: "poll" }));

    expect(hydrated.draft.receiveMode).toBe("poll");
    expect(hydrated.hydration.fieldState.receiveMode).toBe("configured");
  });

  it("keeps the operator as the owner", () => {
    expect(telegram.normalize(draftOf({ ...BASE_CONFIG, ownerActorIds: ["42"] })).ownerActorIds).toEqual(["42"]);
  });

  it("stores owner ids in the canonical form the rest of GoatCitadel compares against", () => {
    const ownerActorIds = [" U1 ", "u1", "U2", "", "   ", 5];
    const normalized = telegram.normalize(draftOf({ ...BASE_CONFIG, ownerActorIds }));

    expect(normalized.ownerActorIds).toEqual(["u1", "u2"]);
    expect(normalized.ownerActorIds).toEqual(resolveChannelOwnerActorIds({ ownerActorIds }));
  });

  it("omits ownerActorIds when the draft has none or only blanks", () => {
    expect(telegram.normalize(draftOf(BASE_CONFIG))).not.toHaveProperty("ownerActorIds");
    expect(telegram.normalize(draftOf({ ...BASE_CONFIG, ownerActorIds: [] }))).not.toHaveProperty("ownerActorIds");
    expect(telegram.normalize(draftOf({ ...BASE_CONFIG, ownerActorIds: ["  ", 7] }))).not.toHaveProperty(
      "ownerActorIds",
    );
    expect(telegram.normalize(draftOf({ ...BASE_CONFIG, ownerActorIds: "42" }))).not.toHaveProperty("ownerActorIds");
  });

  it("carries ownerActorIds through hydrate and normalize", () => {
    const hydrated = telegram.hydrate(connection({ ...BASE_CONFIG, ownerActorIds: ["42", " 77 ", "42", "U1"] }));

    expect(hydrated.draft.ownerActorIds).toEqual(["42", "77", "u1"]);
    expect(hydrated.hydration.fieldState.ownerActorIds).toBe("configured");
    expect(telegram.hydrate(connection(BASE_CONFIG)).hydration.fieldState.ownerActorIds).toBe("unknown");
    expect(telegram.normalize(draftOf(hydrated.draft)).ownerActorIds).toEqual(["42", "77", "u1"]);
  });

  it("shows webhook secrets only for web-address delivery", () => {
    const visibleWhen = { fieldKey: "receiveMode", value: "webhook" };

    expect(field("webhookSecret").visibleWhenFieldEquals).toEqual(visibleWhen);
    expect(field("webhookSecretEnv").visibleWhenFieldEquals).toEqual(visibleWhen);
  });

  it("only asks for a public address when web-address delivery is chosen", () => {
    const line = "A public HTTPS address only if you choose web-address delivery.";
    const raw = createTelegramDefinition().definition.wizard.prerequisites;
    const guided = telegram.definition.wizard.prerequisites;

    for (const prerequisites of [raw, guided]) {
      expect(prerequisites).toContain(line);
      expect(prerequisites.join(" ")).not.toMatch(/Gateway URL/i);
    }
  });

  it("does not tell a polling connection to register a webhook", () => {
    const wizard = telegram.definition.wizard;
    const firstMessage = wizard.steps.find((step) => step.id === "first-message");
    const firstMessageText = JSON.stringify(firstMessage?.body);

    expect(wizard.introSummary).toBe("Connect a Telegram bot, choose who can message it, and how it gets messages.");
    expect(firstMessageText).toContain(
      "Send the bot a message and approve its pairing request in GoatCitadel. With web-address delivery, first register the connection's webhook URL with the same secret token.",
    );
    expect(firstMessageText).not.toContain("Register the saved connection webhook URL");
    expect(`${wizard.introSummary} ${firstMessageText}`).not.toContain("webhook conversations");
  });
});
