import type {
  ChatSendMessageRequest,
  ChatStreamChunk,
  ChatStreamChunkDraft,
  ChatTurnBranchKind,
  ChatUserInputPromptResponse,
} from "@goatcitadel/contracts";
import type { OrchestrationPlan as ModeOrchestrationPlan, OrchestrationRouterInput } from "../orchestration/types.js";

export type PersistableChatStreamChunk = ChatStreamChunkDraft extends infer T
  ? T extends { turnId?: string }
    ? T & { turnId: string }
    : never
  : never;

export type InspectableChatStreamChunk = ChatStreamChunk | ChatStreamChunkDraft;

export interface PreparedChatExecutionPlanResolution {
  routerInput: OrchestrationRouterInput;
  orchestrationPlan: ModeOrchestrationPlan;
  executionPlanDraft: {
    source: "planner" | "workflow_template" | "planner_with_template_fallback";
    advisoryOnly: boolean;
    objective: string;
    summary: string;
    steps: Array<{
      stepId: string;
      index: number;
      objective: string;
      successCriteria?: string;
      suggestedTools?: string[];
      expectedOutput?: string;
      parallelizable: boolean;
      dependsOnStepIds?: string[];
      delegatedRole?: string;
      status: "pending" | "running" | "completed" | "failed" | "cancelled";
      summary?: string;
      error?: string;
      startedAt?: string;
      finishedAt?: string;
      childRunId?: string;
      childSessionId?: string;
      childTurnId?: string;
    }>;
  };
}

export interface DurableChatTurnExecutionPayload {
  version: "chat.turn.execute.v1";
  sessionId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  branchKind: ChatTurnBranchKind;
  parentTurnId?: string;
  sourceTurnId?: string;
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited";
  request: ChatSendMessageRequest;
  userInputResponses?: DurableChatTurnUserInputResumeRecord[];
}

export interface DurableChatTurnUserInputResumeRecord {
  promptId: string;
  kind: "single_select" | "text";
  title?: string;
  question: string;
  answeredAt: string;
  response: ChatUserInputPromptResponse;
  selectedOption?: {
    optionId: string;
    label: string;
    description?: string;
  };
}

export function isPersistableChatStreamChunk(chunk: ChatStreamChunkDraft): chunk is PersistableChatStreamChunk {
  return typeof chunk.turnId === "string" && chunk.turnId.length > 0;
}
