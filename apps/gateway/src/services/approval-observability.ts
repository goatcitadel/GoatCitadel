import type { ApprovalRequest, ApprovalResolveInput, RealtimeEventLinks } from "@goatcitadel/contracts";
import type { ApprovalObservabilityEffectInput } from "./approval-resolution-effects-service.js";

export function buildApprovalRealtimeLinks(approval: ApprovalRequest): RealtimeEventLinks {
  return {
    approvalId: approval.approvalId,
    sessionId: approval.linkage?.sessionId,
    taskId: approval.linkage?.taskId,
    runId: approval.linkage?.runId ?? approval.linkage?.durableRunId,
    proactiveRunId: approval.linkage?.proactiveRunId,
    workspaceId: approval.linkage?.workspaceId,
    connectorId: approval.linkage?.connectorId,
    tokenId: approval.linkage?.tokenId,
  };
}

export function buildApprovalCreatedObservabilityEffects(
  approval: ApprovalRequest,
): ApprovalObservabilityEffectInput[] {
  const payload = {
    approvalId: approval.approvalId,
    kind: approval.kind,
    riskLevel: approval.riskLevel,
    status: approval.status,
  };
  return [
    {
      operationId: "approval.create.audit",
      delivery: {
        kind: "audit",
        stream: "approvals",
        payload: {
          event: "approval.create",
          ...payload,
        },
      },
    },
    {
      operationId: "approval.create.realtime",
      delivery: {
        kind: "realtime",
        eventType: "approval_created",
        source: "approvals",
        payload,
        options: {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: buildApprovalRealtimeLinks(approval),
          correlationId: approval.approvalId,
        },
      },
    },
  ];
}

export function buildApprovalResolutionObservabilityEffects(
  approval: ApprovalRequest,
  input: ApprovalResolveInput,
): ApprovalObservabilityEffectInput[] {
  const payload = {
    approvalId: approval.approvalId,
    status: approval.status,
    decision: input.decision,
    resolvedBy: input.resolvedBy,
  };
  return [
    {
      operationId: "approval.resolve.audit",
      delivery: {
        kind: "audit",
        stream: "approvals",
        payload: {
          event: "approval.resolve",
          ...payload,
        },
      },
    },
    {
      operationId: "approval.resolve.realtime",
      delivery: {
        kind: "realtime",
        eventType: "approval_resolved",
        source: "approvals",
        payload,
        options: {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: buildApprovalRealtimeLinks(approval),
          correlationId: approval.approvalId,
        },
      },
    },
  ];
}

export function buildRemoteTokenConsumedObservabilityEffect(
  approvalId: string,
  token: { tokenId: string; connectorId: string },
  input: Pick<ApprovalResolveInput, "decision" | "resolvedBy">,
): ApprovalObservabilityEffectInput {
  return {
    operationId: `approval.remote_token.consume.audit:${token.tokenId}`,
    delivery: {
      kind: "audit",
      stream: "approvals",
      payload: {
        event: "approval.remote_token.consume",
        approvalId,
        connectorId: token.connectorId,
        tokenId: token.tokenId,
        decision: input.decision,
        resolvedBy: input.resolvedBy,
      },
    },
  };
}
