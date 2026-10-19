import type { OnboardingState } from "@goatcitadel/contracts";
import { describeToolApprovalMode } from "../../../features/native-routes/settings/helpers/permission-helpers";

/** "Provider · model", or a plain statement when no default model is confirmed yet. */
export function firstRunModelSummary(state: OnboardingState) {
  const llm = state.settings?.llm;
  const label = llm?.providers.find((item) => item.providerId === llm.activeProviderId)?.label ?? llm?.activeProviderId;
  return label && llm?.activeModel ? `${label} · ${llm.activeModel}` : "No model confirmed";
}

/** The current tool approval rule in words, for a done safety step. */
export function firstRunSafetySummary(state: OnboardingState) {
  return `Tool approval: ${describeToolApprovalMode(state.settings.toolApprovalMode)}`;
}
