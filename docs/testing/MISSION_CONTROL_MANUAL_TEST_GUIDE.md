# Mission Control Manual Test Guide

This guide is for the exhaustive pre-test stabilization pass across all Mission Control pages.

## Files

- Matrix: `artifacts/manual-qa/mission-control-manual-test-matrix.csv`
- Defects: `artifacts/manual-qa/mission-control-defect-log.csv`

## How to run this pass

1. Start GoatCitadel and confirm UI + gateway are reachable.
2. Open the matrix in Excel or Google Sheets.
3. Execute rows in ascending `case_id` order.
4. For each row, fill `actual_result`, `status`, `severity`, `evidence_path`, `notes`, `build_ref`, and `tested_at`.
5. If a row fails, add a matching entry in defect log with `linked_case_id`.

## Deterministic local smoke path

Use this when you need a reproducible Mission Control surface check without relying on the MCP browser runtime.

### 1. Start the local surface

From the repo root:

```powershell
pnpm --filter @goatcitadel/mission-control dev -- --host 127.0.0.1 --port 4173
```

Wait for the local Vite URL to report ready:

```text
http://127.0.0.1:4173
```

### 2. Verify Playwright CLI availability

In a second terminal:

```powershell
npx --version
```

If `npx` is available, point to the user-scoped Playwright wrapper:

```powershell
$env:CODEX_HOME = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME/.codex" }
$env:PWCLI = Join-Path $env:CODEX_HOME "skills/playwright/scripts/playwright_cli.sh"
```

### 3. Run the CLI smoke flow

Prefer headed mode for operator-facing checks:

```powershell
bash "$env:PWCLI" open http://127.0.0.1:4173 --headed
bash "$env:PWCLI" snapshot
```

Re-snapshot after every navigation, mode switch, dock toggle, or modal transition. Save artifacts under `output/playwright/` when you need screenshots:

```powershell
bash "$env:PWCLI" screenshot --output output/playwright/mission-control-smoke.png
```

### 4. Required smoke checklist

Run these in order:

1. Empty states
   Confirm first-load empty states for Chat, Cowork, and Code.
2. Surface switching
   Switch modes with no active session, then with an active session and locked surface routing.
3. Session rail
   Select a session from the left rail and confirm the selected row reveals the extra preview line.
4. Dock defaults
   Confirm Chat starts with the dock closed, while Cowork and Code start with the dock open on desktop.
5. Dock toggle
   Toggle the dock manually in each surface and confirm state changes are stable.
6. Queue while streaming
   Start a turn, queue a follow-up send/edit/retry, and confirm it resumes after the active turn completes.
7. Edit, retry, and recovery
   Trigger a recoverable turn state and confirm the composer recovery banner and retry action appear.
8. Reconnect behavior
   Interrupt the event stream, confirm reconnect banners appear in the thread status lane, then verify recovery or refresh guidance.
9. Narrow-width layout
   Resize below desktop width and confirm the dock behaves like a drawer/sheet instead of a permanent lane.

## Preflight

- `pnpm -r typecheck`
- `pnpm -r test`
- `pnpm smoke`
- `pnpm -r build`

## Test data you should have before starting

- At least one configured provider/model.
- At least one chat project/session.
- One prompt pack imported in Prompt Lab.
- One integration connection (or deliberately missing credentials for blocked-state checks).
- One MCP template added (can remain disconnected).

## Execution order

1. Global shell + navigation rows.
2. Per-page simple mode rows.
3. Per-page advanced mode rows.
4. Cross-cutting rows for refresh/flicker/workspace switching/accessibility.

## Status values

- `pass`: expected behavior confirmed.
- `fail`: expected behavior not met.
- `blocked`: cannot complete due prerequisite/environment issue.
- `not_run`: intentionally skipped or deferred.

## Severity values

- `none`: pass/no issue.
- `low`: cosmetic/minor friction.
- `medium`: meaningful usability or reliability issue.
- `high`: major workflow break.
- `critical`: blocking core usage or safety risk.

## Evidence naming convention

Use predictable filenames so triage is fast:

- Screenshot: `evidence/screenshots/<case_id>.png`
- Video: `evidence/videos/<case_id>.mp4`
- Log snippet: `evidence/logs/<case_id>.txt`

## Exit criteria for this pass

- All P0 and P1 rows executed.
- No unresolved critical defects.
- No in-page hard reload/flicker defects on key workflows.
- Prompt Lab run-vs-score classification remains clear.
