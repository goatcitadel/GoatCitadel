import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  ChatCompactionBreakerApprovalCreateRequest,
  ChatCompactionBreakerApprovalCreateResponse,
  ChatCompactionBreakerActionCreateRequest,
  ChatCompactionBreakerActionRecord,
  ChatCompactionBreakerRepairResponse,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

const DEFAULT_ACTION_TTL_SECONDS = 120;
export const CHAT_COMPACTION_BREAKER_MIN_ACTION_TTL_SECONDS = 30;
export const CHAT_COMPACTION_BREAKER_MAX_ACTION_TTL_SECONDS = 300;
const MAX_RECOVERY_REASON_LENGTH = 512;

export const CHAT_COMPACTION_BREAKER_APPROVAL_SCHEMA_VERSION = "chat_compaction_breaker_approval.v1" as const;

type ActionRepository = Pick<
  AsyncStorage["chatConversationSummaries"],
  | "getCompactionBreaker"
  | "createCompactionBreakerAction"
  | "getCompactionBreakerAction"
  | "findPendingCompactionBreakerForceAction"
  | "consumeCompactionBreakerRepairAction"
>;

export interface ChatCompactionBreakerGovernanceDecision {
  decision: "allow" | "deny" | "require_approval";
  decisionId: string;
  approvalId?: string;
  approvalStatus?: "approved" | "pending" | "denied" | "expired" | "revoked";
  approvalBindingHash?: string;
}

export interface ChatCompactionBreakerGovernancePort {
  authorize(input: {
    actionId: string;
    sessionId: string;
    dimensionHash: string;
    actionKind: "force" | "repair";
    expectedBreakerRevision: number;
    actorHash: string;
    reason: string;
    requestedApprovalId?: string;
    requestEvidenceHash: string;
    expectedApprovalBindingHash: string;
  }): Promise<ChatCompactionBreakerGovernanceDecision>;
}

export interface ChatCompactionBreakerAuditPort {
  append(input: {
    eventKind: "chat.compaction_breaker.action_requested";
    actionId: string;
    sessionId: string;
    dimensionHash: string;
    actionKind: "force" | "repair";
    expectedBreakerRevision: number;
    actorHash: string;
    requestEvidenceHash: string;
    policyDecisionHash: string;
    approvalId?: string;
    actionStatus: "pending" | "rejected";
    rejectionReason?: string;
  }): Promise<{ committed: boolean; receiptId?: string }>;
}

export interface ChatCompactionBreakerApprovalPort {
  create(input: ApprovalCreateInput, authority?: { ttlMs: number }): Promise<ApprovalRequest>;
}

export interface ChatCompactionBreakerActionServiceDependencies {
  repository: ActionRepository;
  governance: ChatCompactionBreakerGovernancePort;
  audit: ChatCompactionBreakerAuditPort;
  approvals: ChatCompactionBreakerApprovalPort;
  resolveSessionWorkspaceId(sessionId: string): Promise<string>;
  isUseAuthorized(input: { action: ChatCompactionBreakerActionRecord; observedAt: string }): Promise<boolean>;
  now?: () => Date;
  createActionId?: () => string;
}

export class ChatCompactionBreakerActionService {
  private readonly now: () => Date;
  private readonly createActionId: () => string;

  public constructor(private readonly dependencies: ChatCompactionBreakerActionServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.createActionId = dependencies.createActionId ?? (() => randomUUID());
  }

  public async createAction(input: {
    sessionId: string;
    actorId: string;
    request: ChatCompactionBreakerActionCreateRequest;
  }): Promise<ChatCompactionBreakerActionRecord> {
    const actorHash = hashActorId(input.actorId);
    await this.requireRecoveryBreakerState(input.sessionId, input.request);
    const actionId = this.createActionId();
    const createdAt = this.now().toISOString();
    const ttlSeconds = normalizeActionTtl(input.request.expiresInSeconds);
    const expiresAt = new Date(Date.parse(createdAt) + ttlSeconds * 1_000).toISOString();
    const reason = normalizeRecoveryReason(input.request.reason);
    const binding = {
      version: 1,
      actionId,
      sessionId: input.sessionId,
      dimensionHash: input.request.dimensionHash,
      actionKind: input.request.actionKind,
      expectedBreakerRevision: input.request.expectedBreakerRevision,
      actorHash,
      reason,
      approvalId: input.request.approvalId ?? null,
      createdAt,
      expiresAt,
    } as const;
    const requestEvidenceHash = hashEvidence("request", binding);
    const expectedApprovalBindingHash = hashEvidence("approval-binding", {
      version: 1,
      sessionId: input.sessionId,
      dimensionHash: input.request.dimensionHash,
      actionKind: input.request.actionKind,
      expectedBreakerRevision: input.request.expectedBreakerRevision,
      actorHash,
      reason,
    });
    const decision = await this.dependencies.governance.authorize({
      actionId,
      sessionId: input.sessionId,
      dimensionHash: input.request.dimensionHash,
      actionKind: input.request.actionKind,
      expectedBreakerRevision: input.request.expectedBreakerRevision,
      actorHash,
      reason,
      ...(input.request.approvalId ? { requestedApprovalId: input.request.approvalId } : {}),
      requestEvidenceHash,
      expectedApprovalBindingHash,
    });
    const policyDecisionHash = hashEvidence("policy", {
      version: 1,
      requestEvidenceHash,
      sessionId: input.sessionId,
      dimensionHash: input.request.dimensionHash,
      actionKind: input.request.actionKind,
      expectedBreakerRevision: input.request.expectedBreakerRevision,
      actorHash,
      decision: decision.decision,
      decisionId: decision.decisionId,
      approvalId: decision.approvalId ?? null,
      approvalStatus: decision.approvalStatus ?? null,
      approvalBindingHash: decision.approvalBindingHash ?? null,
    });
    const rejectionReason = resolveGovernanceRejection({
      requestedApprovalId: input.request.approvalId,
      expectedApprovalBindingHash,
      decision,
    });
    const status = rejectionReason ? ("rejected" as const) : ("pending" as const);
    const approvalId = status === "pending" ? decision.approvalId : input.request.approvalId;
    const auditReceipt = await this.dependencies.audit.append({
      eventKind: "chat.compaction_breaker.action_requested",
      actionId,
      sessionId: input.sessionId,
      dimensionHash: input.request.dimensionHash,
      actionKind: input.request.actionKind,
      expectedBreakerRevision: input.request.expectedBreakerRevision,
      actorHash,
      requestEvidenceHash,
      policyDecisionHash,
      ...(approvalId ? { approvalId } : {}),
      actionStatus: status,
      ...(rejectionReason ? { rejectionReason } : {}),
    });
    if (!auditReceipt.committed || !auditReceipt.receiptId?.trim()) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Compaction breaker action was not persisted because its audit receipt did not commit",
      });
    }
    const auditEvidenceHash = hashEvidence("audit", {
      version: 1,
      requestEvidenceHash,
      policyDecisionHash,
      actionId,
      sessionId: input.sessionId,
      dimensionHash: input.request.dimensionHash,
      actionKind: input.request.actionKind,
      expectedBreakerRevision: input.request.expectedBreakerRevision,
      actorHash,
      status,
      rejectionReason: rejectionReason ?? null,
      receiptId: auditReceipt.receiptId,
    });
    return await this.dependencies.repository.createCompactionBreakerAction({
      actionId,
      sessionId: input.sessionId,
      dimensionHash: input.request.dimensionHash,
      actionKind: input.request.actionKind,
      expectedBreakerRevision: input.request.expectedBreakerRevision,
      actorHash,
      requestEvidenceHash,
      policyDecisionHash,
      auditEvidenceHash,
      ...(approvalId ? { approvalId } : {}),
      reason,
      status,
      ...(rejectionReason ? { rejectionReason } : {}),
      createdAt,
      expiresAt,
    });
  }

  public async requestApproval(input: {
    sessionId: string;
    actorId: string;
    request: ChatCompactionBreakerApprovalCreateRequest;
  }): Promise<ChatCompactionBreakerApprovalCreateResponse> {
    const actorHash = hashActorId(input.actorId);
    await this.requireRecoveryBreakerState(input.sessionId, input.request);
    const workspaceId = await this.dependencies.resolveSessionWorkspaceId(input.sessionId);
    const reason = normalizeRecoveryReason(input.request.reason);
    const ttlSeconds = normalizeActionTtl(input.request.expiresInSeconds);
    const ttlMs = ttlSeconds * 1_000;
    const approvalBindingHash = buildChatCompactionBreakerApprovalBindingHashFromActorHash({
      sessionId: input.sessionId,
      dimensionHash: input.request.dimensionHash,
      actionKind: input.request.actionKind,
      expectedBreakerRevision: input.request.expectedBreakerRevision,
      actorHash,
      reason,
    });
    const payload = {
      schemaVersion: CHAT_COMPACTION_BREAKER_APPROVAL_SCHEMA_VERSION,
      sessionId: input.sessionId,
      dimensionHash: input.request.dimensionHash,
      actionKind: input.request.actionKind,
      expectedBreakerRevision: input.request.expectedBreakerRevision,
      actorHash,
      reason,
      approvalBindingHash,
    } as const;
    const approval = await this.dependencies.approvals.create(
      {
        kind: "chat_compaction_breaker_recovery",
        riskLevel: "danger",
        payload,
        preview: {
          title: `${input.request.actionKind === "force" ? "Force" : "Repair"} chat compaction breaker`,
          ...payload,
          expiresInSeconds: ttlSeconds,
          rollbackNote:
            "Approval only authorizes one short-lived recovery action; no breaker mutation occurs until the bound action is created and consumed.",
        },
        linkage: {
          sessionId: input.sessionId,
          workspaceId,
          actionType: `chat_compaction_breaker_${input.request.actionKind}`,
        },
      },
      { ttlMs },
    );
    assertCanonicalRecoveryApproval(approval, {
      payload,
      ttlMs,
      linkage: {
        sessionId: input.sessionId,
        workspaceId,
        actionType: `chat_compaction_breaker_${input.request.actionKind}`,
      },
    });
    return { approval, approvalBindingHash };
  }

  public async inspectAction(input: {
    sessionId: string;
    actionId: string;
    actorId: string;
  }): Promise<ChatCompactionBreakerActionRecord> {
    const action = await this.dependencies.repository.getCompactionBreakerAction(
      input.actionId,
      this.now().toISOString(),
    );
    assertActorBoundAction(action, input.sessionId, hashActorId(input.actorId));
    return action;
  }

  public async repair(input: {
    sessionId: string;
    actionId: string;
    actorId: string;
  }): Promise<ChatCompactionBreakerRepairResponse> {
    const action = await this.inspectAction(input);
    if (action.actionKind !== "repair" || action.status !== "pending") {
      throw new ConflictError({ code: "STATE_CONFLICT", message: "A pending repair action is required" });
    }
    const consumedAt = this.now().toISOString();
    if (!(await this.dependencies.isUseAuthorized({ action, observedAt: consumedAt }))) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "The pending repair action is no longer authorized by current policy and approval state",
      });
    }
    return await this.dependencies.repository.consumeCompactionBreakerRepairAction({
      actionId: action.actionId,
      sessionId: action.sessionId,
      dimensionHash: action.dimensionHash,
      actorHash: action.actorHash,
      consumedAt,
    });
  }

  /**
   * Called by canonical Chat preparation only after capability profile and
   * compaction dimension sealing. The returned reference is server-derived;
   * no client actor hash or force boolean crosses the route boundary.
   */
  public async resolvePendingForceAction(input: {
    sessionId: string;
    sealedDimensionHash: string;
    actorId: string;
  }): Promise<{ actionId: string; actorHash: string } | undefined> {
    const actorHash = hashActorId(input.actorId);
    const observedAt = this.now().toISOString();
    const action = await this.dependencies.repository.findPendingCompactionBreakerForceAction({
      sessionId: input.sessionId,
      dimensionHash: input.sealedDimensionHash,
      actorHash,
      observedAt,
    });
    return action && (await this.dependencies.isUseAuthorized({ action, observedAt }))
      ? { actionId: action.actionId, actorHash }
      : undefined;
  }

  private async requireRecoveryBreakerState(
    sessionId: string,
    request: Pick<ChatCompactionBreakerActionCreateRequest, "dimensionHash" | "actionKind" | "expectedBreakerRevision">,
  ): Promise<void> {
    const breaker = await this.dependencies.repository.getCompactionBreaker(sessionId, request.dimensionHash);
    if (!breaker) {
      throw new NotFoundError({
        entity: "Chat compaction breaker",
        id: `${sessionId}/${request.dimensionHash}`,
      });
    }
    if (breaker.revision !== request.expectedBreakerRevision) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Chat compaction breaker revision changed; reload durable state before requesting recovery",
      });
    }
    if (request.actionKind === "force" && breaker.status !== "tripped") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "A force action is recovery-only and requires an exactly tripped compaction breaker",
      });
    }
    if (request.actionKind === "repair" && breaker.status !== "blocked_corrupt") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "A repair action is recovery-only and requires blocked corrupt compaction state",
      });
    }
  }
}

export function hashActorId(actorId: string): string {
  const normalized = actorId.trim();
  if (!normalized || normalized === "auth:none") {
    throw new ConflictError({ code: "STATE_CONFLICT", message: "A specific authenticated operator is required" });
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function buildChatCompactionBreakerApprovalBindingHash(input: {
  sessionId: string;
  dimensionHash: string;
  actionKind: "force" | "repair";
  expectedBreakerRevision: number;
  actorId: string;
  reason: string;
}): string {
  return buildChatCompactionBreakerApprovalBindingHashFromActorHash({
    ...input,
    actorHash: hashActorId(input.actorId),
  });
}

export function buildChatCompactionBreakerApprovalBindingHashFromActorHash(input: {
  sessionId: string;
  dimensionHash: string;
  actionKind: "force" | "repair";
  expectedBreakerRevision: number;
  actorHash: string;
  reason: string;
}): string {
  return hashEvidence("approval-binding", {
    version: 1,
    sessionId: input.sessionId,
    dimensionHash: input.dimensionHash,
    actionKind: input.actionKind,
    expectedBreakerRevision: input.expectedBreakerRevision,
    actorHash: input.actorHash,
    reason: input.reason.trim(),
  });
}

function assertCanonicalRecoveryApproval(
  approval: ApprovalRequest,
  expected: {
    payload: {
      schemaVersion: typeof CHAT_COMPACTION_BREAKER_APPROVAL_SCHEMA_VERSION;
      sessionId: string;
      dimensionHash: string;
      actionKind: "force" | "repair";
      expectedBreakerRevision: number;
      actorHash: string;
      reason: string;
      approvalBindingHash: string;
    };
    ttlMs: number;
    linkage: {
      sessionId: string;
      workspaceId: string;
      actionType: string;
    };
  },
): void {
  const expectedPayloadKeys = Object.keys(expected.payload).sort();
  const actualPayloadKeys = Object.keys(approval.payload).sort();
  const payloadMatches =
    actualPayloadKeys.length === expectedPayloadKeys.length &&
    actualPayloadKeys.every(
      (key, index) =>
        key === expectedPayloadKeys[index] &&
        approval.payload[key] === (expected.payload as Record<string, unknown>)[key],
    );
  const createdAtMs = Date.parse(approval.createdAt);
  const expiresAtMs = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
  const exactDatabaseTtl =
    Number.isFinite(createdAtMs) &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs - createdAtMs === expected.ttlMs &&
    expected.ttlMs >= CHAT_COMPACTION_BREAKER_MIN_ACTION_TTL_SECONDS * 1_000 &&
    expected.ttlMs <= CHAT_COMPACTION_BREAKER_MAX_ACTION_TTL_SECONDS * 1_000;
  if (
    approval.kind !== "chat_compaction_breaker_recovery" ||
    approval.riskLevel !== "danger" ||
    (approval.status !== "pending" && approval.status !== "rejected") ||
    !exactDatabaseTtl ||
    approval.preview.expiresInSeconds !== expected.ttlMs / 1_000 ||
    approval.preview.expiresAt !== undefined ||
    approval.linkage?.sessionId !== expected.linkage.sessionId ||
    approval.linkage?.workspaceId !== expected.linkage.workspaceId ||
    approval.linkage?.actionType !== expected.linkage.actionType ||
    !payloadMatches
  ) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Canonical approval creation changed the governed compaction recovery boundary",
    });
  }
}

function normalizeRecoveryReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized || normalized.length > MAX_RECOVERY_REASON_LENGTH) {
    throw new RangeError(`reason must be between 1 and ${MAX_RECOVERY_REASON_LENGTH} characters`);
  }
  return normalized;
}

function resolveGovernanceRejection(input: {
  requestedApprovalId?: string;
  expectedApprovalBindingHash: string;
  decision: ChatCompactionBreakerGovernanceDecision;
}): string | undefined {
  if (input.decision.decision === "deny") {
    return "Denied by deny-wins policy";
  }
  if (input.decision.decision === "require_approval") {
    return "An approved operator decision is required";
  }
  if (!input.requestedApprovalId || !input.decision.approvalId) {
    return "Approved evidence is required for this action";
  }
  if (input.requestedApprovalId !== input.decision.approvalId) {
    return "Approval evidence does not match the requested approval";
  }
  if (input.decision.approvalStatus !== "approved") {
    return "Approval evidence is not currently approved";
  }
  if (input.decision.approvalBindingHash !== input.expectedApprovalBindingHash) {
    return "Approval evidence does not match the action boundary";
  }
  return undefined;
}

function assertActorBoundAction(action: ChatCompactionBreakerActionRecord, sessionId: string, actorHash: string): void {
  if (action.sessionId !== sessionId) {
    throw new NotFoundError({ entity: "Chat compaction breaker action", id: action.actionId });
  }
  if (action.actorHash !== actorHash) {
    throw new ConflictError({ code: "STATE_CONFLICT", message: "Action is bound to a different operator" });
  }
}

function normalizeActionTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_ACTION_TTL_SECONDS;
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < CHAT_COMPACTION_BREAKER_MIN_ACTION_TTL_SECONDS ||
    ttl > CHAT_COMPACTION_BREAKER_MAX_ACTION_TTL_SECONDS
  ) {
    throw new RangeError(
      `expiresInSeconds must be an integer between ${CHAT_COMPACTION_BREAKER_MIN_ACTION_TTL_SECONDS} and ${CHAT_COMPACTION_BREAKER_MAX_ACTION_TTL_SECONDS}`,
    );
  }
  return ttl;
}

function hashEvidence(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${namespace}:${stableJson(value)}`)
    .digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
