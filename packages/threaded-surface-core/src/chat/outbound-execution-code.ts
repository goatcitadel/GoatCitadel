import type {
  ChatAttachmentRecord,
  ChatMessageRecord,
  ChatMode,
  ChatModelCouncilRequest,
  ChatRoutedContextRef,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatStreamChunk,
  ChatThreadResponse,
  ChatWorkspaceSnapshotRequest,
  RoutingPreflightResult,
  RunTemplateInvocation,
} from "@goatcitadel/contracts";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  editChatTurn,
  resumeChatTurnStream,
  retryChatTurn,
  sendAgentChatMessage,
  streamAgentChatMessage,
  streamEditChatTurn,
  streamRetryChatTurn,
} from "@goatcitadel/mission-control-shared/api/client";
import type { PendingStreamTurnSeed } from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import type { ActiveChatStreamState, UseChatOutboundExecutionInput } from "./useChatOutboundExecution.types";
import type { OutboundQueueItem, OutboundRequestPrefsSnapshot } from "./useChatSurfaceOrchestration";
import type {
  OptimisticChatUserMessage,
  UseChatOutboundExternalContext,
  resolveOutboundExecutionPrefs,
} from "./useChatOutboundExecution";
import type { useChatStreamingPreviewState } from "./useChatStreamingPreviewState";
import type { useChatOperatorPrompts } from "./useChatOperatorPrompts";
import type { isBackgroundChatUserInputPrompt } from "@goatcitadel/contracts";
import type {
  isThreadMutatingStreamChunk,
  updateThreadFromStreamChunk,
} from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import type {
  clearChatStreamActivity,
  recordChatStreamChunkActivity,
} from "@goatcitadel/mission-control-shared/state/chat-stream-activity-store";
import type { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import type { recordChatApprovalPhase, recordChatOutboundPhase } from "./chat-causality";
import type { isAbortError } from "./chat-page-derivations";
import type { ChatErrorSource } from "./chat-error-copy";
import type { shouldExecuteLocalChatCommand } from "./chat-page-pure-helpers";

type PreviewOwner = ReturnType<typeof useChatStreamingPreviewState>;
type PromptOwner = ReturnType<typeof useChatOperatorPrompts>;
export interface PreparedOutboundExecution {
  preflightHash: (value: RoutingPreflightResult | null) => string | null;
  executionCorrelationId: string;
  trimmedContent: string;
  attachmentsSnapshot: ChatAttachmentRecord[];
  attachmentIds: string[];
  externalContextRefs: ChatRoutedContextRef[] | undefined;
  externalContextOptIn: { contextRefs?: ChatRoutedContextRef[] };
  templateInvocationOptIn: { templateInvocation?: RunTemplateInvocation };
  workspaceSnapshotOptIn: { workspaceSnapshot?: ChatWorkspaceSnapshotRequest };
  requestPrefs: OutboundRequestPrefsSnapshot;
  effectiveMode: ChatMode;
  executionProviderId: string | undefined;
  executionModel: string | undefined;
  outboundPrefs: ReturnType<typeof resolveOutboundExecutionPrefs>;
  councilOptIn: { modelCouncil?: ChatModelCouncilRequest };
  optimisticPrefs: ChatSessionPrefsRecord | null;
  localAttachments: Array<Pick<ChatAttachmentRecord, "attachmentId" | "fileName" | "mimeType" | "sizeBytes">>;
  localUserMessageId: string;
  shouldProjectOptimisticUserMessage: boolean;
}
export interface OutboundExecutionCodeOwner {
  activeStreamRef: MutableRefObject<ActiveChatStreamState | null>;
  selectedSessionIdRef: MutableRefObject<string | null>;
  threadRef: MutableRefObject<ChatThreadResponse | null>;
  locallyHandledTurnKeysRef: MutableRefObject<Set<string>>;
  finalizedStreamMessageRef: PreviewOwner["finalizedStreamMessageRef"];
  clearStreamingPreview: PreviewOwner["clearStreamingPreview"];
  getStreamingPreviewBuffer: PreviewOwner["getStreamingPreviewBuffer"];
  promoteStreamingPreviewToThread: PreviewOwner["promoteStreamingPreviewToThread"];
  commitThreadUpdate: UseChatOutboundExecutionInput["stateSetters"]["setThread"];
  setError: UseChatOutboundExecutionInput["stateSetters"]["setError"];
  setDraft: UseChatOutboundExecutionInput["stateSetters"]["setDraft"];
  setPendingAttachments: UseChatOutboundExecutionInput["stateSetters"]["setPendingAttachments"];
  setEditingTurnId: UseChatOutboundExecutionInput["stateSetters"]["setEditingTurnId"];
  setCapabilitySuggestions: UseChatOutboundExecutionInput["stateSetters"]["setCapabilitySuggestions"];
  setSpecialistSuggestions: UseChatOutboundExecutionInput["stateSetters"]["setSpecialistSuggestions"];
  setOptimisticUserMessage: Dispatch<SetStateAction<OptimisticChatUserMessage | null>>;
  setPendingApproval: PromptOwner["setPendingApproval"];
  setPendingUserInput: PromptOwner["setPendingUserInput"];
  ensureSession: UseChatOutboundExecutionInput["operations"]["ensureSession"];
  loadSidebar: UseChatOutboundExecutionInput["operations"]["loadSidebar"];
  loadSessionCoreState: UseChatOutboundExecutionInput["operations"]["loadSessionCoreState"];
  handleCommandExecution: UseChatOutboundExecutionInput["operations"]["handleCommandExecution"];
  pushLocalNotice: UseChatOutboundExecutionInput["operations"]["pushLocalNotice"];
  ensureFreshRoutePreflight: UseChatOutboundExecutionInput["routing"]["ensureFreshRoutePreflight"];
  isRoutePreflightAcknowledged: UseChatOutboundExecutionInput["routing"]["isRoutePreflightAcknowledged"];
  finishOutboundExecution: () => void;
  getOutboundErrorSource: (action: OutboundQueueItem["action"]) => ChatErrorSource;
  scheduleStreamMessageReconciliation: (sessionId: string, options?: { immediate?: boolean }) => void;
  onExternalContextSentRef: MutableRefObject<UseChatOutboundExternalContext["onExternalContextSent"]>;
  onTemplateInvocationSentRef: MutableRefObject<UseChatOutboundExternalContext["onTemplateInvocationSent"]>;
  onWorkspaceSnapshotFailedRef: MutableRefObject<UseChatOutboundExternalContext["onWorkspaceSnapshotFailed"]>;
  streamEnabled: boolean;
  isBackgroundChatUserInputPrompt: typeof isBackgroundChatUserInputPrompt;
  isThreadMutatingStreamChunk: typeof isThreadMutatingStreamChunk;
  updateThreadFromStreamChunk: typeof updateThreadFromStreamChunk;
  clearChatStreamActivity: typeof clearChatStreamActivity;
  recordChatStreamChunkActivity: typeof recordChatStreamChunkActivity;
  recordClientDiagnostic: typeof recordClientDiagnostic;
  recordChatApprovalPhase: typeof recordChatApprovalPhase;
  recordChatOutboundPhase: typeof recordChatOutboundPhase;
  isAbortError: typeof isAbortError;
  shouldExecuteLocalChatCommand: typeof shouldExecuteLocalChatCommand;
  assertCurrentCustody: () => void;
  isCurrentCustody: () => boolean;
}

const MAX_STREAM_RESUME_ATTEMPTS = 2;
const ROUTE_FALLBACK_ACK_REQUIRED_MESSAGE = "Please confirm the route fallback before sending.";
const STREAMING_REQUEST_FAILED_MESSAGE = "Streaming request failed.";

export function createOutboundExecutionHandler(owner: OutboundExecutionCodeOwner) {
  const {
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
    ensureSession,
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
  } = owner;
  return async (item: OutboundQueueItem, prepared: PreparedOutboundExecution): Promise<void> => {
    const {
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
    } = prepared;
    let canonicalTurnAccepted = false;
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
        // Per-turn discriminator: without this, two messages' summaries
        // completing within the shared 1200ms throttle window (fast retry,
        // quick follow-up, agentic loop) would collide on the single
        // app-wide "chat:thread.preview_path" bucket and the second
        // summary would be silently dropped, defeating its purpose of
        // proving the preview path ran for THIS message.
        throttleKeySuffix: turnId,
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
      assertCurrentCustody();
      session = await ensureSession();
      if (shouldProjectOptimisticUserMessage) {
        setOptimisticUserMessage((current) =>
          current?.queueItemId === item.id ? { ...current, sessionId: session!.sessionId } : current,
        );
      }
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
        assertCurrentCustody();
        await handleCommandExecution(session.sessionId, trimmedContent);
        assertCurrentCustody();
        await loadSidebar(undefined, { bypassCache: true, preferredSessionId: session.sessionId });
        assertCurrentCustody();
        if (item.action === "send" && item.workspaceSnapshot) {
          // Local commands do not create a Chat turn, so the one-shot snapshot
          // remains armed for the next actual outbound turn.
          onWorkspaceSnapshotFailedRef.current?.(item);
        }
        return;
      }
      assertCurrentCustody();
      const routePreflight = await ensureFreshRoutePreflight({
        sessionId: session.sessionId,
        action: item.action,
        turnId: item.targetTurnId,
        content: trimmedContent,
        requestPrefs,
        workspaceSnapshot: item.workspaceSnapshot,
        force: true,
      });
      assertCurrentCustody();
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
              messageId: localUserMessageId,
              sessionId: session.sessionId,
              role: "user",
              actorType: "user",
              actorId: "operator",
              sourceAuthority: "operator",
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
        // Seed a baseline activity timestamp as soon as the stream is
        // created so the stall indicator has something to measure against
        // while the connection is still opening ("connecting" status),
        // before the first chunk (or even message_start) has arrived.
        recordChatStreamChunkActivity(session.sessionId);
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
        let streamErrorChunkReceived = false;
        let terminalStreamStateReceived = false;
        let cancelledStreamStateReceived = false;
        const onChunk = (chunk: ChatStreamChunk) => {
          const liveStream = activeStreamRef.current;
          if (!isCurrentCustody()) return;
          if (
            liveStream?.streamToken !== streamToken ||
            liveStream.controller.signal.aborted ||
            cancelledStreamStateReceived ||
            liveStream.sessionId !== session!.sessionId ||
            chunk.sessionId !== liveStream.sessionId ||
            (liveStream.turnId && chunk.turnId && chunk.turnId !== liveStream.turnId) ||
            selectedSessionIdRef.current !== session!.sessionId
          ) {
            return;
          }
          // Only a server-authored turn identity proves this request crossed
          // the canonical turn boundary. Route-level error chunks may omit
          // turnId, so treating every chunk as acceptance would consume a
          // one-shot workspace snapshot before any turn existed.
          if (typeof chunk.turnId === "string" && chunk.turnId.trim().length > 0) {
            assertCurrentCustody();
            canonicalTurnAccepted = true;
          }
          // Any chunk that survives the identity guard above proves the
          // stream connection is alive, even one the dedupe guard below
          // will drop as a replay/duplicate: a dropped duplicate still
          // arrived over the wire, so it must count as liveness. Recording
          // it here (before dedupe) keeps heartbeat-adjacent silence from
          // ever being mistaken for a stall. Note: SSE `: heartbeat`
          // comment lines never reach onChunk at all (the SSE parser drops
          // them), so real heartbeats correctly do NOT mask a stall.
          recordChatStreamChunkActivity(session!.sessionId);
          // Server sequences are strictly increasing per turn; anything at or
          // below the last successfully processed one is a replay (resume
          // overlap, re-delivery) whose effects already landed. Synthetic
          // client chunks use negative sequences and are exempt.
          const chunkSequence = typeof chunk.sequence === "number" && chunk.sequence >= 0 ? chunk.sequence : null;
          if (
            chunkSequence !== null &&
            typeof liveStream.lastSequence === "number" &&
            chunkSequence <= liveStream.lastSequence
          ) {
            return;
          }
          // The resume cursor may only advance after a chunk's handlers have
          // run: a handler that throws must leave the cursor on the previous
          // chunk so resume re-delivers this one.
          const advanceStreamCursor = () => {
            liveStream.lastEventId = chunk.eventId;
            if (chunk.runId) {
              liveStream.runId = chunk.runId;
            }
            if (chunkSequence !== null) {
              liveStream.lastSequence = chunkSequence;
            }
          };
          if (chunk.type === "message_start") {
            // Guards against double-counting if a resumed/retried segment ever
            // reuses this onChunk closure across more than one message_start;
            // the normal per-message case starts these already at zero.
            previewDeltaCount = 0;
            previewCharCount = 0;
            liveStream.turnId = chunk.turnId;
            locallyHandledTurnKeysRef.current.add(`${chunk.sessionId}:${chunk.turnId}`);
            setOptimisticUserMessage((current) => (current?.queueItemId === item.id ? null : current));
            getStreamingPreviewBuffer().start({
              sessionId: chunk.sessionId,
              turnId: chunk.turnId,
              messageId: chunk.messageId,
            });
          }
          if (chunk.type === "trace_update" && chunk.trace.durable?.runId) {
            liveStream.runId = chunk.trace.durable.runId;
          }
          if (
            chunk.type === "trace_update" &&
            (chunk.trace.status === "failed" || chunk.trace.status === "cancelled")
          ) {
            terminalStreamStateReceived = true;
          }
          if (chunk.type === "done") {
            terminalStreamStateReceived = true;
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
          if (chunk.type === "trace_update" && chunk.trace.status === "cancelled") {
            cancelledStreamStateReceived = true;
            setPendingApproval(null);
            setPendingUserInput(null);
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
            if (!isBackgroundChatUserInputPrompt(chunk.prompt)) setPendingApproval(null);
            setPendingUserInput(chunk.prompt);
          }
          if (
            chunk.type === "trace_update" &&
            chunk.trace.pendingUserInput === undefined &&
            chunk.trace.status !== "waiting_for_user_input"
          ) {
            setPendingUserInput((current) => (isBackgroundChatUserInputPrompt(current) ? null : current));
          }
          if (chunk.type === "error") {
            streamErrorChunkReceived = true;
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
            advanceStreamCursor();
            return;
          }
          if (!isThreadMutatingStreamChunk(chunk)) {
            advanceStreamCursor();
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
          advanceStreamCursor();
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
              assertCurrentCustody();
              await resumeChatTurnStream(session.sessionId, liveStream.turnId, onChunk, {
                signal: controller.signal,
                sinceEventId: liveStream.lastEventId,
                originSurface: effectiveMode,
              });
            } else if (item.action === "retry" && item.targetTurnId) {
              assertCurrentCustody();
              await streamRetryChatTurn(
                session.sessionId,
                item.targetTurnId,
                {
                  providerId: routeExecutionProviderId,
                  model: routeExecutionModel,
                  routeDecision: routeExecutionDecision,
                  mode: effectiveMode,
                  webMode: requestPrefs.webMode,
                  memoryMode: requestPrefs.memoryMode,
                  thinkingLevel: requestPrefs.thinkingLevel,
                  speedMode: requestPrefs.speedMode,
                  subagentPolicy: requestPrefs.subagentPolicy,
                  ...councilOptIn,
                  ...(requestPrefs.fullWebAccess ? { fullWebAccess: true } : {}),
                },
                onChunk,
                { signal: controller.signal, originSurface: effectiveMode },
              );
            } else if (item.action === "edit" && item.targetTurnId) {
              assertCurrentCustody();
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
                  ...councilOptIn,
                  ...(requestPrefs.fullWebAccess ? { fullWebAccess: true } : {}),
                },
                onChunk,
                { signal: controller.signal, originSurface: effectiveMode },
              );
            } else {
              assertCurrentCustody();
              await streamAgentChatMessage(
                session.sessionId,
                {
                  content: trimmedContent,
                  attachments: attachmentIds,
                  ...externalContextOptIn,
                  ...templateInvocationOptIn,
                  ...workspaceSnapshotOptIn,
                  ...outboundPrefs,
                  mode: effectiveMode,
                  providerId: routeExecutionProviderId,
                  model: routeExecutionModel,
                  routeDecision: routeExecutionDecision,
                  ...councilOptIn,
                  ...(requestPrefs.fullWebAccess ? { fullWebAccess: true } : {}),
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
            // The shared SSE consumer rethrows a server error chunk after it
            // reaches EOF so the caller retains the failure message. Once the
            // same stream has also delivered canonical terminal state, that
            // exception is an application failure, not a transport drop.
            if (streamErrorChunkReceived && terminalStreamStateReceived) {
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
        if (!canonicalTurnAccepted) {
          throw new Error("Streaming request ended before a canonical Chat turn was accepted.");
        }
        const finalizedStreamMessage = finalizedStreamMessageRef.current;
        const missingFinalizedMessage =
          !finalizedStreamMessage || finalizedStreamMessage.sessionId !== session.sessionId;
        scheduleStreamMessageReconciliation(session.sessionId, {
          immediate: missingFinalizedMessage,
        });
      } else {
        setPendingApproval(null);
        assertCurrentCustody();
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
                  webMode: requestPrefs.webMode,
                  memoryMode: requestPrefs.memoryMode,
                  thinkingLevel: requestPrefs.thinkingLevel,
                  speedMode: requestPrefs.speedMode,
                  subagentPolicy: requestPrefs.subagentPolicy,
                  ...councilOptIn,
                  ...(requestPrefs.fullWebAccess ? { fullWebAccess: true } : {}),
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
                    ...councilOptIn,
                    ...(requestPrefs.fullWebAccess ? { fullWebAccess: true } : {}),
                  },
                  { originSurface: effectiveMode },
                )
              : await sendAgentChatMessage(
                  session.sessionId,
                  {
                    content: trimmedContent,
                    attachments: attachmentIds,
                    ...externalContextOptIn,
                    ...templateInvocationOptIn,
                    ...workspaceSnapshotOptIn,
                    ...outboundPrefs,
                    mode: effectiveMode,
                    providerId: routeExecutionProviderId,
                    model: routeExecutionModel,
                    routeDecision: routeExecutionDecision,
                    ...councilOptIn,
                    ...(requestPrefs.fullWebAccess ? { fullWebAccess: true } : {}),
                  },
                  { originSurface: effectiveMode },
                );
        canonicalTurnAccepted = true;
        assertCurrentCustody();
        if (sent.trace) {
          setCapabilitySuggestions(sent.trace.capabilityUpgradeSuggestions ?? []);
          setSpecialistSuggestions(sent.trace.specialistCandidateSuggestions ?? []);
        }
        const canonicalUserMessageId = sent.userMessage?.messageId;
        if (shouldProjectOptimisticUserMessage && canonicalUserMessageId) {
          setOptimisticUserMessage((current) =>
            current?.queueItemId === item.id ? { ...current, canonicalMessageId: canonicalUserMessageId } : current,
          );
        }
        await loadSessionCoreState(session.sessionId, {
          background: true,
          includeThread: true,
        });
        assertCurrentCustody();
        setOptimisticUserMessage((current) => (current?.queueItemId === item.id ? null : current));
      }
      assertCurrentCustody();
      setEditingTurnId(null);
      // Successful (non-thrown) completion is the ONLY point that consumes
      // the frozen external-source selection; the catch/abort paths below
      // return without reaching here, so failed sends retain it.
      if (externalContextRefs) {
        onExternalContextSentRef.current?.(item);
      }
      if (item.templateInvocation) {
        onTemplateInvocationSentRef.current?.(item);
      }
      const completedSessionId = session.sessionId;
      void loadSidebar(undefined, {
        bypassCache: true,
        preferredSessionId: completedSessionId,
        reconcileLoadedRange: true,
      }).catch((sidebarError: unknown) => {
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
      });
      recordChatOutboundPhase({
        phase: "complete",
        action: item.action,
        correlationId: executionCorrelationId,
        sessionId: session.sessionId,
        turnId: item.targetTurnId,
        message: `${item.action} action completed`,
      });
    } catch (err) {
      if (!isCurrentCustody()) return;
      if (isAbortError(err)) {
        if (item.action === "send" && item.workspaceSnapshot && !canonicalTurnAccepted) {
          onWorkspaceSnapshotFailedRef.current?.(item);
        }
        if (session) {
          promoteStreamingPreviewToThread(session.sessionId, "abort");
        }
        // Fall back to the queue-item id so rapid abort-during-send summaries
        // from distinct sends never collide on the shared throttle bucket.
        flushPreviewPathDiagnostic("abort", activeStreamRef.current?.turnId ?? item.targetTurnId ?? item.id);
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
        if (item.action === "send" && item.workspaceSnapshot && !canonicalTurnAccepted) {
          onWorkspaceSnapshotFailedRef.current?.(item);
        }
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
      if (isCurrentCustody()) {
        setOptimisticUserMessage((current) => (current?.queueItemId === item.id ? null : current));
        const activeStream = activeStreamRef.current;
        if (session && activeStream?.sessionId === session.sessionId) {
          activeStreamRef.current = null;
        }
        if (!session || activeStream?.sessionId === session.sessionId) {
          clearStreamingPreview({ allowSettlingFinalText: true });
        }
        if (session && activeStream?.sessionId === session.sessionId) {
          clearChatStreamActivity(session.sessionId);
        }
        finishOutboundExecution();
      }
    }
  };
}
