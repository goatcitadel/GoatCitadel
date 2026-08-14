import {
  ConflictError,
  SemanticValidationError,
  type ChatChangePlanInstallationDefaultModelRequest,
  type ChatChangePlanSessionModelRequest,
  type ChatCompletionReasoningEffort,
  type ChatSessionPrefsPatch,
  type ChatSessionPrefsRecord,
  type ChatThinkingLevel,
  type ChangePlanRecord,
  type LlmModelReasoningMetadata,
  type LlmModelRecord,
  type LlmProviderSummary,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { UpdateSettingsInput } from "./settings-auth-service.js";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
} from "./evolution-control-plane-adapter.js";

type ModelChangeRequest = ChatChangePlanSessionModelRequest | ChatChangePlanInstallationDefaultModelRequest;

export interface ModelChangePlanAdapterDependencies {
  readonly getChatSessionPrefs: (sessionId: string) => Promise<ChatSessionPrefsRecord>;
  readonly updateChatSessionPrefs: (sessionId: string, input: ChatSessionPrefsPatch) => Promise<ChatSessionPrefsRecord>;
  readonly getSettings: () => Promise<RuntimeSettings>;
  readonly updateSettings: (input: UpdateSettingsInput) => Promise<RuntimeSettings>;
  readonly listModels: (providerId: string) => Promise<readonly LlmModelRecord[]>;
  readonly getModelReasoningMetadata: (providerId: string, model: string) => LlmModelReasoningMetadata | undefined;
}

export class ModelChangePlanAdapter implements EvolutionControlPlaneAdapter<ModelChangeRequest> {
  public readonly adapterId = "model-selection";
  public readonly version = 1;
  public readonly kinds = ["session_model", "installation_default_model"] as const;

  public constructor(private readonly deps: ModelChangePlanAdapterDependencies) {}

  public async prepare(context: EvolutionControlPlaneAdapterContext, request: ModelChangeRequest) {
    if (request.kind === "session_model") {
      const sessionId = requireSessionId(context);
      const prefs = await this.deps.getChatSessionPrefs(sessionId);
      const settings = await this.deps.getSettings();
      const providerId = request.providerId ?? prefs.providerId ?? settings.llm.activeProviderId;
      const model = request.model ?? prefs.model ?? settings.llm.activeModel;
      const provider = requireReadyProvider(settings.llm.providers, providerId);
      await this.assertSelection(provider, model, request.thinkingLevel);
      const effort = request.thinkingLevel ? ` with ${request.thinkingLevel} effort` : "";
      return {
        target: { ownerId: "chat_session_prefs", resourceId: sessionId, expectedRevision: prefs.revision },
        title: `Use ${model} in this chat`,
        summary: `Switch only this conversation to ${provider.label} / ${model}${effort}.`,
        impact:
          "The current Chat changes immediately after confirmation. Future chats keep their installation default.",
        risk: "safe" as const,
        status: "awaiting_confirmation" as const,
        requiredAction: context.actions.confirmation({
          title: "Confirm current Chat model",
          confirmationText: `Use ${provider.label} / ${model}${effort} only in this Chat.`,
        }),
      };
    }

    const settings = await this.deps.getSettings();
    const provider = requireReadyProvider(settings.llm.providers, request.providerId);
    await this.assertSelection(provider, request.model, request.thinkingLevel);
    const effort = request.thinkingLevel ? ` with ${request.thinkingLevel} effort` : "";
    return {
      target: { ownerId: "runtime_settings", resourceId: "llm_defaults", expectedRevision: settings.revision },
      title: `Make ${request.model} the default`,
      summary: `Set ${provider.label} / ${request.model}${effort} as the default for future chats.`,
      impact: "Only Chat sessions created after this plan completes inherit the new provider, model, and effort.",
      risk: "safe" as const,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({
        title: "Confirm future Chat default",
        confirmationText: `Make ${provider.label} / ${request.model}${effort} the default for future Chats.`,
      }),
    };
  }

  public async apply(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    if (plan.request.kind === "session_model") {
      const sessionId = plan.origin.sessionId;
      if (!sessionId) throw new Error("Session model Change Plan lost its Chat session binding.");
      const current = await this.deps.getChatSessionPrefs(sessionId);
      assertTargetRevision(plan, current.revision);
      const settings = await this.deps.getSettings();
      const providerId = plan.request.providerId ?? current.providerId ?? settings.llm.activeProviderId;
      const model = plan.request.model ?? current.model ?? settings.llm.activeModel;
      const provider = requireReadyProvider(settings.llm.providers, providerId);
      await this.assertSelection(provider, model, plan.request.thinkingLevel);
      const updated = await this.deps.updateChatSessionPrefs(sessionId, {
        providerId,
        model,
        ...(plan.request.thinkingLevel ? { thinkingLevel: plan.request.thinkingLevel } : {}),
        expectedRevision: current.revision,
      });
      return {
        status: "verifying",
        evidenceRefs: [`chat_session:${sessionId}:revision:${updated.revision}`],
        result: {
          summary: `This Chat now uses ${provider.label} / ${model}${plan.request.thinkingLevel ? ` at ${plan.request.thinkingLevel} effort` : ""}.`,
          appliedRevision: updated.revision,
        },
      };
    }

    if (plan.request.kind !== "installation_default_model") throw new Error("Model Change Plan kind drifted.");
    const current = await this.deps.getSettings();
    assertTargetRevision(plan, current.revision);
    const provider = requireReadyProvider(current.llm.providers, plan.request.providerId);
    await this.assertSelection(provider, plan.request.model, plan.request.thinkingLevel);
    const updated = await this.deps.updateSettings({
      expectedRevision: current.revision,
      llm: {
        activeProviderId: provider.providerId,
        activeModel: plan.request.model,
        ...(plan.request.thinkingLevel ? { defaultThinkingLevel: plan.request.thinkingLevel } : {}),
      },
    });
    return {
      status: "verifying",
      evidenceRefs: [`runtime_settings:llm:revision:${updated.revision}`],
      result: {
        summary: `${provider.label} / ${plan.request.model}${plan.request.thinkingLevel ? ` at ${plan.request.thinkingLevel} effort` : ""} is now the default for future Chats.`,
        appliedRevision: updated.revision,
      },
    };
  }

  public async verify(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const observed = await this.observeApplied(plan);
    if (!observed.applied) {
      return {
        status: "manual_required",
        result: { summary: observed.reason, failureCode: "owner_verification_failed" },
      };
    }
    return {
      status: "completed",
      evidenceRefs: observed.evidenceRefs,
      result: plan.result ?? { summary: "The selected model configuration is active." },
    };
  }

  public async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const observed = await this.observeApplied(plan);
    if (observed.applied) {
      return {
        effectObserved: true,
        status: "completed" as const,
        evidenceRefs: observed.evidenceRefs,
        result: plan.result ?? { summary: "Owner state proves the selected model configuration is active." },
      };
    }
    return {
      effectObserved: false,
      status: "manual_required" as const,
      result: {
        summary: `${observed.reason} The Gateway did not replay the model change during recovery.`,
        failureCode: "ambiguous_recovery",
      },
    };
  }

  private async observeApplied(
    plan: ChangePlanRecord,
  ): Promise<{ applied: boolean; reason: string; evidenceRefs: readonly string[] }> {
    if (plan.request.kind === "session_model") {
      const sessionId = plan.origin.sessionId;
      if (!sessionId) return { applied: false, reason: "The Chat session binding is missing.", evidenceRefs: [] };
      const prefs = await this.deps.getChatSessionPrefs(sessionId);
      const settings = await this.deps.getSettings();
      const providerId = plan.request.providerId ?? prefs.providerId ?? settings.llm.activeProviderId;
      const model = plan.request.model ?? prefs.model ?? settings.llm.activeModel;
      const effortMatches = !plan.request.thinkingLevel || prefs.thinkingLevel === plan.request.thinkingLevel;
      const applied = prefs.providerId === providerId && prefs.model === model && effortMatches;
      return {
        applied,
        reason: applied
          ? "The Chat session preference owner matches the plan."
          : "The Chat session preference owner does not match the plan.",
        evidenceRefs: applied ? [`chat_session:${sessionId}:revision:${prefs.revision}`] : [],
      };
    }
    if (plan.request.kind === "installation_default_model") {
      const settings = await this.deps.getSettings();
      const effortMatches =
        !plan.request.thinkingLevel || settings.llm.defaultThinkingLevel === plan.request.thinkingLevel;
      const applied =
        settings.llm.activeProviderId === plan.request.providerId &&
        settings.llm.activeModel === plan.request.model &&
        effortMatches;
      return {
        applied,
        reason: applied
          ? "The runtime settings owner matches the plan."
          : "The runtime settings owner does not match the plan.",
        evidenceRefs: applied ? [`runtime_settings:llm:revision:${settings.revision}`] : [],
      };
    }
    return { applied: false, reason: "The Model Change Plan kind is unsupported.", evidenceRefs: [] };
  }

  private async assertSelection(provider: LlmProviderSummary, model: string, level?: ChatThinkingLevel): Promise<void> {
    const models = await this.listAvailableModels(provider);
    if (!models.some((candidate) => candidate.id === model)) {
      const alternatives = models.slice(0, 8).map((candidate) => candidate.id);
      throw new SemanticValidationError(`${model} is not available from ${provider.label}.`, {
        providerId: provider.providerId,
        requestedModel: model,
        alternatives,
      });
    }
    if (!level) return;
    const requested = reasoningEffortForThinkingLevel(level);
    const modelReasoning = this.deps.getModelReasoningMetadata(provider.providerId, model);
    const supported = modelReasoning?.supportedEfforts ?? provider.capabilities?.reasoningEfforts;
    if (requested === "none") return;
    if (provider.capabilities?.reasoning === false || (supported && !supported.includes(requested))) {
      throw new SemanticValidationError(`${provider.label} / ${model} does not support ${level} effort.`, {
        providerId: provider.providerId,
        model,
        requestedEffort: level,
        supportedEfforts: thinkingLevelsForReasoningEfforts(supported ?? ["none"]),
      });
    }
  }

  private async listAvailableModels(provider: LlmProviderSummary): Promise<readonly LlmModelRecord[]> {
    try {
      return await this.deps.listModels(provider.providerId);
    } catch {
      throw new SemanticValidationError(
        `Unable to verify model availability for ${provider.label}. Reconnect or refresh the provider first.`,
      );
    }
  }
}

function requireSessionId(context: EvolutionControlPlaneAdapterContext): string {
  const sessionId = context.origin.sessionId?.trim();
  if (!sessionId) throw new SemanticValidationError("A current-Chat model plan requires a Chat session.");
  return sessionId;
}

function requireReadyProvider(providers: readonly LlmProviderSummary[], providerId: string): LlmProviderSummary {
  const provider = providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) throw new SemanticValidationError(`LLM provider ${providerId} is not configured.`);
  if (provider.authReadiness && !["configured", "ready"].includes(provider.authReadiness.status)) {
    throw new SemanticValidationError(`${provider.label} is not ready. Complete its secure setup first.`);
  }
  return provider;
}

function assertTargetRevision(plan: ChangePlanRecord, currentRevision: number): void {
  if (plan.target.expectedRevision === currentRevision) return;
  throw new ConflictError({
    code: "WRITE_CONFLICT",
    message: "The model configuration owner changed after this Change Plan was prepared.",
    details: {
      resourceKind: plan.target.ownerId,
      resourceId: plan.target.resourceId,
      expectedRevision: plan.target.expectedRevision,
      currentRevision,
    },
  });
}

function reasoningEffortForThinkingLevel(level: ChatThinkingLevel): ChatCompletionReasoningEffort {
  switch (level) {
    case "off":
      return "none";
    case "minimal":
      return "low";
    case "standard":
      return "medium";
    case "extended":
      return "high";
    case "deep":
      return "xhigh";
    case "max":
      return "max";
    case "ultra":
      return "ultra";
  }
}

function thinkingLevelsForReasoningEfforts(efforts: readonly ChatCompletionReasoningEffort[]): ChatThinkingLevel[] {
  const mapping: Partial<Record<ChatCompletionReasoningEffort, ChatThinkingLevel>> = {
    none: "off",
    low: "minimal",
    medium: "standard",
    high: "extended",
    xhigh: "deep",
    max: "max",
    ultra: "ultra",
  };
  return efforts.flatMap((effort) => (mapping[effort] ? [mapping[effort]!] : []));
}
