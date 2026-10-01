import type {
  CapabilityCatalogSnapshotRecord,
  CodeModeRunArtifactKind,
  CodeModeRunComparisonRecord,
  CodeModeRunRecord,
  CodeModeVerificationCommandName,
  CodeModeVerificationEvidenceRecord,
  CodeModeVerificationStatus,
} from "@goatcitadel/contracts";
import { formatArtifactPath, formatRunTimestamp } from "./format";
import { EMPTY_CHANGED_FILES, type CodePanelType } from "./code-workbench-model";

export const CODE_MODE_ARTIFACT_KINDS: Array<{ kind: CodeModeRunArtifactKind; label: string }> = [
  { kind: "source", label: "Source" },
  { kind: "wrapper_manifest", label: "Wrapper" },
  { kind: "policy_snapshot", label: "Policy" },
  { kind: "stdout", label: "Stdout" },
  { kind: "stderr", label: "Stderr" },
  { kind: "aider_request", label: "Aider request" },
  { kind: "aider_invocation_plan", label: "Aider plan" },
  { kind: "aider_result_envelope", label: "Aider result" },
  { kind: "aider_patch", label: "Aider patch" },
  { kind: "aider_stdout", label: "Aider stdout" },
  { kind: "aider_stderr", label: "Aider stderr" },
];
export const CODE_MODE_VERIFICATION_COMMANDS: ReadonlyArray<{
  name: CodeModeVerificationCommandName;
  label: string;
}> = [
  { name: "git_diff_check", label: "Git diff whitespace check" },
  { name: "test", label: "Project test script" },
  { name: "typecheck", label: "Project typecheck script" },
  { name: "lint", label: "Project lint script" },
  { name: "build", label: "Project build script" },
  { name: "check", label: "Project check script" },
  { name: "verify", label: "Project verify script" },
  { name: "coverage", label: "Project coverage script" },
];

export interface CapabilitySnapshotProfileSummary {
  snapshotId: string;
  inspectableCount: number;
  callableCount: number;
  callableToolCount: number;
  callableSkillCount: number;
  inspectableOnlyCount: number;
  reviewWarningCount: number;
  createdAt: string;
}

export function summarizeCapabilitySnapshotProfile(
  snapshot: CapabilityCatalogSnapshotRecord | null | undefined,
): CapabilitySnapshotProfileSummary | null {
  if (!snapshot) {
    return null;
  }
  return {
    snapshotId: snapshot.snapshotId,
    inspectableCount: snapshot.inspectableEntries.length,
    callableCount: snapshot.callableEntries.length,
    callableToolCount: snapshot.callableEntries.filter((entry) => entry.kind === "tool").length,
    callableSkillCount: snapshot.callableEntries.filter((entry) => entry.kind === "skill").length,
    inspectableOnlyCount: snapshot.inspectableEntries.length - snapshot.callableEntries.length,
    reviewWarningCount: snapshot.inspectableEntries.filter((entry) => Boolean(entry.reviewWarning)).length,
    createdAt: snapshot.createdAt,
  };
}

export function effectiveCodeModeVerificationStatus(
  run: CodeModeRunRecord,
  evidence: CodeModeVerificationEvidenceRecord[],
): CodeModeVerificationStatus {
  const recordedStatus =
    run.verification?.status ?? (run.status === "completed" ? "completed_unverified" : "not_applicable");
  if (recordedStatus !== "verified") {
    return recordedStatus;
  }
  const currentEvidence = evidence.find((item) => item.evidenceId === run.verification?.evidenceId);
  return currentEvidence?.status === "verified" && currentEvidence.subject.subjectHash === run.verification?.subjectHash
    ? "verified"
    : "completed_unverified";
}

export function codeModeVerificationTone(
  status: CodeModeVerificationStatus,
): "success" | "warning" | "critical" | "muted" {
  if (status === "verified") {
    return "success";
  }
  if (status === "verification_failed") {
    return "critical";
  }
  if (status === "completed_unverified" || status === "stale") {
    return "warning";
  }
  return "muted";
}

export function codeModeVerificationCopy(
  status: CodeModeVerificationStatus,
  evidence: CodeModeVerificationEvidenceRecord | undefined,
): string {
  if (status === "verified" && evidence) {
    return `Fresh named proof passed: ${evidence.commandLabel} (${evidence.scope} scope). This claim is bound to the recorded run, artifacts, and worktree state.`;
  }
  if (status === "verification_failed") {
    return evidence?.reason
      ? `The latest named proof failed: ${evidence.reason}.`
      : "The latest named proof failed; execution output is still available for inspection.";
  }
  if (status === "stale") {
    return "A previously passing proof is stale because its recorded source, artifact, worktree, or evidence binding changed.";
  }
  if (status === "completed_unverified") {
    return "Execution completed, but no fresh durable named semantic proof is available for this exact state.";
  }
  return "Semantic verification is not applicable until execution completes successfully.";
}

export function codeModeArtifactIntegritySummary(run: CodeModeRunRecord): {
  label: string;
  detail: string;
  tone: "success" | "warning" | "critical";
} {
  const record = run.trustedCodeWriteVerification;
  if (!record?.artifacts.length) {
    return {
      label: "not recorded",
      detail: "Trusted Code artifact-integrity evidence is missing. This does not imply semantic verification.",
      tone: "warning",
    };
  }
  if (!record.artifacts.every((artifact) => artifact.verified)) {
    return {
      label: "mismatch",
      detail: "One or more managed artifact hashes did not match the Trusted Code write record.",
      tone: "critical",
    };
  }
  return {
    label: "hashes matched",
    detail: `Managed artifact hashes matched at ${formatRunTimestamp(record.verifiedAt)}. This is artifact integrity, not semantic verification or a hostile-code sandbox claim.`,
    tone: "success",
  };
}

export function isCodeModeArtifactAvailable(run: CodeModeRunRecord, artifactKind: CodeModeRunArtifactKind): boolean {
  if (artifactKind === "stdout") {
    return Boolean(run.stdoutArtifact);
  }
  if (artifactKind === "stderr") {
    return Boolean(run.stderrArtifact);
  }
  if (artifactKind.startsWith("aider_")) {
    return isAiderArtifactAvailable(run, artifactKind);
  }
  return true;
}

export function isAiderArtifactAvailable(run: CodeModeRunRecord, artifactKind: CodeModeRunArtifactKind): boolean {
  const adapter = readAiderAdapterResult(run);
  if (!adapter) {
    return false;
  }
  if (artifactKind === "aider_request") {
    return isRecord(adapter.requestArtifact);
  }
  if (artifactKind === "aider_invocation_plan") {
    return isRecord(adapter.invocationPlanArtifact);
  }
  if (artifactKind === "aider_result_envelope") {
    return isRecord(adapter.resultEnvelopeArtifact);
  }
  const envelope = isRecord(adapter.envelope) ? adapter.envelope : undefined;
  if (!envelope) {
    return false;
  }
  if (artifactKind === "aider_patch") {
    const patch = envelope.patchArtifact;
    return isRecord(patch) && isRecord(patch.artifact);
  }
  if (artifactKind === "aider_stdout") {
    return isRecord(envelope.stdoutArtifact);
  }
  if (artifactKind === "aider_stderr") {
    return isRecord(envelope.stderrArtifact);
  }
  return false;
}

export function readAiderAdapterResult(run: CodeModeRunRecord): Record<string, unknown> | undefined {
  const result = run.result;
  if (!isRecord(result)) {
    return undefined;
  }
  const adapter = result.aiderAdapter;
  return isRecord(adapter) ? adapter : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function formatCodeModeArtifactKind(artifactKind: CodeModeRunArtifactKind): string {
  return CODE_MODE_ARTIFACT_KINDS.find((item) => item.kind === artifactKind)?.label ?? artifactKind;
}

export function codeModeArtifactLanguage(run: CodeModeRunRecord, artifactKind: CodeModeRunArtifactKind): string {
  if (artifactKind === "source") {
    return run.language === "javascript" ? "javascript" : "typescript";
  }
  if (artifactKind === "wrapper_manifest" || artifactKind === "policy_snapshot") {
    return "json";
  }
  if (artifactKind === "aider_request") {
    return "markdown";
  }
  if (artifactKind === "aider_invocation_plan" || artifactKind === "aider_result_envelope") {
    return "json";
  }
  if (artifactKind === "aider_patch") {
    return "diff";
  }
  return "text";
}

export function codeModeComparisonRows(
  comparison: CodeModeRunComparisonRecord,
): Array<{ label: string; matched: boolean }> {
  return [
    { label: "Capability snapshot", matched: comparison.matches.capabilitySnapshot },
    { label: "Submitted source", matched: comparison.matches.source },
    { label: "Frozen input", matched: comparison.matches.input },
    { label: "Wrapper manifest", matched: comparison.matches.wrapperManifest },
    { label: "Policy snapshot", matched: comparison.matches.policySnapshot },
    { label: "Permission profile", matched: comparison.matches.permissionProfile },
    { label: "Local override", matched: comparison.matches.localOperatorOverride },
    { label: "Sandbox runner", matched: comparison.matches.sandboxRunner },
    { label: "Sandbox profile", matched: comparison.matches.sandboxProfile },
    { label: "Sandbox availability", matched: comparison.matches.sandboxAvailability },
  ];
}

export function summarizeValidationForReview(
  validationStatus: string | undefined,
  output: CodePanelType["props"]["output"],
  helperRunCount: number,
): {
  status: string;
  command: string;
  skipped: string;
  detail: string;
  tone: "good" | "warning" | "danger" | "muted";
} {
  const validation = output?.validation;
  const status = validation?.status ?? validationStatus ?? "idle";
  const command =
    validation?.commandLabel ??
    (helperRunCount > 0
      ? `${helperRunCount} Code Mode helper run${helperRunCount === 1 ? "" : "s"} recorded`
      : "No validation command recorded");
  const skipped =
    validation?.status === "skipped"
      ? (validation.reason ?? "Validation was skipped.")
      : validation
        ? "No skipped validation recorded."
        : "Tests skipped or not yet recorded in this workbench.";
  const duration = validation?.durationMs ? ` · ${Math.round(validation.durationMs / 100) / 10}s` : "";
  const validationChangedFiles = validation?.changedFiles ?? EMPTY_CHANGED_FILES;
  const detail = validationChangedFiles.length
    ? `${validationChangedFiles.length} changed file${validationChangedFiles.length === 1 ? "" : "s"} covered${duration}`
    : validation
      ? `No changed-file coverage recorded${duration}`
      : "Run validation from this workbench to attach concrete proof.";
  return {
    status,
    command,
    skipped,
    detail,
    tone: status === "passed" ? "good" : status === "failed" ? "danger" : status === "idle" ? "muted" : "warning",
  };
}

export function codeModeArtifactReviewRows(run: CodeModeRunRecord | null): Array<{ label: string; value: string }> {
  return [
    { label: "Source", value: formatArtifactPath(run?.codeArtifact) },
    { label: "Wrapper", value: formatArtifactPath(run?.wrapperManifestArtifact) },
    { label: "Policy", value: formatArtifactPath(run?.policySnapshotArtifact) },
    { label: "Stdout", value: formatArtifactPath(run?.stdoutArtifact) },
    { label: "Stderr", value: formatArtifactPath(run?.stderrArtifact) },
  ];
}
