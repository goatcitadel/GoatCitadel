import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveEffectiveEffectsMode, shouldUseReducedEffects } from "./effects-mode";

describe("effects mode resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("honors explicit effects modes and defaults to full without browser signals", () => {
    vi.stubGlobal("window", undefined);
    expect(resolveEffectiveEffectsMode("full")).toBe("full");
    expect(resolveEffectiveEffectsMode("reduced")).toBe("reduced");
    expect(shouldUseReducedEffects()).toBe(false);
    expect(resolveEffectiveEffectsMode("auto")).toBe("full");
  });

  it("reduces effects for reduced-motion preference, low CPU, and low memory signals", () => {
    vi.stubGlobal("window", { matchMedia: vi.fn(() => ({ matches: true })) });
    vi.stubGlobal("navigator", { hardwareConcurrency: 16, deviceMemory: 32 });
    expect(shouldUseReducedEffects()).toBe(true);
    expect(resolveEffectiveEffectsMode("auto")).toBe("reduced");

    vi.stubGlobal("window", { matchMedia: vi.fn(() => ({ matches: false })) });
    vi.stubGlobal("navigator", { hardwareConcurrency: 4, deviceMemory: 32 });
    expect(shouldUseReducedEffects()).toBe(true);

    vi.stubGlobal("navigator", { hardwareConcurrency: 8, deviceMemory: 8 });
    expect(shouldUseReducedEffects()).toBe(true);

    vi.stubGlobal("navigator", { hardwareConcurrency: 8, deviceMemory: 16 });
    expect(shouldUseReducedEffects()).toBe(false);
  });
});
