/**
 * Approval lifecycle service.
 *
 * Holds the moved bodies for the simpler members of the GatewayService
 * approval surface (Step 3 of the gateway-service decomposition plan).
 * The two largest methods — createApproval and resolveApproval — keep
 * their bodies inside GatewayService for now because they own
 * transaction scopes and hook orchestration; they will be migrated in a
 * follow-on pass once their dependency surface stabilizes.
 *
 * Pattern reference: comms-service.ts, memory-facade-service.ts,
 * cron-scheduler-service.ts.
 */

import { randomUUID } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
import {
  clampInt,
  ConflictError,
  type ApprovalBulkResolveInput,
  type ApprovalBulkResolveResult,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type ApprovalResolveInput,
  type ToolGrantCreateInput,
  type ToolGrantRecord,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";
import { DEVICE_ACCESS_APPROVAL_KIND } from "./device-access-helpers.js";

function hashSensitiveToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
import type {
  ApprovalReplayResult,
  ApprovalResolveResult,
  GatewayService,
  RemoteApprovalActionTokenIssueResult,
} from "./gateway-service.js";

export type ApprovalLifecycleHost = GatewayService;

export function listToolGrants(
  host: ApprovalLifecycleHost,
  scope?: "global" | "session" | "agent" | "task",
  scopeRef?: string,
  limit = 200,
): ToolGrantRecord[] {
  return host.policyEngine.listGrants(scope, scopeRef, limit);
}

export function createToolGrant(host: ApprovalLifecycleHost, input: ToolGrantCreateInput): ToolGrantRecord {
  const grant = host.policyEngine.createGrant(input);
  host.publishRealtime("system", "tools", {
    type: "tool_grant_created",
    grantId: grant.grantId,
    toolPattern: grant.toolPattern,
    decision: grant.decision,
    scope: grant.scope,
    scopeRef: grant.scopeRef,
    expiresAt: grant.expiresAt,
  });
  return grant;
}

export function revokeToolGrant(host: ApprovalLifecycleHost, grantId: string): boolean {
  const revoked = host.policyEngine.revokeGrant(grantId);
  if (revoked) {
    host.publishRealtime("system", "tools", {
      type: "tool_grant_revoked",
      grantId,
    });
  }
  return revoked;
}

export function listApprovals(
  host: ApprovalLifecycleHost,
  status?: ApprovalRequest["status"],
  limit = 100,
): ApprovalRequest[] {
  return host.storage.approvals.list(status, limit);
}

export function getApprovalReplay(
  host: ApprovalLifecycleHost,
  approvalId: string,
  replayedBy = "operator",
): ApprovalReplayResult {
  const approval = host.storage.approvals.get(approvalId);

  host.storage.approvalEvents.append({
    approvalId,
    eventType: "replayed",
    actorId: replayedBy,
    payload: {
      status: approval.status,
    },
  });

  return {
    approval,
    events: host.storage.approvalEvents.listByApprovalId(approvalId),
    pendingAction: host.storage.pendingApprovalActions.find(approvalId),
    durableRunId: host.findApprovalWaitDurableRunId(approvalId),
  };
}

export function createApprovalRemoteActionToken(
  host: ApprovalLifecycleHost,
  approvalId: string,
  input: {
    connectorId: string;
    issuedBy?: string;
    expiresInMs?: number;
  },
): RemoteApprovalActionTokenIssueResult {
  const approval = host.storage.approvals.get(approvalId);
  if (approval.status !== "pending") {
    throw new ConflictError({
      message: `Approval ${approvalId} is already resolved`,
    });
  }
  const connector = host.requireConnectorRecord(input.connectorId);
  const expiresInMs = clampInt(input.expiresInMs ?? 15 * 60_000, 15 * 60_000, 60_000, 24 * 60 * 60_000);
  const token = `grat_${randomBytes(32).toString("base64url")}`;
  const created = host.storage.remoteActionTokens.create({
    tokenHash: hashSensitiveToken(token),
    actionType: "approval.resolve",
    approvalId,
    connectorId: input.connectorId,
    mutation: { approvalId },
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  });
  void host.storage.audit.append("approvals", {
    event: "approval.remote_token.create",
    approvalId,
    connectorId: input.connectorId,
    issuedBy: input.issuedBy ?? "operator",
    expiresAt: created.expiresAt,
    tokenId: created.tokenId,
  });
  host.publishRealtime(
    "approval_remote_token_created",
    "approvals",
    {
      approvalId,
      connectorId: input.connectorId,
      expiresAt: created.expiresAt,
      tokenId: created.tokenId,
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: {
        approvalId,
        connectorId: input.connectorId,
        tokenId: created.tokenId,
      },
    },
  );
  host.enqueueApprovalRemoteTokenDelivery(approval, connector, {
    token,
    tokenId: created.tokenId,
    expiresAt: created.expiresAt,
  });
  return {
    ...created,
    approvalId,
    token,
  };
}

export async function resolveApprovalWithRemoteToken(
  host: ApprovalLifecycleHost,
  input: {
    token: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  },
): Promise<ApprovalResolveResult> {
  const tokenRecord = host.consumeRemoteActionToken(input.token, "approval.resolve");
  return host.resolveApprovalWithConsumedRemoteToken(tokenRecord, input);
}

export async function resolveApprovalWithRemoteTokenId(
  host: ApprovalLifecycleHost,
  input: {
    tokenId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  },
): Promise<ApprovalResolveResult> {
  const tokenRecord = host.consumeRemoteActionTokenById(input.tokenId, "approval.resolve");
  return host.resolveApprovalWithConsumedRemoteToken(tokenRecord, input);
}

export async function resolveApprovalsBulk(
  host: ApprovalLifecycleHost,
  input: ApprovalBulkResolveInput,
): Promise<ApprovalBulkResolveResult> {
  const statusFilter = input.status ?? "pending";
  const items = host.storage.approvals.list(statusFilter, 10_000);
  const results: ApprovalBulkResolveResult["items"] = [];

  for (const approval of items) {
    try {
      const result = await host.resolveApproval(approval.approvalId, {
        decision: input.decision,
        resolvedBy: input.resolvedBy,
        resolutionNote: input.resolutionNote,
      });
      results.push({
        approvalId: approval.approvalId,
        outcome: "resolved",
        status: result.approval.status,
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        let status: ApprovalRequest["status"] | undefined;
        try {
          status = host.storage.approvals.get(approval.approvalId).status;
        } catch {
          status = undefined;
        }
        results.push({
          approvalId: approval.approvalId,
          outcome: "skipped",
          status,
          error: error.message,
        });
        continue;
      }
      results.push({
        approvalId: approval.approvalId,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const resolvedCount = results.filter((item) => item.outcome === "resolved").length;
  const skippedCount = results.filter((item) => item.outcome === "skipped").length;
  const failedCount = results.filter((item) => item.outcome === "failed").length;

  return {
    decision: input.decision,
    statusFilter,
    attemptedCount: results.length,
    resolvedCount,
    skippedCount,
    failedCount,
    items: results,
  };
}

export async function createApproval(
  host: ApprovalLifecycleHost,
  input: ApprovalCreateInput,
): Promise<ApprovalRequest> {
  const approvalHookWorkspaceId = host.resolveApprovalHookWorkspaceId(input.payload);
  const approvalHookEntityId = randomUUID();
  const beforeHook = await host.hooksService.runInlineHooks<{
    riskLevel?: ApprovalCreateInput["riskLevel"];
    payloadMerge?: Record<string, unknown>;
    previewMerge?: Record<string, unknown>;
    expiresAt?: string | null;
  }>({
    workspaceId: approvalHookWorkspaceId,
    trigger: "approval.create.before",
    entityType: "approval",
    entityId: approvalHookEntityId,
    payload: {
      kind: input.kind,
      riskLevel: input.riskLevel,
      payload: input.payload,
      preview: input.preview,
      expiresAt: input.expiresAt ?? null,
    },
    parsePatch: (value) => host.parseApprovalCreateHookPatch(value),
    mergePatch: (current, next) => ({
      ...(current ?? {}),
      ...next,
      ...(current?.payloadMerge || next.payloadMerge
        ? {
            payloadMerge: {
              ...(current?.payloadMerge ?? {}),
              ...(next.payloadMerge ?? {}),
            },
          }
        : {}),
      ...(current?.previewMerge || next.previewMerge
        ? {
            previewMerge: {
              ...(current?.previewMerge ?? {}),
              ...(next.previewMerge ?? {}),
            },
          }
        : {}),
    }),
  });
  if (beforeHook.blockedBy) {
    throw new Error(beforeHook.blockedBy.reason);
  }

  const hookableInput = beforeHook.patch
    ? {
        ...input,
        ...(beforeHook.patch.riskLevel ? { riskLevel: beforeHook.patch.riskLevel } : {}),
        payload: {
          ...input.payload,
          ...(beforeHook.patch.payloadMerge ?? {}),
        },
        preview: {
          ...input.preview,
          ...(beforeHook.patch.previewMerge ?? {}),
        },
        expiresAt: beforeHook.patch.expiresAt !== undefined ? beforeHook.patch.expiresAt : input.expiresAt,
      }
    : input;

  let approval = host.storage.approvals.create(hookableInput);
  approval = host.primeApprovalLifecycle(approval.approvalId, host.buildApprovalLinkage(hookableInput.linkage));

  host.storage.approvalEvents.append({
    approvalId: approval.approvalId,
    eventType: "created",
    actorId: "system",
    payload: {
      kind: approval.kind,
      riskLevel: approval.riskLevel,
      status: approval.status,
    },
  });

  await host.storage.audit.append("approvals", {
    event: "approval.create",
    approvalId: approval.approvalId,
    kind: approval.kind,
    riskLevel: approval.riskLevel,
    status: approval.status,
  });

  host.publishRealtime(
    "approval_created",
    "approvals",
    {
      approvalId: approval.approvalId,
      kind: approval.kind,
      riskLevel: approval.riskLevel,
      status: approval.status,
    },
    {
      eventClass: "domain_fact",
      eventAuthority: "retained_stream",
      links: host.buildApprovalRealtimeLinks(approval),
    },
  );

  host.scheduleApprovalExplanation(approval);

  return approval;
}

export async function resolveApproval(
  host: ApprovalLifecycleHost,
  approvalId: string,
  input: ApprovalResolveInput,
): Promise<ApprovalResolveResult> {
  const current = host.storage.approvals.get(approvalId);
  if (current.kind === DEVICE_ACCESS_APPROVAL_KIND) {
    return host.resolveDeviceAccessApproval(current, input);
  }

  let executedAction: ToolInvokeResult | undefined;
  const pendingAction = host.storage.pendingApprovalActions.find(approvalId);

  if (input.decision === "approve") {
    if (pendingAction?.actionType === "code_mode.run") {
      executedAction = await host.executeCodeModePendingApproval(approvalId);
    } else {
      executedAction = await host.policyEngine.executeApprovedAction(approvalId);
      if (pendingAction?.resolutionStatus === "pending" && executedAction?.outcome !== "executed") {
        host.storage.pendingApprovalActions.upsertPending({
          approvalId,
          actionType: pendingAction.actionType,
          request: pendingAction.request,
          createdAt: pendingAction.createdAt,
        });
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `Approved action could not execute and remains pending: ${executedAction?.policyReason ?? "unknown execution error"}`,
        });
      }
    }
  }

  let approval!: ApprovalRequest;
  let wakeRunId: string | undefined;

  host.storage.runImmediateTransaction(() => {
    approval = host.storage.approvals.resolve(approvalId, input);

    host.storage.approvalEvents.append({
      approvalId,
      eventType: "resolved",
      actorId: input.resolvedBy,
      payload: {
        decision: input.decision,
        status: approval.status,
        editedPayload: input.editedPayload,
        executedOutcome: executedAction?.outcome,
      },
    });

    if (input.decision !== "approve" && pendingAction && pendingAction.resolutionStatus === "pending") {
      host.storage.pendingApprovalActions.markResolved(approvalId, "rejected", {
        decision: input.decision,
      });
    }
    wakeRunId = host.markApprovalWaitDurableRunResolved(approval, input, executedAction);
  });

  const proactiveRunIds = host.findProactiveDurableRunIdsForApproval(approvalId);
  if (wakeRunId) {
    approval = host.storage.approvals.mergeLinkage(approval.approvalId, { durableRunId: wakeRunId });
    host.durableRunService.requestRunProcessing(wakeRunId);
  }
  for (const proactiveRunId of proactiveRunIds) {
    try {
      host.wakeDurableRun(proactiveRunId, {
        eventKey: "approval.resolved",
        correlationId: approval.approvalId,
        payload: {
          approvalId: approval.approvalId,
          status: approval.status,
          decision: input.decision,
          resolvedBy: input.resolvedBy,
          executedOutcome: executedAction?.outcome,
        },
      });
    } catch (error) {
      if (!String((error as Error).message ?? "").includes("not waiting/paused")) {
        throw error;
      }
    }
    host.durableRunService.requestRunProcessing(proactiveRunId);
  }

  await host.recordApprovalResolutionEffects(approval, input, executedAction);

  host.hooksService.enqueueAfterHooks({
    workspaceId: host.resolveApprovalHookWorkspaceId({
      approvalId,
      ...(approval.payload ?? {}),
    }),
    trigger: "approval.resolve.after",
    entityType: "approval",
    entityId: approval.approvalId,
    payload: {
      approval,
      decision: input.decision,
      resolvedBy: input.resolvedBy,
      executedAction,
    },
  });

  return {
    approval,
    executedAction,
    replay: {
      approval,
      events: host.storage.approvalEvents.listByApprovalId(approvalId),
      pendingAction: host.storage.pendingApprovalActions.find(approvalId),
    },
    durableRunId: wakeRunId,
  };
}

export async function resolveChatToolApproval(
  host: ApprovalLifecycleHost,
  sessionId: string,
  approvalId: string,
  decision: "approve" | "reject",
): Promise<void> {
  const approval = host.storage.approvals.get(approvalId);
  const approvalSessionId = typeof approval.payload.sessionId === "string" ? approval.payload.sessionId : undefined;
  if (approvalSessionId && approvalSessionId !== sessionId) {
    throw new Error(`Approval ${approvalId} does not belong to session ${sessionId}.`);
  }
  const existingInlineApproval = host.storage.chatInlineApprovals.get(approvalId);
  if (existingInlineApproval && existingInlineApproval.sessionId !== sessionId) {
    throw new Error(`Approval ${approvalId} does not belong to session ${sessionId}.`);
  }
  const turn = host.storage.chatToolRuns
    .listBySession(sessionId, 2000)
    .find((toolRun) => toolRun.approvalId === approvalId);
  const turnId = turn?.turnId ?? existingInlineApproval?.turnId;
  if (!turnId) {
    throw new Error(`Approval ${approvalId} is not attached to session ${sessionId}.`);
  }
  if (approval.status !== "pending") {
    return;
  }
  await host.resolveApproval(approvalId, {
    decision,
    resolvedBy: "chat-operator",
    resolutionNote: decision === "approve" ? "Approved from chat inline control." : "Denied from chat inline control.",
  });
  host.storage.chatInlineApprovals.upsert({
    approvalId,
    sessionId,
    turnId,
    toolName: turn?.toolName ?? existingInlineApproval?.toolName,
    status: decision === "approve" ? "approved" : "denied",
    reason: decision === "approve" ? "approved by operator" : "denied by operator",
    resolvedBy: "chat-operator",
  });
}
