/**
 * Remote approval action owner.
 *
 * Issues connector-bound approval tokens and resolves the approval bound to a
 * consumed token. The context is intentionally narrower than the full approval
 * lifecycle host so remote ingress cannot reach unrelated approval machinery.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  clampInt,
  ConflictError,
  type ApprovalEffectRecord,
  type ApprovalRequest,
  type ApprovalResolveInput,
  type ConnectorRecord,
  type RemoteActionTokenRecord,
  ValidationError,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { hashSensitiveToken } from "./device-access-helpers.js";
import { withApprovalFollowUp } from "./approval-follow-up.js";
import { buildRemoteTokenConsumedObservabilityEffect } from "./approval-observability.js";
import { readApprovalReplay } from "./approval-replay-reader.js";
import {
  deriveApprovalResolutionEffectsResult,
  type ApprovalObservabilityEffectInput,
} from "./approval-resolution-effects-service.js";
import type {
  ApprovalResolutionContext,
  ApprovalResolveResult,
  RemoteApprovalActionTokenIssueResult,
} from "./approval-types.js";

export interface ApprovalRemoteActionContext {
  readonly storage: Pick<
    Storage,
    | "approvals"
    | "approvalEffects"
    | "approvalEvents"
    | "pendingApprovalActions"
    | "remoteActionTokens"
    | "runImmediateTransaction"
  >;
  requireConnectorRecord(connectorId: string): ConnectorRecord;
  consumeRemoteActionToken(
    token: string,
    actionType: RemoteActionTokenRecord["actionType"],
    options?: { claimFingerprint?: string; expectedConnectorId?: string },
  ): RemoteActionTokenRecord;
  consumeRemoteActionTokenById(
    tokenId: string,
    actionType: RemoteActionTokenRecord["actionType"],
    options?: { claimFingerprint?: string; expectedConnectorId?: string },
  ): RemoteActionTokenRecord;
  resolveApproval(
    approvalId: string,
    input: ApprovalResolveInput,
    context?: ApprovalResolutionContext,
  ): Promise<ApprovalResolveResult>;
  enqueueApprovalObservabilityEffects(
    approvalId: string,
    items: readonly ApprovalObservabilityEffectInput[],
  ): ApprovalEffectRecord[];
  enqueueApprovalRemoteTokenDelivery(
    approval: ApprovalRequest,
    connector: ConnectorRecord,
    tokenRecord: { token: string; tokenId: string; expiresAt: string },
  ): { runId?: string } | undefined;
}

export function createApprovalRemoteActionToken(
  context: ApprovalRemoteActionContext,
  approvalId: string,
  input: {
    connectorId: string;
    issuedBy?: string;
    expiresInMs?: number;
  },
): RemoteApprovalActionTokenIssueResult {
  const approval = context.storage.approvals.get(approvalId);
  assertApprovalPending(approval);
  const connector = context.requireConnectorRecord(input.connectorId);
  const expiresInMs = clampInt(input.expiresInMs ?? 15 * 60_000, 15 * 60_000, 60_000, 24 * 60 * 60_000);
  const token = `grat_${randomBytes(32).toString("base64url")}`;
  let created!: RemoteActionTokenRecord;
  let deliveryApproval!: ApprovalRequest;
  context.storage.runImmediateTransaction(() => {
    deliveryApproval = context.storage.approvals.lockPendingForUpdate(approvalId);
    assertApprovalIssuable(context, deliveryApproval);
    created = context.storage.remoteActionTokens.createWithTtl({
      tokenHash: hashSensitiveToken(token),
      actionType: "approval.resolve",
      approvalId,
      connectorId: input.connectorId,
      mutation: { approvalId },
      expiresInMs,
    });
    context.enqueueApprovalObservabilityEffects(approvalId, [
      {
        operationId: `approval.remote_token.create.audit:${created.tokenId}`,
        delivery: {
          kind: "audit",
          stream: "approvals",
          payload: {
            event: "approval.remote_token.create",
            approvalId,
            connectorId: input.connectorId,
            issuedBy: input.issuedBy ?? "operator",
            expiresAt: created.expiresAt,
            tokenId: created.tokenId,
          },
        },
      },
      {
        operationId: `approval.remote_token.create.realtime:${created.tokenId}`,
        delivery: {
          kind: "realtime",
          eventType: "approval_remote_token_created",
          source: "approvals",
          payload: {
            approvalId,
            connectorId: input.connectorId,
            expiresAt: created.expiresAt,
            tokenId: created.tokenId,
          },
          options: {
            eventClass: "operational_signal",
            eventAuthority: "retained_stream",
            links: {
              approvalId,
              connectorId: input.connectorId,
              tokenId: created.tokenId,
            },
          },
        },
      },
    ]);
    deliveryApproval = context.storage.approvals.lockPendingForUpdate(approvalId);
    assertApprovalIssuable(context, deliveryApproval);
    if (!context.storage.remoteActionTokens.findPendingFresh(created.tokenId)) {
      throw new ValidationError({
        message: `Remote action token for approval ${approvalId} expired before issuance committed.`,
      });
    }
  });

  return {
    ...created,
    approvalId,
    token,
    ...enqueueRemoteTokenDelivery(context, deliveryApproval, connector, {
      token,
      tokenId: created.tokenId,
      expiresAt: created.expiresAt,
    }),
  };
}

export async function resolveApprovalWithConsumedRemoteToken(
  context: ApprovalRemoteActionContext,
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
  context.storage.runImmediateTransaction(() => {
    context.enqueueApprovalObservabilityEffects(approvalId, [
      buildRemoteTokenConsumedObservabilityEffect(
        approvalId,
        {
          tokenId: tokenRecord.tokenId,
          connectorId: tokenRecord.connectorId,
        },
        {
          decision: input.decision,
          resolvedBy,
        },
      ),
    ]);
  });
  const current = context.storage.approvals.get(approvalId);
  if (current.status !== "pending") {
    if (current.linkage?.tokenId !== tokenRecord.tokenId || current.linkage.connectorId !== tokenRecord.connectorId) {
      throw new ConflictError({
        message: `Approval ${approvalId} was resolved by a different actor or remote token.`,
      });
    }
    const expectedStatus =
      input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "edited";
    if (current.status !== expectedStatus) {
      throw new ConflictError({
        message: `Approval ${approvalId} was already resolved as ${current.status}, not ${expectedStatus}.`,
      });
    }
    return buildApprovalResolveResult(context, current);
  }
  return context.resolveApproval(
    approvalId,
    {
      decision: input.decision,
      editedPayload: input.editedPayload,
      resolutionNote: input.resolutionNote,
      resolvedBy,
    },
    {
      remoteToken: {
        tokenId: tokenRecord.tokenId,
        connectorId: tokenRecord.connectorId,
      },
    },
  );
}

export async function resolveApprovalWithRemoteToken(
  context: ApprovalRemoteActionContext,
  input: {
    token: string;
    connectorId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  },
): Promise<ApprovalResolveResult> {
  const tokenRecord = context.consumeRemoteActionToken(input.token, "approval.resolve", {
    claimFingerprint: buildRemoteApprovalClaimFingerprint(input),
    expectedConnectorId: input.connectorId,
  });
  return resolveApprovalWithConsumedRemoteToken(context, tokenRecord, input);
}

export async function resolveApprovalWithRemoteTokenId(
  context: ApprovalRemoteActionContext,
  input: {
    tokenId: string;
    connectorId: string;
    decision: ApprovalResolveInput["decision"];
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
    resolvedBy?: string;
  },
): Promise<ApprovalResolveResult> {
  const connectorId = input.connectorId.trim();
  if (!connectorId) {
    throw new ValidationError({ message: "Opaque remote action token resolution requires a connector binding." });
  }
  const tokenRecord = context.consumeRemoteActionTokenById(input.tokenId, "approval.resolve", {
    claimFingerprint: buildRemoteApprovalClaimFingerprint(input),
    expectedConnectorId: connectorId,
  });
  return resolveApprovalWithConsumedRemoteToken(context, tokenRecord, input);
}

function assertApprovalPending(approval: ApprovalRequest): void {
  if (approval.status !== "pending") {
    throw new ConflictError({
      message: `Approval ${approval.approvalId} is already resolved`,
    });
  }
}

function assertApprovalIssuable(context: ApprovalRemoteActionContext, approval: ApprovalRequest): void {
  assertApprovalPending(approval);
  if (context.storage.approvals.isExpiredPendingAtDatabaseNow(approval.approvalId)) {
    throw new ValidationError({
      message: `Approval ${approval.approvalId} has expired and can no longer issue a remote action token.`,
    });
  }
}

function enqueueRemoteTokenDelivery(
  context: ApprovalRemoteActionContext,
  approval: ApprovalRequest,
  connector: ConnectorRecord,
  tokenRecord: { token: string; tokenId: string; expiresAt: string },
): Pick<RemoteApprovalActionTokenIssueResult, "deliveryStatus" | "deliveryRunId" | "deliveryError"> {
  try {
    const deliveryRun = context.enqueueApprovalRemoteTokenDelivery(approval, connector, tokenRecord);
    if (!deliveryRun) {
      return { deliveryStatus: "not_configured" };
    }
    return {
      deliveryStatus: "queued",
      ...(deliveryRun.runId ? { deliveryRunId: deliveryRun.runId } : {}),
    };
  } catch (error) {
    return {
      deliveryStatus: "failed",
      deliveryError: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildApprovalResolveResult(
  context: ApprovalRemoteActionContext,
  current: ApprovalRequest,
): ApprovalResolveResult {
  const replay = readApprovalReplay(context.storage, current);
  const effects = replay.effects;
  const resolutionEffects = deriveApprovalResolutionEffectsResult(effects);
  const approval = withApprovalFollowUp(current, effects);
  return {
    approval,
    effects,
    replay: { ...replay, approval },
    durableRunId: resolutionEffects?.approvalWaitDurableRunId,
    resolutionEffects,
  };
}

function buildRemoteApprovalClaimFingerprint(input: {
  decision: ApprovalResolveInput["decision"];
  editedPayload?: Record<string, unknown>;
  resolutionNote?: string;
  resolvedBy?: string;
}): string {
  return createHash("sha256")
    .update(
      stableApprovalClaimStringify({
        decision: input.decision,
        editedPayload: input.editedPayload ?? null,
        resolutionNote: input.resolutionNote ?? null,
        resolvedBy: input.resolvedBy?.trim() || null,
      }),
      "utf8",
    )
    .digest("hex");
}

function stableApprovalClaimStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableApprovalClaimStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableApprovalClaimStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}
