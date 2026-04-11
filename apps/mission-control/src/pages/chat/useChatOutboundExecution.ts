import type {
  ChatAttachmentRecord,
  ChatCapabilityUpgradeSuggestion,
  ChatMessageRecord,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatStreamChunk,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
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
} from "../../api/client";
import type { ChatModelProviderOption } from "../../components/ChatModelPicker";
import {
  isThreadMutatingStreamChunk,
  type PendingStreamTurnSeed,
  updateThreadFromStreamChunk,
} from "../../components/chat/chat-thread-reducer";
import type { ChatStreamStatus } from "../../components/chat/ChatStreamStatusBar";
import { recordClientDiagnostic } from "../../state/dev-diagnostics-store";
import { createChatExecutionCorrelationId, recordChatApprovalPhase, recordChatOutboundPhase } from "./chat-causality";
import { resolveProviderModelSelection } from "./chat-page-helpers";
import { isAbortError } from "./chat-page-derivations";
import {
  shouldApplyFetchedMessagesAfterStream,
  shouldExecuteLocalChatCommand,
  type FinalizedStreamMessageState,
} from "./chat-page-pure-helpers";
import { deriveThreadPendingApproval, mergePendingApproval, type PendingApprovalRecord } from "./chat-pending-approval";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";

export type PendingApprovalState = PendingApprovalRecord;

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

export function useChatOutboundExecution(input: {
  selectedSessionId: string | null;
  selectedSession: ChatSessionRecord | null;
  providerOptions: ChatModelProviderOption[];
  selectedProviderId: string | undefined;
  selectedModel: string | undefined;
  streamEnabled: boolean;
  sending: boolean;
  error: string | null;
  queuedOutbound: OutboundQueueItem[];
  activeStreamRef: MutableRefObject<ActiveChatStreamState | null>;
  prefs: ChatSessionPrefsRecord | null;
  thread: ChatThreadResponse | null;
  messages: ChatMessageRecord[];
  setThread: React.Dispatch<React.SetStateAction<ChatThreadResponse | null>>;
  setError: (value: string | null) => void;
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
  loadSidebar: () => Promise<void>;
  loadSessionCoreState: (
    sessionId: string,
    options?: { background?: boolean; includeThread?: boolean },
  ) => Promise<void>;
  ensureSession: () => Promise<ChatSessionRecord>;
  getCachedModels: (providerId: string) => string[];
  pushLocalNotice: (content: string, tone?: "neutral" | "success" | "warning") => void;
  handleCommandExecution: (sessionId: string, commandText: string) => Promise<void>;
  executeOutboundItemRef: MutableRefObject<(item: OutboundQueueItem) => Promise<void>>;
  tryBeginOutboundExecutionRef: MutableRefObject<() => boolean>;
  applyFetchedThreadRef: MutableRefObject<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>;
  messageMutationVersionRef: MutableRefObject<number>;
}) {
  const {
    selectedSessionId,
    selectedSession,
    providerOptions,
    selectedProviderId,
    selectedModel,
    streamEnabled,
    sending,
    error,
    queuedOutbound,
    activeStreamRef,
    prefs,
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
    getCachedModels,
    pushLocalNotice,
    handleCommandExecution,
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    applyFetchedThreadRef,
    messageMutationVersionRef,
  } = input;

  const [pendingApproval, setPendingApproval] = useState<PendingApprovalState | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const latestMessagesRef = useRef<ChatMessageRecord[]>(messages);
  const finalizedStreamMessageRef = useRef<FinalizedStreamMessageState | null>(null);
  const streamReconcileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  applyFetchedThreadRef.current = applyFetchedThread;

  useEffect(() => {
    const threadApproval = deriveThreadPendingApproval(thread);
    if (!threadApproval || !selectedSessionId) {
      return;
    }
    setPendingApproval((current) => {
      const merged = mergePendingApproval(current, threadApproval);
      if (
        merged &&
        (!current ||
          current.approvalId !== merged.approvalId ||
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
  }, [selectedSessionId, thread]);

  useEffect(() => {
    if (!selectedSession?.sessionId) {
      return;
    }
    void refreshPendingApprovalQueue(selectedSession.sessionId).catch(() => undefined);
  }, [refreshPendingApprovalQueue, selectedSession?.sessionId]);

  const scheduleStreamMessageReconciliation = useCallback(
    (sessionId: string) => {
      if (streamReconcileTimeoutRef.current) {
        clearTimeout(streamReconcileTimeoutRef.current);
      }
      const versionAtSchedule = messageMutationVersionRef.current;
      streamReconcileTimeoutRef.current = setTimeout(() => {
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
        }).catch((err: Error) => setError(err.message));
      }, 400);
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

  tryBeginOutboundExecutionRef.current = tryBeginOutboundExecution;

  const executeOutboundItem = useCallback(
    async (item: OutboundQueueItem) => {
      const executionCorrelationId = createChatExecutionCorrelationId();
      const trimmedContent = item.content.trim();
      const attachmentsSnapshot = item.attachments;
      const attachmentIds = attachmentsSnapshot.map((entry) => entry.attachmentId);
      const currentPrefs = prefsRef.current;
      const currentProviderId = currentPrefs?.providerId ?? selectedProviderId;
      const currentProvider = providerOptions.find((provider) => provider.providerId === currentProviderId);
      const currentProviderSelection = resolveProviderModelSelection({
        provider: currentProvider,
        loadedModels: currentProviderId ? getCachedModels(currentProviderId) : [],
        selectedModel: currentPrefs?.model ?? selectedModel,
      });
      const effectiveProviderId = currentProvider?.providerId;
      const effectiveModel = currentProviderSelection.model;
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
        setPendingApproval(null);
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
          recordChatOutboundPhase({
            phase: "command_handoff",
            action: item.action,
            correlationId: executionCorrelationId,
            sessionId: session.sessionId,
            message: "Handing outbound request to the local command executor",
          });
          await handleCommandExecution(session.sessionId, trimmedContent);
          await loadSidebar();
          return;
        }
        if (!effectiveProviderId) {
          throw new Error("No model provider is configured yet. Open Configure and connect a provider first.");
        }
        if (currentProviderSelection.blockedMessage) {
          throw new Error(currentProviderSelection.blockedMessage);
        }
        if (!effectiveModel) {
          throw new Error(
            currentProviderSelection.missingModelMessage ??
              `No model is selected for ${currentProvider?.label ?? effectiveProviderId}. Choose a model and try again.`,
          );
        }
        recordChatOutboundPhase({
          phase: "provider_selected",
          action: item.action,
          correlationId: executionCorrelationId,
          sessionId: session.sessionId,
          turnId: item.targetTurnId,
          message: `Selected ${effectiveProviderId}:${effectiveModel} for ${item.action}`,
          level: "debug",
          context: {
            providerId: effectiveProviderId,
            model: effectiveModel,
          },
        });
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
            }
            if (chunk.type === "trace_update" && chunk.trace.durable?.runId) {
              liveStream.runId = chunk.trace.durable.runId;
            }
            if (chunk.type === "message_done") {
              finalizedStreamMessageRef.current = {
                sessionId: session!.sessionId,
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
              const approval = {
                approvalId: chunk.approval.approvalId,
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
                sessionId: session!.sessionId,
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
            if (chunk.type === "error") {
              setError(chunk.error || "Streaming request failed.");
              recordClientDiagnostic({
                level: "error",
                category: "chat",
                event: "stream.chunk_error",
                message: chunk.error || "Streaming request failed.",
                sessionId: session!.sessionId,
                turnId: chunk.turnId,
              });
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
              updateThreadFromStreamChunk(current, chunk, streamSeed, session!.sessionId, prefsRef.current),
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
                });
              } else if (item.action === "retry" && item.targetTurnId) {
                await streamRetryChatTurn(
                  session.sessionId,
                  item.targetTurnId,
                  {
                    providerId: effectiveProviderId,
                    model: effectiveModel,
                    mode: currentPrefs?.mode,
                    webMode: currentPrefs?.webMode,
                    memoryMode: currentPrefs?.memoryMode,
                    thinkingLevel: currentPrefs?.thinkingLevel,
                  },
                  onChunk,
                  { signal: controller.signal },
                );
              } else if (item.action === "edit" && item.targetTurnId) {
                await streamEditChatTurn(
                  session.sessionId,
                  item.targetTurnId,
                  {
                    content: trimmedContent,
                    attachments: attachmentIds,
                    useMemory: (currentPrefs?.memoryMode ?? "auto") !== "off",
                    mode: currentPrefs?.mode ?? "chat",
                    providerId: effectiveProviderId,
                    model: effectiveModel,
                    webMode: currentPrefs?.webMode ?? "auto",
                    memoryMode: currentPrefs?.memoryMode ?? "auto",
                    thinkingLevel: currentPrefs?.thinkingLevel ?? "standard",
                  },
                  onChunk,
                  { signal: controller.signal },
                );
              } else {
                await streamAgentChatMessage(
                  session.sessionId,
                  {
                    content: trimmedContent,
                    attachments: attachmentIds,
                    useMemory: (currentPrefs?.memoryMode ?? "auto") !== "off",
                    mode: currentPrefs?.mode ?? "chat",
                    providerId: effectiveProviderId,
                    model: effectiveModel,
                    webMode: currentPrefs?.webMode ?? "auto",
                    memoryMode: currentPrefs?.memoryMode ?? "auto",
                    thinkingLevel: currentPrefs?.thinkingLevel ?? "standard",
                  },
                  onChunk,
                  { signal: controller.signal },
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
              if (!canResume || resumeAttempts >= 2) {
                throw streamError;
              }
              resumeAttempts += 1;
            }
          }
          scheduleStreamMessageReconciliation(session.sessionId);
        } else {
          const sent =
            item.action === "retry" && item.targetTurnId
              ? await retryChatTurn(session.sessionId, item.targetTurnId, {
                  providerId: effectiveProviderId,
                  model: effectiveModel,
                  mode: currentPrefs?.mode,
                  webMode: currentPrefs?.webMode,
                  memoryMode: currentPrefs?.memoryMode,
                  thinkingLevel: currentPrefs?.thinkingLevel,
                })
              : item.action === "edit" && item.targetTurnId
                ? await editChatTurn(session.sessionId, item.targetTurnId, {
                    content: trimmedContent,
                    attachments: attachmentIds,
                    useMemory: (currentPrefs?.memoryMode ?? "auto") !== "off",
                    mode: currentPrefs?.mode ?? "chat",
                    providerId: effectiveProviderId,
                    model: effectiveModel,
                    webMode: currentPrefs?.webMode ?? "auto",
                    memoryMode: currentPrefs?.memoryMode ?? "auto",
                    thinkingLevel: currentPrefs?.thinkingLevel ?? "standard",
                  })
                : await sendAgentChatMessage(session.sessionId, {
                    content: trimmedContent,
                    attachments: attachmentIds,
                    useMemory: (currentPrefs?.memoryMode ?? "auto") !== "off",
                    mode: currentPrefs?.mode ?? "chat",
                    providerId: effectiveProviderId,
                    model: effectiveModel,
                    webMode: currentPrefs?.webMode ?? "auto",
                    memoryMode: currentPrefs?.memoryMode ?? "auto",
                    thinkingLevel: currentPrefs?.thinkingLevel ?? "standard",
                  });
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
        await loadSidebar();
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
        setError((err as Error).message);
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
        finishOutboundExecution();
      }
    },
    [
      commitThreadUpdate,
      ensureSession,
      finishOutboundExecution,
      getCachedModels,
      handleCommandExecution,
      loadSessionCoreState,
      providerOptions,
      loadSidebar,
      scheduleStreamMessageReconciliation,
      selectedModel,
      selectedProviderId,
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
        setError((err as Error).message);
        return null;
      }
    },
    [commitThreadUpdate, selectedSessionId, setError],
  );

  const handleApprovePending = useCallback(
    async (allowScope: "once" | "session" | "workspace" = "once") => {
      if (!selectedSession || !pendingApproval) return;
      setApprovalPending(true);
      try {
        recordChatApprovalPhase({
          phase: "resolve_started",
          sessionId: selectedSession.sessionId,
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
          context: { allowScope },
        });
        const result = await approveChatTool(selectedSession.sessionId, pendingApproval.approvalId, { allowScope });
        await refreshPendingApprovalQueue(selectedSession.sessionId);
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
          sessionId: selectedSession.sessionId,
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
          },
        });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setApprovalPending(false);
      }
    },
    [pendingApproval, pushLocalNotice, refreshPendingApprovalQueue, selectedSession, setError],
  );

  const handleDenyPending = useCallback(async () => {
    if (!selectedSession || !pendingApproval) return;
    setApprovalPending(true);
    try {
      recordChatApprovalPhase({
        phase: "resolve_started",
        sessionId: selectedSession.sessionId,
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
      });
      await denyChatTool(selectedSession.sessionId, pendingApproval.approvalId);
      await refreshPendingApprovalQueue(selectedSession.sessionId);
      pushLocalNotice(`Denied request ${pendingApproval.approvalId}. No action was taken.`, "warning");
      recordChatApprovalPhase({
        phase: "dismissed",
        sessionId: selectedSession.sessionId,
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
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApprovalPending(false);
    }
  }, [pendingApproval, pushLocalNotice, refreshPendingApprovalQueue, selectedSession, setError]);

  const streamStatus: ChatStreamStatus = useMemo(() => {
    if (error) return "error";
    if (sending && activeStreamRef.current) return "streaming";
    if (sending) return "connecting";
    if (queuedOutbound.some((item) => !item.paused)) return "queued";
    return "idle";
  }, [error, queuedOutbound, sending]);

  useEffect(
    () => () => {
      abortActiveChatStream(activeStreamRef.current);
      activeStreamRef.current = null;
      if (streamReconcileTimeoutRef.current) {
        clearTimeout(streamReconcileTimeoutRef.current);
        streamReconcileTimeoutRef.current = null;
      }
    },
    [],
  );

  return {
    activeStreamRef,
    pendingApproval,
    setPendingApproval,
    approvalPending,
    handleApprovePending,
    handleDenyPending,
    handleSelectBranchTurn,
    streamStatus,
    prefsRef,
    threadRef,
  };
}
