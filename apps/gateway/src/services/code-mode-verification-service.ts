import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  ValidationError,
  redactStructuredSecrets,
  type AgenticCommandRunRecord,
  type CapabilityArtifactRecord,
  type ChatSessionWorkbenchCommandRunRequest,
  type ChatSessionWorkbenchCommandRunResponse,
  type ChatSessionWorkbenchRecord,
  type CodeModeRunRecord,
  type CodeModeRunVerificationResponse,
  type CodeModeTrustedCodeWriteVerificationArtifactKind,
  type CodeModeVerificationArtifactBinding,
  type CodeModeVerificationCommandName,
  type CodeModeVerificationEvidenceRecord,
  type CodeModeVerificationSubjectBinding,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import {
  CODE_MODE_GIT_CAPTURE_TIMEOUT_MS,
  assertPathInside,
  captureCodeModeWorkbenchWorktree as captureWorktree,
  readContainedRegularFile,
} from "./code-mode-worktree-capture.js";

const MAX_MANAGED_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_PREVIEW_CHARS = 4_096;

interface CodeModeVerificationServiceOptions {
  rootDir: string;
  artifactRoot: string;
  storage: Storage;
  getWorkbench: (sessionId: string) => Promise<ChatSessionWorkbenchRecord>;
  runWorkbenchCommand: (
    sessionId: string,
    input: ChatSessionWorkbenchCommandRunRequest,
  ) => Promise<ChatSessionWorkbenchCommandRunResponse>;
  publishRealtime: (eventType: string, source: string, payload: Record<string, unknown>) => Promise<unknown>;
  /** Test/load-harness override; production keeps the bounded 15-second Git capture limit. */
  gitCaptureTimeoutMs?: number;
}

interface VerificationSubjectCapture {
  subject: CodeModeVerificationSubjectBinding;
  valid: boolean;
  reasons: string[];
}

interface VerificationCommandSpec {
  commandName: CodeModeVerificationCommandName;
  label: string;
  command: string;
  args: string[];
  scope: CodeModeVerificationEvidenceRecord["scope"];
}

export class CodeModeVerificationService {
  public constructor(private readonly options: CodeModeVerificationServiceOptions) {}

  public async verifyRun(
    run: CodeModeRunRecord,
    commandName: CodeModeVerificationCommandName,
    operatorId?: string,
  ): Promise<CodeModeRunVerificationResponse> {
    if (run.status !== "completed") {
      throw new ValidationError({ message: `Code Mode run ${run.runId} has not completed successfully.` });
    }
    if (!run.sessionId) {
      throw new ValidationError({ message: `Code Mode run ${run.runId} is not linked to a Chat workbench session.` });
    }

    const workbench = await this.options.getWorkbench(run.sessionId);
    if (workbench.worktreeStatus !== "ready") {
      throw new ValidationError({ message: "The linked Chat workbench is not ready for verification." });
    }
    const command = resolveVerificationCommand(commandName, workbench.packageManager ?? "pnpm");
    const before = await this.captureSubject(run);
    let commandResult: ChatSessionWorkbenchCommandRunResponse | undefined;
    let commandError: string | undefined;
    try {
      commandResult = await this.options.runWorkbenchCommand(run.sessionId, {
        command: command.command,
        args: command.args,
      });
    } catch (error) {
      commandError = error instanceof Error ? error.message : String(error);
    }
    const after = await this.captureSubject(run);
    const execution = readCommandExecution(commandResult?.run);
    const subjectStayedFresh = before.subject.subjectHash === after.subject.subjectHash;
    const commandPassed = execution.status === "passed" && execution.exitCode === 0;
    const verified = commandPassed && subjectStayedFresh && before.valid && after.valid;
    const reasons = [
      ...(commandError ? ["verification_command_error"] : []),
      ...(!commandPassed ? ["named_proof_failed"] : []),
      ...(!subjectStayedFresh ? ["subject_changed_during_proof"] : []),
      ...before.reasons,
      ...after.reasons,
    ];
    const createdAt = new Date().toISOString();
    const evidence = buildVerificationEvidence({
      run,
      operatorId,
      command,
      execution,
      commandError,
      subject: after.subject,
      status: verified ? "verified" : "verification_failed",
      reason: verified ? undefined : [...new Set(reasons)].join(", ") || "named_proof_failed",
      outputArtifactRefs: commandResult?.state.outputArtifactId ? [commandResult.state.outputArtifactId] : [],
      createdAt,
    });
    const recorded = await this.options.storage.codeModeRuns.recordVerificationEvidence(evidence);
    await this.options.publishRealtime(
      recorded.evidence.status === "verified"
        ? "code_mode_run_verification_passed"
        : "code_mode_run_verification_failed",
      "capabilities",
      {
        runId: run.runId,
        evidenceId: recorded.evidence.evidenceId,
        verificationStatus: recorded.evidence.status,
        commandName: recorded.evidence.commandName,
        scope: recorded.evidence.scope,
        reason: recorded.evidence.reason,
      },
    );
    return recorded;
  }

  public async refreshRun(run: CodeModeRunRecord): Promise<CodeModeRunRecord> {
    if (run.status !== "completed" || run.verification?.status !== "verified") {
      return run;
    }
    const latestEvidence = (await this.options.storage.codeModeRuns.listVerificationEvidence(run.runId, 1))[0];
    const evidenceMatchesCurrentState = Boolean(
      latestEvidence &&
      latestEvidence.evidenceId === run.verification.evidenceId &&
      latestEvidence.status === "verified" &&
      latestEvidence.subject.subjectHash === run.verification.subjectHash,
    );
    const current = await this.captureSubject(run);
    if (evidenceMatchesCurrentState && current.valid && current.subject.subjectHash === run.verification.subjectHash) {
      return run;
    }
    const now = new Date().toISOString();
    const reason = !evidenceMatchesCurrentState
      ? "verification_evidence_missing_or_mismatched"
      : current.valid
        ? "verification_subject_drift"
        : current.reasons.join(", ") || "verification_subject_drift";
    const evidence: CodeModeVerificationEvidenceRecord = {
      evidenceId: `code-mode-proof-${randomUUID()}`,
      runId: run.runId,
      status: "stale",
      reason,
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      turnId: run.turnId,
      commandName: "passive_freshness_check",
      commandLabel: "Passive Code Mode proof freshness check",
      command: "passive_freshness_check",
      args: [],
      scope: "worktree",
      commandStatus: "not_run",
      startedAt: now,
      finishedAt: now,
      stdoutTruncated: false,
      stderrTruncated: false,
      outputArtifactRefs: [],
      subject: current.subject,
      createdAt: now,
    };
    const recorded = await this.options.storage.codeModeRuns.recordVerificationEvidence(evidence);
    await this.options.publishRealtime("code_mode_run_verification_stale", "capabilities", {
      runId: run.runId,
      evidenceId: evidence.evidenceId,
      verificationStatus: "stale",
      reason,
    });
    return recorded.run;
  }

  public async listEvidence(runId: string, limit = 50): Promise<CodeModeVerificationEvidenceRecord[]> {
    return this.options.storage.codeModeRuns.listVerificationEvidence(runId, limit);
  }

  private async captureSubject(run: CodeModeRunRecord): Promise<VerificationSubjectCapture> {
    const artifacts = captureManagedArtifacts(this.options.rootDir, this.options.artifactRoot, run);
    const worktree = await captureWorktree(
      this.options.storage,
      run,
      normalizeGitCaptureTimeout(this.options.gitCaptureTimeoutMs),
    );
    const subjectWithoutHash = {
      runId: run.runId,
      workspaceId: run.workspaceId ?? null,
      sessionId: run.sessionId ?? null,
      turnId: run.turnId ?? null,
      codeModeInputHash: run.codeModeInputHash,
      codeHash: run.codeHash,
      wrapperManifestHash: run.wrapperManifestHash,
      policySnapshotHash: run.policySnapshotHash,
      worktreeIdentityHash: worktree.identityHash,
      worktreeStateHash: worktree.stateHash,
      worktreeBaseRef: worktree.baseRef ?? null,
      worktreeHeadHash: worktree.headHash ?? null,
      changedFiles: worktree.changedFiles,
      changedFilesTruncated: worktree.changedFilesTruncated,
      artifacts: artifacts.items,
    };
    const subject: CodeModeVerificationSubjectBinding = {
      subjectHash: sha256(JSON.stringify(subjectWithoutHash)),
      codeModeInputHash: run.codeModeInputHash,
      codeHash: run.codeHash,
      wrapperManifestHash: run.wrapperManifestHash,
      policySnapshotHash: run.policySnapshotHash,
      worktreeIdentityHash: worktree.identityHash,
      worktreeStateHash: worktree.stateHash,
      worktreeBaseRef: worktree.baseRef,
      worktreeHeadHash: worktree.headHash,
      changedFiles: worktree.changedFiles,
      changedFilesTruncated: worktree.changedFilesTruncated,
      artifacts: artifacts.items,
    };
    return {
      subject,
      valid: artifacts.valid && worktree.valid,
      reasons: [...artifacts.reasons, ...worktree.reasons],
    };
  }
}

function resolveVerificationCommand(
  commandName: CodeModeVerificationCommandName,
  packageManager: NonNullable<ChatSessionWorkbenchRecord["packageManager"]>,
): VerificationCommandSpec {
  if (commandName === "git_diff_check") {
    return {
      commandName,
      label: "git diff --check",
      command: "git",
      args: ["diff", "--check"],
      scope: "worktree",
    };
  }
  return {
    commandName,
    label: `${packageManager} run ${commandName}`,
    command: packageManager,
    args: ["run", commandName],
    scope: "targeted",
  };
}

function readCommandExecution(run: AgenticCommandRunRecord | undefined): {
  commandRunId?: string;
  status: CodeModeVerificationEvidenceRecord["commandStatus"];
  exitCode?: number;
  startedAt: string;
  finishedAt: string;
  durationMs?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
} {
  const now = new Date().toISOString();
  if (!run) {
    return {
      status: "failed",
      startedAt: now,
      finishedAt: now,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
  const extended = run as AgenticCommandRunRecord & {
    durationMs?: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  };
  return {
    commandRunId: run.commandRunId,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    finishedAt: run.completedAt ?? now,
    durationMs: extended.durationMs,
    stdoutPreview: redactPreview(run.stdoutPreview),
    stderrPreview: redactPreview(run.stderrPreview),
    stdoutTruncated: (extended.stdoutTruncated ?? false) || (run.stdoutPreview?.length ?? 0) > MAX_OUTPUT_PREVIEW_CHARS,
    stderrTruncated: (extended.stderrTruncated ?? false) || (run.stderrPreview?.length ?? 0) > MAX_OUTPUT_PREVIEW_CHARS,
  };
}

function buildVerificationEvidence(input: {
  run: CodeModeRunRecord;
  operatorId?: string;
  command: VerificationCommandSpec;
  execution: ReturnType<typeof readCommandExecution>;
  commandError?: string;
  subject: CodeModeVerificationSubjectBinding;
  status: CodeModeVerificationEvidenceRecord["status"];
  reason?: string;
  outputArtifactRefs: string[];
  createdAt: string;
}): CodeModeVerificationEvidenceRecord {
  return {
    evidenceId: `code-mode-proof-${randomUUID()}`,
    runId: input.run.runId,
    status: input.status,
    reason: input.reason,
    workspaceId: input.run.workspaceId,
    sessionId: input.run.sessionId,
    turnId: input.run.turnId,
    operatorId: input.operatorId,
    commandName: input.command.commandName,
    commandLabel: input.command.label,
    command: input.command.command,
    args: [...input.command.args],
    scope: input.command.scope,
    commandRunId: input.execution.commandRunId,
    commandStatus: input.execution.status,
    exitCode: input.execution.exitCode,
    startedAt: input.execution.startedAt,
    finishedAt: input.execution.finishedAt,
    durationMs: input.execution.durationMs,
    stdoutPreview: input.execution.stdoutPreview,
    stderrPreview: input.commandError ? redactPreview(input.commandError) : input.execution.stderrPreview,
    stdoutTruncated: input.execution.stdoutTruncated,
    stderrTruncated: input.execution.stderrTruncated || (input.commandError?.length ?? 0) > MAX_OUTPUT_PREVIEW_CHARS,
    outputArtifactRefs: input.outputArtifactRefs,
    subject: input.subject,
    createdAt: input.createdAt,
  };
}

function captureManagedArtifacts(
  rootDir: string,
  artifactRoot: string,
  run: CodeModeRunRecord,
): { items: CodeModeVerificationArtifactBinding[]; valid: boolean; reasons: string[] } {
  const sources: Array<{
    kind: CodeModeTrustedCodeWriteVerificationArtifactKind;
    artifact: CapabilityArtifactRecord;
    expectedSha256: string;
  }> = [
    { kind: "source", artifact: run.codeArtifact, expectedSha256: run.codeHash },
    {
      kind: "wrapper_manifest",
      artifact: run.wrapperManifestArtifact,
      expectedSha256: run.wrapperManifestArtifact.sha256,
    },
    {
      kind: "policy_snapshot",
      artifact: run.policySnapshotArtifact,
      expectedSha256: run.policySnapshotArtifact.sha256,
    },
    ...(run.stdoutArtifact
      ? [{ kind: "stdout" as const, artifact: run.stdoutArtifact, expectedSha256: run.stdoutArtifact.sha256 }]
      : []),
    ...(run.stderrArtifact
      ? [{ kind: "stderr" as const, artifact: run.stderrArtifact, expectedSha256: run.stderrArtifact.sha256 }]
      : []),
  ];
  const reasons: string[] = [];
  const items = sources.map(({ kind, artifact, expectedSha256 }) => {
    const targetPath = path.resolve(rootDir, artifact.relPath);
    let actualSha256: string;
    let verified = false;
    try {
      assertPathInside(targetPath, artifactRoot);
      const content = readContainedRegularFile(targetPath, artifactRoot, MAX_MANAGED_ARTIFACT_BYTES);
      actualSha256 = sha256(content);
      verified = actualSha256 === expectedSha256 && actualSha256 === artifact.sha256;
    } catch (error) {
      reasons.push(`artifact_${kind}_unavailable`);
      actualSha256 = `unavailable:${sha256(error instanceof Error ? error.message : String(error))}`;
    }
    if (!verified && !reasons.includes(`artifact_${kind}_unavailable`)) {
      reasons.push(`artifact_${kind}_drift`);
    }
    return {
      artifactKind: kind,
      artifactId: artifact.artifactId,
      relPath: artifact.relPath,
      expectedSha256,
      actualSha256,
      verified,
    };
  });
  return { items, valid: items.every((item) => item.verified), reasons };
}

function normalizeGitCaptureTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 120_000)
    : CODE_MODE_GIT_CAPTURE_TIMEOUT_MS;
}

function redactPreview(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return redactStructuredSecrets(value).value.slice(0, MAX_OUTPUT_PREVIEW_CHARS);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
