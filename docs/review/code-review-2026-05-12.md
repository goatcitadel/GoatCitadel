# GoatCitadel Code Review — 2026-05-12

Historical note: this document preserves the adversarial review snapshot from May 12, 2026. Several findings and
the headline verdict have since been superseded by later fixes and release evidence; use `docs/1_0_RELEASE_EVIDENCE.md`,
`docs/review/backlog-closeout-2026-05-15.md`, and current verification artifacts for the live release posture.

## 1. What the owner asked for

> "I want you to put together a plan for a read-only code review of this entire codebase. There have been major updates recently and major fixes done. I need to make sure that there's no bugs, things are optimized for performance, and that all the functionality expects as it should for an agentic ai orchestration system. Be brutal and adversarial in the assessment. In the review, I will need a list of everything found and the reason why you put it there, this is because codex has done most of the coding so i need to keep it there and will be providing this code review to codex to review. I need to make sure that the entire ui/ux is smooth. That the chat in all 3, chat/cowork/code feels very smooth and modern. i want to make sure that chat provides the best possible responses regardless of model used, i want to make sure that cowork does an incredibly job of agent orchestration for longer tasks and other things that cowork is useful for, and i need to make sure that code makes sense in general on the page. I also need to make sure that all the settings are clearly labeled and that in general everything makes sense in the explanations on the page for the layman or the engineer. if you have any other improvements that you think of while doing the code review, please include that in the code review report. it should include what i want above, what you found and why it's an issue or what you think about it, and then i want a summary of everything and where you think this stands as a shippable product, and then i want you to provide recommended next steps"

**Success criteria, restated:** (1) no shipping-blocker bugs and a defensible performance posture; (2) Chat, Cowork, and Code surfaces feel modern, fluid, and honest about their state; (3) the orchestration engine actually orchestrates agents over long-running tasks, not just animates a state machine; (4) every settings field is intelligible to a layman without misleading an engineer.

## 2. Scope & Methodology

**Reviewed surfaces.** Backend (`apps/gateway/`, `packages/orchestration/`, `packages/storage/`, `packages/policy-engine/`, `packages/memory-core/`, `packages/mesh-core/`, `packages/contracts/`, `packages/gateway-core/`, `packages/skills/`, `packages/threaded-surface-core/`, `packages/mission-control-shared/`), the canonical UI (`apps/mission-control-next/`), root configuration, verification scripts, and `docs/`. Per owner directive, the legacy shell (`apps/mission-control/`) received a seam-only audit, not a full content read.

**Method.** Eight specialist reviewer passes (R1–R8), each with a single lens and a fixed severity rubric, plus this synthesis layer that renumbers globally, settles severity collisions, and builds the convergence map. All findings — including NIT — are retained per owner directive. Where the source brief gave a stale fact (e.g., gateway-service.ts size, llm-service.ts size, paths that have since been removed), the reviewer's current measurement is preserved.

**Reviewer lenses (one-line each).**
- R1 — Backend architecture, gateway decomposition, LlmService monolith, layering, dead code.
- R2 — Secrets, auth, Code Mode containment, tool policy, SQL/CORS/CSRF/SSRF, approval bypass, logging.
- R3 — SSE / EventSource / polling, DB queries, bundle, render, leaks, worktree disk, cost overhead.
- R4 — Smoothness, modernity, A11y, responsive, microinteractions across Chat / Cowork / Code.
- R5 — Settings labels, help text, tooltips, validation, defaults, secrets UI, discoverability, env docs.
- R6 — Orchestration state machine, approval gates, subagents, memory, durability, observability, ownership matrix.
- R7 — Coverage truthfulness, mock-vs-real, E2E, flaky tests, verification-lane meaningfulness.
- R8 — Naming, error handling, immutability, file size, comments, dead code, doc-vs-code.

**Out of scope.** Network-dependent live tests, third-party SDK internals (Playwright/Monaco/assistant-ui), packaging/installer (`pnpm build:desktop`, Windows native installer), and any UI-screenshot comparison against marketing material.

## 3. Headline Verdict

**Historical verdict from this snapshot, now superseded.** GoatCitadel's plumbing was already unusually strong — durable execution, dead-letter recovery, OAuth/PKCE, deny-wins policy, real-DB integration coverage in the agentic lanes — but this May 12 snapshot judged several release claims not yet ready. It included an outdated Settings loopback-bypass default finding (**F-006**, R5-CC-1) that has since been superseded. Use current source and `docs/1_0_RELEASE_EVIDENCE.md` for the live release posture.

## 4. Findings

Findings are sequentially numbered F-001…F-NNN across the whole review. Severity ordering: CRITICAL → HIGH → MEDIUM → LOW → NIT. Source reviewer IDs are preserved in each entry.

### 4.1 CRITICAL (15 items)

### F-001 — Orchestration phases have no execution path; the "engine" is a state-machine animator
- **Source:** R6-C1
- **Severity:** CRITICAL
- **Category:** Orchestration
- **Location:** `apps/gateway/src/services/orchestration-lifecycle-service.ts:720-752`
- **Observed:** The "phase execution" loop calls only `host.orchestrationEngine.advancePhase(plan, run, previousPhaseId)` — a pure state-machine transition that mutates `currentPhaseId`, increments `totalIterations`, and pauses on approval. There is no LLM call, no tool invocation, no agent dispatch, and no use of `phase.ownerAgentId` or `phase.specPath`. `specPath` is referenced in production code exactly once — as a label fed to memory composition (`gateway-service.ts:6132`).
- **Why it matters:** This is the headline product feature. A 10-phase auto-mode run "completes" in microseconds, emitting 10 `phase_executed` events that represent zero real work. The entire Cowork value proposition rests on this loop.
- **Evidence:** No call to `prepareAgentChatTurn`, `executePreparedAgentChatTurnBackground`, or any subagent dispatcher exists inside the orchestration execution path. Confirmed via grep across `apps/gateway/src/services`.
- **Suggested direction:** Wire phase execution to `prepareAgentChatTurn` or build a subagent dispatcher that resolves `phase.ownerAgentId` to an agent and `phase.specPath` to a spec, executes a turn, captures usage/cost, and records a turn-trace. Or rename the surface honestly.
- **Confidence:** High

### F-002 — Cost tracking is a permanent zero for auto-mode runs; budget guardrails are decorative
- **Source:** R6-C2
- **Severity:** CRITICAL
- **Category:** Orchestration
- **Location:** `packages/orchestration/src/engine.ts:159-196`, `apps/gateway/src/services/orchestration-lifecycle-service.ts:725`
- **Observed:** `advancePhase` accepts `options.costIncrementUsd`. The lifecycle service never passes it. The only place a cost increment is supplied is `approvePhase` via an operator-typed value in the HTTP body. Auto-mode runs advance through all phases with `totalCostUsd` remaining `0`. `engine.shouldStopByLimits` therefore never enforces `maxCostUsd` in auto mode.
- **Why it matters:** "Budget guardrail" is a 1.0-contract promise. It is unenforced for the default mode.
- **Evidence:** `engine.ts:88,171` (parameter wired through engine); `orchestration-lifecycle-service.ts:725` (call site does not pass cost).
- **Suggested direction:** Increment cost from `ChatTurnTraceRecord.usage.costUsd` on each `phase_executed`, once F-001 is wired. Long term, model-specific token estimator + provider charge mapping.
- **Confidence:** High

### F-003 — Worktrees are created per session/run and never automatically removed; disk fills on long-running deployments
- **Source:** R3-CR-2, R6-H1 (convergent)
- **Severity:** CRITICAL
- **Category:** Performance / Orchestration
- **Location:** `apps/gateway/src/services/chat-workbench-service.ts:84-103`, `apps/gateway/src/services/gateway-service.ts:5398-5431`, `packages/orchestration/src/worktree-manager.ts:1-35`
- **Observed:** `WorktreeManager.remove` exists and is tested but is never called from any orchestration lifecycle path nor any chat-session lifecycle hook (archive/delete/fail/idle). No orphan scan, no quota, no max worktrees per workspace.
- **Why it matters:** Each worktree is a full git checkout — hundreds of MB on a Node monorepo. After weeks of use, sqlite writes start failing with "database is locked" or random write errors. Compounds with F-026 (worktree allocation does not clean up half-created dirs on failure).
- **Evidence:** Grep finds `WorktreeManager.remove` only in tests and the explicit `git.worktree.remove` operator tool — never in service code. R6 confirms no cleanup on `run_completed`, `stopped_by_limit`, `failed`, or cancel.
- **Suggested direction:** Add a `releaseOrchestrationWorktree` host method called in `run_completed/stopped/failed` paths and on chat-session archive/delete. Add a periodic orphan-reaper that scans `worktreesDir` against active runs and prunes after a grace period. Cap worktrees per workspace; emit `worktree_quota_exceeded`.
- **Confidence:** High
- **Synthesis note:** R3 ranks CRITICAL (disk-fills-then-everything-dies). R6 ranks HIGH (run-lifecycle). Settled at CRITICAL — disk exhaustion has the worst blast radius and is the convergent failure mode.

### F-004 — `runOrchestrationPlan` has no deduplication; POST twice creates two parallel runs on the same plan
- **Source:** R6-C4
- **Severity:** CRITICAL
- **Category:** Orchestration
- **Location:** `apps/gateway/src/services/orchestration-lifecycle-service.ts:441-513`
- **Observed:** `createOrchestrationPlan` unconditionally calls `engine.createRun(plan)`, which mints a fresh `runId` via `randomUUID()`. `findLatestRunByPlan(planId)` is declared on the host port (line 68) but never called inside the lifecycle. The HTTP route provides no idempotency-key surface.
- **Why it matters:** Two operators (or one double-click) creates two independent runs, each with its own worktree, each with its own durable run, both running "in parallel" against the same plan. Doubled cost, doubled state, two worktrees per accidental click.
- **Evidence:** `orchestration.ts:82-93` HTTP route, `orchestration-lifecycle-service.ts:441-513` lifecycle.
- **Suggested direction:** Fetch latest run via `findLatestRunByPlan`, return-or-reject if status non-terminal; or accept an `Idempotency-Key` header. Add an integration test for double-POST.
- **Confidence:** High

### F-005 — Server-side SSE writes have no backpressure; slow client can OOM the gateway
- **Source:** R3-CR-1
- **Severity:** CRITICAL
- **Category:** Performance
- **Location:** `apps/gateway/src/routes/chat.shared.ts:75-104`, `apps/gateway/src/routes/events.ts:88-110`, `apps/gateway/src/services/chat-turn-stream-service.ts:756-791`
- **Observed:** The shared SSE writer does `raw.write(...)` without awaiting `drain`, without checking `raw.writableNeedDrain`, and without pausing the generator. `createAsyncProgressQueue` is unbounded. Node's internal write buffer grows without limit on a paused tab / mobile / throttled client.
- **Why it matters:** A killed gateway kills every other session on the box. This is the single most likely path from "user backgrounds a streaming chat" to "production process dies."
- **Evidence:** Lines cited; grep finds no `setMaxListeners`, no `writableNeedDrain` check, no queue cap.
- **Suggested direction:** Check `raw.write()` return; on `false` await `'drain'` (or pause the source generator). Cap progress queue at e.g. 256 items and drop oldest non-`final` updates with a warning event. Apply to `events.ts` keep-alive and `subscribeRealtime` writer (line 192).
- **Confidence:** High

### F-006 — Historical: Settings UI loopback-bypass default mismatch
- **Source:** R5-CC-1
- **Severity:** CRITICAL
- **Category:** Settings / Security
- **Location at snapshot time:** Mission Control Next Access settings and legacy Settings.
- **Observed then:** The review reported a default mismatch for the loopback-bypass flag between the canonical and legacy settings UIs.
- **Current status:** Superseded by later Mission Control Next Access work. Re-check current source before quoting this finding as live evidence.
- **Suggested direction:** Keep the current Access form safe by default and explicit about loopback-bypass tradeoffs.
- **Confidence:** Historical snapshot only.

### F-007 — Provider API-key storage UI never tells the user the key does not roundtrip back to the browser
- **Source:** R5-CC-2
- **Severity:** CRITICAL
- **Category:** Settings / Security UX
- **Location:** `apps/mission-control/src/pages/settings/SettingsModelsSection.tsx:403-429`; `apps/mission-control/src/api/platform.ts:271-292`
- **Observed:** API key flow uses `<input type="password">`, "Save Key to Secure Store", and "Remove Secure Key". On reload, the input is empty. There is no "key on file" indicator next to the input, no "never sent back to the browser" reassurance, and no masked tail. The underlying implementation is safe (status returns `{ hasSecret, source }` only).
- **Why it matters:** A user who can't tell whether saving worked, whether the key persists, or whether the browser can later exfiltrate it has no basis to trust the secrets store. This is the central trust contract for the product.
- **Evidence:** Lines cited; no `FieldHelp` block adjacent to the input.
- **Suggested direction:** Add a `<FieldHelp>` above the input describing the secure-store contract. Render "Key on file: stored in OS keychain since YYYY-MM-DD" when `hasSecret` is true. Use a placeholder "Leave blank to keep existing key; type to replace."
- **Confidence:** High

### F-008 — `chat-agent-orchestrator.ts` is 14,183 LOC and `eslint-disable max-lines` — 17.7× owner's 800-LOC cap
- **Source:** R8-001
- **Severity:** CRITICAL
- **Category:** Quality
- **Location:** `apps/gateway/src/services/chat-agent-orchestrator.ts:1` (file-level eslint disable); whole file
- **Observed:** Single-class file. Owns tool-loop detection, runtime cron-job seeding, repair generation routing, and chat-turn delegation. Companion test files: 3,669 + 5,149 + 7,229 LOC. Contains 100+ hardcoded source-tree path strings used as repair-routing logic (see F-027).
- **Why it matters:** Reviewability is broken — an LLM-assisted reviewer's context window is exhausted by one file. This is the load-bearing path between user prompts and tool execution; future bug fixes will be high-risk by default.
- **Evidence:** `wc -l` = 14,183; `grep -nE "^export"` shows 4 exports, all for one class.
- **Suggested direction:** Extract `cron-seed` (12,800-13,400 range), repair-routing tables (the embedded path strings → `chat-repair-routes.ts` constants), tool-loop detection (`chat-tool-loop.ts`), and tool-loop guard event production.
- **Confidence:** High

### F-009 — `ChatTurnRuntimeService` host is the entire `GatewayService` instance — narrow-host contract is theatrical
- **Source:** R1-001
- **Severity:** CRITICAL
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/gateway-service.ts:1011`; `apps/gateway/src/services/chat-turn-runtime-host-composition.ts:13-30, 236-244`; `apps/gateway/src/services/chat-turn-runtime-service.ts:32-33`
- **Observed:** `new ChatTurnRuntimeService(createChatTurnRuntimeHost(this))` — `this` is the full GatewayService. Every "collaborator" in the composition file is built from the same `source` reference; each property is a `get`-bound forwarder back to GatewayService via `Object.defineProperties(target, Object.getOwnPropertyDescriptors(collaborator))`. The wrapping is type-narrowing only — runtime identity, lifetime, mutability, and reachable surface remain `GatewayService`. There are 70+ methods/getters on the intersection-typed host.
- **Why it matters:** The chat-turn cluster is the largest and most-cited "real seam" in the decomposition plan, and its host contract is fiction. The runtime cannot be tested with a fake host without implementing every property; turn dispatch retains transitive access to memory admin, retention, mesh, NPU sidecar; the in-repo audit prompt's dangerous-false-decomposition pattern verbatim.
- **Evidence:** Lines cited; no other consumers of `createChatTurnRuntimeHost`.
- **Suggested direction:** Inject the runtime with an explicit narrow host built from services, not from `this`. Either an object literal `{ storage, turnRuntime, llmService, hooksService, approvalRuntime, memoryLifecycleService, … }` or a `buildChatTurnRuntime(...)` builder that takes ~12 collaborators by name.
- **Confidence:** High

### F-010 — `GatewayRouteCompositionPort` is a 200-line transposition of GatewayService onto an interface — extraction in name only
- **Source:** R1-002
- **Severity:** CRITICAL
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/gateway-route-composition-port.ts:54-203`, `:240-390`
- **Observed:** The port declares 31 readonly service references plus 87 method references. The implementation `createGatewayRouteCompositionPort(gateway, privateDependencies)` binds every method off `gateway` (`gateway.acceptChatDelegation.bind(gateway)`, …). Routes call `fastify.services.chatMessages.agentSendChatMessage(...)` which calls `gateway.chatTurnRuntime.agentSendChatMessage(...)` which calls `chatTurnEntryService.agentSendChatMessage(host = the full GatewayService, ...)`.
- **Why it matters:** The route layer no longer talks to `fastify.gateway.*` (verified zero occurrences), but the chain underneath is *less* observable. State ownership, transactional boundary, error-handling responsibility, and lifecycle ownership all still live in GatewayService. The "port" is GatewayService transposed onto an interface name.
- **Evidence:** Counts above; `route-service-factory.ts:6-15` shows the route-service wrapper is `Object.freeze({ method: (...args) => port[method](...args) })`.
- **Suggested direction:** Stop adding to the port. Each future extraction *replaces* a slice of the port with a self-owned service that the route composition imports directly. Target: shrink port from 87 method references to ~15 entry points.
- **Confidence:** High

### F-011 — `LlmService` has no per-provider seam; growth requires switch-statement edits in 3,215 LOC
- **Source:** R1-003 (also touches R8-001 family)
- **Severity:** CRITICAL
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/llm-service.ts` (whole file; switches at `:669` and `:690`; per-provider checks at `:1471, 1482, 1485, 1496, 1503, 1556, 1585, 1600, 1713, 3034, 3156, 3164, 3173`)
- **Observed:** Adding a new provider with a meaningfully different transport requires edits in 6-8 places: enum extension in `packages/contracts`, two execute methods, builder, response adapter, both switches, URL canonicalization special-case, provider-specific options conditional, max-tokens conditional, api-style normalization, api-style resolution. No `ProviderAdapter` interface, no registry, no per-provider module. Codex provider has bled across the file (11+ sites). File comment at `:1` admits "intentionally centralized until provider seams are split further."
- **Why it matters:** 1.0 contract `docs/1_0_CONTRACT.md:84-91` requires "multi-provider operation with explicit runtime diagnostics." Every new integration is 3,215-line surgery, and the risk of regression for existing providers when adding one is high.
- **Evidence:** Lines cited; durable workflow registry (`durable-execution-service.ts:1165-1241`) is the clean per-workflow adapter shape that this layer needs.
- **Suggested direction:** Introduce `LlmProviderAdapter` interface (`buildRequest`, `parseResponse`, `parseStream`, `buildHeaders`, optional `canonicalizeUrl`, `applyProviderQuirks`). Register in `Map<LlmApiStyle | providerId, LlmProviderAdapter>`. `chatCompletions` becomes ~30 lines.
- **Confidence:** High

### F-012 — Ownership matrix is plan-time-only theatre; never enforced at file-operation level
- **Source:** R6-C5
- **Severity:** CRITICAL
- **Category:** Orchestration / Security
- **Location:** `packages/orchestration/src/engine.ts:20-32`, `packages/orchestration/src/ownership-matrix.ts:11-46`
- **Observed:** Plan validation calls `findOwnershipConflicts(wave)` which detects overlapping declared paths between agents *within a wave*. It never inspects reads/writes during phase execution, cross-wave overlaps, or actual file operations. `assertWritePathInJail` does not consult the phase's declared ownership paths. Path normalization strips only trailing `*+` and `/`; middle-path globs (`apps/*/src` vs `apps/mission-control/src`) are not detected.
- **Why it matters:** Documented as an audit-bearing safety feature. Currently a non-enforcing string-prefix check.
- **Evidence:** `findOwnershipConflicts` used only by the engine validator.
- **Suggested direction:** Either (a) enforce ownership at write time by passing `runId/phaseId` through to file-mutating tools and checking against active-phase declared paths, or (b) downgrade to a soft warning and remove ownership language from operator docs. Replace string-prefix overlap with proper glob intersection (e.g., `picomatch`-based mutual-match).
- **Confidence:** High

### F-013 — `startRun` has no precondition; can silently reset completed/failed/stopped runs
- **Source:** R6-C3
- **Severity:** CRITICAL
- **Category:** Orchestration
- **Location:** `packages/orchestration/src/engine.ts:46-57`, `apps/gateway/src/services/orchestration-lifecycle-service.ts:700-708`
- **Observed:** `startRun` checks nothing about `run.status`. If invoked on a `completed`, `paused`, `stopped_by_limit`, or `failed` run, it silently resets `currentPhaseId` → first phase, sets status to `running`/`paused`, and clears `endedAt`. `executeDurableOrchestrationRun` calls `startRun` whenever `executionState !== "resume_requested"`. A durable re-queue (manual retry, lease expiration, race between worker shutdown and queue replay) silently destroys completed run state.
- **Why it matters:** Durable retry can silently overwrite a finished orchestration run.
- **Evidence:** Lines cited.
- **Suggested direction:** Add `if (run.status !== "queued") throw` in `startRun`. The lifecycle resume vs. start branch already exists; the engine should enforce it as a tripwire.
- **Confidence:** High

### F-014 — Postgres migrator/client/sync-worker tests use a hand-rolled `FakePool` — violates the owner's explicit mock-DB ban
- **Source:** R7-C1
- **Severity:** CRITICAL
- **Category:** Testing
- **Location:** `packages/storage/src/postgres-migrator.test.ts:21-65`, `packages/storage/src/postgres-client.test.ts:15-65`, `packages/storage/src/postgres-sync-worker.test.ts`, `packages/storage/src/postgres-sync.test.ts:6-26`
- **Observed:** `FakePool` / `FakePoolClient` classes feed canned `QueryResponse[]` arrays to a fake pool. `postgres-sync.test.ts` builds a class instance via `Object.create(... .prototype)` so the real constructor never runs. No `testcontainers` / `pg-mem`; no live Postgres CI lane for storage tests. The parity gate `verify-storage-migration-parity.mjs` is a regex over migration files.
- **Why it matters:** Owner's auto-memory states this rule was written to prevent the exact prior incident — "mock/prod divergence masked a broken migration." The forbidden mocks live in exactly the files the rule targeted.
- **Evidence:** File contents; no `PGHOST/POSTGRES_HOST/TEST_DATABASE_URL` references in `packages/storage/`.
- **Suggested direction:** Add `testcontainers` or docker-compose Postgres test pass for `postgres-migrator.test.ts` and the public sync API at minimum, or remove the `FakePool` and rely on SQLite parity.
- **Confidence:** High

### F-015 — `coverage-exercise.ts` inflates gateway line coverage with `assert.notEqual(statusCode, 500)` — 17 occurrences
- **Source:** R7-C2
- **Severity:** CRITICAL
- **Category:** Testing
- **Location:** `apps/gateway/src/coverage-exercise.ts:274,282,298,308,314,321,333,342,440,463,491,509,527,582,629,656,739`
- **Observed:** 17 of 24 `statusCode` assertions in the harness are `assert.notEqual(statusCode, 500)`. That passes for `400`, `403`, `404`, `409`, anything but a server crash. The harness silently swallows `unhandledRejection` and `uncaughtException` (lines 53-62) on top.
- **Why it matters:** Coverage produced by this harness is not a correctness signal — only "no 500s today." The 65%/45% global gate (and 80%/70% Gateway tier) clear without any behavioral assertion. Combined with F-016, the gate is unenforced anyway.
- **Evidence:** Lines cited.
- **Suggested direction:** Replace each `notEqual(..., 500)` with `equal(statusCode, expectedCode)` + body-shape check, or exclude `coverage-exercise.ts` from coverage and rely on per-service `*.test.ts`.
- **Confidence:** High

### 4.2 HIGH (28 items)

### F-016 — `coverage:gate` and `coverage:gate:production` are never invoked by any verification lane or CI workflow
- **Status update 2026-05-18:** Superseded for the current verification workflow shape. `verification-fast.yml`
  runs `pnpm coverage:collect && pnpm coverage:gate:production` as workflow steps after `pnpm verify:fast`.
  Release certificates require the direct `verification-fast.yml` workflow for fast-lane, production coverage,
  and Postgres proof; `verify:fast` itself is not the release-proof umbrella lane.
- **Source:** R7-C3
- **Severity:** Closed historical finding
- **Category:** Testing
- **Location:** `package.json:48-50`; `scripts/coverage-gate.mjs`; `.github/workflows/verification-fast.yml`
- **Current state:** `verification-fast.yml` runs `pnpm verify:fast`,
  `pnpm coverage:collect && pnpm coverage:gate:production`, and Postgres storage checks as distinct proof steps.
- **Remaining note:** Keep this entry only as branch-history context; do not treat it as an open action on current `main`.
- **Confidence:** High

### F-017 — Historical: `packages/storage/src/postgres/server-encoding.test.ts` was unreachable by `pnpm test`
- **Source:** R7-C4
- **Severity:** HIGH
- **Category:** Testing
- **Location:** `packages/storage/package.json:20`
- **Current state:** `packages/storage/package.json` now uses a recursive test glob, so the Postgres encoding test is no longer silently skipped by the package test lane.
- **Remaining note:** Keep this entry only as branch-history context; do not treat it as an open action on current `main`.
- **Confidence:** High

### F-018 — MCP `allowedEnvKeys` grants arbitrary host-env read to untrusted child processes
- **Source:** R2-001
- **Severity:** HIGH
- **Category:** Security
- **Location:** `apps/gateway/src/services/mcp-runtime.ts:413-420`
- **Observed:** `buildMcpChildEnv` blindly copies every key in `server.policy.allowedEnvKeys` from `process.env` to the spawned MCP child. The list comes from a database record; an operator (or whoever can write MCP config) can request `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOATCITADEL_AUTH_TOKEN`, etc. A malicious or compromised MCP binary exfiltrates them.
- **Why it matters:** Full credential exfiltration path for any MCP server the user installs from an untrusted source.
- **Evidence:** Code block at lines cited.
- **Suggested direction:** Enforce a key prefix allowlist (e.g., `ALLOWED_SECRET_ENV_PREFIXES` from `integration-webhooks-shared.ts`) and/or block keys overlapping gateway-internal secret names.
- **Confidence:** High

### F-019 — Firecrawl `firecrawlApiKeyEnv` lets an agent read any env var by name
- **Source:** R2-002
- **Severity:** HIGH
- **Category:** Security
- **Location:** `packages/policy-engine/src/ingestion-backends.ts:234-235`, `packages/policy-engine/src/browser-tools.ts:1952-1954`
- **Observed:** `docs.ingest` with `backend: "firecrawl"` reads `firecrawlApiKeyEnv` from tool args, then uses it as a `process.env` key. A prompt-injected agent supplies `firecrawlApiKeyEnv: "ANTHROPIC_API_KEY"`; the resulting value is sent as `Authorization: Bearer ...` to the configured (and possibly attacker-controlled) Firecrawl endpoint.
- **Why it matters:** Prompt injection via scraped web content is realistic. Network-guard validates URL only against allowlist; with a whitelisted attacker domain (e.g., a hosted Firecrawl on a permitted host), the secret is exfiltrated.
- **Evidence:** Lines cited.
- **Suggested direction:** Ignore `args.firecrawlApiKeyEnv`; read only from a fixed set of allowed env var names. Or require strict prefix allowlist.
- **Confidence:** High

### F-020 — `approvalMode: bypass` silently removes all approval gates for danger and nuclear tools
- **Source:** R2-003
- **Current status:** Superseded by the current policy engine: bypass/trusted-local fast paths no longer remove the retained nuclear/risky-shell approval gates or hard deny/path/network/capability blocks. Treat this as historical review context unless fresh tests reproduce it.
- **Severity:** HIGH
- **Category:** Security
- **Location:** `packages/policy-engine/src/engine.ts:524-526`
- **Observed:** When `policy.approvalMode === "bypass"`, the engine sets `requiresApproval = false` unconditionally — including `riskLevel: "nuclear"` and risky shell commands. Audited but not gated behind a separate privilege check.
- **Why it matters:** A compromised operator session can pre-configure bypass and trigger nuclear-risk operations without any approval prompt. Structural safety (path jail, network guard) still holds — but every human gate is removed by a single config value.
- **Evidence:** Lines cited.
- **Suggested direction:** Require a separate secret or two-factor confirm to enable bypass; or restrict bypass from overriding `nuclear`. Log a prominent warning on every invocation under bypass.
- **Confidence:** High

### F-021 — Chat composer is missing every keyboard shortcut a modern chat ships
- **Source:** R4-CHAT-001
- **Severity:** HIGH
- **Category:** UX
- **Location:** `packages/threaded-surface-core/src/chat/useChatComposerInteractions.ts:106-137`
- **Observed:** Handles only `Enter` (send), implicit `Shift+Enter` newline, and `Shift+Tab` (planning). No `Cmd/Ctrl+Enter` force-send, no `Esc` to cancel turn, no `ArrowUp` recall-last, no `Cmd/Ctrl+K` command palette.
- **Why it matters:** Owner explicitly asked the chat to feel as snappy as Claude.ai / ChatGPT. Both ship all four of these shortcuts. This alone disqualifies the "modern chat" claim.
- **Evidence:** Code block (only `event.key === "Enter" && !event.shiftKey` send-path).
- **Suggested direction:** Add `Cmd/Ctrl+Enter` alternative send, `Escape` to call `onStopActiveTurn` or `onCancelEdit`, `ArrowUp` on empty draft to recall last user turn, `Cmd/Ctrl+K` to focus model picker or open command suggestions.
- **Confidence:** High

### F-022 — Streaming assistant text is not announced to screen readers — WCAG blocker
- **Source:** R4-CHAT-002, R4-CC-003 (convergent)
- **Severity:** HIGH
- **Category:** UX / A11y
- **Location:** `packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx:103-158`, `apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx:209-234`
- **Observed:** Only the static status bar is `aria-live`. Streaming chunks land in `.mc-next-thread-bubble.assistant > .mc-assistant-renderer-...` with no aria-live, no role="log", no aria-busy on the parent.
- **Why it matters:** A blind operator cannot follow a streamed response. Industry baseline marks the streaming message as `role="log"` or wraps in `aria-live="polite" aria-atomic="false"`.
- **Evidence:** Grep returns no `aria-live` on streaming containers in the threaded-surface tree.
- **Suggested direction:** Add `aria-live="polite"` and `aria-busy={running}` to the assistant bubble during streaming. Drop aria-live once the turn completes.
- **Confidence:** High

### F-023 — Citations rendered as a bare integer; not clickable, no preview, no source list
- **Source:** R4-CHAT-003
- **Severity:** HIGH
- **Category:** UX
- **Location:** `apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx:242`
- **Observed:** `<span>{turn.citations.length} citations</span>`. No expansion, no click handler, no underline. No path elsewhere in the surface to inspect citations.
- **Why it matters:** "Best possible response regardless of model" requires the user to be able to verify a sourced response. The data is hidden.
- **Evidence:** Line cited.
- **Suggested direction:** Render as popover/sheet listing citations with title/url. Render inline `[n]` references in markdown when offsets exist. Match Claude.ai's footnote chip pattern.
- **Confidence:** High

### F-024 — Model picker hides context window, cost, capability — no decision data
- **Source:** R4-CHAT-004
- **Severity:** HIGH
- **Category:** UX
- **Location:** `packages/mission-control-shared/src/components/ChatModelPicker.tsx:24-86`
- **Observed:** `ChatModelProviderOption` carries `capabilities` (voiceInput/Output/imageGenerate/imageEdit) but only `availabilityLabel` is shown. No context window, no per-token cost, no capability badges, no grouping. The data is in `useProviderModelCatalog`.
- **Why it matters:** The picker provides none of the data needed to choose intelligently. Owner's "best response regardless of model" promise requires this surface.
- **Suggested direction:** Surface context window + cost per MTok + capability chips per model row. Promote a "best-for" hint in the trigger when provider is auto-routed.
- **Confidence:** High

### F-025 — Cowork "Record pause intent" / "Record kill intent" buttons admit they don't pause
- **Source:** R4-COWORK-003 (convergent with R6-C1)
- **Severity:** HIGH
- **Category:** UX / Orchestration
- **Location:** `apps/mission-control-next/src/features/threaded-surface/ThreadedWorkflowPanel.tsx:573-591, 675-689`
- **Observed:** When `control.runtimeEffect === "state_only"`, button labels are `Record pause intent` / `Record kill intent` with note "State-only: records intent in GoatCitadel state; it is not a live pause or kill signal by itself."
- **Why it matters:** Honesty is good, but the user wants to pause the run. The Cowork surface is supposed to make agent work "watchable and controllable." Controls that don't control are a broken promise. Compounds with F-001: there is no live work to pause anyway.
- **Evidence:** Lines cited.
- **Suggested direction:** Either implement live pause/cancel (see F-028, missing cancel endpoint) and remove this label, or rename buttons less misleadingly ("Mark to stop at next checkpoint") and disable when no executor honors the intent. Add a visible "state-only" run badge so users understand upfront.
- **Confidence:** High

### F-026 — Hitl-mode + non-approval phase: lifecycle accepts, engine rejects — run lands in confusing failed state
- **Source:** R6-H2
- **Severity:** HIGH
- **Category:** Orchestration
- **Location:** `apps/gateway/src/services/orchestration-lifecycle-service.ts:536-538`, `packages/orchestration/src/engine.ts:77-79`
- **Observed:** Lifecycle's `approvePhase` permits hitl mode for phases without `requiresApproval`. The engine's `approvePhase` rejects with `not approval-gated`. The lifecycle marks the run as `resume_requested` with pending approval metadata; the durable worker then fails the run via `failWorkflowRun`. Operator sees a confusing "approval-gated" error on a phase they were told was approvable.
- **Suggested direction:** Decide once whether hitl overrides per-phase `requiresApproval`. Align both layers.
- **Confidence:** High

### F-027 — `chat-agent-orchestrator.ts` embeds 100+ hardcoded source-tree path strings as repair-routing logic
- **Source:** R8-018 (related to R8-001)
- **Severity:** HIGH
- **Category:** Quality / Architecture
- **Location:** `apps/gateway/src/services/chat-agent-orchestrator.ts:7590-7593, 12817, 13160, 13396` (representative)
- **Observed:** Patterns like `add("apps/gateway/src/services/gateway/cron-automation-service.ts")`, `addQuery("cron-automation-service.ts")`, and regex tests for filesystem path shapes are scattered through the file as routing decisions.
- **Why it matters:** A rename in another package silently breaks repair routing with no failure signal. Owner's rule: "no hardcoded values — use constants or config."
- **Suggested direction:** Externalize into `apps/gateway/src/services/chat-repair-routes.ts` as `Record<RepairKind, RepairTarget[]>`.
- **Confidence:** High

### F-028 — No orchestration-run cancel endpoint; operator has no clean stop path
- **Source:** R6-H4
- **Severity:** HIGH
- **Category:** Orchestration
- **Location:** `apps/gateway/src/routes/orchestration.ts` (entire file)
- **Observed:** Routes cover create/start/approve/get/checkpoints/context. No cancel, stop, abort, or pause-orchestration. Operators can only call `DurableOperatorService.cancelRun` indirectly, which (a) doesn't propagate to the orchestration row, (b) doesn't release the worktree, (c) doesn't emit a cancel event.
- **Suggested direction:** Add `POST /api/v1/orchestration/runs/:runId/cancel` that cancels the linked durable run, updates the orchestration row to `failed` with `lastError: "cancelled by <actor>"`, releases the worktree (see F-003), and emits `run_cancelled` realtime + checkpoint.
- **Confidence:** High

### F-029 — `/api/v1/secrets` routes have no per-route rate limit and no `withRouteAccess` wrapper
- **Source:** R2-004, R2-015 (related)
- **Severity:** HIGH
- **Category:** Security
- **Location:** `apps/gateway/src/routes/secrets.ts` (entire file)
- **Observed:** No `config: { rateLimit: { max: N } }` blocks; relies on global `classifyRateLimitBucket` defaulting to "auth" (60/min). Auth routes set explicit per-route limits — secrets routes do not. Access class is also inferred from URL prefix rather than explicit.
- **Why it matters:** `POST /api/v1/secrets/providers/:providerId` writes provider API keys. In `auth=none` or `auth=loopback` mode this is unauthenticated on loopback — high-speed probing for key acceptance is possible.
- **Suggested direction:** Wrap all secrets routes with `withRouteAccess(fastify, "operator", { config: { rateLimit: { max: RATE_LIMIT_AUTH_MAX } } })`.
- **Confidence:** High

### F-030 — Code Mode sandbox launch inherits full `process.env` on multiple paths, including the unsandboxed advisory path
- **Source:** R2-005
- **Severity:** HIGH
- **Category:** Security
- **Status update (2026-05-17):** Resolved in the current Code Mode runtime. Code Mode child execution now uses a minimal synthetic environment, and gateway regressions assert provider/auth secrets are stripped before child execution. This finding is retained as historical review context, not an active current defect.
- **Location:** `apps/gateway/src/services/code-mode-sandbox/types.ts:18-25, 99-109`; `linux-firejail-adapter.ts:85`; `windows-appcontainer-adapter.ts:87`
- **Observed at review time:** `CodeModeSandboxLaunchInput.env: NodeJS.ProcessEnv` was passed directly to the child process. That is no longer the current launch posture.
- **Why it mattered at review time:** Code Mode runs shell commands in worktrees. Commands influenced by agent/user content could exfiltrate provider/auth secrets if those secrets reached the child environment.
- **Resolution direction:** Implemented with a minimal synthetic Code Mode child environment and regression coverage for stripped provider/auth secrets.
- **Confidence:** Resolved in current runtime; re-check the Code Mode child environment tests if this area changes.

### F-031 — Loopback bypass grants full operator-level access without any token, regardless of `auth.mode`
- **Source:** R2-006
- **Severity:** HIGH
- **Category:** Security
- **Location:** `apps/gateway/src/plugins/auth.ts:127-130, 351-356`
- **Observed:** With `auth.allowLoopbackBypass=true`, any `127.0.0.1`/`::1` request with no `X-Forwarded-For` gets `authActorSource: "loopback"`, which counts as operator. Applies regardless of `auth.mode`.
- **Why it matters:** If the gateway is ever bound to `0.0.0.0` via `GATEWAY_HOST`, and a reverse proxy is inserted that strips XFF, any client can spoof loopback. The default in canonical Settings (F-006) makes this likely.
- **Suggested direction:** Document risk prominently. Startup warning when `allowLoopbackBypass=true` and `GATEWAY_HOST != 127.0.0.1`. Or restrict to literal socket address only.
- **Confidence:** Medium

### F-032 — `listChatSessions` does N+1 prefs lookup × 20000 sessions per call
- **Source:** R3-CR-3, R3-M-6 (compound)
- **Severity:** HIGH
- **Category:** Performance
- **Location:** `apps/gateway/src/services/chat-session-service.ts:62-75`
- **Observed:** `deps.storage.sessions.list(20000)` hard-coded ceiling regardless of caller `limit`. Then `sessionIds.map((id) => [id, deps.storage.chatSessionPrefs.get(id)?.mode ?? "chat"])` — one sqlite query per session. No `listBySessionIds` method on `chatSessionPrefs`. Called from rail badges, dropdowns, search.
- **Why it matters:** 20000 × ~10 µs = ~200 ms of blocking on the main thread per list call. With long-lived installs holding tens of thousands of sessions, megabytes of rows allocate and GC per call.
- **Suggested direction:** Add `ChatSessionPrefsRepository.listBySessionIds(ids)` mirroring `chat-tool-run-repo.ts:listByTurnIds`. Push filters and `limit` into SQL via the existing cursor-based statement.
- **Confidence:** High

### F-033 — Every stream chunk triggers a full ThreadedTimeline re-render — no memoization, fresh `AssistantRuntimeProvider` per turn
- **Source:** R3-CR-4, R3-H-4 (convergent)
- **Severity:** HIGH
- **Category:** Performance / UX
- **Location:** `apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx:453-599`, `packages/threaded-surface-core/src/chat/useChatOutboundExecution.ts:771-773`, `packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx:103-158`
- **Observed:** Neither `ThreadedTimeline` nor `ThreadTurnCard` is wrapped in `React.memo`. Each delta chunk bumps `messageMutationVersionRef` and re-creates `thread`, re-rendering the whole timeline. Each `<AssistantMessageRenderer>` instantiates a new `useExternalStoreRuntime` + `<AssistantRuntimeProvider>` — full assistant-ui runtime spin-up per turn per render.
- **Why it matters:** 100-turn thread × 200-chunk stream = 20,000 re-renders + 20,000 runtime initializations. Visible jank on mid-tier laptops; layout thrashing; GC pressure. The longer the session, the worse — opposite of an "agentic UI" promise.
- **Suggested direction:** Wrap `ThreadTurnCard` in `React.memo` with explicit equality. Use the lighter `ReactMarkdown` fallback for inactive turns; the runtime path only for the active streaming turn. Add `react-window` virtualization past ~50 turns.
- **Confidence:** High

### F-034 — Realtime `EventEmitter` has no `setMaxListeners` — 25 SSE clients per IP trigger MaxListenersExceededWarning storm
- **Source:** R3-H-2
- **Severity:** HIGH
- **Category:** Performance
- **Location:** `apps/gateway/src/services/realtime-event-service.ts:24`, `apps/gateway/src/routes/events.ts:190-201`
- **Observed:** Default Node limit is 10. SSE allows 25 per IP. Listeners array grows linearly with closures over SSE response.
- **Suggested direction:** `this.events.setMaxListeners(0)` in the constructor (or to `Math.max(64, 25 * 4)`). Better: switch to a fan-out queue with a single dispatcher.
- **Confidence:** High

### F-035 — Attachment upload base64-roundtrips both ends — peak ~75 MB per concurrent upload
- **Source:** R3-H-3
- **Severity:** HIGH
- **Category:** Performance
- **Location:** `packages/mission-control-shared/src/api/chat.ts:890-906, 1234-1258`; `apps/gateway/src/services/chat-attachment-service.ts:23-44`; `apps/gateway/src/routes/chat.attachments.ts:24-41`
- **Observed:** `FileReader.readAsDataURL` then JSON body with `bytesBase64`. Server route `bodyLimit ≈ 27 MB`; cap 20 MB. Peak memory = base64 string (~27 MB) + decoded buffer (20 MB) + Zod-parsed body (~27 MB).
- **Suggested direction:** Switch to `multipart/form-data` streamed via `@fastify/multipart`. Add per-session and per-workspace upload quotas.
- **Confidence:** High

### F-036 — `splitIntoChunks` is O(N²) on message length — called per-stream-finalize
- **Source:** R3-H-5
- **Severity:** HIGH
- **Category:** Performance
- **Location:** `apps/gateway/src/services/chat-turn-helpers.ts:30-43`
- **Observed:** Loop reallocates the entire rest-of-string each iteration via `remaining.slice(chunkSize)`. 50,000-char output × 120 chunk size ≈ 10M characters moved.
- **Suggested direction:** Index-based `for (let i = 0; i < input.length; i += chunkSize) chunks.push(input.slice(i, i + chunkSize));`.
- **Confidence:** High

### F-037 — Cowork panel renders 9+ vertical sections without visual hierarchy
- **Source:** R4-COWORK-001
- **Severity:** HIGH
- **Category:** UX
- **Location:** `apps/mission-control-next/src/features/threaded-surface/ThreadedWorkflowPanel.tsx:227-440`
- **Observed:** Stack: head → stage-strip → mission-brief → now → action-callout → tab row → tab content → blockers → agentic-runtime panel. Same z-level, same border, same typography weight. "Next operator action" is buried.
- **Suggested direction:** Hoist "Next operator action" to the top. Collapse mission-brief / facts / agents / blockers into a single header summary card. Move agentic runtime into a dedicated tab.
- **Confidence:** High

### F-038 — Run-map "plan graph" is a horizontal scroll of identical gray cards — communicates nothing
- **Source:** R4-COWORK-002, R4-COWORK-007 (convergent)
- **Severity:** HIGH
- **Category:** UX
- **Location:** `apps/mission-control-next/src/features/threaded-surface/ThreadedWorkflowPanel.tsx:483-494, 546-561`
- **Observed:** `.mc-next-cowork-run-map-graph` is `display: flex; overflow-x: auto`. Each node is fixed-width with a 1px link; no status colors, no real DAG, no minimap. Subagent tree is a flat `<PanelList>` with no hierarchy.
- **Suggested direction:** Use `react-flow` (already in dep family) for the DAG. Status-colored nodes, real arrows, minimap past 6 nodes. Build a real tree view (existing `react-arborist` dep) for the subagent fan-out.
- **Confidence:** High

### F-039 — Approval card doesn't autofocus, doesn't aggressively scroll-into-view, no top-banner alert
- **Source:** R4-COWORK-004, R4-COWORK-011 (related)
- **Severity:** HIGH
- **Category:** UX
- **Location:** `apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx:521-539`, `packages/mission-control-shared/src/components/InlineApprovalPrompt.tsx:109-211`
- **Observed:** Approval inline-renders at the bottom of `.mc-next-thread-list`. Composer is dimmed via CSS, but the card itself has only `scroll-margin-block: 1rem`. On a long thread, the user may not see it. No keyboard shortcuts to approve/deny.
- **Suggested direction:** Auto-scroll smooth+center, focus first action by default, add sticky "1 approval waiting — jump to it" banner when out of viewport. Add keyboard accelerators (a=allow once, s=session, w=workspace, d=deny).
- **Confidence:** High

### F-040 — Monaco workbench has no keyboard shortcuts wired (no Cmd+S, no Cmd+P, no Cmd+Shift+P)
- **Source:** R4-CODE-001
- **Severity:** HIGH
- **Category:** UX
- **Location:** `packages/mission-control-shared/src/components/WorkbenchMonacoEditor.tsx:58-78`
- **Observed:** Editor created with default config; no `addAction`/`addCommand` for save, quick-open, or command palette. `onSaveFile` only fires from a toolbar button.
- **Why it matters:** Owner asked for a "real coding surface (Monaco + file tree + terminal + diffs)." VS Code shortcuts are what users expect from Monaco.
- **Suggested direction:** Wire `Cmd/Ctrl+S` → `onSaveFile`; `Cmd/Ctrl+Shift+P` → command palette of workbench actions; `Cmd/Ctrl+P` → file picker.
- **Confidence:** High

### F-041 — File tree has no create/rename/delete/duplicate; "Terminal" pane is a read-only Monaco editor showing markdown
- **Source:** R4-CODE-003, R4-CODE-004 (convergent)
- **Severity:** HIGH
- **Category:** UX
- **Location:** `packages/mission-control-shared/src/components/WorkbenchFileTree.tsx:79-163`; `apps/mission-control-next/src/features/threaded-surface/ThreadedWorkflowPanel.tsx:1075-1101`
- **Observed:** Tree props are select/expand-only. The "Output" pane uses `<WorkbenchMonacoEditor value={output.output} language="markdown" readOnly>`. No xterm, no run-command, no clear button.
- **Why it matters:** Owner explicitly listed file ops and terminal as Code-surface requirements.
- **Suggested direction:** Right-click context menu + drag-drop for tree. Integrate xterm.js for a real terminal bound to the worktree shell.
- **Confidence:** High

### F-042 — Workbench has no resize handles or pane size persistence; below 1360px stacks into one giant scroll
- **Source:** R4-CODE-005, R4-CODE-007 (convergent)
- **Severity:** HIGH
- **Category:** UX
- **Location:** `apps/mission-control-next/src/features/threaded-surface/threaded-surface.css:1877-1902, 1939-1962`
- **Observed:** Fixed grid columns. `react-reflex` (in deps) is unused here. At `max-width: 1360px`, workbench flattens to a stacked column with fixed editor 520 px + terminal 240 px.
- **Suggested direction:** Use `react-reflex` for splits; persist sizes to localStorage scoped by workspace. At narrower widths, hide workbench by default with a floating "Open editor" toggle, or tab between Thread/Workbench.
- **Confidence:** High

### F-043 — Workbench toolbar is a single overflowing row of ~10+ buttons + validation input; wraps unpredictably
- **Source:** R4-CODE-010
- **Severity:** HIGH
- **Category:** UX
- **Location:** `apps/mission-control-next/src/features/threaded-surface/ThreadedWorkflowPanel.tsx:860-960`
- **Observed:** Refresh, Save file, Discard draft, Create worktree, validation input, Typecheck, Test, Lint, Fast verify, Apply, Export, Revert file, Revert all — all equal weight.
- **Suggested direction:** Group: File (Save/Discard/Revert), Repo (Create worktree, Apply/Export patch, Revert all), Validation. Move secondary into overflow `…` menu.
- **Confidence:** High

### F-044 — Orphan CSS class names from chat / status surfaces — components render unstyled
- **Source:** R4-CHAT-013, R4-CHAT-014, R4-Top-Level-5 (convergent)
- **Severity:** HIGH
- **Category:** UX
- **Location:** `packages/mission-control-shared/src/components/chat/ChatStreamStatusBar.tsx:56`, `ChatQueueBar.tsx:58`, `SurfaceReconnectBanner.tsx:95`, `StatusChip.tsx:11-13`; CSS expected in `apps/mission-control-next/src/styles/*`
- **Observed:** `.chat-stream-status-bar`, `.chat-v11-queue-bar`, `.surface-reconnect-banner`, `.status-chip-success/-warning/-critical/-muted/-live/-default` exist in JSX but have no rules in next-app CSS (only in legacy `apps/mission-control/src/styles/chat-surface.css`). All chips look identical regardless of tone.
- **Why it matters:** Operator cannot distinguish "failing" from "fine" at a glance. The components do their job; the styles never landed in the canonical shell.
- **Suggested direction:** Port the rules into `threaded-surface.css` / `mission-control-next.css`. Audit every legacy classname rendered by `packages/mission-control-shared/src/components/chat/*` against the canonical CSS.
- **Confidence:** High

### F-045 — Naked `outline: none` on textarea / turn surface / rail inputs; no `:focus-visible` ring — WCAG 2.4.7 blocker
- **Source:** R4-CHAT-016, R4-CC-008 (related)
- **Severity:** HIGH
- **Category:** UX / A11y
- **Location:** `apps/mission-control-next/src/features/threaded-surface/threaded-surface.css:282, 1127, 1601, 1606-1609`
- **Observed:** `outline: none` applied without replacement focus ring. Keyboard navigation produces no visual signal.
- **Suggested direction:** Add `:focus-visible` rings on every interactive element. Match area-color tokens for theming.
- **Confidence:** High

### F-046 — Compact-layout (≤1180px) is dead CSS; `:has()` opacity rule degrades silently on older browsers
- **Source:** R4-CC-007, R4-CHAT-017 (related)
- **Severity:** HIGH
- **Category:** UX
- **Location:** `apps/mission-control-next/src/features/threaded-surface/ThreadedSurfacePage.tsx:52, 322, 468`; `threaded-surface.css:772-793`
- **Observed:** `compactLayout = useMediaQuery("(max-width: 1180px)")` toggles a `.compact` class with no matching CSS rule. `:has()` selector for blocked-composer opacity has no fallback; `aria-disabled` is set in JS but CSS does not react to it.
- **Suggested direction:** Either define `.mc-next-threaded-conversation.compact` rules or delete the hook. Switch the opacity hook from `:has()` to the JS-set `data-blocked-by-inline-prompt="true"` attribute.
- **Confidence:** High

### 4.3 MEDIUM (47 items)

### F-047 — Tool Profile / Budget Mode dropdowns have no per-option help; layman cannot pick safely
- **Source:** R5-RT-1, R5-RT-2 (convergent)
- **Severity:** MEDIUM (but operator-critical for first-run)
- **Category:** Settings
- **Location:** `apps/mission-control/src/pages/settings/SettingsRuntimeSection.tsx:120-143`; `settings-page-constants.ts:9-16`
- **Observed:** Tool Profile options: `minimal (safest)`, `standard`, `coding`, `ops`, `research`, `danger (high risk)`. Only minimal/danger annotated. Budget Mode: `saver/balanced/power` with zero text.
- **Suggested direction:** Per-option help: "minimal: read-only, no shell, no browser. standard: read/write workspace, browser, no shell. coding: + git, package manager, test runners. ops: + shell, system inspection. research: + network reads. danger: full unrestricted access." Same for Budget Mode (context-window + model tier per mode).
- **Confidence:** High

### F-048 — Provider API Style dropdown has 4 enum values with no per-option description
- **Source:** R5-MD-1
- **Severity:** MEDIUM
- **Category:** Settings
- **Location:** `apps/mission-control/src/pages/settings/SettingsModelsSection.tsx:314-334`; `settings-page-constants.ts:93-98`
- **Observed:** `OpenAI Responses`, `OpenAI Codex Responses`, `Anthropic Messages`, `OpenAI Chat Completions`. One paragraph HelpHint covers the whole field. `resolvedApiStyle` silently re-resolves picks, compounding confusion.
- **Suggested direction:** Per-option label: e.g., `OpenAI Responses (POST /v1/responses — newer, streaming-native)`, etc.
- **Confidence:** High

### F-049 — Deployment Profile defaults to `local_dev` even on remote installs; raw snake_case shown to users
- **Source:** R5-RT-3, R5-OV-2 (convergent)
- **Severity:** MEDIUM
- **Category:** Settings / Security UX
- **Location:** `apps/mission-control/src/pages/SettingsPage.tsx:88-90`; `apps/mission-control/src/pages/settings-page-utils.ts:54-62`
- **Current status:** Partially superseded. Raw deployment-profile labels now map to human-readable labels in the shared and legacy settings helpers. The remote-bind default/banner recommendation remains a distinct runtime-posture follow-up.
- **Observed:** Initial state `useState("local_dev")`. `formatDeploymentProfileLabel` returns raw snake_case. No detection of non-loopback bind.
- **Suggested direction:** When `GATEWAY_HOST != 127.0.0.1`, default to `remote_hardened`. Banner if mismatch. Map enum to human labels.
- **Confidence:** High

### F-050 — `auth=none` "Local trusted" / loopback bypass labels lack risk callouts and recommended copy
- **Source:** R5-AC-1, R5-AC-2 (convergent)
- **Severity:** MEDIUM
- **Category:** Settings
- **Location:** `apps/mission-control/src/pages/settings/SettingsAccessSection.tsx:67-95`
- **Observed:** Auth mode dropdown uses internal jargon ("none (local trusted)"); loopback-bypass toggle has zero help and silently no-ops when mode=none.
- **Suggested direction:** Tooltip per option (recommended copy in R5-AC-1). Disable/hide toggle when mode=none; add FieldHelp for token/basic modes.
- **Confidence:** High

### F-051 — Provider templates default to forward-dated model IDs that may not exist on providers
- **Source:** R5-MD-2
- **Severity:** MEDIUM
- **Category:** Settings
- **Location:** `packages/contracts/src/provider-templates.ts:13-181`
- **Observed:** Anthropic → `claude-sonnet-4-6`; OpenAI → `gpt-5.4`; Google → `models/gemini-2.5-flash`; GLM → `glm-5`; DeepSeek → `deepseek-v4-flash`.
- **Why it matters:** Test Chat fails after picking a default; first-run user blames Mission Control.
- **Suggested direction:** Snapshot model IDs at release. Add `lastValidatedAt` to each template; UI shows freshness.
- **Confidence:** High

### F-052 — API Key labeled "(optional)" while it's mandatory for cloud providers
- **Source:** R5-MD-3
- **Severity:** MEDIUM
- **Category:** Settings
- **Location:** `apps/mission-control/src/pages/settings/SettingsModelsSection.tsx:402-410`
- **Observed:** Always labeled "(optional)". True for LM Studio/Ollama/llama.cpp; false for OpenAI/Anthropic/GLM/Moonshot.
- **Suggested direction:** Conditional "(required)" when selected provider isn't local.
- **Confidence:** High

### F-053 — `.env.example` lists fewer than half the env vars referenced by code and Settings UI
- **Source:** R5-CC-4
- **Severity:** MEDIUM
- **Category:** Settings / Docs
- **Location:** `.env.example:1-60`; `INSTALL_SETUP_TESTING.md:345-374`; `SettingsModelsSection.tsx:442-454`
- **Observed:** `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `FIRECRAWL_API_KEY`, `GOATCITADEL_AUTH_TOKEN`, `GOATCITADEL_ALLOWED_ORIGINS` missing from `.env.example`.
- **Suggested direction:** Expand `.env.example` (commented out for keys); add FieldHelp by env-name dropdown.
- **Confidence:** High

### F-054 — Voice settings: 13 buttons crammed into one section, "Repair Voice Runtime" rendered twice
- **Source:** R5-VC-1, R5-VC-5 (convergent)
- **Severity:** MEDIUM
- **Category:** Settings / UX
- **Location:** `apps/mission-control/src/pages/settings/SettingsVoiceSection.tsx:208-414, 214-217, 313-319`
- **Observed:** Recovery, install/activate, talk-mode start/stop, wake enable/disable, run transcription — all flat. Same button rendered twice with identical callback.
- **Suggested direction:** Add a top-level "Voice features OFF by default" master toggle; hide controls until enabled. Show recovery button only when recovery context active.
- **Confidence:** High

### F-055 — "Forge" vs "Settings" used interchangeably across UI strings
- **Source:** R5-CC-7, R5-CC-10
- **Severity:** MEDIUM
- **Category:** Settings
- **Location:** `apps/mission-control/src/pages/SettingsPage.tsx:937`; `SettingsSectionNav.tsx:18`; `copy.ts:492`
- **Observed:** "Loading Forge settings…", "Forge Sections" aside header, "Forge controls how GoatCitadel runs…" — all next to "Settings" rail labels.
- **Suggested direction:** Pick one brand. If "Forge" is kicker, "Settings" is rail label — use consistently.
- **Confidence:** High

### F-056 — Settings UI inputs lack inline validation (URLs, env-var names, numbers silently coerce)
- **Source:** R5-CC-5, R5-MD-7
- **Severity:** MEDIUM
- **Category:** Settings
- **Location:** `SettingsRuntimeSection.tsx:204-232, 243-249`; `SettingsModelsSection.tsx:300-313`
- **Observed:** Firecrawl Base URL relies on browser-default validation. Firecrawl API Key Env has no env-var-name shape check. Timeout coerces invalid input silently to 20000. Base URL accepts strings without protocol.
- **Suggested direction:** Zod-validate on blur. Inline `<span class="form-error">` for messages. Surface "Reset because value was unreadable" when coercion fires.
- **Confidence:** High

### F-057 — Settings page first-run lacks zero-state CTA when no provider configured; loading state is a single line
- **Source:** R5-CC-3, R5-CC-8, R5-CC-9 (convergent)
- **Severity:** MEDIUM
- **Category:** Settings
- **Location:** `SettingsPage.tsx:937`; `SettingsHubPage.tsx:69-72`; `SettingsModelsSection.tsx:149`
- **Observed:** "Loading Forge settings…" with no skeleton or spinner. No "Start here →" arrow for first-run users; layman doesn't know "Models" is where provider setup lives.
- **Suggested direction:** Rename "Models" → "Providers & Models" everywhere. When `!settings.llm.activeProviderId`, render a top banner "No active provider — jump to Providers & Models →". Use `GoatLoader`/skeleton instead of plain text.
- **Confidence:** High

### F-058 — Composer textarea cannot autosize (fixed `rows={4}`); send button is 50×25 px touch target
- **Source:** R4-CHAT-007, R4-CHAT-008 (convergent)
- **Severity:** MEDIUM
- **Category:** UX
- **Location:** `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx:370-378`; CSS `threaded-surface.css:1422-1427`
- **Suggested direction:** Auto-grow textarea up to `max-height: 14rem`. Bump send to `min-height: 2.25rem` with an icon.
- **Confidence:** High

### F-059 — Stream auto-scroll uses smooth behavior on every chunk; fights itself on fast streams
- **Source:** R4-CHAT-009
- **Severity:** MEDIUM
- **Category:** UX / Performance
- **Location:** `ThreadedTimeline.tsx:460-488, 491`
- **Suggested direction:** `behavior: "auto"` while streaming; detect user scroll-up to pause autoscroll.
- **Confidence:** High

### F-060 — Thread scroll capped at `min(58dvh, 44rem)` — wastes ~40% of vertical real-estate
- **Source:** R4-CHAT-010
- **Severity:** MEDIUM
- **Category:** UX
- **Location:** `threaded-surface.css:920-925`
- **Suggested direction:** Let thread-scroll fill column with `flex: 1`; composer sticky stays inside the column.
- **Confidence:** High

### F-061 — Empty state shows mode-label verbs; no suggested prompts or recent threads
- **Source:** R4-CHAT-006
- **Severity:** MEDIUM
- **Category:** UX
- **Location:** `ThreadedSurfacePage.tsx:500-549`
- **Suggested direction:** Suggested prompts, recent threads with click-to-fork, mode-specific copy.
- **Confidence:** High

### F-062 — `commandSuggestions` listbox lacks combobox/listbox ARIA wiring
- **Source:** R4-CHAT-020
- **Severity:** MEDIUM
- **Category:** UX / A11y
- **Location:** `ThreadedComposer.tsx:381-395`
- **Suggested direction:** Proper combobox semantics (`role="combobox" aria-expanded aria-controls aria-activedescendant`); items as `role="option"`.
- **Confidence:** High

### F-063 — Cowork header tab row + code-source chooser tabs lack ARIA `role="tablist"`
- **Source:** R4-COWORK-013, R4-CODE-009 (convergent)
- **Severity:** MEDIUM
- **Category:** UX / A11y
- **Location:** `ThreadedWorkflowPanel.tsx:354-371, 70-85, 691-1014`
- **Suggested direction:** Apply WAI-ARIA tabs pattern with arrow-key nav.
- **Confidence:** High

### F-064 — `MissionControlNextApp` polls dashboard + health every 15 s forever, including on hidden tabs
- **Source:** R3-M-2
- **Severity:** MEDIUM
- **Category:** Performance
- **Location:** `apps/mission-control-next/src/app/MissionControlNextApp.tsx:448-456`
- **Suggested direction:** Suspend on `document.hidden`; lengthen to 60 s; or move into the existing event stream.
- **Confidence:** High

### F-065 — Server-side durable-stream live tail polls sqlite every 200 ms per turn per viewer
- **Source:** R3-M-1
- **Severity:** MEDIUM
- **Category:** Performance
- **Location:** `apps/gateway/src/services/gateway-service.ts:2511-2534`
- **Suggested direction:** Subscribe via the realtime event emitter gated on `chat_stream_event_appended`.
- **Confidence:** Medium

### F-066 — `realtimeEvents.append` runs inline DELETE every 100 events — synchronous prune on publish hot path
- **Source:** R3-M-7
- **Severity:** MEDIUM
- **Category:** Performance
- **Location:** `packages/storage/src/realtime-event-repo.ts:137-138, 218-221`
- **Suggested direction:** Defer pruning to setImmediate/queueMicrotask or a periodic 60-s timer.
- **Confidence:** Medium

### F-067 — `listHydratedChatTurnTraces` does N+1 fetch of execution plans
- **Source:** R3-H-1
- **Severity:** MEDIUM
- **Category:** Performance
- **Location:** `apps/gateway/src/services/chat-turn-trace-hydration.ts:33-61`
- **Suggested direction:** Add `ChatExecutionPlanRepository.listByPlanIds(ids)`; same pattern as `chat-tool-run-repo.listByTurnIds`.
- **Confidence:** High

### F-068 — Three.js / @react-three/fiber / drei in `apps/mission-control-next/package.json` but never imported in `src/`
- **Source:** R3-H-6
- **Severity:** MEDIUM
- **Category:** Performance / Quality
- **Location:** `apps/mission-control-next/package.json:33-34, 57, 65`
- **Suggested direction:** Drop if unused. If a feature is planned, lazy-import behind a code-split route.
- **Confidence:** Medium

### F-069 — Hooks can mutate plan during pending approval — no optimistic lock on `upsertPlan`
- **Source:** R6-H3
- **Severity:** MEDIUM
- **Category:** Orchestration
- **Location:** `apps/gateway/src/services/orchestration-lifecycle-service.ts:540-568`
- **Suggested direction:** Optimistic locking on `upsertPlan`, or per-plan mutex, or hook-patch overlay records keyed by `(planId, phaseId)`.
- **Confidence:** High

### F-070 — Engine bypasses cost/runtime limit check on the LAST phase
- **Source:** R6-H5
- **Severity:** MEDIUM
- **Category:** Orchestration
- **Location:** `packages/orchestration/src/engine.ts:180-193`
- **Observed:** `next &&` guard means limit check is skipped when current phase is the last; run lands `completed` even if `totalCostUsd >= maxCostUsd`.
- **Suggested direction:** Apply limit check regardless of successor.
- **Confidence:** High

### F-071 — `executeDurableOrchestrationRun` while-loop never checks `context.signal.aborted` mid-loop
- **Source:** R6-H6
- **Severity:** MEDIUM
- **Category:** Orchestration
- **Location:** `apps/gateway/src/services/orchestration-lifecycle-service.ts:720-752`
- **Observed:** Today harmless because phase loop is a no-op. Once F-001 is wired, the loop will starve worker, fight lease heartbeats, and ignore abort.
- **Suggested direction:** Check abort between phases, yield for fairness, run each phase under `executeWithLeaseHeartbeat`.
- **Confidence:** High

### F-072 — `LlmService` fallback hardcodes "moonshot" as the cross-provider fallback target
- **Source:** R1-005
- **Severity:** MEDIUM
- **Category:** Architecture / Security
- **Location:** `apps/gateway/src/services/gateway-service.ts:5340-5341`
- **Observed:** Active provider + hardcoded `moonshot` as the only fallback candidate. Privacy/regulatory surprise for users who never selected Kimi.
- **Suggested direction:** Drive fallback from config or a routing-policy module. Get the string out of source.
- **Confidence:** High

### F-073 — `policy-engine` package depends on `playwright` and ships browser-tool execution
- **Source:** R1-006, R1-OC-001 (convergent)
- **Severity:** MEDIUM
- **Category:** Architecture / Security
- **Location:** `packages/policy-engine/package.json`; `packages/policy-engine/src/browser-tools.ts`
- **Observed:** A "policy engine" that decides if a tool can run is also *running* the tool. Loses gating boundary; pulls in heavyweight Playwright transitively.
- **Suggested direction:** Move `browser-tools.ts` to `packages/browser-runtime` or `apps/gateway/src/services/browser-runtime-service.ts`. Policy engine becomes policy-only.
- **Confidence:** High

### F-074 — `memory-facade-service.ts` exports `KnowledgeFacadeService` — name/file mismatch breaks searchability
- **Source:** R1-007
- **Severity:** MEDIUM
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/memory-facade-service.ts:21`
- **Suggested direction:** Rename file to `knowledge-facade-service.ts`.
- **Confidence:** High

### F-075 — `chat-turn-runtime.ts` vs `chat-turn-runtime-service.ts` — colliding names, different concepts
- **Source:** R1-008
- **Severity:** MEDIUM
- **Category:** Architecture
- **Location:** Both files in `apps/gateway/src/services/`
- **Suggested direction:** Rename `chat-turn-runtime.ts` → `gateway-turn-runtime.ts`. Document a `-service.ts` vs `-runtime.ts` convention.
- **Confidence:** High

### F-076 — 9 route-composition files do real DI work but are typed against the 200-line port (R1-002)
- **Source:** R1-009
- **Severity:** MEDIUM
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/gateway-route-composition-*.ts` (~1,540 LOC of DI wiring)
- **Suggested direction:** Each composition file should shrink as concrete services absorb responsibility. Make port-shrinkage the explicit metric for Step 9+.
- **Confidence:** High

### F-077 — 600-line GatewayService constructor encodes hidden cyclic dependencies via closure-captured `this`
- **Source:** R1-010, R1-015 (convergent)
- **Severity:** MEDIUM
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/gateway-service.ts:650-1244` (constructor); `:743-751` (`taskLifecycleService → improvementService`); `:1102-1118`
- **Observed:** `TaskLifecycleService` captures `this.improvementService` before it's constructed; works only because the closure is lazy. One synchronous call at construction time = silent null-reference crash.
- **Suggested direction:** Two-phase construction or late-binding setters. Move construction to `gateway/builder.ts` returning a typed bag; GatewayService becomes a thin orchestrator.
- **Confidence:** High

### F-078 — 56 `/** @internal */ public` promotions on GatewayService have not been cleaned up
- **Source:** R1-004
- **Severity:** MEDIUM
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/gateway-service.ts` (56 occurrences)
- **Observed:** Scaffolding has become structural. JSDoc `/** @internal */` enforces nothing at runtime; each promotion is a public-surface widening with no scheduled rollback.
- **Suggested direction:** Move top 10 most-called members into their owning extracted modules. Sunset target: drop from 56 to <20 by end of Step 8.
- **Confidence:** High

### F-079 — Service-level state distributed across GatewayService rather than co-located with owners
- **Source:** R1-011
- **Severity:** MEDIUM
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/gateway-service.ts:632-643`; `gateway-route-composition-port.ts:84-90`
- **Observed:** GatewayService holds 12+ pieces of mutable state directly on `this`. `recentChannelSetupTests` (a mutable map) is exposed through the port to the route composition layer.
- **Suggested direction:** Push each piece into the service that conceptually owns it (e.g., `ChannelSetupCacheService`, `BackgroundTaskService`, `OnboardingStateService`).
- **Confidence:** High

### F-080 — `chat-turn-stream-service.ts` is 1,648 LOC; eslint-disabled — next monolith after gateway-service
- **Source:** R1-012, R8-022 family
- **Severity:** MEDIUM
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/chat-turn-stream-service.ts`
- **Suggested direction:** Split into `chat-turn-stream-orchestrator.ts`, `chat-turn-stream-persistence.ts`, `chat-turn-stream-events.ts`, `chat-turn-stream-fallback.ts`.
- **Confidence:** High

### F-081 — `SettingsNativePage.tsx` is 6,204 LOC; `NativeRoutePages.tsx` is 2,980 LOC; `prompt-pack-service.ts` is 9,243 LOC
- **Source:** R8-003, R8-006, R8-011
- **Severity:** MEDIUM
- **Category:** Quality
- **Location:** As listed
- **Suggested direction:** Per-domain split. Prompt-pack-service into policy/execution/scoring/evidence services; Settings into per-section subpages.
- **Confidence:** High

### F-082 — Three copies of `cowork-view-model.ts` — two differ functionally (durable recovery state)
- **Source:** R8-004
- **Severity:** MEDIUM
- **Category:** Quality
- **Location:** `apps/mission-control/src/components/cowork-view-model.ts` (522 LOC); `packages/mission-control-shared/src/components/cowork-view-model.ts` (879 LOC); `packages/threaded-surface-core/src/cowork-view-model.ts` (879 LOC)
- **Observed:** Last two differ by 46 lines; the threaded-surface-core copy has an extra `durableRecoveryState` block.
- **Suggested direction:** Delete the mission-control-shared copy; re-export from threaded-surface-core (or vice versa). Legacy copy stays for rollback.
- **Confidence:** High

### F-083 — `apps/mission-control` maintains parallel implementations of 29 API client modules vs the canonical `mission-control-shared` package
- **Source:** R8-005
- **Severity:** MEDIUM
- **Category:** Quality
- **Location:** `apps/mission-control/src/api/*.ts` (29 files) vs `packages/mission-control-shared/src/api/*.ts` (32 files)
- **Observed:** `chat.ts`: 1,190 vs 1,258 LOC, diff 2,450 lines. `client.ts`: 1,085 vs 1,159 LOC, diff 104 lines.
- **Suggested direction:** Convert legacy to thin shims that re-export from the shared package. Track sunset milestone in `1_0_RELEASE_EVIDENCE.md`.
- **Confidence:** High

### F-084 — 47 personality `.md` files under `docs/personalities/` are referenced by path string but never `fs.readFile`-loaded
- **Source:** R8-002
- **Severity:** MEDIUM
- **Category:** Quality
- **Location:** `apps/gateway/src/services/channel-personalities.ts:447-455, 503`; `docs/personalities/{core,thinking,chaos,critical,execution,flavor,social}/*.md`
- **Observed:** `soulFile` is included in the LLM overlay as a path reference only. Actual personality instruction is the inline `systemOverlay` string. `.md` content already drifted from inline overlay text in samples.
- **Suggested direction:** Either load the `.md` content at startup (single `readFileSync` per preset) making the file the source of truth, or delete the `.md` files and remove the `soulFile` field. Pick one.
- **Confidence:** High

### F-085 — 19 "moved to X" tombstone comments in `gateway-service.ts`, including a duplicate at lines 3028/3030
- **Source:** R8-008, R8-036
- **Severity:** MEDIUM
- **Category:** Quality
- **Location:** `apps/gateway/src/services/gateway-service.ts:1814, 2691-3030, 3329-5572, 6524`
- **Suggested direction:** Delete all 19. Git blame retains the move record.
- **Confidence:** High

### F-086 — `docs/A2UI_CONTRACT.md:71` references non-existent `artifacts/follow-on-parity/a2ui/` path
- **Source:** R8-009
- **Severity:** MEDIUM
- **Category:** Quality / Docs
- **Location:** `docs/A2UI_CONTRACT.md:71`
- **Suggested direction:** Either create directory with proof bundle, or rewrite doc to point at actual artifact location.
- **Confidence:** High

### F-087 — `docs/screenshots/mission-control/` exists but is empty; README claims it as generated output
- **Source:** R8-010
- **Severity:** MEDIUM
- **Category:** Quality / Docs
- **Location:** `docs/screenshots/mission-control/`; `README.md:211`
- **Suggested direction:** Delete subdirectory or check in a representative set for the 1.0 tag.
- **Confidence:** High

### F-088 — `lazy-legacy-pages.tsx` is named "legacy" but loads exclusively canonical next-shell pages
- **Source:** R8-014
- **Severity:** MEDIUM
- **Category:** Quality
- **Location:** `apps/mission-control-next/src/app/lazy-legacy-pages.tsx:1-24`
- **Suggested direction:** Rename to `lazy-next-pages.tsx`. Test file follows.
- **Confidence:** High

### F-089 — Two `OrchestrationEngine` exports across `packages/orchestration` and `apps/gateway/src/orchestration` with different concerns
- **Source:** R8-019
- **Severity:** MEDIUM
- **Category:** Quality / Architecture
- **Location:** `packages/orchestration/src/engine.ts:19`; `apps/gateway/src/orchestration/engine.ts:20`
- **Suggested direction:** Rename one — `WaveOrchestrationEngine` for the package version, `executeChatOrchestrationPlan` for the gateway version.
- **Confidence:** High

### F-090 — Notifications stack has no auto-dismiss, no enter/exit animation, overlaps composer
- **Source:** R4-CC-001
- **Severity:** MEDIUM
- **Category:** UX
- **Location:** `packages/mission-control-shared/src/components/NotificationStack.tsx:48-90`
- **Suggested direction:** Auto-dismiss info/success after 4-6 s; keep error/warning pinned. CSS transitions for enter/exit. Reposition so it doesn't collide.
- **Confidence:** High

### F-091 — Only two CSS transitions exist in the entire `threaded-surface.css` (~2120 lines)
- **Source:** R4-CC-002
- **Severity:** MEDIUM
- **Category:** UX
- **Location:** `threaded-surface.css:436, 1985`
- **Suggested direction:** Base transitions: 150ms hover, 200ms message fade-in, 250ms panel slide. Respect `prefers-reduced-motion`.
- **Confidence:** High

### F-092 — `aria-live` regions sparse; many live states unannounced
- **Source:** R4-CC-003
- **Severity:** MEDIUM
- **Category:** UX / A11y
- **Location:** Multiple — Cowork "Now" section, workbench validation status, streaming bubble (see F-022)
- **Suggested direction:** Add `role="status" aria-live="polite"` to those regions; assertive for errors only.
- **Confidence:** High

### F-093 — Turn surface card is `role="button" tabIndex={0}` while containing nested interactive elements
- **Source:** R4-CC-008
- **Severity:** MEDIUM
- **Category:** UX / A11y
- **Location:** `ThreadedTimeline.tsx:193-201`
- **Suggested direction:** Drop button-role from the whole surface. Use a dedicated "Select turn" control or `aria-current` selection indicator.
- **Confidence:** High

### F-094 — Buttons share a single class with no semantic variants (primary/secondary/ghost/danger)
- **Source:** R4-CC-018
- **Severity:** MEDIUM
- **Category:** UX
- **Location:** Across the threaded-surface tree
- **Suggested direction:** Define and apply `primary` (filled), `secondary` (outlined), `ghost` (text), `danger` (red filled), `subtle`.
- **Confidence:** High

### F-095 — Drop target accepts any file type/size; main file input has no `accept`
- **Source:** R4-CC-012
- **Severity:** MEDIUM
- **Category:** UX
- **Location:** `packages/threaded-surface-core/src/chat/useChatComposerInteractions.ts:80-104`; `ThreadedSurfacePage.tsx:282-287, 522`
- **Suggested direction:** Client-side type allowlist + size cap; feedback chip when files are rejected.
- **Confidence:** High

### F-096 — Mode-color theming dilutes risk signals via `--mc-area-color` mix
- **Source:** R4-COWORK-014
- **Severity:** MEDIUM
- **Category:** UX
- **Location:** `threaded-surface.css:9-29, 156-159`
- **Suggested direction:** Don't tint risk chips/banners with `--mc-area-color`. Keep risk colors stable across surfaces.
- **Confidence:** Medium

### 4.4 LOW (29 items)

### F-097 — Diff editor forced `renderSideBySide: true`; no unified-view toggle
- **Source:** R4-CODE-006
- **Severity:** LOW
- **Category:** UX
- **Location:** `packages/mission-control-shared/src/components/MonacoDiffEditor.tsx:64-73`
- **Suggested direction:** Toolbar toggle; auto-switch to unified below 900px.
- **Confidence:** High

### F-098 — Validation history limited to last 5 with no filtering or status colors
- **Source:** R4-CODE-008
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedWorkflowPanel.tsx:1184-1204`
- **Suggested direction:** Show all (paginated), color-code by status, click to expand stdout/stderr.
- **Confidence:** High

### F-099 — `WorkbenchFileTree` height clamped to fixed math — small projects show empty space
- **Source:** R4-CODE-011
- **Severity:** LOW
- **Category:** UX
- **Location:** `packages/mission-control-shared/src/components/WorkbenchFileTree.tsx:89`
- **Suggested direction:** Natural sizing with `flex: 1` in column.
- **Confidence:** High

### F-100 — Monaco theme doesn't react to runtime theme toggle (no MutationObserver/context subscribe)
- **Source:** R4-CODE-012
- **Severity:** LOW
- **Category:** UX
- **Location:** `packages/mission-control-shared/src/components/WorkbenchMonacoEditor.tsx:19-23, 90-99`
- **Suggested direction:** Subscribe to theme changes via observer or context; call `monaco.editor.setTheme()`.
- **Confidence:** High

### F-101 — Code surface unbound state mismatch: sidebar shows chooser, main pane shows generic empty
- **Source:** R4-CODE-013
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedWorkflowPanel.tsx:970-991, 1015-1031`
- **Suggested direction:** Main pane mirrors the unbound state with a welcome card.
- **Confidence:** High

### F-102 — Composer chip row shows up to 6 chips at all times (font 0.6rem) — visual clutter
- **Source:** R4-CHAT-019
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedComposer.tsx:322-335`
- **Suggested direction:** Collapse into a single "i" info button popover. Show only model/speed by default.
- **Confidence:** Medium

### F-103 — Composer dropzone overlay fully covers the conversation during drag
- **Source:** R4-CHAT-011
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedSurfacePage.tsx:391-400`; CSS `threaded-surface.css:52-66`
- **Suggested direction:** Thin highlight ring + floating "Drop to attach" chip. Avoid backdrop-filter during drag.
- **Confidence:** Medium

### F-104 — Attachment preview dual fetch path can dead-end at "Preview unavailable" with no retry
- **Source:** R4-CHAT-012
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedComposer.tsx:88-171`
- **Suggested direction:** Always fetch with auth headers first. Final-failure renders a card with filename + "Open" button.
- **Confidence:** Medium-high

### F-105 — Image preview chip min-height 160px even for tiny attachments
- **Source:** R4-CHAT-018
- **Severity:** LOW
- **Category:** UX
- **Location:** `threaded-surface.css:1663-1690`
- **Suggested direction:** 72px min, 320px max.
- **Confidence:** High

### F-106 — `confirm()` browser-native dialog used for "Archive workspace chats"
- **Source:** R4-CHAT-021
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedSurfacePage.tsx:99`
- **Suggested direction:** Use existing `ConfirmModal`.
- **Confidence:** High

### F-107 — Continuation-gate decision chip uses 3 tones; unknown strings fall to "critical"
- **Source:** R4-COWORK-009
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedWorkflowPanel.tsx:458-462`
- **Suggested direction:** Map known decisions; default to `muted`.
- **Confidence:** High

### F-108 — Blocker cards lack severity color and inline resolution
- **Source:** R4-COWORK-010
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedWorkflowPanel.tsx:411-428`
- **Suggested direction:** Severity-colored left border, inline resolve/dismiss/escalate, group counters at top.
- **Confidence:** High

### F-109 — Approval countdown chip is small and subtle; no progress ring/pulse
- **Source:** R4-COWORK-012
- **Severity:** LOW
- **Category:** UX
- **Location:** `threaded-surface.css:980-1000`
- **Suggested direction:** Progress ring + subtle pulse on low-time.
- **Confidence:** Medium

### F-110 — Cowork checkpoint timeline is a single concatenated string with `" -> "`
- **Source:** R4-COWORK-006
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedWorkflowPanel.tsx:506-509`
- **Suggested direction:** Stepper list with timestamps and click-to-expand.
- **Confidence:** High

### F-111 — Mobile rail has no Escape-to-close; hardcoded `top: 5.2rem` assumes topbar height
- **Source:** R4-CC-006
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedSurfacePage.tsx:107-114`; CSS `threaded-surface.css:1985-1999`
- **Suggested direction:** Escape handler + CSS variable for topbar height.
- **Confidence:** High

### F-112 — Hardcoded `rgba()` shadows produce wrong depth in light theme
- **Source:** R4-CC-005
- **Severity:** LOW
- **Category:** UX
- **Location:** `threaded-surface.css:880, 1450, 1998`
- **Suggested direction:** `color-mix(in oklab, var(--shadow-base) X%, transparent)`.
- **Confidence:** High

### F-113 — `compactArtifactSheet` uses 840px breakpoint while rest of layout uses 767/1023/1180/1360
- **Source:** R4-CC-011
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedSurfacePage.tsx:374, 477-490`
- **Suggested direction:** Align with existing breakpoint matrix.
- **Confidence:** High

### F-114 — Disabled buttons inherit `cursor: pointer` (no `:disabled` reset)
- **Source:** R4-CC-013
- **Severity:** LOW
- **Category:** UX
- **Location:** `threaded-surface.css:1349-1374`
- **Suggested direction:** `:disabled { cursor: not-allowed; opacity: 0.5; pointer-events: none; }`.
- **Confidence:** High

### F-115 — Theme toggle has no `transition` on color/background — flash repaint
- **Source:** R4-CC-010
- **Severity:** LOW
- **Category:** UX
- **Location:** `MissionControlNextApp.tsx:422-432`
- **Suggested direction:** `transition: background-color 200ms ease, color 200ms ease` on shell root; respect reduced motion.
- **Confidence:** High

### F-116 — Notification stack does not announce count growth (collapsed via `upsertNotificationItem`)
- **Source:** R4-CC-015
- **Severity:** LOW
- **Category:** UX / A11y
- **Location:** `NotificationStack.tsx:62-89`
- **Suggested direction:** When count increments, re-render with slightly different message to trigger SR announcement.
- **Confidence:** Medium

### F-117 — Code copy button is 1.55 rem (24-25 px) — below 44×44 touch target
- **Source:** R4-CC-020
- **Severity:** LOW
- **Category:** UX
- **Location:** `threaded-surface.css:1186-1212`
- **Suggested direction:** Bump to 2 rem or hover-reveal with other message actions.
- **Confidence:** High

### F-118 — Composer "send" button has no spinner during sending; just label change
- **Source:** R4-CC-019
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedComposer.tsx:574-583`
- **Suggested direction:** Add an inline `Loader2` spinner + pulse animation.
- **Confidence:** High

### F-119 — Compose card has padding `16px 0` — content touches edge on narrow columns
- **Source:** R4-CC-021
- **Severity:** LOW
- **Category:** UX
- **Location:** `threaded-surface.css:763-770`
- **Suggested direction:** `padding: 16px 16px` or rely solely on inner composer padding.
- **Confidence:** High

### F-120 — Header action row has 5-7 secondary buttons; no primary anchor
- **Source:** R4-CC-022
- **Severity:** LOW
- **Category:** UX
- **Location:** `ThreadedSurfacePage.tsx:437-464`
- **Suggested direction:** One primary ("Continue in Cowork"); collapse the rest into `…` menu.
- **Confidence:** High

### F-121 — `setTimeout(closeActiveChatTurnStream, 30_000)` not `unref`'d — can hold event loop on shutdown
- **Source:** R3-L-1
- **Severity:** LOW
- **Category:** Performance
- **Location:** `apps/gateway/src/services/chat-turn-dispatch-service.ts:265, 373`
- **Suggested direction:** `.unref()` or track timers and clear on shutdown.
- **Confidence:** High

### F-122 — `notifications` state grows over time — no cap, no auto-dismiss
- **Source:** R3-L-2
- **Severity:** LOW
- **Category:** Performance
- **Location:** `apps/mission-control-next/src/app/MissionControlNextApp.tsx:144, 184-194, 311-313`
- **Suggested direction:** Cap at 100; auto-dismiss non-error after 5 min.
- **Confidence:** High

### F-123 — `useDebouncedLocalStoragePersistence` doesn't flush on `beforeunload`
- **Source:** R3-L-3
- **Severity:** LOW
- **Category:** Performance
- **Location:** `packages/threaded-surface-core/src/chat/useChatLocalPersistence.ts:24-67`
- **Suggested direction:** Register `beforeunload` listener to synchronously flush.
- **Confidence:** High

### F-124 — Stream-resume retry has no exponential backoff between attempts
- **Source:** R3-M-5
- **Severity:** LOW
- **Category:** Performance
- **Location:** `packages/threaded-surface-core/src/chat/useChatOutboundExecution.ts:775-879`
- **Suggested direction:** 250-500 ms delay before each resume attempt.
- **Confidence:** Medium

### F-125 — `sharedEventSource` reconnects forever with 30 s cap — no max-attempts give-up
- **Source:** R3-M-4
- **Severity:** LOW
- **Category:** Performance
- **Location:** `packages/mission-control-shared/src/api/client.ts:1010-1032`
- **Suggested direction:** After 30 consecutive failures, switch to paused state with manual "Reconnect" button.
- **Confidence:** Medium

### 4.5 NIT (16 items)

### F-126 — Permanent `eslint-disable max-lines` on 57 files; repo eslint config allows 1000, owner rule says 800
- **Source:** R8-022, R8-023, R8-024 (convergent)
- **Severity:** NIT
- **Category:** Quality
- **Location:** `eslint.config.mjs:53`; 57 disabled files
- **Suggested direction:** Lower eslint cap to 800. Track each disable with a TODO + sunset target.
- **Confidence:** High

### F-127 — Bare `catch { ... }` (no error binding) is the dominant fallback pattern; 100+ instances
- **Source:** R8-026
- **Severity:** NIT
- **Category:** Quality
- **Location:** `apps/gateway/src/services/backup-retention-service.ts` (12), `llama-cpp-runtime-service.ts` (10), `gateway-service.ts` (10), `chat-agent-orchestrator.ts` (10), etc.
- **Suggested direction:** `} catch (_error) {` for visual signal; or wrap in a `safeDecode<T>` helper.
- **Confidence:** High

### F-128 — `LlmProviderConfig.headers` / `LlmProviderHeadersDefaultsConfig.headers` are `@deprecated` with zero consumers
- **Source:** R8-013
- **Severity:** NIT
- **Category:** Quality
- **Location:** `packages/contracts/src/llm.ts:90-91, 139-140`
- **Suggested direction:** Migrate any persisted configs; then delete the fields.
- **Confidence:** High

### F-129 — In-place `.sort()` on locally-constructed arrays in 21+ services
- **Source:** R8-025
- **Severity:** NIT
- **Category:** Quality
- **Location:** `apps/gateway/src/services/agency-agent-catalog-service.ts:304, 323` (representative)
- **Suggested direction:** Either explicitly tolerate or migrate to `[...arr].sort(...)`.
- **Confidence:** High

### F-130 — `// eslint-disable-next-line @typescript-eslint/no-this-alias` at `gateway-service.ts:898`
- **Source:** R1-032, R8-021 (convergent)
- **Severity:** NIT
- **Category:** Quality
- **Location:** `apps/gateway/src/services/gateway-service.ts:898`
- **Suggested direction:** Move `closing` flag to a tiny `LifecycleService`; remove `self` alias.
- **Confidence:** High

### F-131 — `apps/mission-control-next/src/app/` mixes PascalCase and kebab-case file names
- **Source:** R8-031
- **Severity:** NIT
- **Category:** Quality
- **Suggested direction:** Document and enforce per-directory convention.
- **Confidence:** High

### F-132 — Three "orchestration"-named files across `router.ts`, `orchestration-lifecycle-service.ts`, `routes/orchestration.ts`
- **Source:** R8-032
- **Severity:** NIT
- **Category:** Quality
- **Suggested direction:** No change unless related renames happen.
- **Confidence:** Medium

### F-133 — `OPENCLAW_PARITY_STATUS.md:15-22` and `FOLLOW_ON_PARITY_REGISTER.md:9-15` reference the same epic IDs with different framings
- **Source:** R8-034
- **Severity:** NIT
- **Category:** Quality / Docs
- **Suggested direction:** Merge into one ledger with primary + follow-on status columns.
- **Confidence:** High

### F-134 — `chat-turn-entry-service.ts` host is an intersection of 7 collaborator types — readable but on the edge
- **Source:** R1-025
- **Severity:** NIT
- **Category:** Architecture
- **Location:** `apps/gateway/src/services/chat-turn-entry-service.ts:55-117`
- **Suggested direction:** Document the collaborator union shape (one paragraph).
- **Confidence:** Medium

### F-135 — Routes call `fastify.gatewayConfig` directly rather than through services
- **Source:** R1-026
- **Severity:** NIT
- **Category:** Architecture
- **Suggested direction:** Long-term: expose only config slices per route service.
- **Confidence:** Medium

### F-136 — `service-context-guard.test.ts` locks in the current transitional ServiceContext shape
- **Source:** R1-027
- **Severity:** NIT
- **Category:** Quality / Testing
- **Suggested direction:** Add a sibling test asserting ServiceContext usage count trends down.
- **Confidence:** Medium

### F-137 — File-level `/* eslint-disable max-lines */` in 4+ files (gateway-service, llm-service, chat-turn-stream-service, durable-run-service) have become permanent
- **Source:** R1-031
- **Severity:** NIT
- **Category:** Quality
- **Suggested direction:** Each disable should carry a tracking issue and sunset.
- **Confidence:** Medium

### F-138 — `gateway-route-services.ts` is 336 LOC of imports + factory; approaches the typical 400-LOC bound
- **Source:** R1-034
- **Severity:** NIT
- **Category:** Architecture
- **Suggested direction:** If growth continues, group route services by domain into sub-aggregators.
- **Confidence:** Low

### F-139 — `OrchestrationRun.status` enum vs `OrchestrationExecutionState` enum nomenclature inconsistency
- **Source:** R6-N2
- **Severity:** NIT
- **Category:** Orchestration
- **Suggested direction:** Document mapping table or align vocabularies.
- **Confidence:** Medium

### F-140 — Verify-install / smoke harnesses mutate `process.env` directly
- **Source:** R7-M-6
- **Severity:** NIT
- **Category:** Testing
- **Suggested direction:** Build the app with explicit options instead.
- **Confidence:** Medium

### F-141 — `expectedStdout` literal-string matching in `agentic-proof.mjs` is fragile to test rename
- **Source:** R7-N-2
- **Severity:** NIT
- **Category:** Testing
- **Suggested direction:** Stable test-id annotations instead of title-substring matching.
- **Confidence:** Medium

---

## 5. Convergence Map

Issues flagged by >=2 reviewers are documented here. Each is a high-confidence problem: independent lenses landed on the same artifact from different angles. This is the single best place to start triage.

| Issue | F-NNN | Reviewers | Confidence |
|---|---|---|---|
| Worktrees never auto-cleaned; disk fills + orchestration leaks them | F-003 | R3-CR-2 (disk) + R6-H1 (orchestration lifecycle) | HIGH - perf and orchestration both confirm; settled at CRITICAL |
| Cowork "pause"/"kill" buttons don't pause, orchestration engine doesn't execute phases | F-001 + F-025 | R6-C1 (no execution path) + R4-COWORK-003 (UX admits no-op) | HIGH - UX surface honestly labels what backend doesn't do |
| `allowLoopbackBypass` default ON in canonical Settings; loopback bypass is full operator-level access | F-006 + F-031 | R5-CC-1 (default mismatch) + R2-006 (bypass is operator-level) | HIGH - settings UX exposes a real auth-bypass; combined with R2 = ship blocker |
| Streaming has no aria-live for screen readers across multiple surfaces | F-022 | R4-CHAT-002 (chat bubble) + R4-CC-003 (sparse live regions) | HIGH - two lens-passes on the same a11y blocker |
| File-size monolith debt has spread beyond gateway-service.ts | F-008 + F-011 + F-080 + F-081 | R1-003 (LlmService) + R1-012 (chat-turn-stream) + R8-001 (chat-agent-orchestrator) + R8-003 (SettingsNativePage) + R8-006 (prompt-pack-service) + R8-007 (improvement-service / tool-executor / sqlite) | HIGH - 7 reviewer signals; the 800-LOC rule is functionally not enforced |
| Coverage-truthfulness was degraded: harness inflated lines + gate was not in CI + the storage glob historically missed files; F-016/F-017 are now closed in current repo evidence, while F-015 remains a separate coverage-assertion quality item | F-015 + F-016 + F-017 | R7-C2, R7-C3, R7-C4 (one reviewer but three independent failure modes; cited as convergent because each undermines the others) | HIGH |
| Cowork run-map and subagent fan-out are flat/uninformative | F-038 | R4-COWORK-002 (run-map gray cards) + R4-COWORK-007 (subagent flat list) + R6-M7 (3-item timeline cap) | MEDIUM-HIGH - three independent UX/orchestration signals on the same data surface |
| ARIA tabs pattern missing on cowork tab row + code-source chooser tabs | F-063 | R4-COWORK-013 + R4-CODE-009 | MEDIUM-HIGH |
| Mid-path glob ownership-conflict detection broken (string-prefix overlap only) | F-012 | R6-C5 (engine ownership) + R8-018 (hardcoded repair routing) - related-class concern around stringly-typed path matching | MEDIUM-HIGH |
| Polling on hidden tabs and 200 ms sqlite live-tail compete for the same workload | F-064 + F-065 | R3-M-1 (server poll) + R3-M-2 (client poll) | MEDIUM - independent perf observations |
| Duplicate API surfaces between legacy and canonical apps | F-082 + F-083 | R8-004 (cowork-view-model 3x) + R8-005 (29 API modules duplicated) | HIGH - same pattern in two layers |
| GatewayService constructor encodes cycles through `this`-captured closures | F-077 | R1-010 (600-line constructor) + R1-015 (proven cycle taskLifecycle->improvement) | HIGH |
| Doc-vs-code truthfulness drift (A2UI artifact missing, screenshots dir empty, personality .md files never loaded) | F-084 + F-086 + F-087 | R8-002 + R8-009 + R8-010 | HIGH - three independent doc-truthfulness drifts |
| Forward-dated provider defaults paired with no validation freshness signal | F-051 | R5-MD-2 (model IDs) + R5-MD-8 (LM Studio "local-model" placeholder) + R5-MD-5 (live vs fallback discovery unexplained) | MEDIUM |
| "Forge" vs "Settings" brand inconsistency | F-055 | R5-CC-7 + R5-CC-10 | LOW-MEDIUM |

Convergence signal: every CRITICAL except F-008 (file size) and F-014/F-015/F-017 (testing) has >=2 reviewers landing on it.

## 6. UX-Specific Quality Notes (Chat / Cowork / Code)

The owner's three headline asks map onto three discrete surfaces. Each is reviewed against its specific promise.

### Chat - Verdict: **FAIL** (owner asked: "best possible responses regardless of model used")

- Missing every modern keyboard shortcut (no `Cmd+Enter`, `Esc`, `ArrowUp`, `Cmd+K`) - **F-021**. This alone disqualifies the "snappy as Claude/ChatGPT" claim.
- Citations rendered as a bare integer; not clickable, no source list - **F-023**. The premise "best response regardless of model" requires verifiability; verifiability is hidden.
- Model picker omits context window, cost, capability badges - **F-024**. The data exists in `useProviderModelCatalog`; the UI doesn't surface it. Picking the right model is the precondition for the best response.
- No per-model system-prompt customization in the surface (R4-CHAT-005). Best-practice prompting differs sharply per model (Claude XML, GPT function descriptions, Llama step lists); the surface forces one-size-fits-all.
- A11y blockers: streaming text not in an aria-live region - **F-022**; naked `outline: none` with no `:focus-visible` replacement - **F-045**.
- Orphan CSS classes mean status/stream/queue UI renders unstyled in the canonical shell - **F-044**.
- **Biggest fix:** Wire the four keyboard shortcuts (**F-021**), port the orphan CSS rules (**F-044**), expose context/cost on the model picker (**F-024**). Without these, "modern chat" is a marketing word.

### Cowork - Verdict: **FAIL** (owner asked: "incredible job of agent orchestration for longer tasks")

- **Orchestration phases do not execute** - **F-001**. The engine walks state and emits `phase_executed` events for work that never happened. This is the single most damning finding in the review. Cost tracking is permanently zero in auto mode (**F-002**) because of this.
- Headline "pause"/"kill" controls admit they don't actually pause or kill - **F-025**. The label is honest; the surface is broken.
- No idempotency, no run-cancel endpoint, no precondition on `startRun` - **F-004**, **F-013**, **F-028**. Double-clicking the run button spawns parallel runs.
- Ownership matrix is plan-time-only theatre - **F-012**. The audit-bearing "wave conflict" check is a string-prefix scan; cross-wave overlaps and mid-path globs are not detected; no enforcement at write time.
- Visual surface fails to communicate hierarchy: 9+ vertical sections without grouping - **F-037**. Run-map is a horizontal scroll of identical gray cards - **F-038**. Subagent fan-out is a flat list. Checkpoints are a string with `" -> "` arrows - **F-110**.
- Approval card doesn't autofocus, doesn't scroll into view aggressively, no keyboard accelerators - **F-039**.
- Memory composition for orchestration uses a global `workspace: "memory"` literal (R6-M1) - cross-workspace leak.
- **Biggest fix:** **F-001** and **F-002** together. Until the engine actually invokes agents and accounts for cost, every other Cowork finding is decoration on a broken surface.

### Code - Verdict: **CONCERNS** (owner asked: "code makes sense in general on the page")

- Monaco has no keyboard shortcuts wired - **F-040**. No `Cmd+S`, no `Cmd+P`, no command palette; the surface feels fake.
- File tree cannot create/rename/delete - **F-041**. Terminal pane is a read-only Monaco showing markdown, not an actual shell.
- No resize handles between tree/editor/terminal; pane sizes don't persist - **F-042**. `react-reflex` is in deps but unused.
- Below 1360px, workbench stacks into a giant column with fixed editor 520 px + terminal 240 px - **F-042**. On a 14-15" laptop this is the layout.
- Workbench toolbar is a single overflowing row of ~10+ buttons - **F-043**. Visual chaos.
- Diff editor is hardcoded side-by-side; no unified toggle - **F-097**.
- Monaco doesn't react to runtime theme toggle - **F-100**.
- **Biggest fix:** Either commit to the "real coding surface" by wiring Monaco shortcuts (**F-040**), file ops (**F-041**), and resize panes (**F-042**), or reframe the surface as a "patch reviewer + scratchpad" and drop the IDE promise.

## 7. Settings Clarity Audit

Reproducing R5's comprehension scorecard (1-5 scale; lower = worse):

| Section | Layman | Engineer | Top weakness |
|---|---|---|---|
| Overview | 3 | 3 | Raw snake_case (`local_dev`); loopback-bypass chip with no explainer |
| Access | 2 | 3 | "Auth Mode = none (local trusted)" + bypass toggle interplay; no "key on file" indicator |
| Voice | 3 | 3 | 13 buttons, no grouping; advanced env vars exposed without context |
| Runtime | 1 | 2 | Tool Profile / Budget Mode / Deployment Profile all missing per-option help |
| Models | 2 | 3 | Provider API Style dropdown is the worst offender; "API Key (optional)" is sometimes mandatory |
| Tests | 4 | 4 | QMD jargon |

**Cross-cutting observations.**

- **First-run UX is broken.** A user landing on Settings with no provider sees "Loading Forge settings..." (single line), six tabs labeled by jargon ("Forge Sections"), and no zero-state CTA pointing at the one section they need. The most-important section is labeled "Models," not "Providers & Models." Fix: F-055, F-057.
- **Layman vs engineer divergence is largest in Runtime and Models.** Tool Profile (`minimal/standard/coding/ops/research/danger`) and Budget Mode (`saver/balanced/power`) have no per-option help (**F-047**). Provider API Style enumerates four arcane values with a single shared paragraph (**F-048**). Engineers eventually figure these out; laymen click "danger" because the name is cool.
- **Discoverability of provider configuration is poor.** The label "Models" hides the provider connection flow. Combined with `.env.example` missing half the env vars the UI exposes (**F-053**), and with two UIs shipping different defaults for an auth flag (**F-006**), the first-run path is "click around until something works."
- **Two CRITICAL settings findings** are the loopback-bypass default mismatch (**F-006**) and the missing "key never sent back to browser" reassurance (**F-007**). Both are owner-flagged operator-trust items.
- **NIT-but-cumulative.** "Forge" vs "Settings" inconsistency (**F-055**), raw snake_case enum labels (**F-049**), browser-default URL validation (**F-056**), env-vs-UI silent overrides (R5-CC-6). Each is small; together they make Settings feel half-finished.

## 8. Recent-Changes Integrity Check

The owner said "major fixes done." Last 50 commits sketch:

- **Architecture-metrics helpers (commits `9470a3e3` through `0459f6c7`, 8 commits):** Hardening the verification-lane parser. The metrics they produce are a **counter**, not a **constraint** - R7-H2 / **F-016 family**. The fixes are real (more robust parsing, edge-case handling, TS-parser usage), but the underlying lane cannot forbid X-from-Y imports. The work is solid; the lane it serves is too soft. Held.
- **Verification-lane stabilization (`ac68d0d0`, `8871c7f0`, `0d6e0b86`, `4827de2c`, `40caf39f`):** Multiple "fix verification" / "fix coverage review regressions" commits. R7 confirms `verify:durable:recovery` is genuinely meaningful (real process restart + dead-letter recovery). Current `verification-fast.yml` runs `verify:fast`, coverage collection/gating, and Postgres proof as distinct workflow steps (**F-016 closed**), and the storage package now uses recursive test discovery (**F-017 closed**); `coverage-exercise.ts` precision (**F-015**) remains separate historical debt. Partial.
- **GitHub security/quality alert sweeps (`9128e8ed`, `ad209b79`, `58404894`, `e322a5fa`, `955e06e9`):** Multi-commit cleanup of GitHub Code Scanning findings. R2 found new HIGH security issues (MCP env passthrough **F-018**, Firecrawl env-name injection **F-019**, approval bypass **F-020**) that are not surfaced by GitHub's analyzers - these require domain-aware review. The auto-scan fixes are useful but address a different category of risk. Held narrowly.
- **Storage coverage expansion (~20 commits, `e1c78ab1` -> `64e3f88d`, `0205057a`, `3719ed48` etc.):** Substantial real work. Per-repository tests added. R7-C1 still fires though: the Postgres path uses `FakePool` - the exact mock the owner explicitly forbade in auto-memory. Storage coverage expansion is real for SQLite; for Postgres it's adversarial mocking. Mixed.

**Net read:** The recent work is substantive on UI surface coverage and verification parser robustness. It is **shallower on the things this review just surfaced**: orchestration execution (F-001), worktree cleanup (F-003), Postgres real-DB testing (F-014), file-size discipline (F-008/F-080/F-081), SSE backpressure (F-005). The fixes that landed are real; the fixes that did not land are exactly the ones blocking 1.0.

## 9. Summary: Shippable Product Standing

**Where this stands today.** GoatCitadel has unusually strong plumbing for an agentic system at this stage - durable runs with dead-letter recovery, deny-wins policy with real path-jail enforcement, OAuth/PKCE with OS-keychain secrets, and a verification lane that genuinely restarts the process to prove recovery (R7-O1). But the surface most users interact with as "the product" - Cowork as an agent orchestrator, the Chat as a snappy model frontend, and the Settings panel as the trust contract - has either central feature gaps (Cowork: **F-001/F-002**) or first-impression breakage (Chat: **F-021/F-022/F-023/F-024/F-044**; Settings: **F-006/F-007/F-047/F-048**). The plumbing keeps promises the UX cannot.

**What 1.0 promises it actually keeps** (verified by reading `docs/1_0_CONTRACT.md` and the relevant evidence). Durable execution and dead-letter recovery (**F-014** is a testing-method concern, the feature itself is real). OAuth/PKCE for OpenAI Codex (verified in R8 closing notes). Deny-wins policy precedence (R8 closing notes confirm tests). Workspace + write-jail + symlink-real-path resolution (R2 attack scorecard: PASS). Real SSE delivery (the writer works; **F-005** is about backpressure, not delivery). Multi-provider operation (works; **F-011** is about how it's done, not whether it works).

**What 1.0 promises are aspirational or false.** "Cowork does an incredible job of agent orchestration for longer tasks" - **false today**: the engine walks state and never invokes agents (**F-001**). "Visible orchestration and checkpoints with watchable/controllable runs" - **half true**: events fire, checkpoints persist, but the pause/kill buttons admit they don't pause (**F-025**) and the run-map is a strip of gray cards (**F-038**). "Budget guardrail" - **false in auto mode** (**F-002**). "Best response regardless of model" - **unsupportable**: the model picker hides the data needed to choose intelligently (**F-024**) and there is no per-model prompt tuning surface (R4-CHAT-005). "Settings UI safely captures provider secrets" - **mostly true** (the implementation is safe) but **unverifiable from the UI** (**F-007**), and the canonical UI ships an auth-bypass default that the legacy UI doesn't (**F-006**).

**Top 5 risks if shipped today.**

1. **Customer believes Cowork is doing work it isn't.** Auto-mode runs "complete" with $0 spend and zero artifacts, leaving the customer baffled when nothing happened (**F-001/F-002**). Highest reputational risk because the surface lies confidently.
2. **Disk fills on a long-running install and the gateway dies with cryptic sqlite errors.** Worktrees accumulate forever (**F-003**); the failure mode looks like a database bug rather than a disk bug.
3. **Slow client OOMs the gateway.** SSE writes have no backpressure (**F-005**); a paused tab + LLM stream = node `_writableState.buffer` grows until OOM.
4. **Operator unknowingly disables auth.** Canonical Settings ships `allowLoopbackBypass=true` (**F-006**); combined with loopback being operator-level (**F-031**) and the missing "key on file" indicator (**F-007**), a first-run user can end up in an open-by-default posture.
5. **MCP server installed from an untrusted source exfiltrates all provider keys.** `allowedEnvKeys` is unsanitized (**F-018**), and `firecrawlApiKeyEnv` lets the agent itself name the env var to read (**F-019**). One bad MCP install = full credential breach.

**Verdict for 1.0:** Not ready. The pre-ship blockers (Section 10.1) need to be addressed first. Once F-001 through F-007, F-014 through F-020 are resolved, the product is plausibly shippable as a 1.0.

## 10. Recommended Next Steps

### 10.1 Pre-ship blockers (do NOT release 1.0 until these are fixed)

Every CRITICAL F-NNN, with a one-line "to fix this" sketch.

- **F-001** - Wire orchestration phase execution. Either dispatch via `prepareAgentChatTurn` against `phase.ownerAgentId`, or build a subagent runner that resolves `phase.specPath`. Without this, Cowork is fiction.
- **F-002** - Increment `totalCostUsd` per `phase_executed` from `ChatTurnTraceRecord.usage.costUsd` (depends on F-001).
- **F-003** - Call `WorktreeManager.remove` on `run_completed/stopped/failed/cancelled` and on chat-session archive/delete. Add a periodic orphan-reaper. Cap worktrees per workspace.
- **F-004** - Add idempotency to `runOrchestrationPlan` via `findLatestRunByPlan` check or `Idempotency-Key` header. Integration test for double-POST.
- **F-005** - Check `raw.write()` return value; on `false` await `'drain'`. Cap progress queue at 256 items; drop oldest non-`final` updates.
- **F-006** - Default `allowLoopbackBypass` to `false` in `SettingsNativePage.tsx:2438`. Add risk-callout text.
- **F-007** - Add "Key on file" line + "never sent back to browser" `<FieldHelp>` text to the Models section secrets UI.
- **F-008** - Begin the `chat-agent-orchestrator.ts` decomposition. First targets: extract repair-routing string table (-> `chat-repair-routes.ts`), cron-seed (-> `cron-seed-service.ts`), tool-loop detection (-> `chat-tool-loop.ts`).
- **F-009** - Inject `ChatTurnRuntimeService` with an explicit narrow host built from services, not from `this`. Either an object literal or a `buildChatTurnRuntime(...)` builder.
- **F-010** - Stop adding to `GatewayRouteCompositionPort`. Each future extraction replaces a slice of the port with a self-owned service.
- **F-011** - Introduce `LlmProviderAdapter` interface + registry. Pick one provider to be the first concrete adapter (Anthropic is cleanest); refactor `chatCompletions` to dispatch.
- **F-012** - Decide ownership-matrix semantics: enforce at write time, or downgrade to a soft warning and remove ownership language from operator docs. Either way, replace string-prefix overlap with proper glob intersection.
- **F-013** - Add `if (run.status !== "queued") throw` in `engine.startRun`.
- **F-014** - Add testcontainers-Postgres test pass for `postgres-migrator.test.ts` and the public sync API. Or remove `FakePool` and rely on SQLite parity (with the parity check tightened).
- **F-015** - Replace each `notEqual(..., 500)` in `coverage-exercise.ts` with `equal(statusCode, expectedCode)` + body-shape check. Or exclude the file from coverage and trust per-service tests.

### 10.2 Post-ship hardening (first 30 days)

HIGH findings + compounding mediums, grouped by area.

**Security.**
- **F-018, F-019** - Sanitize MCP `allowedEnvKeys` and Firecrawl `firecrawlApiKeyEnv` against an explicit prefix allowlist.
- **F-020** - Require a separate confirm or restrict `approvalMode: bypass` from overriding `nuclear` risk.
- **F-029** - Add `withRouteAccess(fastify, "operator", { rateLimit: { max: 60 } })` to all `/api/v1/secrets/*` routes.
- **F-030** - Apply env-allowlist inside `prepareCodeModeSandboxLaunch`.
- **F-031** - Add startup warning when `allowLoopbackBypass=true` and `GATEWAY_HOST != 127.0.0.1`.

**Testing.**
- **F-016** - Closed: `verification-fast.yml` now runs `pnpm verify:fast`,
  `coverage:collect`, and `coverage:gate:production` as distinct proof steps.
- **F-017** - Closed: the storage package test lane now uses a recursive `src/**/*.test.ts` glob; keep server-encoding coverage proved through the package test lane.

**Performance.**
- **F-032** - Add `ChatSessionPrefsRepository.listBySessionIds`. Stop fetching 20,000 sessions per call.
- **F-033** - `React.memo` the `ThreadTurnCard`; lighter `ReactMarkdown` fallback for inactive turns.
- **F-034** - `setMaxListeners(0)` on the realtime emitter.
- **F-035** - Switch attachment upload to streaming `multipart/form-data`.
- **F-036** - Fix `splitIntoChunks` to index-based O(N).

**UX / Chat-Cowork-Code.**
- **F-021** - Wire the four chat keyboard shortcuts.
- **F-022, F-045** - Add `aria-live` to streaming bubble; add `:focus-visible` rings everywhere.
- **F-023, F-024** - Render citations as a clickable list; expose context/cost/capabilities on the model picker.
- **F-025, F-028** - Implement live cancel via the new orchestration cancel endpoint.
- **F-037, F-038** - Hoist "Next action" to the top of Cowork; build a real `react-flow` run-map.
- **F-039** - Approval card autofocus + scroll-into-view + keyboard accelerators.
- **F-040, F-041, F-042, F-043** - Wire Monaco shortcuts + tree ops + resize panes + toolbar grouping.
- **F-044** - Port orphan CSS rules from `apps/mission-control/src/styles/chat-surface.css` into `threaded-surface.css`.

**Settings.**
- **F-047, F-048** - Per-option help for Tool Profile, Budget Mode, Provider API Style.
- **F-049** - Detect non-loopback bind and default to `remote_hardened`.
- **F-051** - Snapshot model IDs at release; add `lastValidatedAt`.
- **F-052** - Conditional "(optional)"/"(required)" on API key label.
- **F-053** - Expand `.env.example` to match the env vars the UI exposes.

**Orchestration / Architecture follow-ups.**
- **F-026** - Align hitl approval semantics across lifecycle and engine.
- **F-027** - Externalize repair-routing strings to a config file.
- **F-069** - Optimistic locking or per-plan mutex on plan upsert.
- **F-070** - Apply limit check on the last phase too.
- **F-071** - Wire abort signal check inside the durable phase loop.

### 10.3 Architectural debt (next decomposition steps)

R1 owns this. Specific next moves:

- **`gateway-service.ts` (7,598 LOC).** Stop adding to the route-composition port (**F-010**). Pick the 10 most-called `/** @internal */ public` methods (**F-078**) and either move them into the extracted module that owns them or push them into a typed `GatewayInternals` mixin. Move the constructor wiring to `gateway/builder.ts` returning a typed bag (**F-077**).
- **`LlmService` (3,215 LOC).** First per-provider adapter extraction (**F-011**). Anthropic is the cleanest first target - fewest quirks. After that: OpenAI Codex (its bleed across the file is the worst). The "moonshot" fallback string (**F-072**) becomes adapter metadata.
- **`chat-agent-orchestrator.ts` (14,183 LOC).** Phase 1: repair-routing tables + cron-seed extraction (**F-008/F-027**). Phase 2: tool-loop detection split. Phase 3: turn delegation split into its own module.
- **`chat-turn-stream-service.ts` (1,648 LOC).** Split into `orchestrator / persistence / events / fallback` (**F-080**).
- **`prompt-pack-service.ts` (9,243 LOC).** Split into `policy / execution / scoring / evidence` (**F-081**).
- **`SettingsNativePage.tsx` (6,204 LOC).** Per-section subpage files (**F-081**).
- **Route-composition port shrinkage.** Make it the explicit metric for Step 9: port method count should drop from 87 to ~15 by end of next decomp window (**F-010 / F-076**).
- **`memory-facade-service.ts`** rename (**F-074**); **`chat-turn-runtime.ts`** rename (**F-075**); **`lazy-legacy-pages.tsx`** rename (**F-088**).
- **`policy-engine` package** - move `browser-tools.ts` out into a `browser-runtime` package (**F-073**); policy engine becomes policy-only.

### 10.4 Stretch improvements

The "other improvements" bucket, owner-encouraged.

- **Personality docs ghost configuration.** The 47 `.md` files are reference docs masquerading as runtime config (**F-084**). Pick: load them, or delete them and remove the `soulFile` field. Either is fine; both is not.
- **Documentation-vs-code drift.** A2UI artifact directory doesn't exist (**F-086**); screenshots directory is empty (**F-087**); R8 found 5 doc-vs-code divergences in total. Reconcile in one pass.
- **Dead/duplicated code.** `cowork-view-model.ts` 3 copies (**F-082**); 29 duplicated API modules between legacy and canonical (**F-083**); 19 "moved to" tombstone comments in gateway-service (**F-085**). All deletable without behavior change.
- **Observability for orchestration.** Emit `recordDevDiagnostic` for orchestration transitions (R6-M2). Add per-run token ledger (R6-M3). Surface checkpoint timeline beyond 3 items in the view-model (R6-M7).
- **Memory-context workspace scoping.** Fix the static `workspace: "memory"` literal (R6-M1) - one-line fix; prevents cross-workspace context leak.
- **Bundle bloat.** Drop Three.js / @react-three/fiber / drei from `mission-control-next/package.json` if they remain unused (**F-068**).
- **Polish.** F-097 through F-125 cover ~30 LOW-severity UX improvements that compound. Pick the top 10 (notification auto-dismiss, focus rings, send-button spinner, mobile-rail Escape, theme transition) for a "polish week."
- **Brand consistency.** Pick "Forge" or "Settings" (**F-055**). Wherever "Forge" stays, use as kicker only.
- **CSS-token discipline.** Replace hardcoded `rgba()` shadows with `color-mix` tokens (**F-112**); add the missing `:disabled { cursor: not-allowed }` rule (**F-114**).

## 11. Verification Checklist (for Codex)

After fixing each CRITICAL, confirm in this order before claiming completion:

- [ ] **F-001** - Run a 3-phase auto-mode orchestration plan. Confirm at least one chat-turn trace is created per phase, with non-zero `usage.tokensIn/Out`, and at least one tool invocation if the phase requires one.
- [ ] **F-002** - Same 3-phase run: confirm `OrchestrationRun.totalCostUsd > 0` and equals (within epsilon) the sum of underlying turn-trace `usage.costUsd`. Confirm `engine.shouldStopByLimits` fires when `maxCostUsd` is exceeded.
- [ ] **F-003** - Start an orchestration run. After it completes, confirm `<worktreesDir>/orchestration/<runId>/` is deleted. Run an orphan-scan; confirm zero orphans for active runs.
- [ ] **F-004** - Double-POST `/api/v1/orchestration/plans/:planId/run` within 1 second. Confirm exactly one run is created; the second response either returns the same `runId` or 409 with the active `runId`.
- [ ] **F-005** - Open a streaming chat, pause the tab via `chrome://inspect`. Run a 200-chunk LLM stream. Confirm gateway RSS doesn't grow >50 MB; confirm a backpressure warning event appears.
- [ ] **F-006** - Fresh-install the canonical UI on a clean Postgres + secrets store. Navigate to Settings -> Access. Confirm `allowLoopbackBypass` checkbox is **unchecked** by default.
- [ ] **F-007** - Save a provider API key. Reload Settings -> Models. Confirm "Key on file" indicator shows masked source; confirm no key value appears in the page DOM or network response.
- [ ] **F-008** - `wc -l apps/gateway/src/services/chat-agent-orchestrator.ts` < 10,000 (interim target); confirm `chat-repair-routes.ts` exports the routing table.
- [ ] **F-009** - Build a minimal mock host (5 methods) and instantiate `ChatTurnRuntimeService` against it. Confirm `agentSendChatMessage` runs a happy-path turn without needing the full GatewayService.
- [ ] **F-010** - `wc -l apps/gateway/src/services/gateway-route-composition-port.ts` < 350; method-reference count in the port < 60. (Baseline today: ~400 LOC, 87 method references.)
- [ ] **F-011** - Add a fake provider via the new `LlmProviderAdapter` interface; confirm a chat turn against it works end-to-end without modifying `LlmService`'s switch statements.
- [ ] **F-012** - Define a plan with cross-wave path overlap (wave 1: `apps/web/**`, wave 2: `apps/web/components/file.ts`). Confirm validation either rejects (if enforcement chosen) or warns (if soft-warning chosen). For glob intersection, confirm `apps/*/src` and `apps/mission-control/src` are detected as overlapping.
- [ ] **F-013** - Manually fail a run via `failWorkflowRun`. Re-trigger durable resume. Confirm engine throws on attempted `startRun`; confirm the run does not revert to phase 1.
- [ ] **F-014** - Run `pnpm --filter @goatcitadel/storage test` against a real Postgres (testcontainers or compose). Confirm migrator tests, client tests, and sync-worker tests execute against the live DB.
- [ ] **F-015** - Replace one `notEqual(500)` in `coverage-exercise.ts` with a precise assertion that fails today. Confirm the failure surfaces in `pnpm coverage:gate:production`.
- [x] **F-016** - `verification-fast.yml` runs `pnpm verify:fast`, `coverage:collect`, and
  `coverage:gate:production` as distinct direct workflow proof; release proof does not treat `verify:fast`
  as the umbrella lane.
- [x] **F-017** - Storage package tests now use recursive discovery; rerun `pnpm --filter @goatcitadel/storage test` for current server-encoding proof instead of relying on the historical empty grep.

Once all 17 boxes are checked, re-run the convergence map in Section 5 - at least 5 convergent issues should be resolved.
