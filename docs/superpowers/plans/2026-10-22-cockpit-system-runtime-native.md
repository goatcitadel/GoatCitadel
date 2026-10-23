# Cockpit System › Runtime Native Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Classic page that `SystemRuntime` embeds with native cockpit pages built from cockpit primitives. That covers `/system/runtime`, `/system/runtime/diagnostics`, `/system/spend/details` and `/system/runtime/workers`, after which no `EmbeddedClassicPage` is left under System.

**Decisions agreed with the user (2026-10-22):**
- Port all four routes in this PR.
- Port the Classic Efficiency tab as a "Model performance" section.
- Keep Start, Restart and Stop, with a confirmation dialog on Restart and Stop.
- Native execution, then one whole-branch review.

**Architecture:** Pure derivations live in small `*-model.ts` files. Views are flat `Section`s with hairline rows over the existing hooks and API clients. Each route is built as its own tasks, in this order: Runtime (Tasks 1–5), Diagnostics (Task 6), Spend details (Task 7), Workers (Tasks 8–11), and the final routing and guard pass (Task 12).

- `SystemRuntime` becomes the Runtime page only.
- `/system/runtime/diagnostics` folds into the native `SystemDiagnostics`.
- `/system/spend/details` gets `SpendDetails`.
- `/system/runtime/workers` gets `cockpit/areas/system/workers/SystemWorkers`.

The Classic `RuntimeRoutePage` and `RemoteWorkersRoutePage` stay for the Classic shell. Where a native page for a control already exists, the Runtime page summarises and links to it instead of duplicating it:

- runtime authority: System › Diagnostics (`RuntimeAuthorityMap`);
- mesh activation: Library › Skills and tools (`MeshCapabilityPublications`);
- llama.cpp lifecycle: Settings › Advanced (`#managed-runtime`);
- MCP editing: Settings › Connections (`#mcp-servers`).

**Tech Stack:** React 19, TanStack Query, Tailwind cockpit tokens, vitest + happy-dom.

**Spec:** the task brief from the cockpit follow-up review, Phase 3 ("Runtime goes first"). Also `DESIGN.md` › Copy, Glossary and Page anatomy.

## Global Constraints

- Page anatomy: one `AreaHeader` (h1 "Runtime", one-line description, Refresh on the right). The System tabs come from the existing `AreaTabsProvider`. The body is flat `Section`s, with rows as `<ul className="divide-y divide-line-subtle">`. No bordered card inside the page, and no hero tiles: numbers are a sentence followed by a `MetricList`.
- Copy: none of posture, evidence, canonical, owner, projection, durable, caller or "Gateway" in operator text. The server is "GoatCitadel server", the same name Health uses. The `internal-terms` copy ratchet budget is 0 and must stay 0.
- Accessible names start with the visible text, for example `Back up now`, `Restart server`, `Open System › Diagnostics`.
- Host, PID, backup IDs, raw ISO times, server-authored diagnostic IDs and shell commands appear only inside `TechnicalDetails` (commands may also go in a `<details>` disclosure, as `DaemonDiagnostics` does). Times use `TimeText`, counts use `plural()` and sizes use the shared `format` helpers.
- Daemon status uses `presentRuntimeDaemon(data)` → `describeRuntimeService`, the same derivation as Health, rendered with `StatusBadge`. Backup status uses `backupHealthCheck(backupTrustFromInbox(...))`, the same as Health, so the two pages never disagree.
- Missing data reads "Unknown" or "Not reported", never 0 or healthy.
- Health's links keep working: `/system/runtime` and `/system/runtime#ops-runtime-backups`. The legacy hashes `#ops-runtime-posture`, `#ops-runtime-recovery` and `#ops-runtime-handoff` land on the server section, and `#ops-runtime-integrations` lands on the integrations section.
- Machine rules: one heavy job at a time; vitest one file at a time with `--maxWorkers=2` at low priority; no `verify:*` lanes locally; build `@goatcitadel/contracts` first; Prettier only on touched files; never `git stash`.

## Review Focus

1. **Both daemon and health sources failed.** The page shows "Unknown" status plus the unavailable-sources disclosure, never "Running" and never an empty services list. Pinned in Task 1 (`runtimeServerStatus`) and Task 5 (degraded test).
2. **Caller or workspace change while a Stop confirmation or a budget authorization is open.** The page remounts, so the dialog closes and nothing is sent. Pinned in Task 5 (Stop) and Task 11 (the uncertain-outcome and generation pins).
3. **Old bookmarks:**
   - `/system/runtime#ops-runtime-backups` reaches the backups section (Task 3 checks the id; Task 1 checks `runtimeSectionForHash`);
   - `/system/runtime/diagnostics` still renders Diagnostics (Task 6);
   - `?workerId=&assignmentId=` still opens the exact worker and assignment, and never falls back to another one (Tasks 9 and 10).
4. **A backup record whose trust has not been read yet.** It shows "Not verified yet", exactly as Health does, not "Verified". Pinned in Task 3.
5. **Unknown money.** A missing cost reads "Unknown", never "$0.00", in Spend details and on assignments. Pinned in Tasks 7 and 10.

---

### Task 1: Runtime page model

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/system/runtime-page-model.ts`
- Test: `apps/mission-control-next/src/cockpit/areas/system/runtime-page-model.test.ts`

**Interfaces:**
- Consumes: `OpsRuntimeData`, `presentRuntimeDaemon` and `sourceFailed` from `features/native-routes/ops/runtime-overview-model`; `readDaemonRuntimeDiagnostics`, `readDaemonRepairActions` and `readDaemonControlHandoff` from `RuntimeDaemonPanels`; `DAEMON_SEVERITY_LABELS` from `settings/settings-vocabulary`; `formatBytes` and `formatSeconds` from shared `content/format`.
- Produces:
  - `RUNTIME_SOURCE_LABELS: Record<string, string>`: daemon → "Server process", health → "Health summary", llamaCpp → "Local model runtime", mcpServers → "MCP servers", backups → "Backup records".
  - `runtimeServerStatus(data): StatusPresentation & { detail: string }`.
  - `runtimeServerMetrics(data): Metric[]`: Uptime, Memory used (hint "process …"), and, when `storageWait` is present, Database wait p95 and Database wait max. Values are "Unknown" when the source failed.
  - `runtimeDiagnosticRows(data): { key: string; title: string; detail: string; severity: StatusPresentation }[]`: severity maps critical → failed, warn → waiting, pass → done, info → neutral, with the label from `DAEMON_SEVERITY_LABELS`.
  - `localModelStatus(data): StatusPresentation & { detail: string }`.
  - `integrationRows(data): { key: string; name: string; status: StatusPresentation; kind: string }[]`.
  - `runtimeSectionForHash(hash: string): "runtime-server" | "ops-runtime-backups" | "runtime-integrations" | null`.

- [ ] **Step 1: Write failing tests.** Run the following assertions over a minimal `OpsRuntimeData` fixture built with `sourceStatus` entries:
  - `runtimeServerStatus` with daemon and health both errored → `{label: "Unknown", tone: "neutral"}`.
  - `runtimeServerStatus` with `daemon.running: true` and no diagnostics → the same label and tone as `describeRuntimeService(daemon)`.
  - `runtimeServerMetrics` with health errored → Memory used is "Unknown".
  - `runtimeServerMetrics` with `storageWait {p95Ms: 12, maxMs: 40, count: 3, criticalCount: 0}` → includes `{term: "Database wait p95"}`.
  - `runtimeDiagnosticRows` with a `warn` diagnostic → `severity: {label: "Warning", tone: "waiting"}`.
  - `localModelStatus` with llamaCpp `not_requested`/errored → "Unknown".
  - `localModelStatus` with `{processState: "running", healthy: true}` → `{label: "Running", tone: "done"}`.
  - `localModelStatus` with `healthy: false` → `{label: "Needs review", tone: "waiting"}`.
  - `integrationRows` with an enabled server → `status.label === "On"`; with a disabled one → `"Off"`.
  - `runtimeSectionForHash`: `"#ops-runtime-posture"` → `"runtime-server"`; `"#ops-runtime-backups"` → `"ops-runtime-backups"`; `"#nope"` → `null`.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/system/runtime-page-model.test.ts --maxWorkers=2`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the exports above. Each is a pure function over `data`, with no React.
- [ ] **Step 4: Re-run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): runtime page model for the native System › Runtime page`.

### Task 2: Server section with controls

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/system/RuntimeServerSection.tsx`
- Test: `apps/mission-control-next/src/cockpit/areas/system/RuntimeServerSection.test.tsx`
- Modify: `apps/mission-control-next/src/cockpit/ui/Section.tsx`: add an optional `id?: string` on the `<section>`, used for hash targets.

**Interfaces:**
- Consumes: the Task 1 functions; `Section`, `StatusBadge`, `MetricList`, `TechnicalDetails`, `Button` and `Dialog`.
- Produces: `RuntimeServerSection({ data, runtime }: { data: OpsRuntimeData; runtime: Pick<ReturnType<typeof useOpsRuntimeSnapshot>, "notice" | "daemonBusy" | "runDaemonAction"> })`.

Content, in order:
- `Section` with id `runtime-server` and title "GoatCitadel server", with the `StatusBadge` in its actions.
- The status detail sentence.
- `MetricList` with label "Server measurements".
- The diagnostics as a hairline list, each row a title plus a severity `StatusBadge` and its detail. It is hidden when there are no diagnostics.
- Repair actions as rows (label and description). Commands go inside a `<details>` named "Process manager and commands", next to the handoff owner and reason.
- `TechnicalDetails` holding host, PID and the server's control message.
- When `controllable`: the buttons "Start server", "Restart server" and "Stop server", all secondary, because stopping can be undone. Restart and Stop open a `Dialog` that states the consequence ("Chat, runs and this page lose the server until it starts again") with the confirm buttons "Restart server" / "Stop server" and Cancel. `runtime.notice` renders in a `role="status"` paragraph. While `daemonBusy` is set, every button is disabled and the busy one reads "Starting…", "Restarting…" or "Stopping…".

- [ ] **Step 1: Write failing tests.**
  - The heading "GoatCitadel server" and the badge text equal `describeRuntimeService(...)`.label.
  - With `controllable: false`, there is no button named /^Stop server/, and the summary "Process manager and commands" is present.
  - Clicking "Stop server" opens a dialog. Confirming calls `runDaemonAction("stop")` once; Cancel calls nothing.
  - The host string is absent from `textContent` when `showTechnicalDetails` is false (mock `useUiPreferences`).
  - The section element has `id="runtime-server"`.
- [ ] **Step 2: Run** `vitest run …/RuntimeServerSection.test.tsx --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3: Implement** the `Section` `id` prop and `RuntimeServerSection`.
- [ ] **Step 4: Re-run** that test and `src/cockpit/ui/*Section*` if one exists. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): native runtime server section with confirmed restart and stop`.

### Task 3: Records sections (backups, local model, integrations, links)

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/system/RuntimeRecordSections.tsx`
- Test: `apps/mission-control-next/src/cockpit/areas/system/RuntimeRecordSections.test.tsx`

**Interfaces:**
- Consumes: the Task 1 functions; `backupHealthCheck`; `backupTrustFromInbox`; `useOperatorInbox` and `inboxMatchesWorkspace` (the same calls as `HealthOverview`); `HealthBackupAction`; `SystemOwnerLink`; `TimeText`; `plural`.
- Produces: `RuntimeRecordSections({ data, workspaceId, onRefresh }: { data: OpsRuntimeData; workspaceId: string; onRefresh: () => Promise<unknown> })`.

Sections, in order:
1. **Backups**, with id `ops-runtime-backups`. The badge is `backupHealthCheck(...).status` and its detail follows. `HealthBackupAction` comes next. Then the backups as rows: `TimeText createdAt`, "· N files" via `plural`, with the backup ID in `TechnicalDetails`. When the list is empty: "No backup records yet."
2. **Local model runtime.** The `localModelStatus` badge and detail, the last error inside `TechnicalDetails`, and the link "Open Settings › Advanced" → `/settings/advanced#managed-runtime`.
3. **Integrations**, with id `runtime-integrations`. `integrationRows` as rows (name, On/Off badge, kind), and the link "Open Settings › Connections" → `/settings/connections#mcp-servers`. When the source is unavailable: "MCP servers could not be read."
4. **Runtime records and capabilities.** Two rows, each a sentence plus a link:
   - "Runtime authority: what each part of the system last reported, and how fresh it is." → "Open System › Diagnostics" → `/system/diagnostics`.
   - "Mesh capabilities: published tools, activation requests and revocations." → "Open Library › Skills and tools" → the existing Library skills-and-tools href (read it from `LibraryArea`).

- [ ] **Step 1: Write failing tests.**
  - When the inbox has no `backup_trust` coverage and a latest record exists, the badge reads "Not verified yet".
  - The Backups section has `id="ops-runtime-backups"`.
  - Each backup row shows "3 files" and does not show the backup ID with technical details off.
  - A disabled MCP server row shows "Off".
  - The link named "Open System › Diagnostics" has its pathname `/system/diagnostics`.
- [ ] **Step 2: Run** `vitest run` on that file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): native runtime backups, local model and integrations sections`.


### Task 4: Model performance section (the Classic Efficiency tab)

**Files:**
- Modify: `apps/mission-control-next/src/cockpit/areas/system/runtime-page-model.ts` (and its test)
- Create: `apps/mission-control-next/src/cockpit/areas/system/RuntimeModelPerformance.tsx`
- Test: `apps/mission-control-next/src/cockpit/areas/system/RuntimeModelPerformance.test.tsx`

**Interfaces:**
- Produces, in the model:
  - `modelPerformanceMetrics(data): Metric[]` with three entries:
    - "Average response time" (completed samples only, hint "completed calls");
    - "Latest output speed" (tokens/s);
    - "Latest estimated cost" (shared money formatter, "Unknown" when absent).
    Each value reads "Unknown" when `runtimeMeasurements` failed.
  - `engineFitStatus(fit): StatusPresentation`: strong or ok → "Good fit"/done; weak → "Weak fit"/waiting; anything else → "Not measured"/neutral.
  - `comparisonRunStatus(status): StatusPresentation`, through the shared status-vocabulary presenter.
  - Add three entries to `RUNTIME_SOURCE_LABELS`: runtimeMeasurements → "Model call measurements", localEngines → "Local engines", evalProofRuns → "Model comparison runs".
- Produces, in the view: `RuntimeModelPerformance({ data }: { data: OpsRuntimeData })`. It is a `Section` with id `ops-runtime-efficiency`, title "Model performance" and description "Measured model calls, how well each local engine fits, and model comparison runs."
  - A lead sentence, then the `MetricList`.
  - "Recent model calls" (h3): rows of model name, provider display name (use the shared provider-label helper; the provider ID goes in `TechnicalDetails`), response time, cost and `TimeText collectedAt`.
  - "Local engines" (h3), id `ops-runtime-engine-fit`: rows of label, `engineFitStatus` badge and the first note.
  - "Model comparison runs" (h3), id `ops-runtime-evidence`: rows of `TimeText createdAt`, status badge, "N candidates" via `plural`, and the providers on the best trade-off curve. Run IDs and warnings go in `TechnicalDetails`.
  - Each subgroup shows "Could not be read." when its source failed, and one line when it is empty.
  - Drop the static "Browser proof abstraction" card; it shows no data.
- In Task 5, `requestedSources` adds `runtimeMeasurements`, `localEngines` and `evalProofRuns`. `runtimeSectionForHash` maps `#ops-runtime-browser-proof` to `ops-runtime-efficiency`.

- [ ] **Step 1: Write failing tests.**
  - With `runtimeMeasurements` errored, the metric "Average response time" reads "Unknown", not "0 ms".
  - `engineFitStatus("weak")` returns `{label: "Weak fit", tone: "waiting"}`.
  - The view shows "2 candidates" and hides the run ID while technical details are off.
  - With an empty `localEngines` list, the line "No local engines are configured." appears.
- [ ] **Step 2: Run each test file.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run each file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): model performance section on System › Runtime`.

### Task 5: Native Runtime page in `SystemRuntime`

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/system/RuntimeOverview.tsx`
- Modify: `SystemRuntime.tsx`. The `"runtime"` branch renders `RuntimeOverview`. The other branches stay embedded until Tasks 6, 7 and 11 remove them.
- Modify: `SystemRuntime.test.tsx`. Drop `"runtime"` from the delegation `it.each` and render `"diagnostics"` in the navigation tests for now. Add the native-page tests below.

**Interfaces:**
- Consumes:
  - Tasks 2, 3 and 4;
  - `useOpsRuntimeSnapshot("runtime", { requestedSources: ["llamaCpp", "backups", "mcpServers", "runtimeMeasurements", "localEngines", "evalProofRuns"] })`;
  - `buildSectionDegradedSources(data, "runtime")`, `RUNTIME_SOURCE_LABELS` and `runtimeSectionForHash`.
- Produces: `RuntimeOverview({ workspaceId, sessionId }: { workspaceId: string; sessionId?: string })`, mounted with `key={access.identity + ":runtime"}`.

`RuntimeOverview` renders, inside `AREA_PAGE`:
- `AreaHeader` with title "Runtime" and description "The GoatCitadel server, local models, backups and integrations, as each reports itself."
  - Actions: Refresh (with `<span className="sr-only"> runtime</span>`) and a "Data stale" `StatusBadge` when `isStale`.
  - Children: `TimeText prefix="Updated"`.
- A loading `role="status"` line.
- An `EmptyState` on `runtime.error`, with "Try again".
- The unavailable-sources `<details>`, in the same shape as Health's ("N runtime sources are unavailable").
- `RuntimeServerSection`, then `RuntimeRecordSections`, then `RuntimeModelPerformance`.
- When `sessionId` is set, a row "Open the session in System › Sessions" → `/system/sessions?sessionId=…`.

On mount and on `hashchange`, `runtimeSectionForHash` scrolls to the mapped id.

- [ ] **Step 1: Write failing tests**, mocking `useOpsRuntimeSnapshot`:
  - There is no `.cockpit-embedded-classic` element for `"runtime"`.
  - The h1 reads "Runtime".
  - The section headings appear in this order: GoatCitadel server, Backups, Local model runtime, Integrations, Runtime records and capabilities, Model performance.
  - With daemon and health errored, the page shows "2 runtime sources are unavailable" and the "Unknown" badge.
  - A caller identity change remounts the page: an open Stop dialog closes and `runDaemonAction` is never called.
  - The Refresh button's accessible name starts with "Refresh".
- [ ] **Step 2: Run** `SystemRuntime.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run** `SystemRuntime.test.tsx`, then `HealthOverview.access.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): System › Runtime renders a native page`.

### Task 6: Fold runtime diagnostics into System › Diagnostics

**Files:**
- Create: `cockpit/areas/system/DiagnosticsHostSection.tsx` (host and server checks)
- Create: `cockpit/areas/system/ReleaseReadinessSection.tsx`
- Create: `cockpit/areas/system/release-readiness-model.ts` and its test
- Modify:
  - `SystemDiagnostics.tsx`: add the two sections and a log text filter. Drop the "Open full diagnostics and export controls" link, and add a backup line linking "Open System › Runtime" → `/system/runtime#ops-runtime-backups`.
  - `recent-diagnostics-export.ts`: add server checks as a third source.
  - `cockpit/app/cockpit-compatibility.ts`: `diagnostics` → `/system/diagnostics`.
  - `SystemArea.tsx`: `runtime/diagnostics` renders `SystemDiagnostics`, so old bookmarks still work.
  - `SystemDashboardWidget.tsx`: point the diagnostics link at `/system/diagnostics`.
  - `SystemRuntime.tsx`: remove the `"diagnostics"` branch.
  - Update the tests that expect the old path: `cockpit-compatibility.test.ts`, `cockpit-native-continuations.test.ts`, `shell-preference.test.ts`, `SystemDiagnostics.test.tsx`, `SystemDashboards.test.tsx` and `SystemRuntime.test.tsx`.

**Interfaces:**
- **Host section.** Data comes from `useQuery` over `fetchHealthSummary` (reuse an existing health query key if one fits).
  - "Host" `MetricList`: Uptime, Release, CPU, Load, Memory used, Free memory, each via the shared `format` helpers. Missing values read "Unknown".
  - Hostname and platform go in `TechnicalDetails`.
  - "Server checks": rows from `daemonStatus.diagnostics`, using the severity mapping exported from Task 1 as `daemonSeverityStatus`.
- **Readiness section.** Data comes from `useQuery` over `fetchReviewReadiness()`, `enabled` only once its `<details>` is opened. "Check again" calls `refreshRuntimeReleaseTrust()` and writes the result into the query cache.
  - The model produces `releaseReadinessSummary(summary): { status: StatusPresentation; sentence: string; blockers: { key: string; title: string; detail: string }[]; checks: { key: string; title: string; status: StatusPresentation }[] }`.
  - Hashes, reason codes, task IDs, branch and SHA, script and workflow names, and the route-scope table go in `TechnicalDetails`.
  - The copy avoids "Server-owned", "Gateway-owned" and "evidence".

- [ ] **Step 1: Write failing tests.**
  - The model: a blocked summary gives `{label: "Blocked", tone: "failed"}` with one blocker per reason. No title contains "_".
  - The page: the "Host" heading is shown, and "Free memory" reads "Unknown" when missing.
  - Typing "timeout" in the log filter leaves only matching log rows.
  - Opening "Release and review readiness" calls `fetchReviewReadiness` once; nothing is fetched before it opens.
  - The old link text is gone.
  - Rendering `SystemArea` at `/system/runtime/diagnostics` shows the h1 "Diagnostics" with no `.cockpit-embedded-classic`.
- [ ] **Step 2: Run each file.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run each touched test file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): System › Diagnostics absorbs host, server checks and release readiness`.

### Task 7: Native Spend details

**Files:**
- Create: `cockpit/areas/system/SpendDetails.tsx` and its test
- Create: `cockpit/areas/system/spend-details-model.ts` and its test
- Modify:
  - `SpendDailyChart.tsx`: an optional provider filter, or accept a pre-filtered summary, whichever keeps its test unchanged.
  - `SystemArea.tsx`: `spend/details` → `SpendDetails`.
  - `SystemRuntime.tsx`: remove the `"costs"` branch.

**Interfaces:**
- **Model:**
  - `readSpendFilters(search: string): { days: 1 | 3 | 7; provider: string }`. Invalid or repeated values fall back to 7 and "all".
  - `filterCostSummary(summary, filters)`: slices `dailySeries` to the last N days and to the provider. It never turns a missing cost into 0.
  - `providerDayRows(summary, providerKey): { date: string; input: number | null; output: number | null; cached: number | null; partial: boolean }[]`.
- **Page:** `SpendDetails()`. Data: `useQuery` over `fetchCostSummary("day")` with the cache key SpendOverview already uses.
  - `AreaHeader` with title "Spend details", description "Cost and token records by day and provider." and Refresh.
  - Filters: a segmented "Last 7 days · 3 days · 1 day" control and a provider radiogroup. Both write `?window=` and `?provider=` with `navigate(…, { replace: true })`, keeping the other params (`workspaceId`, `citadelId`, `cockpitReturnView`) and the hash.
  - "Coverage": a sentence, then a `MetricList` with "Calls with a known cost" ("N of M"), "Tracked events" and "Events without cost".
  - "By day": `SpendDailyChart`.
  - "Providers": `projectProviderCostRows` rows with `SpendObservedModels`. Each row has a `<details>` "Daily tokens" showing `providerDayRows`, labelled "partial" when partial.
  - `SpendAttempts` for the window.
  - `TechnicalDetails`: the accounting window and raw totals.
  - A link "Back to Spend" → `/system/spend` with the same params.
- **Copy:** the Classic QMD compression block is dropped. Unknown cost reads "Unknown", never "$0.00".

- [ ] **Step 1: Write failing tests.**
  - `readSpendFilters("?window=3&provider=openai")` returns `{days: 3, provider: "openai"}`; `"?window=9"` returns `{days: 7, provider: "all"}`.
  - `filterCostSummary` with a missing `costUsd` keeps the cost `null`.
  - Clicking "3 days" calls navigate with `window=3` and keeps `cockpitReturnView`.
  - A provider row with an unknown cost shows "Unknown".
  - There is no `.cockpit-embedded-classic` at `/system/spend/details`.
- [ ] **Step 2: Run each file.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run each file, plus `SpendOverview.test.tsx` and `SpendDailyChart.test.tsx`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): native Spend details page`.

### Task 8: Workers data layer

**Files** (all under `cockpit/areas/system/workers/`):
- Create: `worker-copy.ts`, the status presenters and glossary-safe labels:
  - `workerStatus(posture)`: active → Running/done, quarantined → "Contained"/failed, otherwise "Unknown"/neutral;
  - `assignmentStatus(phase)`;
  - `settlementStatus(outcome)`;
  - `AUTHORITY_WORDS`: canonical → "Saved record", projected → "Summary";
  - `readWorkerSelection`, moved from `SystemRuntime`.
- Create: `use-worker-detail.ts`, lifted from `RemoteWorkersRoutePage` without changing behaviour:
  - the sequence-guarded detail, assignments and reconciliation load;
  - scope masking while the next worker loads;
  - assignment paging with the repeated-cursor guard and page-count refetch;
  - the realtime coalescer.
- Create: `use-assignment-events.ts`, which checks workspace, assignment and generation, and pages with `afterSequence` under a busy lock.
- Tests: `worker-copy.test.ts`, `use-worker-detail.test.tsx`.

**Interfaces:**
- `useWorkerDetail(workspaceId: string, workerId: string | undefined)` returns `{ detail, assignments, reconciliation, loading, error, loadMoreAssignments(), hasMoreAssignments, refresh() }`. Fields keep the API types from `api/remote-workers`.
- `useAssignmentEvents(workspaceId, assignment | undefined)` returns `{ events, loading, error, loadNewer() }`.
- It reuses `useRemoteWorkerRegistry(workspaceId)` unchanged.

- [ ] **Step 1: Port the pinned behaviours from `RemoteWorkersRoutePage.test.tsx` as hook tests.**
  - No detail fetch until a worker is selected.
  - Detail calls use `{workerId, limit: 50}`.
  - A late detail response from a previous workspace or worker is ignored.
  - The previous worker's assignments are hidden while the next loads.
  - A repeated cursor stops paging.
  - Events are not fetched for a generation mismatch.
- [ ] **Step 2: Run each file.** Expected: FAIL.
- [ ] **Step 3: Implement**, moving the logic rather than rewriting it.
- [ ] **Step 4: Re-run.** Expected: PASS.
- [ ] **Step 5: Commit** `refactor(cockpit): worker detail and assignment event hooks`.

### Task 9: Workers list, detail and identity

**Files** (under `workers/`):
- Create: `SystemWorkers.tsx` (page), `WorkerList.tsx`, `WorkerDetail.tsx`, `WorkerIdentitySection.tsx`
- Test: `SystemWorkers.test.tsx`

**Interfaces:**
- **`SystemWorkers()`** reads `?workerId=` and `?assignmentId=` with `readWorkerSelection`.
  - An ambiguous selection keeps today's alert and the "Open worker records" link.
  - Selecting or closing writes the URL and keeps the other params and the hash.
  - It is keyed on `access.identity + workspaceId`.
  - `AreaHeader`: title "Workers", description "Remote workers, their assignments and spending budgets." and Refresh.
- **`WorkerList`**: hairline rows of name (or "Unnamed worker"), `workerStatus` badge, "N capabilities" and "Last checked" `TimeText`. It has "Load more workers", an error `EmptyState` ("Worker records are unavailable") and an empty state ("No workers have joined yet.").
- **`WorkerDetail`**: the sections Identity, Controls (read-only, with copy saying it never enrolls, rotates, contains or revokes), Reconciliation, Assignments and Spending budgets (Task 11).
  - Assignment rows: `assignmentStatus` badge, session title or "Session", `settlementStatus`, and an "Assignment details" button whose name starts with that text.
- **Identity**: worker, node and session IDs, digests, revisions, generation and raw times all go in `TechnicalDetails`, with digests truncated as today. Visible times use `TimeText`. None of the strings leasetoken, reasonsha, idempotency, requestsha or dispatchauthority may render.

- [ ] **Step 1: Write failing tests.**
  - "Detail unavailable" for an unknown bookmarked worker, never the first row.
  - The "Worker records are unavailable" copy.
  - Selecting a row navigates with `workerId`.
  - No raw ID is visible while technical details are off.
  - No text contains Canonical, admitted or evidence.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): native workers list and worker detail`.

### Task 10: Assignment inspector and runtime

**Files** (under `workers/`):
- Create: `AssignmentInspector.tsx` (cockpit `Sheet`), `AssignmentRuntimeSections.tsx`
- Test: `AssignmentInspector.test.tsx`

**Interfaces:**
- `AssignmentInspector({ workspaceId, worker, assignmentId, onClose })` uses `useAssignmentEvents` and `useRemoteWorkerAssignmentRuntime`. It contains:
  - Events, with "Load newer events";
  - Contact;
  - Usage and cost;
  - Resource cell;
  - Outputs (reuse `NativeOutputDownloads`);
  - a raw record in `TechnicalDetails`.
- A missing bookmarked assignment shows "This assignment is not in the loaded records." and makes no events call.
- **Money** uses the shared formatter, so a tiny amount reads "<$0.01", following DESIGN. The exact micro-dollar value goes in `TechnicalDetails`. This replaces the Classic `$0.000001` pin.

- [ ] **Step 1: Write failing tests**, porting the pins from `RemoteWorkerAssignmentRuntimePanel.test.tsx`:
  - "incomplete" and "outstanding holds" are shown;
  - the text "does not establish an open connection" is shown;
  - "Resource cell unavailable" is shown;
  - "Worker healthy" and "$0.00" never appear;
  - "Assignment identity changed" on a generation mismatch;
  - "Assignment runtime is unavailable" on a read failure;
  - a late read is ignored;
  - a tiny cost shows "<$0.01";
  - a bookmark opens the inspector and fetches events with `{limit: 50}`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): native assignment inspector`.

### Task 11: Worker spending budgets

**Files** (under `workers/`):
- Create: `worker-budget-model.ts` (pure validation and acknowledgement match), `WorkerBudgets.tsx`
- Test: `worker-budget-model.test.ts`, `WorkerBudgets.test.tsx`
- Modify: `SystemArea.tsx`: `runtime/workers` → `SystemWorkers`.
- Modify: `SystemRuntime.tsx`: remove the workers branch and the lazy `RemoteWorkersRoutePage` import.

**Interfaces:**
- **Model:**
  - `validateBudgetDraft(draft)` returns `{ ok: true; limits } | { ok: false; message }`, with the same rules as today: at least 2 requests, and money as an integer number of micro-dollars.
  - `acknowledgementMatches(request, response): boolean` (the exact echo check, revision ≥ 1).
- **View:**
  - Reuse `useSessionDraft` with the key `worker:{ws}:{id}:budget`, versioned by generation; `useWorkerBudgetAttempt`; and `fetchRemoteWorkerBudgets`, `authorizeRemoteWorkerBudget` and `revokeRemoteWorkerBudget`.
  - "Review budget" opens a `Dialog` stating limits, workspace name, generation and expiry, with a primary "Authorize budget" and Cancel.
  - An uncertain outcome keeps "Review pending authorization", which resends the same grant.
  - A generation change shows "This worker changed since your draft started" with "Start from the current version".
  - Revoke gets a **danger** `Dialog`. It names the worker and the remaining amount and says it cannot be undone here.
  - Leaving a dirty draft goes through `UnsavedChangesDialog`.
  - A contained worker gets a disabled form with a sentence saying why.

- [ ] **Step 1: Write failing tests**, porting the pins from `RemoteWorkerBudgetPanel.test.tsx`:
  - submitting the form does not authorize;
  - confirming sends the exact limits and generation, then the list is fetched twice;
  - a fetch error shows "budgets are unavailable";
  - a contained worker gets a disabled fieldset;
  - an uncertain outcome survives unmount and the retry payload equals the first one.
  - New pin: revoke calls `revokeRemoteWorkerBudget` only after the danger dialog is confirmed.
- [ ] **Step 2: Run each file.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run each file.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cockpit): native worker spending budgets with confirmed revoke`.

### Task 12: No Classic pages left under System, plus guards

**Files:**
- Modify: `SystemRuntime.tsx`. Only the native Runtime page remains. Remove the `section` prop, the `EmbeddedClassicPage` and `RuntimeRoutePage` imports, and the navigate shim, if it is unused.
- Modify: `SystemArea.tsx`. Its routes: `runtime` → `SystemRuntime`, `runtime/diagnostics` → `SystemDiagnostics`, `runtime/workers` → `SystemWorkers`, `spend/details` → `SpendDetails`.
- Modify: `SystemRuntime.test.tsx`. Delete the delegation and the Classic navigation-shim tests; their behaviour now lives in each page's tests. Keep the access-remount tests.
- Modify: `health-overview.ts`. Update the stale comment about the "existing native runtime owner".
- Modify: guard budgets in `scripts/check-mission-control-next-*.mjs` wherever counts drop.

- [ ] **Step 1:** `git grep -n "EmbeddedClassicPage" apps/mission-control-next/src/cockpit/areas/system` should print nothing.
- [ ] **Step 2: Build contracts**, then run the touched test files one at a time with `--maxWorkers=2` at low priority: every new test file plus `SystemRuntime`, `SystemDiagnostics`, `SpendOverview`, `HealthOverview.access`, `SystemDashboards`, `cockpit-compatibility`, `cockpit-native-continuations` and `shell-preference`. Expected: all PASS.
- [ ] **Step 3:** `pnpm run typecheck` in `apps/mission-control-next`, then eslint on the touched files. Expected: exit 0.
- [ ] **Step 4:** Run each `node scripts/check-mission-control-next-<name>.mjs`. Expected: exit 0. Wherever a guard says a count is below budget, lower that budget, and record the before and after numbers in the commit body.
- [ ] **Step 5: Prettier** on the touched files only. Commit `chore(cockpit): System has no embedded Classic pages; lower guard budgets`.
- [ ] **Step 6:** Ask the user before pushing or opening the PR. After merge, rebaseline the `cockpit-system-runtime` visual baseline, and the diagnostics, spend-details and workers routes if they have visual routes.

## Size and risk note

This is one large PR: about 3,500 lines of new source and 1,800 lines of tests. Workers is about half of it. If review gets hard, the natural split is Tasks 1–7 (Runtime, Diagnostics, Spend) and Tasks 8–12 (Workers), each green on its own.
