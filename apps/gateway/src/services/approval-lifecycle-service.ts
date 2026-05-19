/**
 * Approval lifecycle service.
 *
 * Owns approval state mutation, replay, and resolution side-effect
 * orchestration behind an explicit host contract.
 *
 * ApprovalLifecycleHost documents exactly which capabilities the approval
 * lifecycle requires. GatewayService satisfies this interface, but is not
 * the only possible implementation.
 */

import { randomUUID } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
import {
  type ApprovalEffectRecord,
  clampInt,
  ConflictError,
  type ApprovalBulkResolveInput,
  type ApprovalBulkResolveResult,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type ApprovalResolveInput,
  type ConnectorRecord,
  type DurableWakeResult,
  type RemoteActionType,
  type RealtimeEvent,
  type ToolGrantCreateInput,
  type ToolGrantRecord,
  type ToolInvokeResult,
  ValidationError,
} from "@goatcitadel/contracts";
import { DEVICE_ACCESS_APPROVAL_KIND } from "./device-access-helpers.js";

function hashSensitiveToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
import type {
  ApprovalReplayResult,
  ApprovalResolveResult,
  RemoteApprovalActionTokenIssueResult,
} from "./approval-types.js";
import type { HooksService } from "./hooks-service.js";
import type { ApprovalWaitRunService } from "./approval-wait-run-service.js";
import type { ShellExplainerPolicyConfig } from "../config.js";
import { applyShellExplainerPolicy } from "./shell-command-explainer.js";
import {
  deriveApprovalResolutionEffectsResult,
  type ApprovalResolutionEffectsResult,
} from "./approval-resolution-effects-service.js";
import { parseApprovalCreateHookPatch } from "./hook-patch-helpers.js";
import type { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import type { Storage } from "@goatcitadel/storage";

/**
 * Narrow interface describing exactly what the approval lifecycle functions
 * need from their host. GatewayService satisfies this interface, but the
 * explicit contract enables future extraction and testability.
 */
export interface ApprovalLifecycleHost {
  // ── storage ────────────────────────────────────────────────────────
  readonly storage: Pick<
    Storage,
    | "approvals"
    | "approvalEvents"
    | "pendingApprovalActions"
    | "remoteActionTokens"
    | "audit"
    | "approvalWaitRuns"
    | "approvalEffects"
    | "approvalInbox"
    | "chatInlineApprovals"
    | "chatSessionMeta"
    | "chatTurnTraces"
    | "chatToolRuns"
    | "codeModeRuns"
    | "runImmediateTransaction"
  >;

  // ── services ───────────────────────────────────────────────────────
  readonly policyEngine: Pick<ToolPolicyEngine, "listGrants" | "createGrant" | "revokeGrant" | "executeApprovedAction">;
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;
  readonly approvalWaitRunService: Pick<
    ApprovalWaitRunService,
    "buildApprovalLinkage" | "buildApprovalRealtimeLinks" | "primeApprovalLifecycle"
  >;

  // ── config ─────────────────────────────────────────────────────────
  readonly shellExplainerPolicy: ShellExplainerPolicyConfig;

  // ── realtime ───────────────────────────────────────────────────────
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent;

  // ── approval-specific gateway methods ──────────────────────────────
  requireConnectorRecord(connectorId: string): ConnectorRecord;
  consumeRemoteActionToken(
    token: string,
    actionType: RemoteActionType,
  ): { tokenId: string; connectorId: string; approvalId?: string; mutation?: Record<string, unknown> };
  consumeRemoteActionTokenById(
    tokenId: string,
    actionType: RemoteActionType,
  ): { tokenId: string; connectorId: string; approvalId?: string; mutation?: Record<string, unknown> };
  resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<ApprovalResolveResult>;
  resolveDeviceAccessApproval(current: ApprovalRequest, input: ApprovalResolveInput): Promise<ApprovalResolveResult>;
  executeCodeModePendingApproval(approvalId: string, signal?: AbortSignal): Promise<ToolInvokeResult | undefined>;
  resolveApprovalHookWorkspaceId(payload: Record<string, unknown>): string;
  scheduleApprovalExplanation(approval: ApprovalRequest): void;
  findProactiveDurableRunIdsForApproval(approvalId: string): string[];
  wakeDurableRun(
    runId: string,
    event: { eventKey: string; payload?: Record<string, unknown>; correlationId?: string },
  ): DurableWakeResult;
  recordApprovalResolution(approval: ApprovalRequest, input: ApprovalResolveInput): Promise<void>;
  enqueueApprovalResolutionEffects(approval: ApprovalRequest, input: ApprovalResolveInput): ApprovalEffectRecord[];
  enqueueApprovalRemoteTokenDelivery(
    approval: ApprovalRequest,
    connector: ConnectorRecord,
    tokenRecord: { token: string; tokenId: string; expiresAt: string },
  ): void;
}

export function listToolGrants(
  host: ApprovalLifecycleHost,
  scope?: "global" | "session" | "workspace" | "agent" | "task",
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

export function revokeToolGrant(host: ApprovalLifecycleHost, grantId: string, revokedBy: string): boolean {
  if (!revokedBy.trim()) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "revokedBy" });
  }
  const revoked = host.policyEngine.revokeGrant(grantId, revokedBy);
  if (revoked) {
    host.publishRealtime("system", "tools", {
      type: "tool_grant_revoked",
      grantId,
      revokedBy,
    });
  }
  return revoked;
}

export function listApprovals(
  host: ApprovalLifecycleHost,
  status?: ApprovalRequest["status"],
  limit = 100,
): ApprovalRequest[] {
  return host.storage.approvals
    .list(status, limit)
    .map((approval) =>
      withApprovalFollowUp(approval, host.storage.approvalEffects.listByApproval(approval.approvalId)),
    );
}

export function getApprovalReplay(
  host: ApprovalLifecycleHost,
  approvalId: string,
  replayedBy = "operator",
): ApprovalReplayResult {
  const storedApproval = host.storage.approvals.get(approvalId);
  const effects = host.storage.approvalEffects.listByApproval(approvalId);
  const approval = withApprovalFollowUp(storedApproval, effects);

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
    durableRunId: host.storage.approvalWaitRuns.getRunId(approvalId),
    effects,
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

export async function resolveApprovalWithConsumedRemoteToken(
  host: ApprovalLifecycleHost,
  tokenRecord: {
    tokenId: string;
    connectorId: string;
    approvalId?: string;
    mutation?: Record<string, unknown>;
  },
  input: {
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  },
): Promise<ApprovalResolveResult> {
  const approvalId = tokenRecord.approvalId ?? String(tokenRecord.mutation?.approvalId ?? "").trim();
  if (!approvalId) {
    throw new ValidationError({
      message: "Remote action token is missing an approval binding.",
    });
  }
  const resolvedBy = input.resolvedBy?.trim() || `connector:${tokenRecord.connectorId}`;
  void host.storage.audit.append("approvals", {
    event: "approval.remote_token.consume",
    approvalId,
    connectorId: tokenRecord.connectorId,
    tokenId: tokenRecord.tokenId,
    decision: input.decision,
    resolvedBy,
  });
  host.storage.approvals.mergeLinkage(approvalId, {
    connectorId: tokenRecord.connectorId,
    tokenId: tokenRecord.tokenId,
  });
  return host.resolveApproval(approvalId, {
    decision: input.decision,
    editedPayload: input.editedPayload,
    resolutionNote: input.resolutionNote,
    resolvedBy,
  });
}

export async function resolveApprovalWithRemoteToken(
  host: ApprovalLifecycleHost,
  input: {
    token: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  },
): Promise<ApprovalResolveResult> {
  const tokenRecord = host.consumeRemoteActionToken(input.token, "approval.resolve");
  return resolveApprovalWithConsumedRemoteToken(host, tokenRecord, input);
}

export async function resolveApprovalWithRemoteTokenId(
  host: ApprovalLifecycleHost,
  input: {
    tokenId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  },
): Promise<ApprovalResolveResult> {
  const tokenRecord = host.consumeRemoteActionTokenById(input.tokenId, "approval.resolve");
  return resolveApprovalWithConsumedRemoteToken(host, tokenRecord, input);
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
  const approvalHookWorkspaceId = host.resolveApprovalHookWorkspaceId({
    ...(input.payload ?? {}),
    workspaceId:
      typeof input.linkage?.workspaceId === "string" && input.linkage.workspaceId.trim()
        ? input.linkage.workspaceId.trim()
        : input.payload.workspaceId,
    sessionId:
      typeof input.linkage?.sessionId === "string" && input.linkage.sessionId.trim()
        ? input.linkage.sessionId.trim()
        : input.payload.sessionId,
  });
  const approvalHookEntityId = randomUUID();
  const requestHook = await host.hooksService.runInlineHooks({
    workspaceId: approvalHookWorkspaceId,
    trigger: "approval.request.before",
    entityType: "approval",
    entityId: approvalHookEntityId,
    payload: {
      kind: input.kind,
      riskLevel: input.riskLevel,
      payload: input.payload,
    },
    parsePatch: () => undefined,
  });
  if (requestHook.blockedBy) {
    throw new Error(requestHook.blockedBy.reason);
  }
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
    parsePatch: (value) => parseApprovalCreateHookPatch(value as Record<string, unknown>),
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

  const policyOutcome = applyShellExplainerPolicy(
    {
      riskLevel: hookableInput.riskLevel,
      payload: hookableInput.payload,
      preview: hookableInput.preview,
    },
    host.shellExplainerPolicy,
  );
  const createInput = policyOutcome.elevatedRiskLevel
    ? { ...hookableInput, riskLevel: policyOutcome.elevatedRiskLevel }
    : hookableInput;

  let approval = host.storage.approvals.create(createInput);
  if (policyOutcome.explanations.length > 0) {
    host.storage.approvals.setShellExplanations(approval.approvalId, policyOutcome.explanations);
    approval = host.storage.approvals.get(approval.approvalId);
  }
  approval = host.approvalWaitRunService.primeApprovalLifecycle(
    approval.approvalId,
    host.approvalWaitRunService.buildApprovalLinkage(hookableInput.linkage),
  );

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
      links: host.approvalWaitRunService.buildApprovalRealtimeLinks(approval),
      correlationId: approval.approvalId,
    },
  );

  if (policyOutcome.autoReject) {
    const resolution = await resolveApproval(host, approval.approvalId, {
      decision: "reject",
      resolvedBy: "system",
      resolutionNote: policyOutcome.autoRejectReason ?? "Auto-rejected by shell danger policy.",
    });
    return resolution.approval;
  }

  host.scheduleApprovalExplanation(approval);

  return approval;
}

export async function resolveApproval(
  host: ApprovalLifecycleHost,
  approvalId: string,
  input: ApprovalResolveInput,
): Promise<ApprovalResolveResult> {
  const current = host.storage.approvals.get(approvalId);
  const pendingAction = host.storage.pendingApprovalActions.find(approvalId);
  const expiresAt = current.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    markCodeModeRunTerminalForPendingApproval(host, pendingAction, "expired", {
      reason: `Approval ${approvalId} has expired and can no longer be resolved.`,
    });
    throw new ValidationError({
      message: `Approval ${approvalId} has expired and can no longer be resolved.`,
    });
  }
  if (current.kind === DEVICE_ACCESS_APPROVAL_KIND) {
    return host.resolveDeviceAccessApproval(current, input);
  }

  let approval!: ApprovalRequest;
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
      },
    });

    markChatInlineApprovalResolved(host, approval, input);

    if (input.decision !== "approve" && pendingAction && pendingAction.resolutionStatus === "pending") {
      host.storage.pendingApprovalActions.markResolved(approvalId, "rejected", {
        decision: input.decision,
      });
      markCodeModeRunTerminalForPendingApproval(host, pendingAction, "rejected", {
        decision: input.decision,
        reason: `Approval ${approvalId} resolved with ${input.decision}.`,
      });
    }

    host.enqueueApprovalResolutionEffects(approval, input);
  });

  await host.recordApprovalResolution(approval, input);

  const effects = host.storage.approvalEffects.listByApproval(approvalId);
  const resolutionEffects: ApprovalResolutionEffectsResult | undefined = deriveApprovalResolutionEffectsResult(effects);

  const wakeRunId = resolutionEffects?.approvalWaitDurableRunId;
  if (wakeRunId && approval.linkage?.durableRunId !== wakeRunId) {
    approval = host.storage.approvals.mergeLinkage(approval.approvalId, { durableRunId: wakeRunId });
  }
  approval = withApprovalFollowUp(approval, effects);

  return {
    approval,
    effects,
    replay: {
      approval,
      events: host.storage.approvalEvents.listByApprovalId(approvalId),
      pendingAction: host.storage.pendingApprovalActions.find(approvalId),
      effects,
    },
    durableRunId: wakeRunId,
    resolutionEffects,
  };
}

function markCodeModeRunTerminalForPendingApproval(
  host: ApprovalLifecycleHost,
  pendingAction: ReturnType<ApprovalLifecycleHost["storage"]["pendingApprovalActions"]["find"]>,
  status: "rejected" | "expired",
  details: Record<string, unknown>,
): void {
  if (!pendingAction || pendingAction.actionType !== "code_mode.run" || pendingAction.resolutionStatus !== "pending") {
    return;
  }
  const runId = typeof pendingAction.request.runId === "string" ? pendingAction.request.runId : undefined;
  if (!runId) {
    return;
  }
  const existing = host.storage.codeModeRuns.find(runId);
  if (!existing || existing.status !== "approval_pending") {
    return;
  }
  const finishedAt = new Date().toISOString();
  host.storage.codeModeRuns.upsert({
    ...existing,
    status,
    error: typeof details.reason === "string" ? details.reason : undefined,
    finishedAt,
  });
  if (status === "expired") {
    host.storage.pendingApprovalActions.markResolved(pendingAction.approvalId, "failed", {
      ...details,
      status,
      runId,
    });
  }
}

function withApprovalFollowUp(approval: ApprovalRequest, effects: ApprovalEffectRecord[]): ApprovalRequest {
  const followUp = deriveApprovalFollowUp(effects);
  return {
    ...approval,
    followUp,
  };
}

function markChatInlineApprovalResolved(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  input: ApprovalResolveInput,
): void {
  const inlineApproval = host.storage.chatInlineApprovals.get(approval.approvalId);
  if (!inlineApproval || inlineApproval.status !== "pending") {
    return;
  }
  const approved = input.decision === "approve" || input.decision === "edit";
  host.storage.chatInlineApprovals.upsert({
    approvalId: inlineApproval.approvalId,
    sessionId: inlineApproval.sessionId,
    turnId: inlineApproval.turnId,
    kind: inlineApproval.kind,
    toolName: inlineApproval.toolName,
    status: approved ? "approved" : "denied",
    reason: input.resolutionNote ?? (approved ? `Resolved as ${input.decision} by operator.` : "Rejected by operator."),
    riskLevel: inlineApproval.riskLevel,
    details: {
      ...(inlineApproval.details ?? {}),
      decision: input.decision,
    },
    expiresAt: inlineApproval.expiresAt,
    resolvedBy: input.resolvedBy,
  });
}

function deriveApprovalFollowUp(effects: ApprovalEffectRecord[]): ApprovalRequest["followUp"] {
  if (effects.length === 0) {
    return { status: "none" };
  }

  const ranked = [...effects].sort((left, right) => followUpStatusRank(left.status) - followUpStatusRank(right.status));
  const effect = ranked[0] as ApprovalEffectRecord;
  const status = effect.status === "pending" ? "queued" : effect.status;
  return {
    status,
    effectId: effect.effectId,
    effectKind: effect.effectKind,
    targetKind: effect.targetKind,
    targetId: effect.targetId,
    reason: effect.lastError ?? readFollowUpReason(effect.result),
    updatedAt: effect.updatedAt,
    completedAt: effect.completedAt,
  };
}

function followUpStatusRank(status: ApprovalEffectRecord["status"]): number {
  switch (status) {
    case "running":
      return 0;
    case "pending":
      return 1;
    case "failed":
      return 2;
    case "skipped":
      return 3;
    case "completed":
      return 4;
  }
}

function readFollowUpReason(result: Record<string, unknown>): string | undefined {
  const reason = result.reason ?? result.outcome ?? result.detail ?? result.error;
  return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
}

export async function resolveChatToolApproval(
  host: ApprovalLifecycleHost,
  sessionId: string,
  approvalId: string,
  decision: "approve" | "reject",
  options?: {
    allowScope?: "once" | "session" | "workspace";
    resolvedBy?: string;
  },
): Promise<{
  allowScope: "once" | "session" | "workspace";
  grant?: ToolGrantRecord;
  resumed: boolean;
  resumedTurnId?: string;
  resumedRunId?: string;
}> {
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
    return {
      allowScope: options?.allowScope ?? "once",
      resumed: false,
    };
  }
  const expiresAt = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    throw new ValidationError({
      message: `Approval ${approvalId} has expired and can no longer be resolved.`,
    });
  }
  const allowScope = decision === "approve" ? (options?.allowScope ?? "once") : "once";
  const resolvedBy = options?.resolvedBy?.trim() || "operator";
  const toolPattern = turn?.toolName ?? existingInlineApproval?.toolName ?? approval.kind;
  let grant: ToolGrantRecord | undefined;
  if (decision === "approve" && allowScope !== "once") {
    if (!toolPattern?.trim()) {
      throw new Error(`Approval ${approvalId} does not expose a tool pattern for persistent allow.`);
    }
    const scope = allowScope === "workspace" ? "workspace" : "session";
    const scopeRef =
      allowScope === "workspace" ? resolveChatApprovalWorkspaceScopeRef(host, approval, sessionId) : sessionId;
    grant =
      findExistingGrant(host, scope, scopeRef, toolPattern) ??
      createToolGrant(host, {
        toolPattern,
        decision: "allow",
        scope,
        scopeRef,
        grantType: "persistent",
        createdBy: resolvedBy,
      });
  }
  const resolution = await host.resolveApproval(approvalId, {
    decision,
    resolvedBy,
    resolutionNote: buildChatApprovalResolutionNote(decision, allowScope),
  });
  const resume = resolution.resolutionEffects?.chatTurnResume ?? { resumed: false as const };
  host.storage.chatInlineApprovals.upsert({
    approvalId,
    sessionId,
    turnId,
    toolName: turn?.toolName ?? existingInlineApproval?.toolName,
    status: decision === "approve" ? "approved" : "denied",
    reason: decision === "approve" ? "approved by operator" : "denied by operator",
    resolvedBy,
    details: {
      ...(existingInlineApproval?.details ?? {}),
      allowScope,
      grantId: grant?.grantId,
      grantScope: grant?.scope,
      grantScopeRef: grant?.scopeRef,
    },
  });
  return {
    allowScope,
    grant,
    resumed: resume.resumed,
    resumedTurnId: resume.turnId ?? turnId,
    resumedRunId: resume.durableRunId,
  };
}

function buildChatApprovalResolutionNote(
  decision: "approve" | "reject",
  allowScope: "once" | "session" | "workspace",
): string {
  if (decision === "reject") {
    return "Denied from chat inline control.";
  }
  if (allowScope === "session") {
    return "Approved from chat inline control and allowed for this session.";
  }
  if (allowScope === "workspace") {
    return "Approved from chat inline control and allowed for this workspace.";
  }
  return "Approved from chat inline control.";
}

function resolveChatApprovalWorkspaceScopeRef(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  sessionId: string,
): string {
  const payload = approval.payload ?? {};
  const linkageWorkspaceId =
    typeof approval.linkage?.workspaceId === "string" && approval.linkage.workspaceId.trim()
      ? approval.linkage.workspaceId.trim()
      : undefined;
  const metaWorkspaceId = host.storage.chatSessionMeta.get(sessionId)?.workspaceId?.trim();
  const workspaceId =
    linkageWorkspaceId ??
    (typeof payload.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : undefined) ??
    metaWorkspaceId;
  if (!workspaceId) {
    throw new Error(`Approval ${approval.approvalId} is not linked to a workspace.`);
  }
  return host.resolveApprovalHookWorkspaceId({
    ...(payload as Record<string, unknown>),
    workspaceId,
    sessionId,
  });
}

function findExistingGrant(
  host: ApprovalLifecycleHost,
  scope: "session" | "workspace",
  scopeRef: string,
  toolPattern: string,
): ToolGrantRecord | undefined {
  const now = Date.now();
  return host.policyEngine
    .listGrants(scope, scopeRef, 500)
    .find(
      (grant) =>
        grant.decision === "allow" &&
        grant.toolPattern === toolPattern &&
        !grant.revokedAt &&
        (!grant.expiresAt || Date.parse(grant.expiresAt) > now),
    );
}
