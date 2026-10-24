# Cockpit System › Sessions Native Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `SystemSessions` (`/system/sessions`) stops rendering Classic pages. Today it embeds `RuntimeSessionsPanel`, `OpsDegradedSourcesStrip` and `RuntimeRecordInspector` inside `EmbeddedClassicPage`, and embeds the Classic `RunDetailRoutePage` for `?runId=` / `?view=run-detail`. After this change it renders only cockpit primitives and hands run links to the native Work run page.

**Architecture:** This follows #508 (`2026-10-22-cockpit-system-runtime-native.md`). The derivations go in a pure `sessions-page-model.ts`. The view is flat `Section`s with hairline rows over the same `useOpsRuntimeSnapshot("sessions", { requestedSources: ["sessions"] })` hook the Classic page reads. Each session row comes from a shared `SessionRow`, which System › Activity's `RecentSessions` also uses, so the two pages describe a session in the same words. The selected session opens inline as a `Section` at the top of the page, not in a drawer: it shows its fields, with the ID kept in `TechnicalDetails`, followed by the existing `SessionControlManager`. A run link redirects to `/work/runs/:runId` (`WorkRunDetail`, already native). The Classic `RuntimeSessionsPanel`, `RuntimeRecordInspector` and `RunDetailRoutePage` stay for the Classic shell and Work › Kanban.

**Tech Stack:** React 19, TanStack Query, Tailwind cockpit tokens, vitest + happy-dom.

**Spec:** the task brief (cockpit follow-up review, Phase 3, next port after #508), plus `DESIGN.md` › Glossary and Page anatomy.

## Global Constraints

- Page anatomy:
  - one `AreaHeader`: h1 "Sessions", a one-line description, and Refresh on the right;
  - the System tabs come from the existing `AreaTabsProvider`;
  - the body is flat `Section`s, with rows as `<ul className="divide-y divide-line-subtle">`;
  - no bordered card and no hero tiles: numbers are a sentence followed by a `MetricList`.
- Copy: none of posture, evidence, canonical, owner, projection, durable, signal or caller in operator text. "Session evidence" becomes "Recent sessions" and "Session posture" becomes "Across all workspaces". The `internal-terms` copy budget stays 0.
- Accessible names start with the visible text: `Details: <title>`, `Open in Chat`, `Close session`, `Refresh sessions`.
- Session IDs, the account and raw ISO times appear only inside `TechnicalDetails` or the existing "Session details" disclosure. Times use `TimeText`, and counts use `plural()`.
- Missing data reads "Unknown" or "Not reported", never 0. A failed `sessions` source is never shown as an empty list.
- The URL contract is unchanged: `?sessionId=` selects a session, and selecting or closing one keeps every other query param and the hash (the existing navigate assertions stay).
- Remount on access identity (`useProjectAccess(... "system-sessions" ...)`), as today.
- Machine rules:
  - one heavy job at a time;
  - vitest runs one file at a time with `--maxWorkers=2`;
  - no `verify:*` lanes locally;
  - build `@goatcitadel/contracts` before the first focused test;
  - run Prettier only on touched files;
  - never `git stash`.
- Visual: the cockpit visual manifest (`scripts/verification/lib/cockpit-visual-manifest.mjs`) has no `/system/sessions` route, and `release-surface-manifest`'s `/ops/sessions` is the Classic shell. So no rebaseline PR is needed.

## Review Focus

1. **Sessions source failed while the dashboard source is fine.** The page should say that sessions couldn't be read, show "Unknown" where the count would be, and keep the "Across all workspaces" metrics. It must not say "No sessions have recent activity." Task 1 (model) and Task 3 (page) pin this.
2. **`?sessionId=` names a session that isn't in the recent list.** The selected-session section still renders, says the session isn't in the recent list, and still mounts `SessionControlManager` for that ID. Close removes only `sessionId`. Task 3 pins this.
3. **A `displayName` that is a raw ID (`sess_…`) or empty.** The title falls back to "<Channel> conversation", and the raw ID never appears outside Technical details. Task 1 pins this.
4. **`?runId=` with an unsafe or garbage value, or `?view=run-detail` with no runId.** There is no redirect to a malformed path. Instead an `EmptyState` says no run was chosen and links to Work › History. Task 3 pins this.
5. **Workspace switch with a session selected.** The page remounts, and the control manager is rebound to the new workspace with no stale controls. The existing remount-by-identity behaviour stays; Task 3 re-asserts `workspaceId` on the control-manager props.

---

### Task 1: Sessions page model

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/system/sessions-page-model.ts`
- Test: `apps/mission-control-next/src/cockpit/areas/system/sessions-page-model.test.ts`

**Interfaces:**
- Consumes: `OpsRuntimeData`, `sourceFailed` and `presentPendingApprovals` from `features/native-routes/ops/runtime-overview-model`; `presentChannel` from `./system-vocabulary`; `SessionMeta` from `@goatcitadel/contracts`.
- Produces:
  - `sessionTitle(item: SessionMeta): string`. Move the current `title()` out of `RecentSessions.tsx`: an explicit name unless it matches `/^sess[_-]/i`, otherwise `` `${presentChannel(channel)} conversation` ``.
  - `recentSessionList(data: OpsRuntimeData): { state: "failed" } | { state: "ok"; items: SessionMeta[] }`. Use `data.sessions` when it is non-empty, otherwise `data.dashboard?.sessions ?? []`. Return `failed` when `sourceFailed(data, "sessions")` and both lists are empty.
  - `findSession(data, sessionId): SessionMeta | undefined`.
  - `sessionsAcrossWorkspaces(data, hostPendingApprovals?: number): Metric[]`. Build the `MetricList` terms from:
    - `presentPendingApprovals` ("Pending approvals, all workspaces");
    - "Active subagents";
    - "Recent events".
    When the dashboard source failed or is missing, the values read "Unknown".
  - `SESSIONS_SOURCE_LABELS: Record<string, string>`: sessions → "Session list", dashboard → "Dashboard summary".

- [ ] **Step 1: Write failing tests.**
  - `sessionTitle({displayName: "sess_abc", channel: "web"})` → `"Web conversation"`, assuming `presentChannel("web")` returns "Web". Check `system-vocabulary` and assert its actual output.
  - `sessionTitle({displayName: "Owner conversation"})` → `"Owner conversation"`.
  - `recentSessionList` with `sourceStatus.sessions.status = "error"` and empty lists → `{state: "failed"}`.
  - `recentSessionList` with the dashboard fallback only → those items.
  - `sessionsAcrossWorkspaces` with `dashboard.pendingApprovals: 3` → includes `{term: "Pending approvals, all workspaces", value: "3"}`.
  - `sessionsAcrossWorkspaces` with the dashboard source errored → every value is `"Unknown"`.
  - `findSession(data, "missing")` → `undefined`.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/system/sessions-page-model.test.ts --maxWorkers=2`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the exports as pure functions. Match `Metric` to the type `MetricList` takes in `cockpit/ui/MetricList.tsx`.
- [ ] **Step 4: Re-run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): sessions page model for native System › Sessions`.

### Task 2: Shared `SessionRow`, adopted by Activity's `RecentSessions`

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/system/SessionRow.tsx`
- Modify: `apps/mission-control-next/src/cockpit/areas/system/RecentSessions.tsx`: render rows through `SessionRow` and drop its local `title`/`when`.
- Test: `apps/mission-control-next/src/cockpit/areas/system/SessionRow.test.tsx`. Also run the existing `SystemActivity.test.tsx` (it mocks `RecentSessions`, so it stays green) and any `RecentSessions` test.

**Interfaces:**
- Consumes: `sessionTitle` (Task 1); `SESSION_HEALTH`, `SESSION_BUDGET`, `SESSION_KIND` and `presentChannel`; `StatusBadge`, `TechnicalDetails`, `TimeText` and `SystemOwnerLink`.
- Produces: `SessionRow({ item, onDetails }: { item: SessionMeta; onDetails?: (sessionId: string) => void })`. This renders the current `RecentSessions` `<li>` content unchanged:
  - the title (h3) and the health badge;
  - "channel · kind · Last activity";
  - Budget;
  - the "Session details" disclosure, with Account, Usage, and `TechnicalDetails` holding the Session ID;
  - "Open in Chat".
  When `onDetails` is given, it adds a secondary `Button` "Details" with `aria-label={`Details: ${sessionTitle(item)}`}`.

- [ ] **Step 1: Write failing tests.**
  - It renders the title and the health label.
  - With `showTechnicalDetails` false (mock `useUiPreferences`), `textContent` doesn't contain the session ID.
  - With `onDetails`, the button named `Details: Owner conversation` calls it with the ID.
  - Without `onDetails`, there is no Details button.
- [ ] **Step 2: Run** that file. Expected: FAIL.
- [ ] **Step 3: Implement** `SessionRow` and switch `RecentSessions` to it.
- [ ] **Step 4: Run** `SessionRow.test.tsx`, then `SystemActivity.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(cockpit): share the session row between Activity and Sessions`.

### Task 3: Native `SystemSessions` page

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/areas/system/SystemSessions.tsx`: rewrite it, removing every import from `features/native-routes/**` except `runtime-overview-model`, and removing `EmbeddedClassicPage`, `ReleaseScopeBadge` and the `native-routes.css` import.
- Create, if `SystemSessions.tsx` would pass ~150 lines: `apps/mission-control-next/src/cockpit/areas/system/SelectedSessionSection.tsx`.
- Modify: `apps/mission-control-next/src/cockpit/areas/system/SystemSessions.test.tsx`. Rewrite the Classic-specific assertions; keep the navigation, control-binding and degraded tests.

**Interfaces:**
- Consumes: Tasks 1–2; `useOpsRuntimeSnapshot`; `SessionControlManager`; `AreaHeader`, `Section`, `MetricList`, `EmptyState`, `Button`, `StatusBadge`, `TimeText`, `TechnicalDetails` and `NativeOwnerLink`; `useCockpitRoute`.
- Produces: `SystemSessions()`, the same export the System area already mounts. Its page structure, in order:
  1. `AreaHeader` with title "Sessions" and description "Conversations across every channel, with controls for the one you choose." Its actions are a "Data stale" `StatusBadge` when `runtime.isStale`, then `Button` "Refresh sessions". Under the header comes `TimeText` "Updated …", as in `RuntimeOverview`.
  2. Loading, then the error `EmptyState` "Sessions unavailable" with "Try again", exactly as today.
  3. The degraded `<details>`, copied from `RuntimeOverview`, labelled through `SESSIONS_SOURCE_LABELS`: "N session sources are unavailable".
  4. When `sessionId` is set, a `Section` with id `selected-session` and the title `sessionTitle(found)`, or "Selected session" when the session isn't found. Its actions hold a `Button` "Close session". The body shows:
     - when found: a sentence with channel, kind and last activity, then a `MetricList` with Health, Budget and Tokens;
     - when not found: "This session isn't in the recent list. Its controls still apply.";
     - in both cases, `TechnicalDetails` with the session ID, then `<SessionControlManager key={sessionId} sessionId={sessionId} workspaceId={workspaceId} />`.
  5. `Section` "Recent sessions" with the description "Most recent first." It renders `<ul aria-label="Recent sessions">` of `SessionRow` with `onDetails={selectSession}`. When the list failed, it shows "Sessions couldn't be read." When the list is empty, it shows "No sessions have recent activity."
  6. `Section` "Across all workspaces" with the sentence "Approvals and helper agents for the whole installation, not just this workspace.", then a `MetricList` of `sessionsAcrossWorkspaces(data)`.
- The run branch: when `route.runId` passes the same check as `validApprovalRecordId` in `cockpit-compatibility.ts`, a `useEffect` calls `location.navigate("/work/runs/" + encodeURIComponent(runId) + <search without runId/view/sessionId> + hash, { replace: true })`. Export that validator from `cockpit-compatibility.ts` rather than copying it. Any other `runId`, and `?view=run-detail` with no runId, render the `AreaHeader` "Run detail" plus an `EmptyState` with the title "No run chosen", the description "Open a run from Work › History or from its Chat turn." and the action `NativeOwnerLink href="/work/history"` "Open Work › History".
- `selectSession` stays exactly as it is today.
- Drop the "Browser Sessions" button: Browser sessions is already a System tab.

- [ ] **Step 1: Rewrite the tests (they fail against the Classic page).**
  - The h1 is "Sessions". `host.querySelector(".cockpit-embedded-classic")` is `null`, and the text has none of "Session evidence", "posture" or "Session posture".
  - Clicking `Details: Owner conversation` → `navigate` is called once with `"/system/sessions?workspaceId=workspace-a&extra=keep&sessionId=session-a#control"` (kept from today).
  - With `&sessionId=older-session`: `fixture.control` is called with `{sessionId: "older-session", workspaceId: "workspace-a"}`, the text contains "isn't in the recent list", and Close session → `navigate("/system/sessions?workspaceId=workspace-a&extra=keep#control")`.
  - With `&sessionId=session-a`: the selected section's heading is "Owner conversation", and the text doesn't contain `session-a` while technical details are off.
  - With the sessions source errored and empty: the text contains "Sessions couldn't be read" and "1 session source is unavailable", and not "No sessions have recent activity".
  - The text contains "Pending approvals, all workspaces" and not "Decision queue pressure" (kept from today).
  - `?runId=run_0123456789abcdef&workspaceId=workspace-a&sessionId=s#receipt` → `navigate` is called with `"/work/runs/run_0123456789abcdef?workspaceId=workspace-a#receipt"` and `{replace: true}`.
  - `?view=run-detail` and `?runId=..%2F..` each render "No run chosen" and an "Open Work › History" link, with no navigate.
  - The `RunDetailRoutePage` mock and the `fixture.run` assertions are removed.
- [ ] **Step 2: Run** `vitest run src/cockpit/areas/system/SystemSessions.test.tsx --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3: Implement** the page as specified above, plus the exported validator.
- [ ] **Step 4: Re-run** `SystemSessions.test.tsx`, then `src/cockpit/app/cockpit-compatibility.test.ts`, since the validator export touches it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): native System › Sessions page`.

### Task 4: Guards, budgets, typecheck, lint

**Files:**
- Modify only if a guard reports a count below its budget: the matching `scripts/check-mission-control-next-*.mjs` budget constant(s). Expect legacy-usage (fewer `features/native-routes` imports) and possibly page-anatomy or raw-values.
- Modify, if it lists `SystemSessions` as an embed owner: `docs/ux/cockpit-remediation/release-closure-register.json`. Change only the entries that name `SystemSessions.tsx` as an embedded Classic owner; read the entries at lines ~25482 and ~37137 first.

- [ ] **Step 1: Run each guard** `node scripts/check-mission-control-next-<name>.mjs`, one at a time, for every file the `perf:check` script lists. Expected: all PASS. Where one says "lower the budget to N", set that budget to N in its script and re-run it.
- [ ] **Step 2: Run** `pnpm run typecheck` in `apps/mission-control-next`. Expected: exit 0.
- [ ] **Step 3: Run** eslint on the touched files (`pnpm --filter @goatcitadel/mission-control-next exec eslint <files>`). Expected: 0 errors.
- [ ] **Step 4: Run Prettier** `--check` on the touched files only, and `--write` where needed.
- [ ] **Step 5: Run** `git diff --check`, then commit `chore(cockpit): lower guard budgets after the native Sessions port`. Skip the commit if nothing changed.

Committing, pushing and opening the PR wait for the user's go-ahead.
