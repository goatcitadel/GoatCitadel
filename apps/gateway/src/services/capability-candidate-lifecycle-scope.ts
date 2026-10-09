import {
  ConflictError,
  SemanticValidationError,
  type CandidateSkillDetailRecord,
  type CandidateSkillVersionRecord,
  type CodeModeRunRecord,
} from "@goatcitadel/contracts";

/** Resolve lifecycle scope from the selected immutable version and its actual origin. */
export async function resolveCandidateLifecycleWorkspace(
  detail: CandidateSkillDetailRecord,
  selected: CandidateSkillVersionRecord | undefined,
  readRun: (runId: string) => Promise<CodeModeRunRecord>,
): Promise<string> {
  if (!selected || selected.candidateId !== detail.candidateId
    || !detail.versions.some(version => version.versionId === selected.versionId && version.candidateId === detail.candidateId)) {
    throw new ConflictError({ message: "The selected immutable version does not belong to this capability candidate." });
  }
  // The detail's origin describes the active/latest version. A rollback or
  // explicit revoke can select an older version with a different recorded run.
  const run = selected.originatingRunId
    ? detail.originatingRun?.runId === selected.originatingRunId
      ? detail.originatingRun
      : await readRun(selected.originatingRunId)
    : undefined;
  if (selected.originatingRunId && (!run || run.runId !== selected.originatingRunId)) {
    throw new ConflictError({ message: "The selected capability version's originating Code Mode run is unavailable or changed." });
  }
  if (selected.workspaceId && run?.workspaceId && selected.workspaceId !== run.workspaceId) {
    throw new ConflictError({ message: "The selected capability version and its originating Code Mode run belong to different workspaces." });
  }
  // Older versions can retain scope only on their exact canonical Code run.
  // Workflow captures need no Code run: their immutable version owns the scope.
  const workspaceId = selected.workspaceId ?? run?.workspaceId;
  if (!workspaceId?.trim()) {
    throw new SemanticValidationError("The selected capability version has no recorded workspace. Capture or generate a new version in the intended workspace.");
  }
  return workspaceId;
}
