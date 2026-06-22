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
import type { ChatSteerService } from "./chat-steer-service.js";

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
  ingestEvent(idempotencyKey: string, payload: GatewayEventInput): Promise<unknown>;
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

export interface ChatTurnLeaseControl {
  withChatTurnWriteLease<T>(sessionId: string, operation: string, task: () => Promise<T>): Promise<T>;
  withChatTurnWriteLeaseStream(
    sessionId: string,
    operation: string,
    factory: () => AsyncGenerator<ChatStreamChunk>,
  ): AsyncGenerator<ChatStreamChunk>;
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
  persistChatStreamChunk(chunk: ChatStreamChunkDraft, durableRunId?: string): void;
  createHydratedChatTurnTrace(turnId: string, trace: ChatTurnTraceRecord): ChatTurnTraceRecord;
  registerActiveChatTurnStream(sessionId: string, turnId: string, durableRunId?: string): void;
  getActiveChatTurnStream(turnId: string):
    | {
        sessionId: string;
        runId?: string;
      }
    | undefined;
  completeActiveChatTurnStream(turnId: string): void;
  closeActiveChatTurnStream(turnId: string): void;
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
  ): DurableRunRecord | undefined;
  finalizeDurableChatRun(runId: string, prepared: PreparedAgentChatTurn, trace: ChatTurnTraceRecord): void;
  /**
   * Soft-cancel a durable chat run when an external `AbortSignal` fires while
   * `consumePreparedAgentChatTurn` is waiting on its persisted stream. The
   * implementation typically delegates to the durable-kernel's cancel API
   * (`cancelDurableRun`). Optional because not every dispatch host owns a
   * durable kernel (e.g., tests).
   */
  cancelDurableChatRun?(runId: string, actorId?: string): void;
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
  scheduleMemoryMaintenancePostTurnEvaluation(sessionId: string, parentTurnId?: string): void;
  /**
   * Fire-and-forget self-improvement background review (P2-S1). After a
   * successful root turn, distills durable operator facts and (when a reusable
   * procedure emerged) drafts a candidate skill — counter-gated to run every few
   * turns. The host resolves the master-autonomy / eval-integrity / non-human
   * guards and the counter; the entry/stream services only supply the transcript.
   * Errors are swallowed by the host — this never affects the turn.
   */
  scheduleBackgroundReviewIfDue(input: {
    sessionId: string;
    workspaceId: string;
    userText: string;
    assistantText: string;
    parentTurnId?: string;
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
