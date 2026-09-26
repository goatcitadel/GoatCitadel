import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isChatTurnTerminalStatus,
  type ChatSendMessageRequest,
  type ChatSendMessageResponse,
  type ChatSessionCreateInput,
  type ChatSessionPrefsPatch,
  type ChatSessionPrefsRecord,
  type ChatSessionRecord,
  type ChatTurnTraceRecord,
  type DurableRunRecord,
  type OrchestrationPhase,
  type OrchestrationPhaseChildDispatch,
  type OrchestrationPhaseExecutionResult,
  type OrchestrationPlan,
  type OrchestrationRun,
  type OrchestrationRunPolicyContext,
} from "@goatcitadel/contracts";
import { renderVersionedTextPrompt } from "../orchestration/prompt-registry.js";

const DEFAULT_WORKSPACE_ID = "default";

const UNSUPPORTED_USER_INPUT_WAIT =
  "Phase child turn is waiting for user input, but durable orchestration can only pause/resume approval waits. Refactor this phase to: (1) detect where input is needed, (2) emit an approval-required tool/action and return waiting_for_approval, and (3) resume the run after approval to continue execution.";

/** Stable child turn identity for one orchestration phase, so a re-dispatch converges on the same turn. */
export interface OrchestrationPhaseTurnIdentity {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface OrchestrationPhaseChatDispatchOptions {
  abortSignal?: AbortSignal;
  turnIdentity?: OrchestrationPhaseTurnIdentity;
  /** Return once the child durable run is admitted; the parent parks until the child settles. */
  returnAfterDurableAdmission?: boolean;
  onChildDurableRunLaunched?: (runId: string) => Promise<void>;
}

/** Canonical model usage recorded for one child Chat turn. */
export interface OrchestrationChildTurnUsage {
  costUsd?: number;
  /** False when at least one model call in the turn reported no cost. */
  costComplete: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export interface OrchestrationPhaseExecutionServiceDeps {
  readonly rootDir: string;
  createChatSession(input: ChatSessionCreateInput): Promise<ChatSessionRecord>;
  updateChatSessionPrefs(sessionId: string, input: ChatSessionPrefsPatch): Promise<ChatSessionPrefsRecord>;
  agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: OrchestrationPhaseChatDispatchOptions,
  ): Promise<ChatSendMessageResponse>;
  normalizeWorkspaceId(workspaceId: string): string;
  /** Canonical readers used to harvest a parked phase once its child turn settles. */
  readChatTurnTrace?(turnId: string): Promise<ChatTurnTraceRecord | undefined>;
  readChatMessageContent?(messageId: string): Promise<string | undefined>;
  readChatTurnUsage?(input: { sessionId: string; turnId: string }): Promise<OrchestrationChildTurnUsage>;
}

export interface OrchestrationPhaseHarvestInput {
  phaseId: string;
  ownerAgentId: string;
  childRunId: string;
  childSessionId?: string;
  childTurnId?: string;
  startedAt?: string;
  prompt?: OrchestrationPhaseExecutionResult["prompt"];
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
    const turnIdentity = buildOrchestrationPhaseTurnIdentity(input.run.runId, input.phase.phaseId);
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
      childTurnId: turnIdentity.turnId,
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
          turnIdentity,
          // The phase runs inside the durable worker, which executes one run at
          // a time. Waiting here for the child's durable run would hold the very
          // worker that child needs, so return once the child is admitted; the
          // parent parks until the child settles and is then woken to harvest it.
          returnAfterDurableAdmission: true,
          // Crash-safe breadcrumb #2: enrich the linkage with the durable child
          // run id the instant the child run is created. This is what the parent
          // waits on and what resume harvests/reattaches.
          onChildDurableRunLaunched: async (runId) =>
            await input.onChildDispatched?.({
              phaseId: input.phase.phaseId,
              childSessionId: childSession.sessionId,
              childTurnId: turnIdentity.turnId,
              childRunId: runId,
            }),
        },
      );
      throwIfPhaseAborted(input.signal);
      const childRunId = response.trace?.durable?.runId;
      if (!isChildTurnSettled(response.trace?.status)) {
        // Admitted and still running (or waiting on an approval in Chat).
        return {
          phaseId: input.phase.phaseId,
          ownerAgentId: input.phase.ownerAgentId,
          status: "waiting",
          startedAt,
          finishedAt: new Date().toISOString(),
          childSessionId: response.sessionId ?? childSession.sessionId,
          childTurnId: response.turnId ?? turnIdentity.turnId,
          childRunId,
          prompt: prompt.reference,
        };
      }
      // A replayed canonical turn can already be settled; read it the way a woken phase does.
      const harvested = childRunId
        ? await this.harvest({
            phaseId: input.phase.phaseId,
            ownerAgentId: input.phase.ownerAgentId,
            childRunId,
            childSessionId: response.sessionId,
            childTurnId: response.turnId,
            startedAt,
            prompt: prompt.reference,
          })
        : undefined;
      return harvested ?? settledChildResponseResult(input.phase, startedAt, response, prompt.reference);
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

  /**
   * Reads a parked phase's child turn from its canonical trace, message, and
   * model usage records. Returns undefined while the child is still working
   * (running, or waiting on an approval in Chat) or when it cannot be read, so
   * the caller keeps waiting or falls back. A child waiting for user input
   * fails the phase, because orchestration cannot answer it.
   */
  public async harvest(input: OrchestrationPhaseHarvestInput): Promise<OrchestrationPhaseExecutionResult | undefined> {
    if (!input.childTurnId || !this.deps.readChatTurnTrace) {
      return undefined;
    }
    const trace = await this.deps.readChatTurnTrace(input.childTurnId);
    if (!trace || !isChildTurnSettled(trace.status)) {
      return undefined;
    }
    const assistantText = trace.assistantMessageId
      ? ((await this.deps.readChatMessageContent?.(trace.assistantMessageId)) ?? "").trim()
      : "";
    const usage =
      input.childSessionId && this.deps.readChatTurnUsage
        ? await this.deps.readChatTurnUsage({ sessionId: input.childSessionId, turnId: input.childTurnId })
        : undefined;
    const { completed, error } = describeSettledChildTurn(
      trace.status,
      assistantText,
      trace.failure?.message ?? trace.failure?.failureClass,
    );
    const outputText = assistantText || error;
    return {
      phaseId: input.phaseId,
      ownerAgentId: input.ownerAgentId,
      status: completed ? "completed" : "failed",
      startedAt: input.startedAt ?? trace.startedAt,
      finishedAt: trace.finishedAt ?? new Date().toISOString(),
      outputSummary: summarizePhaseOutput(outputText),
      outputText,
      childSessionId: input.childSessionId,
      childTurnId: input.childTurnId,
      childRunId: input.childRunId,
      model: trace.model,
      ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      ...(!usage?.costComplete ? { costUnreported: true } : {}),
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      citations: trace.citations,
      prompt: input.prompt,
      error,
    };
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

export function buildOrchestrationPhaseTurnIdentity(runId: string, phaseId: string): OrchestrationPhaseTurnIdentity {
  return {
    turnId: buildStableOrchestrationId("orchestration-turn", runId, phaseId),
    userMessageId: buildStableOrchestrationId("orchestration-user", runId, phaseId),
    assistantMessageId: buildStableOrchestrationId("orchestration-assistant", runId, phaseId),
  };
}

function buildStableOrchestrationId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("|"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

/**
 * A child turn has settled for its phase once it finished or stopped to ask for
 * user input. Running turns and approval waits are still the child's to finish.
 */
function isChildTurnSettled(status: ChatTurnTraceRecord["status"] | undefined): boolean {
  return status !== undefined && (status === "waiting_for_user_input" || isChatTurnTerminalStatus(status));
}

/**
 * Maps a settled child turn onto its phase. Only a finished turn with assistant
 * output completes the phase; a wait for user input fails it, because
 * orchestration cannot answer the question.
 */
function describeSettledChildTurn(
  status: ChatTurnTraceRecord["status"] | undefined,
  assistantText: string,
  failure: string | undefined,
): { completed: boolean; error?: string } {
  const finished = status === "completed" || status === "partial";
  if (status === "waiting_for_user_input") {
    return { completed: false, error: UNSUPPORTED_USER_INPUT_WAIT };
  }
  if (finished && assistantText) {
    return { completed: true };
  }
  return {
    completed: false,
    error:
      failure ??
      (finished
        ? "Phase child turn finished without assistant output."
        : `Phase child turn ended as ${status ?? "unknown"}.`),
  };
}

/** Maps a settled child response when its canonical records cannot be read. */
function settledChildResponseResult(
  phase: Pick<OrchestrationPhase, "phaseId" | "ownerAgentId">,
  startedAt: string,
  response: ChatSendMessageResponse,
  prompt: OrchestrationPhaseExecutionResult["prompt"],
): OrchestrationPhaseExecutionResult {
  const assistantText = response.assistantMessage?.content?.trim() ?? "";
  const { completed, error } = describeSettledChildTurn(
    response.trace?.status,
    assistantText,
    response.trace?.failure?.message ?? response.trace?.failure?.failureClass,
  );
  const costUsd = response.assistantMessage?.costUsd;
  return {
    phaseId: phase.phaseId,
    ownerAgentId: phase.ownerAgentId,
    status: completed ? "completed" : "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    outputSummary: summarizePhaseOutput(assistantText || error),
    outputText: assistantText || error,
    childSessionId: response.sessionId,
    childTurnId: response.turnId,
    childRunId: response.trace?.durable?.runId,
    model: response.model ?? response.trace?.model,
    costUsd,
    ...(costUsd === undefined ? { costUnreported: true } : {}),
    inputTokens: response.assistantMessage?.tokenInput,
    outputTokens: response.assistantMessage?.tokenOutput,
    citations: response.citations,
    prompt,
    error,
  };
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
