# Agentic Orchestration Round 3 — Design

- **Date:** 2026-07-03
- **Status:** Implemented (R3-1/2/3/5/7 shipped 2026-07-03 on `feat/agentic-round3`; R3-4/6 struck below; R3-8 not attempted — recorded as the open "part 2" in the fast-lane ledger). Implementation deviations: R3-1 landed as pre-execute-batch + single consumption loop (no dual post-processing path — strictly less drift surface than the plan's sketch); R3-3's UI stall signal is the machine-readable `stream_idle_timeout` error through the existing failure plumbing, not a new SSE event type (no contract change).
- **Baseline:** `origin/main` @ `3d578543d`
- **Prior rounds:** #137 overhaul (2026-06-22) → fast-lane P0s + S1 (2026-06-28, `80f654669`). Analysis of record: [GATEWAY_AGENTIC_REVIEW_2026-06-28.md](../../citadel_update/GATEWAY_AGENTIC_REVIEW_2026-06-28.md); execution ledger: [AGENTIC_FAST_LANE_PLAN.md](../../citadel_update/AGENTIC_FAST_LANE_PLAN.md); competitor verification: [COMPETITOR_UPDATE_2026-06-28.md](../../citadel_update/COMPETITOR_UPDATE_2026-06-28.md).

## Process note (autonomous session)

This design was produced in a non-interactive session on a standing directive ("review the orchestration and how goatcitadel does agentic things; improve it"). The brainstorming skill's interactive approval gates were substituted with: (a) user intent grounded in the prior-round strategy docs above, which the user commissioned and acted on twice; (b) a four-agent fresh verification of every open item against today's `main`; (c) self-review plus independent code/security review before merge. The user reviews this spec asynchronously; every behavior change ships behind a kill switch so any decision here is reversible by config.

## 1. Where the runtime stands (verified 2026-07-03)

Four read-only investigation agents re-verified every open ledger item against `main` @ `3d578543d`. Full evidence in the session transcript; load-bearing facts:

**Shipped and healthy (do not regress):**
- S1 terminal-synthesizer streaming, kill switch `orchestrationFinalStreamingV1Disabled` (`chat-turn-stream-service.ts:599-604,1175-1240`).
- In-prompt tool/skill catalog; pseudo-embedding rank gate; degraded-status honesty (`degraded` sidecar + footer, never laundered).
- **New since the June plan:** orchestration steps now get per-role, capability-selected models via `selectOrchestrationModel` (`orchestration/router.ts:293,328-330`, `orchestration/model-selector.ts:14-77`) — the "selectedEngine is a dead label" half of S3 is fixed for delegated steps.
- **New since the June plan:** audit appends are queued off the tool hot path (`policy-engine/src/audit-log.ts:26-82`).
- Skill self-authoring candidates now auto-file into the improvement ledger every 5th turn; operator profile fills via LLM extraction on the same cadence.

**Still open (this round's raw material):**

| # | Gap | Evidence |
|---|-----|----------|
| G1 | Tool calls execute strictly serially — `for (const toolCall of toolCalls) { … await this.executeToolCall(…) }` — latency is the *sum*, not the *max*. A `readOnly?: boolean` flag already exists on `ToolDefinition` and is set on many builtins, but nothing consumes it. | `chat-agent-orchestrator.ts:2650,2761`; `tool-registry.ts:16,92+` |
| G2 | Planner LLM draft runs unconditionally for cowork/code (only `speedMode:"fast"` skips), serially after prep, ≤1500 ms, **on the session-default model** (`prefs.model`). | `chat-turn-prep-service.ts:748-860,759,773-774,87`; `chat-turn-entry-service.ts:235` |
| G3 | No per-chunk idle watchdog: only a request-level `AbortSignal.timeout`. A provider that hangs after the first chunk freezes the turn until the absolute deadline; no stall event reaches the client. | `llm-provider-anthropic.ts:257`; `llm-completion-service.ts:657-670`; orchestrator `for await` at `:2236` |
| G4 | Stage parallelism exists in the engine (`mapWithConcurrency`, default 4) but the default cowork template is a hard 1→2→3→4 chain and only `cowork.research.synthesize.critic` may parallelize under `auto`; `cowork.workstreams.synthesize` parallelizes only when the user explicitly sets `orchestrationParallelism:"parallel"`. | `orchestration/engine.ts:21-66`; `orchestration/router.ts:287-291,300-310` |
| G5 | Compaction is still a regex keyword digest; the original user ask is never re-pinned after trims. | `chat-compaction.ts:7-50` |
| G6 | `subagentPolicy` defaults to `"ask_when_useful"` (`contracts/chat.ts:702,738`) yet no spawn/fan-out primitive exists; the field is dead config. | grep across gateway tool registry |
| G7 | Per-iteration prompt-budget receipt re-estimates tokens over the whole history every loop, unconditionally. | `chat-agent-orchestrator.ts:2200-2206` |
| G8 | MCP invokes pay 2–3 full policy evaluations (access + dry-run preview + real invoke). Grant constraint counters re-query per evaluation. | `tool-invocation-coordinator-service.ts:303-316,499`; `policy-engine/engine.ts:975-1080` |
| G9 | Every chat/cowork/code turn is durable-wrapped (lease + 5 s heartbeat CAS) with no size threshold (old S6). | `chat-turn-dispatch-service.ts:53-89`; `durable-run-service.ts:55,1280-1352` |

## 2. Objective

Make a GoatCitadel agentic turn **feel and be** faster and more capable than OpenClaw/Hermes on the same work, without moving policy enforcement off the live path. Concretely: tool phases run at *max* not *sum*; trivial cowork asks stop paying a planner tax; hung providers surface as stalls instead of infinite spinners; independent cowork work actually fans out.

## 3. Approaches considered

**A. Micro-optimizations only** (receipt memoization, grant caching, audit polish — G7/G8). Low risk, low ceiling: none of it changes what a user feels in a turn. Rejected as the round's theme; two prior rounds prove shape-level fixes are what move the needle.

**B. Fast-loop package** — close G1, G2, G3, G4, G5 (+ the safe slice of G7). Every item rides an existing seam (readOnly flag, `selectOrchestrationModel`, engine concurrency, existing fallback-draft path), each independently kill-switched. Medium risk, large felt impact.

**C. Capability leap** — B plus a real fan-out primitive for G6. Highest ceiling: with S1 already streaming the terminal step, real fan-out puts GoatCitadel structurally ahead of both competitors (verified 2026-06-28: neither forwards child tokens nor routes cheap models on the main turn).

**Chosen: C, staged as B-first.** Items land smallest-risk-first as independent commits; the fan-out primitive is last and is cut without ceremony if earlier items consume the session's review budget. G8 (MCP double-eval, grant caching) and G9 (durable threshold) are explicitly deferred again — both touch security/recovery semantics and their felt impact is smaller than G1–G4; they're recorded as follow-ups with today's evidence.

## 4. Design per item

Feature-flag convention follows the repo's precedent (`autonomyV1Disabled`, `orchestrationFinalStreamingV1Disabled`): behavior ships ON, `…V1Disabled` kills it.

### R3-1 · Parallel read-only tool execution (G1) — flag `parallelToolExecutionV1Disabled`

When one model turn emits **more than one** tool call and **every** call in the batch resolves to a registered tool with `readOnly: true`, execute the batch with `Promise.allSettled` under a concurrency cap of 4. Otherwise (any mutating, unknown, or MCP tool in the batch) the existing serial path runs byte-identically.

- **Ordering:** results are buffered and appended to the conversation in the original `toolCalls` order — the provider contract (tool results matched to `tool_call_id` in emission order) is preserved regardless of completion order.
- **Governance unchanged:** each call still runs the full per-call policy evaluation + audit inside `executeToolCall`; parallelism only overlaps the waits. Deny-wins and approval gating are per-call and unaffected. A regression test asserts the policy evaluator is invoked once per call on the parallel path.
- **Failure semantics:** a rejected settle maps to the same error-shaped tool result the serial path produces. Whether one failure aborts the remaining calls must **mirror the serial path exactly** — verify the serial loop's continue-vs-break-on-error behavior at implementation time and pin it with a test on both paths.
- **Trace:** step events may interleave; each carries its `toolCallId` already.

### R3-2 · Planner fast path (G2) — flag `plannerFastPathV1Disabled`

Two changes to `generatePreparedExecutionPlanDraft`:

1. **Deterministic triviality skip.** A pure `shouldSkipPlannerDraft(content)` heuristic (short single-clause asks: below a length bound, no enumeration/multi-step/research markers) returns the existing deterministic `fallbackDraft` — exactly the floor `speedMode:"fast"` already ships, so the quality floor is a path users can already choose, not a new one.
2. **Speed-selected draft model.** When the planner does run, choose its model via the existing `selectOrchestrationModel` seam with a speed-biased preference for the planner role, falling back to `prefs.model` when selection yields nothing (single-provider installs). The main turn's model is untouched — this is Hermes' aux-model pattern applied to our one remaining meta-call on the hot path.

Prep/planner overlap (the old "run planner concurrently with prep I/O" claim) is **best-effort**: only if the seam in `chat-turn-entry-service.ts:235` separates cleanly; it is not load-bearing for this round and drops without replacement if the pipeline resists.

### R3-3 · Stream idle watchdog (G3) — flag `streamIdleWatchdogV1Disabled`

An idle timer around provider chunk iteration: re-armed on every chunk, default 120 s (config `assistant.streamIdleTimeoutMs`), on trip abort the provider request and surface a structured `stream_stalled` failure into the **existing** answer-recovery ladder (salvaging already-streamed text — the show-raw-then-recover posture both competitors deliberately chose). Emit a `trace_update` stall marker so mc-next's stall indicator gets a real gateway signal instead of a client-side guess. Placement is the shared streaming iteration in `llm-completion-service.ts` so all providers inherit it.

### R3-4 · Auto-parallel workstreams (G4) — **struck: already shipped**

Implementation-time correction (2026-07-03): `buildWorkstreamStepPlans` already parallelizes production workstreams under `auto` (`router.ts:203` — `parallelProduction = parallelism === "parallel" || parallelism === "auto"`), and the research template parallelizes under `auto` at `router.ts:287-291`. The investigation agent's claim that workstreams required explicit `"parallel"` was a misread. The residual G4 gap is solely the default template's inability to fan out at all — addressed by R3-7.

### R3-5 · Compaction re-pin (G5)

`buildConversationCompactionSummary` becomes ask-anchored: pin (a) an excerpt of the **original** user ask and (b) the **latest** user ask ahead of the decision/failure digest, so long cowork sessions stop drifting off-objective after trims. Pure-function change, deterministic, test-pinned; no flag (content-only, no control-flow change).

### R3-6 · Receipt memoization (G7) — **struck: deferred**

Implementation-time correction (2026-07-03): keeping receipt values byte-identical under memoization is not cheap (`estimateTokensFromText` runs over role-prefixed concatenations, so per-message sums differ from whole-text estimates), and the loop runs at most `maxToolLoops` (4–12) times per turn — this is not the hot tax the June S5 finding identified (the audit-append tax has since healed). Dropped per YAGNI; deferred with the G7 evidence.

### R3-7 · Planner-declared fan-out (G4/G6) — flag `plannerFanoutV1Disabled`

Implementation-time sharpening (2026-07-03): the planner prompt already requests `parallelizable` + `dependsOnStepIds` per step and `coercePlannerExecutionPlanDraft` already preserves them (`chat-turn-planning-helpers.ts:497-516`) — but the draft maps 1:1 onto template steps (extra planner steps are silently dropped) and stages are never recomputed, so on the default `cowork.plan.work.synthesize` template (one worker) the planner structurally cannot fan out. The change: for cowork, allow the draft to **expand production (worker-role) steps** beyond the template count — capped at 4 production steps, control steps (reviewer/synthesizer) keep their protected template role and pick up dependencies on all production steps — then derive stages by topological leveling of the dependency graph so independent workers share a stage and the engine's existing `mapWithConcurrency` (cap 4) runs them concurrently. Planner output remains untrusted input: role/count/dependency caps are enforced server-side; a cycle or malformed graph falls back to the template's linear chain.

### R3-8 · Fan-out primitive, part B — model-callable spawn tool (G6, stretch)

`agent.fanout`: a builtin tool exposed in cowork/code when `prefs.subagentPolicy !== "off"`, accepting ≤3 subtasks, running each through the existing `executeDelegatedPlanStep` machinery concurrently (children keep today's hard floor: `subagentPolicy:"off"`, `orchestrationEnabled:false` — no recursion by construction), returning aggregated per-subtask results. Kill switch `subagentFanoutV1Disabled`. **Only attempted if R3-1…7 are green with review budget left**; since `subagentPolicy` defaults to `ask_when_useful`, shipping this activates a live capability — it must not land half-reviewed.

## 5. Explicitly deferred (with today's evidence, for the next round)

- **G8a** MCP single policy evaluation (preview+execute dedup) — security-sensitive; needs its own review pass. `tool-invocation-coordinator-service.ts:303-316,499`.
- **G8b** Per-turn grant/constraint-counter memoization — same. `policy-engine/engine.ts:975-1080`.
- **G9** Durable-wrap threshold for short turns (old S6) — touches crash-recovery semantics and the replay-safe resume work from 2026-07-02; `chat-turn-dispatch-service.ts:53-89`.
- Main-turn cheap-model downgrade (old S3-main) — quality-risk, competitors don't do it, still upside-only; revisit with eval coverage.
- Code-mode checkpoint-continue extension; real default embeddings provider; skill-loop default-on — unchanged from the June ledger.

## 6. Testing & verification

Per item, TDD (failing test first): overlap/ordering/mixed-batch/flag tests for R3-1 (fake tools with controlled latency; assert wall-clock ≈ max and result order == emission order); triviality-gate + model-selection tests for R3-2; hang-then-abort + re-arm + salvage tests for R3-3 (fake stream); router stage-assignment tests for R3-4/7; pure-function tests for R3-5/6. Regression: full gateway suite, typecheck, `verify:fast`, `verify:agentic:governance` before merge; every flag exercised in both positions somewhere in the suite.

## 7. Success criteria

1. A turn issuing 3 read-only tool calls completes the tool phase in ≈ the slowest call, not the sum (test-asserted).
2. A trivial cowork ask pays zero planner latency; a non-trivial one plans on a speed-selected model.
3. A provider stream that hangs mid-turn aborts at the idle timeout with salvage + a visible stall marker — no infinite spinner.
4. A cowork ask the planner decomposes into independent subtasks executes those workers concurrently on the default template (test-asserted stage sharing), with server-side caps holding against a hostile draft.
5. Compaction output pins original + latest ask (test-pinned).
6. All existing gateway tests green; each kill switch restores prior behavior byte-identically on its path.
