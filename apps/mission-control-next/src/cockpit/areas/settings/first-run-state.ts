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
    modelReady: providerReady && modelConfigured,
    firstResponseVerified,
    firstResponseLabel: progress.firstResponseLabel,
    safeApprovalMode: state.settings.toolApprovalMode === "approve_all" || state.settings.toolApprovalMode === "approve_risky",
  };
}
