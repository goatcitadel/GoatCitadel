import type {
  ApprovalRequest,
  SkillHubOperationKind,
  SkillHubOperationSettlementDisposition,
  SkillLifecycleRecord,
  SkillLifecycleState,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export type SkillHubOperatorAction = SkillHubOperationKind;

export interface SkillHubOperatorActionGuard {
  allowed: boolean;
  blockers: string[];
}

export interface SkillHubOperatorApprovalSummary {
  approvalId: string;
  operationId: string;
  operationKind: SkillHubOperatorAction;
  status: ApprovalRequest["status"];
  createdAt: string;
  resolvedAt?: string;
  settlement?: {
    settlementId: string;
    disposition: SkillHubOperationSettlementDisposition;
    resultSha256: string;
    evidenceEnvelopeId: string;
    journeyEventId: string;
    settledAt: string;
  };
}

export interface SkillHubOperatorItem {
  snapshotId: string;
  skillId?: string;
  title: string;
  candidate?: {
    candidateId: string;
    versionId: string;
    lifecycleState: SkillLifecycleState;
    supersedesVersionId?: string;
    createdAt: string;
    updatedAt: string;
  };
  lineage: {
    candidateId?: string;
    versionCount: number;
    latestVersionId?: string;
    activeVersionId?: string;
    candidateRevision?: number;
    inventoryTruncated: boolean;
    ambiguous: boolean;
  };
  snapshot: {
    operation: "review" | "install" | "update_check" | "update_stage" | "rollback_check";
    sourceProvider: string;
    sourceType: string;
    sourceRef: string;
    canonicalSourceKey: string;
    declaredVersion?: string;
    resolvedVersion?: string;
    contentTreeSha256: string;
    priorSnapshotId?: string;
    digestChangedFromPrior: boolean;
    sameVersionDifferentBytes: boolean;
    sameVersionDriftSnapshotId?: string;
    riskLevel: "low" | "medium" | "high" | "unknown";
    trustDisposition: "review_only" | "candidate" | "blocked" | "revoked";
    blockerCodes: string[];
    audit: Record<string, unknown>;
    auditSha256: string;
    auditFloor: Record<string, unknown>;
    auditFloorSha256: string;
    permissionEnvelope: Record<string, unknown>;
    permissionEnvelopeSha256: string;
    permissionDiff: Record<string, unknown>;
    compatibility: Record<string, unknown>;
    createdAt: string;
  };
  artifact?: {
    artifactId: string;
    manifestSha256: string;
    fileCount: number;
    totalBytes: number;
    createdAt: string;
  };
  runtime: {
    lifecycle?: SkillLifecycleRecord;
    runtimeRevision?: number;
    catalogEntry?: {
      capabilityId: string;
      callable: boolean;
      lifecycleState?: SkillLifecycleState;
      trustLabel?: string;
      reviewWarning?: string;
    };
    callable: boolean;
    activeVersion: boolean;
    inactiveCandidate: boolean;
  };
  approvals: Partial<Record<SkillHubOperatorAction, SkillHubOperatorApprovalSummary>>;
  latestApproval?: SkillHubOperatorApprovalSummary;
  actions: Record<SkillHubOperatorAction, SkillHubOperatorActionGuard>;
}

export interface SkillHubOperatorListResponse {
  schemaVersion: "goatcitadel.skill-hub-operator.v1";
  workspaceId: string;
  generatedAt: string;
  page: {
    limit: number;
    returned: number;
    truncated: boolean;
    candidateInventoryTruncated: boolean;
  };
  summary: {
    snapshots: number;
    retainedCandidates: number;
    inactive: number;
    callable: number;
    blocked: number;
    pendingApprovals: number;
  };
  items: SkillHubOperatorItem[];
}

export interface CreateSkillHubOperatorApprovalResponse {
  schemaVersion: "goatcitadel.skill-hub-operator.v1";
  approval: SkillHubOperatorApprovalSummary;
  reused: boolean;
  operatorMessage: string;
}

export async function fetchSkillHubOperator(input: {
  workspaceId: string;
  limit?: number;
}): Promise<SkillHubOperatorListResponse> {
  const params = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.limit !== undefined) {
    params.set("limit", String(Math.max(1, Math.min(Math.floor(input.limit), 100))));
  }
  return request<SkillHubOperatorListResponse>(`/api/v1/skills/hub?${params.toString()}`, {
    cache: "no-store",
  });
}

export async function createSkillHubOperatorApproval(input: {
  workspaceId: string;
  snapshotId: string;
  operationKind: SkillHubOperatorAction;
  sessionId?: string;
  turnId?: string;
}): Promise<CreateSkillHubOperatorApprovalResponse> {
  return request<CreateSkillHubOperatorApprovalResponse>("/api/v1/skills/hub/operations", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}
