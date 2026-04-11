import { describe, expect, it } from "vitest";
import type { IntegrationCatalogEntry } from "@goatcitadel/contracts";
import {
  getIntegrationFormSchema,
  INTEGRATION_CATALOG,
  resolveIntegrationCatalogMaturity,
  resolveIntegrationCatalogRuntimeAvailability,
} from "./integration-catalog.js";

describe("integration-catalog", () => {
  it("includes OpenClaw-style channel entries with guided setup forms", () => {
    const catalogIds = [
      "channel.line",
      "channel.signal",
      "channel.whatsapp",
      "channel.imessage",
      "channel.mattermost",
      "channel.nextcloud-talk",
      "channel.zalo",
      "channel.zalouser",
    ];

    for (const catalogId of catalogIds) {
      const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === catalogId);
      expect(entry, `${catalogId} should exist in the integration catalog`).toBeDefined();
      expect(getIntegrationFormSchema(catalogId)?.fields.length).toBeGreaterThan(0);
    }
  });

  it("only upgrades planned catalog entries to plugin when the matching plugin is installed", () => {
    const plannedPluginChannel: IntegrationCatalogEntry = {
      ...requireCatalogEntry("channel.discord"),
      key: "custom-bridge",
      catalogId: "channel.custom-bridge",
      maturity: "planned",
      pluginId: "custombridge",
    };

    expect(resolveIntegrationCatalogMaturity(plannedPluginChannel, new Set())).toBe("disabled");
    expect(resolveIntegrationCatalogRuntimeAvailability(plannedPluginChannel, new Set())).toBe("blocked");
    expect(resolveIntegrationCatalogMaturity(plannedPluginChannel, new Set(["slack"]))).toBe("disabled");
    expect(resolveIntegrationCatalogMaturity(plannedPluginChannel, new Set(["custombridge"]))).toBe("plugin");
    expect(resolveIntegrationCatalogRuntimeAvailability(plannedPluginChannel, new Set(["custombridge"]))).toBe(
      "runnable",
    );
  });

  it("exposes the required Signal bridge URL in the guided setup form", () => {
    const signalForm = getIntegrationFormSchema("channel.signal");
    const baseUrlField = signalForm?.fields.find((field) => field.key === "baseUrl");

    expect(baseUrlField).toMatchObject({
      key: "baseUrl",
      type: "url",
      required: true,
    });
  });

  it("requires a WhatsApp phone number id in the guided setup form", () => {
    const whatsappForm = getIntegrationFormSchema("channel.whatsapp");
    const phoneNumberIdField = whatsappForm?.fields.find((field) => field.key === "phoneNumberId");
    const appSecretField = whatsappForm?.fields.find((field) => field.key === "appSecretEnv");
    const verifyTokenField = whatsappForm?.fields.find((field) => field.key === "webhookVerifyTokenEnv");

    expect(phoneNumberIdField).toMatchObject({
      key: "phoneNumberId",
      required: true,
    });
    expect(appSecretField).toMatchObject({
      key: "appSecretEnv",
      secretRef: true,
    });
    expect(verifyTokenField).toMatchObject({
      key: "webhookVerifyTokenEnv",
      secretRef: true,
    });
  });

  it("exposes a LINE channel secret field in the guided setup form", () => {
    const lineForm = getIntegrationFormSchema("channel.line");
    const channelSecretField = lineForm?.fields.find((field) => field.key === "channelSecretEnv");

    expect(channelSecretField).toMatchObject({
      key: "channelSecretEnv",
      secretRef: true,
      advanced: true,
    });
  });

  it("requires BlueBubbles bridge credentials in the iMessage guided setup form", () => {
    const imessageForm = getIntegrationFormSchema("channel.imessage");
    const bridgeUrlField = imessageForm?.fields.find((field) => field.key === "bridgeUrl");
    const passwordEnvField = imessageForm?.fields.find((field) => field.key === "passwordEnv");

    expect(bridgeUrlField).toMatchObject({
      key: "bridgeUrl",
      type: "url",
      required: true,
    });
    expect(passwordEnvField).toMatchObject({
      key: "passwordEnv",
      required: true,
      secretRef: true,
    });
  });

  it("requires a zca bridge URL in the Zalo Personal guided setup form", () => {
    const zalouserForm = getIntegrationFormSchema("channel.zalouser");
    const baseUrlField = zalouserForm?.fields.find((field) => field.key === "baseUrl");
    const defaultTargetField = zalouserForm?.fields.find((field) => field.key === "defaultTarget");

    expect(baseUrlField).toMatchObject({
      key: "baseUrl",
      type: "url",
      required: true,
    });
    expect(defaultTargetField).toMatchObject({
      key: "defaultTarget",
      required: true,
    });
  });

  it("supports plugin aliases for mismatched OpenClaw plugin IDs", () => {
    const whatsapp = requireCatalogEntry("channel.whatsapp");
    const plannedAliasEntry: IntegrationCatalogEntry = {
      ...requireCatalogEntry("channel.line"),
      key: "line-custom",
      catalogId: "channel.line-custom",
      maturity: "planned",
      pluginId: "googlechat",
    };

    expect(resolveIntegrationCatalogMaturity(plannedAliasEntry, new Set(["googlechat"]))).toBe("plugin");
    expect(resolveIntegrationCatalogMaturity(whatsapp, new Set())).toBe("beta");
    expect(resolveIntegrationCatalogRuntimeAvailability(whatsapp, new Set())).toBe("runnable");
  });

  it("keeps built-in channel runtimes truthful while still marking them runnable", () => {
    const betaBuiltInChannels = [
      "channel.signal",
      "channel.zalo",
      "channel.zalouser",
      "channel.whatsapp",
      "channel.mattermost",
      "channel.imessage",
      "channel.line",
    ];

    for (const catalogId of betaBuiltInChannels) {
      const entry = requireCatalogEntry(catalogId);
      expect(resolveIntegrationCatalogMaturity(entry, new Set())).toBe("beta");
      expect(resolveIntegrationCatalogRuntimeAvailability(entry, new Set())).toBe("runnable");
    }

    const nextcloudTalk = requireCatalogEntry("channel.nextcloud-talk");
    expect(resolveIntegrationCatalogMaturity(nextcloudTalk, new Set())).toBe("native");
    expect(resolveIntegrationCatalogRuntimeAvailability(nextcloudTalk, new Set())).toBe("runnable");

    const imessage = requireCatalogEntry("channel.imessage");
    expect(imessage.capabilities).toEqual(expect.arrayContaining(["attachments", "reactions", "unsend"]));

    const slack = requireCatalogEntry("channel.slack");
    expect(slack.capabilities).toEqual(expect.arrayContaining(["attachments", "reactions", "unsend"]));

    const discord = requireCatalogEntry("channel.discord");
    expect(discord.capabilities).toEqual(expect.arrayContaining(["attachments", "reactions", "unsend"]));

    const googleChat = requireCatalogEntry("channel.google-chat");
    expect(googleChat.capabilities).toEqual(expect.arrayContaining(["attachments", "threads"]));

    const telegram = requireCatalogEntry("channel.telegram");
    expect(telegram.capabilities).toEqual(expect.arrayContaining(["attachments", "reactions", "unsend", "typing"]));

    const mattermost = requireCatalogEntry("channel.mattermost");
    expect(mattermost.capabilities).toEqual(expect.arrayContaining(["attachments", "reactions", "unsend"]));

    const teams = requireCatalogEntry("channel.teams");
    expect(teams.capabilities).toEqual(expect.arrayContaining(["attachments", "threads"]));

    const whatsapp = requireCatalogEntry("channel.whatsapp");
    expect(whatsapp.capabilities).toEqual(expect.arrayContaining(["attachments", "direct", "reactions"]));

    const zalouser = requireCatalogEntry("channel.zalouser");
    expect(zalouser.capabilities).toEqual(expect.arrayContaining(["attachments", "direct"]));
  });

  it("marks the local-first voice runtime surface as beta", () => {
    const voice = requireCatalogEntry("automation.voice-wake-talk");

    expect(voice.maturity).toBe("beta");
    expect(resolveIntegrationCatalogMaturity(voice, new Set())).toBe("beta");
    expect(voice.capabilities).toEqual(expect.arrayContaining(["voice"]));
  });

  it("keeps the OpenAI-compatible visible provider set at operator-ready catalog maturity", () => {
    const providerCatalogIds = [
      "model_provider.minimax",
      "model_provider.vercel",
      "model_provider.mistral",
      "model_provider.deepseek",
      "model_provider.perplexity",
      "model_provider.huggingface",
    ];

    for (const catalogId of providerCatalogIds) {
      const entry = requireCatalogEntry(catalogId);
      expect(entry.maturity).toBe("beta");
      expect(resolveIntegrationCatalogMaturity(entry, new Set())).toBe("beta");
      expect(resolveIntegrationCatalogRuntimeAvailability(entry, new Set())).toBe("runnable");
    }
  });

  it("keeps the mandatory visible non-provider catalog set at operator-ready beta maturity", () => {
    const catalogIds = [
      "productivity.apple-notes",
      "productivity.apple-reminders",
      "productivity.things3",
      "productivity.bear",
      "productivity.trello",
      "automation.gmail",
      "automation.gif-search",
      "automation.peekaboo-screen",
      "automation.camera-photo-video",
      "platform.macos-menubar-voice",
      "platform.ios-canvas-camera-voice",
    ];

    for (const catalogId of catalogIds) {
      const entry = requireCatalogEntry(catalogId);
      expect(entry.maturity).toBe("beta");
      expect(resolveIntegrationCatalogMaturity(entry, new Set())).toBe("beta");
      expect(resolveIntegrationCatalogRuntimeAvailability(entry, new Set())).toBe("runnable");
      expect(getIntegrationFormSchema(catalogId)?.fields.length).toBeGreaterThan(0);
      expect(entry.operatorActions?.length ?? 0).toBeGreaterThan(0);
      expect(entry.capabilities).toEqual(
        expect.arrayContaining((entry.operatorActions ?? []).map((action) => action.capability)),
      );
    }
  });
});

function requireCatalogEntry(catalogId: string): IntegrationCatalogEntry {
  const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === catalogId);
  if (!entry) {
    throw new Error(`Missing integration catalog entry: ${catalogId}`);
  }
  return entry;
}
