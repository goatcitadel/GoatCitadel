/** Settings + onboarding domain slice. Pure re-exports from client.ts. */
export {
  fetchSettings,
  patchSettings,
  fetchOnboardingState,
  bootstrapOnboarding,
  completeOnboarding,
  resolveGatewayInstallToken,
  fetchDeviceAccessGrants,
  revokeDeviceAccessGrant,
} from "./client.js";
