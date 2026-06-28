# GoatCitadel Agentic Runtime — Round 2 Review (post-overhaul)

**Date:** 2026-06-28
**Companion to:** `GATEWAY_COMPETITIVE_TEARDOWN_2026-06-21.md` (which produced PR #137, merged 2026-06-22).
**Method:** 5 parallel investigation agents tracing the *current* code (post-#137 + the three perf commits), competitor contrast against full clones in `F:\code\_external-review\{openclaw,hermes-agent}`, load-bearing claims re-verified by hand.
**Scope the user asked for:** *match the speed, response, and capabilities of OpenClaw and Hermes — cowork still doesn't work well after the overhaul.*

---

## TL;DR — the one-line thesis

> **The June 21 teardown was a *features* report and you shipped it. The residual gap is *shape*: GoatCitadel runs the interactive turn THROUGH the durable + governed + multi-agent machinery, which the competitors keep OFF the live path. The fix is a fast interactive lane grafted onto the existing governance spine — not another feature port.**

Four structural divergences explain ~all of the "slow and weak" feel. All verified first-hand against current `main` (`c2973e7f4`):

| # | Divergence | GoatCitadel today | OpenClaw / Hermes | Axis |
|---|---|---|---|---|
| 1 | Token delivery | Provider tokens → SQLite `INSERT`+`SELECT` per token → client **polls them back on a 200 ms loop** (`gateway-service.ts:628`, `:3543`) | Provider chunk → socket `write` **in the same call stack**, no datastore (OpenClaw `openai-http.ts:1220-1253`; Hermes `chat_completion_helpers.py:1893-1942`) | Speed |
| 2 | Cowork execution | 1 serial planner LLM (≤1.5 s) **+ 4 sequential full child *sessions***, each re-paying session-create + full prep + prompt rebuild + policy + durable setup → **15–25 round-trips** | **One** in-process agent loop; tools **parallel by default** | Speed + Capability |
| 3 | Agent self-knowledge | Base prompt **never lists tools/skills** — `toolset:{toolNames:[]}` hardcoded (`chat-turn-prep-service.ts:405`); catalog sections render empty | Explicit `## Tooling` + `## Skills` index in-prompt, bodies lazy-loaded (OpenClaw `system-prompt.ts:865-874,269-284`; Hermes `system_prompt.py:188-217`) | Response |
| 4 | Memory | Default `pseudo` embeddings add **ranking *noise*** (≤0.35 weight, uncorrelated ~0.85 cosine) that *degrades* BM25, then reports `hybrid_rank`/`semantic_vector` it isn't doing (`candidate-ranker.ts:205-223`, `memory-context-service.ts:429`) | Real embeddings or honest lexical | Response |

---

## Part 0 — What's good now (keep, don't churn)

- **System-prompt content is strong** — identity, anti-fabrication, tool-first doctrine, output bar, real mode differentiation (`base-agent-system-prompt.ts:83-142`). The #1 gap from last time is genuinely fixed.
- **Prompt caching is correct** — clean stable/volatile split; Anthropic `cache_control` lands on the stable block; volatile bits stay outside the cached prefix (`llm-provider-anthropic.ts:523-571`). Commit `0e8a93c95` is real (Anthropic-only, convention-not-enforced).
- **Answer-recovery, tool-call repair, message-pairing sanitizer** — live, fail-closed, load-bearing (`chat-agent-orchestrator.ts:2346-2351, 2448-2475, 2602-2614`). One dead arm: the `tool_use_without_answer` nudge is unreachable (guard requires `toolRuns.length===0`, `:2451`).
- **Governance spine** (deny-wins policy, Wards, durable execution, capability matrix) — a real differentiator neither competitor has. The plan grafts onto it, doesn't replace it.

---

## Part 1 — SPEED

### 1.1 Store-and-poll streaming (the single biggest "feels laggy" cause)
The orchestrator streams correctly internally (`yield` per chunk, `chat-agent-orchestrator.ts:2234`), but `agentSendChatMessageStream` launches a background durable run and the client reads tokens **back out of SQLite** via a 200 ms poller (`gateway-service.ts:3490-3543`; `chat-turn-entry-service.ts:754,763`). Every token — including the first — waits avg ~100 ms for the poller, on top of a synchronous `INSERT` + re-`SELECT` per token (`chat-stream-event-repo.ts:82-94`). Competitors have ~0 ms here: a synchronous hand-off stream feeds an in-process bus listener that calls `res.write` inside the callback (OpenClaw `event-stream.ts:36-41` → `openai-http.ts:1220-1253`; Hermes `_fire_stream_delta` → `run_agent.py:4273`). **No token coalescing in GoatCitadel either** — one DB write + one DB read per token.

### 1.2 Cowork = serial planner + N sequential child sessions
- Planner LLM is **always-on** for cowork/code (`shouldUseModeOrchestration` returns `true` unconditionally, `apps/gateway/src/orchestration/router.ts:37-39`; only `speedMode:"fast"` skips it, `chat-turn-prep-service.ts:726`), runs ≤1.5 s **before any work starts**, first step **not** speculated concurrently (`chat-turn-entry-service.ts:209,231`).
- Each delegated role is a **brand-new child session running the entire turn pipeline** — `createChatSession` + full `prepareAgentChatTurn` + policy re-resolution + durable setup (`chat-turn-stream-service.ts:829-1127`), ×4, **sequentially** (default `cowork.plan.work.synthesize` template forces one stage per role, `router.ts:299,343`).
- **Round-trip math:** floor ≈ 5; typical (child tool-loop K≈3–5) ≈ 15–25; research ≈ 40+. OpenClaw/Hermes run cowork as one loop.
- The engine *can* run stages parallel at concurrency 4 (`apps/gateway/src/orchestration/engine.ts:37-41`); the template just doesn't use it.

### 1.3 No real fast-model lane
The "model router" is advisory-only — `selectedEngine:"fast_local"` is written to the trace but **never maps to a model** (`model-router-decision-service.ts:60-124`); the turn always calls `prefs.model`. `speedMode:"fast"` only sets `verbosity:"low"`. The "quick web chat fast lane" (`730842e9b`) is real but **chat-only, passes the model verbatim, and is `stream:false`** — does nothing for cowork. Hermes pattern: a cheap **aux model** carries *all* meta-work (summarize/classify/score/vision) (`auxiliary_client.py:319`).

### 1.4 Serial tools + heavy per-tool governance
`for (const toolCall of toolCalls)` awaits each `executeToolCall` in series (`chat-agent-orchestrator.ts:2619,2730`) — latency is the **sum**, not max. Each call blocks on a **cross-process file-lock audit append** (JSONL `appendFile` + `mkdir` dir-lock, `policy-engine/src/engine.ts:1629` → `audit-log.ts:87`), an uncached **3–7 grant `SELECT`s**, and for MCP tools the **whole policy+audit pipeline runs twice** (dry-run preview + real, `tool-invocation-coordinator-service.ts:305`). OpenClaw parallelizes by default with per-tool opt-out (`agent-loop.ts:507,682`); Hermes fans out over a threadpool (max 8) gated by a pure-function read-only-allowlist + path-overlap check (`tool_dispatch_helpers.py:103`).

### 1.5 No stream watchdog
No per-chunk idle timeout, no wedged-provider breaker. A hung provider = a silent spinner forever. OpenClaw: `llm-idle-timeout.ts` (120 s re-armed per chunk) + consecutive-timeout breaker. Hermes: layered stale detectors (180–300 s scaled by context), local providers exempt.

> **Perf-commit reality:** `2116cb43f` ("run turn planner concurrently with prep I/O") is **mislabeled** — it only tightened the planner's own timeout 2500→1500 ms; the planner still runs serially *after* prep. The advertised overlap was never delivered.

---

## Part 2 — RESPONSE QUALITY

### 2.1 The agent is never told what it can do (highest quality leverage)
`toolset:{toolNames:[]}` is hardcoded (`chat-turn-prep-service.ts:405`), so the prompt's "Tools available this turn" + "Skills you can draw on" sections (`base-agent-system-prompt.ts:191-204`) **render empty**. The model gets native tool schemas but no skills catalog / capability summary — the exact affordance that makes competitor agents reach for the right skill. **One-line data-plumbing fix.**

### 2.2 Default memory is lexical-with-noise, mislabeled semantic
Pseudo-hash embeddings → ~0.85 cosine between unrelated strings → clear the 0.65 gate indiscriminately → add ≤0.35 of relevance-uncorrelated weight that **over-ranks `memory_items` and degrades BM25** (`candidate-ranker.ts:205-223`, never calls the existing `isEmbeddingCompatible` gate, `local-embeddings.ts:128`). Status API reports `hybrid_rank`/`semantic_vector` it isn't doing (`memory-context-service.ts:429,702-705`). Real recall needs `GOATCITADEL_EMBEDDINGS_PROVIDER` + `_URL`, which no default install sets.

### 2.3 Self-improvement skill loop never closes
Self-authored skills are written **non-callable** (`skill-mutation-service.ts:187-200`, `lifecycleState:"candidate"`); promotion needs a human-resolved `improvement_activation`; the rail is **flag-off** (`improvementActivationV1Enabled ?? false`, `config.ts:1181`). The agent "learns" skills it can never call.

### 2.4 Degraded turns laundered to `status:"completed"`
Honesty lives only in the prose footer + a `completion.degraded` sidecar; the structured `status` flips `failed→completed` (`chat-agent-orchestrator.ts:3140,3193,3227,3276,3311,3422`). Telemetry / any UI reading `status` sees a clean checkmark on a partial answer.

### 2.5 Cross-session personalization starts empty
Operator profile (the `memoryDigest`) initializes blank (`operator-profile-service.ts:120-123`) and fills only via throttled background-review (`gateway-service.ts:2901`). New users get no personalization for several sessions.

---

## Part 3 — CAPABILITIES

The capability *inventory* is ahead of the competitors (durable execution, Wards, policy kernel, branch/lineage history). What's missing is capability *delivery*: cowork's multi-agent path is too heavy to be worth invoking, the agent doesn't know its own skills (2.1), parallel tool use is off, and several shipped capabilities (skill self-authoring, real embeddings, fast-model routing) are flag-off or inert by default. You pay the complexity cost without the user-facing benefit. Two orchestration layers share the name "orchestration" — `packages/orchestration` is a pure HITL state machine (NOT on the hot path); `apps/gateway/src/orchestration` is the real cowork engine. `packages/mesh-core` is distributed coordination, not agent delegation, not hot-path.

---

## ADR-001: Fast interactive lane; reserve the durable/orchestration lane for long-running work

**Status:** Proposed · **Date:** 2026-06-28

**Context.** Every interactive cowork turn flows through durable-run + store-and-poll + planner + child-session-orchestration. That machinery is correct for *autonomous, long-running, multi-agent* work but on a live turn adds a 200 ms-polled token path, a serial planner, and N sequential sub-agent sessions. Competitors' "fast feel" = persistence + orchestration kept off the live path.

**Decision.** Split execution by intent, keep the spine:
- **Interactive lane (new; default for chat + simple cowork/code):** orchestrator generator piped **directly** to the SSE client (persist as a parallel side-record at message granularity). One in-process loop. **Parallel tool execution** behind a cheap safety gate. Optional **fast model**. **Planner skipped** unless genuinely multi-step. **Stream idle watchdog.**
- **Durable/governed lane (existing):** durable runs, store-and-replay, planner + multi-role orchestration, full audit — for backgrounded / scheduled-proactive / explicitly-multi-step / HITL-gated turns.

The policy engine still runs inline in the loop, so deny-wins/approvals are preserved on the fast lane — assert this with a regression test.

**Options.**

| Option | Complexity | Speed gain | Risk | Verdict |
|---|---|---|---|---|
| A. Status quo + micro-opts | Low | Small | Low | Insufficient — doesn't fix the shape |
| **B. Two-lane (recommended)** | Medium | Large | Medium (governed turns must not leak into fast lane) | **Chosen** |
| C. Replace spine with in-process runtime | High | Large | High (throws away the differentiator) | Rejected |

**Consequences.** *Easier:* TTFT drops by poll interval + per-token DB cost; simple cowork stops paying planner + 4 sessions; tool-heavy turns finish in `max` not `sum`. *Harder:* a lane-routing decision exists and must fail safe; needs a regression guard that fast-lane turns can't bypass deny-wins/approvals. *Revisit:* async-tee durable persistence onto the interactive lane to keep the audit trail without the latency.

---

## Prioritized roadmap (impact ÷ effort)

### P0 — make a single turn fast and self-aware (days, highest ROI)
1. **Pipe orchestrator stream straight to the SSE client** (or event-driven live tail, not a 200 ms poll); persist as a parallel side-record. *`gateway-service.ts:628,3490-3543`; `chat-turn-entry-service.ts:754,763`.* **Biggest latency win.**
2. **Populate the in-prompt tool/skill catalog** — pass real `toolNames` + top skills into `buildBaseAgentSystemPrompt`; render sections already exist. *`chat-turn-prep-service.ts:405`.* **Biggest quality win, ~one line of data.**
3. **Stop pseudo-embedding contaminating ranking** — gate the embedding term on a real provider (`isEmbeddingCompatible`); report `lexical_recency` honestly under pseudo. *`candidate-ranker.ts:205-223`, `memory-context-service.ts:429`.*
4. **Coalesce tokens before persisting; drop the per-append re-`SELECT`.** *`gateway-service.ts:3453`, `chat-stream-event-repo.ts:88`.*
5. **Honest `degraded`/`partial` status** in the structured field. *`chat-agent-orchestrator.ts:3140,3422`.*

### P1 — fix cowork's shape + parallelism (1–2 weeks)
6. **Gate the planner behind a triviality check; overlap it with prep** (deliver what `2116cb43f` claimed). *`chat-turn-prep-service.ts:715-820` vs `chat-turn-entry-service.ts:231`.*
7. **Parallelize independent tool calls** behind a read-only-allowlist + path-overlap gate (Hermes `tool_dispatch_helpers.py:103`). *`chat-agent-orchestrator.ts:2619`.*
8. **Replace full child *sessions* with a lightweight in-process step agent** (esp. non-tool roles → direct completion). *`chat-turn-stream-service.ts:829-1002`.*
9. **Real fast-model lane + aux model for meta-work.** *`model-router-decision-service.ts:118`, `model-selector.ts`.*
10. **Stream idle watchdog + wedged-provider breaker.** *new, around `chat-agent-orchestrator.ts:2227`.*
11. **Per-tool audit off the file lock; cache grant/scope per turn; kill duplicate MCP dry-run.** *`engine.ts:1629,983`, `tool-invocation-coordinator-service.ts:305`.*

### P2 — close the inert loops (2–4 weeks)
12. **Close the self-authored-skill loop** (one-click enable, or auto-promote validated/jailed/scanned candidates under autonomy + rollback). *`skill-mutation-service.ts:187`, `config.ts:1181`.*
13. **Warm the operator profile fast** (lower early-session interval; optional `USER.md` seed). *`operator-profile-service.ts:120`.*
14. **Wire a real default embeddings provider** (local llama.cpp seam exists). *`local-embeddings.ts:229`.*

**Headline:** P0 #1 and #2 are a day or two and fix the two things you *feel* most — the laggy stream and the agent that doesn't know its tools. The cowork-shape work (P1) is where the "drastic" improvement lives.

---

## Appendix — top portable patterns from the competitors

**OpenClaw:** direct event-bus→`res.write` (no store-and-poll); parallel-by-default tools with per-tool opt-out; inline `tool.execute` (no queue); per-chunk idle watchdog that aborts the provider; memoized byte-stable prompt prefix with a single cache boundary.
**Hermes:** synchronous per-chunk delta forwarding; **restore system prompt verbatim from SQLite** (never rebuilt per turn) to keep the prefix cache warm even with a fresh agent per turn; date-only timestamp for byte-stability; threadpool tool fan-out with a cheap static safety gate; all meta-work on a cheap aux model + post-response threshold-gated compaction.
