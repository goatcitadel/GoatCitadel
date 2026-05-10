# Orchestration & Planning Code Review — 2026-05-10

**Reviewer:** Claude (Opus 4.7 + 5 parallel `code-reviewer` subagents)
**SHA range:** `f3109a04..cd49ccbb` (15 commits on `main`)
**Total LOC reviewed:** ~6,600 across `packages/orchestration` and `apps/gateway/src/{orchestration,services,routes}`

## What was reviewed

Five reviewers ran in parallel, each on an independent slice:

| Slice | Primary files |
|---|---|
| R1 — Core orchestration package | `packages/orchestration/src/{plan-schema,engine,turn-runtime,ownership-matrix,worktree-manager,index}.ts` + tests |
| R2 — Gateway router/engine | `apps/gateway/src/orchestration/{engine,router,types,live-data-detect}.ts`, `policies/*`, `providers/*` + tests |
| R3 — Lifecycle & HTTP routes | `apps/gateway/src/services/orchestration-lifecycle-service.ts`, `apps/gateway/src/routes/orchestration.ts`, `apps/gateway/src/services/orchestration-route-service.ts` + tests |
| R4 — Chat planning integration | `apps/gateway/src/services/{chat-turn-planning-helpers,chat-orchestration-presenters,chat-turn-prep-service}.ts` (planning paths only) + tests |
| R5 — Bounded goal loop (new in `cd49ccbb`) | `apps/gateway/src/services/{chat-goal-command,chat-command-service}.ts` + `chat-command-service.goal.test.ts`, plus touch points in `discord-runtime-service.ts` and `gateway-service.ts` |

## Key commits in range

- `cd49ccbb` — Add bounded goal loop command (new feature, single-commit)
- `9083560f` — Implement Hermes-inspired runtime hardening
- `cb99c130` — Harden orchestration plan validation
- `af81be9f` — Prevent invalid Cowork orchestration dependencies
- `7d7e887f` — Decompose gateway services and tests

---

## Strengths

- **Two-layer plan validation.** Router-side `sanitizeStepDependencies` (`apps/gateway/src/orchestration/router.ts:323`) strips bad edges before the plan leaves the router; engine-side `validateOrchestrationPlan` (`apps/gateway/src/orchestration/engine.ts:114`) re-validates with full DAG cycle check. Sanitization correctly runs **after** `maxSteps` truncation (router.ts:81) so no dangling refs to cut steps reach the engine.
- **Immutability honored.** `packages/orchestration/src/engine.ts` returns new `OrchestrationRun` objects via spread throughout; no in-place mutation anywhere in the file.
- **Hook-patch atomicity.** `approvePhase` calls `host.orchestrationEngine.validate(plan)` **before** `upsertPlan` (`apps/gateway/src/services/orchestration-lifecycle-service.ts:550`); test at `apps/gateway/src/services/orchestration-lifecycle-service.test.ts:400` explicitly asserts no storage write on validation failure.
- **Auth surface uniform.** Every orchestration route uses `withRouteAccess(fastify, "operator")` (`apps/gateway/src/routes/orchestration.ts:17`); `sendRouteError` distinguishes typed `GoatError` from bare `Error` and prevents stack-trace leakage.
- **Cowork dependency hardening (`af81be9f`) is logically correct.** `filterPlannerDependencyIds` enforces (1) no self-reference and (2) strictly earlier stages. Two-layer protection: coerce-time + apply-time.
- **`createRun` / `startRun` revalidate.** `packages/orchestration/src/engine.ts:20-35,49-68` — plans cannot enter execution state without passing schema + conflict checks.
- **`buildPriorOutputHandoffs` applies total character budget.** `apps/gateway/src/orchestration/engine.ts:751` — prevents unbounded context blowup when many steps produce large outputs.
- **Goal loop has explicit clamps.** `maxIterations ∈ [1, 8]` with default 3, `budgetUsd ∈ [$0.01, $100]` with default $3 (`apps/gateway/src/services/chat-goal-command.ts`). `clampInteger`/`clampNumber` handle `NaN`/`Infinity` correctly.
- **Goal loop deduplicates child-session cost.** `seenChildSessions` set prevents double-counting across iterations.

---

## Critical (Must Fix)

### C1. IDOR on orchestration runs — operator can read/approve other operators' runs

- **File:** `apps/gateway/src/routes/orchestration.ts:72-114`; related: `apps/gateway/src/services/orchestration-lifecycle-service.ts:782-785`
- **Issue:** `requireOperatorAuth` confirms the caller is **an** operator but never checks `run.workspaceId` against the authenticated operator's workspace. `getRun` and `listCheckpoints` are pass-through lookups. By enumerating or guessing `runId` values, operator A can read and approve operator B's runs.
- **Why it matters:** Direct cross-tenant data access and unauthorized mutation. Approving another operator's phase triggers `resumeDurableRun` and side effects under their identity.
- **Fix:** Add workspace-scoped ownership check before any run-specific read or mutation. Compose into `withRouteAccess` or a shared `requireRunAccess(operator, runId)` helper that returns 404 (not 403, to avoid leaking existence) when scopes mismatch.

### C2. `"unknown"` verdict silently continues the goal loop

- **File:** `apps/gateway/src/services/chat-goal-command.ts:212-217`
- **Issue:** The loop only exits early on `"pass"` or `"blocked"`. When QA output lacks `GOAL_STATUS: pass|fail` (model hallucination, truncation, instruction non-compliance, formatting drift) the verdict is `"unknown"` and the loop falls through to the next iteration **without verification**. With `--max-iterations 8` this burns 8 delegations unjudged — directly contradicting the "bounded" label.
- **Why it matters:** Cost runaway plus an unbounded retry on bad model output, with no signal to the user.
- **Fix:** Treat `"unknown"` as terminal `blocked`, or cap consecutive `"unknown"` verdicts at 2 and emit a clear iteration record:
  ```typescript
  if (verdict.status === "unknown") {
    consecutiveUnknown += 1;
    if (consecutiveUnknown >= 2) {
      return buildLoopResult(false, objective, "blocked", iterations, totalCostUsd, options, latestOutput);
    }
  }
  ```

---

## Important (Should Fix)

### I1. Unbounded inputs in `plan-schema.ts`

- **File:** `packages/orchestration/src/plan-schema.ts:4,6,27,28`
- **Issue:** `goal`, `planId`, `specPath` use only `.min(1)` — Zod parses 100 MB strings into memory before any size check. `maxIterations`/`maxCostUsd`/`maxRuntimeMinutes` are unbounded numerics that admit `Infinity`, `NaN`, `Number.MAX_SAFE_INTEGER`.
- **Fix:** Add `.max(2048)` on bounded strings, `.finite()` and sane `.max(...)` on numerics. E.g. `z.number().int().positive().finite().max(1000)` for iteration limits.

### I2. Cross-wave `verify` ordering not enforced

- **File:** `packages/orchestration/src/plan-schema.ts:80-90`
- **Issue:** The second `superRefine` loop validates that each `verify` entry names a real `phaseId` but doesn't ensure the referenced phase is in a **preceding** wave. A `verify` entry pointing at the same or a later wave passes validation but is logically incoherent.
- **Fix:** Track which phaseIds belong to each wave. When validating `wave[i].verify`, assert every referenced id is in `waveIds[0..i-1]`.

### I3. `advancePhase` / `approvePhase` skip `validate`

- **File:** `packages/orchestration/src/engine.ts:49,70,93`
- **Issue:** Only `createRun` and `startRun` revalidate. Cross-service callers passing a mutated plan to `advancePhase`/`approvePhase` operate against an unvalidated structure; `findPhase` then throws bare `Error` on missing phases, surfacing internals.
- **Fix:** Add a lightweight identity check (hash of `planId` + wave/phase count) or revalidate at the top of advance/approve. At minimum document the invariant.

### I4. Path traversal in `WorktreeManager`

- **File:** `packages/orchestration/src/worktree-manager.ts:15`
- **Issue:** `worktreeId` is joined via `path.join` into a filesystem path. `execFile` (used downstream) prevents shell injection, but `path.join` does **not** prevent directory traversal — a `worktreeId` of `../../etc/something` resolves to arbitrary paths outside `worktreesRoot`.
- **Fix:** After constructing `worktreePath`, assert `worktreePath.startsWith(path.resolve(this.options.worktreesRoot) + path.sep)` before passing to `execFile`.

### I5. `buildParallelHint` uses wrong index for stage-local lookup

- **File:** `apps/gateway/src/orchestration/engine.ts:403-419`
- **Issue:** `const angleIndex = stagePeers.findIndex((step) => step.stepId === plan.steps[stepIndex]?.stepId);` — `stepIndex` is the position in flattened `completedSteps`, **not** the position in the current stage. Beyond stage 1 this looks up the wrong step and produces wrong diversity angles for parallel researchers.
- **Fix:** Use `input.step.stepId` directly:
  ```typescript
  const angleIndex = stagePeers.findIndex((peer) => peer.stepId === input.step.stepId);
  ```

### I6. `stages` ternary in `buildStepPlans` is template-specific

- **File:** `apps/gateway/src/orchestration/router.ts:279-281`
- **Issue:**
  ```typescript
  const stages = roles.map((role, index) =>
    parallelStages && role === "researcher" ? 1 : parallelStages && index > 1 ? index : index + 1,
  );
  ```
  Only correct for the canonical `[researcher, researcher, critic, synthesizer]` template. A new template with a non-researcher at index 1 or a third researcher at index 2 will silently get wrong stage numbers.
- **Fix:** Replace with an explicit per-role stage map keyed on workflow template.

### I7. `getMissingHandoffFailure` doesn't honor `dependsOnStepIds`

- **File:** `apps/gateway/src/orchestration/engine.ts:154-173`
- **Issue:** Fires for **any** reviewer/critic/synthesizer/qa-validator if `priorSteps` lacks completed output — regardless of declared deps. Blocks structurally-independent steps; conversely allows a step through if any unrelated prior step happens to have output.
- **Fix:** Restrict the check to `step.dependsOnStepIds`:
  ```typescript
  const declared = step.dependsOnStepIds ?? [];
  const hasDep = declared.length === 0
    ? priorSteps.some(s => s.status === "completed" && s.output?.trim())
    : declared.every(id => {
        const dep = priorSteps.find(s => s.stepId === id);
        return dep?.status === "completed" && dep.output?.trim();
      });
  ```

### I8. Concurrent double-approval race

- **File:** `apps/gateway/src/services/orchestration-lifecycle-service.ts:516-518`
- **Issue:** Guard checks `run.status !== "paused"`. Two concurrent POSTs to `/phases/:phaseId/approve` both read `paused`, both pass the guard, both call `resumeDurableRun` + `requestDurableRunProcessing`. Phase may be processed twice depending on worker dedup.
- **Fix:** Compare-and-swap update (e.g., `updateRun` succeeds only when current status is still `paused`) or an optimistic version/ETag — second concurrent call returns 409. No test covers this; add one.

### I9. `runOrchestrationPlan` does not re-validate stored plan

- **File:** `apps/gateway/src/services/orchestration-lifecycle-service.ts:433-438`
- **Issue:** `host.storage.orchestration.getPlan(planId)` returns a plan that bypasses `planSchema.safeParse`. Plans written by older code paths or via direct storage execute unvalidated. `runBeforeHook` patches (lines 464-473) are also not revalidated.
- **Fix:** Call `host.orchestrationEngine.validate(plan)` after loading from storage and again after applying any `runBeforeHook` patch.

### I10. `approvePhase` returns 200, should be 202

- **File:** `apps/gateway/src/routes/orchestration.ts:86`
- **Issue:** Approval is asynchronous — service records resume intent and durable worker advances the phase. 200 implies completion.
- **Fix:** Return 202 Accepted with a body describing the resume intent.

### I11. `filterPlannerDependencyIds` empty-array silently drops template deps

- **File:** `apps/gateway/src/services/chat-turn-planning-helpers.ts:474-491`
- **Issue:** When planner emits `dependsOnStepIds: []`:
  1. `Array.isArray([])` → true → `filterPlannerDependencyIds` runs
  2. All candidates filtered out → returns `[]`
  3. Line 491: `dependsOnStepIds?.length ? dependsOnStepIds : undefined` → `undefined`
  
  The template's original `dependsOnStepIds: ["step-1"]` is then overwritten with `undefined` in `applyExecutionPlanDraftToOrchestrationPlan`. Sequencing constraint is silently lost.
- **Fix:** Fall back to `templateStep.dependsOnStepIds` when the filter returns empty:
  ```typescript
  const dependsOnStepIds = (() => {
    if (controlStep || !Array.isArray(raw?.dependsOnStepIds)) {
      return templateStep.dependsOnStepIds;
    }
    const filtered = filterPlannerDependencyIds(raw.dependsOnStepIds, templatePlan, templateStep);
    return filtered.length > 0 ? filtered : templateStep.dependsOnStepIds;
  })();
  ```

### I12. Specialist auto-routing — workspace scope is implicit

- **File:** `apps/gateway/src/services/chat-turn-prep-service.ts:375-437`
- **Issue:** `applyApprovedSpecialistsToPlan` trusts `listAutoRoutable(sessionId)` to return workspace-scoped candidates. No explicit guard in the filtering loop; no TTL on stale approvals. If the underlying store doesn't enforce workspace isolation at the query layer, cross-workspace candidates can apply.
- **Fix:** Add an explicit `workspaceId` assertion in the loop and document the contract on `listAutoRoutable`. Add a test asserting cross-session candidates don't leak.

### I13. Goal loop budget check fires before cost accumulation

- **File:** `apps/gateway/src/services/chat-goal-command.ts:142-145, 195-196`
- **Issue:** Budget guard at loop entry, before `totalCostUsd` is updated for that iteration. Loop always executes at least one full iteration regardless of cost and can overshoot the cap by up to one iteration's cost. Budget $0.50, iteration 1 = $0.45, entry check passes, iteration 2 = $0.45, total $0.90 ≈ 2× cap.
- **Fix:** Add a post-accumulation check immediately after `totalCostUsd += iterationCostUsd` (line 196). If `totalCostUsd >= options.budgetUsd` and not `"pass"`, return `budget_cap` before the next iteration begins.

### I14. No wall-clock timeout on `runChatDelegation`

- **File:** `apps/gateway/src/services/chat-goal-command.ts:150`
- **Issue:** No `Promise.race` or `AbortSignal`. A hung delegation (network hang, rate-limit backoff, downstream outage) holds the loop open indefinitely. Iteration cap is a call-count bound, not a time bound.
- **Fix:**
  ```typescript
  const ITERATION_TIMEOUT_MS = 5 * 60 * 1000;
  const delegationPromise = deps.runChatDelegation(sessionId, payload);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Goal-loop iteration timeout")), ITERATION_TIMEOUT_MS),
  );
  response = await Promise.race([delegationPromise, timeoutPromise]);
  ```

### I15. No concurrency guard for parallel `/goal` invocations

- **File:** `apps/gateway/src/services/chat-goal-command.ts` (entire `runGoalLoop`)
- **Issue:** No session-level lock. Two `/goal X` invocations on the same session (easy on Discord with slash-command retries) run independently, doubling budget consumption and writing conflicting goal memory records.
- **Fix:** Maintain an in-memory `Set<string>` of sessionIds with active loops at the service level. Reject new invocations if the session is already running. Clear on completion or error (use `try`/`finally`).

### I16. `/goal resume` uses default options, not original

- **File:** `apps/gateway/src/services/chat-goal-command.ts:101-119`
- **Issue:** Original `--max-iterations` and `--budget-usd` are not persisted in the goal memory item. A user-constrained `--max-iterations 1 --budget-usd 0.50` loop resumes as 3 iterations / $3.
- **Fix:** Serialize the options into the memory item (metadata field or structured content), accept the same flags on `resume`, or document the behavior prominently. (a) is preferred.

---

## Minor (Nice to Have)

| # | File | Issue |
|---|---|---|
| M1 | `apps/gateway/src/orchestration/live-data-detect.ts:4` | `LIVE_DATA_KEYWORD_REGEX` missing `/i` flag; "Latest"/"Today" escape detection while all five other regexes are case-insensitive. |
| M2 | `apps/gateway/src/orchestration/engine.ts:638` | `tryRepairFinalSynthesis` silently swallows repair errors (`catch { return undefined; }`). Add an `integritySignals` entry like `"orchestration_final_synthesis_repair_failed"`. |
| M3 | `packages/orchestration/src/index.ts:3` | `worktree-manager` is re-exported from the package public surface. Infrastructure concern; widens API unnecessarily. Move to a sub-module or mark internal. |
| M4 | `apps/gateway/src/services/chat-orchestration-presenters.ts` vs `chat-turn-helpers.ts` | Duplicate implementations of `renderExecutionPlanAsMarkdown` and `buildDelegationFailureGuidance`. Drift risk — consolidate via re-export or delete the unused copy. |
| M5 | `apps/gateway/src/routes/orchestration.ts:76` | `approvedBy` accepts unbounded `z.string().min(1)`. Add `.max(128)`. |
| M6 | `apps/gateway/src/routes/orchestration.ts:63` | `planId` cast `(request.params as { planId: string }).planId` without Zod validation. Empty/missing produces opaque storage error instead of 400. |
| M7 | `apps/gateway/src/services/chat-goal-command.ts:262` | `args.length === 1` guard on pause/resume. `/goal pause extra-word` silently runs as a new goal command. |
| M8 | `apps/gateway/src/services/chat-goal-command.ts:108-119` | `resume` calls `updateChatSessionLearnedMemory(..., { status: "active" })` then `extractAndPersistLearnedMemory`, which may create a duplicate goal memory entry for the same objective. |
| M9 | `packages/orchestration/src/engine.test.ts:264-303` | Only `maxIterations` is tested. No coverage for `maxCostUsd` / `maxRuntimeMinutes` stop paths. `runtimeMinutes` uses `Date.parse` which silently returns `NaN` for invalid `startedAt` — an untested failure mode. |
| M10 | `packages/orchestration/src/ownership-matrix.test.ts` | Only one positive-conflict test case. No test for same-agent overlapping paths, non-overlapping paths from different agents, or empty ownership. |
| M11 | `apps/gateway/src/orchestration/router.test.ts` | No test verifying that `policy.maxSteps` truncation + `sanitizeStepDependencies` interaction removes dangling refs to truncated steps. |
| M12 | `apps/gateway/src/services/chat-command-service.goal.test.ts` | Missing tests for: `"unknown"` verdict path (C2), budget exhaustion (I13), `"blocked"` via delegation throw, original-options preservation on resume (I16). |

---

## Recommended Fix Order

1. **Block on Critical (single PR):** C1 (workspace scoping) + C2 (unknown-verdict). Both small diffs, high blast radius.
2. **Plan-schema hardening completion (single PR):** I1 + I2 + I4. Three localized edits in `plan-schema.ts` and `worktree-manager.ts`.
3. **Concurrency safety (single PR):** I8 (CAS on approval) + I15 (goal-loop in-flight registry) + I14 (wall-clock timeout).
4. **Correctness fixes (single PR):** I5 + I6 + I7 (router/engine indexing + handoff check) + I11 (planner empty-deps fallback) + I9 (stored-plan re-validation) + I3 (advance/approve invariant).
5. **UX (single PR):** I10 (202 status) + I13 (budget post-check) + I16 (persist resume options) + I12 (workspace contract on `listAutoRoutable`).
6. **Minors sweep:** All M1–M12 in one PR.

---

## Assessment

**Not ready to merge as a whole.**

Aggregate: **2 Critical, 16 Important, 12 Minor.**

The orchestration hardening commits (`cb99c130`, `af81be9f`) are directionally correct but incomplete — the package-level plan-schema needs upper bounds and cross-wave verify ordering, and the route-level needs workspace scoping. The new goal loop ships with structurally weak bounds (unknown-verdict passthrough, no wall-clock timeout, soft budget cap) that contradict the "bounded" label. Most fixes are localized and could land in five small follow-up PRs before this surface is exposed to multi-user or hostile traffic.
