import type {
  ChatMessageRecord,
  RoutingPreflightResult,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatStreamChunk,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import { useCallback, useEffect, useRef } from "react";
import {
  editChatTurn,
  resumeChatTurnStream,
  retryChatTurn,
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
import type { ChatStreamStatus } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { createChatExecutionCorrelationId, recordChatApprovalPhase, recordChatOutboundPhase } from "./chat-causality";
import { isAbortError } from "./chat-page-derivations";
import { shouldApplyFetchedMessagesAfterStream, shouldExecuteLocalChatCommand } from "./chat-page-pure-helpers";
import type { ChatErrorSource } from "./chat-error-copy";
import { useChatOperatorPrompts } from "./useChatOperatorPrompts";
import { useChatStreamingPreviewState } from "./useChatStreamingPreviewState";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";
import type { ActiveChatStreamState, UseChatOutboundExecutionInput } from "./useChatOutboundExecution.types";
export type {
  ActiveChatStreamState,
  PendingApprovalState,
  PendingUserInputState,
  UseChatOutboundExecutionInput,
} from "./useChatOutboundExecution.types";

const MAX_STREAM_RESUME_ATTEMPTS = 2;
const ROUTE_FALLBACK_ACK_REQUIRED_MESSAGE = "Please confirm the route fallback before sending.";
const STREAMING_REQUEST_FAILED_MESSAGE = "Streaming request failed.";

/**
 * Determines whether a send action on a new (empty) chat thread should use
 * the gateway auto-router instead of an explicit mode.
 *
 * Exported for unit testing. The hook inlines this logic directly for
 * performance (avoid an extra call in the hot send path).
 */
export function shouldAutoRouteSend({
  action,
  threadEmpty,
  surfaceMode,
}: {
  action: string;
  threadEmpty: boolean;
  surfaceMode: string | undefined;
}): boolean {
  return action === "send" && threadEmpty && surfaceMode === undefined;
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

export function useChatOutboundExecution(input: UseChatOutboundExecutionInput) {
  const { sessionConfig, streamConfig, stateConfig, stateSetters, operations, refs, routing } = input;
  const { surfaceMode, selectedSessionId, selectedSession, prefs, fullWebAccess, selectedProviderId, selectedModel } =
    sessionConfig;
  const { streamEnabled, visualStreamMode = "smooth", activeStreamRef } = streamConfig;
  const { sending, error, queuedOutbound, thread, messages } = stateConfig;
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
  const prefsRef = useRef<ChatSessionPrefsRecord | null>(prefs);
  const threadRef = useRef<ChatThreadResponse | null>(thread);
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
    [commitThreadUpdate, messageMutationVersionRef],
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
      const isFirstTurn = item.action === "send" && (threadRef.current?.turns?.length ?? 0) === 0;
      const shouldAutoRoute = isFirstTurn && surfaceMode === undefined;
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
      // Closure-local counters for the streaming preview path: accumulated per
      // queue-item execution (including any stream-resume segments, which reuse
      // the same onChunk closure) and flushed as a single summary diagnostic
      // instead of recording one event per delta chunk (10-50/s while streaming).
      let previewDeltaCount = 0;
      let previewCharCount = 0;
      const flushPreviewPathDiagnostic = (reason: "message_done" | "error" | "abort", turnId: string | undefined) => {
        if (previewDeltaCount === 0) {
          return;
        }
        recordClientDiagnostic({
          level: "debug",
          category: "chat",
          event: "thread.preview_path",
          message: "Aggregated streaming preview delta volume for the message",
          sessionId: session?.sessionId,
          turnId,
          context: {
            deltaCount: previewDeltaCount,
            characterCount: previewCharCount,
            turnId,
            reason,
          },
        });
        previewDeltaCount = 0;
        previewCharCount = 0;
      };
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
              // Guards against double-counting if a resumed/retried segment ever
              // reuses this onChunk closure across more than one message_start;
              // the normal per-message case starts these already at zero.
              previewDeltaCount = 0;
              previewCharCount = 0;
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
              flushPreviewPathDiagnostic("message_done", chunk.turnId);
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
              flushPreviewPathDiagnostic("error", chunk.turnId);
            }
            if (chunk.type === "delta") {
              getStreamingPreviewBuffer().append({
                sessionId: chunk.sessionId,
                turnId: chunk.turnId,
                messageId: chunk.messageId,
                delta: chunk.delta,
              });
              previewDeltaCount += 1;
              previewCharCount += chunk.delta.length;
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
          while (resumeAttempts <= MAX_STREAM_RESUME_ATTEMPTS) {
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
                    ...(fullWebAccess ? { fullWebAccess: true } : {}),
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
                    ...(fullWebAccess ? { fullWebAccess: true } : {}),
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
                    mode: shouldAutoRoute ? undefined : effectiveMode,
                    ...(shouldAutoRoute ? { autoRoute: true as const } : {}),
                    providerId: routeExecutionProviderId,
                    model: routeExecutionModel,
                    routeDecision: routeExecutionDecision,
                    ...(fullWebAccess ? { fullWebAccess: true } : {}),
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
                    ...(fullWebAccess ? { fullWebAccess: true } : {}),
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
                      ...(fullWebAccess ? { fullWebAccess: true } : {}),
                    },
                    { originSurface: effectiveMode },
                  )
                : await sendAgentChatMessage(
                    session.sessionId,
                    {
                      content: trimmedContent,
                      attachments: attachmentIds,
                      ...outboundPrefs,
                      mode: shouldAutoRoute ? undefined : effectiveMode,
                      ...(shouldAutoRoute ? { autoRoute: true as const } : {}),
                      providerId: routeExecutionProviderId,
                      model: routeExecutionModel,
                      routeDecision: routeExecutionDecision,
                      ...(fullWebAccess ? { fullWebAccess: true } : {}),
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
          flushPreviewPathDiagnostic("abort", activeStreamRef.current?.turnId ?? item.targetTurnId);
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
      fullWebAccess,
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
        : queuedOutbound.length > 0
          ? "queued"
          : "idle";

  useEffect(
    () => () => {
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      if (streamReconcileTimeoutRef.current) {
        clearTimeout(streamReconcileTimeoutRef.current);
        streamReconcileTimeoutRef.current = null;
      }
      disposeStreamingPreview();
    },
    [activeStreamRef, disposeStreamingPreview],
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
    activeStreamingTurnId,
    prefsRef,
    threadRef,
  };
}
