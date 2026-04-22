export type UiEffectsMode = "auto" | "full" | "reduced";
export type EffectiveUiEffectsMode = "full" | "reduced";

export function resolveEffectiveEffectsMode(mode: UiEffectsMode): EffectiveUiEffectsMode {
  if (mode === "full" || mode === "reduced") {
    return mode;
  }
  return shouldUseReducedEffects() ? "reduced" : "full";
}

export function shouldUseReducedEffects(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return true;
  }

  const hardwareConcurrency = typeof navigator.hardwareConcurrency === "number"
    ? navigator.hardwareConcurrency
    : undefined;
  if (typeof hardwareConcurrency === "number" && hardwareConcurrency <= 4) {
    return true;
  }

  const navigatorWithDeviceMemory = navigator as Navigator & { deviceMemory?: number };
  const deviceMemory = typeof navigatorWithDeviceMemory.deviceMemory === "number"
    ? navigatorWithDeviceMemory.deviceMemory
    : undefined;
  if (typeof deviceMemory === "number" && deviceMemory <= 8) {
    return true;
  }

  return false;
}
