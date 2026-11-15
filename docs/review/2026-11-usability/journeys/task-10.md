# Task 10: System

Live runs: Playwright headless, 1440x900 dark (SY-1 and Runtime also at 375x812 light: no horizontal overflow, scrollWidth 375), sandbox testbench Gateway (auth mode `none`, stub model). Evidence: `docs/review/2026-11-usability/evidence/sy/`. New findings are listed per journey below by title (ids are assigned when the controller re-merges; the run-workspace finding was withdrawn in fix round 1, so the numbers shift by one after U-SY-007). Carried findings in System before this task: U-SY-001 to U-SY-006 (none duplicated).

Setup and cleanup notes:
- Every tab (Health, Runtime, Workers, Spend, Spend details, Quality, Diagnostics, Activity, Sessions, Dashboards, Browser sessions, Improvement) has one h1, loaded with no console error and no failed or 4xx request, and has no spinner left after 1.5 s. A full page load of each reached "network idle" only at the 8 s cap because the event stream stays open; content was on screen well before that.
- The default workspace holds 112 completed runs and no failed ones; the two cancelled chat turns, two waiting runs and the verification-workspace chat sessions belong to the verification workspace (`ws_f13a...`). One dead-lettered run is the seeded recovery fixture (no workspace), the source of the Inbox/Diagnostics "Dead letters without a readable scoped run were omitted" line.
- Backup directory: the testbench pins `GOATCITADEL_BACKUP_DIR` to `<runtime root>/backups` (`scripts/testbench-runtime.mjs:303`) and that folder existed inside the sandbox runtime root before I pressed the button; the new backup appeared there afterwards and nowhere else was written.
- Created and left: one backup (`backup-20261115083351-...`, 14.7 MB, in the sandbox backup folder), a board `ut10-board` (archived: the UI has no delete), a browser session record `ut10-session` (closed). Nothing else.
- Screenshots and JSON captures were scanned (page text of every System tab and the Work history page) for absolute paths and the Windows user name: none shown. No redaction was needed. One capture had a dev-server module path in a request list; replaced with `<dev-server module>`.

## SY-1 Health: is anything wrong right now, and what to do about it
Result: PARTLY RUN
Findings: U-SY-002 (carried: the one attention item); see Notes on existing findings. No new finding.
Time: Health content on screen by the first 1.5 s check; each "Review ..." link landed in 1.9 s or less; Refresh not timed.
Code path: `cockpit/areas/system/HealthOverview.tsx` -> `system-health-sources.ts` (`fetchHealthSummary` = `GET /api/v1/observe/health`, plus `llamacpp/status`, `npu/status`, `integrations/connections`, `ops/workspaces/<id>/remote-workers`) -> `health-overview.ts` / `system-health.ts` (`deriveHealthChecks`) -> `apps/gateway/src/services/daemon-route-service.ts` (daemon status), `backup-retention-service.ts`.
Live:
1. Opened System: heading "1 check needs attention", nine cards. Fetched the same endpoints from the Gateway and compared line by line: `evidence/sy/sy-1-health-vs-gateway.json`. Every card agrees with the Gateway (database reachable, 0 backups, local runtime and NPU disabled, no connections, no workers). Desktop updates is browser-side (no Gateway read).
2. The one attention item, "Runtime service - Unavailable - Service control is unavailable on this host", is backed by the Gateway only in the sense that `supported` is `false`; the process is running (PID, uptime). Not a fault.
3. Followed every "Review ..." control to its end (ten of them). Runtime service, Backups, GoatCitadel server and Database land on System > Runtime; Backups carries `#ops-runtime-backups` and the section is at the top of the viewport (top 0). Managed local models opens Settings > Models; "Review local runtime start" opens a confirmation dialog in place; Channels opens Chat > Messaging > Advanced setup; Integrations opens Capabilities > Connectors > Advanced setup; Desktop updates opens Settings > General; Remote workers opens System > Runtime > Workers. All land somewhere relevant with no console error.
4. For the attention item the trail ends at Runtime: the card says "Unavailable" and a collapsed "Process manager and commands" disclosure tells the operator to use the program that runs the server, with two PowerShell lines. The operator reaches the thing and a next step exists, but it is not an action that clears the warning. After pressing Back up now (SY-5) the Backups card went to Verified and the heading stayed "1 check needs attention"; the shell's System tab shows "1 check needs review" on every page.
5. The sandbox's failed and cancelled runs and the pending approval do not appear in Health; Health covers only the nine infrastructure checks.
Failure tried: none provoked (the Gateway cannot be stopped); the retry and "Data stale" states are covered by existing unit tests, not live.
Evidence: sy-walk-health.png, sy-1-health-vs-gateway.json, sy-1-link-*.png (ten landing pages), sy-phone-light-health.png.
Not covered: a real attention item (a failed check on a source-run sandbox could not be provoked without stopping something); installed-build behaviour of the service check (settled from code: see Notes).

## SY-2 Runtime and Sessions: see what is running, stop something
Result: FAIL
Findings: the workspace-bound links finding (U-SY-009 as first numbered), the "Close session" label finding. Also carried: U-SY-001 (Workers).
Time: Sessions Details panel 158 ms; Refresh not timed.
Code path: `SystemRuntime.tsx` / `RuntimeServerSection.tsx` / `RuntimeOverview.tsx` -> `daemon/status`, `dashboard/state`, `admin/backups`, `llm/*`; `SystemSessions.tsx` -> `SelectedSessionSection.tsx` -> `chat/SessionControlManager.tsx` (external-controller handoff, not a stop control).
Live:
1. Runtime: server uptime, memory, server checks, Backups with Back up now, local model runtime (Not running), integrations, model performance (average 39 ms, recent calls, "Cost Unknown"), local engines, comparison runs ("No model comparison runs yet"). No control on the page stops anything: server start/stop is a collapsed instruction block for an outside program. Nothing was running (the Gateway lists no `running` run), so there was nothing to stop; stopping a run lives in Work, and Runtime does not link there.
2. Sessions: the list is conversations of every workspace (19 rows in both the default and the verification workspace); the two "Across all workspaces" counts ("1 pending approval", "1 active subagent", "100 recent events") match `dashboard/state`. Details opens a panel in 158 ms; keyboard (focus then Enter) opens it too.
3. In the default workspace the panel for a verification-workspace conversation says in red "This control state does not match the selected session and workspace. No control actions are available.", and "Open in Chat" lands on an empty Chat (workspace-bound links finding). In the verification workspace the same session shows "You control this conversation" and opens in Chat with ?sessionId.
4. "Close session" hides the panel only; the session stays ("Close session" label finding). Sessions here are chat conversations; there are no device or browser sessions on this tab (those are System > Browser sessions, SY-6).
Failure tried: opened a session that belongs to another workspace (step 3).
Evidence: sy-2-runtime.png, sy-2-runtime-process-manager.png, sy-2-session-details.png, sy-2-session-closed.png, sy-2-open-in-chat.png, sy-2-session-details-own-workspace.png, sy-2-open-in-chat-own-workspace.png, sy-phone-light-runtime.png.
Not covered: stopping a live run or service. Nothing was left running, and Gateway services, the llama runtime and the sandbox may not be stopped. Operator steps: start a long chat turn with a real model, open Work > Runs, use the run control there.

## SY-3 Spend: what did today cost, by model
Result: PARTLY RUN
Findings: none new (see Design decisions to confirm). Carried: the UTC bucket labelling is present and correct on screen.
Time: Spend content on screen by 1.2 s; Spend details window switches (1 day / 3 days / 7 days) 1.7 s each.
Code path: `SpendOverview.tsx` / `SpendDetails.tsx` / `SpendDailyChart.tsx` / `SpendObservedModels.tsx` / `spend-details-model.ts` -> `GET /api/v1/costs/summary`, `ops/workspaces/<id>/model-usage`, `llm/models`.
Live:
1. Spend: "Grouped by day (UTC) - Nov 8, 12:18 AM - Nov 15, 12:18 AM (local time)", "Known spend is a lower bound because 113 provider attempts have unknown cost", Known cost "Under $0.01 known (some costs unknown)", 2,078 tokens. The Gateway agrees: day 2026-11-15 costUsd 0.0026, tokens 2078, `costUsdComplete: false`, 1 known of 114 attempts. Stub calls read "Price unavailable", not $0.00: honest.
2. "Today" is the UTC bucket "Sun 15 Nov"; the six earlier days read "no usage recorded"; the page explains the UTC/local difference in words ("these aggregates cannot be rebucketed into local days"). 1 day and 3 days windows on the details page work and update the URL (?window=1).
3. By model: no per-model cost or token breakdown exists. The details page groups by provider and lists "Models observed: Unnamed model, Unnamed model" (stub models have no display names; raw ids are under Model IDs). The only per-model view is the list of the latest 50 calls ("verification-stub-chat", price unavailable) with Open conversation links.
Failure tried: none (no real model; zero-cost and unknown-cost states are what the stub produces, and both explained themselves).
Evidence: sy-3-spend.png, sy-3-details-1day.png, sy-3-details-3days.png, sy-3-details-7days.png, sy-3-spend-capture.json.
Not covered: real priced usage and a per-model total (no real model may be called). Operator steps: after a day with a real provider, check that the daily total equals the sum of the call rows.

## SY-4 Activity and Diagnostics: find out why a turn failed an hour ago
Result: FAIL (on a busy install an operator looking for a failure an hour old cannot reach it from Activity: the page holds only the newest 100 signals with no way back, and does not say older history is in Work > History)
Findings: "System > Activity cannot reach anything older than its newest 100 signals, and does not say where older history is" (friction; the cause of the FAIL), "System > Sessions and Activity list every conversation ... only work in the conversation's own workspace", "A cancelled run's reason reads Cancelled by auth:[REDACTED]". Also carried: U-SY-005, U-GL-020.
Time: Activity first rows by 1.2 s; Open source landing 2.6 s.
Code path: `SystemActivity.tsx` -> `fetchRealtimeEvents(100)` -> `GET /api/v1/events` ; `activity-sentences.ts`; Open source -> `/work/runs/<id>` (`WorkRunDetail.tsx`), `/inbox?approvalId=`, `/chat?sessionId=`; Diagnostics: `SystemDiagnostics.tsx`, `RuntimeAuthorityMap.tsx`.
Live:
1. The two real cases, picked by time and description: the cancelled chat turn "Chat turn - Cancelled - created 1 hour ago" (a Stop in Chat) and the waiting verification approval beside it. Activity lists 76 signals (100 with background signals); none says failed or cancelled, because no failure was inside the window (a failed or cancelled run inside it reads "Durable run failed" / "Durable run cancelled" with an Open source link, from code: activity-sentences.ts, durable-run-service.ts:3771, :3969), and nothing is about either case. 100 signals cover roughly 10 to 15 chat turns; in this seeded sandbox that was about 14 minutes (sandbox figure), so the hour-old turn was out of reach, and the page offers no pager, filter, search or pointer to Work > History (finding: Activity cannot reach anything older than its newest 100 signals). The rows are generic ("Durable run completed", "Tool invoked", "Chat completion") with no conversation title; no row says failed or cancelled.
2. Tried every distinct row kind's Open source: Durable run rows -> "Run workspace unknown" (a sandbox artifact, see Sandbox artifacts below; not recorded as a finding); approval rows -> Inbox with the approval; Evidence/session/conversation rows -> Chat (empty in the wrong workspace, finding on workspace-bound links).
3. Diagnostics: "0 known unresolved dead letters" and "0 warnings or errors in the latest 100 received entries" are consistent with the Gateway except the seeded dead letter (no workspace, omitted and said so); the runtime authority map lists 27 records, "6 need attention", with rows such as "Recorded run event - Contradictory - Critical" that describe themselves in system words. No failure from an hour ago is listed here either.
4. Route that worked: switch to the verification workspace, Work > History (36 runs, none loaded more needed), "Chat turn - Cancelled" row, Open run record: run page shows the reason ("Cancelled by auth" finding: "Cancelled by auth:[REDACTED]"), the recorded errors, a link "Open this conversation in Chat" and Open approval history. Count: 4 clicks plus knowing to change workspace; Activity does not say where older history is. "Open runtime health in System" on that page returns to Health, which ignores the run.
Failure tried: Open source on every row kind; the default workspace's Work > History has 112 completed runs, none failed, so the failed turn is invisible there as well.
Evidence: sy-4-activity.png, sy-4-activity-capture.json, sy-4-open-source.png, sy-4-open-source-by-row-kind.json, sy-4-open-source-own-workspace.json, sy-4-work-history.png, sy-4-cancelled-run.png, sy-4-cancelled-run-capture.json.
Not covered: "Export recent diagnostics" (a download needs the operator's permission). Operator steps: press it and read the file for the 100 entries and the personal-data warning.

## SY-5 Create a backup; find where it went
Result: PARTLY RUN
Findings: "After Back up now nothing on screen says where the backup was written".
Time: not timed to the millisecond (the first script ended early after the receipt). The review dialog was open and the receipt was on screen by the following 15 s and 90 s waits; neither duration was measured.
Code path: `HealthBackupAction.tsx` -> `health-backup-action.ts` (`readBackupReview`, `commitBackup` -> `createBackup`) -> `POST /api/v1/admin/backups/create` -> `backup-retention-service.ts`; Runtime backups list `GET /api/v1/admin/backups`.
Live:
1. Control exists today: Health > Backups > "Back up now" (also on Runtime). `git grep createBackup` in `apps/mission-control-next/src` finds the UI caller at `cockpit/areas/system/health-backup-action.ts:97` (the earlier "no UI calls it" finding is out of date). With no backup Health says "No backup yet ... Back up now creates a host-wide backup. Scheduling and offline restore remain separate operator workflows." and puts the button under it: clear.
2. Keyboard: focused the button, Enter opened "Review backup creation": what is included (database, transcripts, audit logs, config that may hold sensitive settings), "GoatCitadel chooses its configured backup directory" (no path), "This writes a new backup and consumes disk space. Existing records: 0. No online restore is offered." Confirm backup, then a receipt: "Backup created just now - 14.7 MB - 16 files", "Creation does not prove offline restore or installed-host readiness".
3. Health after reload: Backups "Verified - The latest backup passed exact-byte and restore-contract verification. A full restore is not proven here." The heading still says "1 check needs attention" (the service line). Runtime Backups: "just now - 16 files". The folder is shown only in the receipt's technical details (backup-location finding). The sandbox folder `<runtime root>/backups` held the new `backup-20261115083351-...` directory.
Failure tried: none (a failed backup was not provoked; the code shows an error callout and an "uncertain" lock with a Review backup records link).
Evidence: sy-5-dialog.png, sy-5-receipt.png, sy-5-runtime-backups.png, sy-5-health-after.png, sy-5-backup-capture.json.
Not covered: restore, read in code only. A live Gateway refuses restore with `offline_restore_required` (`apps/gateway/src/services/backup-paths.ts`); the operator-run path is `goatcitadel admin backup restore --file <backup-file> --confirm` after stopping the Gateway (`docs/INSTALL_SETUP_TESTING.md:544-549`, `docs/ENGINEERING_HANDBOOK.md:32`, Postgres: `pg_restore`, `docs/1_0_CONTRACT.md:136`). No screen links to that guide.

## SY-6 Browser sessions: open one, read its grants, close it
Result: PARTLY RUN
Findings: "Browser sessions with no sessions says No browser sessions match this filter". Also carried: U-GL-019 (raw actor ids; not duplicated).
Time: create 2.6 s watched window; close 2.6 s watched window.
Code path: `SystemBrowserSessions.tsx` -> `BrowserSessionDetail.tsx` / `BrowserSessionGrants.tsx` / `BrowserSessionStateView.tsx` -> `GET/POST /api/v1/browser-sessions`, `.../<id>/grants`.
Live:
1. No errand had run, so the list was empty: "No browser sessions match this filter" (empty-state finding). The page offers "New browser session" ("Creates an empty session record ... with no grants"), so I made `ut10-session`: confirmation line "Session ut10-session recorded. It has no grants yet.", and the detail opened by itself with ?sessionId in the URL.
2. Read it: Session and grants (Active grants 0, "A session record governs browser grants and events. It does not show that a browser is open, bound or active."), State ("No active grant: tools cannot use this session", saved browser state is volatile), Events (a "Session created" row with a raw requestId shown as text).
3. Closed it: "Review closing this session" explains "Closes this session and revokes its 0 active grants ... A closed session cannot be reopened or receive new grants"; "Close session and revoke grants" closed it; the record reads "Closed record ... Session closed ... No active grant remains."; the Active filter then listed none.
Failure tried: none.
Evidence: sy-6-empty.png, sy-6-created.png, sy-6-new-grant.png, sy-6-close-review.png, sy-6-closed.png, capture JSONs.
Not covered: a session created by an errand, and grants from a real actor (I did not create a grant: it needs an actor id, which would add to U-GL-019). Operator steps: run a browser errand in Chat, open Browser sessions, read its grants, close it.

## SY-7 Quality and Dashboards: open each tab; a tab with nothing to show says why
Result: PARTLY RUN
Findings: Quality > Design "Blocking - P0" (polish, likely), Quality > Evaluations "unavailable". Also carried: U-SY-006.
Time: Quality tab switches about 1 s; board create (Confirm save) 2.6 s; archive 2.6 s.
Code path: `SystemQuality.tsx` / `quality/*` -> `GET /api/v1/ops/quality` (`dashboard.ts:64`); `SystemDashboards.tsx` / `CockpitBoardEditor.tsx` / `BoardLifecycle.tsx` -> `GET/POST /api/v1/ops/boards`.
Live:
1. Quality: Gates (an unimported defensive-security pack says "Not imported", "Import this prompt pack before it can produce run, score, or benchmark evidence" with a Review import link: explains itself), Evaluations ("unavailable" finding), Design ("Blocking - P0" finding: confirmed only in this sandbox, whose root directory is pinned away from the repository; installed builds not verified), Recorded next checks and Quality exports (collapsed, no download pressed). Quality reads `packLimit` 200 by the Gateway default (`dashboard.ts:64`); the page's generic "bounded read" caveat exists but does not say 200. Not recorded as a finding (only matters beyond 200 packs).
2. Dashboards: empty state "No saved boards returned - Create a board to save a custom layout" explains itself. New board > name `ut10-board`, description, widget Usage and cost added beside Runtime truth > Review new board > inline "Create ut10-board with 2 widgets? ... Confirm save" > saved: `POST /api/v1/ops/boards` returned 201 (no 403 under auth none: the old finding is fixed). It opened with both live widgets. After a full reload it was in the list ("2 widgets") and Open board showed it again.
3. "Delete": the UI offers only Archive board (dialog "...you can restore it from the archived list"); archived at version 2, gone from the list, present under Show archived boards. No delete exists.
Failure tried: none beyond reopen after reload.
Evidence: sy-7-quality-evaluations.png, sy-7-quality-design.png, sy-7-quality-capture.json, sy-7-dashboards-empty.png, sy-7-board-review.png, sy-7-board-saved.png, sy-7-board-list.png, sy-7-board-reopened.png, sy-7-archive-dialog.png, sy-7-archived-list.png, capture JSONs.
Not covered: the Improvement view's populated states (empty in the sandbox; its empty states explain themselves), Quality exports download.

## Notes on existing findings
- U-SY-002: from code, `supported` is hard-coded `false` in the Gateway's only daemon-status builder (`apps/gateway/src/services/daemon-route-service.ts:100`; `controllable` also false; no other branch). So an installed build cannot differ: every install reports "Runtime service - Unavailable", and `health-overview.ts:117` turns that into the "waiting" tone that the heading counts. Live: Health heading "1 check needs attention", and the shell's System tab shows "1 check needs review" on every page (seen on Dashboards). Suggested severity friction (not stall: nothing fails to finish). Flagged as affecting every install on every page: the Health heading and the shell's System tab both carry the warning, so the cost is trust in the one screen meant to say whether anything is wrong, which makes it the highest-exposure friction finding. The Running and Problem branches of describeRuntimeService are unreachable from the Gateway today.
- U-SY-001: confirmed live: /system/runtime/workers opens a full Workers page ("No workers have joined yet ...") with no note that it is held back, and Health links to it ("Review remote workers").
- U-SY-004: not reproduced (no failing load provoked).
- U-SY-005: confirmed: "Showing 76 recent signals" before and "Showing 100 recent signals" after Show background signals; 76 rows were listed for 76; the 100-row case was not counted, so the 97-row discrepancy was not tested.
- U-SY-006: confirmed (four stacked caveats on every Quality tab, repeated in the screenshots); the Design finding is the red-status cousin.
- Quality 200-pack lead: verified from code, real but minor (see SY-7); not recorded.
- The Diagnostics "Access" link: not touched (recorded under first-run/settings).
- The old finding that no UI calls createBackup: out of date; Health and Runtime both have Back up now.

## Sandbox artifacts
- Activity "Open source" on "Durable run created / started / woken / completed" rows opened "Run workspace unknown" in both the default and the verification workspace. That message appears only when the run record carries no workspace (durableRunWorkspaceId returns null, WorkRunDetail.tsx:48 and :119); a run owned by another workspace gets the different message "Run outside this workspace ... Choose its workspace". The rows I tried were approval-wait runs created by dev verification routes, which have no workspace; ordinary chat and workflow runs carry one (sy-4-work-history.png lists them as "Workflow run - Done"). Same cause as the carried finding U-IN-013. Only one row per kind was opened, so "every run row" was never shown. Withdrawn as a finding.
- Real observation kept (code only, folded into the workspace-bound links finding): durable-run realtime events carry only runId (durable-run-service.ts:624-629), so an Activity run row cannot open a run in a non-selected workspace directly.
- Test seeding produced the sandbox event volume (76 signals in about 14 minutes); do not read it as a real-use rate.

## Design decisions to confirm
- Spend has no per-model cost or token breakdown (only per provider, and a list of recent calls). If "what did this model cost me" is a day-one question, the design for a model breakdown is worth confirming.
- Dashboards cannot be deleted, only archived (and restored). The confirmation says so; confirm that is intended.
- Sessions (System) lists every workspace's conversations by design ("Conversations across every channel"), while the controls bind to the selected workspace. The workspace-bound links finding is the cost of that split; confirm which side should give.

## Engineering notes
- `daemon-route-service.ts` hard-codes `supported: false`, so the `describeRuntimeService` "Running" and "Problem" branches in `packages/mission-control-shared/src/content/runtime-service.ts` are unreachable from the Gateway today.
- `SystemActivity.tsx` receives `nextCursor` and only uses it for a sentence.
- The Quality Design checks read `fs.existsSync` under the Gateway root (`packages/skills/src/design-quality.ts:218`), so they depend on where the process runs.
