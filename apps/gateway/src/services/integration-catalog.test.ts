import { describe, expect, it } from "vitest";
import type { IntegrationCatalogEntry } from "@goatcitadel/contracts";
import {
  getIntegrationFormSchema,
  INTEGRATION_CATALOG,
  resolveIntegrationCatalogMaturity,
  resolveIntegrationCatalogRuntimeAvailability,
} from "./integration-catalog.js";
import { resolveMailProvider } from "./communications-dashboard-service.js";

describe("integration-catalog", () => {
  it("offers an IMAP/SMTP mail setup that sends through SMTP and keeps its password an env reference", () => {
    const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === "automation.imap-smtp");
    expect(entry).toMatchObject({ kind: "automation", key: "imap-smtp", capabilities: ["send"] });
    // The send executor treats this catalog id as an SMTP sender.
    expect(resolveMailProvider({ catalogId: entry!.catalogId, key: entry!.key } as never)).toBe("imap");
    const fields = getIntegrationFormSchema("automation.imap-smtp")?.fields ?? [];
    expect(fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(["smtpHost", "smtpPort", "smtpUser", "smtpPasswordEnv", "fromAddress"]),
    );
    expect(fields.find((field) => field.key === "smtpPasswordEnv")).toMatchObject({ secretRef: true });
    expect(fields.find((field) => field.key === "smtpHost")).toMatchObject({ required: true });
    expect(fields.find((field) => field.key === "fromAddress")).toMatchObject({ required: true });
    // No field may hold the password itself, and TLS mode follows the port rather than a stored toggle.
    expect(fields.some((field) => field.key === "smtpPassword" || field.key === "smtpSecure")).toBe(false);
    expect(getIntegrationFormSchema("automation.imap-smtp")?.description).toContain("not available yet");
  });

  it("requires visible authenticated Zalo User setup and separates Talk server from Gateway callbacks", () => {
    const zalo = getIntegrationFormSchema("channel.zalouser");
    expect(zalo?.description).toContain("authenticated");
    const auth = zalo?.fields.find((field) => field.key === "authTokenEnv");
    expect(auth).toMatchObject({ required: true });
    expect(auth?.advanced).not.toBe(true);
    const nextcloud = getIntegrationFormSchema("channel.nextcloud-talk");
    expect(nextcloud?.fields.find((field) => field.key === "baseUrl")?.description).toContain("different host");
  });
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
      "channel.matrix",
      "channel.qqbot",
      "channel.wecom",
    ];

    for (const catalogId of catalogIds) {
      const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === catalogId);
      expect(entry, `${catalogId} should exist in the integration catalog`).toBeDefined();
      expect(getIntegrationFormSchema(catalogId)?.fields.length).toBeGreaterThan(0);
    }
  });

  it("does not promote planned catalog entries through plugin presence", () => {
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
    expect(resolveIntegrationCatalogMaturity(plannedPluginChannel, new Set(["custombridge"]))).toBe("disabled");
    expect(resolveIntegrationCatalogRuntimeAvailability(plannedPluginChannel, new Set(["custombridge"]))).toBe(
      "blocked",
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

  it("exposes an explicit local-bridge action route instead of probing after side effects", () => {
    for (const catalogId of [
      "productivity.apple-notes",
      "productivity.apple-reminders",
      "productivity.things3",
      "productivity.bear",
      "automation.peekaboo-screen",
      "automation.camera-photo-video",
      "platform.macos-menubar-voice",
      "platform.ios-canvas-camera-voice",
    ]) {
      const actionRoute = getIntegrationFormSchema(catalogId)?.fields.find((field) => field.key === "actionRoute");

      expect(actionRoute).toMatchObject({
        key: "actionRoute",
        type: "select",
        defaultValue: "v1",
        advanced: true,
        options: [expect.objectContaining({ value: "v1" }), expect.objectContaining({ value: "api_v1" })],
      });
    }
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

  it("exposes inbound access controls for sender-allowlisted webhook channels", () => {
    for (const catalogId of ["channel.slack", "channel.whatsapp", "channel.nextcloud-talk", "channel.line"]) {
      const form = getIntegrationFormSchema(catalogId);
      expect(form?.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "inboundAccessMode",
            type: "select",
            defaultValue: "allowlist",
            advanced: true,
          }),
          expect.objectContaining({
            key: "allowedSenders",
            type: "json",
            defaultValue: "[]",
            advanced: true,
          }),
        ]),
      );
    }
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
    const providerField = imessageForm?.fields.find((field) => field.key === "bridgeProvider");
    const bridgeUrlField = imessageForm?.fields.find((field) => field.key === "bridgeUrl");
    const passwordEnvField = imessageForm?.fields.find((field) => field.key === "passwordEnv");
    const photonSidecarField = imessageForm?.fields.find((field) => field.key === "photonSidecarUrl");

    expect(providerField).toMatchObject({
      key: "bridgeProvider",
      type: "select",
      defaultValue: "bluebubbles",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "bluebubbles" }),
        expect.objectContaining({ value: "photon" }),
      ]),
    });

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
    expect(photonSidecarField).toMatchObject({
      key: "photonSidecarUrl",
      type: "url",
      advanced: true,
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

  it("keeps planned aliases disabled until they are explicitly modeled as plugin entries", () => {
    const whatsapp = requireCatalogEntry("channel.whatsapp");
    const plannedAliasEntry: IntegrationCatalogEntry = {
      ...requireCatalogEntry("channel.line"),
      key: "line-custom",
      catalogId: "channel.line-custom",
      maturity: "planned",
      pluginId: "googlechat",
    };

    expect(resolveIntegrationCatalogMaturity(plannedAliasEntry, new Set(["googlechat"]))).toBe("disabled");
    expect(resolveIntegrationCatalogRuntimeAvailability(plannedAliasEntry, new Set(["googlechat"]))).toBe("blocked");
    expect(resolveIntegrationCatalogMaturity(whatsapp, new Set())).toBe("beta");
    expect(resolveIntegrationCatalogRuntimeAvailability(whatsapp, new Set())).toBe("runnable");
  });

  it("promotes Matrix to a beta runnable channel with an opt-in forced-allowlist inbound form", () => {
    const entry = requireCatalogEntry("channel.matrix");
    expect(entry.maturity).toBe("beta");
    expect(resolveIntegrationCatalogMaturity(entry, new Set())).toBe("beta");
    expect(resolveIntegrationCatalogRuntimeAvailability(entry, new Set())).toBe("runnable");
    expect(entry.capabilities).toEqual(["chat", "rooms", "reactions", "unsend", "typing", "inbound"]);
    const fields = getIntegrationFormSchema("channel.matrix")?.fields ?? [];
    expect(fields.find((field) => field.key === "inboundStreamEnabled")).toBeDefined();
    expect(fields.find((field) => field.key === "allowedSenders")).toBeDefined();
    expect(fields.find((field) => field.key === "defaultRoomId")?.required).toBeFalsy();
  });

  it("promotes QQBot and WeCom to beta runnable channels with forced-allowlist inbound and no catalog-only copy", () => {
    for (const catalogId of ["channel.qqbot", "channel.wecom"]) {
      const entry = requireCatalogEntry(catalogId);
      expect(entry.maturity).toBe("beta");
      expect(resolveIntegrationCatalogMaturity(entry, new Set())).toBe("beta");
      expect(resolveIntegrationCatalogRuntimeAvailability(entry, new Set())).toBe("runnable");
      expect(entry.capabilities).toContain("inbound");
      expect(entry.description).not.toMatch(/catalog|probes are not wired/i);
      const schema = getIntegrationFormSchema(catalogId);
      expect(schema?.description).not.toMatch(/catalog-only/i);
      expect(schema?.fields.find((field) => field.key === "enabled")).toMatchObject({ defaultValue: false });
      expect(schema?.fields.find((field) => field.key === "allowedSenders")).toBeDefined();
      expect(schema?.fields.find((field) => field.key === "defaultTarget")?.required).toBeFalsy();
    }
    const qq = getIntegrationFormSchema("channel.qqbot")?.fields ?? [];
    expect(qq.find((field) => field.key === "appSecretEnv")).toMatchObject({ secretRef: true });
    expect(qq.find((field) => field.key === "appId")?.required).toBe(true);
    expect(qq.some((field) => field.key === "tokenEnv")).toBe(false);
    const wecom = getIntegrationFormSchema("channel.wecom")?.fields ?? [];
    for (const key of ["secretEnv", "callbackTokenEnv", "encodingAesKeyEnv"]) {
      expect(wecom.find((field) => field.key === key)).toMatchObject({ secretRef: true });
    }
    expect(wecom.find((field) => field.key === "corpId")?.required).toBe(true);
    expect(wecom.find((field) => field.key === "agentId")?.required).toBe(true);
  });

  it("only treats explicitly beta, native, or plugin entries as runnable", () => {
    for (const entry of INTEGRATION_CATALOG) {
      const resolvedMaturity = resolveIntegrationCatalogMaturity(entry, new Set());
      const runtimeAvailability = resolveIntegrationCatalogRuntimeAvailability(entry, new Set());
      if (runtimeAvailability === "runnable") {
        expect(["beta", "native", "plugin"]).toContain(resolvedMaturity);
      } else {
        expect(resolvedMaturity).toBe("disabled");
      }
    }
  });

  it("keeps local model providers on registered catalog ids", () => {
    expect(requireCatalogEntry("model_provider.local-models").label).toBe("Local Models");
    expect(getIntegrationFormSchema("model_provider.local-models")?.title).toBe("Local Models Provider");
    expect(INTEGRATION_CATALOG.find((entry) => entry.catalogId === "model_provider.lmstudio")).toBeUndefined();
    expect(getIntegrationFormSchema("model_provider.lmstudio")).toBeUndefined();
  });

  it("does not advertise operator-action capabilities without matching shipped actions", () => {
    const actionCapabilities = new Set(["read", "write", "search", "capture"]);

    for (const entry of INTEGRATION_CATALOG) {
      if (entry.kind === "channel") {
        continue;
      }
      const advertisedActionCapabilities = entry.capabilities.filter((capability) =>
        actionCapabilities.has(capability),
      );
      if (advertisedActionCapabilities.length === 0) {
        continue;
      }
      const shippedActionCapabilities = new Set((entry.operatorActions ?? []).map((action) => action.capability));
      for (const capability of advertisedActionCapabilities) {
        expect(
          shippedActionCapabilities.has(capability),
          `${entry.catalogId} advertises ${capability} without a matching operator action`,
        ).toBe(true);
      }
    }
  });

  it("keeps built-in channel runtimes truthful while still marking them runnable", () => {
    const betaBuiltInChannels = [
      "channel.signal",
      "channel.zalo",
      "channel.zalouser",
      "channel.whatsapp",
      "channel.mattermost",
      "channel.matrix",
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
    expect(getIntegrationFormSchema("channel.telegram")?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "allowedGroupIds", advanced: true }),
        expect.objectContaining({ key: "allowedForumTopicIds", advanced: true }),
      ]),
    );

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
      "automation.activepieces",
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

  it("advertises Activepieces webhook trigger and explicit run-status read actions", () => {
    const entry = requireCatalogEntry("automation.activepieces");
    const actionIds = (entry.operatorActions ?? []).map((action) => action.actionId);
    const fieldKeys = getIntegrationFormSchema("automation.activepieces")?.fields.map((field) => field.key) ?? [];

    expect(actionIds).toEqual(expect.arrayContaining(["trigger_webhook", "check_run_status"]));
    expect(fieldKeys).toEqual(expect.arrayContaining(["webhookUrl", "apiBaseUrl", "apiTokenEnv"]));
    expect(entry.operatorActions?.find((action) => action.actionId === "check_run_status")).toMatchObject({
      capability: "read",
      formSchema: expect.objectContaining({
        catalogId: "action:automation.activepieces.check_run_status",
      }),
    });
  });
});

function requireCatalogEntry(catalogId: string): IntegrationCatalogEntry {
  const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === catalogId);
  if (!entry) {
    throw new Error(`Missing integration catalog entry: ${catalogId}`);
  }
  return entry;
}
