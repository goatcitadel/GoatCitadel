import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CapabilityArtifactRecord,
  ChatSessionWorkbenchCommandRunResponse,
  CodeModeRunRecord,
} from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { CodeModeVerificationService } from "./code-mode-verification-service.js";

const roots: string[] = [];
const stores: Storage[] = [];

afterEach(() => {
  for (const storage of stores.splice(0)) {
    storage.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("CodeModeVerificationService", () => {
  it("records a fresh named proof separately from trusted artifact integrity", async () => {
    const fixture = createFixture();
    const runCommand = vi.fn(async () => commandResponse("passed", 0));
    const service = fixture.service(runCommand);

    const result = await service.verifyRun(fixture.run, "typecheck", "operator-a");

    expect(runCommand).toHaveBeenCalledWith("session-a", { command: "pnpm", args: ["run", "typecheck"] });
    expect(result.run.status).toBe("completed");
    expect(result.run.verification?.status).toBe("verified");
    expect(result.run.trustedCodeWriteVerification?.mode).toBe("trusted_code_artifact_hash_check");
    expect(result.evidence.commandName).toBe("typecheck");
    expect(result.evidence.scope).toBe("targeted");
    expect(result.evidence.subject.artifacts.every((artifact) => artifact.verified)).toBe(true);
    expect(result.evidence.subject.worktreeHeadHash).toMatch(/^[a-f0-9]{40}$/);
    expect(result.evidence.outputArtifactRefs).toEqual(["workbench-output:command-a"]);
  });

  it("records failed named proof without claiming verification", async () => {
    const fixture = createFixture();
    const service = fixture.service(async () => commandResponse("failed", 1));

    const result = await service.verifyRun(fixture.run, "git_diff_check", "operator-a");

    expect(result.run.verification?.status).toBe("verification_failed");
    expect(result.evidence.command).toBe("git");
    expect(result.evidence.args).toEqual(["diff", "--check"]);
    expect(result.evidence.reason).toContain("named_proof_failed");
  });

  it("fails a passing command when the worktree changes during proof", async () => {
    const fixture = createFixture();
    const service = fixture.service(async () => {
      fs.appendFileSync(path.join(fixture.worktree, "index.ts"), "export const drift = true;\n");
      return commandResponse("passed", 0);
    });

    const result = await service.verifyRun(fixture.run, "test", "operator-a");

    expect(result.run.verification?.status).toBe("verification_failed");
    expect(result.evidence.reason).toContain("subject_changed_during_proof");
  });

  it("passively marks prior proof stale after worktree or artifact drift", { timeout: 60_000 }, async () => {
    const fixture = createFixture();
    const service = fixture.service(async () => commandResponse("passed", 0));
    const verified = await service.verifyRun(fixture.run, "git_diff_check", "operator-a");

    fs.appendFileSync(path.join(fixture.worktree, "index.ts"), "export const changed = true;\n");
    const worktreeStale = service.refreshRun(verified.run);
    expect(worktreeStale.verification?.status).toBe("stale");
    expect(worktreeStale.verification?.reason).toContain("verification_subject_drift");

    const fixture2 = createFixture();
    const service2 = fixture2.service(async () => commandResponse("passed", 0));
    const verified2 = await service2.verifyRun(fixture2.run, "git_diff_check", "operator-a");
    fs.writeFileSync(fixture2.sourcePath, "tampered source", "utf8");
    const artifactStale = service2.refreshRun(verified2.run);
    expect(artifactStale.verification?.status).toBe("stale");
    expect(artifactStale.verification?.reason).toContain("artifact_source_drift");
    expect(fixture2.storage.codeModeRuns.listVerificationEvidence("run-a")[0]?.commandName).toBe(
      "passive_freshness_check",
    );
  });

  it("fails closed when the current verification evidence row is missing", async () => {
    const fixture = createFixture();
    const service = fixture.service(async () => commandResponse("passed", 0));
    const verified = await service.verifyRun(fixture.run, "git_diff_check", "operator-a");
    fixture.storage.db
      .prepare("UPDATE code_mode_runs SET verification_evidence_id = 'missing-proof' WHERE run_id = 'run-a'")
      .run();

    const stale = service.refreshRun(fixture.storage.codeModeRuns.get(verified.run.runId));

    expect(stale.verification?.status).toBe("stale");
    expect(stale.verification?.reason).toBe("verification_evidence_missing_or_mismatched");
    expect(fixture.storage.codeModeRuns.listVerificationEvidence("run-a")[0]?.status).toBe("stale");
  });

  it("redacts and bounds command failure output before durable storage", async () => {
    const fixture = createFixture();
    const service = fixture.service(async () => {
      throw new Error(`failed with token ${"sk-" + "a".repeat(48)} ${"x".repeat(5_000)}`);
    });

    const result = await service.verifyRun(fixture.run, "test", "operator-a");

    expect(result.evidence.status).toBe("verification_failed");
    expect(result.evidence.stderrPreview).not.toContain("sk-");
    expect(result.evidence.stderrPreview?.length).toBeLessThanOrEqual(4_096);
    expect(result.evidence.stderrTruncated).toBe(true);
    expect(JSON.stringify(fixture.storage.codeModeRuns.listVerificationEvidence("run-a"))).not.toContain("sk-");
  });

  it("fails closed when an in-root artifact path resolves through a junction outside the managed root", async () => {
    const fixture = createFixture();
    const managedRunRoot = path.dirname(fixture.sourcePath);
    const escapedRunRoot = path.join(fixture.root, "escaped-artifacts");
    fs.cpSync(managedRunRoot, escapedRunRoot, { recursive: true });
    fs.rmSync(managedRunRoot, { recursive: true, force: true });
    try {
      fs.symlinkSync(escapedRunRoot, managedRunRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }
    const runCommand = vi.fn(async () => commandResponse("passed", 0));
    const service = fixture.service(runCommand);

    const result = await service.verifyRun(fixture.run, "typecheck", "operator-a");

    expect(runCommand).toHaveBeenCalledOnce();
    expect(result.run.verification?.status).toBe("verification_failed");
    expect(result.evidence.reason).toContain("artifact_source_unavailable");
    expect(result.evidence.subject.artifacts.every((artifact) => artifact.verified === false)).toBe(true);
  });

  it("does not execute a repository-configured external diff helper while fingerprinting the worktree", async () => {
    const fixture = createFixture();
    const markerPath = path.join(fixture.root, "external-diff-ran.txt");
    const helperPath = path.join(fixture.root, "malicious-diff.cjs");
    fs.writeFileSync(
      helperPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed", "utf8");\n`,
      "utf8",
    );
    const externalDiff = `"${process.execPath}" "${helperPath}"`;
    execFileSync("git", ["config", "diff.external", externalDiff], { cwd: fixture.worktree });
    fs.appendFileSync(path.join(fixture.worktree, "index.ts"), "export const changed = true;\n");
    const service = fixture.service(async () => commandResponse("passed", 0));

    const result = await service.verifyRun(fixture.run, "git_diff_check", "operator-a");

    expect(result.run.verification?.status).toBe("verified");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("does not execute a repository-configured fsmonitor helper while fingerprinting the worktree", async () => {
    const fixture = createFixture();
    const markerPath = path.join(fixture.root, "fsmonitor-ran.txt");
    const helperPath = path.join(
      fixture.root,
      process.platform === "win32" ? "malicious-fsmonitor.cmd" : "malicious-fsmonitor.sh",
    );
    fs.writeFileSync(
      helperPath,
      process.platform === "win32"
        ? `@echo off\r\n> "${markerPath}" echo executed\r\nexit /b 0\r\n`
        : `#!/bin/sh\nprintf executed > ${JSON.stringify(markerPath)}\nexit 0\n`,
      "utf8",
    );
    if (process.platform !== "win32") {
      fs.chmodSync(helperPath, 0o700);
    }
    execFileSync("git", ["config", "core.fsmonitor", helperPath], { cwd: fixture.worktree });
    const service = fixture.service(async () => commandResponse("passed", 0));

    const result = await service.verifyRun(fixture.run, "git_diff_check", "operator-a");

    expect(result.run.verification?.status).toBe("verified");
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-code-proof-"));
  roots.push(root);
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init"], { cwd: worktree, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "proof@example.invalid"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Proof Test"], { cwd: worktree });
  fs.writeFileSync(path.join(worktree, "index.ts"), "export const ok = true;\n", "utf8");
  execFileSync("git", ["add", "index.ts"], { cwd: worktree });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: worktree, stdio: "ignore" });

  const storage = new Storage({
    dbPath: path.join(root, "runtime.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  stores.push(storage);
  storage.chatSessionWorkbench.ensure("session-a");
  storage.chatSessionWorkbench.patch("session-a", {
    baseRef: "main",
    worktreePath: worktree,
    worktreeStatus: "ready",
  });

  const artifactRoot = path.join(root, ".assistant", "code-mode-artifacts");
  const runRoot = path.join(artifactRoot, "run-a");
  fs.mkdirSync(runRoot, { recursive: true });
  const sourcePath = path.join(runRoot, "source.ts");
  const wrapperPath = path.join(runRoot, "wrapper.json");
  const policyPath = path.join(runRoot, "policy.json");
  fs.writeFileSync(sourcePath, "export default 1;", "utf8");
  fs.writeFileSync(wrapperPath, "{}", "utf8");
  fs.writeFileSync(policyPath, "{}", "utf8");
  const source = artifact(root, sourcePath, "source");
  const wrapper = artifact(root, wrapperPath, "wrapper");
  const policy = artifact(root, policyPath, "policy");
  const run: CodeModeRunRecord = storage.codeModeRuns.upsert({
    runId: "run-a",
    status: "completed",
    language: "typescript",
    workspaceId: "workspace-a",
    operatorId: "operator-a",
    saveCandidateOnSuccess: false,
    capabilitySnapshotId: "snapshot-a",
    codeModeInputHash: "input-a",
    wrapperManifestHash: "wrapper-value-a",
    policySnapshotHash: "policy-value-a",
    codeHash: source.sha256,
    sessionId: "session-a",
    turnId: "turn-a",
    codeArtifact: source,
    wrapperManifestArtifact: wrapper,
    policySnapshotArtifact: policy,
    stdoutTruncated: false,
    stderrTruncated: false,
    trustedCodeWriteVerification: {
      mode: "trusted_code_artifact_hash_check",
      claimBoundary: "trusted_code_artifact_integrity_not_hostile_sandbox",
      verifiedAt: "2026-07-13T00:00:00.000Z",
      artifacts: [
        {
          artifactKind: "source",
          artifactId: source.artifactId,
          relPath: source.relPath,
          expectedSha256: source.sha256,
          actualSha256: source.sha256,
          verified: true,
        },
      ],
      notes: ["Artifact integrity is distinct from semantic verification."],
    },
    verification: {
      status: "completed_unverified",
      updatedAt: "2026-07-13T00:00:00.000Z",
    },
    createdAt: "2026-07-13T00:00:00.000Z",
    startedAt: "2026-07-13T00:00:01.000Z",
    finishedAt: "2026-07-13T00:00:02.000Z",
  });
  const events: Array<Record<string, unknown>> = [];
  return {
    root,
    worktree,
    artifactRoot,
    sourcePath,
    storage,
    run,
    events,
    service: (
      runWorkbenchCommand: (
        sessionId: string,
        input: { command: string; args?: string[] },
      ) => Promise<ChatSessionWorkbenchCommandRunResponse>,
    ) =>
      new CodeModeVerificationService({
        rootDir: root,
        artifactRoot,
        storage,
        getWorkbench: async () => ({
          ...storage.chatSessionWorkbench.get("session-a")!,
          packageManager: "pnpm",
        }),
        runWorkbenchCommand,
        publishRealtime: (_eventType, _source, payload) => events.push(payload),
        // Full-suite process contention can delay disposable-repository Git
        // probes; production retains the service's 15-second default.
        gitCaptureTimeoutMs: 60_000,
      }),
  };
}

function artifact(root: string, targetPath: string, name: string): CapabilityArtifactRecord {
  const content = fs.readFileSync(targetPath);
  return {
    artifactId: `${name}-artifact`,
    relPath: path.relative(root, targetPath).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    mimeType: "application/octet-stream",
    createdAt: "2026-07-13T00:00:00.000Z",
  };
}

function commandResponse(status: "passed" | "failed", exitCode: number): ChatSessionWorkbenchCommandRunResponse {
  return {
    state: {
      sessionId: "session-a",
      projectId: "project-a",
      packageManager: "pnpm",
      worktreeStatus: "ready",
      validationStatus: status === "passed" ? "passed" : "failed",
      outputArtifactId: "workbench-output:command-a",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:03.000Z",
    },
    run: {
      commandRunId: "command-a",
      sessionId: "session-a",
      command: "pnpm",
      args: ["run", "typecheck"],
      status,
      exitCode,
      startedAt: "2026-07-13T00:00:02.000Z",
      completedAt: "2026-07-13T00:00:03.000Z",
      stdoutPreview: status === "passed" ? "passed" : "failed",
      stderrPreview: "",
      validationStatus: status === "passed" ? "passed" : "failed",
    },
    output: {
      state: {
        sessionId: "session-a",
        worktreeStatus: "ready",
        validationStatus: status === "passed" ? "passed" : "failed",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:03.000Z",
      },
      output: "proof output",
      updatedAt: "2026-07-13T00:00:03.000Z",
    },
  };
}
