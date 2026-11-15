# Journeys walked in the 2026-11 usability review

The journey files under `journeys/`, in the order they were walked, copied here without changes. Each file keeps its own title; the heading above it names its area. The report is `../2026-11-usability-review.md`.

## Area: Chat: the conversation itself (journeys/task-6.md)

# Task 6: Chat, the conversation itself

Live runs: Playwright 1.58 headless, 1440x900 dark (CH-1 and CH-2 repeated at 375x812 light), the sandbox testbench Gateway (auth mode `none`, deterministic stub model `verification-stub-chat`). The stub answers in about 400 ms with a fixed one-line reply, so real streaming pace, long answers, tool use and model errors were not seen. Evidence directory: `docs/review/2026-11-usability/evidence/ch/`. Finding ids are those the merge script assigned (U-CH-018 to U-CH-024).

Stub limits (read from `scripts/verification/lib/scenarios/deterministic-llm-stub.mjs`, not edited): the stub streams slowly or at length only when the process that starts it passes a `dispatchPlan` (`stream_controlled`, `stream_stall`, `stream_disconnect`) or `promptReplyRules` option, or calls `advanceControlledStream()` from code. There is no prompt keyword, request option or HTTP control. `scripts/testbench.mjs` starts it with only `expectedAuthorization`, so a slow stream could not be produced from outside. CH-2 (Stop) and CH-7 (scroll while streaming) are therefore PARTLY RUN; operator steps for a real model are given in each.

## CH-1 First message in an empty install
Result: PASS (phone/light repeat also finished first time)
Findings: U-CH-024 (polish: empty-state wording; the journey still finished). Approval-mode row did not appear here (conversation not in a project).
Time: first feedback 109 ms ("Sending…"), done 1270 ms from Enter; New conversation to composer 354 ms. Phone/light: first feedback about 260 ms, done 866 ms (Send tapped; Enter on the phone keyboard adds a line instead of sending, which is the usual phone convention).
Code path: `apps/mission-control-next/src/cockpit/areas/chat/ChatArea.tsx` -> `ChatAreaChrome.tsx` (empty state) / `ChatTextComposer.tsx` -> shared threaded controller (`packages/threaded-surface-core`) -> `POST /api/v1/chat/sessions` then `route-preflight` then `POST /api/v1/chat/sessions/:id/agent-send/stream` (`apps/gateway/src/routes/chat.messages.ts`) -> `apps/gateway/src/services/chat-turn-entry-service.ts`.
Live:
1. Opened /chat in the Default Workspace (no conversations): list "No conversations in this view.", main pane "Choose a conversation" with a New conversation button, no composer.
2. Clicked New conversation: composer and starter prompts ("Explain this project", "Plan a change", "Draft or summarize"), "No messages yet".
3. Clicked the box, typed a sentence with the keyboard, pressed Enter: "Sending…" at 109 ms, Stop/Steer at about 270 ms, answer at about 1.3 s; the conversation took its title from the first message; receipt line "verification-stub-chat · Verification stub (loopback) · 536 ms total".
4. Phone, light theme: same flow, no horizontal overflow, composer and Send reachable above the bottom navigation.
Failure tried: Stop at the wrong moment (see CH-2); Gateway unreachable (see Outage).
Evidence: ch-1-empty-install.png, ch-1-new-conversation.png, ch-1-typed.png, ch-1-answered.png, ch-1-timing.json, ch-1-phone-light-list.png, ch-1-phone-light-thread.png, ch-1-phone-light-answered.png.
Not covered: a truly fresh install (first-run task); the first message to a real model (a later task repeats it). The sticky "You asked" bar covering the top transcript line is recorded as its own polish finding (new id U-CH-028).

## CH-2 Follow-up, edit an earlier message, retry an answer, stop a streaming answer
Result: PARTLY RUN
Findings: Stop-at-completion finding (friction, likely for a real model; id U-CH-025 after the merge, replacing the first draft's U-CH-019).
Time: follow-up first feedback 83 ms, done 1184 ms. Edit and retry each answered inside a 2.5 s wait (not timed separately). Stop button visible 116-151 ms after Enter, clicked 172-226 ms.
Code path: `ChatTurnActions.tsx` (Retry, Copy answer, More menu with "Edit your message and resend") -> `use-turn-actions.ts` -> `POST /api/v1/chat/sessions/:id/turns/:turnId/edit/stream` and `.../retry/stream`; Stop: `ChatTextComposer.tsx` -> `POST .../turns/:turnId/cancel` (`apps/gateway/src/routes/chat.messages.ts:1041`) -> `cancelChatTurn` (`apps/gateway/src/services/chat-turn-entry-service.ts:2164`).
Live:
1. In the CH-1 conversation sent a follow-up by keyboard; answer in 1.2 s.
2. More on the first answer -> "Edit your message and resend": composer showed "Editing a new version of this message." with Cancel edit; replaced the text, sent. The thread now shows the edited message with "Version 2 of 2 / 1 / 2" and the follow-up is no longer in view (it belongs to version 1); the conversation list title still shows the old first message.
3. Retry on the latest answer: new answer, "Version 3 of 3". No confirmation because no tools ran.
4. Stop: sent three messages and clicked "Stop response" as soon as it appeared. Run 1: two of three cancels got 400 and showed the "Chat write failed" banner plus the red "provider request failed" card (answer completed anyway); one cancelled cleanly ("Cancelled", Retry). Run 2: three of three 400. The Gateway log gives the cause (turn already completed).
Failure tried: Stop at the wrong moment, as above.
Evidence: ch-2-followup.png, ch-2-more-menu.png, ch-2-edit-mode.png, ch-2-after-edit.png, ch-2-after-retry.png, ch-2-requests.json, ch-2-stop-attempt0.png, ch-2-stop-attempt1.png, ch-2-stop-attempt2.png, ch-2-stop.json, ch-2-stop-gateway-log.txt.
Not covered: stopping a long streamed answer, where the first tokens have arrived and cancel is accepted. Operator steps with a real model: send "Write a 600-word story", click Stop after the first sentence appears, confirm the text so far stays, the turn reads Cancelled and the composer is ready; then send again at once. Settling test: (a) Stop mid-stream, expect "Cancelled" and the text so far kept; (b) send another long answer and press Stop within about 200 ms of the last token, and see whether the red "provider request failed / Reload conversation" card recurs. The stub run showed it recurring when the turn had already completed on the Gateway.

## CH-3 Attach a text file and an image, ask about them; attach a file that is too large
Result: FAIL (the too-large path)
Findings: U-CH-020 (friction, the too-large message).
Time: attach to chips about 1.5 s window (instant in the screenshot), send first feedback 67 ms, done 1124 ms. The 21 MB upload was refused after the file was sent (413); message visible within the 4 s wait.
Code path: `ChatComposerPlusMenu.tsx` "Attach files" -> `ChatComposerControls.tsx:259` file input -> `ChatComposerTools.tsx:300` -> `POST /api/v1/chat/attachments` (`apps/gateway/src/routes/chat.attachments.ts`, `chat-attachment-service.ts:29` limit 20 MiB).
Live:
1. Plus menu -> Attach files; chose a 62 B text file and a 70 B PNG through the file input (Playwright file chooser could not be triggered from the menu item, so `setInputFiles` on the input was used; the two uploads returned 201). Chips "review-task-6-notes.txt Text · 62 B" and "review-task-6-pixel.png Image · 70 B".
2. Asked "what do the attached files contain?" by keyboard. The sent message shows both attachments; the stub reply is fixed text, so whether the model received the content is NOT verified.
3. Chose a 21 MB file: 413 and the red line "The attachment didn't upload. Select the file again to retry." with no size or limit.
Failure tried: the 21 MB file above.
Evidence: ch-3-plus-menu.png, ch-3-attached.png, ch-3-sent.png, ch-3-too-large.png, ch-3-network.json.
Not covered: that a real model reads the text and sees the image; a file type the Gateway refuses; attach by drag and drop or paste.

## CH-4 Switch model and provider for one conversation; see which model answered
Result: PARTLY RUN
Findings: U-CH-021 (friction, three steps and confirmation card).
Time: popover opens in under 0.8 s; the effort change applies 183 ms after "Apply exact change".
Code path: `ChatModelOptionsButton.tsx` -> `ChatModelOptionsPopover.tsx` -> Change Plan card `packages/mission-control-shared/src/components/chat/ChatChangePlanCard.tsx` and dialog `ChatChangePlanActionDialogBody.tsx` -> Gateway change plans.
Live:
1. Opened the model chip: Provider list has one entry (Verification stub), Model one entry, Effort Off/Minimal/Standard/Extended, "Personality", Plan first and Review answer explanations.
2. Set Effort to Extended and pressed Done: chip stays "Standard"; a card "Use verification-stub-chat in this chat / AWAITING CONFIRMATION" appeared in the transcript; a message sent now went out with `thinkingLevel: standard`.
3. "Review and confirm" -> dialog (Scope, Risk safe, Exact revision 1) -> "Apply exact change": chip became "Extended", the next send carried `thinkingLevel: extended`.
4. The receipt under every answer names model and provider ("verification-stub-chat · Verification stub (loopback) · 391 ms total"). After a reload the chip kept the chosen setting.
Failure tried: sending while the change was still unconfirmed (it silently used the old effort).
Evidence: ch-4-model-popover.png, ch-4-effort-extended.png, ch-4-confirm-card.png, ch-4-confirm-step2.png, ch-4-after-apply.png, ch-4-answer-receipt.png.
Not covered: switching to a second provider or model (the sandbox has only the stub; adding a provider means an API key, which is not allowed here). Operator steps: with two providers configured, open the chip, pick the other provider and model, confirm, send, and check the receipt names the new model; also try a model that does not support the chosen effort and a provider whose key is missing.

## CH-5 Find an old conversation, rename it, delete it, and come back to where you were after a reload
Result: PASS (with the approval-mode row noted)
Findings: U-CH-018 (friction, the "Approval mode unavailable" row on project conversations; classified below).
Time: typing "readiness" filtered the 12-conversation list in 696 ms; rename saved and showed in header and list within 1.5 s; delete returned to the empty state within 2 s.
Code path: `ConversationListPanel.tsx` -> `GET /api/v1/chat/sessions` (search) ; header pencil -> `PATCH /api/v1/chat/sessions/:id`; "Conversation actions" menu -> `DELETE /api/v1/chat/sessions/:id`.
Live:
1. In the seeded workspace typed "readiness" in "Find a conversation": the list narrowed to "Release readiness review"; opened it (URL gained `sessionId=`).
2. Reloaded: the same conversation reopened (the URL carries it); the search box was cleared. Went to Work and pressed Back: same conversation.
3. In the Default Workspace: pencil icon -> input holds the old title selected; typed a new one, Enter; header and list updated; survived a reload.
4. Conversation actions menu: Open code workbench, Inspect conversation, New conversation from latest message, Pin conversation, Delete conversation…, Export conversation, Archive conversation. Delete conversation… asked "Delete "<title>" permanently? This removes its messages, traces, session history, and attached files." with Cancel / Delete permanently; landed on "Choose a conversation".
Failure tried: reload and Back (kept place).
Evidence: ch-5-search.png, ch-5-after-reload.png, ch-5-rename.png, ch-5-renamed.png, ch-5-actions-menu.png, ch-5-delete-confirm.png, ch-5-after-delete.png, ch-5-approval-mode-unavailable.png, ch-5-approval-mode-403.json.
Not covered: searching message text rather than titles; archive and restore.

## CH-6 Use the composer's plus menu: web on and off, Review answer, a prompt pack, a variable
Result: PARTLY RUN
Findings: U-CH-023 (polish, "Review unavailable" with no reason); U-CH-018 shown in this conversation. Not run: prompt pack and variable.
Time: palette opens in about 1 s; web select applies at once; "Reviewing the answer" shows about 100 ms then "Review unavailable".
Code path: `ChatComposerPlusMenu.tsx` (Attach files, Sources, Commands and context, Plan first, Web Auto/Off/Deep, Review answer, Voice and images) -> `ChatComposerPalette.tsx` -> `packages/threaded-surface-core/src/chat/composer-palette-source-builders.ts` (prompt packs listed only when the pack has a `runVariableSchema`, line 137).
Live:
1. Web search -> Off: pill "Web: Off" (with remove button "Set web search back to Auto"); the send carried `webMode: off`; the pill reset it to auto and the next send carried `webMode: auto`.
2. Review answer on: pill "Review answer"; sent; "Reviewing the answer" then the receipt "… · Review unavailable".
3. Commands and context: dialog "Find a command, model, file, or variable" listing slash commands, models, projects, files, agent presets ("Reviewer") and skills. Selecting Reviewer showed "Applied Reviewer."
4. The seeded prompt pack ("Mission Control Next Verification Pack") does not appear: the palette lists only packs with a run-variable schema and this one has none. The Library prompt-pack screen only displays a schema (PromptTab.tsx:66), it does not create one, so no variable form could be reached from the UI. NOT RUN.
Failure tried: Review answer with a stub that cannot return a review.
Evidence: ch-6-plus-menu.png, ch-6-web-off.png, ch-6-review-answer.png, ch-6-palette.png, ch-6-palette-filtered.png, ch-6-reviewer-selected.png.
Not covered: a prompt pack with variables and the variable form; Sources, Voice and images, Deep web. Operator steps: import or create a pack whose definition has run variables, open Commands and context, choose its entry, fill the form, send, and check the variable values appear in the sent message.

## CH-7 Long answer: scroll up while it streams, scroll position holds, jump to latest
Result: PARTLY RUN
Findings: none new (the "2 new messages" count includes the operator's own message; related to existing U-CH-003).
Time: n/a (answers last about 400 ms).
Code path: `ChatTranscript.tsx`, `ChatTranscriptNavigation.tsx` ("Jump to latest"), virtualized timeline in `ChatTranscript.virtualization.test.tsx` area.
Live:
1. Built a 20-turn conversation (14 filler messages) by keyboard.
2. Scrolled up, then sent: the view went to the bottom after the operator's own send (expected).
3. Sent again, scrolled up 1500 px about 150 ms later, sampled for 3.5 s: scrollTop stayed 2838 while the scroll height grew 5019 -> 5265; a "Jump to latest · 2 new messages" button appeared; it was also present before sending while scrolled up.
Failure tried: scrolling during growth (position held).
Evidence: ch-7-long-thread-bottom.png, ch-7-scrolled-up-after-send.png, ch-7-scroll-during-stream.png, ch-7-scroll-hold.json.
Not covered: a multi-second streamed answer with many paragraphs, and the jump button click while the stream continues. Operator steps with a real model: ask for a long answer, scroll up one screen as soon as it starts, wait for it to end, confirm the text under your eyes did not move, then click Jump to latest and confirm it reaches the end and stays there when a second answer streams.

## CH-8 Two tabs on the same conversation: send in one, the other catches up
Result: FAIL (only for sends at the same moment)
Findings: U-CH-022 (friction, banner with raw id and "interrupted" card). Live trigger: simultaneous Enter; the realistic trigger is a second tab or device sending during a long turn (same turn lease), not run because the stub finishes too fast.
Time: tab A showed the sent message at 211 ms and finished at 1720 ms; tab B showed the message and the finished answer at 2444 ms (it does not show the stream in progress).
Code path: shared event stream `GET /api/v1/events/stream` -> controller refresh; second send hits `apps/gateway/src/services/chat-turn-execution-registry.ts:76`, copy in `ChatStreamErrorNotice.tsx:8`.
Live (two Playwright pages, one browser context):
1. Sent from tab A: tab B caught up in 2.4 s, no reload.
2. Sent from tab B: tab A showed it within 3 s.
3. Pressed Enter in both tabs at once: B's message went through; A got the banner "A chat turn write is already in progress for session sess_… Wait for the current agent-send/stream to finish and retry." and the red card "The response was interrupted. Check the connection…" with Reload conversation. A's draft stayed in the composer; nothing was lost.
Failure tried: simultaneous send (step 3).
Evidence: ch-8-tab-a.png, ch-8-tab-b.png, ch-8-simultaneous-a.png, ch-8-simultaneous-b.png.
Not covered: two different devices, and a tab left in the background for minutes.

## Outage (Review Focus 1, Step 4)
Result: PARTLY RUN (stop observed; resume NOT RUN: the sandbox cannot be restarted on the same data)
Findings: two recorded after review: the banner that stays after a frozen Gateway returns (new id U-CH-026) and the pending approval card whose buttons look live while the Gateway is down (new id U-CH-027, click not tried). The stopped-Gateway handling itself is good (see below).
Why no true restart: `scripts/testbench.mjs` `watchChildExits` requests a teardown 500 ms after its Gateway exits (`CHILD_EXIT_GRACE_MS`, line 37) and teardown deletes the runtime root. Re-running the Gateway start command by hand would need the launcher's in-process stub model and its environment; killing the launcher instead skips teardown but also kills the stub. So the data directory and port cannot be reused.
Done (target PID's command line confirmed to be this worktree's `apps/gateway/dist/main.js` first):
A. Freeze test (non-destructive): froze the Gateway with NtSuspendProcess for about 41 s right after a send (the PowerShell start-up took about 1 s, so the turn had already finished), then thawed it. For about 30 s the screen showed nothing wrong and "Updates connected" stayed. At about 30 s the red banner "Can't reach the GoatCitadel gateway. Check that it's running, then try again." with "Reload conversation" appeared. After the Gateway was thawed the banner stayed for at least 15 s until Reload conversation is pressed. Nothing was lost; the answer was on screen. A hung (not dead) Gateway is a rarer case; recorded here, not as a finding.
B. Kill test: opened the conversation with a pending approval card (shell command, "Review danger approval" / "Deny"), pressed Enter on a new message and ran `taskkill /F` on the Gateway 86 ms later. Screen: within 0.6 s the nav indicator changed from "Updates connected" to "Reconnecting to updates"; by 5.4 s (first sample after) a top banner "GoatCitadel is unreachable. Sending is paused; your draft is kept. Last connection confirmed at 10:28 PM. Start GoatCitadel on this computer: open the desktop app or run goatcitadel up." with a "Check again" button and a "Checking… / Still unreachable" line repeating every few seconds, and under the composer "GoatCitadel is unavailable. Your draft is preserved; send resumes when the connection returns." The message text stayed in the composer (the send had not reached the Gateway), no answer or spinner appeared, and the pending approval card stayed on screen with live-looking buttons while the Gateway was gone. Nothing was silently lost.
Resume: NOT RUN (the sandbox tore itself down after the kill, then was rebuilt). Operator steps on a real install: (1) send a long answer request, (2) stop the Gateway process mid-answer (desktop app: quit it from the tray; CLI: stop `goatcitadel up`), (3) note the banner and whether the partial text stays, (4) start the Gateway again, (5) watch for the banner to clear without a reload and for "Updates connected", (6) check the interrupted turn: it should be marked interrupted with Retry, not left spinning, and a sent-but-unanswered message should not be sent twice, (7) repeat with an approval card on screen and approve after recovery.
Evidence: ch-outage-freeze-2s.png, ch-outage-freeze-8s.png, ch-outage-freeze-25s.png, ch-outage-freeze-38s.png, ch-outage-after-resume.png, ch-outage-freeze.json, ch-outage-kill-before.png, ch-outage-kill-1s.png, ch-outage-kill-4s.png, ch-outage-kill-12s.png, ch-outage-kill-30s.png, ch-outage-kill.json.

## Sandbox artifacts

Approval mode "unavailable" (403 on `GET /api/v1/chat/sessions/<id>/approval-mode`). Classified: NOT a sandbox artifact. It is recorded as U-CH-018.
- Why the sandbox gets it: the route requires `directLocal` (`apps/gateway/src/routes/chat.sessions.ts:29-33`); `directLocal` is `request.authActorSource !== "none" && isDirectLoopbackRequest(request)` (`session-control-request-context.ts:154`), and the admission context drops it again for source `none` (`session-control-service.ts:155`). The sandbox runs auth mode `none`, which makes every request's actor source `none` (`plugins/auth.ts:180-182`). A curl from 127.0.0.1 straight to the Gateway, no browser, UI port, proxy header or Origin, gets the same 403, so cross-origin or the UI dev server's host and port are not the cause. The testbench's separate UI port is irrelevant.
- Real operator: every mode-`none` install sees it: `auth.mode` defaults to `none` with `allowLoopbackBypass` false (`config.ts:1270-1271`, `config/goatcitadel.example.json:29-30`); the packaged Windows desktop launcher sets only `GOATCITADEL_HOME`, `GOATCITADEL_APP_DIR` and `GOATCITADEL_DESKTOP_HOST` (`main.rs:710-714`), `goatcitadel up` and `pnpm dev` set no auth mode, and the dev supervisor's mode also defaults to `none` (`dev-supervisor.ts:745`), so its `allowLoopbackBypass: true` (line 746) is never reached: in mode `none` `plugins/auth.ts:180-182` returns before the loopback check. The row appears in any conversation that belongs to a project. Docker sets token mode with loopback bypass false (`docker-compose.yaml:74-76`); Docker and proxied or remote setups likely see the 403 too because the request does not arrive as a direct loopback connection (unverified, not run). Token or basic mode with a direct loopback client (actor source `token`, `basic` or `loopback`) gets `directLocal` and the control works (code only; the auth mode may not be changed in this review). The gate looks like a deliberate security rule (mode none cannot prove locality); no document states it, and whether none-mode installs should get Auto mode is a product decision. Conversations with no project do not render the row at all (`chat-managed-files-surface.tsx:48`).
- What the composer loses: only the row's "Use Auto mode" switch and "Managed files" (the managed-project workspace). Checked live in the affected conversations: attachments, plus menu, web, Review answer, model chip, Send, Stop, edit and retry all worked. So other tasks' Chat journeys are not blocked by it,. The Gateway also logs a WARN per load (`... approval-mode -> 403`) and the browser console shows the 403 on every project-conversation load; expect it in console captures from other tasks.
- Sandbox changes: the sandbox was rebuilt, see the report.

## Notes on existing findings
- OL-07: Gateway outage and recovery. Observed: on a hard stop of the Gateway the screen shows "Reconnecting to updates" within 0.6 s and, by 5.4 s, a top banner "GoatCitadel is unreachable. Sending is paused; your draft is kept." with Check again, "Last connection confirmed at <time>" and the start hint; the unsent draft is kept; a pending approval card stays on screen with live-looking buttons. A frozen (not stopped) Gateway shows nothing for about 30 s, then "Can't reach the GoatCitadel gateway…" which stays after the Gateway returns until "Reload conversation" is pressed. Recovery after a real restart: NOT RUN (the testbench deletes its data when the Gateway exits); operator steps are in the Outage section. Suggested verdict: partial (stop behaviour verified live, resume operator-only).
- U-CH-003 (Jump to latest counts new messages): live check showed "Jump to latest · 2 new messages" after the operator's own send and the answer, so the count includes the operator's own message. Severity unchanged (polish).

## Design decisions to confirm
- After editing the first message of a conversation, the conversation-list title stays on the old first message (seen live: list still showed "Say hello in one sentence. …" after the edit). Decide whether the list should follow the current version.
- Editing the first message of a conversation branches it (Version 2 of 2) and hides every later turn of version 1 behind the version selector. Operators who expect "edit and keep going" may think the follow-ups were deleted; the version selector is the only hint.
- Prompt packs appear in the composer only when the pack has a run-variable schema; packs without one are invisible there, and no screen creates a schema.

## Engineering notes
- A stale-looking first Stop: the Stop button stays on screen about 100-250 ms after the Gateway has already completed the turn.
- `ChatManagedFiles.tsx` fetches `approval-mode` for every project conversation even in auth modes where the route always refuses.
- The testbench gives no way to run the stub with a slow `dispatchPlan`, so Chat's streaming states are untestable by an outside reviewer; a `--slow-stub` option or a prompt-keyword rule would close that gap for later tasks.

## Area: Chat: agentic work, approvals and Code Mode (journeys/task-7.md)

# Task 7: Chat, agentic work, approvals and Code Mode

Live runs: Playwright 1.58 headless, 1440x900 dark, sandbox testbench Gateway (auth mode `none`, stub model `verification-stub-chat`). Evidence directory: `docs/review/2026-11-usability/evidence/ch/`. Finding ids are assigned by the merge script when it is re-run after fix round 1, so findings are quoted by title below.

How the triggers were produced. The stub model answers every request with one fixed line; it never calls a tool, plans, researches or runs code (`scripts/verification/lib/scenarios/deterministic-llm-stub.mjs`: tool calls, slow streams and per-prompt replies exist only when the process that starts the stub passes a `dispatchPlan` or `promptReplyRules`, and `scripts/testbench.mjs` passes neither). So a turn that really stops on an approval cannot be started from the composer here. Two kinds of trigger were used:
- Approvals (CH-9, CH-10, CH-13): the Gateway's own verification route `POST /api/v1/dev/verification/chat-approval-scenario` (`apps/gateway/src/routes/dev-verification.ts:319`, the route the repo's own lane `scripts/verification/lib/scenarios/usability-browser-action-lane.mjs` uses) parks a turn on a real pending approval (`shell.exec` = danger risk, `code_mode.request` = caution risk) in a conversation I had started from the composer. Everything after that, the card, the clicks, the Gateway resolve call, the Inbox, was the real UI and Gateway. What the route cannot do is give the turn a model to resume, so "the turn continues by itself" was seen as far as the Gateway settling the decision, not as new model output.
- Plan mode (CH-11) and `use <skill>` (CH-14) needed no fixture: Plan first is Gateway-written text, and explicit skill names are read in the Gateway before the model.

## CH-9 Ask for something that needs a tool: the approval appears in place, one click approves, the turn continues with no "Continue" step and no trip to the Inbox
Result: PARTLY RUN (caution: one click, meets the one-click preference; danger: the documented two-step, see Design decisions to confirm; 'continues by itself' not observed because the stub cannot resume a turn)
Findings: 'The danger approval review dialog repeats Action and Command' (polish), 'Characters typed within about 0.3 s of pressing New can be lost' (polish, likely). Danger approval taking two clicks is NOT a finding: DESIGN.md:60 specifies it (see Design decisions to confirm). Also U-CH-014 (seen: 'How this decision works' disclosure under the buttons), U-IN-001 (seen: the Inbox row 'Review shell exec' does not say what it would run).
Time: first feedback after the final click 116 ms (default workspace, danger), 128 ms (verification workspace, danger), 775 ms (caution, 'Running code…'). Done: decision recorded and card collapsed within about 1 s; the turn did not produce new content (fixture, no model).
Code path: `apps/mission-control-next/src/cockpit/areas/chat/ChatBlockers.tsx` -> `RiskApprovalAction.tsx` (one-click only for safe and caution, review dialog for danger, `RiskApprovalAction.tsx:112`) -> `POST /api/v1/approvals/:id/resolve` -> `approval-lifecycle-service.ts` (commit, then `awaitApprovalResolutionEffects`) -> durable run resume. Caution `code_mode.request` renders as 'Run it / Deny / Details' (the Code Mode request card).
Live:
1. Default workspace: New, typed a message, got the stub reply, then seeded a danger (`shell.exec`) approval onto that conversation. The card appeared in place after the page re-read the conversation (the conversation list row already read 'Waiting on you'; the open thread showed the card only after a reload on the first attempt and without one on the second, so the fixture does not prove live push).
2. Card: 'Approval needed / Run command / Danger / Action: Shell exec / Scope: Default Workspace · one linked conversation. This decision authorizes this request once. / Expiry: No expiry set / Command: pnpm test / Consequence: After approval, the exact reviewed action may run; denying withholds it. The decision alone does not show the work resumed or completed.' with 'Review danger approval' and 'Deny'.
3. Clicked 'Review danger approval' (click 1): dialog 'Confirm danger-level action' repeating Action and Command, with 'Approve once' and 'Cancel'. Clicked 'Approve once' (click 2). 116 ms later the card read 'Recording the approval decision…', then 'Decision recorded: Approved. Approval effects settled. Linked work has its own execution outcome.' and collapsed. Focus returned to the message box. Gateway: approval `approved`, turn `completed`.
4. A second page on the Inbox, opened before the decision, went from 7 waiting to 6 without a reload.
5. Caution (`code_mode.request`): one click on 'Run it'; focus landed on the status line 'Running code…' (775 ms); Gateway approval `approved`; Inbox 7 to 6 without a reload. The status then stayed 'Running code…' (nothing runs it with the stub).
6. Verification workspace (`ws_f13a…`), danger approval: identical result, 2 clicks, Inbox 3 to 2 without a reload, approval `approved`.
7. Keyboard: Deny and Review buttons are reachable by Tab; the typed text steps used the keyboard throughout.
Settings approvals versus Chat approvals (the row OL-16 question): Chat approvals do NOT have the 'selected workspace changed' problem. In the verification workspace the card showed 'Scope: Mission Control Next Verification Workspace', the dialog offered 'Approve once', and the decision went through. Only the Settings dialog (U-ST-001) is affected.
Failure tried: decided from a second page (see CH-10).
Evidence: ch-9-dflt-danger-card.png, ch-9-dflt-danger-dialog.png, ch-9-dflt-danger-after-approve.png, ch-9-dflt-danger.json, ch-9-ver-danger-*.png, ch-9-ver-danger.json, ch-9-dflt-caution-*.png, ch-9-dflt-caution.json, ch-9-typing-after-new.json.
Not covered: a real turn that raises the approval itself and resumes after it ("continues by itself" with new model output); a safe-level approval. Operator steps with a real model: in a project conversation ask "Run the project's tests", wait for the card, approve once, and watch that the answer carries on without Continue and without opening the Inbox; repeat with a danger action and count clicks.

## CH-10 Deny an approval; approve after the request expired
Result: PARTLY RUN (deny and two-tab race run; pure timeout not run)
Findings: U-CH-031 (polish, likely, expired card). Deny is one click for every risk level.
Time: Deny first feedback 124 ms, settled text within about 2 s.
Code path: `RiskApprovalAction.tsx:64` (button disabled from the expiry time at render) and `approvals/approval-preview.ts:87` ('Expired') -> `POST /api/v1/approvals/:id/resolve` -> `approval-lifecycle-service.ts:836-880` (already resolved: ConflictError; past expiry: 'has expired and can no longer be resolved'). Chat tool approvals carry no expiry unless created with a TTL (the sandbox's show 'Expiry: No expiry set'), so a natural timeout does not arise here.
Live:
1. Danger approval: clicked Deny: no dialog, text at once 'You denied the action. This turn will not start any more tools or request another approval. Send a new message to continue.' and the tool line 'Blocked · Denied by an operator · This action did not execute. … No outside changes.' Gateway status `rejected`.
2. Caution approval, two pages on the same conversation: page 1 Deny; page 2 (with its live event stream blocked, so it still showed the card) clicked 'Run it' afterwards. No approval request was sent and no error showed: the card re-read the record and converged to 'You denied the action…'. With the stream not blocked, page 2 had already updated by itself. The Gateway status stayed `rejected`. This is handled well.
Failure tried: second page deciding an already-decided approval, as above.
Evidence: ch-10-danger-card.png, ch-10-danger-denied.png, ch-10-caution-tab1-denied.png, ch-10-caution-blocked-tab2-stale-before-click.png, ch-10-caution-blocked-tab2-stale-after-approve.png, ch-10-caution-blocked.json.
Not covered: approving after a real timeout (needs an approval created with a TTL). Operator steps: raise an approval from a feature that sets a TTL (for example a messaging-channel approval), wait past its expiry with the card open, and check the card says it expired with a next step and that clicking does not leave a spinner; then reopen the conversation and check the same.

## CH-11 A planning or research request: steps, progress, delegation and the final synthesis are readable; a failed step says what failed and what to do
Result: FAIL (planning run; a failed step and a research request could not be produced)
Findings: Delegation 'Done' with 0 of 4 steps and all steps 'Queued'; plan text run together with internal names; every New click saves an empty 'New chat' (polish). Also U-CH-001 (the sticky 'You asked' bar covers the top line of the answer, seen again).
Time: Plan first answer in 179 ms and 162 ms from Enter (Gateway text, no model).
Code path: plus menu 'Plan first' (`ChatComposerPlusMenu.tsx`) -> `PATCH /api/v1/chat/sessions/:id/prefs` -> `agent-send/stream` -> plan text `apps/gateway/src/services/chat-turn-helpers.ts:179-191` -> Delegation card `ChatRunCard.tsx` ('Supervised work · <status>', '<n> of <m> steps done · Latest: <role>') and `Inspect run` side panel; step status words `chat-vocabulary.ts:58-66` (a failed step maps to 'Failed' but the card line shows only a count).
Live:
1. Plus menu showed Attach files, Sources, Commands and context, 'Plan first', Web Auto/Off/Deep, Review answer, Voice and images. Chose Plan first; the chip 'Plan first' appeared in the composer.
2. Sent 'Plan this deterministic usability turn.' by keyboard. Answer 'Chat plan / Objective / Chat orchestration plan … using cowork.plan.work.synthesize / Planned steps: 1..4' with each step run together on one line and 'Depends on: orch-step-1'.
3. Delegation card: 'Supervised work · Done', '0 of 4 steps done · Latest: Synthesizer'. Inspect run: Planner, Worker, Reviewer, Synthesizer all 'Queued'. After reload the card keeps only its header.
4. Counted conversations through the API before and after one New click: 20 then 21 (see U-CH-034).
Failure tried: a failed step. Not possible: the Gateway verification routes seed approvals, user input and tasks but not a failed delegated step, and the stub cannot fail a step.
Evidence: ch-11-plus-menu.png, ch-11-plan-on.png, ch-11-plan-answer.png, ch-11-live-delegation-card.png, ch-11-inspect-run.png, ch-11-after-reload.png, ch-11-new-chat-empty-sessions.json.
Not covered: research with real sources and a synthesis; delegated steps that run, fail and retry. Operator steps with a real model: Plan first on, ask "Plan and research the options for X, then give a recommendation", watch the card count steps as they finish, force a failure (for example switch the model off mid-run or deny a step's approval) and check the card names the step that failed and offers Retry.

## CH-12 Deep research with documents; a document that is truncated says so
Result: PARTLY RUN (documents run; Deep web research not run)
Findings: U-CH-035 (a long document is read only in part and the screen does not say), U-CH-036 (stale 'Attached … for the next turn.' note). Also U-CH-020 context (the too-large upload message).
Time: send first feedback within the 25 ms poll; answer 170 ms.
Code path: composer `@` palette (`ChatComposerPalette.tsx`) -> `useChatComposerPaletteActions.ts:68` ('Attached … for the next turn.') -> `POST /api/v1/chat/attachments` -> `chat-attachment-service.ts:339` (first 4,000 characters) -> `chat-turn-user-message.ts:113` (first 1,600 characters into the prompt). Sources path: `chat-thread-knowledge-service.ts:363` writes 'Truncated <title> …' into the model prompt only.
Live:
1. Uploaded a 122 KB markdown file to the workspace files through the API (setup), typed '@review-task-7' in a new conversation: the palette listed it ('Ready to attach').
2. Selected it, asked about its last line, sent. The message carries the chip 'review-task-7-long-document.md · Markdown · 122 KB'. Inspect > Context: 'Routed context: Not recorded', 'Included documents: 0'; Sources: 'No sources were recorded for this response.' Nothing states how much was read.
3. The typed mention stays in the text ('@review-task-7What is …'): I did not add a space, so this is noted only.
Deep research itself (Web: Deep) calls the network and real sources and was not run.
Failure tried: oversize text document (above).
Evidence: ch-12-at-palette.png, ch-12-ready-to-send.png, ch-12-answer.png, ch-12-inspector-context.png, ch-12-inspector-sources.png, ch-12-attachment-preview.json.
Not covered: Web Deep research and its budget, PDFs, what the model received. Operator steps: attach a long PDF and a long text file, ask for the last section, and check whether the answer or the card says the document was cut; then turn Web to Deep with two documents attached and check the research summary names which documents were used and which were cut.

## CH-13 Code Mode run from Chat: approval, run, artifact shown, artifact opened
Result: PARTLY RUN (approval card and a finished-run card seen; no real run: the sandbox's seeded project is not a git repository, which a project made through the product always is, see Sandbox artifacts)
Findings: 'When Create worktree fails, the build editor shows raw JSON ...' (polish, likely; a real operator meets it only if the project folder lost its .git or git is missing), 'The build editor says Create a worktree ... but the button is hidden' (friction). Also U-CH-018 (no managed-files control here).
Time: Create worktree first sign 173 ms (the error text).
Code path: Chat code card `ChatCodeModeRequestCard` ('Run it / Deny / Details') -> approval resolve (CH-9) -> durable `code_mode` run; build editor `CodeWorkbenchToolbar.tsx` -> `POST /api/v1/chat/sessions/:id/workbench/worktree` (`chat.sessions.ts:910`) -> `git worktree add`; Snippets > Run helper snippet (the lane's route) needs the worktree.
Live:
1. Approval card for a Code Mode request (seeded): 'Run code to read the text of saturday-plan.pdf / Reads saturday-plan.pdf / Run it / Deny / Details'; one click ran it (CH-9).
2. Seeded a finished run (`chat-code-mode-ran-scenario`): 'Ran code to read the text of saturday-plan.pdf · 2 s', 'Keep as a tool', 'Details' showing Reads, Input and Code. The card shows no artifact list and no result text; the run was a fixture, so artifacts could not be judged.
3. Opened the code workbench for the seeded project: 'Create a worktree to begin editing', no obvious Create button (it sits under 'Repo actions and checks'). Create worktree returned the raw 400 error. That failure belongs to the sandbox's non-git seeded project; the finding is only about the raw text on screen.
No code was executed: the only Code Mode requests were seeded ones that run nothing, and the real path (Snippets > Run helper snippet) needs a worktree this sandbox cannot make.
Failure tried: Create worktree on a non-git project (above).
Evidence: ch-13-ran-card.png, ch-13-card-details.png, ch-13-workbench-verif.png, ch-13-repo-actions-open.png, ch-13-after-create-worktree.png.
Not covered: a Code Mode run to completion, its artifact list, opening an artifact, named proof. Operator steps with a real model and a git project: import a small git repo, ask "Write a TypeScript helper that returns the sum of two numbers and run it", approve once, check the card lists the artifact, open it, and use Run named proof.

## CH-14 Use a skill by name (`use <name>`), and a skill that is switched off
Result: FAIL (typing `use <skill>` does nothing and says nothing; a switched-off skill not run)
Findings: 'On a default install, typing use <skill> in Chat does nothing and says nothing ...' (stall).
Time: answers in 225 ms, 289 ms, 307 ms.
Code path: composer -> `agent-send/stream` -> `chat-skill-selection-runtime.ts` (`resolveChatRuntimeSkillSelection`, disabled skills dropped at line 74) -> `chat-feature-admission-service.ts:171` (runs only when feature flag `chatSkillInstructionsV1Enabled` is true) -> `callable-skill-activation.ts:157` (`use <name>` read before the model) -> trace `activated_skill_count` (`chat-turn-runtime-decisions.ts:48`); no UI reader (git grep).
Live:
1. 'use debugging skill to look at this' (enabled, callable), 'use genie-npu-ir20 for this' (enabled, not callable), 'use nosuchskill please': three plain answers, no chip, no message. Same for '@skill debugging explain this' and 'use debugging' in the verification workspace.
2. The Gateway's decision trace for each turn: `activated_skill_count` 0. Cause: `chatSkillInstructionsV1Enabled` defaults to false (`config.ts:1535`, `feature-flags.ts:57` and `:154`); one read-only GET of the sandbox's `/api/v1/settings` returned `features.chatSkillInstructionsV1Enabled = false`. No Cockpit screen exposes the flag (git grep), and Capabilities > Skills still shows the skill as on and callable.
Failure tried: a not-callable skill and an unknown name (both silent). A switched-off skill: not run; switching a skill off needs a Capabilities change plan (another task's area); code read: dropped silently.
Evidence: ch-14-activation-counts.json, ch-14-1-answer.png, ch-14-2-answer.png, ch-14-3-answer.png, ch-14-1-typed.png.
Not covered: what happens with the flag on (it can only be set in the Gateway config or environment, not from a screen), and a switched-off skill. Operator steps: first set GOATCITADEL_FEATURE_CHAT_SKILL_INSTRUCTIONS_V1_ENABLED=true for the Gateway, then switch a skill off in Capabilities, type `use <that skill>` in Chat, and check the screen says it is off; switch it on, repeat, and check a chip or line says it was loaded.

## CH-15 A browser errand started from Chat, up to its first approval
Result: NOT RUN
Findings: none
Time: n/a
Code path: model tool `browser.errand` (only a model can start one: `apps/gateway/src/routes/browser-errands.ts` has only status and stop routes) -> `ChatBrowserErrandCard.tsx` (polls `GET /api/v1/browser-errands/by-tool-run/:id`, Stop button, outcome copy for done, stopped, declined, expired, failed, step limit, time limit, window closed) -> step approval `browser.errand.action` shown by `ChatBlockers.tsx:135-138` with a screenshot of the page.
Live: nothing to drive. The stub cannot call the tool, and no verification route seeds an errand or a `browser.errand.action` approval. The status route answers 404 'No errand ran for this tool run.' for an unknown id (checked), not a 403, so auth mode `none` does not block the card.
Failure tried: none.
Evidence: none.
Not covered: all of it. Operator steps with a real model and a real browser: ask "Open example.com in a browser errand and read the heading"; wait for the first approval card, check it shows the page picture and what the step will do, Deny it, and check the card ends with 'You declined a step, so the errand ended.'; start a second one and press Stop while it runs.

## CH-16 Publish a managed project file with the overwrite review
Result: NOT RUN (blocked by U-CH-018)
Findings: U-CH-018 (the managed-files control is missing in this sandbox), U-CH-040 (error copy sends the operator to a config file; code only).
Time: n/a
Code path: composer 'Managed files' -> `ChatManagedFiles.tsx` (list, restore, download, Publish `:365-380`) -> `publishChatManagedFile` -> Gateway; 'overwrite_required' opens `ManagedFileOverwriteReview` (`:209-221`, `:384-395`) which locks while the file or the approval mode changes.
Live: in a project conversation (verification workspace) the composer shows 'Approval mode unavailable / Retry' and the plus menu has no Managed files entry. The inspector's Files tab shows only 'Documents · Notes and generated artifacts' and the line 'Opening a document never adds it to model context…'; no publish control.
Failure tried: none.
Evidence: ch-16-inspector-files.png.
Not covered: publishing, the overwrite review, restore, download. Operator steps (needs a connection where approval mode loads, for example Gateway auth mode token, or loopback bypass on): open a project conversation, choose Managed files, publish a saved file to the original folder, change the file on disk, publish again, and check the overwrite review shows what will be replaced and cancels cleanly; publish again after editing the file to see the review lock.

## Notes on existing findings
- OL-14: confirmed with the stub (the `use <name>` reader runs in the Gateway before the model), and the cause is the feature flag `chatSkillInstructionsV1Enabled`: it defaults to false (`config.ts:1535`, `feature-flags.ts:57`, `:154`), the sandbox read false, and with it off the skill-loading path (`chat-feature-admission-service.ts:171`) never runs, so `activated_skill_count` is 0. No screen exposes the flag and Capabilities > Skills still shows the skill as on and callable. Treat the row as open (it is the stall finding 'On a default install, typing use <skill> in Chat does nothing and says nothing'), not operator-only.
- U-ST-005 and U-GL-008 (confirm button looks like Cancel): confirmed live on the Chat change-plan dialog ('Confirm current Chat model', opened from the model chip after changing Effort): 'Cancel' and 'Apply exact change' have identical computed styles, background rgb(15, 29, 45), colour rgb(244, 251, 255), border rgba(178, 224, 245, 0.24) 1 px. Suggested severity friction for both; the cause is shared, so one fix covers every dialog of this kind. Evidence: ch-change-plan-dialog.png, ch-change-plan-button-styles.json.
- U-CH-018: the missing 'Use Auto mode' / 'Managed files' controls block CH-16 here; it did not affect approvals (CH-9, CH-10), which run through another route.
- U-CH-014 ('How this decision works' under the buttons): seen on the danger card, not a problem on its own.
- U-CH-001 (sticky 'You asked' bar overlaps the first line of the transcript): seen again at 1440x900 on the plan answer, where it covers the line carrying 'cowork.plan.work.synthesize'.
- U-IN-001 (Inbox row for a shell approval does not say what it would run): seen again ('Review shell exec', no command) next to a Chat card that does show the command.
- U-ST-001: Chat approvals in a workspace other than `default` are not affected (CH-9, step 6).

## Design decisions to confirm
- Danger-level approvals take two clicks. DESIGN.md:60 specifies it: a safe or caution approval is a primary 'Approve once'; a danger or nuclear approval is a red, risk-labelled review button, and nuclear adds a typed confirmation. That conflicts with the operator's standing preference of one click in place. The card already shows the exact command, and a one-click path for danger already exists in the code: `reviewedInPlace` (`RiskApprovalAction.tsx:43-46`, used at `:102-103`) approves in one click where a surrounding dialog already shows the review. Chat could use it and keep the typed confirmation for nuclear. That needs a DESIGN.md change, so it is the operator's call. Measured: danger = 2 clicks, caution = 1 click, Deny = 1 click, nothing needed after the final click (no Continue, no Inbox trip). Not a finding.

## Engineering notes
- The verification route `chat-approval-scenario` (and `chat-code-mode-ran-scenario`) answered 500 `STATE_CONFLICT` 'Session already has one active durable turn admission.' when called within about 4 s after the conversation's own turn finished, and 201 on a retry after a wait. Only a fixture symptom, but it hints that a finished turn's durable admission is released a few seconds after the reply shows.
- A seeded turn that has been approved still shows its tool line as 'Approval needed / Outcome uncertain. Check before retrying.' and the Gateway keeps the turn 'completed'; nothing flips the recorded tool run because no executor exists in the fixture. Not judged as a product defect.
- Seeded turns appear as 'Version 2 of 2' because the fixture adds a second turn under the same conversation; also fixture only.
- The Inbox 'decisions waiting' count included my seeded approvals until I rejected them (reject through the same resolve route); the two seeded approvals were not touched.

## Sandbox artifacts
- The seeded 'Mission Control Verification' project (folder verification/mission-control-next) is not a git repository, because the seeding route created it without the product's project creation, which runs initializeImportedRepo for a local folder without .git (`chat-project-service.ts:243`) and clones GitHub imports. Create worktree therefore fails there and the code workbench cannot make a worktree in this sandbox. Real projects are not affected, except one whose folder has lost its .git or a PC without git.
- Fix round 1 read the sandbox's `chatSkillInstructionsV1Enabled` (false) with one read-only GET of /api/v1/settings; no writes.

## Area: Projects, Inbox and Work (journeys/task-8.md)

# Task 8: Projects, Inbox and Work

Live runs: Playwright 1.58 headless, 1440x900 dark, sandbox testbench Gateway (auth mode `none`, stub model `verification-stub-chat`). Evidence directories: `docs/review/2026-11-usability/evidence/pj/`, `.../in/`, `.../wk/`. Finding ids are those the merge script assigned in the first merge (U-PJ-001 to U-PJ-005, U-IN-007 to U-IN-014, U-WK-011 to U-WK-017). U-PJ-003 was withdrawn in fix round 1 (see Sandbox artifacts); ids are kept stable by the merge script's id map, so U-PJ-003 stays unused.

How the triggers were produced:
- Approvals for the Inbox: my own conversations plus the Gateway's dev route `POST /api/v1/dev/verification/chat-approval-scenario` (as in Task 7; `shell.exec` = danger, `code_mode.request` = caution), and two approvals that needed no dev route: a Safe 'Search code files' approval raised by my own test message in a project conversation (a test artifact, see Sandbox artifacts), and an install-wide Danger 'Turn on skill' approval raised by switching a skill on in Capabilities.
- Runs for Work: the same dev route parks a Chat turn on its approval, which gives a real durable run in state Waiting (pause, resume and cancel were run on those). The dev route `durable-recovery-seed` gave a dead-lettered and an orphaned run (workspace-less, see IN-2). No model-free way to get a Failed non-Chat run was found, so Retry was not run.
- Schedules: a real schedule with the expression `* * * * *` and Action Task fired about 18 s past every minute, so "see that it ran" was observed.

## PJ-1 Create a project, add files, start a conversation in it, switch projects
Result: PARTLY RUN (project created, conversation started, projects switched; "add files" not available in this sandbox)
Findings: U-PJ-001, U-PJ-002, U-PJ-004. Also U-CH-018 (the Managed files control behind it never appears: 'Approval mode unavailable / Retry'), U-CH-037 (no worktree in a folder that is not a git repository, not tried again).
Time: first feedback on Create project: the button reads 'Saving project...' at once and the project page was open within the 2.5 s window of the script (not timed to the millisecond); 'New conversation in project' to the open thread 99 ms; stub reply in the project thread: none, the thread stopped on a Search code files approval (a test artifact of my message text, see Sandbox artifacts).
Code path: `apps/mission-control-next/src/cockpit/areas/chat/ChatProjects.tsx` (list, filter, route /chat/projects/<id>) -> `ProjectEditor.tsx` (`createChatProject`) / `ProjectDetail.tsx` (`createChatSession` with projectId; archive and restore with a review dialog) / `ProjectImport.tsx` (import a local folder or a Git repository, review dialog) -> Gateway `/api/v1/chat/projects*` -> `packages/storage/src/chat-project-repo.ts` (`sanitizeWorkspacePath`). Files: `ChatManagedFiles.tsx` (Managed files dialog: lists files the assistant saved, Restore, Download, Publish; nothing to add a file by hand).
Live:
1. Chat > Projects: one seeded project, 'Pick up where you left off' with three conversations, 'Import project source' (closed), search, All / Pinned / Active / Archived. New project opens an inline form (Project name, Workspace path, Project description, Project color) with no hint for the path (U-PJ-001).
2. Empty submit: 'Project name and workspace path are required.' Path '../../outside': 'workspacePath must be relative and jailed Your draft is preserved...' (U-PJ-001). Path 'C:/Windows/Temp/x': created, no complaint (U-PJ-002; archived again afterwards).
3. Name 'review-task-8-project', path 'review-task-8/demo': created and opened on its detail page (name, description, 'Active project', Workspace path, Pin / Edit / Archive / New conversation in project). The editor intro and archive dialog print the raw workspace id (U-PJ-004).
4. 'New conversation in project' opened 'Chat - review-task-8-project' in 99 ms with the project named under the title. My first message ('review-task-8 hello from the project') stopped on 'Waiting on you: approval' for a Search code files approval on the project folder; that is a test artifact (see Sandbox artifacts), not a finding.
5. Switching: the project list shows all three; opening the seeded project works; in Chat the Project filter (All projects / Unassigned / each project) narrows the conversation list in about 1 s. The open thread stays the previous project's conversation while the filter shows another project's list (the control is labelled only 'Project', the selected name is cut to 'Mission Control V'). Keyboard: Projects button reached with Tab and opened with Enter.
6. Archive project: 2 clicks (Archive project, Confirm archive), dialog says what it does ('This does not delete it or its conversations').
Failure tried: a path outside the workspace (step 2).
Evidence: pj-0-projects.png, pj-1-create-form.png, pj-1-empty-submit.png, pj-1-bad-path.png, pj-1-absolute-path.png, pj-1-created-detail.png, pj-1-conversation-in-project.png, pj-1-project-reply.png, pj-1-projects-list-three.png, pj-1-other-project.png, pj-1-chat-filter-project.png, pj-1-chat-filter-seeded.png, pj-1-archived.png.
Not covered: adding files. The only Cockpit paths are Import project source (copies a local folder or clones a repository; not run, it writes outside the sandbox project) and Managed files, which needs Chat 'Auto' approval mode; the mode request returns 403 in this sandbox (auth `none`, see Engineering notes). Operator steps with a real install: Projects > Import project source > Local folder > a folder path > Review project import > Confirm project import; or in a project conversation turn Auto mode on and ask the assistant to save a file, then open Managed files.

## PJ-2 Open, edit and save a project file; leave with unsaved changes
Result: PARTLY RUN (no screen opens a project file for editing outside a Code Mode run; the leave guard was tested on the project editor)
Findings: U-PJ-005. Also U-CH-037 (the Code workbench's file editor needs a worktree; none can be created in this sandbox project).
Time: Edit project > Save project about 1.5 s to the page showing the saved description; 'Review conversation assignment' not used.
Code path: `ProjectDetail.tsx` (Edit project) -> `ProjectEditor.tsx` (`useSessionDraft`, `useDraftLeave`) -> `features/native-routes/library/DraftLeaveDialog.tsx`, `use-form-dirty.ts` (beforeunload listener at line 275). File editor: `features/threaded-surface/workflow/CodeWorkbenchEditorPanes.tsx` (reached from a Code Mode run in Chat).
Live (each with a typed, unsaved description change):
1. Sidebar click (Inbox): 'Unsaved changes. You have unsaved changes in review-task-8-project. Keep draft and close / Discard changes / Cancel'; the page does not move until a choice is made.
2. Browser Back: the same dialog, URL unchanged.
3. 'All projects' button: the same dialog.
4. Reload (Playwright dialog event): a `beforeunload` prompt; choosing Stay keeps the page and the typed text; choosing Leave reloads and the draft is gone (Edit project opens with the saved text).
5. Tab close (`page.close({ runBeforeUnload: true })`): a `beforeunload` prompt, the tab stays open when dismissed.
6. 'Keep draft and close' then Back to the project then Edit project: the typed text is there; Save project saved it. Nothing on the project page says a draft exists (U-PJ-005).
Failure tried: leaving with unsaved edits in all four ways above; every one is guarded.
Evidence: pj-2-dirty-editor.png, pj-2-sidebar-leave.png, pj-2-back.png, pj-2-all-projects.png, pj-2-after-reload.png, pj-2-kept-draft.png, pj-2-saved.png, pj-2-leave.json.
Not covered: opening, editing and saving a file of the project. Operator steps with a real install: in a project conversation ask for a change with Code Mode, open the code workbench from the conversation, edit a file, Save, then try Back and a sidebar click with the edit unsaved.

## IN-1 Open the Inbox with pending approvals: read what is asked, approve one, deny one, see the result and where it went
Result: FAIL
Findings: U-IN-007, U-IN-008, U-IN-009, U-IN-010, U-IN-011. Also U-IN-001 (confirmed again, see Notes).
Time: first feedback after the final click 45 ms (caution, 1 click), 85 ms (danger, 3 clicks); done within about 2.5 s (row gone, counts updated, panel 'Decision recorded'). Deny 945 ms to settle (2 clicks).
Code path: `cockpit/areas/inbox/InboxArea.tsx` -> `InboxItemCard.tsx`, `InboxRowDecision.tsx` (inline Approve once and Deny on safe and caution rows), `InboxApprovalDetail.tsx` / `InboxApprovalActions.tsx` (panel, 'Review danger approval' dialog) -> `POST /api/v1/approvals/:id/resolve` -> `approval-lifecycle-service.ts`; list from `GET /api/v1/inbox` -> `apps/gateway/src/services/inbox-projection-service.ts` (titles from `approvalKindWords`, summary from `approvalTargetSummary`).
Live (verification workspace, 6 waiting: three Danger shell rows, one Caution 'Run code', one Safe 'Search code files', one question):
1. Reading: every shell row says 'Review shell exec / Review the requested action and its policy reason. Target details are available in the approval record. / Danger / No expiry time was given.' Three rows are identical except for their age. 'Run code' also has only that sentence (U-IN-009). 'Search code files' names its path.
2. Danger approve: Review (panel opens with Action preview, Scope, Command, Consequence) then 'Review danger approval' then dialog 'Confirm danger-level action' then 'Approve once': 3 clicks, one more than the documented two-step (U-IN-007, polish). Result in the page: 'Approved Review shell exec. Approval effects settled. Linked work has its own execution outcome.', Inbox 6 to 5. The row left the list at once; the 'Selected' mark jumped to another row while the panel kept the decided one (U-IN-008). The panel shows 'Safe' next to a Danger action (U-IN-010).
3. Deny: Review then Deny, 2 clicks; panel 'Decision recorded: Denied ...', count 5 to 4.
4. Caution 'Run code': one click on the row's Approve once, 45 ms to the success line, count 4 to 3.
5. Where it went: Approval history (a disclosure at the bottom of the Inbox) lists 'Run code · Approved', 'Shell exec · Denied', 'Shell exec · Approved' with 'Inspect decision'; the same decisions are on the Chat card. The titles there are only 'Shell exec', so which conversation each was is not on the row.
6. Reload needed? No: a second Inbox page updated from 4 to 3 without a reload (a skill approval decided in the demo workspace also cleared the default workspace's Inbox within 10 s).
7. Default workspace: the Inbox says '1 decision waiting' for an expired change plan that can no longer be decided (U-IN-011).
8. Expiry seen by accident: the Safe approval expired after 15 minutes; the Inbox moved it to history ('Expired without an operator decision. Approval <id> expired before operator resolution.', the id sits in plain text) and the Chat card showed 'Expired without an operator decision'.
Failure tried: an approval left to expire (step 8).
Evidence: in-0-ver.png, in-0-default.png, in-1-list-before.png, in-1-danger-review.png, in-1-danger-dialog.png, in-1-danger-after-approve.png, in-1-deny-step.png, in-1-caution-after.png, in-1-history.png, in-1-expired-chat.png, in-1-flow-a.json, in-1-flow-b.json.
Not covered: what the turn does after an approval (the fixture has no model to resume), danger approvals from a real tool call, nuclear risk (typed confirmation).

## IN-2 An approval with no workspace: is it visible anywhere
Result: PARTLY RUN (install-wide approval run end to end; a linked approval that names no workspace could not be produced without a model)
Findings: U-IN-012, U-IN-013 (polish, likely: depends on a dev fixture).
Time: n/a (visibility check). Switching a skill on to the approval being listed in every Inbox: about 2.5 s.
Code path: `isInstallWideApproval` (`packages/contracts/src/approvals.ts`: install-wide only when the approval has no linkage; 'A linkage that exists but names no workspace is not install-wide') -> `packages/storage/src/approval-repo.ts` `listPage` (`includeInstallWide`) -> `inbox-projection-service.ts` (approvals collected with `includeInstallWide: true`, source `installWide: true`; dead letters and durable runs are dropped when `runWorkspaceId(run)` is not this workspace, line 557).
Live:
1. Default workspace > Capabilities > Skills: switch 'documentation' off (about 1.8 s, no approval), then on: a 'Approve skill state change / Turn documentation on / Danger / Approve once / Deny' dialog appears over the page, with a toast 'Turn on skill bundled:documentation / Applies to every workspace' and 'Open Inbox item' (U-IN-012). The approval's linkage is null (checked through the Gateway).
2. The Inbox of the default, verification and demo workspaces each listed exactly one row 'Turn on skill bundled:documentation / Applies to every workspace. / Danger / Expires in 15 minutes' (Inbox counts 2, 4, 2).
3. Decided from the demo workspace: Review then Approve once, 2 clicks; the default Inbox dropped its row without a reload. The skill is On again (checked in Capabilities).
4. The linked-but-workspace-less case: the seeded shell approval has a linkage without a workspace id in the Gateway's list yet shows in the verification Inbox only, so the Gateway resolves it some other way (not traced). No product action found that produces one without a model.
5. A workspace-less dead-lettered run (dev fixture) is not in any Inbox; the Inbox says 'Dead letters without a readable scoped run were omitted' and its Work page is a dead end (U-IN-013). System > Diagnostics ('unresolved recovery records') is the only place that might list it; not followed through.
Failure tried: the workspace-less dead letter (step 5).
Evidence: in-2-capabilities.png, in-2-skills.png, in-2-skill-toggle.png, in-2-skill-on-request.png, in-2-inbox-default.png, in-2-inbox-verification.png, in-2-inbox-demo.png, in-2-visibility.json, in-2-skill-review-panel.png, in-2-skill-after-approve.png, in-2-approve.json, in-2-system-diagnostics.png, in-1-coverage-warning.png, wk-2-run-5d869f5c-7a82-4ff1-844c-84cca17.png.
Not covered: an approval whose linkage exists but has no workspace id. Operator steps: raise an approval from a code path that links a session but not a workspace (none was found) and open the Inbox of each workspace.

## IN-3 Notification from the Inbox to the thing that raised it, and back
Result: FAIL
Findings: U-IN-014. Also U-IN-006 (confirmed again: after the round trip the Inbox is back on the list with the panel closed and no item selected).
Time: 'Open source conversation' to the Chat thread with its approval card 2,665 ms; 'Open in Work' to the task page 2,265 ms.
Code path: `InboxSourceContext.tsx` ('Show source context', panel links), `InboxOwnerLink.tsx` (Open in Work) -> `/chat?sessionId=...` and `/work/tasks/<id>?taskId=...&workspaceId=...` -> back via browser history.
Live:
1. Safe approval row > 'Show source context' expands the last stored message ('You . 11:07 PM / review-task-8 hello from the project').
2. Details opens the panel; its link 'Open source conversation' opens the project conversation with the same approval card (Approve once / Deny); Back returns to /inbox with nothing selected (U-IN-006).
3. 'Open approval' on the row loads /inbox?approvalId=...&sessionId=...&turnId=...&runId=...&workspaceId=... , the same list (U-IN-014).
4. An update row 'Verification prompt-pack quality evidence' > 'Open in Work' opened the task, with the deliverable listed; Back returned to the Inbox; the update still counts as unread (read status is its own manual action).
Failure tried: Back after each hop.
Evidence: in-3-source-context.png, in-3-details.png, in-3-source-conversation.png, in-3-after-back.png, in-3-open-approval.png, in-3-flow.json, wk-1-seeded-task.png.
Not covered: a notification for a failed run or a question.

## WK-1 Create a task on the Board, move it, open its run, read its history
Result: FAIL
Findings: U-WK-015, U-WK-016. Also U-WK-001 and U-WK-005 (both confirmed live, see Notes).
Time: New task > Create task to the task page about 1 s; Save task status to 'Task moved to In progress' under 300 ms.
Code path: `cockpit/areas/work/WorkTaskCreate.tsx` -> `WorkTaskDetail.tsx` (`TaskStatusControl.tsx`, `TaskAssignmentControl.tsx`, `TaskDetailsEditor.tsx`) -> `/api/v1/tasks*`; run pages `WorkRunDetail.tsx`; history `WorkHistory.tsx`, `work-board.ts` (`workRunTitle`).
Live:
1. Work board: 'Waiting on your decision' (two approvals with 'Review current decision' and 'Open run'), then lanes Active / Needs attention / Failed runs / Done mixing tasks and runs.
2. New task: Title, Description, Priority; the form says 'Creating a task does not start a run.' Create task opened the task page. Status control: Planning, Not started, Assigned, In progress, Testing, In review, Blocked. Chose In progress, Save task status: 'Task moved to In progress. This board change does not control an execution.' and the board put it in the Active lane at once.
3. Done: the status list has no Done. Text under it: 'Done requires at least one recorded deliverable. The option appears once one is recorded.' The page has no control to record a deliverable; the Deliverables section reads 'No deliverables were returned.' (U-WK-001 confirmed; U-WK-016).
4. A task has no 'Start run' either; runs come from Chat turns and schedules. The seeded 'In review' task says 'A run is handling this task. Review its run before changing execution state.' with only 'Open linked conversation', no run link (U-WK-005 confirmed). Runs are opened from the board cards or from History.
5. History: '36 saved runs loaded', most titled 'Workflow run' or 'Chat turn' (U-WK-015); a done run page shows 'Run woken / Run started / Run completed'.
Failure tried: trying to reach Done (step 3).
Evidence: wk-0-board.png, wk-1-new-task-form.png, wk-1-after-create.png, wk-1-task-detail.png, wk-1-after-status.png, wk-1-board-after.png, wk-1-seeded-task.png, wk-1-history.png, wk-1-done-run.png.
Not covered: opening 'its run' from a task (no link exists), a task the assistant created in Chat.

## WK-2 Pause, resume, cancel and retry a run; the buttons say what each will do
Result: PARTLY RUN (pause, resume, cancel run; retry not run)
Findings: U-WK-011. Also U-WK-004 (see Notes).
Time: first feedback after the confirm click 79 ms (pause), 92 ms (resume), 83 ms (cancel); each action is 2 clicks (button, then 'Pause run' / 'Resume run' / 'Cancel run').
Code path: `WorkRunControls.tsx` (`canControlWorkRun` in `work-run-control-guard.ts`: pause for queued, running, waiting; resume for paused; cancel for queued, running, waiting, paused; retry only for failed non-Chat runs below their attempt limit) -> `pauseDurableRun`, `resumeDurableRun`, `cancelDurableRun`, `retryDurableRun` -> `/api/v1/durable/runs/:id/*`.
Live (Chat turn runs parked on a Code Mode approval):
1. Waiting run: Pause and Cancel. Dialog 'Pause this run? Stops active processing and leaves the run paused. GoatCitadel will recheck policy and state.' Confirm: 'Run moved to Paused.' and no buttons until Refresh (U-WK-011).
2. After Refresh: Resume and Cancel. Resume dialog 'Queues a paused run to continue.' Confirm: 'Run moved to Queued' with the badge Waiting.
3. Cancel on a second run: dialog 'Stops this run. Completed external effects may remain.' with 'Keep running' as the way out. Result Cancelled, 'No direct control is available from this run state or workspace.' The linked approval was rejected by the cancel (checked through the Gateway), so nothing is left waiting in the Inbox.
4. The dead-lettered and orphaned fixture runs (no workspace) open to 'Run workspace unknown' with no controls (U-IN-013), so Recover could not be tried.
Failure tried: cancelling a run that is waiting on an approval (step 3), fine.
Evidence: wk-2-run-page.png, wk-2-pause-dialog.png, wk-2-pause-after.png, wk-2-resume-dialog.png, wk-2-resume-after.png, wk-2-cancel-dialog.png, wk-2-cancel-after.png, wk-2-A.json, wk-2-B.json.
Not covered: Retry (needs a Failed run that is not a Chat turn; a Failed Chat turn answers 'This Chat reply can't be retried from here. Send the request again in its conversation.' in code, not seen live) and Recover. Operator steps: with a real model, start a supervised plan that fails, open its run in Work, press Retry, read the dialog ('Steps and external effects may run again') and confirm.

## WK-3 Create a schedule, edit it, see when it next runs, see that it ran
Result: FAIL
Findings: U-WK-012, U-WK-013, U-WK-014. Also U-WK-010 (see Notes).
Time: Create schedule to the card in the list about 1.6 s; the first run came at 18 s past the next minute; Edit: Review schedule changes then Save schedule changes, 2 clicks, 207 ms to 'Schedule settings saved and independently verified. Execution has not been verified.'
Code path: `WorkSchedules.tsx` -> `WorkScheduleCreateForm.tsx`, `WorkScheduleEditor.tsx`, `WorkScheduleInspector.tsx`, `WorkScheduleSummary.tsx` (`ScheduleTime`) -> `/api/v1/cron/jobs*` -> cron service.
Live:
1. Schedules: seven installation-wide jobs. 'Cost Report Hourly' says 'Next run: 20 minutes ago' while Enabled; four enabled jobs say 'Next run: Not reported' (U-WK-012, U-WK-013).
2. New schedule: Name, Frequency (Every day, Weekdays, Every hour, Custom expression), Time, Timezone (a list of about 450 names), Action (Task, Improvement, Backup, Memory flush, Cost report, Update review, Watchdog). Chose Custom expression `* * * * *` (preview 'Every minute'), Action Task, Create schedule: card 'Enabled / Every minute / Next run: just now / Last outcome: Succeeded'.
3. It really fired: lastRunAt 07:23:18, 07:24:18, 07:25:18, 07:26:18 UTC (Gateway), one 'review-task-8-schedule' task per run in the Default workspace only (U-WK-014). The card's 'Next run' at 07:26:21 read 'just now' while the next run was 39 s away (U-WK-012).
4. Edit: renamed it; dialog 'Save schedule changes? ... Review expires after one minute.' Pause: dialog 'Pause stops future occurrences; it does not cancel a running job.' Card 'Paused / Next run: Paused'. Delete: 'Delete permanently removes the schedule ... it can't be restored.' then 'Schedule deleted.'
Failure tried: Run now was not pressed (it would add one more task); the edit and pause dialogs expire after one minute, not waited out.
Evidence: wk-3-schedules.png, wk-3-new-schedule-form.png, wk-3-custom-expression.png, wk-3-after-create.png, wk-3-review-schedule.png, wk-3-next-run-label.png, wk-3-edit-dialog.png, wk-3-edit-after.png, wk-3-pause-dialog.png, wk-3-paused.png, wk-3-delete-dialog.png, wk-3-board-default.png, wk-3-board-verification.png, wk-3-edit-pause.json.
Not covered: a schedule whose action is not Task (Backup, Memory flush and the others act on the installation), the review dialog expiring.

## WK-4 Archive and restore a task; open the Automation designer and the older Kanban view
Result: PASS (archive, restore and the Automation designer preview all worked first time; the older Kanban opened as documented; existing findings U-WK-002 and U-WK-003 and new polish U-WK-017 are listed, none stops or stalls the journey)
Findings: U-WK-017 (polish). Also U-WK-002, U-WK-003, U-WK-010 (see Notes).
Time: archive 1,553 ms and restore 1,537 ms from the confirm click to the verified message; each is 2 clicks.
Code path: `WorkArchive.tsx` ('Task list' select: Archived tasks / Active tasks to archive) -> `/api/v1/tasks/:id` archive and restore; `WorkAutomation.tsx` (recipe preview only); `WorkKanban.tsx` via the Work header menu 'More' > 'Older Kanban view' (`WorkMoreViews.tsx`, route /work/kanban).
Live:
1. Archived tasks > Task list > 'Active tasks to archive': each task has 'Review archive'; tasks owned by a run show it disabled with 'A run or background job manages this task, so it can't be archived or restored here.'
2. Review archive > dialog 'This task leaves active task lists. You can restore it from Archived tasks.' > Archive task: 'Task archived and independently verified. Restore it from Archived tasks.' Restore: 'Task restored and independently verified.'
3. Automation designer: Task description, Trigger, Frequency and timezone intent, Success criteria, Constraints; Preview automation recipe gives a recipe, 'No schedule was created and no job ran.', links to copy Activepieces and n8n templates (U-WK-017).
4. Older Kanban: reached with More (keyboard: ArrowDown, Enter) or /work/kanban. It marks itself 'Experimental' and groups the tasks differently from the Board: 'Review task board and agent board cohesion' is 'Failed / Run failed' there and In progress on the Board.
Failure tried: archiving a run-owned task (step 1, refused with a reason).
Evidence: wk-4-archive-page.png, wk-4-archive-active.png, wk-4-active-list.png, wk-4-archive-dialog.png, wk-4-archive-after.png, wk-4-restore-after.png, wk-4-archive-restore.json, wk-4-automation.png, wk-4-automation-preview.png, wk-4-kanban.png, wk-4-select-mode.png.
Not covered: restore of a task archived by another session.

## Notes on existing findings
- U-WK-001: confirmed live. A new task offers Status Planning to Blocked; under it 'Done requires at least one recorded deliverable. The option appears once one is recorded.' The page has no add-deliverable control and the Deliverables section says 'No deliverables were returned.' The sentence names the rule but not how to satisfy it. Suggested severity stall (keep).
- U-WK-005: confirmed live on the seeded 'In review' task: 'A run is handling this task. Review its run before changing execution state.' with only 'Open linked conversation'. Suggested severity friction (keep).
- U-WK-004: a Waiting run page ends with 'Recorded run errors: 1 recorded error needs review. Turn: Waiting for verification approval.' so an approval wait is listed as an error (the fixture writes that failure record; a real approval stop writes the same failure class). Suggested severity friction (keep).
- U-WK-003 and U-WK-002: the Older Kanban says 'Review task board and agent board cohesion: Failed, Run failed' and 'Validate the new Chat/Cowork/Code shell: Stale' for tasks the Board lists as In progress and Planning. Suggested severity friction for U-WK-003 (keep).
- U-WK-010: each of edit schedule, pause, resume, delete, archive and restore (task and project) takes a review dialog, so 2 clicks. The dialogs are well written (scope, consequence, undo). Suggested severity polish unless the operator wants one-click with undo for the reversible ones.
- U-IN-001: three rows 'Review shell exec' in one Inbox were told apart only by age; U-IN-009 is only the one-click approval of the Run code row without a description of the code. Suggested severity friction (keep).
- U-IN-006: confirmed again (IN-3 step 2).
- U-CH-018: confirmed to block the Managed files control in project conversations (PJ-1 Not covered).

## Design decisions to confirm
- DESIGN.md (Decisions and danger): a danger approval opens a review. In the Inbox that review comes after a row 'Review' click that opens the panel, so danger approval is 3 clicks there and 2 in Chat (U-IN-007, polish, is filed for the one click the document does not specify). Decide whether the row's own button can open the confirmation directly.
- The same document gives approvals a risk-scaled button, yet 'Turn on skill documentation' is a Danger approval that is one click in the Capabilities dialog and two in the Inbox, with no danger review step. Decide which of the two behaviours is meant for install-wide skill changes.
- Reversible actions (archive, restore, pause, resume) each go through a review dialog, while 'Cancel a run' is also reversible per DESIGN.md. If the operator's one-click preference applies to them, a toast with Undo would replace the dialogs (U-WK-010).

## Engineering notes
- Under auth mode `none` the Gateway never treats a request as a direct local operator (`session-control-request-context.ts:154` sets `directLocal` only when `authActorSource !== "none"`), so `GET /api/v1/chat/sessions/:id/approval-mode` is always 403 and the 'Approval mode unavailable / Retry' strip and the Managed files control can never work in this mode (`chat.sessions.ts:29-33`). Task 6 classifies this.
- Dev route `durable-recovery-seed` creates approvals without linkage and runs without a workspace; every Inbox then carries the 'Dead letters without a readable scoped run were omitted' warning for the rest of the sandbox's life.
- My script for IN-2 clicked a second 'Approve once' after the skill approval had been decided; that was the inline button of the seeded 'demo.first_run' approval in the demo workspace, which is now Approved. This was my script's mistake, not a product defect. The other seeded approval (shell.exec in the verification workspace) is still pending.
- The sticky 'You asked ...' bar at the top of a Chat thread overlaps the first lines of the tool summary above the approval card (visible in pj-1-project-reply.png); left for Task 6.

## Sandbox artifacts
- Withdrawn finding U-PJ-003 ("a plain greeting in a project conversation stops on an approval to search the project folder"). It came from my own test string, not from the product. The message was 'review-task-8 hello from the project'. `promptLabTaskSuggestsRepoInspection` (chat-turn-agent-runner.ts:14593-14612) matches `\b(review)\b[\s\S]{0,40}\b(project)\b`, which sets `promptLabRepoInspectionAssist` (line 2435) and lets the controller-driven code search run (lines 3500-3513); that block runs only when the model returned no content, which the stub's tool-less turn satisfies. A plain 'hello' does not match, and a real model that answers does not reach the block. Checked by opening those lines. The Safe 'Search code files' approval it raised was still used as a model-free approval for IN-1 and IN-3, and its card shows that approvals of this kind carry the full local path (a design fact, not a finding).

## Engineering notes (added in fix round 1)
- A sentence containing 'review ... project' (also inspect, audit, trace, analyse, read, check, identify, find within 40 characters of repo, repository, codebase, workspace or project) can raise a controller-driven code search and its approval when the model returns nothing. With a real model that answers, the block is not reached; if a real model returns an empty turn for such a sentence, the operator would see the same approval for a search term picked by keyword rules (the term was 'approval' here).

## Area: Capabilities and Library (journeys/task-9.md)

# Task 9: Capabilities and Library

Live runs: Playwright 1.58 headless, 1440x900 dark (CP-1 and CP-3's list also at 375x812 light), sandbox testbench Gateway (auth mode `none`, stub model). Evidence: `docs/review/2026-11-usability/evidence/cp/` and `.../lb/`. New findings are U-CP-004 to U-CP-012 and U-LB-008 to U-LB-016 (after the review fixes the findings referred to here as U-CP-008, U-CP-009 and U-CP-010 carry new titles and will get new ids when the controller re-merges; they are identified by journey and topic in this file). Carried findings in these areas before this task: U-CP-001 to U-CP-003 and U-LB-001 to U-LB-007 (none duplicated).

Setup and cleanup notes:
- Skill and plugin approvals raised from the `default` workspace and, once, from the verification workspace (CP-1) were approved in place from either: confirmed that skill approvals are install-wide and work from a non-default workspace.
- Every Approve once / Deny click was scoped to the card or dialog of the approval my own action raised (matched on its title, skill name or memory id).
- Fixtures: a local plugin folder (one skill `meeting-notes`, one prompt pack) and a 20-line stdio echo MCP server, both under the git-ignored scratch folder; one throwaway memory item created through the dev route `memory-item-seed` (same route `tools/seed.mjs` uses) and then edited and forgotten through the UI.
- Sandbox values read before LB-1: `GET /api/v1/settings` returned `features.memoryLifecycleAdminV1Enabled = true` (tools/seed.mjs lines 64-69 patch it on), `chatSkillInstructionsV1Enabled = false`, `chatStaticMcpV1Enabled = false`.

## CP-1 Skills: find a skill, switch it on, use it in Chat, switch it off
Result: PARTLY RUN
Findings: none new. The Chat half is blocked by the existing finding "On a default install, typing 'use <skill>' in Chat does nothing and says nothing" (task-7); see Notes on existing findings. Approval of switching a skill on is in place (one click), no Inbox trip.
Time: first feedback on switch off 151 ms; switch on: the in-place approval dialog was open within the 2.7 s window of the script, Approve once to the row reading On 243 ms. Not timed to the millisecond.
Code path: `capabilities/skills/SkillsTab.tsx` -> `InstalledView.tsx` / `SkillRow.tsx` / `SkillPanel.tsx` -> `use-skill-switch.ts` -> `POST /api/v1/capabilities/skills/state` (`apps/gateway/src/routes/capability-skills.ts:182`) -> `capability-skill-actions-service.ts`; approval shown by `settings/SettingsApprovalDialog` from `SkillPanelSwitch.tsx`.
Live:
1. Capabilities opens on Connectors the first time (DEFAULT_TAB); Skills tab > Installed lists 24 skills, all On except `genie-npu-ir20` ("Not usable yet - It hasn't been reviewed, so the AI can't use it", its switch still reads On).
2. Typed 'debug' in the search field (about 0.8 s to filter), View debugging: side panel with On badge, 'Turn it on or off', 'Takes effect in new chats.', Pause, Uses, Tags, Instructions.
3. Switched it off: applied at once, no approval, badge Off 'The AI can't use it' (151 ms). Switched it on: row goes 'Waiting for your approval', a toast 'Turn on skill bundled:debugging - Applies to every workspace - Open Inbox item' and an in-place dialog 'Approve skill state change - Turn debugging on - Danger' open. Approve once: row On in 243 ms.
4. Reload while the approval waited: the dialog reopens by itself but with a vaguer title ('Change debugging' instead of 'Turn debugging on'). Pause is instant with no approval ('Used when you name it, or on a close match if you allow it'); Resume asks for a Danger approval again (approved in place).
5. Keyboard: from the verification workspace focused the `planning` switch, Space switched it off, Space again raised the approval, approved in place, On. Skill approvals work from a non-default workspace.
6. Phone width, light theme: list and panel fit (scrollWidth 375), switch 44 px.
Failure tried: reload with an approval waiting (step 4); search with no match not tried.
Evidence: cp-1-search.png, cp-1-panel.png, cp-1-switch-off.png, cp-1-switch-on-approval.png, cp-1-reload-while-waiting.png, cp-1-switched-on-again.png, cp-1-paused.png, cp-1-other-ws-approval.png, cp-1-other-ws-final.png, cp-1-phone-light-list.png, cp-1-phone-light-panel.png.
Not covered: "use it in Chat" (skill instructions in Chat are off by default; no Cockpit screen turns them on). Operator steps: set `features.chatSkillInstructionsV1Enabled` true through the Settings API or `GOATCITADEL_FEATURE_CHAT_SKILL_INSTRUCTIONS_V1_ENABLED`, restart, type `use debugging` in Chat with a real model.

## CP-2 Import a skill from a folder and from a Git source; an import that collides with an existing id
Result: PARTLY RUN
Findings: U-CP-004 (the collision, reached through a plugin that carries a skill). Also carried: U-CP-001 not reached.
Time: Git address refused in 2.5 s watched window (browser-side refusal instant; Gateway refusal after one POST); plugin folder check 1076 ms.
Code path: `skills/SkillGitImport.tsx` (`sendableAddress`: https only, no credentials) -> `use-skill-install.ts` -> `POST /api/v1/capabilities/skills/reviews` -> `capability-skill-actions-service.ts` `trustedGitAddress` (host must be GitHub, GitLab, Bitbucket or Codeberg; refused before any network read). Discover packs: `DiscoverView.tsx` -> `SkillInstallPanel.tsx` (Check, Install, Switch on).
Live:
1. Skills tab has Import from Git, no import from a folder. The only folder import in the Cockpit is Plugins > Add from folder, and the only other route to a skill is Discover > Install of a listed pack. A skill folder dropped into a workspace's skills folder is described only as an origin label ('From this workspace's skills folder'); no screen says where that folder is.
2. Import from Git: 'Git repository address - From GitHub, GitLab, Bitbucket or Codeberg'. `/home/x/skill` and `http://example.invalid/skill.git` refused in the browser ('Enter an https address, like https://github.com/name/repo.'). `https://example.invalid/skill.git` went to the Gateway (422 on `/skills/reviews`) and came back 'GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg.' without any fetch. Clear, with a next step.
3. Discover > Install on a GoatCitadel pack (GitHub gh CLI) ran its check in a few seconds and showed What it does / Where it comes from / What it asks for / Checks / What happens next ('Asks you twice') / Progress and 'Install and switch on'. Not installed: no Cockpit screen removes a skill afterwards, so it would have left a permanent skill in the sandbox.
4. Collision: with the first plugin uninstalled (CP-3), a second local plugin folder holding the same skill name was checked: the skill row says 'This skill was removed with an earlier install. It can't come back until skills can be removed.', the plugin 'So it can't be installed.', no Install button. The refusal is clear and names the cause; the earlier promise is not (U-CP-004).
Failure tried: untrusted Git host; a skill name already used.
Evidence: cp-2-git-panel.png, cp-2-git-refused.png, cp-2-pack-panel.png, cp-2-collision-check.png.
Not covered: import from a skill folder (no Cockpit screen), successful Git import (needs the internet; operator steps: Import from Git with a public GitHub skill repository, Check, Install and switch on, approve twice), a plain id collision between two skills (same cause as step 4).

## CP-3 Plugins: inspect, install, see what it added, uninstall (including the second uninstall when its skill is on)
Result: PASS for install; FAIL overall on uninstall guidance
Findings: U-CP-004, U-CP-005, U-CP-006. Also noted: the built-in 'Browser checks' plugin was inspected (adds the Playwright connector, which names registry.npmjs.org) and not installed, to avoid a download.
Time: Add from folder to checked panel 1076 ms; Install: first dialog at 562 ms, all three approvals done and 'Review task 9 plugin is installed.' at about 13.6 s (5 s of 'Asking...' between the second and third approval); uninstall first dialog 580 ms, second pass 518 ms.
Code path: `plugins/PluginsTab.tsx` -> `PluginSourceForm.tsx` -> `POST /api/v1/capabilities/plugins/inspections` -> `PluginInstallPanel.tsx` / `PluginInstallProgress.tsx` (in-place `SettingsApprovalDialog`) -> `plugin-source-service.ts` (folder source) and `capability-plugin-inspection-service.ts`; uninstall `PluginUninstall.tsx` -> `use-plugin-uninstall.ts` -> `plugin-uninstall-change-plan-adapter.ts`.
Live:
1. Plugins tab: search, Install from Git, Add from folder, 'No plugins yet', one Built in plugin (Browser checks, Ready to install).
2. Add from folder, relative path: 'Give the full path of a folder on this computer.' (browser-side, with help 'A folder on the computer GoatCitadel runs on'). Full path of a local folder: panel with What it is, Where it comes from ('Folder on this computer - Unverified - GoatCitadel hasn't reviewed this plugin'), What it adds (Skill meeting-notes, Prompt pack 'Meeting notes check 1.0 - Adds 2 tests to Library > Prompt packs. Nothing runs until you press Run.'), 'Asks you 3 times: once for the plugin and twice for its skill'.
3. Install: three in-place approvals ('Install Review task 9 plugin' Danger, 'Approve installing meeting-notes?', 'Approve switching on meeting-notes?'), all approved in place, no Inbox trip. Panel ends 'Review task 9 plugin is installed.'
4. What it added really appears: Skills list has `meeting-notes` 'From Review task 9 plugin' On; Library > Prompt packs has 'Meeting notes check 1.0 - 2 tests' beside the seeded pack.
5. Uninstall (skill on): confirmation 'This can't be undone here. Installing it again adds its pieces back.' > approval 'Delete the prompt pack ... Remove the skill meeting-notes' (Caution, in place) > badge 'Removing...' with both pieces Removed and a red 'Finish uninstalling' (U-CP-006) > second approval 'Remove the skill meeting-notes, so the AI can't use it' > plugin gone from the list. The skill stays in the Skills list as 'Removed with Review task 9 plugin' (U-CP-005). Reinstall: re-adding the original plugin was not run. A second plugin, B (another plugin id, same skill name `meeting-notes`, its own prompt pack), was added from a folder after the first was gone and was refused at the check: the skill row says 'This skill was removed with an earlier install. It can't come back until skills can be removed.' The refusal is about the skill's name, which the original plugin carries too, so it is equivalent for the original (U-CP-004).
6. Install-wide approvals confirmed from `default`; plugin approvals not raised from another workspace.
Failure tried: relative folder path; adding a second plugin with the same skill name after the first was uninstalled.
Evidence: cp-3-folder-refused.png, cp-3-folder-checked.png, cp-3-install-panel.png, cp-3-approval-1.png to cp-3-approval-3.png, cp-3-after-install.png, cp-3-plugin-list.png, cp-3-skill-in-list.png, cp-3-pack-in-library.png, cp-3-uninstall-1.png, cp-3-uninstall-dialog-1.png, cp-3-uninstall-dialog-3.png, cp-3-plugins-after-uninstall1.png, cp-3-removing-panel.png, cp-3-skill-after-uninstall1.png, cp-3-finish-dialog.png, cp-3-finish-after.png, cp-3-phone-light-plugins.png.
Not covered: a Git plugin (internet), the built-in Browser checks install (would register a connector that names registry.npmjs.org). Left in the sandbox: the skill row `meeting-notes` ('Removed with Review task 9 plugin'), which no screen removes.

## CP-4 Connectors: add a connector from a template up to the credential step with an invalid test credential; read the error; remove it
Result: PARTLY RUN
Findings: U-CP-007.
Time: Set up to panel 2.7 s watched window; Advanced setup link to page 3.1 s watched window.
Code path: `connectors/ConnectorsTab.tsx` -> `ConnectorRow.tsx` -> `ConnectorPanel.tsx` (`connector-install-copy.ts`: needs an API key means 'Set it up in Advanced setup') -> link `/capabilities/connectors/advanced#web-search` -> `settings/` web search credentials (`GET /api/v1/settings/web/credentials`).
Live:
1. Connectors lists 1 connected (Firecrawl), 4 on this device, 78 available. Only two rows say 'Needs an API key' (Brave Search, Parallel Search); every MCP template installs by sign-in ('Sign in and install' for Airtable, opens a provider sign-in, not run). The `n8n` token template is not in the list at all.
2. Brave Search > Set up: panel 'Needs an API key', one link 'Advanced setup'. It lands at the top of Web & Search on the Firecrawl settings; the Brave key field is 1518 px down (U-CP-007).
3. The key field is disabled in this sandbox ('The OS keychain is unavailable. Set GOATCITADEL_SEARCH_BRAVE_API_KEY or BRAVE_SEARCH_API_KEY in the GoatCitadel environment instead.'), so no placeholder could be typed; 'Check and save' would also contact api.search.brave.com (`approval-lifecycle-service.ts:1754` names the host), so it was not pressed. Nothing was created or half-configured; nothing to remove.
Failure tried: none possible (field disabled; a live check would leave the PC).
Evidence: cp-4-install-panel.png, cp-4-brave-row.png, cp-4-brave-panel.png, cp-4-advanced-websearch.png, cp-4-brave-anchor.json, cp-4-n8n-panel.png.
Not covered: the credential step and its error. Operator steps: on a host with an OS keychain, Connectors > Brave Search > Set up > Advanced setup, paste a deliberately wrong key into 'Brave Search API key', Check and save, read the refusal (the check is live), then clear it.

## CP-5 MCP: add a static MCP server, see its tools, use one in Chat
Result: PARTLY RUN
Findings: U-CP-008, U-CP-009, U-CP-010, U-CP-011.
Time: Review MCP registration to review dialog 2.5 s watched window; Register to saved confirmation under 1 s; Connect reviewed server answered 500 in 313 ms.
Code path: `ConnectorsTab.tsx` -> `settings/McpServerCreate.tsx` (stdio form: label, transport, command, arguments) -> `POST /api/v1/mcp/servers` -> `connectors/ConnectorPanel.tsx`; Advanced setup `settings/McpServersSettings.tsx` / `McpServerInspection.tsx` -> `POST /api/v1/mcp/servers/<id>/connect-reviewed`. Row state `capability-connectors-projection.ts:275-292`.
Live:
1. The repo's only MCP fixtures (`cockpit-mcp-connection-fixture.mjs`, `worker-mcp-stdio.mjs`) return no tools or are packaging-only, so a 20-line stdio echo server (tool `echo`) was written and registered by command.
2. Add your own > Register MCP server (71 templates, search, category, and 'Allow <host>' buttons beside templates that change the network allowlist) > label, Local process (stdio), command, arguments > Review MCP registration ('This saves a new server for the whole installation. No connection, process launch, OAuth handshake or tool call is performed.') > Register reviewed MCP server: saved, no approval.
3. The row reads 'Connected' (U-CP-008) and 'Connected - not available in Chat'; the dialog stays open with a raw 'Saved server ID' (U-CP-011).
4. Advanced setup > Inspect: '5 steps from setup to a verified task' (Saved, Connected, Discovered, Callable, Tested) and Review connection > Connect reviewed server. It failed (U-CP-009): the cause in this run was the sandbox's missing OS keychain ('OS keychain backend is unavailable on this host', read from the Gateway record). The row said 'open it to see why'; with the default Settings 'Technical details' preference (off) the panel gave no reason and no hint of that preference. Last error appears only in a Technical details block (ConnectorPanelParts.tsx:109); not re-run with the preference on. The 'outcome is unconfirmed ... locked for this app session' message was seen once after the 500, cause not isolated. No tools were discovered, so no tool could be tried.
5. 'Callable: Static MCP in Chat is disabled for this runtime' and, for a hand-registered server, no screen it reaches turns it on (U-CP-010). The Cockpit's one switch for the flag is the pre-ticked 'Also let Chat use connectors' box in a template's install panel (seen on Airtable's panel, not installed; ConnectorInstallPanel.tsx:42, :80-89, connector-install-change-plan-adapter.ts:164). Chat's tool list was therefore not checked.
6. Removed the server: panel Remove > 'This removes it for every workspace on this computer, along with its saved sign-in and keys, its tool list and any approvals waiting on it. ... it can't be undone here.' > confirmed; the list is back to the two GoatCitadel servers.
Failure tried: connect on a host without a keychain (step 4).
Evidence: cp-4-add-your-own.png, cp-5-form-filled.png, cp-5-review.png, cp-5-registered.png, cp-5-row.png, cp-5-panel.png, cp-5-advanced-mcp.png, cp-5-inspect.png, cp-5-inspect-bottom.png, cp-5-review-connection.png, cp-5-connected.png, cp-5-after-error-inspect.png, cp-5-row-after-error.png, cp-5-error-panel.png, cp-5-remove-confirm.png, cp-5-removed.png.
Not covered: seeing tools and using one in Chat. Operator steps: on a host with a keychain and with `features.chatStaticMcpV1Enabled` true (settings API; no screen), register a stdio echo server, Connect reviewed server, confirm the tool appears under 'Cached tool inventory', start a new Chat turn with a real model and ask it to call the tool, approve the first call.

## CP-6 Tools: find a tool, read what it can do and what approval it needs, change its permission
Result: PARTLY RUN (permission is a group switch; a per-tool permission is set in Settings > Safety, not run)
Findings: U-CP-012. Also: tools in the group list their raw names under each friendly title ('browser.search', 'local_business.research', 'citations.build'), part of the design's technical-detail rule, not recorded.
Time: switch off applied within the 2.5 s watched window with no approval; switch on: panel read 'Waiting on you in Inbox' within the same window.
Code path: `tools/ToolsTab.tsx` -> `ToolGroupRow.tsx` / `ToolGroupPanel.tsx` -> `GroupSwitchParts.tsx` -> `use-tool-group-switch.ts` -> change plan -> Inbox approval.
Live:
1. Tools: Essentials (Files, Web search, Memory, Browser, all On) and 'All tools' groups with risk (Danger/Caution), 'No calls yet', counts of tools blocked by other rules. A search ('web search') found the group at once.
2. View Web search: risk Caution, what it does, 'Tools in this group' with each tool's risk and 'Asks first' / 'Not used yet', and 'Detailed rules are in Settings > Safety'.
3. Group switch off: applied immediately, tools read 'Switched off', 'The AI can't use these in any chat.' Switch on: 'Waiting on you in Inbox - Open in Inbox' (U-CP-012); the card 'Switch the Web search tools back on' (Caution) approved in the Inbox with one click scoped to it. Final state On, as before.
4. Approvals raised from `default`.
Failure tried: none beyond the Inbox round trip.
Evidence: cp-6-tools.png, cp-6-group-panel.png, cp-6-off-done.png, cp-6-on-done.png, cp-6-inbox.png, cp-6-inbox-approved.png.
Not covered: changing one tool's own permission (Settings > Safety belongs to the Settings task).

## LB-1 Memory: see what was remembered and why, edit an item, forget an item, see history
Result: PARTLY RUN
Findings: U-LB-008 (default-install experience, `likely`, not reproduced live), U-LB-009, U-LB-010, U-LB-011. Carried: U-LB-003 (see Notes), U-LB-002.
Time: not timed to the millisecond; edit and forget each took about 8 s from first click to the item showing the change, four clicks.
Code path: `library/LibraryMemoryWorkspace.tsx` (list, `memory-item-pagination-service.ts`) -> `LibraryMemoryEditor.tsx` (edit, forget, history, provenance) -> governed memory-lifecycle approval -> `LibraryMemoryReceipt.tsx`.
Live (sandbox flag true):
1. Library > Memory: filters (Memory status, namespace), 'Open <item>' per row, batch review buttons, proposals ('Proposals are not trusted memory').
2. Search 'review-task-9' then Enter filtered at once, and 'Apply memory filter' also works (U-LB-003 says only Apply works).
3. Open the item: title, content, expiry, Pinned, Review memory changes, Review forget, Memory history, Memory provenance (U-LB-009).
4. Edit content > Review memory changes > Request edit approval > Review danger approval > Approve once: content changed, history 'Updated - Changed: content - Approved change' (U-LB-010). Re-requesting the same edit reused one pending approval.
5. Forget: same four clicks; the dialog says 'A forgotten item can't be restored from the cockpit.' and the item reads Forgotten (U-LB-011).
Default install, from code (U-LB-008): the in-code fallback is `?? true` (`apps/gateway/src/config.ts:1475`), but a first run materialises `config/goatcitadel.json` from the example (`config.ts:553-558`), and the example sets false (`config/goatcitadel.example.json:202`), so a real fresh install gets false. No onboarding or first-run code sets it. The list read is then refused (`memory-item-pagination-service.ts:21`), the page shows 'This feature is turned off for this installation.' in a callout (`LibraryMemoryWorkspace.tsx:196-201`, `describe-api-error.ts:50-52`), and no Settings screen exposes the flag (git grep over `apps/mission-control-next/src` and `packages/mission-control-shared`: only read checks, one type, one fixture).
Failure tried: edit approval reopened after leaving the editor (a fresh editor shows 'Request edit approval' again, no 'waiting' notice).
Evidence: lb-1-memory.png, lb-1-detail.png, lb-1-provenance.png, lb-1-edit-review.png, lb-1-edit-after-request-1.png, lb-1-danger-review.png, lb-1-inbox.png, lb-1-inbox-review.png, lb-1-inbox-approved.png, lb-1-history-after-edit.png, lb-1-forget-review.png, lb-1-forget-done.png.
Not covered: the default-install screen live (needs an install with the flag false; operator steps: start with the example config, open Library > Memory).

## LB-2 Files and artifacts: upload a text file, find an artifact made in Chat, open it
Result: PARTLY RUN
Findings: U-LB-012.
Time: upload confirmation within the 2.5 s watched window after Upload file (review dialog 1.9 s).
Code path: `library/LibraryFileUpload.tsx` -> `uploadFile` -> `POST /api/v1/files/upload`; `LibraryResources.tsx` / `LibraryArtifactDownload.tsx` for artifacts.
Live:
1. Library > Files: 'Installation shared files. Workspace selection does not change this file root', folders chat/ and workspace/, two files listed. Upload text file: path and text boxes (U-LB-012), Review upload ('Confirm the installation shared destination before writing. Target: review-task-9-note.txt'), Upload file: 'GoatCitadel accepted review-task-9-note.txt (68 B).' and the file listed. The Inspect button for the new file was not found by name in the dialog-open state; the list row appeared.
2. Library > Artifacts (verification workspace): one 'Generated note' (seeded, Text, Version 1, Source: Conversation); Inspect opened a preview with Download artifact, Open artifact conversation, Reopen exact artifact, Use artifact in Chat. No artifact from an earlier task's Code Mode run exists, and none can be made without a model.
Failure tried: none.
Evidence: lb-2-files.png, lb-2-upload-form.png, lb-2-upload-review.png, lb-2-uploaded.png, lb-2-artifacts.png, lb-2-artifact-open.png.
Not covered: an artifact made in a real Chat turn; Download and 'Use artifact in Chat' not pressed. Left in the sandbox: `review-task-9-note.txt` in the shared file root (no delete control).

## LB-3 Agents: view profiles and the imported catalog; prompt packs: open, use in Chat
Result: PARTLY RUN
Findings: U-LB-013, U-LB-014, U-LB-015.
Time: Open QA Goat: URL changed at once, editor 1395 px below the fold.
Code path: `library/LibraryAgentsWorkspace.tsx` (profiles) / `LibraryImportedAgents.tsx` (catalog) / `LibraryAgentEditor.tsx`; `LibraryPromptPacks.tsx` -> `features/prompt-packs/usePromptPacksWorkbenchState.ts`.
Live:
1. Agents > Profiles: 10 installation profiles (eight built-in roles plus two custom, with state, kind and conversation count) and 'New agent profile'. Open QA Goat appears to do nothing (U-LB-013). Imported catalog: empty with no message (U-LB-014).
2. Prompt packs: the screen is a test console (selected pack, latest attempts, pass readiness, model lane `verification-stub/verification-stub-chat`, harness, assessment threshold 78%, per-test Run, Run all, Auto-score, Import a new pack). Run on TEST-01 gave first feedback in 332 ms and 'Ran TEST-01. Auto-scored 60.3/100 (review)' on the stub model, with an absolute log path in the line (U-LB-015).
3. "Use in Chat": no control on the Library side offers it (a search for chat links in the page found none). Earlier tasks found that packs without a run-variable schema are not listed in the composer's prompt-pack menu, so from Library's side 'use' means 'run a test against the selected model lane'.
Failure tried: none.
Evidence: lb-3-agents.png, lb-3-profile.png, lb-3-profile-open-bottom.png, lb-3-profile-position.json, lb-3-imported.png, lb-3-prompt-packs.png, lb-3-pack-run.png.
Not covered: the imported agent catalog with entries (needs a catalog repository; operator steps: Imported catalog > Import agent catalog with the configured source) and using a pack from the Chat composer (Task 6 area). A prompt-pack run record remains in the sandbox.

## LB-4 Knowledge: add a source, see it used in an answer with its citation
Result: PARTLY RUN
Findings: U-LB-016.
Time: ingest approval and receipt within the 3.5 s watched window (one click in place).
Code path: `library/LibraryKnowledgeWorkspace.tsx` -> `LibraryKnowledgeSourceFields.tsx` / `LibraryKnowledgeActions.tsx` -> docs ingest approval -> `LibraryKnowledgeResults.tsx` / `LibraryKnowledgeEvidence.tsx`.
Live:
1. Library > Knowledge asks first for a Source conversation (a long list of conversations, including earlier tasks' `review-task-8 ...`), then namespace, source type (Text, File, URL), title and text. 'Tool policy and read access still decide what this conversation can use.'
2. Review knowledge ingest > Confirm knowledge request > 'Knowledge request requires approval' with Approve once in the same dialog (Caution, 'Docs ingest ... Persist this exact source and its chunks') > one click > 'Original ingest completed; the canonical document receipt is available.'
3. The page then lists no sources (U-LB-016). What the screen says about use: 'Ingest persists source material. Indexing can invoke an embedding provider. Retrieval returns only content allowed for this conversation.'
4. Note: two identical pending 'Docs ingest' approvals appeared because my test script submitted the form three times; it needs a manual repeat by an operator before it could be a finding (the memory approval did not duplicate on the same repeat).
Failure tried: repeat confirm (step 4).
Evidence: lb-4-knowledge.png, lb-4-form.png, lb-4-ingest-review.png, lb-4-after-confirm-1.png, lb-4-approved-1.png, lb-4-ingested.png, lb-4-knowledge-after.png, lb-4-retrieval-review.png.
Not covered: indexing, retrieval and seeing a cited answer (the stub model does not cite). Operator steps: with a real embedding provider and model, run Review knowledge indexing for namespace `review-task-9`, then in the source conversation ask 'When is the quarterly planning meeting?' and look for a citation chip.

## Notes on existing findings
- Task-7 finding "On a default install, typing 'use <skill>' in Chat does nothing and says nothing": Capabilities makes it worse because it promises the Chat half. `SkillPanelSwitch.tsx:9` prints 'Takes effect in new chats.' under every On skill, `SkillPanelSwitch.tsx:13` prints 'Paused skills are used when you name them in Chat. Chat picks one on its own for a close match only if you've turned off first use confirmation.' (and the row for a paused skill reads 'Used when you name it, or on a close match if you allow it'), and `skill-install-view.ts:153` has the install approval read 'Lets the AI use <name> in new chats.' No Capabilities screen says that skill instructions in Chat are off by a setting, or where that setting is. Seen live on all three (cp-1-panel.png, cp-1-paused.png, cp-3-approval-3.png). Suggested severity: keep stall, and add that the Capabilities copy is the promise that fails.
- U-LB-003 (Memory search needs Apply): pressing Enter in 'Search memory' also applies the filter (live), so only pointer users hit it; suggested severity polish.
- U-LB-002 (Library text fields have faint borders): seen again on the Files upload, Knowledge and Memory search fields (not remeasured).
- Skill and plugin approvals are install-wide and worked from the verification workspace (skill) and from `default` (skill, plugin, tool); Settings approvals from a non-default workspace were not raised, so OL-16 was not re-tested.
- The shared change-plan dialog's primary button looking like Cancel (U-ST-005 / U-GL-008): in the Uninstall confirmation ('Keep it' beside 'Uninstall Review task 9 plugin') the primary is red and distinct; not reproduced there.

## Design decisions to confirm
- Turning a skill on, or resuming a paused one, is a Danger approval ('Turn debugging on - Danger') while turning it off and pausing are instant. For a built-in skill the operator switched off 30 seconds earlier the Danger label reads heavy; if the asymmetry is by design, consider a lower risk label for built-in, trusted skills.
- Tool group switch-off is instant but switch-on asks (same asymmetry); see U-CP-012 for the Inbox trip.

## Engineering notes
- The Connectors tab opens on `DEFAULT_TAB` = connectors on a first visit (`capabilities-tabs.ts:14`), while the area's title line reads 'Everything GoatCitadel's AI can use'; Skills is the first tab in the row.
- `GET /api/v1/capabilities/plugins` without `workspaceId` answers 400 (a validation message in raw zod shape); the UI always sends it.
- The Memory forget approval title in the Inbox ('Review memory lifecycle') comes from the generic approval title, whereas docs ingest sets its own ('Docs ingest - Ingests a document').
- The 404 on `GET /api/v1/capabilities/plugins/detail` after an uninstall finishes comes from the still-open plugin panel reading a plugin that no longer exists; harmless, shows once in the console.

## Area: System (journeys/task-10.md)

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

## Area: Settings (journeys/task-11.md)

# Task 11: Settings

Live runs: Playwright headless, 1440x900 dark, sandbox testbench Gateway (auth mode `none`, stub model, no OS keychain), `default` workspace unless stated. Evidence: `docs/review/2026-11-usability/evidence/st/`. New findings are U-ST-019 to U-ST-028, plus one polish finding added in fix round 1 (the recorded-grants list on Safety > Tools; its id is assigned at the next merge). Carried Settings findings before this task: U-ST-001 to U-ST-018 (none duplicated; see Notes on existing findings).

Setup and cleanup notes:
- Pages walked: Settings General, Models (Get started / Providers & models / Local AI), Safety (Permissions, Tools, Trust & policy, Hooks, Budgets), Citadel (Workspaces and the rest read), Access, Advanced, first-run; plus Capabilities > Connectors > Advanced setup > Web & Search (where Firecrawl lives since the Connections retirement).
- Settings before and after: `st-9-settings-before.json` and `st-9-settings-after.json` (paths replaced by `<sandbox runtime root>`), difference in `st-9-settings-diff.json`. Revision 14 to 35. Every value touched is back to its start; the only differences are the order of the `globalToolAccess.deny` list (same set, `fs.copy` moved to the end) and the provider `ut11-local` I added (the UI has no way to remove a provider profile).
- Created and left: provider profile `ut11-local-unreachable` (http://127.0.0.1:9, no key); two archived workspaces `ut11-workspace` and `ut11-workspace-b` (the UI archives, never deletes); two Chat conversations named `ut11 hello` (one failed, one answered by the stub); three of my own provider plans still open but expired (`Replace API key` for the stub and for `ut11-local-unreachable`, `Add ut11-local-unreachable` manual required). Removed: personality `ut11-personality`.
- Mistake, repaired: while restoring a workspace description my script edited the wrong card, after the list re-ordered itself, and wrote the demo text into `Default Workspace` and a `(ut11)` suffix into `GoatCitadel Demo`. I restored name and description of both through the Gateway API with fresh idempotency keys; that regenerated the Default slug (`default-workspace`), which I set back to `default`. Both workspaces' revision numbers and updated-at times moved. The seeded shell.exec approval was left pending.
- Screenshots scanned for absolute paths: the only page that prints them is Safety > Tools (Filesystem write roots). `st-9-safety-tools.png` showed them and was redacted in place (opaque boxes, verified by cropping). Opened and found clean: `st-6-after-reload-pending.png`, `st-2-approval-rule-after-save.png`, `st-2-default-inplace-waiting.png`, `st-6-allow.png`, `st-2-default-approval-1.png`, `st-9-crawl-_settings_safety.png`, `st-1-advanced-provider-config.png`, `st-1-models-open-plans.png`, `st-1-profile-applied.png`, `st-8-set-test.png`, `st-9-safety-tools.png` (after redaction). Every other PNG comes from a page whose full text I scanned for the user name, `Users`, the repo path and the runtime folder name: none printed (Models, Local AI, Access, Advanced, Citadel, General, first-run, Web & Search, Inbox, Chat, Work, Library, System). One console capture had a dev-server module path, replaced by `<dev-server module>`.
- The Settings pages the brief listed as release-scope hidden ("Change this workspace's skills" links) were not reached from any Settings page I opened; U-FR-002 (Diagnostics Access link) not re-walked.

## ST-1 Add a provider with a key, pick a default model, send a Chat message with it
Result: PARTLY RUN
Findings: U-ST-019 (blocker if it reproduces on a production build; confirmed on the development build only, so recorded as `likely`), U-ST-022, U-ST-023 (`likely`), U-ST-024 (friction); also U-ST-002 and U-ST-014 (see notes)
Time: Add provider profile dialog to review 2.6 s, apply 0.3 s; secure-input dialog opens at once; first keystroke crashes the page. Check connection not timed (button absent on loads that showed Done).
Code path: `cockpit/areas/settings/ModelsSettings.tsx` -> `CockpitGuidedModelSetup.tsx` / `use-guided-model-setup.ts` -> `ProviderManagementSettings.tsx`, `ProviderConnectionSettings.tsx` (`prepareCredential`) -> `POST /api/v1/change-plans` (adapter `provider-connection`) -> `POST /api/v1/change-plans/:id/provider-secret` -> Gateway provider-connection service; secure input dialog `packages/mission-control-shared/src/components/chat/ChatChangePlanActionDialogBody.tsx`.
Live:
1. Models > Providers & models: guided setup lists only the stub and "Claude Code CLI (local login) - not added yet"; four Refresh buttons (header + three section buttons).
2. Advanced provider configuration > Add provider profile: filled id, label, base URL http://127.0.0.1:9, model `ut11-model` (Review is disabled until the required fields are valid). Review provider profile > Apply reviewed provider profile > card "Awaiting confirmation" > Review and confirm > Apply exact change: provider added in 4 clicks, with a leftover card "needs your attention - MANUAL REQUIRED" (U-ST-022).
3. "Apply exact change" and "Cancel" have identical computed styles (background rgb(15,29,45), text rgb(244,251,255), border rgba(178,224,245,0.24)): confirms U-ST-005 on a Settings dialog. Settings dialogs that differ: the Add profile review ("Apply reviewed provider profile" is cyan rgb(92,233,255) with dark text), approval dialogs ("Approve once" cyan, "Deny" dark), "Unsaved changes" ("Save and continue" cyan).
4. Replace API credential on the new provider > Open secure input: the dialog explains "Stored in the OS keychain and never added to Chat or model context" and the field is enabled (not disabled in this sandbox). Typed one character with the keyboard: Settings replaced by "Settings couldn't be shown" with Try again / Reload app / Go to Chat (U-ST-019, `st-1-secure-input-crash.json`); this was the development build served by the sandbox, a production build was not run, and whether Try again recovers was not captured. The single settling check: build the UI, serve the output, open Models > Providers & models > Replace API credential > Open secure input, type one character. No key could be entered, so the keychain-failure message was not seen. Where a key box really is disabled for lack of a keychain, Web & Search explains it ("The OS keychain is unavailable. Set FIRECRAWL_API_KEY in the GoatCitadel environment instead."); the provider dialog has no such sentence, and the credential-storage select offers "Installation environment file (plaintext)" with the line "A keychain failure will not switch storage automatically."
5. Default model: Change default model > provider `ut11-local-unreachable`, model `ut11-model` > Review default model change > Apply reviewed routing: applied in about 3 s; the model select lists "verification-stub-chat - Not in current catalog" for the old model.
6. Guided model setup was loaded seven times with no action between: loads alternated between "Done / Ready" and "Not verified - last check is stale / Step 1 Current" (U-ST-023).
Failure tried: sent "ut11 hello" in a new Chat with the unreachable default provider: failed after about 2 s with "The connection dropped. Check the gateway or network connection" and no Settings link; System > Health stayed "1 check needs attention" (the unrelated runtime service) (U-ST-024). Default model restored; a normal message answered by the stub (`st-s4-chat-revert-ok.png`).
Evidence: `st-1-advanced-provider-config.png`, `st-1-add-provider-review.png`, `st-1-change-plan-dialog.png`, `st-1-profile-applied.png`, `st-1-secure-input-dialog.png`, `st-1-secure-typed.png`, `st-1-secure-input-crash.json`, `st-1-advanced-model-settings.png`, `st-1-models-open-plans.png`, `st-s4-chat-after.png`, `st-s4-health.png`.
Not covered: entering a key, "Check connection" with a key, picking a model from a live catalog, and sending the first Chat message through a keyed provider (no keychain, and the key box crashes). Operator steps: on a real Windows install open Models > Advanced provider configuration > Add provider profile, then Replace API credential > Open secure input, type the key, Submit securely; then Change default model; then Chat > New > send a message and confirm the model label under the answer.

## ST-2 Change a setting that needs approval: the approval appears in place, one click, applied without a second step
Result: FAIL
Findings: U-ST-020 (Tool approval rule, filesystem access); U-ST-021; U-ST-001 confirmed live (see notes)
Time: governed toggle in `default`: dialog 0.25 s after Save, Approve once to confirmed 0.56 s, 3 clicks. Firecrawl base URL: 3 clicks, dialog 1.8 s, confirmed 0.93 s after approve. Tool approval rule: 4 clicks after choosing the value, about 6 s. Verification workspace: no approve button at all.
Code path: `GovernedSettingParts.tsx` -> `use-governed-runtime-setting.ts` -> `PATCH /api/v1/settings` (creates a Change Plan and an approval) -> `SettingsApprovalDialog.tsx` -> `POST /api/v1/approvals/:id/resolve` -> Gateway reconciliation applies the plan. Older pattern: `ApprovalModeControl.tsx` and `FilesystemWriteAccessParts.tsx` -> `SettingsApprovalOwnerAction.tsx` (link to Inbox) + `ApprovedSettingsContinuation.tsx`.
Live:
1. `default` workspace, Models: untick "Keep one Claude Code process between tool steps", Save setting: dialog "Turn off ... Caution ... Only this setting changes. You can turn it on again the same way." with Approve once / Deny. Approve once: applied. This is the intended one-click pattern.
2. Same in the verification workspace (`ws_f13a...`): dialog opens but reads "The selected workspace changed. Open this item again in the current Inbox." with no Approve; that workspace's Inbox did not list the approval (0 cards), while the `default` Inbox did. U-ST-001 reproduced (`st-2-verif-gov-governed-1.png`, `st-2-inbox-verification.png`, `st-2-inbox-default.png`). Resolved by approving in the `default` Inbox, scoped to that card.
3. Safety > Tools approval rule (approve_risky to approve_all): see U-ST-020; Inbox path measured end to end, applied by the Gateway after Approve once with no Continue needed on that path.
4. Safety > Budgets (Balanced to Saver) applied at once with no approval (0.3 s): not governed.
Failure tried: pressed Save again after the first approval was left waiting (see ST-3).
Evidence: `st-2-timings.json`, `st-2-default-gov-governed-1.png`, `st-2-verif-gov-governed-1.png`, `st-2-default-inplace-dialog.png`, `st-2-default-inplace-waiting.png`, `st-2-default-after-review-click.png`, `st-2-inbox-default.png`, `st-2-inbox-verification.png`.
Not covered: none.

## ST-3 Save a provider with no changes; save two settings in a row
Result: PARTLY RUN
Findings: U-ST-021
Time: two consecutive governed saves on Models: each Save + Approve once confirmed in about 1.5 s, no conflict (PATCH 200 twice, expectedRevision 23 then 24).
Code path: `ProviderProfileFields.tsx` / `ProviderConnectionSettings.tsx` (Review disabled until a draft differs) -> `use-provider-connection-editor.ts`; consecutive saves `use-governed-runtime-setting.ts` -> `PATCH /api/v1/settings` with `expectedRevision`.
Live:
1. Stub provider > Edit provider profile with nothing changed: "Review provider profile" stays disabled; "Review endpoint change" is disabled as well. So a no-change provider save cannot be sent and the old 409 cannot occur that way. No sentence says why the button is disabled (not recorded; polish).
2. Two settings in a row on Models (reuse-process, then tool bridge, then both restored): all four saves applied, no stale-revision error.
3. The 409 family does appear after an approval is left open and the page is reloaded (U-ST-021).
Failure tried: left an approval waiting, reloaded, saved again: 409 "Another active Change Plan already owns this target." shown as "Settings changed elsewhere".
Evidence: `st-3-provider-unchanged-dialog.png`, `st-3-warm-disabled.png`, `st-3-closed-dialog.png`, `st-3-pending-plan-conflict.png`, `st-3-pending-plan-conflict.json`.
Not covered: an unchanged provider apply (not possible from the screen).

## ST-4 Local AI: point at a local runtime, see its models, start and stop it
Result: PARTLY RUN
Findings: U-ST-024 (the unreachable-server copy); U-ST-012 (carried: raw ids in the first sentences)
Time: Check server on an unreachable URL answered in 0.3 s.
Code path: `LocalAiSettings.tsx` / `LlamaSetupSettings.tsx` -> `POST /api/v1/llm/models/preview` -> Gateway llama.cpp service; readiness from `LocalAiEvidence.tsx`.
Live:
1. Models > Local AI with nothing installed: "Set up llama.cpp" (run mode: use a running server / let GoatCitadel start one), Server URL default http://127.0.0.1:8080/v1, Check server, Finish setup (disabled), Send test message (disabled); readiness panel lists 13 model fits (all "excellent" to "borderline") with "Detected ollama command on PATH"; "No Local AI job endpoint is registered. A local runtime was found."
2. Server URL http://127.0.0.1:9 > Check server: one line, "Live catalog unavailable; template aliases are not selectable." No statement that the server could not be reached. The Advanced page then shows "Latest probe: failed".
3. "Let GoatCitadel start one": "llama-server.exe detected; 0 GGUF files discovered." Nothing to start or stop (Finish setup disabled), so Start/Stop were not run. No download or install was pressed (Advanced lists voice-model Install buttons; not touched).
Evidence: `st-4-local-ai.png`, `st-4-check-server-unreachable.png`, `st-4-managed-mode.png`.
Not covered: models of a real server, start, stop. Operator steps: install llama.cpp, put a .gguf file in the Gateway's model folder, Models > Local AI > Let GoatCitadel start one > Check server > Finish setup, then Advanced > llama.cpp lifecycle to stop.

## ST-5 Access and auth: see the auth mode, create and revoke a token, pair a device up to the code
Result: PARTLY RUN
Findings: none new; answer to the Auto mode question in Notes on existing findings (U-CH-018)
Time: Access page content on screen within 1.5 s; editor opens in 1.5 s.
Code path: `GatewayAuthSettings.tsx` -> `GatewayAuthEditor.tsx` (`features/native-routes/settings`) -> `GET /api/v1/settings` (auth) and `/api/v1/auth/settings`; devices `DeviceAccessSettings.tsx` -> device grants API.
Live:
1. Access: "Anyone who can reach this app can change settings. Set up sign-in." "Current mode: none." Configure access opens an editor: Auth mode None/Token/Basic, Loopback bypass, Save access settings (disabled until edited), Discard, Close, Generate install token (disabled).
2. Selecting Token shows "Enter the new credential. Credentials clear when the editor closes."; Basic shows username and password fields. Neither draft warns that switching mode changes how every client, including this app, must sign in. Generate install token stays disabled in a Token draft until the mode is saved (tokens exist only in Token mode); I did not save. Closed the editor; mode read back as `none`.
3. Approved devices: "No device grants recorded." There is no pairing-code button on this page; pairing starts from the companion device. "Desktop and mobile continuity" lists readiness lines ("Install token lane - Open local - Auth is open; generate and protect an install token before exposing companion access").
4. Nothing on Access tells an auth-mode-`none` operator that Chat "Use Auto mode" and Managed files are unavailable or how to enable them (full page text checked).
Evidence: `st-5-access.png`, `st-5-configure-access.png`, `st-5-mode-token.png`, `st-5-mode-basic.png`, `st-5-continuity.png`.
Not covered: create and revoke a token, pairing code (both need Token mode or a device; changing the mode would lock the sandbox). Operator steps: Access > Configure access > Token > enter a credential > Save access settings; Generate install token; revoke from the same page; install the companion app and start pairing on the device, then approve under Approved devices.

## ST-6 Permissions, Trust and policy: find out why a tool was blocked and allow it
Result: PARTLY RUN
Findings: U-ST-025 (likely), U-ST-020 (allow flow)
Time: allow flow see ST-2; revert to Denied applied at once.
Code path: `TrustPolicySettings.tsx` -> `GET /api/v1/...` trust records (347 rows); `FilesystemToolAccessPanel.tsx` -> `PATCH /api/v1/settings` (`globalToolAccess`); Chat side `ChatToolActivity.tsx`, `ChatTurnFailureCard.tsx`.
Live:
1. No blocked tool event exists in this sandbox (the stub model cannot call a denied tool; earlier Activity shows only a denied approval), so "find out why" was a code read: U-ST-025.
2. Trust & policy filtered to Blocked: 4 rows, all skills (provenance missing or revoked upstream), each with a plain reason. Rows show raw tool ids as headings (permitted in a technical table).
3. Allow a tool: Safety > Tools > Global filesystem tool access, fs.copy Denied to Available, Apply fs.copy: approval needed, no dialog opened on its own (toast "Open Inbox item", buttons "Review approval" and "Continue approved change"); approved from the Inbox; fs.copy then Denied again, applied at once with no approval.
Evidence: `st-6-trust-blocked.png`, `st-6-trust-policy.png`, `st-6-allow.png`, `st-6-after-reload-pending.png`.
Not covered: a real blocked turn. Operator steps: in Chat ask for a file copy while fs.copy is Denied; read the tool row; try to reach the blocking rule from it.

## ST-7 Workspaces and personalities: create, switch, delete
Result: PASS
Findings: U-ST-028 (polish only)
Time: create workspace 0.23 s to the list; archive dialog closes 0.2 s after confirm; personality create 0.2 s, switch and revert each one review dialog (about 3 s including page).
Code path: `WorkspaceSettings.tsx` -> `POST /api/v1/workspaces`, `PATCH /api/v1/workspaces/:id` (archive) ; `PersonalitySettings.tsx` / `PersonalityEditor.tsx` -> `POST/PATCH/DELETE /api/v1/personalities`.
Live:
1. Citadel > Workspaces > New workspace `ut11-workspace` (name + description): listed at once. Make active: header became "Personal / ut11-workspace". Make active on Default switched back. Archive > "Archive workspace?" review > Confirm archive workspace: archived. There is no Delete; the archived workspace stays listed with Restore.
2. General > Personalities > Add custom personality `ut11-personality` (ID, Label, Category, Tone, Style, Description, System overlay, Safety notes): created. Saved personality select > Review global default > Apply reviewed default: global Work default switched; reverted the same way to Default. Edit selected personality > Remove custom > "This cannot be undone" confirm > removed (Gateway confirms none left).
Failure tried: Create workspace with an empty name: button disabled.
Evidence: `st-7-new-workspace-form.png`, `st-7-created.png`, `st-7-switched.png`, `st-7-archive-dialog.png`, `st-7-personality-form.png`, `st-7-personality-created.png`, `st-7-switch-review.png`, `st-7-personality-delete-confirm.png`.
Not covered: workspace delete (not offered).

## ST-8 Web search and Firecrawl: set a base URL and allowlist, run a search from Chat
Result: PARTLY RUN
Findings: U-ST-026 (friction)
Time: Save to dialog 1.8 s; Approve once to "Done - Change saved and confirmed" 0.93 s; Test connection answered in under 1 s.
Code path: `FirecrawlSettings.tsx` (+ `isBaseUrlAllowlisted`) -> `PATCH /api/v1/settings` (`web.firecrawl`) -> approval; `POST /api/v1/settings/web/firecrawl/check`; keys `WebSearchKeys.tsx`.
Live:
1. Web & Search: Use Firecrawl, hosted vs self-hosted, base URL, default backend, fallback, timeout, Save Firecrawl, Test connection, search engine order, three API-key boxes (all disabled with "The OS keychain is unavailable. Set <ENV NAME> in the GoatCitadel environment instead.").
2. Base URL set to http://127.0.0.1:9 (a contrived loopback port; a LAN host is the realistic case): saved and approved; Test connection "Not allowlisted", with no add button and no link (U-ST-026). The allowlist itself lives on Settings > Get started > Change installation defaults ("Network allowlist" field, `FirstRunDefaults.tsx:98-102`), which this page does not point to. Restored to http://127.0.0.1:3002 with the same flow; the Gateway read-back matches the original values (enabled, 3002, firecrawl, fallback, 20 s).
3. The allowlist was not widened (the field on the first-run defaults page was read, not saved).
Evidence: `st-8-web-search.png`, `st-8-set-after-save.png`, `st-8-set-after-approve.png`, `st-8-set-test.png`.
Not covered: running a search from Chat (needs a real model and network). Operator steps: set Firecrawl or a search key, open Chat, turn Web on in the plus menu, ask a question that needs the web, read the sources line.

## ST-9 Every Settings page: open it, change one harmless value, save, reload, value kept
Result: PARTLY RUN
Findings: U-ST-027; U-ST-023 (Models); carried findings on these pages
Time: pages render within 1.5 s each; no console error except aborted event-stream requests on navigation.
Code path: `SettingsArea.tsx` and the section components listed in `settings-route-homes.ts`.
Live (page, value changed, result after reload, restored):
- General > Appearance: "Show technical details" ticked (applies at once, no Save): kept after reload; unticked: restored.
- Models: "Claude Code CLI: reuse one process" and "let it use GoatCitadel tools" off and on again (governed): kept, restored. "Show model reasoning in Chat": its own copy says it "is kept in this browser only, so it is gone after a page reload", yet the save is a governed `PATCH features.chatThinkingStreamV1Enabled` that raised an approval; I denied it, so the value is unchanged and "kept after reload" was not tested.
- Safety: Budgets Balanced to Saver (applied at once, kept per Gateway), back to Balanced. Tools approval rule approve_risky to approve_all and back (via Inbox). fs.copy Denied/Available/Denied. Permissions and Hooks (no hooks) and Trust & policy are read-only pages here.
- Citadel > Workspaces: workspace create, archive (kept), metadata edit of Demo (kept after reload, then restored; see the mistake above).
- Access: no value changed (mode change would lock the sandbox).
- Advanced: read-only apart from voice-model Install buttons (downloads; not pressed) and runtime Check health (not pressed).
- Get started (first run): all three steps Done; no change made.
- Web & Search: Firecrawl base URL changed and restored.
- Notification routing (General): New destination form read only; a webhook destination needs "Webhook URL secret reference", described only as "Use existing keychain references" (U-ST-008 confirmed).
Failure tried: saves left waiting for approval (see ST-3).
Evidence: `st-9-crawl-*.png` (each page), `st-9-general.png`, `st-9-safety-budgets.png`, `st-9-safety-tools.png` (redacted), `st-9-advanced.png`, `st-9-first-run.png`, `st-9-webhook-destination-form.png`, `st-9-settings-before.json`, `st-9-settings-after.json`, `st-9-settings-diff.json`.
Not covered: values on Access and Advanced (no harmless value), hooks (none registered; Register hook not used), Citadel Mason/Wards/Council/Vault/Blueprint tabs were only read.

## Feature settings with no screen
Source: one `GET /api/v1/settings` plus `apps/gateway/src/config.ts:1472-1585`, `config/goatcitadel.example.json` and `git grep` in `apps/mission-control-next/src` and `packages/mission-control-shared/src`; full table in `evidence/st/st-9-feature-flags.json` (69 flags: default in code, example-config value, sandbox value, Settings control, UI references, what it gates).
- 69 feature flags: 36 `...Enabled` flags default off in code, 10 `...Disabled` kill switches (off, meaning the feature is on), 23 `...Enabled` flags default on.
- Only 5 flags have any Settings control: `claudeCliToolBridgeEnabled`, `claudeCliWarmContinuationEnabled`, `browserErrandsEnabled`, `settingsApprovalSkipEnabled`, `chatThinkingStreamV1Enabled` (the last is described as a browser-only preference but saved as a governed Gateway setting).
- 33 default-off flags have no screen to turn them on, among them two of the three already recorded: `chatSkillInstructionsV1Enabled` (`use <skill>`) and `chatStaticMcpV1Enabled` (only through a template connector install). The third recorded one, `memoryLifecycleAdminV1Enabled`, defaults to on in code but off in the shipped example config, so a fresh install has it off; the sandbox seed turned it on.
- New finding U-ST-027 covers the default-off flags that a screen tells the operator about without a switch: `cronReviewQueueV1Enabled`, `engineeringLearningsV1Enabled`, `connectorDiagnosticsV1Enabled`, with `promptRetuneCampaignV1Enabled` hidden silently. Other default-off flags gate nothing an operator is told about today (mostly API-side behaviour): `replayOverridesV1Enabled`, `memoryMaintenanceV1Enabled` (Library memory diagnostics refuses with "Current runtime settings do not permit this operation."), `codeModeV1Enabled` and `codeModeHostSandboxEnabled` (Chat has its own enable flow, `enable-code-mode.ts`), `improvementLedgerV1Enabled`, `improvementActivationV1Enabled`, `structuredReviewV2Enabled`, `chatContextBudgetVisibilityV1Enabled`, `chatProviderFallbackV1Enabled` and `chatDelegationControlsV1Enabled` (Chat's feature availability shows both false), `memoryConsolidationV1Enabled` (the "Memory Consolidation Weekly" schedule shows Paused), `utilityModelRoutingV1Enabled` (read by a Claude CLI notice), and the fan-out, mesh, heartbeat and channel-voice-reply flags.
- The sandbox differs from code defaults for `replayRegressionV1Enabled`, `codeModeV1Enabled` and `codeModeHostSandboxEnabled` (on), and `memoryLifecycleAdminV1Enabled` (on).

## Step 4: no provider, invalid key, missing default model
Result: PARTLY RUN
(a) Reachable case run: the default model set to a model the provider cannot serve and a provider that answers nothing (`ut11-local-unreachable` / `ut11-model`, reversible through Change default model). Reverted and confirmed with a normal message.
- Chat: names nothing useful (U-ST-024): "The connection dropped. Check the gateway or network connection". The empty-conversation screen does carry a "Configure models" button (`ChatConversationStarterChoices.tsx:27`); the failure card has no Settings link except for sign-in and billing failures (`ChatTurnFailureCard.tsx:31`, `:76`).
- Work > Schedules: loaded normally, no mention of the model (schedules were not run).
- Library > Knowledge: loaded normally, no mention.
- System > Health: no model or provider check at all; the one attention item was the unrelated runtime service (U-ST-024).
(b) Code read, not reproduced live:
- Empty provider list: Settings shows "No providers are configured. Use guided setup to connect one." (`ProviderCatalogSettings.tsx:271`) and "No saved providers yet. Add a provider profile to start." (`ProviderList.tsx:31`); Chat's empty state offers "Configure models"; Work > Schedules, Library > Knowledge and System > Health have no code that reads the provider list (`git grep` for "no provider", "connect a provider" in those areas finds only Settings and first-run files), so they give no pointer. Likely: they show their normal content and the first model use fails as in (a).
- Invalid key (401): Chat maps `auth_required` to "The model provider needs you to sign in again" with an "Open model providers" link to `/settings/models#providers` (`ChatTurnFailureCard.tsx:14`, `:31`, `:76`): named and linked. The other three screens: no reading of a provider error.
Fresh-sandbox task (first run) should look at: Chat empty state and the first send with no provider (what the composer says, whether Send is disabled, where "Configure models" goes); Work > Schedules > New schedule and the Cost Report / built-in schedules (do they say a model is needed); Library > Knowledge > ingest and query (does retrieval name the missing model); System > Health (is a missing default model a check) and the Settings > Models guided setup "Step 1 Connect a provider" copy and its Check connection button. Also the secure input dialog: type a key (U-ST-019).

## Notes on existing findings
- U-ST-001: reproduced live (stall confirmed). In the verification workspace the in-place Settings approval says "The selected workspace changed. Open this item again in the current Inbox." with no Approve, and that workspace's Inbox lists no such approval (`st-2-verif-gov-governed-1.png`, `st-2-inbox-verification.png`). Seven call sites hard-code `workspaceId="default"` (`GovernedSettingParts.tsx:117`, `ApprovalModeControl.tsx:177`, `FilesystemWriteAccessParts.tsx:71`, `ProviderConnectionSettings.tsx:344`, `ProviderRoutingSettings.tsx:247`, `ManagedRuntimeSettings.tsx:195`, `GatewayAuthSettings.tsx:101`), so every governed Settings save is affected, not only one. Suggested severity stall (unchanged).
- U-ST-005: confirmed on a Settings change-plan dialog: "Apply exact change" and "Cancel" have identical computed colours (background rgb(15,29,45), text rgb(244,251,255)). Other Settings dialogs differ (see ST-1 step 3). Suggested severity friction (unchanged).
- U-ST-008: confirmed live: Keychain HTTPS webhook form asks for "Webhook URL secret reference" and says only "Use existing keychain references"; nothing shows the format or creates one (`st-9-webhook-destination-form.png`). Suggested severity stall (unchanged).
- U-ST-014: confirmed live: /settings/models shows four buttons named Refresh (header plus "Model reasoning in Chat", "Claude Code CLI: let it use GoatCitadel tools" and "reuse one process"); Safety > Tools has several more. DESIGN.md:102 specifies one in the page header. Suggested severity polish (unchanged).
- U-ST-002: confirmed live: below the guided setup's provider picker, "Advanced provider configuration" opens a second provider list (Provider profiles, Inspect provider, Default provider) and a third chooser in Default model. Suggested severity friction (unchanged).
- U-ST-010: confirmed live: two step lists (Guided model setup steps vs the Get started page's) with different names; the Get started page says "Choose a model / Choose your safety settings / Send a test message". Not re-measured.
- U-ST-011: switching a toggle needs one dialog but the dialog is short and one-click in the `default` workspace (see ST-2); the "modal with a paragraph" wording applies to integrations (not walked). Suggested severity polish.
- U-ST-016, U-ST-017, U-ST-018, U-ST-004, U-ST-007, U-ST-015: not re-walked.
- U-CH-018: answer for the Access question: Settings > Access in auth mode `none` does not say that Chat "Use Auto mode" and Managed files are unavailable, nor how to enable them. It says only "Anyone who can reach this app can change settings. Set up sign-in." and "Current mode: none." (`st-5-access.png`, `st-5-configure-access.png`). Suggested severity: keep, and add that the Access page is the natural place for the pointer.
- U-FR-002 (Diagnostics "Access" link) and the "Change this workspace's skills" links: not re-walked.

## Design decisions to confirm
- Budget preference (Safety > Budgets) applies at once without approval while the tool approval rule needs one: DESIGN says tightening applies freely and loosening asks; the Budgets page already says it is "a preference only". No change needed unless the operator wants budget changes governed.

## Engineering notes
- `ChatChangePlanActionDialogBody.tsx:107-113` reads `event.currentTarget.value` inside the `setSecureValues` updater; capture the value before calling `setSecureValues`. The same file has other onChange handlers (lines 193, 211, 234) that read it directly and are fine. The unit test (`ChatChangePlanActionDialog.test.tsx:269`) passes a hand-built event whose `currentTarget` is never nulled, so it cannot catch this. Users of the dialog (git grep): `GuidedModelPlanDialog.tsx`, `ProviderConnectionSettings.tsx`, `ProviderManagementSettings.tsx`, `ProviderRoutingSettings.tsx`, `LibraryCandidatePlan.tsx`.
- Safety > Tools > Recorded grants shows "Showing 30 of 171 matching records from the latest 400 grants", mostly repeats of a few tools; most are likely seeded by test tasks (also recorded as a polish finding).
- Governed settings cards still exist in two shapes (`GovernedSettingParts.tsx` in-place dialog; `ApprovalModeControl.tsx` and `FilesystemWriteAccessParts.tsx` link + Continue). `ApprovedSettingsContinuation` is rendered whenever the plan is not confirmed, although the comment at `GovernedSettingParts.tsx:123` says Approving applies the change and Continue is only for cards without an in-place approval.
- Safety page: the Permissions, Tools, Trust & policy, Hooks and Budgets tabs are anchors on one long page (the Tools tab text includes the permission-profile controls and 171 grant rows); the whole page also prints runtime folder paths.
- Per-turn `git grep` shows 21 on-by-default `...Enabled` flags with no UI reference at all (type definitions only).
- The Gateway needs an `Idempotency-Key` header on mutating API calls (used when restoring the two workspaces).

## Fix round 1 (review)
- U-ST-019: confidence changed from confirmed to likely; title and text now say confirmed on the development build only, with the production check named, the code reading, why the tests missed it, the reach, and why it is not a keychain artifact.
- U-ST-026: false sentence removed (the allowlist field exists on Settings > Get started); defect reframed as the page's own check disagreeing with the Gateway's; severity stall to friction.
- U-ST-024: severity stall to friction; wording limited to the generic message, the missing link and the missing Health check (Health's attention item is the known runtime-service warning).
- U-ST-023: confidence likely (the stale text may be a loading transient). U-ST-020: cross-reference U-CP-012. U-ST-027: cross-references U-LB-008, U-CP-015, U-CH-044; promptRetuneCampaignV1Enabled listed for completeness only. New polish finding for the grants list.

## Area: First run and install (journeys/task-12.md)

# Task 12: First run and install

Live runs: Playwright headless, 1440x900 dark (first-run page and Chat also at 375x812 light), against a second sandbox started for this task: fresh runtime root, shipped example config (no provider configured, no stub), onboarding NOT completed, auth mode `none`, OS keychain disabled, bundled Postgres and local runtimes off, feature flags left at their shipped defaults (memory lifecycle admin off, Code Mode off). It was started by a small launcher under the git-ignored scratch folder that reuses the testbench helpers; nothing under `scripts/` was edited. It is stopped and its runtime folder is gone. The shared sandbox was only read (two URL loads in FR-5) and still answers.

The tracked-file rule: evidence JSON has paths replaced by `<dev-server module>`; screenshots show no absolute paths (see the hygiene line at the end).

Existing findings for this area before this task: U-FR-001, U-FR-002 (not duplicated; see Notes on existing findings). New findings are the eleven finding titles named under the journeys below.

## FR-1 Fresh sandbox with onboarding not done: the first screen, Get started, choose a model, the first task, arrive in Chat
Result: FAIL
Findings: "A fresh install says 'You can chat now' above a first-send failure..."; "The Cockpit opens a bare installation on model-less Chat..."; "Get started shows 'Saved model defaults changed...'" (polish); "'Check connection' for LM Studio or llama.cpp says nothing when the server is not running..."; "Nothing outside Chat and Settings says that no model is configured..."; U-ST-019 (existing blocker, reproduced here: see notes); U-LB-008 (live check, see notes)
Also breaks: FR-1 is also broken by U-ST-019
Time: first paint 7.4 s on the cold dev server (domcontentloaded to Chat visible; the Get started page itself is ready in 0.9 s); first send feedback 126 ms; with the Claude CLI path (the only complete path with no typed secret): 10 clicks and 5 screens from first paint to Chat able to type, about 13.4 s for the last leg (Return to setup to Finish) plus 5.6 s for "Add Claude Code CLI + verification"
Code path: first paint `cockpit/app/CockpitShell.tsx` -> `cockpit/areas/chat/ChatArea.tsx` (banner `ChatSetupBanner` when `GET /api/v1/onboarding/state` says not completed) -> `/settings/first-run` `FirstRunArea.tsx` / `use-first-run-setup.ts` / `FirstRunModelStep.tsx` -> `CockpitGuidedModelSetup.tsx` / `use-guided-model-setup.ts` -> `POST /api/v1/change-plans` (provider-connection adapter `services/provider-connection-change-plan-adapter.ts`) -> `POST /api/v1/onboarding/complete` (`routes/onboarding.ts`, `services/onboarding-state-service.ts`)
Live:
1. Opened `/` on the fresh install: lands on Chat (no redirect to setup; the Classic shell has one, the Cockpit does not). Banner "You can chat now. Finish setup to verify your first answer." with Return to setup. No model exists. (`fr-1-first-paint.png`)
2. New conversation > typed a message > Enter: red card "The run cannot start because no provider is configured." with only "Reload conversation"; top banner repeats the cause as text. First finding. (`fr-1-first-send-no-model.png`, `fr-1-first-send.json`)
3. Followed the links: "Configure models" -> Settings > Models (Guided model setup, different step names); "Return to setup" -> Settings > Get started (first-run page). (`fr-1-configure-models-link.png`, `fr-1-return-to-setup.png`)
4. Get started > Use a cloud provider: the list holds cloud providers and local runtimes (button name says cloud only). "Connect provider" is disabled until one is chosen. (`fr-1-use-cloud-provider.png`)
5. Each path that needs no secret: Ollama (the PC's own Ollama answered, "Confirm model" offered; not confirmed, to avoid a real model); LM Studio / llama.cpp pointed at nothing: "Check connection" is silent (second finding); OpenAI API / Codex: need a key or a ChatGPT sign-in; Claude Code CLI (local login, already signed in on this PC): Add Claude Code CLI > Apply exact change > "signed in and passed live verification" (5.6 s), Confirm model > Apply exact change (2.5 s), Continue to safety, Keep current rule, Finish setup and open Chat: arrived in Chat with the model chip filled in (`fr-1-cli-added.png`, `fr-1-model-confirmed.png`, `fr-1-safety-step.png`, `fr-1-before-finish.png`, `fr-1-arrived-chat.png`, `fr-1-timings.json`).
6. OpenAI API > Connect provider > Open secure input > typed one placeholder character: Settings is replaced by "Settings couldn't be shown" (U-ST-019 reproduced on first run). Try again returns to step 1 with the provider choice lost and a "Connect OpenAI - awaiting input" card left behind. No key can be entered, so an operator with only a key cannot finish first run on this build. (`fr-1-secure-input-open.png`, `fr-1-secure-input-after-1-char.png`, `fr-1-after-try-again.png`, `fr-1-secure-input-crash.json`)
7. Phone width, light theme: first-run page and Chat fit 375 px with no sideways scroll (`fr-1-phone-light-first-run.png`, `fr-1-phone-light-chat.png`).
Failure tried: the first message with no model (step 2) and the key box (step 6).
Evidence: `docs/review/2026-11-usability/evidence/fr/fr-1-*.png`, `fr-1-timings.json`, `fr-1-first-send.json`, `fr-1-lmstudio-check.json`, `fr-1-secure-input-crash.json`
Not covered: finishing with a real key (box crashes, and no real key may be typed); the first real answer (not sent, to keep to the live-model budget; the Claude CLI "live verification" only checks the CLI's auth-status readiness and sends no model request (provider-readiness-service.ts:33-60); real-model calls in this task: zero). Operator steps: on a real install, Get started > Use a cloud provider > a provider > Connect provider > paste the key; Confirm model; Continue to safety; Keep current rule; Finish; then send "hello" and note the time to the first words.

## FR-2 Leave onboarding halfway and come back; skip it; try the demo
Result: PARTLY RUN
Findings: "'Try the demo' ends as 'Partly prepared'..."; "Chat's 'Configure models' and 'Return to setup' open two different setups..." (related to U-ST-010); U-FR-001 (not reproduced; see notes)
Time: demo preparation 0.3 s; Open recorded demo 3.6 s
Code path: `use-first-run-setup.ts` (step is local state; model and approval are read from `GET /api/v1/onboarding/state`) -> `FirstRunDemo.tsx` / `use-demo-bootstrap` -> `POST` demo bootstrap (`routes/demo.ts`)
Live:
1. Step 2 opened directly by clicking its tab (works with no model), "Keep current rule" clicked: step 2 shows Done. Reload: back on step 1, step 2 "Not started" again; the choice is held only in the page. Server-side facts (provider added, default model, setup marker) survive reload, Back and a new tab; nothing else is lost. (`fr-2-step2-kept.png`, `fr-2-after-reload.png`)
2. Chat > Back and URL navigation to Work, Library, System, Settings all work with setup unfinished; there is no skip button, only "Exit setup" (goes to Settings > Models > Get started, a status list with "Open setup"). The app never blocks work. (`fr-2-exit-setup.png`, `fr-2-settings-home.png`)
3. Try the demo: Review demo preparation > Confirm: "Partly prepared" with a raw flag name; Open recorded demo: empty chat in a different workspace (finding). (`fr-2-demo-panel.png`, `fr-2-demo-review-dialog.png`, `fr-2-demo-prepared.png`, `fr-2-demo-chat.png`)
4. After finishing setup, reopening Get started shows steps 1 and 2 Done and step 3 current with "Open Chat to send a test message" (`fr-2-first-run-after-finish.png`, `fr-2-models-get-started-after.png`).
Failure tried: left halfway (reload, Back, URL) as above.
Evidence: `fr-2-*.png`
Not covered: closing the whole browser and reopening with the same profile (a second tab context behaved the same); U-FR-001 needs a lost response, not provoked.

## FR-3 pnpm onboarding:tui in a scratch home: every prompt, a wrong answer at each, quit halfway and rerun
Result: NOT RUN
Findings: "Quitting the terminal wizard with Ctrl+C prints 'Onboarding wizard failed.'..."; "The terminal wizard applies provider settings first and saves the key second..."
Time: n/a
Code path: `apps/gateway/src/onboarding-tui.ts` (prompts from `@inquirer/prompts`), `onboarding-tui-helpers.ts`, `onboarding-tui-paths.ts` -> `GET /api/v1/onboarding/state`, `POST /api/v1/llm/models/preview`, `POST /api/v1/onboarding/bootstrap`, `POST /api/v1/secrets/providers/<id>`, `POST /api/v1/onboarding/complete`, `GET /api/v1/llm/config`
Live: not run. The wizard writes no file of its own: every write goes to the Gateway at the URL it is given (default `http://127.0.0.1:8787`), so a scratch home does not protect anything; the only safe run is against a scratch Gateway, and the prompts need a terminal.
Prompts in order (every default and message read from the code): intro box ("Press Enter to accept defaults... Nothing is written until you confirm the final review step"); Gateway URL [127.0.0.1:8787]; Gateway auth mode [None]/Token/Basic (token and password masked with `*`); if the Gateway is not answering and the URL is loopback: "Start the local gateway now?" [yes] (runs `pnpm dev:gateway`, 20 s wait; a non-loopback URL just throws the raw fetch error); "Current checklist" box; Provider template [GLM, "recommended cost-oriented default"; the browser flow has no such default]; custom provider id, name, base URL when "Custom"; "Provider API key (optional)" masked; "Save provider key to the OS secure store?" [yes]; "Use a custom env var name...?" [no]; model discovery box then Active model / use default / Retry / manual; Tool approval mode [current]; Budget mode [balanced]; Network allowlist (comma list); "Enable mesh?" [current, no] and, if yes, mode, node id, mDNS, static peers, mTLS, tailnet; "Mark onboarding complete now?" [yes]; "Completed by" [tui-operator]; review table; "Apply onboarding now?" [yes].
Wording as a first-time operator: clear and well explained overall ("The env var name is just the lookup key. It is not the secret value itself"); jargon at the Mesh and "Network allowlist" prompts is explained in boxes; "Provider template" and "Internal provider ID" are developer words. Wrong answers: no prompt validates (empty URL, token, username, base URL and model id are accepted and fail later with a raw `METHOD /path failed (status): body` error). Quit halfway: nothing was written before the final apply, so a rerun is clean, but Ctrl+C prints a failure (finding). The closing "Next step: run `goat up` if the gateway is not already running" is stale: the wizard needed the Gateway to start.
Evidence: none (code read)
Not covered: everything live. Operator steps: start a scratch Gateway (`pnpm testbench` or a fresh `GOATCITADEL_HOME`), run `pnpm onboarding:tui` in a real terminal with `GOATCITADEL_GATEWAY_URL` set to it, answer with Enter throughout; rerun and press Ctrl+C at each prompt; enter `http://127.0.0.1:9` as the provider base URL; with the keychain unavailable answer yes to the key save.

## FR-4 Bundled Postgres: first start, start with its port taken, and what the operator is told
Result: NOT RUN
Findings: "A bundled-database start that fails (port taken, wrong password, 3-minute wait) shows only 'Runtime is stopped'..."
Time: n/a
Code path: `apps/gateway/src/bundled-postgres-runtime.ts` (`ensureBundledPostgresRuntime`, `probeBundledPostgresRuntime`, `waitForBundledPostgres`, `assertBundledPostgresPortIsUsable`) <- Gateway boot; what the operator sees: `apps/mission-control-desktop/src/main.ts` (`launchRuntime`, `renderRecovery`) and, once the Gateway is up, System > Health "Database" card.
Live: not run (no database, container or installed app was started, as instructed). In the browser sandbox the System > Health card shows "Database / Reachable" for SQLite, and "1 check needs attention" for the runtime service only.
Read: first start initialises a native cluster (or a Docker container when no native Postgres is found) with a generated password under `data/secrets/`; the port-is-another-runtime case has a good message (names the expected and observed data directory and says "Stop the other Postgres runtime or configure a different bundledPostgres.port"); a Windows-reserved port has a very good message with the `netsh` command; no native and no Docker gives a five-option message; `autoStart` off gives one short sentence. Port held by anything that is not a matching Postgres, and the `28P01` case, run to the 180 s timeout with "Last probe: password authentication failed (code=28P01)" and no mention of the port (finding). The Gateway has no `28P01`-specific text (`git grep` finds none).
Evidence: none (code read)
Not covered: all live. Operator steps: on a spare profile, (1) start the app with nothing on port 45432 and time first start; (2) start any listener (`node -e "require('net').createServer().listen(45432)"`) and launch; (3) start a Postgres container with another password on 45432 and launch; (4) read the app window at 10 s, 60 s and at failure; (5) open Open Logs and compare.

## FR-5 Installer and update paths: code read of scripts/packaging/ and the desktop host only
Result: NOT RUN
Findings: "The installer's default 'Full installation' pre-selects 'Chromium runtime' and 'Voice runtime'..."; the FR-4 and FR-2 findings for first launch
Time: n/a
Code path: `scripts/packaging/build-windows-native-installer.mjs` (Inno Setup script text), `scripts/packaging/smoke-windows-installer.ps1`, `bin/goatcitadel.mjs` (`launch`, target URL), `apps/mission-control-desktop/src/main.ts` + `src-tauri/src/main.rs` (startup window, tray), `apps/mission-control-windows/Services/DesktopUpdate*.cs`, `MainWindow.Updates.cs`, `apps/mission-control-next/src/cockpit/areas/settings/DesktopUpdateSettings.tsx`
Live: not run (running an installer is not allowed).
Read: installer is Inno Setup, per user (`PrivilegesRequired=lowest`, default folder in the local app data), modern wizard, components page (finding), optional desktop shortcut (unchecked), "Launch GoatCitadel" after install, payload staged and hash-checked, previous payload restored if the install fails, messages for a locked payload ("Close GoatCitadel and retry the update"); uninstall removes the payload, shortcuts and registry, keeps operator data (the smoke test lists what stays); first launch of the desktop host shows "Starting the local runtime..." then Mission Control at `/?tab=onboarding` (verified in the browser: it maps to Settings > Models > Get started), with a recovery panel (Retry, Open in Browser, Open Logs, Open Install Folder); tray menu: Open Mission Control, Open in Browser, Runtime Status, Restart Runtime, Stop Runtime, Open Logs, Quit. Updates are manual by design: Settings > General > Application updates (channel stable/preview, Check, Download with a progress bar, "Remind me tomorrow", "Show installer"); messages are plain ("GitHub could not be reached. Your installed app is unchanged.", "Checksum verified. This preview is unsigned. Open the folder and run the installer when ready."). In a browser the card says "Open the installed Windows app to check for updates" and System > Health shows "Desktop app only". Gaps: an unsigned installer means a SmartScreen prompt the screens never explain (not verifiable here); `CloseApplications=force` closes a running app (and its tasks) during an update without an in-app warning; the downloaded installer is run by hand and the app does not say what happens to open work.
Evidence: `fr-5-launch-url-onboarding.png`, `fr-5-launch-url-dashboard.png` (shared sandbox, read only)
Not covered: everything an installed app does. Operator steps: on a clean VM run the setup file with the defaults (note the components page, the SmartScreen prompt, the time), launch, see the first window and its first screen; switch the update channel to Preview, Check, Download, Show installer, run it while a Chat task is running; uninstall and list what remains in the local app data and home folders.

## Step 4 (packaged app): deferred by the controller
Not run in this dispatch: `pnpm package:desktop` and `pnpm verify:desktop` were not run and the packaged app was not launched.

## Notes on existing findings
- U-ST-019 (blocker, dev build): reproduced on first run. First run > Use a cloud provider > OpenAI API > Connect provider > Open secure input, one character typed: "Settings couldn't be shown". Try again returns to Get started step 1, provider choice lost, awaiting-input card left behind. Not a new finding; severity stays blocker for FR-1 (a key cannot be entered). Not tested on a production build.
- U-FR-001: on the fresh mode-none sandbox the approval-mode lock did NOT appear. Get started step 2 loaded the approval rule at once (`Current: Ask for risky work`), "Keep current rule" was enabled, and Finish enabled as soon as a model existed (`fr-1-before-finish.png`). The first-run approval control reads Settings, not the Chat session read that returns 403 (U-CH-018), so the default install's first run is not locked. Finish was pressed once with no lost response; U-FR-001's trigger (a save with a lost response) was not provoked. Suggested severity unchanged (stall, only after a lost response).
- U-LB-008: live observation on the fresh default install (`GET /api/v1/settings` first confirmed `memoryLifecycleAdminV1Enabled: false`, left unchanged). Library > Memory shows the full filter row and then, twice (directory and Memory proposals), a red box "This feature is turned off for this installation." plus a button "Open memory diagnostics and maintenance"; no sentence says how to turn it on and the Settings pages offer no switch. Confirmed as expected from code; suggested severity stall unchanged. (`fr-1-nomodel-library-memory.png`)
- U-ST-019 also appears on Get started because both screens share the same secure-input dialog. A further symptom: after the crash the Models page keeps a stale "Connect OpenAI - awaiting input" plan card (visible in fr-1-nomodel-models-providers.png). Same source task (task-11); not a new finding.
- U-ST-010: related, not the same. It covers Models > Get started against Providers & models. New in this task: Chat's two links open different setups, the launch URL maps to the third view, and only the first-run Finish records completion (see the finding naming U-ST-010).
- U-FR-002 (Access link): not re-walked.
- U-CH-018: the demo chat shows "Approval mode unavailable / Retry" (`fr-2-demo-chat.png`); it did not block the journey.

## Design decisions to confirm
- "Keep current rule" as an explicit step even when the rule is already the safe default (one extra click, kept for the safety review).

## Engineering notes
- The Cockpit `use-first-run-setup.ts` keeps "safety confirmed" in a React state; reload loses it (no operator-visible harm because Finish re-checks everything).
- `use-guided-model-setup.ts` `recheckLocalEndpoint` ignores the `source` and `warning` fields that `GET /api/v1/llm/models` returns.
- The Models page lists a stale plan card ("Connect OpenAI - awaiting input") after the secure-input crash; plans are not expired on the next visit.
- The testbench launcher always completes onboarding and installs the stub; a fresh-install sandbox needs a custom launcher (this task used one under the scratch folder).

## Screenshot hygiene
All 54 PNGs in `evidence/fr/` were opened (the reviewer opened every one at full size) and no local path was found; none was redacted. The evidence JSON that had a dev-server path uses `<dev-server module>`.

## Area: Everywhere: navigation, keyboard, live updates, Back and reload, phone width (journeys/task-13a.md)

# Task 13a: Everywhere (navigation, keyboard, live updates, idle load, history, phone and light theme)

Live runs: Playwright headless against the shared sandbox (UI and Gateway on loopback, auth mode `none`, stub model, no OS keychain), `default` workspace, one fresh browser context per check. Evidence: `docs/review/2026-11-usability/evidence/gl/`. Journeys GL-1 to GL-7 only; the token-mode and large-data steps are Task 13b. New findings are U-GL-046 to U-GL-051.

## GL-1 Every sidebar entry, every tab in every area, and every command palette entry opens the page its label names
Result: FAIL (nothing new is dead: the three failures are existing findings; one new polish finding on titles)
Findings: U-GL-051 (pages do not carry the label's name); existing: U-CP-003 (links to the unavailable capability-scope pages), U-CH-017 (old /cowork/workspace link ends on 'Page not found'), U-SY-001 (Workers held back but served and linked, unlabelled)
Time: each page was ready (one h1, content) within the 1.3 s the crawl waited; no destination needed a second try.
Code path: `apps/mission-control-next/src/cockpit/app/routes.ts` (COCKPIT_AREAS) -> `Sidebar.tsx`; tab rows from `system-views.ts`, `work-views.ts`, `capabilities-tabs.ts`, `library-sections.ts`, `settings-route-homes.ts`; palette from `CommandPalette.tsx` (DESTINATIONS, TAB_DESTINATIONS, buildSettingsIndex) -> `cockpit-compatibility.ts` (resolveCockpitCompatibility) -> `CockpitShell.tsx` -> area component; document titles from `cockpit-document-title.ts`.
Live:
1. Built the list from the code, then enumerated the palette by opening Ctrl+K and typing a single '›' (it matches every entry): 7 area entries, 9 System, 5 Work, 4 Capabilities, 11 Library, 2 Advanced-setup entries and 19 Settings entries, 57 in all.
2. Crawled 306 page loads in two passes (1440 px dark and 375 px light, headless): 7 sidebar clicks (Settings through the gear menu), 33 tab clicks, 57 palette clicks, 45 direct deep links (anchors, held and experimental pages, health-card links) and 59 compatibility URLs (/ops/..., /cowork/..., /code, /projects, /library/skills, retired /settings/... sections, ?tab= and ?surface= roots, nonsense paths). For each: final URL, visible h1s, title, console errors, failed requests, horizontal overflow, and text checks.
3. Result: every page had exactly one visible h1, zero console errors (apart from the expected 404 for an unknown approval id), zero failed requests (cancelled requests ignored) and no horizontal overflow at either width. No approval-mode 403 appeared because no project conversation was opened.
4. Landing choices that look odd but are design: sidebar Chat opens the last conversation (the h1 is its title), Capabilities opens the remembered tab, Library opens 'Candidates and mesh'.
5. Palette entries and tab labels all land on a page that names them or on the group page that holds them (Settings entries land on the group tab with the right section selected). Every anchor exists (`gl-1-anchors.json`: 'updates' resolves through an alias to #application-updates, and #appearance and #providers are tab ids, not element ids).
6. Health-card links (`gl-1-health-links.json`): all eight open the right page; 'Review managed local models' goes through /settings/local-ai to Models.
7. Pages that say 'Page not found' (nonsense paths and /cowork/workspace) and 'Settings destination unavailable' (the three capability-scope URLs) are listed in the crawl file.
8. Release scope (`gl-1-release-scope.json`): 12 entries are not 'ship'; the only ones reachable and unlabelled or linked and dead are Workers (U-SY-001) and the two capability-scope pages (U-CP-003).
Failure tried: unknown approval link /inbox/approvals/does-not-exist: the Inbox opens and its inspector says 'Approval not found.' (a first look at only the main text missed it; confirmed on the screenshot); the console shows the 404. Unknown paths in every area: 'Page not found' with 'Choose a destination from the navigation to continue.' and no link back.
Evidence: `evidence/gl/gl-1-crawl.json`, `gl-1-release-scope.json`, `gl-1-health-links.json`, `gl-1-anchors.json`, `gl-1-unknown-approval.png`, `gl-1-unknown-approval.txt`
Not covered: Chat project views with a project open; the 403 on the approval-mode read (known, Task 6); pages that need data this sandbox lacks (a note, a memory item, a dashboard widget).

## GL-2 Every link out of the Cockpit
Result: PASS
Findings: none (no Cockpit task ends in Classic)
Time: n/a (code read plus one live check of the two embedded pages)
Code path: `git grep` for `shell=classic`, `ClassicOwnerLink`, `EmbeddedClassicPage`, `buildClassicOwnerUrl`, `useCockpitShellSwitch` over `apps/mission-control-next/src`, `packages/mission-control-shared/src`, `apps/gateway/src`; every hit opened. `Sidebar.tsx`, `MobileTabBar.tsx`, `CommandPaletteView.tsx`, `CockpitShell.tsx`, `use-cockpit-shell-switch.tsx`, `WorkKanban.tsx`, `LibraryPromptPacks.tsx`.
Live:
1. Opened /work/kanban (Older Kanban view, Experimental badge) and /library/prompt-packs: both work inside the Cockpit.
2. Opened the gear menu (items: Settings, Use light theme, Match system theme, Switch to classic Mission Control) and read the palette entry; did not press either Classic entry.
Failure tried: n/a.
Evidence: `evidence/gl/gl-2-classic-links.json` (table: where it renders, which journey reaches it, what it does). Summary: three explicit 'Switch to classic Mission Control' choices (gear menu, phone More sheet, palette) leave to Classic and save it as the default; one 'This view is available in Classic' page that only a hand-typed ?shell=classic address reaches; one dead helper (`use-cockpit-shell-switch.tsx` `visit`, no caller); two embedded Classic pages that work (Older Kanban, Prompt packs); no Gateway service emits a Classic address.
Not covered: the Classic shell itself (out of scope). Whether the Inbox 'task deliverable' update (`/work/kanban?taskId=...`) opens that task in the Older Kanban was not settled: the page opened with no visible selection for the id I tried.

## GL-3 Keyboard only: reach and operate the primary action of each area; focus is visible; a dialog returns focus on close
Result: FAIL
Findings: U-GL-046 (first Tab starts at the current tab), U-GL-047 (focus dropped after Refresh and after a Settings approval), U-GL-048 (Escape in Chat rename); existing U-GL-025 and U-GL-039 not re-tested
Time: Chat: type and Enter to the stub reply 1.08 s. Inbox: Enter on my Approve once to the card gone 1.24 s. Capabilities: Space to dialog 1.0 s, Enter on Approve once to closed 0.53 s. Settings: Enter on Save to dialog 0.84 s, Approve once to closed 0.21 s.
Code path: `use-area-shortcuts.ts`, `OverflowTabs.tsx`, `ui/Sheet.tsx`, `AreaHeader.tsx`, `InboxArea.tsx`, `HealthOverview.tsx`, `ChatSessionControls.tsx`, the governed Settings controls.
Live (Tab presses counted from page load; focus ring measured on every stop as computed outline or box-shadow):
1. Chat: the composer is where the first Tab lands (1 press); 'New' needs 17; typed 'ut13 keyboard check hello', Enter, stub reply in 1.08 s.
2. Inbox: my own approval's 'Approve once' was 25 presses away (the seeded and earlier approvals come first); Enter approved it in 1.24 s and focus moved to the next card's Details.
3. Work: 'New task' needed 54 presses because the first Tab starts at History (U-GL-046); Enter opens an inline form with focus in the title field; 3 more Tabs to 'Create task'; task created.
4. Capabilities: the 'documentation' skill switch is 26 presses away; Space switched it off at once; Space again raised the approval dialog (focus on 'Close dialog'), 2 Tabs to Approve once, closed, focus back on the switch, switch On.
5. Library > Memory: no memory item exists in this sandbox, so only the first real control (Show all statuses, 9 presses) was reached; opening a memory item was not run.
6. System: 'Review runtime service' 9 presses; Enter opened /system/runtime (h1 Runtime).
7. Settings: first control 2 presses; Models > 'Show model reasoning in Chat' switch 11 presses, Space, 'Save setting' 1, Enter, dialog with focus inside, 2 Tabs to Approve once, Enter: saved, focus on the page body (U-GL-047); same again to restore; after reload the value was kept, then restored to Off.
8. Shortcuts: g then i, a, l, s, t, w, c all navigate (Capabilities opens the remembered tab, Settings opens General); '?' opens the shortcut help with focus inside and returns it on Escape; Ctrl+B collapses the sidebar (231 to 39 px); Ctrl+K opens the palette with focus in its search box and Escape returns focus to the previous control in all seven areas.
9. Focus visibility: no stop in any trace lacked an outline or shadow; no focus trap (Tab wraps through the browser chrome to the Skip link).
10. Dialogs: the Chat + options panel, the palette, the Capabilities approval and the Settings approval all took focus on open; they returned it on close, except the Settings approval and the Chat rename (see findings).
Failure tried: Escape in the Chat rename box and on the Work New task form (the form stays open on Escape; focus stays in its field).
Evidence: `evidence/gl/gl-3-keyboard.json`, `gl-3-dialogs.json`, `gl-3-first-tab-start.txt`, `gl-3-focus-after-enter.txt`, `gl-3-inbox-approve.json`, `gl-3-capabilities-skill.json`, `gl-3-settings-save.json`, `gl-3-shortcuts.json`
Not covered: Library 'open a memory item' (no memory exists; operator steps: approve a memory write from Chat, then Tab to the item in Library > Memory and press Enter); screen-reader behaviour.

## GL-4 Live updates: change something in one tab, the other shows it within 10 seconds
Result: PASS
Findings: none
Time: an approval created by the Gateway appeared in page A in 0.26 s and in B in 0.52 s; Approve once in A, row gone in B 1.27 to 1.31 s after the click (both Inbox badges 5 to 4); new task in A visible in B 0.27 s (1.18 s after the click); Chat message from A in B 1.85 s and 2.49 s (two runs), the stub reply in B within 0.1 s of A; skill off in A, off in B 1.05 s after the click, back on, B On 1.06 s after Approve once; Settings value approved in A, B showing it 1.6 s later, and the restore reaching B within 1 s.
Code path: Inbox poll (30 s) plus the Gateway event stream; React Query invalidation after each owner action; the Chat stream; `GET /api/v1/settings` re-reads.
Live: two pages in one browser context, same workspace (`default`), 250 ms polling for the change in B, no reload.
1. Approval: created through the dev verification route, then approved in A.
2. Work: New task in A through the UI.
3. Chat: sent a message in A with B on the same conversation; checked B's thread and its list preview.
4. Skill: switched `documentation` off and on in A, approving its own approval.
5. Setting: Settings > Models 'Show model reasoning in Chat' on then off in A.
Reverse freshness: B never showed anything A had already undone (final state of A and B identical in every scenario, Inbox counts equal).
Failure tried: none provoked (every measurement was far under 10 s).
Evidence: `evidence/gl/gl-4-live-updates.json`. The task scenario was run twice; the second run found the first run's 'ut13-live-task' already on the page, so only the first run's numbers (0.27 s, 1.18 s) count. Both pages share one browser, so a second device was not tested.
Not covered: a second machine or browser profile; a live update on a phone.

## GL-5 Idle for two minutes on each area: count requests; more than 12 is a finding
Result: FAIL (System 16, Settings > Models 14)
Findings: U-GL-050
Time: n/a (120 s per page after a 5 s settle, one page open at a time)
Code path: `refetchInterval` users (47 in the Cockpit and shared packages): `HealthOverview.tsx:125` (60 s), the governed Settings controls (60 s each), `SystemDiagnostics.tsx` (30 s), the Inbox poll, notification presence.
Live: Chat (no thread) 6, Chat (open thread) 6, Inbox 6, Work 8, Capabilities > Skills 6, Library > Memory 6, System 16, Settings > General 6, Settings > Models 14. Every page: 4x GET /api/v1/inbox (every 30 s) and 2x PUT /api/v1/notifications/presence (every 60 s). System adds 2 each of observe/health, llamacpp/status and npu/status and more; Settings > Models adds 8x GET /api/v1/settings (one per control, every 60 s each).
Failure tried: n/a.
Evidence: `evidence/gl/gl-5-idle.json` (top repeated URLs per page)
Not covered: a hidden tab (browsers throttle timers); a long-running run on screen (WorkRunDetail polls every 15 s by design).

## GL-6 Back, Forward and reload on each area keep the operator's place; an unsaved draft is guarded
Result: FAIL (scroll position lost on Back in Work)
Findings: U-GL-049; existing U-IN-006 (Inbox selection not in the URL; the opened 'Approval history' is not either)
Time: n/a
Code path: `cockpit-back-guard.ts`, `use-cockpit-scroll.ts` (position per address), `UnsavedChangesDialog.tsx`, per-area route sync.
Live:
1. Chat: two conversations opened in turn; Back returned to the first, Forward to the second, reload kept it. PASS.
2. Inbox: opening Approval history adds no history entry, so Back left the Inbox; reload shows it closed (U-IN-006 family).
3. Work: Board to a task page: Back to /work, Forward and reload all kept the place; but scroll after Back was 90 px instead of 200, 500 or 1500 px (U-GL-049, two lists, three distances).
4. Capabilities: opening a skill panel adds a temporary history entry (`?item=skill:bundled:documentation`); Back closes it; Forward does not reopen it (the back guard drops that temporary entry on purpose).
5. Library, System, Settings: Back, Forward and reload returned to the same tab or section each time.
6. Drafts (typed text, then sidebar click, browser Back and reload): Settings (a new notification destination label), Work (New task title) and Library (New note) are guarded: the sidebar and the browser Back raise 'Unsaved changes: Keep draft and close / Discard changes / Cancel' (Cancel stays on the page with the text), reload and a cross-document Back raise the browser's own leave prompt. The Chat composer is not guarded: its text is kept silently across a trip to Inbox and back and across a reload (no text lost).
7. Existing U-PJ-005 (no sign of a kept project draft) not re-tested.
Failure tried: reload and Back with a draft in each of four editors (item 6).
Evidence: `evidence/gl/gl-6-navigation.json`, `gl-6-scroll-restore.json`, `gl-6-forward-and-scroll.json`
Not covered: Back through a longer history (three or more levels); Inbox with a selected item (not in the URL, U-IN-006).

## GL-7 Phone width and light theme on each area's first screen: nothing cut off, nothing unreadable
Result: PASS
Findings: none new; existing U-GL-006 (phone tap targets) and U-GL-011 (12 and 13 px body copy) seen but not re-measured
Time: n/a
Code path: `MobileTabBar.tsx`, `MobileNavigationSlot.tsx`, `OverflowTabs.tsx` (picker mode on phones), the area pages.
Live: 375x812 light (touch) and 1440x900 dark, first screen of Chat (list and thread view), Inbox, Work, Capabilities, Library, System and one Settings page: 16 screenshots, all opened at full size and checked by eye.
- At 375: no horizontal scroll on any page (document and #main-content overflow 0), nothing overlapping; Work's column filter strip scrolls sideways with the next tab partly visible (a scroll cue); System, Library and Settings turn their tab rows into a select box; the bottom bar shows the current area, and the 'More' tab carries aria-current and an underline on Capabilities, System and Settings (U-GL-028 did not reproduce; see Notes).
- At 1440: no overflow; sidebar and content readable.
- At 1024x768 (metrics for every area, plus one screenshot with the Chat inspector open): no overflow on any page; with the inspector open the Conversation panel overlays the right half of the thread and covers the composer's Send button until it is closed (a floating inspector, by design).
Failure tried: n/a.
Evidence: `evidence/gl/gl-7-*-375-light.png`, `gl-7-*-1440-dark.png` (16), `gl-7-chat-inspector-1024.png`, `gl-7-layout.json` (overflow, clipped elements, controls under 32 px and font sizes per page). PNGs opened: 17 of 17; none showed a local path, none redacted.
Not covered: dark theme at 375 and light theme at 1440 (not asked); landscape phone.

## Steps 2 and 3 (token mode, large data): done in Task 13b

## Sandbox changes
Created (all named `ut13...`; the UI has no delete for them, so they remain): Chat conversations 'ut13 keyboard check hello' (2), 'ut13-kb-approval', 'ut13-kb-approval-2', 'ut13-live-approval' (2), 'ut13-live-chat' (2) and a few empty 'New chat' conversations; Work tasks 'ut13 keyboard task' (2) and 'ut13-live-task' (2); the approvals they raised (code-mode, caution): all approved except one that I denied in the Inbox. Switched and restored: skill `documentation` (off and on several times, each 'on' approved in place) and the setting 'Show model reasoning in Chat' (on and off twice, approved, final value Off). Text typed in the draft tests was never saved. The seeded shell.exec approval was left pending.

## Notes on existing findings
- U-GL-028: not reproduced at 375 px light. On Capabilities, System and Settings the 'More' tab has aria-current=page and a teal underline (`gl-7-capabilities-375-light.png`, `gl-7-system-375-light.png`, `gl-7-settings-375-light.png`); suggested status: verify and close.
- U-CP-003: the capability-scope pages also answer 'Settings destination unavailable' when reached as /settings/citadel-capabilities and /settings/workspace-capabilities (title 'Settings · Citadel capabilities'); same defect.
- U-IN-006: also true for the 'Approval history' panel (not in the URL), see GL-6.

## Design decisions to confirm
- The Chat composer keeps its text silently when you leave and return, while the Settings, Work and Library editors ask before you leave. Both are reasonable, but an operator moving between them may not expect the difference.

## Engineering notes
- `use-cockpit-shell-switch.tsx` exports `visit()` with no caller.
- `git grep -E "/work/kanban"` returned nothing while `git grep "work/kanban"` found the hits: use plain strings.
- Other `scrollIntoView` callers (for example `WindowedRecordList.tsx:212`) may set the same Tab starting point as `OverflowTabs.tsx:53`.

## Area: Everywhere: token sign-in, large data, production build (journeys/task-13b.md)

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

## Area: Messaging channels, integrations and the real-model pass (journeys/task-14.md)

# Task 14: Messaging channels, integrations and the real-model pass

Shared sandbox: auth mode none, stub model, no OS keychain. The real-model pass ran in its own sandbox (Claude Code CLI login, model claude-sonnet-5-5), stopped afterwards. Nothing left the PC except what the Claude CLI itself sends for the real-model pass; no channel message, email, calendar change, webhook call or OAuth consent was made. Credentials typed: `test-invalid-token` and fake ids only.

## MS-1 Channel setup to the credential step with an invalid credential
Result: PARTLY RUN (four guided channels and four Advanced-setup channels reached the credential step; every invalid credential stopped at the sandbox's missing secure storage, so no vendor error text was read)
Findings: Telegram, Discord and Slack setup blame the key or token when the real cause is no secure credential storage; Advanced channel setup reports a plainly refused credential save as 'Outcome uncertain' and locks the page; every 'Start guided setup' saves another draft; delete-draft dialog is titled 'Review channel lifecycle change'; a public web address awaiting approval is forgotten on reload; 'Who may message this bot?' marked Complete before anything is entered; finding your sender id needs a dropped message and System > Diagnostics (all in `new-findings/task-14.json`, area messaging). Also U-ST-001 and the keychain finding from task 13b are the same sandbox limit (not recorded again).
Time: first feedback on Check key / Check token / Check 83 to 111 ms; Save draft 83 ms to the first message; Start over 1.5 s; draft delete about 3 s.
Code path: Chat `MessagingSection.tsx` (Add) -> `ChannelPicker.tsx` / `channel-picker-model.ts` (four channels have a page of their own in Chat, ten go to `ChannelAdvancedSetup.tsx` > `cockpit/areas/settings/ChannelsSettings.tsx`) -> `use-telegram-setup.ts`, `use-discord-setup.ts`, `use-slack-setup.ts`, `use-whatsapp-setup.ts` -> `POST /api/v1/channels/drafts`, `PATCH .../drafts/:id`, `POST .../drafts/:id/secure-fields` (`apps/gateway/src/routes/integrations-channel-setup-routes.ts`, `channel-setup-draft-security.ts:79` throws the 'Secure channel credential storage is unavailable.' 422). Inbound path (code read only): provider route (`integration-webhooks-*-routes.ts`, Telegram poll, Discord and Slack sockets) -> `webhook-handler-factory.ts` -> `channel-inbound-dispatch.ts` (sender trust gate `evaluateInboundWebhookAccess`, bot-loop guard 20 per 60 s) -> durable accept and worker -> turn -> `channel-delivery-runtime-service.ts` (queue, backoff, approval-pending recovery) -> provider send. Operator view: `GET /api/v1/chat/messaging` (`chat.messaging.ts`) -> `MessagingSection.tsx` / `ChannelPage.tsx` (status, people, posting places, manage).
Live:
1. Chat > Messaging showed 'No channels yet' twice (header Add and body Add) and the picker 'Add a channel' with 14 tiles in three groups (Quickest, Team and self-hosted chat, Phone apps), each with minutes and a note.
2. Telegram, Discord, Slack: typed a fake token, pressed Check. Within 0.1 s the page said '<Vendor> didn't accept that key/token, or GoatCitadel couldn't reach <Vendor>…'. The API log shows POST draft, (PATCH), POST secure-fields = 422, no vendor call; so the message names the wrong cause.
3. WhatsApp: step 1 needs a public web address. Typed `https://ut14-test.example.com`, Save address: an in-place card 'Waiting on you · Set GoatCitadel's public web address…' with Approve once (Caution, one click). I reloaded before approving: the page forgot it (finding), and the second Save said 'Settings changed elsewhere'. Approved it from the Inbox (one Approve once). Then step 3 opened; fake ids and token, Check: 'This page stores your keys in this computer's secure storage, which isn't available here. Use WhatsApp's guide in Advanced channel setup with environment variables instead.' (the right wording, 111 ms).
4. Advanced channel setup: Teams (webhook URL; code read: a non-URL value fails the structural check before any send), LINE, QQBot, WeCom: Start guided setup, ticked the preparation items, reached 'Connect the account'. Teams: typed `test-invalid-token`, Save draft: 'Secure channel credential storage is unavailable.' then 'Outcome uncertain… locked' (finding). The three others were not submitted (same path).
5. Cancel: Back to channels asks 'Unsaved changes' (Save and continue, Keep draft and close, Discard changes, Cancel). Discard keeps the saved draft. Start over (guided pages) discards the draft at once, no confirmation, one click. The Drafts list (Advanced) deleted every draft I made, one confirmation each. Left behind: 0 drafts, 0 connections, no stored secret (none could be stored).
6. Keyboard: not exercised on these pages beyond typing into the fields (the scripted run clicked the buttons); keyboard use was exercised in the MS-4 chat journeys (Enter to send).
Failure tried: an invalid credential on every reachable channel (above).
Evidence: `evidence/ms/ms-1-picker.png`, `ms-1-telegram-invalid-credential.png`, `ms-1-discord-invalid-credential.png`, `ms-1-slack-invalid-credential.png`, `ms-1-whatsapp-invalid-credential.png`, `ms-1-whatsapp-reload-pending.png`, `ms-1-whatsapp-second-save.png`, `ms-1-teams-uncertain-lock.png`, `ms-1-teams-after-check-outcome.png`, `ms-1-teams-after-back.png`, `ms-1-teams-after-discard.png`, `ms-1-delete-draft-dialog.png`, `ms-1-line-credential-step.png`, `ms-1-draft-count.json`.
Not covered: a credential that reaches the vendor (needs a keychain and, for a real answer, a real account); the error text the vendor-side check returns; the later steps (invite, choose where it posts, turn on, say hi) and one real message in and out per channel (operator checklist below). The other eight channels (Slack and Discord Advanced variants, Google Chat, Matrix, Mattermost, ntfy, Nextcloud Talk, Zalo OA, Teams webhook, LINE, WeCom, QQBot) were not each walked past their first step; their setup pages are catalogue-driven and share the editor tested here.

## MS-2 A channel marked incomplete or blocked says so before the operator starts
Result: PARTLY RUN (what the picker and setup pages promise was read for all 14 channels; a saved connection in each state could not be made without a credential)
Findings: none new beyond MS-1; the picker notes and setup intros do say 'Sends only' (Teams, Zalo OA), 'Receiving needs a public web address' (Google Chat, LINE, WeCom, Nextcloud Talk), 'Needs a public web address' (QQBot), 'Business account + public web address' (WhatsApp). Maturity ('beta' for 13 of 14 channels, 'native' for Nextcloud Talk) is not shown to the operator anywhere; not a finding (a beta is not incomplete), listed under Design decisions to confirm.
Time: n/a
Code path: `channel-picker-model.ts` (tiles from the Gateway's `picker.note`), `ChannelPage.tsx` (retired channels: `describeRetiredChannel` in `packages/contracts/src/channels.ts:91` for Zalo Personal, Signal and iMessage show their reason and 'its conversations stay readable'; a connection for one of them can be removed only), `presentChannelStatus` (status badge).
Live:
1. Read all 14 tiles and the Advanced intro text for Teams, Matrix, LINE, WeCom, QQBot: each says what it needs and whether it only sends.
2. Teams intro: 'Sends only: Teams can't message GoatCitadel. No public web address is needed.' before the first click.
3. The picker is silent about the public web address already being set or not; the address field is at the top of every Advanced channel page, including for Teams, which does not need it.
Failure tried: none possible (no connection).
Evidence: `evidence/ms/ms-1-picker.png`, `ms-2-advanced-teams.png`, `ms-2-line-who-may-message.png`.
Not covered: the retired-channel page (needs a saved Zalo Personal, Signal or iMessage connection); a channel page in 'Needs attention' or 'Paused' state. Operator: only if you still hold an old connection of those three kinds, open it from Chat > Messaging and check it says it is not supported and offers only removal.

## MS-3 Integrations: Google sign-in and a vendor MCP connector up to their credential step
Result: PARTLY RUN (both stopped before the browser hand-off: Google by the missing keychain, Asana by the approval; no account was touched)
Findings: 'Set up' on Gmail and Google Calendar ends on an empty list (eight more steps); 'Disabled · Configured status: Connected'; diagnostics disabled with no way to turn them on; hash printed in the delete dialog; platform entries in the Add integration list; vendor MCP install sends the operator to the Inbox (all area capabilities in `new-findings/task-14.json`).
Time: Asana install panel to 'Waiting on Inbox…' 0.8 s; Gmail connection created 4.1 s after Apply reviewed connection.
Code path: Connectors list -> `ConnectorPanel.tsx` / `ConnectorInstallPanel.tsx` -> `connector-install-server-steps.ts` (`startSignIn` -> `commitMcpOAuth` -> Gateway `mcp-oauth-handshake-service.ts` builds the authorize address; `ConnectorSignInStep.tsx:104` shows it as an 'Open sign-in page' link, `target=_blank`, nothing opens by itself). Google: `GoogleWorkspaceSignIn.tsx` -> `use-google-workspace-sign-in.ts` -> `POST /api/v1/integrations/connections/:id/google-oauth/start` (`integrations-google-oauth-routes.ts:54`, returns the flow and does not launch a browser) -> link 'Open Google sign-in' (`GoogleWorkspaceSignIn.tsx:94`); in the desktop app the page shows 'Open Google setup in browser' instead (line 50) and the operator finishes in the system browser.
Live:
1. Connectors > Gmail and Google Calendar > Set up: a side panel 'Not installed / Signs in with your Google account / Advanced setup'. Followed it: Advanced setup > Integrations > 'Saved integrations' empty > Add and manage integrations > Add integration connection > chose Gmail and Google Calendar > client ID `test-invalid-client-id…` > Review new connection > Apply reviewed connection ('Connection Gmail and Google Calendar created.') > Manage.
2. Google sign-in section: 'Not signed in to Google. The OS keychain is unavailable, so GoatCitadel cannot keep a Google sign-in on this computer.' Connect Google disabled. No browser window, no popup, no external request (external requests were blocked in the script and none was attempted).
3. Removed the connection (Delete integration connection, confirmation, 'Connection deleted.'): 0 connections left.
4. Connectors > Asana > Install: panel 'Signs in at mcp.asana.com. Installing makes sure mcp.asana.com is on your network allowlist.' and 'Sign in and install'. Pressed it: 'Waiting on Inbox… / Stop', steps Approve in Inbox (waiting), Allow and save, Sign in, Switch on, Connect (not started). Inbox: 'Install Asana', Danger, 'Allow mcp.asana.com. Save Asana, switched off, set to Reading is free. Let Chat use connectors.' with Review. The panel recovered the same waiting state after a reload (good).
5. Stopped here: approving adds the vendor host to the network allowlist and would be followed by the OAuth start, which contacts the vendor. The pending approval was left to expire (15 minutes); it is the only thing from this task left in the shared sandbox.
Failure tried: reload during the install wait (state recovered).
Evidence: `evidence/ms/ms-3-gmail-setup.png`, `ms-3-add-integration-form.png`, `ms-3-integration-catalog-options.json`, `ms-3-google-sign-in-section.png`, `ms-3-delete-integration-dialog.json`, `ms-3-asana-panel.png`, `ms-3-asana-waiting-inbox.png`, `ms-3-asana-inbox-approval.png`.
Not covered: the browser hand-off itself for both (operator checklist), a vendor MCP call, an MCP server that needs a key instead of OAuth, the hand-registered MCP server (the existing finding U-CP-015 covers why Chat cannot reach it).

## MS-4 Real-model pass: CH-1, CH-2, CH-9, CH-11 and CH-13 with the Claude CLI subscription
Result: PARTLY RUN (all five journeys ran; the exact-completion Stop race, the danger approval, a research request and opening a produced artifact were not reached)
Findings: 'Plan first' makes no model call; file-creation approval card names nothing; 'Outcome uncertain…' wording right after an approval (area chat in `new-findings/task-14.json`); U-CH-032 and U-CH-033 seen again with a real model.
Time: see each journey. Requests: 14 sends (13 reached the model), under 30; no paid API path (see `W/task-14-model-requests.md`, not committed).
Setup: `claude auth status` showed a signed-in subscription login; the testbench (`pnpm testbench:claude-cli`, `scripts/testbench.mjs`) builds a scratch runtime root and passes `GOATCITADEL_HOME` and friends inside it, writes the provider config there, never touches `config/goatcitadel.json`, and strips every API key variable from the Gateway's environment. I cleared my shell's CLAUDE and ANTHROPIC variables before starting it, hidden, on ports 57000 and 57001; stopped afterwards through its stop file.

### CH-1 First message in an empty install (real model)
Result: PASS
Time: 'Sending…' chip and Stop / Steer buttons 230 ms after Enter; answer text from about 3.0 s; done 4.3 s (receipt '3 s total', 'claude-sonnet-5-5 · Claude Code CLI (local login)'). Stub run: done 1.3 s.
Differences from the stub: a real 'Working' header chip and 'Sending' chip for about 3 s before any text; the conversation title appears from the first message. Nothing broken.
Evidence: `ms-4-ch1-early.png`, `ms-4-ch1-done.png`.

### CH-2 Stop, long answer, follow the stream (real model)
Result: PASS for Stop mid-stream and near the end, and for scrolling; the Stop-at-the-exact-completion race (U-CH-025) was not reproduced
Time: 400-word story: first text about 2.8 s after Enter (the stream arrives in chunks about every 0.1 s), done 14.5 s (receipt 12 to 13 s). Stop pressed at 5.2 s: the button went away 121 ms later; the header read 'Last response cancelled', the text so far stayed, 'Stopped — partial answer' with Continue, and 'You stopped this reply. What was written so far is kept.' Stop pressed at 9.0 s of a 9.5 s answer: gone in 138 ms, same result, no 'provider request failed' banner and no 400 (the stub run's U-CH-025 did not recur; the last-chunk window could not be hit on purpose, because the final text and the end of streaming arrive in the same frame).
Follow the stream: the view follows while the reader is within about 100 px of the bottom (a wheel-up that stayed that close was undone at the next chunk). Scrolled 400 px up in a taller thread it stayed put for 5 more seconds of streaming, 'Jump to latest' appeared and the end position was not forced. Good.
Evidence: `ms-4-ch2-a-before-stop.png`, `ms-4-ch2-a-after-stop.png`, `ms-4-ch2-b-after-stop.png`, `ms-4-ch2-d-scrolled-up.png`, `ms-4-ch2-d-done.png`, `ms-4-ch2-a-timing.json`, `ms-4-ch2-b-timing.json`, `ms-4-ch2-c-scroll.json`, `ms-4-ch2-d-scroll.json`. No citations or tool steps occurred in text-only answers.

### CH-9 An action that needs approval (real model)
Result: PASS (the turn continued by itself after one click)
Time: file creation request: approval card at 8.2 s, buttons about 0.3 s later (card first says 'Loading approval controls…'), Approve once clicked at 8.6 s (Caution: one click, no dialog), the turn carried on without a Continue step and without opening the Inbox, finished at 28.6 s (receipt '27 s total'). A request for a shell command raised no approval: shell exec is off in policy and the model said so in plain words (a second try with a safer action was not needed).
Differences from the stub: the card arrives while the model works (Stop and Steer stay on, the composer says 'A decision is waiting above. Resolve it to keep going.'); after approval there are 19 s of work with streaming text, a 'Working' chip and a tool row; the interim 'Outcome uncertain…' wording and stale 'Waiting on you' row (findings).
Evidence: `ms-4-ch9a-t8.2s.png`, `ms-4-ch9a-t9.7s.png`, `ms-4-ch9a-end.png`, `ms-4-ch9a-states.json`, `ms-4-ch9b-states.json`.
Not covered: a Danger approval from a real turn (two clicks by design, DESIGN.md:60).

### CH-11 A planning request (real model)
Result: FAIL
Time: 2 s, no model call (finding): same fixed template and the same 'Done / 0 of 4 steps / Queued' card as the stub run. A research request and a failed step were not tried (no web allowed, nothing to fail).
Evidence: `ms-4-ch11-end.png`, `ms-4-ch11-inspect-run.png`, `ms-4-ch11-states.json`.

### CH-13 Code Mode run from Chat (real model)
Result: PARTLY RUN
Time: 'Write a tiny JavaScript function that adds two numbers and run it' (code mode): approval card at 3.8 s ('Run code to add 2 and 3 with a small JS function · Loading approval controls…'), 'Run it' one click at 4.2 s, 'Running code…' at 5.0 s, answer 'The result is 5.' with the code, 'Ran code to add 2 and 3 with a small JS function · 2 s', Keep as a tool, Details; done 9.9 s. A request for a CSV artifact used the documents tool instead (one Approve once at 4.5 s): 'Created 1 document · 1 done', a 'Download the document' link (in-page handler; not clicked, nothing downloaded) and a table; done 10.5 s.
Differences from the stub: this is the first real run; the card, run and result worked end to end with no workaround. The model said it did not use code mode for the CSV.
Evidence: `ms-4-ch13-t3.8s.png`, `ms-4-ch13-end.png`, `ms-4-ch13b-end.png`, `ms-4-ch13-states.json`, `ms-4-ch13b-states.json`.
Not covered: an artifact produced by Code Mode itself, opening it, and Run named proof (needs a git project).

## Design decisions to confirm
- Maturity ('beta' on 13 of 14 channels, 'native' on Nextcloud Talk) is never shown to the operator. Is a 'beta' label wanted on the picker tiles?
- The picker's minutes differ from the setup page's own estimate for the same channel (Telegram 3 min tile, 8 min in Advanced; WhatsApp 15 versus 8). Presumably the guided path versus the manual one; the tile does not say.
- 'Plan first' stays on after sending. Presumably intended (a mode chip), but the next message is planned too.

## Notes on existing findings
- U-CH-032, U-CH-033: reproduced with a real model, unchanged (and the plan is not model-written, see the new finding).
- U-CH-025: not reproduced with a real model (Stop pressed at 9.0 s of 9.5 s was clean); keep it likely, severity friction is fair because the exact-completion window is about one frame.
- U-CP-012, U-CP-013, U-CP-011: the same patterns recur for connector install, integration rows and the delete dialog (new findings reference them).
- U-CH-018: the composer showed no 'Approval mode unavailable' row in the real-model conversations (conversations were not in a project).

## Engineering notes
- `GET /api/v1/files/download` returns JSON (`encoding: base64`), not a file; the Chat link 'Download the document' works through an in-page handler (`AssistantMessageRenderer.tsx`), so the plain href alone would show JSON.
- A script that calls the Gateway mutations directly needs an `Idempotency-Key` header, otherwise 400.
- The testbench takes about 40 s to start when the Gateway is already built.

## Operator checklist
Run these on a PC with a working OS keychain, your own accounts and, where noted, a public https address (reverse proxy or tunnel). Nothing here was run by the review.

1. Any channel, one real message in and out (repeat per channel; credentials in the table). Chat > Messaging > Add > the channel's tile. Follow the steps to the end: credential, who may message, where it posts, Turn on. Pass: the status badge in Messaging reads working; send a message from your phone or app to the bot; it appears under the channel in Messaging within about 10 seconds with a new-message count; type an answer in Chat or let the agent reply; it arrives in your app; Back in Chat the conversation shows the reply as sent. Failure to look for: a message from a sender you did not allow must not open a conversation (System > Diagnostics shows 'Dropped a … message from …').
   - Telegram: bot key from BotFather; no public address; use the 'say hi' step.
   - Discord: Developer Portal bot token, Message Content Intent on; invite the bot; choose where it posts.
   - Slack: Create the Slack app link, copy Bot token (xoxb-) and App-level token (xapp-).
   - WhatsApp (Cloud API): public address first; phone number id, business account id, app id, app secret, system-user token; 'Point Meta at GoatCitadel' uses the shown callback address; say hi from your phone.
   - Microsoft Teams (sends only): Workflows webhook URL whose trigger is Anyone; the test posts a card; confirm it arrived. No inbound.
   - Google Chat, LINE, WeCom, QQBot, Nextcloud Talk: Advanced channel setup > Start guided setup; public address needed to receive; fill the credential step; Validate the draft; Finish setup; Verify the first conversation. For receiving, add your own sender id under 'Who may message this bot?' (message the bot once and read it from System > Diagnostics).
   - Matrix, Mattermost, ntfy, Zalo OA (sends only): same Advanced route; Matrix needs a bot account and homeserver, Mattermost a server and bot token, ntfy a topic you control (and write-restricted for inbound), Zalo OA an Official Account.
   Also check on this PC what the screen says when the secure credential store works: type a deliberately wrong token and read the vendor error (the review could only see the 'secure storage unavailable' path).
2. Google sign-in (Gmail and Calendar). Create an OAuth client of type Desktop app in your Google Cloud project, enable the Gmail and Calendar APIs. Capabilities > Connectors > Gmail and Google Calendar > Set up > Advanced setup > Add and manage integrations > Add integration connection > Gmail and Google Calendar, paste the client ID, Review, Apply. Manage > Connect Google > choose capabilities, paste the client secret > Continue. In the browser app, click 'Open Google sign-in', allow only what you chose; in the desktop app click 'Open Google setup in browser' and finish there, then Refresh sign-in status. Pass: the section reads connected with the granted capabilities, a Gmail read works in Chat, a send or event create asks for approval every time. Disconnect Google must say whether Google revoked access.
3. Vendor MCP call. Capabilities > Connectors > Asana (or another vendor) > Install > Sign in and install. Approve the request in the Inbox (it adds the vendor host to the network allowlist), come back to the panel, click 'Open sign-in page', sign in, return. Pass: the panel moves through Allow and save, Sign in, Switch on, Connect without a reload; the connector shows Connected; ask Chat 'list my Asana projects' (with 'Also let Chat use connectors' ticked): a read runs without asking, a create asks first. If the panel does not carry on after you return, note whether 'Paste the code instead' is needed.
4. Real-model leftovers. (a) Danger approval from a real turn: in a project conversation ask 'Run the project's tests' (shell exec must be allowed in tool policy); Review danger approval then Approve once (two clicks by design); the answer carries on by itself. (b) Stop at the exact end: send a 300-word story and press Stop as the last paragraph appears; pass is 'Last response cancelled' with the text kept and no 'provider request failed' card. (c) Code Mode artifact: import a small git repo as a project, ask 'Write a TypeScript helper that sums two numbers, run it and keep the output as a file', approve once, check the card lists the artifact, open it, use Run named proof. (d) Click 'Download the document' on a created document in the packaged app and confirm a file is saved. (e) A research request with web search on: steps, sources and a final answer readable; a failing step names what failed.
