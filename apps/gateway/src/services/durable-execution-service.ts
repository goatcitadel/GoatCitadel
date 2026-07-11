/* eslint-disable max-lines -- Durable execution helpers and workflow registry stay co-located so lease, recovery, and step replay stay traceable together. */
/**
 * Durable execution helpers and workflow registry.
 *
 * Durable run state stays with DurableRunService; workflow-specific execution
 * enters here through typed executor hosts.
 */

import {
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
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { ApprovalRemoteTokenSecretService } from "./approval-remote-token-secret.js";
import { dispatchConnectorDelivery } from "./connector-delivery.js";
import type { ChatProactiveService } from "./chat-proactive-service.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { DurableChatTurnExecutionPayload, DurableChatTurnUserInputResumeRecord } from "./chat-turn-types.js";
import type { CuratorService } from "./curator-service.js";
import { parseOrchestrationWorkflowPayload as parseOrchestrationLifecycleWorkflowPayload } from "./orchestration-lifecycle-state-helpers.js";
import type { DurableRunService } from "./durable-run-service.js";
import type { HooksService } from "./hooks-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import {
  type IdempotentExternalSideEffectRunInput,
  type ExternalSideEffectReplayWorkerResult,
  runReplaySafeExternalSideEffectWorker,
} from "./external-side-effect-runner-service.js";

type DurableExecutionStorage = chatTurnDispatchService.ChatTurnDispatchHost["storage"] &
  Pick<Storage, "approvals" | "audit" | "chatMessages" | "externalSideEffectRuns" | "remoteActionTokens">;

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
  cleanupSilentHeartbeatTurn?(input: SilentHeartbeatCleanupRequest): void;
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

export interface DurableWorkflowExecutor {
  execute(run: DurableRunRecord, context?: DurableWorkflowExecutionContext): Promise<void>;
  isRecoverable?(run: DurableRunRecord): DurableWorkflowRecoverability;
  markUnrecoverable?(run: DurableRunRecord, reason: string): Promise<void> | void;
}

export interface DurableWorkflowExecutorRegistry {
  executeWorkflow(run: DurableRunRecord, context?: DurableWorkflowExecutionContext): Promise<void>;
  isWorkflowRecoverable(run: DurableRunRecord): DurableWorkflowRecoverability;
  markWorkflowUnrecoverable(run: DurableRunRecord, reason: string): Promise<void>;
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
  >;

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

type DurableCuratorTickWorkflowHost = {
  curatorService: Pick<CuratorService, "executeDurableCuratorTickRun">;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => void;
};

export interface DurableWorkflowExecutorHosts {
  memoryMaintenance: DurableMemoryMaintenanceWorkflowHost;
  chatTurn: DurableChatTurnWorkflowHost;
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

export function parseDurableChatTurnPayload(run: DurableRunRecord): DurableChatTurnExecutionPayload | undefined {
  const payload = run.payload as Partial<DurableChatTurnExecutionPayload> | undefined;
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
  return payload as DurableChatTurnExecutionPayload;
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

    async markWorkflowUnrecoverable(run: DurableRunRecord, reason: string): Promise<void> {
      const executor = getExecutor(run);
      if (!executor) {
        return;
      }
      await executor.markUnrecoverable?.(run, reason);
    },
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
          run.runId,
          await hosts.memoryMaintenance.memoryLifecycleService.executeMaintenanceDurableRun(run, context),
        );
      },
      isRecoverable: (run) =>
        hosts.memoryMaintenance.memoryLifecycleService.parseMaintenanceWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable memory maintenance payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason) => {
        hosts.memoryMaintenance.memoryLifecycleService.syncMaintenanceFromDurableRun(run);
        hosts.memoryMaintenance.publishRealtime(
          "system",
          "durable",
          {
            type: "durable_workflow_unrecoverable",
            runId: run.runId,
            workflowKey: run.workflowKey,
            reason,
          },
          buildDurableRealtimeOptions({ runId: run.runId }),
        );
      },
    },
    "chat.turn.execute": {
      execute: (run, context) => executeDurableChatTurnRun(hosts.chatTurn, run, context),
      isRecoverable: (run) => isDurableChatTurnRecoverable(hosts.chatTurn, run),
      markUnrecoverable: (run, reason) => markDurableChatTurnUnrecoverable(hosts.chatTurn, run, reason),
    },
    "proactive.tick": {
      execute: (run, context) => {
        assertAutonomousDurableRunAllowed(hosts.proactiveTick, run);
        return hosts.proactiveTick.chatProactiveService.executeDurableProactiveTickRun(run, context);
      },
      isRecoverable: (run) =>
        parseProactiveTickWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable proactive tick payload is invalid or incomplete." },
      markUnrecoverable: (run, reason) => markDurableProactiveTickUnrecoverable(hosts.proactiveTick, run, reason),
    },
    "curator.tick": {
      execute: (run, context) => hosts.curatorTick.curatorService.executeDurableCuratorTickRun(run, context),
      isRecoverable: (run) =>
        parseCuratorTickWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable curator tick payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason) => {
        hosts.curatorTick.publishRealtime("system", "durable", {
          type: "durable_workflow_unrecoverable",
          runId: run.runId,
          workflowKey: run.workflowKey,
          reason,
        });
      },
    },
    "approval.wait": {
      execute: (run, context) => executeDurableApprovalWaitRun(hosts.approvalWait, run, context),
      isRecoverable: (run) =>
        parseApprovalWaitWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable approval wait payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason) => {
        hosts.approvalWait.publishRealtime(
          "system",
          "durable",
          {
            type: "durable_workflow_unrecoverable",
            runId: run.runId,
            workflowKey: run.workflowKey,
            reason,
          },
          buildDurableRealtimeOptions({
            runId: run.runId,
            approvalId: parseApprovalWaitWorkflowPayload(run)?.approvalId,
          }),
        );
      },
    },
    "connector.delivery": {
      execute: (run, context) => executeDurableConnectorDeliveryRun(hosts.connectorDelivery, run, context),
      isRecoverable: (run) =>
        parseConnectorDeliveryWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable connector delivery payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason) => {
        hosts.connectorDelivery.publishRealtime(
          "system",
          "durable",
          {
            type: "durable_workflow_unrecoverable",
            runId: run.runId,
            workflowKey: run.workflowKey,
            reason,
          },
          buildDurableRealtimeOptions({
            runId: run.runId,
            connectorId: parseConnectorDeliveryWorkflowPayload(run)?.connectorId,
          }),
        );
      },
    },
    "hook.delivery": {
      execute: (run, context) => executeDurableHookDeliveryRun(hosts.hookDelivery, run, context),
      isRecoverable: (run) =>
        parseHookDeliveryWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable hook delivery payload is invalid or incomplete." },
      markUnrecoverable: (run, reason) => markDurableHookDeliveryUnrecoverable(hosts.hookDelivery, run, reason),
    },
    "external_side_effect.replay": {
      execute: (run, context) =>
        executeDurableExternalSideEffectReplayRun(hosts.externalSideEffectReplay, run, context),
      isRecoverable: (run) =>
        parseExternalSideEffectReplayWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable external side-effect replay payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason) => {
        hosts.externalSideEffectReplay.publishRealtime(
          "system",
          "durable",
          {
            type: "durable_workflow_unrecoverable",
            runId: run.runId,
            workflowKey: run.workflowKey,
            reason,
          },
          buildDurableRealtimeOptions({
            runId: run.runId,
          }),
        );
      },
    },
    "orchestration.plan.execute": {
      execute: async (run, context) => {
        const result = await hosts.orchestration.executeDurableOrchestrationRun(run, context);
        if (result.outcome === "failed") {
          failDurableWorkflowRun(hosts.orchestration, run.runId, result.checkpointState);
          return;
        }
        if (result.outcome === "paused" || result.outcome === "cancelled") {
          return;
        }
        completeDurableWorkflowRun(hosts.orchestration, run.runId, result.checkpointState);
      },
      isRecoverable: (run) =>
        parseOrchestrationWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable orchestration payload is invalid or incomplete." },
      markUnrecoverable: async (run, reason) => {
        hosts.orchestration.publishRealtime(
          "system",
          "durable",
          {
            type: "durable_workflow_unrecoverable",
            runId: run.runId,
            workflowKey: run.workflowKey,
            reason,
          },
          buildDurableRealtimeOptions({
            runId: run.runId,
          }),
        );
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
    proactiveTick: host,
    approvalWait: host,
    connectorDelivery: host,
    hookDelivery: host,
    orchestration: host,
    externalSideEffectReplay: host,
    curatorTick: {
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
  runId: string,
  checkpointState: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  const current = host.storage.durableRuns.getRun(runId);
  if (!canCompleteCurrentDurableRunStatus(current.status)) {
    return;
  }
  host.storage.durableRuns.updateRun({
    runId,
    status: "completed",
    updatedAt: now,
    finishedAt: now,
    clearLease: true,
    clearLastError: true,
    expectedVersion: current.version,
  });
  host.storage.durableRuns.createCheckpoint({
    runId,
    checkpointKind: "run_completed",
    state: checkpointState,
    createdAt: now,
  });
  host.recordDurableTimelineEvent(runId, "run_completed", checkpointState);
  host.publishRealtime(
    "system",
    "durable",
    {
      type: "durable_run_completed",
      runId,
      checkpoint: checkpointState,
    },
    buildDurableRealtimeOptions({ runId }),
  );
  host.recordImprovementDurableRunCompletion?.(host.storage.durableRuns.getRun(runId), checkpointState);
}

function failDurableWorkflowRun(
  host: DurableWorkflowCompletionHost,
  runId: string,
  checkpointState: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  const current = host.storage.durableRuns.getRun(runId);
  if (!canCompleteCurrentDurableRunStatus(current.status)) {
    return;
  }
  const lastError =
    typeof checkpointState.error === "string"
      ? checkpointState.error
      : typeof checkpointState.lastError === "string"
        ? checkpointState.lastError
        : "Durable workflow failed.";
  host.storage.durableRuns.updateRun({
    runId,
    status: "failed",
    updatedAt: now,
    finishedAt: now,
    clearLease: true,
    lastError,
    expectedVersion: current.version,
  });
  host.storage.durableRuns.createCheckpoint({
    runId,
    checkpointKind: "run_failed",
    state: checkpointState,
    createdAt: now,
  });
  host.recordDurableTimelineEvent(runId, "run_failed", checkpointState);
  host.publishRealtime(
    "system",
    "durable",
    {
      type: "durable_run_failed",
      runId,
      checkpoint: checkpointState,
      error: lastError,
    },
    buildDurableRealtimeOptions({ runId }),
  );
}

function canCompleteCurrentDurableRunStatus(status: DurableRunRecord["status"]): boolean {
  return status === "queued" || status === "running";
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
  completeDurableWorkflowRun(host, run.runId, checkpointState);
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
  completeDurableWorkflowRun(host, run.runId, checkpointState);
}

export async function executeDurableConnectorDeliveryRun(
  host: DurableConnectorDeliveryWorkflowHost,
  run: DurableRunRecord,
  context?: DurableWorkflowExecutionContext,
): Promise<void> {
  throwIfDurableWorkflowAborted(context);
  assertAutonomousDurableRunAllowed(host, run);
  const { approvalRemoteTokenSecrets, publishRealtime, storage } = host;
  const payload = parseConnectorDeliveryWorkflowPayload(run);
  if (!payload) {
    throw new Error("Durable connector delivery payload is invalid or incomplete.");
  }
  const approvalActionTokenRef = payload.secretRefs?.approvalActionToken;
  const approvalAction = payload.approvalAction;
  if (approvalAction && Date.parse(approvalAction.expiresAt) <= Date.now()) {
    if (approvalActionTokenRef) {
      try {
        approvalRemoteTokenSecrets.delete(approvalActionTokenRef);
      } catch {
        // The terminal token state is authoritative. The approval expiry
        // worker will retry keychain cleanup by token id.
      }
    }
    try {
      storage.remoteActionTokens.expirePendingAtOrBefore(approvalAction.tokenId, new Date().toISOString());
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }
    const checkpointState = {
      connectorId: payload.connectorId,
      connectorType: payload.connectorType,
      action: payload.action,
      tokenId: approvalAction.tokenId,
      expiresAt: approvalAction.expiresAt,
      deliveryStatus: "expired",
      error: "Approval remote-action delivery expired before dispatch.",
    };
    publishRealtime(
      "connector_delivery_expired",
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
    failDurableWorkflowRun(host, run.runId, checkpointState);
    return;
  }
  const connector = host.requireConnectorRecord(payload.connectorId);
  if (payload.simulateFailureReason?.trim()) {
    throw new Error(payload.simulateFailureReason.trim());
  }
  const operatorId = payload.operatorId ?? payload.authActorId ?? "system-durable";
  const dispatchPayload =
    connector.connectorType === "browser" && approvalActionTokenRef
      ? hydrateBrowserApprovalActionToken(payload, approvalRemoteTokenSecrets.resolve(approvalActionTokenRef))
      : payload;
  const dispatch = await dispatchConnectorDelivery(connector, dispatchPayload, {
    commsSend: (input) => host.commsSend(input),
    commsReply: (input) => host.commsReply(input),
    commsReact: (input) => host.commsReact(input),
    commsUnsend: (input) => host.commsUnsend(input),
    commsTyping: (input) => host.commsTyping(input),
    commsActivity: (input) => host.commsActivity(input),
    invokeMcpTool: (input) => host.invokeMcpTool({ ...input, signal: context?.signal }),
    mcpInvokeContext: {
      workspaceId: payload.workspaceId ?? host.resolveDurableRunHookWorkspaceId(run),
      taskId: payload.taskId,
      runId: payload.runId ?? run.runId,
      permissionProfileId: payload.permissionProfileId,
      localOperatorOverrideId: payload.localOperatorOverrideId,
      surface: normalizeDurableConnectorSurface(payload.originSurface) ?? "mcp",
      policyContext: {
        operatorId,
        authActorId: payload.authActorId,
        authActorSource: payload.authActorSource,
        workspaceId: payload.workspaceId ?? host.resolveDurableRunHookWorkspaceId(run),
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
    publishRealtime: (eventType, source, eventPayload, options) =>
      host.publishRealtime(eventType, source, eventPayload, options),
    signal: context?.signal,
  });
  throwIfDurableWorkflowAborted(context);
  if (connector.connectorType === "browser" && approvalActionTokenRef) {
    try {
      approvalRemoteTokenSecrets.delete(approvalActionTokenRef);
    } catch {
      // The live-only browser delivery already completed; cleanup failure must
      // not cause a duplicate durable replay.
    }
  }
  const checkpointState = {
    connectorId: connector.connectorId,
    connectorType: connector.connectorType,
    action: payload.action,
    capabilityId: dispatch.capabilityId,
    dispatchKind: dispatch.dispatchKind,
    result: dispatch.result ?? null,
  };
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
  completeDurableWorkflowRun(host, run.runId, checkpointState);
}

function hydrateBrowserApprovalActionToken(
  payload: ConnectorDeliveryWorkflowPayload,
  token: string,
): ConnectorDeliveryWorkflowPayload {
  const actionPayload = payload.payload ?? {};
  const eventPayload =
    actionPayload.payload && typeof actionPayload.payload === "object" && !Array.isArray(actionPayload.payload)
      ? (actionPayload.payload as Record<string, unknown>)
      : {};
  return {
    ...payload,
    payload: {
      ...actionPayload,
      payload: {
        ...eventPayload,
        token,
      },
    },
  };
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
    throwIfDurableWorkflowAborted(context);
    completeDurableWorkflowRun(host, run.runId, {
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
  const resumedContent = buildDurableChatTurnResumeContent(userMessage.content, payload.userInputResponses);
  const resumedUserMessage =
    resumedContent === userMessage.content ? userMessage : { ...userMessage, content: resumedContent };
  const request = {
    ...payload.request,
    content: resumedContent,
    policyRunId: payload.request.policyRunId ?? run.runId,
    signal: context?.signal,
  };
  const prepared = await host.prepareAgentChatTurn(payload.sessionId, request, {
    branchKind: payload.branchKind,
    sourceTurnId: payload.sourceTurnId,
    parentTurnId: payload.parentTurnId,
    existingUserMessage: resumedUserMessage,
    ingestUserMessage: false,
    turnId: payload.turnId,
    assistantMessageId: payload.assistantMessageId,
  });
  throwIfDurableWorkflowAborted(context);
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
      ...(context?.signal ? { abortSignal: context.signal } : {}),
    },
  );
  maybeEnqueueAutonomousDelivery(host, run, payload);
  maybeCleanupSilentHeartbeatTurn(host, run, payload);
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

function readDurableChatTurnAssistantOutput(
  host: DurableChatTurnWorkflowHost,
  payload: DurableChatTurnExecutionPayload,
): { assistantText?: string; trace?: ChatTurnTraceRecord } {
  let trace: ChatTurnTraceRecord | undefined;
  try {
    trace = host.storage.chatTurnTraces.get(payload.turnId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  const assistantMessageId = trace?.assistantMessageId ?? payload.assistantMessageId;
  if (!assistantMessageId) {
    return { trace };
  }
  const content = host.storage.chatMessages.get(assistantMessageId)?.content?.trim();
  return { assistantText: content ? content : undefined, trace };
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
  const autonomous = (run.metadata as { autonomous?: AutonomousTurnMetadata } | undefined)?.autonomous;
  if (!autonomous || typeof autonomous !== "object") {
    return undefined;
  }
  if (isAutonomyKillSwitchEnabled(host)) {
    return undefined;
  }
  const deliveryChannel = autonomous.deliveryChannel;
  if (!deliveryChannel?.channelKey || typeof host.enqueueAutonomousChannelDelivery !== "function") {
    return undefined;
  }
  const { assistantText, trace } = readDurableChatTurnAssistantOutput(host, payload);
  if (trace?.status !== "completed") {
    return undefined;
  }
  if (isFailedAutonomousDeliveryRunStatus(readCurrentDurableRunStatus(host, run))) {
    return undefined;
  }
  if (!assistantText) {
    return undefined;
  }
  if (autonomous.deliverMode === "on_notify" && !parseAutonomousNotifySignal(assistantText)) {
    return undefined;
  }
  return host.enqueueAutonomousChannelDelivery({
    runId: run.runId,
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    assistantText,
    deliveryChannel,
    systemActorId: autonomous.systemActorId,
    reason: autonomous.reason,
    commitmentId: autonomous.commitmentId,
  });
}

function readCurrentDurableRunStatus(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
): DurableRunRecord["status"] {
  try {
    return host.storage.durableRuns.getRun(run.runId).status;
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  return run.status;
}

function isFailedAutonomousDeliveryRunStatus(status: DurableRunRecord["status"]): boolean {
  return status === "failed" || status === "cancelled" || status === "dead_lettered";
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
): void {
  const autonomous = (run.metadata as { autonomous?: AutonomousTurnMetadata } | undefined)?.autonomous;
  if (autonomous?.kind !== "heartbeat" || typeof host.cleanupSilentHeartbeatTurn !== "function") {
    return;
  }
  const assistantText = readDurableChatTurnAssistantText(host, payload);
  // Notifying heartbeats stay visible (the user is meant to see them). Only a
  // silent (no-notify / empty) heartbeat is pruned.
  if (assistantText && parseAutonomousNotifySignal(assistantText)) {
    return;
  }
  host.cleanupSilentHeartbeatTurn({
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    userMessageId: payload.userMessageId,
    assistantMessageId: payload.assistantMessageId,
    ...(payload.parentTurnId ? { parentTurnId: payload.parentTurnId } : {}),
  });
}

function isDurableChatTurnRecoverable(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
): { recoverable: boolean; reason?: string } {
  const payload = parseDurableChatTurnPayload(run);
  if (!payload) {
    return { recoverable: false, reason: "Durable chat run payload is invalid or incomplete." };
  }
  let trace: ChatTurnTraceRecord | undefined;
  try {
    trace = host.storage.chatTurnTraces.get(payload.turnId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  if (!trace) {
    return { recoverable: true };
  }
  const assistantMessage = trace.assistantMessageId
    ? host.storage.chatMessages.get(trace.assistantMessageId)
    : undefined;
  if (assistantMessage?.role === "assistant") {
    return { recoverable: false, reason: "Assistant output was already persisted before interruption." };
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

function markDurableProactiveTickUnrecoverable(
  host: DurableProactiveTickWorkflowHost,
  run: DurableRunRecord,
  reason: string,
): void {
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
  host.publishRealtime(
    "system",
    "durable",
    {
      type: "durable_workflow_unrecoverable",
      runId: run.runId,
      workflowKey: run.workflowKey,
      reason,
    },
    buildDurableRealtimeOptions({
      runId: run.runId,
      proactiveRunId: payload?.proactiveRunId,
      sessionId: payload?.sessionId,
      taskId: payload?.taskId,
    }),
  );
}

function markDurableHookDeliveryUnrecoverable(
  host: DurableHookDeliveryWorkflowHost,
  run: DurableRunRecord,
  reason: string,
): void {
  const payload = parseHookDeliveryWorkflowPayload(run);
  if (payload) {
    host.hooksService.markHookRunDeadLettered(payload.hookRunId, reason);
  }
  host.publishRealtime(
    "system",
    "durable",
    {
      type: "durable_workflow_unrecoverable",
      runId: run.runId,
      workflowKey: run.workflowKey,
      reason,
    },
    buildDurableRealtimeOptions({ runId: run.runId }),
  );
}

function markDurableChatTurnUnrecoverable(
  host: DurableChatTurnWorkflowHost,
  run: DurableRunRecord,
  reason: string,
): void {
  const payload = parseDurableChatTurnPayload(run);
  if (!payload) {
    return;
  }
  let trace: ChatTurnTraceRecord | undefined;
  try {
    trace = host.storage.chatTurnTraces.get(payload.turnId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  if (trace) {
    host.storage.chatTurnTraces.patch(payload.turnId, {
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
      durable: {
        runId: run.runId,
        status: "failed",
        checkpointKind: "run_failed",
      },
    });
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
): Promise<void> {
  const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutorsFromExecutionHost(host));
  await registry.markWorkflowUnrecoverable(run, reason);
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
