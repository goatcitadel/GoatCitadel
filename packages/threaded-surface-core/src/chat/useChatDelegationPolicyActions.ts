import type {
  ChatDelegateRequest,
  ChatDelegateResponse,
  ChatDelegationRunStatus,
  ChatDelegationStepRecord,
  ChatDelegationStepStatus,
  ChatDelegationSuggestionRecord,
  ChatMessageRecord,
  ChatMode,
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatThreadResponse,
  ChatThreadTurnRecord,
  DelegatedFilesystemScopePublicProjection,
  ProactivePolicy,
  ProactiveRunRecord,
} from "@goatcitadel/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  fetchChatDelegationRun,
  fetchLatestChatWorkspaceExplorer,
} from "@goatcitadel/mission-control-shared/api/client";
import { resolveActiveWorkflowTurn } from "@goatcitadel/mission-control-shared/components/chat/active-workflow-turn";


import type { ActiveExplorerObservation, DelegationActionOwner, DelegationActions } from "./delegation-action-code.types";

let delegationActionCode: Promise<typeof import("./delegation-action-code")> | undefined;
function loadDelegationActionCode() {
  return delegationActionCode ??= import("./delegation-action-code").catch((error: unknown) => {
    delegationActionCode = undefined;
    throw error;
  });
}

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

export const CODE_DELEGATION_PRESETS = {
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
  label?: string;
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
  workResult?: ChatDelegationStepRecord["workResult"];
  scopeControl?: DelegatedFilesystemScopePublicProjection;
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
  explorer?: ChatDelegateResponse["explorer"];
}

export class ExplorerObservationDetachedError extends Error {
  public constructor() {
    super("Workspace explorer observation continued in background.");
    this.name = "ExplorerObservationDetachedError";
  }
}

export function toActiveDelegationStep(step: ChatDelegationStepRecord): ActiveChatDelegationStep {
  return {
    stepId: step.stepId,
    runId: step.runId,
    role: step.role,
    label: step.label,
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
    workResult: step.workResult,
    scopeControl: toActiveDelegationScopeControl(step.scopeControl),
  };
}

export function toActiveDelegationScopeControl(
  scope: DelegatedFilesystemScopePublicProjection | undefined,
): ActiveChatDelegationStep["scopeControl"] {
  if (!scope) return undefined;
  return {
    ...(scope.workingPath ? { workingPath: scope.workingPath } : {}),
    approvedPaths: [...scope.approvedPaths],
    scopeHash: scope.scopeHash,
    dispatchGeneration: scope.dispatchGeneration,
    updatedAt: scope.updatedAt,
  };
}

export function inferDelegationRunStatus(
  steps: ActiveChatDelegationStep[],
  fallback: ChatDelegationRunStatus = "running",
) {
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

export function createSeedDelegationSteps(request: ChatDelegateRequest): ActiveChatDelegationStep[] {
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

export function resolveDelegationMode(mode: ChatDelegateRequest["mode"]): NonNullable<ChatDelegateRequest["mode"]> {
  return mode ?? "sequential";
}

export function resolveDelegationRoute(
  prefs: ChatSessionPrefsRecord | null,
  selectedProviderId: string | undefined,
  selectedModel: string | undefined,
) {
  return {
    providerId: prefs?.providerId ?? selectedProviderId,
    model: prefs?.model ?? selectedModel,
  };
}

function mergeDelegationStep(
  currentSteps: ActiveChatDelegationStep[],
  nextStep: ActiveChatDelegationStep,
): ActiveChatDelegationStep[] {
  // Assumes `currentSteps` is already sorted by `.index`. Callers seed via
  // `createSeedDelegationSteps` which sorts, and every other code path that
  // builds a fresh list also sorts before assigning. By inserting in-order
  // instead of `.sort()`-ing after every merge, we drop O(n log n) work
  // from every streaming update.
  const matchingIndex = currentSteps.findIndex(
    (step) =>
      step.stepId === nextStep.stepId ||
      (!step.runId && step.index === nextStep.index && step.role.toLowerCase() === nextStep.role.toLowerCase()),
  );
  const mergedStep = matchingIndex >= 0 ? { ...currentSteps[matchingIndex], ...nextStep } : nextStep;
  const remainingSteps =
    matchingIndex >= 0 ? currentSteps.filter((_, position) => position !== matchingIndex) : currentSteps;
  const insertionIndex = remainingSteps.findIndex((step) => step.index > mergedStep.index);
  if (insertionIndex < 0) {
    return [...remainingSteps, mergedStep];
  }
  return [...remainingSteps.slice(0, insertionIndex), mergedStep, ...remainingSteps.slice(insertionIndex)];
}

export function applyDelegationStatusChunk(
  current: ActiveChatDelegationRun | null,
  chunk: { runId?: string; taskId?: string },
): ActiveChatDelegationRun | null {
  return current
    ? {
        ...current,
        runId: chunk.runId ?? current.runId,
        taskId: chunk.taskId ?? current.taskId,
      }
    : current;
}

export function applyDelegationStepChunk(
  current: ActiveChatDelegationRun | null,
  chunk: { runId?: string; taskId?: string },
  nextStep: ActiveChatDelegationStep,
): ActiveChatDelegationRun | null {
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
}

export function applyDelegationStreamFailure(current: ActiveChatDelegationRun | null): ActiveChatDelegationRun | null {
  return current
    ? {
        ...current,
        status: inferDelegationRunStatus(
          current.steps,
          current.steps.some((step) => step.status === "completed") ? "partial" : "failed",
        ),
      }
    : current;
}

export function resolveSelectedTurn(
  thread: ChatThreadResponse | null,
  selectedTurnId: string | null,
): ChatThreadTurnRecord | null {
  if (!thread) {
    return null;
  }
  return thread.turns.find((turn) => turn.turnId === selectedTurnId) ?? thread.turns.at(-1) ?? null;
}

export function shouldHydrateTraceDelegationRun(
  current: Pick<ActiveChatDelegationRun, "runId" | "attachedTurnId" | "status"> | null,
  runId: string,
  turnId: string,
): boolean {
  if (!current || current.attachedTurnId !== turnId) {
    return true;
  }
  return current.runId === runId && current.status === "running";
}

export function buildDelegationGraph(
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

export interface UseChatDelegationPolicyActionsInput {
  selectedSession: ChatSessionRecord | null;
  thread: ChatThreadResponse | null;
  selectedTurnId: string | null;
  draft: string;
  messages: ChatMessageRecord[];
  prefs: ChatSessionPrefsRecord | null;
  selectedProviderId?: string;
  selectedModel?: string;
  surfaceMode: ChatMode;
  fullWebAccess?: boolean;
  sending: boolean;
  streamEnabled: boolean;
  codeModeNeedsProjectBinding: boolean;
  loadSidebar: () => Promise<void>;
  refreshSessionAggregate?: (sessionId: string) => Promise<void>;
  ensureSession: (onResolved?: (session: ChatSessionRecord) => void) => Promise<ChatSessionRecord>;
  setError: (value: string | null) => void;
  setSending: (value: boolean) => void;
  setPrefs: React.Dispatch<React.SetStateAction<ChatSessionPrefsRecord | null>>;
  setProactiveStatus: React.Dispatch<React.SetStateAction<ProactivePolicy | null>>;
  setProactiveRuns: React.Dispatch<React.SetStateAction<ProactiveRunRecord[]>>;
  pushLocalNotice: (content: string, tone?: "neutral" | "success" | "warning") => void;
  lastLocalPrefMutationAtRef: MutableRefObject<number>;
  runtimeBlockerActiveRef?: MutableRefObject<boolean>;
}

export function useChatDelegationPolicyActions(input: UseChatDelegationPolicyActionsInput) {
  const {
    selectedSession,
    draft,
    messages,
    prefs,
    selectedProviderId,
    selectedModel,
    surfaceMode,
    fullWebAccess,
    sending,
    codeModeNeedsProjectBinding,
    setError,
    setSending,
    pushLocalNotice,
    runtimeBlockerActiveRef,
  } = input;

  const [delegationSuggestion, setDelegationSuggestion] = useState<ChatDelegationSuggestionRecord | null>(null);
  const [activeDelegationRun, setActiveDelegationRun] = useState<ActiveChatDelegationRun | null>(null);
  const [proactivePolicyDraft, setProactivePolicyDraft] = useState<ChatProactivePolicyPatch | null>(null);
  const [proactivePolicyConflict, setProactivePolicyConflict] = useState(false);
  const directDelegationGenerationRef = useRef(0);
  const activeExplorerObservationRef = useRef<ActiveExplorerObservation | null>(null);
  const explorerAttentionGenerationRef = useRef(0);
  const selectedTurn = useMemo(
    () => resolveSelectedTurn(input.thread, input.selectedTurnId),
    [input.selectedTurnId, input.thread],
  );

  // A rendered scope lifetime is monotonic, including A -> B -> A navigation.
  const lifetimeRef = useRef(0);
  const mountedRef = useRef(true);
  const attemptRef = useRef<object | null>(null);
  const publicationRef = useRef<object | null>(null);
  const sessionAdoptionRef = useRef<{ token: object; scope: string; adopt: () => void } | null>(null);
  const scopeRoute = resolveDelegationRoute(prefs, selectedProviderId, selectedModel);
  const scopeForSession = (session: ChatSessionRecord | null) => JSON.stringify([
    session?.sessionId, session?.projectId, selectedTurn?.turnId, selectedTurn?.trace.durable?.runId,
    scopeRoute.providerId, scopeRoute.model, input.fullWebAccess, input.codeModeNeedsProjectBinding,
    input.surfaceMode, session?.workspaceId,
  ]);
  const scope = scopeForSession(selectedSession);
  const scopeRef = useRef(scope);
  const releaseOnScopeChangeRef = useRef(false);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    lifetimeRef.current += 1;
    const adoption = sessionAdoptionRef.current;
    if (adoption && adoption.token === attemptRef.current && adoption.scope === scope && !runtimeBlockerActiveRef?.current) {
      // ensureSession independently confirmed this exact creation before selecting it.
      adoption.adopt();
    } else {
      directDelegationGenerationRef.current += 1;
      explorerAttentionGenerationRef.current += 1;
      releaseOnScopeChangeRef.current = attemptRef.current !== null;
      attemptRef.current = null;
      publicationRef.current = null;
      activeExplorerObservationRef.current?.controller.abort();
      activeExplorerObservationRef.current = null;
    }
    sessionAdoptionRef.current = null;
  }
  useEffect(() => {
    if (releaseOnScopeChangeRef.current) {
      releaseOnScopeChangeRef.current = false;
      setSending(false);
    }
  }, [scope, setSending]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      directDelegationGenerationRef.current += 1;
      attemptRef.current = null;
      publicationRef.current = null;
      sessionAdoptionRef.current = null;
      activeExplorerObservationRef.current?.controller.abort();
      activeExplorerObservationRef.current = null;
    };
  }, []);
  const renderLifetime = lifetimeRef.current;

  const selectedSessionIdRef = useRef(selectedSession?.sessionId);
  const selectedDurableParentRunIdRef = useRef(selectedTurn?.trace.durable?.runId);
  selectedSessionIdRef.current = selectedSession?.sessionId;
  selectedDurableParentRunIdRef.current = selectedTurn?.trace.durable?.runId;
  const activeWorkflowTurn = useMemo(() => resolveActiveWorkflowTurn(input.thread), [input.thread]);
  const selectedTurnHasDelegation = Boolean(
    selectedTurn?.trace.orchestration?.runId ||
    (activeDelegationRun?.runId && activeDelegationRun.attachedTurnId === selectedTurn?.turnId),
  );
  const workspaceExplorerEligible = Boolean(
    selectedSession?.projectId && selectedTurn?.trace.durable?.runId && !selectedTurnHasDelegation,
  );
  const activeDelegationRunId = activeDelegationRun?.runId;
  const activeDelegationAttachedTurnId = activeDelegationRun?.attachedTurnId;
  const activeDelegationStatus = activeDelegationRun?.status;
  const activeDelegationHydrationState = useMemo(
    () =>
      activeDelegationStatus
        ? {
            runId: activeDelegationRunId,
            attachedTurnId: activeDelegationAttachedTurnId,
            status: activeDelegationStatus,
          }
        : null,
    [activeDelegationAttachedTurnId, activeDelegationRunId, activeDelegationStatus],
  );

  useEffect(() => {
    setActiveDelegationRun(null);
    setProactivePolicyDraft(null);
    setProactivePolicyConflict(false);
  }, [selectedSession?.sessionId]);

  useEffect(() => {
    const runId = activeWorkflowTurn?.trace.orchestration?.runId;
    const turnId = activeWorkflowTurn?.turnId ?? null;
    const sessionId = selectedSession?.sessionId;
    if (!runId || !turnId || !sessionId || input.thread?.sessionId !== sessionId) {
      return;
    }
    if (!shouldHydrateTraceDelegationRun(activeDelegationHydrationState, runId, turnId)) {
      return;
    }
    let cancelled = false;
    void fetchChatDelegationRun(sessionId, runId)
      .then(({ run, steps, explorer }) => {
        if (cancelled) {
          return;
        }
        setActiveDelegationRun((current) => {
          if (!shouldHydrateTraceDelegationRun(current, runId, turnId)) {
            return current;
          }
          if (current?.runId === runId && current.attachedTurnId === turnId && current.status === "running") {
            return current;
          }
          return {
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
            explorer,
          };
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setActiveDelegationRun((current) =>
          current?.runId === runId && current.attachedTurnId === turnId ? null : current,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeDelegationHydrationState,
    activeWorkflowTurn?.trace.orchestration?.runId,
    activeWorkflowTurn?.turnId,
    input.thread?.sessionId,
    selectedSession?.sessionId,
  ]);

  useEffect(() => {
    const sessionId = selectedSession?.sessionId;
    if (!sessionId || input.thread?.sessionId !== sessionId) return;
    const requestGeneration = directDelegationGenerationRef.current;
    let cancelled = false;
    void fetchLatestChatWorkspaceExplorer(sessionId)
      .then((detail) => {
        if (cancelled || requestGeneration !== directDelegationGenerationRef.current || !detail) return;
        const attachedTurn = detail.run.parentRunId
          ? input.thread?.turns.find((turn) => turn.trace.durable?.runId === detail.run.parentRunId)
          : undefined;
        const attachedTurnId = attachedTurn?.turnId ?? null;
        const traceDelegationRunId = activeWorkflowTurn?.trace.orchestration?.runId;
        const explorerBelongsToActiveParent =
          Boolean(detail.run.parentRunId) && detail.run.parentRunId === activeWorkflowTurn?.trace.durable?.runId;
        setActiveDelegationRun((current) => {
          if (traceDelegationRunId && !explorerBelongsToActiveParent) return current;
          if (
            current?.runId &&
            current.runId !== detail.run.runId &&
            !(current.runId === traceDelegationRunId && explorerBelongsToActiveParent)
          ) {
            return current;
          }
          return {
            runId: detail.run.runId,
            taskId: detail.run.taskId,
            executionPlanId: detail.run.executionPlanId,
            attachedTurnId,
            label: "Workspace exploration",
            objective: detail.run.objective,
            mode: detail.run.mode,
            status: detail.run.status,
            steps: detail.steps.map(toActiveDelegationStep).sort((left, right) => left.index - right.index),
            stitchedOutput: detail.run.stitchedOutput,
            explorer: detail.explorer,
          };
        });
      })
      .catch((error: unknown) => {
        if (cancelled || activeWorkflowTurn?.trace.orchestration?.runId) return;
        const failureKind = error instanceof Error ? error.name : "UnknownError";
        pushLocalNotice(
          `Workspace explorer history is temporarily unavailable (${failureKind}); current Chat turns are unchanged.`,
          "warning",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeWorkflowTurn?.trace.durable?.runId,
    activeWorkflowTurn?.trace.orchestration?.runId,
    input.thread,
    pushLocalNotice,
    selectedSession?.sessionId,
  ]);

  const continueActiveExplorerInBackground = useCallback(
    (input: { parentRunId: string; watcherId: string }): boolean => {
      const observation = activeExplorerObservationRef.current;
      const stepId = input.watcherId.startsWith("delegation-child:")
        ? input.watcherId.slice("delegation-child:".length)
        : "";
      if (
        !observation ||
        observation.sessionId !== selectedSession?.sessionId ||
        observation.parentRunId !== input.parentRunId ||
        !stepId ||
        !observation.stepIds.has(stepId) ||
        observation.controller.signal.aborted
      ) {
        return false;
      }
      observation.handoffRequested = true;
      if (directDelegationGenerationRef.current === observation.generation) {
        directDelegationGenerationRef.current += 1;
      }
      explorerAttentionGenerationRef.current += 1;
      attemptRef.current = null;
      publicationRef.current = null;
      setSending(false);
      observation.controller.abort();
      return true;
    },
    [selectedSession?.sessionId, setSending],
  );

  const rehydrateBackgroundExplorerReport = useCallback(
    async (input: {
      parentRunId: string;
      delegationRunId: string;
      delegationStepId: string;
      childRunId: string;
    }): Promise<boolean> => {
      const sessionId = selectedSession?.sessionId;
      const attachedTurnId = selectedTurn?.turnId ?? null;
      const requestGeneration = directDelegationGenerationRef.current;
      if (
        !sessionId ||
        selectedDurableParentRunIdRef.current !== input.parentRunId ||
        activeDelegationRun?.runId !== input.delegationRunId ||
        activeDelegationRun.label !== "Workspace exploration"
      ) {
        return false;
      }
      try {
        const detail = await fetchChatDelegationRun(sessionId, input.delegationRunId);
        if (
          requestGeneration !== directDelegationGenerationRef.current ||
          selectedSessionIdRef.current !== sessionId ||
          selectedDurableParentRunIdRef.current !== input.parentRunId ||
          detail.run.runId !== input.delegationRunId ||
          detail.run.sessionId !== sessionId ||
          detail.run.parentRunId !== input.parentRunId ||
          detail.run.status === "running" ||
          !detail.explorer
        ) {
          return false;
        }
        const settledStep = detail.steps.find((step) => step.stepId === input.delegationStepId);
        if (!settledStep || settledStep.durableRunId !== input.childRunId) {
          return false;
        }
        setActiveDelegationRun((current) => {
          if (
            requestGeneration !== directDelegationGenerationRef.current ||
            current?.runId !== detail.run.runId ||
            current.attachedTurnId !== attachedTurnId ||
            current.label !== "Workspace exploration"
          ) {
            return current;
          }
          return {
            runId: detail.run.runId,
            taskId: detail.run.taskId,
            executionPlanId: detail.run.executionPlanId,
            attachedTurnId,
            label: "Workspace exploration",
            objective: detail.run.objective,
            mode: detail.run.mode,
            status: detail.run.status,
            steps: detail.steps.map(toActiveDelegationStep).sort((left, right) => left.index - right.index),
            stitchedOutput: detail.run.stitchedOutput,
            explorer: detail.explorer,
          };
        });
        return true;
      } catch {
        // The durable rail remains canonical and will offer another refresh
        // snapshot; a transient report read must not change execution state.
        return false;
      }
    },
    [activeDelegationRun?.label, activeDelegationRun?.runId, selectedSession?.sessionId, selectedTurn?.turnId],
  );


  // Admission and visible seed state belong to the mounted owner, before any import.
  const prepareDelegation = (method: keyof DelegationActions, args: unknown[]): { request: ChatDelegateRequest; label: string } | null => {
    if (method === "handleAcceptDelegation" && delegationSuggestion) {
      return { request: buildSeedRequest(delegationSuggestion.objective, delegationSuggestion.roles, delegationSuggestion.mode), label: "Delegation" };
    }
    if (method === "handleRunCodeDelegation" && selectedSession) {
      const preset = CODE_DELEGATION_PRESETS[args[0] as keyof typeof CODE_DELEGATION_PRESETS];
      const objective = draft.trim() || messages.filter(item => item.role === "user").at(-1)?.content?.trim() || selectedSession.title?.trim() || "";
      if (!objective || codeModeNeedsProjectBinding) return null;
      return { request: buildSeedRequest(preset.prefix + objective, [...preset.roles], preset.mode), label: preset.label };
    }
    if (method === "handleExploreWorkspace" && selectedSession?.projectId && selectedTurn?.trace.durable?.runId && !selectedTurnHasDelegation && draft.trim()) {
      const route = resolveDelegationRoute(prefs, selectedProviderId, selectedModel);
      return { request: { objective: draft.trim(), roles: ["Workspace explorer"], mode: "sequential", surfaceMode: "chat", ...route, executionProfile: "read_only_explorer", policyRunId: selectedTurn.trace.durable.runId }, label: "Workspace exploration" };
    }
    return null;
  };
  const buildSeedRequest = (objective: string, roles: string[], mode: NonNullable<ChatDelegateRequest["mode"]>): ChatDelegateRequest => {
    const graph = buildDelegationGraph(selectedTurn, roles);
    const route = resolveDelegationRoute(prefs, selectedProviderId, selectedModel);
    const policyRunId = activeDelegationRun?.runId ?? activeWorkflowTurn?.trace.orchestration?.runId;
    return { objective, ...graph, mode, surfaceMode, ...route,
      ...(fullWebAccess ? { fullWebAccess: true } : {}),
      ...(policyRunId ? { policyRunId } : {}),
      ...(activeDelegationRun?.taskId ? { policyTaskId: activeDelegationRun.taskId } : {}) };
  };
  async function invoke<K extends Exclude<keyof DelegationActions, "runDelegationAction">>(method: K, ...args: Parameters<DelegationActions[K]>): Promise<void> {
    const policy = method === "handleProactivePolicyPatch";
    if (!mountedRef.current || renderLifetime !== lifetimeRef.current || (!policy && (attemptRef.current || sending || runtimeBlockerActiveRef?.current))) return;
    if (method !== "handleRunQuickResearch" && !selectedSession) return;
    if (method === "handleAcceptDelegation" && !delegationSuggestion) return;
    if (method === "handleRunCodeDelegation" && codeModeNeedsProjectBinding) {
      setError("Bind this Code session to a project before running delegated implementation work.");
      return;
    }
    if (method === "handleExploreWorkspace") {
      const error = !selectedSession?.projectId ? "Bind this Chat to a project before exploring its governed workspace scope."
        : !selectedTurn?.trace.durable?.runId ? "Send a Chat turn first so workspace exploration can attach to durable progress and recovery."
        : selectedTurnHasDelegation ? "This Chat turn already owns delegated work. Send a new turn before exploring the workspace."
        : !draft.trim() ? "Write what you want to find, then choose Explore workspace." : null;
      if (error) { setError(error); return; }
    }
    const prepared = prepareDelegation(method, args);
    if (method === "handleRunCodeDelegation" && !prepared) {
      setError("Write a coding objective first so GoatCitadel has something concrete to implement or review.");
      return;
    }
    const token = {};
    let actionLifetime = renderLifetime;
    if (!policy) {
      attemptRef.current = token;
      publicationRef.current = token;
    }
    // Completed updates may still be queued in React after busy ownership releases.
    const isCurrent = () => mountedRef.current && actionLifetime === lifetimeRef.current && (policy || publicationRef.current === token) && !runtimeBlockerActiveRef?.current;
    if (!policy) setSending(true);
    if (prepared) {
      directDelegationGenerationRef.current += 1;
      setActiveDelegationRun({ attachedTurnId: selectedTurn?.turnId ?? null, label: prepared.label,
        objective: prepared.request.objective, mode: resolveDelegationMode(prepared.request.mode), status: "running", steps: createSeedDelegationSteps(prepared.request) });
    }
    const actionInput = method === "handleRunQuickResearch" && !selectedSession ? {
      ...input,
      ensureSession: async () => {
        let confirmedScope: string | undefined;
        const result = await input.ensureSession(created => {
          if (!isCurrent() || !created.sessionId) return;
          confirmedScope = scopeForSession(created);
          sessionAdoptionRef.current = {
            token, scope: confirmedScope, adopt: () => { actionLifetime = lifetimeRef.current; },
          };
        });
        if (confirmedScope && scopeForSession(result) !== confirmedScope) {
          throw new Error("Created conversation does not match its confirmed research owner.");
        }
        return result;
      },
    } : input;
    const owner: DelegationActionOwner = { input: actionInput, delegationSuggestion, activeDelegationRun, selectedTurn,
      activeWorkflowTurn, selectedTurnHasDelegation, setActiveDelegationRun, setDelegationSuggestion,
      setProactivePolicyDraft, setProactivePolicyConflict, directDelegationGenerationRef,
      activeExplorerObservationRef, explorerAttentionGenerationRef, isCurrent };
    let codeLoaded = false;
    try {
      const code = await loadDelegationActionCode();
      if (!isCurrent()) return;
      codeLoaded = true;
      const actions = code.createDelegationActionCode(owner);
      const action = actions[method] as (...parameters: Parameters<DelegationActions[K]>) => Promise<void>;
      await action(...args);
    } catch (error) {
      if (isCurrent()) {
        if (!codeLoaded && prepared) setActiveDelegationRun(activeDelegationRun);
        setError((error as Error).message);
      }
    } finally {
      if (sessionAdoptionRef.current?.token === token) sessionAdoptionRef.current = null;
      if (!policy && mountedRef.current && actionLifetime === lifetimeRef.current && attemptRef.current === token) {
        attemptRef.current = null;
        setSending(false);
      }
    }
  }
  const handleRunQuickResearch = () => invoke("handleRunQuickResearch");
  const handleProactivePolicyPatch = (patch: ChatProactivePolicyPatch) => invoke("handleProactivePolicyPatch", patch);
  const handleTriggerProactive = () => invoke("handleTriggerProactive");
  const handleSuggestDelegation = () => invoke("handleSuggestDelegation");
  const handleAcceptDelegation = () => invoke("handleAcceptDelegation");
  const handleRunCodeDelegation = (preset: keyof typeof CODE_DELEGATION_PRESETS) => invoke("handleRunCodeDelegation", preset);
  const handleExploreWorkspace = () => invoke("handleExploreWorkspace");

  return {
    activeDelegationRun,
    delegationSuggestion,
    setDelegationSuggestion,
    handleRunQuickResearch,
    proactivePolicyDraft,
    proactivePolicyConflict,
    handleProactivePolicyPatch,
    handleTriggerProactive,
    handleSuggestDelegation,
    handleAcceptDelegation,
    handleRunCodeDelegation,
    handleExploreWorkspace,
    continueActiveExplorerInBackground,
    rehydrateBackgroundExplorerReport,
    workspaceExplorerEligible,
  };
}
