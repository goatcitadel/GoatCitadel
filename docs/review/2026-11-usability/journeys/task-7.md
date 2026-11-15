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
