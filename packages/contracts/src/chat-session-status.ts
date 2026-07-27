import type { ChatMemoryMode, ChatRetrievalMode, ChatTurnLifecycleStatus, ChatUserInputPromptKind } from "./chat.js";
import type { DurableRecoveryState, DurableRunStatus, DurableWorkerHealth } from "./durable.js";
import type { ModelUsageMetricAvailability } from "./model-usage.js";
import type { RuntimeBuildIdentity } from "./review-readiness.js";

export const CHAT_SESSION_STATUS_VERSION = "chat.session-status.v1" as const;

export type ChatSessionStatusSection<T> =
  | { availability: "available"; value: T }
  | { availability: "unavailable"; reason: string };

export interface ChatSessionStatusModel {
  providerId: string;
  model: string;
  selectionSource: "turn_trace" | "session_preference" | "runtime_default";
}

export interface ChatSessionStatusSnapshotReceipt {
  snapshotId: string;
  snapshotHash: string;
  turnId: string;
  createdAt: string;
  includedCount: number;
  truncatedCount: number;
  omittedCount: number;
}

export interface ChatSessionStatusContext {
  contextWindowTokens: number;
  promptReservedTokens?: number;
  outputReservedTokens?: number;
  usedTokens?: number;
  attachmentCount: number;
  latestSnapshot?: ChatSessionStatusSnapshotReceipt;
}

export interface ChatSessionStatusDurableRun {
  runId: string;
  status: DurableRunStatus;
  workerHealth: DurableWorkerHealth;
  recoveryState: DurableRecoveryState;
  recoverySummary?: string;
}

export interface ChatSessionStatusWork {
  latestTurnId?: string;
  turnCounts: Record<
    Extract<
      ChatTurnLifecycleStatus,
      "queued" | "running" | "waiting_for_tool" | "waiting_for_approval" | "waiting_for_user_input"
    >,
    number
  >;
  durableRuns: ChatSessionStatusDurableRun[];
}

export interface ChatSessionStatusApproval {
  approvalId: string;
  turnId?: string;
  kind: string;
  riskLevel?: "safe" | "caution" | "danger" | "nuclear";
  createdAt: string;
}

export interface ChatSessionStatusUserInput {
  turnId: string;
  promptId: string;
  kind: ChatUserInputPromptKind;
  title: string;
  question: string;
}

export interface ChatSessionStatusAttention {
  pendingApprovals: ChatSessionStatusApproval[];
  pendingUserInputs: ChatSessionStatusUserInput[];
}

export interface ChatSessionStatusOrchestrationRun {
  runId: string;
  status: "running" | "completed" | "failed" | "partial";
  objective: string;
  completedSteps: number;
  activeSteps: number;
  totalSteps: number;
}

export interface ChatSessionStatusCapabilities {
  profileTurnId: string;
  callableTools: string[];
  trustedSkills: Array<{ skillId: string; trustLabel: string }>;
  attachedContextTools: string[];
  memory: {
    mode: ChatMemoryMode;
    retrievalMode: ChatRetrievalMode;
    writeApprovalRequired: boolean;
  };
}

export interface ChatSessionStatusUsageMetric {
  value?: number;
  availability: ModelUsageMetricAvailability;
}

export interface ChatSessionStatusUsage {
  attemptCount: number;
  inputTokens: ChatSessionStatusUsageMetric;
  outputTokens: ChatSessionStatusUsageMetric;
  costUsd: ChatSessionStatusUsageMetric;
}

export interface ChatSessionStatusResponse {
  schemaVersion: typeof CHAT_SESSION_STATUS_VERSION;
  sessionId: string;
  workspaceId: string;
  generatedAt: string;
  model: ChatSessionStatusSection<ChatSessionStatusModel>;
  context: ChatSessionStatusSection<ChatSessionStatusContext>;
  work: ChatSessionStatusSection<ChatSessionStatusWork>;
  attention: ChatSessionStatusSection<ChatSessionStatusAttention>;
  orchestration: ChatSessionStatusSection<{ runs: ChatSessionStatusOrchestrationRun[] }>;
  capabilities: ChatSessionStatusSection<ChatSessionStatusCapabilities>;
  usage: ChatSessionStatusSection<ChatSessionStatusUsage>;
  build: ChatSessionStatusSection<RuntimeBuildIdentity>;
}

/** Smaller, secret-free projection returned to models through `session.status`. */
export interface ChatSessionStatusModelProjection {
  schemaVersion: typeof CHAT_SESSION_STATUS_VERSION;
  sessionId: string;
  generatedAt: string;
  model: ChatSessionStatusSection<ChatSessionStatusModel>;
  context: ChatSessionStatusSection<
    Pick<
      ChatSessionStatusContext,
      "contextWindowTokens" | "promptReservedTokens" | "outputReservedTokens" | "usedTokens" | "attachmentCount"
    >
  >;
  work: ChatSessionStatusSection<{
    turnCounts: ChatSessionStatusWork["turnCounts"];
    durableRuns: Array<Pick<ChatSessionStatusDurableRun, "status" | "workerHealth" | "recoveryState">>;
  }>;
  attention: ChatSessionStatusSection<{ pendingApprovalCount: number; pendingUserInputCount: number }>;
  orchestration: ChatSessionStatusSection<{
    activeRunCount: number;
    activeStepCount: number;
    totalStepCount: number;
  }>;
  capabilities: ChatSessionStatusSection<ChatSessionStatusCapabilities>;
  usage: ChatSessionStatusSection<ChatSessionStatusUsage>;
}
