# Reliability + Perf Sweep — Results

Branch: `feature/reliability-perf-sweep`
Plan: `docs/superpowers/plans/2026-05-15-reliability-perf-sweep.md`
Baseline: `2026-05-15-reliability-perf-sweep.baseline.json` (437 files / 2720 tests / 0 failures)
Cold-start: `2026-05-15-reliability-perf-sweep.after.json`

## Audit findings

**Already correct, regression-tested:**
- Parallel scheduler fanout in chat-proactive-service (Task 1)
- Per-session busy skip (Task 2)
- Malformed JSONL row tolerance in transcript-log + audit-log (Task 3 — kept transcript test, extended existing audit-log test)
- Content-hash conversation summary cache (no stale read possible)
- Deferred sidecar init

**Upstream features not present in GoatCitadel (skipped):**
- HEARTBEAT.md, streamWithIdleTimeout, heartbeat.session pinning, commitment-only dispatch
- AJV (Zod used), node-canvas, sandbox registry, HTTP/2 fallback, APNG normalization, Gemini thought-signature replay

**Fixed:**
- Task 4: Cron malformed-row tolerance + stale nextRunAt repair + structured warning logs
- Task 5: Doctor cron-row repair check + --fix prune (shared validator extracted to `cron-row-validation.ts`)
- Task 6: Model catalog 60s TTL cache + stampede protection + error_fallback exclusion
- Task 7: Phased shutdown wait budgets (5s pre-close + 10s force-exit)
- Task 8: SSE streaming delta coalesce (whitelist includes bare `delta` for production)
- Task 9: mtime-cached config loader

**Deferred:** Task 10 (durable run archive TTL knob) — optional / low impact.

## Cold-start measurements

| Run | importMs | buildMs | elapsedMs | rssMb | heapMb |
|-----|---------:|--------:|----------:|------:|-------:|
| 1   | 1143.70 | 6133.02 | 7497.10 | 146.98 | 57.85 |
| 2   | 1930.14 |  465.04 | 2625.40 | 141.39 | 57.78 |
| 3   | 1902.73 |  452.49 | 2601.65 | 141.00 | 57.78 |

Median (run 2): import 1902.73 ms · buildApp 465.04 ms · elapsed **2625.40 ms** · RSS 141.39 MB · heap 57.78 MB.

Run 1 is much slower (7.5 s) because the gateway materializes config files from examples and warms first-run sqlite schemas on the very first invocation; runs 2/3 reuse those artifacts and are stable at ~2.6 s.

No pre-plan baseline was captured for cold-start; only post-plan numbers are available. (Baseline JSON only logged the vitest counts.)

## Test deltas

| | Files | Tests | Failures |
|---|---:|---:|---:|
| Baseline (`baseline.json`) | 437 | 2720 | 0 |
| Post-plan (`vitest run`)   | 444 | 2753 | 1 |

Net additions across the plan: **+7 files / +33 tests** (the regression locks added in Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9 plus the new shared cron-validator unit tests).

Post-plan failure: `src/services/skill-import-service.loop41.test.ts` — pre-existing flaky test under parallel load (passes in isolation); unrelated to this plan. The second known flaky `llama-cpp-runtime-service.test.ts` did not fire this run but remains in the same category.

## Repo-wide checks

- `pnpm -r typecheck`: PASS (exit 0).
- `pnpm -r build`: PASS (see commit log; final tsc -b on gateway clean before this verification).

## Commits in this branch (since baseline d8a04a07)

```
97689f6d perf(config): mtime-keyed cache for loadGatewayConfig
9ad0f2fd perf(chat-sse): coalesce assistant/thinking deltas inside short window
38c90fb7 feat(shutdown): phased pre-close + force-exit wait budgets
6f4534d6 perf(llm): TTL cache for model catalog discovery
8866fe5c feat(doctor): flag and --fix prune malformed cron rows
1bac0cb2 fix(cron): tolerate malformed rows and repair stale nextRunAt on load
bcd1c869 test: sharpen malformed-row tolerance lock in transcript log
d20a5d12 test: lock per-session busy scope in scheduler tick
78af45d9 test: lock parallel fanout in proactive scheduler
```

## Known caveats / follow-ups

1. **SSE coalescing eventId/sequence preservation.** The new coalescer keeps only the LAST event's metadata in a coalesce group. Safe today; future SSE Last-Event-ID resume features may need to disable for resumable streams.
2. **Config mtime cache content-hash gap.** Atomic rename / restore-with-preserved-mtime could yield a false cache hit. Acceptable; worth a doc note in `config.ts`.
3. **Model catalog cache invalidation granularity.** `updateRuntimeConfig` clears the entire cache; could be narrowed to per-provider on a future refactor.
4. **No pre-plan cold-start baseline.** Capture cold-start before future perf sweeps so deltas are reportable.
5. **Pre-existing flaky tests** (`skill-import-service.loop41.test.ts`, `llama-cpp-runtime-service.test.ts`) still fail intermittently under parallel load and should be stabilised independently.
