import { describe, expect, it } from "vitest";
import { buildVoiceRecoveryActions } from "@goatcitadel/contracts";
import {
  buildProviderScopedModelOptions,
  getModelPreviewFallbackModel,
  resolveSettingsTabSections,
  resolveAuthStorageMode,
  resolveModelDraftHydration,
  resolveProviderModelSelection,
  shouldRenderSettingsPageChrome,
} from "./SettingsPage";

describe("SettingsPage auth storage mode", () => {
  it("forces session mode when auth mode is none", () => {
    expect(resolveAuthStorageMode("none", true)).toBe("session");
    expect(resolveAuthStorageMode("none", false)).toBe("session");
  });

  it("uses persistent mode only when remember credentials is enabled", () => {
    expect(resolveAuthStorageMode("token", false)).toBe("session");
    expect(resolveAuthStorageMode("basic", false)).toBe("session");
    expect(resolveAuthStorageMode("token", true)).toBe("persistent");
    expect(resolveAuthStorageMode("basic", true)).toBe("persistent");
  });
});

describe("SettingsPage model selection helpers", () => {
  const providers = [
    {
      providerId: "openai",
      defaultModel: "gpt-4.1-mini",
      models: ["gpt-4.1-mini", "gpt-4.1"],
    },
    {
      providerId: "glm",
      defaultModel: "glm-5",
      models: ["glm-5", "glm-5-air"],
    },
  ];

  it("builds model options only for the selected provider", () => {
    const options = buildProviderScopedModelOptions({
      providerId: "glm",
      providers,
      previewedProviderId: "glm",
      previewedModels: ["glm-5-turbo"],
      currentModel: "glm-5-turbo",
    });

    expect(options.map((option) => option.value)).toEqual(["glm-5", "glm-5-air", "glm-5-turbo"]);
  });

  it("prefers the currently selected model for preview fallback", () => {
    expect(getModelPreviewFallbackModel("glm-5-turbo", "glm-5")).toBe("glm-5-turbo");
    expect(getModelPreviewFallbackModel("", "glm-5")).toBe("glm-5");
  });

  it("resolves provider changes to a valid model for that provider", () => {
    expect(resolveProviderModelSelection("glm", providers, "gpt-4.1")).toBe("glm-5");
    expect(resolveProviderModelSelection("glm", providers, "glm-5-air")).toBe("glm-5-air");
  });

  it("preserves unsaved model drafts during background refresh hydration", () => {
    expect(resolveModelDraftHydration(true, true, false)).toEqual({
      activeSelection: false,
      providerEditor: false,
    });
    expect(resolveModelDraftHydration(true, false, true)).toEqual({
      activeSelection: true,
      providerEditor: false,
    });
    expect(resolveModelDraftHydration(false, true, true)).toEqual({
      activeSelection: true,
      providerEditor: true,
    });
  });

  it("groups shared settings sections by top-level tab", () => {
    expect(resolveSettingsTabSections("general")).toEqual(["settings-overview"]);
    expect(resolveSettingsTabSections("providers")).toEqual(["settings-models", "settings-tests"]);
    expect(resolveSettingsTabSections("access")).toEqual(["settings-access"]);
    expect(resolveSettingsTabSections("budget")).toEqual(["settings-runtime"]);
    expect(resolveSettingsTabSections("runtime")).toEqual(["settings-voice", "settings-runtime"]);
  });

  it("suppresses full-page chrome when a settings tab is embedded in another hub", () => {
    expect(shouldRenderSettingsPageChrome()).toBe(true);
    expect(shouldRenderSettingsPageChrome("runtime")).toBe(false);
    expect(shouldRenderSettingsPageChrome("providers")).toBe(false);
  });
});

describe("SettingsPage voice recovery helpers", () => {
  it("prioritizes runtime repair when the managed runtime is missing", () => {
    expect(buildVoiceRecoveryActions({
      stt: {
        provider: "whisper.cpp",
        state: "stopped",
        runtimeReady: false,
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
      talk: {
        state: "stopped",
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
      wake: {
        enabled: false,
        state: "stopped",
        model: "openwakeword",
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
    }, {
      provider: "whisper.cpp",
      source: "managed",
      readiness: "missing",
      binaryReady: false,
      ffmpegReady: false,
      installedModels: [],
      catalog: [],
    })[0]).toMatchObject({
      id: "repair-runtime",
      tone: "critical",
    });
  });

  it("offers installed-model activation when runtime is ready without a selected model", () => {
    expect(buildVoiceRecoveryActions({
      stt: {
        provider: "whisper.cpp",
        state: "stopped",
        runtimeReady: true,
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
      talk: {
        state: "stopped",
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
      wake: {
        enabled: false,
        state: "stopped",
        model: "openwakeword",
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
    }, {
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      ffmpegReady: true,
      installedModels: [{
        modelId: "base.en",
        filePath: "/tmp/base.en.bin",
        sizeBytes: 1,
        active: false,
      }],
      catalog: [],
    })).toContainEqual(expect.objectContaining({
      id: "activate-installed-model",
      modelId: "base.en",
      tone: "warning",
    }));
  });

  it("adds talk and wake cleanup actions when operator state is still active", () => {
    expect(buildVoiceRecoveryActions({
      stt: {
        provider: "whisper.cpp",
        state: "stopped",
        runtimeReady: true,
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
      talk: {
        activeSessionId: "talk-123",
        state: "running",
        mode: "push_to_talk",
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
      wake: {
        enabled: true,
        state: "running",
        model: "openwakeword",
        updatedAt: "2026-03-30T00:00:00.000Z",
      },
    }, {
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      ffmpegReady: true,
      selectedModelId: "base.en",
      installedModels: [{
        modelId: "base.en",
        filePath: "/tmp/base.en.bin",
        sizeBytes: 1,
        active: true,
      }],
      catalog: [],
    }).map((action) => action.id)).toEqual([
      "stop-talk-session",
      "stop-wake-listener",
    ]);
  });
});
