import {
  getGatewayCallerScopeRevision,
  getGatewayAccessRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { isBackgroundChatUserInputPrompt } from "@goatcitadel/contracts";
import type {
  ChatMessageRecord,
  ChatMode,
  RoutingPreflightResult,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isThreadMutatingStreamChunk,
  updateThreadFromStreamChunk,
} from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import type { ChatStreamStatus } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import {
  clearChatStreamActivity,
  recordChatStreamChunkActivity,
} from "@goatcitadel/mission-control-shared/state/chat-stream-activity-store";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { createChatExecutionCorrelationId, recordChatApprovalPhase, recordChatOutboundPhase } from "./chat-causality";
import { isAbortError } from "./chat-page-derivations";
import { shouldApplyFetchedMessagesAfterStream, shouldExecuteLocalChatCommand } from "./chat-page-pure-helpers";
import type { ChatErrorSource } from "./chat-error-copy";
import { useChatOperatorPrompts } from "./useChatOperatorPrompts";
import { useChatRetainedStreamReattachment } from "./useChatRetainedStreamReattachment";
import { useChatStreamingPreviewState } from "./useChatStreamingPreviewState";
import type { OutboundQueueItem, OutboundRequestPrefsSnapshot } from "./useChatSurfaceOrchestration";
import type { ActiveChatStreamState, UseChatOutboundExecutionInput } from "./useChatOutboundExecution.types";
export type {
  ActiveChatStreamState,
  PendingApprovalState,
  PendingUserInputState,
  UseChatOutboundExecutionInput,
} from "./useChatOutboundExecution.types";

export function abortActiveChatStream(stream: ActiveChatStreamState | null): void {
  if (!stream || stream.controller.signal.aborted) {
    return;
  }
  stream.controller.abort();
}

/**
 * HX-407 C3 seam: the queue-frozen external-source selection rides each send
 * item as `externalContextRefs`; this callback fires exactly once per item that
 * completed WITHOUT throwing, so the owning selection state clears only after a
 * successful send (failed and aborted sends retain the selection).
 */
export interface UseChatOutboundExternalContext {
  onExternalContextSent?: (item: OutboundQueueItem) => void;
  onTemplateInvocationSent?: (item: OutboundQueueItem) => void;
  onWorkspaceSnapshotFailed?: (item: OutboundQueueItem) => void;
}

export interface OptimisticChatUserMessage {
  queueItemId: string;
  messageId: string;
  sessionId?: string;
  canonicalMessageId?: string;
  content: string;
  timestamp: string;
  attachments?: ChatMessageRecord["attachments"];
}

type OutboundExecutionPrefsSource = Pick<
  ChatSessionPrefsRecord,
  "memoryMode" | "webMode" | "thinkingLevel" | "speedMode" | "subagentPolicy"
>;

export function resolveOutboundExecutionPrefs(prefs: OutboundExecutionPrefsSource | null | undefined) {
  const memoryMode = prefs?.memoryMode ?? "auto";
  return {
    useMemory: memoryMode !== "off",
    webMode: prefs?.webMode ?? "auto",
    memoryMode,
    thinkingLevel: prefs?.thinkingLevel ?? "standard",
    speedMode: prefs?.speedMode ?? "standard",
    subagentPolicy: prefs?.subagentPolicy ?? "ask_when_useful",
  };
}

export function captureOutboundRequestPrefsSnapshot(input: {
  prefs: ChatSessionPrefsRecord | null | undefined;
  selectedProviderId?: string;
  selectedModel?: string;
  fullWebAccess?: boolean;
}): OutboundRequestPrefsSnapshot {
  const executionPrefs = resolveOutboundExecutionPrefs(input.prefs);
  return Object.freeze({
    mode: "chat",
    providerId: input.prefs?.providerId ?? input.selectedProviderId,
    model: input.prefs?.model ?? input.selectedModel,
    webMode: executionPrefs.webMode,
    memoryMode: executionPrefs.memoryMode,
    thinkingLevel: executionPrefs.thinkingLevel,
    speedMode: executionPrefs.speedMode,
    subagentPolicy: executionPrefs.subagentPolicy,
    fullWebAccess: Boolean(input.fullWebAccess),
  });
}

let outboundCodePromise: Promise<typeof import("./outbound-execution-code.js")> | null = null;
function loadOutboundExecutionCode() {
  if (!outboundCodePromise) {
    outboundCodePromise = import("./outbound-execution-code.js").catch((cause) => {
      outboundCodePromise = null;
      throw cause;
    });
  }
  return outboundCodePromise;
}

export function useChatOutboundExecution(
  input: UseChatOutboundExecutionInput & { externalContext?: UseChatOutboundExternalContext; workspaceId?: string },
) {
  const { sessionConfig, streamConfig, stateConfig, stateSetters, operations, refs, routing } = input;
  // Synced ref: the callback stays render-current without widening the
  // executeOutboundItem dependency list (the standard pattern in this hook).
  const onExternalContextSentRef = useRef(input.externalContext?.onExternalContextSent);
  onExternalContextSentRef.current = input.externalContext?.onExternalContextSent;
  const onTemplateInvocationSentRef = useRef(input.externalContext?.onTemplateInvocationSent);
  onTemplateInvocationSentRef.current = input.externalContext?.onTemplateInvocationSent;
  const onWorkspaceSnapshotFailedRef = useRef(input.externalContext?.onWorkspaceSnapshotFailed);
  onWorkspaceSnapshotFailedRef.current = input.externalContext?.onWorkspaceSnapshotFailed;
  const { selectedSessionId, selectedSession, prefs, fullWebAccess, selectedProviderId, selectedModel } = sessionConfig;
  const { streamEnabled, visualStreamMode = "smooth", activeStreamRef } = streamConfig;
  const outboundMountedRef = useRef(true);
  const outboundSelectionRef = useRef({ sessionId: selectedSessionId, workspaceId: input.workspaceId, revision: 0 });
  if (
    outboundSelectionRef.current.sessionId !== selectedSessionId ||
    outboundSelectionRef.current.workspaceId !== input.workspaceId
  ) {
    outboundSelectionRef.current = {
      sessionId: selectedSessionId,
      workspaceId: input.workspaceId,
      revision: outboundSelectionRef.current.revision + 1,
    };
  }
  type PendingOutboundCode = {
    controller: AbortController;
    selection: typeof outboundSelectionRef.current;
    isCurrent: () => boolean;
  };
  const pendingOutboundCodeRef = useRef<PendingOutboundCode | null>(null);
  const renderedOutboundSelection = outboundSelectionRef.current;
  const renderedCallerRevision = getGatewayCallerScopeRevision();
  const renderedAccessRevision = getGatewayAccessRevision();
  const renderedGatewayBase = getGatewayApiBaseUrl();
  const { sending, error, errorSource, queuedOutbound, thread, messages } = stateConfig;
  const {
    setThread,
    setError,
    setSending,
    setDraft,
    setPendingAttachments,
    setEditingTurnId,
    setCapabilitySuggestions,
    setSpecialistSuggestions,
  } = stateSetters;
  const { loadSidebar, loadSessionCoreState, ensureSession, pushLocalNotice, handleCommandExecution } = operations;
  const { executeOutboundItemRef, tryBeginOutboundExecutionRef, applyFetchedThreadRef, messageMutationVersionRef } =
    refs;
  const { ensureFreshRoutePreflight, isRoutePreflightAcknowledged } = routing;

  const getOutboundErrorSource = useCallback((action: OutboundQueueItem["action"]): ChatErrorSource => {
    if (action === "edit") {
      return "edit";
    }
    if (action === "send") {
      return "send";
    }
    return "other";
  }, []);

  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const latestMessagesRef = useRef<ChatMessageRecord[]>(messages);
  const streamReconcileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);
  const locallyHandledTurnKeysRef = useRef(new Set<string>());
  const prefsRef = useRef<ChatSessionPrefsRecord | null>(prefs);
  const threadRef = useRef<ChatThreadResponse | null>(thread);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<OptimisticChatUserMessage | null>(null);
  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    latestMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  const commitThreadUpdate = useCallback(
    (updater: ChatThreadResponse | null | ((current: ChatThreadResponse | null) => ChatThreadResponse | null)) => {
      setThread((current) => {
        const next = typeof updater === "function" ? updater(current) : updater;
        if (next !== current) {
          messageMutationVersionRef.current += 1;
        }
        return next;
      });
    },
    [messageMutationVersionRef, setThread],
  );

  const {
    streamingPreview,
    activeStreamingTurnId,
    finalizedStreamMessageRef,
    getStreamingPreviewBuffer,
    clearStreamingPreview,
    promoteStreamingPreviewToThread,
    disposeStreamingPreview,
  } = useChatStreamingPreviewState({
    selectedSessionId,
    visualStreamMode,
    commitThreadUpdate,
    prefsRef,
  });

  useChatRetainedStreamReattachment({
    selectedSessionId,
    thread,
    streamEnabled,
    activeStreamRef,
    sendingRef,
    locallyHandledTurnKeysRef,
    setSending,
    getStreamingPreviewBuffer,
    clearStreamingPreview,
    loadSessionCoreState,
    pushLocalNotice,
  });

  const {
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
    refreshThreadAndApprovals,
  } = useChatOperatorPrompts({
    selectedSessionId,
    selectedSession,
    thread,
    loadSessionCoreState,
    pushLocalNotice,
    setError,
    commitThreadUpdate,
  });

  const applyFetchedThread = useCallback(
    (nextThread: ChatThreadResponse, requestVersion: number | null) => {
      if (requestVersion !== null && requestVersion !== messageMutationVersionRef.current) {
        recordClientDiagnostic({
          level: "debug",
          category: "chat",
          event: "thread.reconcile",
          message: "Rejected fetched thread because the request version is stale",
          sessionId: nextThread.sessionId,
          context: {
            requestVersion,
            turnCount: nextThread.turns.length,
            reason: "request_version_mismatch",
            currentVersion: messageMutationVersionRef.current,
          },
        });
        recordChatOutboundPhase({
          phase: "thread_reconcile_rejected",
          action: "send",
          correlationId: activeStreamRef.current?.streamToken ?? nextThread.sessionId,
          sessionId: nextThread.sessionId,
          message: "Rejected fetched thread because the request version is stale",
          level: "debug",
          context: {
            requestVersion,
            currentVersion: messageMutationVersionRef.current,
            reason: "request_version_mismatch",
          },
        });
        return false;
      }
      const items = nextThread.turns.flatMap((turn) => [
        turn.userMessage,
        ...(turn.assistantMessage ? [turn.assistantMessage] : []),
      ]);
      if (!shouldApplyFetchedMessagesAfterStream(latestMessagesRef.current, items, finalizedStreamMessageRef.current)) {
        recordClientDiagnostic({
          level: "debug",
          category: "chat",
          event: "thread.reconcile",
          message: "Rejected fetched thread because the finalized streamed assistant message is newer",
          sessionId: nextThread.sessionId,
          context: {
            requestVersion,
            turnCount: nextThread.turns.length,
            reason: "finalized_stream_newer",
          },
        });
        recordChatOutboundPhase({
          phase: "thread_reconcile_rejected",
          action: "send",
          correlationId: finalizedStreamMessageRef.current?.messageId ?? nextThread.sessionId,
          sessionId: nextThread.sessionId,
          message: "Rejected fetched thread because the finalized streamed assistant message is newer",
          level: "debug",
          context: {
            reason: "finalized_stream_newer",
            requestVersion,
          },
        });
        return false;
      }
      const activeStream = activeStreamRef.current;
      if (activeStream?.sessionId === nextThread.sessionId && activeStream.turnId) {
        const includesActiveTurn = nextThread.turns.some((turn) => turn.turnId === activeStream.turnId);
        if (!includesActiveTurn) {
          recordClientDiagnostic({
            level: "debug",
            category: "chat",
            event: "thread.reconcile",
            message: "Rejected fetched thread because the active stream turn is still missing",
            sessionId: nextThread.sessionId,
            turnId: activeStream.turnId,
            context: {
              requestVersion,
              turnCount: nextThread.turns.length,
              reason: "missing_active_stream_turn",
            },
          });
          recordChatOutboundPhase({
            phase: "thread_reconcile_rejected",
            action: "send",
            correlationId: activeStream.streamToken,
            sessionId: nextThread.sessionId,
            turnId: activeStream.turnId,
            message: "Rejected fetched thread because the active stream turn is still missing",
            level: "debug",
            context: {
              reason: "missing_active_stream_turn",
              requestVersion,
            },
          });
          return false;
        }
      }
      if (finalizedStreamMessageRef.current) {
        finalizedStreamMessageRef.current = null;
      }
      recordClientDiagnostic({
        level: "debug",
        category: "chat",
        event: "thread.reconcile",
        message: "Applying fetched thread state",
        sessionId: nextThread.sessionId,
        context: {
          requestVersion,
          turnCount: nextThread.turns.length,
          applied: true,
        },
      });
      recordChatOutboundPhase({
        phase: "thread_reconcile_applied",
        action: "send",
        correlationId: activeStream?.streamToken ?? nextThread.sessionId,
        sessionId: nextThread.sessionId,
        turnId: activeStream?.turnId,
        message: "Applied fetched thread state after background reconciliation",
        level: "debug",
        context: {
          requestVersion,
          turnCount: nextThread.turns.length,
        },
      });
      commitThreadUpdate(nextThread);
      return true;
    },
    [activeStreamRef, commitThreadUpdate, finalizedStreamMessageRef, messageMutationVersionRef],
  );
  // These callback refs are intentionally refreshed during render so sibling
  // orchestration hooks can call the current implementation before effects run.
  applyFetchedThreadRef.current = applyFetchedThread;

  const scheduleStreamMessageReconciliation = useCallback(
    (sessionId: string, options?: { immediate?: boolean }) => {
      if (streamReconcileTimeoutRef.current) {
        clearTimeout(streamReconcileTimeoutRef.current);
      }
      const versionAtSchedule = messageMutationVersionRef.current;
      streamReconcileTimeoutRef.current = setTimeout(
        () => {
          streamReconcileTimeoutRef.current = null;
          if (selectedSessionIdRef.current !== sessionId) {
            return;
          }
          if (messageMutationVersionRef.current !== versionAtSchedule) {
            scheduleStreamMessageReconciliation(sessionId);
            return;
          }
          void loadSessionCoreState(sessionId, {
            background: true,
            includeThread: true,
          }).catch((err: Error) => setError(err.message, "refresh"));
        },
        options?.immediate ? 0 : 400,
      );
    },
    [loadSessionCoreState, messageMutationVersionRef, setError],
  );

  const tryBeginOutboundExecution = useCallback(() => {
    const pending = pendingOutboundCodeRef.current;
    if (pending && !pending.isCurrent()) {
      pending.controller.abort();
      pendingOutboundCodeRef.current = null;
      sendingRef.current = false;
    }
    if (sendingRef.current) {
      return false;
    }
    sendingRef.current = true;
    setSending(true);
    return true;
  }, [setSending]);

  const finishOutboundExecution = useCallback(() => {
    sendingRef.current = false;
    setSending(false);
  }, [setSending]);

  // See the note above applyFetchedThreadRef: this must stay current for the
  // queue-drain hook even during the render that creates a new callback.
  tryBeginOutboundExecutionRef.current = tryBeginOutboundExecution;

  const executeOutboundItem = useCallback(
    async (item: OutboundQueueItem) => {
      if (
        !outboundMountedRef.current ||
        outboundSelectionRef.current !== renderedOutboundSelection ||
        getGatewayCallerScopeRevision() !== renderedCallerRevision ||
        getGatewayAccessRevision() !== renderedAccessRevision ||
        getGatewayApiBaseUrl() !== renderedGatewayBase
      )
        return;
      const preflightHash = (value: RoutingPreflightResult | null) => (value ? JSON.stringify(value) : null);
      const executionCorrelationId = createChatExecutionCorrelationId();
      const trimmedContent = item.content.trim();
      const attachmentsSnapshot = item.attachments;
      const attachmentIds = attachmentsSnapshot.map((entry) => entry.attachmentId);
      // Queue-frozen external-source selection: sends carry exactly the refs
      // captured at enqueue time (never re-read from live selection state).
      const externalContextRefs =
        item.action === "send" && item.externalContextRefs && item.externalContextRefs.length > 0
          ? item.externalContextRefs.map((ref) => ({ ...ref }))
          : undefined;
      const externalContextOptIn = externalContextRefs ? { contextRefs: externalContextRefs } : {};
      const templateInvocationOptIn =
        item.action === "send" && item.templateInvocation ? { templateInvocation: item.templateInvocation } : {};
      const workspaceSnapshotOptIn =
        item.action === "send" && item.workspaceSnapshot ? { workspaceSnapshot: item.workspaceSnapshot } : {};
      const currentPrefs = prefsRef.current;
      const requestPrefs =
        item.requestPrefs ??
        captureOutboundRequestPrefsSnapshot({
          prefs: currentPrefs,
          selectedProviderId,
          selectedModel,
          fullWebAccess,
        });
      const effectiveMode: ChatMode = requestPrefs.mode;
      const executionProviderId = requestPrefs.providerId;
      const executionModel = requestPrefs.model;
      const outboundPrefs = resolveOutboundExecutionPrefs(requestPrefs);
      const councilOptIn = item.modelCouncil ? { modelCouncil: item.modelCouncil } : {};
      const optimisticPrefs =
        currentPrefs && (executionProviderId || executionModel)
          ? {
              ...currentPrefs,
              mode: effectiveMode,
              providerId: executionProviderId,
              model: executionModel,
              webMode: requestPrefs.webMode,
              memoryMode: requestPrefs.memoryMode,
              thinkingLevel: requestPrefs.thinkingLevel,
              speedMode: requestPrefs.speedMode,
              subagentPolicy: requestPrefs.subagentPolicy,
            }
          : currentPrefs;
      const localAttachments = attachmentsSnapshot.map((entry) => ({
        attachmentId: entry.attachmentId,
        fileName: entry.fileName,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
      }));
      const localUserMessageId = `local-user-${item.id}`;
      const shouldProjectOptimisticUserMessage =
        item.action === "send" && !shouldExecuteLocalChatCommand(item.action, trimmedContent);
      if (shouldProjectOptimisticUserMessage) {
        const optimisticSessionId = item.sessionId ?? selectedSessionId ?? undefined;
        setOptimisticUserMessage({
          queueItemId: item.id,
          messageId: localUserMessageId,
          ...(optimisticSessionId ? { sessionId: optimisticSessionId } : {}),
          content: (item.displayContent ?? trimmedContent).trim(),
          timestamp: item.createdAt,
          attachments: localAttachments.length > 0 ? localAttachments : undefined,
        });
      }

      const codeController = new AbortController();
      const admissionScope = outboundSelectionRef.current;
      const callerRevision = getGatewayCallerScopeRevision();
      const accessRevision = getGatewayAccessRevision();
      const gatewayBase = getGatewayApiBaseUrl();
      const pendingCode: PendingOutboundCode = {
        controller: codeController,
        selection: admissionScope,
        isCurrent: () => isCurrentCustody(),
      };
      pendingOutboundCodeRef.current = pendingCode;
      let ownedSelection = admissionScope;
      let resolvedSession: ChatSessionRecord | null = null;
      let creationSelectionBound = false;
      const isCurrentCustody = () => {
        const selection = outboundSelectionRef.current;
        if (
          selection !== ownedSelection &&
          !creationSelectionBound &&
          resolvedSession &&
          admissionScope.sessionId === null &&
          selection.revision === admissionScope.revision + 1 &&
          selection.sessionId === resolvedSession.sessionId &&
          selection.workspaceId === admissionScope.workspaceId
        ) {
          ownedSelection = selection;
          pendingCode.selection = selection;
          creationSelectionBound = true;
        }
        return (
          outboundMountedRef.current &&
          selection === ownedSelection &&
          pendingOutboundCodeRef.current === pendingCode &&
          !codeController.signal.aborted &&
          getGatewayCallerScopeRevision() === callerRevision &&
          getGatewayAccessRevision() === accessRevision &&
          getGatewayApiBaseUrl() === gatewayBase
        );
      };
      const assertCurrentCustody = () => {
        if (!isCurrentCustody())
          throw new DOMException("Outbound conversation custody changed before dispatch.", "AbortError");
      };
      const acceptResolvedSession = (session: ChatSessionRecord) => {
        if (admissionScope.workspaceId !== undefined && session.workspaceId !== admissionScope.workspaceId)
          throw new Error("The resolved conversation does not match the outbound workspace.");
        if (admissionScope.sessionId !== null && session.sessionId !== admissionScope.sessionId)
          throw new Error("The resolved conversation does not match the outbound selection.");
        if (resolvedSession && resolvedSession.sessionId !== session.sessionId)
          throw new Error("The resolved conversation changed during outbound creation.");
        if (!resolvedSession) resolvedSession = session;
        assertCurrentCustody();
      };
      const ensureOwnedSession = async () => {
        assertCurrentCustody();
        // The canonical owner publishes the verified record before selecting it or awaiting sidebar hydration.
        const session = await ensureSession(acceptResolvedSession);
        acceptResolvedSession(session);
        return session;
      };
      let executionStarted = false;
      try {
        const code = await loadOutboundExecutionCode();
        assertCurrentCustody();
        const execute = code.createOutboundExecutionHandler({
          activeStreamRef,
          selectedSessionIdRef,
          threadRef,
          locallyHandledTurnKeysRef,
          finalizedStreamMessageRef,
          clearStreamingPreview,
          getStreamingPreviewBuffer,
          promoteStreamingPreviewToThread,
          commitThreadUpdate,
          setError,
          setDraft,
          setPendingAttachments,
          setEditingTurnId,
          setCapabilitySuggestions,
          setSpecialistSuggestions,
          setOptimisticUserMessage,
          setPendingApproval,
          setPendingUserInput,
          ensureSession: ensureOwnedSession,
          loadSidebar,
          loadSessionCoreState,
          handleCommandExecution,
          pushLocalNotice,
          ensureFreshRoutePreflight,
          isRoutePreflightAcknowledged,
          finishOutboundExecution,
          getOutboundErrorSource,
          scheduleStreamMessageReconciliation,
          onExternalContextSentRef,
          onTemplateInvocationSentRef,
          onWorkspaceSnapshotFailedRef,
          streamEnabled,
          isBackgroundChatUserInputPrompt,
          isThreadMutatingStreamChunk,
          updateThreadFromStreamChunk,
          clearChatStreamActivity,
          recordChatStreamChunkActivity,
          recordClientDiagnostic,
          recordChatApprovalPhase,
          recordChatOutboundPhase,
          isAbortError,
          shouldExecuteLocalChatCommand,
          assertCurrentCustody,
          isCurrentCustody,
        });
        executionStarted = true;
        await execute(item, {
          preflightHash,
          executionCorrelationId,
          trimmedContent,
          attachmentsSnapshot,
          attachmentIds,
          externalContextRefs,
          externalContextOptIn,
          templateInvocationOptIn,
          workspaceSnapshotOptIn,
          requestPrefs,
          effectiveMode,
          executionProviderId,
          executionModel,
          outboundPrefs,
          councilOptIn,
          optimisticPrefs,
          localAttachments,
          localUserMessageId,
          shouldProjectOptimisticUserMessage,
        });
      } catch (cause) {
        if (!isCurrentCustody()) return;
        if (isAbortError(cause)) {
          if (item.action === "send" && item.workspaceSnapshot) onWorkspaceSnapshotFailedRef.current?.(item);
          return;
        }
        if (item.action !== "retry") {
          setDraft((current) => (current.trim().length > 0 ? current : item.content));
          setPendingAttachments((current) => (current.length > 0 ? current : attachmentsSnapshot));
          if (item.action === "send" && item.workspaceSnapshot) onWorkspaceSnapshotFailedRef.current?.(item);
          if (item.action === "edit" && item.targetTurnId) setEditingTurnId(item.targetTurnId);
        }
        setError((cause as Error).message, getOutboundErrorSource(item.action));
        recordChatOutboundPhase({
          phase: "failed",
          action: item.action,
          correlationId: executionCorrelationId,
          sessionId: item.sessionId,
          turnId: item.targetTurnId,
          message: "Outbound action code could not load.",
          level: "error",
          context: { error: (cause as Error).message },
        });
      } finally {
        const canSettle = isCurrentCustody();
        if (pendingOutboundCodeRef.current === pendingCode) {
          codeController.abort();
          // A hidden/unmounted owner keeps the stale ticket for a later mounted admission to release without setters.
          if (outboundMountedRef.current) {
            pendingOutboundCodeRef.current = null;
            setOptimisticUserMessage((current) => (current?.queueItemId === item.id ? null : current));
            if (!executionStarted || !canSettle) finishOutboundExecution();
          }
        }
      }
    },
    [
      activeStreamRef,
      clearStreamingPreview,
      commitThreadUpdate,
      ensureSession,
      ensureFreshRoutePreflight,
      finalizedStreamMessageRef,
      finishOutboundExecution,
      getOutboundErrorSource,
      getStreamingPreviewBuffer,
      handleCommandExecution,
      fullWebAccess,
      isRoutePreflightAcknowledged,
      loadSessionCoreState,
      loadSidebar,
      promoteStreamingPreviewToThread,
      scheduleStreamMessageReconciliation,
      selectedModel,
      selectedProviderId,
      selectedSessionId,
      setCapabilitySuggestions,
      setSpecialistSuggestions,
      setDraft,
      setEditingTurnId,
      setError,
      setPendingAttachments,
      setPendingApproval,
      setPendingUserInput,
      streamEnabled,
      pushLocalNotice,
      renderedOutboundSelection,
      renderedCallerRevision,
      renderedAccessRevision,
      renderedGatewayBase,
    ],
  );
  // See the note above applyFetchedThreadRef: outbound execution is exposed to
  // another hook through a ref and must reflect the latest session/prefs.
  executeOutboundItemRef.current = executeOutboundItem;

  /*
   * Computed per render on purpose: the value depends on activeStreamRef,
   * which a useMemo dependency list cannot observe. Memoizing on
   * [error, queuedOutbound, sending] froze the status at "connecting" for
   * the entire life of a stream (the ref is assigned after the memo runs and
   * never invalidates it). The result is a primitive, so recomputing is free
   * and the status flips to "streaming" on the first preview-flush render.
   */
  // `error` is the host's shared UI-error channel. Only outbound transport
  // failures should change the stream state; model, export, and other control
  // errors still render beside their own controls without becoming a failed
  // chat response. A missing source is retained as a legacy transport error.
  const hasTransportError = Boolean(error && (!errorSource || errorSource === "send" || errorSource === "edit"));
  const streamStatus: ChatStreamStatus = hasTransportError
    ? "error"
    : sending && activeStreamRef.current
      ? "streaming"
      : sending
        ? "connecting"
        : queuedOutbound.length > 0
          ? "queued"
          : "idle";

  useEffect(() => {
    outboundMountedRef.current = true;
    return () => {
      outboundMountedRef.current = false;
      pendingOutboundCodeRef.current?.controller.abort();
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      if (streamReconcileTimeoutRef.current) {
        clearTimeout(streamReconcileTimeoutRef.current);
        streamReconcileTimeoutRef.current = null;
      }
      disposeStreamingPreview();
    };
  }, [activeStreamRef, disposeStreamingPreview]);

  return {
    activeStreamRef,
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
    refreshThreadAndApprovals,
    optimisticUserMessage,
    streamStatus,
    streamingPreview,
    activeStreamingTurnId,
    prefsRef,
    threadRef,
  };
}
