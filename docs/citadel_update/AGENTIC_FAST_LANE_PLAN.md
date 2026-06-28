# Plan: Close the GoatCitadel ↔ OpenClaw/Hermes agentic gap

**Status:** Active · **Date:** 2026-06-28 · **Verified against:** main `c2973e7f4`
**Sources:** [GATEWAY_AGENTIC_REVIEW_2026-06-28.md](GATEWAY_AGENTIC_REVIEW_2026-06-28.md) (5-agent audit) + a live-repo side-chat review (3 audits) + the hand-verified [GATEWAY_COMPETITIVE_TEARDOWN_2026-06-21.md](GATEWAY_COMPETITIVE_TEARDOWN_2026-06-21.md). Two of the side-chat's load-bearing claims (S1 cowork buffering, S6 durable-wrap) were re-verified by hand for this plan.

## Objective
Match OpenClaw/Hermes **speed + liveness** without losing GoatCitadel's governance edge.

## Thesis (corrected & merged)
PR #137 fixed "thin responses" by wrapping cowork in a **plan → execute → synthesize → durable → govern** pipeline. The features are now present and mostly effective — but the integration **regressed liveness**: a cowork turn runs the whole orchestration to completion and then delivers a finished string, so time-to-first-token ≈ whole-turn. The competitors win with one lean streaming loop on a fast-routed model. The fix is not more features — it's **un-bury the streaming loop** and **switch on the features we shipped dead**.

> **Correction from the side-chat review (verified):** the single biggest cowork win is **S1 — stream the terminal orchestration step**. The already-shipped P0‑#1 (notify-on-append, below) removes the chat-path 200ms poll but does **not** make cowork stream, because cowork has no model tokens to forward until `orchestrationResultPromise` resolves. S1 is still open and is the headline.

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

---

## P0 — make a single cowork turn feel alive (days, highest ROI)

- [ ] **S1 (HEADLINE) — stream the terminal orchestration step's tokens to SSE** instead of `await orchestrationResultPromise` then delivering a finished string. Verified: cowork awaits the full orchestration (`chat-turn-stream-service.ts:1314,1390-1402`), takes `finalOutput` as a complete string (`:1405`), writes it as one message (`:1430-1441`); only `trace_update` progress events stream meanwhile. Forward the final step's deltas. Gate that forces cowork/code through orchestration: `model-router-decision-service.ts:96`. **TTFT: whole-turn → first chunk. #1 win.**
- [ ] **S2 — de-block the planner.** Every cowork turn pays a mandatory ~1.5s non-streaming planner LLM, serial after prep (`chat-turn-prep-service.ts:715-820`). Run it on a fast/cheap model, truly parallel with prep, or skip for low-complexity turns. (Note: `2116cb43f` did **not** actually parallelize it — it only added a `Promise.race` timeout and lowered the bound 2500→1500ms.)
- [ ] **S3 — real fast-model routing.** `selectedEngine` (`fast_local`, …) is a trace label only; the provider call always uses the session-default model (`chat-agent-orchestrator.ts:2199-2200`). Map the labels to actual models so a trivial turn uses a cheap fast model.
- [ ] **P0‑#3 — stop pseudo-embeddings poisoning ranking, then ship a real default.** Short-term: gate the embedding term off when the provider is `pseudo` and report `lexical_recency` honestly (`candidate-ranker.ts:205-223`, `memory-context-service.ts:429`) so it stops *degrading* BM25. Medium-term: ship a real bundled local embedding default (e.g. `bge-small`/MiniLM via `@xenova/transformers`) at `local-embeddings.ts:290`, keeping pseudo only as offline fallback. Recall stack: noise → working with one dependency + a default change.

## P1 — speed depth + quality (1–2 weeks)
- [ ] **S4 — parallelize independent tool calls.** N calls from one model turn run `for…of` with `await` each = sum, not max; no `Promise.all` in the orchestrator (`chat-agent-orchestrator.ts:2619→:2730`). Use `Promise.allSettled` over side-effect-free calls behind a read-only/path-overlap safety gate.
- [ ] **S5 — per-tool IO tax off the hot path.** Each tool call does a lock-serialized `fs.appendFile` audit + 3–5 sync SQLite writes blocking the next tool (`engine.ts:1462→audit-log.ts:89`); every iteration `JSON.stringify`s the whole context for a trace receipt and regex-scans every full tool result (`chat-agent-prompt-budget-receipt.ts:16`). Batch/async the audit; gate the receipt behind a debug flag.
- [ ] **S6 — fast-lane short turns out of durable wrapping.** A ~5s chat answer gets a durable lease + 5s heartbeat CAS loop for its lifetime (`chat-turn-dispatch-service.ts:65`, `durable-run-service.ts:1207,1247`). Promote to durable only past a duration/tool-count threshold.
- [ ] **Structured checkpoint compaction.** Replace the regex keyword digest (240-char previews, original ask not re-pinned) with a latest-ask-first checkpoint (`chat-compaction.ts:7-50`). Long cowork sessions drift today.
- [ ] **Extend checkpoint-continue to code/high-intent chat** so depth isn't gated on the user picking "cowork" — chat/code are terminal, hard-stopping at 2–7 tool runs and reporting `completed` (`chat-agent-budget.ts:208-242`).
- [ ] **Stream idle watchdog** — per-chunk timeout + wedged-provider breaker (neither competitor lacks this; we do).

## P2 — capability / moat (2–4 weeks)
- [ ] **Real sub-agent fan-out.** `subagentPolicy` is a config field with zero spawning code; the `packages/orchestration` wave/ownership model proves phases are independent but still runs them one child-turn each, sequentially. Dispatch independent phases concurrently; expose a spawn primitive. Biggest capability ceiling vs a modern multi-agent design.
- [ ] **Close skill self-authoring.** `draftSkillMutation` writes a `candidate`; `isSkillCallable` needs approved/trusted; promotion is flag-OFF and background-review never files a promotion candidate, so authored skills dead-end on disk (`skill-mutation-service.ts:187-200`, `capability-system-service.ts:3215-3220`). After draft, file a promotion candidate.
- [ ] **Trusted-local governance fast-path.** For read-only loopback turns under rate limits, collapse to in-memory allow + batched async audit — keep deny-set + Wards, skip the per-call DB round-trips.
- [ ] **Warm the operator profile fast** (born empty, fills ~1 turn in 5) — `operator-profile-service.ts:120-123`.

## Done criteria
- Cowork TTFT measured **first-chunk**, not whole-turn.
- A trivial cowork turn uses a **fast model** (not the session default).
- Memory recall returns **semantically-relevant** (not lexically-overlapping) items.
- Base prompt contains the live tool/skills index. ✅ (P0‑#2)

## Open follow-up — competitor-update survey (this session CAN do it)
The side-chat couldn't pull a fresh competitor diff (read-only fork, out-of-root blocked). In a full session: `git -C F:\code\_external-review\hermes-agent fetch --unshallow` (it's a shallow clone), refresh openclaw, then re-verify their current loop/streaming/spawn code against today's GoatCitadel for a line-anchored port map. The loop now lives under `src/agents/embedded-agent-runner/run/attempt.ts`; OpenClaw's spawn tool relocated to `sessions-spawn-tool.ts`.
