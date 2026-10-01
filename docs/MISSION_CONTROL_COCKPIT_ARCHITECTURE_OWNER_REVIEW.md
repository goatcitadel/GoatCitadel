# Cockpit architecture owner review

Date: 2026-09-30. Status: independently reviewed extractions and inherited setup registrations applied. This record preserves their original measurements and test results. The source reconciliation below ran no build, metric gate, tests or browser journey; subsequent runtime changes require their own final-source verification.

## Current source reconciliation

A source reread confirms that the reviewed owners still exist with these physical line counts: `gateway-service.ts` 13,128; `orchestration-lifecycle-service.ts` 3,095; child service/state 245/136; phase harvest/output 59/89; runtime llama setup change 132; and llama setup selection/service 132/186. These are source counts, not a rerun of dependency, callback or route-port metrics. The three Phase 0d registrations remain capped at 7/6, 5/0 and 11/0 dependencies/callbacks, and the two inherited llama setup registrations at 5/0 and 11/0. This documentation pass changes no registration or baseline.

The companion [extraction and Quality audit](MISSION_CONTROL_COCKPIT_EXTRACTION_QUALITY_AUDIT.md) now records the current bounded UI composition: the shared Chat host is 673 lines, Providers 624, Settings route owner 336, shared Code workbench 796 and classic Quality 755. Document inspection directly uses the existing document leaf; background settlement has its own shared hook. Quality shares clipboard and guarded first-import lifecycle across presentations. Explicit shell handoffs reuse one React root in both directions so application-session draft and mutation-lock owners survive. These implemented source boundaries do not establish browser parity, worker admission, provider execution or installed-app readiness.

## Historical architecture gate and extraction measurements

The named `pnpm verify:architecture:metrics` run for this extraction checkpoint passed its single scenario with zero failures at `artifacts/verification/2026-09-30T15-45-56-472Z-architecture-metrics-cf0fcc49`. Its manifest records GatewayService at 13,128/13,132 lines and the route port at 184/187 members. The review preserved the pinned baseline, inventory/hash and every original allowance entry. This historical guard proves the measured snapshot and reviewed registrations; it is not a current or final-source gate for later changes and does not mean the remaining large Gateway services have all been decomposed.

The earlier named `pnpm verify:architecture:metrics` run at
`artifacts/verification/2026-09-30T14-56-12-631Z-architecture-metrics-c3e401cb`
reported 13 remaining regressions. The preceding Gateway extraction brought GatewayService to its original 13,132-line limit, Chat route composition to 138/141 dependency accesses, and approval-refusal reconciliation to 9/9.

The following existing-owner reuse changes then removed duplicate owner bindings. Raw dependency counts remain visible; no method was moved behind an unmeasured callback, cast, or reflection API.

| Existing owner | Before | At extraction checkpoint | Original limit | Responsibility preserved |
| --- | ---: | ---: | ---: | --- |
| `chat-autonomous-turn-service.ts` | 93 | 89 | 91 | Capture the two admission repositories once for completeness checks and transaction wiring; preserve admission/profile checks. |
| `chat-route-resolution.ts` | 30 | 25 | 25 | Reuse the LLM owner, preserve bound catalog receiver, invoke optional turn/model readers with their original receiver. |
| `gateway-route-composition-runtime.ts` | 108 | 97 | 104 | Share the readonly backup owner across admin operations and dashboard; compose the existing setup service at the root. |
| `llama-cpp-route-service.ts` | 15 | 5 | 12 | Bind the runtime and setup owners once; retain lifecycle publication after successful owner actions. |
| `orchestration-worktree-service.ts` | 36 | 28 | 30 | Reuse the lease repository within release and orphan scan; keep generation/owner tokens, dirty retention, and cleanup guards. |

These are historical source measurements, not proof of a running provider, worker or installed app. At that checkpoint new autonomous admission remained paused; legacy skipped tests were not enabled by inventing authority. This structural review makes no current worker-availability claim.

The intermediate named gate at `artifacts/verification/2026-09-30T15-04-15-723Z-architecture-metrics-c9c17584` confirmed all five reductions and reported eight remaining failures at that time: route-port members (190/187), lifecycle host callbacks (105/82), delegation dependencies (175/156), the two unregistered setup owners below, lifecycle dependencies (150/126), phase-execution dependencies (10/5), and runtime-configuration adapter dependencies (22/11).

Focused verification covered 77 distinct passing tests across nine files, with 20 existing autonomous tests skipped. The initial seven-file run had 69 passes and two new test assertion failures: the real lease repository calls its own `get` while claiming, so its receiver spy correctly recorded three reads. The assertions now check every receiver without imposing a false one-read contract; the affected worktree file plus both unchanged setup-owner suites then passed 17/17. Scoped ESLint and `git diff --check` passed. No build/typecheck, host runtime start, worker admission, or installed-app validation was run for this slice.

## llama.cpp setup registration review

### Origin and inventory

Commit `26cedae10ab242ed71a45f0da8f8ba22d2bd8d94` (2026-09-27), **feat: guide llama.cpp setup through Settings**, introduced both setup owners and `docs/LLAMA_CPP_SETUP.md`. That document specifies the operator workflow and existing endpoint/Change Plan boundaries. No separate implementation phase identifier was found in that originating commit's documentation.

Both files are absent from the pinned `existingServicePaths` inventory at `41d0f2e52910c60c39fa0b788042638eddf302e5` and from the original metric map. Before this review they had no new-owner entry. Their effective zero limit represented missing new-owner registration, not growth of a registered zero-access owner. The original inventory, baseline hash, and existing-owner limits remain unchanged.

| Reviewed owner | Lines at review | Raw dependencies at review | Raw host callbacks at review | Actual responsibility |
| --- | ---: | ---: | ---: | --- |
| `apps/gateway/src/services/llama-cpp-setup-selection-service.ts` | 132 | 5 | 0 | Discover a managed model/executable through existing owners, retain opaque selection custody, validate workspace/expiry/files on resolve, discard through custody. |
| `apps/gateway/src/services/llama-cpp-setup-service.ts` | 186 | 11 | 0 | Compose settings/runtime/catalog/Change Plan projections and explicitly requested normal Chat diagnostics through existing owners. |

The selection owner's five accesses are model discovery, install discovery, and custody set/get/delete. The setup owner's eleven accesses include three settings reads, three runtime inspection methods, one model preview, one plan list, one selection stage, one Chat session creation, and one Chat send. These are real dependencies; renaming or relocating them solely to suppress the counts is not a correction.

### Independent review and registration applied

The parent implementation agent reviewed actual stage/resolve custody, setup projections and normal scoped Chat diagnostics and found no authority widening. Exactly these two entries are registered under `llama-cpp-setup:settings-owner` at 5/0 and 11/0. The validator binds that step to these exact paths, rejects misleading Phase 3/Phase 0d/C0 labels for them, and retains existing-path, duplicate, pinned hash/inventory and cap-exhaustion protection. This registration cannot make unrelated existing-owner regressions acceptable.

Existing tests for that review:

- `llama-cpp-setup-selection-service.test.ts`: host-path redaction, exact workspace, changed-file rejection, missing custody after discard, plus fresh elapsed-TTL proof accepting the last valid millisecond and rejecting the exact 30-minute boundary and afterward.
- `llama-cpp-setup-service.test.ts`: completed-plan projection, hidden scoped Chat route, manual tool autonomy with web/memory/delegation off, completion failures, changed-settings staleness, and missing-route errors.
- `llama-cpp-setup.integration.test.ts`: separately gated task-owned real-server diagnostic. Its presence is not fresh execution proof; this review does not start a host runtime or claim this integration passed.

## Orchestration lifecycle responsibility seams (initial analysis)

Before this extraction, the lifecycle owner was 3,391 lines, 105 host callbacks against 82, and 150 dependency accesses against 126. It needed a coherent ownership review rather than superficial count reduction.

The initial analysis identified `OrchestrationPhaseChildWakeHost` and the child wake/reconciliation block at then-lines 1855-1987. It read canonical parent/child/watcher/trace state and invoked the existing wake owner. The extraction requirements were exact parent waiting state and child correlation, current-phase breadcrumb, watcher source, terminal/user-input settlement distinctions, and the scan's continue-then-AggregateError behavior. Approval-waiting children must remain unsettled. These historical line references are not current edit locations; the applied owners are described below.

A second initial seam was child recovery/harvest at then-lines 2173-2300, breadcrumb parsing at 2748 and fallback harvest at 3021. Its requirements were no redispatch of a previously dispatched child, truthful failure on missing child linkage, canonical Chat output/cost, re-parking live children and retaining breadcrumbs until phase advancement commits. The implemented typed recovery decision returns to the lifecycle, whose `recordUpdate` owner retains the fresh durable lease/worktree fence and transaction boundary.

Existing lifecycle tests cover completed-child harvest, interrupted in-flight harvest, live-child reattachment, canonical output/cost, retained breadcrumbs after interruption, exact wake bindings, and re-parking.

### Child extraction independently reviewed and applied

The subsequent bounded patch moves canonical child wake/reconciliation and the read/harvest decision to `orchestration-phase-child-service.ts` (245 lines). Pure breadcrumb parsing, fallback output projection, and the shared wake event key live in `orchestration-phase-child-state.ts` (136 lines). The lifecycle keeps fresh lease/worktree fencing, transactions, `recordUpdate`, missing-child failure commits, child dispatch, and all subsequent phase advancement. Existing public lifecycle exports are re-exported for caller continuity.

| Owner | Dependencies before → after | Host callbacks before → after |
| --- | ---: | ---: |
| Existing lifecycle | 150 → 124 (limit 126) | 105 → 80 (limit 82) |
| New child service | 0 → 7 | 0 → 6 |
| New pure child state | 0 → 0 | 0 → 0 |

The child service's real seven accesses are the existing harvest owner, waiting-run listing, watcher lookup, trace read, orchestration run read, durable run read, and wake command. Six retain the historical typed-host classification. The extraction itself transferred those accesses unchanged. The lifecycle additionally captures the actual orchestration repository once within each affected operation and the durable-run repository once for the recovery scan. It retains fresh reads, method receivers, transaction callbacks, CAS parameters, and the storage-keyed recovery throttle; it does not cache canonical record values. Removing those repeated owner bindings brought the measured combined dependency/host totals to 131/86. The lifecycle measured 3,095 lines and was within its original dependency and callback limits at the recorded gate; its current physical count remains 3,095.

After the extraction alone, the unchanged lifecycle, phase-execution, and durable-child-watcher test files passed **98 tests with 4 existing skips**. After repository reuse and focused receiver/CAS assertions, the final four-file run passed **170 tests with 4 existing skips**, including `orchestration-lifecycle-service.loop43.test.ts`. This covers exact correlation/watchers, approval waits remaining unsettled, continuation after one failed scan read, canonical harvest, no redispatch, missing linkage, re-parking, preserved transaction fences, recovery paging/crash restart, and no successful approval checkpoint or resume after a lost state race. Scoped ESLint passed. This slice has not run a build or typecheck.

The parent implementation agent independently reviewed the child service/state and the caller integration through recovery and repository reuse, confirming that transaction writes remain with the lifecycle and method receivers are preserved. The exact child responsibility was approved under the authorized Phase 0d extraction scope. Its new entry has these bounds:

```json
{
  "path": "apps/gateway/src/services/orchestration-phase-child-service.ts",
  "planStep": "mission-control-cockpit:phase-0d",
  "maxHostCallbacks": 6,
  "maxDependencyMemberAccesses": 7,
  "reason": "Extract canonical orchestration child wake and recovery decisions while retaining lifecycle transaction, lease, dispatch, and phase-advance owners.",
  "evidence": "docs/MISSION_CONTROL_COCKPIT_ARCHITECTURE_OWNER_REVIEW.md; lifecycle + loop43 + phase-execution + durable-child-watcher focused suites: 170 passed, 4 existing skipped on 2026-09-30."
}
```

At this checkpoint the validator admitted the exact additional step `mission-control-cockpit:phase-0d`, preserving its C0-C6 and Inbox Phase 3 entries. All **11 allowance tests passed**, including explicit neighboring/misspelled-step rejection, existing-owner rejection (including zero-access inventory members), preservation of every previous cap, and failure at one access or callback above the child's cap. A separate comparison against the checkout's HEAD confirmed the pinned baseline hash, inventory commit, complete inventory and every original allowance entry remained unchanged at that checkpoint. No new entry was necessary for the pure zero-access helper. The later named architecture checkpoint passed as recorded above.

### Delegation repository reuse applied

With separate ownership approval, this extraction changed `runChatDelegation` to bind its actual `chatDelegationSteps` repository once immediately before the first step read. Its 31 existing calls retained their original times and receiver. No records were cached, and dispatch generation, fresh database clocks, frozen scope/profile authority, transaction callbacks, lease binding and response/error CAS inputs were unchanged by this extraction. Measured raw dependency accesses decreased from **175 to 145** against the original **156** cap, with no new IO owner or allowance. This measurement does not cover subsequent local-delegation admission changes.

The four delegation suites (`loop20-worker-a`, `budget`, `subagent-task`, and `explorer-profile`) passed **99 tests**. The atomic replacement-winner regression additionally checks repository receivers across creation, current reads, clock reads, child linkage and response CAS. Existing tests cover rollback, concurrent/duplicate wake, stale owner replacement, waiting projections, and no post-race deliverable or learned-memory effects. Scoped ESLint and diff checks passed; no build/typecheck or live worker admission was performed.

## Remaining extractions applied at the recorded checkpoint

- **Route port:** the root constructs the existing `LlamaCppSetupService` once after the evolution control-plane owner, before route services. A lazy route-port getter preserves the earlier route-port construction order. It replaces four setup-only facade members (`getSettings`, `agentSendChatMessage`, `llamaCppSetupSelection`, and `evolutionControlPlaneService`) with one named owner. The recorded checker reported 184 members against 187; its regex also counts multiline function parameters, so this exceeded the conceptual three-member reduction. Runtime route composition measured 97 accesses against 104 after that change. The existing pure durable-config normalization moved to `config-sync-lib.ts`; Gateway measured 13,128 lines against 13,132 without compressed formatting or moved IO.
- **Phase execution:** canonical child harvest now lives in `orchestration-phase-harvest-service.ts` (59 lines, 5 dependencies/0 callbacks), while shared pure settled-child projections live in `orchestration-phase-output.ts` (89 lines, 0/0). The existing execution owner returns to 5 dependencies against 5. Optional-reader behavior, original receivers and requested IDs, approval/user-input distinction, canonical cost completeness and the public `harvest` method are preserved. Dispatch and spec-path validation stay in execution; lifecycle owns mutations.
- **Runtime configuration:** `runtime-llama-setup-change.ts` (132 lines, 11 dependencies/0 callbacks) owns existing selection validation, fresh catalog verification, runtime settings CAS, owned/healthy runtime check, subsequent Chat-default CAS, discard and pure observation projections. The adapter returns to 11 accesses against 11 and retains approval/revision/auth-custody checks. The ordered writes and failure truth are unchanged: the Chat default is retained if runtime verification fails, while the earlier runtime setting write may have committed. No atomic all-or-nothing setup or replay-from-observation claim is made.

The parent implementation agent independently reviewed both helpers, shared output, execution/adapter caller diffs, root initialization and lazy route-port integration before approving the exact Phase 0d caps 5/0 and 11/0. The validator binds Phase 0d to the three reviewed extraction paths; other paths, misleading plan steps, existing-owner aliases and cap exhaustion are rejected. Explicit narrow dependency interfaces keep every real access visible to the local metric reader; opaque imported `Pick` types were replaced before admission when the checker could not resolve them. The two new pure helpers need no IO allowance.

The closing focused verification for this extraction checkpoint passed **142 tests with 4 existing skips across nine files**: phase execution, lifecycle, runtime configuration adapter, both setup owners, runtime composition, lazy route port, config synchronization and feature flags. Added assertions cover exact canonical read IDs/receivers/cost, ordered revisions 7→8→9 and callback receivers, elapsed selection expiry, lazy initialization and pure config immutability. All **14 allowance tests passed** after those registrations. Scoped ESLint and diff checks passed after removing a trailing blank line and correcting one test-only `prefer-const` finding. No build/typecheck or host/provider execution was performed by this extraction slice; parent integrated build/browser checkpoints are separate evidence.
