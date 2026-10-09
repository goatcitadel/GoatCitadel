import type { CodeModeRunVerificationResponse } from "@goatcitadel/contracts";
import type { EngineeringLearningProposalInput } from "./engineering-learning-service.js";

/** The two owners a canonical-source proposal reads: Code Mode verification and the conversation's project. */
export interface EngineeringCanonicalSourceDependencies {
  readVerifiedSource?: (runId: string, workspaceId: string) => Promise<CodeModeRunVerificationResponse>;
  resolveProjectId?: (sessionId: string) => string | undefined | Promise<string | undefined>;
}

/**
 * Binds a public Engineering proposal to a canonical run and its current immutable verification evidence. Text may
 * be operator-authored; ownership, changed files and verification are server-authored. Returns the proposal input
 * the learning owner records, or throws when the source is not a current completed, verified run in this workspace.
 */
export async function resolveCanonicalEngineeringProposal(
  deps: EngineeringCanonicalSourceDependencies,
  input: EngineeringLearningProposalInput,
): Promise<EngineeringLearningProposalInput> {
  const { readVerifiedSource, resolveProjectId } = deps;
  if (!readVerifiedSource) throw new Error("Canonical Engineering source verification is unavailable.");
  const { run, evidence } = await readVerifiedSource(input.source.runId, input.workspaceId);
  if (
    run.runId !== input.source.runId ||
    run.workspaceId !== input.workspaceId ||
    run.status !== "completed" ||
    run.verification?.status !== "verified" ||
    run.verification.evidenceId !== evidence.evidenceId ||
    run.verification.subjectHash !== evidence.subject.subjectHash ||
    evidence.status !== "verified" ||
    evidence.runId !== run.runId ||
    evidence.workspaceId !== run.workspaceId ||
    evidence.sessionId !== run.sessionId ||
    evidence.turnId !== run.turnId ||
    evidence.subject.codeHash !== run.codeHash ||
    evidence.subject.codeModeInputHash !== run.codeModeInputHash ||
    evidence.subject.wrapperManifestHash !== run.wrapperManifestHash ||
    evidence.subject.policySnapshotHash !== run.policySnapshotHash ||
    evidence.subject.changedFilesTruncated ||
    !evidence.subject.changedFiles.length ||
    (input.source.sessionId && input.source.sessionId !== run.sessionId) ||
    (input.source.turnId && input.source.turnId !== run.turnId)
  ) {
    throw new Error("Engineering proposals require a current completed, verified source in this workspace.");
  }
  const projectId = run.sessionId ? await resolveProjectId?.(run.sessionId) : undefined;
  if (input.projectId && input.projectId !== projectId)
    throw new Error("Engineering source project does not match the canonical conversation.");
  return {
    ...input,
    projectId,
    source: {
      runId: run.runId,
      sessionId: run.sessionId,
      turnId: run.turnId,
      patchArtifactId: run.stdoutArtifact?.artifactId,
      commitSha: evidence.subject.worktreeHeadHash,
    },
    changedFiles: evidence.subject.changedFiles,
    verificationEvidence: [
      `code-mode-verification:${evidence.evidenceId}`,
      ...evidence.outputArtifactRefs.map((ref) => `artifact:${ref}`),
    ],
  };
}
