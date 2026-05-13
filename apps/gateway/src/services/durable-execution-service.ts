/**
 * Durable execution helpers and workflow registry.
 *
 * Durable run state stays with DurableRunService; workflow-specific execution
 * enters here through typed executor hosts.
 */

import {
  type ChannelSendInput,
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
  type DurableRunRecord,
  type DurableRunTimelineEvent,
  type HookTrigger,
  type OrchestrationPlanWorkflowPayload,
  type ProactiveTickWorkflowPayload,
  type ProactiveRunRecord,
  type RealtimeEvent,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { dispatchConnectorDelivery } from "./connector-delivery.js";
import type { ChatProactiveService } from "./chat-proactive-service.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { DurableChatTurnExecutionPayload, DurableChatTurnUserInputResumeRecord } from "./chat-turn-types.js";
import type { DurableRunService } from "./durable-run-service.js";
import type { HooksService } from "./hooks-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";

type DurableExecutionStorage = chatTurnDispatchService.ChatTurnDispatchHost["storage"] &
  Pick<Storage, "approvals" | "audit" | "chatMessages">;

export interface DurableExecutionHost extends chatTurnDispatchService.ChatTurnDispatchHost {
  readonly storage: DurableExecutionStorage;
  readonly gatewaySql: Storage["gatewaySql"];
  readonly durableRunService: Pick<DurableRunService, "retryDurableRun" | "requestRunProcessing">;
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
  ): Promise<{ outcome: "paused" | "completed" | "failed"; checkpointState: Record<string, unknown> }>;
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
  commsSend(input: ChannelSendInput): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsReply(input: ChannelReplyInput): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsReact(input: ChannelReactInput): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsUnsend(input: ChannelUnsendInput): Promise<ToolInvokeResult | Record<string, unknown>>;
  commsTyping(input: ChannelTypingInput): Promise<ChannelTypingResult | Record<string, unknown>>;
  invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse>;
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
    "storage" | "prepareAgentChatTurn" | "registerActiveChatTurnStream" | "persistChatStreamChunk"
  >;

type DurableProactiveTickWorkflowHost = Pick<
  DurableExecutionHost,
  "chatProactiveService" | "gatewaySql" | "listChatSessionProactiveRuns" | "publishRealtime"
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
    | "invokeMcpTool"
    | "publishRealtime"
  >;

type DurableHookDeliveryWorkflowHost = DurableWorkflowCompletionHost &
  Pick<DurableExecutionHost, "hooksService" | "durableRunService" | "computeDurableRetryDelayMs">;

type DurableOrchestrationWorkflowHost = DurableWorkflowCompletionHost &
  Pick<DurableExecutionHost, "executeDurableOrchestrationRun" | "durableRunService">;

export interface DurableWorkflowExecutorHosts {
  memoryMaintenance: DurableMemoryMaintenanceWorkflowHost;
  chatTurn: DurableChatTurnWorkflowHost;
  proactiveTick: DurableProactiveTickWorkflowHost;
  approvalWait: DurableApprovalWaitWorkflowHost;
  connectorDelivery: DurableConnectorDeliveryWorkflowHost;
  hookDelivery: DurableHookDeliveryWorkflowHost;
  orchestration: DurableOrchestrationWorkflowHost;
}

function buildConnectorDeliveryRealtimeLinks(input: {
  runId: string;
  connectorId: string;
  payload?: Record<string, unknown>;
}): NonNullable<RealtimeEvent["links"]> {
  const payload = input.payload ?? {};
  const readString = (key: keyof NonNullable<RealtimeEvent["links"]>) => {
    const value = payload[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };
  const sessionId = readString("sessionId");
  const turnId = readString("turnId");
  const proactiveRunId = readString("proactiveRunId");
  const approvalId = readString("approvalId");
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
  const payload = run.payload as Partial<OrchestrationPlanWorkflowPayload> | undefined;
  if (!payload || payload.version !== "orchestration.plan.execute.v1") {
    return undefined;
  }
  if (
    typeof payload.orchestrationRunId !== "string" ||
    typeof payload.planId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.requestedAt !== "string"
  ) {
    return undefined;
  }
  return payload as OrchestrationPlanWorkflowPayload;
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
      execute: (run, context) => hosts.proactiveTick.chatProactiveService.executeDurableProactiveTickRun(run, context),
      isRecoverable: (run) =>
        parseProactiveTickWorkflowPayload(run)
          ? { recoverable: true }
          : { recoverable: false, reason: "Durable proactive tick payload is invalid or incomplete." },
      markUnrecoverable: (run, reason) => markDurableProactiveTickUnrecoverable(hosts.proactiveTick, run, reason),
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
    "orchestration.plan.execute": {
      execute: async (run, context) => {
        const result = await hosts.orchestration.executeDurableOrchestrationRun(run, context);
        if (result.outcome === "paused" || result.outcome === "failed") {
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
  const payload = parseConnectorDeliveryWorkflowPayload(run);
  if (!payload) {
    throw new Error("Durable connector delivery payload is invalid or incomplete.");
  }
  const connector = host.requireConnectorRecord(payload.connectorId);
  if (payload.simulateFailureReason?.trim()) {
    throw new Error(payload.simulateFailureReason.trim());
  }
  const dispatch = await dispatchConnectorDelivery(connector, payload, {
    commsSend: (input) => host.commsSend(input),
    commsReply: (input) => host.commsReply(input),
    commsReact: (input) => host.commsReact(input),
    commsUnsend: (input) => host.commsUnsend(input),
    commsTyping: (input) => host.commsTyping(input),
    invokeMcpTool: (input) => host.invokeMcpTool({ ...input, signal: context?.signal }),
    publishRealtime: (eventType, source, eventPayload, options) =>
      host.publishRealtime(eventType, source, eventPayload, options),
    signal: context?.signal,
  });
  throwIfDurableWorkflowAborted(context);
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
        payload: payload.payload,
      }),
    },
  );
  completeDurableWorkflowRun(host, run.runId, checkpointState);
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
    const retry = host.durableRunService.retryDurableRun(
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
  host.registerActiveChatTurnStream(payload.sessionId, payload.turnId, run.runId);
  await chatTurnDispatchService.executePreparedAgentChatTurnBackground(
    host,
    payload.sessionId,
    request,
    prepared,
    payload.threadEventType,
    run.runId,
    undefined,
    { skipMessageStart: true },
  );
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
  if (trace.assistantMessageId) {
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
