import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalJsonString, skillHubArtifactBundleRelPath } from "@goatcitadel/contracts";
import type {
  SkillContentIntegrityManifest,
  SkillHubOperationIntentRecord,
  SkillHubOperationSettlementRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import {
  SkillHubArtifactRepository,
  computeSkillHubManifestSha256,
  computeSkillHubTreeSha256,
} from "./skill-hub-artifact-repo.js";
import {
  SkillHubOperationRepository,
  computeSkillHubOperationRequestSha256,
  computeSkillHubOperationResultSha256,
} from "./skill-hub-operation-repo.js";
import { SkillHubSnapshotRepository, type SkillHubSnapshotCreateInput } from "./skill-hub-snapshot-repo.js";
import { createDatabase } from "./sqlite.js";

const opened: DatabaseClient[] = [];
const files: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const file of files.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

describe("SkillHubOperationRepository", () => {
  it("stores exactly one approval-bound immutable intent with exact replay", () => {
    const { db, operations, manifest } = createStore();
    const input = intent(manifest, { approvalId: "approval-1" });
    insertApproval(db, input);

    assertCanonicalEqual(operations.createIntent(input), input);
    assertCanonicalEqual(operations.createIntent(input), input);
    assertCanonicalEqual(operations.findIntentByApprovalId("approval-1"), input);
    assertCanonicalEqual(operations.findIntentByIdempotencyKey(input.idempotencyKey), input);

    const conflictingBase = {
      ...withoutRequestHash(input),
      operationId: "operation-2",
      approvalId: "approval-2",
    };
    const conflicting = {
      ...conflictingBase,
      requestSha256: computeSkillHubOperationRequestSha256(conflictingBase),
    };
    insertApproval(db, conflicting);
    assert.throws(() => operations.createIntent(conflicting), /conflicts with an immutable record/);
    assert.throws(
      () => db.prepare("UPDATE skill_hub_operation_intents SET actor_id = 'changed'").run(),
      /operation intents are immutable/,
    );
  });

  it("fails closed on inconsistent lifecycle expectations and foreign approval/source linkage", () => {
    const { db, operations, manifest } = createStore();
    const input = intent(manifest, { approvalId: "approval-1" });
    insertApproval(db, input);
    const invalidBase = {
      ...withoutRequestHash(input),
      expectedRuntimeAbsent: false,
    };
    assert.throws(
      () =>
        operations.createIntent({
          ...invalidBase,
          requestSha256: computeSkillHubOperationRequestSha256(invalidBase),
        }),
      /runtime absence and expected revision are inconsistent/,
    );
    const foreignApprovalBase = {
      ...withoutRequestHash(input),
      operationId: "operation-foreign-approval",
      idempotencyKey: "operation:foreign-approval",
      approvalId: "approval-missing",
    };
    assert.throws(() =>
      operations.createIntent({
        ...foreignApprovalBase,
        requestSha256: computeSkillHubOperationRequestSha256(foreignApprovalBase),
      }),
    );
    const foreignTreeBase = {
      ...withoutRequestHash(input),
      operationId: "operation-foreign-tree",
      idempotencyKey: "operation:foreign-tree",
      approvalId: "approval-2",
      contentTreeSha256: "f".repeat(64),
    };
    const foreignTree = {
      ...foreignTreeBase,
      requestSha256: computeSkillHubOperationRequestSha256(foreignTreeBase),
    };
    insertApproval(db, foreignTree);
    assert.throws(() => operations.createIntent(foreignTree));
  });

  it("rejects unrelated, pending, mismatched, and cross-workspace approvals", () => {
    const { db, operations, manifest } = createStore();
    const unrelated = intent(manifest, {
      operationId: "operation-unrelated",
      idempotencyKey: "operation:unrelated",
      approvalId: "approval-unrelated",
    });
    insertApproval(db, unrelated, { kind: "tool_execution" });
    assert.throws(() => operations.createIntent(unrelated), /approved dedicated lifecycle approval/);
    assert.throws(() => insertRawIntent(db, unrelated), /approval does not match/);

    const pending = intent(manifest, {
      operationId: "operation-pending",
      idempotencyKey: "operation:pending",
      approvalId: "approval-pending",
    });
    insertApproval(db, pending, { status: "pending" });
    assert.throws(() => operations.createIntent(pending), /approved dedicated lifecycle approval/);

    const mismatched = intent(manifest, {
      operationId: "operation-mismatch",
      idempotencyKey: "operation:mismatch",
      approvalId: "approval-mismatch",
    });
    insertApproval(db, mismatched, { payload: { requestSha256: "f".repeat(64) } });
    assert.throws(() => operations.createIntent(mismatched), /approval payload must exactly match/);

    const extraPayload = intent(manifest, {
      operationId: "operation-extra-payload",
      idempotencyKey: "operation:extra-payload",
      approvalId: "approval-extra-payload",
    });
    insertApproval(db, extraPayload, {
      payload: { unrelatedEffect: { kind: "shell.exec", args: ["whoami"] } },
    });
    assert.throws(() => operations.createIntent(extraPayload), /approval payload must exactly match/);
    assert.throws(() => insertRawIntent(db, extraPayload), /approval does not match/);

    const extraLinkage = intent(manifest, {
      operationId: "operation-extra-linkage",
      idempotencyKey: "operation:extra-linkage",
      approvalId: "approval-extra-linkage",
    });
    insertApproval(db, extraLinkage, {
      linkage: { foreignSession: { sessionId: "session-other" } },
    });
    assert.throws(() => operations.createIntent(extraLinkage), /approval linkage must exactly match/);
    assert.throws(() => insertRawIntent(db, extraLinkage), /approval does not match/);

    const crossWorkspace = intent(manifest, {
      operationId: "operation-cross-workspace",
      idempotencyKey: "operation:cross-workspace",
      approvalId: "approval-cross-workspace",
      workspaceId: "workspace-2",
    });
    insertApproval(db, crossWorkspace);
    assert.throws(() => operations.createIntent(crossWorkspace), /artifact in the same workspace/);
  });

  it("accepts update and rollback candidates only with existing candidate and runtime revisions", () => {
    const { db, operations, manifest } = createStore();
    for (const [index, operationKind] of (["stage_update_candidate", "stage_rollback_candidate"] as const).entries()) {
      const requested = intent(manifest, {
        operationId: `operation-revision-${index}`,
        idempotencyKey: `operation:revision:${index}`,
        approvalId: `approval-revision-${index}`,
        operationKind,
        supersedesVersionId: "candidate-version-2",
        expectedCandidateRevision: 3,
        expectedRuntimeRevision: 4,
        expectedCandidateAbsent: false,
        expectedRuntimeAbsent: false,
      });
      insertApproval(db, requested);
      assertCanonicalEqual(operations.createIntent(requested), requested);
    }

    const invalid = intent(manifest, {
      operationId: "operation-invalid-update",
      idempotencyKey: "operation:invalid-update",
      approvalId: "approval-invalid-update",
      operationKind: "stage_update_candidate",
      supersedesVersionId: "candidate-version-2",
      expectedRuntimeRevision: 4,
      expectedCandidateAbsent: true,
      expectedRuntimeAbsent: false,
    });
    insertApproval(db, invalid);
    assert.throws(() => operations.createIntent(invalid), /lineage expectations/);
  });

  it("preserves first activation, update activation, and revoke aggregate shapes", () => {
    const { db, operations, manifest } = createStore();
    const shapes: Array<Partial<Omit<SkillHubOperationIntentRecord, "requestSha256">>> = [
      {
        operationKind: "activate",
        expectedCandidateRevision: 1,
        expectedCandidateAbsent: false,
        expectedRuntimeAbsent: true,
      },
      {
        operationKind: "activate",
        expectedCandidateRevision: 2,
        expectedRuntimeRevision: 3,
        expectedCandidateAbsent: false,
        expectedRuntimeAbsent: false,
      },
      {
        operationKind: "revoke",
        expectedCandidateRevision: 4,
        expectedRuntimeRevision: 5,
        expectedCandidateAbsent: false,
        expectedRuntimeAbsent: false,
      },
    ];
    for (const [index, shape] of shapes.entries()) {
      const requested = intent(manifest, {
        operationId: `operation-activation-shape-${index}`,
        idempotencyKey: `operation:activation-shape:${index}`,
        approvalId: `approval-activation-shape-${index}`,
        ...shape,
      });
      insertApproval(db, requested);
      assertCanonicalEqual(operations.createIntent(requested), requested);
    }
  });

  it("requires evidence and Journey parents for one immutable terminal settlement", () => {
    const { db, operations, manifest } = createStore();
    const requested = intent(manifest, { approvalId: "approval-1" });
    insertApproval(db, requested);
    const operation = operations.createIntent(requested);
    const result = { status: "inactive_candidate", blockerCodes: [] };
    const resultSha256 = computeSkillHubOperationResultSha256(result);
    insertEvidenceAndJourney(db, operation, "artifact-1", "evidence-1", "journey-1", resultSha256);
    const settlement: SkillHubOperationSettlementRecord = {
      settlementId: "settlement-1",
      operationId: operation.operationId,
      workspaceId: operation.workspaceId,
      approvalId: operation.approvalId,
      contentTreeSha256: operation.contentTreeSha256,
      disposition: "applied",
      observedTreeSha256: operation.contentTreeSha256,
      candidateRevision: 1,
      evidenceEnvelopeId: "evidence-1",
      journeyEventId: "journey-1",
      result,
      resultSha256,
      settledAt: "2026-07-13T18:05:00.000Z",
    };

    assert.throws(
      () => operations.createSettlement({ ...settlement, observedTreeSha256: "f".repeat(64) }),
      /must observe the exact intent tree/,
    );
    assertCanonicalEqual(operations.createSettlement(settlement), settlement);
    assertCanonicalEqual(operations.createSettlement(settlement), settlement);
    assertCanonicalEqual(operations.findSettlementByOperationId(operation.operationId), settlement);
    assert.throws(
      () => operations.createSettlement({ ...settlement, settlementId: "settlement-2" }),
      /conflicts with an immutable record/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM skill_hub_operation_settlements").run(),
      /operation settlements are immutable/,
    );

    const secondBase = {
      ...withoutRequestHash(operation),
      operationId: "operation-2",
      idempotencyKey: "operation:2",
      approvalId: "approval-2",
    };
    const secondRequest = {
      ...secondBase,
      requestSha256: computeSkillHubOperationRequestSha256(secondBase),
    };
    insertApproval(db, secondRequest);
    const second = operations.createIntent(secondRequest);
    const missingEvidenceResult = { status: "blocked" };
    assert.throws(() =>
      operations.createSettlement({
        settlementId: "settlement-missing-evidence",
        operationId: second.operationId,
        workspaceId: second.workspaceId,
        approvalId: second.approvalId,
        contentTreeSha256: second.contentTreeSha256,
        disposition: "blocked",
        observedTreeSha256: second.contentTreeSha256,
        evidenceEnvelopeId: "evidence-missing",
        journeyEventId: "journey-1",
        result: missingEvidenceResult,
        resultSha256: computeSkillHubOperationResultSha256(missingEvidenceResult),
        settledAt: "2026-07-13T18:06:00.000Z",
      }),
    );
  });

  it("requires same-workspace semantic evidence and Journey bindings while allowing blocked drift", () => {
    const { db, operations, manifest } = createStore();
    const requested = intent(manifest, { approvalId: "approval-blocked" });
    insertApproval(db, requested);
    const operation = operations.createIntent(requested);
    const result = { status: "blocked", blockerCodes: ["AUDIT_DOWNGRADE"] };
    const resultSha256 = computeSkillHubOperationResultSha256(result);
    insertEvidenceAndJourney(
      db,
      operation,
      "artifact-1",
      "evidence-wrong-workspace",
      "journey-wrong-workspace",
      resultSha256,
      { evidenceWorkspaceId: "workspace-2", journeyWorkspaceId: "workspace-2" },
    );
    const baseSettlement: SkillHubOperationSettlementRecord = {
      settlementId: "settlement-blocked",
      operationId: operation.operationId,
      workspaceId: operation.workspaceId,
      approvalId: operation.approvalId,
      contentTreeSha256: operation.contentTreeSha256,
      disposition: "blocked",
      observedTreeSha256: "f".repeat(64),
      evidenceEnvelopeId: "evidence-wrong-workspace",
      journeyEventId: "journey-wrong-workspace",
      result,
      resultSha256,
      settledAt: "2026-07-13T18:07:00.000Z",
    };
    assert.throws(() => operations.createSettlement(baseSettlement), /evidence does not match/);
    assert.throws(() => insertRawSettlement(db, baseSettlement), /FOREIGN KEY|binding does not match/);

    insertEvidenceAndJourney(
      db,
      operation,
      "artifact-1",
      "evidence-wrong-action",
      "journey-wrong-action",
      resultSha256,
      { evidenceMetadata: { action: "revoke" } },
    );
    const wrongActionSettlement = {
      ...baseSettlement,
      evidenceEnvelopeId: "evidence-wrong-action",
      journeyEventId: "journey-wrong-action",
    };
    assert.throws(() => operations.createSettlement(wrongActionSettlement), /evidence metadata does not match action/);
    assert.throws(() => insertRawSettlement(db, wrongActionSettlement), /binding does not match/);

    insertEvidenceAndJourney(db, operation, "artifact-1", "evidence-blocked", "journey-blocked", resultSha256);
    assertCanonicalEqual(
      operations.createSettlement({
        ...baseSettlement,
        evidenceEnvelopeId: "evidence-blocked",
        journeyEventId: "journey-blocked",
      }),
      {
        ...baseSettlement,
        evidenceEnvelopeId: "evidence-blocked",
        journeyEventId: "journey-blocked",
      },
    );
  });
});

function createStore(): {
  db: DatabaseClient;
  operations: SkillHubOperationRepository;
  manifest: SkillContentIntegrityManifest;
} {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-skill-hub-operation-${randomUUID()}.db`);
  files.push(dbPath);
  const db = createDatabase({ dbPath });
  opened.push(db);
  const manifest = manifestFor("SKILL.md", "exact bytes\n");
  createSnapshot(db, "snapshot-1", manifest.treeSha256);
  new SkillHubArtifactRepository(db).create({
    artifactId: "artifact-1",
    workspaceId: "workspace-1",
    snapshotId: "snapshot-1",
    contentTreeSha256: manifest.treeSha256,
    bundleRelPath: skillHubArtifactBundleRelPath(manifest.treeSha256),
    manifest,
    manifestSha256: computeSkillHubManifestSha256(manifest),
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    createdAt: "2026-07-13T18:00:00.000Z",
  });
  return { db, operations: new SkillHubOperationRepository(db), manifest };
}

function intent(
  manifest: SkillContentIntegrityManifest,
  overrides: Partial<Omit<SkillHubOperationIntentRecord, "requestSha256">> = {},
): SkillHubOperationIntentRecord {
  const base: Omit<SkillHubOperationIntentRecord, "requestSha256"> = {
    operationId: "operation-1",
    idempotencyKey: "operation:1",
    workspaceId: "workspace-1",
    operationKind: "install_inactive",
    approvalId: "approval-1",
    snapshotId: "snapshot-1",
    contentTreeSha256: manifest.treeSha256,
    skillId: "extra:demo",
    targetCandidateId: "candidate-1",
    targetVersionId: "candidate-version-1",
    expectedCandidateAbsent: true,
    expectedRuntimeAbsent: true,
    actorId: "operator-1",
    sessionId: "session-1",
    turnId: "turn-1",
    createdAt: "2026-07-13T18:01:00.000Z",
    ...overrides,
  };
  return { ...base, requestSha256: computeSkillHubOperationRequestSha256(base) };
}

function insertApproval(
  db: DatabaseClient,
  intent: SkillHubOperationIntentRecord,
  overrides: {
    kind?: string;
    status?: string;
    payload?: Record<string, unknown>;
    linkage?: Record<string, unknown>;
  } = {},
): void {
  const payload = {
    operationId: intent.operationId,
    requestSha256: intent.requestSha256,
    workspaceId: intent.workspaceId,
    operationKind: intent.operationKind,
    skillId: intent.skillId,
    snapshotId: intent.snapshotId,
    contentTreeSha256: intent.contentTreeSha256,
    ...overrides.payload,
  };
  const linkage = {
    workspaceId: intent.workspaceId,
    ...(intent.sessionId ? { sessionId: intent.sessionId } : {}),
    ...(intent.turnId ? { turnId: intent.turnId } : {}),
    ...overrides.linkage,
  };
  db.prepare(
    `
    INSERT INTO approvals (
      approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json, created_at
    ) VALUES (?, ?, 'danger', ?, ?, ?, '{}', ?)
  `,
  ).run(
    intent.approvalId,
    overrides.kind ?? "skill_hub.lifecycle",
    overrides.status ?? "approved",
    canonicalJsonString(linkage),
    canonicalJsonString(payload),
    "2026-07-13T18:00:00.000Z",
  );
}

function insertRawIntent(db: DatabaseClient, input: SkillHubOperationIntentRecord): void {
  db.prepare(
    `
    INSERT INTO skill_hub_operation_intents (
      operation_id, idempotency_key, workspace_id, operation_kind, approval_id,
      snapshot_id, content_tree_sha256, skill_id, target_candidate_id, target_version_id,
      supersedes_version_id, expected_candidate_revision, expected_runtime_revision,
      expected_candidate_absent, expected_runtime_absent, actor_id, session_id, turn_id,
      request_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    input.operationId,
    input.idempotencyKey,
    input.workspaceId,
    input.operationKind,
    input.approvalId,
    input.snapshotId,
    input.contentTreeSha256,
    input.skillId,
    input.targetCandidateId ?? null,
    input.targetVersionId ?? null,
    input.supersedesVersionId ?? null,
    input.expectedCandidateRevision ?? null,
    input.expectedRuntimeRevision ?? null,
    input.expectedCandidateAbsent ? 1 : 0,
    input.expectedRuntimeAbsent ? 1 : 0,
    input.actorId,
    input.sessionId ?? null,
    input.turnId ?? null,
    input.requestSha256,
    input.createdAt,
  );
}

function insertRawSettlement(db: DatabaseClient, input: SkillHubOperationSettlementRecord): void {
  db.prepare(
    `
    INSERT INTO skill_hub_operation_settlements (
      settlement_id, operation_id, workspace_id, approval_id, content_tree_sha256,
      disposition, observed_tree_sha256, candidate_version_id, runtime_skill_id,
      candidate_revision, runtime_revision, evidence_envelope_id, journey_event_id,
      result_json, result_sha256, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    input.settlementId,
    input.operationId,
    input.workspaceId,
    input.approvalId,
    input.contentTreeSha256,
    input.disposition,
    input.observedTreeSha256,
    input.candidateVersionId ?? null,
    input.runtimeSkillId ?? null,
    input.candidateRevision ?? null,
    input.runtimeRevision ?? null,
    input.evidenceEnvelopeId,
    input.journeyEventId,
    canonicalJsonString(input.result),
    input.resultSha256,
    input.settledAt,
  );
}

function insertEvidenceAndJourney(
  db: DatabaseClient,
  operation: SkillHubOperationIntentRecord,
  artifactId: string,
  evidenceEnvelopeId: string,
  journeyEventId: string,
  resultSha256: string,
  overrides: {
    evidenceWorkspaceId?: string;
    journeyWorkspaceId?: string;
    evidenceMetadata?: Record<string, unknown>;
    journeyAction?: string;
    journeyEvidenceRefs?: Array<{ owner: string; refId: string }>;
  } = {},
): void {
  const evidenceMetadata = {
    operationId: operation.operationId,
    action: operation.operationKind,
    subjectKind: "skill",
    subjectId: operation.skillId,
    sourceKind: "upstream_snapshot",
    sourceId: operation.snapshotId,
    contentTreeSha256: operation.contentTreeSha256,
    requestSha256: operation.requestSha256,
    resultSha256,
    ...overrides.evidenceMetadata,
  };
  db.prepare(
    `
    INSERT INTO runtime_evidence_envelopes (
      envelope_id, event_kind, workspace_id, approval_id, content_hash, payload_hash,
      tool_call_hashes_json, memory_lineage_json, signature_status, metadata_json, created_at
    ) VALUES (?, 'approval_resolution', ?, ?, ?, ?, '[]', '[]', 'unsigned_local', ?, ?)
  `,
  ).run(
    evidenceEnvelopeId,
    overrides.evidenceWorkspaceId ?? operation.workspaceId,
    operation.approvalId,
    operation.requestSha256,
    resultSha256,
    canonicalJsonString(evidenceMetadata),
    "2026-07-13T18:04:00.000Z",
  );
  const evidenceRefs = overrides.journeyEvidenceRefs ?? [
    { owner: "approval", refId: operation.approvalId },
    { owner: "upstream_snapshot", refId: operation.snapshotId },
    { owner: "artifact", refId: artifactId },
  ];
  const summary = {
    operationId: operation.operationId,
    requestSha256: operation.requestSha256,
    contentTreeSha256: operation.contentTreeSha256,
    resultSha256,
  };
  db.prepare(
    `
    INSERT INTO governance_journey_events (
      schema_version, event_id, idempotency_key, scope_kind, workspace_id, event_type,
      subject_kind, subject_id, action, actor_id, actor_type, session_id, turn_id, approval_id,
      fingerprint, source_kind, source_id, trust_disposition, poisoning_status,
      evidence_refs_json, provenance_json, summary_json, occurred_at, recorded_at
    ) VALUES (
      'goatcitadel.journey-event.v1', ?, ?, 'workspace', ?, 'skill_hub_lifecycle',
      'skill', ?, ?, 'operator-1', 'approval_effect',
      ?, ?, ?, ?, 'upstream_snapshot', ?, 'candidate', NULL,
      ?, ?, ?, ?, ?
    )
  `,
  ).run(
    journeyEventId,
    `journey:${journeyEventId}`,
    overrides.journeyWorkspaceId ?? operation.workspaceId,
    operation.skillId,
    overrides.journeyAction ?? operation.operationKind,
    operation.sessionId ?? null,
    operation.turnId ?? null,
    operation.approvalId,
    operation.requestSha256,
    operation.snapshotId,
    canonicalJsonString(evidenceRefs),
    canonicalJsonString({ approvalRequired: true, sourceRequired: true }),
    canonicalJsonString(summary),
    "2026-07-13T18:04:00.000Z",
    "2026-07-13T18:04:00.000Z",
  );
}

function manifestFor(filePath: string, content: string): SkillContentIntegrityManifest {
  const file = {
    path: filePath,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bytes: Buffer.byteLength(content, "utf8"),
  };
  const initial: SkillContentIntegrityManifest = {
    manifestVersion: "goatcitadel.skill-tree.v1",
    algorithm: "sha256",
    treeSha256: "0".repeat(64),
    fileCount: 1,
    totalBytes: file.bytes,
    excludedPaths: ["source.json", ".git/**"],
    files: [file],
  };
  return { ...initial, treeSha256: computeSkillHubTreeSha256(initial) };
}

function createSnapshot(db: DatabaseClient, snapshotId: string, treeSha256: string): void {
  const audit = {
    policyId: "skill-import",
    policyVersion: "2.0.0",
    policyRevision: 2,
    scanners: [{ scannerId: "static", scannerVersion: "2.0.0", revision: 2, coverageIds: ["scripts"] }],
    findingCodes: [],
    blockerCodes: [],
    approvedBlockerResolutions: [],
  };
  const permissionEnvelope = {
    version: "goatcitadel.skill-permission-envelope.v1" as const,
    toolIds: [],
    environmentVariableNames: [],
    networkOrigins: [],
    filesystem: { readScopes: [], writeScopes: [] },
    scripts: [],
    dependencies: { packages: [], nativeRequirements: [] },
  };
  const empty = () => ({ added: [], removed: [] });
  const input: SkillHubSnapshotCreateInput = {
    snapshotId,
    workspaceId: "workspace-1",
    operation: "review",
    sourceProvider: "github",
    sourceType: "git_url",
    sourceRef: "https://github.com/owner/repo.git#main",
    canonicalSourceKey: "github:owner/repo:skill/demo",
    declaredVersion: "v1.0.0",
    resolvedVersion: "1".repeat(40),
    contentTreeSha256: treeSha256,
    provenance: { capturedBy: "test" },
    audit,
    auditSha256: hashJson(audit),
    permissionEnvelope,
    permissionEnvelopeSha256: hashJson(permissionEnvelope),
    permissionDiff: {
      version: "goatcitadel.skill-permission-diff.v1",
      disposition: "none",
      dimensions: {
        toolIds: empty(),
        environmentVariableNames: empty(),
        networkOrigins: empty(),
        filesystemReadScopes: empty(),
        filesystemWriteScopes: empty(),
        scripts: empty(),
        packages: empty(),
        nativeRequirements: empty(),
      },
    },
    compatibility: { platform: "all" },
    riskLevel: "low",
    trustDisposition: "candidate",
    blockerCodes: [],
    createdAt: "2026-07-13T17:59:00.000Z",
  };
  new SkillHubSnapshotRepository(db).create(input);
}

function withoutRequestHash(
  input: SkillHubOperationIntentRecord,
): Omit<SkillHubOperationIntentRecord, "requestSha256"> {
  const { requestSha256: _requestSha256, ...base } = input;
  return base;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function assertCanonicalEqual(actual: unknown, expected: unknown): void {
  assert.equal(canonicalJsonString(actual), canonicalJsonString(expected));
}
