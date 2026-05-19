import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { CapabilityArtifactRecord, CodeModeRunRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { CodeModeRunRepository } from "./code-mode-run-repo.js";

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

function createStore(): { db: DatabaseClient; repo: CodeModeRunRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-code-mode-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new CodeModeRunRepository(db) };
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

function run(overrides: Partial<CodeModeRunRecord> = {}): CodeModeRunRecord {
  return {
    runId: "run-a",
    status: "running",
    language: "typescript",
    originSurface: "code",
    workspaceId: "workspace-a",
    operatorId: "operator-a",
    permissionProfileId: "profile-a",
    permissionProfileLabel: "Profile A",
    localOperatorOverrideId: "override-a",
    requestedOutputIntent: "skill_wrapper",
    saveCandidateOnSuccess: true,
    capabilitySnapshotId: "snapshot-a",
    codeModeInputHash: "input-sha",
    wrapperManifestHash: "wrapper-sha",
    policySnapshotHash: "policy-sha",
    codeHash: "code-sha",
    approvalId: "approval-a",
    sessionId: "session-a",
    turnId: "turn-a",
    sandbox: {
      runnerId: "runner-a",
      runnerVersion: "1.0.0",
      platform: "linux",
      isolationProfile: "firejail",
      required: true,
      available: true,
      checksPassed: ["enabled"],
      checksFailed: [],
    },
    codeArtifact: artifact("code"),
    wrapperManifestArtifact: artifact("wrapper"),
    policySnapshotArtifact: artifact("policy"),
    stdoutArtifact: artifact("stdout"),
    stderrArtifact: artifact("stderr"),
    stdoutPreview: "ok",
    stderrPreview: "warn",
    stdoutTruncated: true,
    stderrTruncated: true,
    result: { candidateId: "candidate-a" },
    error: "none",
    errorCode: "CODE_MODE_CHILD_ERROR",
    errorDetails: { detail: true },
    createdAt: "2026-03-26T00:00:00.000Z",
    startedAt: "2026-03-26T00:00:01.000Z",
    finishedAt: "2026-03-26T00:00:02.000Z",
    ...overrides,
  };
}

function setRawField(db: DatabaseClient, runId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE code_mode_runs SET ${field} = ? WHERE run_id = ?`).run(value, runId);
}

describe("CodeModeRunRepository", () => {
  it("upserts, updates, finds, and lists code mode runs", () => {
    const { repo } = createStore();
    const first = repo.upsert(run());
    const minimal = repo.upsert(
      run({
        runId: "run-b",
        status: "queued",
        language: "javascript",
        originSurface: undefined,
        requestedOutputIntent: undefined,
        saveCandidateOnSuccess: false,
        approvalId: undefined,
        sessionId: undefined,
        turnId: undefined,
        sandbox: undefined,
        stdoutArtifact: undefined,
        stderrArtifact: undefined,
        stdoutPreview: undefined,
        stderrPreview: undefined,
        stdoutTruncated: false,
        stderrTruncated: false,
        result: undefined,
        error: undefined,
        errorCode: undefined,
        errorDetails: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        createdAt: "2026-03-26T00:01:00.000Z",
      }),
    );

    assert.equal(first.requestedOutputIntent, "skill_wrapper");
    assert.equal(first.originSurface, "code");
    assert.equal(first.saveCandidateOnSuccess, true);
    assert.equal(first.sandbox?.runnerId, "runner-a");
    assert.equal(first.stdoutArtifact?.artifactId, "stdout-artifact");
    assert.equal(first.stderrArtifact?.artifactId, "stderr-artifact");
    assert.equal(first.stdoutTruncated, true);
    assert.equal(first.stderrTruncated, true);
    assert.deepEqual(first.result, { candidateId: "candidate-a" });
    assert.equal(first.error, "none");
    assert.equal(first.errorCode, "CODE_MODE_CHILD_ERROR");
    assert.deepEqual(first.errorDetails, { detail: true });
    assert.equal(minimal.requestedOutputIntent, undefined);
    assert.equal(minimal.originSurface, undefined);
    assert.equal(minimal.saveCandidateOnSuccess, false);
    assert.equal(minimal.sandbox, undefined);
    assert.equal(minimal.stdoutArtifact, undefined);
    assert.equal(minimal.stderrArtifact, undefined);
    assert.equal(minimal.result, undefined);

    const completed = repo.upsert(
      run({
        runId: "run-a",
        status: "completed",
        originSurface: undefined,
        workspaceId: undefined,
        operatorId: undefined,
        permissionProfileId: undefined,
        permissionProfileLabel: undefined,
        localOperatorOverrideId: undefined,
        requestedOutputIntent: undefined,
        approvalId: undefined,
        sandbox: undefined,
        stdoutArtifact: undefined,
        stderrArtifact: undefined,
        stdoutPreview: undefined,
        stderrPreview: undefined,
        stdoutTruncated: false,
        stderrTruncated: false,
        result: { ok: true },
        error: undefined,
        errorCode: undefined,
        errorDetails: undefined,
        finishedAt: "2026-03-26T00:03:00.000Z",
      }),
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.originSurface, "code");
    assert.equal(completed.workspaceId, "workspace-a");
    assert.equal(completed.operatorId, "operator-a");
    assert.equal(completed.permissionProfileId, "profile-a");
    assert.equal(completed.permissionProfileLabel, "Profile A");
    assert.equal(completed.localOperatorOverrideId, "override-a");
    assert.equal(completed.requestedOutputIntent, "skill_wrapper");
    assert.equal(completed.approvalId, "approval-a");
    assert.equal(completed.codeModeInputHash, "input-sha");
    assert.equal(completed.wrapperManifestHash, "wrapper-sha");
    assert.equal(completed.policySnapshotHash, "policy-sha");
    assert.equal(completed.codeHash, "code-sha");
    assert.deepEqual(completed.result, { ok: true });
    assert.equal(completed.stdoutTruncated, false);

    assert.equal(repo.find("run-a")?.status, "completed");
    assert.equal(repo.find("missing-run"), undefined);
    assert.throws(() => repo.get("missing-run"), /code mode run missing-run not found/);
    assert.deepEqual(
      repo.list(10).map((item) => item.runId),
      ["run-b", "run-a"],
    );
  });

  it("filters listed runs by workspace scope", () => {
    const { repo } = createStore();
    repo.upsert(run({ runId: "run-a", workspaceId: "workspace-a", createdAt: "2026-03-26T00:00:00.000Z" }));
    repo.upsert(run({ runId: "run-b", workspaceId: "workspace-b", createdAt: "2026-03-26T00:01:00.000Z" }));
    repo.upsert(run({ runId: "run-c", workspaceId: undefined, createdAt: "2026-03-26T00:02:00.000Z" }));

    assert.deepEqual(
      repo.listFiltered({ workspaceId: "workspace-a", limit: 10 }).map((item) => item.runId),
      ["run-a"],
    );
    assert.deepEqual(
      repo.listFiltered({ workspaceId: "workspace-b", limit: 10 }).map((item) => item.runId),
      ["run-b"],
    );
  });

  it("throws for malformed stored JSON payloads instead of hiding ledger corruption", () => {
    const { db, repo } = createStore();
    const corrupt = (runId: string, field: string, expected: RegExp) => {
      repo.upsert(run({ runId }));
      setRawField(db, runId, field, "{bad json");
      assert.throws(() => repo.get(runId), expected);
    };

    corrupt("run-sandbox", "sandbox_json", /corrupt sandbox_json metadata/);
    corrupt("run-code", "code_artifact_json", /corrupt code_artifact_json metadata/);
    corrupt("run-wrapper", "wrapper_manifest_artifact_json", /corrupt wrapper_manifest_artifact_json metadata/);
    corrupt("run-policy", "policy_snapshot_artifact_json", /corrupt policy_snapshot_artifact_json metadata/);
    corrupt("run-stdout", "stdout_artifact_json", /corrupt stdout_artifact_json metadata/);
    corrupt("run-stderr", "stderr_artifact_json", /corrupt stderr_artifact_json metadata/);
    corrupt("run-result", "result_json", /corrupt result_json metadata/);
    corrupt("run-error-details", "error_details_json", /corrupt error_details_json metadata/);
  });
});
