# GoatCitadel External Review — Claude Code First-Pass Report

**Date:** 2026-04-22
**Reviewer:** Claude Code (local checkout: `F:\code\personal-ai`)
**Brief:** `docs/review/REVIEW_MASTER_BRIEF.md`
**Prompt:** `docs/review/CLAUDE_CODE_FIRST_PASS_PROMPT.md`
**Scope:** Full repo, evidence-first, architecture-first, adversarial posture.

---

## 1. Executive Summary

GoatCitadel is farther along than the codebase size suggests, and weaker in exactly the places the docs claim are strongest. The runtime is workable, the contracts are honest about being additive, the storage layer genuinely owns its semantics, and the policy engine is one of the cleanest pieces of the system. None of those are the risk.

The risk is that **the story of "decomposed services with clear ownership" is only partially true**. `apps/gateway/src/services/gateway-service.ts` is still **15,248 lines with ~487 public methods** and 29 fields marked `/** @internal */ public` (i.e. nominally private, actually reachable by every route and extracted service). Routes call `fastify.gateway.*` directly at **~505 sites across 50 files**. Extracted services (`approval-lifecycle-service.ts`, `chat-turn-entry-service.ts`, `chat-turn-stream-service.ts`, etc.) still make **21 – 77 `host.*` callbacks each** back into that god-object. The only service that truly owns its state is `durable-run-service.ts` (0 host callbacks, private fields, narrow context). That is the exception, not the rule.

The UI story is similar: `apps/mission-control-next` is the default runtime surface, but `apps/mission-control` is still buildable, and a ~2,237-line `NativeRoutePages.tsx` co-locates Library/Ops/Cowork re-implementations behind its own `eslint-disable max-lines` with a comment that says the rewrite "settles". Parity with the legacy UI is **incomplete** for approvals, memory, cowork, settings, and activity surfaces, and the legacy-route adapter still translates `?space=operate&page=...` on every navigation — meaning the legacy URL surface is still the de-facto reference.

Declared-vs-actual: the `CANONICAL_RUNTIME_STATE_MODEL.md` describes an architecture that assumes the decomposition is already done. It does not acknowledge the 15k-line Gateway. It describes `approval_wait_runs` as "canonical wait mapping, not execution truth" — a distinction that exists only as code discipline, not as a DB or service-level constraint. It names `MemoryLifecycleService` as "the" operator-facing owner when `MemoryContextService`, `ChatLearnedMemoryService`, and `MemoryMaintenanceService` all have independent public surfaces.

The verification harness is competent for **additive contract shape** and **happy-path lifecycle**, but proves almost nothing about concurrency, TTL boundaries, multi-instance event ordering, graceful degradation, or cross-surface functional parity. A green run means "feature shapes have not regressed", not "system is sound under load".

**Bottom line:** this repository is roughly a `0.85` that is being told it is a `1.0`. Shipping at 1.0 is defensible if you accept that:
1. The gateway is a single oversized file under actively paused decomposition.
2. `mission-control-next` is primary but not complete.
3. Verification gates don't prove reliability, only additive shape and happy-path.
4. Concurrency, TTL, and replay-under-failure are largely untested.

This report catalogs the specific places those four truths show up in code.

---

## 2. Top Priority Findings (by severity)

### 2.1 `critical` · Gateway service is decomposed in form, not in authority
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `apps/gateway/src/services/gateway-service.ts` is **15,248 lines** (verified `wc -l`). ~487 public methods. 29 fields declared `/** @internal */ public` — i.e. documentation says "internal", TypeScript access is fully public, routes and extracted services both reach into them. Private mutable state remains centralized: `realtime` `EventEmitter`, `chatTurnExecutionRegistry`, `operatorSummaryCache`, `backgroundTasks` set, `maintenanceScheduler` timer, `chatMessageProjectionBackfillAttempted`, `warnedOutsideRootPathFingerprints`, `lastChatStreamPurgeAt`, etc. (around `gateway-service.ts:1442–1495`). Extracted services accept `host: GatewayService` (memory describes the pattern) and make callbacks back:
  - `approval-lifecycle-service.ts`: 59 `host.*` call sites
  - `chat-turn-entry-service.ts`: 77
  - `chat-turn-stream-service.ts`: 73
  - `chat-turn-dispatch-service.ts`: 35
  - `chat-turn-prep-service.ts`: 21
  - `durable-run-service.ts`: **0** — the only true extraction (private state, narrow `DurableRunServiceContext`).
  `service-context.ts` self-describes as *"Transitional shared dependency bag for services that still need more than a tiny local contract"* (`apps/gateway/src/services/service-context.ts:8–13`); the file itself admits this is not the target architecture.
- **Why it matters:** Extracted services are stateless coordinators that request permission back from the host. You cannot instantiate `ApprovalLifecycleService` without either the real `GatewayService` or a mock that implements 20+ methods. Bug surface is still "read two files plus the god-object". Testing in isolation is not supported.
- **Affected subsystems:** every subsystem touched by gateway (chat, approvals, memory, orchestration, durable, channel-setup, MCP admin, companion session, device access).
- **Likely root cause:** delegation-first extraction pattern (move method body, replace with `return xxxService.foo(this, ...)`) preserves the original ownership by construction. The promotion step (`/** @internal */ public`) is the tell: real decomposition would have narrowed contracts, not widened access.
- **Recommended action:** stop counting "services extracted" and start counting (a) `host.*` call sites per service and (b) private state moved. Gate further extractions on *reducing* `host.*` count, not just moving code. Use `DurableRunService` as the model. Accept that 8h/8i/8k-style extractions are producing smaller files but not smaller authority.

### 2.2 `high` · Routes are mounted directly onto the god-object
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `fastify.gateway.*` is called at ~505 sites across ~50 route files. Top methods called from routes include `storage`, `isDevDiagnosticsEnabled`, `isFeatureEnabled`, `createApproval`, `touchRealtimeStreamLease`, `listRealtimeEvents`, `createChatSession`, `updateSettings`. Example: `apps/gateway/src/routes/agents.ts:85,95,104,116,130,143,152,164,178,191,200,214` each invoke `fastify.gateway.<businessMethod>` directly. There is no HTTP adapter / command bus / per-domain facade between transport and business.
- **Why it matters:** Routes decide error shape, cursor encoding, SSE envelope, and in some places even mutate user args (see 2.6). If you ever want to swap the gateway (second process, different binary, remote), you have to rewrite the routes layer at the same time.
- **Likely root cause:** the `fastify.gateway` decorator was convenient early, and every new capability added a new public method. The surface is the union of all features, not a contract.
- **Recommended action:** freeze new additions to `GatewayService`'s public surface. New capabilities land on an extracted service and routes call that service directly. Progressively deprecate `fastify.gateway.*` call sites in favor of narrowly-injected services.

### 2.3 `high` · Error envelope is fragmented; clients cannot rely on a single shape
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `_error-handler.ts:10–23` declares the intended normalization via `GoatError.toJSON()`. It is inconsistently applied:
  - `apps/gateway/src/routes/chat.messages.ts:141, 153, 275, 321, 409` use ad-hoc `reply.code(400).send({ error: "..." })`.
  - `apps/gateway/src/routes/approvals.ts:95, 114, 136`, `orchestration.ts:85, 94, 103` use `sendRouteError()`.
  - `apps/gateway/src/routes/memory.ts:105–110, 140, 153, 280` mix both patterns.
  - `apps/gateway/src/routes/tools-invoke.ts:56–59, 67–74` uses `{ error, details }` bespoke shape for guardrail denials.
- **Why it matters:** Mission Control (legacy and next) must branch on error shape. The `ApiRequestError.parse*` logic in the client becomes defensively tolerant, which hides real shape regressions.
- **Recommended action:** mandate `sendRouteError()` in all route catch blocks, make the service layer throw `GoatError` subclasses (never raw `Error`), and make Fastify error handler the only shape-normalizer.

### 2.4 `high` · No scheduled TTL enforcement on memory items — silent retention past expiry
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `apps/gateway/src/services/memory-lifecycle-service.ts` and `packages/storage/src/memory-item-repo.ts` store `expires_at` and `ttl_override_seconds`, but no daily job prunes expired items. The daily `memoryFlush` cron (`gateway-service.ts:3117`, `MEMORY_FLUSH_DAILY_JOB_ID`) prunes **context packs**, not items. Items past their TTL remain visible and retrievable until an operator manually forgets them or maintenance runs over them.
- **Why it matters:** "Memory expires after N days" is something operators will assume. If a learned secret or an outdated policy lives past expiry, it leaks into prompt contexts indefinitely. This is a privacy / freshness / trust issue disguised as an operational detail.
- **Recommended action:** add a scheduled sweeper (`memory_items.expired_at < now()`), emit a `memory_item_expired` realtime event, and surface the count on the Memory page. Until then, document the gap on the Memory page explicitly rather than implying items auto-expire.

### 2.5 `high` · Approval concurrency is untested; idempotency is aspirational
- **release_tier:** `shipped` · **certainty:** `runtime-validation-needed` · **confidence:** `high`
- **Evidence:** Every approval test in `apps/gateway/src/services/approval-lifecycle-service.test.ts` runs serially. The verification harness `operator-proof.api.chat-code-mode-lifecycle` (`scripts/verification/lib/scenarios.mjs:914–968`) seeds one approval at a time, resolves once. There is no scenario, unit or integration, that exercises two simultaneous `approval.resolve(approvalId)` requests, or two approvals landing on the same durable run wake, or a browser tab + companion session racing to resolve the same pending action. `mutation-idempotency-repo.ts` exists (see 1_0_RELEASE_EVIDENCE.md line 46) but it is not demonstrated on approvals.
- **Why it matters:** Production hits two-tab scenarios immediately. `pendingApprovalActions` + `approval_effects` + `approval_wait_runs` form a three-table state machine that only works under strict serialization. A concurrent double-resolve could re-enqueue effects and double-wake a durable run.
- **Recommended action:** add a focused concurrency scenario under the `operator-proof` lane: fire N>1 `approval.resolve` in parallel on the same approval ID, assert exactly one succeeds, exactly one set of effects is persisted, exactly one wake event is emitted.

### 2.6 `high` · Cross-surface UI parity is incomplete; `NativeRoutePages.tsx` is the honest marker
- **release_tier:** `shipped` (current primary UI) · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx` is a single ~2,237-line component with a file-level `/* eslint-disable max-lines -- Native route shells intentionally co-locate next-native Library/Ops/Cowork views while the surface rewrite settles. */` (line 1). It re-implements approvals, library, cowork, ops, and settings surfaces in one file while the legacy app keeps them as separate pages. Specific drift:
  - Approvals: `NativeRoutePages.tsx:1452` calls `fetchApprovals("pending")` — one status. Legacy `apps/mission-control/src/pages/ApprovalsPage.tsx:70–76` fetches pending, approved, rejected, and edited, plus `fetchApprovalReplay` and `resumeDurableRun`. The next-UI approvals experience is strictly weaker.
  - Approval count: `NativeRoutePages.tsx:1500` uses `String(data.approvals.length || pendingApprovals)` — falls back to dashboard count when list is empty. Two sources, no reconciliation.
  - Memory write confirmation: `NativeRoutePages.tsx:854` toasts `"Memory file updated."` on `uploadFile()` success. There is no corresponding domain event in `packages/contracts/src/monitoring.ts` (no `memory_updated` `RealtimeEventType`). The toast is optimistic and decoupled from backend confirmation.
- **API client duplication:** `apps/mission-control/src/api/client.ts` and `packages/mission-control-shared/src/api/client.ts` both exist (~1056 / ~1058 lines). `mission-control-next` imports from the shared copy; the legacy app still has its own local copy. Two copies, near-identical, no enforcement that they stay in sync.
- **Legacy route adapter still live:** `apps/mission-control-next/src/app/legacy-route-adapter.ts` translates `?space=operate&page=approvals` → `{ area: "ops", section: "approvals" }` on every navigation (`MissionControlNextApp.tsx:121`). Legacy URL space is still the reference.
- **Why it matters:** The 1.0 contract says mission-control-next is primary. Primary implies feature parity. Approvals, memory admin depth, cowork board, and settings subsurfaces are visibly shallower in next.
- **Recommended action:** either (a) finish the rewrite and mark legacy deprecated with a build-time warning, or (b) honestly describe the dual-shell model in docs and release evidence. Right now the docs imply (a) while the code reflects (b).

### 2.7 `high` · Verification harness is happy-path and serial; "green" does not imply reliability
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `scripts/verification/run.mjs` + `scripts/verification/lib/scenarios.mjs` enumerate ~130 scenarios across 11 lanes. Coverage is heavily skewed to:
  - Additive REST/SSE contract shape (`runApiCompatibilityLane`, `scenarios.mjs:1877–1935`) — proves shape, not behavior.
  - Visual pixel regression on 13 next-UI routes × 4 variants (`runVisualRegressionLane`, `scenarios.mjs:2298–2417`) — proves render, not interaction.
  - Happy-path approval creation and resolution (`runOperatorProofLane`, `scenarios.mjs:824–1400`) — one at a time.
  - Single-instance durable restart (`runDurableRecoveryLane`, `scenarios.mjs:1409–1507`) — tests orphan restart, doesn't test poison checkpoint, retry exhaustion inside recovery, or concurrent worker claim.
  No lane asserts: SSE sequence continuity across restart, memory TTL boundary, UI→backend event causality, connector 401 / timeout / partial-catalog handling, two-tab approval race, cross-surface functional parity (legacy action → same backend mutation as next action).
- **Baseline failure accounting:** Recent git history implies there are 22 baseline test failures treated as known (documented in plan memory). The harness does not encode them as allowlisted — `scenarios.mjs` has no `known_failure` status path. These 22 are either being absorbed into `degraded`/`not_configured`/`skipped` statuses or are passing on CI and failing only locally. Either way the release evidence doesn't currently carry them.
- **Why it matters:** "All gates green" is being used as a release signal. The gates don't cover the actual reliability-critical paths.
- **Recommended action:** add the five scenarios listed in §6 (below) before calling the harness "sufficient for 1.0". Formalize the baseline failure allowlist with reasons and expiry dates.

### 2.8 `medium` · Pagination cursor semantics are duplicated in routes, not owned by storage
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** Routes build their own cursors:
  - `apps/gateway/src/routes/chat.sessions.ts:140–142` composes `${last.updatedAt}|${last.sessionId}`.
  - `apps/gateway/src/routes/events.ts:43` uses sequence number directly.
  - `apps/gateway/src/routes/tasks.ts:91` mirrors chat sessions.
  - `apps/gateway/src/routes/mesh.ts:172–174` and `sessions-list.ts:43–48` add their own variants.
- **Why it matters:** If cursor format changes, five route files must change together. `session-repo.ts:87–100` already implements keyset pagination correctly inside the repo — the routes are duplicating that logic instead of consuming a `{ items, nextCursor }` from the repo.
- **Recommended action:** move cursor encoding into storage repos. Routes should only pass an opaque `cursor?: string` through.

### 2.9 `medium` · Storage owns semantics, but three of the most important repos are untested
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `packages/storage/src/realtime-event-repo.ts` is 537 lines and owns event classification (`__gcEventClass`, `__gcEventAuthority`), envelope embedding (`realtime-event-repo.ts:356–378`), sequence allocation in transaction (`realtime-event-repo.ts:34–83`), automatic pruning on every 100th append (`realtime-event-repo.ts:138–140`), and inference of missing metadata (`realtime-event-repo.ts:456–484`). **There is no `realtime-event-repo.test.ts`**. Similarly `chat-turn-trace-repo.ts` encodes ~14 JSON fields and a set of string-typed enums (`branch_kind`, `mode`, `web_mode`, `memory_mode`, `thinking_level`) without CHECK constraints or tests.
- **Why it matters:** `CANONICAL_RUNTIME_STATE_MODEL.md:136` says "Realtime events are not the authoritative historical record." But the repo is the authoritative *for what they are* — and the envelope/linkage/sequence-allocation logic is enforced only by convention. If a future refactor changes inference rules, no test catches it.
- **Recommended action:** add focused tests:
  - `realtime-event-repo.test.ts`: envelope round-trip, `eventClass`/`eventAuthority` inference for each event type, sequence monotonicity under simulated concurrent append, pruning at boundary.
  - `chat-turn-trace-repo.test.ts`: enum round-trips, JSON field serialization for `routing`/`reflection`/`orchestration`/`failure`.

### 2.10 `medium` · Dialect leakage from storage is one-of-a-kind but real
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `packages/storage/src/memory-context-repo.ts:276–285` implements `buildNullableMatchSql()` that emits different SQL for `postgres` (`IS NOT DISTINCT FROM`) vs SQLite (`IS`). This is the only repo in the tree that does it explicitly. Other repos either rely on consistent non-null semantics or happen to be dialect-portable by coincidence.
- **Why it matters:** The moment a second repo needs nullable-column equality, someone will either reinvent this helper or get the semantics wrong in one dialect. The abstraction belongs on the `DatabaseClient`, not inside a domain repo.
- **Recommended action:** hoist `nullableMatch(column, param)` onto the shared DB client interface. Grep the repo directory for any other `IS NOT DISTINCT FROM` / `IS NULL` branching.

### 2.11 `medium` · Tools-invoke route mutates user args with `__gcSafety`
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `apps/gateway/src/routes/tools-invoke.ts:50–84` runs `evaluateDeploymentProfileToolAccess()` and `evaluateComputerUseSafety()` in the route layer, then **mutates** the user-supplied args to inject `__gcSafety` fields before calling `gateway.invokeTool()`.
- **Why it matters:** Safety layer coupling in routes means the same safety contract must be re-implemented for any future non-HTTP caller (SDK, MCP, background worker). Args mutation is also a red flag for round-tripping — whatever echoes back in approval previews may now contain the synthetic `__gcSafety` namespace.
- **Recommended action:** move safety evaluation inside the gateway / tool coordinator. Route should only carry transport concerns.

### 2.12 `medium` · MCP has a first-use-approval gate that built-in tools and comms connectors lack
- **release_tier:** `shipped` · **certainty:** `confirmed` · **confidence:** `high`
- **Evidence:** `apps/gateway/src/services/tool-invocation-coordinator-service.ts:357` checks server-level `requireFirstToolApproval` for MCP servers. Built-in tools and comms/connector tools do not have an equivalent "first time this tool is used, explicit approval required" gate — their approvals are purely risk-level-driven. This is a **deliberate** asymmetry (MCP servers are user-configured and untrusted; built-in tools are bundled and curated). But the asymmetry is not documented anywhere.
- **Why it matters:** Operator mental model of "approval" becomes inconsistent. The UI must explain why a brand-new Slack action doesn't prompt the same way a brand-new MCP tool does.
- **Recommended action:** document the asymmetry in `docs/1_0_CONTRACT.md` or the handbook, or introduce a lightweight first-use gate for connector tools too.

---

## 3. Architectural / Systemic Concerns

### 3.1 "Extraction" is an overloaded word in this repo
The Step 8 series in the plan memory treats moving ~70–1000 lines of code into a sibling file as "extraction". Under the pattern actually used (`export` pure helpers; promote private members to `/** @internal */ public`; leave public method signatures intact; replace method body with `return xxxService.foo(this, ...)`), **ownership does not move**. What moves is text. The host still owns state, the host still owns the public API, and callers (routes, other services) still call the host. `DurableRunService` is the only extracted service in the tree that took state with it, accepts a narrow context, and does not call back. That is what extraction should look like. The rest is code-organization hygiene, which is valuable — but it should not be mistaken for an architectural change, and release docs should not imply otherwise.

### 3.2 The "host" interface pattern hides coupling
Every extracted service declares a local interface like `ApprovalLifecycleHost` as `Pick<>` of `GatewayService`. In practice these picks contain 20–40 members each. The types shrink but the dependencies don't. The test surface of each service is the union of its host picks, and because those picks are structural, TypeScript can't tell you at compile time when the required surface grew. Consider generating host-surface metrics per extracted service as part of CI (method count, property count, delta over time). If the number is trending up, the service is *less* isolated than it was.

### 3.3 Routes are the effective business-layer API
Because the gateway surface is so wide and routes reach into it directly, the routes layer is where you see the actual business-level API of the system. That's where error shapes get decided, where cursors are composed, where arg mutations happen, where deprecation 410s are hardcoded. This is backwards for a backend of this size: the service layer should be the API, and routes should be transport. The cost is duplication (see pagination in §2.8) and inconsistency (see error envelope in §2.3).

### 3.4 Invariants enforced by convention, not by code
Multiple claims in `docs/CANONICAL_RUNTIME_STATE_MODEL.md` describe invariants that depend on everyone writing correct code:
- "`approval_wait_runs` remains a canonical wait mapping, but it is not canonical execution truth" — no DB constraint, no service guard, no test prevents a future caller from treating a wait-run row as execution truth.
- "Protected approval/session/task/orchestration/auth-device event types must fail loudly when explicit metadata is omitted" — enforced via host interface shape, not via `RealtimeEventRepository` input validation. A future caller that reaches the repo directly can publish without metadata.
- "MemoryLifecycleService is the operator-facing lifecycle owner" — but `MemoryContextService.compose()` and `ChatLearnedMemoryService` are independently callable.
These are fine *as aspirations*. They are not fine as *claims* in release evidence. The fix is either to enforce them in code (Zod validation at repo boundary, runtime assertions, linters) or to soften the docs.

### 3.5 Feature flags without workspace scoping
`memoryLifecycleAdminV1Enabled`, `memoryMaintenanceV1Enabled`, `durableKernelV1Enabled`, `chatAutoPromoteEnabled`, and similar flags are global (`apps/gateway/src/services/memory-lifecycle-service.ts:113` is a representative example). For a local-first / single-operator tool this is fine. For any multi-workspace or multi-tenant future it is not — a flag flipped for ops visibility affects every workspace simultaneously. Document the scope assumption explicitly so the flags don't get stretched beyond their design.

### 3.6 Policy engine is the bright spot
`packages/policy-engine/src/engine.ts:437–548` (`evaluateAccessInternal`) is the single enforcement point for built-in tools, MCP tools (wrapped as `"mcp.invoke"` pseudotool in `tool-invocation-coordinator-service.ts:134–160`), and comms connectors (`tool-executor.ts:162–195`). Auth mode is orthogonal to policy (grep shows no auth-mode references in `engine.ts`). Secrets are enforced at the boundary via `authContext.secretRefs` (`tool-executor.ts:60–66`). This subsystem should be held up as the model for the other extractions.

---

## 4. Declared Model vs Actual Runtime

Per the brief, each of the six canonical entities is compared declared-vs-actual.

### 4.1 Session
- **Declared** (`docs/CANONICAL_RUNTIME_STATE_MODEL.md:21–33`): "durable identity for an ongoing exchange", authority = contract + `chat-session-meta-repo.ts`, durability = "transcript log plus transcript outbox".
- **Actual:** `apps/gateway/src/services/chat-session-service.ts` queries five repositories for a single logical session (`sessions`, `chatSessionMeta`, `chatSessionPrefs`, `chatSessionProjects`, `chatGeneratedArtifacts`). Durability is JSONL append-only under `data/transcripts/<sessionId>.jsonl` plus SQLite indexing. There is no distinct "transcript outbox" entity.
- **Divergence:** Terminology mismatch. The durability guarantee holds (appends are atomic, indexing is eventually consistent). The word "outbox" in the doc does not correspond to a table or module.
- **Severity:** low — it's a naming issue, but a reader using the doc as a map will not find the outbox.

### 4.2 Turn
- **Declared:** (`CANONICAL_RUNTIME_STATE_MODEL.md:35–45`): authority = `chat-turn-trace-repo.ts`; may create or resume one or more runs.
- **Actual:** Turn authority is **split** across four services: `chat-turn-entry-service.ts` (public entry), `chat-turn-prep-service.ts` (preparation), `chat-turn-dispatch-service.ts` (routing/durable decision), `chat-turn-stream-service.ts` (SSE execution). The trace repo is storage, not authority; it receives rows but doesn't own the lifecycle.
- **Divergence:** Doc underspecifies. A reader would look in the trace repo for turn execution logic and not find it.
- **Severity:** medium — affects any new contributor trying to understand the turn lifecycle.

### 4.3 Durable Run
- **Declared:** (`CANONICAL_RUNTIME_STATE_MODEL.md:47–72`, `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md`): durable execution "owns worker startup, retry scheduling, wake/resume, dead-letter recovery, approval wait/resume, approval-linked proactive wakes, and durable-linked chat-turn stream resumption".
- **Actual:** `DurableRunService` (`apps/gateway/src/services/durable-run-service.ts:44–150+`) genuinely owns worker lifecycle, lease-based claim (15s TTL, 5s heartbeat at lines 27–30), `reconcileRecoverableRuns`, `drainQueuedRuns`, `requestRunProcessing`. It does **not** own chat-turn stream resumption — that lives in `chat-turn-dispatch-service.ts` and `chat-turn-entry-service.ts`. DurableRunService owns the *run* lifecycle; chat-turn services own the *stream* lifecycle.
- **Divergence:** Doc conflates run-level ownership with stream-level execution. A reader following the doc will look for stream resumption inside `DurableRunService` and find nothing.
- **Severity:** medium — the verification evidence at `1_0_RELEASE_EVIDENCE.md:31,33` cites `chat-turn-dispatch-service.ts` and `gateway-service.ts` without line numbers, and the chain doesn't actually route through `DurableRunService` for stream resumption.

### 4.4 Approval
- **Declared:** (`CANONICAL_RUNTIME_STATE_MODEL.md:74–104`): authority = `approval-repo.ts`, effects = `approval-effect-repo.ts`; "`approval_wait_runs` remains a canonical wait mapping, but it is not canonical execution truth".
- **Actual:** `ApprovalLifecycleHost` (`apps/gateway/src/services/approval-lifecycle-service.ts:56–120`) spans approvals, approvalEvents, pendingApprovalActions, remoteActionTokens, audit, approvalWaitRuns, approvalEffects, chatInlineApprovals — seven repositories. The status machine is enforced at the SQL layer in `approval-repo.ts:69` (`status = 'pending'` guard on transitions). Linkage extraction has triple fallback (explicit column → payload → preview at `approval-repo.ts:216–240`).
- **Divergence:** The "wait mapping is not execution truth" invariant is unreached by any code or test. It is a convention.
- **Severity:** high for the invariant; low for the rest of approval ownership.

### 4.5 Realtime Event
- **Declared:** (`CANONICAL_RUNTIME_STATE_MODEL.md:106–140`): classification = `eventClass` ∈ {domain_fact, operational_signal, ui_notification} × `eventAuthority` ∈ {retained_stream, durable_history, derived_projection}; "repository inference is legacy compatibility-only"; "protected event types must fail loudly when explicit metadata is omitted".
- **Actual:** `packages/storage/src/realtime-event-repo.ts:356–378` owns envelope embedding, `:34–83` owns sequence allocation, `:456–484` still has inference logic for `eventClass`/`eventAuthority` based on pattern-matching event type + source. Publishers like `durable-run-service.ts:32–37` build `buildDurableRealtimeOptions()` with explicit metadata. But the repo will still accept an event with missing metadata and infer — it does not "fail loudly".
- **Divergence:** "Fail loudly" is not implemented. Inference is supposedly legacy, but it is the current behavior.
- **Severity:** medium — a missing linkage on a protected event type will silently hit inference fallback and produce a technically-valid but semantically-wrong record.

### 4.6 Memory Context
- **Declared:** (`CANONICAL_RUNTIME_STATE_MODEL.md:191–210`): "`MemoryLifecycleService` is the operator-facing lifecycle owner for context composition, learned-memory entry points, maintenance policy/run orchestration, memory item list/edit/forget/history".
- **Actual:** Coordination exists — `MemoryLifecycleService` pulls in `MemoryContextService`, `ChatLearnedMemoryService`, `MemoryMaintenanceService`. But the collaborators have independent public surfaces:
  - `MemoryContextService.compose()` is called by gateway-service.ts for turn-time context assembly, not routed through `MemoryLifecycleService`.
  - `ChatLearnedMemoryService` is called on turn completion by `gateway-service.ts:3721`.
  - Memory items have no scheduled TTL enforcement (§2.4).
- **Divergence:** "Sole operator-facing owner" overstates. It is the operator-facing *admin* owner. Runtime memory flows through the collaborators directly.
- **Severity:** medium — a reader implementing a new memory flow through `MemoryLifecycleService` because the doc says to, will produce a layered call that the existing runtime doesn't use.

### 4.7 Summary table

| Entity | Declared owner | Actual owner(s) | Code-enforced? | Drift severity |
|---|---|---|---|---|
| Session | `chat-session-meta-repo` + transcripts | 5 repos + JSONL; "outbox" term not grounded | Partial | Low |
| Turn | `chat-turn-trace-repo` | 4 services + trace repo | Convention | Medium |
| Durable run | Durable execution "owns … stream resumption" | Run lifecycle in `DurableRunService`; stream in chat-turn-* | Partial | Medium |
| Approval | `approval-repo` + effects repo; wait ≠ execution truth | 7 repos; wait/truth boundary = convention | SQL-level for status; convention for wait | High (for invariant) |
| Realtime event | Repo owns envelope; protected types fail loudly | Repo owns envelope; inference still present | No | Medium |
| Memory context | MemoryLifecycleService "the" owner | Three collaborators with independent public surfaces | No | Medium |

---

## 5. UI/UX-to-System Drift

### 5.1 `mission-control-next` is primary in runtime but not in completeness
`pnpm dev:ui` resolves to `mission-control-next`, but both apps remain buildable (`dev:ui:current` and `dev:ui:legacy` coexist in top-level `package.json:21–24`). The legacy-route adapter is still active; old URLs still land. No build-time deprecation warning, no enforced cut-over date.

### 5.2 Parity table (next vs legacy)

| Domain | In next | In legacy | Drift |
|---|---|---|---|
| Chat threaded | `ThreadedSurfaceRoute` + `MissionThreadedControllerHost` from shared core | `ChatPage` using same shared core | **Minor** — core is shared |
| Approvals | Read-only list, pending-only, no bulk ops | Full replay, resume durable run, 4 statuses, bulk resolve | **High** |
| Memory | File browser + upload + inline preview | Full admin surface, maintenance, item history | **Medium** |
| Activity / Ops | Summary cards | Dedicated pages (`ActivityPage`, `HealthPage`, `CostConsolePage`, `LlamaCppPage`) | **High** |
| Settings | Native skeleton | Full integration wizards, channel setup, MCP admin, tool grants | **Very high** |
| Library / Agents | Read-only list + archive/restore | Full CRUD, catalog import, specialization | **High** |
| Cowork / Tasks | List + status | Kanban, drag-drop, filtering, bulk ops | **Very high** |

### 5.3 Shared packages
- `packages/mission-control-shared`: the API client is genuinely shared (both apps import it). UI components and hooks are partially shared, but **legacy has a parallel `UiPreferencesProvider` in `apps/mission-control/src/state/ui-preferences.ts` distinct from the shared one**. Duplication is not strictly enforced away.
- `packages/threaded-surface-core`: this is real shared ownership. `MissionThreadedControllerHost` is a single 86KB component imported by both apps. It is monolithic (reducing it further is out of scope for 1.0), but ownership is honest.

### 5.4 Optimistic UI claims decoupled from backend events
- `NativeRoutePages.tsx:854`: `"Memory file updated."` toast on `uploadFile()` resolution. No `memory_updated` `RealtimeEventType` exists (`packages/contracts/src/monitoring.ts`). The UI claims persistence that the backend doesn't confirm over SSE.
- Approval count (`NativeRoutePages.tsx:1500`): falls back between `data.approvals.length` and a dashboard count. If those disagree, the UI silently picks one. No error signal.
- Cursor mismatch: `NativeRoutePages.tsx:1452` fetches only `pending` approvals; legacy fetches four statuses. A user who resolves an approval and navigates between surfaces sees different counts.

### 5.5 API client dual-maintenance risk
`apps/mission-control/src/api/client.ts` (~1056 lines) and `packages/mission-control-shared/src/api/client.ts` (~1058 lines) are two copies. `mission-control-next` uses the shared one; legacy uses its local one. There is no test or linter enforcing equivalence. The memory plan describes a Step 9 that moved pure helpers out of `client.ts` into `http-internal.ts`, but did not deduplicate the two clients.

---

## 6. Risky "Looks Fine But Isn't" Areas

### 6.1 Step 8 line-count metric
The decomposition plan's scorecard is lines-of-file. Lines are going down (`gateway-service.ts` from ~19,922 at start of 8a to 15,248 now — a ~23% reduction). Authority, measured in `host.*` call sites and private field count, is not going down at the same rate. **"Extraction complete" as a milestone is misleading.** Tighten the definition: an extraction is complete when the extracted service (a) has private state, (b) has zero `host.*` calls, (c) is instantiable without a live `GatewayService` mock of >5 methods.

### 6.2 "Green verification harness" as release gate
See §2.7. The lanes pass. They prove additive contract shape, pixel stability on 13 curated routes, and happy-path approval/durable lifecycle. They **do not** prove concurrency safety, TTL correctness, event ordering across restart, graceful degradation, or cross-surface functional parity. Publishing "all lanes green" as a 1.0 readiness claim overstates the coverage.

### 6.3 "`MemoryLifecycleService` is the lifecycle owner"
Runtime paths bypass it (chat-learned-memory-service is called on turn completion directly). Writing new memory behavior against the doc will lead to over-layering; writing against the code will reveal three parallel entry points.

### 6.4 "Durable execution owns Chat / Cowork / Code resumable flow"
The *decision* to use durable execution lives in `chat-turn-dispatch-service.ts:80–120`. The run lifecycle lives in `DurableRunService`. The stream resumption lives in `chat-turn-entry-service.ts`. No single module "owns" the flow. The claim is true at the marketing level, misleading at the architecture level.

### 6.5 "Storage is dumb CRUD" (it isn't)
This one cuts the other way: storage repos do own semantics (status machines, cursor composition, envelope embedding, aggregation). The systemic concern is that two of the most important ones (`realtime-event-repo`, `chat-turn-trace-repo`) have **no tests** — so the semantic ownership is load-bearing but unverified.

### 6.6 `@internal` markers as encapsulation
29 `/** @internal */ public` fields on `GatewayService`. TypeScript treats them as public. Any route, any extracted service, any downstream consumer can reach them. This is a gentlemen's agreement, not encapsulation. Finding them is trivial via search; respecting them is cultural.

### 6.7 Route-layer arg mutation (`__gcSafety`)
See §2.11. Args round-trip through approval previews. An operator reading an approval preview sees a synthetic `__gcSafety` namespace they didn't send. Cognitive-load bug at minimum, signature-integrity bug at worst.

---

## 7. Suspected But Unconfirmed Issues

These require runtime validation or deeper trace work than a first-pass permits.

### 7.1 SSE sequence continuity across gateway restart
`runDurableRecoveryLane` restarts the gateway and verifies the durable run reconciles. It does not verify that an SSE consumer subscribed at `seq=N` before restart receives `seq=N+1..M` after restart without gaps or duplicates. The repo does append sequences in a transaction (`realtime-event-repo.ts:34–83`), but cross-restart consumer reconnection semantics are unproved.

### 7.2 Two-operator approval resolution race
`pendingApprovalActions` + `approval_effects` + `approval_wait_runs` under two simultaneous resolves with the same approvalId. Idempotency is architected but not tested under concurrency. **High priority to validate.**

### 7.3 Durable recovery from poison checkpoint
The happy-path restart is tested. A run with a malformed checkpoint JSON, or a workflow that throws during replay, or a dead-letter whose recovery itself fails — none are covered.

### 7.4 Memory item TTL boundary
No scheduled sweeper (§2.4). Expired items are retrievable. Side effect: an expired learned memory item can still surface in a QMD context-pack composition if the composer queries by scope rather than by `expires_at`.

### 7.5 Connector token/auth rotation
Device grants, companion sessions, and Bearer tokens are issued. Rotation/revocation paths are not visible in a first-pass read. Needs dedicated tracing.

### 7.6 Visual regression baseline stability
52 baselines, thresholded at 18-pixel delta / 0.5% ratio. Whether the thresholds are empirically calibrated (i.e. no flake without real change) is unverified.

### 7.7 The "22 baseline failures"
Plan memory references them as known-baseline. `scripts/verification/lib/shared.mjs:250–271` has no `known_failure` status bucket. They are either passing on CI, or being absorbed into `degraded`/`skipped`, or only reproduce locally. Provenance needs to be reconciled before 1.0.

---

## 8. Recommended Next Actions

Prioritized. "Before 1.0" = pre-release. "Soon after" = within the first post-release sprint. "Systemic" = longer arc.

**Before 1.0**
1. Add the concurrency scenario for approvals (§2.5).
2. Add the SSE-sequence-across-restart scenario (§7.1).
3. Add a scheduled sweeper for expired memory items (§2.4) or honestly document that items do not auto-expire.
4. Write tests for `realtime-event-repo` and `chat-turn-trace-repo` (§2.9).
5. Reconcile the 22 baseline failures — either formalize an allowlist with reasons or resolve them (§7.7).
6. Document the MCP-vs-built-in-vs-connector first-use-approval asymmetry (§2.12).
7. Audit Bearer token / secret logging (§8's standing concern from governance review).

**Soon after 1.0**
8. Unify error envelope (§2.3). Mandate `sendRouteError()`; make service layer throw `GoatError` only.
9. Move cursor encoding into storage repos (§2.8).
10. Move deployment-profile / computer-use safety out of the route layer (§2.11).
11. Resolve the `client.ts` duplication between `apps/mission-control` and `packages/mission-control-shared` (§5.5).
12. Replace `UiPreferencesProvider` duplication with the shared version (§5.3).
13. Hoist dialect-specific SQL (nullable match) to the shared `DatabaseClient` interface (§2.10).

**Systemic**
14. Redefine "service extracted" as (private state moved, zero host callbacks, instantiable in isolation). Apply the definition to the current backlog (8h, 8i, 8k). Prefer fewer, deeper extractions over more text-level extractions.
15. Introduce a `fastify.gateway.*` deprecation plan. New routes must inject a narrow service; existing routes migrate incrementally.
16. Encode convention-only invariants as code:
   - Zod validation on `realtime_events` input requiring explicit `eventClass`/`eventAuthority`/`links` for protected types.
   - Lint rule or CI check on `/** @internal */ public` counts (expect number to trend *down*, not up).
17. Commit to either (a) completing the next-UI rewrite on a visible schedule, or (b) formally declaring the dual-shell model. Either choice beats the current implicit limbo (§2.6).
18. Add functional parity tests between legacy and next UI for the top 5 operator actions (approvals, memory item edit, session create, tool invoke, task create).

---

## 9. Final Verdict

GoatCitadel is closer to 1.0 than most codebases of this size tend to be. The contract posture is honest about being additive, the policy engine is cleanly unified, the storage layer owns its semantics, and the durable subsystem demonstrates that real decomposition is possible in this codebase. Those are genuine strengths and they should not be understated.

The risk is not that the code is broken. The risk is that the **claims outrun the code in two specific dimensions**:

1. **Architecture claims** — "services are decomposed", "approvals have clear ownership", "memory lifecycle has a single owner", "durable execution owns Chat/Cowork/Code resumption". These are partially true. The gateway remains a 15k-line god-object with ~487 public methods, and extracted services still make 20+ callbacks each into it. Release docs and the canonical state model assume a decomposition that is in progress, not done.

2. **Verification claims** — "all lanes green" currently proves additive contract shape, pixel stability, and happy-path lifecycle. It does not prove concurrency, TTL, restart-time event ordering, graceful degradation, or cross-surface functional parity. A green harness is not, today, a reliability claim.

If the founder treats 1.0 as a marker of **feature completeness and additive-contract stability**, the repo is there. If 1.0 is a marker of **architectural coherence and production reliability under adversarial conditions**, the repo is **not yet there**, and the gap is exactly the items in §8.

The most honest 1.0 label is: *"GoatCitadel 1.0 — feature surface and contract posture stable; decomposition and reliability hardening ongoing."* That matches the code. The current docs read closer to *"architecture is settled"*, which doesn't.

This is a shippable codebase with a believable story. The believable story is slightly shorter than the currently told story. Tell the shorter one and the 1.0 stands up.

---

## Appendix: Highest-Value Areas For Second Reviewer To Challenge

The second-pass reviewer (ChatGPT Pro) should treat these as priority targets to confirm, dispute, or extend. Each is picked because it is either load-bearing or likely to hide uncertainty a first-pass cannot resolve.

1. **`GatewayService` host-callback profile** — I counted `host.*` call sites per extracted service via grep. Confirm the counts. Then walk one of the larger services (e.g. `chat-turn-entry-service.ts`, 77 callbacks) end-to-end and classify each callback: (a) pure read of host state, (b) delegation to another host method that could be directly injected, (c) side-effect the service should own. A classification breakdown exposes whether the extraction is salvageable-by-narrowing or requires a real redesign.

2. **The `/** @internal */ public` pattern count across the tree** — I only counted inside `gateway-service.ts` (29). Grep the whole repo. If the pattern is widespread, the entire codebase is fighting TypeScript's access control; if it's localized, the god-object is the single bottleneck. The answer changes the remediation size.

3. **Approval two-tab race** — §2.5 / §7.2 is the single most likely place a bug reaches production. Build a runtime test: two parallel `approval.resolve` calls on the same approvalId, assert exactly one effect pipeline runs. The test either proves idempotency is real or exposes a concrete defect.

4. **SSE sequence continuity across gateway restart** — §7.1. `realtime-event-repo.ts` allocates sequences in-transaction, but the reconnection-resume path (client subscribes, gateway restarts, client reconnects at last-seen seq) is not covered by any scenario I found. This matters because `CANONICAL_RUNTIME_STATE_MODEL.md:136` explicitly positions realtime events as non-authoritative — but Mission Control's reactive panels rely on them for freshness.

5. **`1_0_RELEASE_EVIDENCE.md` citation integrity** — I found at least one citation (`1_0_RELEASE_EVIDENCE.md:33` pointing at `gateway-service.ts` for replay skip behavior) where the actual logic is in `chat-turn-dispatch-service.ts:96–99`. Walk the full release evidence file and verify every `[...](.../file.ts)` cite still corresponds to the code that proves the claim.

6. **Memory item TTL behavior** — §2.4. Confirm, with a runtime probe: create a memory item with a short TTL override, wait past expiry, query it. Is it still returned? Does `memoryFlush` cron touch items at all, or only context packs? The answer decides whether this is a bug or a missing feature.

7. **The 22 "baseline failures"** — §7.7. These appear in plan memory but not in any allowlist under `scripts/verification/`. Find them. Are they flakes, environment-dependent, or real? The release evidence currently does not carry them, and it should.

Each of these can be resolved in a focused runtime or grep pass. Each of them, if my conclusion is wrong, meaningfully changes the 1.0 readiness call.

---

*End of Claude Code first-pass report. Hand to ChatGPT Pro for second-pass adversarial review per `docs/review/REVIEW_MASTER_BRIEF.md` § "Repo Access Modes".*
