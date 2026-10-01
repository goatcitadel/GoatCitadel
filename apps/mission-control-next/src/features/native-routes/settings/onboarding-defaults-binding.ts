import { canonicalJsonString, type OnboardingState, type OnboardingBootstrapInput } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { splitCommaList } from "./helpers/input-format";

export interface OnboardingDefaultsDraft {
  toolApprovalMode: OnboardingState["settings"]["toolApprovalMode"];
  budgetMode: OnboardingState["settings"]["budgetMode"];
  networkAllowlist: string;
}
export const ONBOARDING_DEFAULTS_CONSEQUENCE =
  "These installation-wide defaults update tool approvals, budget mode and outbound hosts, and turn off loopback auth bypass. Local clients must satisfy the configured authentication mode. This does not finish setup or run a model.";
export function onboardingDefaultsDraft(state?: OnboardingState): OnboardingDefaultsDraft {
  return {
    toolApprovalMode: state?.settings?.toolApprovalMode ?? "approve_all",
    budgetMode: state?.settings?.budgetMode ?? "balanced",
    networkAllowlist: state?.settings?.networkAllowlist?.join(", ") ?? "",
  };
}
export function onboardingDefaultsInput(draft: OnboardingDefaultsDraft, revision: number): OnboardingBootstrapInput {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !["approve_all", "approve_risky", "bypass"].includes(draft.toolApprovalMode) ||
    !["saver", "balanced", "power"].includes(draft.budgetMode)
  )
    throw new Error("Load valid current defaults before reviewing a change.");
  return {
    expectedRevision: revision,
    toolApprovalMode: draft.toolApprovalMode,
    budgetMode: draft.budgetMode,
    networkAllowlist: splitCommaList(draft.networkAllowlist),
    auth: { allowLoopbackBypass: false },
  };
}
export function defaultsOwnerBinding(state: OnboardingState, runtime: RuntimeSettingsResponse): string {
  if (
    !state.settings?.auth ||
    !runtime.auth ||
    state.settings.revision !== runtime.revision ||
    !Number.isSafeInteger(runtime.revision) ||
    runtime.revision < 1 ||
    state.settings.toolApprovalMode !== runtime.toolApprovalMode ||
    state.settings.budgetMode !== runtime.budgetMode ||
    canonicalJsonString(state.settings.networkAllowlist) !== canonicalJsonString(runtime.networkAllowlist) ||
    state.settings.auth.mode !== runtime.auth.mode ||
    state.settings.auth.allowLoopbackBypass !== runtime.auth.allowLoopbackBypass
  )
    throw new Error("Settings reads disagree. Refresh the current Gateway defaults before reviewing them.");
  return canonicalJsonString({
    settings: state.settings,
    deploymentProfile: runtime.deploymentProfile,
    completed: state.completed,
    completedAt: state.completedAt,
    completedBy: state.completedBy,
  });
}
export function defaultsReceiptMatches(
  before: OnboardingState,
  saved: OnboardingState,
  input: OnboardingBootstrapInput,
): boolean {
  const comparable = (state: OnboardingState) => ({
    ...state.settings,
    auth: {
      mode: state.settings.auth.mode,
      allowLoopbackBypass: state.settings.auth.allowLoopbackBypass,
      tokenConfigured: state.settings.auth.tokenConfigured,
      basicConfigured: state.settings.auth.basicConfigured,
    },
  });
  return (
    canonicalJsonString(comparable(saved)) ===
      canonicalJsonString({
        ...comparable(before),
        revision: input.expectedRevision + 1,
        toolApprovalMode: input.toolApprovalMode,
        budgetMode: input.budgetMode,
        networkAllowlist: input.networkAllowlist,
        auth: { ...comparable(before).auth, allowLoopbackBypass: false },
      }) &&
    before.completed === saved.completed &&
    before.completedAt === saved.completedAt &&
    before.completedBy === saved.completedBy
  );
}
