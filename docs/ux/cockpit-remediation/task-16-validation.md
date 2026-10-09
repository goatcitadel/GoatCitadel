# Task 16 performance validation — 2026-10-08

Owner: Claude Code root continuation. Source, focused tests and one disposable before/after measurement establish what is claimed here. No installed-host, Ubuntu, full PostgreSQL, live-provider or release proof is claimed. Unmet targets are recorded as unmet; no budget, counting window or exclusion was changed.

## Measurement definition

- **Harness:** `.superpowers/sdd/2026-10-05-cockpit-remediation/task-16-measure.mjs <label> <before|after>`.
- **Runtime:** one disposable Gateway, a Vite production preview and a fresh browser context per run, at a 1440×900 viewport. Each run has a saved dark theme under a light OS preference, plus one inverse theme check.
- **Startup:** every request within 3.5 s, excluding only `/api/v1/events/stream`.
- **Initial JS:** the gzip size of the scripts loaded in that window.
- **CLS:** layout-shift entries.
- **First frame:** the `data-theme` attribute and background before the bundle runs.
- **Idle:** requests over 120 s across Chat plus Inbox, after a 10 s settle.
- **Elsewhere-turn:** not measured; it needs a deterministic-provider Chat turn.
- **Records:**
  - `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-16-before-1/task-16-before-measure.json`
  - `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-16-after-1/task-16-after-measure.json`
  - Cleanup was verified for both.

## Results

| Metric (target) | Before | After | Result |
| --- | --- | --- | --- |
| First-frame theme (correct) | none ×3; inverse none | dark ×3; inverse light | met |
| Initial JS gzip (≤350 KB) | 660,029 B | 622,972 B | unmet (−37 KB) |
| Chat startup requests (≤20) | 52 / 56 / 56 | 56 / 59 / 56 | unmet |
| CLS (≤0.10) | 0.069 / 0.129 / 0.157 | 0.093 / 0.071 / 0.173 | unmet |
| Idle per 2 min, Chat + Inbox (≤12) | 12 | 12 | met |
| Chat turn viewed elsewhere (≤10) | not measured | not measured | open |

- The startup difference in run 0 is the sidebar health poller firing a second time inside the window. Run 3 is identical (56 = 56).
- `theme-boot.js` adds one script request.

## Source batches

1. **First-frame theme.**
   - Files: `apps/mission-control-next/public/theme-boot.js`, `apps/mission-control-next/index.html`, `apps/mission-control-next/src/theme-boot.test.ts`, `scripts/check-mission-control-next-budgets.mjs`.
   - A ≤1 KB pre-paint script applies the saved theme (or the `?theme=` alias) before paint. An inline style gives the matching canvas.
   - The budget guard allows only this listed pre-paint script and caps its size.
   - The packaged UI server serves it as no-store (`scripts/packaging/runtime/ui-static-server.mjs`, `ui-static-server.cache.test.mjs`).
2. **Work column counts.** `apps/mission-control-next/src/cockpit/areas/work/work-column-status.ts` (with its test) and `WorkBoard`. A refetch keeps the last good count, marked "checking" or "stale"; only a first read says "loading". The `cockpit-refetch` guard is clean.
3. **Lazy OpenUI renderer.** `packages/mission-control-shared/src/components/chat/`:
   - files: `openui-flag.ts`, `LazyOpenUiStructuredBlock.tsx` (with `.test`, `.failure.test` and `.boundary.test`), `AssistantMessageRenderer.tsx`, `OpenUiStructuredBlock.tsx`, `chat-renderer-tail.test.tsx`;
   - the OpenUI parser and component library load only when the flag is on and a block appears;
   - a load or render failure keeps the plain code block, reports once per block, and retries when the streamed source changes;
   - GeneratedArtifactViewer dropped from about 47 KB to 9.4 KB gzip, and OpenUI is a separate 38.5 KB chunk reached only by `import()`.
4. **Native route stylesheet guard.** `scripts/check-mission-control-next-budgets.mjs`.
   - Cause: `native-routes.css` is shared by the native route pages and `NativeTable`, so Rollup emits `native-routes-*.css`. The guard looked for the wrong name; the stylesheet was never missing.
   - The guard now requires the stylesheet in the NativeRoutePages `import()`'s own preload list, and fails if `index.html` references it.

## Commands and results

- Shared chat suite: `pnpm exec vitest run --maxWorkers=2 src/components/chat/` in `packages/mission-control-shared`. PASS, 31 files / 356 tests.
- Packaged cache headers: `node --test scripts/packaging/runtime/ui-static-server.cache.test.mjs`. PASS, 1 test.
- Budget guard on the built dist: `node scripts/check-mission-control-next-budgets.mjs`. PASS. Six disposable-copy cases (pass, legacy name, missing, unreferenced, unrelated import, eager) behave as expected.
- Per batch: Mission Control Next typecheck through the output-lock wrapper, ESLint on owned paths, the ten cockpit design guards and `git diff --check`. All exit 0.

## Measured carries (unmet or not done)

- **T16-S-1, startup dedupe.** The duplicated boot reads (workspaces, citadel, onboarding, control, route-preflight, presence) belong to the shared Chat controller and boot sequence.
- **T16-J-1, JS chunking.** change-plans, cockpit-entry and the contracts/zod chunk dominate the initial JS.
- **T16-C-1, CLS sources.**
- **T16-M-1, elsewhere-turn measurement.**
- **T16-AP-1, run-linked approval discovery.** Measured on synthetic in-memory SQLite (a lower bound). A sparse workspace with a 60k history scans every row (about 3.8 s per run trace). Older links beyond 1,000 workspace rows are missed, but reported honestly as unknown. The fix needs a linkage-indexed storage query with SQLite and Postgres migration parity.
- **P16-RC, raw-colour budget (user decision).** `verify:design:quality` reports 132 against a budget of 92, the same as HEAD.
  - 39 hits come from the opt-in cockpit commit, mostly its palette tokens; 1 comes from the dev testbench.
  - The cockpit intentionally does not load the Classic tokens file, so getting green needs a change to the gate's token-file exemption. That change is left for the user.
- **T16C-1/3, T16G-1 (LOW).** The review notes recorded in the scratch report.

## Not established

- Browser keyboard and focus stress for long lists.
- Ubuntu visual baselines.
- PostgreSQL performance.
- Installed or live-host performance.
- Live-provider turns.
- Release gates.

## Task 16 final accepted slice

Owner: Claude Code root continuation, 2026-10-08. The ledger gains a top-level `task_16_accepted_slice` and a `task_16_recheck` annotation on each of the 30 Task16-owned findings; the parity inventory gains only the top-level summary. All 233 findings and 148 inventory rows keep their original fields, statuses, criteria, ordering and prior evidence. All preceding bytes of this document remain an exact prefix.

- Claimed: GL-46 (OpenUI not loaded on ordinary boot), on source, build-graph and measured transfer-delta evidence; the harness did not record script filenames.
- Partially addressed, criterion unmet: GL-48 (the guard is truthful about pre-paint scripts and native route styles but still measures the entry stub).
- Measured unmet: CH-08 (startup), GL-06 (initial JS), GL-18 (CLS).
- Met but not owned by a listed row: correct first-frame theme; idle stays at 12 per 2 minutes.
- The other 25 Task16 rows are not addressed and carry to Task17 unchanged.

Boundaries: saved Classic and `?shell=classic` rollback remain. Full parity, Classic retirement and release certification remain false.
