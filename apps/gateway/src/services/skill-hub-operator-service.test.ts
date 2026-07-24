import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
  SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA,
  type ApprovalCreateInput,
  type ApprovalRequest,
  type CandidateSkillVersionRecord,
  type CapabilityCatalogEntry,
  type SkillHubOperationIntentTemplate,
  type SkillLifecycleRecord,
} from "@goatcitadel/contracts";
import type {
  SkillAggregateRevisionRecord,
  SkillHubSnapshotArtifactRecord,
  SkillHubSnapshotRecord,
  Storage,
} from "@goatcitadel/storage";
import { SkillHubOperatorService } from "./skill-hub-operator-service.js";

let historicalApprovalSequence = 0;

describe("SkillHubOperatorService", () => {
  it("lists workspace snapshots before candidates and exposes honest bounds, drift, audit, permissions, and guards", () => {
    const review = snapshot({ snapshotId: "snapshot-review", createdAt: "2026-07-14T00:03:00.000Z" });
    const blocked = snapshot({
      snapshotId: "snapshot-blocked",
      createdAt: "2026-07-14T00:02:00.000Z",
      trustDisposition: "blocked",
      blockerCodes: ["AUDIT_DOWNGRADE", "PERMISSION_WIDENED", "UPSTREAM_VERSION_BYTE_DRIFT"],
      permissionDiff: {
        version: "goatcitadel.skill-permission-diff.v1",
        disposition: "widened",
        dimensions: { toolIds: { added: ["shell.exec"], removed: [] } },
      },
    });
    const hiddenSentinel = snapshot({
      snapshotId: "snapshot-hidden",
      createdAt: "2026-07-14T00:01:00.000Z",
    });
    const harness = createHarness({ snapshots: [review, blocked, hiddenSentinel] });

    const result = harness.service.list({ workspaceId: "workspace-1", limit: 2 });

    expect(result.page).toEqual({
      limit: 2,
      returned: 2,
      truncated: true,
      candidateInventoryTruncated: false,
    });
    expect(result.summary).toMatchObject({ snapshots: 2, retainedCandidates: 0, inactive: 0, blocked: 1 });
    expect(result.items[0]).toMatchObject({
      snapshotId: "snapshot-review",
      candidate: undefined,
      runtime: { callable: false, inactiveCandidate: false },
      actions: { install_inactive: { allowed: true }, activate: { allowed: false } },
    });
    expect(result.items[1]).toMatchObject({
      snapshotId: "snapshot-blocked",
      snapshot: {
        sameVersionDifferentBytes: true,
        blockerCodes: ["AUDIT_DOWNGRADE", "PERMISSION_WIDENED", "UPSTREAM_VERSION_BYTE_DRIFT"],
        permissionDiff: { disposition: "widened" },
      },
      actions: { install_inactive: { allowed: false } },
    });
    expect(result.items[1]?.actions.install_inactive.blockers).toEqual(
      expect.arrayContaining(["AUDIT_DOWNGRADE", "PERMISSION_WIDENED", "SNAPSHOT_NOT_CANDIDATE"]),
    );
    expect(harness.storage.skillHubSnapshots.listByWorkspace).toHaveBeenCalledWith("workspace-1", 3);
  });

  it("counts only materialized non-active candidates as inactive and keeps active policy-blocked versions distinct", () => {
    const current = snapshot({ snapshotId: "snapshot-v1" });
    const exact = candidateVersion({
      versionId: "version-v1",
      upstreamSnapshotId: current.snapshotId,
      sourceFingerprint: current.contentTreeSha256,
    });
    const inactiveHarness = createHarness({ snapshots: [current], candidates: [exact] });
    const inactive = inactiveHarness.service.list({ workspaceId: "workspace-1" });
    expect(inactive.summary.inactive).toBe(1);
    expect(inactive.items[0]?.runtime).toMatchObject({
      activeVersion: false,
      callable: false,
      inactiveCandidate: true,
    });

    const activeHarness = createHarness({
      snapshots: [current],
      candidates: [exact],
      lifecycle: activeLifecycle(current),
    });
    const active = activeHarness.service.list({ workspaceId: "workspace-1" });
    expect(active.summary.inactive).toBe(0);
    expect(active.items[0]?.runtime).toMatchObject({
      activeVersion: true,
      callable: false,
      inactiveCandidate: false,
    });
  });

  it("builds exact server-derived intents for all five lifecycle kinds", async () => {
    const v1Snapshot = snapshot({
      snapshotId: "snapshot-v1",
      contentTreeSha256: "1".repeat(64),
      declaredVersion: "1.0.0",
      createdAt: "2026-07-14T00:01:00.000Z",
    });
    const v2Snapshot = snapshot({
      snapshotId: "snapshot-v2",
      contentTreeSha256: "2".repeat(64),
      declaredVersion: "2.0.0",
      priorSnapshotId: "snapshot-v1",
      operation: "update_stage",
      createdAt: "2026-07-14T00:02:00.000Z",
    });
    const rollbackSnapshot = snapshot({
      snapshotId: "snapshot-rollback",
      contentTreeSha256: "1".repeat(64),
      declaredVersion: "1.0.0",
      priorSnapshotId: "snapshot-v2",
      operation: "rollback_check",
      createdAt: "2026-07-14T00:03:00.000Z",
    });
    const v1 = candidateVersion({
      versionId: "version-v1",
      upstreamSnapshotId: "snapshot-v1",
      sourceFingerprint: v1Snapshot.contentTreeSha256,
    });
    const v2 = candidateVersion({
      versionId: "version-v2",
      upstreamSnapshotId: "snapshot-v2",
      sourceFingerprint: v2Snapshot.contentTreeSha256,
      supersedesVersionId: "version-v1",
      lifecycleState: "approved",
      updatedAt: "2026-07-14T00:02:30.000Z",
    });

    const installHarness = createHarness({ snapshots: [v1Snapshot] });
    const install = await createIntent(installHarness, "snapshot-v1", "install_inactive");
    expect(install).toMatchObject({
      operationKind: "install_inactive",
      snapshotId: "snapshot-v1",
      skillId: "extra:demo",
      expectedCandidateAbsent: true,
      expectedRuntimeAbsent: true,
    });
    expect(install.targetCandidateId).toMatch(/^skill-hub-candidate-/u);
    expect(install.targetVersionId).toMatch(/^skill-hub-version-/u);

    const updateHarness = createHarness({
      snapshots: [v2Snapshot, v1Snapshot],
      candidates: [v1],
      lifecycle: activeLifecycle(v1Snapshot),
    });
    const update = await createIntent(updateHarness, "snapshot-v2", "stage_update_candidate");
    expect(update).toMatchObject({
      operationKind: "stage_update_candidate",
      targetCandidateId: "candidate-demo",
      supersedesVersionId: "version-v1",
      expectedCandidateRevision: 3,
      expectedRuntimeRevision: 2,
      expectedCandidateAbsent: false,
      expectedRuntimeAbsent: false,
    });

    const rollbackHarness = createHarness({
      snapshots: [rollbackSnapshot, v2Snapshot, v1Snapshot],
      candidates: [v2, v1],
      lifecycle: activeLifecycle(v2Snapshot),
    });
    const rollback = await createIntent(rollbackHarness, "snapshot-rollback", "stage_rollback_candidate");
    expect(rollback).toMatchObject({
      operationKind: "stage_rollback_candidate",
      targetCandidateId: "candidate-demo",
      supersedesVersionId: "version-v2",
      expectedCandidateRevision: 3,
      expectedRuntimeRevision: 2,
      expectedCandidateAbsent: false,
      expectedRuntimeAbsent: false,
    });

    const activateHarness = createHarness({ snapshots: [v1Snapshot], candidates: [v1] });
    const activation = await createIntent(activateHarness, "snapshot-v1", "activate");
    expect(activation).toMatchObject({
      operationKind: "activate",
      targetCandidateId: "candidate-demo",
      targetVersionId: "version-v1",
      expectedCandidateRevision: 3,
      expectedCandidateAbsent: false,
      expectedRuntimeAbsent: true,
    });
    expect(activation.expectedRuntimeRevision).toBeUndefined();

    const revokeHarness = createHarness({
      snapshots: [v2Snapshot, v1Snapshot],
      candidates: [v2, v1],
      lifecycle: activeLifecycle(v2Snapshot),
    });
    const revoke = await createIntent(revokeHarness, "snapshot-v2", "revoke");
    expect(revoke).toMatchObject({
      operationKind: "revoke",
      targetCandidateId: "candidate-demo",
      targetVersionId: "version-v2",
      expectedCandidateRevision: 3,
      expectedRuntimeRevision: 2,
      expectedCandidateAbsent: false,
      expectedRuntimeAbsent: false,
    });
  });

  it("blocks update and rollback staging for an installed inactive lineage without runtime revision", async () => {
    const v1Snapshot = snapshot({
      snapshotId: "snapshot-v1",
      contentTreeSha256: "1".repeat(64),
      createdAt: "2026-07-14T00:01:00.000Z",
    });
    const v2Snapshot = snapshot({
      snapshotId: "snapshot-v2",
      contentTreeSha256: "2".repeat(64),
      declaredVersion: "2.0.0",
      priorSnapshotId: "snapshot-v1",
      operation: "update_stage",
      createdAt: "2026-07-14T00:02:00.000Z",
    });
    const v1 = candidateVersion({
      versionId: "version-v1",
      upstreamSnapshotId: "snapshot-v1",
      sourceFingerprint: v1Snapshot.contentTreeSha256,
    });
    const harness = createHarness({ snapshots: [v2Snapshot, v1Snapshot], candidates: [v1] });

    const listed = harness.service.list({ workspaceId: "workspace-1" });
    const updateItem = listed.items.find((item) => item.snapshotId === "snapshot-v2")!;
    expect(updateItem.actions.stage_update_candidate).toEqual({
      allowed: false,
      blockers: expect.arrayContaining(["RUNTIME_LINEAGE_MISSING"]),
    });
    const installedItem = listed.items.find((item) => item.snapshotId === "snapshot-v1")!;
    expect(installedItem.actions.activate.allowed).toBe(true);
    await expect(
      harness.service.createApproval({
        workspaceId: "workspace-1",
        snapshotId: "snapshot-v2",
        operationKind: "stage_update_candidate",
        actorId: "operator-1",
      }),
    ).rejects.toThrow(/RUNTIME_LINEAGE_MISSING/u);
  });

  it("rejects turn lineage without a parent session before creating an approval", async () => {
    const current = snapshot({ snapshotId: "snapshot-install" });
    const harness = createHarness({ snapshots: [current] });

    await expect(
      harness.service.createApproval({
        workspaceId: "workspace-1",
        snapshotId: current.snapshotId,
        operationKind: "install_inactive",
        actorId: "operator-1",
        turnId: "turn-orphaned",
      }),
    ).rejects.toThrow("Skill Hub turn lineage requires a session ID.");
    expect(harness.createApproval).not.toHaveBeenCalled();
  });

  it("reuses an equivalent pending approval without creating a duplicate", async () => {
    const current = snapshot({ snapshotId: "snapshot-install" });
    const harness = createHarness({ snapshots: [current] });

    const first = await harness.service.createApproval({
      workspaceId: "workspace-1",
      snapshotId: current.snapshotId,
      operationKind: "install_inactive",
      actorId: "operator-1",
    });
    const second = await harness.service.createApproval({
      workspaceId: "workspace-1",
      snapshotId: current.snapshotId,
      operationKind: "install_inactive",
      actorId: "operator-1",
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.approval.approvalId).toBe(first.approval.approvalId);
    expect(harness.createApproval).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a forged idempotency prefix whose immutable intent fingerprint changed", async () => {
    const current = snapshot({ snapshotId: "snapshot-install" });
    const harness = createHarness({ snapshots: [current] });
    await harness.service.createApproval({
      workspaceId: "workspace-1",
      snapshotId: current.snapshotId,
      operationKind: "install_inactive",
      actorId: "operator-1",
    });
    const prior = harness.approvals[0]!;
    const preview = prior.preview as { schemaVersion: string; intent: SkillHubOperationIntentTemplate };
    prior.preview = {
      ...preview,
      intent: { ...preview.intent, actorId: "operator-forged" },
    };

    const result = await harness.service.createApproval({
      workspaceId: "workspace-1",
      snapshotId: current.snapshotId,
      operationKind: "install_inactive",
      actorId: "operator-1",
    });

    expect(result.reused).toBe(false);
    expect(harness.createApproval).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent equivalent requests inside one Gateway process", async () => {
    const current = snapshot({ snapshotId: "snapshot-install" });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const harness = createHarness({
      snapshots: [current],
      beforeCreateApproval: async () => createGate,
    });

    const firstPending = harness.service.createApproval({
      workspaceId: "workspace-1",
      snapshotId: current.snapshotId,
      operationKind: "install_inactive",
      actorId: "operator-1",
    });
    const secondPending = harness.service.createApproval({
      workspaceId: "workspace-1",
      snapshotId: current.snapshotId,
      operationKind: "install_inactive",
      actorId: "operator-1",
    });

    expect(harness.createApproval).toHaveBeenCalledTimes(1);
    releaseCreate();
    const results = await Promise.all([firstPending, secondPending]);

    expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
    expect(results[0]?.approval.approvalId).toBe(results[1]?.approval.approvalId);
    expect(harness.createApproval).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed historical lifecycle previews instead of crashing list or create", async () => {
    const current = snapshot({ snapshotId: "snapshot-install" });
    const malformedMissingIdentity = historicalApproval({
      operationKind: "install_inactive",
      snapshotId: current.snapshotId,
    });
    const malformedOptionalRevision = historicalApproval({
      operationId: "skill-hub-op-corrupt-1",
      idempotencyKey: `skill-hub:lifecycle:${"a".repeat(64)}:1`,
      workspaceId: "workspace-1",
      operationKind: "install_inactive",
      snapshotId: current.snapshotId,
      contentTreeSha256: current.contentTreeSha256,
      skillId: "extra:demo",
      targetCandidateId: "candidate-demo",
      targetVersionId: "version-demo",
      expectedCandidateRevision: "not-a-revision",
      expectedCandidateAbsent: false,
      expectedRuntimeAbsent: true,
      actorId: "operator-1",
      createdAt: "2026-07-14T01:00:00.000Z",
    });
    const impossibleOrphanedTurn = historicalApproval(
      canonicalHistoricalIntent({ turnId: "turn-orphaned", sessionId: undefined }),
    );
    const harness = createHarness({
      snapshots: [current],
      approvals: [malformedMissingIdentity, malformedOptionalRevision, impossibleOrphanedTurn],
    });

    const listed = harness.service.list({ workspaceId: "workspace-1" });
    expect(listed.items[0]?.approvals).toEqual({});

    const created = await harness.service.createApproval({
      workspaceId: "workspace-1",
      snapshotId: current.snapshotId,
      operationKind: "install_inactive",
      actorId: "operator-1",
    });

    expect(created.reused).toBe(false);
    expect(harness.createApproval).toHaveBeenCalledTimes(1);
  });

  it("fails closed when approval creation returns a hook-mutated canonical boundary", async () => {
    const current = snapshot({ snapshotId: "snapshot-install" });
    const harness = createHarness({
      snapshots: [current],
      transformCreatedApproval: (approval) => {
        const preview = approval.preview as { schemaVersion: string; intent: SkillHubOperationIntentTemplate };
        return {
          ...approval,
          preview: {
            ...preview,
            intent: { ...preview.intent, snapshotId: "snapshot-hook-mutated" },
          },
        };
      },
    });

    await expect(
      harness.service.createApproval({
        workspaceId: "workspace-1",
        snapshotId: current.snapshotId,
        operationKind: "install_inactive",
        actorId: "operator-1",
      }),
    ).rejects.toThrow(/did not preserve its canonical preview, payload, and linkage/u);
    expect(harness.createApproval).toHaveBeenCalledTimes(1);
  });
});

async function createIntent(
  harness: ReturnType<typeof createHarness>,
  snapshotId: string,
  operationKind: SkillHubOperationIntentTemplate["operationKind"],
): Promise<SkillHubOperationIntentTemplate> {
  await harness.service.createApproval({
    workspaceId: "workspace-1",
    snapshotId,
    operationKind,
    actorId: "operator-1",
  });
  const input = harness.createApproval.mock.calls[0]?.[0] as ApprovalCreateInput;
  return (input.preview as { intent: SkillHubOperationIntentTemplate }).intent;
}

function createHarness(input: {
  snapshots: SkillHubSnapshotRecord[];
  candidates?: CandidateSkillVersionRecord[];
  lifecycle?: SkillLifecycleRecord;
  approvals?: ApprovalRequest[];
  catalogEntry?: CapabilityCatalogEntry;
  beforeCreateApproval?: () => Promise<void>;
  transformCreatedApproval?: (approval: ApprovalRequest) => ApprovalRequest;
}) {
  const approvals = input.approvals ?? [];
  const candidates = input.candidates ?? [];
  const createApproval = vi.fn(async (approvalInput: ApprovalCreateInput): Promise<ApprovalRequest> => {
    await input.beforeCreateApproval?.();
    const approval: ApprovalRequest = {
      approvalId: `approval-${approvals.length + 1}`,
      kind: approvalInput.kind,
      riskLevel: approvalInput.riskLevel,
      status: "pending",
      payload: approvalInput.payload,
      preview: approvalInput.preview,
      linkage: approvalInput.linkage,
      createdAt: "2026-07-14T01:00:00.000Z",
      explanationStatus: "not_requested",
    };
    const returnedApproval = input.transformCreatedApproval?.(approval) ?? approval;
    approvals.unshift(returnedApproval);
    return returnedApproval;
  });
  const storage = {
    approvals: { list: vi.fn(() => approvals) },
    candidateSkillVersions: {
      list: vi.fn(() => candidates),
      find: vi.fn((versionId: string) => candidates.find((candidate) => candidate.versionId === versionId)),
      listByCandidateId: vi.fn((candidateId: string) =>
        candidates.filter((candidate) => candidate.candidateId === candidateId),
      ),
    },
    skillHubSnapshots: {
      listByWorkspace: vi.fn((_workspaceId: string, limit: number) => input.snapshots.slice(0, limit)),
      get: vi.fn((snapshotId: string) => {
        const found = input.snapshots.find((item) => item.snapshotId === snapshotId);
        if (!found) throw new Error(`missing snapshot ${snapshotId}`);
        return found;
      }),
      find: vi.fn((snapshotId: string) => input.snapshots.find((item) => item.snapshotId === snapshotId)),
      findSameVersionByteDrift: vi.fn((query: { declaredVersion?: string; contentTreeSha256: string }) =>
        input.snapshots.find(
          (item) =>
            item.declaredVersion === query.declaredVersion && item.contentTreeSha256 !== query.contentTreeSha256,
        ),
      ),
    },
    skillHubArtifacts: {
      findBySnapshot: vi.fn((_workspaceId: string, snapshotId: string) => {
        const found = input.snapshots.find((item) => item.snapshotId === snapshotId);
        return found ? artifact(found) : undefined;
      }),
    },
    skillHubOperations: { findSettlementByOperationId: vi.fn(() => undefined) },
    skillLifecycle: { find: vi.fn(() => input.lifecycle) },
    skillAggregateRevisions: {
      get: vi.fn((kind: "candidate_skill" | "runtime_skill", aggregateId: string) => {
        if (kind === "candidate_skill" && candidates.some((candidate) => candidate.candidateId === aggregateId)) {
          return revision("candidate_skill", aggregateId, 3);
        }
        if (kind === "runtime_skill" && input.lifecycle?.skillId === aggregateId) {
          return revision("runtime_skill", aggregateId, 2);
        }
        return undefined;
      }),
    },
  } as unknown as Pick<
    Storage,
    | "approvals"
    | "candidateSkillVersions"
    | "skillHubSnapshots"
    | "skillHubArtifacts"
    | "skillHubOperations"
    | "skillLifecycle"
    | "skillAggregateRevisions"
  >;
  const service = new SkillHubOperatorService({
    storage,
    createApproval,
    listInspectableCatalog: () => (input.catalogEntry ? [input.catalogEntry] : []),
    now: () => "2026-07-14T01:00:00.000Z",
  });
  return { service, storage, approvals, createApproval };
}

function historicalApproval(intent: Record<string, unknown>): ApprovalRequest {
  historicalApprovalSequence += 1;
  return {
    approvalId: `approval-historical-${historicalApprovalSequence}`,
    kind: SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
    riskLevel: "danger",
    status: "pending",
    payload: {},
    preview: {
      schemaVersion: SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA,
      intent,
    },
    linkage: { workspaceId: "workspace-1" },
    createdAt: "2026-07-14T00:30:00.000Z",
    explanationStatus: "not_requested",
  };
}

function canonicalHistoricalIntent(
  overrides: Partial<SkillHubOperationIntentTemplate> = {},
): SkillHubOperationIntentTemplate {
  const base = {
    workspaceId: "workspace-1",
    operationKind: "install_inactive" as const,
    snapshotId: "snapshot-install",
    contentTreeSha256: "1".repeat(64),
    skillId: "extra:demo",
    targetCandidateId: "candidate-demo",
    targetVersionId: "version-demo",
    expectedCandidateAbsent: true,
    expectedRuntimeAbsent: true,
    actorId: "operator-1",
    ...overrides,
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        base.workspaceId,
        base.operationKind,
        base.snapshotId,
        base.contentTreeSha256,
        base.skillId,
        base.targetCandidateId,
        base.targetVersionId,
        base.supersedesVersionId,
        base.expectedCandidateRevision,
        base.expectedRuntimeRevision,
        base.expectedCandidateAbsent,
        base.expectedRuntimeAbsent,
        base.actorId,
        base.sessionId,
        base.turnId,
      ]),
    )
    .digest("hex");
  return {
    ...base,
    operationId: `skill-hub-op-${fingerprint.slice(0, 32)}-1`,
    idempotencyKey: `skill-hub:lifecycle:${fingerprint}:1`,
    createdAt: "2026-07-14T01:00:00.000Z",
  };
}

function candidateVersion(overrides: Partial<CandidateSkillVersionRecord> = {}): CandidateSkillVersionRecord {
  return {
    candidateId: "candidate-demo",
    versionId: "version-v1",
    sourceKind: "upstream_hub",
    lineageStatus: "governed",
    workspaceId: "workspace-1",
    sourceFingerprint: "1".repeat(64),
    upstreamSnapshotId: "snapshot-v1",
    createdByActorId: "operator-1",
    title: "demo",
    summary: "Immutable inactive upstream candidate",
    bundleRoot: "data/candidates/demo",
    lifecycleState: "candidate",
    manifestArtifact: capabilityArtifact("manifest"),
    instructionArtifact: capabilityArtifact("instruction"),
    proofArtifact: capabilityArtifact("proof"),
    createdAt: "2026-07-14T00:01:00.000Z",
    updatedAt: "2026-07-14T00:01:00.000Z",
    ...overrides,
  };
}

function capabilityArtifact(name: string) {
  return {
    artifactId: `artifact-${name}`,
    relPath: `${name}.json`,
    sha256: "a".repeat(64),
    bytes: 100,
    mimeType: "application/json",
    createdAt: "2026-07-14T00:00:00.000Z",
  };
}

function snapshot(overrides: Partial<SkillHubSnapshotRecord> = {}): SkillHubSnapshotRecord {
  return {
    snapshotId: "snapshot-v1",
    workspaceId: "workspace-1",
    operation: "review",
    sourceProvider: "clawhub",
    sourceType: "registry",
    sourceRef: "clawhub:demo",
    canonicalSourceKey: "clawhub/demo",
    declaredVersion: "1.0.0",
    resolvedVersion: "commit-v1",
    contentTreeSha256: "1".repeat(64),
    provenance: { source: "clawhub" },
    audit: {
      policyId: "skill-import",
      policyVersion: "2.0.0",
      policyRevision: 2,
      scanners: [{ scannerId: "static", scannerVersion: "2.0.0", revision: 2, coverageIds: ["scripts"] }],
      findingCodes: [],
      blockerCodes: [],
      approvedBlockerResolutions: [],
    },
    auditSha256: "3".repeat(64),
    auditFloor: {
      version: "goatcitadel.skill-upstream-audit-floor.v1",
      policyId: "skill-import",
      policyVersion: "2.0.0",
      policyRevision: 2,
      scanners: [{ scannerId: "static", scannerVersion: "2.0.0", revision: 2, coverageIds: ["scripts"] }],
      effectiveBlockerCodes: [],
    },
    auditFloorSha256: "4".repeat(64),
    permissionEnvelope: { version: "goatcitadel.skill-permission-envelope.v1" },
    permissionEnvelopeSha256: "5".repeat(64),
    permissionDiff: { version: "goatcitadel.skill-permission-diff.v1", disposition: "none" },
    compatibility: { skillId: "extra:demo", compatible: true },
    riskLevel: "low",
    trustDisposition: "candidate",
    blockerCodes: [],
    createdAt: "2026-07-14T00:01:00.000Z",
    ...overrides,
  };
}

function artifact(snapshotRecord: SkillHubSnapshotRecord): SkillHubSnapshotArtifactRecord {
  return {
    artifactId: `artifact-${snapshotRecord.snapshotId}`,
    workspaceId: snapshotRecord.workspaceId,
    snapshotId: snapshotRecord.snapshotId,
    contentTreeSha256: snapshotRecord.contentTreeSha256,
    bundleRelPath: `sha256/${snapshotRecord.contentTreeSha256}`,
    manifest: {
      manifestVersion: "goatcitadel.skill-tree.v1",
      algorithm: "sha256",
      treeSha256: snapshotRecord.contentTreeSha256,
      excludedPaths: ["source.json", ".git/**"],
      fileCount: 1,
      totalBytes: 100,
      files: [{ path: "SKILL.md", sha256: "6".repeat(64), bytes: 100 }],
    },
    manifestSha256: "7".repeat(64),
    fileCount: 1,
    totalBytes: 100,
    createdAt: "2026-07-14T00:00:00.000Z",
  };
}

function activeLifecycle(activeSnapshot: SkillHubSnapshotRecord): SkillLifecycleRecord {
  return {
    skillId: "extra:demo",
    category: "community_imported",
    lifecycleState: "approved",
    trustLabel: "Approved upstream snapshot",
    provenance: {
      source: "extra",
      sourceRef: activeSnapshot.snapshotId,
      contentIntegrity: {
        manifestVersion: "goatcitadel.skill-tree.v1",
        treeSha256: activeSnapshot.contentTreeSha256,
        fileCount: 1,
        totalBytes: 100,
        verified: true,
      },
    },
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function revision(
  aggregateKind: "candidate_skill" | "runtime_skill",
  aggregateId: string,
  value: number,
): SkillAggregateRevisionRecord {
  return {
    aggregateKind,
    aggregateId,
    revision: value,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}
