import type {
  ChatDelegateRequest,
  ChatDelegateResponse,
  ChatDelegationRunStatus,
  ChatDelegationStepRecord,
  ChatDelegationStepStatus,
  ChatDelegationSuggestionRecord,
  ChatMessageRecord,
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatThreadResponse,
  ChatThreadTurnRecord,
  ProactivePolicy,
  ProactiveRunRecord,
} from "@goatcitadel/contracts";
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import {
  fetchChatDelegationRun,
  runChatDelegation,
  runChatResearch,
  streamChatDelegation,
  suggestChatDelegation,
  triggerChatProactive,
  updateChatProactivePolicy,
} from "@goatcitadel/mission-control-shared/api/client";
import { resolveActiveWorkflowTurn } from "@goatcitadel/mission-control-shared/components/cowork-view-model";
import { toTitleCase } from "./chat-page-normalizers";

export interface ChatProactivePolicyPatch {
  proactiveMode?: ChatProactiveMode;
  autonomyBudget?: {
    maxActionsPerHour?: number;
    maxActionsPerTurn?: number;
    cooldownSeconds?: number;
  };
  retrievalMode?: ChatRetrievalMode;
  reflectionMode?: ChatReflectionMode;
}

const CODE_DELEGATION_PRESETS = {
  implement: {
    label: "Implement",
    mode: "sequential" as const,
    roles: ["Architect", "Coder"],
    prefix: "Implement the requested change with a minimal, reviewable diff. ",
  },
  review: {
    label: "Review",
    mode: "sequential" as const,
    roles: ["Coder", "QA"],
    prefix: "Review the current implementation for bugs, regressions, and missing tests. ",
  },
  test: {
    label: "Test",
    mode: "sequential" as const,
    roles: ["Coder", "QA"],
    prefix: "Add or improve validation for the current implementation and report residual risk. ",
  },
  ship: {
    label: "Ship cycle",
    mode: "sequential" as const,
    roles: ["Architect", "Coder", "QA"],
    prefix:
      "Run an implement-review-test cycle for this task, then stitch the result into one operator-ready handoff. ",
  },
} as const;

export interface ActiveChatDelegationStep {
  stepId: string;
  runId?: string;
  role: string;
  status: ChatDelegationStepStatus;
  index: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  output?: string;
  error?: string;
  durableRunId?: string;
  childSessionId?: string;
  childTurnId?: string;
}

export interface ActiveChatDelegationRun {
  runId?: string;
  taskId?: string;
  executionPlanId?: string;
  attachedTurnId?: string | null;
  label: string;
  objective: string;
  mode: NonNullable<ChatDelegateRequest["mode"]>;
  status: ChatDelegationRunStatus;
  steps: ActiveChatDelegationStep[];
  stitchedOutput?: string;
}

function toActiveDelegationStep(step: ChatDelegationStepRecord): ActiveChatDelegationStep {
  return {
    stepId: step.stepId,
    runId: step.runId,
    role: step.role,
    status: step.status,
    index: step.index,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    durationMs: step.durationMs,
    summary: step.summary,
    output: step.output,
    error: step.error,
    durableRunId: step.durableRunId,
    childSessionId: step.childSessionId,
    childTurnId: step.childTurnId,
  };
}

function inferDelegationRunStatus(steps: ActiveChatDelegationStep[], fallback: ChatDelegationRunStatus = "running") {
  if (steps.length === 0) {
    return fallback;
  }
  if (steps.some((step) => step.status === "running" || step.status === "pending")) {
    return "running";
  }
  const completedCount = steps.filter((step) => step.status === "completed").length;
  const failedOrSkippedCount = steps.filter((step) => step.status === "failed" || step.status === "skipped").length;
  if (completedCount === steps.length) {
    return "completed";
  }
  if (completedCount > 0 && failedOrSkippedCount > 0) {
    return "partial";
  }
  if (failedOrSkippedCount > 0) {
    return "failed";
  }
  return fallback;
}

function createSeedDelegationSteps(request: ChatDelegateRequest): ActiveChatDelegationStep[] {
  if (request.steps?.length) {
    return request.steps
      .map((step, index) => ({
        stepId: step.stepId ?? `delegation-step-${index + 1}`,
        role: step.role,
        status: "pending" as const,
        index: step.index ?? index,
      }))
      .sort((left, right) => left.index - right.index);
  }
  return request.roles.map((role, index) => ({
    stepId: `delegation-step-${index + 1}`,
    role,
    status: "pending" as const,
    index,
  }));
}

function mergeDelegationStep(
  currentSteps: ActiveChatDelegationStep[],
  nextStep: ActiveChatDelegationStep,
): ActiveChatDelegationStep[] {
  const matchingIndex = currentSteps.findIndex(
    (step) =>
      step.stepId === nextStep.stepId ||
      (!step.runId && step.index === nextStep.index && step.role.toLowerCase() === nextStep.role.toLowerCase()),
  );
  const nextSteps =
    matchingIndex >= 0
      ? currentSteps.map((step, index) => (index === matchingIndex ? { ...step, ...nextStep } : step))
      : [...currentSteps, nextStep];
  return nextSteps.sort((left, right) => left.index - right.index);
}

function resolveSelectedTurn(
  thread: ChatThreadResponse | null,
  selectedTurnId: string | null,
): ChatThreadTurnRecord | null {
  if (!thread) {
    return null;
  }
  return thread.turns.find((turn) => turn.turnId === selectedTurnId) ?? thread.turns.at(-1) ?? null;
}

function buildDelegationGraph(
  selectedTurn: ChatThreadTurnRecord | null,
  fallbackRoles: string[],
): Pick<ChatDelegateRequest, "roles" | "steps"> {
  const plannedSteps = selectedTurn?.trace.executionPlan?.steps ?? [];
  const delegatedSteps = plannedSteps
    .filter((step) => typeof step.delegatedRole === "string" && step.delegatedRole.trim().length > 0)
    .sort((left, right) => left.index - right.index);
  if (delegatedSteps.length === 0) {
    return { roles: [...fallbackRoles] };
  }
  const delegatedStepIds = new Set(delegatedSteps.map((step) => step.stepId));
  const steps = delegatedSteps.map((step) => ({
    stepId: step.stepId,
    index: step.index,
    role: step.delegatedRole!.trim(),
    parallelizable: step.parallelizable,
    dependsOnStepIds: step.dependsOnStepIds?.filter((dependency) => delegatedStepIds.has(dependency)),
  }));
  return {
    roles: [...new Set(steps.map((step) => step.role))],
    steps,
  };
}

export function useChatDelegationPolicyActions(input: {
  selectedSession: ChatSessionRecord | null;
  thread: ChatThreadResponse | null;
  selectedTurnId: string | null;
  draft: string;
  messages: ChatMessageRecord[];
  prefs: ChatSessionPrefsRecord | null;
  sending: boolean;
  streamEnabled: boolean;
  codeModeNeedsProjectBinding: boolean;
  loadSidebar: () => Promise<void>;
  ensureSession: () => Promise<ChatSessionRecord>;
  setError: (value: string | null) => void;
  setSending: (value: boolean) => void;
  setPrefs: React.Dispatch<React.SetStateAction<ChatSessionPrefsRecord | null>>;
  setProactiveStatus: React.Dispatch<React.SetStateAction<ProactivePolicy | null>>;
  setProactiveRuns: React.Dispatch<React.SetStateAction<ProactiveRunRecord[]>>;
  pushLocalNotice: (content: string, tone?: "neutral" | "success" | "warning") => void;
  lastLocalPrefMutationAtRef: MutableRefObject<number>;
}) {
  const {
    selectedSession,
    draft,
    messages,
    prefs,
    sending,
    streamEnabled,
    codeModeNeedsProjectBinding,
    loadSidebar,
    ensureSession,
    setError,
    setSending,
    setPrefs,
    setProactiveStatus,
    setProactiveRuns,
    pushLocalNotice,
    lastLocalPrefMutationAtRef,
  } = input;

  const [delegationSuggestion, setDelegationSuggestion] = useState<ChatDelegationSuggestionRecord | null>(null);
  const [activeDelegationRun, setActiveDelegationRun] = useState<ActiveChatDelegationRun | null>(null);
  const selectedTurn = useMemo(
    () => resolveSelectedTurn(input.thread, input.selectedTurnId),
    [input.selectedTurnId, input.thread],
  );
  const activeWorkflowTurn = useMemo(() => resolveActiveWorkflowTurn(input.thread), [input.thread]);

  useEffect(() => {
    setActiveDelegationRun(null);
  }, [selectedSession?.sessionId]);

  useEffect(() => {
    const runId = activeWorkflowTurn?.trace.orchestration?.runId;
    const turnId = activeWorkflowTurn?.turnId ?? null;
    const sessionId = selectedSession?.sessionId;
    if (!runId || !turnId || !sessionId) {
      return;
    }
    let cancelled = false;
    void fetchChatDelegationRun(sessionId, runId)
      .then(({ run, steps }) => {
        if (cancelled) {
          return;
        }
        setActiveDelegationRun({
          runId: run.runId,
          taskId: run.taskId,
          executionPlanId: run.executionPlanId,
          attachedTurnId: turnId,
          label: "Delegation",
          objective: run.objective,
          mode: run.mode,
          status: run.status,
          steps: steps.map(toActiveDelegationStep).sort((left, right) => left.index - right.index),
          stitchedOutput: run.stitchedOutput,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    activeDelegationRun?.attachedTurnId,
    activeDelegationRun?.runId,
    activeDelegationRun?.status,
    activeWorkflowTurn?.trace.orchestration?.runId,
    activeWorkflowTurn?.turnId,
    selectedSession?.sessionId,
  ]);

  const handleRunQuickResearch = useCallback(async () => {
    if (sending) return;
    const session = await ensureSession();
    const query = draft.trim() || messages.filter((item) => item.role === "user").at(-1)?.content || "";
    if (!query) {
      setError("Enter a query first or send a user message before research.");
      return;
    }
    setSending(true);
    try {
      const summary = await runChatResearch(session.sessionId, {
        query,
        mode: prefs?.webMode === "deep" ? "deep" : "quick",
        providerId: prefs?.providerId,
        model: prefs?.model,
      });
      pushLocalNotice(`Research summary:\n${summary.summary}\n\nSources: ${summary.sources.length}`, "success");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [
    draft,
    ensureSession,
    messages,
    prefs?.model,
    prefs?.providerId,
    prefs?.webMode,
    pushLocalNotice,
    sending,
    setError,
    setSending,
  ]);

  const handleProactivePolicyPatch = useCallback(
    async (patch: ChatProactivePolicyPatch) => {
      if (!selectedSession) return;
      lastLocalPrefMutationAtRef.current = Date.now();
      try {
        const updated = await updateChatProactivePolicy(selectedSession.sessionId, patch);
        setProactiveStatus(updated);
        setPrefs((current) =>
          current
            ? {
                ...current,
                proactiveMode: updated.mode,
                autonomyBudget: updated.autonomyBudget,
                retrievalMode: updated.retrievalMode,
                reflectionMode: updated.reflectionMode,
              }
            : current,
        );
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [lastLocalPrefMutationAtRef, selectedSession, setError, setPrefs, setProactiveStatus],
  );

  const handleTriggerProactive = useCallback(async () => {
    if (!selectedSession || sending) return;
    setSending(true);
    try {
      const run = await triggerChatProactive(selectedSession.sessionId, {
        source: "manual",
        reason: "Operator triggered from chat workspace.",
      });
      setProactiveRuns((current) => [run, ...current].slice(0, 30));
      pushLocalNotice(`Proactive run ${run.status}: ${run.reasoningSummary}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [pushLocalNotice, selectedSession, sending, setError, setProactiveRuns, setSending]);

  const handleSuggestDelegation = useCallback(async () => {
    if (!selectedSession || sending) return;
    const objective =
      draft.trim() ||
      messages
        .filter((item) => item.role === "user")
        .at(-1)
        ?.content?.trim() ||
      "";
    if (!objective) {
      setError("Write a request first so I can suggest a delegation plan.");
      return;
    }
    setSending(true);
    try {
      const suggested = await suggestChatDelegation(selectedSession.sessionId, { objective });
      setDelegationSuggestion(suggested.suggestion);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [draft, messages, selectedSession, sending, setError, setSending]);

  const runDelegationAction = useCallback(
    async (sessionId: string, request: ChatDelegateRequest, label: string) => {
      const attachedTurnId = selectedTurn?.turnId ?? null;
      setActiveDelegationRun({
        attachedTurnId,
        label,
        objective: request.objective,
        mode: request.mode ?? "sequential",
        status: "running",
        steps: createSeedDelegationSteps(request),
      });

      if (!streamEnabled) {
        const result = await runChatDelegation(sessionId, request);
        setActiveDelegationRun({
          runId: result.runId,
          taskId: result.taskId,
          executionPlanId: result.executionPlanId,
          attachedTurnId,
          label,
          objective: request.objective,
          mode: request.mode ?? "sequential",
          status: inferDelegationRunStatus(result.steps.map(toActiveDelegationStep)),
          steps: result.steps.map(toActiveDelegationStep).sort((left, right) => left.index - right.index),
          stitchedOutput: result.stitchedOutput,
        });
        return result;
      }

      let finalResult: ChatDelegateResponse | null = null;
      const expectedSteps = request.steps?.length ?? request.roles.length;
      try {
        await streamChatDelegation(sessionId, request, (chunk) => {
          if (chunk.type === "status") {
            setActiveDelegationRun((current) =>
              current
                ? {
                    ...current,
                    runId: chunk.runId ?? current.runId,
                    taskId: chunk.taskId ?? current.taskId,
                  }
                : current,
            );
            if (chunk.message) {
              pushLocalNotice(chunk.message);
            }
            return;
          }
          if (chunk.type === "step" && chunk.step) {
            const nextStep: ActiveChatDelegationStep = {
              stepId: chunk.step.stepId,
              runId: chunk.step.runId,
              role: chunk.step.role,
              status: chunk.step.status as ChatDelegationStepStatus,
              index: chunk.step.index,
              startedAt: chunk.step.startedAt,
              finishedAt: chunk.step.finishedAt,
              durationMs: chunk.step.durationMs,
              output: chunk.step.output,
              error: chunk.step.error,
            };
            setActiveDelegationRun((current) => {
              if (!current) {
                return current;
              }
              const steps = mergeDelegationStep(current.steps, nextStep);
              return {
                ...current,
                runId: chunk.runId ?? current.runId,
                taskId: chunk.taskId ?? current.taskId,
                steps,
                status: inferDelegationRunStatus(steps, "running"),
              };
            });
            if (chunk.step.status === "running") {
              pushLocalNotice(
                `${toTitleCase(chunk.step.role)} started ${label.toLowerCase()} step ${chunk.step.index + 1}/${expectedSteps}.`,
              );
            } else if (chunk.step.status === "completed") {
              pushLocalNotice(
                `${toTitleCase(chunk.step.role)} completed ${label.toLowerCase()} step ${chunk.step.index + 1}/${expectedSteps}.`,
                "success",
              );
            } else if (chunk.step.status === "failed") {
              pushLocalNotice(
                `${toTitleCase(chunk.step.role)} failed ${label.toLowerCase()} step ${chunk.step.index + 1}/${expectedSteps}: ${chunk.step.error ?? "Unknown failure."}`,
                "warning",
              );
            } else if (chunk.step.status === "skipped") {
              pushLocalNotice(
                `${toTitleCase(chunk.step.role)} skipped ${label.toLowerCase()} step ${chunk.step.index + 1}/${expectedSteps}: ${chunk.step.error ?? "Dependency did not settle successfully."}`,
                "warning",
              );
            }
            return;
          }
          if (chunk.type === "done" && chunk.result) {
            finalResult = chunk.result;
            const steps = chunk.result.steps
              .map(toActiveDelegationStep)
              .sort((left, right) => left.index - right.index);
            setActiveDelegationRun((current) => ({
              runId: chunk.result!.runId,
              taskId: chunk.result!.taskId,
              executionPlanId: chunk.result!.executionPlanId,
              attachedTurnId: current?.attachedTurnId ?? attachedTurnId,
              label: current?.label ?? label,
              objective: current?.objective ?? request.objective,
              mode: current?.mode ?? request.mode ?? "sequential",
              status: inferDelegationRunStatus(steps),
              steps,
              stitchedOutput: chunk.result!.stitchedOutput,
            }));
          }
        });
      } catch (error) {
        setActiveDelegationRun((current) =>
          current
            ? {
                ...current,
                status: inferDelegationRunStatus(
                  current.steps,
                  current.steps.some((step) => step.status === "completed") ? "partial" : "failed",
                ),
              }
            : current,
        );
        throw error;
      }

      if (!finalResult) {
        throw new Error(`${label} finished without a final result payload.`);
      }
      return finalResult;
    },
    [pushLocalNotice, selectedTurn?.turnId, streamEnabled],
  );

  const buildDelegationRequest = useCallback(
    (objective: string, roles: string[], mode: NonNullable<ChatDelegateRequest["mode"]>) => {
      const graph = buildDelegationGraph(selectedTurn, roles);
      return {
        objective,
        roles: graph.roles,
        mode,
        providerId: prefs?.providerId,
        model: prefs?.model,
        ...(graph.steps?.length ? { steps: graph.steps } : {}),
      } satisfies ChatDelegateRequest;
    },
    [prefs?.model, prefs?.providerId, selectedTurn],
  );

  const handleAcceptDelegation = useCallback(async () => {
    if (!selectedSession || !delegationSuggestion || sending) return;
    setSending(true);
    try {
      const accepted = await runDelegationAction(
        selectedSession.sessionId,
        buildDelegationRequest(delegationSuggestion.objective, delegationSuggestion.roles, delegationSuggestion.mode),
        "Delegation",
      );
      pushLocalNotice(`Delegation completed:\n${accepted.stitchedOutput}`, "success");
      setDelegationSuggestion(null);
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [
    buildDelegationRequest,
    delegationSuggestion,
    loadSidebar,
    pushLocalNotice,
    runDelegationAction,
    selectedSession,
    sending,
    setError,
    setSending,
  ]);

  const handleRunCodeDelegation = useCallback(
    async (presetKey: keyof typeof CODE_DELEGATION_PRESETS) => {
      if (!selectedSession || sending) {
        return;
      }
      if (codeModeNeedsProjectBinding) {
        setError("Bind this Code session to a project before running delegated implementation work.");
        return;
      }
      const baseObjective =
        draft.trim() ||
        messages
          .filter((item) => item.role === "user")
          .at(-1)
          ?.content?.trim() ||
        selectedSession.title?.trim() ||
        "";
      if (!baseObjective) {
        setError("Write a coding objective first so GoatCitadel has something concrete to implement or review.");
        return;
      }
      const preset = CODE_DELEGATION_PRESETS[presetKey];
      setSending(true);
      try {
        const result = await runDelegationAction(
          selectedSession.sessionId,
          buildDelegationRequest(`${preset.prefix}${baseObjective}`, [...preset.roles], preset.mode),
          preset.label,
        );
        pushLocalNotice(`${preset.label} completed:\n${result.stitchedOutput}`, "success");
        setDelegationSuggestion(null);
        await loadSidebar();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
      }
    },
    [
      buildDelegationRequest,
      codeModeNeedsProjectBinding,
      draft,
      loadSidebar,
      messages,
      pushLocalNotice,
      runDelegationAction,
      selectedSession,
      sending,
      setError,
      setSending,
    ],
  );

  return {
    activeDelegationRun,
    delegationSuggestion,
    setDelegationSuggestion,
    handleRunQuickResearch,
    handleProactivePolicyPatch,
    handleTriggerProactive,
    handleSuggestDelegation,
    handleAcceptDelegation,
    handleRunCodeDelegation,
  };
}
