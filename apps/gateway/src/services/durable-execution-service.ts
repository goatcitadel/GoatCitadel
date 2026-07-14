/* eslint-disable max-lines -- Durable execution helpers and workflow registry stay co-located so lease, recovery, and step replay stay traceable together. */
/**
 * Durable execution helpers and workflow registry.
 *
 * Durable run state stays with DurableRunService; workflow-specific execution
 * enters here through typed executor hosts.
 */

import {
  CHAT_TURN_ACTIVE_STATUSES,
  type ChannelSendInput,
  type ChannelActivityInput,
  type ChannelActivityResult,
  type ChannelReplyInput,
  type ChannelReactInput,
  type ChannelTypingInput,
  type ChannelTypingResult,
  type ChannelUnsendInput,
  ConflictError,
  type ConnectorRecord,
  type McpInvokeRequest,
  type McpInvokeResponse,
  NotFoundError,
  type ApprovalWaitWorkflowPayload,
  type ChatSendMessageRequest,
  type ChatRoutedContextSnapshotRecord,
  type ChatTurnTraceRecord,
  type ConnectorDeliveryWorkflowPayload,
  type CuratorTickWorkflowPayload,
  type DurableRunRecord,
  type DurableRunTimelineEvent,
  type ExternalSideEffectReplayWorkflowPayload,
  type ExternalSideEffectRunRecord,
  type HookTrigger,
  type OrchestrationPlanWorkflowPayload,
  type ProactiveTickWorkflowPayload,
  type ProactiveRunRecord,
  type RealtimeEvent,
  type ToolInvokeResult,
  isChatTurnTerminalStatus,
  isDurableRunTerminal,
  redactStructuredSecrets,
} from "@goatcitadel/contracts";
import {
  sealChatTurnCapabilityProfile,
  verifyChatRoutedContextSnapshot,
  verifyChatTurnCapabilityCatalogBinding,
  verifyChatTurnCapabilitySkillBindings,
  type Storage,
} from "@goatcitadel/storage";
import type { ApprovalRemoteTokenSecretService } from "./approval-remote-token-secret.js";
import { hydrateBrowserApprovalRemoteTokenConnectorDeliveryPayload } from "./approval-connector-delivery.js";
import { dispatchConnectorDelivery } from "./connector-delivery.js";
import type { ChatProactiveService } from "./chat-proactive-service.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";
import {
  hasAutonomousChatPostCommitPending,
  readGeneralChatPostCommitPendingMarker,
  type GeneralChatPostCommitDurableEffectInput,
  type GeneralChatPostCommitDurableEffectExecutionInput,
  type GeneralChatPostCommitEffectWorkflowPayload,
  type GeneralChatPostCommitEffect,
  type GeneralChatPostCommitProgress,
} from "./chat-durable-run-service.js";
import { upsertChatCapabilityProfileSystemInstruction, type PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";
import { enqueueAgentEndHook } from "./chat-turn-stream-events.js";
import type { DurableChatTurnExecutionPayload, DurableChatTurnUserInputResumeRecord } from "./chat-turn-types.js";
import type { CuratorService } from "./curator-service.js";
import { parseOrchestrationWorkflowPayload as parseOrchestrationLifecycleWorkflowPayload } from "./orchestration-lifecycle-state-helpers.js";
import type { DurableRunService } from "./durable-run-service.js";
import type { HooksService } from "./hooks-service.js";
import { IDEMPOTENT_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { isAutonomousTurnRequest } from "./gateway/autonomous-turn-policy.js";
import {
  type IdempotentExternalSideEffectRunInput,
  type ExternalSideEffectReplayWorkerResult,
  runIdempotentExternalSideEffect,
  runReplaySafeExternalSideEffectWorker,
} from "./external-side-effect-runner-service.js";

type DurableExecutionStorage = chatTurnDispatchService.ChatTurnDispatchHost["storage"] &
  Pick<
    Storage,
    | "approvals"
    | "audit"
    | "chatMessages"
    | "chatTurnCapabilityProfiles"
    | "capabilityCatalogSnapshots"
    | "externalSideEffectRuns"
    | "mutationIdempotency"
    | "remoteActionTokens"
    | "routedContextSnapshots"
    | "runImmediateTransaction"
    | "skillLifecycle"
  >;

/** Channel routing recorded on an autonomous turn's `metadata.autonomous`. */
export interface AutonomousTurnDeliveryChannel {
  channelKey: string;
  target?: string;
}

/**
 * The `metadata.autonomous` block written by the gateway when it enqueues an
 * autonomous (cron/heartbeat/proactive) `chat.turn.execute` run. Drives the
 * post-turn channel delivery.
 */
export interface AutonomousTurnMetadata {
  kind: string;
  systemActorId?: string;
  reason?: string;
  deliverMode?: "always" | "on_notify";
  deliveryChannel?: AutonomousTurnDeliveryChannel;
  commitmentId?: string;
}

/** Request passed to the gateway-backed autonomous channel delivery enqueue. */
export interface AutonomousChannelDeliveryRequest {
  runId: string;
  sessionId: string;
  turnId?: string;
  assistantText: string;
  deliveryChannel: AutonomousTurnDeliveryChannel;
  systemActorId?: string;
  reason?: string;
  commitmentId?: string;
}

/** Request passed to the gateway-backed silent-heartbeat transcript cleanup. */
export interface SilentHeartbeatCleanupRequest {
  sessionId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  /** Active leaf to revert to (the leaf before the heartbeat seed turn). */
  parentTurnId?: string;
}

export type SilentHeartbeatCleanupResult =
  | { status: "completed" | "already_completed" | "not_required" }
  | { status: "manual_reconciliation" | "retryable_failure"; reason: string };

export interface DurableExecutionHost extends chatTurnDispatchService.ChatTurnDispatchHost {
  readonly storage: DurableExecutionStorage;
  readonly gatewaySql: Storage["gatewaySql"];
  readonly durableRunService: Pick<
    DurableRunService,
    "retryDurableRun" | "scheduleRunningWorkflowRetry" | "requestRunProcessing"
  >;
  readonly hooksService: Pick<
    HooksService,
    "runInlineHooks" | "enqueueAfterHooks" | "executeHookDelivery" | "markHookRunDeadLettered"
  >;
  readonly memoryLifecycleService: Pick<
    MemoryLifecycleService,
    "parseMaintenanceWorkflowPayload" | "syncMaintenanceFromDurableRun" | "executeMaintenanceDurableRun"
  >;
  readonly chatProactiveService: Pick<ChatProactiveService, "executeDurableProactiveTickRun">;
  executeDurableOrchestrationRun(
    run: DurableRunRecord,
    context?: DurableWorkflowExecutionContext,
  ): Promise<{ outcome: "paused" | "completed" | "failed" | "cancelled"; checkpointState: Record<string, unknown> }>;
  prepareAgentChatTurn(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: {
      branchKind?: PreparedAgentChatTurn["branchKind"];
      sourceTurnId?: string;
      parentTurnId?: string;
      existingUserMessage?: PreparedAgentChatTurn["userMessage"];
      ingestUserMessage?: boolean;
      turnId?: string;
      assistantMessageId?: string;
      capabilityProfileId?: string;
      capabilityProfileHash?: string;
      capabilityProfileContent?: string;
    },
  ): Promise<PreparedAgentChatTurn>;
  requireConnectorRecord(connectorId: string): ConnectorRecord;
  /**
   * Enqueue a `connector.delivery` durable run that routes an autonomous turn's
   * assistant reply to a channel. Implemented by the gateway (which can resolve
   * a connector from a channel key and call `createDurableRun`). Returns the
   * delivery run id, or undefined when no connector/channel could be resolved.
   */
  enqueueAutonomousChannelDelivery?(input: AutonomousChannelDeliveryRequest): string | undefined;
  /**
   * Remove a silent heartbeat turn (seed user message + `{notify:false}`
   * assistant message + its trace) from the human transcript, reverting the
   * active branch leaf. Implemented by the gateway (which owns branch-state +
   * transactional storage). Called only when a `kind:"heartbeat"` turn does not
   * notify, so heartbeats stay invisible unless they surface to the user.
   */
  cleanupSilentHeartbeatTurn?(input: SilentHeartbeatCleanupRequest): SilentHeartbeatCleanupResult;
  reconcileAutonomousChatPostCommit?(runId: string): Promise<boolean>;
  reconcileGeneralChatPostCommit?(runId: string): Promise<boolean>;
  executeGeneralChatPostCommitDurableEffect(
    input: GeneralChatPostCommitDurableEffectExecutionInput,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown> | void>;
  commsSend(input: ChannelSendInput): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsReply(input: ChannelReplyInput): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsReact(input: ChannelReactInput): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsUnsend(input: ChannelUnsendInput): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsTyping(input: ChannelTypingInput): Promise<ChannelTypingResult | Record<string, unknown>>;
  commsActivity(input: ChannelActivityInput): Promise<ChannelActivityResult | Record<string, unknown>>;
  invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse>;
  readonly approvalRemoteTokenSecrets: Pick<ApprovalRemoteTokenSecretService, "resolve" | "delete">;
  computeDurableRetryDelayMs(current: DurableRunRecord, attemptNo: number): number;
  resolveDurableRunHookWorkspaceId(run: DurableRunRecord): string;
  listChatSessionProactiveRuns(sessionId: string, limit?: number): ProactiveRunRecord[];
  recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
  ): void;
  recordImprovementDurableRunCompletion?(run: DurableRunRecord, checkpointState: Record<string, unknown>): void;
}

type HookDeliveryWorkflowPayload = {
  version: "hook.delivery.v1";
  hookRunId: string;
  hookId: string;
  workspaceId: string;
  trigger: HookTrigger;
  entityType: string;
  entityId: string;
};

type DurableWorkflowRecoverability = { recoverable: boolean; reason?: string };

export interface DurableWorkflowExecutionContext {
  signal?: AbortSignal;
}

export interface GeneralChatPostCommitEffectExecutionContext extends DurableWorkflowExecutionContext {
  effectRunId: string;
  parentRunId: string;
  generationId: string;
  leaseOwnerId: string;
}

export interface DurableWorkflowFinalizationContext {
  finalizationId: string;
  signal: AbortSignal;
}

export interface DurableWorkflowExecutor {
  execute(run: DurableRunRecord, context?: DurableWorkflowExecutionContext): Promise<void>;
  isRecoverable?(run: DurableRunRecord): DurableWorkflowRecoverability;
  markUnrecoverable?(
    run: DurableRunRecord,
    reason: string,
    context?: DurableWorkflowFinalizationContext,
  ): Promise<void> | void;
}

export interface DurableWorkflowExecutorRegistry {
  executeWorkflow(run: DurableRunRecord, context?: DurableWorkflowExecutionContext): Promise<void>;
  isWorkflowRecoverable(run: DurableRunRecord): DurableWorkflowRecoverability;
  markWorkflowUnrecoverable(
    run: DurableRunRecord,
    reason: string,
    context?: DurableWorkflowFinalizationContext,
  ): Promise<void>;
}

type DurableWorkflowCompletionHost = Pick<
  DurableExecutionHost,
  "storage" | "publishRealtime" | "recordDurableTimelineEvent" | "recordImprovementDurableRunCompletion"
>;

type DurableMemoryMaintenanceWorkflowHost = DurableWorkflowCompletionHost &
  Pick<DurableExecutionHost, "memoryLifecycleService">;

export type DurableChatTurnWorkflowHost = chatTurnDispatchService.ChatTurnDispatchHost &
  Pick<
    DurableExecutionHost,
    | "storage"
    | "prepareAgentChatTurn"
    | "registerActiveChatTurnStream"
    | "persistChatStreamChunk"
    | "enqueueAutonomousChannelDelivery"
    | "cleanupSilentHeartbeatTurn"
    | "reconcileAutonomousChatPostCommit"
    | "reconcileGeneralChatPostCommit"
  >;

export type DurableChatPostCommitEffectWorkflowPort = DurableWorkflowCompletionHost &
  Pick<DurableExecutionHost, "storage" | "executeGeneralChatPostCommitDurableEffect">;

type DurableProactiveTickWorkflowHost = Pick<
  DurableExecutionHost,
  "chatProactiveService" | "gatewaySql" | "isFeatureEnabled" | "listChatSessionProactiveRuns" | "publishRealtime"
>;

type DurableApprovalWaitWorkflowHost = DurableWorkflowCompletionHost & Pick<DurableExecutionHost, "storage">;

type DurableConnectorDeliveryWorkflowHost = DurableWorkflowCompletionHost &
  Pick<
    DurableExecutionHost,
    | "requireConnectorRecord"
    | "commsSend"
    | "commsReply"
    | "commsReact"
    | "commsUnsend"
    | "commsTyping"
    | "commsActivity"
    | "isFeatureEnabled"
    | "invokeMcpTool"
    | "approvalRemoteTokenSecrets"
    | "publishRealtime"
    | "resolveDurableRunHookWorkspaceId"
  >;

type DurableHookDeliveryWorkflowHost = DurableWorkflowCompletionHost &
  Pick<DurableExecutionHost, "hooksService" | "durableRunService" | "computeDurableRetryDelayMs">;

type DurableOrchestrationWorkflowHost = DurableWorkflowCompletionHost &
  Pick<DurableExecutionHost, "executeDurableOrchestrationRun" | "durableRunService">;

type DurableExternalSideEffectReplayWorkflowHost = DurableWorkflowCompletionHost & {
  storage: Pick<Storage, "durableRuns" | "externalSideEffectRuns">;
  buildExternalSideEffectReplayJob?(
    run: ExternalSideEffectRunRecord,
    payload: ExternalSideEffectReplayWorkflowPayload,
  ): IdempotentExternalSideEffectRunInput<Record<string, unknown>> | undefined;
};

type DurableCuratorTickWorkflowHost = DurableWorkflowCompletionHost & {
  curatorService: Pick<CuratorService, "executeDurableCuratorTickRun">;
};

export interface DurableWorkflowExecutorHosts {
  memoryMaintenance: DurableMemoryMaintenanceWorkflowHost;
  chatTurn: DurableChatTurnWorkflowHost;
  chatPostCommitEffect: DurableWorkflowExecutor;
  proactiveTick: DurableProactiveTickWorkflowHost;
  approvalWait: DurableApprovalWaitWorkflowHost;
  connectorDelivery: DurableConnectorDeliveryWorkflowHost;
  hookDelivery: DurableHookDeliveryWorkflowHost;
  orchestration: DurableOrchestrationWorkflowHost;
  externalSideEffectReplay: DurableExternalSideEffectReplayWorkflowHost;
  curatorTick: DurableCuratorTickWorkflowHost;
}

function buildConnectorDeliveryRealtimeLinks(input: {
  runId: string;
  connectorId: string;
  payload?: Record<string, unknown>;
}): NonNullable<RealtimeEvent["links"]> {
  const payload = input.payload ?? {};
  const nestedPayload =
    payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload)
      ? (payload.payload as Record<string, unknown>)
      : {};
  const readString = (key: keyof NonNullable<RealtimeEvent["links"]>) => {
    const value = nestedPayload[key] ?? payload[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };
  const sessionId = readString("sessionId");
  const turnId = readString("turnId");
  const proactiveRunId = readString("proactiveRunId");
  const approvalId = readString("approvalId") ?? readOptionalString(payload.correlationId);
  const taskId = readString("taskId");
  const workspaceId = readString("workspaceId");
  const messageId = readString("messageId");
  return {
    runId: input.runId,
    connectorId: input.connectorId,
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(proactiveRunId ? { proactiveRunId } : {}),
    ...(approvalId ? { approvalId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isAutonomyKillSwitchEnabled(host: { isFeatureEnabled?(feature: string): boolean }): boolean {
  return host.isFeatureEnabled?.("autonomyV1Disabled") === true;
}

function isAutonomousDurableRun(run: DurableRunRecord): boolean {
  if (run.workflowKey === "proactive.tick") {
    return true;
  }
  const metadata = run.metadata as Record<string, unknown> | undefined;
  const autonomous = metadata?.autonomous;
  return (
    autonomous === true ||
    (typeof autonomous === "object" && autonomous !== null) ||
    metadata?.deliveryKind === "autonomous.assistant_message"
  );
}

function assertAutonomousDurableRunAllowed(
  host: { isFeatureEnabled?(feature: string): boolean },
  run: DurableRunRecord,
): void {
  if (!isAutonomousDurableRun(run) || !isAutonomyKillSwitchEnabled(host)) {
    return;
  }
  const error = new Error(
    `Autonomous durable workflow ${run.workflowKey} (${run.runId}) is blocked while the autonomy kill switch is engaged (autonomyV1Disabled).`,
  );
  error.name = "AutonomousDurableRunDisabledError";
  throw error;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function buildDurableRealtimeOptions(input: {
  runId: string;
  approvalId?: string;
  connectorId?: string;
  proactiveRunId?: string;
  sessionId?: string;
  taskId?: string;
}): Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links"> {
  return {
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    links: {
      runId: input.runId,
      approvalId: input.approvalId,
      connectorId: input.connectorId,
      proactiveRunId: input.proactiveRunId,
      sessionId: input.sessionId,
      taskId: input.taskId,
    },
  };
}

// ---------- Pure payload parsers ----------

export type DurableChatTurnPayload = DurableChatTurnExecutionPayload & {
  routedContextSnapshotId?: string;
  routedContextSnapshotHash?: string;
};

export function parseDurableChatTurnPayload(run: DurableRunRecord): DurableChatTurnPayload | undefined {
  const payload = run.payload as Partial<DurableChatTurnPayload> | undefined;
  if (!payload || payload.version !== "chat.turn.execute.v1") {
    return undefined;
  }
  if (
    typeof payload.sessionId !== "string" ||
    typeof payload.turnId !== "string" ||
    typeof payload.userMessageId !== "string" ||
    typeof payload.assistantMessageId !== "string" ||
    typeof payload.branchKind !== "string" ||
    typeof payload.threadEventType !== "string" ||
    !payload.request ||
    typeof payload.request !== "object"
  ) {
    return undefined;
  }
  if (
    (payload.capabilityProfileId !== undefined && typeof payload.capabilityProfileId !== "string") ||
    (payload.capabilityProfileHash !== undefined && typeof payload.capabilityProfileHash !== "string") ||
    Boolean(payload.capabilityProfileId) !== Boolean(payload.capabilityProfileHash)
  ) {
    return undefined;
  }
  if (containsRawDurableRoutedContext(payload)) {
    return undefined;
  }
  if (
    (payload.routedContextSnapshotId !== undefined &&
      (typeof payload.routedContextSnapshotId !== "string" ||
        !payload.routedContextSnapshotId.trim() ||
        payload.routedContextSnapshotId.length > 256)) ||
    (payload.routedContextSnapshotHash !== undefined &&
      (typeof payload.routedContextSnapshotHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(payload.routedContextSnapshotHash))) ||
    Boolean(payload.routedContextSnapshotId) !== Boolean(payload.routedContextSnapshotHash) ||
    (Boolean(payload.routedContextSnapshotId) && !payload.capabilityProfileId)
  ) {
    return undefined;
  }
  return payload as DurableChatTurnPayload;
}

function containsRawDurableRoutedContext(value: unknown): boolean {
  const forbiddenKeys = new Set([
    "contextrefs",
    "routedcontext",
    "routedcontextsnapshot",
    "routedcontextsources",
    "resolvedroutedcontextsources",
    "routedcontextentries",
    "routedcontexttext",
    "admittedtext",
    "sourcecontent",
  ]);
  const visit = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }
    if (Array.isArray(candidate)) {
      return candidate.some(visit);
    }
    return Object.entries(candidate as Record<string, unknown>).some(
      ([key, nested]) => forbiddenKeys.has(key.toLowerCase()) || visit(nested),
    );
  };
  return visit(value);
}

export function parseGeneralChatPostCommitEffectWorkflowPayload(
  run: DurableRunRecord,
): GeneralChatPostCommitEffectWorkflowPayload | undefined {
  const payload = run.payload as Partial<GeneralChatPostCommitEffectWorkflowPayload> | undefined;
  if (
    !payload ||
    payload.version !== "chat.post_commit.effect.v1" ||
    typeof payload.parentRunId !== "string" ||
    !payload.parentRunId.trim() ||
    typeof payload.generationId !== "string" ||
    !payload.generationId.trim() ||
    typeof payload.traceStatus !== "string" ||
    !payload.input ||
    typeof payload.input !== "object" ||
    !isGeneralChatPostCommitDurableEffectInput(payload.input)
  ) {
    return undefined;
  }
  return payload as GeneralChatPostCommitEffectWorkflowPayload;
}

function isGeneralChatPostCommitDurableEffectInput(
  input: Record<string, unknown>,
): input is GeneralChatPostCommitDurableEffectInput {
  if (
    !readRequiredString(input.sessionId) ||
    !readRequiredString(input.workspaceId) ||
    !readRequiredString(input.turnId)
  ) {
    return false;
  }
  if (input.effect === "memory_maintenance") {
    return typeof input.delegatedChild === "boolean";
  }
  if (
    (input.effect !== "commitments" && input.effect !== "background_review") ||
    typeof input.autonomous !== "boolean"
  ) {
    return false;
  }
  return input.effect !== "background_review" || typeof input.delegatedChild === "boolean";
}

function readRequiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function buildDurableChatTurnResumeContent(
  baseContent: string,
  responses?: DurableChatTurnUserInputResumeRecord[],
): string {
  const normalizedBase = baseContent.trim();
  if (!responses || responses.length === 0) {
    return normalizedBase;
  }
  const entries = responses.map((response, index) => formatDurableChatTurnResumeEntry(response, index + 1));
  return `${normalizedBase}\n\nResume context from answered blocking prompts:\n${entries.join("\n\n")}`;
}

export function parseApprovalWaitWorkflowPayload(run: DurableRunRecord): ApprovalWaitWorkflowPayload | undefined {
  const payload = run.payload as Partial<ApprovalWaitWorkflowPayload> | undefined;
  if (!payload || payload.version !== "approval.wait.v1") {
    return undefined;
  }
  if (
    typeof payload.approvalId !== "string" ||
    typeof payload.approvalKind !== "string" ||
    typeof payload.createdAt !== "string"
  ) {
    return undefined;
  }
  return payload as ApprovalWaitWorkflowPayload;
}

export function parseProactiveTickWorkflowPayload(run: DurableRunRecord): ProactiveTickWorkflowPayload | undefined {
  const payload = run.payload as Partial<ProactiveTickWorkflowPayload> | undefined;
  if (!payload || payload.version !== "proactive.tick.v1") {
    return undefined;
  }
  if (
    typeof payload.sessionId !== "string" ||
    typeof payload.proactiveRunId !== "string" ||
    typeof payload.originSurface !== "string" ||
    typeof payload.triggerSource !== "string" ||
    typeof payload.requestedAt !== "string" ||
    !payload.policySnapshot ||
    typeof payload.policySnapshot !== "object"
  ) {
    return undefined;
  }
  return payload as ProactiveTickWorkflowPayload;
}

export function parseCuratorTickWorkflowPayload(run: DurableRunRecord): CuratorTickWorkflowPayload | undefined {
  const payload = run.payload as Partial<CuratorTickWorkflowPayload> | undefined;
  if (!payload || payload.version !== "curator.tick.v1") {
    return undefined;
  }
  if (typeof payload.runId !== "string" || payload.runId.length === 0) {
    return undefined;
  }
  if (payload.triggerMode !== "scheduled" && payload.triggerMode !== "manual") {
    return undefined;
  }
  if (typeof payload.cycleDays !== "number") {
    return undefined;
  }
  if (typeof payload.requestedAt !== "string") {
    return undefined;
  }
  return payload as CuratorTickWorkflowPayload;
}

export function parseConnectorDeliveryWorkflowPayload(
  run: DurableRunRecord,
): ConnectorDeliveryWorkflowPayload | undefined {
  const payload = run.payload as Partial<ConnectorDeliveryWorkflowPayload> | undefined;
  if (!payload || payload.version !== "connector.delivery.v1") {
    return undefined;
  }
  if (typeof payload.connectorId !== "string" || typeof payload.action !== "string") {
    return undefined;
  }
  if (payload.payload !== undefined && (typeof payload.payload !== "object" || Array.isArray(payload.payload))) {
    return undefined;
  }
  if (payload.approvalAction !== undefined) {
    const approvalAction = payload.approvalAction;
    if (
      !approvalAction ||
      typeof approvalAction !== "object" ||
      typeof approvalAction.tokenId !== "string" ||
      !approvalAction.tokenId.trim() ||
      typeof approvalAction.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(approvalAction.expiresAt))
    ) {
      return undefined;
    }
  }
  return payload as ConnectorDeliveryWorkflowPayload;
}

export function parseHookDeliveryWorkflowPayload(run: DurableRunRecord): HookDeliveryWorkflowPayload | undefined {
  const payload = run.payload as Partial<HookDeliveryWorkflowPayload> | undefined;
  if (!payload || payload.version !== "hook.delivery.v1") {
    return undefined;
  }
  if (
    typeof payload.hookRunId !== "string" ||
    typeof payload.hookId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.trigger !== "string" ||
    typeof payload.entityType !== "string" ||
    typeof payload.entityId !== "string"
  ) {
    return undefined;
  }
  return payload as HookDeliveryWorkflowPayload;
}

export function parseOrchestrationWorkflowPayload(run: DurableRunRecord): OrchestrationPlanWorkflowPayload | undefined {
  return parseOrchestrationLifecycleWorkflowPayload(run);
}

export function parseExternalSideEffectReplayWorkflowPayload(
  run: DurableRunRecord,
): ExternalSideEffectReplayWorkflowPayload | undefined {
  const payload = run.payload as Partial<ExternalSideEffectReplayWorkflowPayload> | undefined;
  if (!payload || payload.version !== "external_side_effect.replay.v1") {
    return undefined;
  }
  if (
    typeof payload.workspaceId !== "string" ||
    typeof payload.requestedBy !== "string" ||
    typeof payload.requestedAt !== "string"
  ) {
    return undefined;
  }
  if (payload.runIds !== undefined && !isStringArray(payload.runIds)) {
    return undefined;
  }
  if (payload.connectionId !== undefined && typeof payload.connectionId !== "string") {
    return undefined;
  }
  if (payload.limit !== undefined && (!Number.isInteger(payload.limit) || payload.limit <= 0)) {
    return undefined;
  }
  if (
    payload.staleClaimedNotSentAfterMs !== undefined &&
    (!Number.isInteger(payload.staleClaimedNotSentAfterMs) || payload.staleClaimedNotSentAfterMs < 0)
  ) {
    return undefined;
  }
  return payload as ExternalSideEffectReplayWorkflowPayload;
}

export function createDurableWorkflowExecutorRegistry(
  executors: Record<string, DurableWorkflowExecutor>,
): DurableWorkflowExecutorRegistry {
  const getExecutor = (run: DurableRunRecord): DurableWorkflowExecutor | undefined => executors[run.workflowKey];

  return {
    async executeWorkflow(run: DurableRunRecord, context?: DurableWorkflowExecutionContext): Promise<void> {
      const executor = getExecutor(run);
      if (!executor) {
        throw new Error(`Unsupported durable workflow: ${run.workflowKey}`);
      }
      await executor.execute(run, context);
    },

    isWorkflowRecoverable(run: DurableRunRecord): DurableWorkflowRecoverability {
      const executor = getExecutor(run);
      if (!executor) {
        return { recoverable: false, reason: `Unsupported durable workflow: ${run.workflowKey}` };
      }
      return executor.isRecoverable?.(run) ?? { recoverable: true };
    },

    async markWorkflowUnrecoverable(
      run: DurableRunRecord,
      reason: string,
      context?: DurableWorkflowFinalizationContext,
    ): Promise<void> {
      const executor = getExecutor(run);
      if (!executor) {
        return;
      }
      await executor.markUnrecoverable?.(run, reason, context);
    },
  };
}

export function createDeferredDurableWorkflowExecutorRegistry(
  resolveRegistry: () => DurableWorkflowExecutorRegistry,
): DurableWorkflowExecutorRegistry {
  return {
    executeWorkflow: (run, context) => resolveRegistry().executeWorkflow(run, context),
    isWorkflowRecoverable: (run) => resolveRegistry().isWorkflowRecoverable(run),
    markWorkflowUnrecoverable: (run, reason, context) =>
      resolveRegistry().markWorkflowUnrecoverable(run, reason, context),
  };
}

export function buildDurableWorkflowExecutors(
  hosts: DurableWorkflowExecutorHosts,
): Record<string, DurableWorkflowExecutor> {
  return {
    "memory.maintenance": {
      execute: async (run, context) => {
        throwIfDurableWorkflowAborted(context);
        completeDurableWorkflowRun(
          hosts.memoryMaintenance,
          run,
          await hosts.memoryMaintenance.memoryLifecycleService.executeMaintenanceDurableRun(run, context),
        );
      },
      isRecoverable: (run) =>
        hosts.memoryMaintenance.memoryLifecycleService.parseMaintenanceWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable memory maintenance payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason, context) => {
        throwIfDurableWorkflowAborted(context);
        hosts.memoryMaintenance.memoryLifecycleService.syncMaintenanceFromDurableRun(run);
        publishUnrecoverableProjectionSafely(hosts.memoryMaintenance, run, reason, { runId: run.runId }, context);
      },
    },
    "chat.turn.execute": {
      execute: (run, context) => executeDurableChatTurnRun(hosts.chatTurn, run, context),
      isRecoverable: (run) => isDurableChatTurnRecoverable(hosts.chatTurn, run),
      markUnrecoverable: (run, reason, context) =>
        markDurableChatTurnUnrecoverable(hosts.chatTurn, run, reason, context),
    },
    "chat.post_commit.effect": hosts.chatPostCommitEffect,
    "proactive.tick": {
      execute: (run, context) => {
        assertAutonomousDurableRunAllowed(hosts.proactiveTick, run);
        return hosts.proactiveTick.chatProactiveService.executeDurableProactiveTickRun(run, context);
      },
      isRecoverable: (run) =>
        parseProactiveTickWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable proactive tick payload is invalid or incomplete." },
      markUnrecoverable: (run, reason, context) =>
        markDurableProactiveTickUnrecoverable(hosts.proactiveTick, run, reason, context),
    },
    "curator.tick": {
      execute: async (run, context) => {
        await hosts.curatorTick.curatorService.executeDurableCuratorTickRun(run, context);
        completeDurableWorkflowRun(hosts.curatorTick, run, {
          workflow: "curator.tick",
          status: "completed",
          completedAt: new Date().toISOString(),
        });
      },
      isRecoverable: (run) =>
        parseCuratorTickWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable curator tick payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason, context) => {
        throwIfDurableWorkflowAborted(context);
        publishUnrecoverableProjectionSafely(hosts.curatorTick, run, reason, { runId: run.runId }, context);
      },
    },
    "approval.wait": {
      execute: (run, context) => executeDurableApprovalWaitRun(hosts.approvalWait, run, context),
      isRecoverable: (run) =>
        parseApprovalWaitWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable approval wait payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason, context) => {
        throwIfDurableWorkflowAborted(context);
        publishUnrecoverableProjectionSafely(
          hosts.approvalWait,
          run,
          reason,
          {
            runId: run.runId,
            approvalId: parseApprovalWaitWorkflowPayload(run)?.approvalId,
          },
          context,
        );
      },
    },
    "connector.delivery": {
      execute: (run, context) => executeDurableConnectorDeliveryRun(hosts.connectorDelivery, run, context),
      isRecoverable: (run) => isDurableConnectorDeliveryRecoverable(hosts.connectorDelivery, run),
      markUnrecoverable: (run, reason, context) =>
        markDurableConnectorDeliveryUnrecoverable(hosts.connectorDelivery, run, reason, context),
    },
    "hook.delivery": {
      execute: (run, context) => executeDurableHookDeliveryRun(hosts.hookDelivery, run, context),
      isRecoverable: (run) =>
        parseHookDeliveryWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable hook delivery payload is invalid or incomplete." },
      markUnrecoverable: (run, reason, context) =>
        markDurableHookDeliveryUnrecoverable(hosts.hookDelivery, run, reason, context),
    },
    "external_side_effect.replay": {
      execute: (run, context) =>
        executeDurableExternalSideEffectReplayRun(hosts.externalSideEffectReplay, run, context),
      isRecoverable: (run) =>
        parseExternalSideEffectReplayWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable external side-effect replay payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason, context) => {
        throwIfDurableWorkflowAborted(context);
        publishUnrecoverableProjectionSafely(
          hosts.externalSideEffectReplay,
          run,
          reason,
          { runId: run.runId },
          context,
        );
      },
    },
    "orchestration.plan.execute": {
      execute: async (run, context) => {
        const result = await hosts.orchestration.executeDurableOrchestrationRun(run, context);
        if (result.outcome === "failed") {
          failDurableWorkflowRun(hosts.orchestration, run, result.checkpointState);
          return;
        }
        if (result.outcome === "paused" || result.outcome === "cancelled") {
          return;
        }
        completeDurableWorkflowRun(hosts.orchestration, run, result.checkpointState);
      },
      isRecoverable: (run) =>
        parseOrchestrationWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable orchestration payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason, context) => {
        throwIfDurableWorkflowAborted(context);
        publishUnrecoverableProjectionSafely(hosts.orchestration, run, reason, { runId: run.runId }, context);
      },
    },
  };
}

function buildDurableWorkflowExecutorsFromExecutionHost(
  host: DurableExecutionHost,
): Record<string, DurableWorkflowExecutor> {
  return buildDurableWorkflowExecutors({
    memoryMaintenance: host,
    chatTurn: host,
    chatPostCommitEffect: createDurableChatPostCommitEffectWorkflowExecutor(host),
    proactiveTick: host,
    approvalWait: host,
    connectorDelivery: host,
    hookDelivery: host,
    orchestration: host,
    externalSideEffectReplay: host,
    curatorTick: {
      storage: host.storage,
      recordDurableTimelineEvent: (runId, eventType, payload) =>
        host.recordDurableTimelineEvent(runId, eventType, payload),
      recordImprovementDurableRunCompletion: (run, checkpointState) =>
        host.recordImprovementDurableRunCompletion?.(run, checkpointState),
      curatorService: {
        executeDurableCuratorTickRun: async () => {
          throw new Error("curator.tick not supported in this execution context");
        },
      },
      publishRealtime: () => undefined,
    },
  });
}

// ---------- Workflow execution helpers ----------

function completeDurableWorkflowRun(
  host: DurableWorkflowCompletionHost,
  run: DurableRunRecord,
  checkpointState: Record<string, unknown>,
): DurableRunRecord | undefined {
  const now = new Date().toISOString();
  const safeCheckpointState = redactStructuredSecrets(checkpointState).value;
  let completed: DurableRunRecord | undefined;
  runDurableCompletionTransaction(host, () => {
    const current = lockExpectedFreshExecutionLease(host, run);
    if (!current) {
      return;
    }
    completed = host.storage.durableRuns.updateRun({
      runId: run.runId,
      status: "completed",
      updatedAt: now,
      finishedAt: now,
      clearLease: true,
      clearLastError: true,
      expectedVersion: current.version,
    });
    host.storage.durableRuns.createCheckpoint({
      runId: run.runId,
      checkpointKind: "run_completed",
      state: safeCheckpointState,
      createdAt: now,
    });
    host.recordDurableTimelineEvent(run.runId, "run_completed", safeCheckpointState);
  });
  if (!completed) {
    return undefined;
  }
  publishDurableWorkflowProjectionSafely(host, run.runId, {
    type: "durable_run_completed",
    runId: run.runId,
    checkpoint: safeCheckpointState,
  });
  try {
    host.recordImprovementDurableRunCompletion?.(completed, safeCheckpointState);
  } catch {
    // Improvement analytics are downstream of the canonical terminal commit.
    return completed;
  }
  return completed;
}

function failDurableWorkflowRun(
  host: DurableWorkflowCompletionHost,
  run: DurableRunRecord,
  checkpointState: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  const safeCheckpointState = redactStructuredSecrets(checkpointState).value;
  const lastError =
    typeof safeCheckpointState.error === "string"
      ? safeCheckpointState.error
      : typeof safeCheckpointState.lastError === "string"
        ? safeCheckpointState.lastError
        : "Durable workflow failed.";
  let failed = false;
  runDurableCompletionTransaction(host, () => {
    const current = lockExpectedFreshExecutionLease(host, run);
    if (!current) {
      return;
    }
    host.storage.durableRuns.updateRun({
      runId: run.runId,
      status: "failed",
      updatedAt: now,
      finishedAt: now,
      clearLease: true,
      lastError,
      expectedVersion: current.version,
    });
    host.storage.durableRuns.createCheckpoint({
      runId: run.runId,
      checkpointKind: "run_failed",
      state: safeCheckpointState,
      createdAt: now,
    });
    host.recordDurableTimelineEvent(run.runId, "run_failed", safeCheckpointState);
    failed = true;
  });
  if (!failed) {
    return;
  }
  publishDurableWorkflowProjectionSafely(host, run.runId, {
    type: "durable_run_failed",
    runId: run.runId,
    checkpoint: safeCheckpointState,
    error: lastError,
  });
}

function lockExpectedFreshExecutionLease(
  host: DurableWorkflowCompletionHost,
  claimed: DurableRunRecord,
): DurableRunRecord | undefined {
  const expectedLeaseOwnerId = claimed.leaseOwnerId?.trim();
  if (!expectedLeaseOwnerId) {
    return undefined;
  }
  const durableRuns = host.storage.durableRuns;
  const lockFreshActiveLeaseForUpdate = durableRuns.lockFreshActiveLeaseForUpdate;
  if (typeof lockFreshActiveLeaseForUpdate === "function") {
    return lockFreshActiveLeaseForUpdate.call(durableRuns, claimed.runId, expectedLeaseOwnerId);
  }
  if (process.env.NODE_ENV === "test") {
    const current = durableRuns.getRun(claimed.runId);
    return current.status === "running" && current.leaseOwnerId === expectedLeaseOwnerId ? current : undefined;
  }
  throw new Error("Durable completion repository is missing the database-clock lease fence");
}

function publishDurableWorkflowProjectionSafely(
  host: Pick<DurableWorkflowCompletionHost, "publishRealtime">,
  runId: string,
  payload: Record<string, unknown>,
): void {
  try {
    host.publishRealtime("system", "durable", payload, buildDurableRealtimeOptions({ runId }));
  } catch {
    // Retained realtime is downstream of the atomic terminal transition.
    return;
  }
}

function runDurableCompletionTransaction<T>(host: DurableWorkflowCompletionHost, callback: () => T): T {
  const transactionOwner = host.storage as { runImmediateTransaction?: <R>(work: () => R) => R };
  if (transactionOwner.runImmediateTransaction) {
    return transactionOwner.runImmediateTransaction(callback);
  }
  if (process.env.NODE_ENV === "test") {
    return callback();
  }
  throw new Error("Durable completion host is missing immediate transaction ownership");
}

export async function executeDurableExternalSideEffectReplayRun(
  host: DurableExternalSideEffectReplayWorkflowHost,
  run: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<void> {
  throwIfDurableWorkflowAborted(context);
  const payload = parseExternalSideEffectReplayWorkflowPayload(run);
  if (!payload) {
    throw new Error("Durable external side-effect replay payload is invalid or incomplete.");
  }
  const checkedAt = new Date().toISOString();
  const replayCollection = collectExternalSideEffectReplayRuns(host, payload);
  const results = await runReplaySafeExternalSideEffectWorker<Record<string, unknown>>({
    runs: replayCollection.runs,
    checkedAt,
    limit: payload.limit,
    staleClaimedNotSentAfterMs: payload.staleClaimedNotSentAfterMs,
    buildJob: (candidate) => host.buildExternalSideEffectReplayJob?.(candidate, payload),
  });
  const replayAuditResults = [...replayCollection.auditResults, ...results.map(mapExternalSideEffectReplayResult)];
  const checkpointState = {
    workflow: "external_side_effect.replay",
    version: payload.version,
    workspaceId: payload.workspaceId,
    requestedBy: payload.requestedBy,
    checkedAt,
    requestedRunIds: replayCollection.requestedRunIds,
    candidates: replayCollection.runs.length,
    found: replayCollection.runs.length,
    missing: replayCollection.missingRunIds.length,
    missingRunIds: replayCollection.missingRunIds,
    skippedRunIds: replayCollection.skippedRunIds,
    executed: replayAuditResults.filter((item) => item.status === "executed").length,
    replayed: replayAuditResults.filter((item) => item.status === "executed").length,
    blocked: replayAuditResults.filter((item) => item.status === "blocked").length,
    failed: replayAuditResults.filter((item) => item.status === "failed").length,
    skipped: replayAuditResults.filter((item) => item.status === "skipped").length,
    replayAuditResults,
    results: replayAuditResults,
  };
  completeDurableWorkflowRun(host, run, checkpointState);
}

type ExternalSideEffectReplayAuditResult = {
  runId: string;
  status: "not_found" | "skipped" | "blocked" | "failed" | "executed";
  reason?: string;
  message?: string;
  replayOutcome?: string;
  replayAttempt?: string;
  resumeState?: string;
};

type ExternalSideEffectReplayRunCollection = {
  requestedRunIds: string[];
  runs: ExternalSideEffectRunRecord[];
  missingRunIds: string[];
  skippedRunIds: string[];
  auditResults: ExternalSideEffectReplayAuditResult[];
};

function collectExternalSideEffectReplayRuns(
  host: DurableExternalSideEffectReplayWorkflowHost,
  payload: ExternalSideEffectReplayWorkflowPayload,
): ExternalSideEffectReplayRunCollection {
  const limit = clampExternalSideEffectReplayLimit(payload.limit);
  const requestedRunIds = [...(payload.runIds ?? [])];
  const auditResults: ExternalSideEffectReplayAuditResult[] = [];
  const missingRunIds: string[] = [];
  const skippedRunIds: string[] = [];
  if (requestedRunIds.length > 0) {
    const uniqueRequestedRunIds: string[] = [];
    const seenRequestedRunIds = new Set<string>();
    for (const runId of requestedRunIds) {
      if (seenRequestedRunIds.has(runId)) {
        skippedRunIds.push(runId);
        auditResults.push({
          runId,
          status: "skipped",
          reason: "duplicate_requested_run",
          message: "Requested external side-effect run was already included in this replay workflow.",
        });
        continue;
      }
      seenRequestedRunIds.add(runId);
      uniqueRequestedRunIds.push(runId);
    }
    const scopedRuns: ExternalSideEffectRunRecord[] = [];
    for (const runId of uniqueRequestedRunIds) {
      const run = readExternalSideEffectRunMaybe(host, runId);
      if (!run) {
        missingRunIds.push(runId);
        auditResults.push({
          runId,
          status: "not_found",
          reason: "requested_run_missing",
          message: "Requested external side-effect run was not found.",
        });
        continue;
      }
      if (
        run.workspaceId !== payload.workspaceId ||
        (payload.connectionId && run.connectionId !== payload.connectionId)
      ) {
        skippedRunIds.push(runId);
        auditResults.push({
          runId,
          status: "skipped",
          reason: "out_of_scope",
          message: "Requested external side-effect run did not match replay scope.",
        });
        continue;
      }
      scopedRuns.push(run);
    }
    const runs = scopedRuns.slice(0, limit);
    for (const skipped of scopedRuns.slice(limit)) {
      skippedRunIds.push(skipped.runId);
      auditResults.push({
        runId: skipped.runId,
        status: "skipped",
        reason: "limit_exceeded",
        message: "Requested external side-effect run was beyond the replay limit.",
      });
    }
    return { requestedRunIds, runs, missingRunIds, skippedRunIds, auditResults };
  }
  const runs = payload.connectionId
    ? host.storage.externalSideEffectRuns.listByConnection(payload.connectionId, {
        workspaceId: payload.workspaceId,
        limit,
      })
    : host.storage.externalSideEffectRuns.listByWorkspace(payload.workspaceId, limit);
  return {
    requestedRunIds,
    runs: runs
      .filter((item) => item.workspaceId === payload.workspaceId)
      .filter((item) => !payload.connectionId || item.connectionId === payload.connectionId)
      .slice(0, limit),
    missingRunIds,
    skippedRunIds,
    auditResults,
  };
}

function mapExternalSideEffectReplayResult(
  item: ExternalSideEffectReplayWorkerResult<Record<string, unknown>>,
): ExternalSideEffectReplayAuditResult {
  if (item.status === "skipped") {
    return {
      runId: item.run.runId,
      status: "skipped",
      reason: item.reason,
      message: item.message,
    };
  }
  return {
    runId: item.run.runId,
    status: item.status,
    replayOutcome: item.result.claim.replayOutcome,
    replayAttempt: item.result.claim.replayAttempt,
    resumeState: item.result.claim.resumeState,
    ...(item.status === "blocked" ? { reason: item.result.blockedReason, message: item.result.message } : {}),
    ...(item.status === "failed" ? { message: item.result.error.message } : {}),
  };
}

function readExternalSideEffectRunMaybe(
  host: DurableExternalSideEffectReplayWorkflowHost,
  runId: string,
): ExternalSideEffectRunRecord | undefined {
  try {
    return host.storage.externalSideEffectRuns.get(runId);
  } catch {
    return undefined;
  }
}

function clampExternalSideEffectReplayLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || !limit || limit < 1) {
    return 50;
  }
  return Math.min(200, limit);
}

export async function executeDurableApprovalWaitRun(
  host: DurableApprovalWaitWorkflowHost,
  run: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<void> {
  throwIfDurableWorkflowAborted(context);
  const payload = parseApprovalWaitWorkflowPayload(run);
  if (!payload) {
    throw new Error("Durable approval wait payload is invalid or incomplete.");
  }
  const approval = host.storage.approvals.get(payload.approvalId);
  if (approval.status === "pending") {
    throw new ConflictError({
      message: `Approval ${payload.approvalId} is still pending and cannot complete its durable wait workflow.`,
    });
  }
  const checkpointState = {
    approvalId: approval.approvalId,
    approvalKind: approval.kind,
    status: approval.status,
    resolvedAt: approval.resolvedAt,
    resolvedBy: approval.resolvedBy,
  };
  await host.storage.audit.append("approvals", {
    event: "durable.approval_wait.complete",
    runId: run.runId,
    workflowKey: run.workflowKey,
    ...checkpointState,
  });
  completeDurableWorkflowRun(host, run, checkpointState);
}

export async function executeDurableConnectorDeliveryRun(
  host: DurableConnectorDeliveryWorkflowHost,
  run: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<void> {
  throwIfDurableWorkflowAborted(context);
  assertAutonomousDurableRunAllowed(host, run);
  const { approvalRemoteTokenSecrets, storage } = host;
  const payload = parseConnectorDeliveryWorkflowPayload(run);
  if (!payload) {
    throw new Error("Durable connector delivery payload is invalid or incomplete.");
  }
  const approvalActionTokenRef = payload.secretRefs?.approvalActionToken;
  const approvalAction = payload.approvalAction;
  if (
    approvalAction &&
    process.env.NODE_ENV === "test" &&
    typeof storage.remoteActionTokens?.findPendingFresh !== "function"
  ) {
    try {
      assertApprovalActionFreshForDelivery(host, payload, approvalActionTokenRef);
    } catch (error) {
      if (!(error instanceof ApprovalActionDeliveryUnavailableError)) {
        throw error;
      }
      failApprovalActionConnectorDelivery(host, run, payload, error);
      return;
    }
  }
  const connector = host.requireConnectorRecord(payload.connectorId);
  if (payload.simulateFailureReason?.trim()) {
    throw new Error(payload.simulateFailureReason.trim());
  }
  const operatorId = payload.operatorId ?? payload.authActorId ?? "system-durable";
  const hydratesBrowserApprovalBearer = connector.connectorType === "browser" && Boolean(approvalActionTokenRef);
  const deliveryEffectId = `connector-delivery:${run.runId}`;
  const workspaceId = payload.workspaceId ?? host.resolveDurableRunHookWorkspaceId(run);
  const sideEffect = await runIdempotentExternalSideEffect({
    mutationStore: storage.mutationIdempotency,
    sideEffectRunStore: storage.externalSideEffectRuns,
    runClaimTransaction: (work) => storage.runImmediateTransaction(work),
    workspaceId,
    boundary: "durable_connector_delivery",
    catalogId: `connector.${connector.connectorType}`,
    connectionId: connector.connectorId,
    actionId: payload.action,
    actorScope: workspaceId,
    idempotencyKey: `durable-connector:${run.runId}`,
    checkedAt: new Date().toISOString(),
    payload,
    label: `Durable connector delivery ${run.runId}`,
    output: { durableRunId: run.runId, connectorId: connector.connectorId, action: payload.action },
    requireDurableBoundaryRecord: true,
    isExternalCallProvenNotDispatched: isConnectorDeliveryExternalCallProvenNotDispatched,
    execute: (claim) => {
      const assertApprovalActionFresh = () =>
        assertApprovalActionFreshForDelivery(host, payload, approvalActionTokenRef);
      assertApprovalActionFresh();
      const markExternalCallStarted = () => {
        assertApprovalActionFresh();
        claim.markExternalCallStarted();
      };
      const dispatchPayload =
        hydratesBrowserApprovalBearer && approvalActionTokenRef
          ? hydrateBrowserApprovalRemoteTokenConnectorDeliveryPayload(
              payload,
              approvalRemoteTokenSecrets.resolve(approvalActionTokenRef),
            )
          : payload;
      return dispatchConnectorDelivery(connector, dispatchPayload, {
        commsSend: (input) => invokeConnectorDeliveryTransport(() => host.commsSend(input)),
        commsReply: (input) => invokeConnectorDeliveryTransport(() => host.commsReply(input)),
        commsReact: (input) => invokeConnectorDeliveryTransport(() => host.commsReact(input)),
        commsUnsend: (input) => invokeConnectorDeliveryTransport(() => host.commsUnsend(input)),
        commsTyping: (input) => invokeConnectorDeliveryTransport(() => host.commsTyping(input)),
        commsActivity: (input) => invokeConnectorDeliveryTransport(() => host.commsActivity(input)),
        invokeMcpTool: (input) => host.invokeMcpTool({ ...input, signal: context?.signal }),
        mcpInvokeContext: {
          workspaceId,
          taskId: payload.taskId,
          runId: payload.runId ?? run.runId,
          permissionProfileId: payload.permissionProfileId,
          localOperatorOverrideId: payload.localOperatorOverrideId,
          surface: normalizeDurableConnectorSurface(payload.originSurface) ?? "mcp",
          policyContext: {
            operatorId,
            authActorId: payload.authActorId,
            authActorSource: payload.authActorSource,
            workspaceId,
            sessionId: payload.sessionId,
            taskId: payload.taskId,
            runId: payload.runId ?? run.runId,
            surface: normalizeDurableConnectorSurface(payload.originSurface) ?? "mcp",
            permissionProfileId: payload.permissionProfileId,
            localOperatorOverrideId: payload.localOperatorOverrideId,
          },
          consentContext: {
            operatorId,
            source: "agent",
            reason: `durable connector delivery:${run.runId}`,
          },
        },
        publishRealtime: (eventType, source, eventPayload, options) => {
          host.publishRealtime(eventType, source, eventPayload, options);
        },
        markExternalCallStarted,
        deliveryEffectId,
        signal: context?.signal,
      });
    },
  });
  if (sideEffect.status === "failed") {
    if (sideEffect.error instanceof ApprovalActionDeliveryUnavailableError) {
      failApprovalActionConnectorDelivery(host, run, payload, sideEffect.error);
      return;
    }
    throw sideEffect.error;
  }
  if (sideEffect.status === "blocked") {
    const recorded = sideEffect.claim.sideEffectRunId
      ? storage.externalSideEffectRuns.get(sideEffect.claim.sideEffectRunId)
      : undefined;
    if (sideEffect.claim.replayOutcome !== "duplicate" && recorded?.status !== "completed") {
      throw new Error(sideEffect.message);
    }
    const checkpointState = {
      connectorId: connector.connectorId,
      connectorType: connector.connectorType,
      action: payload.action,
      deliveryStatus: "already_committed",
      sideEffectRunId: sideEffect.claim.sideEffectRunId,
      externalReferenceId: recorded?.externalReferenceId,
    };
    const completed = completeDurableWorkflowRun(host, run, checkpointState);
    if (completed && hydratesBrowserApprovalBearer && approvalActionTokenRef) {
      try {
        approvalRemoteTokenSecrets.delete(approvalActionTokenRef);
      } catch {
        // Canonical delivery and terminal state are already committed.
      }
    }
    publishConnectorDeliveryCompletedSafely(host, run, connector, payload, checkpointState);
    return;
  }
  const dispatch = sideEffect.value;
  const checkpointState = {
    connectorId: connector.connectorId,
    connectorType: connector.connectorType,
    action: payload.action,
    capabilityId: dispatch.capabilityId,
    dispatchKind: dispatch.dispatchKind,
    result: dispatch.result ?? null,
    sideEffectRunId: sideEffect.claim.sideEffectRunId,
  };
  const completed = completeDurableWorkflowRun(host, run, checkpointState);
  if (completed && hydratesBrowserApprovalBearer && approvalActionTokenRef) {
    try {
      approvalRemoteTokenSecrets.delete(approvalActionTokenRef);
    } catch {
      // The protected-token delivery and durable terminal state already committed.
    }
  }
  publishConnectorDeliveryCompletedSafely(host, run, connector, payload, checkpointState);
}

class ConnectorDeliveryDispatchFailureError extends Error {
  public constructor(
    message: string,
    public readonly deliveryStatus: string | undefined,
    public readonly providerMessageId: string | undefined,
    public readonly provenNotDispatched: boolean,
  ) {
    super(message);
    this.name = "ConnectorDeliveryDispatchFailureError";
  }
}

async function invokeConnectorDeliveryTransport<TValue>(invoke: () => Promise<TValue>): Promise<TValue> {
  const result = await invoke();
  const failure = readConnectorDeliveryTransportFailure(result);
  if (!failure) {
    return result;
  }
  throw new ConnectorDeliveryDispatchFailureError(
    failure.message,
    failure.deliveryStatus,
    failure.providerMessageId,
    failure.provenNotDispatched,
  );
}

function readConnectorDeliveryTransportFailure(value: unknown):
  | {
      message: string;
      deliveryStatus?: string;
      providerMessageId?: string;
      provenNotDispatched: boolean;
    }
  | undefined {
  const record = readUnknownRecord(value);
  if (!record) {
    return undefined;
  }
  const outcome = readTrimmedString(record.outcome);
  if (outcome && outcome !== "executed") {
    return {
      message: readTrimmedString(record.policyReason) ?? `Connector delivery returned ${outcome} before dispatch.`,
      deliveryStatus: "blocked",
      provenNotDispatched: true,
    };
  }
  if (outcome === "executed") {
    return readConnectorDeliveryTransportFailure(record.result);
  }
  if (readTrimmedString(record.status)?.toLowerCase() !== "failed") {
    return undefined;
  }
  const deliveryStatus = readTrimmedString(record.deliveryStatus)?.toLowerCase();
  const providerMessageId = readTrimmedString(record.providerMessageId);
  return {
    message:
      readTrimmedString(record.error) ?? readTrimmedString(record.fallbackReason) ?? "Connector delivery failed.",
    deliveryStatus,
    providerMessageId,
    provenNotDispatched: !providerMessageId && (deliveryStatus === "blocked" || deliveryStatus === "not_available"),
  };
}

function isConnectorDeliveryExternalCallProvenNotDispatched(error: unknown): boolean {
  if (error instanceof ConnectorDeliveryDispatchFailureError) {
    return error.provenNotDispatched;
  }
  const record = readUnknownRecord(error);
  if (!record || readTrimmedString(record.providerMessageId)) {
    return false;
  }
  const deliveryStatus = readTrimmedString(record.deliveryStatus)?.toLowerCase();
  return deliveryStatus === "blocked" || deliveryStatus === "not_available";
}

function readUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

class ApprovalActionDeliveryUnavailableError extends Error {
  public constructor(
    public readonly deliveryStatus: "expired" | "unavailable",
    public readonly secretCleanupPending: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalActionDeliveryUnavailableError";
  }
}

function assertApprovalActionFreshForDelivery(
  host: DurableConnectorDeliveryWorkflowHost,
  payload: ConnectorDeliveryWorkflowPayload,
  tokenRef: string | undefined,
): void {
  const approvalAction = payload.approvalAction;
  if (!approvalAction) {
    return;
  }
  const tokens = host.storage.remoteActionTokens;
  if (typeof tokens?.findPendingFresh !== "function") {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Remote action token repository is missing the database-clock freshness fence");
    }
    if (Date.parse(approvalAction.expiresAt) > Date.now()) {
      return;
    }
    let secretCleanupPending = false;
    if (tokenRef) {
      try {
        host.approvalRemoteTokenSecrets.delete(tokenRef);
      } catch {
        secretCleanupPending = true;
      }
    }
    if (!secretCleanupPending) {
      try {
        tokens?.expirePendingAtOrBefore(approvalAction.tokenId, new Date().toISOString());
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          throw error;
        }
      }
    }
    throw new ApprovalActionDeliveryUnavailableError(
      "expired",
      secretCleanupPending,
      "Approval remote-action delivery expired before dispatch.",
    );
  }

  const fresh = tokens.findPendingFresh(approvalAction.tokenId);
  if (fresh) {
    if (fresh.connectorId !== payload.connectorId) {
      throw new ApprovalActionDeliveryUnavailableError(
        "unavailable",
        false,
        "Approval remote-action delivery token is bound to a different connector.",
      );
    }
    return;
  }

  let current;
  try {
    current = tokens.get(approvalAction.tokenId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new ApprovalActionDeliveryUnavailableError(
        "unavailable",
        false,
        "Approval remote-action delivery token is unavailable before dispatch.",
      );
    }
    throw error;
  }
  let secretCleanupPending = false;
  if ((current.state === "pending" || current.state === "expired") && tokenRef) {
    try {
      host.approvalRemoteTokenSecrets.delete(tokenRef);
    } catch {
      secretCleanupPending = true;
    }
  }
  if (current.state === "pending" && !secretCleanupPending) {
    current = tokens.expirePendingIfExpired(current.tokenId);
  }
  const deliveryStatus = current.state === "expired" ? "expired" : "unavailable";
  throw new ApprovalActionDeliveryUnavailableError(
    deliveryStatus,
    secretCleanupPending,
    deliveryStatus === "expired"
      ? "Approval remote-action delivery expired before dispatch."
      : "Approval remote-action delivery token is no longer pending before dispatch.",
  );
}

function failApprovalActionConnectorDelivery(
  host: DurableConnectorDeliveryWorkflowHost,
  run: DurableRunRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  error: ApprovalActionDeliveryUnavailableError,
): void {
  const checkpointState = {
    connectorId: payload.connectorId,
    connectorType: payload.connectorType,
    action: payload.action,
    tokenId: payload.approvalAction?.tokenId,
    expiresAt: payload.approvalAction?.expiresAt,
    deliveryStatus: error.deliveryStatus,
    secretCleanupPending: error.secretCleanupPending,
    error: error.message,
  };
  failDurableWorkflowRun(host, run, checkpointState);
  try {
    host.publishRealtime(
      error.deliveryStatus === "expired" ? "connector_delivery_expired" : "connector_delivery_blocked",
      "connectors",
      { runId: run.runId, ...checkpointState },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: buildConnectorDeliveryRealtimeLinks({
          runId: run.runId,
          connectorId: payload.connectorId,
          payload: payload as unknown as Record<string, unknown>,
        }),
      },
    );
  } catch {
    // The durable failure/checkpoint is canonical; retained realtime is best-effort.
  }
}

function publishConnectorDeliveryCompletedSafely(
  host: Pick<DurableConnectorDeliveryWorkflowHost, "publishRealtime">,
  run: DurableRunRecord,
  connector: ConnectorRecord,
  payload: ConnectorDeliveryWorkflowPayload,
  checkpointState: Record<string, unknown>,
): void {
  try {
    host.publishRealtime(
      "connector_delivery_completed",
      "connectors",
      {
        runId: run.runId,
        ...checkpointState,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: buildConnectorDeliveryRealtimeLinks({
          runId: run.runId,
          connectorId: connector.connectorId,
          payload: payload as unknown as Record<string, unknown>,
        }),
      },
    );
  } catch {
    // The side-effect ledger and durable terminal state are authoritative.
    return;
  }
}

export async function executeDurableHookDeliveryRun(
  host: DurableHookDeliveryWorkflowHost,
  run: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<void> {
  throwIfDurableWorkflowAborted(context);
  const payload = parseHookDeliveryWorkflowPayload(run);
  if (!payload) {
    throw new Error("Durable hook delivery payload is invalid or incomplete.");
  }
  try {
    const delivered = await host.hooksService.executeHookDelivery(payload.hookRunId, run.attemptCount + 1, {
      signal: context?.signal,
    });
    completeDurableWorkflowRun(host, run, {
      hookRunId: delivered.runId,
      hookId: delivered.hookId,
      status: delivered.status,
      trigger: delivered.trigger,
    });
  } catch (error) {
    if (isDurableWorkflowAbortError(error, context)) {
      throw error;
    }
    const retry = host.durableRunService.scheduleRunningWorkflowRetry(
      run.runId,
      error instanceof Error ? error.message : "hook delivery failed",
      "hooks",
      run.leaseOwnerId,
    );
    if (retry.status === "queued") {
      const nextDelayMs = host.computeDurableRetryDelayMs(retry, retry.attemptCount);
      setTimeout(() => {
        host.durableRunService.requestRunProcessing(run.runId);
      }, nextDelayMs);
      return;
    }
    host.hooksService.markHookRunDeadLettered(
      payload.hookRunId,
      error instanceof Error ? error.message : "hook delivery failed",
    );
  }
}

export async function executeDurableChatTurnRun(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<void> {
  throwIfDurableWorkflowAborted(context);
  assertAutonomousDurableRunAllowed(host, run);
  const payload = parseDurableChatTurnPayload(run);
  if (!payload) {
    throw new Error("Durable chat run payload is invalid or incomplete.");
  }
  const userMessage = host.storage.chatMessages.get(payload.userMessageId);
  if (!userMessage) {
    throw new NotFoundError({ entity: "Chat message", id: payload.userMessageId });
  }
  const userMessageError = validateDurableChatLinkedUserMessage(userMessage, payload);
  if (userMessageError) {
    throw new Error(userMessageError);
  }
  const routedContextSnapshot = loadAndVerifyDurableChatRoutedContextSnapshot(host, run, payload);
  const recoveryTrace = validateCommittedDurableChatTurnRecoveryTrace(host, payload, run.runId, userMessage);
  if (recoveryTrace.outcome === "invalid") {
    throw new Error(recoveryTrace.reason);
  }
  const committedRecoveryTrace = recoveryTrace.outcome === "valid" ? recoveryTrace.trace : undefined;
  const resumedContent = buildDurableChatTurnResumeContent(userMessage.content, payload.userInputResponses);
  const resumedUserMessage =
    resumedContent === userMessage.content ? userMessage : { ...userMessage, content: resumedContent };
  const request = {
    ...payload.request,
    content: resumedContent,
    policyRunId: payload.request.policyRunId ?? run.runId,
    signal: context?.signal,
  };
  const capabilityProfileStore = host.storage.chatTurnCapabilityProfiles;
  if (payload.capabilityProfileId && !capabilityProfileStore) {
    throw new Error(`Durable Chat run ${run.runId} cannot load its bound capability profile.`);
  }
  const existingCapabilityProfile = payload.capabilityProfileId
    ? undefined
    : capabilityProfileStore?.findByTurn(payload.turnId);
  const prepared = await host.prepareAgentChatTurn(payload.sessionId, request, {
    branchKind: payload.branchKind,
    sourceTurnId: payload.sourceTurnId,
    parentTurnId: payload.parentTurnId,
    existingUserMessage: resumedUserMessage,
    ingestUserMessage: false,
    turnId: payload.turnId,
    assistantMessageId: payload.assistantMessageId,
    capabilityProfileId: payload.capabilityProfileId ?? existingCapabilityProfile?.profileId,
    capabilityProfileHash: payload.capabilityProfileHash ?? existingCapabilityProfile?.hashes.profileHash,
    capabilityProfileContent: userMessage.content,
  });
  assertDurableChatCapabilityProfileBinding(run.runId, payload, prepared);
  if (routedContextSnapshot) {
    injectFrozenDurableChatRoutedContext(prepared, routedContextSnapshot);
  }
  // Explicit legacy-only backfill: runs admitted before capability profiles
  // existed may receive one here. Newly admitted runs always carry payload
  // profile references and take the fail-closed branch above.
  if (prepared.capabilityProfile && !existingCapabilityProfile && !payload.capabilityProfileId) {
    if (!capabilityProfileStore || !host.storage.capabilityCatalogSnapshots) {
      throw new Error(`Durable Chat run ${run.runId} cannot persist its legacy capability profile backfill.`);
    }
    const { hashes: _hashes, ...draft } = prepared.capabilityProfile;
    const durableProfile = sealChatTurnCapabilityProfile({
      ...draft,
      identity: {
        ...draft.identity,
        durableRunId: run.runId,
      },
    });
    prepared.history = upsertChatCapabilityProfileSystemInstruction(prepared.history, durableProfile);
    if (!prepared.capabilityCatalogSnapshot) {
      throw new Error(`Durable Chat run ${run.runId} cannot bind its legacy profile without a catalog snapshot.`);
    }
    const catalogSnapshot = prepared.capabilityCatalogSnapshot;
    verifyChatTurnCapabilityCatalogBinding(durableProfile, catalogSnapshot);
    verifyChatTurnCapabilitySkillBindings(durableProfile, host.storage.skillLifecycle.list());
    host.storage.runImmediateTransaction(() => {
      prepared.capabilityCatalogSnapshot = host.storage.capabilityCatalogSnapshots.create(catalogSnapshot);
      prepared.capabilityProfile = capabilityProfileStore.create(durableProfile);
      host.storage.chatTurnTraces.patch(payload.turnId, {
        capabilitySnapshotId: durableProfile.catalog.snapshotId,
        capabilityProfileId: durableProfile.profileId,
        capabilityProfileHash: durableProfile.hashes.profileHash,
      });
    });
  }
  throwIfDurableWorkflowAborted(context);
  if (committedRecoveryTrace) {
    host.finalizeDurableChatRun(run.runId, prepared, committedRecoveryTrace, run.leaseOwnerId);
    const finalizedRun = host.storage.durableRuns.getRun(run.runId);
    const finalizedAsExpected = isDurableChatWaitingStatus(committedRecoveryTrace.status)
      ? finalizedRun.status === "waiting"
      : isDurableRunTerminal(finalizedRun.status);
    if (!finalizedAsExpected) {
      const error = new Error(
        `Durable Chat recovery for ${run.runId} could not commit ${committedRecoveryTrace.status} state under lease ${run.leaseOwnerId ?? "unknown"}.`,
      );
      error.name = "DurableWorkerInterruptionError";
      throw error;
    }
    await reconcileDurableChatPostCommit(host, finalizedRun, payload);
    return;
  }
  const continuation = isDurableChatStreamContinuation(run, payload);
  const streamRegistration = host.registerActiveChatTurnStream(
    payload.sessionId,
    payload.turnId,
    run.runId,
    continuation ? { continuation: true } : undefined,
  );
  await chatTurnDispatchService.executePreparedAgentChatTurnBackground(
    host,
    payload.sessionId,
    request,
    prepared,
    payload.threadEventType,
    run.runId,
    undefined,
    {
      streamRegistration,
      skipMessageStart: true,
      durableLeaseOwnerId: run.leaseOwnerId,
      ...(context?.signal ? { abortSignal: context.signal } : {}),
    },
  );
  await reconcileDurableChatPostCommit(host, run, payload);
}

export function loadAndVerifyDurableChatRoutedContextSnapshot(
  host: Pick<DurableChatTurnWorkflowHost, "storage">,
  run: DurableRunRecord,
  payload: DurableChatTurnPayload,
): ChatRoutedContextSnapshotRecord | undefined {
  if (!payload.routedContextSnapshotId || !payload.routedContextSnapshotHash) {
    return undefined;
  }
  const snapshotStore = host.storage.routedContextSnapshots;
  const profileStore = host.storage.chatTurnCapabilityProfiles;
  if (!snapshotStore || !profileStore || !payload.capabilityProfileId || !payload.capabilityProfileHash) {
    throw new Error(`Durable Chat run ${run.runId} cannot load its frozen routed-context binding.`);
  }
  const snapshot = snapshotStore.get(payload.routedContextSnapshotId);
  verifyChatRoutedContextSnapshot(snapshot);
  const profile = profileStore.get(payload.capabilityProfileId);
  const trace = host.storage.chatTurnTraces.get(payload.turnId);
  const traceBinding = trace?.routing?.routedContext;
  if (
    snapshot.snapshotId !== payload.routedContextSnapshotId ||
    snapshot.snapshotHash !== payload.routedContextSnapshotHash ||
    snapshot.turnId !== payload.turnId ||
    snapshot.sessionId !== payload.sessionId ||
    snapshot.capabilityProfileId !== payload.capabilityProfileId ||
    snapshot.capabilityProfileHash !== payload.capabilityProfileHash ||
    profile.profileId !== payload.capabilityProfileId ||
    profile.hashes.profileHash !== payload.capabilityProfileHash ||
    profile.identity.turnId !== payload.turnId ||
    profile.identity.sessionId !== payload.sessionId ||
    profile.identity.workspaceId !== snapshot.workspaceId ||
    profile.identity.durableRunId !== run.runId ||
    profile.selection.effectiveProviderId !== snapshot.budget.effectiveProviderId ||
    profile.selection.effectiveModel !== snapshot.budget.effectiveModel ||
    trace?.turnId !== payload.turnId ||
    trace.sessionId !== payload.sessionId ||
    trace.capabilityProfileId !== payload.capabilityProfileId ||
    trace.capabilityProfileHash !== payload.capabilityProfileHash ||
    trace.durable?.runId !== run.runId ||
    traceBinding?.snapshotId !== snapshot.snapshotId ||
    traceBinding.snapshotHash !== snapshot.snapshotHash ||
    traceBinding.sourceRequestHash !== snapshot.sourceRequestHash ||
    traceBinding.contentHash !== snapshot.contentHash
  ) {
    throw new Error(`Durable Chat run ${run.runId} has a mismatched frozen routed-context snapshot.`);
  }
  return snapshot;
}

export function injectFrozenDurableChatRoutedContext(
  prepared: PreparedAgentChatTurn,
  snapshot: ChatRoutedContextSnapshotRecord,
): void {
  verifyChatRoutedContextSnapshot(snapshot);
  if (
    prepared.routedContextSnapshot &&
    (prepared.routedContextSnapshot.snapshotId !== snapshot.snapshotId ||
      prepared.routedContextSnapshot.snapshotHash !== snapshot.snapshotHash)
  ) {
    throw new Error(`Durable Chat turn ${prepared.turnId} has a conflicting routed-context snapshot attachment.`);
  }
  prepared.routedContextSnapshot = snapshot;
  if (!snapshot.contextText) {
    return;
  }
  const marker = "Routed context snapshot (immutable).";
  const existing = prepared.history.filter(
    (message) => message.role === "system" && typeof message.content === "string" && message.content.startsWith(marker),
  );
  if (existing.length > 1 || (existing.length === 1 && existing[0]?.content !== snapshot.contextText)) {
    throw new Error(`Durable Chat turn ${prepared.turnId} has conflicting routed-context prompt state.`);
  }
  if (existing.length === 1) {
    return;
  }
  const insertionIndex = prepared.history.findIndex((message) => message.role !== "system");
  prepared.history.splice(insertionIndex < 0 ? prepared.history.length : insertionIndex, 0, {
    role: "system",
    content: snapshot.contextText,
  });
}

export function assertDurableChatCapabilityProfileBinding(
  runId: string,
  payload: { capabilityProfileId?: string; capabilityProfileHash?: string },
  prepared: Pick<PreparedAgentChatTurn, "capabilityProfile">,
): void {
  if (!payload.capabilityProfileId) {
    return;
  }
  if (
    !prepared.capabilityProfile ||
    prepared.capabilityProfile.profileId !== payload.capabilityProfileId ||
    prepared.capabilityProfile.hashes.profileHash !== payload.capabilityProfileHash ||
    prepared.capabilityProfile.identity.durableRunId !== runId
  ) {
    throw new Error(`Durable Chat run ${runId} has a malformed or missing bound capability profile.`);
  }
}

async function reconcileDurableChatPostCommit(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
  payload: DurableChatTurnExecutionPayload,
): Promise<void> {
  if (typeof host.reconcileGeneralChatPostCommit === "function") {
    await host.reconcileGeneralChatPostCommit(run.runId);
  }
  if (typeof host.reconcileAutonomousChatPostCommit === "function") {
    await host.reconcileAutonomousChatPostCommit(run.runId);
    return;
  }
  // Compatibility fallback for narrow hosts. Shipped Gateway hosts use the
  // durable marker reconciler so a crash cannot lose or duplicate delivery.
  maybeEnqueueAutonomousDelivery(host, run, payload);
  maybeCleanupSilentHeartbeatTurn(host, run, payload);
}

export function createDurableChatPostCommitEffectWorkflowExecutor(
  port: DurableChatPostCommitEffectWorkflowPort,
): DurableWorkflowExecutor {
  return {
    execute: (run, context) => executeGeneralChatPostCommitEffectRun(port, run, context),
    isRecoverable: (run) =>
      parseGeneralChatPostCommitEffectWorkflowPayload(run)
        ? { recoverable: true }
        : { recoverable: false, reason: "Durable Chat post-commit effect payload is invalid or incomplete." },
    markUnrecoverable: async (run, reason, context) => {
      throwIfDurableWorkflowAborted(context);
      const payload = parseGeneralChatPostCommitEffectWorkflowPayload(run);
      publishUnrecoverableProjectionSafely(
        port,
        run,
        reason,
        { runId: run.runId, sessionId: payload?.input.sessionId },
        context,
      );
    },
  };
}

async function executeGeneralChatPostCommitEffectRun(
  port: DurableChatPostCommitEffectWorkflowPort,
  run: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<void> {
  throwIfDurableWorkflowAborted(context);
  const payload = parseGeneralChatPostCommitEffectWorkflowPayload(run);
  if (!payload) {
    throw new Error(`Durable Chat post-commit effect payload is invalid for run ${run.runId}.`);
  }
  const provenance = assertGeneralChatPostCommitEffectProvenance(port, run, payload);
  const executionInput = hydrateGeneralChatPostCommitEffectInput(port, payload.input, provenance);
  if (!run.leaseOwnerId) {
    throw new Error(`Durable Chat post-commit effect ${run.runId} is missing its claimed lease owner.`);
  }
  const result = await port.executeGeneralChatPostCommitDurableEffect(executionInput, {
    effectRunId: run.runId,
    parentRunId: payload.parentRunId,
    generationId: payload.generationId,
    leaseOwnerId: run.leaseOwnerId,
    ...(context?.signal ? { signal: context.signal } : {}),
  });
  throwIfDurableWorkflowAborted(context);
  completeDurableWorkflowRun(port, run, {
    ...(result ?? {}),
    workflow: "chat.post_commit.effect",
    status: "completed",
    parentRunId: payload.parentRunId,
    generationId: payload.generationId,
    effect: payload.input.effect,
    workspaceId: payload.input.workspaceId,
    sessionId: payload.input.sessionId,
    turnId: payload.input.turnId,
    deliverySemantics: "at_least_once",
  });
}

function assertGeneralChatPostCommitEffectProvenance(
  port: DurableChatPostCommitEffectWorkflowPort,
  run: DurableRunRecord,
  payload: GeneralChatPostCommitEffectWorkflowPayload,
): { parentPayload: DurableChatTurnExecutionPayload; trace: ChatTurnTraceRecord } {
  const parent = port.storage.durableRuns.getRun(payload.parentRunId);
  const parentPayload = parseDurableChatTurnPayload(parent);
  if (
    !parentPayload ||
    parentPayload.sessionId !== payload.input.sessionId ||
    parentPayload.turnId !== payload.input.turnId
  ) {
    throw new Error(`Durable Chat post-commit effect ${run.runId} does not match its parent Chat provenance.`);
  }
  const pending = readGeneralChatPostCommitPendingMarker(parent);
  const completed = parent.metadata?.generalChatPostCommit as
    | {
        generationId?: unknown;
        durableEffectRunIds?: Record<string, unknown>;
      }
    | undefined;
  const linkedRunId =
    pending?.generationId === payload.generationId
      ? pending.durableEffectRunIds[payload.input.effect]
      : completed?.generationId === payload.generationId
        ? completed.durableEffectRunIds?.[payload.input.effect]
        : undefined;
  if (linkedRunId !== run.runId) {
    throw new Error(`Durable Chat post-commit effect ${run.runId} is not linked from its parent generation.`);
  }
  const trace = port.storage.chatTurnTraces.get(payload.input.turnId);
  const traceWorkspaceId = trace.guidance?.workspaceId?.trim() || "default";
  if (
    trace.sessionId !== payload.input.sessionId ||
    traceWorkspaceId !== payload.input.workspaceId ||
    run.metadata?.parentRunId !== payload.parentRunId ||
    run.metadata?.generationId !== payload.generationId ||
    run.metadata?.effect !== payload.input.effect ||
    run.metadata?.workspaceId !== payload.input.workspaceId ||
    run.metadata?.sessionId !== payload.input.sessionId ||
    run.metadata?.turnId !== payload.input.turnId
  ) {
    throw new Error(`Durable Chat post-commit effect ${run.runId} has inconsistent workspace/session/turn provenance.`);
  }
  return { parentPayload, trace };
}

function hydrateGeneralChatPostCommitEffectInput(
  port: DurableChatPostCommitEffectWorkflowPort,
  input: GeneralChatPostCommitDurableEffectInput,
  provenance: { parentPayload: DurableChatTurnExecutionPayload; trace: ChatTurnTraceRecord },
): GeneralChatPostCommitDurableEffectExecutionInput {
  if (input.effect === "memory_maintenance") {
    return input;
  }
  const userMessage = port.storage.chatMessages.get(provenance.parentPayload.userMessageId);
  const assistantMessage = provenance.trace.assistantMessageId
    ? port.storage.chatMessages.get(provenance.trace.assistantMessageId)
    : undefined;
  if (
    userMessage?.role !== "user" ||
    userMessage.sessionId !== input.sessionId ||
    assistantMessage?.role !== "assistant" ||
    assistantMessage.sessionId !== input.sessionId ||
    !assistantMessage.content.trim()
  ) {
    throw new Error(`Durable Chat post-commit ${input.effect} cannot hydrate its canonical user/assistant transcript.`);
  }
  return {
    ...input,
    userText: userMessage.content,
    assistantText: assistantMessage.content,
  };
}

export function executeGeneralChatPostCommit(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
  progress?: GeneralChatPostCommitProgress,
): Record<string, unknown> {
  const payload = parseDurableChatTurnPayload(run);
  if (!payload) {
    throw new Error("Durable chat run payload is invalid or incomplete.");
  }
  const userMessage = host.storage.chatMessages.get(payload.userMessageId);
  const recoveryTrace = validateCommittedDurableChatTurnRecoveryTrace(host, payload, run.runId, userMessage);
  if (recoveryTrace.outcome !== "valid") {
    throw new Error(
      recoveryTrace.outcome === "invalid"
        ? recoveryTrace.reason
        : `Durable Chat post-commit requires a committed resting trace ${payload.turnId}.`,
    );
  }
  const trace = recoveryTrace.trace;
  if (progress && trace.status !== progress.targetTraceStatus) {
    throw new Error(
      `Durable Chat post-commit generation ${progress.generationId} targets ${progress.targetTraceStatus}, but the canonical trace is ${trace.status}.`,
    );
  }
  const assistantMessageId = trace.assistantMessageId;
  const assistantMessage = assistantMessageId ? host.storage.chatMessages.get(assistantMessageId) : undefined;
  const toolRuns = host.storage.chatToolRuns.listByTurn(payload.turnId);
  const hydratedTrace: ChatTurnTraceRecord = { ...trace, toolRuns };
  const workspaceId = trace.guidance?.workspaceId?.trim() || "default";
  const autonomous = isAutonomousTurnRequest(payload.request);
  const hasTranscript = Boolean(
    isChatTurnTerminalStatus(trace.status) &&
    userMessage?.role === "user" &&
    assistantMessage?.role === "assistant" &&
    assistantMessage.content.trim().length > 0,
  );
  const delegatedChild = Boolean(userMessage?.parentDelegationStepId);
  const completed = trace.status === "completed";
  const transcriptCompleted = hasTranscript && completed;
  const runEffect = (
    effect: GeneralChatPostCommitEffect,
    applicable: boolean,
    callback: () => void,
  ): "reconciled" | "already_reconciled" | "not_applicable" => {
    if (!applicable) {
      if (progress) {
        progress.runEffect(effect, () => undefined);
      }
      return "not_applicable";
    }
    if (!progress) {
      callback();
      return "reconciled";
    }
    return progress.runEffect(effect, callback) ? "reconciled" : "already_reconciled";
  };
  const enqueueDurableEffect = (
    input: GeneralChatPostCommitDurableEffectInput,
    applicable: boolean,
    compatibilityCallback: () => void,
  ): "durably_enqueued" | "already_enqueued" | "not_applicable" | "reconciled" => {
    if (!applicable) {
      if (progress) {
        progress.runEffect(input.effect, () => undefined);
      }
      return "not_applicable";
    }
    if (!progress) {
      compatibilityCallback();
      return "reconciled";
    }
    return progress.enqueueDurableEffect(input) ? "durably_enqueued" : "already_enqueued";
  };

  const capabilityGap = runEffect("capability_gap", hasTranscript || trace.status === "waiting_for_approval", () => {
    host.recordCapabilityGapFromTrace({
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      content: userMessage!.content,
      trace: hydratedTrace,
    });
  });
  const learnedMemoryUser = runEffect("learned_memory_user", hasTranscript, () => {
    host.extractAndPersistLearnedMemory(payload.sessionId, userMessage!.content, {
      role: "user",
      sourceRef: userMessage!.messageId,
      trace: hydratedTrace,
    });
  });
  const learnedMemoryAssistant = runEffect("learned_memory_assistant", hasTranscript, () => {
    host.extractAndPersistLearnedMemory(payload.sessionId, assistantMessage!.content, {
      role: "assistant",
      sourceRef: assistantMessage!.messageId,
      trace: hydratedTrace,
    });
  });
  const commitmentsInput: GeneralChatPostCommitDurableEffectInput = {
    effect: "commitments",
    sessionId: payload.sessionId,
    workspaceId,
    turnId: payload.turnId,
    autonomous,
  };
  const commitments = enqueueDurableEffect(commitmentsInput, transcriptCompleted, () => {
    host.recordTurnCommitments({
      sessionId: payload.sessionId,
      workspaceId,
      userText: userMessage!.content,
      assistantText: assistantMessage!.content,
      autonomous,
    });
  });
  const backgroundReviewInput: GeneralChatPostCommitDurableEffectInput = {
    effect: "background_review",
    sessionId: payload.sessionId,
    workspaceId,
    turnId: payload.turnId,
    delegatedChild,
    autonomous,
  };
  const backgroundReview = enqueueDurableEffect(backgroundReviewInput, transcriptCompleted, () => {
    host.scheduleBackgroundReviewIfDue({
      sessionId: payload.sessionId,
      workspaceId,
      turnId: payload.turnId,
      userText: userMessage!.content,
      assistantText: assistantMessage!.content,
      delegatedChild,
      autonomous,
    });
  });
  const memoryMaintenanceInput: GeneralChatPostCommitDurableEffectInput = {
    effect: "memory_maintenance",
    sessionId: payload.sessionId,
    workspaceId,
    turnId: payload.turnId,
    delegatedChild,
  };
  const memoryMaintenance = enqueueDurableEffect(memoryMaintenanceInput, transcriptCompleted, () => {
    host.scheduleMemoryMaintenancePostTurnEvaluation({
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      delegatedChild,
    });
  });
  const memoryPrewarm = runEffect("memory_prewarm", hasTranscript, () => {
    host.scheduleChatMemoryContextPrewarm({
      sessionId: payload.sessionId,
      prompt: assistantMessage!.content,
      relationScope: "self",
    });
  });
  const realtimeApplicable = hasTranscript || isDurableChatWaitingStatus(trace.status);
  const publishThreadUpdate = () => {
    host.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: payload.threadEventType,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        activeLeafTurnId: payload.turnId,
        ...(progress
          ? {
              [IDEMPOTENT_REALTIME_ENVELOPE_KEY]: {
                deliveryId: `${run.runId}:${progress.generationId}:chat-thread-updated`,
                occurredAt: progress.requestedAt,
              },
            }
          : {}),
      },
      buildChatTurnRealtimeOptions({ sessionId: payload.sessionId, turnId: payload.turnId }),
    );
  };
  let realtime: "reconciled" | "already_reconciled" | "not_applicable";
  if (!realtimeApplicable) {
    progress?.runEffect("realtime", () => undefined);
    realtime = "not_applicable";
  } else if (!progress) {
    publishThreadUpdate();
    realtime = "reconciled";
  } else {
    realtime = progress.publishEffect("realtime", publishThreadUpdate) ? "reconciled" : "already_reconciled";
  }
  const agentEnd = runEffect("agent_end", true, () => {
    enqueueAgentEndHook(host, {
      workspaceId,
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      status: trace.status,
      toolRunCount: toolRuns.length,
      stream: true,
      repaired: Boolean(trace.completion?.repaired),
      runId: run.runId,
      taskId: trace.orchestration ? `chat-orchestration:${payload.turnId}` : undefined,
      approvalId: toolRuns.find((toolRun) => toolRun.approvalId)?.approvalId,
      providerId: trace.routing?.effectiveProviderId ?? trace.routing?.primaryProviderId,
      model: trace.routing?.effectiveModel ?? trace.model,
    });
  });

  return {
    turnId: payload.turnId,
    status: trace.status,
    agentEnd,
    learnedMemory: {
      user: learnedMemoryUser,
      assistant: learnedMemoryAssistant,
    },
    capabilityGap,
    realtime,
    commitments,
    memoryMaintenance,
    memoryPrewarm,
    backgroundReview,
  };
}

function isDurableChatStreamContinuation(run: DurableRunRecord, payload: DurableChatTurnExecutionPayload): boolean {
  if ((payload.userInputResponses?.length ?? 0) > 0 || run.attemptCount > 0) {
    return true;
  }
  // A fresh first claim writes startedAt and leaseHeartbeatAt from the same
  // timestamp. Resume, wake, and lease takeover retain the original startedAt
  // while installing a new lease heartbeat, giving us durable continuation
  // truth even after retained stream events have expired.
  return Boolean(run.startedAt && run.leaseHeartbeatAt && run.startedAt !== run.leaseHeartbeatAt);
}

/** Read the persisted assistant text for a completed durable chat turn, if any. */
function readDurableChatTurnAssistantText(
  host: DurableChatTurnWorkflowHost,
  payload: DurableChatTurnExecutionPayload,
): string | undefined {
  return readDurableChatTurnAssistantOutput(host, payload).assistantText;
}

function readAutonomousChatAssistantText(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
  payload: DurableChatTurnExecutionPayload,
): string | undefined {
  const durableOutput = typeof run.metadata?.outputText === "string" ? run.metadata.outputText.trim() : "";
  return durableOutput || readDurableChatTurnAssistantText(host, payload);
}

function readDurableChatTurnAssistantOutput(
  host: DurableChatTurnWorkflowHost,
  payload: DurableChatTurnExecutionPayload,
): { assistantText?: string; trace?: ChatTurnTraceRecord } {
  const trace = readDurableChatTurnTrace(host, payload.turnId);
  const assistantMessageId = trace?.assistantMessageId ?? payload.assistantMessageId;
  if (!assistantMessageId) {
    return { trace };
  }
  const content = host.storage.chatMessages.get(assistantMessageId)?.content?.trim();
  return { assistantText: content ? content : undefined, trace };
}

function readDurableChatTurnTrace(host: DurableChatTurnWorkflowHost, turnId: string): ChatTurnTraceRecord | undefined {
  try {
    return host.storage.chatTurnTraces.get(turnId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
    return undefined;
  }
}

type DurableChatRecoveryTraceValidation =
  | { outcome: "not_resting"; trace?: ChatTurnTraceRecord }
  | { outcome: "valid"; trace: ChatTurnTraceRecord }
  | { outcome: "invalid"; reason: string };

function validateCommittedDurableChatTurnRecoveryTrace(
  host: DurableChatTurnWorkflowHost,
  payload: DurableChatTurnExecutionPayload,
  expectedRunId: string,
  observedUserMessage?: { role?: unknown; sessionId?: unknown },
): DurableChatRecoveryTraceValidation {
  const trace = readDurableChatTurnTrace(host, payload.turnId);
  const userMessage = observedUserMessage ?? host.storage.chatMessages.get(payload.userMessageId);
  const userMessageError = validateDurableChatLinkedUserMessage(userMessage, payload);
  if (userMessageError) {
    return { outcome: "invalid", reason: userMessageError };
  }
  if (!trace) {
    return { outcome: "not_resting" };
  }
  if (trace.durable?.runId && trace.durable.runId !== expectedRunId) {
    return {
      outcome: "invalid",
      reason: "Persisted Chat trace does not match the current durable run linkage.",
    };
  }
  if (trace.sessionId !== payload.sessionId || trace.userMessageId !== payload.userMessageId) {
    return {
      outcome: "invalid",
      reason: "Persisted Chat resting trace does not match the durable run session/user linkage.",
    };
  }
  if (!isChatTurnTerminalStatus(trace.status) && !isDurableChatWaitingStatus(trace.status)) {
    return { outcome: "not_resting", trace };
  }
  if (trace.assistantMessageId && trace.assistantMessageId !== payload.assistantMessageId) {
    return {
      outcome: "invalid",
      reason: "Persisted assistant output does not match the durable Chat run linkage.",
    };
  }
  const assistantMessage = trace.assistantMessageId
    ? host.storage.chatMessages.get(trace.assistantMessageId)
    : undefined;
  if (assistantMessage && (assistantMessage.role !== "assistant" || assistantMessage.sessionId !== payload.sessionId)) {
    return {
      outcome: "invalid",
      reason: "Persisted assistant output does not match the durable Chat run linkage.",
    };
  }
  if (
    (trace.status === "completed" || trace.status === "partial") &&
    (!assistantMessage || trace.assistantMessageId !== payload.assistantMessageId)
  ) {
    return {
      outcome: "invalid",
      reason: "Completed durable Chat trace is missing its linked assistant output.",
    };
  }
  if (isDurableChatWaitingStatus(trace.status)) {
    const toolRuns = host.storage.chatToolRuns.listByTurn(payload.turnId);
    if (!hasDurableChatWaitingEvidence(trace, toolRuns)) {
      return {
        outcome: "invalid",
        reason: `Durable Chat trace ${payload.turnId} lacks canonical evidence for ${trace.status}.`,
      };
    }
  }
  return { outcome: "valid", trace };
}

function validateDurableChatLinkedUserMessage(
  userMessage: { role?: unknown; sessionId?: unknown } | undefined,
  payload: DurableChatTurnExecutionPayload,
): string | undefined {
  if (!userMessage) {
    return "Durable Chat recovery is missing its linked user message.";
  }
  if (userMessage.role !== "user" || userMessage.sessionId !== payload.sessionId) {
    return "Durable Chat recovery linked user message is not a user message in the payload session.";
  }
  return undefined;
}

function isDurableChatWaitingStatus(
  status: ChatTurnTraceRecord["status"],
): status is "waiting_for_approval" | "waiting_for_user_input" | "waiting_for_tool" {
  return status === "waiting_for_approval" || status === "waiting_for_user_input" || status === "waiting_for_tool";
}

function hasDurableChatWaitingEvidence(trace: ChatTurnTraceRecord, toolRuns: ChatTurnTraceRecord["toolRuns"]): boolean {
  if (trace.status === "waiting_for_user_input") {
    return Boolean(
      trace.pendingUserInput?.promptId?.trim() &&
      trace.pendingUserInput.turnId === trace.turnId &&
      trace.pendingUserInput.question?.trim(),
    );
  }
  if (trace.status === "waiting_for_approval") {
    return toolRuns.some(
      (toolRun) =>
        isDurableChatWaitToolRunLinked(toolRun, trace) &&
        toolRun.status === "approval_required" &&
        Boolean(toolRun.approvalId?.trim()),
    );
  }
  return toolRuns.some(
    (toolRun) => isDurableChatWaitToolRunLinked(toolRun, trace) && toolRun.status === "started" && !toolRun.finishedAt,
  );
}

function isDurableChatWaitToolRunLinked(
  toolRun: ChatTurnTraceRecord["toolRuns"][number],
  trace: ChatTurnTraceRecord,
): boolean {
  return toolRun.turnId === trace.turnId && toolRun.sessionId === trace.sessionId;
}

/**
 * Detect a structured `{ notify: boolean }` signal in an autonomous turn's
 * assistant output. Used by `deliverMode:"on_notify"` (cron) and — per the
 * shared convention — the heartbeat path: a turn is "silent" unless it opts in
 * by emitting `notify: true`. Absent/unparseable ⇒ no notify.
 *
 * Parsing is deliberately strict to avoid false-positive delivery from the word
 * "notify" appearing in prose or tool-call arguments:
 *  1. Parse the (trimmed) assistant text as JSON; honor only a top-level
 *     `notify === true` on an object.
 *  2. If that fails (the model wrapped the JSON in prose), fall back to a strict
 *     *quoted-key* match `"notify": true` — the JSON object shape, not bare
 *     `notify: true` / `notify=true` in prose.
 * The previous broad `\bnotify\s*[:=]\s*true` prose fallback is intentionally
 * dropped: it matched arbitrary prose and tool args and could mis-trigger
 * delivery of a silent turn.
 */
export function parseAutonomousNotifySignal(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>).notify === true;
    }
  } catch {
    // Not pure JSON — fall through to the strict quoted-key fallback below.
  }
  return /"notify"\s*:\s*true\b/.test(trimmed);
}

/**
 * After an autonomous (`metadata.autonomous`) chat turn completes, route its
 * assistant reply to the configured channel via a durable `connector.delivery`
 * run. Honors `deliverMode:"on_notify"` (deliver only when the output signals
 * `notify`). No-op for non-autonomous turns, missing channels, or empty output.
 */
export function maybeEnqueueAutonomousDelivery(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
  payload: DurableChatTurnExecutionPayload,
): string | undefined {
  if (!run.metadata?.autonomous) {
    return undefined;
  }
  const currentRun = readCurrentDurableRun(host, run);
  if (currentRun.status !== "completed" || !hasAutonomousChatPostCommitPending(currentRun)) {
    return undefined;
  }
  const autonomous = (currentRun.metadata as { autonomous?: AutonomousTurnMetadata } | undefined)?.autonomous;
  if (!autonomous || typeof autonomous !== "object") {
    return undefined;
  }
  const deliveryChannel = autonomous.deliveryChannel;
  if (!deliveryChannel?.channelKey || typeof host.enqueueAutonomousChannelDelivery !== "function") {
    return undefined;
  }
  const assistantText = readAutonomousChatAssistantText(host, currentRun, payload);
  if (!assistantText) {
    return undefined;
  }
  if (autonomous.deliverMode === "on_notify" && !parseAutonomousNotifySignal(assistantText)) {
    return undefined;
  }
  return host.enqueueAutonomousChannelDelivery({
    runId: currentRun.runId,
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    assistantText,
    deliveryChannel,
    systemActorId: autonomous.systemActorId,
    reason: autonomous.reason,
    commitmentId: autonomous.commitmentId,
  });
}

function readCurrentDurableRun(host: DurableChatTurnWorkflowHost, run: DurableRunRecord): DurableRunRecord {
  try {
    return host.storage.durableRuns.getRun(run.runId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  return run;
}

/**
 * After a heartbeat (`metadata.autonomous.kind:"heartbeat"`) chat turn completes,
 * keep it invisible in the user's transcript unless it notified. A heartbeat
 * runs inside the human session and persists a seed user message plus a
 * `{notify:false}` assistant message every interval; without cleanup the user
 * would see that noise on every tick. When the turn did NOT signal `notify`, the
 * gateway prunes both messages + the trace and reverts the branch leaf. No-op
 * for non-heartbeat turns, notifying heartbeats, or when no cleanup hook exists.
 */
export function maybeCleanupSilentHeartbeatTurn(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
  payload: DurableChatTurnExecutionPayload,
): SilentHeartbeatCleanupResult {
  if (!run.metadata?.autonomous) {
    return { status: "not_required" };
  }
  const currentRun = readCurrentDurableRun(host, run);
  if (currentRun.status !== "completed" || !hasAutonomousChatPostCommitPending(currentRun)) {
    return { status: "not_required" };
  }
  const autonomous = (currentRun.metadata as { autonomous?: AutonomousTurnMetadata } | undefined)?.autonomous;
  if (autonomous?.kind !== "heartbeat" || typeof host.cleanupSilentHeartbeatTurn !== "function") {
    return { status: "not_required" };
  }
  const assistantText = readAutonomousChatAssistantText(host, currentRun, payload);
  // Notifying heartbeats stay visible (the user is meant to see them). Only a
  // silent (no-notify / empty) heartbeat is pruned.
  if (assistantText && parseAutonomousNotifySignal(assistantText)) {
    return { status: "not_required" };
  }
  return host.cleanupSilentHeartbeatTurn({
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    userMessageId: payload.userMessageId,
    assistantMessageId: payload.assistantMessageId,
    ...(payload.parentTurnId ? { parentTurnId: payload.parentTurnId } : {}),
  });
}

export function executeAutonomousChatPostCommit(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Record<string, unknown> {
  throwIfDurableWorkflowAborted(context);
  const payload = parseDurableChatTurnPayload(run);
  if (!payload) {
    throw new Error(`Autonomous Chat post-commit recovery payload is invalid for run ${run.runId}.`);
  }
  const currentRun = readCurrentDurableRun(host, run);
  throwIfDurableWorkflowAborted(context);
  if (currentRun.status !== "completed" || !hasAutonomousChatPostCommitPending(currentRun)) {
    return {
      delivery: { status: "skipped", reason: "parent_not_pending" },
      heartbeatCleanup: { status: "not_required" },
    };
  }
  const autonomous = (currentRun.metadata as { autonomous?: AutonomousTurnMetadata } | undefined)?.autonomous;
  const assistantText = readAutonomousChatAssistantText(host, currentRun, payload);
  const hasDeliveryChannel = Boolean(autonomous?.deliveryChannel?.channelKey?.trim());
  const notifyRequested = Boolean(assistantText && parseAutonomousNotifySignal(assistantText));
  const deliveryIntended = Boolean(
    autonomous && hasDeliveryChannel && assistantText && (autonomous.deliverMode !== "on_notify" || notifyRequested),
  );
  throwIfDurableWorkflowAborted(context);
  const deliveryRunId = maybeEnqueueAutonomousDelivery(host, currentRun, payload);
  if (deliveryIntended && !deliveryRunId) {
    throw new Error(`Autonomous Chat delivery could not be durably enqueued for run ${run.runId}.`);
  }
  const cleanupRequired = autonomous?.kind === "heartbeat" && !notifyRequested;
  if (cleanupRequired && typeof host.cleanupSilentHeartbeatTurn !== "function") {
    throw new Error(`Silent heartbeat cleanup host is unavailable for run ${run.runId}.`);
  }
  throwIfDurableWorkflowAborted(context);
  const cleanup = maybeCleanupSilentHeartbeatTurn(host, run, payload);
  if (cleanup.status === "retryable_failure") {
    throw new Error(`Silent heartbeat cleanup did not commit for run ${run.runId}.`);
  }
  const skippedReason = !autonomous
    ? "not_autonomous"
    : !hasDeliveryChannel
      ? "delivery_not_configured"
      : !assistantText
        ? "empty_output"
        : "notify_not_requested";
  return {
    delivery: deliveryRunId
      ? { status: "enqueued", runId: deliveryRunId }
      : { status: "skipped", reason: skippedReason },
    heartbeatCleanup: cleanupRequired ? cleanup : { status: "not_required" },
  };
}

function isDurableChatTurnRecoverable(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
): { recoverable: boolean; reason?: string } {
  const payload = parseDurableChatTurnPayload(run);
  if (!payload) {
    return { recoverable: false, reason: "Durable chat run payload is invalid or incomplete." };
  }
  const recoveryTrace = validateCommittedDurableChatTurnRecoveryTrace(host, payload, run.runId);
  if (recoveryTrace.outcome === "valid") {
    return { recoverable: true };
  }
  if (recoveryTrace.outcome === "invalid") {
    return { recoverable: false, reason: recoveryTrace.reason };
  }
  const trace = recoveryTrace.trace;
  if (!trace) {
    return { recoverable: true };
  }
  const assistantMessage = trace.assistantMessageId
    ? host.storage.chatMessages.get(trace.assistantMessageId)
    : undefined;
  if (assistantMessage?.role === "assistant") {
    if (
      trace.sessionId !== payload.sessionId ||
      trace.userMessageId !== payload.userMessageId ||
      trace.assistantMessageId !== payload.assistantMessageId ||
      assistantMessage.sessionId !== payload.sessionId
    ) {
      return {
        recoverable: false,
        reason: "Persisted assistant output does not match the durable Chat run linkage.",
      };
    }
    if (isChatTurnTerminalStatus(trace.status)) {
      return { recoverable: true };
    }
    return {
      recoverable: false,
      reason: "Assistant output was persisted while the Chat turn trace was still active.",
    };
  }
  const toolRuns = host.storage.chatToolRuns.listByTurn(payload.turnId);
  if (toolRuns.length > 0) {
    return {
      recoverable: false,
      reason: "Durable chat run was interrupted after tool execution began and cannot be safely replayed.",
    };
  }
  return { recoverable: true };
}

function isDurableConnectorDeliveryRecoverable(
  host: DurableConnectorDeliveryWorkflowHost,
  run: DurableRunRecord,
): DurableWorkflowRecoverability {
  const payload = parseConnectorDeliveryWorkflowPayload(run);
  if (!payload) {
    return { recoverable: false, reason: "Durable connector delivery payload is invalid or incomplete." };
  }

  let sideEffect: ExternalSideEffectRunRecord | undefined;
  try {
    sideEffect = readDurableConnectorDeliverySideEffect(host, run, payload);
  } catch {
    return {
      recoverable: false,
      reason:
        "Connector delivery recovery could not establish external side-effect boundary truth; automatic replay is blocked pending manual reconciliation.",
    };
  }

  if (!sideEffect) {
    return { recoverable: true };
  }
  if (sideEffect.resumeState === "manual_review_unknown_external_outcome") {
    return connectorDeliveryManualReconciliationRequired(sideEffect);
  }
  switch (sideEffect.status) {
    case "claimed_not_sent":
    case "failed_before_boundary":
    case "completed":
    case "blocked_duplicate":
      return { recoverable: true };
    case "external_call_started":
    case "unknown_external_outcome":
      return connectorDeliveryManualReconciliationRequired(sideEffect);
    case "payload_mismatch":
      return {
        recoverable: false,
        reason: "Connector delivery external side-effect identity no longer matches; automatic replay is blocked.",
      };
    case "idempotency_unavailable":
      return {
        recoverable: false,
        reason: "Connector delivery lacked replay-safe idempotency; automatic replay is blocked.",
      };
  }
}

function readDurableConnectorDeliverySideEffect(
  host: DurableConnectorDeliveryWorkflowHost,
  run: DurableRunRecord,
  payload: ConnectorDeliveryWorkflowPayload,
): ExternalSideEffectRunRecord | undefined {
  const workspaceId = payload.workspaceId ?? host.resolveDurableRunHookWorkspaceId(run);
  const connector = host.requireConnectorRecord(payload.connectorId);
  const connectorTypes = new Set(
    [connector.connectorType, payload.connectorType?.trim()].filter((candidate): candidate is string =>
      Boolean(candidate),
    ),
  );
  for (const connectorType of connectorTypes) {
    const routePath = [
      "external_side_effect",
      "durable_connector_delivery",
      `connector.${connectorType}`,
      connector.connectorId,
      payload.action,
    ].join(":");
    const sideEffect = host.storage.externalSideEffectRuns.findByIdempotency(
      routePath,
      `durable-connector:${run.runId}`,
      workspaceId,
    );
    if (sideEffect) {
      return sideEffect;
    }
  }
  return undefined;
}

function connectorDeliveryManualReconciliationRequired(
  sideEffect: ExternalSideEffectRunRecord,
): DurableWorkflowRecoverability {
  return {
    recoverable: false,
    reason: `Connector delivery external side-effect ${sideEffect.runId} may have crossed the provider boundary; automatic replay is blocked and manual reconciliation is required.`,
  };
}

function markDurableConnectorDeliveryUnrecoverable(
  host: DurableConnectorDeliveryWorkflowHost,
  run: DurableRunRecord,
  reason: string,
  context?: DurableWorkflowFinalizationContext,
): void {
  throwIfDurableWorkflowAborted(context);
  const payload = parseConnectorDeliveryWorkflowPayload(run);
  if (payload) {
    try {
      const sideEffect = readDurableConnectorDeliverySideEffect(host, run, payload);
      if (sideEffect?.status === "external_call_started") {
        host.storage.externalSideEffectRuns.markFailureIfStatus(
          sideEffect.runId,
          "external_call_started",
          {
            status: "unknown_external_outcome",
            errorText: reason,
          },
          new Date().toISOString(),
        );
      }
    } catch (error) {
      void error;
      // Durable terminalization still proceeds. A failed effect-ledger CAS can
      // only make recovery more conservative; it never authorizes replay.
    }
  }
  publishUnrecoverableProjectionSafely(
    host,
    run,
    reason,
    {
      runId: run.runId,
      connectorId: payload?.connectorId,
    },
    context,
  );
}

function markDurableProactiveTickUnrecoverable(
  host: DurableProactiveTickWorkflowHost,
  run: DurableRunRecord,
  reason: string,
  context?: DurableWorkflowFinalizationContext,
): void {
  throwIfDurableWorkflowAborted(context);
  const payload = parseProactiveTickWorkflowPayload(run);
  if (payload) {
    const proactiveRun = host
      .listChatSessionProactiveRuns(payload.sessionId, 100)
      .find((candidate) => candidate.runId === payload.proactiveRunId);
    if (proactiveRun) {
      host.gatewaySql
        .prepare(
          `
        UPDATE proactive_runs
        SET
          status = 'failed',
          stop_reason = 'terminal_failure',
          error = @reason,
          finished_at = @finishedAt
        WHERE run_id = @runId
      `,
        )
        .run({
          runId: proactiveRun.runId,
          reason,
          finishedAt: new Date().toISOString(),
        });
    }
  }
  publishUnrecoverableProjectionSafely(
    host,
    run,
    reason,
    {
      runId: run.runId,
      proactiveRunId: payload?.proactiveRunId,
      sessionId: payload?.sessionId,
      taskId: payload?.taskId,
    },
    context,
  );
}

function markDurableHookDeliveryUnrecoverable(
  host: DurableHookDeliveryWorkflowHost,
  run: DurableRunRecord,
  reason: string,
  context?: DurableWorkflowFinalizationContext,
): void {
  throwIfDurableWorkflowAborted(context);
  const payload = parseHookDeliveryWorkflowPayload(run);
  if (payload) {
    host.hooksService.markHookRunDeadLettered(payload.hookRunId, reason);
  }
  publishUnrecoverableProjectionSafely(host, run, reason, { runId: run.runId }, context);
}

function markDurableChatTurnUnrecoverable(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
  reason: string,
  context?: DurableWorkflowFinalizationContext,
): void {
  throwIfDurableWorkflowAborted(context);
  const payload = parseDurableChatTurnPayload(run);
  if (!payload) {
    return;
  }
  const durableFailure = {
    runId: run.runId,
    status: "failed" as const,
    checkpointKind: "run_failed",
  };
  host.storage.runImmediateTransaction(() => {
    let trace: ChatTurnTraceRecord;
    try {
      trace = host.storage.chatTurnTraces.getForUpdate(payload.turnId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return;
      }
      throw error;
    }
    if (!matchesDurableChatTraceLink(trace, payload, run.runId)) {
      return;
    }
    if (!CHAT_TURN_ACTIVE_STATUSES.includes(trace.status as (typeof CHAT_TURN_ACTIVE_STATUSES)[number])) {
      host.storage.chatTurnTraces.patchIfStatus(payload.turnId, [trace.status], {
        durable: durableFailure,
      });
      return;
    }
    const failedTrace = host.storage.chatTurnTraces.patchIfStatus(payload.turnId, CHAT_TURN_ACTIVE_STATUSES, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      failure: {
        failureClass: "unknown",
        message: reason,
        retryable: true,
        recommendedAction: "retry",
      },
      completion: {
        finishReason: trace.completion?.finishReason,
        status: "interrupted",
        repaired: Boolean(trace.completion?.repaired),
      },
      durable: durableFailure,
    });
    if (!failedTrace) {
      const latestTrace = host.storage.chatTurnTraces.getForUpdate(payload.turnId);
      if (!matchesDurableChatTraceLink(latestTrace, payload, run.runId)) {
        return;
      }
      if (!CHAT_TURN_ACTIVE_STATUSES.includes(latestTrace.status as (typeof CHAT_TURN_ACTIVE_STATUSES)[number])) {
        host.storage.chatTurnTraces.patchIfStatus(payload.turnId, [latestTrace.status], {
          durable: durableFailure,
        });
      }
      return;
    }
    host.persistChatStreamChunk(
      {
        type: "error",
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        error: reason,
      },
      run.runId,
    );
  });
}

function matchesDurableChatTraceLink(
  trace: ChatTurnTraceRecord,
  payload: DurableChatTurnExecutionPayload,
  durableRunId: string,
): boolean {
  return (
    trace.turnId === payload.turnId &&
    trace.sessionId === payload.sessionId &&
    trace.userMessageId === payload.userMessageId &&
    (!trace.assistantMessageId || trace.assistantMessageId === payload.assistantMessageId) &&
    trace.durable?.runId === durableRunId
  );
}

function publishUnrecoverableProjectionSafely(
  host: Pick<DurableExecutionHost, "publishRealtime">,
  run: DurableRunRecord,
  reason: string,
  links: Parameters<typeof buildDurableRealtimeOptions>[0],
  context?: DurableWorkflowFinalizationContext,
): void {
  try {
    host.publishRealtime(
      "system",
      "durable",
      {
        type: "durable_workflow_unrecoverable",
        runId: run.runId,
        workflowKey: run.workflowKey,
        reason,
        ...(context ? { finalizationId: context.finalizationId } : {}),
      },
      buildDurableRealtimeOptions(links),
    );
  } catch {
    // Linked canonical state is authoritative; retained realtime is best-effort.
  }
}

function formatDurableChatTurnResumeEntry(response: DurableChatTurnUserInputResumeRecord, index: number): string {
  const lines = [
    `${index}. ${response.title?.trim() || response.question.trim()}`,
    `Question: ${response.question.trim()}`,
  ];
  if (response.response.kind === "single_select") {
    lines.push(`Answer: ${response.selectedOption?.label ?? response.response.optionId}`);
    if (response.selectedOption?.description?.trim()) {
      lines.push(`Option detail: ${response.selectedOption.description.trim()}`);
    }
  } else {
    lines.push(`Answer: ${response.response.text.trim()}`);
  }
  return lines.join("\n");
}

export async function executeDurableWorkflowRun(host: DurableExecutionHost, run: DurableRunRecord): Promise<void> {
  const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutorsFromExecutionHost(host));
  await registry.executeWorkflow(run);
}

export function isDurableWorkflowRecoverable(
  host: DurableExecutionHost,
  run: DurableRunRecord,
): DurableWorkflowRecoverability {
  const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutorsFromExecutionHost(host));
  return registry.isWorkflowRecoverable(run);
}

export async function markDurableWorkflowUnrecoverable(
  host: DurableExecutionHost,
  run: DurableRunRecord,
  reason: string,
  context?: DurableWorkflowFinalizationContext,
): Promise<void> {
  const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutorsFromExecutionHost(host));
  await registry.markWorkflowUnrecoverable(run, reason, context);
}

function throwIfDurableWorkflowAborted(context?: DurableWorkflowExecutionContext): void {
  if (!context?.signal?.aborted) {
    return;
  }
  const reason = context.signal.reason;
  throw reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Durable workflow aborted.");
}

function isDurableWorkflowAbortError(error: unknown, context?: DurableWorkflowExecutionContext): boolean {
  const signal = context?.signal;
  if (!signal?.aborted) {
    return false;
  }
  return (
    error === signal.reason || (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)))
  );
}

function normalizeDurableConnectorSurface(value: string | undefined): McpInvokeRequest["surface"] | undefined {
  return value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "tools" ||
    value === "mcp" ||
    value === "all"
    ? value
    : undefined;
}
