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
  const directRunMatchesCommit = !targetCommit || directRun.head_sha === targetCommit;
  // A direct lane run only counts when it is bound to THIS commit. If the lane's own
  // workflow is missing/unavailable OR last concluded on a different (stale) SHA — common
  // for path-filtered lanes that did not run on the release commit — defer to the exact-SHA
  // release-proof umbrella run so a green-but-stale lane cannot silently satisfy the gate.
  const useReleaseProof =
    spec.releaseProofCovered === true &&
    releaseProofRun.status === "success" &&
    releaseProofMatchesCommit &&
    (isUnavailableOrMissingWorkflowStatus(directRun.status) || !directRunMatchesCommit);
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
