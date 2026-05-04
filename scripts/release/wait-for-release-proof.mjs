#!/usr/bin/env node
const args = parseArgs(process.argv.slice(2));
const repository = args.repository ?? process.env.GITHUB_REPOSITORY;
const commit = args.commit ?? process.env.GITHUB_SHA;
const workflowFile = args.workflow ?? "verification-1-0-release-proof.yml";
const timeoutMs = Number(args.timeoutMs ?? 2 * 60 * 60 * 1000);
const intervalMs = Number(args.intervalMs ?? 60 * 1000);
const token = process.env.GITHUB_TOKEN;

if (!repository) {
  throw new Error("Missing repository. Pass --repository or set GITHUB_REPOSITORY.");
}
if (!commit) {
  throw new Error("Missing commit. Pass --commit or set GITHUB_SHA.");
}
if (!token) {
  throw new Error("Missing GITHUB_TOKEN; cannot inspect release proof workflow status.");
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("--timeout-ms must be a positive number.");
}
if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  throw new Error("--interval-ms must be a positive number.");
}

const startedAt = Date.now();
let lastStatus = "missing";

while (Date.now() - startedAt <= timeoutMs) {
  const run = await fetchLatestWorkflowRun({ repository, commit, workflowFile });
  if (!run) {
    lastStatus = "missing";
    console.log(`Release proof workflow ${workflowFile} is not visible for ${commit} yet; waiting...`);
    await sleep(intervalMs);
    continue;
  }

  lastStatus = run.conclusion ?? run.status ?? "unknown";
  if (run.status === "completed" && run.conclusion === "success") {
    console.log(`Release proof workflow is green for ${commit}: ${run.html_url}`);
    process.exit(0);
  }

  if (
    run.status === "completed" &&
    ["failure", "cancelled", "timed_out", "action_required", "skipped"].includes(run.conclusion)
  ) {
    throw new Error(`Release proof workflow finished with ${run.conclusion} for ${commit}: ${run.html_url}`);
  }

  console.log(`Release proof workflow is ${lastStatus} for ${commit}: ${run.html_url ?? "no run URL yet"}`);
  await sleep(intervalMs);
}

throw new Error(
  `Timed out waiting ${timeoutMs}ms for ${workflowFile} to succeed for ${commit}. Last observed status: ${lastStatus}.`,
);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repository") {
      parsed.repository = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--commit") {
      parsed.commit = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--workflow") {
      parsed.workflow = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--timeout-ms") {
      parsed.timeoutMs = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--interval-ms") {
      parsed.intervalMs = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

async function fetchLatestWorkflowRun({ repository, commit, workflowFile }) {
  const encodedWorkflow = encodeURIComponent(workflowFile);
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${encodedWorkflow}/runs?head_sha=${commit}&per_page=10`;
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub workflow lookup failed (${response.status}) for ${workflowFile}.`);
  }
  const payload = await response.json();
  return payload.workflow_runs?.[0] ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
