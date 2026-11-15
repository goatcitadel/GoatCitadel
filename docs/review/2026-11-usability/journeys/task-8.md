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
