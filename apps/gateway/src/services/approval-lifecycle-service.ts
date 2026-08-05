/* eslint-disable max-lines -- Approval lifecycle state and its side effects remain one audited owner during the parity integration. */
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

import { createHash, randomUUID } from "node:crypto";
import {
  APPROVAL_EXPIRY_ACTOR_ID,
  MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND,
  canonicalJsonString,
  assertMeshCapabilityActivationApprovalPayload,
  type ApprovalEffectRecord,
  type ApprovalLinkage,
  type ApprovalListResponse,
  type ApprovalReplayEvent,
  ConflictError,
  type ApprovalBulkResolveInput,
  type ApprovalBulkResolveResult,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type ApprovalResolveInput,
  type DurableWakeResult,
  type RealtimeEvent,
  type ToolGrantCreateInput,
  type ToolGrantRecord,
  type ToolGrantScope,
  type ToolInvokeResult,
  type MeshCapabilityActivationApprovalPayload,
  ValidationError,
} from "@goatcitadel/contracts";
import { DEVICE_ACCESS_APPROVAL_KIND } from "./device-access-helpers.js";
import type { ApprovalReplayResult, ApprovalResolutionContext, ApprovalResolveResult } from "./approval-types.js";
import type { HooksService } from "./hooks-service.js";
import type { ApprovalWaitRunService } from "./approval-wait-run-service.js";
import type { ShellExplainerPolicyConfig } from "../config.js";
import { applyShellExplainerPolicy } from "./shell-command-explainer.js";
import {
  type ApprovalObservabilityEffectInput,
  type ApprovalResolutionEffectEnqueueOptions,
} from "./approval-resolution-effects-service.js";
import { markCodeModeRunTerminalForPendingApproval } from "./approval-code-mode-terminal.js";
import {
  buildApprovalCreatedObservabilityEffects,
  buildApprovalResolutionObservabilityEffects,
} from "./approval-observability.js";
import { buildApprovalResolveResult, withApprovalFollowUp } from "./approval-follow-up.js";
import { parseApprovalCreateHookPatch } from "./hook-patch-helpers.js";
import {
  isOfficialResearchSearchInvocation,
  resolveOfficialSearchProviders,
  type ApprovalCreateAuthority,
  type ToolPolicyEngine,
} from "@goatcitadel/policy-engine";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

export class ApprovalExpiredAfterCommitError extends ValidationError {
  public readonly mutationCommitted = true;

  public constructor(approvalId: string) {
    super({
      message: `Approval ${approvalId} has expired and can no longer be resolved.`,
    });
    this.name = "ApprovalExpiredAfterCommitError";
  }
}

type ApprovalCreateCommitExtension =
  | readonly ApprovalObservabilityEffectInput[]
  | {
      finalize(
        finalApproval: ApprovalRequest,
      ):
        | readonly ApprovalObservabilityEffectInput[]
        | Promise<readonly ApprovalObservabilityEffectInput[] | undefined>
        | undefined;
    }
  | undefined;

export type ApprovalCreateCommitHook = (
  approval: ApprovalRequest,
) => ApprovalCreateCommitExtension | Promise<ApprovalCreateCommitExtension>;

function isApprovalCreateCommitFinalizer(
  value: Awaited<ReturnType<ApprovalCreateCommitHook>>,
): value is Exclude<ApprovalCreateCommitExtension, readonly ApprovalObservabilityEffectInput[] | undefined> {
  return Boolean(value && typeof value === "object" && "finalize" in value);
}

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
    | "approvalWaitRuns"
    | "approvalEffects"
    | "approvalInbox"
    | "remoteActionTokens"
    | "chatDelegationSteps"
    | "chatInlineApprovals"
    | "chatSessionMeta"
    | "chatTurnTraces"
    | "chatToolRuns"
    | "codeModeRuns"
    | "governanceJourneyEvents"
    | "runImmediateTransaction"
  >;

  // ── services ───────────────────────────────────────────────────────
  readonly policyEngine: Pick<
    ToolPolicyEngine,
    "listGrants" | "listActiveGrants" | "createGrant" | "revokeGrant" | "executeApprovedAction"
  >;
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;
  readonly approvalWaitRunService: Pick<
    ApprovalWaitRunService,
    "buildApprovalLinkage" | "reserveApprovalWaitRun" | "primeApprovalLifecycle"
  >;

  // ── config ─────────────────────────────────────────────────────────
  readonly shellExplainerPolicy: ShellExplainerPolicyConfig;

  // ── realtime ───────────────────────────────────────────────────────
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;

  // ── approval-specific gateway methods ──────────────────────────────
  resolveApproval(
    approvalId: string,
    input: ApprovalResolveInput,
    context?: ApprovalResolutionContext,
  ): Promise<ApprovalResolveResult>;
  resolveDeviceAccessApproval(
    current: ApprovalRequest,
    input: ApprovalResolveInput,
    context?: ApprovalResolutionContext,
  ): Promise<ApprovalResolveResult>;
  executeCodeModePendingApproval(approvalId: string, signal?: AbortSignal): Promise<ToolInvokeResult | undefined>;
  resolveApprovalHookWorkspaceId(payload: Record<string, unknown>): Promise<string>;
  scheduleApprovalExplanation(approval: ApprovalRequest): void;
  findProactiveDurableRunIdsForApproval(approvalId: string): Promise<string[]>;
  wakeDurableRun(
    runId: string,
    event: { eventKey: string; payload?: Record<string, unknown>; correlationId?: string },
  ): Promise<DurableWakeResult>;
  enqueueApprovalObservabilityEffects(
    approvalId: string,
    items: readonly ApprovalObservabilityEffectInput[],
  ): Promise<ApprovalEffectRecord[]>;
  enqueueApprovalWaitMaterialization(approval: ApprovalRequest): Promise<ApprovalEffectRecord | undefined>;
  enqueueApprovalResolutionEffects(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
    options?: ApprovalResolutionEffectEnqueueOptions,
  ): Promise<ApprovalEffectRecord[]>;
  requestApprovalEffectProcessing(): void;
  awaitApprovalResolutionEffects(approvalId: string): Promise<ApprovalEffectRecord[]>;
}

export const MESH_CAPABILITY_ACTIVATION_APPROVAL_TTL_MS = 15 * 60_000;

export interface MeshCapabilityActivationApprovalLifecycleHost {
  readonly storage: Pick<Storage, "approvals" | "approvalEvents" | "runImmediateTransaction">;
}

export interface MeshCapabilityActivationApprovalCommitInput {
  approvalId: string;
  payload: MeshCapabilityActivationApprovalPayload;
  preview: Pick<
    MeshCapabilityActivationApprovalPayload,
    "activationId" | "activationRevision" | "capabilityId" | "effectPosture"
  >;
  linkage: Pick<ApprovalLinkage, "workspaceId" | "sessionId" | "turnId"> & { workspaceId: string };
}

export interface MeshCapabilityActivationApprovalCommitResult {
  approval: ApprovalRequest;
  replayed: boolean;
}

/**
 * Commits the production-dark mesh activation approval record and its one
 * canonical creation event. It deliberately performs none of the generic
 * approval lifecycle enrichment, hook, wait-run, or pending-action work.
 */
export async function commitMeshCapabilityActivationApproval(
  host: MeshCapabilityActivationApprovalLifecycleHost,
  input: MeshCapabilityActivationApprovalCommitInput,
): Promise<MeshCapabilityActivationApprovalCommitResult> {
  assertMeshCapabilityActivationApprovalPayload(input.payload);
  assertExactMeshActivationApprovalPreview(input.preview, input.payload);
  assertExactMeshActivationApprovalLinkage(input.linkage, input.payload.workspaceId);

  let result!: MeshCapabilityActivationApprovalCommitResult;
  await host.storage.runImmediateTransaction(async () => {
    const stored = await host.storage.approvals.createDeterministicDetachedWithTtlDuration(
      {
        approvalId: input.approvalId,
        kind: MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND,
        riskLevel: "danger",
        payload: { ...input.payload },
        preview: { ...input.preview },
        linkage: { ...input.linkage },
      },
      MESH_CAPABILITY_ACTIVATION_APPROVAL_TTL_MS,
    );
    const existingEvents = await host.storage.approvalEvents.listByApprovalId(stored.approval.approvalId);
    if (stored.created) {
      if (existingEvents.length !== 0) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `Approval ${stored.approval.approvalId} has inconsistent creation evidence.`,
        });
      }
      await host.storage.approvalEvents.append({
        approvalId: stored.approval.approvalId,
        eventType: "created",
        actorId: "system",
        timestamp: stored.approval.createdAt,
        payload: {
          kind: stored.approval.kind,
          riskLevel: stored.approval.riskLevel,
          status: stored.approval.status,
        },
      });
    } else {
      assertCanonicalMeshActivationCreatedEvent(stored.approval, existingEvents);
    }
    result = { approval: stored.approval, replayed: !stored.created };
  });
  return result;
}

function assertCanonicalMeshActivationCreatedEvent(
  approval: ApprovalRequest,
  events: readonly ApprovalReplayEvent[],
): void {
  const createdEvents = events.filter((event) => event.eventType === "created");
  const created = createdEvents[0];
  const expectedPayload = {
    kind: MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND,
    riskLevel: "danger",
    status: "pending",
  };
  if (
    createdEvents.length !== 1 ||
    !created ||
    created.approvalId !== approval.approvalId ||
    created.actorId !== "system" ||
    created.timestamp !== approval.createdAt ||
    canonicalJsonString(created.payload) !== canonicalJsonString(expectedPayload)
  ) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Approval ${approval.approvalId} has inconsistent creation evidence.`,
    });
  }
}

function assertExactMeshActivationApprovalPreview(
  preview: MeshCapabilityActivationApprovalCommitInput["preview"],
  payload: MeshCapabilityActivationApprovalPayload,
): void {
  assertExactKeys(preview, ["activationId", "activationRevision", "capabilityId", "effectPosture"], "preview");
  if (
    preview.activationId !== payload.activationId ||
    preview.activationRevision !== payload.activationRevision ||
    preview.capabilityId !== payload.capabilityId ||
    preview.effectPosture !== payload.effectPosture
  ) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "preview",
      message: "Mesh capability activation approval preview does not match its exact payload binding.",
    });
  }
}

function assertExactMeshActivationApprovalLinkage(
  linkage: MeshCapabilityActivationApprovalCommitInput["linkage"],
  workspaceId: string,
): void {
  const optionalKeys = ["sessionId", "turnId"].filter((key) => Object.prototype.hasOwnProperty.call(linkage, key));
  assertExactKeys(linkage, ["workspaceId", ...optionalKeys], "linkage");
  if (
    linkage.workspaceId !== workspaceId ||
    optionalKeys.some((key) => typeof linkage[key as "sessionId" | "turnId"] !== "string")
  ) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "linkage",
      message: "Mesh capability activation approval linkage is not exact.",
    });
  }
}

function assertExactKeys(value: unknown, expectedKeys: readonly string[], field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (canonicalJsonString(actualKeys) !== canonicalJsonString(sortedExpected)) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field,
      message: `Mesh capability activation approval ${field} has an invalid key set.`,
    });
  }
}

export async function listToolGrants(
  host: ApprovalLifecycleHost,
  scope?: ToolGrantScope,
  scopeRef?: string,
  limit = 200,
): Promise<ToolGrantRecord[]> {
  return host.policyEngine.listGrants(scope, scopeRef, limit);
}

export async function createToolGrant(
  host: ApprovalLifecycleHost,
  input: ToolGrantCreateInput,
): Promise<ToolGrantRecord> {
  const grant = await host.policyEngine.createGrant(input);
  try {
    await host.publishRealtime("system", "tools", {
      type: "tool_grant_created",
      grantId: grant.grantId,
      toolPattern: grant.toolPattern,
      decision: grant.decision,
      scope: grant.scope,
      scopeRef: grant.scopeRef,
      expiresAt: grant.expiresAt,
    });
  } catch (realtimeError) {
    void realtimeError;
    // The policy mutation is canonical; realtime is an advisory projection.
  }
  return grant;
}

export async function revokeToolGrant(
  host: ApprovalLifecycleHost,
  grantId: string,
  revokedBy: string,
): Promise<boolean> {
  if (!revokedBy.trim()) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "revokedBy" });
  }
  const revoked = await host.policyEngine.revokeGrant(grantId, revokedBy);
  if (revoked) {
    try {
      await host.publishRealtime("system", "tools", {
        type: "tool_grant_revoked",
        grantId,
        revokedBy,
      });
    } catch (realtimeError) {
      void realtimeError;
      // The policy mutation is canonical; realtime is an advisory projection.
    }
  }
  return revoked;
}

export async function listApprovals(
  host: ApprovalLifecycleHost,
  status?: ApprovalRequest["status"],
  limit = 100,
  workspaceId?: string,
): Promise<ApprovalRequest[]> {
  const approvals = await host.storage.approvals.list(status, limit, workspaceId);
  return Promise.all(
    approvals.map(async (approval) =>
      withApprovalFollowUp(approval, await host.storage.approvalEffects.listByApproval(approval.approvalId)),
    ),
  );
}

export async function listApprovalsPage(
  host: ApprovalLifecycleHost,
  input: {
    status?: ApprovalRequest["status"];
    limit?: number;
    cursor?: string;
    workspaceId?: string;
  },
): Promise<ApprovalListResponse> {
  const page = await host.storage.approvals.listPage(input);
  return {
    items: await Promise.all(
      page.items.map(async (approval) =>
        withApprovalFollowUp(approval, await host.storage.approvalEffects.listByApproval(approval.approvalId)),
      ),
    ),
    nextCursor: page.nextCursor,
  };
}

interface ApprovalExpirationContext {
  requestedDecision?: ApprovalResolveInput["decision"];
  reason: string;
}

interface ApprovalExpirationOutcome {
  approval: ApprovalRequest;
  committed: boolean;
}

export async function expirePendingApprovals(host: ApprovalLifecycleHost, limit = 100): Promise<number> {
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 100;
  const candidates = await host.storage.approvals.listExpiredPending(
    undefined,
    boundedLimit,
    DEVICE_ACCESS_APPROVAL_KIND,
  );
  let committed = 0;
  let firstFailure: { error: unknown } | undefined;
  for (const approval of candidates) {
    try {
      if ((await reconcileExpiredApproval(host, approval)).committed) {
        committed += 1;
      }
    } catch (error) {
      firstFailure ??= { error };
    }
  }
  if (firstFailure) {
    throw firstFailure.error;
  }
  return committed;
}

async function reconcileExpiredApproval(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  context?: Pick<ApprovalExpirationContext, "requestedDecision">,
): Promise<ApprovalExpirationOutcome> {
  const approvals = host.storage.approvals;
  if (approval.status !== "pending" || !(await approvals.isExpiredPendingAtDatabaseNow(approval.approvalId))) {
    return { approval, committed: false };
  }

  let outcome!: ApprovalExpirationOutcome;
  try {
    await host.storage.runImmediateTransaction(async () => {
      const current = await approvals.get(approval.approvalId);
      if (current.status !== "pending" || !(await approvals.isExpiredPendingAtDatabaseNow(current.approvalId))) {
        outcome = { approval: current, committed: false };
        return;
      }
      const reason = `Approval ${approval.approvalId} expired before operator resolution.`;
      outcome = {
        approval: (
          await commitExpiredApprovalResolution(host, current, {
            requestedDecision: context?.requestedDecision,
            reason,
          })
        ).approval,
        committed: true,
      };
    });
  } catch (error) {
    if (!(error instanceof ConflictError)) {
      throw error;
    }
    const latest = await approvals.get(approval.approvalId);
    if (latest.status === "pending") {
      throw error;
    }
    return { approval: latest, committed: false };
  }
  return outcome;
}

export async function getApprovalReplay(
  host: ApprovalLifecycleHost,
  approvalId: string,
  replayedBy = "operator",
): Promise<ApprovalReplayResult> {
  const storedApproval = await host.storage.approvals.get(approvalId);
  const effects = await host.storage.approvalEffects.listByApproval(approvalId);
  const approval = withApprovalFollowUp(storedApproval, effects);

  await host.storage.approvalEvents.append({
    approvalId,
    eventType: "replayed",
    actorId: replayedBy,
    payload: {
      status: approval.status,
    },
  });

  return {
    approval,
    events: await host.storage.approvalEvents.listByApprovalId(approvalId),
    pendingAction: await host.storage.pendingApprovalActions.find(approvalId),
    durableRunId: await host.storage.approvalWaitRuns.getRunId(approvalId),
    effects,
  };
}

export async function resolveApprovalsBulk(
  host: ApprovalLifecycleHost,
  input: ApprovalBulkResolveInput,
): Promise<ApprovalBulkResolveResult> {
  const statusFilter = input.status ?? "pending";
  const items = await host.storage.approvals.list(statusFilter, 10_000);
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
          status = (await host.storage.approvals.get(approval.approvalId)).status;
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
  onCreated?: ApprovalCreateCommitHook,
  authority?: ApprovalCreateAuthority,
): Promise<ApprovalRequest> {
  const approvalHookWorkspaceId = await host.resolveApprovalHookWorkspaceId({
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
  const approvalLinkage = host.approvalWaitRunService.buildApprovalLinkage(hookableInput.linkage);
  const transactionalCreateInput = approvalLinkage ? { ...createInput, linkage: approvalLinkage } : createInput;

  let approval!: ApprovalRequest;
  await host.storage.runImmediateTransaction(async () => {
    approval =
      authority?.ttlMs !== undefined
        ? await host.storage.approvals.createWithTtlDuration(transactionalCreateInput, authority.ttlMs)
        : await host.storage.approvals.create(transactionalCreateInput);
    if (policyOutcome.explanations.length > 0) {
      await host.storage.approvals.setShellExplanations(approval.approvalId, policyOutcome.explanations);
      approval = await host.storage.approvals.get(approval.approvalId);
    }
    await host.storage.approvalEvents.append({
      approvalId: approval.approvalId,
      eventType: "created",
      actorId: "system",
      payload: {
        kind: approval.kind,
        riskLevel: approval.riskLevel,
        status: approval.status,
      },
    });

    if (!policyOutcome.autoReject) {
      approval = await host.approvalWaitRunService.reserveApprovalWaitRun(approval);
      await host.enqueueApprovalWaitMaterialization(approval);
    }

    const creationExtension = await onCreated?.(approval);
    const immediateExtensionObservability = Array.isArray(creationExtension) ? creationExtension : [];
    await host.enqueueApprovalObservabilityEffects(approval.approvalId, [
      ...buildApprovalCreatedObservabilityEffects(approval),
      ...immediateExtensionObservability,
    ]);

    if (policyOutcome.autoReject) {
      const resolution = await commitStandardApprovalResolution(host, approval.approvalId, {
        decision: "reject",
        resolvedBy: "system",
        resolutionNote: policyOutcome.autoRejectReason ?? "Auto-rejected by shell danger policy.",
      });
      approval = resolution.approval;
    }
    if (isApprovalCreateCommitFinalizer(creationExtension)) {
      const finalizedObservability = (await creationExtension.finalize(approval)) ?? [];
      if (finalizedObservability.length > 0) {
        await host.enqueueApprovalObservabilityEffects(approval.approvalId, finalizedObservability);
      }
    }
  });
  host.requestApprovalEffectProcessing();

  if (!policyOutcome.autoReject) {
    try {
      approval = await host.approvalWaitRunService.primeApprovalLifecycle(approval.approvalId, approvalLinkage);
    } catch {
      // The approval and its observability envelope are already committed.
      // Durable wait-run priming is recoverable and must not revive creation.
      approval = await host.storage.approvals.get(approval.approvalId);
    }
    try {
      host.scheduleApprovalExplanation(approval);
    } catch {
      // Creation is already committed. Explanation scheduling is advisory and
      // must never turn durable success into an API failure.
    }
  }

  return approval;
}

export async function resolveApproval(
  host: ApprovalLifecycleHost,
  approvalId: string,
  input: ApprovalResolveInput,
  context?: ApprovalResolutionContext,
): Promise<ApprovalResolveResult> {
  const storage = host.storage;
  const initial = await storage.approvals.get(approvalId);
  if (initial.status !== "pending") {
    throw new ConflictError({
      message: `Approval ${approvalId} is already resolved`,
    });
  }
  if (initial.kind === DEVICE_ACCESS_APPROVAL_KIND) {
    return host.resolveDeviceAccessApproval(initial, input, context);
  }
  let result: ApprovalResolveResult | undefined;
  let expiredMutationCommitted = false;
  try {
    await storage.runImmediateTransaction(async () => {
      const current = await storage.approvals.get(approvalId);
      if (current.status !== "pending") {
        throw new ConflictError({
          message: `Approval ${approvalId} is already resolved`,
        });
      }
      if (context?.remoteToken) {
        await storage.approvals.mergeLinkage(approvalId, {
          connectorId: context.remoteToken.connectorId,
          tokenId: context.remoteToken.tokenId,
        });
      }
      result = await commitStandardApprovalResolution(host, approvalId, input);
    });
  } catch (error) {
    if (!isApprovalExpiryConflict(error, approvalId)) {
      throw error;
    }
    // The database rejected an operator decision at its own expiry boundary.
    // Reconcile that still-pending request as an explicit system rejection.
    result = undefined;
    const expiration = await reconcileExpiredApproval(host, await storage.approvals.get(approvalId), {
      requestedDecision: input.decision,
    });
    if (!expiration.committed) {
      throw new ConflictError({
        message: `Approval ${approvalId} was resolved while its expiry boundary was being reconciled.`,
      });
    }
    expiredMutationCommitted = true;
  }
  if (!result) {
    if (expiredMutationCommitted) {
      throw new ApprovalExpiredAfterCommitError(approvalId);
    }
    throw new ValidationError({
      message: `Approval ${approvalId} has expired and can no longer be resolved.`,
    });
  }
  host.requestApprovalEffectProcessing();
  try {
    const settledEffects = await host.awaitApprovalResolutionEffects(approvalId);
    return buildApprovalResolveResult(storage, await storage.approvals.get(approvalId), settledEffects);
  } catch (error) {
    // Canonical resolution is already committed. A bounded read-after-commit
    // settlement failure must leave the durable follow-up pending instead of
    // turning committed success into a retryable API mutation.
    try {
      await host.publishRealtime("approval_effect_settlement_failed", "approvals", {
        approvalId,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (diagnosticError) {
      void diagnosticError;
      // The effect ledger remains the recovery authority when diagnostics fail.
    }
    return result;
  }
}

function isApprovalExpiryConflict(error: unknown, approvalId: string): error is ConflictError {
  return (
    error instanceof ConflictError &&
    error.details?.reason === "approval_expired" &&
    error.details.approvalId === approvalId
  );
}

async function commitExpiredApprovalResolution(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  expiration: ApprovalExpirationContext,
): Promise<ApprovalResolveResult> {
  const input: ApprovalResolveInput = {
    decision: "reject",
    resolvedBy: APPROVAL_EXPIRY_ACTOR_ID,
    resolutionNote: expiration.reason,
  };
  return commitStandardApprovalResolution(host, approval.approvalId, input, {
    allowExpired: true,
    expiration,
  });
}

async function commitStandardApprovalResolution(
  host: ApprovalLifecycleHost,
  approvalId: string,
  input: ApprovalResolveInput,
  options: {
    allowExpired?: boolean;
    expiration?: ApprovalExpirationContext;
  } = {},
): Promise<ApprovalResolveResult> {
  const storage = host.storage;
  const current = await storage.approvals.get(approvalId);
  if (current.status !== "pending") {
    throw new ConflictError({
      message: `Approval ${approvalId} is already resolved`,
    });
  }
  if (current.kind === DEVICE_ACCESS_APPROVAL_KIND) {
    throw new ValidationError({
      message: "Device-access approvals must be resolved through the device-access transaction owner.",
    });
  }
  if (current.kind === "code_mode.run" && input.decision === "edit") {
    throw new ValidationError({
      message: "Code Mode approvals are immutable; reject this run and create a new one with edited input.",
    });
  }
  if (current.kind === MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND && input.decision === "edit") {
    throw new ValidationError({
      message:
        "Mesh capability activation approvals bind one exact immutable request; reject and request a new activation instead of editing.",
    });
  }

  const pendingAction = await storage.pendingApprovalActions.find(approvalId);
  const approval = await storage.approvals.resolve(
    approvalId,
    input,
    options.allowExpired ? { allowExpired: true } : undefined,
  );
  const expiredRemoteTokenCount = await storage.remoteActionTokens.expirePendingByApprovalId(approvalId);

  const resolutionEvent = await storage.approvalEvents.append({
    approvalId,
    eventType: "resolved",
    actorId: input.resolvedBy,
    payload: {
      decision: input.decision,
      status: approval.status,
      editedPayload: input.editedPayload,
      expiredRemoteTokenCount,
      ...(options.expiration
        ? {
            expired: true,
            requestedDecision: options.expiration.requestedDecision,
            expiresAt: approval.expiresAt,
            reason: options.expiration.reason,
          }
        : {}),
    },
  });

  await recordApprovalResolutionJourney(storage, approval, input, resolutionEvent, options.expiration);

  await markChatInlineApprovalResolved(host, approval, input);

  if (options.expiration && pendingAction?.resolutionStatus === "pending") {
    const terminalizedCodeModeRun = await markCodeModeRunTerminalForPendingApproval(
      host,
      approval,
      pendingAction,
      "expired",
      {
        decision: "reject",
        expired: true,
        requestedDecision: options.expiration.requestedDecision,
        reason: options.expiration.reason,
      },
    );
    if (!terminalizedCodeModeRun) {
      await storage.pendingApprovalActions.markResolved(approvalId, "rejected", {
        decision: "reject",
        expired: true,
        requestedDecision: options.expiration.requestedDecision,
        reason: options.expiration.reason,
      });
      await storage.approvalEvents.append({
        approvalId,
        eventType: "pending_action_refused",
        actorId: APPROVAL_EXPIRY_ACTOR_ID,
        payload: {
          actionType: pendingAction.actionType,
          decision: "reject",
          expired: true,
          requestedDecision: options.expiration.requestedDecision,
          reason: options.expiration.reason,
        },
      });
    }
  } else if (input.decision !== "approve" && pendingAction && pendingAction.resolutionStatus === "pending") {
    const terminalizedCodeModeRun = await markCodeModeRunTerminalForPendingApproval(
      host,
      approval,
      pendingAction,
      "rejected",
      {
        decision: input.decision,
        reason: `Approval ${approvalId} resolved with ${input.decision}.`,
      },
    );
    await storage.pendingApprovalActions.markResolved(approvalId, "rejected", {
      decision: input.decision,
      ...(terminalizedCodeModeRun?.runId ? { runId: terminalizedCodeModeRun.runId } : {}),
      ...(terminalizedCodeModeRun?.pendingRunId !== undefined
        ? { pendingRunId: terminalizedCodeModeRun.pendingRunId }
        : {}),
    });
  }

  if (options.allowExpired) {
    await host.enqueueApprovalResolutionEffects(approval, input, { allowExpired: true });
  } else {
    await host.enqueueApprovalResolutionEffects(approval, input);
  }
  await host.enqueueApprovalObservabilityEffects(
    approval.approvalId,
    buildApprovalResolutionObservabilityEffects(approval, input),
  );

  const effects = await storage.approvalEffects.listByApproval(approvalId);
  return await buildApprovalResolveResult(storage, approval, effects);
}

async function recordApprovalResolutionJourney(
  storage: ApprovalLifecycleHost["storage"],
  approval: ApprovalRequest,
  input: ApprovalResolveInput,
  sourceEvent: ApprovalReplayEvent,
  expiration?: ApprovalExpirationContext,
): Promise<void> {
  const workspaceId = asJourneyIdentifier(approval.linkage?.workspaceId);
  if (!workspaceId) {
    // Legacy approval paths can lack workspace ownership. Never relabel those
    // decisions as `default` or globally visible just to fill the projection.
    return;
  }

  const action = expiration ? "expired" : `resolved_${approval.status}`;
  const eventId = `approval:journey:${sourceEvent.eventId}`;
  const fingerprint = createHash("sha256")
    .update(
      canonicalJsonString({
        action,
        actorId: sourceEvent.actorId,
        approvalId: approval.approvalId,
        sourceEventId: sourceEvent.eventId,
        sourceTimestamp: sourceEvent.timestamp,
        status: approval.status,
        workspaceId,
      }),
      "utf8",
    )
    .digest("hex");

  await storage.governanceJourneyEvents.create({
    schemaVersion: "goatcitadel.journey-event.v1",
    eventId,
    idempotencyKey: `approval:lifecycle:${sourceEvent.eventId}`,
    scopeKind: "workspace",
    workspaceId,
    eventType: "approval_lifecycle",
    subjectKind: "approval",
    subjectId: approval.approvalId,
    action,
    actorId: sourceEvent.actorId,
    actorType: isSystemActor(sourceEvent.actorId) ? "system" : "operator",
    sessionId: asJourneyIdentifier(approval.linkage?.sessionId),
    turnId: asJourneyIdentifier(approval.linkage?.turnId),
    approvalId: approval.approvalId,
    fingerprint,
    sourceKind: "approval_event",
    sourceId: sourceEvent.eventId,
    trustDisposition: expiration ? "expired" : approval.status,
    poisoningStatus: "clean",
    evidenceRefs: [{ owner: "approval", refId: approval.approvalId }],
    provenance: {
      sourceRequired: true,
      approvalRequired: false,
      ...approvalJourneyLinkageProvenance(approval),
    },
    summary: {
      decision: expiration ? "expired" : input.decision,
      status: approval.status,
      expired: Boolean(expiration),
    },
    occurredAt: sourceEvent.timestamp,
    recordedAt: sourceEvent.timestamp,
  });
}

function approvalJourneyLinkageProvenance(approval: ApprovalRequest): Record<string, string> {
  const provenance: Record<string, string> = {};
  for (const key of ["taskId", "runId", "durableRunId", "correlationId", "traceId"] as const) {
    const value = asJourneyIdentifier(approval.linkage?.[key]);
    if (value) provenance[key] = value;
  }
  return provenance;
}

function asJourneyIdentifier(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 ? value : undefined;
}

function isSystemActor(actorId: string): boolean {
  return actorId === "system" || actorId.startsWith("system:");
}

async function markChatInlineApprovalResolved(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  input: ApprovalResolveInput,
): Promise<void> {
  const inlineApproval = await host.storage.chatInlineApprovals.get(approval.approvalId);
  if (!inlineApproval || inlineApproval.status !== "pending") {
    return;
  }
  const approved = input.decision === "approve" || input.decision === "edit";
  await host.storage.chatInlineApprovals.upsert({
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

function isCodeModeApproval(approval: ApprovalRequest): boolean {
  if (approval.kind === "code_mode.run") {
    return true;
  }
  return (
    typeof approval.payload.codeHash === "string" ||
    typeof approval.payload.wrapperManifestHash === "string" ||
    typeof approval.payload.capabilitySnapshotId === "string"
  );
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
  grantError?: string;
  resumed: boolean;
  resumedTurnId?: string;
  resumedRunId?: string;
}> {
  const approval = await host.storage.approvals.get(approvalId);
  const approvalSessionId = typeof approval.payload.sessionId === "string" ? approval.payload.sessionId : undefined;
  if (approvalSessionId && approvalSessionId !== sessionId) {
    throw new Error(`Approval ${approvalId} does not belong to session ${sessionId}.`);
  }
  const existingInlineApproval = await host.storage.chatInlineApprovals.get(approvalId);
  if (existingInlineApproval && existingInlineApproval.sessionId !== sessionId) {
    throw new Error(`Approval ${approvalId} does not belong to session ${sessionId}.`);
  }
  const turn = (await host.storage.chatToolRuns.listBySession(sessionId, 2000)).find(
    (toolRun) => toolRun.approvalId === approvalId,
  );
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
  const requestedAllowScope = decision === "approve" ? (options?.allowScope ?? "once") : "once";
  const allowScope = decision === "approve" && isCodeModeApproval(approval) ? "once" : requestedAllowScope;
  const resolvedBy = options?.resolvedBy?.trim() || "operator";
  const toolPattern = turn?.toolName ?? existingInlineApproval?.toolName ?? approval.kind;
  let grant: ToolGrantRecord | undefined;
  let grantError: string | undefined;
  const persistentGrantScope =
    decision === "approve" && allowScope !== "once"
      ? allowScope === "workspace"
        ? ("workspace" as const)
        : ("session" as const)
      : undefined;
  if (persistentGrantScope && !toolPattern?.trim()) {
    throw new Error(`Approval ${approvalId} does not expose a tool pattern for persistent allow.`);
  }
  const officialSearchAllowedHosts = persistentGrantScope
    ? resolveOfficialSearchApprovalGrantHosts(approval, toolPattern)
    : undefined;
  const resolution = await host.resolveApproval(approvalId, {
    decision,
    resolvedBy,
    resolutionNote: buildChatApprovalResolutionNote(decision, allowScope),
  });
  let persistentGrantRequest:
    | {
        scope: "session" | "workspace";
        scopeRefs: string[];
      }
    | undefined;
  if (persistentGrantScope) {
    try {
      persistentGrantRequest = {
        scope: persistentGrantScope,
        scopeRefs:
          persistentGrantScope === "workspace"
            ? [await resolveChatApprovalWorkspaceScopeRef(host, resolution.approval, sessionId)]
            : await resolveChatApprovalSessionGrantScopeRefs(host, resolution.approval, sessionId),
      };
    } catch (error) {
      grantError = error instanceof Error ? error.message : String(error);
    }
  }
  if (persistentGrantRequest) {
    for (const scopeRef of persistentGrantRequest.scopeRefs) {
      try {
        const nextGrant =
          (await findExistingGrant(
            host,
            persistentGrantRequest.scope,
            scopeRef,
            toolPattern,
            officialSearchAllowedHosts,
          )) ??
          (await createToolGrant(host, {
            toolPattern,
            decision: "allow",
            scope: persistentGrantRequest.scope,
            scopeRef,
            grantType: "persistent",
            createdBy: resolvedBy,
            ...(officialSearchAllowedHosts ? { constraints: { allowedHosts: officialSearchAllowedHosts } } : {}),
          }));
        grant ??= nextGrant;
      } catch (error) {
        const recoveredGrant = await findExistingGrant(
          host,
          persistentGrantRequest.scope,
          scopeRef,
          toolPattern,
          officialSearchAllowedHosts,
        );
        if (recoveredGrant) {
          grant ??= recoveredGrant;
          continue;
        }
        grantError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
  }
  const resume = resolution.resolutionEffects?.chatTurnResume ?? { resumed: false as const };
  try {
    await host.storage.chatInlineApprovals.upsert({
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
        ...(grantError ? { grantError } : {}),
      },
    });
  } catch {
    // Canonical approval resolution already updated the inline status in the
    // winning transaction. Grant-detail projection is advisory after commit
    // and must not revive the request idempotency key or report false failure.
  }
  return {
    allowScope,
    grant,
    ...(grantError ? { grantError } : {}),
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

async function resolveChatApprovalSessionGrantScopeRefs(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  sessionId: string,
): Promise<string[]> {
  const scopeRefs = new Set<string>([sessionId]);
  const workspaceId =
    typeof approval.linkage?.workspaceId === "string" && approval.linkage.workspaceId.trim()
      ? approval.linkage.workspaceId.trim()
      : undefined;
  try {
    const parent = (
      await host.storage.chatDelegationSteps?.listParentsByChildSessionIds([sessionId], workspaceId)
    )?.get(sessionId);
    if (parent?.parentSessionId?.trim()) {
      scopeRefs.add(parent.parentSessionId.trim());
    }
  } catch {
    // Delegation lineage is best-effort for grant widening; the child-session grant remains authoritative.
  }
  return [...scopeRefs];
}

async function resolveChatApprovalWorkspaceScopeRef(
  host: ApprovalLifecycleHost,
  approval: ApprovalRequest,
  sessionId: string,
): Promise<string> {
  const payload = approval.payload ?? {};
  const linkageWorkspaceId =
    typeof approval.linkage?.workspaceId === "string" && approval.linkage.workspaceId.trim()
      ? approval.linkage.workspaceId.trim()
      : undefined;
  const metaWorkspaceId = (await host.storage.chatSessionMeta.get(sessionId))?.workspaceId?.trim();
  const workspaceId =
    linkageWorkspaceId ??
    (typeof payload.workspaceId === "string" && payload.workspaceId.trim() ? payload.workspaceId.trim() : undefined) ??
    metaWorkspaceId;
  if (!workspaceId) {
    throw new Error(`Approval ${approval.approvalId} is not linked to a workspace.`);
  }
  return await host.resolveApprovalHookWorkspaceId({
    ...(payload as Record<string, unknown>),
    workspaceId,
    sessionId,
  });
}

async function findExistingGrant(
  host: ApprovalLifecycleHost,
  scope: "session" | "workspace",
  scopeRef: string,
  toolPattern: string,
  exactAllowedHosts?: string[],
): Promise<ToolGrantRecord | undefined> {
  return (await host.policyEngine.listActiveGrants(scope, scopeRef, 500)).find(
    (grant) =>
      grant.decision === "allow" &&
      grant.toolPattern === toolPattern &&
      (exactAllowedHosts === undefined ||
        haveSameExactHostSet(grant.constraints?.allowedHosts ?? [], exactAllowedHosts)),
  );
}

function resolveOfficialSearchApprovalGrantHosts(approval: ApprovalRequest, toolPattern: string): string[] | undefined {
  if (approval.kind !== "browser.search" || toolPattern !== "browser.search") {
    return undefined;
  }
  if (!isOfficialResearchSearchInvocation(approval.payload)) {
    return undefined;
  }
  const providers = resolveOfficialSearchProviders(approval.payload);
  const hosts = providers.map((provider) => (provider === "brave" ? "api.search.brave.com" : "api.parallel.ai"));
  if (hosts.length === 0) {
    throw new Error(`Approval ${approval.approvalId} does not select a supported official search provider.`);
  }
  return [...new Set(hosts)].sort();
}

function haveSameExactHostSet(left: string[], right: string[]): boolean {
  const normalize = (values: string[]) =>
    [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}
