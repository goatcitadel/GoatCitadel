# Competitor Update — 2026-06-28

**Scope:** Read-only re-verification of OpenClaw and Hermes streaming + agentic-loop + sub-agent spawn to validate our planned **S1** ("stream the terminal synthesizer step") via **Strategy B** (terminal synthesizer = delegated child turn; forward child deltas to parent SSE; recover-before-persist). Follows the hand-verified [GATEWAY_COMPETITIVE_TEARDOWN_2026-06-21.md](GATEWAY_COMPETITIVE_TEARDOWN_2026-06-21.md). Plan under test: [AGENTIC_FAST_LANE_PLAN.md](AGENTIC_FAST_LANE_PLAN.md).

**Repos (clones, refreshed today):**
- OpenClaw `F:\code\_external-review\openclaw` — branch `main`, HEAD `a083c766` `fix(bedrock): honor adaptive model max tokens (#97343)`, latest commit **2026-06-28 12:15 -0700**. 1098 commits since 2026-06-21.
- Hermes `F:\code\_external-review\hermes-agent` — branch `main`, HEAD `b699d27a4` (PR #54357, browser chromium autoinstall), latest commit **2026-06-28 12:36 -0500**. Fetched `--unshallow` (full history now local; 956 commits since 2026-06-21; tags through `v2026.6.19`).

Both repos are live and were committing the **same day** as this review.

---

## (a) What's new since 2026-06-21

Neither repo changed its streaming/spawn *architecture* in the window — the churn is hardening, model-catalog, and channel fixes around the same design. Relevant deltas:

**OpenClaw** (the spawn/stream-relevant commits):
- `6883c6c0` `fix: wake yielded parent after subagents finish (#97090)` and `7fc4bbc0` `fix(agents): wake active parents for subagent completions` — parent-wake-on-child-completion plumbing (confirms the **buffer→wake→announce** model, not live forwarding).
- `a0f93cf8` `fix(agents): gate subagent stream suppression` + `1876e3e1` `perf: skip per-chunk live parsing for subagents` — subagent live streams are **suppressed by default**; per-chunk parsing is skipped for subagents as a perf win.
- `9f675920` `fix(codex): stream non-final-answer assistant deltas as partials (#95404)` — only relevant to the Codex *harness* passthrough, not their own loop.
- `552ec2b4` re-arm idle timer on block-boundary events; `769579bc`/`56259606` stream-completion + truncated-tool-call guards. Streaming-robustness only.
- Many `bound … response reads at N MiB` commits (SSE OOM guards) — parity hardening, not behavior change.

**Hermes** (the stream/delegate-relevant commits):
- `8233598e6` `fix(interrupt): keep partial streamed reply when stopped mid-response` and `397270142` `fix(agent): complete final text on last turn` — confirm **show-raw-then-recover** (they keep what was already streamed; they do not gate on recover-before-show).
- `e860a40e1` / `1fa46570f` `fix(agent,gateway): surface partial-stream recovery …` — same posture, hardened.
- `211ba9c7d` `feat(agent): one-shot LLM helper + llm.oneshot gateway RPC (#51261)` and `87c4a5ebb` aux-model selector for self-improvement review — cheap-model **side-task** routing (see S3 below).
- `25b734845` inherit subagent endpoint from parent active client; `1e4df599e` strip cronjob toolset from delegated children; `7f02f30b7`/`563d347e4` "resumes when subagent finishes" status UX — all reinforce that delegated children are **awaited then summarized**, never token-forwarded.
- `3b44a3c8b`/`163cb24d4` MoA: render each reference model's output as a labelled block **before** the aggregator — a multi-model answer is shown as discrete buffered blocks, not interleaved token streams.

---

## (b) Streaming / spawn verification (file:line)

### OpenClaw

**Top-level loop streams final tokens LIVE, then recovers (show-raw-then-fix).**
- `embedded-agent-runner/thinking.ts:660-678` — `pumpStreamWithRecovery` iterates the provider stream and `outer.push(chunk)` **per chunk, immediately** (`:678`). It is forward-as-you-go.
- `embedded-agent-runner/thinking.ts:663-666` — once `yieldedOutput` is true, recovery is explicitly **skipped** "to avoid duplicate chunks." So repair is only possible *before* the first token reaches the user; after that, raw output stands. Same guard in the catch path at `:686-690`.
- `embedded-agent-runner/run/incomplete-turn.ts:236-265` — incomplete-turn handling checks `payloadCount > 0` (tokens already emitted) and, if so, **suppresses** the would-be warning rather than rewriting the answer. Recovery is a post-hoc warning payload, not a pre-stream gate.
- `embedded-agent-runner/run/attempt.stop-reason-recovery.ts:67-142` — bad stop reasons are patched **in-band on already-emitted error events**; no pre-stream interception.

**Spawned sub-agent output is BUFFERED (read from history post-completion), not token-forwarded.**
- `agents/tools/sessions-spawn-tool.ts` → returns immediately with `status:"accepted"` + child session metadata via `jsonResult(...)` (≈`:514`). The parent gets a queued-confirmation, **not** the child's tokens.
- `agents/subagent-announce-output.ts:202-236` — `readSubagentOutput` pulls the child's answer from `chat.history` / `readSessionMessagesAsync({ mode:"recent", maxMessages:100 })` **after** the child finishes, selects the final text, and returns it as **one string**.
- `agents/subagent-announce-delivery.ts` (resolveActiveWakeWithRetries) + `agents/subagent-announce.ts` — on parent-wake the frozen result is delivered **once** as a single steer/message block.

**Their one "forward the child stream" path (ACP `streamTo:"parent"`) is a coarse progress relay, NOT token passthrough.**
- `agents/acp-spawn.ts` — `streamTo:"parent"` is an ACP-only opt-in (`ACP_SPAWN_STREAM_TARGETS = ["parent"]`); for normal `run` mode it is **suppressed unless** a heartbeat relay route is active (`resolveAcpSpawnStreamPlan`, ≈`:903-930`).
- `agents/acp-spawn-parent-stream.ts:598-626` — the relay intercepts child `assistant` deltas, but then `appendVisibleProgress(delta, …)` **buffers** them.
- `agents/acp-spawn-parent-stream.ts:460-469` + `:401-416` — buffered text is whitespace-compacted, **truncated to `STREAM_SNIPPET_MAX_CHARS`**, and emitted as out-of-band **`system_event` progress notices** (`enqueueSystemEvent`) on a flush timer (~2.5s). It is a "what the child is doing" ticker, not the child's answer rendered as the user-facing reply token-by-token.

**Fast-routing (cheap model for simple turns): NOT present.**
- `agents/fast-mode.ts` + `shared/fast-mode.ts:88-112` — "fast mode" is a **time-based** gate (`resolveFastModeForElapsed`, default 60s); `enabled = mode==="auto" ? elapsedMs<=thresholdMs : mode===true`. **No model downgrade.**
- `embedded-agent-runner/run/attempt.ts` (≈`:2806`) passes `fastMode` into extra params only; the model stays `params.modelId`. No prompt-complexity classifier that picks a cheaper model. (No `router`/`triage`/`classifier` model-selection module exists.)

### Hermes

**Final turn forwards provider deltas SYNCHRONOUSLY as they arrive (no buffer-then-deliver).**
- `agent/chat_completion_helpers.py:1938-1942` — per chunk: `if delta and delta.content … if not tool_calls_acc: _fire_first_delta(); agent._fire_stream_delta(delta.content)`. Raw delta fired immediately.
- `run_agent.py:4273-4282` — `_fire_stream_delta` calls each callback synchronously then `_record_streamed_assistant_text(text)`. No accumulation buffer.

**There IS a "final step streams, intermediate steps don't" distinction — but it's text-vs-tool, not a separate synthesizer turn.**
- `agent/chat_completion_helpers.py:1940` — streaming to the user fires **only when `not tool_calls_acc`** (i.e., the model is emitting a plain text answer). While tool-call args accumulate, user-facing text is suppressed. So the "terminal/text" emission streams; tool-emitting steps don't.

**Delegated/sub-agent tokens are BUFFERED, never forwarded to the user.**
- `run_agent.py:5211-5241` — `_dispatch_delegate_task`: top-level delegates run `background=True`, sub-agent delegates run synchronously; **both return a JSON summary only**.
- `tools/delegate_tool.py` — `delegate_task(...) -> str`; children run in a `ThreadPoolExecutor`; the parent gets `json.dumps(_execute_and_aggregate())` (sync path ≈`:2599-2600`; aggregate ≈`:2477-2480`). Children's tokens never call the parent's stream callbacks.

**Incomplete-answer handling: show-raw-then-recover (keep what was delivered).**
- `agent/conversation_loop.py:4156-4179` — comment is explicit: *"If content was already streamed to the user before the connection died, use it as the final response."* Sets `_turn_exit_reason="partial_stream_recovery"`, takes `_current_streamed_assistant_text` as `final_response`, marks `_response_was_previewed=True`. It recovers what the user **already saw**; it does not gate-then-reveal.

**Fast-routing: cheap models exist, but for SIDE TASKS only — not the main turn.**
- `agent/auxiliary_client.py` — `get_text_auxiliary_client(task=…)` (≈`:4142-4164`) routes side tasks (compression, web-extract, title-gen, self-improvement review) to per-provider cheap defaults: Anthropic→`claude-haiku-4-5`, Gemini→`gemini-3-flash-preview`, etc. (`_API_KEY_PROVIDER_AUX_MODELS_FALLBACK`, ≈`:318-351`).
- The **main conversation loop always uses the user-selected model** for the final turn. There is no prompt-complexity classifier that downgrades the *user-facing* turn to a cheap model.

---

## (c) Verdict on Strategy B

**Strategy B is sound and ships a capability neither competitor has — but it is NOT a "match their pattern" move, because their pattern for the final answer is a single top-level streaming loop, not a forwarded delegated child. Keep Strategy B; the higher-leverage correction is on recovery ordering, where we should align to their proven choice.**

Three findings drive this:

1. **Neither competitor streams a delegated/sub-agent step's tokens up to the user as the answer.** Both produce the user-facing reply from **one top-level loop** (`pumpStreamWithRecovery` / `chat_completion_helpers._fire_stream_delta`) and **buffer** every delegated child into a finished string (`readSubagentOutput` from history; `delegate_task -> json.dumps`). OpenClaw's ACP `streamTo:"parent"` is the only forwarding path and it is a **truncated out-of-band progress ticker**, not token-faithful answer streaming.
   → **Implication:** Our real divergence from them is **not** "we don't forward a child's stream" — it's that **our cowork turn buffers the whole orchestration and emits a finished string** (S1: `chat-turn-stream-service.ts:1314,1390-1405,1430-1441`). Their win is simply that their terminal answer streams from one loop. So **the prize is making the terminal step stream at all** — Strategy B (child turn forwards deltas) is a *valid way to get there* and is strictly more capable than their progress-ticker, but a simpler equivalent would be to stream the synthesizer **inline in the parent loop** the way both of them do. Strategy B is justified **only if** our terminal synthesizer is genuinely a separate child turn in our architecture; if it can stream inline without the child indirection, that is closer to the competitor pattern and lower-risk. **Recommend: confirm the synthesizer is a real delegated turn before committing to forwarding plumbing; otherwise stream it inline.**

2. **Recover-BEFORE-persist diverges from both competitors, who recover-AFTER-show — deliberately.** OpenClaw refuses to retry once `yieldedOutput` is true ("skipping retry to avoid duplicate chunks", `thinking.ts:663-666`); Hermes keeps already-streamed text as the final answer (`conversation_loop.py:4156-4179`). Both optimize **time-to-first-token and no-double-render** over a clean recovered string.
   → **Implication / adjustment:** Our "let the child's answer-recovery finish BEFORE we persist the final string" must **not** hold back the *user-visible stream*. The safe shape is: **stream the child's deltas to SSE live (forward-as-you-go), and apply recover-before-persist only to the stored/durable record** — i.e., the user sees tokens immediately, and recovery reconciles the persisted message after the stream ends. If "recover-before-persist" is implemented as "buffer the child to completion, recover, *then* emit," we will have **re-introduced the exact whole-turn-TTFT regression S1 is meant to kill**, and we'd be slower than both competitors on first token. **This is the one place to adjust: decouple persist-recovery from stream-emission; never gate first-token on recovery.**

3. **The progress-ticker is the only thing worth borrowing, and we already have it.** OpenClaw's `enqueueSystemEvent` snippet relay (`acp-spawn-parent-stream.ts`) maps to our existing `trace_update` progress events. We don't need to adopt anything new there.

**Net:** Strategy B — *forward the terminal child's token deltas to the parent SSE* — is **confirmed as the correct direction and is more capable than either competitor's delegated-output handling.** Two guardrails: (i) prefer inline streaming of the synthesizer if it isn't truly a separate child turn (lower risk, matches their single-loop pattern); (ii) **recover-before-persist must apply to the persisted record only — emit the child's tokens to the user live, or you reproduce the buffering regression you're removing.**

---

## (d) Fast-routing confirmation for S3

**Confirmed: there is NO main-turn cheap-model routing in either competitor** — which means S3 ("real fast-model routing": map `selectedEngine` labels to actual cheap models, `chat-agent-orchestrator.ts:2199-2200`) is a **genuine differentiator if we ship it on the user-facing turn**, not just catch-up.

- **OpenClaw:** "fast mode" is purely **time-based**, same model throughout (`shared/fast-mode.ts:88-112`). No complexity classifier, no model downgrade.
- **Hermes:** cheap models (Haiku 4.5 / Gemini-3-Flash) are wired **only for side tasks** via `get_text_auxiliary_client` (`auxiliary_client.py:318-351, 4142-4164`); the main turn keeps the user's selected model. The `llm.oneshot` RPC (`#51261`) is a helper for one-off auxiliary calls, not main-turn routing.

**Guidance for S3:** Hermes' `auxiliary_client` per-provider cheap-default table is a clean **pattern to mirror for our auxiliary/planner work (S2)** — a per-provider "fast model" map keyed by task. But for S3 proper (downgrading a *trivial user turn* to a cheap fast model) **neither competitor does it**, so it is upside, not parity, and worth doing carefully (a misclassified hard turn on a cheap model is a visible quality regression — gate it conservatively).

---

### One-line verdict
**Strategy B confirmed (correct direction, more capable than competitors) — with one required adjustment: keep the user-visible stream forward-as-you-go and apply recover-before-persist to the persisted record ONLY, so first-token isn't gated on recovery. S3 main-turn fast-routing is a differentiator, not catch-up (neither competitor routes the user turn to a cheap model).**
