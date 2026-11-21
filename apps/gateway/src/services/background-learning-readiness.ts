import type { BackgroundLearningDestination, BackgroundLearningReadiness } from "@goatcitadel/contracts";

export interface BackgroundLearningReadinessDeps {
  readConfiguration(): Promise<{
    autonomyEnabled: boolean;
    memoryEnabled: boolean;
    memoryAdministrationEnabled: boolean;
    skillDraftsEnabled: boolean;
    maintenanceEnabled: boolean;
    memoryReasonCode?:string;
    skillReasonCode?:string;
  }>;
  sourceEligible(input: { workspaceId: string; sessionId: string }): Promise<boolean>;
  providerReady(): Promise<boolean>;
  budgetReady(input: { workspaceId: string; sessionId: string }): Promise<{ ready: boolean; reasonCode?: string }>;
}
const ready: BackgroundLearningDestination = { state: "ready" };
export async function resolveBackgroundLearningReadiness(
  deps: BackgroundLearningReadinessDeps,
  input: { workspaceId: string; sessionId: string },
): Promise<BackgroundLearningReadiness> {
  const disabled: BackgroundLearningDestination = { state: "disabled", reasonCode: "feature_disabled" };
  let result: BackgroundLearningReadiness = {
    source: { state: "unavailable", reasonCode: "not_checked" },
    provider: { state: "unavailable", reasonCode: "not_checked" },
    budget: { state: "unavailable", reasonCode: "not_checked" },
    memory: disabled,
    skill: disabled,
    maintenance: disabled,
    canExtractMemory: false,
    canDraftSkill: false,
    canEvaluateMaintenance: false,
  };
  try {
    const config = await deps.readConfiguration();
    result.memory = config.memoryEnabled && config.memoryAdministrationEnabled ? ready : {...disabled,...(config.memoryReasonCode ? {reasonCode:config.memoryReasonCode}: {})};
    result.skill = config.skillDraftsEnabled ? ready : {...disabled,...(config.skillReasonCode ? {reasonCode:config.skillReasonCode}: {})};
    result.maintenance =
      config.memoryEnabled && config.memoryAdministrationEnabled && config.maintenanceEnabled ? ready : disabled;
    if (!config.autonomyEnabled) return { ...result, source: { state: "blocked", reasonCode: "autonomy_disabled" } };
    if (![result.memory, result.skill, result.maintenance].some((destination) => destination.state === "ready"))
      return result;
    result.source =
      input.workspaceId.trim() && input.sessionId.trim() && (await deps.sourceEligible(input))
        ? ready
        : { state: "blocked", reasonCode: "source_ineligible" };
    if (result.source.state !== "ready") return result;
    result.provider = (await deps.providerReady())
      ? ready
      : { state: "unavailable", reasonCode: "provider_unavailable" };
    if (result.provider.state !== "ready") return result;
    const budget = await deps.budgetReady(input);
    result.budget = budget.ready ? ready : { state: "blocked", reasonCode: budget.reasonCode ?? "budget_unavailable" };
    if (!budget.ready) return result;
    return {
      ...result,
      canExtractMemory: result.memory.state === "ready",
      canDraftSkill: result.skill.state === "ready",
      canEvaluateMaintenance: result.maintenance.state === "ready",
    };
  } catch {
    return {
      ...result,
      source: { state: "unavailable", reasonCode: "readiness_unavailable" },
      canExtractMemory: false,
      canDraftSkill: false,
      canEvaluateMaintenance: false,
    };
  }
}
