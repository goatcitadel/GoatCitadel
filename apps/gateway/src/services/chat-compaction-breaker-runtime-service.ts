import { createHash } from "node:crypto";
import type { ApprovalCreateInput, ApprovalRequest, ChatCompactionBreakerActionRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import {
  CHAT_COMPACTION_BREAKER_APPROVAL_SCHEMA_VERSION,
  CHAT_COMPACTION_BREAKER_MAX_ACTION_TTL_SECONDS,
  CHAT_COMPACTION_BREAKER_MIN_ACTION_TTL_SECONDS,
  ChatCompactionBreakerActionService,
  buildChatCompactionBreakerApprovalBindingHashFromActorHash,
  type ChatCompactionBreakerGovernanceDecision,
  type ChatCompactionBreakerGovernancePort,
} from "./chat-compaction-breaker-action-service.js";
import { resolveWardEffectForExternalAction } from "./citadel-ward-gate.js";

const APPROVAL_KIND = "chat_compaction_breaker_recovery";
const AUDIT_SCHEMA_VERSION = "chat_compaction_breaker_action_audit.v1";

type RuntimeStorage = Pick<
  Storage,
  "approvals" | "audit" | "chatConversationSummaries" | "chatSessionMeta" | "citadels" | "sessions" | "workspaces"
>;

export interface ChatCompactionBreakerRuntimeHost {
  readonly storage: RuntimeStorage;
  normalizeWorkspaceId(workspaceId?: string): string;
  createApproval(input: ApprovalCreateInput, authority?: { ttlMs: number }): Promise<ApprovalRequest>;
  now?: () => Date;
}

/**
 * Binds the breaker recovery aggregate to Gateway-owned identity, Wards,
 * canonical approvals, and the durable audit owner. The core service stays
 * storage-agnostic; this adapter is the only production authorization path.
 */
export function createChatCompactionBreakerActionServiceForGateway(
  host: ChatCompactionBreakerRuntimeHost,
): ChatCompactionBreakerActionService {
  const now = host.now ?? (() => new Date());
  const resolveSessionWorkspaceId = async (sessionId: string): Promise<string> => {
    await host.storage.sessions.getBySessionId(sessionId);
    return host.normalizeWorkspaceId((await host.storage.chatSessionMeta.get(sessionId))?.workspaceId);
  };

  return new ChatCompactionBreakerActionService({
    repository: host.storage.chatConversationSummaries,
    approvals: {
      create: (input, authority) => host.createApproval(input, authority),
    },
    resolveSessionWorkspaceId,
    isUseAuthorized: ({ action, observedAt }) =>
      isCompactionBreakerActionUseAuthorized({
        storage: host.storage,
        resolveSessionWorkspaceId,
        action,
        observedAt,
      }),
    governance: {
      authorize: (input) =>
        authorizeCompactionBreakerAction({
          storage: host.storage,
          now,
          resolveSessionWorkspaceId,
          input,
        }),
    },
    audit: {
      append: async (input) => {
        const receiptId = `chat-compaction-breaker-action:${input.actionId}`;
        await host.storage.audit.append(
          "approvals",
          {
            schemaVersion: AUDIT_SCHEMA_VERSION,
            ...input,
          },
          { deliveryId: receiptId },
        );
        return { committed: true, receiptId };
      },
    },
    now,
  });
}

async function authorizeCompactionBreakerAction(input: {
  storage: RuntimeStorage;
  now: () => Date;
  resolveSessionWorkspaceId(sessionId: string): Promise<string>;
  input: Parameters<ChatCompactionBreakerGovernancePort["authorize"]>[0];
}): Promise<ChatCompactionBreakerGovernanceDecision> {
  const request = input.input;
  const workspaceId = await input.resolveSessionWorkspaceId(request.sessionId);
  const ward = await resolveWardEffectForExternalAction({
    storage: input.storage,
    workspaceId,
    action: `chat.compaction_breaker.${request.actionKind}`,
  });
  if (ward.effect === "deny" || ward.effect === "require_dry_run") {
    return decision({
      decision: "deny",
      context: {
        reason: ward.effect,
        citadelId: ward.citadelId,
        actionKind: request.actionKind,
        requestEvidenceHash: request.requestEvidenceHash,
      },
    });
  }

  const approvalId = request.requestedApprovalId?.trim();
  if (!approvalId) {
    return decision({
      decision: "require_approval",
      context: {
        reason: "approval_missing",
        citadelId: ward.citadelId,
        actionKind: request.actionKind,
        requestEvidenceHash: request.requestEvidenceHash,
      },
    });
  }

  let approval: ApprovalRequest;
  try {
    approval = await input.storage.approvals.get(approvalId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
    return decision({
      decision: "require_approval",
      approvalId,
      context: {
        reason: "approval_not_found",
        citadelId: ward.citadelId,
        actionKind: request.actionKind,
        requestEvidenceHash: request.requestEvidenceHash,
      },
    });
  }

  const nowMs = input.now().getTime();
  const expiresAtMs = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return decision({
      decision: "require_approval",
      approvalId,
      approvalStatus: "expired",
      context: {
        reason: "approval_expired",
        citadelId: ward.citadelId,
        actionKind: request.actionKind,
        requestEvidenceHash: request.requestEvidenceHash,
      },
    });
  }
  if (approval.status === "pending") {
    return decision({
      decision: "require_approval",
      approvalId,
      approvalStatus: "pending",
      context: {
        reason: "approval_pending",
        citadelId: ward.citadelId,
        actionKind: request.actionKind,
        requestEvidenceHash: request.requestEvidenceHash,
      },
    });
  }
  if (approval.status !== "approved") {
    return decision({
      decision: "deny",
      approvalId,
      approvalStatus: approval.status === "edited" ? "revoked" : "denied",
      context: {
        reason: `approval_${approval.status}`,
        citadelId: ward.citadelId,
        actionKind: request.actionKind,
        requestEvidenceHash: request.requestEvidenceHash,
      },
    });
  }

  if (
    !isCanonicalApprovedRecoveryApproval({
      approval,
      workspaceId,
      observedAtMs: nowMs,
      sessionId: request.sessionId,
      dimensionHash: request.dimensionHash,
      actionKind: request.actionKind,
      expectedBreakerRevision: request.expectedBreakerRevision,
      actorHash: request.actorHash,
      reason: request.reason,
      approvalBindingHash: request.expectedApprovalBindingHash,
    })
  ) {
    return decision({
      decision: "deny",
      approvalId,
      approvalStatus: "denied",
      context: {
        reason: "approval_boundary_mismatch",
        citadelId: ward.citadelId,
        actionKind: request.actionKind,
        requestEvidenceHash: request.requestEvidenceHash,
      },
    });
  }

  return decision({
    decision: "allow",
    approvalId,
    approvalStatus: "approved",
    approvalBindingHash: request.expectedApprovalBindingHash,
    context: {
      reason: ward.effect === "require_approval" ? "ward_approval_satisfied" : "canonical_approval_satisfied",
      citadelId: ward.citadelId,
      actionKind: request.actionKind,
      requestEvidenceHash: request.requestEvidenceHash,
    },
  });
}

async function isCompactionBreakerActionUseAuthorized(input: {
  storage: RuntimeStorage;
  resolveSessionWorkspaceId(sessionId: string): Promise<string>;
  action: ChatCompactionBreakerActionRecord;
  observedAt: string;
}): Promise<boolean> {
  const observedAtMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAtMs) || !input.action.approvalId) {
    return false;
  }
  const workspaceId = await input.resolveSessionWorkspaceId(input.action.sessionId);
  const ward = await resolveWardEffectForExternalAction({
    storage: input.storage,
    workspaceId,
    action: `chat.compaction_breaker.${input.action.actionKind}`,
  });
  if (ward.effect === "deny" || ward.effect === "require_dry_run") {
    return false;
  }
  let approval: ApprovalRequest;
  try {
    approval = await input.storage.approvals.get(input.action.approvalId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return false;
    }
    throw error;
  }
  return isCanonicalApprovedRecoveryApproval({
    approval,
    workspaceId,
    observedAtMs,
    sessionId: input.action.sessionId,
    dimensionHash: input.action.dimensionHash,
    actionKind: input.action.actionKind,
    expectedBreakerRevision: input.action.expectedBreakerRevision,
    actorHash: input.action.actorHash,
    reason: input.action.reason,
    approvalBindingHash: buildChatCompactionBreakerApprovalBindingHashFromActorHash({
      sessionId: input.action.sessionId,
      dimensionHash: input.action.dimensionHash,
      actionKind: input.action.actionKind,
      expectedBreakerRevision: input.action.expectedBreakerRevision,
      actorHash: input.action.actorHash,
      reason: input.action.reason,
    }),
  });
}

function isCanonicalApprovedRecoveryApproval(input: {
  approval: ApprovalRequest;
  workspaceId: string;
  observedAtMs: number;
  sessionId: string;
  dimensionHash: string;
  actionKind: "force" | "repair";
  expectedBreakerRevision: number;
  actorHash: string;
  reason: string;
  approvalBindingHash: string;
}): boolean {
  const expectedPayload = {
    schemaVersion: CHAT_COMPACTION_BREAKER_APPROVAL_SCHEMA_VERSION,
    sessionId: input.sessionId,
    dimensionHash: input.dimensionHash,
    actionKind: input.actionKind,
    expectedBreakerRevision: input.expectedBreakerRevision,
    actorHash: input.actorHash,
    reason: input.reason,
    approvalBindingHash: input.approvalBindingHash,
  } as const;
  const expiresAtMs = input.approval.expiresAt ? Date.parse(input.approval.expiresAt) : Number.NaN;
  const createdAtMs = Date.parse(input.approval.createdAt);
  const resolvedAtMs = input.approval.resolvedAt ? Date.parse(input.approval.resolvedAt) : Number.NaN;
  const approvalLifetimeMs = expiresAtMs - createdAtMs;
  const validTimeline =
    Number.isFinite(input.observedAtMs) &&
    Number.isFinite(createdAtMs) &&
    Number.isFinite(resolvedAtMs) &&
    createdAtMs <= input.observedAtMs &&
    createdAtMs <= resolvedAtMs &&
    resolvedAtMs <= input.observedAtMs &&
    resolvedAtMs < expiresAtMs &&
    expiresAtMs > input.observedAtMs &&
    approvalLifetimeMs >= CHAT_COMPACTION_BREAKER_MIN_ACTION_TTL_SECONDS * 1_000 &&
    approvalLifetimeMs <= CHAT_COMPACTION_BREAKER_MAX_ACTION_TTL_SECONDS * 1_000;
  return (
    input.approval.kind === APPROVAL_KIND &&
    input.approval.riskLevel === "danger" &&
    input.approval.status === "approved" &&
    recordsExactlyEqual(input.approval.payload, expectedPayload) &&
    input.approval.linkage?.sessionId === input.sessionId &&
    input.approval.linkage?.workspaceId === input.workspaceId &&
    input.approval.linkage?.actionType === `chat_compaction_breaker_${input.actionKind}` &&
    Boolean(input.approval.resolvedAt?.trim() && input.approval.resolvedBy?.trim()) &&
    validTimeline
  );
}

function decision(input: {
  decision: ChatCompactionBreakerGovernanceDecision["decision"];
  approvalId?: string;
  approvalStatus?: ChatCompactionBreakerGovernanceDecision["approvalStatus"];
  approvalBindingHash?: string;
  context: Record<string, unknown>;
}): ChatCompactionBreakerGovernanceDecision {
  const decisionId = `sha256:${createHash("sha256")
    .update(stableJson({ decision: input.decision, ...input.context }))
    .digest("hex")}`;
  return {
    decision: input.decision,
    decisionId,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    ...(input.approvalStatus ? { approvalStatus: input.approvalStatus } : {}),
    ...(input.approvalBindingHash ? { approvalBindingHash: input.approvalBindingHash } : {}),
  };
}

function recordsExactlyEqual(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
  );
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
