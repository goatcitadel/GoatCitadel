import type { ChatSessionRecord, ChatThreadResponse, ChatUserInputPromptResponse } from "@goatcitadel/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  answerChatUserInputPrompt,
  approveChatTool,
  denyChatTool,
  fetchChatPendingApprovals,
  selectChatBranchTurn,
} from "@goatcitadel/mission-control-shared/api/client";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { recordChatApprovalPhase } from "./chat-causality";
import { deriveThreadPendingApproval, mergePendingApproval, type PendingApprovalRecord } from "./chat-pending-approval";
import {
  deriveThreadPendingUserInput,
  mergePendingUserInput,
  type PendingUserInputRecord,
} from "./chat-pending-user-input";
import type { ChatOutboundErrorSetter, ChatThreadCommitter } from "./useChatOutboundExecution.types";

const APPROVAL_RESUMED_REFRESH_DELAYS_MS = [750, 2_000] as const;
const APPROVAL_FALLBACK_REFRESH_DELAYS_MS = [500, 1_500, 3_000] as const;

interface UseChatOperatorPromptsInput {
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
  selectedSessionId,
  selectedSession,
  thread,
  loadSessionCoreState,
  pushLocalNotice,
  setError,
  commitThreadUpdate,
}: UseChatOperatorPromptsInput) {
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalRecord | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [pendingUserInput, setPendingUserInput] = useState<PendingUserInputRecord | null>(null);
  const [userInputPending, setUserInputPending] = useState(false);
  const approvalRefreshTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const refreshPendingApprovalQueue = useCallback(async (sessionId: string, isCancelled?: () => boolean) => {
    const response = await fetchChatPendingApprovals(sessionId);
    const activeItems = response.items.filter((item) => !item.stale);
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
    if (isCancelled?.()) {
      // The selected session moved on while this fetch was in flight; do not apply a stale
      // session's approval to the now-current session. Effect-driven calls pass isCancelled;
      // handler-driven calls (approve/deny) omit it so their result is always applied.
      return;
    }
    if (!active) {
      setPendingApproval(null);
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

  useEffect(() => {
    const threadApproval = deriveThreadPendingApproval(thread);
    if (!selectedSessionId) {
      setPendingApproval(null);
      setPendingUserInput(null);
      return;
    }
    if (threadApproval) {
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
    if (!selectedSession?.sessionId) {
      return;
    }
    let cancelled = false;
    void refreshPendingApprovalQueue(selectedSession.sessionId, () => cancelled).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshPendingApprovalQueue, selectedSession?.sessionId]);

  const handleSelectBranchTurn = useCallback(
    async (turnId: string) => {
      if (!selectedSessionId) {
        return;
      }
      try {
        recordClientDiagnostic({
          level: "info",
          category: "chat",
          event: "branch.select",
          message: "Selecting chat branch turn",
          sessionId: selectedSessionId,
          turnId,
        });
        const nextThread = await selectChatBranchTurn(selectedSessionId, turnId);
        commitThreadUpdate(nextThread);
        return nextThread;
      } catch (err) {
        setError((err as Error).message, "branch_select");
        return null;
      }
    },
    [commitThreadUpdate, selectedSessionId, setError],
  );

  const handleApprovePending = useCallback(
    async (allowScope: "once" | "session" | "workspace" = "once") => {
      if (!selectedSession || !pendingApproval) return;
      const approvalSessionId = pendingApproval.sessionId?.trim() || selectedSession.sessionId;
      setApprovalPending(true);
      try {
        recordChatApprovalPhase({
          phase: "resolve_started",
          sessionId: approvalSessionId,
          approval: {
            approvalId: pendingApproval.approvalId,
            toolName: pendingApproval.toolName,
            kind: pendingApproval.kind,
            reason: pendingApproval.reason,
            riskLevel: pendingApproval.riskLevel,
            remainingCount: pendingApproval.remainingCount,
            affectedResourceCount: pendingApproval.affectedResources?.length,
            requestedOutputIntent: pendingApproval.requestedOutputIntent,
            expiresAt: pendingApproval.expiresAt,
          },
          source: "operator",
          context: { allowScope, selectedSessionId: selectedSession.sessionId },
        });
        const result = await approveChatTool(approvalSessionId, pendingApproval.approvalId, { allowScope });
        setPendingApproval(null);
        await refreshPendingApprovalQueue(approvalSessionId);
        await loadSessionCoreState(selectedSession.sessionId, { background: true, includeThread: true }).catch(
          () => undefined,
        );
        if (approvalSessionId !== selectedSession.sessionId) {
          await refreshPendingApprovalQueue(selectedSession.sessionId).catch(() => undefined);
        }
        const refreshDelaysMs = result.resumed
          ? APPROVAL_RESUMED_REFRESH_DELAYS_MS
          : APPROVAL_FALLBACK_REFRESH_DELAYS_MS;
        for (const delayMs of refreshDelaysMs) {
          const timer = globalThis.setTimeout(() => {
            approvalRefreshTimersRef.current.delete(timer);
            void refreshPendingApprovalQueue(approvalSessionId).catch(() => undefined);
            void loadSessionCoreState(selectedSession.sessionId, { background: true, includeThread: true }).catch(
              () => undefined,
            );
            if (approvalSessionId !== selectedSession.sessionId) {
              void refreshPendingApprovalQueue(selectedSession.sessionId).catch(() => undefined);
            }
          }, delayMs);
          approvalRefreshTimersRef.current.add(timer);
        }
        const scopeLabel =
          allowScope === "session"
            ? "Session allow created."
            : allowScope === "workspace"
              ? "Workspace allow created."
              : "Approved once.";
        pushLocalNotice(
          `Approved request ${pendingApproval.approvalId}. ${scopeLabel} ${
            result.resumed
              ? "The runtime resumed immediately."
              : "If the run is no longer live, use Approvals & Recovery to continue from the persisted checkpoint."
          }`,
          "success",
        );
        recordChatApprovalPhase({
          phase: "resolved",
          sessionId: approvalSessionId,
          approval: {
            approvalId: pendingApproval.approvalId,
            toolName: pendingApproval.toolName,
            kind: pendingApproval.kind,
            reason: pendingApproval.reason,
            riskLevel: pendingApproval.riskLevel,
            remainingCount: pendingApproval.remainingCount,
            affectedResourceCount: pendingApproval.affectedResources?.length,
            requestedOutputIntent: pendingApproval.requestedOutputIntent,
            expiresAt: pendingApproval.expiresAt,
          },
          source: "operator",
          context: {
            allowScope,
            resumed: result.resumed,
            resumedRunId: result.resumedRunId,
            resumedTurnId: result.resumedTurnId,
            selectedSessionId: selectedSession.sessionId,
          },
        });
      } catch (err) {
        setError((err as Error).message, "approval");
      } finally {
        setApprovalPending(false);
      }
    },
    [loadSessionCoreState, pendingApproval, pushLocalNotice, refreshPendingApprovalQueue, selectedSession, setError],
  );

  const handleDenyPending = useCallback(async () => {
    if (!selectedSession || !pendingApproval) return;
    const approvalSessionId = pendingApproval.sessionId?.trim() || selectedSession.sessionId;
    setApprovalPending(true);
    try {
      recordChatApprovalPhase({
        phase: "resolve_started",
        sessionId: approvalSessionId,
        approval: {
          approvalId: pendingApproval.approvalId,
          toolName: pendingApproval.toolName,
          kind: pendingApproval.kind,
          reason: pendingApproval.reason,
          riskLevel: pendingApproval.riskLevel,
          remainingCount: pendingApproval.remainingCount,
          affectedResourceCount: pendingApproval.affectedResources?.length,
          requestedOutputIntent: pendingApproval.requestedOutputIntent,
          expiresAt: pendingApproval.expiresAt,
        },
        source: "operator",
        context: { selectedSessionId: selectedSession.sessionId },
      });
      await denyChatTool(approvalSessionId, pendingApproval.approvalId);
      await refreshPendingApprovalQueue(approvalSessionId);
      if (approvalSessionId !== selectedSession.sessionId) {
        await refreshPendingApprovalQueue(selectedSession.sessionId).catch(() => undefined);
        await loadSessionCoreState(selectedSession.sessionId, { background: true, includeThread: true }).catch(
          () => undefined,
        );
      }
      pushLocalNotice(`Denied request ${pendingApproval.approvalId}. No action was taken.`, "warning");
      recordChatApprovalPhase({
        phase: "dismissed",
        sessionId: approvalSessionId,
        approval: {
          approvalId: pendingApproval.approvalId,
          toolName: pendingApproval.toolName,
          kind: pendingApproval.kind,
          reason: pendingApproval.reason,
          riskLevel: pendingApproval.riskLevel,
          remainingCount: pendingApproval.remainingCount,
          affectedResourceCount: pendingApproval.affectedResources?.length,
          requestedOutputIntent: pendingApproval.requestedOutputIntent,
          expiresAt: pendingApproval.expiresAt,
        },
        source: "operator",
        context: { selectedSessionId: selectedSession.sessionId },
      });
    } catch (err) {
      setError((err as Error).message, "approval");
    } finally {
      setApprovalPending(false);
    }
  }, [loadSessionCoreState, pendingApproval, pushLocalNotice, refreshPendingApprovalQueue, selectedSession, setError]);

  const handleSubmitUserInput = useCallback(
    async (response: ChatUserInputPromptResponse) => {
      if (!selectedSession || !pendingUserInput) return;
      setUserInputPending(true);
      try {
        const result = await answerChatUserInputPrompt(
          selectedSession.sessionId,
          pendingUserInput.turnId,
          pendingUserInput.promptId,
          {
            response,
          },
        );
        setPendingUserInput(null);
        pushLocalNotice(
          result.resumed
            ? `Submitted response for ${pendingUserInput.promptId}. The turn resumed immediately.`
            : `Submitted response for ${pendingUserInput.promptId}. Refresh the thread or resume the run when the runtime is ready.`,
          "success",
        );
        await loadSessionCoreState(selectedSession.sessionId, {
          background: true,
          includeThread: true,
        });
      } catch (err) {
        setError((err as Error).message, "user_input");
      } finally {
        setUserInputPending(false);
      }
    },
    [loadSessionCoreState, pendingUserInput, pushLocalNotice, selectedSession, setError],
  );

  useEffect(() => {
    const approvalRefreshTimers = approvalRefreshTimersRef.current;
    return () => {
      for (const timer of approvalRefreshTimers) {
        clearTimeout(timer);
      }
      approvalRefreshTimers.clear();
    };
  }, [selectedSessionId]);

  return {
    pendingApproval,
    setPendingApproval,
    pendingUserInput,
    setPendingUserInput,
    approvalPending,
    userInputPending,
    handleApprovePending,
    handleDenyPending,
    handleSubmitUserInput,
    handleSelectBranchTurn,
  };
}
