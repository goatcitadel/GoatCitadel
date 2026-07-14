import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  CapabilityArtifactRecord,
  CodeModeRunRecord,
  CodeModeVerificationEvidenceRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
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

function createStore(): { dbPath: string; db: DatabaseClient; repo: CodeModeRunRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-code-mode-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { dbPath, db, repo: new CodeModeRunRepository(db) };
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
  const record = {
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
    executionBackend: {
      backendId: "trusted-code-host",
      kind: "host",
      label: "Trusted-code host runner",
      status: "active",
      runtimeSupport: "active_runner",
      isolationProfile: "firejail",
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
    trustedCodeWriteVerification: {
      mode: "trusted_code_artifact_hash_check",
      claimBoundary: "trusted_code_artifact_integrity_not_hostile_sandbox",
      verifiedAt: "2026-03-26T00:00:02.000Z",
      artifacts: [
        {
          artifactKind: "source",
          artifactId: "code-artifact",
          relPath: "code.json",
          expectedSha256: "code-sha",
          actualSha256: "code-sha",
          verified: true,
          bytes: 123,
        },
      ],
      notes: ["Artifact integrity is not semantic verification."],
    },
    result: { candidateId: "candidate-a" },
    error: "none",
    errorCode: "CODE_MODE_CHILD_ERROR",
    errorDetails: { detail: true },
    createdAt: "2026-03-26T00:00:00.000Z",
    startedAt: "2026-03-26T00:00:01.000Z",
    finishedAt: "2026-03-26T00:00:02.000Z",
    ...overrides,
  } as Omit<CodeModeRunRecord, "executionRecovery">;
  return {
    ...record,
    executionRecovery:
      overrides.executionRecovery ??
      (record.status === "running"
        ? { generation: 0, phase: "legacy_unknown", disposition: "manual_reconciliation" }
        : record.status === "completed" ||
            record.status === "failed" ||
            record.status === "rejected" ||
            record.status === "expired"
          ? { generation: 0, phase: "terminal", disposition: "terminal" }
          : { generation: 0, phase: "not_started", disposition: "none" }),
  };
}

function verificationEvidence(
  overrides: Partial<CodeModeVerificationEvidenceRecord> = {},
): CodeModeVerificationEvidenceRecord {
  return {
    evidenceId: "proof-a",
    runId: "run-a",
    status: "verified",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    turnId: "turn-a",
    operatorId: "operator-a",
    commandName: "git_diff_check",
    commandLabel: "git diff --check",
    command: "git",
    args: ["diff", "--check"],
    scope: "worktree",
    commandRunId: "command-a",
    commandStatus: "passed",
    exitCode: 0,
    startedAt: "2026-03-26T00:04:00.000Z",
    finishedAt: "2026-03-26T00:04:01.000Z",
    durationMs: 1_000,
    stdoutPreview: "",
    stderrPreview: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    outputArtifactRefs: ["workbench-output:command-a"],
    subject: {
      subjectHash: "subject-a",
      codeModeInputHash: "input-sha",
      codeHash: "code-sha",
      wrapperManifestHash: "wrapper-sha",
      policySnapshotHash: "policy-sha",
      worktreeIdentityHash: "worktree-a",
      worktreeStateHash: "worktree-state-a",
      worktreeBaseRef: "main",
      worktreeHeadHash: "head-a",
      changedFiles: ["src/index.ts"],
      changedFilesTruncated: false,
      artifacts: [
        {
          artifactKind: "source",
          artifactId: "code-artifact",
          relPath: "code.json",
          expectedSha256: "code-sha",
          actualSha256: "code-sha",
          verified: true,
        },
      ],
    },
    createdAt: "2026-03-26T00:04:01.000Z",
    ...overrides,
  };
}

function setRawField(db: DatabaseClient, runId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE code_mode_runs SET ${field} = ? WHERE run_id = ?`).run(value, runId);
}

describe("CodeModeRunRepository", () => {
  it("upserts, updates, finds, and lists code mode runs", () => {
    const { repo } = createStore();
    const first = repo.upsert(run({ status: "completed" }));
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
        executionBackend: undefined,
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
    assert.equal(first.executionBackend?.backendId, "trusted-code-host");
    assert.equal(first.executionBackend?.isolationProfile, "firejail");
    assert.equal(first.stdoutArtifact?.artifactId, "stdout-artifact");
    assert.equal(first.stderrArtifact?.artifactId, "stderr-artifact");
    assert.equal(first.stdoutTruncated, true);
    assert.equal(first.stderrTruncated, true);
    assert.equal(first.trustedCodeWriteVerification?.artifacts[0]?.verified, true);
    assert.equal(first.verification?.status, "completed_unverified");
    assert.deepEqual(first.result, { candidateId: "candidate-a" });
    assert.equal(first.error, "none");
    assert.equal(first.errorCode, "CODE_MODE_CHILD_ERROR");
    assert.deepEqual(first.errorDetails, { detail: true });
    assert.equal(minimal.requestedOutputIntent, undefined);
    assert.equal(minimal.originSurface, undefined);
    assert.equal(minimal.saveCandidateOnSuccess, false);
    assert.equal(minimal.sandbox, undefined);
    assert.equal(minimal.executionBackend, undefined);
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
    assert.equal(completed.executionBackend?.backendId, "trusted-code-host");
    assert.deepEqual(completed.result, { ok: true });
    assert.equal(completed.stdoutTruncated, false);
    assert.equal(completed.trustedCodeWriteVerification?.mode, "trusted_code_artifact_hash_check");
    assert.equal(completed.verification?.status, "completed_unverified");

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

  it("bounds status-hydration scans before read-side filtering", () => {
    const { repo } = createStore();
    for (let index = 0; index < 40; index += 1) {
      repo.upsert(
        run({
          runId: `failed-run-${index}`,
          status: "failed",
          createdAt: `2026-03-26T02:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      );
    }
    for (let index = 0; index < 40; index += 1) {
      repo.upsert(
        run({
          runId: `pending-run-${index}`,
          status: "approval_pending",
          approvalId: `approval-${index}`,
          createdAt: `2026-03-26T01:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      );
    }

    assert.equal(repo.listFilteredForStatusHydration({ status: "failed", limit: 5 }).length, 20);
    assert.equal(repo.listFilteredForStatusHydration({ status: "expired", limit: 5 }).length, 20);
    assert.equal(repo.listFiltered({ status: "failed", limit: 5 }).length, 5);
  });

  it("casts optional filtered list parameters for postgres null filters", () => {
    const db = new CodeModeSqlCaptureDatabase("postgres");
    new CodeModeRunRepository(db);

    const listSql = db.sql.find(
      (sql) => sql.includes("LIMIT @limit") && sql.includes("workspace_id") && sql.includes("@status"),
    );
    assert.ok(listSql);
    assert.match(listSql, /\(@workspaceId::text IS NULL OR workspace_id = @workspaceId::text\)/);
    assert.match(listSql, /\(@sessionId::text IS NULL OR session_id = @sessionId::text\)/);
    assert.match(listSql, /\(@turnId::text IS NULL OR turn_id = @turnId::text\)/);
    assert.match(listSql, /\(@status::text IS NULL OR status = @status::text\)/);

    const hydrationSql = db.sql.find((sql) => sql.includes("includeApprovalPending"));
    assert.ok(hydrationSql);
    assert.match(hydrationSql, /\(@workspaceId::text IS NULL OR workspace_id = @workspaceId::text\)/);
    assert.match(hydrationSql, /\(@sessionId::text IS NULL OR session_id = @sessionId::text\)/);
    assert.match(hydrationSql, /\(@turnId::text IS NULL OR turn_id = @turnId::text\)/);

    const releaseSql = db.sql.find((sql) => sql.includes("SET\n        status = 'approval_pending'"));
    assert.ok(releaseSql);
    assert.match(releaseSql, /started_at = @startedAt/);
    assert.match(releaseSql, /execution_generation = @executionGeneration/);
    assert.match(releaseSql, /execution_phase = 'claimed'/);
  });

  it("claims pending runs atomically before execution", () => {
    const { repo } = createStore();
    repo.upsert(
      run({
        status: "approval_pending",
        startedAt: undefined,
        finishedAt: undefined,
        error: undefined,
        errorCode: undefined,
        errorDetails: undefined,
      }),
    );

    const claimed = repo.claimForExecution({
      runId: "run-a",
      approvalId: "approval-a",
      sandbox: run().sandbox,
      startedAt: "2026-03-26T00:05:00.000Z",
    });
    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.startedAt, "2026-03-26T00:05:00.000Z");
    assert.equal(
      repo.claimForExecution({
        runId: "run-a",
        approvalId: "approval-a",
        startedAt: "2026-03-26T00:06:00.000Z",
      }),
      undefined,
    );
    assert.equal(
      repo.releaseExecutionClaim({
        runId: "run-a",
        approvalId: "approval-a",
        startedAt: "2026-03-26T00:04:00.000Z",
        executionGeneration: claimed!.executionRecovery.generation,
        interruptedAt: "2026-03-26T00:04:30.000Z",
        interruptionReason: "stale claimant",
      }),
      undefined,
    );

    const released = repo.releaseExecutionClaim({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt: "2026-03-26T00:05:00.000Z",
      executionGeneration: claimed!.executionRecovery.generation,
      interruptedAt: "2026-03-26T00:05:30.000Z",
      interruptionReason: "worker stopped before launch",
    });
    assert.equal(released?.status, "approval_pending");
    assert.equal(released?.startedAt, undefined);
  });

  it("finishes only the active Code Mode execution claim", () => {
    const { repo } = createStore();
    repo.upsert(
      run({
        status: "approval_pending",
        startedAt: undefined,
        finishedAt: undefined,
        result: undefined,
        stdoutArtifact: undefined,
        stderrArtifact: undefined,
        stdoutPreview: undefined,
        stderrPreview: undefined,
      }),
    );
    const firstClaimStartedAt = "2026-03-26T00:05:00.000Z";
    const secondClaimStartedAt = "2026-03-26T00:06:00.000Z";
    const firstClaim = repo.claimForExecution({
      runId: "run-a",
      approvalId: "approval-a",
      sandbox: run().sandbox,
      startedAt: firstClaimStartedAt,
    });
    assert.equal(firstClaim?.status, "running");
    repo.releaseExecutionClaim({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt: firstClaimStartedAt,
      executionGeneration: firstClaim!.executionRecovery.generation,
      interruptedAt: "2026-03-26T00:05:30.000Z",
      interruptionReason: "worker stopped before launch",
    });
    const secondSandbox = { ...run().sandbox!, runnerId: "runner-b" };
    const secondClaim = repo.claimForExecution({
      runId: "run-a",
      approvalId: "approval-a",
      sandbox: secondSandbox,
      startedAt: secondClaimStartedAt,
    });
    assert.equal(secondClaim?.status, "running");

    const staleFinish = repo.finishExecutionClaim({
      ...firstClaim!,
      status: "completed",
      approvalId: "approval-a",
      startedAt: firstClaimStartedAt,
      finishedAt: "2026-03-26T00:07:00.000Z",
      result: { stale: true },
    });

    assert.equal(staleFinish, undefined);
    assert.deepEqual(repo.get("run-a").result, undefined);

    const secondBoundary = repo.markExecutionBoundaryCrossed({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt: secondClaimStartedAt,
      executionGeneration: secondClaim!.executionRecovery.generation,
      boundaryCrossedAt: "2026-03-26T00:06:30.000Z",
    });
    const secondOutput = repo.recordExecutionOutput({
      ...secondBoundary!,
      approvalId: "approval-a",
      startedAt: secondClaimStartedAt,
      executionGeneration: secondClaim!.executionRecovery.generation,
      executionPhase: "output_captured_completed",
      result: { ok: true },
    });

    const currentFinish = repo.finishExecutionClaim({
      ...secondOutput!,
      status: "completed",
      approvalId: "approval-a",
      startedAt: secondClaimStartedAt,
      finishedAt: "2026-03-26T00:08:00.000Z",
      result: { ok: true },
    });

    assert.equal(currentFinish?.status, "completed");
    assert.deepEqual(currentFinish?.result, { ok: true });
    assert.equal(currentFinish?.sandbox?.runnerId, "runner-b");
    assert.equal(currentFinish?.executionBackend?.backendId, "trusted-code-host");
    assert.equal(currentFinish?.verification?.status, "completed_unverified");
    assert.equal(currentFinish?.trustedCodeWriteVerification?.artifacts[0]?.verified, true);
  });

  it("requires matching captured output before normal terminalization", () => {
    const { repo } = createStore();
    repo.upsert(
      run({
        status: "approval_pending",
        executionRecovery: { generation: 0, phase: "not_started", disposition: "none" },
        startedAt: undefined,
        finishedAt: undefined,
      }),
    );
    const startedAt = "2026-03-26T00:05:00.000Z";
    const claim = repo.claimForExecution({ runId: "run-a", approvalId: "approval-a", startedAt });
    assert.equal(
      repo.finishExecutionClaim({
        ...claim!,
        status: "completed",
        approvalId: "approval-a",
        startedAt,
        finishedAt: "2026-03-26T00:05:01.000Z",
      }),
      undefined,
    );
    const boundary = repo.markExecutionBoundaryCrossed({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      boundaryCrossedAt: "2026-03-26T00:05:02.000Z",
    });
    assert.equal(
      repo.finishExecutionClaim({
        ...boundary!,
        status: "failed",
        approvalId: "approval-a",
        startedAt,
        finishedAt: "2026-03-26T00:05:03.000Z",
      }),
      undefined,
    );
    const completedOutput = repo.recordExecutionOutput({
      ...boundary!,
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      executionPhase: "output_captured_completed",
      result: { ok: true },
    });
    assert.equal(
      repo.finishExecutionClaim({
        ...completedOutput!,
        status: "failed",
        approvalId: "approval-a",
        startedAt,
        finishedAt: "2026-03-26T00:05:04.000Z",
      }),
      undefined,
    );
    assert.equal(
      repo.finishExecutionClaim({
        ...completedOutput!,
        status: "completed",
        approvalId: "approval-a",
        startedAt,
        finishedAt: "2026-03-26T00:05:05.000Z",
      })?.status,
      "completed",
    );
  });

  it("never marks a claimed pre-boundary run for manual reconciliation", () => {
    const { repo } = createStore();
    repo.upsert(
      run({
        status: "approval_pending",
        executionRecovery: { generation: 0, phase: "not_started", disposition: "none" },
        startedAt: undefined,
        finishedAt: undefined,
      }),
    );
    const startedAt = "2026-03-26T00:05:00.000Z";
    const claim = repo.claimForExecution({ runId: "run-a", approvalId: "approval-a", startedAt });
    assert.equal(
      repo.markExecutionInterrupted({
        runId: "run-a",
        approvalId: "approval-a",
        startedAt,
        executionGeneration: claim!.executionRecovery.generation,
        interruptedAt: "2026-03-26T00:05:01.000Z",
        interruptionReason: "abort before dispatch",
      }),
      undefined,
    );
    const released = repo.releaseExecutionClaim({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      interruptedAt: "2026-03-26T00:05:01.000Z",
      interruptionReason: "abort before dispatch",
    });
    assert.equal(released?.status, "approval_pending");
    assert.equal(released?.executionRecovery.disposition, "retryable");
  });

  it("fences execution generations and never releases a claim after the mutation boundary", () => {
    const { dbPath, db, repo } = createStore();
    repo.upsert(
      run({
        status: "approval_pending",
        executionRecovery: { generation: 0, phase: "not_started", disposition: "none" },
        startedAt: undefined,
        finishedAt: undefined,
        stdoutArtifact: undefined,
        stderrArtifact: undefined,
        stdoutPreview: undefined,
        stderrPreview: undefined,
        result: undefined,
      }),
    );
    const startedAt = "2026-03-26T00:05:00.000Z";
    const claim = repo.claimForExecution({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
    });
    assert.equal(claim?.executionRecovery.generation, 1);
    assert.equal(claim?.executionRecovery.phase, "claimed");
    assert.equal(
      repo.releaseExecutionClaim({
        runId: "run-a",
        approvalId: "approval-a",
        startedAt,
        executionGeneration: 0,
        interruptedAt: "2026-03-26T00:05:01.000Z",
        interruptionReason: "stale generation",
      }),
      undefined,
    );

    const boundary = repo.markExecutionBoundaryCrossed({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: 1,
      boundaryCrossedAt: "2026-03-26T00:05:02.000Z",
    });
    assert.equal(boundary?.executionRecovery.phase, "boundary_crossed");
    assert.equal(
      repo.releaseExecutionClaim({
        runId: "run-a",
        approvalId: "approval-a",
        startedAt,
        executionGeneration: 1,
        interruptedAt: "2026-03-26T00:05:03.000Z",
        interruptionReason: "must not replay",
      }),
      undefined,
    );

    const output = repo.recordExecutionOutput({
      ...boundary!,
      approvalId: "approval-a",
      startedAt,
      executionGeneration: 1,
      executionPhase: "output_captured_failed",
      stdoutArtifact: artifact("partial-stdout"),
      stdoutPreview: "completed prefix",
      stdoutTruncated: false,
      stderrTruncated: false,
      error: "worker interrupted",
      errorCode: "RUN_CANCELLED",
    });
    assert.equal(output?.executionRecovery.phase, "output_captured_failed");
    assert.equal(output?.stdoutPreview, "completed prefix");

    const terminal = repo.markExecutionInterrupted({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: 1,
      interruptedAt: "2026-03-26T00:05:04.000Z",
      interruptionReason: "gateway restart after child launch",
    });
    assert.equal(terminal?.status, "failed");
    assert.equal(terminal?.executionRecovery.disposition, "manual_reconciliation");
    assert.equal(terminal?.stdoutPreview, "completed prefix");

    db.close();
    const reopened = createDatabase({ dbPath });
    const reopenedRun = new CodeModeRunRepository(reopened).get("run-a");
    assert.equal(reopenedRun.status, "failed");
    assert.equal(reopenedRun.executionRecovery.generation, 1);
    assert.equal(reopenedRun.executionRecovery.disposition, "manual_reconciliation");
    assert.equal(reopenedRun.executionRecovery.interruptionReason, "gateway restart after child launch");
    assert.equal(reopenedRun.stdoutPreview, "completed prefix");
    reopened.close();
  });

  it("fails closed for legacy ambiguous execution ownership and corrupt recovery phases", () => {
    const { db, repo } = createStore();
    repo.upsert(
      run({
        status: "approval_pending",
        executionRecovery: { generation: 0, phase: "not_started", disposition: "none" },
        startedAt: undefined,
        finishedAt: undefined,
      }),
    );
    const startedAt = "2026-03-26T00:05:00.000Z";
    const claim = repo.claimForExecution({ runId: "run-a", approvalId: "approval-a", startedAt });
    db.prepare(
      "UPDATE code_mode_runs SET execution_phase = 'legacy_unknown', recovery_disposition = 'manual_reconciliation' WHERE run_id = ?",
    ).run("run-a");

    const legacyTerminal = repo.markExecutionInterrupted({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      interruptedAt: "2026-03-26T00:05:01.000Z",
      interruptionReason: "legacy owner disappeared during restart",
    });
    assert.equal(legacyTerminal?.status, "failed");
    assert.equal(legacyTerminal?.executionRecovery.disposition, "manual_reconciliation");

    repo.upsert(run({ runId: "run-corrupt-recovery" }));
    db.prepare("UPDATE code_mode_runs SET execution_phase = 'impossible_phase' WHERE run_id = ?").run(
      "run-corrupt-recovery",
    );
    const corrupt = repo.get("run-corrupt-recovery");
    assert.equal(corrupt.status, "failed");
    assert.equal(corrupt.errorCode, "CORRUPT_CODE_MODE_RUN_LEDGER");
    assert.equal(corrupt.executionRecovery.disposition, "manual_reconciliation");
    assert.match(corrupt.error ?? "", /invalid execution_phase/u);
  });

  it("resets a tentative boundary and preserves launch diagnostics when dispatch cannot occur", () => {
    const { repo } = createStore();
    repo.upsert(
      run({
        status: "approval_pending",
        executionRecovery: { generation: 0, phase: "not_started", disposition: "none" },
        startedAt: undefined,
        finishedAt: undefined,
      }),
    );
    const startedAt = "2026-03-26T00:05:00.000Z";
    const claim = repo.claimForExecution({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
    });
    const boundary = repo.markExecutionBoundaryCrossed({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      boundaryCrossedAt: "2026-03-26T00:05:01.000Z",
    });
    assert.equal(boundary?.executionRecovery.phase, "boundary_crossed");

    const reset = repo.resetExecutionBoundaryBeforeDispatch({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
    });
    assert.equal(reset?.executionRecovery.phase, "claimed");
    assert.equal(reset?.executionRecovery.boundaryCrossedAt, undefined);

    const failedSandbox = {
      ...run().sandbox!,
      available: false,
      checksFailed: ["launch_preparation_failed"],
      failClosedReason: "launch preparation failed",
    };
    const syntheticToken = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    const released = repo.releaseExecutionClaim({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      interruptedAt: "2026-03-26T00:05:02.000Z",
      interruptionReason: `child IPC ${syntheticToken} ${"😀".repeat(2_000)} channel closed before request dispatch`,
      sandbox: failedSandbox,
    });
    assert.equal(released?.status, "approval_pending");
    assert.equal(released?.executionRecovery.phase, "not_started");
    assert.equal(released?.executionRecovery.disposition, "retryable");
    assert.ok(Buffer.byteLength(released?.executionRecovery.interruptionReason ?? "", "utf8") <= 1_024);
    assert.doesNotMatch(released?.executionRecovery.interruptionReason ?? "", new RegExp(syntheticToken));
    assert.doesNotMatch(released?.executionRecovery.interruptionReason ?? "", /�/);
    assert.equal(released?.sandbox?.available, false);
    assert.deepEqual(released?.sandbox?.checksFailed, ["launch_preparation_failed"]);
  });

  it("tracks terminal transcript delivery with a deterministic generation fence", () => {
    const { repo } = createStore();
    repo.upsert(
      run({
        status: "completed",
        executionRecovery: {
          generation: 3,
          phase: "terminal",
          disposition: "terminal",
          finalTranscriptEventId: "code-mode-final:run-a",
        },
      }),
    );

    assert.deepEqual(
      repo.listPendingFinalTranscriptDelivery().map((item) => item.runId),
      ["run-a"],
    );
    assert.equal(
      repo.markFinalTranscriptEnqueued({
        runId: "run-a",
        executionGeneration: 2,
        eventId: "code-mode-final:run-a",
        enqueuedAt: "2026-03-26T00:06:00.000Z",
      }),
      undefined,
    );
    const delivered = repo.markFinalTranscriptEnqueued({
      runId: "run-a",
      executionGeneration: 3,
      eventId: "code-mode-final:run-a",
      enqueuedAt: "2026-03-26T00:06:00.000Z",
    });
    assert.equal(delivered?.executionRecovery.finalTranscriptEnqueuedAt, "2026-03-26T00:06:00.000Z");
    assert.deepEqual(repo.listPendingFinalTranscriptDelivery(), []);
  });

  it("rejects stale generic upserts across newer claims and transcript settlement", () => {
    const { repo } = createStore();
    const stalePending = repo.upsert(
      run({
        status: "approval_pending",
        executionRecovery: { generation: 0, phase: "not_started", disposition: "none" },
        startedAt: undefined,
        finishedAt: undefined,
      }),
    );
    const startedAt = "2026-03-26T00:05:00.000Z";
    const claim = repo.claimForExecution({ runId: "run-a", approvalId: "approval-a", startedAt });

    repo.upsert({ ...stalePending, status: "failed", error: "stale caller" });
    assert.equal(repo.get("run-a").status, "running");
    assert.equal(repo.get("run-a").executionRecovery.generation, 1);
    assert.equal(repo.get("run-a").executionRecovery.phase, "claimed");

    const boundary = repo.markExecutionBoundaryCrossed({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      boundaryCrossedAt: "2026-03-26T00:05:01.000Z",
    });
    const output = repo.recordExecutionOutput({
      ...boundary!,
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      executionPhase: "output_captured_completed",
      result: { ok: true },
    });
    const terminal = repo.finishExecutionClaim({
      ...output!,
      status: "completed",
      approvalId: "approval-a",
      startedAt,
      finishedAt: "2026-03-26T00:05:02.000Z",
    });
    const beforeDelivery = { ...terminal!, executionRecovery: { ...terminal!.executionRecovery } };
    repo.markFinalTranscriptEnqueued({
      runId: "run-a",
      executionGeneration: claim!.executionRecovery.generation,
      eventId: "code-mode-final:run-a",
      enqueuedAt: "2026-03-26T00:05:03.000Z",
    });

    repo.upsert(beforeDelivery);
    const settled = repo.get("run-a");
    assert.equal(settled.status, "completed");
    assert.equal(settled.executionRecovery.generation, 1);
    assert.equal(settled.executionRecovery.phase, "terminal");
    assert.equal(settled.executionRecovery.finalTranscriptEnqueuedAt, "2026-03-26T00:05:03.000Z");
  });

  it("redacts and byte-bounds interruption recovery reason and details", () => {
    const { db, repo } = createStore();
    repo.upsert(
      run({
        status: "approval_pending",
        executionRecovery: { generation: 0, phase: "not_started", disposition: "none" },
        startedAt: undefined,
        finishedAt: undefined,
      }),
    );
    const startedAt = "2026-03-26T00:05:00.000Z";
    const claim = repo.claimForExecution({ runId: "run-a", approvalId: "approval-a", startedAt });
    repo.markExecutionBoundaryCrossed({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      boundaryCrossedAt: "2026-03-26T00:05:01.000Z",
    });
    const syntheticToken = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    let deep: Record<string, unknown> = { payload: `${syntheticToken}-${"😀".repeat(20_000)}` };
    for (let index = 0; index < 20; index += 1) {
      deep = { nested: deep };
    }
    repo.markExecutionInterrupted({
      runId: "run-a",
      approvalId: "approval-a",
      startedAt,
      executionGeneration: claim!.executionRecovery.generation,
      interruptedAt: "2026-03-26T00:05:02.000Z",
      interruptionReason: `Bearer ${syntheticToken} ${"😀".repeat(2_000)}`,
      error: `child failed with ${syntheticToken}`,
      errorDetails: { childErrorDetails: deep },
    });

    const row = db
      .prepare("SELECT interruption_reason, error_text, error_details_json FROM code_mode_runs WHERE run_id = ?")
      .get("run-a") as { interruption_reason: string; error_text: string; error_details_json: string };
    assert.ok(Buffer.byteLength(row.interruption_reason, "utf8") <= 1_024);
    assert.ok(Buffer.byteLength(row.error_text, "utf8") <= 4 * 1_024);
    assert.ok(Buffer.byteLength(row.error_details_json, "utf8") <= 16 * 1_024);
    assert.doesNotMatch(
      `${row.interruption_reason}${row.error_text}${row.error_details_json}`,
      new RegExp(syntheticToken),
    );
    assert.doesNotMatch(`${row.interruption_reason}${row.error_text}${row.error_details_json}`, /�/);
    const storedDetails = JSON.parse(row.error_details_json) as Record<string, unknown>;
    assert.equal(storedDetails.manualReconciliationRequired, true);
    assert.equal(storedDetails.detailsTruncated, true);
    assert.match(String(storedDetails.redactedSha256), /^[a-f0-9]{64}$/u);
    assert.equal(typeof storedDetails.redactedBytes, "number");
    assert.deepEqual(Object.keys(storedDetails).sort(), [
      "detailsTruncated",
      "manualReconciliationRequired",
      "reason",
      "redactedBytes",
      "redactedSha256",
    ]);
  });

  it("atomically appends bounded verification evidence and preserves it across restart", () => {
    const { dbPath, db, repo } = createStore();
    repo.upsert(run({ status: "completed" }));
    assert.equal(repo.get("run-a").verification?.status, "completed_unverified");

    const recorded = repo.recordVerificationEvidence(verificationEvidence());
    assert.equal(recorded.run.verification?.status, "verified");
    assert.equal(recorded.run.verification?.evidenceId, "proof-a");
    assert.equal(recorded.evidence.subject.subjectHash, "subject-a");
    assert.deepEqual(repo.listVerificationEvidence("run-a"), [recorded.evidence]);
    assert.throws(() => db.prepare("UPDATE code_mode_verification_evidence SET status = 'stale'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM code_mode_verification_evidence").run(), /append-only/);

    db.close();
    const reopenedDb = createDatabase({ dbPath });
    const reopened = new CodeModeRunRepository(reopenedDb);
    assert.equal(reopened.get("run-a").verification?.status, "verified");
    assert.equal(reopened.get("run-a").trustedCodeWriteVerification?.artifacts[0]?.verified, true);
    assert.equal(reopened.listVerificationEvidence("run-a")[0]?.evidenceId, "proof-a");

    const stale = reopened.recordVerificationEvidence(
      verificationEvidence({
        evidenceId: "proof-stale",
        status: "stale",
        reason: "worktree_state_drift",
        createdAt: "2026-03-26T00:05:00.000Z",
        subject: {
          ...verificationEvidence().subject,
          subjectHash: "subject-b",
          worktreeStateHash: "worktree-state-b",
        },
      }),
    );
    assert.equal(stale.run.verification?.status, "stale");
    assert.equal(stale.run.verification?.reason, "worktree_state_drift");
    assert.deepEqual(
      reopened.listVerificationEvidence("run-a").map((item) => item.evidenceId),
      ["proof-stale", "proof-a"],
    );
    reopenedDb.close();
  });

  it("rolls back the evidence append when the current-state update fails", () => {
    const { db, repo } = createStore();
    repo.upsert(run({ status: "completed" }));
    db.exec(`
      CREATE TRIGGER fail_code_mode_verification_state
      BEFORE UPDATE OF verification_status ON code_mode_runs
      WHEN NEW.verification_status = 'verified'
      BEGIN
        SELECT RAISE(ABORT, 'injected verification state failure');
      END;
    `);

    assert.throws(() => repo.recordVerificationEvidence(verificationEvidence()), /injected verification state failure/);
    assert.equal(repo.get("run-a").verification?.status, "completed_unverified");
    assert.deepEqual(repo.listVerificationEvidence("run-a"), []);
  });

  it("rejects verification evidence that is not bound to the stored run or a passing named proof", () => {
    const { repo } = createStore();
    repo.upsert(run({ status: "completed" }));

    assert.throws(
      () =>
        repo.recordVerificationEvidence(
          verificationEvidence({
            subject: { ...verificationEvidence().subject, codeHash: "another-code-hash" },
          }),
        ),
      /does not bind the stored run identity/,
    );
    assert.throws(
      () =>
        repo.recordVerificationEvidence(
          verificationEvidence({
            evidenceId: "proof-failed-claim",
            commandStatus: "failed",
            exitCode: 1,
          }),
        ),
      /cannot support a verified claim/,
    );
    assert.deepEqual(repo.listVerificationEvidence("run-a"), []);
  });

  it("fails closed for legacy or incomplete verification state", () => {
    const { db, repo } = createStore();
    repo.upsert(run({ status: "completed" }));
    db.prepare(
      `
      UPDATE code_mode_runs
      SET verification_status = 'verified',
          verification_evidence_id = NULL,
          verification_subject_hash = NULL
      WHERE run_id = ?
    `,
    ).run("run-a");

    const stored = repo.get("run-a");
    assert.equal(stored.verification?.status, "completed_unverified");
    assert.match(stored.verification?.reason ?? "", /Legacy or incomplete/);
  });

  it("surfaces malformed stored JSON payloads as failed ledger records", () => {
    const { db, repo } = createStore();
    const corrupt = (runId: string, field: string, expected: RegExp) => {
      repo.upsert(run({ runId }));
      setRawField(db, runId, field, "{bad json");
      const stored = repo.get(runId);
      assert.equal(stored.status, "failed");
      assert.equal(stored.errorCode, "CORRUPT_CODE_MODE_RUN_LEDGER");
      assert.match(stored.error ?? "", expected);
      assert.equal(stored.codeArtifact.bytes, 0);
      assert.equal(stored.finishedAt, "2026-03-26T00:00:02.000Z");
    };

    corrupt("run-sandbox", "sandbox_json", /corrupt sandbox_json metadata/);
    corrupt("run-execution-backend", "execution_backend_json", /corrupt execution_backend_json metadata/);
    corrupt("run-code", "code_artifact_json", /corrupt code_artifact_json metadata/);
    corrupt("run-wrapper", "wrapper_manifest_artifact_json", /corrupt wrapper_manifest_artifact_json metadata/);
    corrupt("run-policy", "policy_snapshot_artifact_json", /corrupt policy_snapshot_artifact_json metadata/);
    corrupt("run-stdout", "stdout_artifact_json", /corrupt stdout_artifact_json metadata/);
    corrupt("run-stderr", "stderr_artifact_json", /corrupt stderr_artifact_json metadata/);
    corrupt(
      "run-trusted-code-write-verification",
      "trusted_code_write_verification_json",
      /corrupt trusted_code_write_verification_json metadata/,
    );
    corrupt("run-result", "result_json", /corrupt result_json metadata/);
    corrupt("run-error-details", "error_details_json", /corrupt error_details_json metadata/);
    repo.upsert(run({ runId: "run-healthy", createdAt: "2026-03-26T00:10:00.000Z" }));
    const listedRunIds = repo.listFiltered({ workspaceId: "workspace-a", limit: 20 }).map((item) => item.runId);
    assert.equal(listedRunIds.length, 11);
    assert.equal(listedRunIds[0], "run-healthy");
    assert.equal(new Set(listedRunIds).has("run-code"), true);
    assert.equal(new Set(listedRunIds).has("run-error-details"), true);

    const failedRunIds = repo
      .listFiltered({ workspaceId: "workspace-a", status: "failed", limit: 20 })
      .map((item) => item.runId);
    assert.equal(new Set(failedRunIds).has("run-result"), true);
    assert.equal(new Set(failedRunIds).has("run-error-details"), true);
    assert.equal(new Set(failedRunIds).has("run-healthy"), false);

    const syntheticToken = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    repo.upsert(run({ runId: "run-corrupt-secret" }));
    setRawField(db, "run-corrupt-secret", "result_json", `${syntheticToken}${"😀".repeat(20_000)}`);
    const corruptSecret = repo.get("run-corrupt-secret");
    assert.ok(Buffer.byteLength(corruptSecret.error ?? "", "utf8") <= 4 * 1_024);
    assert.doesNotMatch(corruptSecret.error ?? "", new RegExp(syntheticToken));
    assert.doesNotMatch(JSON.stringify(corruptSecret.errorDetails), new RegExp(syntheticToken));
    assert.doesNotMatch(`${corruptSecret.error}${JSON.stringify(corruptSecret.errorDetails)}`, /�/);
  });

  it("hydrates failed filters before applying the list limit", () => {
    const { db, repo } = createStore();
    repo.upsert(
      run({
        runId: "run-old-failed",
        status: "failed",
        createdAt: "2026-03-25T00:00:00.000Z",
        error: "old failure",
      }),
    );
    repo.upsert(
      run({
        runId: "run-old-corrupt",
        status: "running",
        createdAt: "2026-03-26T00:09:00.000Z",
      }),
    );
    setRawField(db, "run-old-corrupt", "result_json", "{bad json");

    for (let index = 0; index < 501; index += 1) {
      repo.upsert(
        run({
          runId: `run-new-completed-${index}`,
          status: "completed",
          result: { ok: true, index },
          createdAt: new Date(Date.UTC(2026, 2, 26, 0, 0, index)).toISOString(),
        }),
      );
    }

    const failedRunIds = repo
      .listFiltered({ workspaceId: "workspace-a", status: "failed", limit: 20 })
      .map((item) => item.runId);

    assert.equal(new Set(failedRunIds).has("run-old-failed"), true);
    assert.equal(new Set(failedRunIds).has("run-old-corrupt"), true);
    assert.equal(
      failedRunIds.some((runId) => runId.startsWith("run-new-completed-")),
      false,
    );
  });
});

class CodeModeSqlCaptureDatabase implements DatabaseClient {
  public readonly sql: string[] = [];

  public constructor(public readonly dialect: DatabaseClient["dialect"]) {}

  public prepare(sql: string): DbStatement {
    this.sql.push(sql);
    return new CodeModeFakeStatement();
  }

  public exec(): void {}

  public close(): void {}

  public transaction<T>(_mode: "deferred" | "immediate" | "exclusive", callback: () => T): T {
    return callback();
  }
}

class CodeModeFakeStatement implements DbStatement {
  public run(): { changes: number } {
    return { changes: 0 };
  }

  public get<T = unknown>(): T | undefined {
    return undefined;
  }

  public all<T = unknown>(): T[] {
    return [];
  }
}
