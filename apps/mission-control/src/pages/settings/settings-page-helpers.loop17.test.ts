import { describe, expect, it, vi } from "vitest";
import {
  getModelPreviewFallbackModel,
  resolveModelDraftHydration,
  resolveProviderModelSelection,
  resolveSettingsTabSection,
  scrollToSettingsSection,
} from "./settings-page-helpers";

describe("settings page helpers loop 17 branches", () => {
  it("resolves the primary section for every embedded settings tab", () => {
    expect(resolveSettingsTabSection("providers")).toBe("settings-models");
    expect(resolveSettingsTabSection("access")).toBe("settings-access");
    expect(resolveSettingsTabSection("runtime")).toBe("settings-voice");
    expect(resolveSettingsTabSection("budget")).toBe("settings-runtime");
    expect(resolveSettingsTabSection("general")).toBe("settings-overview");
  });

  it("guards DOM scrolling and falls back when model choices are blank or missing", () => {
    const originalDocument = globalThis.document;
    vi.stubGlobal("document", undefined);
    expect(() => scrollToSettingsSection("settings-models")).not.toThrow();
    vi.stubGlobal("document", originalDocument);

    expect(getModelPreviewFallbackModel("   ", "   ")).toBeUndefined();
    expect(resolveProviderModelSelection("missing", [], "orphan")).toBe("");
    expect(resolveModelDraftHydration(false, true, true)).toEqual({
      activeSelection: true,
      providerEditor: true,
    });
  });
});
