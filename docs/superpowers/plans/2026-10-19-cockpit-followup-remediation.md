# Cockpit Follow-up Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps found by the 2026-10-19 follow-up review: the 38 regressions, the high and medium new findings, and the 41 still-open and 5 regressed old findings. The work runs as seven small PRs plus a separate porting phase.

**Architecture:** Fix the root causes first, then sweep. PR 1 contains the Classic pages mounted inside cockpit tabs with one wrapper and one stylesheet, before any port, which removes most visible regressions on five tabs at once. PRs 2–3 fix decisions and Settings anatomy and run in parallel, because their files don't overlap. PRs 4–7 are sweeps, each led by a guard change that makes CI fail on the class of defect before its call sites are fixed. Porting the Classic pages is Phase 3, one plan per page.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 cockpit tokens, TanStack Query, Vitest (happy-dom, react-dom/client `createRoot` + `act` test style), Node `node:test` guard scripts in `scripts/check-mission-control-next-*.mjs`.

**Spec:** the "Cockpit follow-up review" artifact, https://claude.ai/artifact/RGNznEavTEJECy8bu9pUXj. Its ledgers carry each finding's file:line, problem and fix, and its source files are in the session scratchpad `review/pass-*.md`. Read it with `DESIGN.md` and `PRODUCT.md` at the repo root, which are the standard. Finding IDs below (SY-R01, IN-L01…) are that artifact's IDs.

## Global Constraints

- Paths are relative to `apps/mission-control-next/src/` unless they start with `scripts/`, `packages/`, `config/` or `apps/` (for example `apps/gateway/` or `apps/mission-control-next/index.html`), or are the repo-root `DESIGN.md` and `PRODUCT.md`. `cockpit/` = `apps/mission-control-next/src/cockpit/`; `features/` = `apps/mission-control-next/src/features/`.
- Work in a fresh worktree off latest `origin/main`, one branch per PR (`fix/cockpit-followup-<n>-<slug>`). Never edit `C:\personal-ai` itself, which holds foreign WIP. Never `git stash`.
- Ask the user before every commit, push and PR. The user merges.
- PC load limits: one heavy job at a time on the whole machine. Before any vitest, tsc or build, check `Get-CimInstance Win32_Process` for node.exe running vitest, tsx or tsc, and wait. Run vitest only as single files at low priority with `--maxWorkers=2`, never `vitest --changed`, a full suite or a `verify:*` lane locally. Never wrap commands in a timeout. Long jobs run in the background. Full suites run in CI.
- Test command, one file: `pnpm --filter @goatcitadel/mission-control-next exec vitest run <path-from-app-root> --maxWorkers=2` (shared package: `--filter @goatcitadel/mission-control-shared`). Guard command: `node --test scripts/<guard>.test.mjs && node scripts/<guard>.mjs`.
- Prettier only on the files you touch, never a directory glob. For files that weren't prettier-clean on main, use the two-commit recipe: first a commit with prettier-only reformatting of the touched files, then the fix commit. If the reformat pushes a file past max-lines, extract code and call it out in the PR.
- DESIGN.md rules, verbatim: "Red (`variant="danger"`) means one thing: this action deletes, forgets, revokes, removes, discards unsaved work, or rejects in bulk, and the cockpit cannot take it back." "Deny is always a neutral secondary button." "A danger or nuclear approval is a red, risk-labelled review button with a shield icon." "Values are presented, never dumped." "Accessible names start with the visible text." "There is no eyebrow above the title, no second navigation row and no full-bleed panel." "Money … two-decimal money with "<$0.01" for tiny amounts and "Unknown" rather than $0.00."
- Glossary (DESIGN › Copy): operator copy never says Gateway, projection, durable, owner, posture, caller, admitted, readback, revision, evidence, replay, canonical or snapshot. Write "GoatCitadel" or name the page instead.
- Never `architecture:baseline:update`. Never hand-edit derived icons. No new dependencies.
- Each PR's description lists the finding IDs it closes. Visual baselines are regenerated once per wave by dispatching `visual-rebaseline.yml` and cherry-picking its branch: after PRs 1–3, and after PRs 4–7. Never rebaseline locally.

## Review Focus

- **An embedded Classic page whose data fails to load.** The wrapper must keep the cockpit column and show the Classic error state inside it, never a blank tab or a page outside the column. Test in Task 1.2.
- **A pending approval in another workspace while this workspace's Inbox is empty.** Expect no red box and no "all caught up" contradiction. If a count shows at all, it is labelled "in other workspaces". Test in Task 2.4.
- **Expired-but-still-pending approvals.** They must never count as decidable: not in the bulk reject count, not in Work's waiting list, and not with a "can't be decided yet" message. Tests in Tasks 2.3 and 2.4.
- **Money under one cent, and days with no known amount.** Expect "<$0.01" and "No day has a known amount", never "$0.0026+" or "highest day $0.00". Test in Task 5.2.
- **A Settings page with a single section.** Expect no tablist at all, and the h1 is the page name. Test in Task 3.1.

---

## Wave 1 (PRs 1–3)

### PR 1 · Contain the embedded Classic pages

Closes SY-R02, SY-R03, WK-R01, WK-R02, LB-R02, SY-R05, SY-L01, SY-N01 (workspace name), SY-N11, WK-R03, plus the visible part of VR-01, SY-01 and SY-04.

#### Task 1.1: `EmbeddedClassicPage` wrapper and stylesheet

**Files:**
- Create: `cockpit/ui/EmbeddedClassicPage.tsx`, `cockpit/styles/embedded-classic.css`
- Modify: `cockpit-entry.tsx` (import the stylesheet)
- Test: `cockpit/ui/EmbeddedClassicPage.test.tsx`

**Interfaces:**
- Produces: `export function EmbeddedClassicPage({ children, inColumn = false }: { children: ReactNode; inColumn?: boolean }): JSX.Element`. It renders `<div className={cn(AREA_PAGE, "cockpit-embedded-classic pt-0")}>`. With `inColumn`, the caller already renders inside `AREA_PAGE`, so the wrapper keeps only the containment class and a flex column, without the column padding twice. Tasks 1.2 and 1.3 use it.

- [ ] **Step 1: Write the failing tests.**
  - `it("renders children inside the cockpit column with the containment class")`: the wrapper's className contains `max-w-5xl` and `cockpit-embedded-classic`.
  - `it("skips the column padding when the caller already owns the column")`: with `inColumn`, the className keeps `cockpit-embedded-classic` and drops `max-w-5xl`.
  - `it("scopes the containment rules")`: read `../styles/embedded-classic.css` with `fs.readFileSync`. Assert that it contains `.cockpit-embedded-classic .mc-next-visually-hidden`, `.cockpit-embedded-classic .mc-next-button` with `display: inline-flex`, and `.cockpit-embedded-classic .mc-pp-kicker`, and no bare `#` color literals. Vitest doesn't apply CSS to happy-dom, so the computed styles are checked live in the Wave 1 close crawl.
- [ ] **Step 2: Run it and confirm it fails** (module not found).
- [ ] **Step 3: Implement.** In `embedded-classic.css`, every rule is scoped under `.cockpit-embedded-classic`:
  - `.mc-next-visually-hidden` gets the same declarations as `features/native-routes/calm-surfaces.css:2`.
  - `.mc-pp-kicker` and `.mc-pp-command-copy > span` get `display:none`.
  - `.mc-next-button` (all variants) gets `display:inline-flex; align-items:center; gap:.375rem`, and `svg` inside it gets `display:inline`.
  - Headings, `th`, labels and stat terms get `text-transform:none; letter-spacing:normal`.
  - Uses tokens only; no raw colors (the `verify:design:quality` budget).
- [ ] **Step 4: Run the test and confirm it passes.**
- [ ] **Step 5: Commit** `fix(cockpit): add an embedded Classic page wrapper (SY-R02, SY-R03)`.

#### Task 1.2: Mount every embedded page in the wrapper

**Files:**
- Modify: `cockpit/areas/system/SystemRuntime.tsx:71-133`, `cockpit/areas/system/SystemSessions.tsx:164-180`, `cockpit/areas/library/LibraryPromptPacks.tsx:327-375`, `cockpit/areas/work/WorkKanban.tsx:43-73`, `cockpit/areas/library/LibraryJourney.tsx` (only if it mounts `JourneyTimelineRoutePage` outside a column)
- Test: `cockpit/areas/system/SystemRuntime.test.tsx`, `cockpit/areas/system/SystemSessions.test.tsx`, `cockpit/areas/work/WorkKanban.test.tsx` (create if absent, using SystemRuntime.test's fixture style)

**Interfaces:**
- Consumes: `EmbeddedClassicPage` (Task 1.1); `useWorkspaceName(citadelId, workspaceId)` from `cockpit/data/use-workspace-name.ts:23`.

- [ ] **Step 1: Write the failing tests.**
  - SystemRuntime: `it("renders the runtime page inside the cockpit column")` asserts the mocked `RuntimeRoutePage` element's closest `.cockpit-embedded-classic` exists.
  - SystemSessions: `it("passes the workspace name, never the id")` asserts `fixture.props.activeWorkspaceName === "Workspace A"`, with the workspace lookup mocked to return "Workspace A" for "workspace-a". Also `it("titles a run detail with Run, not the raw id")` asserts the h1 text is "Run".
  - WorkKanban: `it("wraps the Kanban in the cockpit column")` and `it("titles a run detail with Run, not the raw id")`.
  - For Review Focus line 1, `it("keeps the column when the embedded worker page renders its load error")`: the mocked page renders its in-component error state (`registry.error`), and the error text stays inside `.cockpit-embedded-classic`. A page that throws during render is caught by the outer `AreaErrorBoundary`, not by the wrapper, so this test covers the rendered error state only.
- [ ] **Step 2: Run each file and confirm the new tests fail.**
- [ ] **Step 3: Implement.**
  - Wrap each embedded page element in `<EmbeddedClassicPage>`.
  - SystemSessions passes `activeWorkspaceName: workspaceName ?? "Current workspace"` from `useWorkspaceName`, replacing `workspaceId`.
  - Run detail titles become "Run". The ID moves to the inspector's TechnicalDetails, as it already appears there.
  - WorkKanban's intro becomes "Archived tasks are in Work › Archived tasks.", with a styled `NativeOwnerLink`; drop "prove".
- [ ] **Step 4: Run the three files and confirm they pass.**
- [ ] **Step 5: Commit** `fix(cockpit): keep embedded Classic pages in the cockpit column (WK-R02, LB-R02, SY-N01, SY-N11, WK-R03)`.

#### Task 1.3: Missing counts are unknown, and the approval count names its scope

**Files:**
- Modify: `features/native-routes/ops/runtime-overview-model.ts:198-245`, `features/native-routes/ops/RuntimeRoutePage.tsx` (prop type `pendingApprovals?: number`), `cockpit/areas/system/SystemRuntime.tsx:117,130`
- Test: `features/native-routes/ops/runtime-overview-model.test.ts` (extend or create)

**Interfaces:**
- Produces: `pendingApprovals?: number` on `RuntimeRoutePage` and `RemoteWorkersRoutePage` props.

- [ ] **Step 1: Write the failing tests.**
  - `it("shows Unknown, not 0, when the dashboard and the host give no approval count")`: the model's Pending approvals metric value is "Unknown".
  - `it("labels an installation-wide approval count")`: given `{ pendingApprovals: 2, scope: "installation" }`, the value is "2 across all workspaces".
  - `it("shows Unknown for backups and CPU when their source failed")`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Missing numbers render "Unknown". The daemon value reuses `describeRuntimeService` from `cockpit/areas/system/health-overview.ts`, so Runtime and Health agree, which fixes SY-01.
  - The cockpit host passes `undefined`, not `0`.
  - The dashboard count is installation-wide; label it "across all workspaces".
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `fix(system): show unknown counts as unknown and agree with Health (SY-R05, SY-L01, SY-01)`.

#### Task 1.4: Guard: embedded pages need the wrapper

**Files:**
- Modify: `scripts/check-mission-control-next-page-anatomy.mjs`, `scripts/check-mission-control-next-page-anatomy.test.mjs`

- [ ] **Step 1: Write the failing test.** `it("rejects a features/native-routes RoutePage rendered outside EmbeddedClassicPage")`: a cockpit area file that imports `../../../features/native-routes/ops/KanbanRoutePage` and renders `<KanbanRoutePage` with no `EmbeddedClassicPage` in the file yields one finding. A file that has both yields none.
- [ ] **Step 2: Run** `node --test scripts/check-mission-control-next-page-anatomy.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the rule (budget 0; no allowlist).
- [ ] **Step 4: Run the test and the guard.** Expected: PASS and "0 findings".
- [ ] **Step 5: Commit** `test(guard): require EmbeddedClassicPage around embedded Classic pages`.

### PR 2 · Decisions and danger, second pass

Closes IN-R02, GL-R03, WK-R04, CH-R01, CH-R02, GL-02, GL-03, IN-N02, IN-R01, IN-02, IN-10, IN-R03, IN-R04, WK-N06, ST-N21, SY-R04, CH-R06, CH-R08, WK-N11, ST-N09, IN-R06, GL-N04. It touches only inbox, work-run, chat-approval, library-mail and system-board files, so it can run in parallel with PR 3.

#### Task 2.1: The danger guard catches expressions and dynamic labels

**Files:**
- Modify: `scripts/check-mission-control-next-danger-actions.mjs:18-41`, its `.test.mjs`

- [ ] **Step 1: Write the failing tests.** Each yields exactly one finding:
  - `variant={entry.id === "cancel" || entry.id === "retry" ? "danger" : "secondary"}`
  - `<Button variant="danger">{label}</Button>`, where `label` is assigned from a literal "Retry run" within 20 lines
  - `<Button variant="danger">Request send approval</Button>`
  - `<Button variant="danger">Reject proposal</Button>`

  `<Button variant="danger">Reject all pending</Button>` (bulk) and "Discard changes" stay allowed.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Add `Cancel`, `Recover`, `Request`, `Reject(?! all)`, `Skip` and `Review prompt skipping` to `REVERSIBLE_VERBS`.
  - Match a verb anywhere in the label's first clause, not only at the start.
  - Scan the whole `variant={…}` expression for any reversible literal before `"danger"`.
  - Resolve `{identifier}` labels to a literal assigned in the same file when there is exactly one.
- [ ] **Step 4: Run the test (PASS).** Then run the guard and record the new findings list, which is Task 2.2's to-do.
- [ ] **Step 5: Commit** `test(guard): catch red reversible actions in expressions and dynamic labels (IN-R02, GL-R03)`.

#### Task 2.2: Fix every action the guard now flags

**Files:**
- Modify: `cockpit/areas/work/WorkRunControls.tsx:235,274-278`, `cockpit/areas/inbox/InboxRunRecovery.tsx:189-239`, `cockpit/areas/library/LibraryMailCompose.tsx:381-386`, `cockpit/areas/settings/ApprovalModeControl.tsx:147,221-226`, `cockpit/areas/settings/ManagedRuntimeSettings.tsx:150-152`, `cockpit/areas/chat/RiskApprovalAction.tsx:68-80`, plus any other file the guard lists
- Test: `cockpit/areas/work/WorkRunControls.test.tsx`, `cockpit/areas/chat/RiskApprovalAction.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `it("cancel, retry and recover are secondary with a primary confirm")` checks `data-variant`, or the class contains `border-line-control` and not `border-status-failed`.
  - `it("labels the danger-tier review with its risk")`: risk "danger" gives a button named "Review danger approval" with a ShieldAlert icon; "nuclear" gives "Review nuclear approval".
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Reversible actions become secondary triggers with primary confirms.
  - "Discard runtime draft" becomes danger.
  - Bypass approval uses RiskBadge with the shield review pattern instead of plain red.
  - Update the proofs and tests that pinned "Review approval": `git grep -n "Review approval" -- apps scripts` lists them.
- [ ] **Step 4: Run both files, then the danger guard.** Expected: PASS, and the guard reports 0 findings.
- [ ] **Step 5: Commit** `fix(cockpit): reversible run actions are not red; risk-labelled review (WK-R04, CH-R02, GL-02, GL-03, ST-N21)`.

#### Task 2.3: Deny and proposals act in place; expiry reads once

**Files:**
- Modify: `cockpit/areas/inbox/ApprovalDecisionBar.tsx:112,297-383`, `cockpit/areas/inbox/InboxInspectorBody.tsx:128`, `cockpit/areas/inbox/InboxApprovalDetail.tsx:179-183,281-283`, `cockpit/areas/inbox/ApprovalReviewSummary.tsx:29-33`, the proposal details `InboxMemoryProposalDetail.tsx`, `InboxDocumentProposalDetail.tsx`, `InboxImprovementProposalDetail.tsx` and `InboxUserInputDetail.tsx`, and `cockpit/areas/work/WorkWaitingDecisions.tsx:270-273`
- Test: `cockpit/areas/inbox/ApprovalDecisionBar.test.tsx`, `cockpit/areas/inbox/InboxMemoryProposalDetail.test.tsx`, `cockpit/areas/work/WorkWaitingDecisions.test.tsx`

**Interfaces:**
- Consumes: `hasExpired(expiresAt: string | undefined, now: number): boolean` from `cockpit/areas/inbox/use-minute-clock.ts:239-243`.

- [ ] **Step 1: Write the failing tests.**
  - `it("denies in one click and announces the outcome")`: clicking Deny calls the deny mutation once and no `[role=dialog]` appears.
  - `it("shows Expired before the missing-preview message")`: an expired approval without a preview renders the Expired badge and not "can't be decided yet".
  - `it("treats a malformed expiresAt as not expired, as the list does")`.
  - `it("rejects a memory proposal in place")`: Reject calls the mutation with no dialog. Apply stays primary.
  - `it("excludes expired approvals from Waiting on your decision")`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Remove the Deny confirmation modal and the proposal decision dialogs. A dialog stays only where it shows something new: the nuclear typed confirmation and document diffs whose content isn't already on screen.
  - Check expiry first using `hasExpired`.
  - The inspector shows one expiry line, owned by `InboxApprovalDetail`, and one "decision does not prove the action ran" disclaimer.
  - WorkWaitingDecisions filters with `inboxViewGroup(item, now) === "needs_decision"`.
- [ ] **Step 4: Run the three files and confirm they pass.**
- [ ] **Step 5: Commit** `fix(inbox): one-click deny, in-place proposals, single expiry (CH-R01, IN-N02, IN-R03, IN-R04, WK-N06)`.

#### Task 2.4: Bulk reject leaves the empty Inbox

**Files:**
- Modify: `cockpit/areas/inbox/InboxArea.tsx:321,394`, `cockpit/areas/inbox/InboxBulkRejectZone.tsx`, `cockpit/areas/inbox/installation-pending-approvals.ts:198-238`, `cockpit/areas/inbox/ApprovalBulkReject.tsx:140-176`
- Test: `cockpit/areas/inbox/InboxArea.test.tsx`, `cockpit/areas/inbox/installation-pending-approvals.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `it("shows only the empty state when this workspace has nothing pending, even if another workspace does")`: no "Reject everything pending" text, no `border-status-failed` element, and no "Approval history" button.
  - `it("counts only unexpired pending approvals for bulk reject")`.
  - `it("puts the bulk reject zone after the groups, as a flat section, only while this page has open decisions")`.
  - `it("names the confirm in the typed-confirmation hint")`: the hint reads "Confirm installation-wide rejection stays unavailable until the text matches".
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - The zone renders inside the projection branch only when this page has open decisions. It is a flat `Section` with a hairline top, not a bordered box.
  - Exclude expired approvals from the count.
  - Approval history moves below the groups (IN-N08).
  - The confirm and Cancel buttons sit in a flex row with Cancel last.
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `fix(inbox): keep bulk reject off an empty Inbox (IN-R01, IN-02, IN-10, IN-N08, IN-R06)`.

#### Task 2.5: Shared dialogs for the remaining interruptions

**Files:**
- Modify: `cockpit/areas/system/CockpitBoardEditor.tsx:291-305`, the three "Reload app?" dialogs (`cockpit/areas/chat/ChatInspector.tsx:151-189`, `ChatApprovalRenderer.tsx:240-278`, `ChatComposerControls.tsx:256-285`), `cockpit/areas/chat/ChatSessionControls.tsx:131-153`, `cockpit/areas/work/WorkScheduleInspector.tsx:99-103`, `cockpit/areas/work/WorkArchive.tsx:202`, `cockpit/areas/settings/IntegrationConnectionsSettings.tsx:157-168`, `cockpit/ui/TypedConfirmation.tsx:57-59`
- Create: `cockpit/ui/use-reload-app.ts`
- Test: `cockpit/areas/system/CockpitBoardEditor.test.tsx`, `cockpit/ui/TypedConfirmation.test.tsx`

**Interfaces:**
- Produces: `export function useReloadApp(): () => void`, which reloads immediately with no dialog, matching the transcript's existing Reload.

- [ ] **Step 1: Write the failing tests.**
  - `it("asks with UnsavedChangesDialog when the layout changed")`: buttons in order Save and continue, Keep draft and close, Discard changes, Cancel.
  - `it("matches the phrase ignoring repeated spaces")`: `typedConfirmationMatches("reject  all", "reject all") === true`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - The board editor uses `UnsavedChangesDialog`.
  - The three Reload dialogs become `useReloadApp`.
  - Archive and restore conversation, pause and resume schedule, archive and restore task, and the integration enable toggle act directly, each with a toast that carries Undo where an inverse exists.
  - Archive gets a rejection path that shows the error inline.
  - TypedConfirmation collapses `\s+`.
- [ ] **Step 4: Run, then run the danger guard.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(cockpit): drop modals for reversible actions; shared unsaved-changes prompt (SY-R04, CH-R06, CH-R08, WK-N11, ST-N09, GL-N04)`.

### PR 3 · Settings anatomy and first run

Closes ST-N01, ST-N02, GL-09, ST-R01, ST-R02, ST-N03, ST-N05, ST-R05, ST-N04, ST-R04, ST-R06, ST-N16, ST-N17, ST-N18, ST-N19, ST-N23, ST-11, ST-27, ST-22. It touches only `cockpit/areas/settings/`.

#### Task 3.1: Page name as h1, one tab row, no single-tab tablist

**Files:**
- Modify: `cockpit/areas/settings/SettingsArea.tsx:223-278`, `cockpit/areas/settings/SettingsSectionTabs.tsx:62-111`, `cockpit/areas/settings/AppearanceSettings.tsx:63`
- Test: `cockpit/areas/settings/SettingsArea.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `it("titles each page with its own name")`: h1 is "General" on /settings/general and "Models" on /settings/models.
  - `it("renders no section tablist on a page with one section")`: /settings/access has zero `[role=tablist]` inside the page body.
  - `it("keeps search in the header actions")`.
  - `it("shows Get started in the header only while setup is unfinished, named Get started")`.
  - `it("does not make a section panel a tab stop when it starts with a control")`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - h1 = `page.label`; the description comes from route-model.
  - Pages with one discoverable section render it as a plain `<section aria-label>`. Pages with several keep one row of in-page section links, not a Radix tablist, and the panels become `Section`s.
  - The header actions slot holds Search (a 44px input), then a single page Refresh that invalidates the page's queries. The Get started Button-size action shows only while `!firstRun.complete`.
  - Remove each section's own Refresh button except in its error state.
  - Drop the stray `border-t` (`first:border-t-0 first:pt-0`).
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `fix(settings): page-name h1, one navigation row, header search and refresh (ST-N01, ST-N02, GL-09, ST-N05, ST-N17, ST-N18, ST-N19)`.

#### Task 3.2: Notification routing and the save-model line

**Files:**
- Modify: `cockpit/areas/settings/NotificationRoutingSettings.tsx:29-243`, `cockpit/areas/settings/AppearanceSettings.tsx:65-78,227`, `cockpit/areas/settings/DesktopUpdateSettings.tsx:25-75`
- Test: `cockpit/areas/settings/AppearanceSettings.test.tsx`, `cockpit/areas/settings/NotificationRoutingSettings.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `it("scopes Saved automatically to the preference fields only")`: the line is a descendant of the preferences `Section` and not an ancestor of the routing section.
  - `it("renders routing as a flat section with hairline rows")`: no element with `rounded-md border` wraps the section.
  - `it("presents test status and event types through the vocabulary")`: no `_` in visible text, given the fixture status `delivery_failed`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Preferences, Notification routing and Application updates become three sibling `Section`s. Only Preferences carries "Saved automatically".
  - Routing copy: "Notification destinations and rules for this workspace."
  - Use one input class: `cockpitInputClass` from `cockpit/ui/input-class.ts`, replacing the four `min-h-10` selects. Section h3s use one size (`text-lg font-display`, per GL-N03).
  - Commit hashes go to TechnicalDetails; the size comes from `formatBytes`.
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `fix(settings): honest save model; flat notification routing (ST-R01, ST-R02, ST-N14, ST-N20, ST-11, ST-27)`.

#### Task 3.3: One setup stepper, flat, with safe defaults only

**Files:**
- Modify: `cockpit/areas/settings/FirstRunArea.tsx:18-173`, `cockpit/areas/settings/GuidedModelSteps.tsx:57-75`, `cockpit/areas/settings/ModelsSettings.tsx:73`, `cockpit/areas/settings/FirstRunDefaults.tsx:41-99`, `cockpit/areas/settings/FirstRunStatus.tsx:62-79`, `cockpit/app/CockpitShell.tsx:61,136` (the Exit target only)
- Create: `cockpit/areas/settings/setup-steps.ts`
- Test: `cockpit/areas/settings/FirstRunArea.test.tsx`, `cockpit/areas/settings/ModelsSettings.test.tsx`

**Interfaces:**
- Produces: `export const SETUP_STEPS: readonly { id: "model" | "safety" | "message"; label: string }[]` with the labels "Choose a model", "Choose your safety settings" and "Send a test message".

- [ ] **Step 1: Write the failing tests.**
  - `it("renders the steps as an ordered list with aria-current on the current step")`: no `<button>` step cards.
  - `it("puts Open Chat to send a test message and Refresh checks in one action row")`.
  - `it("offers only safe approval modes in installation defaults")`: no "bypass" option.
  - `it("shows a one-line setup status on Models with a link to Get started, not a second stepper")`.
  - `it("Exit setup returns to the page it came from")`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Both surfaces use `SETUP_STEPS`. Rename the button to "Change installation defaults" and pass `safeOnly` to its approval editor.
  - FirstRunStatus adds an "Open Chat" link.
  - Exit uses the referrer stored at entry and falls back to /settings/models. Drop `?shell=cockpit`.
  - Step h2s use one size.
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `fix(settings): one flat setup stepper with safe defaults (ST-N03, ST-R05, ST-N04, ST-R04, ST-R06, ST-N16, ST-N23, ST-22)`.

**Wave 1 close:** dispatch `visual-rebaseline.yml` on the branch that has PRs 1–3 merged, cherry-pick its `chore/visual-rebaseline-<runid>` commit into a baselines PR, and ask the user before opening it.

---

## Wave 2 (PRs 4–7)

Each PR starts with its guard task, so CI fails on the defect class before its call sites are fixed. Run them one at a time. All four touch many files, so parallel runs would conflict.

### PR 4 · Glossary and server-written prose

Closes GL-R02 (copy half), GL-L02, GL-07, GL-12, SY-N06, SY-N07, SY-N08, WK-N01, WK-N02, WK-N09, WK-N10, CH-N04, CH-N13, CH-N16, CH-N22, IN-N05, IN-N09, IN-N10, LB-N05, LB-N07, LB-N02, ST-12, ST-13, ST-N08, ST-N10, ST-N11, ST-N12, ST-N13, ST-N22, SH-N11, CH-R07.

#### Task 4.1: The copy guard learns the glossary and plurals

**Files:**
- Modify: `scripts/check-mission-control-next-cockpit-copy.mjs:48-55,114`, its `.test.mjs`

- [ ] **Step 1: Write the failing tests.**
  - `it("flags glossary words in JSX text and string props")` covers Gateway, evidence, owner, replay, revision, snapshot, posture, canonical, durable and projection. It does not flag them inside `TechnicalDetails`, code identifiers, or `className`.
  - `it("flags number-noun templates that bypass plural()")`: `` `${count} items` `` and `"(s)"`.
  - `it("fails on an unreadable directory")`: replace `.catch(() => [])` with a thrown error.
  - `it("walks features/native-routes and packages/mission-control-shared/src/components")`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.** Set the budget to the current count, ratcheting down. The count must reach 0 for the files PR 4 touches.
- [ ] **Step 4: Run the test (PASS) and the guard (prints the to-do list).**
- [ ] **Step 5: Commit** `test(guard): glossary words and plurals in operator copy (GL-R02)`.

#### Task 4.2: The Gateway sends codes, and the cockpit words them

**Files:**
- Modify: `apps/gateway/src/services/runtime-authority-projection-service.ts:578,692,735`, `apps/gateway/src/services/prompt-pack-service.ts:572`, `apps/gateway/src/services/llm-runtime-truth-service.ts:129`, `apps/gateway/src/services/daemon-route-service.ts:103`, `apps/gateway/src/services/improvement-service.ts:662`, `config/cron-jobs.example.json:5`, `packages/contracts/src/` (the types for those fields)
- Create: `cockpit/areas/system/runtime-authority-copy.ts`
- Test: `apps/gateway/src/services/runtime-authority-projection-service.test.ts`, `cockpit/areas/system/runtime-authority-copy.test.ts`

**Interfaces:**
- Produces, in contracts: an optional `{ code: string; count?: number }` on the authority, quality and daemon message fields, kept beside the existing prose so old clients don't break (additive only).
- Produces, in cockpit: `export function presentAuthorityMessage(m: { code: string; count?: number }): string`.

- [ ] **Step 1: Write the failing tests.**
  - Gateway: `it("returns a code and count with each authority caveat")`.
  - Cockpit: `presentAuthorityMessage({ code: "approval_records_available", count: 1 }) === "1 approval record is available"`. The count 0 reads "No approval records are available", and the result has no "(s)".
- [ ] **Step 2: Run each file at `--maxWorkers=2` and confirm they fail.** Remember that package tests resolve contracts from dist, so rebuild `@goatcitadel/contracts` first, as its own heavy job.
- [ ] **Step 3: Implement.**
  - The Gateway adds codes. The cockpit renders `presentAuthorityMessage` when a code is present and the prose only in TechnicalDetails.
  - Rename the seeded schedule to "Weekly improvement review".
  - The daemon `controlMessage` moves to TechnicalDetails.
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `feat(gateway): authority, quality and daemon messages carry codes for operator copy (SY-N06, ST-N10, WK-N09)`.

#### Task 4.3: Copy sweep, area by area

**Files:** every file the Task 4.1 guard lists, one commit per area (System, Work, Inbox, Chat, Library, Settings, Shell).
**Test:** the guard is the test. Each area commit brings that area's count to 0.

- [ ] **Step 1: Pick the next area from the guard output.**
- [ ] **Step 2: Rewrite each hit using the glossary.** These replacements are fixed: "Recurring jobs for this installation" (Schedules); "Cost by day (UTC)"; "Recent model calls"; "Estimated"; "Updated just now"; "Run details"; "Anyone who can reach this app can change settings. Set up sign-in." (ST-N08, as a waiting-tone Callout with Configure access, and mode label "No sign-in"); "Find a setting." (Settings description); "Check again" (for "Refresh … evidence"). Use `plural()` from `packages/mission-control-shared/src/content/format.ts:141` for every number-noun pair.
- [ ] **Step 3: Run the guard, and the touched files' tests, one file at a time.** Expected: that area at 0, and the tests pass after updating any copy assertions.
- [ ] **Step 4: Commit** `fix(<area>): operator copy follows the glossary`.
- [ ] **Step 5: Repeat for each area, then lower the guard budget to the remaining total and commit.**

### PR 5 · Raw values and money

Closes ST-R03, GL-R02 (raw half), WK-N03, WK-N08, CH-N08, CH-11 (fallback), IN-L01, IN-L02, IN-N11, ST-N06, ST-N07, ST-N11, ST-N15, ST-14, SY-N03, SY-N04, SY-08, VR-04, GL-06, LB-N04, LB-09, SH-N04.

#### Task 5.1: The raw-values guard covers ISO times, features/, and IDs outside TechnicalDetails

**Files:**
- Modify: `scripts/check-mission-control-next-raw-values.mjs:16-60`, its `.test.mjs`

- [ ] **Step 1: Write the failing tests.**
  - `it("flags {x.checkedAt}-style ISO fields rendered outside TimeText or TechnicalDetails")`: the pattern `/\{[\w?.!]+(At|checkedAt|generatedAt)\}/`.
  - `it("does not count ids inside TechnicalDetails or key= toward the budget")`.
  - `it("walks features/native-routes/settings and features/native-routes/ops")`.
  - `it("flags lastError, step.error and report.error rendered as text")`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement** with new budgets equal to today's counts.
- [ ] **Step 4: Run the test (PASS) and the guard (to-do list).**
- [ ] **Step 5: Commit** `test(guard): ISO times, error text and Classic settings panels count as raw values (ST-R03)`.

#### Task 5.2: Money under a cent and unknown days

**Files:**
- Modify: `packages/mission-control-shared/src/content/format.ts:80-103`, `packages/mission-control-shared/src/content/cost-summary.ts:92,153,159,181`, `cockpit/areas/system/SpendDailyChart.tsx:34,46,72-77`, `cockpit/areas/system/SpendOverview.tsx:96-133`
- Test: `packages/mission-control-shared/src/content/format.test.ts`, `cockpit/areas/system/SpendDailyChart.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `formatMoneyLowerBound(0.0026) === "At least <$0.01"`; `formatMoneyLowerBound(12.344) === "At least $12.34"`.
  - `it("says No day has a known amount when every day is unknown")`: no "$0.00" in the text.
  - `it("keeps the lower-bound marker on the highest day")`.
  - `it("titles day labels with a formatted date, not ISO")`.
  - `it("shows provider attribution by model label")`: no raw model ID; the fallback is "Unnamed model".
- [ ] **Step 2: Run the two files at `--maxWorkers=2` and confirm they fail.**
- [ ] **Step 3: Implement** in `format.ts`, then update the callers.
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `fix(spend): money under a cent and unknown days read honestly (SY-N03, SY-N04, SY-08, VR-04)`.

#### Task 5.3: Approval preview, error text and model labels are presented

**Files:**
- Modify: `cockpit/areas/inbox/InboxApprovalDetail.tsx`, `cockpit/areas/inbox/ApprovalReviewSummary.tsx`, `cockpit/areas/inbox/InboxItemCard.tsx:52-58`, `cockpit/areas/inbox/approval-preview.ts:42-51,276`, `cockpit/areas/inbox/InboxApprovalHistory.tsx:180-182`, `cockpit/areas/work/WorkBoardColumn.tsx:179-181`, `cockpit/areas/work/WorkRunDetail.tsx:149-154`, `cockpit/areas/inbox/ApprovalSettlement.tsx:114-117`, `cockpit/areas/chat/ChatInspectorTurnPanel.tsx:46-50`, `cockpit/areas/chat/ChatTurnDetails.tsx:145-149`, `cockpit/data/use-model-label.ts:32`, `cockpit/areas/settings/first-run-summaries.ts:5-9`, `cockpit/areas/settings/CitadelMasonSettings.tsx:154-170`, `cockpit/areas/settings/LocalAiSettings.tsx:94-115`, `cockpit/areas/settings/ToolGrantDetails.tsx:16-37`, `cockpit/areas/work/WorkScheduleSummary.tsx:122,155`, `cockpit/areas/library/LibraryKnowledgeWorkspace.tsx:38-71`, `cockpit/app/cockpit-document-title.ts:6-30`
- Create: `cockpit/lib/present-error.ts`
- Test: `cockpit/areas/inbox/InboxApprovalDetail.test.tsx`, `cockpit/areas/inbox/InboxItemCard.test.tsx`, `cockpit/lib/present-error.test.ts`, `cockpit/data/use-model-label.test.ts`

**Interfaces:**
- Produces: `export function presentErrorText(raw: string | null | undefined): { summary: string; detail?: string }`. It wraps the existing `describeThreadedUiError`, so callers render `summary` and put `detail` in TechnicalDetails.

- [ ] **Step 1: Write the failing tests.**
  - The preview shows one failure line only when nothing loaded, with no "SHA-256" or "bytes" outside TechnicalDetails and no `word-break: break-all`.
  - The card body names the target ("Writes memory · Operator preference: visible proof") and not the filler sentence.
  - `presentErrorText("ECONNREFUSED 127.0.0.1:5432 at …").summary` has no IP and no stack text.
  - `useModelLabel` returns "Unnamed model", never the ID, when the catalog lacks a label.
  - Document titles use the cockpit tab label: Spend is "Spend", and Browser sessions is distinct from Sessions.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Format the expiry with `Math.round` and switch to days above 48 hours. Drop "Expiry not provided" from rows.
  - History uses `presentApprovalAction`.
  - Cron expressions, hashes, Grant IDs and ISO times go to TechnicalDetails or TimeText.
  - Mason uses the citadel-vocabulary presenters and a key label map (successDefinition becomes "What success looks like").
  - Local AI presents the OS as "Windows, 64-bit".
- [ ] **Step 4: Run each file, then the raw-values guard.** Expected: PASS, with the budget lowered to the new count.
- [ ] **Step 5: Commit** `fix(cockpit): present approval previews, errors and model labels (IN-L01, IN-L02, WK-N03, CH-N08, ST-N06, ST-N07, ST-14)`.

### PR 6 · Rows instead of cards, one empty state

Closes GL-10, GL-R03 (card half), IN-N04, IN-N07, WK-N07, WK-N05, WK-N04, LB-N06, LB-N09, LB-N01, LB-N03, LB-R01, LB-N10, LB-N08, SY-N05, SY-N10, CH-N02, CH-N03, CH-N23, CH-N06, VR-02, SY-11, LB-17.

#### Task 6.1: The card guard counts any bordered padded container

**Files:**
- Modify: `scripts/check-mission-control-next-page-anatomy.mjs:46-52`, its `.test.mjs`

- [ ] **Step 1: Write the failing test.** `it("counts rounded-md border p-* containers in areas/ as cards")`: `className="rounded-md border border-line p-3"` yields one finding, while `border-b` and `divide-y` rows yield none.
- [ ] **Step 2: Run and confirm it fails.**
- [ ] **Step 3: Implement** with budget = the current count, about 126.
- [ ] **Step 4: Run (PASS) and print the list.**
- [ ] **Step 5: Commit** `test(guard): bordered padded containers count as cards (GL-R03)`.

#### Task 6.2: `NativeOwnerLink` looks like a link

**Files:**
- Modify: `cockpit/ui/NativeOwnerLink.tsx:11-40`
- Test: `cockpit/ui/NativeOwnerLink.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `it("defaults to accent link styling at its natural width")`: the className contains `text-accent` and `w-fit`.
  - `it("renders nothing, not a bare span, when no cockpit href resolves")` (GL-N08).
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.** The default class merges with the caller's className.
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `fix(cockpit): owner links look like links (WK-N04, GL-N08)`.

#### Task 6.3: Hairline rows and single empty states, area by area

**Files:** the Task 6.1 guard list. Also:
- Projects: `cockpit/areas/chat/ChatProjects.tsx:72-203` and `ProjectDetail.tsx` adopt AreaHeader with a primary New project and Refresh, use AREA_COLUMN, drop the governance link row, and use one EmptyState.
- `cockpit/areas/library/LibraryGovernanceRoute.tsx:26-32` uses one heading, puts the actions in `flex gap-2` with Start setup primary, and marks a current tab.
- `cockpit/areas/library/LibraryAgentsWorkspace.tsx:73-143` removes the slug link row and adds a segmented control and a Sheet editor.
- `cockpit/areas/system/RuntimeAuthorityMap.tsx:33-117` moves the eyebrow to trailing metadata.
- `cockpit/areas/system/SystemDiagnostics.tsx:96` uses AREA_PAGE.
- `cockpit/areas/work/WorkBoard.tsx:262-306` shows a board-level EmptyState with New task.
- `cockpit/areas/library/LibraryJourney.tsx:127-204` hides the filters on an empty read.
- `cockpit/areas/inbox/InboxArea.tsx:275-277` opens a linked approval in the inspector.

**Tests:** one per area file, in its existing test file:
- `it("renders rows as hairline-separated items, not bordered cards")`
- `it("shows exactly one EmptyState and no filters when there is nothing to show")`

- [ ] **Step 1: Pick the next area. Write its two tests and confirm they fail.**
- [ ] **Step 2: Implement with `divide-y divide-line-subtle` rows and `EmptyState`.**
- [ ] **Step 3: Run that area's files and the page-anatomy guard.** Expected: PASS, and the count drops.
- [ ] **Step 4: Commit** `fix(<area>): hairline rows and one empty state`.
- [ ] **Step 5: Repeat for each area, then lower the budget and commit.**

### PR 7 · Accessible names, live regions and keyboard

Closes GL-L01, SH-N03, IN-R05, CH-N09, SY-N02, SH-R02, SH-R01, CH-L01, CH-L03, GL-R01, GL-08, SY-N09, GL-N10, CH-N14, CH-N17, SH-N06, SH-N08, IN-N12, SH-09, SH-36, SH-37, SH-31, GL-N01, CH-N10, CH-N15, SH-N02, SH-N10.

#### Task 7.1: The semantics guard checks names and Callout roles

**Files:**
- Modify: `scripts/check-mission-control-next-cockpit-semantics.mjs:20-64`, its `.test.mjs`

- [ ] **Step 1: Write the failing tests.**
  - `it("flags an aria-label that does not start with the element's literal visible text")`: `<button aria-label="Search commands">Search<kbd>` passes; `<select aria-label="Filter by kind">` with `<label>Kind</label>` fails.
  - `it("counts Callout without announce={false} as a live region")`.
  - `it("flags aria-label on div, span or p without a role")`.
  - `it("flags inputs without cockpitInputClass or text-md below sm")` (the iOS zoom rule).
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement** with budgets equal to today's counts.
- [ ] **Step 4: Run the test (PASS) and the guard (to-do list).**
- [ ] **Step 5: Commit** `test(guard): label-in-name, implicit Callout regions and phone input size`.

#### Task 7.2: Fix the names and regions

**Files:** the guard list, including:
- `cockpit/app/Sidebar.tsx`: the search name starts with "Search", with the shortcut in `aria-keyshortcuts`.
- `cockpit/app/ScopeSwitcher.tsx:94-161`: the name is "{scope name}, change Citadel and workspace".
- `cockpit/areas/inbox/InboxFilterBar.tsx:257-278`: drop the aria-labels.
- `cockpit/areas/chat/ChatComposerControls.tsx:189,199` and `ChatModelOptionsPopover.tsx:117,145`.
- `features/native-routes/ops/RuntimeSessionsPanel.tsx:41-72`: the name is "Details: {title}".
- `cockpit/app/MobileTabBar.tsx:90-113`: `aria-label="Work"`.
- `cockpit/app/stream-status.ts:344-351`: use `stream.label`.
- Static callouts get `announce={false}`.
- `cockpit/areas/system/SystemOwnerLink.tsx:18-23`: no role.

**Tests:** extend each touched file's test with `it("accessible name starts with the visible text")`, using `getByRole(..., { name: /^Visible/ })`.

- [ ] **Step 1: Write the tests for the listed files and confirm they fail.**
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run each file, then the guard.** Expected: PASS, with the budget lowered.
- [ ] **Step 4: Commit** `fix(cockpit): accessible names start with visible text; static callouts stay quiet`.

#### Task 7.3: Keyboard and headings in Chat, and phone polish

**Files:**
- Modify: `cockpit/areas/chat/ChatComposerPalette.tsx`, `cockpit/areas/chat/ChatTextComposer.tsx:165,270`, `cockpit/areas/chat/ChatSessionControls.tsx:51-68`, `cockpit/areas/chat/ChatTranscriptContent.tsx:83-110`, `cockpit/app/inspector.tsx:116-120,179-186`, `cockpit/app/InspectorResizeHandle.tsx:294`, `cockpit/ui/Sheet.tsx:294-311`, `apps/mission-control-next/index.html:6`, `cockpit/areas/inbox/use-inbox-shortcuts.ts:44`
- Test: `cockpit/areas/chat/ChatComposerPalette.test.tsx`, `cockpit/areas/chat/ChatSessionControls.test.tsx`, `cockpit/app/inspector.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `it("Escape closes the slash menu and keeps the draft")`: after typing "/", pressing Escape leaves no `[role=listbox]` and the textarea value stays "/".
  - `it("the conversation h1 contains only the title")`.
  - `it("Escape outside the inspector does not close it")`.
  - `it("each turn has an sr-only heading")`.
  - `it("the draft is text-md at every width")`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
  - The rename button moves beside the h1.
  - The resize handle hit area becomes `w-6`. Remove the inner `role="region"`.
  - Sheet gets `aria-describedby={undefined}` and `cockpit-safe-bottom`.
  - Add two media-scoped `theme-color` metas.
  - Inbox shortcuts exempt the inspector sheet.
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `fix(chat): Escape closes the slash menu; clean heading; phone sheet insets (CH-L01, CH-L03, SH-09, SH-36, SH-37, SH-31, SH-N02, SH-N10)`.

#### Task 7.4: Chat leftovers and sentences that point somewhere

Closes CH-27/CH-R04, CH-R05, CH-R09, CH-R10, CH-R11, CH-N05, CH-N07, CH-N18, CH-N19, CH-N20, CH-N21, CH-20, CH-28, SH-18, IN-04, LB-N08, ST-N11 (link half).

**Files:**
- Modify: `cockpit/areas/chat/ConversationListPanel.tsx:107-109`, `cockpit/areas/chat/thread-activity.ts:14-59`, `cockpit/areas/chat/ChatTurnReceipt.tsx:30-53`, `cockpit/areas/chat/ChatOrganizationForm.tsx:28-97`, `cockpit/areas/chat/ChatTurnActions.tsx:52-55`, `cockpit/areas/chat/ChatArea.tsx:74-87,118,197`, `cockpit/areas/chat/RiskApprovalAction.tsx:53,56,174-176`, `cockpit/areas/chat/ChatTranscriptContent.tsx:149,256-262`, `cockpit/areas/chat/ChatAttachmentChips.tsx:8-13`, `cockpit/areas/chat/ChatComposerControls.tsx:76-163`, `cockpit/areas/chat/ChatAreaChrome.tsx:131-133`, `cockpit/data/realtime.ts:330`, `cockpit/areas/inbox/InboxRunRecovery.tsx:90-157`, `cockpit/areas/library/LibraryMemoryEditorParts.tsx:164`
- Test: `cockpit/areas/chat/ConversationListPanel.test.tsx`, `cockpit/areas/chat/ChatTurnReceipt.test.tsx`, `cockpit/areas/chat/ChatOrganizationForm.test.tsx`, `cockpit/areas/chat/ChatTurnActions.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - `it("shows status only for running, waiting and failed rows")`: no "Status unavailable" and no "No messages yet" text.
  - `it("opens the Message tab of the Chat inspector from a receipt")`: `onInspectTurn` is called with the turn ID, and the inspector `source` is "chat".
  - `it("reports a save outcome from the save result, not a draft comparison")`.
  - `it("asks before retry only when a tool's effectPotential is a write or side effect")`.
  - `it("opens the Inspect panel on Message for an ordinary turn")`.
  - `it("error toasts expire after 10 seconds")`.
- [ ] **Step 2: Run each file and confirm they fail.**
- [ ] **Step 3: Implement.**
  - Drop `?shell=cockpit` from every hand-off.
  - Every "Review the persisted approval…", "Use Open run…", "check Inbox…" and "Use Get started…" sentence gets its link in the same element, or is reworded to name a real control.
  - The optimistic message renders as a user bubble with a Sending badge.
  - One file-type presenter serves chips and sent attachments.
  - Plan first and Review answer get `min-h-8` and visible helper text in the options popover.
  - Projects moves into the scope area.
  - Error toasts last 10 seconds, with a cap of 3.
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Commit** `fix(chat): quieter rows, one message-details view, honest save outcomes, linked guidance`.

**Wave 2 close:** run a second visual rebaseline as in Wave 1. Then run a check crawl using the follow-up review's `crawl5.cjs`, `probe5.cjs` and `busy5.cjs` against a fresh `pnpm testbench`, and republish the artifact with each finding's status. That crawl is the only heavy job running at that point.

---

## Phase 3 · Port the embedded Classic pages (separate plans)

Out of scope for this plan. Write one plan per page after PR 1 merges, in this order: System › Runtime and Workers (SY-R01, SY-01, SY-04), System › Sessions (SY-N02, SY-N12), the Chat controller frame and GCModal confirms (CH-N01, CH-N11), Library › Prompt packs, the build editor (CH-N12), and then deleting the older Kanban once Task actions are native (WK-01, VR-01). The Task 1.4 guard keeps each one contained until it is ported.

Also deferred, and not re-planned here: compact density, a Mesh tab, Gateway approval-scope IDs, PDF/SVG preview, Skip for optional questions, the provider transport section, and merging the four rule pages.
