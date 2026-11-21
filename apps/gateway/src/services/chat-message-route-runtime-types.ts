import type { ChatTurnTraceRecord, RealtimeEvent } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage, DurableChatUserInputResponderAuthSource } from "@goatcitadel/storage";
import type { DurableRunService } from "./durable-run-service.js";
import type { ChatTurnSessionState } from "./chat-turn-prep-service.js";

export interface ChatThreadLoadOptions {
  includeDecisionTrace?: boolean;
  /** Internal only: keeps retained system runs out of Chat branch hydration. */
  isConversationTrace?: (trace: ChatTurnTraceRecord) => boolean;
}

export interface ChatMessageRouteRuntimeHost {
  chatAsyncClarificationV1Enabled?: () => boolean | Promise<boolean>;
  readonly config?: {
    rootDir: string;
    assistant: { workspaceDir: string };
  };
  readonly storage: Storage;
  readonly durableRunService: Pick<DurableRunService, "getDurableRun" | "requestRunProcessing">;
  getSession(sessionId: string): unknown | Promise<unknown>;
  loadChatTurnSessionState(sessionId: string, options?: ChatThreadLoadOptions): Promise<ChatTurnSessionState>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
  recordDevDiagnostic(input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    sessionId?: string;
    turnId?: string;
    context?: Record<string, unknown>;
  }): void;
  configureRuntimeTarget?(input: {
    targetId: string;
    secret: string;
    requestId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    actorId: string;
    expiresAt: string;
    operatorId?: string;
    authActorSource?: ChatUserInputPromptResponder["authActorSource"];
    runId?: string;
    taskId?: string;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
    approvedAction?: {
      approvalId: string;
      toolRunId: string;
      promptId: string;
    };
  }): Promise<{
    targetId: string;
    provider: string;
    revision: string;
    scopeRef: string;
  }>;
  getRuntimeConfigurationScopeRef?(targetId: string): string;
  finalizeRuntimeConfiguration?(requestId: string): void | Promise<void>;
  rollbackRuntimeConfiguration?(requestId: string): Promise<void>;
}

export interface ChatUserInputPromptResponder {
  actorId: string;
  authActorSource: DurableChatUserInputResponderAuthSource;
}
