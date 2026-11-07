import type { ChatSessionRecord, ChatThreadResponse, ChatUserInputPromptResponse } from "@goatcitadel/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getGatewayAccessRevision, getGatewayCallerScopeRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { fetchChatPendingApprovals } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { recordChatApprovalPhase } from "./chat-causality";
import {
  deriveThreadPendingApproval,
  isApprovalForCancelledTurn,
  mergePendingApproval,
  type PendingApprovalRecord,
} from "./chat-pending-approval";
import {
  deriveThreadPendingUserInput,
  mergePendingUserInput,
  type PendingUserInputRecord,
} from "./chat-pending-user-input";
import type { ChatOutboundErrorSetter, ChatThreadCommitter } from "./useChatOutboundExecution.types";
import { loadOperatorPromptActionCode } from "./load-operator-prompt-action-code";

type PromptActionCode = Awaited<ReturnType<typeof loadOperatorPromptActionCode>>;
type PromptActionAttempt = { scopeCurrent: () => boolean };
type PromptScope = {
  sessionId: string | null;
  workspaceId?: string;
  active: boolean;
  lifetime: number;
  timers: Set<ReturnType<typeof setTimeout>>;
};
export type OperatorPromptCustody = {
  historicalRevisionRef?: { readonly current: number };
  historicalReadOnly?: boolean;
  selectionRevisionRef?: { readonly current: number };
};

interface UseChatOperatorPromptsInput extends OperatorPromptCustody {
  workspaceId?: string;
  selectedSessionId: string | null;
  selectedSession: ChatSessionRecord | null;
  thread: ChatThreadResponse | null;
  loadSessionCoreState: (
    sessionId: string,
    options?: { background?: boolean; includeThread?: boolean },
  ) => Promise<void>;
  pushLocalNotice: (content: string, tone?: "neutral" | "success" | "warning") => void;
  setError: ChatOutboundErrorSetter;
  commitThreadUpdate: ChatThreadCommitter;
}

export function useChatOperatorPrompts({
  workspaceId,
  historicalRevisionRef,
  historicalReadOnly,
  selectionRevisionRef,
  selectedSessionId,
  selectedSession,
  thread,
  loadSessionCoreState,
  pushLocalNotice,
  setError,
  commitThreadUpdate,
}: UseChatOperatorPromptsInput) {
  const historicalRevision = historicalRevisionRef?.current;
  const selectionRevision = selectionRevisionRef?.current;
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalRecord | null>(null);
  const [pendingUserInput, setPendingUserInput] = useState<PendingUserInputRecord | null>(null);
  const [approvalAttempt, setApprovalAttempt] = useState<PromptActionAttempt | null>(null);
  const [inputAttempt, setInputAttempt] = useState<PromptActionAttempt | null>(null);
  const actionAttempts = useRef<Record<"approval" | "user_input", PromptActionAttempt | null>>({
    approval: null,
    user_input: null,
  });
  const setActionPending = useCallback((source: "approval" | "user_input", attempt: PromptActionAttempt | null) => {
    if (source === "approval") setApprovalAttempt(attempt);
    else setInputAttempt(attempt);
  }, []);
  const promptsRef = useRef({ approval: pendingApproval, userInput: pendingUserInput });
  useLayoutEffect(() => {
    promptsRef.current = { approval: pendingApproval, userInput: pendingUserInput };
  }, [pendingApproval, pendingUserInput]);
  // Approvals the persisted queue reported as stale (decided, expired, or superseded). A thread
  // snapshot that still shows the turn waiting must not reopen one of these and block the composer.
  const settledApprovalIdsRef = useRef<Set<string>>(new Set());
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const scopeRef = useRef<PromptScope>({
    sessionId: selectedSessionId,
    workspaceId,
    active: true,
    lifetime: 0,
    timers: new Set(),
  });
  if (scopeRef.current.sessionId !== selectedSessionId || scopeRef.current.workspaceId !== workspaceId)
    scopeRef.current = { sessionId: selectedSessionId, workspaceId, active: true, lifetime: 0, timers: new Set() };
  const scope = scopeRef.current;
  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      scope.lifetime += 1;
      for (const timer of scope.timers) clearTimeout(timer);
      scope.timers.clear();
    };
  }, [scope]);

  const refreshPendingApprovalQueue = useCallback(async (sessionId: string, isCancelled?: () => boolean) => {
    const response = await fetchChatPendingApprovals(sessionId);
    if (isCancelled?.()) return;
    for (const item of response.items) if (item.stale) settledApprovalIdsRef.current.add(item.approvalId);
    const activeItems = response.items.filter(
      (item) => !item.stale && !isApprovalForCancelledTurn(threadRef.current, item.approvalId),
    );
    const riskCounts = activeItems.reduce<Record<string, number>>((counts, item) => {
      const key = item.riskLevel ?? "unknown";
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    recordClientDiagnostic({
      level: "debug",
      category: "chat",
      event: "approval.queue_synced",
      message: "Synced pending approval queue",
      sessionId,
      context: {
        pendingCount: activeItems.length,
        activeApprovalId: response.activeApprovalId,
        riskCounts,
      },
    });
    const active = activeItems.find((item) => item.approvalId === response.activeApprovalId) ?? activeItems[0] ?? null;
    if (isCancelled?.()) return;
    if (!active) {
      setPendingApproval((current) => (isCancelled?.() ? current : null));
      return;
    }
    const nextApproval = {
      approvalId: active.approvalId,
      sessionId: active.sessionId ?? sessionId,
      kind: active.kind,
      toolName: active.toolName,
      reason: active.reason,
      riskLevel: active.riskLevel,
      expiresAt: active.expiresAt,
      codeHash: typeof active.details?.codeHash === "string" ? active.details.codeHash : undefined,
      wrapperManifestHash:
        typeof active.details?.wrapperManifestHash === "string" ? active.details.wrapperManifestHash : undefined,
      capabilitySnapshotId:
        typeof active.details?.capabilitySnapshotId === "string" ? active.details.capabilitySnapshotId : undefined,
      inspectPath: typeof active.details?.inspectPath === "string" ? active.details.inspectPath : undefined,
      requestedOutputIntent:
        typeof active.details?.requestedOutputIntent === "string" ? active.details.requestedOutputIntent : undefined,
      saveCandidateOnSuccess:
        typeof active.details?.saveCandidateOnSuccess === "boolean" ? active.details.saveCandidateOnSuccess : undefined,
      remainingCount: response.remainingCount,
      affectedResources: Array.isArray(active.details?.affectedResources)
        ? active.details.affectedResources.filter((value): value is string => typeof value === "string")
        : undefined,
      codePreview: typeof active.details?.codePreview === "string" ? active.details.codePreview : undefined,
    };
    setPendingApproval((current) => {
      if (isCancelled?.()) return current;
      const changed =
        !current ||
        current.approvalId !== nextApproval.approvalId ||
        current.sessionId !== nextApproval.sessionId ||
        current.toolName !== nextApproval.toolName ||
        current.reason !== nextApproval.reason ||
        current.riskLevel !== nextApproval.riskLevel ||
        current.remainingCount !== nextApproval.remainingCount;
      if (changed) {
        recordChatApprovalPhase({
          phase: "prompt_arrived",
          sessionId,
          approval: {
            approvalId: nextApproval.approvalId,
            toolName: nextApproval.toolName,
            kind: nextApproval.kind,
            reason: nextApproval.reason,
            riskLevel: nextApproval.riskLevel,
            remainingCount: nextApproval.remainingCount,
            affectedResourceCount: nextApproval.affectedResources?.length,
            requestedOutputIntent: nextApproval.requestedOutputIntent,
            expiresAt: nextApproval.expiresAt,
          },
          source: "queue",
          level: "debug",
          context: {
            queueDepth: activeItems.length,
            riskCounts,
          },
        });
      }
      return nextApproval;
    });
  }, []);

  // A shared decision owner can resolve without invoking Chat's legacy approve/deny action.
  // Re-read both canonical owners; a decision alone never advances execution or clears a prompt.
  const refreshThreadAndApprovals = useCallback(async () => {
    if (!selectedSessionId || !scope.active || scopeRef.current !== scope) return;
    const revision = getGatewayAccessRevision();
    const stale = () => !scope.active || scopeRef.current !== scope || revision !== getGatewayAccessRevision();
    try {
      await Promise.all([
        refreshPendingApprovalQueue(selectedSessionId, stale),
        loadSessionCoreState(selectedSessionId, { background: true, includeThread: true }),
      ]);
    } catch (err) {
      if (!stale()) setError((err as Error).message, "approval");
    }
  }, [loadSessionCoreState, refreshPendingApprovalQueue, scope, selectedSessionId, setError]);

  useEffect(() => {
    const threadApproval = deriveThreadPendingApproval(thread);
    if (!selectedSessionId) {
      setPendingApproval(null);
      setPendingUserInput(null);
      return;
    }
    if (threadApproval && !settledApprovalIdsRef.current.has(threadApproval.approvalId)) {
      setPendingApproval((current) => {
        const merged = mergePendingApproval(current, threadApproval);
        if (
          merged &&
          (!current ||
            current.approvalId !== merged.approvalId ||
            current.sessionId !== merged.sessionId ||
            current.toolName !== merged.toolName ||
            current.reason !== merged.reason)
        ) {
          recordChatApprovalPhase({
            phase: "prompt_merged",
            sessionId: selectedSessionId,
            turnId: thread?.selectedTurnId ?? thread?.activeLeafTurnId,
            approval: merged,
            source: "thread",
            level: "info",
          });
        }
        return merged;
      });
    } else {
      setPendingApproval((current) => {
        if (!current) {
          return null;
        }
        if (isApprovalForCancelledTurn(thread, current.approvalId)) return null;
        if (settledApprovalIdsRef.current.has(current.approvalId)) return null;
        // The persisted approval queue is authoritative. A repaired or briefly
        // stale thread snapshot can say `completed` while the approval remains
        // pending, so do not hide an actionable prompt from the same session.
        return current.sessionId && current.sessionId !== selectedSessionId ? null : current;
      });
    }

    const threadUserInput = deriveThreadPendingUserInput(thread);
    if (threadUserInput) {
      setPendingUserInput((current) => mergePendingUserInput(current, threadUserInput));
    } else {
      setPendingUserInput(null);
    }
  }, [selectedSessionId, thread]);

  useEffect(() => {
    if (!selectedSessionId || selectedSession?.sessionId !== selectedSessionId) {
      return;
    }
    let cancelled = false;
    void refreshPendingApprovalQueue(selectedSessionId, () => cancelled).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshPendingApprovalQueue, scope, selectedSessionId, selectedSession?.sessionId]);

  const runPromptAction = useCallback(
    async <T>(
      source: "approval" | "user_input" | "branch_select",
      run: (code: PromptActionCode, scopeCurrent: () => boolean) => Promise<T>,
      intentCurrent: () => boolean = () => true,
    ) => {
      const access = getGatewayAccessRevision();
      const caller = getGatewayCallerScopeRevision();
      const installation = getGatewayApiBaseUrl();
      const lifetime = scope.lifetime;
      const scopeCurrent = () =>
        scope.active &&
        scopeRef.current === scope &&
        scope.lifetime === lifetime &&
        !historicalReadOnly &&
        historicalRevisionRef?.current === historicalRevision &&
        selectionRevisionRef?.current === selectionRevision &&
        getGatewayAccessRevision() === access &&
        getGatewayCallerScopeRevision() === caller &&
        getGatewayApiBaseUrl() === installation;
      if (!scopeCurrent() || !intentCurrent()) return;
      const attempt = { scopeCurrent };
      if (source !== "branch_select") {
        if (actionAttempts.current[source]?.scopeCurrent()) return;
        actionAttempts.current[source] = attempt;
        setActionPending(source, attempt);
      }
      let dispatchStarted = false;
      try {
        const code = await loadOperatorPromptActionCode();
        if (!scopeCurrent() || !intentCurrent()) return;
        dispatchStarted = true;
        return await run(code, scopeCurrent);
      } catch (err) {
        if (scopeCurrent() && (dispatchStarted || intentCurrent())) {
          setError(err instanceof Error ? err.message : String(err), source);
        }
        return null;
      } finally {
        if (source !== "branch_select" && actionAttempts.current[source] === attempt) {
          actionAttempts.current[source] = null;
          if (scopeRef.current.active) setActionPending(source, null);
        }
      }
    },
    [scope, historicalReadOnly, historicalRevisionRef, historicalRevision, selectionRevisionRef, selectionRevision, setError, setActionPending],
  );

  const handleSelectBranchTurn = useCallback(
    (turnId: string) =>
      selectedSessionId
        ? runPromptAction("branch_select", (code, current) =>
            code.selectOperatorBranch(selectedSessionId, turnId, current, commitThreadUpdate),
          )
        : Promise.resolve(undefined),
    [commitThreadUpdate, selectedSessionId, runPromptAction],
  );

  const handleApprovalDecision = useCallback(
    async (allowScope?: "once" | "session" | "workspace") => {
      if (!selectedSessionId || selectedSession?.sessionId !== selectedSessionId || !pendingApproval) return;
      const sessionId = selectedSession.sessionId;
      const approvalSessionId = pendingApproval.sessionId?.trim() || sessionId;
      const matches = (prompt: PendingApprovalRecord | null) =>
        prompt !== null &&
        prompt.approvalId === pendingApproval.approvalId &&
        (prompt.sessionId?.trim() || sessionId) === approvalSessionId;
      await runPromptAction(
        "approval",
        (code, current) =>
          code.decideOperatorApproval(
            {
              sessionId,
              current,
              notice: pushLocalNotice,
              loadCore: loadSessionCoreState,
              refreshQueue: refreshPendingApprovalQueue,
              timers: scope.timers,
              clearApproval: () => setPendingApproval((prompt) => (current() && matches(prompt) ? null : prompt)),
            },
            pendingApproval,
            allowScope,
          ),
        () => matches(promptsRef.current.approval),
      );
    },
    [loadSessionCoreState, pendingApproval, pushLocalNotice, refreshPendingApprovalQueue, selectedSession, selectedSessionId, runPromptAction, scope],
  );
  const handleApprovePending = useCallback(
    (allowScope: "once" | "session" | "workspace" = "once") => handleApprovalDecision(allowScope),
    [handleApprovalDecision],
  );
  const handleDenyPending = useCallback(() => handleApprovalDecision(), [handleApprovalDecision]);

  const handleSubmitUserInput = useCallback(
    async (response: ChatUserInputPromptResponse) => {
      if (!selectedSessionId || selectedSession?.sessionId !== selectedSessionId || !pendingUserInput) return;
      const sessionId = selectedSession.sessionId;
      const matches = (prompt: PendingUserInputRecord | null) =>
        prompt !== null && prompt.promptId === pendingUserInput.promptId && prompt.turnId === pendingUserInput.turnId;
      await runPromptAction(
        "user_input",
        (code, current) =>
          code.submitOperatorPrompt(
            {
              sessionId,
              current,
              notice: pushLocalNotice,
              loadCore: loadSessionCoreState,
              clearInput: () => setPendingUserInput((prompt) => (current() && matches(prompt) ? null : prompt)),
            },
            pendingUserInput,
            response,
          ),
        () => matches(promptsRef.current.userInput),
      );
    },
    [loadSessionCoreState, pendingUserInput, pushLocalNotice, selectedSession, selectedSessionId, runPromptAction],
  );

  return {
    pendingApproval,
    setPendingApproval,
    pendingUserInput,
    setPendingUserInput,
    approvalPending: Boolean(approvalAttempt?.scopeCurrent()),
    userInputPending: Boolean(inputAttempt?.scopeCurrent()),
    handleApprovePending,
    handleDenyPending,
    handleSubmitUserInput,
    handleSelectBranchTurn,
    refreshThreadAndApprovals,
  };
}
