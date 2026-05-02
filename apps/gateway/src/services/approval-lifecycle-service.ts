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
    | "runImmediateTransaction"
  >;

  // ── services ───────────────────────────────────────────────────────
  readonly policyEngine: Pick<ToolPolicyEngine, "listGrants" | "createGrant" | "revokeGrant" | "executeApprovedAction">;
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;
  readonly approvalWaitRunService: Pick<
    ApprovalWaitRunService,
    "buildApprovalLinkage" | "buildApprovalRealtimeLinks" | "primeApprovalLifecycle"
  >;

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
    durableRunId: host.storage.approvalWaitRuns.getRunId(approvalId),
    effects: host.storage.approvalEffects.listByApproval(approvalId),
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

  let approval = host.storage.approvals.create(hookableInput);
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

  host.scheduleApprovalExplanation(approval);

  return approval;
}

export async function resolveApproval(
  host: ApprovalLifecycleHost,
  approvalId: string,
  input: ApprovalResolveInput,
): Promise<ApprovalResolveResult> {
  const current = host.storage.approvals.get(approvalId);
  const expiresAt = current.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    throw new ValidationError({
      message: `Approval ${approvalId} has expired and can no longer be resolved.`,
    });
  }
  if (current.kind === DEVICE_ACCESS_APPROVAL_KIND) {
    return host.resolveDeviceAccessApproval(current, input);
  }

  const pendingAction = host.storage.pendingApprovalActions.find(approvalId);

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

    if (input.decision !== "approve" && pendingAction && pendingAction.resolutionStatus === "pending") {
      host.storage.pendingApprovalActions.markResolved(approvalId, "rejected", {
        decision: input.decision,
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

export async function resolveChatToolApproval(
  host: ApprovalLifecycleHost,
  sessionId: string,
  approvalId: string,
  decision: "approve" | "reject",
  options?: {
    allowScope?: "once" | "session" | "workspace";
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
  const allowScope = decision === "approve" ? (options?.allowScope ?? "once") : "once";
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
        createdBy: "chat-operator",
      });
  }
  const resolution = await host.resolveApproval(approvalId, {
    decision,
    resolvedBy: "chat-operator",
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
    resolvedBy: "chat-operator",
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
