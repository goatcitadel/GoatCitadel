import { describe, expect, it } from "vitest";
import { resolveUtilityModelOverride } from "./utility-model-routing.js";

const provider = { providerId: "glm", hasApiKey: true, defaultModel: "glm-5" };

describe("resolveUtilityModelOverride", () => {
  it("returns undefined when the flag is off", () => {
    expect(
      resolveUtilityModelOverride({
        flagEnabled: false,
        utilityProviderId: "glm",
        utilityModel: "glm-4-flash",
        provider,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no utility provider is configured", () => {
    expect(resolveUtilityModelOverride({ flagEnabled: true, provider })).toBeUndefined();
    expect(resolveUtilityModelOverride({ flagEnabled: true, utilityProviderId: "  ", provider })).toBeUndefined();
  });

  it("returns undefined when the provider is unknown or mismatched", () => {
    expect(
      resolveUtilityModelOverride({ flagEnabled: true, utilityProviderId: "glm", utilityModel: "x" }),
    ).toBeUndefined();
    expect(
      resolveUtilityModelOverride({
        flagEnabled: true,
        utilityProviderId: "glm",
        provider: { ...provider, providerId: "moonshot" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the provider has no API key", () => {
    expect(
      resolveUtilityModelOverride({
        flagEnabled: true,
        utilityProviderId: "glm",
        utilityModel: "glm-4-flash",
        provider: { ...provider, hasApiKey: false },
      }),
    ).toBeUndefined();
  });

  it("returns the configured utility model when all preconditions hold", () => {
    expect(
      resolveUtilityModelOverride({
        flagEnabled: true,
        utilityProviderId: "glm",
        utilityModel: "glm-4-flash",
        provider,
      }),
    ).toEqual({ providerId: "glm", model: "glm-4-flash" });
  });

  it("falls back to the provider default model when no utility model is set", () => {
    expect(resolveUtilityModelOverride({ flagEnabled: true, utilityProviderId: "glm", provider })).toEqual({
      providerId: "glm",
      model: "glm-5",
    });
  });

  it("returns undefined when neither a utility model nor a default model exists", () => {
    expect(
      resolveUtilityModelOverride({
        flagEnabled: true,
        utilityProviderId: "glm",
        provider: { ...provider, defaultModel: "" },
      }),
    ).toBeUndefined();
  });
});
