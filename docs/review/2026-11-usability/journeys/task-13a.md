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
