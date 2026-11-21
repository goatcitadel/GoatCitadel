import { NotFoundError } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { AutomaticBackgroundBudget } from "./automatic-background-budget.js";
import { estimateBackgroundReviewReservation } from "./background-review-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { BackgroundLearningDestination, BackgroundLearningReadiness } from "@goatcitadel/contracts";

export interface BackgroundLearningReadinessDeps {
  readConfiguration(): Promise<{
    autonomyEnabled: boolean;
    memoryEnabled: boolean;
    memoryAdministrationEnabled: boolean;
    skillDraftsEnabled: boolean;
    maintenanceEnabled: boolean;
    memoryReasonCode?: string;
    skillReasonCode?: string;
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
  const result: BackgroundLearningReadiness = {
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
    result.memory =
      config.memoryEnabled && config.memoryAdministrationEnabled
        ? ready
        : { ...disabled, ...(config.memoryReasonCode ? { reasonCode: config.memoryReasonCode } : {}) };
    result.skill = config.skillDraftsEnabled
      ? ready
      : { ...disabled, ...(config.skillReasonCode ? { reasonCode: config.skillReasonCode } : {}) };
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

interface BackgroundLearningRuntimeDeps {
  storage: Pick<
    AsyncStorage,
    "chatSessionPrefs" | "sessions" | "chatSessionMeta" | "costLedger" | "modelUsageEvents" | "backgroundLearningJobs"
  >;
  readFeatureFlags(): Promise<
    Pick<
      RuntimeSettings["features"],
      | "autonomyV1Disabled"
      | "memoryLifecycleAdminV1Enabled"
      | "backgroundSkillDraftsV1Enabled"
      | "memoryMaintenanceV1Enabled"
    >
  >;
  memoryEnabled(): boolean;
  readBudgets(): { dailyUsdHardCap: number; sessionTokenHardCap: number };
  readAutomaticBudget: AutomaticBackgroundBudget["snapshot"];
  resolveModel(passive: boolean): Promise<{ providerId: string; model: string } | undefined>;
  isReplayScratchSession(sessionId: string): Promise<boolean>;
}

export class BackgroundLearningReadinessRuntime {
  public constructor(private readonly deps: BackgroundLearningRuntimeDeps) {}

  public async readDestinations(input: { sessionId: string }) {
    const [flags, prefs] = await Promise.all([
      this.deps.readFeatureFlags(),
      this.deps.storage.chatSessionPrefs.get(input.sessionId),
    ]);
    const allowed = !flags.autonomyV1Disabled && prefs?.memoryMode !== "off";
    const memory = allowed && this.deps.memoryEnabled() && flags.memoryLifecycleAdminV1Enabled;
    return {
      memory,
      skill: allowed && flags.backgroundSkillDraftsV1Enabled === true,
      maintenance: memory && flags.memoryMaintenanceV1Enabled,
      memoryReasonCode:
        prefs?.memoryMode === "off"
          ? "session_memory_off"
          : !this.deps.memoryEnabled()
            ? "memory_disabled"
            : !flags.memoryLifecycleAdminV1Enabled
              ? "memory_administration_disabled"
              : undefined,
      skillReasonCode: prefs?.memoryMode === "off" ? "session_memory_off" : undefined,
    };
  }

  public async readSettings() {
    const [budget, model, disabled] = await Promise.all([
      this.deps.readAutomaticBudget(),
      this.deps.resolveModel(true),
      this.deps.readFeatureFlags().then((flags) => flags.autonomyV1Disabled),
    ]);
    const paidAllowanceUsed = budget.spentUsd + budget.reservedUsd >= budget.limitUsd;
    return {
      ...budget,
      model,
      reason: disabled
        ? "autonomy_disabled"
        : !model
          ? "provider_unavailable"
          : paidAllowanceUsed
            ? "background_budget_exhausted"
            : undefined,
    };
  }

  public async resolve(input: { workspaceId: string; sessionId: string }, options?: { passive?: boolean }) {
    const resolveModel = () => this.deps.resolveModel(options?.passive === true);
    return await resolveBackgroundLearningReadiness(
      {
        readConfiguration: async () => {
          const flags = await this.deps.readFeatureFlags();
          const destination = await this.readDestinations(input);
          return {
            autonomyEnabled: !flags.autonomyV1Disabled,
            memoryEnabled: destination.memory,
            memoryAdministrationEnabled: flags.memoryLifecycleAdminV1Enabled,
            skillDraftsEnabled: destination.skill,
            maintenanceEnabled: destination.maintenance,
            memoryReasonCode: destination.memoryReasonCode,
            skillReasonCode: destination.skillReasonCode,
          };
        },
        sourceEligible: async ({ workspaceId, sessionId }) => {
          try {
            const [session, meta] = await Promise.all([
              this.deps.storage.sessions.getBySessionId(sessionId),
              this.deps.storage.chatSessionMeta.get(sessionId),
            ]);
            return (
              session.kind === "dm" &&
              meta?.workspaceId === workspaceId &&
              meta.origin === "operator" &&
              meta.lifecycleStatus === "active" &&
              !(await this.deps.isReplayScratchSession(sessionId))
            );
          } catch (error) {
            if (error instanceof NotFoundError) return false;
            throw error;
          }
        },
        providerReady: async () => Boolean(await resolveModel()),
        budgetReady: async ({ sessionId }) => {
          const cap = this.deps.readBudgets();
          if (!(cap.dailyUsdHardCap > 0) || !(cap.sessionTokenHardCap > 0))
            return { ready: false, reasonCode: "budget_exhausted" };
          const defaults = await resolveModel();
          const price = defaults
            ? estimateBackgroundReviewReservation({
                stage: "memory",
                userText: "",
                assistantText: "",
                ...defaults,
                dailyCostCeilingUsd: cap.dailyUsdHardCap,
              })
            : undefined;
          if (!price) return { ready: false, reasonCode: "pricing_unavailable" };
          const now = new Date().toISOString(),
            from = `${now.slice(0, 10)}T00:00:00.000Z`;
          const [days, availability, session, reservations, automatic] = await Promise.all([
            this.deps.storage.costLedger.summary("day", from, now),
            this.deps.storage.costLedger.usageAvailability(from, now),
            this.deps.storage.modelUsageEvents.list({ sessionId, limit: 1 }),
            this.deps.storage.backgroundLearningJobs.readBudgetSnapshot(now),
            this.deps.readAutomaticBudget(),
          ]);
          if (
            price.reservedCostUsd > 0 &&
            automatic.spentUsd + automatic.reservedUsd + price.reservedCostUsd > automatic.limitUsd
          ) {
            return { ready: false, reasonCode: "background_budget_exhausted" };
          }
          const usage = session.summary;
          if (
            (availability.totalAgentEvents > 0 && !availability.metricAvailability.costUsd.complete) ||
            usage.uncertainDispatchCount > 0 ||
            (usage.attemptCount > 0 &&
              (!usage.metricAvailability.inputTokens.complete || !usage.metricAvailability.outputTokens.complete))
          )
            return { ready: false, reasonCode: "usage_unknown" };
          const spent = days.reduce((total, day) => total + day.costUsd, 0),
            tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
          return Math.max(spent, reservations.spentCostUsd) + reservations.reservedCostUsd + price.reservedCostUsd <=
            cap.dailyUsdHardCap && tokens + 6400 <= cap.sessionTokenHardCap
            ? { ready: true }
            : {
                ready: false,
                reasonCode: reservations.unsettledOperations > 0 ? "budget_reserved" : "budget_exhausted",
              };
        },
      },
      input,
    );
  }
}
