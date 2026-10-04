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
| SY-02 fresh-install re-test | Pending: operator | | Needs a fresh `pnpm testbench` sandbox (check 3). |
| Large data (1,000 records) | Pending: CI after merge, once the proof is count-aware | | The count override landed. The long-lists proof still asserts 105 records in places, so another count fails on harness assumptions (check 4). |
| Cross-browser smoke (Firefox, WebKit) | Pending: operator, after approving the engine download | | The script and its unit tests landed. A run needs a running testbench and the two engines (check 5). |
| Real browsers (Firefox, Safari) | Pending: operator | | Safari needs a Mac; without one it is Blocked (check 6). |
| Screen readers | Pending: operator | | NVDA, Narrator and VoiceOver. VoiceOver needs a Mac (check 7). |
| Real models (operator) | Pending: operator | | Includes the PERF-01 re-test. The plan's flag step does not work with the launcher (check 8). |
| Packaged app and macOS input (operator) | Pending: operator | | Replaces the installed app, so the operator picks the time (check 9). |
| Gateway outage and recovery | Pending: operator | | The launcher cannot test in-place recovery (check 10). |
| Long session | Pending: operator | | Four hours, in its own sandbox (check 11). |
| First-answer baseline | Pending: operator | | A stub run, then a real-provider run in a second sandbox (check 12). |

Status values: Not run, Pending (queued, with who runs it), Passed, Failed (findings filed), Blocked (reason in Notes).
The numbers in the Notes column point to the check details below.

## New findings

| ID | Severity | Owner | Title | Evidence |
|---|---|---|---|---|

None yet: none of the manual checks has run. New findings take the next free number in their area (CH-54, IN-12,
WK-14, LB-06, SY-11, ST-32, FR-07, NV-26 and GL-66 onwards) and record "Source: V". The owner is the workstream that
owns the area, by the program spec's ownership rules (§7.4 and Appendix A).

## Withdrawn or closed review findings

| ID | Outcome | Evidence |
|---|---|---|

None yet. SY-02 is decided by check 3.

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
  Playwright install command, freshness boundary, review command and redaction step match
  `verification-1-0-release-proof.yml` as it is now. Step names aside, the only difference is that the review lane is
  written out as `ux-budgets` where the matrix job takes it from the matrix row. As there, the upload runs only after
  the redaction check passed.
- **First run, after merge:** `gh workflow run verification-ux-budgets-nightly.yml --ref main`, then
  `gh run list --workflow verification-ux-budgets-nightly.yml --limit 1`. A workflow dispatched from a branch works
  only once the file exists on the default branch.
- **Promotion rule (unchanged):** after 14 consecutive green nights, add `- laneScript: verify:ux:budgets`,
  `artifactSlug: ux-budgets` and `runner: ubuntu-latest` to the release-proof matrix in a later PR.
- **Large-data runs:** the optional `long_list_count` dispatch input is covered in check 4.

### 3. SY-02 fresh-install re-test (plan Task 4)

- **Status:** Pending. The operator runs it.
- **Question:** the review reported a stale-backup warning (SY-02), but its harness read the operator's real backups
  before `9e8edc056`. On a fresh install the backup folder is empty, and the Gateway's backup-trust projection
  (`apps/gateway/src/services/inbox-projection-model.ts`) then returns state `not_enabled` and no items. It raises
  `backup_trust:stale` only for a verified backup older than 24 hours or with no valid creation time, and
  `backup_trust:failed` for a backup that failed verification.
- **Existing unit evidence:** `apps/gateway/src/services/inbox-projection-service.test.ts` asserts `not_enabled` when
  there are no backups.
- **Setup:** the launcher points `GOATCITADEL_BACKUP_DIR` at an empty `backups` folder inside the sandbox root.

Steps:

1. Start a fresh sandbox with `pnpm testbench`. It prints the cockpit origin (`Test bench:`) and `Sandbox gateway:`.
2. In a second terminal, replace `<gateway>` with the printed Gateway URL:

   ```powershell
   $inbox = Invoke-RestMethod "<gateway>/api/v1/inbox?workspaceId=default"
   $inbox.items | Where-Object { $_.id -like "backup_trust:*" } | Select-Object id, title
   ```

   Expected: no output. The plan says to retry a 401 with a bearer token printed by the launcher. The launcher prints
   no token, and the sandbox Gateway runs with auth `none`, so a 401 would itself be worth reporting.
3. Open the cockpit. Check System > Health and the Inbox for anything that says a backup is stale. Expected: no stale
   warning, and a "no backup yet" state.
4. Record the outcome:
   - If nothing is stale, add `SY-02 | Not reproducible: the review harness read the operator's real backups before
     9e8edc056 | <evidence>` to "Withdrawn or closed review findings".
   - If a stale warning appears, keep SY-02 open with screenshots and the projection output, and mark it for W1.

### 4. Large data, 1,000 records (plan Task 5)

- **Status:** Pending. The count override landed. The run itself happens on GitHub after merge, and it needs the proof
  changes below first.
- **Who:** CI, by dispatching the nightly workflow with `long_list_count`. It is not run locally: seeding 1,000 records
  per list and running the proof is heavy.
- **What landed:** `readLongListCount` and the `GOATCITADEL_VERIFY_LONG_LIST_COUNT` override in
  `scripts/verification/lib/scenarios/cockpit-long-list-fixture.mjs`, with unit tests. It returns 105 when the variable
  is unset or empty, and accepts integers from 101 to 2000 (the proof needs more than 100 records). The nightly never
  sets it, so the lane keeps 105 records and its timings stay comparable.
- **Expected, once the proof can take other counts:** `Status: passed`. The proof checks Inbox, Work, Work > History,
  System > Quality and Chat, each with fewer than 100 rows rendered.
- **Messages:** the fixture does not seed long message threads. Only one conversation carries messages. For the "10,000
  messages" goal, W8's streaming work (CH-32, CH-50) re-measures long threads.

Command, after merge:

```powershell
gh workflow run verification-ux-budgets-nightly.yml --ref main -f long_list_count=1000
```

The plan's local equivalent is `$env:GOATCITADEL_VERIFY_LONG_LIST_COUNT = "1000"` followed by
`node scripts/verification/cockpit-owner-controls-proof.mjs long-lists`.

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

### 6. Real browsers by hand, Firefox and Safari (plan Task 7)

- **Status:** Pending. The operator runs it.
- **Setup:** `pnpm testbench` running, and one pending approval (see "Before you start" in the operator checklist).
  Safari needs a Mac that can reach a cockpit URL. If no Mac is available, record Safari as Blocked.

Run these journeys in each browser at 1440 × 900 and again at 390 px wide (responsive mode):

1. Send a message, using both Enter and the Send button. Use Shift+Enter for a new line. Expected: one message each
   time, and the stub reply appears.
2. On Safari with a Japanese input method: type `nihongo`, press Enter to confirm the conversion, then press Enter
   again. Expected: the first Enter only confirms the text (CH-12); the second sends.
3. Open Inbox, open an approval, choose **Review approval**, then cancel. Expected: the dialog shows the action, and
   Cancel leaves the approval waiting.
4. Open and close the inspector from Chat with the keyboard only. Expected: focus moves into the inspector and returns
   when it closes.
5. Switch to the dark theme and reload. Expected: no light flash. Record the flash duration if one appears (NV-02).
6. Use Tab through the sidebar and one area. Expected: a visible focus indicator on every stop.

Record one row per browser and journey with the result. File new findings for browser-specific problems.

### 7. Screen readers (plan Task 8)

- **Status:** Pending. The operator runs it.
- **Setup:** `pnpm testbench` running, and one pending approval (see the operator checklist).
- **Pairs to cover:** NVDA with Firefox and with Chrome (Windows); Narrator with Edge (Windows); VoiceOver with Safari
  (macOS, if available; otherwise record it as Blocked).

Run these journeys with each pair:

1. **Move between areas** with the rail and with landmarks. Record what is announced on each route change (NV-05).
2. **Send a message and wait for the reply.** Record whether "responding", "finished", "stopped" or "failed" is
   announced, and whether old failures repeat when Chat is reopened (CH-17).
3. **Move through the Inbox list** with J and K, then open an item. Record whether focus stays visible and is announced
   (GL-04, IN-06).
4. **Approve a reviewed approval** through its dialog. Record the dialog's name and description, and whether focus
   returns after it closes.
5. **Open Settings, change a field, then press browser Back.** Record whether the unsaved-changes dialog is announced
   (GL-02, after H0 lands).

Record a table of pair, journey, what was announced, and problem. File new findings (usually for W4 or W7b).

### 8. Real models, operator-run, with the PERF-01 re-test (plan Task 9)

- **Status:** Pending. The operator runs it. Agents never enter provider credentials. The operator adds keys through
  Settings > Models in the sandbox, which keeps them out of real data. Record observations and numbers without any
  keys, prompts with personal content, or provider account details.

**Step 1, the thinking stream, needs a different method than the plan's.** The plan sets
`GOATCITADEL_FEATURE_CHAT_THINKING_STREAM_V1_ENABLED` in the shell before it starts the launcher. The launcher removes
every `GOATCITADEL_*` variable the shell exports before it starts the sandbox (`scripts/testbench-runtime.mjs`), so the
variable never reaches the sandbox Gateway. The flag is also a runtime setting, and no cockpit control for it exists in
the source. After the sandbox is up, set it through the Gateway. The body comes from the route's schema and the call
has not been run; the Gateway may answer with a change-plan receipt to confirm. Mutating requests need an
`Idempotency-Key` header:

```powershell
$settings = Invoke-RestMethod "<gateway>/api/v1/settings"
$body = @{ expectedRevision = $settings.revision; features = @{ chatThinkingStreamV1Enabled = $true } } | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Patch -Uri "<gateway>/api/v1/settings" -Headers @{ "Idempotency-Key" = [guid]::NewGuid().ToString() } -ContentType "application/json" -Body $body
```

Confirm in the settings response that `features.chatThinkingStreamV1Enabled` is true. If it cannot be set, record the
PERF-01 re-test as Blocked ("thinking stream flag not settable in the sandbox") and continue with journeys 1 and 3.

Step 2, three model journeys:

1. **Cloud model with tools.** Ask for a task that needs a tool (for example, list the files in the workspace). Record
   the approval card (CH-09: hashes, "+N more", expiry), the run card (CH-06), and which model answered (CH-29).
2. **Reasoning model with the thinking stream on.** Record a Chrome Performance profile while a long answer streams.
   Note frames slower than 50 ms, long tasks, and typing latency in the composer during the stream. With React
   DevTools "Highlight updates" on, note whether every visible message re-renders on each token (PERF-01, CH-32,
   CH-50). If frames regularly exceed 50 ms, file a finding for W8.
3. **Local llama.cpp model.** Configure it in Settings > Models > Local AI and chat once. Then leave two tabs idle for
   2 minutes, and count requests per tab in the Network panel. Expected: 6 or fewer per minute after H0 (GL-01). The
   launcher starts the sandbox with the managed llama.cpp runtime off (`GOATCITADEL_LLAMACPP_ENABLED=false` and
   autostart off). If turning it on in the sandbox does not take effect, record this journey as Blocked.

### 9. Packaged Windows app and macOS input methods, operator-run (plan Task 10)

- **Status:** Pending. The operator runs it. Installing a build replaces the installed app, so the operator decides
  when. Note the installed version first.

Step 1, get a build. Either download the latest `release-installers` workflow artifact (preferred: a local build is
heavy), or build locally in a clean worktree:

```powershell
pnpm package:windows-host --target windows-x64
pnpm package:bundle --target windows-x64
pnpm package:windows
```

Step 2, check the packaged app:

1. **Cold start in the dark theme.** Record any light flash (NV-02).
2. **Shortcuts:** Ctrl+K, Ctrl+1 to Ctrl+5, and Ctrl+B, in the composer and outside it (NV-07).
3. **Japanese input method in the Chat composer.** The Enter that confirms a conversion must not send (CH-12).
4. **Stop the Gateway from the tray or service controls.** Read the outage banner's hint text (NV-20).

On a Mac, with `pnpm package:macos` or the latest artifact, repeat check 3 with the macOS Japanese input method.

### 10. Gateway outage and recovery (plan Task 11, Steps 1 and 2)

- **Status:** Pending. The operator runs it, in its own sandbox: it stops the sandbox Gateway.
- **Setup:** `pnpm testbench` running. Open every area once so their code chunks are loaded.

Step 1, stop the sandbox Gateway. Use the port printed by the launcher (`Sandbox gateway:`), and confirm the command
line points at the sandbox runtime before stopping anything:

```powershell
$gatewayPid = (Get-NetTCPConnection -LocalPort <gateway port> -State Listen).OwningProcess
(Get-CimInstance Win32_Process -Filter "ProcessId = $gatewayPid").CommandLine
Stop-Process -Id $gatewayPid
```

Then record:

- the outage banner (NV-20);
- whether "Check again" gives feedback;
- the composer state;
- requests per minute in the Network panel while the Gateway is down (GL-63);
- whether an area opened for the first time now shows the chunk-failure fallback (GL-13, after H0).

Step 2, bring it back. Start `pnpm testbench` again and reload the page. Record whether the page recovers.

**What the launcher does (read from `scripts/testbench.mjs`):** it treats a Gateway exit as a failed stop and, about half
a second later, tears the whole sandbox down: the UI server stops and the runtime folder is deleted. A page that is
already open keeps its loaded code and shows the outage, but the chunk for an area not yet opened cannot load because
the UI server is gone too (the GL-13 case). A new `pnpm testbench` gets new ports and an empty runtime, so recovering
in place cannot be tested this way. Record that, and cite the Chat fault-recovery lane
(`scripts/verification/lib/scenarios/gateway-chat-fault-recovery-lane.mjs`) as the automated evidence.

### 11. Long session (plan Task 11, Steps 3 and 4)

- **Status:** Pending. The operator runs it, in a sandbox of its own (check 10 stops its sandbox).

Keep one Chat tab and one idle Inbox tab open for 4 hours. Every 30 minutes:

1. Send a message.
2. Record the JS heap size (Chrome: Performance monitor, "JS heap size").
3. Record requests in the last minute for each tab.
4. Record the number of rows in System > Activity.

Record the trend. File a finding if the heap or request rate grows steadily.

### 12. First-answer baseline (plan Task 12)

- **Status:** Pending. The operator runs it. Step 2 is operator-only because it adds a real provider key.
- **Setup:** a new `pnpm testbench`, so the sandbox is fresh.

Step 1, time a new user on the stub model:

1. Open `/settings/first-run?shell=cockpit`.
2. Start a timer.
3. Go through first run to a completed first reply, using the stub model the sandbox provides.
4. Count clicks and keystrokes. Note every point where you had to read help text, or where the next step wasn't
   obvious.

Step 2, repeat with a real provider. In another fresh sandbox, run the same journey, adding a real provider key
through first run. Record the time and clicks without the key.

**The launcher already completed onboarding** (it posts to `/api/v1/onboarding/complete` before it prints the URLs), so
the sandbox shows no "Finish setup and open Chat" button. The first-run page still has its three steps: model, safety
posture and a test message. Count the missing finish click as one extra click when W5 sets its target from these
baselines (spec §8.2).

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
     stream could surface as a failed request on the next route.
   - One engine failing to launch no longer discards the other engines' results, and the failure names the install
     command. The draft printed results only after every engine had finished.
   - Engine names are checked as own keys. The draft's `in` check accepted names such as `constructor`.
   - A missing `--ui` and an empty `--engines` list are refused. The draft could run no engines and still pass.
5. **The testbench launcher differs from what the plan assumes (Tasks 4, 9, 11 and 12).** Read from
   `scripts/testbench.mjs` and `scripts/testbench-runtime.mjs`:
   - The sandbox Gateway runs with auth `none`, and the launcher prints no token (check 3).
   - The launcher removes every `GOATCITADEL_*` variable the shell exports, so the thinking-stream variable never
     reaches the Gateway. The flag has to be set through the Gateway's settings route (check 8).
   - It starts the sandbox with the managed llama.cpp runtime off (check 8).
   - It treats a Gateway exit as a failed stop and tears the whole sandbox down, so recovering in place cannot be
     tested with it (check 10).
   - It completes onboarding before it prints the URLs, so the first-run walkthrough has no finish step (check 12).
   - The URL it prints is the test bench page (`/testbench.html?target=sandbox`). The cockpit is served from the same
     origin (check 5).
6. **The journeys need a pending approval, and the plan does not say how to get one (Tasks 7 and 8).** The sandbox
   starts with none, and its stub model answers in plain text. The operator checklist gives a Gateway call that
   creates an inert one.
7. **The manual and operator checks are queued, not run (Tasks 4 and 7 to 12).** This run only changes code and
   documentation, so each check is a Pending row with its steps above and a line in the operator checklist below.

## Operator checklist

Everything here needs the operator; CI cannot do it. The check numbers point to the details above.

### Before you start

- [ ] Approve the engine download for check 5. `pnpm exec playwright install firefox webkit` downloads the Firefox and
  WebKit builds for the repository's Playwright package. Nothing else in this program downloads anything.
- [ ] Start a sandbox whenever a check needs one: `pnpm testbench`. It prints a `Test bench:` URL (the cockpit is
  served from the same origin) and `Sandbox gateway:`. It runs with auth `none`, does not read your real config or
  keys, and deletes its runtime folder when you press Ctrl+C.
- [ ] Create one pending approval for checks 6 and 7 (the call below).

The approval call. Mutating requests need an `Idempotency-Key` header. The body comes from the approvals route schema
and the long-list fixture; the call has not been run:

```powershell
$body = '{"kind":"verification.display","riskLevel":"safe","payload":{"fixture":"v-check"},"preview":{"summary":"Check approval"},"linkage":{"workspaceId":"default"}}'
Invoke-RestMethod -Method Post -Uri "<gateway>/api/v1/approvals" -Headers @{ "Idempotency-Key" = [guid]::NewGuid().ToString() } -ContentType "application/json" -Body $body
```

### Journeys

- [ ] Cross-browser smoke (check 5): `node scripts/verification/cross-browser-smoke.mjs --ui "<Test bench URL>"`, then
  `--engines chromium` for any `FAIL`.
- [ ] Real browsers (check 6): Firefox and Safari at 1440 and 390 px. Send with Enter and the button, the
  Japanese-input Enter on Safari, Inbox approval review then cancel, the inspector by keyboard, a dark-theme reload
  (flash?), and Tab focus indicators.
- [ ] Screen readers (check 7): NVDA with Firefox and Chrome, Narrator with Edge, and VoiceOver with Safari (Blocked
  without a Mac). Route changes, send and reply announcements, Inbox J and K with focus, the approval dialog, and the
  unsaved-changes dialog after Back in Settings.
- [ ] Real models (check 8): a cloud model with tools; a reasoning model with the thinking stream on (set through the
  settings route, not the shell variable) and a Performance profile; a local llama.cpp model with two idle tabs for
  2 minutes.
- [ ] Packaged app and macOS input (check 9): prefer the latest `release-installers` artifact over a local build, and
  note the installed version first. Dark cold start, shortcuts, the Japanese-input Enter, the Gateway-stop banner, and
  the macOS input method on a Mac.

### Also yours

- [ ] SY-02 re-test in a fresh sandbox (check 3).
- [ ] Gateway outage (check 10) and the 4-hour long session (check 11), each in its own sandbox.
- [ ] First-answer baselines (check 12): a stub run, then a real-provider run in a second sandbox.

### CI after merge

- [ ] Dispatch the nightly once (checks 1 and 2): `gh workflow run verification-ux-budgets-nightly.yml --ref main`.
  Read the result as check 1 describes.
- [ ] The large-data dispatch (check 4) waits for the count-aware proof change.

### Hand-off

- Each new finding goes to the workstream that owns its area. Owners read this report at their start (spec §7.6
  step 2). A critical finding goes straight into a hotfix PR (spec §3 rule 6): raise it as soon as it is seen, not at
  the hand-off.
- The review tracker was not touched. SY-02 stays open until check 3 is recorded. Adding new findings to the review
  page needs the operator's approval, because it republishes the page.
