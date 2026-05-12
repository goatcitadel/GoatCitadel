import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
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
    sha256: `${name}-sha`,
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
  it("upserts, lists, and updates candidate skill versions", () => {
    const { repo } = createStore();
    const first = repo.upsert(version());
    const second = repo.upsert(
      version({
        versionId: "version-b",
        title: "Second Skill",
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
  });

  it("returns missing rows and malformed artifact JSON defensively", () => {
    const { db, repo } = createStore();
    repo.upsert(version({ versionId: "version-a" }));

    assert.equal(repo.find("missing-version"), undefined);
    assert.throws(() => repo.get("missing-version"), /candidate skill version missing-version not found/);
    assert.throws(
      () => repo.updateLifecycleState("missing-version", "trusted"),
      /candidate skill version missing-version not found/,
    );

    setRawField(db, "version-a", "manifest_artifact_json", "{bad json");
    setRawField(db, "version-a", "instruction_artifact_json", "{bad json");
    setRawField(db, "version-a", "proof_artifact_json", "{bad json");
    setRawField(db, "version-a", "program_artifact_json", "{bad json");
    setRawField(db, "version-a", "schema_artifact_json", "{bad json");

    const loaded = repo.get("version-a");
    assert.deepEqual(loaded.manifestArtifact, {});
    assert.deepEqual(loaded.instructionArtifact, {});
    assert.deepEqual(loaded.proofArtifact, {});
    assert.equal(loaded.programArtifact, undefined);
    assert.equal(loaded.schemaArtifact, undefined);
  });
});
