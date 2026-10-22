import type { OnboardingState } from "@goatcitadel/contracts";
import { describeToolApprovalMode } from "../../../features/native-routes/settings/helpers/permission-helpers";

/**
 * "Model · Provider", the same order as the model labels elsewhere, or a plain statement when no default model is
 * confirmed yet. The provider shows by its saved name, never its ID.
 */
export function firstRunModelSummary(state: OnboardingState) {
  const llm = state.settings?.llm;
  const model = llm?.activeModel?.trim();
  if (!llm?.activeProviderId || !model) return "No model confirmed";
  const provider = llm.providers.find((item) => item.providerId === llm.activeProviderId)?.label?.trim();
  return provider ? `${model} · ${provider}` : model;
}

/** The current tool approval rule in words, for a done safety step. */
export function firstRunSafetySummary(state: OnboardingState) {
  return `Tool approval: ${describeToolApprovalMode(state.settings.toolApprovalMode)}`;
}
