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
