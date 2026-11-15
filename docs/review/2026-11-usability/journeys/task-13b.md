# Task 13b: token mode, large data, production-build check

Live runs: Playwright 1.58 headless, 1440x900 dark. Evidence directory: `docs/review/2026-11-usability/evidence/gl/` (files `tk-…` token mode, `ld-…` large data, `pb-…` production build).

Sandbox: a second sandbox of my own, started from a small launcher that copies the testbench recipe (deterministic stub model, scratch runtime root, home, backups and database, secret store off) with the Gateway in auth mode `token` (a generated test value, kept outside `docs/`) and the dev UI on its own ports. The shared auth-`none` sandbox was not touched. All seeded fixture data from `tools/seed.mjs` (run with a bearer header) plus my own `ut13b-…` data.

Honest limits. The stub never calls a tool, so "approval raised by a real turn" is the same fixture route earlier tasks used (`POST /api/v1/dev/verification/chat-approval-scenario`). The token-mode run has `allowLoopbackBypass` false and the browser sends a bearer token from a loopback origin; that is the connection the question "does the composer work in token mode" is about. Basic mode, proxied access and Docker were not run.

## GL-T Sign-in in token mode
Result: FAIL
Findings: "Pressing Enter in the Gateway token box on the sign-in page does nothing" (friction), "Typing a wrong token on the sign-in page empties the box and says 'Gateway access changed'" (friction)
Time: sign-in page on screen 825 ms after navigation (warm dev server); a correct token via the button 215 ms to the Cockpit.
Code path: `apps/mission-control-next/src/app/use-gateway-access.ts` -> `packages/mission-control-shared/src/components/GatewayAccessGate.tsx` (`handleConnect`) -> `persistGatewayAuthState` / `preflightGatewayAccess` in `packages/mission-control-shared/src/api/client-core.ts` -> `GET /api/v1/onboarding/startup` (401 without a token).
Live:
1. First visit, no token: 'Sign in to continue / Connect to GoatCitadel to load your workspace', Gateway target, 'Stored credentials: None stored yet.', 'Gateway credentials are required. Sign in to continue.', a three-step list, Credential type (Token / Basic), Gateway token, 'Remember credentials on this browser', Request label, 'Connect to gateway', 'Request approval from another device'. One 401 on `onboarding/startup` is logged to the console (expected).
2. Wrong token (21 characters), click Connect: 'Gateway access changed. Sign in again to continue.', the box is empty. Nothing says the token was wrong (finding).
3. Right token, press Enter: nothing happens (finding). Click 'Connect to gateway': in. The token is held in session storage only unless 'Remember credentials' is ticked. A reload after signing in was not tested.
4. Stored token goes bad on an open page (I replaced it with a wrong value while a Chat draft was typed, then clicked Work): 420 ms later 'Gateway credentials were rejected. Re-enter them to continue.', the URL stays on /work. After re-entering the token the page returned to /work and the Chat draft was still in the composer (kept).
5. Stored token removed and page reloaded: 'Gateway credentials are required. Sign in to continue.'
Failure tried: steps 2 and 4.
Evidence: tk-signin-first-visit.png, tk-signin-wrong-token.png, tk-signin-enter-does-nothing.png, tk-signin-token-rejected-open-page.png, tk-signin-zoom.png, tk-signin.json, tk-signin2.json, tk-signin-expire.json.
Not covered: Basic mode; 'Request approval from another device' (needs a second signed-in session); 'Remember credentials' across a browser restart.

## GL-T CH-1 First message in an empty install (token mode)
Result: PASS (same as auth none). The key difference is in project conversations, below.
Findings: none new. Existing U-CH-018 (see Notes on existing findings).
Time: first feedback 97 ms, done 1384 ms from Enter; New conversation to composer 282 ms. Auth none: 109 ms, 1270 ms.
Code path: as in `journeys/task-6.md` CH-1.
Live:
1. Default workspace, empty list: 'No conversations in this view.' and 'Choose a conversation / New conversation', as in auth none. New conversation, typed a sentence, Enter: 'Sending…' then the stub reply; receipt line 'verification-stub-chat · Verification stub (loopback) · 591 ms total'. Console clean, no failed requests.
2. Composer in an ordinary conversation: no approval-mode row in either mode (as auth none).
3. Composer in a project conversation ('Runtime evidence follow-up', project 'Mission Control Verification'): the row reads 'Standard approvals' with a 'Use Auto mode' button. Auth none shows 'Approval mode unavailable / Retry' with a 403 on `GET /api/v1/chat/sessions/<id>/approval-mode`. In token mode there is no 403 and no console error.
4. 'Use Auto mode': no dialog, 2.6 s later the row reads 'Auto · Managed project workspace / Use Standard mode / Managed files', with 'Saves go to the managed workspace for Mission Control Verification. Deletions always ask for approval.' and 'Auto mode enabled.' 'Managed files' opens 'Managed project files' (path box, Find files, 'No managed files saved yet.'). So Auto mode and Managed project files WORK in token mode and are lost in mode none.
Failure tried: none beyond the comparison above.
Evidence: tk-ch-1-project-composer.png, tk-ch-1-managed-files.png, tk-ch-1.json, tk-ch-1-project.json.
Not covered: publishing a managed file (CH-16) in token mode.

## GL-T CH-3 Attach a text file and an image, ask about them; attach a file that is too large (token mode)
Result: FAIL, same as auth none (the too-large message, U-CH-020).
Findings: none new. Also breaks the existing finding for the too-large message.
Time: send first feedback 72 ms, done 1155 ms. Auth none: 67 ms, 1124 ms.
Live: text and PNG attach (two 201s), chips 'ut13b-notes.txt Text · 62 B' and 'ut13b-pixel.png Image · 70 B', send, stub reply. A 21 MiB file: 413 and 'The attachment didn’t upload. Select the file again to retry.' with no size or limit, identical to auth none.
Evidence: tk-ch-3.json (screenshots not kept; same screens as `evidence/ch/ch-3-*.png`).
Not covered: that a real model reads the files.

## GL-T CH-9 Ask for something that needs a tool: approval in place (token mode)
Result: PARTLY RUN, same as auth none.
Findings: none new (the danger two-click flow is specified by DESIGN.md).
Time: danger: 2 clicks, first change 111 ms and 129 ms after the final click (two runs); caution `code_mode.request`: 1 click, 757 ms. Auth none: 116 ms, 775 ms.
Live: seeded a danger `shell.exec` approval and a caution `code_mode.request` approval on my own conversations in the `default` workspace. The card appeared on the open conversation without a reload this time (found within 5 ms of the seed returning; in auth none the first attempt needed a reload, so push may be better in token mode, not a trusted difference). Danger: 'Review danger approval' then 'Approve once'; the Gateway approval read `approved`; a second page on the Inbox went from 2 waiting to 1 without a reload. The end state of the thread is the same stale-looking card as auth none ('Approval needed', 'Outcome uncertain…', 'Version 2 of 2'; there is no model to resume the fixture turn).
Failure tried: none.
Evidence: tk-ch-9-dflt-danger-after.png, tk-ch-9-dflt-danger.json, tk-ch-9-dflt-danger2.json, tk-ch-9-dflt-caution.json.
Not covered: a real turn that raises the approval itself.

## GL-T IN-1 Inbox with pending approvals (token mode)
Result: FAIL, same as auth none (U-IN-007 to U-IN-011 unchanged).
Findings: none new.
Time: caution approve 1 click, 183 ms; danger approve 3 clicks (Review, Review danger approval, Approve once), 193 ms; deny 2 clicks, 22 ms. Auth none: 45 ms, 85 ms, 945 ms.
Live: verification workspace, 4 then 6 waiting. Same rows ('Review shell exec' with the generic sentence), the panel again shows 'Approval summary unavailable' and a 'Safe' badge next to a Danger action, counts fall without a reload (6 to 5, the other tab 5). Honest scoping note: my danger click picked the first 'Review shell exec' row, which was the older seeded one, not the two I raised (their ids stayed `pending`); this only matters for the sandbox's own state, the UI behaviour measured is the same.
Evidence: tk-in-1-danger-review.png, tk-in-1.json.
Not covered: nuclear risk; expiry.

## GL-T WK-1 Create a task, move it, open its run, read its history (token mode)
Result: FAIL, same as auth none (U-WK-001, U-WK-005, U-WK-015).
Findings: none new.
Time: New task > Create task to the task page 150 ms; Save task status 99 ms. Auth none: about 1 s, under 300 ms.
Live: New task form ('Creating a task does not start a run.'), Create task opens the task page; status list Planning, Not started, Assigned, In progress, Testing, In review, Blocked with no Done and 'Done requires at least one recorded deliverable. The option appears once one is recorded.'; Save: 'Task moved to In progress. This board change does not control an execution.' and the board put it in Active. History: '32 saved runs loaded. End of saved run history.', cards titled 'Workflow run' and 'Chat turn'. No link from a task to its run.
Evidence: tk-wk-1.json.

## GL-T LB-2 Files and artifacts (token mode)
Result: PARTLY RUN, same as auth none (U-LB-012).
Findings: none new.
Time: review dialog 112 ms; 'GoatCitadel accepted ut13b-note.txt (44 B).' shown inside the review dialog within the first poll, file listed. Auth none: same.
Live: Library > Files, Upload text file (path box and text box), Review upload, Upload file; the two chat attachments from CH-3 are listed under chat/default/attachments with a UUID prefix on their names. Library > Artifacts: the seeded 'Generated note' opens with Download artifact, Open artifact conversation, Reopen exact artifact, Use artifact in Chat.
Evidence: tk-lb-2-files.png, tk-lb-2-uploaded.png, tk-lb-2.json.
Not covered: an artifact made by a real Chat turn.

## GL-T SY-1 Health (token mode)
Result: PARTLY RUN, same as auth none.
Findings: none new. Carried: U-SY-002.
Time: Health content in 3.4 s including a cold navigation. 
Live: '1 check needs attention' (Runtime service: Unavailable), the same ten Review controls, each lands where it did in auth none (Runtime, Runtime#backups, Settings > Models, a confirmation dialog, Chat messaging advanced setup, Capabilities connectors advanced, Settings > General, Workers, Runtime, Runtime). `GET /api/v1/observe/health` answers 200 with the same keys.
Evidence: tk-sy-1-health.png, tk-sy.json.

## GL-T SY-7 Quality and Dashboards (token mode)
Result: PARTLY RUN, same as auth none (U-SY-006, U-SY-013, U-SY-017 unchanged).
Findings: none new.
Time: board Review 1.5 s, Confirm save 3.1 s (`POST /api/v1/ops/boards` 201, no 403 in token mode either). 
Live: Quality tabs Gates, Evaluations ('Model evaluations: unavailable. No results are available for this source.'), Design ('Blocking · P0' on check 7); Dashboards empty state, create `ut13b-board` with two widgets, saved, listed after reload.
Evidence: tk-sy-7-quality-design.png, tk-sy-7-board-saved.png, tk-sy.json.

## GL-T ST-2 Change a setting that needs approval (token mode)
Result: FAIL, same as auth none (U-ST-001 reproduces).
Findings: none new. U-ST-001 confirmed again in token mode.
Time: `default` workspace, Models, untick 'Keep one Claude Code process between tool steps', Save setting: dialog 0.26 s after Save, Approve once to 'Done · Change saved and confirmed.' about 0.35 s for the approve call; 3 clicks (tick, Save, Approve once). Auth none: dialog 0.25 s, confirmed 0.56 s, 3 clicks.
Live: verification workspace: the dialog opens with 'The selected workspace changed. Open this item again in the current Inbox.' and no Approve, identical to auth none.
Evidence: tk-st-2-default-dialog.png, tk-st-2-default.json, tk-st-2-verif.json.

## GL-L Large data
Result: PASS for volume handling on the production build; dev-server numbers over the thresholds are listed under Engineering notes (not findings).
Findings: one polish finding, 'With 300 tasks the Needs attention lane header reads "200 tasks"'.
Seeded through the Gateway API in workspace `ut13b-large`: 1,001 conversations (1,000 plus the long thread; the sessions API returns 1001), one thread of exactly 300 messages (150 real stub turns through route-preflight and agent-send, about 0.7 s each; the dev seed route caps at 120 messages so it was not used), 500 memory items (`/dev/verification/memory-item-seed`, flag already on), 300 tasks. A 15,728,640 byte attachment was uploaded through the Chat composer.
Measured, 3 runs each, median, headless Chromium, first content = first row of seeded text in `#main-content`; long task from a PerformanceObserver, frame gap from requestAnimationFrame:

| Measure | Dev server (median) | Production build (median) | Longest long task / frame gap, dev -> prod |
|---|---|---|---|
| Chat list open | 1519 ms | 547 ms | 197 / 183 ms -> 92 / 83 ms |
| Open the 300-message thread | 1921 ms | 909 ms | 308 / 300 ms -> 104 / 100 ms |
| Scroll to top of the thread (wheel) | 947 ms | 732 ms | 136 / 133 ms -> 0 / 0 |
| Library > Memory open | 1286 ms | 509 ms | 63 / 0 -> 0 / 0 |
| Work board open | 1241 ms | 489 ms | 76 / 67 -> 0 / 0 |
| Chat list filter (type 23 characters) | typing took 2.9 to 3.0 s (about 130 ms per key), result 6 ms after the last key | typing 0.85 s, result 1 ms | 134 / 167 -> 0 / 0 |
| Memory filter (type, Apply memory filter) | result 33 ms | 36 ms | 57 / 0 -> 0 / 0 |

15 MB attachment: chip 'ut13b-15mb.bin · BIN · 15.0 MB' after 553 ms (201 from `/chat/attachments`), send done 2345 ms, the stub reply arrived.
Truncation checks: Chat list shows 100 rows then 'Load more' (ten 'Load more' clicks reached 1,001; aria-setsize went 200, 300, ... 1000, 1001), so nothing is silently cut; Memory states '500 matching records when this list was read. More pages are available.' and pages by 200 ('Next memory page'); the Work board lane showed 200 of 300 tasks with 'Load more tasks' (the header number is the finding); Done shows the latest 25 runs and says so (`WorkBoard.tsx:336`).
Thread: only the visible turns are rendered (2 turn texts in the DOM at open), scrolling to the first turn took 10 wheel steps, no frozen frame over 200 ms on the dev server except the opening render (308 ms long task).
Evidence: ld-measure-dev.json, ld-measure-prod.json, ld-probe.json, ld-15mb.json (no PNG of the upload kept), ld-work-board.png, ld-memory.png, ld-chat-list.png.
Not covered: 10,000 messages; search inside a thread; the 15 MB file read by a model; Firefox or WebKit.

## GL-P Production build: credential box
Result: PASS (the crash does not reproduce on a production build)
Findings: 'When the OS keychain cannot store a provider key, the key dialog says only "The gateway hit an error…"' (friction).
Build: `vite build` run from `apps/mission-control-next` with `NODE_ENV=production` and `VITE_GATEWAY_URL` pointed at my token-mode Gateway; 1 min 18 s (about 80 s wall), hidden process at below-normal priority, output in git-ignored `apps/mission-control-next/dist`; `git status` stayed clean. I did not run `pnpm build` (which also reruns `build:deps` and `tsc -b`), because the dependency outputs already existed and no type check was needed; the compiled Cockpit code is the same. Served with `vite preview` on port 18790, hidden. The Gateway in token mode accepted the origin without extra configuration.
Live (identical steps on both builds): Settings > Models > Advanced provider configuration > Replace API credential > Open secure input, click the box, type `x` with `page.keyboard.type`.
1. Production build: no crash. One dot appeared, 'Submit securely' became available, no console error. Five fresh page loads in a row: 0 of 5 crashed.
2. Typed the 20-character placeholder `test-invalid-key-000` and clicked Submit securely: the Gateway answered 503 `SECRET_STORE_UNAVAILABLE` ('OS keychain backend is unavailable on this host'; this sandbox disables the secret store), and the dialog showed 'The gateway hit an error. Try again, or check System health.' It failed safely: no crash, no partial state, dialog closable (see finding).
3. Dev-server control (the same page on the Vite dev UI): crash on the first character, 3 of 3 times: 'Settings couldn't be shown' with Try again / Reload app / Go to Chat; console `TypeError: Cannot read properties of null (reading 'value')` from `ChatChangePlanActionDialogBody`. Matches the original observation.
Reading: the failure is a development-build effect (React's development double invocation of the setState updater after the synthetic event is nulled). An operator on the shipped production bundle does not meet it. The code at `ChatChangePlanActionDialogBody.tsx:107` is still fragile in principle (reading `event.currentTarget` inside an updater), so a one-line fix is cheap, but it is not a blocker for operators.
Not covered: the first-run 'Get started' entry (same dialog component, not clicked separately); a real keychain; Linux and macOS builds; the packaged desktop bundle.
Evidence: pb-prod-after-x.png, pb-prod-after-submit.png, pb-dev-after-x.png, pb-prod.json, pb-dev.json, pb-repeat.json.

## Notes on existing findings
- U-ST-019 (the brief's name; the id in findings.json is U-ST-029): crash does not reproduce on a production build (0 of 5 production loads, 3 of 3 dev-server loads crash), suggested confidence confirmed (for the dev-build-only behaviour), suggested severity polish (developer experience; the code smell remains), and the title should say 'on the development build'.
- U-CH-018 (composer 'Approval mode unavailable' with a Retry): confirmed live that token mode does not have it. A project conversation in token mode shows 'Standard approvals / Use Auto mode'; Auto mode enables with no dialog ('Auto mode enabled.' in 2.6 s) and 'Managed files' opens 'Managed project files / No managed files saved yet.' No 403, no console error. The finding's 'code only, not run' remark about token mode can become 'confirmed live'. Mode-none installs therefore get less than token-mode installs: no Auto mode and no Managed project files.
- U-ST-001 (Settings approvals fail outside `default`): reproduces identically in token mode.
- U-IN-010 ('Safe' badge beside a Danger action): reproduces in token mode.

## Design decisions to confirm
- A first-time operator on a token-mode install must find the token themselves; the sign-in page offers 'Request approval from another device' but no hint where the token lives (the Gateway start output, the config, the desktop launcher). Not run end to end here; confirm the first-run docs cover it.

## Engineering notes
- Dev-server large-data numbers over the thresholds (first content 1.5 s Chat list, 1.9 s thread, 1.3 s Memory, 1.2 s Work; longest frame 300 ms opening the thread; about 130 ms per key typing into the Chat list filter with 1,001 conversations) are Vite dev-server effects: the production build is 0.5 to 0.9 s with at most a 100 ms frame. Not filed as findings because operators do not run the dev server. The thread open on production, 909 ms, is the number closest to the 1 s line.
- Sign-in page layout: the 'Sign in to continue' heading touches the line under it (heading bottom 101 px, subtitle top 101 px) and the 'Remember credentials on this browser' tick box renders as a large dark square with a dot. Visual taste, not recorded.
- `GET /api/v1/chat/sessions/<id>/approval-mode` answers 200 for a bearer-authenticated loopback client with `allowLoopbackBypass` false (see U-CH-018 notes).
- Writing the thread through `route-preflight` then `agent-send` needs `providerId` and `model` in both bodies; without them the send returns 409 `route_effective_mismatch`.

## Sandbox artifacts
Own sandbox only. Created in it: the verification fixture, workspace `ut13b-large` with its 1,001 conversations, 300 tasks, 500 memory items, the long thread, a 15 MB attachment; `ut13b-…` tasks, files, a dashboard board, approvals (some decided, some left pending), Auto mode switched on for one project conversation, a pending Settings change in `default`. All of it went with the sandbox's scratch runtime when it was stopped. Nothing was created in the shared sandbox.
