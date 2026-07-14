import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { CandidateSkillVersionRecord, CapabilityArtifactRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { CandidateSkillVersionRepository } from "./candidate-skill-version-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): { db: DatabaseClient; repo: CandidateSkillVersionRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-candidate-skill-version-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new CandidateSkillVersionRepository(db) };
}

function artifact(name: string): CapabilityArtifactRecord {
  return {
    artifactId: `${name}-artifact`,
    relPath: `${name}.json`,
    sha256: createHash("sha256").update(name, "utf8").digest("hex"),
    bytes: 123,
    mimeType: "application/json",
    createdAt: "2026-03-26T00:00:00.000Z",
  };
}

function version(overrides: Partial<CandidateSkillVersionRecord> = {}): CandidateSkillVersionRecord {
  return {
    candidateId: "candidate-a",
    versionId: "version-a",
    sourceKind: "code_mode_generated",
    title: "Candidate Skill",
    summary: "Skill summary",
    bundleRoot: "skills/candidate-a/version-a",
    originatingRunId: "run-a",
    wrapperManifestHash: "wrapper-sha",
    lifecycleState: "candidate",
    manifestArtifact: artifact("manifest"),
    instructionArtifact: artifact("instructions"),
    proofArtifact: artifact("proof"),
    programArtifact: artifact("program"),
    schemaArtifact: artifact("schema"),
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
    lastSuccessfulExecutionAt: "2026-03-26T00:01:00.000Z",
    ...overrides,
  };
}

function setRawField(db: DatabaseClient, versionId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE candidate_skill_versions SET ${field} = ? WHERE version_id = ?`).run(value, versionId);
}

describe("CandidateSkillVersionRepository", () => {
  it("inserts, lists, and updates candidate skill lifecycle state", () => {
    const { repo } = createStore();
    const first = repo.upsert(version());
    const second = repo.upsert(
      version({
        versionId: "version-b",
        title: "Second Skill",
        createdAt: "2026-03-26T00:02:00.000Z",
        updatedAt: "2026-03-26T00:02:00.000Z",
        lastSuccessfulExecutionAt: undefined,
      }),
    );
    const otherCandidate = repo.upsert(
      version({
        candidateId: "candidate-b",
        versionId: "version-c",
        sourceKind: "manual",
        summary: undefined,
        originatingRunId: undefined,
        wrapperManifestHash: undefined,
        programArtifact: undefined,
        schemaArtifact: undefined,
        updatedAt: "2026-03-26T00:03:00.000Z",
      }),
    );

    assert.equal(first.summary, "Skill summary");
    assert.equal(first.lineageStatus, "legacy_missing");
    assert.equal(first.programArtifact?.artifactId, "program-artifact");
    assert.equal(second.lastSuccessfulExecutionAt, undefined);
    assert.equal(otherCandidate.sourceKind, "manual");
    assert.equal(otherCandidate.summary, undefined);
    assert.equal(otherCandidate.originatingRunId, undefined);
    assert.equal(otherCandidate.wrapperManifestHash, undefined);
    assert.equal(otherCandidate.programArtifact, undefined);
    assert.equal(otherCandidate.schemaArtifact, undefined);

    assert.deepEqual(
      repo.list(10).map((item) => item.versionId),
      ["version-c", "version-b", "version-a"],
    );
    assert.deepEqual(
      repo.listByCandidateId("candidate-a", 10).map((item) => item.versionId),
      ["version-b", "version-a"],
    );
    assert.equal(repo.findLatestByCandidateId("candidate-a")?.versionId, "version-b");
    assert.equal(repo.findLatestByCandidateId("missing-candidate"), undefined);

    const approved = repo.updateLifecycleState("version-a", "approved", "2026-03-26T00:04:00.000Z");
    assert.equal(approved.lifecycleState, "approved");
    assert.equal(approved.updatedAt, "2026-03-26T00:04:00.000Z");
    assert.equal(
      repo.findLatestByCandidateId("candidate-a")?.versionId,
      "version-b",
      "a lifecycle-only update must not make older content the latest version",
    );
  });

  it("treats an exact replay as idempotent without reverting lifecycle state", () => {
    const { repo } = createStore();
    const input = version();
    repo.upsert(input);
    repo.updateLifecycleState("version-a", "approved", "2026-03-26T00:04:00.000Z");

    const replay = repo.upsert({
      ...input,
      updatedAt: "2026-03-26T00:05:00.000Z",
      lastSuccessfulExecutionAt: "2026-03-26T00:05:00.000Z",
    });

    assert.equal(replay.lifecycleState, "approved");
    assert.equal(replay.updatedAt, "2026-03-26T00:04:00.000Z");
    assert.equal(replay.lastSuccessfulExecutionAt, "2026-03-26T00:01:00.000Z");

    assert.throws(() => repo.upsert({ ...input, lifecycleState: "approved" }), /must be inserted or replayed inactive/);
    assert.equal(repo.get("version-a").lifecycleState, "approved");
  });

  it("rejects immutable byte or provenance changes for an existing version", () => {
    const { repo } = createStore();
    repo.upsert(version());

    assert.throws(
      () => repo.upsert(version({ title: "Mutated title" })),
      /conflicts with an existing immutable record/,
    );
    assert.throws(
      () => repo.upsert(version({ manifestArtifact: artifact("different-manifest") })),
      /conflicts with an existing immutable record/,
    );
    assert.equal(repo.get("version-a").title, "Candidate Skill");
    assert.equal(repo.get("version-a").manifestArtifact.artifactId, "manifest-artifact");
  });

  it("requires newly inserted versions to start inactive", () => {
    const { repo } = createStore();
    assert.throws(() => repo.upsert(version({ lifecycleState: "approved" })), /must be inserted or replayed inactive/);
    assert.equal(repo.find("version-a"), undefined);
  });

  it("returns missing rows and fails closed on malformed artifact JSON", () => {
    const { db, repo } = createStore();
    repo.upsert(version({ versionId: "version-a" }));

    assert.equal(repo.find("missing-version"), undefined);
    assert.throws(() => repo.get("missing-version"), /candidate skill version missing-version not found/);
    assert.throws(
      () => repo.updateLifecycleState("missing-version", "trusted"),
      /candidate skill version missing-version not found/,
    );

    db.exec("DROP TRIGGER IF EXISTS trg_candidate_skill_versions_immutable_content");
    setRawField(db, "version-a", "manifest_artifact_json", "{bad json");
    setRawField(db, "version-a", "instruction_artifact_json", "{bad json");
    setRawField(db, "version-a", "proof_artifact_json", "{bad json");
    setRawField(db, "version-a", "program_artifact_json", "{bad json");
    setRawField(db, "version-a", "schema_artifact_json", "{bad json");

    assert.throws(() => repo.get("version-a"), /malformed manifest artifact JSON/);
  });

  it("persists governed lineage, scopes references, and makes it immutable", () => {
    const { db, repo } = createStore();
    const hash = "a".repeat(64);
    const floor = JSON.stringify({
      version: "goatcitadel.skill-upstream-audit-floor.v1",
      policyId: "policy",
      policyVersion: "1",
      policyRevision: 1,
      scanners: [],
      effectiveBlockerCodes: [],
    });
    const insertSnapshot = db.prepare(`
      INSERT INTO skill_hub_snapshots (
        snapshot_id, workspace_id, operation, source_provider, source_type, source_ref,
        canonical_source_key, declared_version, resolved_version, content_tree_sha256,
        provenance_json, audit_json, audit_sha256, audit_floor_json, audit_floor_sha256,
        permission_envelope_json, permission_envelope_sha256, permission_diff_json,
        compatibility_json, risk_level, trust_disposition, prior_snapshot_id,
        blocker_codes_json, created_at
      ) VALUES (?, ?, 'review', 'test', 'fixture', 'fixture', ?, 'v1', NULL, ?, '{}', '{}', ?, ?, ?, '{}', ?, '{}', '{}', 'low', 'candidate', NULL, '[]', ?)
    `);
    insertSnapshot.run(
      "snapshot-local",
      "workspace-1",
      "source-local",
      hash,
      hash,
      floor,
      hash,
      hash,
      "2026-03-26T00:00:00.000Z",
    );
    insertSnapshot.run(
      "snapshot-foreign",
      "workspace-2",
      "source-foreign",
      hash,
      hash,
      floor,
      hash,
      hash,
      "2026-03-26T00:00:01.000Z",
    );

    const governed = repo.upsert(
      version({
        sourceKind: "upstream_hub",
        lineageStatus: "governed",
        workspaceId: "workspace-1",
        sourceFingerprint: hash,
        upstreamSnapshotId: "snapshot-local",
        createdByActorId: "operator-1",
      }),
    );
    assert.equal(governed.lineageStatus, "governed");
    assert.equal(governed.sourceKind, "upstream_hub");
    assert.equal(governed.workspaceId, "workspace-1");
    assert.equal(governed.upstreamSnapshotId, "snapshot-local");

    const successor = repo.upsert(
      version({
        versionId: "version-b",
        sourceKind: "upstream_hub",
        lineageStatus: "governed",
        workspaceId: "workspace-1",
        sourceFingerprint: hash,
        upstreamSnapshotId: "snapshot-local",
        supersedesVersionId: "version-a",
        createdByActorId: "operator-1",
        updatedAt: "2026-03-26T00:02:00.000Z",
      }),
    );
    assert.equal(successor.supersedesVersionId, "version-a");

    assert.throws(
      () =>
        repo.upsert(
          version({
            lineageStatus: "governed",
            workspaceId: "workspace-1",
            sourceFingerprint: hash,
            upstreamSnapshotId: "snapshot-local",
            createdByActorId: "operator-2",
          }),
        ),
      /conflicts with an existing immutable record/,
    );
    assert.throws(
      () =>
        repo.upsert(
          version({
            versionId: "version-foreign",
            lineageStatus: "governed",
            workspaceId: "workspace-1",
            sourceFingerprint: hash,
            upstreamSnapshotId: "snapshot-foreign",
            createdByActorId: "operator-1",
          }),
        ),
      /missing, foreign-scope, or different-byte upstream snapshot/,
    );

    db.exec("DROP TRIGGER IF EXISTS trg_candidate_skill_versions_immutable_content");
    setRawField(db, "version-a", "upstream_snapshot_id", "snapshot-foreign");
    assert.throws(() => repo.get("version-a"), /missing, foreign-scope, or different-byte upstream snapshot/);
  });

  it("rejects partial or malformed governed lineage and unsafe list bounds", () => {
    const { repo } = createStore();
    assert.throws(() => repo.upsert(version({ sourceKind: "learned_correction" })), /requires governed lineage/);
    assert.throws(
      () => repo.upsert(version({ workspaceId: "workspace-1" })),
      /require workspace, source fingerprint, and creating actor/,
    );
    assert.throws(
      () =>
        repo.upsert(
          version({
            lineageStatus: "governed",
            workspaceId: "workspace-1",
            sourceFingerprint: "not-a-hash",
            createdByActorId: "operator-1",
          }),
        ),
      /SHA-256/,
    );
    assert.throws(
      () =>
        repo.upsert(
          version({
            sourceKind: "upstream_hub",
            lineageStatus: "governed",
            workspaceId: "workspace-1",
            sourceFingerprint: "a".repeat(64),
            createdByActorId: "operator-1",
          }),
        ),
      /require an upstream snapshot lineage reference/,
    );
    assert.throws(() => repo.list(Number.NaN), /finite integer/);
    assert.throws(() => repo.listByCandidateId("candidate-a", Number.POSITIVE_INFINITY), /finite integer/);
  });

  it("preserves explicit governed source provenance for correction and history candidates", () => {
    const { repo } = createStore();
    const lineage = {
      lineageStatus: "governed" as const,
      workspaceId: "workspace-1",
      sourceFingerprint: "b".repeat(64),
      createdByActorId: "operator-1",
    };
    const correction = repo.upsert(
      version({
        ...lineage,
        versionId: "version-correction",
        sourceKind: "learned_correction",
      }),
    );
    const history = repo.upsert(
      version({
        ...lineage,
        versionId: "version-history",
        sourceKind: "history_workshop",
        updatedAt: "2026-03-26T00:02:00.000Z",
      }),
    );

    assert.equal(correction.sourceKind, "learned_correction");
    assert.equal(history.sourceKind, "history_workshop");
  });
});
