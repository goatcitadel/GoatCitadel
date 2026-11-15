import type { OnboardingState } from "@goatcitadel/contracts";
import { deriveSetupProgress } from "@goatcitadel/mission-control-shared/content/setup-progress";

export function projectFirstRunState(state: OnboardingState) {
  const providerReadiness = state.setupReadiness?.items.find((item) => item.id === "provider");
  const providerReady = providerReadiness?.status === "ready";
  const modelConfigured = Boolean(state.settings?.llm?.activeProviderId && state.settings?.llm?.activeModel);
  const firstResponseVerified = state.firstTask?.status === "verified";
  const progress = deriveSetupProgress({ providerReady, defaultPlanCompleted: modelConfigured, firstResponseVerified });
  return {
    providerReady,
    /** False when the readiness list did not include a provider item: not known, which is not the same as not ready. */
    providerReadinessReported: providerReadiness !== undefined,
    modelConfigured,
    modelReady: providerReady && modelConfigured,
    firstResponseVerified,
    firstResponseLabel: progress.firstResponseLabel,
    safeApprovalMode:
      state.settings.toolApprovalMode === "approve_all" || state.settings.toolApprovalMode === "approve_risky",
  };
}
