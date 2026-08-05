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
  OrchestrationPhaseChildDispatch,
  OrchestrationPhaseExecutionResult,
  OrchestrationPlan,
  OrchestrationRun,
  OrchestrationRunPolicyContext,
} from "@goatcitadel/contracts";
import { renderVersionedTextPrompt } from "../orchestration/prompt-registry.js";

const DEFAULT_WORKSPACE_ID = "default";

export interface OrchestrationPhaseExecutionServiceDeps {
  readonly rootDir: string;
  createChatSession(input: ChatSessionCreateInput): Promise<ChatSessionRecord>;
  updateChatSessionPrefs(sessionId: string, input: ChatSessionPrefsPatch): Promise<ChatSessionPrefsRecord>;
  agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: { abortSignal?: AbortSignal; onChildDurableRunLaunched?: (runId: string) => Promise<void> },
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
  /**
   * Reported the moment the phase dispatches its child Cowork turn so the
   * caller can persist a crash-safe linkage breadcrumb (ORCH-002). Invoked once
   * with the child session id before the turn is launched, and again with the
   * child durable run id once the durable child run has been created.
   */
  onChildDispatched?: (dispatch: OrchestrationPhaseChildDispatch) => Promise<void>;
}

export class OrchestrationPhaseExecutionService {
  public constructor(private readonly deps: OrchestrationPhaseExecutionServiceDeps) {}

  public async execute(input: OrchestrationPhaseExecutionInput): Promise<OrchestrationPhaseExecutionResult> {
    throwIfPhaseAborted(input.signal);
    const startedAt = new Date().toISOString();
    const workspaceId = this.deps.normalizeWorkspaceId(input.run.workspaceId ?? DEFAULT_WORKSPACE_ID);
    const specText = await this.readPhaseSpec(input.run, input.phase);
    const childSession = await this.deps.createChatSession({
      workspaceId,
      mode: "cowork",
      origin: "system",
      includeInHistory: false,
      title: `[Orchestration] ${input.run.runId}/${input.phase.phaseId}`,
    });
    // Crash-safe breadcrumb #1: record the child session before the turn is
    // dispatched, so an interruption mid-turn never re-dispatches this phase.
    await input.onChildDispatched?.({
      phaseId: input.phase.phaseId,
      childSessionId: childSession.sessionId,
    });
    await this.deps.updateChatSessionPrefs(childSession.sessionId, {
      mode: "cowork",
      planningMode: "off",
      memoryMode: "auto",
      toolAutonomy: "safe_auto",
      proactiveMode: "off",
      reflectionMode: "off",
      orchestrationEnabled: false,
      subagentPolicy: "off",
    });

    const prompt = renderVersionedTextPrompt({
      promptId: "orchestration.durable.phase.execute",
      promptVersion: "v1",
      content: [
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
      ].join("\n"),
    });

    try {
      const response = await this.deps.agentSendChatMessage(
        childSession.sessionId,
        {
          content: prompt.content,
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
        {
          ...(input.signal ? { abortSignal: input.signal } : {}),
          // Crash-safe breadcrumb #2: enrich the linkage with the durable child
          // run id the instant the child run is created, before the (possibly
          // long-running) turn settles. This is what resume harvests/reattaches.
          onChildDurableRunLaunched: input.onChildDispatched
            ? async (runId) =>
                await input.onChildDispatched?.({
                  phaseId: input.phase.phaseId,
                  childSessionId: childSession.sessionId,
                  childRunId: runId,
                })
            : undefined,
        },
      );
      throwIfPhaseAborted(input.signal);
      const assistantText = response.assistantMessage?.content?.trim() ?? "";
      const finishedAt = new Date().toISOString();
      const costUsd = response.assistantMessage?.costUsd;
      const inputTokens = response.assistantMessage?.tokenInput;
      const outputTokens = response.assistantMessage?.tokenOutput;
      const traceStatus = response.trace?.status;
      const failure = response.trace?.failure?.message ?? response.trace?.failure?.failureClass;
      const approvalId =
        response.trace?.pendingApprovalSummary?.approvalId ??
        response.trace?.toolRuns?.find((toolRun) => toolRun.status === "approval_required" && toolRun.approvalId)
          ?.approvalId;
      const waitingForApproval = traceStatus === "waiting_for_approval";
      const waitingForUserInput = traceStatus === "waiting_for_user_input";
      const unsupportedUserInputWait =
        "Phase child turn is waiting for user input, but durable orchestration can only pause/resume approval waits. Refactor this phase to: (1) detect where input is needed, (2) emit an approval-required tool/action and return waiting_for_approval, and (3) resume the run after approval to continue execution.";
      const effectiveFailure = waitingForUserInput ? unsupportedUserInputWait : failure;
      return {
        phaseId: input.phase.phaseId,
        ownerAgentId: input.phase.ownerAgentId,
        status: waitingForApproval
          ? "waiting"
          : traceStatus === "failed" || waitingForUserInput || !assistantText
            ? "failed"
            : "completed",
        startedAt,
        finishedAt,
        outputSummary: summarizePhaseOutput(assistantText || effectiveFailure),
        outputText: assistantText || effectiveFailure,
        childSessionId: response.sessionId,
        childTurnId: response.turnId,
        childRunId: response.trace?.durable?.runId,
        approvalId,
        model: response.model ?? response.trace?.model,
        costUsd,
        inputTokens,
        outputTokens,
        citations: response.citations,
        prompt: prompt.reference,
        error:
          traceStatus === "failed"
            ? (failure ?? "Phase chat turn failed.")
            : waitingForUserInput
              ? unsupportedUserInputWait
              : undefined,
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
        prompt: prompt.reference,
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
