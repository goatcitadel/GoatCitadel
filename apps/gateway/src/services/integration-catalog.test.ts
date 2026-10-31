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

  it("leaves out the retired Zalo Personal, Signal and iMessage channels and separates Talk server from Gateway callbacks", () => {
    for (const key of ["zalouser", "signal", "imessage"]) {
      expect(INTEGRATION_CATALOG.some((entry) => entry.key === key)).toBe(false);
      expect(getIntegrationFormSchema(`channel.${key}`)).toBeUndefined();
    }
    const nextcloud = getIntegrationFormSchema("channel.nextcloud-talk");
    expect(nextcloud?.fields.find((field) => field.key === "baseUrl")?.description).toContain("different host");
  });
  it("includes OpenClaw-style channel entries with guided setup forms", () => {
    const catalogIds = [
      "channel.line",
      "channel.whatsapp",
      "channel.mattermost",
      "channel.nextcloud-talk",
      "channel.zalo",
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

  it("keeps a planned catalog entry disabled and blocked", () => {
    const planned: IntegrationCatalogEntry = {
      ...requireCatalogEntry("channel.discord"),
      key: "custom-bridge",
      catalogId: "channel.custom-bridge",
      maturity: "planned",
    };

    expect(resolveIntegrationCatalogMaturity(planned)).toBe("disabled");
    expect(resolveIntegrationCatalogRuntimeAvailability(planned)).toBe("blocked");
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

  it("keeps planned aliases disabled until they are explicitly modeled as catalog entries", () => {
    const whatsapp = requireCatalogEntry("channel.whatsapp");
    const plannedAliasEntry: IntegrationCatalogEntry = {
      ...requireCatalogEntry("channel.line"),
      key: "line-custom",
      catalogId: "channel.line-custom",
      maturity: "planned",
    };

    expect(resolveIntegrationCatalogMaturity(plannedAliasEntry)).toBe("disabled");
    expect(resolveIntegrationCatalogRuntimeAvailability(plannedAliasEntry)).toBe("blocked");
    expect(resolveIntegrationCatalogMaturity(whatsapp)).toBe("beta");
    expect(resolveIntegrationCatalogRuntimeAvailability(whatsapp)).toBe("runnable");
  });

  it("promotes Matrix to a beta runnable channel with an opt-in forced-allowlist inbound form", () => {
    const entry = requireCatalogEntry("channel.matrix");
    expect(entry.maturity).toBe("beta");
    expect(resolveIntegrationCatalogMaturity(entry)).toBe("beta");
    expect(resolveIntegrationCatalogRuntimeAvailability(entry)).toBe("runnable");
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
      expect(resolveIntegrationCatalogMaturity(entry)).toBe("beta");
      expect(resolveIntegrationCatalogRuntimeAvailability(entry)).toBe("runnable");
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

  it("only treats explicitly beta or native entries as runnable", () => {
    for (const entry of INTEGRATION_CATALOG) {
      const resolvedMaturity = resolveIntegrationCatalogMaturity(entry);
      const runtimeAvailability = resolveIntegrationCatalogRuntimeAvailability(entry);
      if (runtimeAvailability === "runnable") {
        expect(["beta", "native"]).toContain(resolvedMaturity);
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
      "channel.zalo",
      "channel.whatsapp",
      "channel.mattermost",
      "channel.matrix",
      "channel.line",
    ];

    for (const catalogId of betaBuiltInChannels) {
      const entry = requireCatalogEntry(catalogId);
      expect(resolveIntegrationCatalogMaturity(entry)).toBe("beta");
      expect(resolveIntegrationCatalogRuntimeAvailability(entry)).toBe("runnable");
    }

    const nextcloudTalk = requireCatalogEntry("channel.nextcloud-talk");
    expect(resolveIntegrationCatalogMaturity(nextcloudTalk)).toBe("native");
    expect(resolveIntegrationCatalogRuntimeAvailability(nextcloudTalk)).toBe("runnable");

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
    // A Workflows webhook posts cards into a channel; it cannot start or reply in a thread.
    expect(teams.capabilities).toEqual(expect.arrayContaining(["attachments"]));
    expect(teams.capabilities).not.toContain("threads");

    const whatsapp = requireCatalogEntry("channel.whatsapp");
    expect(whatsapp.capabilities).toEqual(expect.arrayContaining(["attachments", "direct", "reactions"]));
  });

  it("marks the local-first voice runtime surface as beta", () => {
    const voice = requireCatalogEntry("automation.voice-wake-talk");

    expect(voice.maturity).toBe("beta");
    expect(resolveIntegrationCatalogMaturity(voice)).toBe("beta");
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
      expect(resolveIntegrationCatalogMaturity(entry)).toBe("beta");
      expect(resolveIntegrationCatalogRuntimeAvailability(entry)).toBe("runnable");
    }
  });

  it("keeps the mandatory visible non-provider catalog set at operator-ready beta maturity", () => {
    const catalogIds = [
      "productivity.apple-notes",
      "productivity.apple-reminders",
      "productivity.things3",
      "productivity.bear",
      "productivity.trello",
      "productivity.notion",
      "productivity.github",
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
      expect(resolveIntegrationCatalogMaturity(entry)).toBe("beta");
      expect(resolveIntegrationCatalogRuntimeAvailability(entry)).toBe("runnable");
      expect(getIntegrationFormSchema(catalogId)?.fields.length).toBeGreaterThan(0);
      expect(entry.operatorActions?.length ?? 0).toBeGreaterThan(0);
      expect(entry.capabilities).toEqual(
        expect.arrayContaining((entry.operatorActions ?? []).map((action) => action.capability)),
      );
    }
  });

  it("lists only sign-in methods GoatCitadel implements for channels", () => {
    expect(byChannelKey("discord").authMethods).toEqual(["bot-token"]);
    expect(byChannelKey("whatsapp").authMethods).toEqual(["token"]);
    expect(byChannelKey("google-chat").authMethods).toEqual(["webhook", "service-account"]);
    expect(byChannelKey("teams").authMethods).toEqual(["webhook"]);
    expect(byChannelKey("slack").authMethods).toEqual(["oauth"]);
  });

  it("marks channels that receive messages as inbound-capable", () => {
    for (const key of ["slack", "telegram", "whatsapp", "line"]) {
      expect(byChannelKey(key).capabilities).toContain("inbound");
    }
  });

  it("advertises Notion search first, then read and the two governed writes, behind a token form", () => {
    const entry = requireCatalogEntry("productivity.notion");
    expect(entry.description).toBe(
      "Notion pages: search, read, create and append through an internal integration token.",
    );
    expect(entry.authMethods).toEqual(["token"]);
    expect((entry.operatorActions ?? []).map((action) => [action.actionId, action.capability])).toEqual([
      ["search", "read"],
      ["page_read", "read"],
      ["page_create", "write"],
      ["block_append", "write"],
    ]);
    const fields = getIntegrationFormSchema("productivity.notion")?.fields ?? [];
    expect(fields.map((field) => field.key)).toEqual(["label", "tokenEnv", "defaultParentPageId", "enabled"]);
    expect(fields.find((field) => field.key === "tokenEnv")).toMatchObject({
      required: true,
      secretRef: true,
      placeholder: "NOTION_INTEGRATION_TOKEN",
    });
  });

  it("advertises GitHub issue and pull request reads plus two governed writes behind a token form", () => {
    const entry = requireCatalogEntry("productivity.github");
    expect(entry.description).toBe(
      "GitHub issues and pull requests: list, read, create issues and comment through a fine-grained token.",
    );
    expect(entry.maturity).toBe("beta");
    expect(entry.authMethods).toEqual(["token"]);
    expect((entry.operatorActions ?? []).map((action) => [action.actionId, action.capability])).toEqual([
      ["issue_list", "read"],
      ["issue_read", "read"],
      ["pr_list", "read"],
      ["pr_read", "read"],
      ["issue_create", "write"],
      ["issue_comment", "write"],
    ]);
    const fields = getIntegrationFormSchema("productivity.github")?.fields ?? [];
    expect(fields.map((field) => field.key)).toEqual(["label", "tokenEnv", "defaultRepo", "enabled"]);
    expect(fields.find((field) => field.key === "tokenEnv")).toMatchObject({
      required: true,
      secretRef: true,
      placeholder: "GITHUB_INTEGRATION_TOKEN",
    });
    expect(fields.find((field) => field.key === "defaultRepo")).toMatchObject({ required: true });
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

function byChannelKey(key: string): IntegrationCatalogEntry {
  const entry = INTEGRATION_CATALOG.find((candidate) => candidate.kind === "channel" && candidate.key === key);
  if (!entry) {
    throw new Error(`Missing channel catalog entry: ${key}`);
  }
  return entry;
}
