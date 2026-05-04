import { randomUUID } from "node:crypto";
import type {
  ChatCitationRecord,
  ChatDelegateAcceptRequest,
  ChatDelegateRequest,
  ChatDelegateResponse,
  ChatDelegateSuggestRequest,
  ChatDelegateSuggestResponse,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatDelegationSuggestionRecord,
  ChatMode,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import { chatModeRequiresProjectBinding, ValidationError } from "@goatcitadel/contracts";
import { buildDelegatedChatSendRequest } from "./delegated-chat-request.js";
import {
  buildDelegationFailureGuidance,
  DEFAULT_DELEGATION_ROLES,
  detectDelegationRoles,
  toTitleCase,
  truncateSummaryLine,
} from "./chat-turn-helpers.js";

interface ChatDelegationProgressStatusEvent {
  runId: string;
  taskId: string;
  message: string;
}

export interface ChatDelegationProgressCallbacks {
  onStatus?: (event: ChatDelegationProgressStatusEvent) => Promise<void> | void;
  onStep?: (step: ChatDelegationStepRecord) => Promise<void> | void;
}

interface NormalizedDelegationStep {
  stepId: string;
  index: number;
  role: string;
  parallelizable: boolean;
  dependsOnStepIds: string[];
}

interface DelegationStepExecutionResult {
  step: ChatDelegationStepRecord;
  output?: string;
  citations: ChatCitationRecord[];
  trace?: ChatTurnTraceRecord["routing"];
  completed: boolean;
}

export interface ChatDelegationServiceHost {
  storage: {
    chatSessionPrefs: {
      ensure(sessionId: string): ChatSessionPrefsRecord;
    };
    chatSessionMeta: {
      ensure(sessionId: string): { workspaceId?: string };
    };
    chatSessionProjects: {
      get(sessionId: string): { projectId: string } | undefined;
    };
    chatDelegationRuns: {
      create(input: {
        runId: string;
        sessionId: string;
        taskId: string;
        objective: string;
        roles: string[];
        mode: "sequential" | "parallel";
        providerId?: string;
        model?: string;
        status: ChatDelegationRunRecord["status"];
        citations: ChatCitationRecord[];
      }): ChatDelegationRunRecord;
      patch(runId: string, patch: Partial<ChatDelegationRunRecord>): ChatDelegationRunRecord;
    };
    chatDelegationSteps: {
      create(
        input: Partial<ChatDelegationStepRecord> & {
          stepId: string;
          runId: string;
          role: string;
          index: number;
          status: ChatDelegationStepRecord["status"];
          startedAt: string;
        },
      ): ChatDelegationStepRecord;
      patch(stepId: string, patch: Partial<ChatDelegationStepRecord>): ChatDelegationStepRecord;
      listByRun(runId: string): ChatDelegationStepRecord[];
    };
  };
  gatewaySql: {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
    };
  };
  taskLifecycleService: {
    createTask(input: {
      workspaceId: string;
      title: string;
      description: string;
      status: "in_progress";
      priority: "normal";
      createdBy: string;
    }): { taskId: string };
    appendTaskActivity(
      taskId: string,
      input: { activityType: "comment"; message: string; agentId?: string; metadata?: Record<string, unknown> },
    ): unknown;
    appendTaskDeliverable(
      taskId: string,
      input: { deliverableType: "artifact"; title: string; description: string },
    ): unknown;
    updateTask(taskId: string, patch: { status: "review" | "blocked" }): unknown;
    registerTaskSubagent(taskId: string, input: { agentSessionId: string; agentName: string }): unknown;
    updateTaskSubagent(agentSessionId: string, patch: { status: "completed" | "failed"; endedAt: string }): unknown;
  };
  getSession(sessionId: string): unknown;
  listChatMessages(sessionId: string, limit: number): Promise<Array<{ role: string; content: string }>>;
  normalizeWorkspaceId(workspaceId?: string): string;
  ensureChatSessionModelDefaults(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord;
  createChatSession(input: {
    workspaceId?: string;
    title?: string;
    projectId?: string;
    mode?: ChatMode;
  }): ChatSessionRecord;
  inheritDelegatedSessionToolGrants(parentSessionId: string, childSessionId: string): void;
  updateChatSessionPrefs(sessionId: string, patch: Partial<ChatSessionPrefsRecord>): ChatSessionPrefsRecord;
  agentSendChatMessage(sessionId: string, input: ChatSendMessageRequest): Promise<ChatSendMessageResponse>;
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: { role: "user" | "assistant"; sourceRef: string },
  ): void;
  scheduleChatMemoryContextPrewarm(input: { sessionId: string; prompt: string; relationScope: "peer" }): void;
}

export class ChatDelegationService {
  public constructor(private readonly deps: ChatDelegationServiceHost) {}

  public async runChatDelegation(
    sessionId: string,
    input: ChatDelegateRequest,
    callbacks?: ChatDelegationProgressCallbacks,
  ): Promise<ChatDelegateResponse> {
    const deps = this.deps;
    deps.getSession(sessionId);
    const objective = input.objective.trim();
    if (!objective) {
      throw new Error("objective is required");
    }
    const roles = normalizeDelegationRoles(input.roles);
    if (roles.length === 0) {
      throw new Error("at least one role is required");
    }
    const requestedMode = input.mode ?? "sequential";
    const mode = requestedMode;
    const delegationSteps = normalizeDelegationSteps({
      roles,
      mode,
      steps: input.steps,
    });
    const prefs = deps.ensureChatSessionModelDefaults(sessionId, deps.storage.chatSessionPrefs.ensure(sessionId));
    const executionMode: ChatMode = input.surfaceMode ?? prefs.mode;
    const providerId = input.providerId ?? prefs.providerId;
    const model = input.model ?? prefs.model;
    const sessionWorkspaceId = deps.normalizeWorkspaceId(deps.storage.chatSessionMeta.ensure(sessionId).workspaceId);
    const parentProjectId = deps.storage.chatSessionProjects.get(sessionId)?.projectId;
    if (chatModeRequiresProjectBinding(executionMode) && !parentProjectId) {
      throw new ValidationError({ message: "Code delegation requires a project-bound parent session." });
    }

    const task = deps.taskLifecycleService.createTask({
      workspaceId: sessionWorkspaceId,
      title: `Delegation: ${objective.slice(0, 120)}`,
      description: objective,
      status: "in_progress",
      priority: "normal",
      createdBy: "chat",
    });

    const runId = randomUUID();
    deps.storage.chatDelegationRuns.create({
      runId,
      sessionId,
      taskId: task.taskId,
      objective,
      roles: dedupeStrings(delegationSteps.map((step) => step.role)),
      mode,
      providerId,
      model,
      status: "running",
      citations: [],
    });
    await callbacks?.onStatus?.({
      runId,
      taskId: task.taskId,
      message: "Delegation started.",
    });
    deps.taskLifecycleService.appendTaskActivity(task.taskId, {
      activityType: "comment",
      message: `Delegation started (${delegationSteps.map((step) => step.role).join(mode === "parallel" ? " | " : " -> ")})`,
      metadata: { runId, sessionId, mode, requestedMode, surfaceMode: executionMode },
    });

    const citations: ChatCitationRecord[] = [];
    let trace: ChatTurnTraceRecord["routing"] | undefined;
    const completedOutputs = new Map<string, { role: string; output: string }>();
    const stepResults = new Map<string, DelegationStepExecutionResult>();
    const stages = buildDelegationStages(delegationSteps);

    const executeDelegationStep = async (step: NormalizedDelegationStep): Promise<DelegationStepExecutionResult> => {
      const startedAt = new Date().toISOString();
      const runningStep = deps.storage.chatDelegationSteps.create({
        stepId: step.stepId,
        runId,
        role: step.role,
        label: step.role,
        index: step.index,
        status: "running",
        startedAt,
      });
      await callbacks?.onStep?.(runningStep);

      const childSession = deps.createChatSession({
        workspaceId: sessionWorkspaceId,
        title: `Delegate · ${toTitleCase(step.role)}`,
        projectId: parentProjectId,
        mode: executionMode,
      });
      deps.inheritDelegatedSessionToolGrants(sessionId, childSession.sessionId);
      deps.updateChatSessionPrefs(childSession.sessionId, {
        mode: executionMode,
        planningMode: "off",
        providerId,
        model,
        webMode: prefs.webMode,
        memoryMode: prefs.memoryMode,
        thinkingLevel: prefs.thinkingLevel,
        speedMode: prefs.speedMode,
        subagentPolicy: "off",
        toolAutonomy: prefs.toolAutonomy,
        orchestrationEnabled: false,
        orchestrationIntensity: "minimal",
        orchestrationVisibility: "explicit",
        orchestrationProviderPreference: prefs.orchestrationProviderPreference,
        orchestrationReviewDepth: prefs.orchestrationReviewDepth,
        orchestrationParallelism: "sequential",
        codeAutoApply: prefs.codeAutoApply,
        proactiveMode: "off",
        retrievalMode: prefs.retrievalMode,
        reflectionMode: "off",
      });
      const agentSessionId = childSession.sessionId;
      deps.taskLifecycleService.registerTaskSubagent(task.taskId, {
        agentSessionId,
        agentName: step.role,
      });

      const dependencyContext = step.dependsOnStepIds
        .map((dependencyStepId) => completedOutputs.get(dependencyStepId))
        .filter((item): item is { role: string; output: string } => Boolean(item));

      try {
        const response = await deps.agentSendChatMessage(
          childSession.sessionId,
          buildDelegatedChatSendRequest({
            content: [
              buildDelegationSystemPrompt(step.role),
              buildDelegationUserPrompt({
                objective,
                role: step.role,
                mode,
                sharedContext: dependencyContext,
              }),
            ].join("\n\n"),
            providerId,
            model,
            mode: executionMode,
            webMode: prefs.webMode,
            memoryMode: prefs.memoryMode,
            thinkingLevel: prefs.thinkingLevel,
            speedMode: prefs.speedMode,
            subagentPolicy: "off",
            retrievalMode: prefs.retrievalMode ?? "standard",
            toolAutonomy: prefs.toolAutonomy,
          }),
        );
        const traceStatus = response.trace?.status;
        const waitingForApproval = traceStatus === "waiting_for_approval";
        const waitingForUserInput = traceStatus === "waiting_for_user_input";
        const stillActive = traceStatus === "waiting_for_tool";
        const failed =
          traceStatus === "failed" ||
          traceStatus === "cancelled" ||
          waitingForApproval ||
          waitingForUserInput ||
          stillActive;
        const output =
          response.assistantMessage?.content?.trim() ||
          response.trace?.failure?.message?.trim() ||
          (waitingForApproval
            ? response.trace?.pendingApprovalSummary?.reason?.trim() || "Delegate is waiting for approval."
            : waitingForUserInput
              ? response.trace?.pendingUserInput?.question?.trim() || "Delegate is waiting for user input."
              : stillActive
                ? "Delegate is still waiting on a tool result."
                : "(delegate returned no output)");
        const finishedAt = new Date().toISOString();
        const completedStep = deps.storage.chatDelegationSteps.patch(step.stepId, {
          status: failed ? "failed" : "completed",
          providerId: response.trace?.routing?.effectiveProviderId ?? providerId,
          model: response.trace?.model ?? model,
          label: step.role,
          summary: truncateSummaryLine(output, 180),
          output,
          error: failed ? (response.trace?.failure?.message ?? output) : undefined,
          failureGuidance: failed ? buildDelegationFailureGuidance(output, step.role) : undefined,
          durableRunId: response.trace?.durable?.runId,
          childSessionId: childSession.sessionId,
          childTurnId: response.turnId,
          citations: response.citations ?? [],
          finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        });
        await callbacks?.onStep?.(completedStep);
        deps.taskLifecycleService.updateTaskSubagent(agentSessionId, {
          status: failed ? "failed" : "completed",
          endedAt: finishedAt,
        });
        deps.taskLifecycleService.appendTaskActivity(task.taskId, {
          activityType: "comment",
          agentId: step.role,
          message: failed
            ? `${step.role} failed delegation step ${step.index + 1}/${delegationSteps.length}.`
            : `${step.role} completed delegation step ${step.index + 1}/${delegationSteps.length}.`,
          metadata: {
            runId,
            stepId: step.stepId,
            childSessionId: childSession.sessionId,
            childTurnId: response.turnId,
            durableRunId: response.trace?.durable?.runId,
          },
        });
        if (!failed) {
          deps.taskLifecycleService.appendTaskDeliverable(task.taskId, {
            deliverableType: "artifact",
            title: `${toTitleCase(step.role)} step`,
            description: output.slice(0, 6000),
          });
          completedOutputs.set(step.stepId, {
            role: step.role,
            output: output.slice(0, 4000),
          });
        }

        const completionRouting = response.routing ?? response.trace?.routing;
        if (completionRouting) {
          trace = {
            ...(trace ?? {}),
            ...completionRouting,
          };
        }
        for (const citation of response.citations ?? []) {
          citations.push(citation);
        }

        return {
          step: completedStep,
          output,
          citations: response.citations ?? [],
          trace: completionRouting,
          completed: !failed,
        };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const message = (error as Error).message;
        const failedStep = deps.storage.chatDelegationSteps.patch(step.stepId, {
          status: "failed",
          label: step.role,
          error: message,
          failureGuidance: buildDelegationFailureGuidance(message, step.role),
          childSessionId: childSession.sessionId,
          finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        });
        await callbacks?.onStep?.(failedStep);
        deps.taskLifecycleService.updateTaskSubagent(agentSessionId, {
          status: "failed",
          endedAt: finishedAt,
        });
        deps.taskLifecycleService.appendTaskActivity(task.taskId, {
          activityType: "comment",
          agentId: step.role,
          message: `${step.role} failed delegation step ${step.index + 1}/${delegationSteps.length}: ${message}`,
          metadata: { runId, stepId: step.stepId, error: message },
        });
        return {
          step: failedStep,
          output: message,
          citations: [],
          completed: false,
        };
      }
    };

    for (const stage of stages) {
      const runnableSteps: NormalizedDelegationStep[] = [];
      for (const step of stage) {
        const failedDependencies = step.dependsOnStepIds.reduce<ChatDelegationStepRecord[]>((out, dependencyStepId) => {
          const dependency = stepResults.get(dependencyStepId)?.step;
          if (dependency && dependency.status !== "completed") {
            out.push(dependency);
          }
          return out;
        }, []);
        if (failedDependencies.length === 0) {
          runnableSteps.push(step);
          continue;
        }
        const failedDependencyRoles = failedDependencies.map((dependency) => dependency?.role ?? "unknown");
        const startedAt = new Date().toISOString();
        const skippedStep = deps.storage.chatDelegationSteps.create({
          stepId: step.stepId,
          runId,
          role: step.role,
          label: step.role,
          index: step.index,
          status: "skipped",
          error: `Skipped because dependency failed: ${failedDependencyRoles.join(", ")}`,
          failureGuidance: buildDelegationFailureGuidance(
            `Blocked by dependency failure from ${failedDependencyRoles.join(", ")}`,
            step.role,
          ),
          startedAt,
          finishedAt: startedAt,
          durationMs: 0,
        });
        await callbacks?.onStep?.(skippedStep);
        deps.taskLifecycleService.appendTaskActivity(task.taskId, {
          activityType: "comment",
          agentId: step.role,
          message: `${step.role} skipped delegation step ${step.index + 1}/${delegationSteps.length} due to failed dependency.`,
          metadata: {
            runId,
            stepId: step.stepId,
            failedDependencyStepIds: failedDependencies.map((dependency) => dependency.stepId),
          },
        });
        stepResults.set(step.stepId, {
          step: skippedStep,
          citations: [],
          completed: false,
        });
      }

      await mapWithConcurrency(runnableSteps, 4, async (step) => {
        const result = await executeDelegationStep(step);
        stepResults.set(step.stepId, result);
        return result;
      });
    }

    const finishedAt = new Date().toISOString();
    const persistedSteps = deps.storage.chatDelegationSteps.listByRun(runId);
    const stitchedSections = persistedSteps.map((step) => {
      const body =
        step.status === "completed"
          ? (step.output ?? "(delegate returned no output)")
          : step.status === "skipped"
            ? `SKIPPED: ${step.error ?? "Dependency did not complete."}`
            : `FAILED: ${step.error ?? step.output ?? "Delegate failed without an error message."}`;
      return `### ${toTitleCase(step.role)}\n${body}`;
    });
    const stitchedOutput = stitchedSections.join("\n\n").trim();
    const completedSteps = persistedSteps.filter((step) => step.status === "completed").length;
    const nonCompletedSteps = persistedSteps.length - completedSteps;
    const status: ChatDelegationRunRecord["status"] =
      nonCompletedSteps === 0 ? "completed" : completedSteps > 0 ? "partial" : "failed";
    deps.storage.chatDelegationRuns.patch(runId, {
      status,
      stitchedOutput,
      citations,
      trace,
      finishedAt,
    });
    deps.taskLifecycleService.appendTaskActivity(task.taskId, {
      activityType: "comment",
      message: `Delegation ${status}.`,
      metadata: {
        runId,
        completedSteps,
        failedSteps: persistedSteps.filter((step) => step.status === "failed").length,
        skippedSteps: persistedSteps.filter((step) => step.status === "skipped").length,
        steps: delegationSteps.length,
      },
    });
    deps.taskLifecycleService.updateTask(task.taskId, {
      status: completedSteps > 0 && status === "completed" ? "review" : "blocked",
    });

    deps.extractAndPersistLearnedMemory(sessionId, objective, {
      role: "user",
      sourceRef: runId,
    });
    if (stitchedOutput.trim()) {
      deps.extractAndPersistLearnedMemory(sessionId, stitchedOutput, {
        role: "assistant",
        sourceRef: runId,
      });
      deps.scheduleChatMemoryContextPrewarm({
        sessionId,
        prompt: stitchedOutput,
        relationScope: "peer",
      });
    }

    return {
      runId,
      taskId: task.taskId,
      steps: persistedSteps,
      stitchedOutput,
      citations,
      trace,
    };
  }

  public async *runChatDelegationStream(
    sessionId: string,
    input: ChatDelegateRequest,
  ): AsyncGenerator<{
    type: "status" | "step" | "done" | "error";
    runId?: string;
    taskId?: string;
    message?: string;
    step?: ChatDelegationStepRecord;
    result?: ChatDelegateResponse;
    error?: string;
  }> {
    const queue: Array<{
      type: "status" | "step" | "done";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }> = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let runError: unknown = null;
    const push = (chunk: {
      type: "status" | "step" | "done";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }) => {
      queue.push(chunk);
      const notify = wake;
      wake = null;
      notify?.();
    };

    void this.runChatDelegation(sessionId, input, {
      onStatus: async (event) => {
        push({
          type: "status",
          runId: event.runId,
          taskId: event.taskId,
          message: event.message,
        });
      },
      onStep: async (step) => {
        push({
          type: "step",
          runId: step.runId,
          step,
        });
      },
    })
      .then((result) => {
        push({
          type: "done",
          runId: result.runId,
          taskId: result.taskId,
          result,
        });
      })
      .catch((error) => {
        runError = error;
      })
      .finally(() => {
        finished = true;
        const notify = wake;
        wake = null;
        notify?.();
      });

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const chunk = queue.shift();
      if (chunk) {
        yield chunk;
      }
    }

    if (runError) {
      throw runError;
    }
  }

  public async suggestChatDelegation(
    sessionId: string,
    input: ChatDelegateSuggestRequest = {},
  ): Promise<ChatDelegateSuggestResponse> {
    this.deps.getSession(sessionId);
    const objective = (input.objective?.trim() || (await this.inferLatestUserObjective(sessionId))).trim();
    if (!objective) {
      throw new Error("No objective provided and no recent user request was found.");
    }
    const detectedRoles = normalizeDelegationRoles(
      input.roles?.length ? input.roles : detectDelegationRoles(objective),
    );
    const roles = detectedRoles.length > 0 ? detectedRoles : DEFAULT_DELEGATION_ROLES.slice(0, 3);
    const confidence = computeDelegationSuggestionConfidence(objective, roles);
    const suggestion: ChatDelegationSuggestionRecord = {
      suggestionId: randomUUID(),
      sessionId,
      objective,
      roles,
      mode: "sequential",
      confidence,
      reason: "Detected multi-role objective and generated delegation plan.",
      source: "manual",
      createdAt: new Date().toISOString(),
    };
    return { suggestion };
  }

  public async acceptChatDelegation(
    sessionId: string,
    input: ChatDelegateAcceptRequest,
  ): Promise<ChatDelegateResponse> {
    this.deps.getSession(sessionId);
    if (input.suggestionId) {
      const actionRow = this.deps.gatewaySql
        .prepare(
          `
        SELECT args_json
        FROM proactive_actions
        WHERE action_id = ? AND session_id = ?
      `,
        )
        .get(input.suggestionId, sessionId) as { args_json?: string } | undefined;
      if (actionRow?.args_json) {
        const parsed = safeJsonParse<Record<string, unknown>>(actionRow.args_json, {});
        const objectiveFromSuggestion = typeof parsed.objective === "string" ? parsed.objective.trim() : "";
        const rolesFromSuggestion = Array.isArray(parsed.roles) ? parsed.roles.map((item) => String(item)) : [];
        return this.runChatDelegation(sessionId, {
          objective: objectiveFromSuggestion || input.objective,
          roles: rolesFromSuggestion.length > 0 ? rolesFromSuggestion : input.roles,
          mode: "sequential",
          providerId: input.providerId,
          model: input.model,
          surfaceMode: input.surfaceMode,
        });
      }
    }
    return this.runChatDelegation(sessionId, {
      objective: input.objective,
      roles: input.roles,
      mode: "sequential",
      providerId: input.providerId,
      model: input.model,
      surfaceMode: input.surfaceMode,
    });
  }

  private async inferLatestUserObjective(sessionId: string): Promise<string> {
    const messages = await this.deps.listChatMessages(sessionId, 40);
    const latestUser = [...messages].reverse().find((item) => item.role === "user");
    return latestUser?.content ?? "";
  }
}

function computeDelegationSuggestionConfidence(objective: string, roles: string[]): number {
  let score = roles.length >= 3 ? 0.84 : roles.length >= 2 ? 0.72 : 0.58;
  if (/\b(prd|architecture|implement|qa|ops|handoff)\b/i.test(objective)) {
    score += 0.12;
  }
  return Math.max(0, Math.min(1, score));
}

function normalizeDelegationRoles(roles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const normalized = role
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  if (out.length === 0) {
    return [...DEFAULT_DELEGATION_ROLES];
  }
  return out;
}

function normalizeDelegationSteps(input: {
  roles: string[];
  mode: "sequential" | "parallel";
  steps?: NonNullable<ChatDelegateRequest["steps"]>;
}): NormalizedDelegationStep[] {
  if (!input.steps || input.steps.length === 0) {
    const stepIds = input.roles.map(() => randomUUID());
    return input.roles.map((role, index) => ({
      stepId: stepIds[index]!,
      index,
      role,
      parallelizable: input.mode === "parallel",
      dependsOnStepIds: input.mode === "sequential" && index > 0 ? [stepIds[index - 1]!] : [],
    }));
  }

  const allowedRoles = new Set(input.roles);
  const provisional = input.steps.map((step, index) => {
    const normalizedRole = normalizeDelegationRoles([step.role])[0];
    if (!normalizedRole) {
      throw new Error(`delegation step ${index + 1} is missing a valid role`);
    }
    if (!allowedRoles.has(normalizedRole)) {
      throw new Error(`delegation step role "${normalizedRole}" must also appear in roles`);
    }
    return {
      requestedStepId: step.stepId?.trim(),
      requestedIndex: Number.isFinite(step.index) ? Math.max(0, Math.trunc(step.index!)) : index,
      role: normalizedRole,
      parallelizable: step.parallelizable ?? input.mode === "parallel",
      dependsOnStepIds: dedupeStrings(step.dependsOnStepIds ?? []),
    };
  });

  provisional.sort((left, right) => left.requestedIndex - right.requestedIndex);
  const seenStepIds = new Set<string>();
  const normalized = provisional.map((step, index) => {
    const stepId = step.requestedStepId && !seenStepIds.has(step.requestedStepId) ? step.requestedStepId : randomUUID();
    seenStepIds.add(stepId);
    return {
      stepId,
      index,
      role: step.role,
      parallelizable: step.parallelizable,
      dependsOnStepIds: step.dependsOnStepIds,
    };
  });

  const validStepIds = new Set(normalized.map((step) => step.stepId));
  for (const step of normalized) {
    for (const dependencyStepId of step.dependsOnStepIds) {
      if (!validStepIds.has(dependencyStepId)) {
        throw new Error(`delegation step "${step.stepId}" depends on unknown step "${dependencyStepId}"`);
      }
      if (dependencyStepId === step.stepId) {
        throw new Error(`delegation step "${step.stepId}" cannot depend on itself`);
      }
    }
  }
  return normalized;
}

function buildDelegationStages(steps: readonly NormalizedDelegationStep[]): NormalizedDelegationStep[][] {
  const remaining = new Map(steps.map((step) => [step.stepId, step] as const));
  const resolved = new Set<string>();
  const stages: NormalizedDelegationStep[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((step) => step.dependsOnStepIds.every((dependencyStepId) => resolved.has(dependencyStepId)))
      .sort((left, right) => left.index - right.index);
    if (ready.length === 0) {
      throw new Error("delegation steps contain a dependency cycle or unresolved dependency");
    }
    const stage = ready.some((step) => !step.parallelizable) ? [ready[0]!] : ready;
    stages.push(stage);
    for (const step of stage) {
      remaining.delete(step.stepId);
      resolved.add(step.stepId);
    }
  }

  return stages;
}

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function buildDelegationSystemPrompt(role: string): string {
  return [
    "You are a specialist subagent in a multi-step delegation run.",
    `Assigned role: ${role}.`,
    "Return concise, practical output in plain markdown.",
    "If you are missing data, call that out explicitly and propose a next best step.",
    "Never claim external data unless it was provided in the current context.",
  ].join("\n");
}

function buildDelegationUserPrompt(input: {
  objective: string;
  role: string;
  mode: "sequential" | "parallel";
  sharedContext: Array<{ role: string; output: string }>;
}): string {
  const previous =
    input.sharedContext.length > 0
      ? input.sharedContext.map((item) => `Role ${item.role} output:\n${item.output}`).join("\n\n")
      : "None";
  return [
    `Objective: ${input.objective}`,
    `Execution mode: ${input.mode}`,
    `Current role: ${input.role}`,
    "Completed dependency outputs available to this role:",
    previous,
    "Produce your role output now.",
  ].join("\n\n");
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const cappedConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: cappedConcurrency }, () => runWorker()));
  return results;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
