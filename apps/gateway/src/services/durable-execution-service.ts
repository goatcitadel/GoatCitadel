/**
 * Durable execution service.
 *
 * Body-move home for the durable-run / dead-letter / checkpoint public
 * surface previously living on GatewayService.
 *
 * Step 7 (initial pass) extracted the 13 public methods.
 * Step 7b (this pass) adds the 5 pure workflow payload parsers,
 * the 4 workflow executors (approval / connector / hook / chat-turn),
 * the workflow dispatcher, and the shared completeDurableWorkflowRun helper.
 */

import {
  ConflictError,
  NotFoundError,
  type ApprovalWaitWorkflowPayload,
  type ChatTurnTraceRecord,
  type ConnectorDeliveryWorkflowPayload,
  type DurableCheckpointRecord,
  type DurableDeadLetterRecord,
  type DurableDiagnosticsResponse,
  type DurableRunCreateRequest,
  type DurableRunRecord,
  type DurableRunTimelineEvent,
  type HookTrigger,
  type ProactiveTickWorkflowPayload,
} from "@goatcitadel/contracts";
import { dispatchConnectorDelivery } from "./connector-delivery.js";
import * as chatTurnDispatchService from "./chat-turn-dispatch-service.js";
import type { DurableChatTurnExecutionPayload, GatewayService } from "./gateway-service.js";

export type DurableExecutionHost = GatewayService;

type HookDeliveryWorkflowPayload = {
  version: "hook.delivery.v1";
  hookRunId: string;
  hookId: string;
  workspaceId: string;
  trigger: HookTrigger;
  entityType: string;
  entityId: string;
};

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

// ---------- Workflow execution helpers ----------

function completeDurableWorkflowRun(
  host: DurableExecutionHost,
  runId: string,
  checkpointState: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  host.storage.durableRuns.updateRun({
    runId,
    status: "completed",
    updatedAt: now,
    finishedAt: now,
    lastError: undefined,
  });
  host.storage.durableRuns.createCheckpoint({
    runId,
    checkpointKind: "run_completed",
    state: checkpointState,
    createdAt: now,
  });
  host.recordDurableTimelineEvent(runId, "run_completed", checkpointState);
  host.publishRealtime("system", "durable", {
    type: "durable_run_completed",
    runId,
    checkpoint: checkpointState,
  });
}

export async function executeDurableApprovalWaitRun(host: DurableExecutionHost, run: DurableRunRecord): Promise<void> {
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
  host: DurableExecutionHost,
  run: DurableRunRecord,
): Promise<void> {
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
    invokeMcpTool: (input) => host.invokeMcpTool(input),
    publishRealtime: (eventType, source, eventPayload) => host.publishRealtime(eventType, source, eventPayload),
  });
  const checkpointState = {
    connectorId: connector.connectorId,
    connectorType: connector.connectorType,
    action: payload.action,
    capabilityId: dispatch.capabilityId,
    dispatchKind: dispatch.dispatchKind,
    result: dispatch.result ?? null,
  };
  host.publishRealtime("connector_delivery_completed", "connectors", {
    runId: run.runId,
    ...checkpointState,
  });
  completeDurableWorkflowRun(host, run.runId, checkpointState);
}

export async function executeDurableHookDeliveryRun(host: DurableExecutionHost, run: DurableRunRecord): Promise<void> {
  const payload = parseHookDeliveryWorkflowPayload(run);
  if (!payload) {
    throw new Error("Durable hook delivery payload is invalid or incomplete.");
  }
  try {
    const delivered = await host.hooksService.executeHookDelivery(payload.hookRunId, run.attemptCount + 1);
    completeDurableWorkflowRun(host, run.runId, {
      hookRunId: delivered.runId,
      hookId: delivered.hookId,
      status: delivered.status,
      trigger: delivered.trigger,
    });
  } catch (error) {
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

export async function executeDurableChatTurnRun(host: DurableExecutionHost, run: DurableRunRecord): Promise<void> {
  const payload = parseDurableChatTurnPayload(run);
  if (!payload) {
    throw new Error("Durable chat run payload is invalid or incomplete.");
  }
  const userMessage = host.storage.chatMessages.get(payload.userMessageId);
  if (!userMessage) {
    throw new NotFoundError({ entity: "Chat message", id: payload.userMessageId });
  }
  const prepared = await host.prepareAgentChatTurn(payload.sessionId, payload.request, {
    branchKind: payload.branchKind,
    sourceTurnId: payload.sourceTurnId,
    parentTurnId: payload.parentTurnId,
    existingUserMessage: userMessage,
    ingestUserMessage: false,
    turnId: payload.turnId,
    assistantMessageId: payload.assistantMessageId,
  });
  host.registerActiveChatTurnStream(payload.sessionId, payload.turnId, run.runId);
  await chatTurnDispatchService.executePreparedAgentChatTurnBackground(
    host,
    payload.sessionId,
    payload.request,
    prepared,
    payload.threadEventType,
    run.runId,
    undefined,
    { skipMessageStart: true },
  );
}

export function isDurableWorkflowRecoverable(
  host: DurableExecutionHost,
  run: DurableRunRecord,
): { recoverable: boolean; reason?: string } {
  switch (run.workflowKey) {
    case "memory.maintenance":
      return host.memoryMaintenanceService.parseWorkflowPayload(run)
        ? { recoverable: true }
        : { recoverable: false, reason: "Durable memory maintenance payload is invalid or incomplete." };
    case "chat.turn.execute":
      break;
    case "proactive.tick":
      return parseProactiveTickWorkflowPayload(run)
        ? { recoverable: true }
        : { recoverable: false, reason: "Durable proactive tick payload is invalid or incomplete." };
    case "approval.wait":
      return parseApprovalWaitWorkflowPayload(run)
        ? { recoverable: true }
        : { recoverable: false, reason: "Durable approval wait payload is invalid or incomplete." };
    case "connector.delivery":
      return parseConnectorDeliveryWorkflowPayload(run)
        ? { recoverable: true }
        : { recoverable: false, reason: "Durable connector delivery payload is invalid or incomplete." };
    case "hook.delivery":
      return parseHookDeliveryWorkflowPayload(run)
        ? { recoverable: true }
        : { recoverable: false, reason: "Durable hook delivery payload is invalid or incomplete." };
    default:
      return { recoverable: false, reason: `Unsupported durable workflow: ${run.workflowKey}` };
  }
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

export async function markDurableWorkflowUnrecoverable(
  host: DurableExecutionHost,
  run: DurableRunRecord,
  reason: string,
): Promise<void> {
  if (run.workflowKey === "memory.maintenance") {
    host.memoryMaintenanceService.syncFromDurableRun(run);
    host.publishRealtime("system", "durable", {
      type: "durable_workflow_unrecoverable",
      runId: run.runId,
      workflowKey: run.workflowKey,
      reason,
    });
    return;
  }
  if (run.workflowKey === "proactive.tick") {
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
    host.publishRealtime("system", "durable", {
      type: "durable_workflow_unrecoverable",
      runId: run.runId,
      workflowKey: run.workflowKey,
      reason,
    });
    return;
  }
  if (run.workflowKey === "approval.wait" || run.workflowKey === "connector.delivery") {
    host.publishRealtime("system", "durable", {
      type: "durable_workflow_unrecoverable",
      runId: run.runId,
      workflowKey: run.workflowKey,
      reason,
    });
    return;
  }
  if (run.workflowKey === "hook.delivery") {
    const payload = parseHookDeliveryWorkflowPayload(run);
    if (payload) {
      host.hooksService.markHookRunDeadLettered(payload.hookRunId, reason);
    }
    host.publishRealtime("system", "durable", {
      type: "durable_workflow_unrecoverable",
      runId: run.runId,
      workflowKey: run.workflowKey,
      reason,
    });
    return;
  }
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

export async function executeDurableWorkflowRun(host: DurableExecutionHost, run: DurableRunRecord): Promise<void> {
  switch (run.workflowKey) {
    case "memory.maintenance":
      completeDurableWorkflowRun(host, run.runId, await host.memoryMaintenanceService.executeDurableRun(run));
      return;
    case "chat.turn.execute":
      await executeDurableChatTurnRun(host, run);
      return;
    case "proactive.tick":
      await host.chatProactiveService.executeDurableProactiveTickRun(run);
      return;
    case "approval.wait":
      await executeDurableApprovalWaitRun(host, run);
      return;
    case "connector.delivery":
      await executeDurableConnectorDeliveryRun(host, run);
      return;
    case "hook.delivery":
      await executeDurableHookDeliveryRun(host, run);
      return;
    default:
      throw new Error(`Unsupported durable workflow: ${run.workflowKey}`);
  }
}

export function getDurableDiagnostics(host: DurableExecutionHost): DurableDiagnosticsResponse {
  return host.durableRunService.getDurableDiagnostics();
}

export function listDurableRuns(host: DurableExecutionHost, limit = 50): DurableRunRecord[] {
  return host.durableRunService.listDurableRuns(limit);
}

export function listDurableDeadLetters(host: DurableExecutionHost, limit = 50): DurableDeadLetterRecord[] {
  return host.durableRunService.listDurableDeadLetters(limit);
}

export function listDurableRunCheckpoints(
  host: DurableExecutionHost,
  runId: string,
  limit = 200,
): DurableCheckpointRecord[] {
  return host.durableRunService.listDurableRunCheckpoints(runId, limit);
}

export function createDurableRun(host: DurableExecutionHost, input: DurableRunCreateRequest): DurableRunRecord {
  const run = host.durableRunService.createDurableRun(input);
  if (run.status === "queued") {
    host.durableRunService.requestRunProcessing(run.runId);
  }
  return run;
}

export function getDurableRun(host: DurableExecutionHost, runId: string): DurableRunRecord {
  return host.durableRunService.getDurableRun(runId);
}

export function listDurableRunTimeline(
  host: DurableExecutionHost,
  runId: string,
  limit = 300,
): DurableRunTimelineEvent[] {
  return host.durableRunService.listDurableRunTimeline(runId, limit);
}

export function pauseDurableRun(host: DurableExecutionHost, runId: string, actorId = "operator"): DurableRunRecord {
  return host.durableRunService.pauseDurableRun(runId, actorId);
}

export function resumeDurableRun(host: DurableExecutionHost, runId: string, actorId = "operator"): DurableRunRecord {
  const run = host.durableRunService.resumeDurableRun(runId, actorId);
  host.memoryMaintenanceService.syncFromDurableRun(run);
  host.durableRunService.requestRunProcessing(runId);
  return run;
}

export function cancelDurableRun(host: DurableExecutionHost, runId: string, actorId = "operator"): DurableRunRecord {
  const run = host.durableRunService.cancelDurableRun(runId, actorId);
  host.memoryMaintenanceService.syncFromDurableRun(run);
  return run;
}

export function retryDurableRun(
  host: DurableExecutionHost,
  runId: string,
  reason = "manual_retry",
  actorId = "operator",
): DurableRunRecord {
  const run = host.durableRunService.retryDurableRun(runId, reason, actorId);
  host.memoryMaintenanceService.syncFromDurableRun(run);
  if (run.status === "queued") {
    host.durableRunService.requestRunProcessing(runId);
  }
  host.hooksService.enqueueAfterHooks({
    workspaceId: host.resolveDurableRunHookWorkspaceId(run),
    trigger: "orchestration.retry.scheduled",
    entityType: "durable_run",
    entityId: runId,
    payload: {
      runId,
      reason,
      actorId,
      status: run.status,
      attemptCount: run.attemptCount,
    },
  });
  return run;
}

export function wakeDurableRun(
  host: DurableExecutionHost,
  runId: string,
  event: {
    eventKey: string;
    payload?: Record<string, unknown>;
    correlationId?: string;
  },
): DurableRunRecord {
  const run = host.durableRunService.wakeDurableRun(runId, event);
  host.durableRunService.requestRunProcessing(runId);
  host.hooksService.enqueueAfterHooks({
    workspaceId: host.resolveDurableRunHookWorkspaceId(run),
    trigger: "orchestration.run.woken",
    entityType: "durable_run",
    entityId: runId,
    payload: {
      runId,
      eventKey: event.eventKey,
      correlationId: event.correlationId,
      payload: event.payload ?? {},
    },
  });
  return run;
}

export function recoverDurableDeadLetter(
  host: DurableExecutionHost,
  entryId: string,
  actorId = "operator",
): DurableRunRecord {
  return host.durableRunService.recoverDurableDeadLetter(entryId, actorId);
}
