import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionCreateInput,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  DurableRunRecord,
  OrchestrationPhase,
  OrchestrationPhaseExecutionResult,
  OrchestrationPlan,
  OrchestrationRun,
  OrchestrationRunPolicyContext,
} from "@goatcitadel/contracts";

const DEFAULT_WORKSPACE_ID = "default";

export interface OrchestrationPhaseExecutionServiceDeps {
  readonly rootDir: string;
  createChatSession(input: ChatSessionCreateInput): ChatSessionRecord;
  updateChatSessionPrefs(sessionId: string, input: ChatSessionPrefsPatch): ChatSessionPrefsRecord;
  agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ChatSendMessageResponse>;
  normalizeWorkspaceId(workspaceId: string): string;
}

export interface OrchestrationPhaseExecutionInput {
  plan: OrchestrationPlan;
  run: OrchestrationRun;
  phase: OrchestrationPhase;
  durableRun: DurableRunRecord;
  policyContext?: OrchestrationRunPolicyContext;
  signal?: AbortSignal;
}

export class OrchestrationPhaseExecutionService {
  public constructor(private readonly deps: OrchestrationPhaseExecutionServiceDeps) {}

  public async execute(input: OrchestrationPhaseExecutionInput): Promise<OrchestrationPhaseExecutionResult> {
    throwIfPhaseAborted(input.signal);
    const startedAt = new Date().toISOString();
    const workspaceId = this.deps.normalizeWorkspaceId(input.run.workspaceId ?? DEFAULT_WORKSPACE_ID);
    const specText = await this.readPhaseSpec(input.run, input.phase);
    const childSession = this.deps.createChatSession({
      workspaceId,
      mode: "cowork",
      origin: "system",
      includeInHistory: false,
      title: `[Orchestration] ${input.run.runId}/${input.phase.phaseId}`,
    });
    this.deps.updateChatSessionPrefs(childSession.sessionId, {
      mode: "cowork",
      planningMode: "off",
      memoryMode: "auto",
      toolAutonomy: "safe_auto",
      proactiveMode: "off",
      reflectionMode: "off",
      orchestrationEnabled: false,
      subagentPolicy: "off",
    });

    const prompt = [
      "You are executing one GoatCitadel Cowork orchestration phase.",
      "",
      `Goal: ${input.plan.goal}`,
      `Run: ${input.run.runId}`,
      `Durable run: ${input.durableRun.runId}`,
      `Phase: ${input.phase.phaseId}`,
      `Owner agent: ${input.phase.ownerAgentId}`,
      `Loop mode: ${input.phase.loopMode}`,
      `Spec path: ${input.phase.specPath}`,
      "",
      "Phase spec:",
      specText || "(The phase spec file was not readable; proceed from the plan metadata above.)",
      "",
      "Return the concrete phase output. Include decisions, files or artifacts touched, validation performed, blockers, and the next handoff if applicable. Do not claim later phases are complete.",
    ].join("\n");

    try {
      const response = await this.deps.agentSendChatMessage(
        childSession.sessionId,
        {
          content: prompt,
          mode: "cowork",
          memoryMode: "auto",
          subagentPolicy: "off",
          prefsOverride: {
            mode: "cowork",
            planningMode: "off",
            memoryMode: "auto",
            toolAutonomy: "safe_auto",
            proactiveMode: "off",
            reflectionMode: "off",
            orchestrationEnabled: false,
            subagentPolicy: "off",
          },
          operatorId: input.policyContext?.operatorId,
          authActorId: input.policyContext?.authActorId,
          authActorSource: input.policyContext?.authActorSource,
          permissionProfileId: input.policyContext?.permissionProfileId,
          localOperatorOverrideId: input.policyContext?.localOperatorOverrideId,
          policyRunId: input.run.runId,
          policyTaskId: input.phase.phaseId,
          signal: input.signal,
        },
        input.signal ? { abortSignal: input.signal } : undefined,
      );
      throwIfPhaseAborted(input.signal);
      const assistantText = response.assistantMessage?.content?.trim() ?? "";
      const finishedAt = new Date().toISOString();
      const costUsd = response.assistantMessage?.costUsd;
      const inputTokens = response.assistantMessage?.tokenInput;
      const outputTokens = response.assistantMessage?.tokenOutput;
      const traceStatus = response.trace?.status;
      const failure = response.trace?.failure?.message ?? response.trace?.failure?.failureClass;
      const waiting = traceStatus === "waiting_for_approval" || traceStatus === "waiting_for_user_input";
      const approvalId =
        response.trace?.pendingApprovalSummary?.approvalId ??
        response.trace?.toolRuns?.find((toolRun) => toolRun.status === "approval_required" && toolRun.approvalId)
          ?.approvalId;
      return {
        phaseId: input.phase.phaseId,
        ownerAgentId: input.phase.ownerAgentId,
        status: waiting ? "waiting" : traceStatus === "failed" || !assistantText ? "failed" : "completed",
        startedAt,
        finishedAt,
        outputSummary: summarizePhaseOutput(assistantText || failure),
        outputText: assistantText || failure,
        childSessionId: response.sessionId,
        childTurnId: response.turnId,
        childRunId: response.trace?.durable?.runId,
        approvalId,
        model: response.model ?? response.trace?.model,
        costUsd,
        inputTokens,
        outputTokens,
        citations: response.citations,
        error: traceStatus === "failed" ? (failure ?? "Phase chat turn failed.") : undefined,
      };
    } catch (error) {
      if (isPhaseAbortError(error, input.signal)) {
        throw error;
      }
      return {
        phaseId: input.phase.phaseId,
        ownerAgentId: input.phase.ownerAgentId,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        childSessionId: childSession.sessionId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readPhaseSpec(run: OrchestrationRun, phase: OrchestrationPhase): Promise<string> {
    const basePath = path.resolve(run.worktreePath ?? this.deps.rootDir);
    const targetPath = path.resolve(basePath, phase.specPath);
    const relative = path.relative(basePath, targetPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return `Spec path ${phase.specPath} resolves outside the orchestration workspace and was not read.`;
    }
    try {
      const text = await fs.readFile(targetPath, "utf8");
      return text.length > 24000 ? `${text.slice(0, 24000)}\n\n[Spec truncated after 24000 characters.]` : text;
    } catch (error) {
      return `Unable to read ${phase.specPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function throwIfPhaseAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error("Orchestration phase aborted.");
}

function isPhaseAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.name === "OrchestrationPhaseAbortedError";
}

function summarizePhaseOutput(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
}
