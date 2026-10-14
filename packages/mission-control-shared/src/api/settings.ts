import type { OnboardingState } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "./types.js";
import { request } from "./client-core.js";

export async function fetchSettings(options: { signal?: AbortSignal } = {}): Promise<RuntimeSettingsResponse> {
  return request<RuntimeSettingsResponse>(
    "/api/v1/settings",
    options.signal ? { signal: options.signal, cache: "no-store" } : undefined,
  );
}

export async function fetchOnboardingState(options: { signal?: AbortSignal } = {}): Promise<OnboardingState> {
  return request<OnboardingState>(
    "/api/v1/onboarding/state",
    options.signal ? { signal: options.signal, cache: "no-store" } : undefined,
  );
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  fetchDeviceAccessGrants,
  revokeDeviceAccessGrant,
  bootstrapOnboarding,
  completeOnboarding,
  resolveGatewayInstallToken,
  patchSettings,
  patchGatewayAuthSettings,
  fetchPersonalities,
  createPersonality,
  updatePersonality,
  deletePersonality,
  setDefaultPersonality,
} from "./settings-operations.js";
