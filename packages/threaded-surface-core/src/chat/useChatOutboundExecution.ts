/* eslint-disable max-lines -- Outbound chat execution stays centralized so stream lifecycle, approval context, and retry handoff remain consistent. */
import type {
  ChatAttachmentRecord,
  ChatCapabilityUpgradeSuggestion,
  ChatMessageRecord,
  RoutingPreflightResult,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatStreamChunk,
  ChatThreadResponse,
  ChatUserInputPromptResponse,
} from "@goatcitadel/contracts";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  answerChatUserInputPrompt,
  approveChatTool,
  denyChatTool,
  editChatTurn,
  fetchChatPendingApprovals,
  resumeChatTurnStream,
  retryChatTurn,
  selectChatBranchTurn,
  sendAgentChatMessage,
  streamAgentChatMessage,
  streamEditChatTurn,
  streamRetryChatTurn,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  isThreadMutatingStreamChunk,
  type PendingStreamTurnSeed,
  updateThreadFromStreamChunk,
} from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import {
  ChatStreamingPreviewBuffer,
  isReducedMotionPreferred,
  type ChatStreamingPreview,
  type ChatVisualStreamMode,
} from "./chat-streaming-preview";
import type { ChatStreamStatus } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { createChatExecutionCorrelationId, recordChatApprovalPhase, recordChatOutboundPhase } from "./chat-causality";
import { isAbortError } from "./chat-page-derivations";
import {
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
  type FinalizedStreamMessageState,
} from "./chat-page-pure-helpers";
import { deriveThreadPendingApproval, mergePendingApproval, type PendingApprovalRecord } from "./chat-pending-approval";
import {
  deriveThreadPendingUserInput,
  mergePendingUserInput,
  type PendingUserInputRecord,
} from "./chat-pending-user-input";
import type { ChatErrorSource } from "./chat-error-copy";
import type { ChatHistoryView, ChatSidebarLoadOptions } from "./useChatSessionData";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";

const APPROVAL_RESUMED_REFRESH_DELAYS_MS = [750, 2_000] as const;
const APPROVAL_FALLBACK_REFRESH_DELAYS_MS = [500, 1_500, 3_000] as const;
const MAX_STREAM_RESUME_ATTEMPTS = 2;
const ROUTE_FALLBACK_ACK_REQUIRED_MESSAGE = "Please confirm the route fallback before sending.";
const STREAMING_REQUEST_FAILED_MESSAGE = "Streaming request failed.";

export type PendingApprovalState = PendingApprovalRecord;
export type PendingUserInputState = PendingUserInputRecord;

export interface ActiveChatStreamState {
  sessionId: string;
  streamToken: string;
  controller: AbortController;
  turnId?: string;
  lastEventId?: string;
  runId?: string;
}

export function abortActiveChatStream(stream: ActiveChatStreamState | null): void {
  if (!stream || stream.controller.signal.aborted) {
    return;
  }
  stream.controller.abort();
}

export function resolveOutboundExecutionPrefs(prefs: ChatSessionPrefsRecord | null | undefined) {
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

export function useChatOutboundExecution(input: {
  surfaceMode?: ChatSessionPrefsRecord["mode"];
  selectedSessionId: string | null;
  selectedSession: ChatSessionRecord | null;
  streamEnabled: boolean;
  visualStreamMode?: ChatVisualStreamMode;
  sending: boolean;
  error: string | null;
  queuedOutbound: OutboundQueueItem[];
  activeStreamRef: MutableRefObject<ActiveChatStreamState | null>;
  prefs: ChatSessionPrefsRecord | null;
  fullWebAccess?: boolean;
  selectedProviderId?: string;
  selectedModel?: string;
  thread: ChatThreadResponse | null;
  messages: ChatMessageRecord[];
  setThread: React.Dispatch<React.SetStateAction<ChatThreadResponse | null>>;
  setError: (value: string | null, source?: ChatErrorSource) => void;
  setSending: (value: boolean) => void;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentRecord[]>>;
  setEditingTurnId: (value: string | null) => void;
  setCapabilitySuggestions: (
    value:
      | ChatCapabilityUpgradeSuggestion[]
      | ((current: ChatCapabilityUpgradeSuggestion[]) => ChatCapabilityUpgradeSuggestion[]),
  ) => void;
  setSpecialistSuggestions: (
    value:
      | ChatSpecialistCandidateSuggestionRecord[]
      | ((current: ChatSpecialistCandidateSuggestionRecord[]) => ChatSpecialistCandidateSuggestionRecord[]),
  ) => void;
  loadSidebar: (nextHistoryView?: ChatHistoryView, options?: ChatSidebarLoadOptions) => Promise<void>;
  loadSessionCoreState: (
    sessionId: string,
    options?: { background?: boolean; includeThread?: boolean },
  ) => Promise<void>;
  ensureSession: () => Promise<ChatSessionRecord>;
  pushLocalNotice: (content: string, tone?: "neutral" | "success" | "warning") => void;
  handleCommandExecution: (sessionId: string, commandText: string) => Promise<void>;
  executeOutboundItemRef: MutableRefObject<(item: OutboundQueueItem) => Promise<void>>;
  tryBeginOutboundExecutionRef: MutableRefObject<() => boolean>;
  applyFetchedThreadRef: MutableRefObject<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>;
  messageMutationVersionRef: MutableRefObject<number>;
  ensureFreshRoutePreflight: (input: {
    sessionId?: string | null;
    action: OutboundQueueItem["action"];
    turnId?: string | null;
    force?: boolean;
  }) => Promise<RoutingPreflightResult | null>;
  isRoutePreflightAcknowledged: (hash: string) => boolean;
}) {
  const {
    surfaceMode,
    selectedSessionId,
    selectedSession,
    streamEnabled,
    visualStreamMode = "smooth",
    sending,
    error,
    queuedOutbound,
    activeStreamRef,
    prefs,
    selectedProviderId,
    selectedModel,
    thread,
    messages,
    setThread,
    setError,
    setSending,
    setDraft,
    setPendingAttachments,
    setEditingTurnId,
    setCapabilitySuggestions,
    setSpecialistSuggestions,
    loadSidebar,
    loadSessionCoreState,
    ensureSession,
    pushLocalNotice,
    handleCommandExecution,
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    applyFetchedThreadRef,
    messageMutationVersionRef,
    ensureFreshRoutePreflight,
    isRoutePreflightAcknowledged,
  } = input;

  const getOutboundErrorSource = useCallback((action: OutboundQueueItem["action"]): ChatErrorSource => {
    if (action === "edit") {
      return "edit";
    }
    if (action === "send") {
      return "send";
    }
    return "other";
  }, []);

  const [pendingApproval, setPendingApproval] = useState<PendingApprovalState | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [pendingUserInput, setPendingUserInput] = useState<PendingUserInputState | null>(null);
  const [userInputPending, setUserInputPending] = useState(false);
  const [streamingPreview, setStreamingPreview] = useState<ChatStreamingPreview | null>(null);
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const latestMessagesRef = useRef<ChatMessageRecord[]>(messages);
  const finalizedStreamMessageRef = useRef<FinalizedStreamMessageState | null>(null);
  const streamingPreviewBufferRef = useRef<ChatStreamingPreviewBuffer | null>(null);
  const visualStreamModeRef = useRef<ChatVisualStreamMode>(visualStreamMode);
  const streamReconcileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deferred approval-resolve refresh timers (APPROVAL_*_REFRESH_DELAYS_MS). Tracked
  // so they can be cleared on unmount and on session switch, preventing refetches /
  // setState for a session the operator has already left.
  const approvalRefreshTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const sendingRef = useRef(false);
  const prefsRef = useRef<ChatSessionPrefsRecord | null>(prefs);
  const threadRef = useRef<ChatThreadResponse | null>(thread);
  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  const refreshPendingApprovalQueue = useCallback(
    async (sessionId: string) => {
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
      const active =
        activeItems.find((item) => item.approvalId === response.activeApprovalId) ?? activeItems[0] ?? null;
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
          typeof active.details?.saveCandidateOnSuccess === "boolean"
            ? active.details.saveCandidateOnSuccess
            : undefined,
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
    },
    [setPendingApproval],
  );

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
    visualStreamModeRef.current = visualStreamMode;
    if (visualStreamMode === "instant") {
      streamingPreviewBufferRef.current?.flush({ forceVisible: true });
    }
  }, [visualStreamMode]);

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

  const getStreamingPreviewBuffer = useCallback(() => {
    if (!streamingPreviewBufferRef.current) {
      streamingPreviewBufferRef.current = new ChatStreamingPreviewBuffer({
        onFlush: setStreamingPreview,
        isReducedMotion: () => visualStreamModeRef.current === "instant" || isReducedMotionPreferred(),
      });
    }
    return streamingPreviewBufferRef.current;
  }, []);

  const clearStreamingPreview = useCallback((options: { allowSettlingFinalText?: boolean } = {}) => {
    if (options.allowSettlingFinalText && streamingPreviewBufferRef.current?.isSettlingFinalText()) {
      return;
    }
    streamingPreviewBufferRef.current?.clear();
    setStreamingPreview(null);
  }, []);

  const promoteStreamingPreviewToThread = useCallback(
    (sessionId: string, reason: "abort" | "error") => {
      const snapshot =
        streamingPreviewBufferRef.current?.getSnapshot({ forceVisible: true }) ??
        (streamingPreview?.sessionId === sessionId ? streamingPreview : null);
      if (!snapshot || snapshot.sessionId !== sessionId || snapshot.text.trim().length === 0) {
        clearStreamingPreview();
        return;
      }
      const partialChunk: ChatStreamChunk = {
        type: "message_done",
        sessionId: snapshot.sessionId,
        eventId: `local-preview-${reason}-${Date.now()}`,
        sequence: -1,
        turnId: snapshot.turnId,
        messageId: snapshot.messageId ?? `local-assistant-${snapshot.turnId}`,
        content: snapshot.text,
      };
      commitThreadUpdate((current) =>
        updateThreadFromStreamChunk(current, partialChunk, null, snapshot.sessionId, prefsRef.current),
      );
      recordClientDiagnostic({
        level: "warn",
        category: "chat",
        event: "stream.preview_promoted_partial",
        message: "Promoted visible streaming preview after the live stream ended before message_done.",
        sessionId: snapshot.sessionId,
        turnId: snapshot.turnId,
        context: {
          reason,
          characterCount: snapshot.text.length,
        },
      });
      clearStreamingPreview();
    },
    [clearStreamingPreview, commitThreadUpdate, streamingPreview],
  );

  useEffect(() => {
    if (streamingPreview && streamingPreview.sessionId !== selectedSessionId) {
      clearStreamingPreview();
    }
  }, [clearStreamingPreview, selectedSessionId, streamingPreview]);

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
    [commitThreadUpdate, messageMutationVersionRef],
  );
  // These callback refs are intentionally refreshed during render so sibling
  // orchestration hooks can call the current implementation before effects run.
  applyFetchedThreadRef.current = applyFetchedThread;

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
        const selectedTurn = thread
          ? (thread.turns.find((turn) => turn.turnId === (thread.selectedTurnId ?? thread.activeLeafTurnId)) ??
            thread.turns.at(-1) ??
            null)
          : null;
        if (selectedTurn?.trace.status === "waiting_for_approval") {
          return current;
        }
        return null;
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
    void refreshPendingApprovalQueue(selectedSession.sessionId).catch(() => undefined);
  }, [refreshPendingApprovalQueue, selectedSession?.sessionId]);

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
      const preflightHash = (value: RoutingPreflightResult | null) => (value ? JSON.stringify(value) : null);
      const executionCorrelationId = createChatExecutionCorrelationId();
      const trimmedContent = item.content.trim();
      const attachmentsSnapshot = item.attachments;
      const attachmentIds = attachmentsSnapshot.map((entry) => entry.attachmentId);
      const currentPrefs = prefsRef.current;
      const effectiveMode = surfaceMode ?? currentPrefs?.mode ?? "chat";
      const executionProviderId = currentPrefs?.providerId ?? selectedProviderId;
      const executionModel = currentPrefs?.model ?? selectedModel;
      const outboundPrefs = resolveOutboundExecutionPrefs(currentPrefs);
      const optimisticPrefs =
        currentPrefs && (executionProviderId || executionModel)
          ? {
              ...currentPrefs,
              mode: effectiveMode,
              providerId: executionProviderId,
              model: executionModel,
            }
          : currentPrefs;
      const localAttachments = attachmentsSnapshot.map((entry) => ({
        attachmentId: entry.attachmentId,
        fileName: entry.fileName,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
      }));
      let session: ChatSessionRecord | null = null;
      try {
        recordChatOutboundPhase({
          phase: "start",
          action: item.action,
          correlationId: executionCorrelationId,
          sessionId: item.sessionId,
          turnId: item.targetTurnId,
          message: `Starting ${item.action} action`,
          context: {
            attachmentCount: attachmentsSnapshot.length,
            contentLength: trimmedContent.length,
            streamEnabled,
          },
        });
        setError(null);
        session = await ensureSession();
        recordChatOutboundPhase({
          phase: "session_ready",
          action: item.action,
          correlationId: executionCorrelationId,
          sessionId: session.sessionId,
          turnId: item.targetTurnId,
          message: `Resolved chat session for ${item.action}`,
        });
        if (shouldExecuteLocalChatCommand(item.action, trimmedContent)) {
          setPendingApproval(null);
          recordChatOutboundPhase({
            phase: "command_handoff",
            action: item.action,
            correlationId: executionCorrelationId,
            sessionId: session.sessionId,
            message: "Handing outbound request to the local command executor",
          });
          await handleCommandExecution(session.sessionId, trimmedContent);
          await loadSidebar(undefined, { bypassCache: true, preferredSessionId: session.sessionId });
          return;
        }
        const routePreflight = await ensureFreshRoutePreflight({
          sessionId: session.sessionId,
          action: item.action,
          turnId: item.targetTurnId,
          force: true,
        });
        if (routePreflight?.blockedReason) {
          throw new Error(routePreflight.blockedReason);
        }
        const routeHash = preflightHash(routePreflight);
        const requiresRouteAck =
          routePreflight?.fallbackResult === "local_to_cloud" || routePreflight?.fallbackResult === "cloud_to_local";
        if (routeHash && requiresRouteAck && !isRoutePreflightAcknowledged(routeHash)) {
          throw new Error(ROUTE_FALLBACK_ACK_REQUIRED_MESSAGE);
        }
        recordChatOutboundPhase({
          phase: "provider_selected",
          action: item.action,
          correlationId: executionCorrelationId,
          sessionId: session.sessionId,
          turnId: item.targetTurnId,
          message: `Resolved route for ${item.action}`,
          level: "debug",
          context: {
            requestedProviderId: routePreflight?.requestedProviderId,
            requestedModel: routePreflight?.requestedModel,
            providerId: routePreflight?.effectiveProviderId,
            model: routePreflight?.effectiveModel,
            selectionSource: routePreflight?.selectionSource,
            fallbackPolicy: routePreflight?.fallbackPolicy,
            routeDecisionFingerprint: routePreflight?.decision.fingerprint,
          },
        });
        const routeExecutionProviderId = routePreflight?.effectiveProviderId ?? executionProviderId;
        const routeExecutionModel = routePreflight?.effectiveModel ?? executionModel;
        const routeExecutionDecision = routePreflight?.decision;
        const targetTurn = item.targetTurnId
          ? (threadRef.current?.turns.find((turn) => turn.turnId === item.targetTurnId) ?? null)
          : null;
        if ((item.action === "edit" || item.action === "retry") && !targetTurn) {
          throw new Error("The selected branch turn is no longer available.");
        }
        const effectiveUserMessage: ChatMessageRecord =
          item.action === "retry" && targetTurn
            ? targetTurn.userMessage
            : {
                messageId: `local-user-${Date.now()}`,
                sessionId: session.sessionId,
                role: "user",
                actorType: "user",
                actorId: "operator",
                content: trimmedContent,
                timestamp: new Date().toISOString(),
                attachments: localAttachments.length > 0 ? localAttachments : undefined,
              };
        if (streamEnabled) {
          setPendingApproval(null);
          const streamToken = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const controller = new AbortController();
          const activeStream: ActiveChatStreamState = {
            sessionId: session.sessionId,
            streamToken,
            controller,
          };
          activeStreamRef.current = activeStream;
          recordChatOutboundPhase({
            phase: "stream_seeded",
            action: item.action,
            correlationId: executionCorrelationId,
            sessionId: session.sessionId,
            turnId: item.targetTurnId,
            message: "Seeded realtime outbound stream execution",
            level: "debug",
            context: {
              streamToken,
            },
          });
          const streamSeed: PendingStreamTurnSeed = {
            userMessage: effectiveUserMessage,
            parentTurnId: item.action === "send" ? threadRef.current?.activeLeafTurnId : targetTurn?.parentTurnId,
            branchKind: item.action === "send" ? "append" : item.action === "edit" ? "edit" : "retry",
            sourceTurnId: item.action === "send" ? undefined : item.targetTurnId,
            mode: item.action,
          };
          const onChunk = (chunk: ChatStreamChunk) => {
            const liveStream = activeStreamRef.current;
            if (
              liveStream?.streamToken !== streamToken ||
              liveStream.sessionId !== session!.sessionId ||
              selectedSessionIdRef.current !== session!.sessionId
            ) {
              return;
            }
            liveStream.lastEventId = chunk.eventId;
            if (chunk.runId) {
              liveStream.runId = chunk.runId;
            }
            if (chunk.type === "message_start") {
              liveStream.turnId = chunk.turnId;
              getStreamingPreviewBuffer().start({
                sessionId: chunk.sessionId,
                turnId: chunk.turnId,
                messageId: chunk.messageId,
              });
            }
            if (chunk.type === "trace_update" && chunk.trace.durable?.runId) {
              liveStream.runId = chunk.trace.durable.runId;
            }
            if (chunk.type === "message_done") {
              const previewBuffer = getStreamingPreviewBuffer();
              if (!previewBuffer.matches(chunk.sessionId, chunk.turnId)) {
                previewBuffer.start({
                  sessionId: chunk.sessionId,
                  turnId: chunk.turnId,
                  messageId: chunk.messageId,
                });
              }
              previewBuffer.finish({ clear: true, forceVisible: false, finalText: chunk.content });
              finalizedStreamMessageRef.current = {
                sessionId: chunk.sessionId,
                placeholderId: chunk.messageId,
                messageId: chunk.messageId,
                content: chunk.content,
              };
            }
            if (chunk.type === "trace_update" && chunk.trace.capabilityUpgradeSuggestions !== undefined) {
              setCapabilitySuggestions(chunk.trace.capabilityUpgradeSuggestions);
            }
            if (chunk.type === "trace_update" && chunk.trace.specialistCandidateSuggestions !== undefined) {
              setSpecialistSuggestions(chunk.trace.specialistCandidateSuggestions);
            }
            if (chunk.type === "capability_upgrade_suggestion") {
              setCapabilitySuggestions(chunk.capabilityUpgradeSuggestions ?? []);
            }
            if (chunk.type === "approval_required") {
              setPendingUserInput(null);
              const approval = {
                approvalId: chunk.approval.approvalId,
                sessionId: chunk.sessionId,
                kind: chunk.approval.kind,
                toolName: chunk.approval.toolName,
                reason: chunk.approval.reason,
                riskLevel: chunk.approval.riskLevel,
                expiresAt: chunk.approval.expiresAt,
                codeHash: chunk.approval.codeHash,
                wrapperManifestHash: chunk.approval.wrapperManifestHash,
                capabilitySnapshotId: chunk.approval.capabilitySnapshotId,
                inspectPath: chunk.approval.inspectPath,
                requestedOutputIntent: chunk.approval.requestedOutputIntent,
                saveCandidateOnSuccess: chunk.approval.saveCandidateOnSuccess,
                remainingCount: chunk.approval.remainingCount,
                affectedResources: chunk.approval.affectedResources,
              };
              setPendingApproval(approval);
              recordChatApprovalPhase({
                phase: "prompt_arrived",
                correlationId: executionCorrelationId,
                sessionId: approval.sessionId ?? session!.sessionId,
                turnId: chunk.turnId,
                approval: {
                  approvalId: approval.approvalId,
                  toolName: approval.toolName,
                  kind: approval.kind,
                  reason: approval.reason,
                  riskLevel: approval.riskLevel,
                  remainingCount: approval.remainingCount,
                  affectedResourceCount: approval.affectedResources?.length,
                  requestedOutputIntent: approval.requestedOutputIntent,
                  expiresAt: approval.expiresAt,
                },
                source: "stream",
              });
            }
            if (chunk.type === "user_input_required") {
              setPendingApproval(null);
              setPendingUserInput(chunk.prompt);
            }
            if (chunk.type === "error") {
              const errorMessage = chunk.error?.trim() || STREAMING_REQUEST_FAILED_MESSAGE;
              setError(errorMessage, getOutboundErrorSource(item.action));
              promoteStreamingPreviewToThread(chunk.sessionId, "error");
              recordClientDiagnostic({
                level: "error",
                category: "chat",
                event: "stream.chunk_error",
                message: errorMessage,
                sessionId: session!.sessionId,
                turnId: chunk.turnId,
              });
            }
            if (chunk.type === "delta") {
              getStreamingPreviewBuffer().append({
                sessionId: chunk.sessionId,
                turnId: chunk.turnId,
                messageId: chunk.messageId,
                delta: chunk.delta,
              });
              recordClientDiagnostic({
                level: "debug",
                category: "chat",
                event: "thread.preview_path",
                message: "Buffered delta chunk for streaming preview",
                sessionId: session!.sessionId,
                turnId: chunk.turnId,
                context: {
                  characterCount: chunk.delta.length,
                },
              });
              return;
            }
            if (!isThreadMutatingStreamChunk(chunk)) {
              return;
            }
            recordClientDiagnostic({
              level: "debug",
              category: "chat",
              event: "thread.render_path",
              message: `Applying ${chunk.type} chunk to thread`,
              sessionId: session!.sessionId,
              turnId: chunk.turnId,
              context: {
                chunkType: chunk.type,
              },
            });
            commitThreadUpdate((current) =>
              updateThreadFromStreamChunk(current, chunk, streamSeed, session!.sessionId, optimisticPrefs),
            );
          };
          let resumeAttempts = 0;
          for (;;) {
            try {
              if (resumeAttempts > 0) {
                const liveStream = activeStreamRef.current;
                if (!liveStream?.turnId) {
                  throw new Error("Streaming request failed before the turn could be resumed.");
                }
                recordChatOutboundPhase({
                  phase: "stream_resume",
                  action: item.action,
                  correlationId: executionCorrelationId,
                  sessionId: session.sessionId,
                  turnId: liveStream.turnId,
                  message: "Resuming interrupted outbound chat stream",
                  level: "warn",
                  context: {
                    sinceEventId: liveStream.lastEventId,
                    resumeAttempt: resumeAttempts,
                  },
                });
                setError(null);
                pushLocalNotice(`Stream interrupted. Reconnecting to turn ${liveStream.turnId.slice(-6)}.`, "warning");
                await resumeChatTurnStream(session.sessionId, liveStream.turnId, onChunk, {
                  signal: controller.signal,
                  sinceEventId: liveStream.lastEventId,
                  originSurface: effectiveMode,
                });
              } else if (item.action === "retry" && item.targetTurnId) {
                await streamRetryChatTurn(
                  session.sessionId,
                  item.targetTurnId,
                  {
                    providerId: routeExecutionProviderId,
                    model: routeExecutionModel,
                    routeDecision: routeExecutionDecision,
                    mode: effectiveMode,
                    webMode: currentPrefs?.webMode,
                    memoryMode: currentPrefs?.memoryMode,
                    thinkingLevel: currentPrefs?.thinkingLevel,
                    speedMode: currentPrefs?.speedMode,
                    subagentPolicy: currentPrefs?.subagentPolicy,
                    ...(input.fullWebAccess ? { fullWebAccess: true } : {}),
                  },
                  onChunk,
                  { signal: controller.signal, originSurface: effectiveMode },
                );
              } else if (item.action === "edit" && item.targetTurnId) {
                await streamEditChatTurn(
                  session.sessionId,
                  item.targetTurnId,
                  {
                    content: trimmedContent,
                    attachments: attachmentIds,
                    ...outboundPrefs,
                    mode: effectiveMode,
                    providerId: routeExecutionProviderId,
                    model: routeExecutionModel,
                    routeDecision: routeExecutionDecision,
                    ...(input.fullWebAccess ? { fullWebAccess: true } : {}),
                  },
                  onChunk,
                  { signal: controller.signal, originSurface: effectiveMode },
                );
              } else {
                await streamAgentChatMessage(
                  session.sessionId,
                  {
                    content: trimmedContent,
                    attachments: attachmentIds,
                    ...outboundPrefs,
                    mode: effectiveMode,
                    providerId: routeExecutionProviderId,
                    model: routeExecutionModel,
                    routeDecision: routeExecutionDecision,
                    ...(input.fullWebAccess ? { fullWebAccess: true } : {}),
                  },
                  onChunk,
                  { signal: controller.signal, originSurface: effectiveMode },
                );
              }
              break;
            } catch (streamError) {
              if (isAbortError(streamError)) {
                throw streamError;
              }
              const liveStream = activeStreamRef.current;
              const canResume = Boolean(
                liveStream &&
                liveStream.streamToken === streamToken &&
                liveStream.sessionId === session.sessionId &&
                liveStream.turnId,
              );
              if (!canResume || resumeAttempts >= MAX_STREAM_RESUME_ATTEMPTS) {
                throw streamError;
              }
              resumeAttempts += 1;
            }
          }
          const finalizedStreamMessage = finalizedStreamMessageRef.current;
          const missingFinalizedMessage =
            !finalizedStreamMessage || finalizedStreamMessage.sessionId !== session.sessionId;
          scheduleStreamMessageReconciliation(session.sessionId, {
            immediate: missingFinalizedMessage,
          });
        } else {
          setPendingApproval(null);
          const sent =
            item.action === "retry" && item.targetTurnId
              ? await retryChatTurn(
                  session.sessionId,
                  item.targetTurnId,
                  {
                    providerId: routeExecutionProviderId,
                    model: routeExecutionModel,
                    routeDecision: routeExecutionDecision,
                    mode: effectiveMode,
                    webMode: currentPrefs?.webMode,
                    memoryMode: currentPrefs?.memoryMode,
                    thinkingLevel: currentPrefs?.thinkingLevel,
                    speedMode: currentPrefs?.speedMode,
                    subagentPolicy: currentPrefs?.subagentPolicy,
                    ...(input.fullWebAccess ? { fullWebAccess: true } : {}),
                  },
                  { originSurface: effectiveMode },
                )
              : item.action === "edit" && item.targetTurnId
                ? await editChatTurn(
                    session.sessionId,
                    item.targetTurnId,
                    {
                      content: trimmedContent,
                      attachments: attachmentIds,
                      ...outboundPrefs,
                      mode: effectiveMode,
                      providerId: routeExecutionProviderId,
                      model: routeExecutionModel,
                      routeDecision: routeExecutionDecision,
                      ...(input.fullWebAccess ? { fullWebAccess: true } : {}),
                    },
                    { originSurface: effectiveMode },
                  )
                : await sendAgentChatMessage(
                    session.sessionId,
                    {
                      content: trimmedContent,
                      attachments: attachmentIds,
                      ...outboundPrefs,
                      mode: effectiveMode,
                      providerId: routeExecutionProviderId,
                      model: routeExecutionModel,
                      routeDecision: routeExecutionDecision,
                      ...(input.fullWebAccess ? { fullWebAccess: true } : {}),
                    },
                    { originSurface: effectiveMode },
                  );
          if (sent.trace) {
            setCapabilitySuggestions(sent.trace.capabilityUpgradeSuggestions ?? []);
            setSpecialistSuggestions(sent.trace.specialistCandidateSuggestions ?? []);
          }
          await loadSessionCoreState(session.sessionId, {
            background: true,
            includeThread: true,
          });
        }
        setEditingTurnId(null);
        const completedSessionId = session.sessionId;
        void loadSidebar(undefined, { bypassCache: true, preferredSessionId: completedSessionId }).catch(
          (sidebarError: unknown) => {
            recordClientDiagnostic({
              level: "warn",
              category: "chat",
              event: "sidebar.refresh_failed_after_send",
              message: "Sidebar refresh failed after outbound chat completion.",
              sessionId: completedSessionId,
              context: {
                error: sidebarError instanceof Error ? sidebarError.message : String(sidebarError),
              },
            });
          },
        );
        recordChatOutboundPhase({
          phase: "complete",
          action: item.action,
          correlationId: executionCorrelationId,
          sessionId: session.sessionId,
          turnId: item.targetTurnId,
          message: `${item.action} action completed`,
        });
      } catch (err) {
        if (isAbortError(err)) {
          if (session) {
            promoteStreamingPreviewToThread(session.sessionId, "abort");
          }
          recordChatOutboundPhase({
            phase: "aborted",
            action: item.action,
            correlationId: executionCorrelationId,
            sessionId: session?.sessionId ?? item.sessionId,
            turnId: item.targetTurnId,
            message: `${item.action} action aborted`,
            level: "warn",
          });
          return;
        }
        if (session) {
          promoteStreamingPreviewToThread(session.sessionId, "error");
          void loadSessionCoreState(session.sessionId, {
            background: true,
            includeThread: true,
          }).catch(() => undefined);
        }
        if (item.action !== "retry") {
          setDraft((current) => (current.trim().length > 0 ? current : item.content));
          setPendingAttachments((current) => (current.length > 0 ? current : attachmentsSnapshot));
          if (item.action === "edit" && item.targetTurnId) {
            setEditingTurnId(item.targetTurnId);
          }
        }
        setError((err as Error).message, getOutboundErrorSource(item.action));
        recordChatOutboundPhase({
          phase: "failed",
          action: item.action,
          correlationId: executionCorrelationId,
          sessionId: session?.sessionId ?? item.sessionId,
          turnId: item.targetTurnId,
          message: `${item.action} action failed`,
          level: "error",
          context: {
            error: (err as Error).message,
          },
        });
      } finally {
        const activeStream = activeStreamRef.current;
        if (session && activeStream?.sessionId === session.sessionId) {
          activeStreamRef.current = null;
        }
        if (!session || activeStream?.sessionId === session.sessionId) {
          clearStreamingPreview({ allowSettlingFinalText: true });
        }
        finishOutboundExecution();
      }
    },
    [
      clearStreamingPreview,
      commitThreadUpdate,
      ensureSession,
      ensureFreshRoutePreflight,
      finishOutboundExecution,
      getStreamingPreviewBuffer,
      handleCommandExecution,
      input.fullWebAccess,
      isRoutePreflightAcknowledged,
      loadSessionCoreState,
      loadSidebar,
      promoteStreamingPreviewToThread,
      scheduleStreamMessageReconciliation,
      selectedModel,
      selectedProviderId,
      surfaceMode,
      setCapabilitySuggestions,
      setSpecialistSuggestions,
      setDraft,
      setEditingTurnId,
      setError,
      setPendingAttachments,
      streamEnabled,
      pushLocalNotice,
    ],
  );
  // See the note above applyFetchedThreadRef: outbound execution is exposed to
  // another hook through a ref and must reflect the latest session/prefs.
  executeOutboundItemRef.current = executeOutboundItem;

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

  /*
   * Computed per render on purpose: the value depends on activeStreamRef,
   * which a useMemo dependency list cannot observe. Memoizing on
   * [error, queuedOutbound, sending] froze the status at "connecting" for
   * the entire life of a stream (the ref is assigned after the memo runs and
   * never invalidates it). The result is a primitive, so recomputing is free
   * and the status flips to "streaming" on the first preview-flush render.
   */
  const streamStatus: ChatStreamStatus = error
    ? "error"
    : sending && activeStreamRef.current
      ? "streaming"
      : sending
        ? "connecting"
        : queuedOutbound.some((item) => !item.paused)
          ? "queued"
          : "idle";

  // Clear deferred approval-resolve refresh timers when the operator switches
  // sessions, so the previous session is not re-fetched for up to ~3s afterwards.
  useEffect(() => {
    return () => {
      for (const timer of approvalRefreshTimersRef.current) {
        clearTimeout(timer);
      }
      approvalRefreshTimersRef.current.clear();
    };
  }, [selectedSessionId]);

  useEffect(
    () => () => {
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      if (streamReconcileTimeoutRef.current) {
        clearTimeout(streamReconcileTimeoutRef.current);
        streamReconcileTimeoutRef.current = null;
      }
      for (const timer of approvalRefreshTimersRef.current) {
        clearTimeout(timer);
      }
      approvalRefreshTimersRef.current.clear();
      streamingPreviewBufferRef.current?.dispose();
      streamingPreviewBufferRef.current = null;
      setStreamingPreview(null);
    },
    [],
  );

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
    streamStatus,
    streamingPreview,
    activeStreamingTurnId: streamingPreview?.turnId ?? null,
    prefsRef,
    threadRef,
  };
}
