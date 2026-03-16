import { describe, expect, it } from "vitest";
import {
  buildProviderScopedModelOptions,
  getModelPreviewFallbackModel,
  resolveAuthStorageMode,
  resolveModelDraftHydration,
  resolveProviderModelSelection,
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
});
