import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import {
  CandidateSkillEvidenceLinkRepository,
  SkillLearningEvidenceRepository,
  createSkillLearningFingerprint,
  type SkillLearningEvidenceRecord,
} from "./skill-learning-evidence-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];
const openedDatabases: DatabaseClient[] = [];
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

afterEach(() => {
  for (const db of openedDatabases.splice(0)) db.close();
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

function createStore(): {
  db: DatabaseClient;
  evidence: SkillLearningEvidenceRepository;
  links: CandidateSkillEvidenceLinkRepository;
  dbPath: string;
} {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-skill-learning-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  openedDatabases.push(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_learning_evidence (
      evidence_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_session_id TEXT,
      source_turn_id TEXT,
      source_message_id TEXT,
      correction_action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      correction_sha256 TEXT NOT NULL,
      source_artifact_json TEXT,
      correction_artifact_json TEXT,
      provenance_json TEXT NOT NULL,
      poisoning_status TEXT NOT NULL,
      blocker_codes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidate_skill_evidence_links (
      version_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (version_id, evidence_id)
    );
  `);
  db.prepare(
    `
    INSERT OR IGNORE INTO candidate_skill_versions (
      candidate_id, version_id, source_kind, title, summary, bundle_root, originating_run_id,
      wrapper_manifest_hash, lifecycle_state, manifest_artifact_json, instruction_artifact_json,
      proof_artifact_json, program_artifact_json, schema_artifact_json, created_at, updated_at,
      last_successful_execution_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    "candidate-1",
    "version-1",
    "manual",
    "Candidate",
    null,
    "skills/candidate-1/version-1",
    null,
    null,
    "candidate",
    "{}",
    "{}",
    "{}",
    null,
    null,
    "2026-07-13T12:00:00.000Z",
    "2026-07-13T12:00:00.000Z",
    null,
  );
  return {
    db,
    evidence: new SkillLearningEvidenceRepository(db),
    links: new CandidateSkillEvidenceLinkRepository(db),
    dbPath,
  };
}

function evidence(overrides: Partial<SkillLearningEvidenceRecord> = {}): SkillLearningEvidenceRecord {
  const base = {
    evidenceId: "evidence-1",
    idempotencyKey: "learn:workspace-1:session-1:turn-1",
    workspaceId: "workspace-1",
    targetKey: "skill/demo",
    fingerprint: SHA_A,
    sourceKind: "chat_turn" as const,
    sourceSessionId: "session-1",
    sourceTurnId: "turn-1",
    sourceMessageId: "message-1",
    correctionActionId: "action-1",
    actorId: "operator-1",
    sourceSha256: SHA_B,
    correctionSha256: SHA_C,
    sourceArtifact: { artifactId: "source-artifact-1", sha256: SHA_B, bytes: 100 },
    correctionArtifact: { artifactId: "correction-artifact-1", sha256: SHA_C, bytes: 120 },
    poisoningStatus: "clean" as const,
    blockerCodes: [],
    createdAt: "2026-07-13T12:00:00.000Z",
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    provenance: overrides.provenance ?? {
      version: "goatcitadel.skill-correction-provenance.v1",
      action: "learn_candidate",
      correctionActionId: merged.correctionActionId,
      actorId: merged.actorId,
      workspaceId: merged.workspaceId,
      source:
        merged.sourceKind === "chat_turn"
          ? {
              kind: "chat_turn",
              sessionId: merged.sourceSessionId as string,
              turnId: merged.sourceTurnId as string,
              messageId: merged.sourceMessageId as string,
            }
          : { kind: "library_text" },
      sourceSha256: merged.sourceSha256,
      correctionSha256: merged.correctionSha256,
      sourceArtifact: merged.sourceArtifact,
      correctionArtifact: merged.correctionArtifact,
      fingerprint: merged.fingerprint,
      capturedAt: merged.createdAt,
    },
  };
}

describe("SkillLearningEvidenceRepository", () => {
  it("creates exact correction provenance idempotently and rejects conflicting replay", () => {
    const { evidence: repo } = createStore();
    const input = evidence();
    assert.deepEqual(repo.create(input), input);
    assert.deepEqual(repo.create(input), input);
    assert.throws(
      () =>
        repo.create(
          evidence({
            correctionSha256: SHA_A,
            correctionArtifact: { artifactId: "correction-artifact-2", sha256: SHA_A, bytes: 120 },
          }),
        ),
      /conflicts with an existing immutable record|provenance does not match/,
    );
    assert.equal(repo.listByFingerprint("workspace-1", "skill/demo", SHA_A).length, 1);
  });

  it("counts only clean distinct Chat sessions and keeps same-session replay from inflating recurrence", () => {
    const { evidence: repo } = createStore();
    for (const [index, sessionId] of ["session-1", "session-1", "session-2", "session-3"].entries()) {
      repo.create(
        evidence({
          evidenceId: `evidence-${index}`,
          idempotencyKey: `learn-${index}`,
          sourceSessionId: sessionId,
          sourceTurnId: `turn-${index}`,
          sourceMessageId: `message-${index}`,
          correctionActionId: `action-${index}`,
          createdAt: `2026-07-13T12:00:0${index}.000Z`,
        }),
      );
    }
    repo.create(
      evidence({
        evidenceId: "blocked-evidence",
        idempotencyKey: "blocked-evidence",
        sourceSessionId: "session-4",
        sourceTurnId: "turn-blocked",
        sourceMessageId: "message-blocked",
        correctionActionId: "action-blocked",
        sourceArtifact: undefined,
        correctionArtifact: undefined,
        poisoningStatus: "blocked",
        blockerCodes: ["SECRET_LIKE_CONTENT"],
      }),
    );

    assert.deepEqual(
      repo.summarizeRecurrence({ workspaceId: "workspace-1", targetKey: "skill/demo", fingerprint: SHA_A }),
      {
        workspaceId: "workspace-1",
        targetKey: "skill/demo",
        fingerprint: SHA_A,
        distinctSessionCount: 3,
        hasConflictingFingerprint: false,
        hasNonCleanEvidence: true,
        minimumDistinctSessions: 3,
        automaticStagingEligible: false,
      },
    );
  });

  it("fails closed when direct-SQL session aliases try to inflate recurrence", () => {
    const { db, evidence: repo } = createStore();
    for (const [index, sessionId] of ["session-1", "session-2", "session-3"].entries()) {
      repo.create(
        evidence({
          evidenceId: `evidence-${index}`,
          idempotencyKey: `learn-${index}`,
          sourceSessionId: sessionId,
          sourceTurnId: `turn-${index}`,
          sourceMessageId: `message-${index}`,
          correctionActionId: `action-${index}`,
          createdAt: `2026-07-13T12:00:0${index}.000Z`,
        }),
      );
    }
    assert.equal(
      repo.summarizeRecurrence({ workspaceId: "workspace-1", targetKey: "skill/demo", fingerprint: SHA_A })
        .automaticStagingEligible,
      true,
    );

    db.exec("DROP TRIGGER IF EXISTS trg_skill_learning_evidence_no_update");
    for (const [evidenceId, sourceSessionId] of [
      ["evidence-1", " session-1"],
      ["evidence-2", "session-1 "],
    ] as const) {
      const record = evidence({
        evidenceId,
        idempotencyKey: evidenceId === "evidence-1" ? "learn-1" : "learn-2",
        sourceSessionId,
        sourceTurnId: evidenceId === "evidence-1" ? "turn-1" : "turn-2",
        sourceMessageId: evidenceId === "evidence-1" ? "message-1" : "message-2",
        correctionActionId: evidenceId === "evidence-1" ? "action-1" : "action-2",
        createdAt: evidenceId === "evidence-1" ? "2026-07-13T12:00:01.000Z" : "2026-07-13T12:00:02.000Z",
      });
      db.prepare(
        "UPDATE skill_learning_evidence SET source_session_id = ?, provenance_json = ? WHERE evidence_id = ?",
      ).run(sourceSessionId, JSON.stringify(record.provenance), evidenceId);
    }

    assert.throws(
      () => repo.summarizeRecurrence({ workspaceId: "workspace-1", targetKey: "skill/demo", fingerprint: SHA_A }),
      /canonical identity form/,
    );
  });

  it("uses one coherent validated snapshot across repository instances", () => {
    const { evidence: first, dbPath } = createStore();
    const secondDb = createDatabase({ dbPath });
    openedDatabases.push(secondDb);
    const second = new SkillLearningEvidenceRepository(secondDb);
    for (const [index, repo] of [first, second, first].entries()) {
      repo.create(
        evidence({
          evidenceId: `multi-evidence-${index}`,
          idempotencyKey: `multi-learn-${index}`,
          sourceSessionId: `multi-session-${index}`,
          sourceTurnId: `multi-turn-${index}`,
          sourceMessageId: `multi-message-${index}`,
          correctionActionId: `multi-action-${index}`,
          createdAt: `2026-07-13T12:01:0${index}.000Z`,
        }),
      );
    }
    const summary = second.summarizeRecurrence({
      workspaceId: "workspace-1",
      targetKey: "skill/demo",
      fingerprint: SHA_A,
    });
    assert.equal(summary.distinctSessionCount, 3);
    assert.equal(summary.automaticStagingEligible, true);
  });

  it("never permits callers to lower the three-session recurrence floor", () => {
    const { evidence: repo } = createStore();
    repo.create(evidence());
    const summary = repo.summarizeRecurrence({
      workspaceId: "workspace-1",
      targetKey: "skill/demo",
      fingerprint: SHA_A,
      minimumDistinctSessions: 1,
    });
    assert.equal(summary.minimumDistinctSessions, 3);
    assert.equal(summary.automaticStagingEligible, false);
    assert.throws(
      () =>
        repo.summarizeRecurrence({
          workspaceId: "workspace-1",
          targetKey: "skill/demo",
          fingerprint: SHA_A,
          minimumDistinctSessions: Number.NaN,
        }),
      /finite integer/,
    );
  });

  it("blocks automatic staging when a clean conflicting target fingerprint recurs", () => {
    const { evidence: repo } = createStore();
    repo.create(evidence());
    repo.create(
      evidence({
        evidenceId: "evidence-conflict",
        idempotencyKey: "learn-conflict",
        fingerprint: SHA_B,
        sourceSessionId: "session-2",
        sourceTurnId: "turn-2",
        sourceMessageId: "message-2",
        correctionActionId: "action-2",
      }),
    );
    const result = repo.summarizeRecurrence({
      workspaceId: "workspace-1",
      targetKey: "skill/demo",
      fingerprint: SHA_A,
      minimumDistinctSessions: 1,
    });
    assert.equal(result.hasConflictingFingerprint, true);
    assert.equal(result.hasNonCleanEvidence, false);
    assert.equal(result.automaticStagingEligible, false);
  });

  it("never persists raw artifact references for secret-like evidence and keeps links immutable", () => {
    const { evidence: repo, links } = createStore();
    assert.throws(
      () => repo.create(evidence({ poisoningStatus: "blocked", blockerCodes: ["SECRET_LIKE_CONTENT"] })),
      /hashes only/,
    );
    repo.create(evidence());
    assert.deepEqual(
      links.create({ versionId: "version-1", evidenceId: "evidence-1", linkedAt: "2026-07-13T12:01:00.000Z" }),
      {
        versionId: "version-1",
        evidenceId: "evidence-1",
        linkedAt: "2026-07-13T12:01:00.000Z",
      },
    );
    assert.throws(
      () => links.create({ versionId: "version-1", evidenceId: "evidence-1", linkedAt: "2026-07-13T12:02:00.000Z" }),
      /conflicts with an immutable record/,
    );
  });

  it("builds a stable workspace-target fingerprint while preserving code semantics", () => {
    const first = createSkillLearningFingerprint({
      workspaceId: "workspace-1",
      targetKey: "skill/demo",
      title: " Demo   Skill ",
      correctedBehavior: "line 1  \r\n  Code();  \r\n",
      permissionEnvelopeSha256: SHA_A,
    });
    const replay = createSkillLearningFingerprint({
      workspaceId: "workspace-1",
      targetKey: "skill/demo",
      title: "Demo Skill",
      correctedBehavior: "line 1\n  Code();",
      permissionEnvelopeSha256: SHA_A,
    });
    assert.equal(first, replay);
    assert.notEqual(
      first,
      createSkillLearningFingerprint({
        workspaceId: "workspace-1",
        targetKey: "skill/demo",
        title: "Demo Skill",
        correctedBehavior: "line 1\n  code();",
        permissionEnvelopeSha256: SHA_A,
      }),
    );
  });

  it("fails closed on malformed stored provenance, oversized blockers, and malformed links", () => {
    const { db, evidence: repo, links } = createStore();
    repo.create(evidence());
    db.exec("DROP TRIGGER IF EXISTS trg_skill_learning_evidence_no_update");
    db.prepare("UPDATE skill_learning_evidence SET provenance_json = ? WHERE evidence_id = ?").run(
      JSON.stringify({ actorId: "forged" }),
      "evidence-1",
    );
    assert.throws(() => repo.get("evidence-1"), /provenance does not match/);

    assert.throws(
      () =>
        repo.create(
          evidence({
            evidenceId: "too-many",
            idempotencyKey: "too-many",
            blockerCodes: Array(65).fill("BLOCKED"),
            poisoningStatus: "blocked",
          }),
        ),
      /bounded to 64/,
    );
    assert.throws(
      () =>
        repo.create(
          evidence({
            evidenceId: "too-long",
            idempotencyKey: "too-long",
            blockerCodes: ["X".repeat(129)],
            poisoningStatus: "blocked",
          }),
        ),
      /oversized/,
    );

    links.create({ versionId: "version-1", evidenceId: "evidence-1", linkedAt: "2026-07-13T12:01:00.000Z" });
    db.exec("DROP TRIGGER IF EXISTS trg_candidate_skill_evidence_links_no_update");
    db.prepare("UPDATE candidate_skill_evidence_links SET linked_at = ? WHERE version_id = ? AND evidence_id = ?").run(
      "not-a-time",
      "version-1",
      "evidence-1",
    );
    assert.throws(() => links.listByVersion("version-1"), /canonical ISO timestamp/);
  });

  it("binds correction action, source identity, and artifact refs into canonical provenance", () => {
    const { db, evidence: repo } = createStore();
    for (const index of [0, 1, 2]) {
      repo.create(
        evidence({
          evidenceId: `bound-${index}`,
          idempotencyKey: `bound-${index}`,
          sourceSessionId: `bound-session-${index}`,
          sourceTurnId: `bound-turn-${index}`,
          sourceMessageId: `bound-message-${index}`,
          correctionActionId: `bound-action-${index}`,
          sourceArtifact: { artifactId: `bound-source-${index}`, sha256: SHA_B, bytes: 100 },
          correctionArtifact: { artifactId: `bound-correction-${index}`, sha256: SHA_C, bytes: 120 },
          createdAt: `2026-07-13T12:02:0${index}.000Z`,
        }),
      );
    }
    db.exec("DROP TRIGGER IF EXISTS trg_skill_learning_evidence_no_update");
    db.prepare("UPDATE skill_learning_evidence SET correction_action_id = ? WHERE evidence_id = ?").run(
      "forged-action",
      "bound-0",
    );
    db.prepare("UPDATE skill_learning_evidence SET source_message_id = ? WHERE evidence_id = ?").run(
      "forged-message",
      "bound-1",
    );
    db.prepare("UPDATE skill_learning_evidence SET source_artifact_json = ? WHERE evidence_id = ?").run(
      JSON.stringify({ artifactId: "forged-artifact", sha256: SHA_B, bytes: 100 }),
      "bound-2",
    );
    assert.throws(() => repo.get("bound-0"), /provenance does not match/);
    assert.throws(() => repo.get("bound-1"), /provenance does not match/);
    assert.throws(() => repo.get("bound-2"), /provenance does not match/);
  });

  it("bounds recurrence/list inputs, artifact sizes, and candidate-link page limits", () => {
    const { evidence: repo, links } = createStore();
    repo.create(evidence());
    assert.throws(() => repo.listByFingerprint("", "skill/demo", SHA_A), /workspace ID is missing/);
    assert.throws(() => repo.listByFingerprint("workspace-1", "skill/demo", "bad"), /fingerprint hash/);
    assert.throws(
      () => repo.summarizeRecurrence({ workspaceId: "workspace-1", targetKey: "x".repeat(257), fingerprint: SHA_A }),
      /target key is missing or too long/,
    );
    assert.throws(
      () =>
        repo.create(
          evidence({
            evidenceId: "oversized-artifact",
            idempotencyKey: "oversized-artifact",
            sourceArtifact: { artifactId: "source-big", sha256: SHA_B, bytes: 16_777_217 },
          }),
        ),
      /Artifact bytes must be between/,
    );

    links.create({ versionId: "version-1", evidenceId: "evidence-1", linkedAt: "2026-07-13T12:01:00.000Z" });
    repo.create(
      evidence({
        evidenceId: "evidence-2",
        idempotencyKey: "evidence-2",
        sourceSessionId: "session-2",
        sourceTurnId: "turn-2",
        sourceMessageId: "message-2",
        correctionActionId: "action-2",
      }),
    );
    links.create({ versionId: "version-1", evidenceId: "evidence-2", linkedAt: "2026-07-13T12:02:00.000Z" });
    assert.equal(links.listByVersion("version-1", -5).length, 1);
    assert.throws(() => links.listByVersion("version-1", Number.NaN), /finite integer/);
    assert.throws(() => links.listByVersion(""), /candidate version ID is missing/);
  });
});
