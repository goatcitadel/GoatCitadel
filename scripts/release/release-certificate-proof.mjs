export function isUnavailableOrMissingWorkflowStatus(status) {
  return status === "missing" || status === "unavailable" || String(status).startsWith("github-api");
}

export function summarizeWorkflowRun(run, workflowFile) {
  return {
    workflowFile,
    status: run.status,
    conclusion: run.conclusion,
    workflowRunUrl: run.html_url,
    workflowRunId: run.id,
    headSha: run.head_sha,
  };
}

export function resolveLaneProof({ spec, directRun, releaseProofRun, releaseProofWorkflowFile, targetCommit }) {
  const releaseProofMatchesCommit = !targetCommit || releaseProofRun.head_sha === targetCommit;
  const useReleaseProof =
    spec.releaseProofCovered === true &&
    isUnavailableOrMissingWorkflowStatus(directRun.status) &&
    releaseProofRun.status === "success" &&
    releaseProofMatchesCommit;
  const effectiveRun = useReleaseProof ? releaseProofRun : directRun;
  return {
    ...spec,
    status: effectiveRun.status,
    conclusion: effectiveRun.conclusion,
    workflowRunUrl: effectiveRun.html_url,
    workflowRunId: effectiveRun.id,
    proofWorkflowFile: useReleaseProof ? releaseProofWorkflowFile : spec.workflowFile,
    proofSource: useReleaseProof ? "release-proof" : "lane-workflow",
    substitutedByReleaseProof: useReleaseProof,
    directRun: summarizeWorkflowRun(directRun, spec.workflowFile),
    releaseProofRun: spec.releaseProofCovered ? summarizeWorkflowRun(releaseProofRun, releaseProofWorkflowFile) : null,
  };
}
