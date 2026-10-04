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
| Large data (1,000 records) | Pending: CI after merge, once the proof is count-aware | | The count override landed. The long-lists proof still asserts 105 records in places, so another count fails on harness assumptions (check 4). |
| Cross-browser smoke (Firefox, WebKit) | Pending: operator, after approving the engine download | | The script and its unit tests landed. A run needs a running testbench and the two engines (check 5). |
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

### 4. Large data, 1,000 records (plan Task 5)

- **Status:** Pending. The count override landed. The run itself happens on GitHub after merge, and it needs the proof
  changes below first.
- **Who:** CI, by dispatching the nightly workflow with `long_list_count`. It is not run locally: seeding 1,000 records
  per list and running the proof is heavy.
- **What landed:** `readLongListCount` and the `GOATCITADEL_VERIFY_LONG_LIST_COUNT` override in
  `scripts/verification/lib/scenarios/cockpit-long-list-fixture.mjs`, with unit tests. It returns 105 when the variable
  is unset or empty, and accepts integers from 101 to 2000 (the proof needs more than 100 records). The nightly never
  sets it, so the lane keeps 105 records and its timings stay comparable.
- **Command, after merge:**

```powershell
gh workflow run verification-ux-budgets-nightly.yml --ref main -f long_list_count=1000
```

  The plan's local equivalent is `$env:GOATCITADEL_VERIFY_LONG_LIST_COUNT = "1000"` followed by
  `node scripts/verification/cockpit-owner-controls-proof.mjs long-lists`.
- **Expected, once the proof can take other counts:** `Status: passed`. The proof checks Inbox, Work, Work > History,
  System > Quality and Chat, each with fewer than 100 rows rendered.
- **Messages:** the fixture does not seed long message threads. Only one conversation carries messages. For the "10,000
  messages" goal, W8's streaming work (CH-32, CH-50) re-measures long threads.

**Premise check: the proof is not count-agnostic yet.** The plan expects the override alone to make a 1,000-record run
pass. Reading `cockpit-long-lists-proof.mjs` and the fixture against the Gateway limits and the pages, a run at any
count other than 105 fails on harness assumptions, not on product behavior:

- **History:** the step clicks "Load older runs" once and waits for the literal text `105 saved runs loaded.`. The page
  loads 100 runs per page, so another count needs another text and more clicks.
- **Chat:** the step waits for `aria-setsize` and `aria-posinset` to equal the literal `105` (four places) after one
  "Load more" click, and bounds the status reads for that one click.
- **Quality:** the step requests `packLimit=200` and asserts at least `LONG_LIST_COUNT` packs. The page itself asks for
  `packLimit: 200` (`SystemQuality.tsx`), so above 200 records it shows at most 200 packs. Candidate finding to confirm
  when the proof can run: System > Quality stops at 200 stored prompt packs.
- **Owner reads:** `readLongListOwners` lists tasks, approvals and sessions with `limit=200`, and the fixture asserts
  the listing equals every seeded record. The Gateway allows at most 200 per page for tasks and approvals (cursor
  paging exists), so seeding above 200 records fails the fixture's own check.

Follow-up before the dispatch is useful: derive the proof's expectations from `LONG_LIST_COUNT` (paging loops for
History and Chat, cursor reads in `readLongListOwners`, a Quality expectation capped at the page's 200), and run it
once locally at the new count. Until then the `long_list_count` input is wired, but only 105 passes.

### 5. Cross-browser smoke, Firefox and WebKit (plan Task 6)

- **Status:** Pending. The script and its unit tests landed. A run needs the operator's approval to download the two
  engines.
- **Who:** the operator (or an agent they allow), against a running `pnpm testbench`.
- **What landed:** `scripts/verification/cross-browser-smoke.mjs`. For each engine it opens every cockpit area
  (`/chat`, `/inbox`, `/work`, `/library`, `/system/health` and `/settings/general`, each with `?shell=cockpit`) in a
  fresh page, waits for the cockpit ready marker, and reports page errors, console errors and failed requests, with one
  screenshot per area. It exits 1 when any area reports a problem. Every other repository lane uses only Chromium, so
  this is the first Firefox and WebKit coverage.
- **Approval needed first:** installing the engines downloads browser binaries for the Playwright package the
  repository already uses. Nothing in this PR downloads them.

Steps (plan Step 6), with `pnpm testbench` running:

```powershell
pnpm exec playwright install firefox webkit
node scripts/verification/cross-browser-smoke.mjs --ui "<URL printed by the launcher>"
```

The launcher prints `Test bench: <origin>/testbench.html?target=sandbox`. The script uses only the origin, and the
cockpit is served from the same origin, so the URL works as printed. If an engine is not installed, the script reports
`engine failed` with the install command and still reports the other engines.

Expected: one `ok` or `FAIL` line per engine and area, and a screenshots folder under
`artifacts/verification/cross-browser-smoke/`. File each `FAIL` that does not also happen in Chromium (check with
`--engines chromium`) as a new finding. Record the results here.

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
3. **The count override alone cannot make a 1,000-record run pass (Task 5).** The code landed as the plan specifies,
   but the plan assumed the long-lists proof only needs a larger count. It hard-codes 105 in the History and Chat steps
   and reads owner lists with a limit of 200 (check 4, "Premise check"). The proof has to become count-aware before the
   `long_list_count` dispatch can pass. This PR does not change the proof: exercising it needs the heavy lanes, and the
   edits depend on page behavior that has not been observed at other counts.
4. **The smoke script differs from the plan's draft in four places (Task 6).** The unit tests keep the draft's three
   tests and add checks for the guards below.
   - It opens a fresh page for each route. The draft reused one page, so the previous route's aborted live event
     stream could surface as a failed request on the next route in every engine.
   - One engine failing to launch no longer discards the other engines' results, and the failure names the install
     command. The draft printed results only after every engine had finished.
   - Engine names are checked as own keys. The draft's `in` check accepted names such as `constructor`.
   - A missing `--ui` and an empty `--engines` list are refused. The draft could run no engines and still pass.
