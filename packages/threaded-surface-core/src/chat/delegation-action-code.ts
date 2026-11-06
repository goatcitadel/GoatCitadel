import type { ChatDelegateRequest, ChatDelegateResponse, ChatDelegationStepStatus } from "@goatcitadel/contracts";
import type { Dispatch, SetStateAction } from "react";
import { WORKFLOW_SKILL_CAPTURE_MARKER } from "@goatcitadel/contracts";
import {
  runChatDelegation as apiRunChatDelegation,
  runChatResearch as apiRunChatResearch,
  streamChatDelegation as apiStreamChatDelegation,
  suggestChatDelegation as apiSuggestChatDelegation,
  triggerChatProactive as apiTriggerChatProactive,
} from "@goatcitadel/mission-control-shared/api/chat-optional-actions";
import {
  ApiRequestError,
  updateChatProactivePolicy as apiUpdateChatProactivePolicy,
  fetchChatProactiveStatus as apiFetchChatProactiveStatus,
} from "@goatcitadel/mission-control-shared/api/client";
import { toTitleCase } from "./chat-page-normalizers";
import { CODE_DELEGATION_PRESETS, ExplorerObservationDetachedError, toActiveDelegationStep, toActiveDelegationScopeControl, inferDelegationRunStatus, createSeedDelegationSteps, resolveDelegationMode, resolveDelegationRoute, applyDelegationStatusChunk, applyDelegationStepChunk, applyDelegationStreamFailure, buildDelegationGraph } from "./useChatDelegationPolicyActions";
import type { ActiveChatDelegationStep, ChatProactivePolicyPatch } from "./useChatDelegationPolicyActions";
import type { DelegationActionOwner, DelegationActions } from "./delegation-action-code.types";

function formatDelegationNotice(
  label: string,
  result: ChatDelegateResponse,
): { message: string; tone: "success" | "neutral" | "warning" } {
  const status = result.status ?? inferDelegationRunStatus(result.steps);
  if (status === "running") {
    return {
      message: `${label} is waiting:\n${result.stitchedOutput}`,
      tone: "neutral",
    };
  }
  if (status === "partial") {
    return {
      message: `${label} finished partially:\n${result.stitchedOutput}`,
      tone: "neutral",
    };
  }
  if (status === "failed") {
    return {
      message: `${label} failed:\n${result.stitchedOutput}`,
      tone: "warning",
    };
  }
  return {
    message: `${label} completed:\n${result.stitchedOutput}`,
    tone: "success",
  };
}

export function createDelegationActionCode(owner: DelegationActionOwner): DelegationActions {
  const { selectedSession, draft, messages, prefs, selectedProviderId, selectedModel, surfaceMode, fullWebAccess, streamEnabled, codeModeNeedsProjectBinding, lastLocalPrefMutationAtRef, runtimeBlockerActiveRef } = owner.input;
  const { delegationSuggestion, activeDelegationRun, selectedTurn, activeWorkflowTurn, selectedTurnHasDelegation,
    directDelegationGenerationRef, activeExplorerObservationRef, explorerAttentionGenerationRef, isCurrent } = owner;
  const sending = false; // the mounted wrapper already admitted this attempt
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("Delegation action is no longer current.");
  };
  const guard = <T,>(setter: Dispatch<SetStateAction<T>>): Dispatch<SetStateAction<T>> => update => {
    if (!isCurrent()) return;
    setter(current => {
      if (!isCurrent()) return current;
      return typeof update === "function" ? (update as (value: T) => T)(current) : update;
    });
  };
  const setActiveDelegationRun = guard(owner.setActiveDelegationRun);
  const setDelegationSuggestion = guard(owner.setDelegationSuggestion);
  const setProactivePolicyDraft = guard(owner.setProactivePolicyDraft);
  const setProactivePolicyConflict = guard(owner.setProactivePolicyConflict);
  const setPrefs = guard(owner.input.setPrefs);
  const setProactiveStatus = guard(owner.input.setProactiveStatus);
  const setProactiveRuns = guard(owner.input.setProactiveRuns);
  const setError = (value: string | null) => { if (isCurrent()) owner.input.setError(value); };
  const setSending = (value: boolean) => { if (isCurrent()) owner.input.setSending(value); };
  const pushLocalNotice: typeof owner.input.pushLocalNotice = (...args) => { if (isCurrent()) owner.input.pushLocalNotice(...args); };
  const ensureSession = async () => { assertCurrent(); const result = await owner.input.ensureSession(); assertCurrent(); return result; };
  const loadSidebar = async () => { assertCurrent(); await owner.input.loadSidebar(); assertCurrent(); };
  const refreshSessionAggregate = owner.input.refreshSessionAggregate ? async (sessionId: string) => { assertCurrent(); await owner.input.refreshSessionAggregate!(sessionId); assertCurrent(); } : undefined;
  const runChatDelegation = async (...args: Parameters<typeof apiRunChatDelegation>): Promise<Awaited<ReturnType<typeof apiRunChatDelegation>>> => { assertCurrent(); const result = await apiRunChatDelegation(...args); assertCurrent(); return result; };
  const runChatResearch = async (...args: Parameters<typeof apiRunChatResearch>): Promise<Awaited<ReturnType<typeof apiRunChatResearch>>> => { assertCurrent(); const result = await apiRunChatResearch(...args); assertCurrent(); return result; };
  const streamChatDelegation = async (...args: Parameters<typeof apiStreamChatDelegation>): Promise<Awaited<ReturnType<typeof apiStreamChatDelegation>>> => { assertCurrent(); const result = await apiStreamChatDelegation(...args); assertCurrent(); return result; };
  const suggestChatDelegation = async (...args: Parameters<typeof apiSuggestChatDelegation>): Promise<Awaited<ReturnType<typeof apiSuggestChatDelegation>>> => { assertCurrent(); const result = await apiSuggestChatDelegation(...args); assertCurrent(); return result; };
  const triggerChatProactive = async (...args: Parameters<typeof apiTriggerChatProactive>): Promise<Awaited<ReturnType<typeof apiTriggerChatProactive>>> => { assertCurrent(); const result = await apiTriggerChatProactive(...args); assertCurrent(); return result; };
  const updateChatProactivePolicy = async (...args: Parameters<typeof apiUpdateChatProactivePolicy>): Promise<Awaited<ReturnType<typeof apiUpdateChatProactivePolicy>>> => { assertCurrent(); const result = await apiUpdateChatProactivePolicy(...args); assertCurrent(); return result; };
  const fetchChatProactiveStatus = async (...args: Parameters<typeof apiFetchChatProactiveStatus>): Promise<Awaited<ReturnType<typeof apiFetchChatProactiveStatus>>> => { assertCurrent(); const result = await apiFetchChatProactiveStatus(...args); assertCurrent(); return result; };

  const handleRunQuickResearch = async () => {
    if (sending || runtimeBlockerActiveRef?.current) return;
    const session = await ensureSession();
    const query = draft.trim() || messages.filter((item) => item.role === "user").at(-1)?.content || "";
    if (!query) {
      setError("Enter a query first or send a user message before research.");
      return;
    }
    setSending(true);
    try {
      const policyRunId = activeDelegationRun?.runId ?? activeWorkflowTurn?.trace.orchestration?.runId;
      const policyTaskId = activeDelegationRun?.taskId;
      const summary = await runChatResearch(session.sessionId, {
        query,
        mode: prefs?.webMode === "deep" ? "deep" : "quick",
        providerId: prefs?.providerId ?? selectedProviderId,
        model: prefs?.model ?? selectedModel,
        ...(policyRunId ? { policyRunId } : {}),
        ...(policyTaskId ? { policyTaskId } : {}),
        surface: surfaceMode,
      });
      pushLocalNotice(`Research summary:\n${summary.summary}\n\nSources: ${summary.sources.length}`, "success");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const handleProactivePolicyPatch = async (patch: ChatProactivePolicyPatch) => {
      if (!selectedSession) return;
      lastLocalPrefMutationAtRef.current = Date.now();
      try {
        const updated = await updateChatProactivePolicy(selectedSession.sessionId, {
          ...patch,
          expectedRevision: prefs?.revision ?? selectedSession.revision,
        });
        setProactiveStatus(updated);
        setPrefs((current) =>
          current
            ? {
                ...current,
                revision: updated.revision,
                proactiveMode: updated.mode,
                autonomyBudget: updated.autonomyBudget,
                retrievalMode: updated.retrievalMode,
                reflectionMode: updated.reflectionMode,
              }
            : current,
        );
        setProactivePolicyDraft(null);
        setProactivePolicyConflict(false);
        await (refreshSessionAggregate?.(selectedSession.sessionId) ?? loadSidebar());
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 409) {
          const latest = await fetchChatProactiveStatus(selectedSession.sessionId);
          await (refreshSessionAggregate?.(selectedSession.sessionId) ?? loadSidebar());
          setProactiveStatus(latest.policy);
          setPrefs((current) =>
            current
              ? {
                  ...current,
                  revision: latest.policy.revision,
                  proactiveMode: latest.policy.mode,
                  autonomyBudget: latest.policy.autonomyBudget,
                  retrievalMode: latest.policy.retrievalMode,
                  reflectionMode: latest.policy.reflectionMode,
                }
              : current,
          );
          setProactivePolicyDraft(patch);
          setProactivePolicyConflict(true);
          setError(
            "This chat changed elsewhere. Canonical policy was refreshed; your unsaved policy draft is preserved for review and retry.",
          );
        } else {
          setError((err as Error).message);
        }
      }
    };

  const handleTriggerProactive = async () => {
    if (!selectedSession || sending) return;
    setSending(true);
    try {
      const run = await triggerChatProactive(selectedSession.sessionId, {
        source: "manual",
        reason: `Operator triggered from ${surfaceMode} workspace.`,
        surface: surfaceMode,
      });
      setProactiveRuns((current) => [run, ...current].slice(0, 30));
      pushLocalNotice(`Proactive run ${run.status}: ${run.reasoningSummary}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const handleSuggestDelegation = async () => {
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
    if (objective.startsWith(WORKFLOW_SKILL_CAPTURE_MARKER)) {
      setError("Skill capture drafts instructions in one Chat turn. Send the prepared request to continue.");
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
  };

  const runDelegationAction = async (sessionId: string, request: ChatDelegateRequest, label: string) => {
      const delegationGeneration = directDelegationGenerationRef.current;
      const attachedTurnId = selectedTurn?.turnId ?? null;
      const mode = resolveDelegationMode(request.mode);
      setActiveDelegationRun({
        attachedTurnId,
        label,
        objective: request.objective,
        mode,
        status: "running",
        steps: createSeedDelegationSteps(request),
      });

      const observeAsStream = streamEnabled || request.executionProfile === "read_only_explorer";
      if (!observeAsStream) {
        const result = await runChatDelegation(sessionId, request);
        setActiveDelegationRun({
          runId: result.runId,
          taskId: result.taskId,
          executionPlanId: result.executionPlanId,
          attachedTurnId,
          label,
          objective: request.objective,
          mode,
          status: inferDelegationRunStatus(result.steps.map(toActiveDelegationStep)),
          steps: result.steps.map(toActiveDelegationStep).sort((left, right) => left.index - right.index),
          stitchedOutput: result.stitchedOutput,
          explorer: result.explorer,
        });
        return result;
      }

      let finalResult: ChatDelegateResponse | null = null;
      const expectedSteps = request.steps?.length ?? request.roles.length;
      const explorerObservation =
        request.executionProfile === "read_only_explorer" && request.policyRunId
          ? {
              controller: new AbortController(),
              generation: delegationGeneration,
              sessionId,
              parentRunId: request.policyRunId,
              stepIds: new Set<string>(),
              handoffRequested: false,
            }
          : null;
      if (explorerObservation) {
        activeExplorerObservationRef.current = explorerObservation;
      }
      try {
        const handleChunk: Parameters<typeof streamChatDelegation>[2] = (chunk) => {
          if (!isCurrent() || delegationGeneration !== directDelegationGenerationRef.current) {
            return;
          }
          if (chunk.type === "status") {
            setActiveDelegationRun((current) => applyDelegationStatusChunk(current, chunk));
            if (chunk.message) {
              pushLocalNotice(chunk.message);
            }
            return;
          }
          if (chunk.type === "step" && chunk.step) {
            explorerObservation?.stepIds.add(chunk.step.stepId);
            const nextStep: ActiveChatDelegationStep = {
              stepId: chunk.step.stepId,
              runId: chunk.step.runId,
              role: chunk.step.role,
              label: chunk.step.label,
              status: chunk.step.status as ChatDelegationStepStatus,
              index: chunk.step.index,
              startedAt: chunk.step.startedAt,
              finishedAt: chunk.step.finishedAt,
              durationMs: chunk.step.durationMs,
              summary: chunk.step.summary,
              output: chunk.step.output,
              error: chunk.step.error,
              scopeControl: toActiveDelegationScopeControl(chunk.step.scopeControl),
            };
            setActiveDelegationRun((current) => applyDelegationStepChunk(current, chunk, nextStep));
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
              mode: current?.mode ?? mode,
              status: inferDelegationRunStatus(steps),
              steps,
              stitchedOutput: chunk.result!.stitchedOutput,
              explorer: chunk.result!.explorer,
            }));
          }
        };
        if (explorerObservation) {
          await streamChatDelegation(sessionId, request, handleChunk, {
            signal: explorerObservation.controller.signal,
          });
        } else {
          await streamChatDelegation(sessionId, request, handleChunk);
        }
      } catch (error) {
        if (explorerObservation?.handoffRequested && explorerObservation.controller.signal.aborted) {
          throw new ExplorerObservationDetachedError();
        }
        if (delegationGeneration === directDelegationGenerationRef.current) {
          setActiveDelegationRun((current) => applyDelegationStreamFailure(current));
        }
        throw error;
      } finally {
        if (activeExplorerObservationRef.current === explorerObservation) {
          activeExplorerObservationRef.current = null;
        }
      }

      if (explorerObservation?.handoffRequested && explorerObservation.controller.signal.aborted) {
        throw new ExplorerObservationDetachedError();
      }
      if (!finalResult) {
        throw new Error(`${label} finished without a final result payload.`);
      }
      return finalResult;
    };

  const buildDelegationRequest = (objective: string, roles: string[], mode: NonNullable<ChatDelegateRequest["mode"]>) => {
      const graph = buildDelegationGraph(selectedTurn, roles);
      const route = resolveDelegationRoute(prefs, selectedProviderId, selectedModel);
      const policyRunId = activeDelegationRun?.runId ?? activeWorkflowTurn?.trace.orchestration?.runId;
      const policyTaskId = activeDelegationRun?.taskId;
      return {
        objective,
        roles: graph.roles,
        mode,
        surfaceMode,
        providerId: route.providerId,
        model: route.model,
        ...(fullWebAccess ? { fullWebAccess: true } : {}),
        ...(policyRunId ? { policyRunId } : {}),
        ...(policyTaskId ? { policyTaskId } : {}),
        ...(graph.steps?.length ? { steps: graph.steps } : {}),
      } satisfies ChatDelegateRequest;
    };

  const handleAcceptDelegation = async () => {
    if (!selectedSession || !delegationSuggestion || sending) return;
    setSending(true);
    try {
      const accepted = await runDelegationAction(
        selectedSession.sessionId,
        buildDelegationRequest(delegationSuggestion.objective, delegationSuggestion.roles, delegationSuggestion.mode),
        "Delegation",
      );
      const notice = formatDelegationNotice("Delegation", accepted);
      pushLocalNotice(notice.message, notice.tone);
      setDelegationSuggestion(null);
      await loadSidebar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const handleRunCodeDelegation = async (presetKey: keyof typeof CODE_DELEGATION_PRESETS) => {
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
        const notice = formatDelegationNotice(preset.label, result);
        pushLocalNotice(notice.message, notice.tone);
        setDelegationSuggestion(null);
        await loadSidebar();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
      }
    };

  const handleExploreWorkspace = async () => {
    if (!selectedSession || sending) return;
    if (!selectedSession.projectId) {
      setError("Bind this Chat to a project before exploring its governed workspace scope.");
      return;
    }
    const durableParentRunId = selectedTurn?.trace.durable?.runId;
    if (!durableParentRunId) {
      setError("Send a Chat turn first so workspace exploration can attach to durable progress and recovery.");
      return;
    }
    if (selectedTurnHasDelegation) {
      setError("This Chat turn already owns delegated work. Send a new turn before exploring the workspace.");
      return;
    }
    const objective = draft.trim();
    if (!objective) {
      setError("Write what you want to find, then choose Explore workspace.");
      return;
    }
    const attentionGeneration = ++explorerAttentionGenerationRef.current;
    setSending(true);
    try {
      const route = resolveDelegationRoute(prefs, selectedProviderId, selectedModel);
      const result = await runDelegationAction(
        selectedSession.sessionId,
        {
          objective,
          roles: ["Workspace explorer"],
          mode: "sequential",
          surfaceMode: "chat",
          providerId: route.providerId,
          model: route.model,
          executionProfile: "read_only_explorer",
          policyRunId: durableParentRunId,
        },
        "Workspace exploration",
      );
      const gaps = result.explorer
        ? ` ${result.explorer.partialResult ? "Partial result" : "Complete result"}; ${result.explorer.gaps.length} explicit gap${result.explorer.gaps.length === 1 ? "" : "s"}.`
        : "";
      pushLocalNotice(
        `Workspace exploration ${result.status}.${gaps}`,
        result.status === "failed" ? "warning" : "success",
      );
      await loadSidebar();
    } catch (err) {
      if (!(err instanceof ExplorerObservationDetachedError)) {
        setError((err as Error).message);
      }
    } finally {
      if (explorerAttentionGenerationRef.current === attentionGeneration) {
        setSending(false);
      }
    }
  };

  return { handleRunQuickResearch, handleProactivePolicyPatch, handleTriggerProactive, handleSuggestDelegation, runDelegationAction, handleAcceptDelegation, handleRunCodeDelegation, handleExploreWorkspace };
}
