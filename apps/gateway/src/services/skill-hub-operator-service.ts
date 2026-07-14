import { createHash } from "node:crypto";
import {
  SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
  SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA,
  ConflictError,
  NotFoundError,
  canonicalJsonString,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type CandidateSkillVersionRecord,
  type CapabilityCatalogEntry,
  type SkillHubOperationIntentPreview,
  type SkillHubOperationIntentTemplate,
  type SkillHubOperationKind,
  type SkillHubOperationSettlementRecord,
  type SkillHubSnapshotArtifactRecord,
  type SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import type { SkillAggregateRevisionRecord, SkillHubSnapshotRecord, Storage } from "@goatcitadel/storage";
import { buildSkillHubLifecycleApprovalInput } from "./skill-hub-lifecycle-service.js";

export const SKILL_HUB_OPERATOR_SCHEMA_VERSION = "goatcitadel.skill-hub-operator.v1" as const;
export const SKILL_HUB_OPERATOR_MAX_ITEMS = 100 as const;

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
  settlement?: Pick<
    SkillHubOperationSettlementRecord,
    "settlementId" | "disposition" | "resultSha256" | "evidenceEnvelopeId" | "journeyEventId" | "settledAt"
  >;
}

export interface SkillHubOperatorCandidateSummary {
  candidateId: string;
  versionId: string;
  lifecycleState: CandidateSkillVersionRecord["lifecycleState"];
  supersedesVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillHubOperatorItem {
  snapshotId: string;
  skillId?: string;
  title: string;
  candidate?: SkillHubOperatorCandidateSummary;
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
    operation: SkillHubSnapshotRecord["operation"];
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
    riskLevel: SkillHubSnapshotRecord["riskLevel"];
    trustDisposition: SkillHubSnapshotRecord["trustDisposition"];
    blockerCodes: string[];
    audit: Record<string, unknown>;
    auditSha256: string;
    auditFloor: SkillHubSnapshotRecord["auditFloor"];
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
    catalogEntry?: Pick<
      CapabilityCatalogEntry,
      "capabilityId" | "callable" | "lifecycleState" | "trustLabel" | "reviewWarning"
    >;
    callable: boolean;
    activeVersion: boolean;
    inactiveCandidate: boolean;
  };
  approvals: Partial<Record<SkillHubOperatorAction, SkillHubOperatorApprovalSummary>>;
  latestApproval?: SkillHubOperatorApprovalSummary;
  actions: Record<SkillHubOperatorAction, SkillHubOperatorActionGuard>;
}

export interface SkillHubOperatorListResponse {
  schemaVersion: typeof SKILL_HUB_OPERATOR_SCHEMA_VERSION;
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

export interface CreateSkillHubOperatorApprovalInput {
  workspaceId: string;
  snapshotId: string;
  operationKind: SkillHubOperatorAction;
  actorId: string;
  sessionId?: string;
  turnId?: string;
}

export interface CreateSkillHubOperatorApprovalResponse {
  schemaVersion: typeof SKILL_HUB_OPERATOR_SCHEMA_VERSION;
  approval: SkillHubOperatorApprovalSummary;
  reused: boolean;
  operatorMessage: string;
}

type SkillHubOperatorStorage = Pick<
  Storage,
  | "approvals"
  | "candidateSkillVersions"
  | "skillHubSnapshots"
  | "skillHubArtifacts"
  | "skillHubOperations"
  | "skillLifecycle"
  | "skillAggregateRevisions"
>;

export interface SkillHubOperatorServiceOptions {
  storage: SkillHubOperatorStorage;
  createApproval(input: ApprovalCreateInput): Promise<ApprovalRequest>;
  listInspectableCatalog(): CapabilityCatalogEntry[];
  now?: () => string;
}

interface OperatorInventory {
  workspaceId: string;
  candidates: CandidateSkillVersionRecord[];
  candidateSnapshots: Map<string, SkillHubSnapshotRecord>;
  candidateInventoryTruncated: boolean;
  catalogBySkillId: Map<string, CapabilityCatalogEntry>;
  approvalsBySnapshot: Map<string, Partial<Record<SkillHubOperatorAction, SkillHubOperatorApprovalSummary>>>;
}

interface SnapshotContext {
  snapshot: SkillHubSnapshotRecord;
  priorSnapshot?: SkillHubSnapshotRecord;
  driftSnapshot?: SkillHubSnapshotRecord;
  artifact?: SkillHubSnapshotArtifactRecord;
  skillId?: string;
  exactCandidate?: CandidateSkillVersionRecord;
  sourceCandidates: CandidateSkillVersionRecord[];
  lineageCandidateId?: string;
  lineageAmbiguous: boolean;
  latestCandidate?: CandidateSkillVersionRecord;
  activeCandidate?: CandidateSkillVersionRecord;
  referenceSnapshot?: SkillHubSnapshotRecord;
  candidateRevision?: SkillAggregateRevisionRecord;
  targetCandidateRevision?: SkillAggregateRevisionRecord;
  runtimeLifecycle?: SkillLifecycleRecord;
  runtimeRevision?: SkillAggregateRevisionRecord;
  catalogEntry?: CapabilityCatalogEntry;
  activeVersion: boolean;
  candidateInventoryTruncated: boolean;
  approvals: Partial<Record<SkillHubOperatorAction, SkillHubOperatorApprovalSummary>>;
}

interface OperationPlan {
  guard: SkillHubOperatorActionGuard;
  targetCandidateId?: string;
  targetVersionId?: string;
  supersedesVersionId?: string;
  expectedCandidateRevision?: number;
  expectedRuntimeRevision?: number;
  expectedCandidateAbsent: boolean;
  expectedRuntimeAbsent: boolean;
}

const OPERATOR_ACTIONS: readonly SkillHubOperatorAction[] = [
  "install_inactive",
  "stage_update_candidate",
  "stage_rollback_candidate",
  "activate",
  "revoke",
];

export class SkillHubOperatorService {
  private readonly now: () => string;
  private readonly inFlightApprovalsByFingerprint = new Map<string, Promise<ApprovalRequest>>();

  public constructor(private readonly options: SkillHubOperatorServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public list(input: { workspaceId: string; limit?: number }): SkillHubOperatorListResponse {
    const workspaceId = normalizeRequired(input.workspaceId, "workspace ID", 256);
    const limit = normalizeLimit(input.limit);
    const snapshotsWithSentinel = this.options.storage.skillHubSnapshots.listByWorkspace(workspaceId, limit + 1);
    const truncated = snapshotsWithSentinel.length > limit;
    const snapshots = snapshotsWithSentinel.slice(0, limit);
    const inventory = this.loadInventory(workspaceId);
    const items = snapshots.map((snapshot) => this.project(this.contextFor(snapshot, inventory)));
    const pendingApprovalIds = new Set(
      items.flatMap((item) =>
        Object.values(item.approvals)
          .filter((approval) => approval?.status === "pending")
          .map((approval) => approval!.approvalId),
      ),
    );

    return {
      schemaVersion: SKILL_HUB_OPERATOR_SCHEMA_VERSION,
      workspaceId,
      generatedAt: this.now(),
      page: {
        limit,
        returned: items.length,
        truncated,
        candidateInventoryTruncated: inventory.candidateInventoryTruncated,
      },
      summary: {
        snapshots: items.length,
        retainedCandidates: items.filter((item) => item.candidate).length,
        inactive: items.filter((item) => item.runtime.inactiveCandidate).length,
        callable: items.filter((item) => item.runtime.callable).length,
        blocked: items.filter((item) => item.snapshot.blockerCodes.length > 0).length,
        pendingApprovals: pendingApprovalIds.size,
      },
      items,
    };
  }

  public async createApproval(
    input: CreateSkillHubOperatorApprovalInput,
  ): Promise<CreateSkillHubOperatorApprovalResponse> {
    const workspaceId = normalizeRequired(input.workspaceId, "workspace ID", 256);
    const snapshotId = normalizeRequired(input.snapshotId, "snapshot ID", 256);
    const actorId = normalizeRequired(input.actorId, "actor ID", 256);
    const snapshot = this.options.storage.skillHubSnapshots.find(snapshotId);
    if (!snapshot || snapshot.workspaceId !== workspaceId) {
      throw new NotFoundError({ entity: "Skill Hub snapshot", id: snapshotId });
    }
    const context = this.contextFor(snapshot, this.loadInventory(workspaceId));
    const plan = this.plan(input.operationKind, context);
    if (!plan.guard.allowed || !context.skillId || !plan.targetCandidateId || !plan.targetVersionId) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `Skill Hub ${input.operationKind} is blocked: ${plan.guard.blockers.join(", ")}.`,
        details: { blockers: plan.guard.blockers, snapshotId },
      });
    }

    const sessionId = normalizeOptional(input.sessionId, "session ID", 256);
    const turnId = normalizeOptional(input.turnId, "turn ID", 256);
    if (turnId && !sessionId) {
      throw new TypeError("Skill Hub turn lineage requires a session ID.");
    }
    const intentBase = {
      workspaceId,
      operationKind: input.operationKind,
      snapshotId,
      contentTreeSha256: snapshot.contentTreeSha256,
      skillId: context.skillId,
      targetCandidateId: plan.targetCandidateId,
      targetVersionId: plan.targetVersionId,
      supersedesVersionId: plan.supersedesVersionId,
      expectedCandidateRevision: plan.expectedCandidateRevision,
      expectedRuntimeRevision: plan.expectedRuntimeRevision,
      expectedCandidateAbsent: plan.expectedCandidateAbsent,
      expectedRuntimeAbsent: plan.expectedRuntimeAbsent,
      actorId,
      sessionId,
      turnId,
    } satisfies Omit<SkillHubOperationIntentTemplate, "operationId" | "idempotencyKey" | "createdAt">;
    const fingerprint = operationFingerprint(intentBase);
    const existing = this.findReusableApproval(workspaceId, fingerprint);
    if (existing) {
      return {
        schemaVersion: SKILL_HUB_OPERATOR_SCHEMA_VERSION,
        approval: this.summarizeApproval(existing),
        reused: true,
        operatorMessage: "An equivalent governed approval is already active; no duplicate mutation was created.",
      };
    }
    const inFlight = this.inFlightApprovalsByFingerprint.get(fingerprint);
    if (inFlight) {
      const approval = await inFlight;
      return {
        schemaVersion: SKILL_HUB_OPERATOR_SCHEMA_VERSION,
        approval: this.summarizeApproval(approval),
        reused: true,
        operatorMessage: "An equivalent governed approval is already active; no duplicate mutation was created.",
      };
    }
    const attempt = this.nextAttempt(workspaceId, fingerprint);
    const operationId = `skill-hub-op-${fingerprint.slice(0, 32)}-${attempt}`;
    const intent: SkillHubOperationIntentTemplate = {
      ...intentBase,
      operationId,
      idempotencyKey: `skill-hub:lifecycle:${fingerprint}:${attempt}`,
      createdAt: this.now(),
    };
    const approvalInput = buildSkillHubLifecycleApprovalInput(intent);
    const pendingApproval = this.options.createApproval(approvalInput).then((approval) => {
      assertCreatedApprovalMatchesIntent(approval, approvalInput);
      return approval;
    });
    this.inFlightApprovalsByFingerprint.set(fingerprint, pendingApproval);
    try {
      const approval = await pendingApproval;
      return {
        schemaVersion: SKILL_HUB_OPERATOR_SCHEMA_VERSION,
        approval: this.summarizeApproval(approval),
        reused: false,
        operatorMessage: "Approval created. Candidate and runtime state remain unchanged until the effect settles.",
      };
    } finally {
      if (this.inFlightApprovalsByFingerprint.get(fingerprint) === pendingApproval) {
        this.inFlightApprovalsByFingerprint.delete(fingerprint);
      }
    }
  }

  private loadInventory(workspaceId: string): OperatorInventory {
    const rawCandidates = this.options.storage.candidateSkillVersions.list(500);
    const candidates = rawCandidates.filter(
      (candidate) =>
        candidate.sourceKind === "upstream_hub" &&
        candidate.lineageStatus === "governed" &&
        candidate.workspaceId === workspaceId &&
        candidate.upstreamSnapshotId,
    );
    const candidateSnapshots = new Map<string, SkillHubSnapshotRecord>();
    for (const candidate of candidates) {
      const snapshot = this.options.storage.skillHubSnapshots.find(candidate.upstreamSnapshotId!);
      if (snapshot?.workspaceId === workspaceId) candidateSnapshots.set(candidate.versionId, snapshot);
    }
    const catalogBySkillId = new Map(
      this.options
        .listInspectableCatalog()
        .filter((entry) => entry.kind === "skill" && entry.skillId)
        .map((entry) => [entry.skillId!, entry]),
    );
    return {
      workspaceId,
      candidates,
      candidateSnapshots,
      candidateInventoryTruncated: rawCandidates.length >= 500,
      catalogBySkillId,
      approvalsBySnapshot: this.latestApprovalsBySnapshot(workspaceId),
    };
  }

  private contextFor(snapshot: SkillHubSnapshotRecord, inventory: OperatorInventory): SnapshotContext {
    const deterministicVersion = this.options.storage.candidateSkillVersions.find(versionIdForSnapshot(snapshot));
    const candidates = uniqueCandidates([
      ...inventory.candidates,
      ...(deterministicVersion &&
      deterministicVersion.sourceKind === "upstream_hub" &&
      deterministicVersion.workspaceId === inventory.workspaceId
        ? [deterministicVersion]
        : []),
    ]);
    const candidatesWithSources = candidates
      .map((candidate) => ({
        candidate,
        snapshot:
          inventory.candidateSnapshots.get(candidate.versionId) ??
          (candidate.upstreamSnapshotId
            ? this.options.storage.skillHubSnapshots.find(candidate.upstreamSnapshotId)
            : undefined),
      }))
      .filter((item): item is { candidate: CandidateSkillVersionRecord; snapshot: SkillHubSnapshotRecord } =>
        Boolean(item.snapshot?.workspaceId === inventory.workspaceId),
      );
    const sourceCandidates = candidatesWithSources
      .filter((item) => item.snapshot.canonicalSourceKey === snapshot.canonicalSourceKey)
      .map((item) => item.candidate);
    const sourceCandidateIds = [...new Set(sourceCandidates.map((candidate) => candidate.candidateId))];
    const lineageCandidateId = sourceCandidateIds.length === 1 ? sourceCandidateIds[0] : undefined;
    const lineageCandidates = lineageCandidateId
      ? uniqueCandidates([
          ...sourceCandidates,
          ...this.options.storage.candidateSkillVersions
            .listByCandidateId(lineageCandidateId, 500)
            .filter(
              (candidate) =>
                candidate.sourceKind === "upstream_hub" &&
                candidate.workspaceId === inventory.workspaceId &&
                candidate.upstreamSnapshotId,
            ),
        ])
      : sourceCandidates;
    const exactCandidates = lineageCandidates
      .filter(
        (candidate) =>
          candidate.upstreamSnapshotId === snapshot.snapshotId &&
          candidate.sourceFingerprint === snapshot.contentTreeSha256,
      )
      .sort(compareCandidateNewest);
    const exactCandidateIds = [...new Set(exactCandidates.map((candidate) => candidate.candidateId))];
    const exactCandidate = exactCandidateIds.length <= 1 ? exactCandidates[0] : undefined;
    const latestCandidate = [...lineageCandidates].sort(compareCandidateNewest)[0];
    const candidateTitles = [...new Set(lineageCandidates.map((candidate) => candidate.title))];
    const skillId =
      candidateTitles.length === 1 ? skillIdForName(candidateTitles[0]!) : resolveSnapshotSkillId(snapshot);
    const runtimeLifecycle = skillId ? this.options.storage.skillLifecycle.find(skillId) : undefined;
    const activeCandidate = runtimeLifecycle?.provenance?.sourceRef
      ? lineageCandidates.find(
          (candidate) =>
            candidate.upstreamSnapshotId === runtimeLifecycle.provenance?.sourceRef &&
            candidate.sourceFingerprint === runtimeLifecycle.provenance?.contentIntegrity?.treeSha256,
        )
      : undefined;
    const referenceCandidate = activeCandidate ?? latestCandidate;
    const referenceSnapshot = referenceCandidate?.upstreamSnapshotId
      ? this.options.storage.skillHubSnapshots.find(referenceCandidate.upstreamSnapshotId)
      : undefined;
    const candidateRevision = lineageCandidateId
      ? this.options.storage.skillAggregateRevisions.get("candidate_skill", lineageCandidateId)
      : undefined;
    const targetCandidateId = lineageCandidateId ?? candidateIdForSource(snapshot);
    const activeVersion = Boolean(
      exactCandidate &&
      activeCandidate?.versionId === exactCandidate.versionId &&
      runtimeLifecycle &&
      runtimeLifecycle.lifecycleState !== "revoked",
    );
    return {
      snapshot,
      priorSnapshot: snapshot.priorSnapshotId
        ? this.options.storage.skillHubSnapshots.find(snapshot.priorSnapshotId)
        : undefined,
      driftSnapshot: this.options.storage.skillHubSnapshots.findSameVersionByteDrift({
        workspaceId: snapshot.workspaceId,
        canonicalSourceKey: snapshot.canonicalSourceKey,
        declaredVersion: snapshot.declaredVersion,
        resolvedVersion: snapshot.resolvedVersion,
        contentTreeSha256: snapshot.contentTreeSha256,
      }),
      artifact: this.options.storage.skillHubArtifacts.findBySnapshot(snapshot.workspaceId, snapshot.snapshotId),
      skillId,
      exactCandidate,
      sourceCandidates: lineageCandidates,
      lineageCandidateId,
      lineageAmbiguous: sourceCandidateIds.length > 1 || exactCandidateIds.length > 1 || candidateTitles.length > 1,
      latestCandidate,
      activeCandidate,
      referenceSnapshot,
      candidateRevision,
      targetCandidateRevision: this.options.storage.skillAggregateRevisions.get("candidate_skill", targetCandidateId),
      runtimeLifecycle,
      runtimeRevision: skillId ? this.options.storage.skillAggregateRevisions.get("runtime_skill", skillId) : undefined,
      catalogEntry: skillId ? inventory.catalogBySkillId.get(skillId) : undefined,
      activeVersion,
      candidateInventoryTruncated: inventory.candidateInventoryTruncated,
      approvals: inventory.approvalsBySnapshot.get(snapshot.snapshotId) ?? {},
    };
  }

  private project(context: SnapshotContext): SkillHubOperatorItem {
    const { snapshot } = context;
    const callable = Boolean(context.catalogEntry?.callable && context.activeVersion);
    const approvals = context.approvals;
    const latestApproval = Object.values(approvals).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return {
      snapshotId: snapshot.snapshotId,
      skillId: context.skillId,
      title: context.exactCandidate?.title ?? context.latestCandidate?.title ?? titleForSnapshot(snapshot),
      candidate: context.exactCandidate
        ? {
            candidateId: context.exactCandidate.candidateId,
            versionId: context.exactCandidate.versionId,
            lifecycleState: context.exactCandidate.lifecycleState,
            supersedesVersionId: context.exactCandidate.supersedesVersionId,
            createdAt: context.exactCandidate.createdAt,
            updatedAt: context.exactCandidate.updatedAt,
          }
        : undefined,
      lineage: {
        candidateId: context.lineageCandidateId,
        versionCount: context.sourceCandidates.length,
        latestVersionId: context.latestCandidate?.versionId,
        activeVersionId: context.activeCandidate?.versionId,
        candidateRevision: context.candidateRevision?.revision,
        inventoryTruncated: context.candidateInventoryTruncated,
        ambiguous: context.lineageAmbiguous,
      },
      snapshot: {
        operation: snapshot.operation,
        sourceProvider: snapshot.sourceProvider,
        sourceType: snapshot.sourceType,
        sourceRef: snapshot.sourceRef,
        canonicalSourceKey: snapshot.canonicalSourceKey,
        declaredVersion: snapshot.declaredVersion,
        resolvedVersion: snapshot.resolvedVersion,
        contentTreeSha256: snapshot.contentTreeSha256,
        priorSnapshotId: snapshot.priorSnapshotId,
        digestChangedFromPrior: Boolean(
          context.priorSnapshot && context.priorSnapshot.contentTreeSha256 !== snapshot.contentTreeSha256,
        ),
        sameVersionDifferentBytes:
          snapshot.blockerCodes.includes("UPSTREAM_VERSION_BYTE_DRIFT") || Boolean(context.driftSnapshot),
        sameVersionDriftSnapshotId: context.driftSnapshot?.snapshotId,
        riskLevel: snapshot.riskLevel,
        trustDisposition: snapshot.trustDisposition,
        blockerCodes: snapshot.blockerCodes,
        audit: snapshot.audit,
        auditSha256: snapshot.auditSha256,
        auditFloor: snapshot.auditFloor,
        auditFloorSha256: snapshot.auditFloorSha256,
        permissionEnvelope: snapshot.permissionEnvelope,
        permissionEnvelopeSha256: snapshot.permissionEnvelopeSha256,
        permissionDiff: snapshot.permissionDiff,
        compatibility: snapshot.compatibility,
        createdAt: snapshot.createdAt,
      },
      artifact: context.artifact
        ? {
            artifactId: context.artifact.artifactId,
            manifestSha256: context.artifact.manifestSha256,
            fileCount: context.artifact.fileCount,
            totalBytes: context.artifact.totalBytes,
            createdAt: context.artifact.createdAt,
          }
        : undefined,
      runtime: {
        lifecycle: context.runtimeLifecycle,
        runtimeRevision: context.runtimeRevision?.revision,
        catalogEntry: context.catalogEntry
          ? {
              capabilityId: context.catalogEntry.capabilityId,
              callable: context.catalogEntry.callable,
              lifecycleState: context.catalogEntry.lifecycleState,
              trustLabel: context.catalogEntry.trustLabel,
              reviewWarning: context.catalogEntry.reviewWarning,
            }
          : undefined,
        callable,
        activeVersion: context.activeVersion,
        inactiveCandidate: Boolean(context.exactCandidate && !context.activeVersion),
      },
      approvals,
      latestApproval,
      actions: Object.fromEntries(
        OPERATOR_ACTIONS.map((action) => [action, this.plan(action, context).guard]),
      ) as Record<SkillHubOperatorAction, SkillHubOperatorActionGuard>,
    };
  }

  private plan(action: SkillHubOperatorAction, context: SnapshotContext): OperationPlan {
    const blockers: string[] = [];
    if (!context.skillId) blockers.push("SKILL_ID_UNRESOLVED");
    if (!context.artifact) blockers.push("ARTIFACT_NOT_RETAINED");
    if (context.lineageAmbiguous) blockers.push("CANDIDATE_LINEAGE_AMBIGUOUS");
    if (action !== "revoke") {
      if (context.snapshot.trustDisposition !== "candidate") blockers.push("SNAPSHOT_NOT_CANDIDATE");
      blockers.push(...context.snapshot.blockerCodes);
    }
    const runtimeExists = context.runtimeLifecycle !== undefined;
    if (runtimeExists && !context.runtimeRevision) blockers.push("RUNTIME_REVISION_MISSING");
    if (!runtimeExists && context.runtimeRevision) blockers.push("RUNTIME_REVISION_ORPHANED");

    let targetCandidateId = context.lineageCandidateId ?? candidateIdForSource(context.snapshot);
    let targetVersionId = context.exactCandidate?.versionId ?? versionIdForSnapshot(context.snapshot);
    let supersedesVersionId: string | undefined;
    let expectedCandidateRevision: number | undefined;
    let expectedRuntimeRevision = runtimeExists ? context.runtimeRevision?.revision : undefined;
    let expectedCandidateAbsent = false;
    let expectedRuntimeAbsent = !runtimeExists;

    if (action === "install_inactive") {
      expectedCandidateAbsent = true;
      expectedRuntimeAbsent = true;
      expectedRuntimeRevision = undefined;
      if (context.candidateInventoryTruncated) blockers.push("CANDIDATE_INVENTORY_TRUNCATED");
      if (context.sourceCandidates.length > 0 || context.exactCandidate) blockers.push("SOURCE_ALREADY_INSTALLED");
      if (context.targetCandidateRevision) blockers.push("CANDIDATE_ALREADY_EXISTS");
      if (runtimeExists) blockers.push("RUNTIME_ALREADY_EXISTS");
    } else if (action === "stage_update_candidate" || action === "stage_rollback_candidate") {
      if (context.candidateInventoryTruncated) blockers.push("CANDIDATE_INVENTORY_TRUNCATED");
      if (!context.lineageCandidateId || context.sourceCandidates.length === 0)
        blockers.push("CANDIDATE_LINEAGE_MISSING");
      if (!context.candidateRevision) blockers.push("CANDIDATE_REVISION_MISSING");
      if (context.exactCandidate) blockers.push("SNAPSHOT_ALREADY_STAGED");
      if (context.runtimeLifecycle?.lifecycleState === "revoked") blockers.push("RUNTIME_REVOKED");
      if (!context.runtimeLifecycle || !context.runtimeRevision) blockers.push("RUNTIME_LINEAGE_MISSING");
      if (!context.latestCandidate) blockers.push("SUPERSEDED_VERSION_MISSING");
      targetCandidateId = context.lineageCandidateId ?? targetCandidateId;
      supersedesVersionId = context.activeCandidate?.versionId ?? context.latestCandidate?.versionId;
      expectedCandidateRevision = context.candidateRevision?.revision;
      expectedRuntimeAbsent = false;
      expectedRuntimeRevision = context.runtimeRevision?.revision;
      const position = context.referenceSnapshot
        ? compareSnapshotPosition(context.snapshot, context.referenceSnapshot)
        : 0;
      if (action === "stage_update_candidate") {
        if (context.snapshot.operation === "rollback_check" || position <= 0) blockers.push("SNAPSHOT_NOT_UPDATE");
      } else if (context.snapshot.operation !== "rollback_check" && position >= 0) {
        blockers.push("SNAPSHOT_NOT_ROLLBACK");
      }
    } else if (action === "activate") {
      if (!context.exactCandidate) blockers.push("INACTIVE_CANDIDATE_MISSING");
      if (!context.lineageCandidateId || !context.candidateRevision) blockers.push("CANDIDATE_REVISION_MISSING");
      if (context.exactCandidate && ["revoked", "deprecated"].includes(context.exactCandidate.lifecycleState)) {
        blockers.push("CANDIDATE_NOT_ACTIVATABLE");
      }
      if (context.runtimeLifecycle?.lifecycleState === "revoked") blockers.push("RUNTIME_REVOKED");
      if (context.activeVersion) blockers.push("VERSION_ALREADY_ACTIVE");
      targetCandidateId = context.exactCandidate?.candidateId ?? targetCandidateId;
      targetVersionId = context.exactCandidate?.versionId ?? targetVersionId;
      supersedesVersionId = context.exactCandidate?.supersedesVersionId;
      expectedCandidateRevision = context.candidateRevision?.revision;
    } else {
      if (!context.exactCandidate || !context.activeVersion) blockers.push("VERSION_NOT_ACTIVE");
      if (!context.runtimeLifecycle || context.runtimeLifecycle.lifecycleState === "revoked") {
        blockers.push("RUNTIME_NOT_REVOCABLE");
      }
      if (!context.lineageCandidateId || !context.candidateRevision) blockers.push("CANDIDATE_REVISION_MISSING");
      if (!context.runtimeRevision) blockers.push("RUNTIME_REVISION_MISSING");
      targetCandidateId = context.exactCandidate?.candidateId ?? targetCandidateId;
      targetVersionId = context.exactCandidate?.versionId ?? targetVersionId;
      supersedesVersionId = context.exactCandidate?.supersedesVersionId;
      expectedCandidateRevision = context.candidateRevision?.revision;
      expectedRuntimeAbsent = false;
    }

    const normalizedBlockers = [...new Set(blockers)].sort();
    return {
      guard: { allowed: normalizedBlockers.length === 0, blockers: normalizedBlockers },
      targetCandidateId,
      targetVersionId,
      supersedesVersionId,
      expectedCandidateRevision,
      expectedRuntimeRevision,
      expectedCandidateAbsent,
      expectedRuntimeAbsent,
    };
  }

  private latestApprovalsBySnapshot(
    workspaceId: string,
  ): Map<string, Partial<Record<SkillHubOperatorAction, SkillHubOperatorApprovalSummary>>> {
    const result = new Map<string, Partial<Record<SkillHubOperatorAction, SkillHubOperatorApprovalSummary>>>();
    for (const approval of this.options.storage.approvals.list(undefined, 500, workspaceId)) {
      const intent = readOperatorIntent(approval);
      if (!intent) continue;
      const existing = result.get(intent.snapshotId) ?? {};
      if (!existing[intent.operationKind]) {
        existing[intent.operationKind] = this.summarizeApproval(approval);
        result.set(intent.snapshotId, existing);
      }
    }
    return result;
  }

  private summarizeApproval(approval: ApprovalRequest): SkillHubOperatorApprovalSummary {
    const intent = readOperatorIntent(approval);
    if (!intent) throw new TypeError(`Approval ${approval.approvalId} is not a Skill Hub operator action.`);
    const settlement = this.options.storage.skillHubOperations.findSettlementByOperationId(intent.operationId);
    return {
      approvalId: approval.approvalId,
      operationId: intent.operationId,
      operationKind: intent.operationKind,
      status: approval.status,
      createdAt: approval.createdAt,
      resolvedAt: approval.resolvedAt,
      settlement: settlement
        ? {
            settlementId: settlement.settlementId,
            disposition: settlement.disposition,
            resultSha256: settlement.resultSha256,
            evidenceEnvelopeId: settlement.evidenceEnvelopeId,
            journeyEventId: settlement.journeyEventId,
            settledAt: settlement.settledAt,
          }
        : undefined,
    };
  }

  private findReusableApproval(workspaceId: string, fingerprint: string): ApprovalRequest | undefined {
    return this.options.storage.approvals.list(undefined, 500, workspaceId).find((approval) => {
      const intent = readOperatorIntent(approval);
      return Boolean(
        intent &&
        operationFingerprintForIntent(intent) === fingerprint &&
        ["pending", "approved"].includes(approval.status),
      );
    });
  }

  private nextAttempt(workspaceId: string, fingerprint: string): number {
    const attempts = this.options.storage.approvals.list(undefined, 500, workspaceId).flatMap((approval) => {
      const intent = readOperatorIntent(approval);
      return intent && operationFingerprintForIntent(intent) === fingerprint ? [operationAttempt(intent)] : [];
    });
    return Math.max(0, ...attempts) + 1;
  }
}

function readOperatorIntent(approval: ApprovalRequest): SkillHubOperationIntentTemplate | undefined {
  if (approval.kind !== SKILL_HUB_LIFECYCLE_APPROVAL_KIND) return undefined;
  if (!isRecord(approval.preview)) return undefined;
  const preview = approval.preview as Partial<SkillHubOperationIntentPreview>;
  if (
    preview.schemaVersion !== SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA ||
    !isRecord(preview.intent) ||
    !isOperatorIntentTemplate(preview.intent)
  ) {
    return undefined;
  }
  return preview.intent;
}

function isOperatorIntentTemplate(value: Record<string, unknown>): value is SkillHubOperationIntentTemplate {
  if (
    !(
      isCanonicalIntentString(value.operationId, 256) &&
      isCanonicalIntentString(value.idempotencyKey, 256) &&
      isCanonicalIntentString(value.workspaceId, 256) &&
      OPERATOR_ACTIONS.includes(value.operationKind as SkillHubOperatorAction) &&
      isCanonicalIntentString(value.snapshotId, 256) &&
      isSha256(value.contentTreeSha256) &&
      isCanonicalIntentString(value.skillId, 256) &&
      isOptionalCanonicalIntentString(value.targetCandidateId, 256) &&
      isOptionalCanonicalIntentString(value.targetVersionId, 256) &&
      isOptionalCanonicalIntentString(value.supersedesVersionId, 256) &&
      isOptionalPositiveRevision(value.expectedCandidateRevision) &&
      isOptionalPositiveRevision(value.expectedRuntimeRevision) &&
      typeof value.expectedCandidateAbsent === "boolean" &&
      typeof value.expectedRuntimeAbsent === "boolean" &&
      isCanonicalIntentString(value.actorId, 256) &&
      isOptionalCanonicalIntentString(value.sessionId, 256) &&
      isOptionalCanonicalIntentString(value.turnId, 256) &&
      (value.turnId === undefined || value.sessionId !== undefined) &&
      isCanonicalIsoDateTime(value.createdAt)
    )
  ) {
    return false;
  }
  const intent = value as unknown as SkillHubOperationIntentTemplate;
  const match = /^skill-hub:lifecycle:([a-f0-9]{64}):([1-9][0-9]*)$/u.exec(intent.idempotencyKey);
  if (!match) return false;
  const fingerprint = operationFingerprintForIntent(intent);
  const attempt = Number(match[2]);
  return (
    match[1] === fingerprint &&
    Number.isSafeInteger(attempt) &&
    attempt > 0 &&
    intent.operationId === `skill-hub-op-${fingerprint.slice(0, 32)}-${match[2]}`
  );
}

function isCanonicalIntentString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.normalize("NFKC").trim() === value
  );
}

function isOptionalCanonicalIntentString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || isCanonicalIntentString(value, maxLength);
}

function isOptionalPositiveRevision(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCanonicalIsoDateTime(value: unknown): value is string {
  if (!isCanonicalIntentString(value, 64)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function operationFingerprintForIntent(intent: SkillHubOperationIntentTemplate): string {
  return operationFingerprint({
    workspaceId: intent.workspaceId,
    operationKind: intent.operationKind,
    snapshotId: intent.snapshotId,
    contentTreeSha256: intent.contentTreeSha256,
    skillId: intent.skillId,
    targetCandidateId: intent.targetCandidateId,
    targetVersionId: intent.targetVersionId,
    supersedesVersionId: intent.supersedesVersionId,
    expectedCandidateRevision: intent.expectedCandidateRevision,
    expectedRuntimeRevision: intent.expectedRuntimeRevision,
    expectedCandidateAbsent: intent.expectedCandidateAbsent,
    expectedRuntimeAbsent: intent.expectedRuntimeAbsent,
    actorId: intent.actorId,
    sessionId: intent.sessionId,
    turnId: intent.turnId,
  });
}

function operationAttempt(intent: SkillHubOperationIntentTemplate): number {
  return Number(intent.idempotencyKey.slice(intent.idempotencyKey.lastIndexOf(":") + 1));
}

function assertCreatedApprovalMatchesIntent(approval: ApprovalRequest, expected: ApprovalCreateInput): void {
  let matches: boolean;
  try {
    matches =
      isCanonicalIntentString(approval.approvalId, 256) &&
      approval.kind === expected.kind &&
      approval.riskLevel === expected.riskLevel &&
      approval.status === "pending" &&
      isCanonicalIsoDateTime(approval.createdAt) &&
      canonicalJsonString(approval.payload) === canonicalJsonString(expected.payload) &&
      canonicalJsonString(approval.preview) === canonicalJsonString(expected.preview) &&
      canonicalJsonString(approval.linkage) === canonicalJsonString(expected.linkage);
  } catch {
    matches = false;
  }
  if (!matches) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Created Skill Hub approval did not preserve its canonical preview, payload, and linkage.",
    });
  }
}

function resolveSnapshotSkillId(snapshot: SkillHubSnapshotRecord): string | undefined {
  const explicit =
    readMetadataString(snapshot.compatibility, "skillId") ?? readMetadataString(snapshot.provenance, "skillId");
  if (explicit?.startsWith("extra:") && isCanonicalSkillName(explicit.slice("extra:".length))) return explicit;
  const explicitName =
    readMetadataString(snapshot.compatibility, "skillName") ?? readMetadataString(snapshot.provenance, "skillName");
  if (explicitName && isCanonicalSkillName(explicitName)) return `extra:${explicitName}`;
  const tail = snapshot.canonicalSourceKey.split(/[/:]/u).filter(Boolean).at(-1);
  return tail && isCanonicalSkillName(tail) ? `extra:${tail}` : undefined;
}

function titleForSnapshot(snapshot: SkillHubSnapshotRecord): string {
  return resolveSnapshotSkillId(snapshot)?.slice("extra:".length) ?? snapshot.canonicalSourceKey;
}

function skillIdForName(name: string): string | undefined {
  return isCanonicalSkillName(name) ? `extra:${name}` : undefined;
}

function isCanonicalSkillName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(value) && value === value.normalize("NFKC").trim();
}

function candidateIdForSource(snapshot: SkillHubSnapshotRecord): string {
  return `skill-hub-candidate-${hashParts(snapshot.workspaceId, snapshot.canonicalSourceKey).slice(0, 32)}`;
}

function versionIdForSnapshot(snapshot: SkillHubSnapshotRecord): string {
  return `skill-hub-version-${hashParts(snapshot.workspaceId, snapshot.snapshotId, snapshot.contentTreeSha256).slice(0, 32)}`;
}

function hashParts(...parts: Array<string | number | boolean | undefined>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function operationFingerprint(
  input: Omit<SkillHubOperationIntentTemplate, "operationId" | "idempotencyKey" | "createdAt">,
): string {
  return hashParts(
    input.workspaceId,
    input.operationKind,
    input.snapshotId,
    input.contentTreeSha256,
    input.skillId,
    input.targetCandidateId,
    input.targetVersionId,
    input.supersedesVersionId,
    input.expectedCandidateRevision,
    input.expectedRuntimeRevision,
    input.expectedCandidateAbsent,
    input.expectedRuntimeAbsent,
    input.actorId,
    input.sessionId,
    input.turnId,
  );
}

function compareSnapshotPosition(left: SkillHubSnapshotRecord, right: SkillHubSnapshotRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.snapshotId.localeCompare(right.snapshotId);
}

function compareCandidateNewest(left: CandidateSkillVersionRecord, right: CandidateSkillVersionRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.versionId.localeCompare(left.versionId);
}

function uniqueCandidates(candidates: CandidateSkillVersionRecord[]): CandidateSkillVersionRecord[] {
  return [...new Map(candidates.map((candidate) => [candidate.versionId, candidate])).values()];
}

function readMetadataString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function normalizeRequired(value: string, label: string, maxLength: number): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength || normalized !== value) {
    throw new TypeError(`Skill Hub ${label} is missing, oversized, or noncanonical.`);
  }
  return normalized;
}

function normalizeOptional(value: string | undefined, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : normalizeRequired(value, label, maxLength);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value)) throw new TypeError("Skill Hub list limit must be an integer.");
  return Math.max(1, Math.min(value, SKILL_HUB_OPERATOR_MAX_ITEMS));
}
