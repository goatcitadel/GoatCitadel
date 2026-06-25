# Unified Conversation Surface with Self-Improving Auto-Router — Design

- **Date:** 2026-06-24
- **Status:** Approved (design); pending implementation plan
- **Drives:** [goatcitadel/GoatCitadel#136](https://github.com/goatcitadel/GoatCitadel/issues/136) — "Promote Citadel further"
- **Related issue (dependency):** [#145](https://github.com/goatcitadel/GoatCitadel/issues/145) — Harden Code Mode execution sandbox + CI-gate the hostile-canary suite
- **Author:** design session (brainstorming)

> File/line anchors below come from a read-only exploration of the codebase and are **approximate** — verify at implementation time.

---

## 1. Problem & goal

GoatCitadel exposes three separate conversation surfaces — **chat**, **cowork**, and **code** — as distinct top-level areas. Per #136, three explicit surfaces create UI/UX confusion. The product owner's decision: **collapse them into a single surface** where the system **auto-routes** each new thread to the right mode, the user can **override**, and **overrides are recorded so routing self-improves over time** — all nested under the existing **Citadel → Workspace** hierarchy.

**Goal:** one conversation surface that (a) classifies a new thread's intent into chat/cowork/code, (b) shows its choice and lets the user override in one click, and (c) learns from overrides — without building any ML training pipeline, by reusing existing self-improvement infrastructure.

### Key insight that shapes this design

The surfaces are already ~95% one implementation, and the "self-improving router" is mostly **wiring existing infrastructure**, not greenfield work:

- The UI already renders all three modes through one component (`ThreadedSurfaceRoute`) with a `surface` prop; the composer is already mode-aware (`ThreadedComposer.tsx:23-68`).
- An intent classifier already exists to mirror: `model-router-decision-service.ts:60` (`routeWithModelRouter`) classifies prompts (incl. `DIRECT_CODING_RE`, `RESEARCH_RE`) for **model** selection.
- A home for routing decisions already exists: `runtime-decision-trace-repo.ts` has a **`"routing_choice"`** decision kind scoped to citadel/workspace/session/turn.
- A turnkey self-improvement loop already exists: `improvement-service.ts` records signals with `origin:"human"` + `outcome:"positive|negative"`, dedups by fingerprint, and runs a **weekly scheduler** that synthesizes candidates and evaluates them (`recordImprovementSignal` ~:1641, scheduler ~:423).

---

## 2. Decisions (locked)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Mode scope | **Sticky per-thread** | Classify once at thread start; mode persists until overridden. Matches today's model (mode set at session creation), keeps orchestration policy stable across a thread, lowest v1 risk. Override = re-pin the thread. |
| D2 | Classifier mechanism | **Hybrid: heuristics + LLM-judge fallback** | Obvious cases resolve instantly via patterns mirrored from the existing model-router; ambiguous first-turns escalate to a cheap fast model (Haiku). Deterministic fallback if the model call fails. Cost amortized (runs once per thread). |
| D3 | Learning scope | **Citadel-scoped** | Overrides learned within a Citadel, isolated across Citadels — matches the top-level tenancy boundary. Active workspace capabilities still feed the classifier as a **runtime signal** (not persisted learning). |
| D4 | Code + nothing bound | **Route to code, prompt to bind** | Preserve the "it knew" signal but respect the hard constraint that code mode requires a bound project + separate execution backend. If the workspace already has a default project, proceed with no prompt. |
| D5 | Override UX | **Always-visible mode chip, 1-click override, ask only on low confidence** | Zero-friction when confident; a guard rail before routing into high-stakes code execution. Every override records a learning signal. |
| D6 | Architecture | **Reuse-heavy thin layer** | One new gateway service that reads existing model-router signals, emits a `routing_choice` trace, and records overrides via the existing improvement-service. **No new tables.** Build order: heuristic path + override-recording first, LLM-judge + exemplars second. |

---

## 3. Scope

### In scope
- Collapse `chat | cowork | code` from three nav **areas** into one **surface** area; mode becomes a **field** (still deep-linkable), not an area.
- New gateway `SurfaceRouterService` (hybrid classifier) wired at the chat-turn entry seam.
- Sticky per-thread mode persisted on `chat_session_meta` (already carries `mode` + `workspace_id`).
- A `routing_choice` runtime-decision-trace per classification.
- Mode chip UI: shows the choice, 1-click override, low-confidence confirm, code+unbound bind prompt.
- Override recording as a **citadel-scoped** `human`/`negative` improvement signal (new signal `class`, no new table).
- Self-improvement: citadel-scoped exemplar retrieval into the judge prompt (fast channel) + the existing weekly job consuming override stats for heuristic tuning (slow channel).

### Out of scope (deliberately)
- **Workspace truly *owns* skills/plugins/MCP** (the global→scoped data-model migration — the other half of #136). This design only **reads** workspace capabilities as a routing signal. **Separate spec.**
- **Per-turn fluid routing** (rejected in D1).
- **Any ML training / learned weights** beyond exemplar growth + heuristic-stat tuning.
- **Code-mode sandbox hardening** — tracked in **#145** (a dependency, since this design increases code-mode traffic).
- **Phase 0 hygiene** (below) is a mechanical prerequisite, not part of this design's novelty.

### Phase 0 prerequisite (hygiene, mechanical)
- Fix the SQLite `workspaces.citadel_id` drift (Postgres has it via migration v65; SQLite schema does not).
- Make sessions consistently carry `workspace_id` + `citadel_id` so routing traces and override signals can be reliably citadel-scoped.

---

## 4. Architecture overview

A thin new gateway service sits at the existing turn-entry seam and delegates persistence/learning to existing infrastructure. Downstream mode-keyed machinery is **untouched**.

```
[mc-next unified surface]
   | first turn (mode unset)
   v
chat-turn-entry-service.ts  ──►  SurfaceRouterService  ──► routing_choice trace (runtime-decision-trace-repo)
   |   (mode now set, sticky)        |  heuristic → (low conf) LLM-judge + citadel exemplars
   v                                 └─ reads: model-router signals, workspace capabilities
[existing] resolveModePolicy → selectWorkflowTemplate → buildModeDoctrine → tool filter → (code) sandbox backend
   ^
   |  user clicks chip (override)
mc-next ──► SurfaceRouteOverrideRecorder ──► improvement-service.recordImprovementSignal(human/negative, citadel-scoped)
                                                  └─ becomes an exemplar (fast) + weekly candidate (slow)
```

---

## 5. Components

Each component has one purpose, a defined interface, and explicit dependencies.

### 5.1 `SurfaceRouterService` (new — `apps/gateway/src/services/surface-router-service.ts`)
- **Purpose:** decide the mode for a new thread.
- **Input:** first-turn text; context = `{ citadelId, workspaceId, workspaceCapabilitySummary, hasBoundProject, priorThreadMode? }`.
- **Flow:**
  1. **Heuristic pass** — reuse/mirror `model-router-decision-service.ts` signals + surface-specific patterns → `{ candidateMode, confidence }`.
  2. **LLM-judge fallback** — if `confidence < THRESHOLD`, call a fast model (Haiku) with citadel-scoped exemplars from `SurfaceExemplarStore` → `{ mode, confidence, rationale }`.
- **Output:** `{ mode: 'chat'|'cowork'|'code', confidence: number, source: 'heuristic'|'judge', rationale, alternatives }`.
- **Side effect:** emit a `routing_choice` trace via `RuntimeDecisionTraceRepository.append` (`runtime-decision-trace-repo.ts:98`).
- **Depends on:** model-router signals (read-only), `SurfaceExemplarStore`, a fast LLM provider, the trace repo. No UI, no persistence beyond the trace.

### 5.2 `SurfaceRouteOverrideRecorder` (new public wrapper on `ImprovementService`)
- **Purpose:** turn an override into a learning signal.
- **Input:** `{ sessionId, citadelId, workspaceId, fromMode, toMode, autoConfidence, promptFeatureHash }`.
- **Action:** a NEW public method `recordSurfaceRouteOverrideSignal(...)` (mirroring `recordApprovalResolutionSignal`) that builds an `ImprovementSignalInput` with `origin:'human'`, `signalClass:'runtime'`, `signalKind:'surface_route_override'`, `outcome:'negative'`, `fingerprint: surface_route_override:<citadelId>:<from>-><to>:<featureHash>`, `citadelId` in `metadata`, and calls the **private** `recordImprovementSignal`.
- **Why a wrapper:** `recordImprovementSignal` is private and `ImprovementSignalClass` is a closed union (`runtime|approval|evaluation`) — the specific type rides in the free-form `signalKind`.
- **Depends on:** `improvement-service.ts` (`recordImprovementSignal` ~:1641). No new table.

### 5.3 `SurfaceExemplarStore` (new read-side helper)
- **Purpose:** supply citadel-scoped correction examples for the judge.
- **Action:** query existing `improvement_signals` where `class='surface_route_override'` AND `scope.citadelId = X`, most recent N (recency-capped) → few-shot exemplars.
- **Depends on:** the improvement-signal store (read). No new table.

### 5.4 Entry-seam wiring (`apps/gateway/src/services/chat-turn-entry-service.ts` ~:158)
- **Purpose:** the single integration point.
- **Behavior:**
  - New thread, no client-supplied mode → call `SurfaceRouterService`, set `input.mode`.
  - Client-supplied mode differs from the recorded auto-choice (override) → call `SurfaceRouteOverrideRecorder`.
- **Invariant:** downstream mode consumers (`orchestration/router.ts` `resolveModePolicy` ~:22 / `selectWorkflowTemplate` ~:109, `base-agent-system-prompt.ts` `buildModeDoctrine` ~:106, tool filtering, code sandbox backend) are unchanged.

### 5.5 UI: unified surface + mode chip (`apps/mission-control-next`)
- **Purpose:** present the choice and let the user steer.
- **Changes:**
  - `route-model.ts:2` — collapse `PrimaryArea` `chat|cowork|code` into one `surface`; encode `mode` as a route field so deep-links to a code thread still work.
  - Unify the three per-area nav entries + rails into one (`MissionControlNextApp.tsx:100-108`, citadel/workspace selectors already at `:814-843`).
  - Mode chip in `ThreadedSurfacePage`/`ThreadedComposer` (already mode-aware) — shows the chosen mode; click → override (re-pin `chat_session_meta.mode` + emit override).
  - Low-confidence → inline confirm affordance before first send.
  - Code intent + unbound → bind-project prompt.

---

## 6. Data flow

### New thread
1. User types the first message in the unified surface (no mode chosen).
2. UI sends the turn with mode unset → entry-service calls `SurfaceRouterService`.
3. Heuristic → (maybe) judge with citadel exemplars → `{ mode, confidence }`.
4. `routing_choice` trace recorded (citadel/workspace/session/turn scope).
5. `confidence < THRESHOLD` → UI asks to confirm; else mode set silently (chip shows it).
6. `mode === 'code'` and no bound project → UI prompts to bind before execution; decline → chat for that turn.
7. Mode persisted on `chat_session_prefs.mode` (sticky; via `updateChatSessionPrefs` + `buildChatModePrefsPatch`). Auto-route is triggered by a transient `autoRoute` request flag and only fires when no mode is persisted yet.
8. Downstream existing machinery runs unchanged.

### Override
1. User clicks the chip → picks a different mode (client sends explicit `mode`, `autoRoute` off).
2. Server detects `input.mode` ≠ persisted `chat_session_prefs.mode` → re-pins prefs + records the override.
3. `recordSurfaceRouteOverrideSignal` writes a `human`/`negative` signal (citadel in `metadata`, fingerprint scoped by citadel).
4. The signal is now an exemplar for the next ambiguous thread in that citadel.

### Weekly improvement (existing scheduler)
1. Sunday job aggregates `surface_route_override` signals by citadel + fingerprint.
2. Synthesizes a candidate (e.g., "promote pattern X → code in citadel Y", or "lower threshold") → eval → human approval → apply.
3. Heuristic patterns/thresholds adjust; the exemplar set has already been growing continuously.

---

## 7. Data model & persistence

**No new tables, no migrations.** Reuse:

- `chat_session_prefs.mode` — the sticky per-thread mode (already present). Loaded each turn via `chatSessionPrefs.ensure(sessionId)`; written via `updateChatSessionPrefs(deps, sessionId, buildChatModePrefsPatch(mode))`. (Note: this is in `chat_session_prefs`, **not** `chat_session_meta`.)
- `runtime_decision_traces` (kind `routing_choice`, already a member of `RUNTIME_DECISION_KINDS`) — one row per classification, with scope `{ citadelId, workspaceId, sessionId, turnId }`, `selected`, `rationale`, `alternatives`, confidence in the rationale/payload.
- `improvement_signals` — overrides as `origin:'human'`, `signalClass:'runtime'`, `signalKind:'surface_route_override'`, `outcome:'negative'`, fingerprint `surface_route_override:<citadelId>:<from>-><to>:<featureHash>`, `metadata` storing `citadelId` + turn **features** (not full transcript).

New surface area only: a transient `autoRoute?: boolean` on `ChatSendMessageRequest`, the public `recordSurfaceRouteOverrideSignal` wrapper, the surface-routing `routing_choice` payload, and a confidence-threshold constant. (`citadelId`/`workspaceId` are derivable at turn time — no new session columns. The earlier "Phase 0 SQLite `citadel_id` drift" appears already handled by migration v121; verify, no action expected.)

---

## 8. The learning loop

Two channels, both on existing infrastructure, **zero ML training**:

- **Fast channel (continuous, automatic):** every override is immediately an exemplar; the next ambiguous thread in that citadel benefits. No human in the loop.
- **Slow channel (weekly, supervised):** the existing improvement scheduler turns override *patterns* into candidate heuristic/threshold changes, gated by eval + human approval (the `candidate → eval → apply` path already exists).

### Drift guardrails
- **Citadel isolation** — no cross-tenant pollution (D3).
- **Eval gate** on heuristic changes (existing candidate evaluation).
- **Exemplar recency-cap** — don't overweight stale corrections.
- **Confidence-gated asking** — low-signal cases get a human answer, not a guess.

---

## 9. Error handling & edge cases

| Case | Behavior |
|------|----------|
| Judge call fails/times out | Deterministic heuristic best guess, marked low-confidence so the chip invites correction. **Never blocks the turn.** |
| Ambiguous / empty first turn | Default **chat** (no execution backend), low-confidence chip. |
| Code intent, no bound project | Route to code intent but gate execution behind the bind prompt; decline → chat for that turn. |
| Override thrash (rapid flips) | improvement-service fingerprint dedup prevents signal flooding; last-write-wins on thread mode. |
| Cold-start citadel (no exemplars) | Judge runs base-prompt-only; heuristics carry it; global stats deliberately **not** borrowed (D3) — accept slightly lower early accuracy. |
| Privacy | Exemplars store turn **features**/short snippets, not transcripts; reuse improvement-service's existing secret sanitization. |

---

## 10. Testing strategy

- **Unit:** heuristic classifier (table-driven: repo path → code, "research/compare" → cowork, greeting → chat); confidence thresholding; judge-failure fallback; override fingerprinting.
- **Integration:** entry-seam wiring (mode unset → router fills; override → signal recorded + thread re-pinned); `routing_choice` trace emitted with correct scope; code+unbound → bind gate.
- **Learning:** seed N override signals in citadel A → assert retrieved as exemplars and bias a subsequent ambiguous classification; assert citadel B is unaffected (isolation).
- **UI:** chip renders the chosen mode; click overrides + records; low-confidence confirm appears; mode deep-link round-trips.
- Follow existing TDD conventions and per-package test setup (gateway vitest, storage tests).

---

## 11. Phasing / build order

- **Phase 0 (hygiene):** SQLite `citadel_id` drift fix; sessions carry `workspace_id` + `citadel_id`.
- **Phase 1 (heuristic + override recording):** unified surface UI + mode chip; heuristic-only `SurfaceRouterService`; `routing_choice` trace; override recording. Ships the "one surface" win and starts collecting real override data.
- **Phase 2 (judge + learning):** LLM-judge fallback + `SurfaceExemplarStore`; wire the weekly job to consume `surface_route_override` stats. Closes the self-improvement loop.

(#145 sandbox hardening should land before/with Phase 2, when code-mode traffic increases.)

---

## 12. Open questions / risks

- **Confidence threshold value** — pick an initial constant; tune from real `routing_choice` traces + override rates. (Implementation detail.)
- **Heuristic feature reuse** — confirm exactly which `model-router-decision-service` internals are cleanly reusable vs. need a small extracted shared helper.
- **Exemplar prompt budget** — cap exemplar count/size to bound judge latency + token cost.
- **Deep-link migration** — old `/chat|/cowork|/code` URLs should redirect to the unified surface with the right mode field.

---

## 13. Related work

- **#136** — parent ("Promote Citadel further").
- **#145** — Code Mode sandbox hardening + CI-gating the hostile-canary suite (dependency for Phase 2).
- **Separate future spec** — Workspace truly owns skills/plugins/MCP (global → workspace/citadel scoping migration).
