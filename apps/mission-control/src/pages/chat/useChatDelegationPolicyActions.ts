import type {
  ChatDelegationSuggestionRecord,
  ChatMessageRecord,
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ProactivePolicy,
  ProactiveRunRecord,
} from "@goatcitadel/contracts";
import { useCallback, useState, type MutableRefObject } from "react";
import {
  runChatDelegation,
  runChatResearch,
  streamChatDelegation,
  suggestChatDelegation,
  triggerChatProactive,
  updateChatProactivePolicy,
} from "../../api/client";
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

export function useChatDelegationPolicyActions(input: {
  selectedSession: ChatSessionRecord | null;
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
    async (sessionId: string, request: Parameters<typeof runChatDelegation>[1], label: string) => {
      if (!streamEnabled) {
        return runChatDelegation(sessionId, request);
      }

      let finalResult: Awaited<ReturnType<typeof runChatDelegation>> | null = null;
      await streamChatDelegation(sessionId, request, (chunk) => {
        if (chunk.type === "status" && chunk.message) {
          pushLocalNotice(chunk.message);
          return;
        }
        if (chunk.type === "step" && chunk.step) {
          if (chunk.step.status === "completed") {
            pushLocalNotice(
              `${toTitleCase(chunk.step.role)} completed ${label.toLowerCase()} step ${chunk.step.index + 1}/${request.roles.length}.`,
            );
          } else if (chunk.step.status === "failed") {
            pushLocalNotice(
              `${toTitleCase(chunk.step.role)} failed ${label.toLowerCase()} step ${chunk.step.index + 1}/${request.roles.length}: ${chunk.step.error ?? "Unknown failure."}`,
              "warning",
            );
          }
          return;
        }
        if (chunk.type === "done" && chunk.result) {
          finalResult = chunk.result;
        }
      });

      if (!finalResult) {
        throw new Error(`${label} finished without a final result payload.`);
      }
      return finalResult;
    },
    [pushLocalNotice, streamEnabled],
  );

  const handleAcceptDelegation = useCallback(async () => {
    if (!selectedSession || !delegationSuggestion || sending) return;
    setSending(true);
    try {
      const accepted = await runDelegationAction(
        selectedSession.sessionId,
        {
          objective: delegationSuggestion.objective,
          roles: delegationSuggestion.roles,
          mode: delegationSuggestion.mode,
          providerId: prefs?.providerId,
          model: prefs?.model,
        },
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
    delegationSuggestion,
    loadSidebar,
    prefs?.model,
    prefs?.providerId,
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
          {
            objective: `${preset.prefix}${baseObjective}`,
            roles: [...preset.roles],
            mode: preset.mode,
            providerId: prefs?.providerId,
            model: prefs?.model,
          },
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
      codeModeNeedsProjectBinding,
      draft,
      loadSidebar,
      messages,
      prefs?.model,
      prefs?.providerId,
      pushLocalNotice,
      runDelegationAction,
      selectedSession,
      sending,
      setError,
      setSending,
    ],
  );

  return {
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
