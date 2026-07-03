# Plan: Close the GoatCitadel ↔ OpenClaw/Hermes agentic gap

**Status:** Active · **Date:** 2026-06-28 · **Round-3 update:** 2026-07-03 (branch `feat/agentic-round3` — S2/S3/S4/watchdog/compaction-anchoring/planner-fan-out shipped; spec: `docs/superpowers/specs/2026-07-03-agentic-orchestration-round3-design.md`) · **Originally verified against:** `80f654669` plus review fixes
**Sources:** [GATEWAY_AGENTIC_REVIEW_2026-06-28.md](GATEWAY_AGENTIC_REVIEW_2026-06-28.md) (5-agent audit) + a live-repo side-chat review (3 audits) + the hand-verified [GATEWAY_COMPETITIVE_TEARDOWN_2026-06-21.md](GATEWAY_COMPETITIVE_TEARDOWN_2026-06-21.md). Two of the side-chat's load-bearing claims (S1 cowork buffering, S6 durable-wrap) were re-verified by hand for this plan.

## Objective
Match OpenClaw/Hermes **speed + liveness** without losing GoatCitadel's governance edge.

## Thesis (corrected & merged)
PR #137 fixed "thin responses" by wrapping cowork in a **plan → execute → synthesize → durable → govern** pipeline. The features are now present and mostly effective — but the integration **regressed liveness**: a cowork turn runs the whole orchestration to completion and then delivers a finished string, so time-to-first-token ≈ whole-turn. The competitors win with one lean streaming loop on a fast-routed model. The fix is not more features — it's **un-bury the streaming loop** and **switch on the features we shipped dead**.

> **Correction from the side-chat review (verified):** the single biggest cowork win was **S1 — stream the terminal orchestration step**. The already-shipped P0‑#1 (notify-on-append, below) removes the chat-path 200ms poll but does **not** make cowork stream, because cowork has no model tokens to forward until `orchestrationResultPromise` resolves. S1 is now implemented on this branch with a reversible kill switch and post-review guards for backpressure and partial child-stream failure.

## DO NOT REGRESS (verified-good from the overhaul)
- Answer-recovery ladder + user-visible `degraded` footer — `chat-agent-orchestrator.ts:2448-2475,:3356-3375`
- Cowork checkpoint-continue (loop-cap → progress snapshot + no-progress detection) — `chat-agent-orchestrator.ts:2934-3006`
- Honest degradation — salvage no longer laundered as clean `completed`; the old "failed step forwarded as usable handoff" bug is fixed — `orchestration-lifecycle-service.ts:1446-1469`
- Prompt-cache stable/volatile split (Anthropic breakpoint pinned) — `base-agent-system-prompt.ts:161-210`
- Proactivity/autonomy end-to-end (cron `agent_turn`, model-callable `schedule.manage` with anti-recursion depth cap, silent heartbeat, commitments) — `schedule-tool-support.ts:182`, `chat-proactive-service.ts:678`
- Governance spine (deny-wins + Wards + restricted profiles) — `policy-engine/engine.ts:256,661`
- Base system-prompt prose is above-average — keep it; the problem was two sections wired to empty (one now fixed, see P0).

---

## ✅ SHIPPED this session — branch `feat/agentic-fast-lane-p0` (3 commits, not pushed)

- [x] **P0‑#1 — kill the live-tail 200ms poll** (`adb1c4780`). `persistChatStreamChunk` now wakes live-tail readers on append; the loop awaits a per-turn signal instead of `wait(200ms)`, timeout kept as a liveness floor. Removes avg ~100ms/token on the **chat / single-loop** streaming path. +5 tests. *Scope note: necessary but NOT sufficient for cowork — see S1.*
- [x] **P0‑#2 — populate the in-prompt tool/skill catalog** (`3f99e8583`). `resolveBasePromptCapabilityCatalog()` feeds the model its callable tools + skill summaries; `chat-turn-prep-service.ts:405` no longer passes `{ toolNames: [] }`. Cheap, cache-safe, no per-tool policy eval. +2 tests. *This is the side-chat's "flip the dead toolset/skills feature" — done.*
- [x] **P0‑#3 — stop pseudo-embeddings poisoning ranking** (`d3ef48102` + review fix). Pseudo/fallback embeddings no longer contribute semantic-vector rank, and retrieval status no longer advertises hybrid rerank unless recent citations actually used it.
- [x] **S1 — stream the terminal orchestration step's tokens to SSE** (`cf7230e82` + `80f654669` + review fixes). Cowork/code terminal synthesizer deltas can now flow live to the parent SSE when the final streamed text matches the authoritative final output; otherwise the parent falls back to the buffered final text. The operator kill switch is `orchestrationFinalStreamingV1Disabled`.

---

## P0 — make a single cowork turn feel alive (days, highest ROI)

- [x] **S1 (HEADLINE) — stream the terminal orchestration step's tokens to SSE** instead of `await orchestrationResultPromise` then delivering a finished string. Implemented with parent-SSE forwarding for the terminal delegated synthesizer, exact-match final-text reconciliation, a lossless progress queue, non-terminal stream-error failure handling, and a `orchestrationFinalStreamingV1Disabled` kill switch. **TTFT: whole-turn → first terminal-synthesizer chunk. #1 win.**
- [x] **S2 — de-block the planner.** *(Round 3, 2026-07-03, kill switch `plannerFastPathV1Disabled`.)* Trivial single-clause asks skip the planner LLM entirely (deterministic `shouldSkipPlannerDraft` gate → template draft, the same floor `speedMode:"fast"` ships); when the planner does run it drafts on a speed-biased capability-selected model via `selectOrchestrationModel` instead of the session default (`chat-planner-fast-path.ts`). Prep/planner overlap was evaluated and dropped — the skip + cheap model capture the bulk of the win without restructuring the prep pipeline.
- [x] **S3 — real fast-model routing.** *(Closed across two rounds.)* Orchestration steps gained per-role capability-selected models before this round (`orchestration/router.ts:293,328-330` — verified 2026-07-03); round 3 closed the remaining hot-path gap by routing the planner draft to a speed-selected model (S2 above). Main-turn cheap-model downgrade stays deliberately unshipped (quality risk; neither competitor does it — see COMPETITOR_UPDATE_2026-06-28 §d).
- [x] **P0‑#3 — stop pseudo-embeddings poisoning ranking.** Short-term is complete: the embedding term is gated off when the actual generated query vector is pseudo/fallback, and status reports `lexical_recency` honestly unless semantic/hybrid evidence exists. Medium-term remains: ship a real bundled local embedding default (e.g. `bge-small`/MiniLM via `@xenova/transformers`) at `local-embeddings.ts:290`, keeping pseudo only as offline fallback. Recall stack: noise → working with one dependency + a default change.

## P1 — speed depth + quality (1–2 weeks)

- [x] **S4 — parallelize independent tool calls.** *(Round 3, 2026-07-03, kill switch `parallelToolExecutionV1Disabled`.)* All-read-only multi-call batches (registry-declared `readOnly` + `riskLevel:"safe"` + no definition-level approval, cap 4) pre-execute concurrently; the unchanged serial loop consumes results in emission order, so per-call policy/audit/post-processing have exactly one code path. Mixed/unknown/MCP batches stay byte-identical serial. Serial-parity pinned by test (`chat-agent-orchestrator.parallel-tools.test.ts`). Also flagged `memory.read`/`session.status`/`time.now` as `readOnly` in the registry (were unflagged).
- [ ] **S5 — per-tool IO tax off the hot path.** Each tool call does a lock-serialized `fs.appendFile` audit + 3–5 sync SQLite writes blocking the next tool (`engine.ts:1462→audit-log.ts:89`); every iteration `JSON.stringify`s the whole context for a trace receipt and regex-scans every full tool result (`chat-agent-prompt-budget-receipt.ts:16`). Batch/async the audit; gate the receipt behind a debug flag.
- [ ] **S6 — fast-lane short turns out of durable wrapping.** A ~5s chat answer gets a durable lease + 5s heartbeat CAS loop for its lifetime (`chat-turn-dispatch-service.ts:65`, `durable-run-service.ts:1207,1247`). Promote to durable only past a duration/tool-count threshold.
- [x] **Structured checkpoint compaction (ask anchoring).** *(Round 3, 2026-07-03.)* `buildConversationCompactionSummary` now pins the original ask and the latest ask ahead of the decision/failure digest, so trimmed sessions keep the objective. The digest body remains deterministic (regex) by design; LLM summarization stays unshipped.
- [ ] **Extend checkpoint-continue to code/high-intent chat** so depth isn't gated on the user picking "cowork" — chat/code are terminal, hard-stopping at their tool budgets (chat 4 loops/7 runs, code 6/12 — re-verified 2026-07-03) and reporting `completed` with an honest `degraded` sidecar (`chat-agent-budget.ts:258-260`).
- [x] **Stream idle watchdog.** *(Round 3, 2026-07-03, kill switch `streamIdleWatchdogV1Disabled`, config `assistant.streamIdleTimeoutMs`, default 120s, floor 5s.)* Per-chunk re-armed idle timer around both the primary and cross-provider-fallback stream loops (`stream-idle-watchdog.ts` + `llm-completion-service.ts`); on trip it aborts the provider request and throws a machine-readable `stream_idle_timeout` error into the existing failed-after-emit salvage path — a hang becomes a recoverable stream failure instead of an infinite spinner.

## P2 — capability / moat (2–4 weeks)

- [x] **Real sub-agent fan-out — part 1: planner-declared.** *(Round 3, 2026-07-03, kill switch `plannerFanoutV1Disabled`.)* The planner may append extra worker steps for genuinely independent subtasks (cowork only; total production hard-capped at 4; control steps protected; hostile drafts sanitized; dependency-derived stage leveling with fail-closed fallback to the template chain). Independent workers share a stage, so the engine's existing `mapWithConcurrency` (4) runs them concurrently — the default `cowork.plan.work.synthesize` template can finally fan out. *(Correction 2026-07-03: `cowork.workstreams.synthesize` and the research template already parallelized under `auto` — `router.ts:203,287-291`; the June note claiming workstreams needed explicit `parallel` was a misread.)* **Part 2 (model-callable spawn tool wired to `subagentPolicy`) remains open** — `subagentPolicy` is still consumed nowhere; defaults to `ask_when_useful`.
- [ ] **Close skill self-authoring.** `draftSkillMutation` writes a `candidate`; `isSkillCallable` needs approved/trusted; promotion is flag-OFF and background-review never files a promotion candidate, so authored skills dead-end on disk (`skill-mutation-service.ts:187-200`, `capability-system-service.ts:3215-3220`). After draft, file a promotion candidate.
- [ ] **Trusted-local governance fast-path.** For read-only loopback turns under rate limits, collapse to in-memory allow + batched async audit — keep deny-set + Wards, skip the per-call DB round-trips.
- [ ] **Warm the operator profile fast** (born empty, fills ~1 turn in 5) — `operator-profile-service.ts:120-123`.

## Done criteria
- Cowork TTFT measured **first terminal-synthesizer chunk**, not whole-turn. ✅ (S1 implementation)
- A trivial cowork turn uses a **fast model** (not the session default).
- Memory recall stops letting pseudo vectors outrank BM25. Real semantic relevance still depends on a real default embedding provider.
- Base prompt contains the live tool/skills index. ✅ (P0‑#2)

## Open follow-up — competitor-update survey (this session CAN do it)
The side-chat couldn't pull a fresh competitor diff (read-only fork, out-of-root blocked). In a full session: refresh the local Hermes and OpenClaw external review clones, then re-verify their current loop/streaming/spawn code against today's GoatCitadel for a line-anchored port map. The loop now lives under `src/agents/embedded-agent-runner/run/attempt.ts`; OpenClaw's spawn tool relocated to `sessions-spawn-tool.ts`.
