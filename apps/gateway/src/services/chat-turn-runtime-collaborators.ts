import type {
  ChatSendMessageRequest,
  ChatStreamChunk,
  ChatStreamChunkDraft,
  ChatTurnTraceRecord,
  GatewayEventInput,
  MemoryRelationScope,
  RealtimeEvent,
  ToolInvokeResult,
  ChannelSendInput,
  DurableRunRecord,
} from "@goatcitadel/contracts";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { ChatStreamMutationLifecycle } from "./chat-turn-types.js";
import type { ChatSteerService } from "./chat-steer-service.js";
import type { ActiveChatTurnStreamExecution } from "./chat-turn-execution-registry.js";
import type { SessionControlRuntimeOwner } from "./session-control-runtime-owner.js";

export type ChatTurnRealtimeOptions = Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">;

export interface ChatTurnRealtimeEmitter {
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: ChatTurnRealtimeOptions,
  ): void;
}

export interface ChatTurnTranscriptIngress {
  ingestEvent(
    idempotencyKey: string,
    payload: GatewayEventInput,
    options?: { onCommit?: () => void; afterCommit?: () => void },
  ): Promise<unknown>;
}

export interface ChatTurnActiveExecutionControl {
  beginActiveChatTurnExecution(sessionId: string, turnId: string, operation: string): AbortController;
  endActiveChatTurnExecution(turnId: string, controller: AbortController): void;
  getActiveChatTurnExecution(turnId: string):
    | {
        sessionId: string;
        controller: AbortController;
      }
    | undefined;
  markChatTurnCancelled(sessionId: string, turnId: string, cancelledBy?: string): ChatTurnTraceRecord;
}

export interface ChatTurnAdmissionControl {
  readonly sessionControlRuntimeOwner: Pick<
    SessionControlRuntimeOwner,
    | "admitOperatorChatTurn"
    | "admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery"
    | "startRequestLeaseHeartbeat"
    | "renewRequestLease"
    | "bindDurableRun"
    | "withDurableClaim"
    | "assertActiveTurnWrite"
    | "closeTurnWrite"
  >;
}

export interface ChatTurnLeaseControl {
  withChatTurnWriteLease<T>(sessionId: string, operation: string, task: () => Promise<T>): Promise<T>;
  withChatTurnWriteLeaseStream(
    sessionId: string,
    operation: string,
    factory: () => AsyncGenerator<ChatStreamChunk>,
  ): AsyncGenerator<ChatStreamChunk>;
}

export interface ChatTurnStreamRegistrationOptions {
  continuation?: boolean;
  reservation?: boolean;
}

export interface ChatTurnStreamLifecycleControl {
  withEphemeralStreamEnvelope(
    stream: AsyncGenerator<ChatStreamChunkDraft>,
    runId?: string,
  ): AsyncGenerator<ChatStreamChunk>;
  streamPersistedChatTurnEvents(
    sessionId: string,
    turnId: string,
    options?: {
      sinceEventId?: string;
      liveTail?: boolean;
      returnOnDurableInterrupt?: boolean;
      signal?: AbortSignal;
    },
  ): AsyncGenerator<ChatStreamChunk>;
  persistChatStreamChunk(
    chunk: ChatStreamChunkDraft,
    durableRunId?: string,
    streamRegistration?: ActiveChatTurnStreamExecution,
  ): void;
  createHydratedChatTurnTrace(turnId: string, trace: ChatTurnTraceRecord): ChatTurnTraceRecord;
  registerActiveChatTurnStream(
    sessionId: string,
    turnId: string,
    durableRunId?: string,
    options?: ChatTurnStreamRegistrationOptions,
  ): ActiveChatTurnStreamExecution;
  getActiveChatTurnStream(turnId: string): ActiveChatTurnStreamExecution | undefined;
  completeActiveChatTurnStream(turnId: string, registrationId: string): boolean;
  closeActiveChatTurnStream(turnId: string, registrationId: string): boolean;
}

export interface ChatTurnDurableRunOwner {
  readonly config: {
    assistant: {
      durable: {
        enabled: boolean;
        executionEnabled: boolean;
        chatAutoPromoteEnabled: boolean;
      };
    };
  };
  readonly backgroundTasks: Set<Promise<void>>;
  isFeatureEnabled(flag: string): boolean;
  beginDurableChatRun(
    prepared: PreparedAgentChatTurn,
    input: ChatSendMessageRequest,
    threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
    options?: { mutationLifecycle?: ChatStreamMutationLifecycle; runId?: string },
  ): DurableRunRecord | undefined;
  finalizeDurableChatRun(
    runId: string,
    prepared: PreparedAgentChatTurn,
    trace: ChatTurnTraceRecord,
    expectedLeaseOwnerId?: string,
  ): void;
  /**
   * Soft-cancel a durable chat run when an external `AbortSignal` fires while
   * `consumePreparedAgentChatTurn` is waiting on its persisted stream. The
   * implementation typically delegates to the durable-kernel's cancel API
   * (`cancelDurableRun`). Optional because not every dispatch host owns a
   * durable kernel (e.g., tests).
   */
  cancelDurableChatRun?(runId: string, actorId?: string): DurableRunRecord | undefined;
}

export interface ChatTurnMemorySideEffects {
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: {
      role: "user" | "assistant";
      sourceRef: string;
      trace?: Pick<ChatTurnTraceRecord, "status" | "toolRuns">;
    },
  ): void;
  /**
   * Fire-and-forget post-turn commitment inference (P1-F3). Runs a cheap hidden
   * classifier over the just-completed transcript to infer future follow-up
   * check-ins, persisted (deduped, confidence-gated) for the maintenance sweep
   * to deliver. The host applies the master-autonomy / eval-integrity /
   * non-human guards; the entry service only supplies the transcript. Errors are
   * swallowed by the host — this never affects the turn.
   */
  recordTurnCommitments(input: {
    sessionId: string;
    workspaceId: string;
    userText: string;
    assistantText: string;
    /** True when the completed turn is itself an autonomous self-wake (skip). */
    autonomous?: boolean;
  }): void;
  scheduleChatMemoryContextPrewarm(input: {
    sessionId: string;
    prompt: string;
    relationScope?: MemoryRelationScope;
  }): void;
  scheduleMemoryMaintenancePostTurnEvaluation(input: {
    sessionId: string;
    /** The turn that just completed, retained for truthful post-turn provenance. */
    turnId: string;
    /** True only for a delegated child, not for an ordinary turn with branch ancestry. */
    delegatedChild: boolean;
  }): void;
  /**
   * Fire-and-forget self-improvement background review (P2-S1). After a
   * successful eligible turn, distills durable operator facts and (when a reusable
   * procedure emerged) drafts a candidate skill — counter-gated to run every few
   * turns. The host resolves the master-autonomy / eval-integrity / non-human
   * guards and the counter; the entry/stream services only supply the transcript.
   * Errors are swallowed by the host — this never affects the turn.
   */
  scheduleBackgroundReviewIfDue(input: {
    sessionId: string;
    workspaceId: string;
    /** The turn that produced this review input and owns any resulting provenance. */
    turnId: string;
    userText: string;
    assistantText: string;
    /** True only for a delegated child, not for an ordinary turn with branch ancestry. */
    delegatedChild: boolean;
    /** True when the completed turn is itself an autonomous self-wake (skip). */
    autonomous?: boolean;
  }): void;
  recordCapabilityGapFromTrace(input: {
    sessionId: string;
    turnId: string;
    content: string;
    trace: ChatTurnTraceRecord;
  }): void;
}

export interface ChatTurnIntegrationDispatch {
  ensureSessionInternalToolGrant(sessionId: string, toolName: string, reason: string): void;
  requireExecutedToolResult(
    toolName: string,
    result: ToolInvokeResult | Record<string, unknown>,
  ): Record<string, unknown>;
  commsSend(input: ChannelSendInput): Promise<ToolInvokeResult | Record<string, unknown>>;
}

export interface ChatTurnSteerCollaborator {
  readonly steerService: ChatSteerService;
}
