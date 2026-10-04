# Cockpit Verification Gaps Report

Workstream V of the Cockpit Teardown Remediation program
(`docs/superpowers/specs/2026-10-03-cockpit-teardown-remediation-design.md` §6.2).
The program spec and the V plan are not committed yet, so this report carries the procedures it needs.
Finding IDs (CH-, IN-, WK-, LB-, SY-, ST-, FR-, NV-, GL-) come from the Cockpit UX Teardown review of
2026-10-03, which is kept outside the repository.

- **Base commit:** `da158ef00` (`origin/main` when this report was started)
- **Launcher:** `pnpm testbench` (isolated sandbox runtime, deterministic stub model)

## Prerequisites

Both prerequisites are met on the base commit (plan Task 1, Step 1):

| Prerequisite | Check | Result |
|---|---|---|
| The UX-budgets repair has landed | `git log --oneline 9e8edc056..origin/main -- scripts/verification/lib/ux-budgets.mjs scripts/verification/lib/scenarios/ux-budget-routes.mjs` | `1f4c97663` "test(verification): repair stale ux-budgets and cockpit proofs". `git ls-remote origin fix/ux-budgets-proofs` prints nothing: the branch is gone from origin. |
| The testbench launcher exists | `git ls-tree --name-only origin/main scripts/testbench.mjs` | `scripts/testbench.mjs` (#279) |

## Summary

| Check | Status | New findings | Notes |
|---|---|---|---|
| UX-budgets lane on main | Pending: CI after merge | | Measured by the nightly workflow's first run, not locally (check 1). Before the repair the review measured 24 failures on `522f84708` and 27 after the cockpit follow-through, out of 118 scenarios. |
| Nightly CI wiring | Pending: CI after merge | | `verification-ux-budgets-nightly.yml` is in this PR and is not gating. Its first run happens after merge (check 2). |
| SY-02 fresh-install re-test | Not run | | |
| Large data (1,000 records) | Not run | | |
| Cross-browser smoke (Firefox, WebKit) | Not run | | |
| Real browsers (Firefox, Safari) | Not run | | |
| Screen readers | Not run | | |
| Real models (operator) | Not run | | |
| Packaged app and macOS input (operator) | Not run | | |
| Gateway outage and recovery | Not run | | |
| Long session | Not run | | |
| First-answer baseline | Not run | | |

Status values: Not run, Pending (queued, with who runs it), Passed, Failed (findings filed), Blocked (reason in Notes).
The numbers in the Notes column point to the check details below.

## New findings

| ID | Severity | Owner | Title | Evidence |
|---|---|---|---|---|

## Withdrawn or closed review findings

| ID | Outcome | Evidence |
|---|---|---|

## Check details

Each check below records the setup used, what was done, what was observed, and links to evidence
(screenshots or run artifacts under `artifacts/verification/`, which are not committed).

### 1. UX-budgets lane on main (plan Task 2)

- **Status:** Pending. CI runs it after merge.
- **Who:** CI, through the first run of the nightly workflow (check 2).
- **Why not locally:** a local `pnpm verify:ux:budgets` takes 30+ minutes of heavy load on the operator's PC. The
  workflow is not gating, so landing it before it is green is safe.
- **Baseline to compare with:** before the repair the review measured 24 failures on `522f84708` and 27 after the
  cockpit follow-through, out of 118 scenarios. The repair landed as `1f4c97663`.

Read the result (plan Step 2). Download the run's evidence into `artifacts/verification` (untracked; this replaces its
`latest-run.json`), then list what did not pass:

```powershell
gh run download <run id> -n verification-ux-budgets-nightly-artifacts -D artifacts/verification
node -e "const fs=require('fs');const p=require('path');const latest=JSON.parse(fs.readFileSync('artifacts/verification/latest-run.json','utf8'));const root=latest.artifactRoot||p.join('artifacts','verification',latest.runId);const m=JSON.parse(fs.readFileSync(p.join(root,'manifest.json'),'utf8'));console.log(root);console.log(JSON.stringify(m.counts||{}));for(const s of m.scenarios||[]){if(s.status!=='passed')console.log(s.status,s.id,JSON.stringify(s.error??s.failure??s.readyError??s.detail??'').slice(0,240));}"
```

The command prints the artifact root, the counts and one line per scenario that did not pass. Classify every failure
from its evidence under that root (plan Step 3):

- **Harness:** a stale selector, link or timing in the scenario script. The product behaves correctly. Fix it only if
  the repair missed it, in a separate small PR with a unit test in the scenario's `.test.mjs`.
- **Product:** the cockpit or Gateway behaves wrongly. File it as a new finding in this report.
- **Environment:** the machine, ports or a missing build. Re-run once. If it repeats, record the check as Blocked.

Record here: the pass and fail counts, and a table of scenario id, class and evidence.

### 2. Nightly CI wiring (plan Task 3)

- **Status:** Pending. The workflow is in this PR; CI produces its first run after merge.
- **What landed:** `.github/workflows/verification-ux-budgets-nightly.yml` runs `pnpm verify:ux:budgets` on
  `ubuntu-latest` every day at 08:00 UTC and on manual dispatch, with a 120-minute timeout, and keeps the evidence for
  14 days. It uses the stub model, so it needs no provider keys.
- **Not gating:** it is a separate workflow, not a release-proof matrix row. `release-installers.yml` waits for the
  whole release-proof workflow, so a red row there would block tagged releases.
- **Compared with the release-proof job (plan Step 2):** the pnpm version (10.31.0), Node version (22), build filter,
  Playwright install command, freshness boundary, review command and redaction step are identical to
  `verification-1-0-release-proof.yml` as it is now. As there, the upload runs only after the redaction check passed.
- **First run, after merge:** `gh workflow run verification-ux-budgets-nightly.yml --ref main`, then
  `gh run list --workflow verification-ux-budgets-nightly.yml --limit 1`. A workflow dispatched from a branch works
  only once the file exists on the default branch.
- **Promotion rule (unchanged):** after 14 consecutive green nights, add `- laneScript: verify:ux:budgets`,
  `artifactSlug: ux-budgets` and `runner: ubuntu-latest` to the release-proof matrix in a later PR.
- **Large-data runs:** the optional `long_list_count` dispatch input is covered in check 4.

## Deviations from the plan

1. **Check 1 is measured by CI, not locally (Tasks 2 and 3).** The plan runs the lane locally first and writes the
   workflow once the lane is green. A local run takes 30+ minutes of heavy load, so the workflow lands first and its
   first run after merge is the measurement. It is not gating, so landing it before it is green is safe. The promotion
   rule (14 green nights) is unchanged.
2. **The workflow differs from the plan's draft in three places (Task 3).**
   - It has the optional `long_list_count` input (check 4).
   - The freshness-boundary step, the redaction step id and the upload condition follow the release-proof job as it is
     now, where the draft differed. The draft uploaded evidence even when the redaction check failed.
   - The concurrency group includes the trigger, so a manual large-data run is not cancelled when the nightly starts,
     and a manual run does not cancel the nightly.
