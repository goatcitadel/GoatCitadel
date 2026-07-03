# Agentic Orchestration Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the round-3 fast-loop + fan-out package from `docs/superpowers/specs/2026-07-03-agentic-orchestration-round3-design.md`: parallel read-only tool execution, planner fast path, stream idle watchdog, ask-anchored compaction, and planner-declared fan-out.

**Architecture:** Five independent, individually kill-switched changes riding existing seams in the gateway turn pipeline (`apps/gateway/src/services` + `src/orchestration`). No new packages, no schema/storage migrations, no contract-breaking changes. Each task = failing test → minimal implementation → green → commit.

**Tech Stack:** TypeScript (Node 24), vitest 4 (`pnpm exec vitest run <file>` from `apps/gateway`), pnpm monorepo. Worktree: `F:/code/pa-round3`, branch `feat/agentic-round3`.

## Global Constraints

- Feature-flag convention: on-by-default behavior gets `<name>V1Disabled?: boolean` in `GatewayFeatureConfig` (`apps/gateway/src/config.ts:63-90`), env mapping `GOATCITADEL_FEATURE_<SNAKE>_V1_DISABLED` in the pair list (`config.ts:665-690`), default `?? false` in the features resolution block (near `config.ts:1205`).
- The orchestrator reads flags the same way `orchestrationFinalStreamingV1Disabled` is read — find the existing accessor (`isFeatureEnabled` on the host/deps) and reuse it; do not invent a new plumbing path.
- DO NOT REGRESS (assert via existing suites): S1 terminal streaming, degraded-status honesty, answer-recovery ladder, prompt-cache stable/volatile split, deny-wins policy inline on the tool path.
- Immutability: new helpers return new objects; no in-place mutation of shared records.
- Every new file ≤ ~400 lines; extract helpers instead of growing `chat-agent-orchestrator.ts` (12k lines) — new logic lives in new focused modules the orchestrator imports.
- Commit format: `<type>: <description>` (repo convention, no attribution footer). Husky pre-commit runs — never `--no-verify`.
- Empty `catch {}` blocks need a rationale comment (repo lint gate).
- Run only focused vitest files during TDD; full gateway suite + typecheck at the end (Task 6).

---

### Task 1: Ask-anchored compaction (R3-5)

**Files:**
- Modify: `apps/gateway/src/services/chat-compaction.ts` (function `buildConversationCompactionSummary`, lines 7-50)
- Test: `apps/gateway/src/services/chat-compaction.test.ts` (exists — extend; if absent, create alongside)

**Interfaces:**
- Consumes: `ChatMessageRecord[]` (existing signature — unchanged).
- Produces: same `string | undefined` return; output now begins with `Original ask:` / `Latest ask:` sections when user messages exist. No caller changes.

- [ ] **Step 1: Write failing tests** — in the test file, add cases:

```ts
describe("buildConversationCompactionSummary ask anchoring", () => {
  it("pins the original and latest user ask ahead of the digest", () => {
    const messages = [
      msg("user", "Build me a churn dashboard for Q3 with cohort splits"),
      msg("assistant", "Working on it. I decided to use the metrics API."),
      msg("user", "Actually also add a retention heatmap"),
      msg("assistant", "There was an error calling the metrics API."),
    ];
    const summary = buildConversationCompactionSummary(messages)!;
    const originalIdx = summary.indexOf("Original ask:");
    const latestIdx = summary.indexOf("Latest ask:");
    expect(originalIdx).toBeGreaterThanOrEqual(0);
    expect(latestIdx).toBeGreaterThan(originalIdx);
    expect(summary).toContain("churn dashboard");
    expect(summary).toContain("retention heatmap");
    // asks come before the digest sections
    expect(latestIdx).toBeLessThan(summary.indexOf("Decisions and constraints:"));
  });
  it("emits a single ask section when there is only one user message", () => {
    const summary = buildConversationCompactionSummary([msg("user", "Summarize the repo"), msg("assistant", "ok")])!;
    expect(summary).toContain("Original ask:");
    expect(summary).not.toContain("Latest ask:");
  });
  it("still works with no user messages", () => {
    const summary = buildConversationCompactionSummary([msg("assistant", "standalone note")]);
    expect(summary).toBeDefined();
    expect(summary).not.toContain("Original ask:");
  });
});
```

Use the file's existing `msg`/fixture helper if present; otherwise `const msg = (role: string, content: string) => ({ role, content } as ChatMessageRecord)` matching existing test idiom.

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run src/services/chat-compaction.test.ts` → new cases FAIL (no "Original ask:" in output).
- [ ] **Step 3: Implement** — in `buildConversationCompactionSummary`, after `normalized` is built:

```ts
const userAsks = normalized.filter((message) => message.role === "user");
const originalAsk = userAsks[0];
const latestAsk = userAsks.length > 1 ? userAsks[userAsks.length - 1] : undefined;
```

and prepend to `sections` (after the "Compacted conversation context." line):

```ts
originalAsk ? `Original ask: ${truncateSummaryLine(originalAsk.content, 320)}` : undefined,
latestAsk ? `Latest ask: ${truncateSummaryLine(latestAsk.content, 320)}` : undefined,
```

- [ ] **Step 4: Run to green** — same command; whole file PASSES (existing cases must not break — if an existing snapshot asserts exact output, update it deliberately).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(gateway): pin original and latest ask in compaction summary"`

---

### Task 2: Planner fast path (R3-2) — flag `plannerFastPathV1Disabled`

**Files:**
- Modify: `apps/gateway/src/config.ts` (feature interface ~:75-90, env pair list ~:665-690, defaults ~:1205)
- Create: `apps/gateway/src/services/chat-planner-fast-path.ts`
- Modify: `apps/gateway/src/services/chat-turn-prep-service.ts` (`generatePreparedExecutionPlanDraft`, lines 748-853)
- Test: `apps/gateway/src/services/chat-planner-fast-path.test.ts` (new); extend the prep-service planner coverage where the existing planner tests live (`chat-turn-planning-helpers.test.ts` covers coercion; planner invocation tests: `chat-turn-prep-service.personality.test.ts` shows the host-mock idiom).

**Interfaces:**
- Produces: `shouldSkipPlannerDraft(content: string): boolean` and `selectPlannerDraftModel(input: { routerInput: OrchestrationRouterInput; prefs: ChatSessionPrefsRecord }): { providerId?: string; model?: string; evidence?: unknown } | undefined` — both pure, exported from the new module.
- `generatePreparedExecutionPlanDraft` behavior: when flag OFF (default) and `shouldSkipPlannerDraft(prepared.content)` → return `fallbackDraft` without any LLM call; when the planner runs, `providerId`/`model` for the call come from `selectPlannerDraftModel(...)` falling back to `prepared.prefs`. When flag ON (`plannerFastPathV1Disabled: true`) → byte-identical to today.

- [ ] **Step 1: Failing unit tests for the heuristic** (`chat-planner-fast-path.test.ts`):

```ts
describe("shouldSkipPlannerDraft", () => {
  it.each([
    "Summarize this file",
    "what's the capital of France?",
    "rename the variable foo to bar",
  ])("skips for trivial single-clause asks: %s", (content) => {
    expect(shouldSkipPlannerDraft(content)).toBe(true);
  });
  it.each([
    "Research competitor pricing and then draft a comparison table with recommendations",
    "1. audit the repo 2. fix the findings 3. write a report",
    "Plan the migration: inventory services, design the target schema, then produce a cutover runbook",
    "compare React and Vue and Svelte for our dashboard rewrite",
  ])("keeps the planner for multi-step asks: %s", (content) => {
    expect(shouldSkipPlannerDraft(content)).toBe(false);
  });
  it("keeps the planner for long asks even without markers", () => {
    expect(shouldSkipPlannerDraft("x".repeat(400))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run src/services/chat-planner-fast-path.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement the module** — heuristic: skip when `content.trim().length <= 220` AND no multi-step markers. Marker regex (single source of truth, documented in-file):

```ts
const MULTI_STEP_MARKERS =
  /(\band then\b|\bafter that\b|\bstep\s*\d|\b\d\s*[.)]\s|\bfirst\b[\s\S]*\bthen\b|\bresearch\b|\bcompare\b|\baudit\b|\bplan\b|\bmigrat|\broadmap\b|\bworkstream|\bin parallel\b|\bseparately\b|;\s|\n-|\n\d|,\s*(and|then)\b|\band\b[\s\S]*\band\b)/i;
export function shouldSkipPlannerDraft(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 220) return false;
  return !MULTI_STEP_MARKERS.test(trimmed);
}
```

Tune the regex until the table passes — the table is the spec. `selectPlannerDraftModel`: reuse `selectOrchestrationModel` from `../orchestration/model-selector` with `role: "planner"` — check its actual signature first; `buildStepPlans` calls it as `selectOrchestrationModel({ role, capabilities, prefs, usedProviders })` (`router.ts:293`). Capabilities come from the same source `buildOrchestrationPlan` uses — trace where `router.ts` gets `capabilities` (a `ProviderCapabilityRecord[]`) and expose the same resolution to the prep path; `routerInput` likely already carries providers. Bias to speed: pass prefs with `orchestrationProviderPreference: "speed"` override (`{ ...prefs, orchestrationProviderPreference: "speed" }`) unless the user pinned an explicit `prefs.providerId`+`prefs.model` pair — when pinned, return `undefined` (respect the pin; planner uses the pinned model as today).
- [ ] **Step 4: Wire into `generatePreparedExecutionPlanDraft`** — add host flag accessor to `ChatTurnPrepHost` if not present (mirror how the host exposes features elsewhere — check `host.` members used in the file). Insertion after the existing `speedMode === "fast"` early return (line 759):

```ts
const fastPathDisabled = host.isFeatureEnabled?.("plannerFastPathV1Disabled") ?? false;
if (!fastPathDisabled && shouldSkipPlannerDraft(prepared.content)) {
  return fallbackDraft;
}
const draftModel = fastPathDisabled ? undefined : selectPlannerDraftModel({ routerInput, prefs: prepared.prefs });
```

and in the `host.createChatCompletion({...})` call replace the two model lines with `providerId: draftModel?.providerId ?? prepared.prefs.providerId, model: draftModel?.model ?? prepared.prefs.model,`.
- [ ] **Step 5: Failing integration tests** — in the prep-service planner test surface, add: (a) trivial ask + flag default → `createChatCompletion` mock NOT called, draft === fallback template; (b) multi-step ask → called; (c) trivial ask + `plannerFastPathV1Disabled: true` → called (old behavior); (d) multi-step ask with two mock providers where a `*-mini` model exists → the completion call received the speed-selected model, not `prefs.model`. Mirror the existing host-mock construction from `chat-turn-prep-service.personality.test.ts`.
- [ ] **Step 6: Run to green** — both test files pass.
- [ ] **Step 7: Config flag plumbing** — add `plannerFastPathV1Disabled?: boolean` to the feature interface, `["plannerFastPathV1Disabled", process.env.GOATCITADEL_FEATURE_PLANNER_FAST_PATH_V1_DISABLED]` to the env pair list, `plannerFastPathV1Disabled: featuresInput.plannerFastPathV1Disabled ?? false` to defaults. If `config.test.ts` pins the feature-flag set, update it.
- [ ] **Step 8: Commit** — `git commit -m "feat(gateway): planner fast path — triviality skip + speed-selected draft model"`

---

### Task 3: Stream idle watchdog (R3-3) — flag `streamIdleWatchdogV1Disabled`

**Files:**
- Create: `apps/gateway/src/services/stream-idle-watchdog.ts`
- Modify: `apps/gateway/src/services/llm-completion-service.ts` (the `for await (const chunk of host.llmService.chatCompletionsStream(...))` attempt loop, lines ~647-720)
- Modify: `apps/gateway/src/config.ts` (flag, as Task 2; plus `assistant`-section knob if one fits the existing shape — check how `assistant.durable.*` style knobs are declared and mirror for `streamIdleTimeoutMs`, default 120_000)
- Test: `apps/gateway/src/services/stream-idle-watchdog.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export interface StreamIdleWatchdogOptions {
  idleTimeoutMs: number;
  onTrip?: (elapsedIdleMs: number) => void; // diagnostics hook
  abort?: () => void;                        // aborts the underlying provider request
}
export class StreamIdleTimeoutError extends Error { readonly code = "stream_idle_timeout"; }
export function withStreamIdleWatchdog<T>(source: AsyncIterable<T>, options: StreamIdleWatchdogOptions): AsyncIterable<T>;
```

Semantics: yields `source`'s items unchanged; if the gap between items exceeds `idleTimeoutMs`, calls `options.abort?.()`, then throws `StreamIdleTimeoutError`. Timer starts before the first item (a stream that never emits also trips). Timer cleared on return/throw (no leaked timeout keeping the process alive — use `unref()` where available).

- [ ] **Step 1: Failing unit tests** (use fake timers where the file's idiom allows; otherwise real timers with small values):

```ts
it("passes chunks through and re-arms between chunks", async () => {
  const chunks = await collect(withStreamIdleWatchdog(emitWithDelays(["a", "b", "c"], 30), { idleTimeoutMs: 100 }));
  expect(chunks).toEqual(["a", "b", "c"]);
});
it("throws StreamIdleTimeoutError when the source hangs after emitting", async () => {
  const source = (async function* () { yield "a"; await new Promise(() => {}); })();
  const aborted = vi.fn();
  await expect(collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 50, abort: aborted }))).rejects.toBeInstanceOf(StreamIdleTimeoutError);
  expect(aborted).toHaveBeenCalledOnce();
});
it("throws when the source never emits at all", async () => {
  const source = (async function* () { await new Promise(() => {}); })() as AsyncIterable<string>;
  await expect(collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 50 }))).rejects.toBeInstanceOf(StreamIdleTimeoutError);
});
it("propagates source errors unchanged", async () => {
  const source = (async function* () { yield "a"; throw new Error("boom"); })();
  await expect(collect(withStreamIdleWatchdog(source, { idleTimeoutMs: 1000 }))).rejects.toThrow("boom");
});
```

- [ ] **Step 2: Run to verify failure** → module not found.
- [ ] **Step 3: Implement** — race each `iterator.next()` against a re-armed timer:

```ts
export async function* withStreamIdleWatchdog<T>(source: AsyncIterable<T>, options: StreamIdleWatchdogOptions): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const idleGuard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          options.abort?.();
          options.onTrip?.(options.idleTimeoutMs);
          reject(new StreamIdleTimeoutError(`Provider stream idle for ${options.idleTimeoutMs}ms`));
        }, options.idleTimeoutMs);
        timer.unref?.();
      });
      try {
        const next = await Promise.race([iterator.next(), idleGuard]);
        if (next.done) return;
        yield next.value;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await iterator.return?.().catch(() => undefined); // release the underlying stream; best-effort cleanup
  }
}
```

- [ ] **Step 4: Wire into the completion attempt loop** — in `llm-completion-service.ts`: per attempt, create `const idleAbort = new AbortController()`; pass a combined signal into the request (`AbortSignal.any([...existing signal if present, idleAbort.signal])` — Node 24 has `AbortSignal.any`); wrap the stream: gate on flag + resolve `idleTimeoutMs` from config (default 120_000). The thrown `StreamIdleTimeoutError` flows into the existing `catch` → `normalizeChatCompletionAttemptError` → `attemptStreamed ? streamFailedAfterEmit` salvage path — that is the design: hang becomes a normal recoverable stream failure. Ensure `StreamIdleTimeoutError` is treated as **non-retryable-transient after emit** (existing logic already breaks the attempt loop when `attemptStreamed`); when nothing was emitted yet, letting the existing transient-retry try the next attempt is correct and needs no special-casing. Add the error's `code` into the dev-diagnostic context so stalls are identifiable (`event: "chat.completion_stream.attempt_failed"` already logs `error.message`).
- [ ] **Step 5: Failing integration test** — extend the llm-completion-service test file (find it: `src/services/llm-completion-service.test.ts` or nearest): fake `chatCompletionsStream` that yields one chunk then hangs; with a small configured idle timeout assert (a) the generator finishes with the salvage/error path rather than hanging (guard the test with vitest's own timeout), (b) with `streamIdleWatchdogV1Disabled: true` the wrapper is not applied (fake a hang + assert the request's own `timeoutMs` path still governs — keep this case fast by injecting a tiny `timeoutMs`).
- [ ] **Step 6: Run to green.**
- [ ] **Step 7: Config plumbing** — flag as Task 2; `streamIdleTimeoutMs` knob: follow the existing assistant-config shape (find where per-feature tunables live — e.g. durable/heartbeat constants vs config — prefer config with default 120_000, floor it at 5_000 to prevent foot-gun values).
- [ ] **Step 8: Commit** — `git commit -m "feat(gateway): per-chunk stream idle watchdog with abort + salvage"`

---

### Task 4: Parallel read-only tool execution (R3-1) — flag `parallelToolExecutionV1Disabled`

**Files:**
- Create: `apps/gateway/src/services/chat-tool-parallelism.ts` (pure decision helpers)
- Modify: `packages/policy-engine/src/tool-registry.ts` (export a read-only name set helper) + `packages/policy-engine/src/index.ts` (re-export)
- Modify: `apps/gateway/src/services/chat-agent-orchestrator.ts` (tool loop, lines 2650-2795)
- Test: `apps/gateway/src/services/chat-tool-parallelism.test.ts` (new) + a focused orchestrator test file `apps/gateway/src/services/chat-agent-orchestrator.parallel-tools.test.ts` (new; mirror the harness from `chat-agent-orchestrator.quick-web.test.ts`)

**Interfaces:**
- Registry produces: `export function listReadOnlyBuiltinToolNames(): ReadonlySet<string>` — names where `readOnly === true && requiresApproval === false && riskLevel === "safe"`.
- Helper produces:

```ts
export interface ParallelToolBatchDecision { parallel: boolean; reason: string; }
export function decideToolBatchParallelism(input: {
  toolNames: string[];               // canonical names, in emission order
  readOnlyNames: ReadonlySet<string>;
  disabledByFlag: boolean;
  remainingToolBudget: number;       // executionBudget.maxToolRunsPerTurn - toolRunCount
  maxParallel: number;               // 4
}): ParallelToolBatchDecision;
```

Rules (each is a test): parallel only when `!disabledByFlag`, `toolNames.length > 1`, **every** name ∈ `readOnlyNames`, `toolNames.length <= remainingToolBudget`, and `toolNames.length <= maxParallel`. Any violation → `{ parallel: false, reason }`.

- [ ] **Step 1: Failing tests for the registry helper + decision function** — registry: assert the set contains `session.search` (readOnly, safe, no-approval — verified at `tool-registry.ts:69-99`) and excludes `session.status` (no `readOnly` flag, `tool-registry.ts:60-67`); assert every member's definition satisfies all three predicates (walk `createDefaultToolRegistry().list()`). Decision: one test per rule above + the happy path.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement both helpers** (registry helper iterates `BUILTIN_TOOLS` once, caches the Set at module level).
- [ ] **Step 4: Failing orchestrator test** — harness with a scripted provider: first completion returns THREE tool calls to a fake read-only tool wired with controlled latency (e.g. each `executeToolCall` target takes 80ms via the tool executor fake); second completion returns the final answer. Assertions:
  - (a) **overlap**: record wall-clock around the tool phase; parallel path completes in `< 200ms` (3×80 serial ≈ 240+) — or, more robustly, instrument the fake with `started[]`/`finished[]` timestamps and assert `max(started) < min(finished)` for at least one pair;
  - (b) **ordering**: the `role:"tool"` messages in the captured second completion request appear in the emission order of the tool calls regardless of completion order (make call 1 the slowest);
  - (c) **mixed batch stays serial**: swap one call to a non-read-only name → assert no overlap (pairwise `started[i+1] >= finished[i]`);
  - (d) **flag**: `parallelToolExecutionV1Disabled: true` → serial;
  - (e) **failure shape**: one parallel call rejects → its tool message carries the same error-result shape as the serial path (run the identical scenario serially and compare the tool-message payload structure);
  - (f) **records**: `chatToolRuns` storage receives one record per call in both paths.
- [ ] **Step 5: Implement the orchestrator splice** — inside the loop region, BEFORE `for (const toolCall of toolCalls)`: compute the batch decision (canonical names are already resolved at that point — verify how `toolCall.toolName` relates to `toolSchema.modelToCanonical`; use canonical). If `decision.parallel`:
  - Run the per-call pre-checks that are pure/cheap for the whole batch first: cancellation (`throwIfChatTurnCancelled`), loop-guard (`detectToolLoopRisk` per call against the CURRENT `loopGuardState` — if ANY entry trips, fall back to the serial path for the whole batch (its handling logic stays where it is); do not duplicate the trip-handling in the parallel arm);
  - `toolRunCount += batch.length` up-front (budget already checked by the decision);
  - Patch trace once: `status: "waiting_for_tool"`;
  - Execute: `const settled = await Promise.all(batch.map(async (toolCall) => { try { return { toolCall, executed: await this.executeToolCall({ ...same args as serial, priorToolRuns: priorSnapshot }) }; } catch (error) { return { toolCall, thrown: error }; } }))` where `priorSnapshot = [...toolRuns]` frozen before the batch (parallel siblings do not see each other — pin with a comment + test (f) tolerance);
  - Then iterate `settled` IN ORDER running the exact same post-execution block the serial loop runs (push record, `rememberToolLoopHistory`, budget extension, yield `tool_start` + `executed.chunk`, `answeredToolCallIds` bookkeeping, `userInputPrompt` handling — first prompt in order wins, matching serial semantics for that call; a `thrown` entry re-throws after the loop finishes appending completed siblings' results, preserving serial throw behavior as closely as possible — check what the serial path does when `executeToolCall` throws (it doesn't catch → the whole turn errors) and mirror: collect, append nothing extra, re-throw the FIRST thrown in order).
  - **Extract the shared post-execution block into a local function** used by both arms so the two paths cannot drift.
- [ ] **Step 6: Run to green** — the new orchestrator test file + `chat-agent-orchestrator.quick-web.test.ts` (regression canary) pass.
- [ ] **Step 7: Config plumbing** (as Task 2) + verify the flag reaches the orchestrator through the same seam other feature flags do (find how the orchestrator learns `autonomyV1Disabled`/features today — likely via `input` or `this.deps`; reuse).
- [ ] **Step 8: Run the full orchestrator test set** — `pnpm exec vitest run src/services/chat-agent-orchestrator` (all files matching) → green.
- [ ] **Step 9: Commit** — `git commit -m "feat(gateway): parallel execution for all-read-only tool batches"`

---

### Task 5: Planner-declared fan-out (R3-7) — flag `plannerFanoutV1Disabled`

**Files:**
- Modify: `apps/gateway/src/services/chat-turn-planning-helpers.ts` (`coercePlannerExecutionPlanDraft` :454-534, `applyExecutionPlanDraftToOrchestrationPlan` :555+, `filterPlannerDependencyIds` :536-553)
- Modify: `apps/gateway/src/services/chat-turn-prep-service.ts` (planner system prompt lines 784-792 — announce the expansion capability; flag gate)
- Test: `apps/gateway/src/services/chat-turn-planning-helpers.test.ts` (extend — existing coercion tests at :277-460 show the fixture idiom)

**Interfaces:**
- `coercePlannerExecutionPlanDraft` gains optional `input.allowProductionExpansion?: boolean` (default false → today's behavior byte-identical). When true and mode is cowork: extra raw steps beyond the template count may materialize as ADDITIONAL worker steps, subject to hard caps.
- `applyExecutionPlanDraftToOrchestrationPlan` learns to materialize those extra steps into `ModeOrchestrationPlan` steps (role `worker`, `delegatedRole` from the planner label or `Worker N`, model via the same `selectOrchestrationModel` call other steps use — check what plan-level context is available there; if capabilities aren't reachable inside the helper, clone the template worker's provider/model) and recompute stages by topological leveling.
- New pure helper in the same file: `deriveStagesFromDependencies(steps): number[] | undefined` — Kahn leveling over `dependsOnStepIds`; returns `undefined` on cycle/missing-ref (caller falls back to template stages).

**Hard caps enforced server-side (planner output is untrusted):** ≤ 4 production steps total; expansion only of worker-role steps; control steps (`shouldProtectPlannerTemplateStep`) keep template role/label/objective and their `dependsOnStepIds` are REPLACED with "all production step ids" when expansion occurred; every materialized step's `dependsOnStepIds` filtered to known earlier steps; stage leveling failure → template linear chain.

- [ ] **Step 1: Failing coercion/apply tests** — extend the existing describe blocks:
  - planner returns 5 steps against the 4-step default template with `allowProductionExpansion: true`: 2 extra worker steps requested, only 1 materializes (cap 4 production? default template has 1 worker + planner adds up to 3 → assert the cap math you implement: total production ≤ 4);
  - two independent workers (`parallelizable: true`, no deps between them) → both get the same derived stage; synthesizer stage > worker stages; reviewer depends on all workers;
  - a dependency cycle in the draft → stages identical to the template chain (fallback);
  - `allowProductionExpansion: false` (default) → extra steps dropped exactly as today (pin with an existing-behavior test BEFORE changing code, to prove no drift);
  - chat mode / `advisoryOnly` → expansion never happens;
  - hostile draft: 40 extra steps, bogus roles, deps on nonexistent ids → caps hold, no throw.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** in small increments (coerce expansion → deriveStages → apply materialization), re-running the file each increment.
- [ ] **Step 4: Wire the flag + prompt** — in `generatePreparedExecutionPlanDraft`: `allowProductionExpansion: routerInput.task.mode === "cowork" && !host.isFeatureEnabled?.("plannerFanoutV1Disabled")`; extend the planner system prompt with one line: `"For cowork you may add up to N extra worker steps when the request contains genuinely independent subtasks; mark them parallelizable:true and give each a precise objective."` (compute N from the cap). Keep the protected-step language unchanged.
- [ ] **Step 5: End-to-end stage assertion** — in the planning-helpers or prep-service test surface: template `cowork.plan.work.synthesize` + a mocked planner payload with two independent workers → final `ModeOrchestrationPlan` has both workers sharing a stage and the engine's stage grouping (pure function — import and call `executeOrchestrationPlan`'s grouping logic if exported, else assert on `step.stage` values) would run them in one `mapWithConcurrency` wave.
- [ ] **Step 6: Run to green** — planning-helpers file + `orchestration/router.test.ts` + prep-service tests.
- [ ] **Step 7: Config plumbing** (as Task 2).
- [ ] **Step 8: Commit** — `git commit -m "feat(gateway): planner-declared fan-out — bounded worker expansion with dependency-derived stages"`

---

### Task 6: Full verification + docs

**Files:**
- Modify: `docs/citadel_update/AGENTIC_FAST_LANE_PLAN.md` (mark S2/S4/watchdog/fan-out lines shipped with this round's commits; correct the workstreams-parallelism note)
- Modify: `docs/superpowers/specs/2026-07-03-agentic-orchestration-round3-design.md` (status → Implemented; note any scope cuts)

- [ ] **Step 1:** `cd F:/code/pa-round3/apps/gateway && pnpm test` (vitest full + the two tsx --test files) → green.
- [ ] **Step 2:** `cd F:/code/pa-round3 && pnpm typecheck` → green (workspace-wide; catches contracts/policy-engine ripples).
- [ ] **Step 3:** `pnpm verify:fast` and `pnpm verify:agentic:governance` from the worktree root → green (governance lane asserts deny-wins survived the parallel-tools change).
- [ ] **Step 4:** Update the two docs; commit `docs: record round-3 agentic shipments in the fast-lane ledger`.
- [ ] **Step 5:** Push branch, open PR, run code-review + security-review agents on the diff, fix findings, merge per repo convention.

## Self-review notes

- Spec coverage: R3-1→Task 4, R3-2→Task 2, R3-3→Task 3, R3-5→Task 1, R3-7→Task 5, R3-4/R3-6 struck in the spec, R3-8 stretch (not planned — only after Task 6 green with budget left, as its own spec addendum).
- Type-consistency: helper names used in later steps are defined in this plan's Interfaces blocks; orchestrator/config seams are named as "find and reuse the existing accessor" deliberately — the implementer verifies the concrete member at task start (the two candidate seams are named).
- Known intentional divergences to pin with tests + comments: parallel siblings see a frozen `priorToolRuns` snapshot; first-in-order `userInputPrompt` wins after sibling completion.
