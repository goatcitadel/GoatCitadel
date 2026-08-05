import { describe, expect, it } from "vitest";
import {
  getChannelSetupDefinition,
  listChannelSetupDefinitions,
  requireChannelSetupDefinition,
} from "./channel-setup-definitions.js";
import {
  compactRecord,
  definitionFailures,
  hasAnyConfiguredSecret,
  inferDiscordConfigRuntimeMode,
  legacyTarget,
  looksLikeHttpUrl,
  malformedFieldIssue,
  normalizeSlackTargets,
  normalizeTargetArray,
  normalizeTelegramTargets,
  normalizeTelegramUsername,
  parseTargetsJson,
  requireCatalog,
  readLegacyString,
  readString,
  requiredFieldIssue,
  resolveDiscordRuntimeMode,
} from "./channel-setup-definitions/common.js";
import {
  buildPersonalityOverlay,
  getPersonalityPreset,
  listPersonalityPresets,
  normalizePersonalityId,
  PersonalityCatalogService,
} from "./channel-personalities.js";

describe("Loop 19 channel setup definition tails", () => {
  it("returns undefined for unknown optional lookups and throws for required unknown definitions", () => {
    expect(getChannelSetupDefinition("channel.unknown")).toBeUndefined();
    expect(() => requireChannelSetupDefinition("channel.unknown")).toThrow(
      "No channel setup definition is available for channel.unknown.",
    );
    expect(() => requireCatalog("channel.unknown")).toThrow("Missing integration catalog entry for channel.unknown.");
    expect(
      listChannelSetupDefinitions()
        .slice(0, 2)
        .map((item) => item.catalog.catalogId),
    ).toEqual(["channel.slack", "channel.telegram"]);
  });

  it("normalizes setup helper fallbacks for targets, secrets, and Discord runtime mode", () => {
    expect(readString({ value: " trimmed " }, "value")).toBe("trimmed");
    expect(readString({ value: "   " }, "value")).toBeUndefined();
    expect(definitionFailures("token")).toEqual([
      expect.objectContaining({ id: "token-credential_rejected" }),
      expect.objectContaining({ id: "token-permission_mismatch" }),
    ]);
    expect(definitionFailures("missing" as never)).toEqual([]);
    expect(parseTargetsJson("not json")).toEqual([]);
    expect(normalizeTargetArray([{ label: "missing address" }], "channel", "slack")).toEqual([]);
    expect(normalizeTargetArray("[]", "chatId", "telegram")).toEqual([]);
    expect(
      normalizeSlackTargets({
        targets: [{ id: "", label: "", channel: "#ops", default: false }],
      }),
    ).toEqual([
      {
        id: "slack-target-1",
        label: "#ops",
        channel: "#ops",
        threadTs: undefined,
        kind: undefined,
        default: true,
      },
    ]);
    expect(
      normalizeTelegramTargets({
        targets: [{ id: "", label: "", chatId: "12345", default: false }],
      }),
    ).toEqual([
      {
        id: "telegram-target-1",
        label: "12345",
        chatId: "12345",
        threadId: undefined,
        kind: undefined,
        default: true,
      },
    ]);
    expect(legacyTarget(undefined, "Default", "channel")).toEqual([]);
    expect(legacyTarget("#ops", "Slack default", "channel")).toEqual([
      { id: "default", label: "Slack default", channel: "#ops", default: true },
    ]);
    expect(legacyTarget("12345", "Telegram default", "chatId")).toEqual([
      { id: "default", label: "Telegram default", chatId: "12345", default: true },
    ]);
    expect(normalizeSlackTargets({ defaultChannel: "#ops" })).toEqual([
      { id: "default", label: "Slack default", channel: "#ops", default: true },
    ]);
    expect(normalizeTelegramTargets({ defaultChatId: "12345" })).toEqual([
      { id: "default", label: "Telegram default", chatId: "12345", default: true },
    ]);
    expect(normalizeTelegramUsername("goatcitadel")).toBe("@goatcitadel");
    expect(normalizeTelegramUsername("@goatcitadel")).toBe("@goatcitadel");
    expect(looksLikeHttpUrl("https://example.test")).toBe(true);
    expect(looksLikeHttpUrl("ftp://example.test")).toBe(false);
    expect(hasAnyConfiguredSecret({ tokenEnv: "TOKEN" }, [["token", "tokenEnv"]])).toBe(true);
    expect(compactRecord({ keep: " value ", empty: " ", missing: undefined, nil: null, count: 0 })).toEqual({
      keep: " value ",
      count: 0,
    });
    expect(resolveDiscordRuntimeMode({ lifecycleMode: "create", draft: { webhookUrl: "https://hook" } } as never)).toBe(
      "bridge",
    );
    expect(resolveDiscordRuntimeMode({ lifecycleMode: "edit", draft: {} } as never)).toBe("bridge");
    expect(resolveDiscordRuntimeMode({ lifecycleMode: "create", draft: { runtimeMode: "gateway" } } as never)).toBe(
      "gateway",
    );
    expect(inferDiscordConfigRuntimeMode({ token: "bot" })).toBe("gateway");
    expect(inferDiscordConfigRuntimeMode({ webhookUrl: "https://hook" })).toBe("bridge");
    expect(inferDiscordConfigRuntimeMode({})).toBe("bridge");
    expect(
      readLegacyString({ hydration: { rawLegacyConfig: { token: " legacy " } } } as never, "missing", "token"),
    ).toBe("legacy");
    expect(readLegacyString({ hydration: { rawLegacyConfig: [] } } as never, "token")).toBeUndefined();
    expect(requiredFieldIssue("token", "Token required")).toEqual(
      expect.objectContaining({ key: "token_required", failureCategory: "missing_input" }),
    );
    expect(malformedFieldIssue("url", "URL invalid")).toEqual(
      expect.objectContaining({ key: "url_malformed", failureCategory: "malformed_value" }),
    );
  });
});

describe("Loop 19 channel personality tails", () => {
  function createSettings(initial?: unknown) {
    let value = initial;
    return {
      get: () => (value === undefined ? undefined : { value }),
      set: (_key: string, next: unknown) => {
        value = next;
      },
    };
  }

  it("normalizes overlay ids, default fallbacks, and custom personality mutations", async () => {
    expect(normalizePersonalityId(" Neutral ")).toBe("default");
    expect(normalizePersonalityId("My Custom Voice!")).toBe("my-custom-voice");
    expect(getPersonalityPreset("missing").id).toBe("default");
    expect(buildPersonalityOverlay("default")).toBeUndefined();
    expect(buildPersonalityOverlay("technical")).toContain("Personality overlay:");
    expect(listPersonalityPresets().some((preset) => preset.id === "operator")).toBe(true);

    const service = new PersonalityCatalogService(
      createSettings({
        defaultPersonalityId: "missing",
        builtinOverrides: {
          technical: {
            id: "technical",
            label: " Technical Override ",
            category: "not-real",
            description: " Updated ",
            safetyNotes: [],
            updatedAt: "2026-05-14T00:00:00.000Z",
          },
          broken: "not-record",
        },
        customPresets: ["bad", { id: "custom voice", label: " Custom Voice ", safetyNotes: [" safe "] }],
      }) as never,
    );

    const catalog = await service.getCatalog();
    expect(catalog.defaultPersonalityId).toBe("default");
    expect(catalog.items.find((item) => item.id === "technical")).toMatchObject({
      label: "Technical Override",
      category: "core",
      modified: true,
    });
    expect(catalog.items.find((item) => item.id === "custom-voice")).toMatchObject({
      label: "Custom Voice",
      visibility: "custom",
      safetyNotes: ["safe"],
    });
    expect(await service.getDefaultPersonalityId()).toBe("default");
    expect(await service.buildDefaultChatPersonalityOverlay()).toBeUndefined();
  });

  it("keeps personality writes reviewable through explicit service calls", async () => {
    const service = new PersonalityCatalogService(createSettings() as never);

    await expect(service.setDefaultPersonality("missing")).rejects.toThrow("Unknown personality");
    await expect(service.createPersonality({ id: "default", label: "Default" })).rejects.toThrow(
      "Custom personality id cannot be default.",
    );

    const created = await service.createPersonality({
      label: "Incident Commander",
      category: "execution",
      systemOverlay: "Keep incident response terse.",
    });
    expect(created.items.find((item) => item.id === "incident-commander")).toMatchObject({
      category: "execution",
      visibility: "custom",
    });
    await expect(service.createPersonality({ id: "incident-commander", label: "Duplicate" })).rejects.toThrow(
      "already exists",
    );
    expect((await service.setDefaultPersonality("incident-commander")).defaultPersonalityId).toBe("incident-commander");
    expect(
      (
        await service.updatePersonality("incident-commander", {
          id: "incident-lead",
          label: "Incident Lead",
          category: "critical",
        })
      ).defaultPersonalityId,
    ).toBe("incident-lead");
    await service.createPersonality({ id: "second-custom", label: "Second Custom" });
    await expect(service.updatePersonality("incident-lead", { id: "technical" })).rejects.toThrow("already exists");
    await expect(service.updatePersonality("incident-lead", { id: "second-custom" })).rejects.toThrow("already exists");
    await expect(service.updatePersonality("missing", { label: "Missing" })).rejects.toThrow("Unknown personality");
    await expect(service.updatePersonality("default", { label: "Default" })).rejects.toThrow("cannot be edited");
    expect(
      (await service.updatePersonality("technical", { label: "Tech Voice" })).items.find(
        (item) => item.id === "technical",
      ),
    ).toMatchObject({
      label: "Tech Voice",
      modified: true,
    });
    expect((await service.deletePersonality("technical")).items.find((item) => item.id === "technical")?.modified).toBe(
      false,
    );
    expect((await service.deletePersonality("incident-lead")).defaultPersonalityId).toBe("default");
    await expect(service.deletePersonality("missing")).rejects.toThrow("Unknown personality");
    await expect(service.deletePersonality("default")).rejects.toThrow("cannot be removed");
  });
});
