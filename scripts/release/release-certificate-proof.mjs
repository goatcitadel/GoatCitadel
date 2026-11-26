const RELEASE_COMMIT_EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);

export function matchesHostileSandboxProofRun(proof, { commit, repository, proofRun }) {
  return Boolean(
    commit &&
    repository &&
    proofRun?.workflowRunId &&
    Number.isSafeInteger(proofRun.workflowRunAttempt) &&
    proofRun.workflowRunAttempt > 0 &&
    proofRun.headSha === commit &&
    proof?.githubRun?.commit === commit &&
    proof.githubRun.repository === repository &&
    proof.githubRun.runId === String(proofRun.workflowRunId) &&
    proof.githubRun.attempt === String(proofRun.workflowRunAttempt),
  );
}

export function selectReleaseCommitRun(runs, targetCommit) {
  if (!targetCommit || !Array.isArray(runs)) return null;
  // Pull-request run metadata can name the head SHA while checkout tested a synthetic merge commit.
  return runs.find((run) => run?.head_sha === targetCommit && RELEASE_COMMIT_EVENTS.has(run.event)) ?? null;
}

export async function fetchReleaseCommitRun(url, { commit, token, fetchImpl = fetch }) {
  const pageUrl = new URL(url);
  for (let page = 1; ; page += 1) {
    // Keep credentials and the exact-SHA query on the configured endpoint.
    pageUrl.searchParams.set("page", String(page));
    const response = await fetchImpl(pageUrl, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: `github-api-${response.status}`, run: null };
    }
    const payload = await response.json();
    const run = selectReleaseCommitRun(payload.workflow_runs, commit);
    if (run) {
      return { status: run.conclusion ?? run.status ?? "unknown", run };
    }
    const links = response.headers.get("link") ?? "";
    if (!/(?:^|,)\s*<[^>]+>\s*;\s*rel="next"(?:\s*[,;]|\s*$)/u.test(links)) {
      return { status: "missing", run: null };
    }
  }
}

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
    workflowRunAttempt: run.run_attempt ?? null,
    headSha: run.head_sha,
  };
}

export async function resolveRequiredLaneProofs({ specs, releaseProofWorkflowFile, targetCommit, readWorkflowRun }) {
  const workflowFiles = new Set([releaseProofWorkflowFile, ...specs.map((spec) => spec.workflowFile)]);
  const runs = new Map(
    await Promise.all([...workflowFiles].map(async (file) => [file, await readWorkflowRun(file)])),
  );
  const checkedAt = new Date().toISOString();
  return specs.map((spec) => ({
    ...resolveLaneProof({
      spec,
      directRun: runs.get(spec.workflowFile),
      releaseProofRun: runs.get(releaseProofWorkflowFile),
      releaseProofWorkflowFile,
      targetCommit,
    }),
    checkedAt,
  }));
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
