# GoatCitadel Engineering Handbook

This document is the deep technical documentation for GoatCitadel. It is intended for:

- Engineers onboarding to the codebase.
- External reviewers performing architecture and code quality audits.
- Contributors implementing new features without breaking deterministic safety behavior.

This handbook is a reference architecture guide for the current repo shape. It is not the final authority for runtime ownership or feature completeness.

When runtime ownership, lifecycle status, or operator truth matter, prefer these sources in order:

1. `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
2. current implementation under `apps/` and `packages/`
3. `docs/1_0_CONTRACT.md` for public `1.0` scope, support truth, and release gates
4. this handbook for broader subsystem orientation

Implementation process guidance lives in `docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md`.

## Current Runtime Truth

- Durable execution is the canonical owner for the shipped resumable Chat / Cowork / Code flow set: HTTP/SSE send entrypoints, approval wait/resume, linked proactive wakes, durable-linked chat stream resumption, worker restart recovery, retry scheduling, and dead-letter recovery mechanics.
- Legacy traces without durable linkage may still use compatibility reads or resume fallbacks for historical records, but shipped operator sends and retries no longer rely on a non-durable ownership path.
- `MemoryLifecycleService` is the operator-facing memory lifecycle owner for context composition, learned-memory policy, and memory item list/edit/forget/history. `MemoryContextService`, `ChatLearnedMemoryService`, and `MemoryMaintenanceService` remain collaborators behind that boundary instead of separate policy owners.
- `packages/mesh-core` is currently smoke-only and does not count toward the `1.0` readiness bar while it still relies on `--passWithNoTests`.
- `apps/npu-sidecar` is optional experimental infrastructure and is not part of the current `1.0` bar.
- Visible `beta` and `native` non-channel integrations derive their advertised capabilities from the operator-action runtime registry; Mission Control should not surface diagnostics-only shells for those entries.
- Filesystem-backed backup restore is offline-only for `1.0`; operators must stop any gateway serving the same runtime root before invoking the CLI restore, and the live admin restore route must fail closed with `offline_restore_required` while the gateway is serving.
- Backup verify now carries two truths for `1.0`: archive integrity (`verified`) and minimum-set contract coverage (`contractVerified`).
- Surface-regression and visual-regression derive from the same canonical release-surface manifest so the visible `Work / Observe / Tune` proof set cannot drift silently.
- Postgres backups participate in shipped create/verify coverage, but restore remains an operator-driven `pg_restore` workflow rather than the SQLite file-copy restore path.

## 0. OpenClaw-Informed Hardening Deltas (Current Cycle)

This cycle applied targeted patterns inspired by OpenClaw changelog themes, adapted to GoatCitadel architecture:

- Config and startup diagnostics with warn-first remote bind guidance.
- Request hardening for suspicious encoded paths and webhook-style payload bounds.
- Prompt Lab runtime continuity improvements for event storms (background refresh over full reload).
- Explicit Prompt Lab separation of run failures vs score failures.
- Prompt-pack report summary counters now expose run failure count, score failure count, needs-score count, and pass threshold.
- Prompt-pack benchmark matrix endpoints are available for provider/model subset comparisons.
- Tool-loop reduction via argument preflight + repeated-failure circuit breaker.
- Controlled write-jail fallback to deterministic safe output paths.
- Expanded safe JSON parsing coverage in storage row mappers.
- Private-beta daily backup scheduler (`private_beta_backup_daily`) now runs with retention pruning.

## 1. Product Definition and System Goals

GoatCitadel is a local-first, TypeScript monorepo for orchestrating personal AI agents with:

- A gateway that owns session truth and accounting.
- A strict policy and sandbox layer before tool capability.
- Human-in-the-loop approval workflows with replayable audit.
- A skills system based on `SKILL.md` frontmatter and deterministic precedence.
- A Mission Control web application for operator visibility and intervention.
- OpenAI-compatible model endpoint support using `chat/completions`.
- Local, Docker-less execution with host filesystem controls and worktree-based isolation primitives.

Primary implementation goals:

- Safety before capability.
- Deterministic routing, policy evaluation, and activation behavior.
- API-first operations (user interface is a client, not a source of truth).
- Replayability and auditability of high-risk actions.
- Practical local operation without cloud lock-in.

## 2. Monorepo Structure

```text
<repo-root>
├─ apps
│  ├─ gateway                  # Fastify backend, canonical control plane
│  └─ mission-control          # React + Vite operator console
├─ packages
│  ├─ contracts                # Shared TypeScript contracts
│  ├─ extensions-sdk           # Author-facing add-on / integration-plugin SDK helpers
│  ├─ storage                  # SQLite repositories + JSONL logs
│  ├─ gateway-core             # Session keying, event ingest, token ledger
│  ├─ policy-engine            # Tool policy resolver + sandbox gates
│  ├─ skills                   # SKILL.md loading, precedence, activation
│  └─ orchestration            # Plan/wave/phase engine primitives
├─ config
│  ├─ goatcitadel.json
│  ├─ assistant.config.json
│  ├─ tool-policy.json
│  ├─ budgets.json
│  ├─ llm-providers.json
│  └─ cron-jobs.json
├─ data
│  ├─ index.db                 # SQLite index and durable operational state
│  ├─ transcripts\*.jsonl      # Append-only transcript events
│  └─ audit\*.jsonl            # Append-only policy/tool/approval audit logs
├─ skills
│  └─ bundled\*\SKILL.md       # Built-in skill definitions
└─ docs
   └─ screenshots              # Mission Control captures
```

## 3. Runtime Topology

### 3.1 Gateway (`apps/gateway`)

Gateway is the control plane and source of operational truth. It:

- Accepts inbound events and maps them to deterministic sessions.
- Writes transcript events to JSONL.
- Maintains indexed state and aggregates in SQLite.
- Executes tool requests through policy enforcement.
- Generates and resolves approvals.
- Streams realtime events via Server-Sent Events.
- Persists runtime settings and model provider configuration.

Boot sequence:

1. `loadGatewayConfig()` runs unified config sync (`config/goatcitadel.json` -> split config files).
2. `main.ts` starts Fastify on `127.0.0.1:8787` (default).
3. Signal handlers (`SIGINT`/`SIGTERM`) perform graceful shutdown via `app.close()`.
4. `gatewayPlugin` resolves repository root and loads config.
5. `GatewayService.init()` reloads skills and cron entries.
6. Routes are registered after CORS, auth, and idempotency plugins.

Development runtime:

- `pnpm dev:gateway` uses `apps/gateway/src/dev-supervisor.ts`.
- Supervisor behavior: restart-on-change with explicit child process tree shutdown, port release wait, and health check before returning to ready state.
- `pnpm dev:gateway:watch` is available as direct `tsx watch` fallback.

### 3.2 Mission Control (`apps/mission-control`)

Mission Control is an API client, not a backend extension. It:

- Calls gateway REST endpoints.
- Uses Server-Sent Events (`/api/v1/events/stream`) for live updates.
- Maintains local browser preferences for operator UX.
- Never writes data directly to local storage files or SQLite.
- Uses a topic-scoped refresh bus for SSE updates to avoid full-page refresh churn during active operations.

### 3.3 Shared Domain Packages

- `@goatcitadel/contracts`: types shared across backend and frontend.
- `@goatcitadel/extensions-sdk`: published author-facing manifest schemas, validation, and file helpers for extensions.
- `@goatcitadel/storage`: all SQLite repository and JSONL append/read logic.
- `@goatcitadel/gateway-core`: event ingest and deterministic session key logic.
- `@goatcitadel/policy-engine`: policy resolution and enforcement gates.
- `@goatcitadel/skills`: skill loading and activation.
- `@goatcitadel/orchestration`: orchestration run state transitions.

### 3.4 Workspaces and Guidance Resolution

Workspace model (v1):

- First-class `workspaces` entity with logical isolation in a single runtime/DB process.
- Existing records default to `workspace_id=default` for backward compatibility.
- Core chat/task entities include workspace scope for list/create flows.

Guidance resolution model:

- Public repo guidance is anchored in `AGENTS.md`, `CONTRIBUTING.md`, and `SECURITY.md`.
- Workspace-specific guidance may still exist in private or local runtime environments outside the public repository snapshot.
- Runtime injection is bounded by token budget and can be disabled with:
  - `GOATCITADEL_DISABLE_GUIDANCE_INJECTION=true`

Safety invariants are non-overridable by docs:

- deny-wins policy
- approval gates
- tool grants
- sandbox/security boundaries

## 4. Canonical Workflows

### 4.1 Session Event Ingest Flow

Endpoint: `POST /api/v1/gateway/events`

Execution order:

1. `Idempotency-Key` validated by plugin.
2. Input schema validated by route.
3. `EventIngestService.ingest()` resolves deterministic session key:
   - Direct message: `channel:account:peer`
   - Group: `channel:account:room`
   - Thread: `channel:account:room:threadId`
4. Existing idempotency record check:
   - If found: mark deduped, return existing session.
5. If new:
   - Insert pending idempotency row.
   - Upsert session record in SQLite.
   - Append transcript event to `data/transcripts/<sessionId>.jsonl`.
   - Transactionally update session usage + cost ledger + idempotency status.
6. Publish realtime `session_event`.

Design properties:

- Deterministic session mapping.
- Append-only transcript logging.
- Gateway-owned accounting.
- Idempotent mutation semantics.

### 4.2 Tool Invocation and Safety Gate Flow

Endpoint: `POST /api/v1/tools/invoke`

Execution order:

1. Route schema validation.
2. `ToolPolicyEngine.invoke()` resolves effective policy:
   - profile allowlist
   - global allow
   - per-agent allow
   - global deny
   - per-agent deny
   - deny wins
3. Unknown or denied tool is blocked and audited.
4. Safety gates:
   - path/host structural safety checks (jail + allowlist).
   - scoped consent grants (`global|session|agent|task`) with deny-wins.
   - risk-level gates (`safe|caution|danger|nuclear`) with approval requirements.
5. For approval-required actions:
   - create approval
   - store pending action payload
   - append approval event
   - return `approval_required`.
6. For allowed actions:
   - execute via `executeTool()`
   - persist invocation audit
   - return result payload.

### 4.3 Approval Lifecycle with Async Layman Explainer

Core endpoints:

- `POST /api/v1/approvals`
- `POST /api/v1/approvals/:approvalId/resolve`
- `GET /api/v1/approvals/:approvalId/replay`

Lifecycle:

1. Approval created and stored.
2. `approval_events` receives `created`.
3. Async explainer may schedule if risk >= configured threshold.
4. Explainer marks `explanation_status=pending`, emits `explanation_requested`.
5. Explainer calls LLM chat-completions with redacted payload.
6. On success:
   - stores explanation JSON
   - marks `completed`
   - emits `explanation_generated`
   - publishes realtime `approval_explained`.
7. On failure:
   - marks `failed`
   - stores `explanation_error`
   - emits `explanation_failed`.
8. Resolve endpoint:
   - updates approval state
   - optionally executes pending action if approved
   - emits replayable events.

Guarantee: explainer is informational only; policy decisions do not depend on it.

### 4.6 Native Tool Expansion Packs

Implemented packs:

- Dev Ops: `fs.*`, `git.*`, `tests.run`, `lint.run`, `build.run`
- Knowledge: `memory.*`, `docs.ingest`, `embeddings.*`, `artifacts.create`
- Comms: `channel.send`, `webhook.send`, `slack.send`, `discord.send`, `gmail.*`, `calendar.*`

Execution model:

- All calls still go through `POST /api/v1/tools/invoke` and the policy engine.
- Helper endpoints exist for API-first UX, but they do not bypass policy.
- Grant scopes are evaluated in precedence order `task > agent > session > global`.
- Grants and access decisions are persisted in SQLite (`tool_grants`, `tool_access_decisions`).

### 4.4 Channel Inbound Adapters

Endpoint: `POST /api/v1/channels/:channel/inbound`

Purpose: allows external channels (for example Discord or Slack connectors) to map into canonical gateway event ingestion without bypassing session routing or accounting.

Behavior:

- Normalizes channel payload into `GatewayEventInput`.
- Enforces idempotency with header.
- Reuses primary ingest pipeline.
- Publishes channel ingestion realtime event.

### 4.5 Orchestration Run Progression

Core endpoints:

- `POST /api/v1/orchestration/plans`
- `POST /api/v1/orchestration/plans/:planId/run`
- `POST /api/v1/orchestration/phases/:phaseId/approve`
- `GET /api/v1/orchestration/runs/:runId`
- `GET /api/v1/orchestration/runs/:runId/checkpoints`

Behavior:

- Plan validation via schema and ownership overlap checks.
- Run creation with checkpoints and run events.
- Start transitions to `running` or `paused` based on run mode.
- Phase approval advances to next phase/wave and increments iteration/cost.
- Hard limits (`maxIterations`, `maxRuntimeMinutes`, `maxCostUsd`) can terminate run with `stopped_by_limit`.

Current scope:

- State machine and checkpoints are implemented.
- Worktree manager class exists, but full wave execution against isolated worktrees is not yet wired into runtime execution loops.

## 5. Persistence Model

### 5.1 On-Disk Files

- SQLite index/state: `data/index.db`
- Transcript logs: `data/transcripts/<sessionId>.jsonl`
- Audit logs: `data/audit/tool_invocations.jsonl`, `policy_blocks.jsonl`, `approvals.jsonl`

### 5.2 SQLite Tables

The `packages/storage/src/sqlite.ts` migration creates and updates these tables:

- `sessions`
- `inbound_events`
- `approvals`
- `approval_events`
- `pending_approval_actions`
- `tool_invocations`
- `policy_blocks`
- `cost_ledger`
- `tasks`
- `task_activities`
- `task_deliverables`
- `task_subagent_sessions`
- `realtime_events`
- `cron_jobs`
- `skills_index`
- `workspaces`
- `orchestration_runs`
- `orchestration_plans`
- `orchestration_checkpoints`
- `orchestration_events`
- `integration_connections`

Migration safeguards:

- Approval explainer columns added idempotently if missing.
- Legacy `openclaw_session_id` migrated to `agent_session_id` with fallback table rebuild.
- Workspace migration backfills `workspace_id=default` across scoped entities.

### 5.3 Source-of-Truth Clarification

- Session/event flow truth is controlled by gateway APIs and event ingest logic.
- Transcripts and audit streams are append-only operational event records.
- SQLite stores indexed operational state and replay metadata used by APIs and Mission Control.
- Skills are sourced from disk `SKILL.md`; database entries are cache/index.

## 6. Security and Safety Model

### 6.1 Authentication Modes

Configured in `assistant.config.json`:

- `none`: no auth checks.
- `token`: bearer token/header/query validation.
- `basic`: HTTP basic authentication.

Features:

- Optional loopback bypass for local trust.
- Warn-first startup warning when binding non-loopback without configured auth.
- Runtime updates through `PATCH /api/v1/auth/settings` and `PATCH /api/v1/settings`.
- Client-side Mission Control stores auth credentials in browser local storage for API calls and event stream URL query auth.

Related host/origin controls:

- `GOATCITADEL_ALLOWED_ORIGINS`
- `GOATCITADEL_VITE_ALLOWED_HOSTS`
- `VITE_GATEWAY_ALLOWED_HOSTS`

### 6.2 Idempotency Enforcement

Mutating methods (`POST`, `PATCH`, `PUT`, `DELETE`) require `Idempotency-Key`.

Rejected requests without this header receive `400`.

### 6.3 Sandbox Controls

Policy engine enforcement includes:

- Path jail (`assertWritePathInJail`) for write scope.
- Read allowlist combining write roots and read-only roots.
- Existing-path realpath check to reduce symlink escape risks.
- Network allowlist using wildcard host pattern matching.
- Risky shell pattern classification and approval gate.

### 6.4 Auditing

Tool and policy decisions are written to both:

- SQLite (`tool_invocations`, `policy_blocks`, approvals tables).
- Append-only JSONL audit logs.

## 7. Skills System

Skill canonical format:

- Folder containing `SKILL.md`.
- YAML frontmatter at top of file.
- Body instructions as skill content.

Implemented frontmatter fields:

- `name`
- `description`
- `metadata.version`
- `metadata.tags`
- `metadata.tools`
- `metadata.requires`
- `metadata.keywords`

Load order and precedence:

- Sources loaded: `extra`, `bundled`, `managed`, `workspace`.
- Conflict resolution precedence: `workspace > managed > bundled > extra`.
- Tie-breaker within same source: latest `mtime`.

Activation behavior:

- Explicit triggers (`@skill name`, `use name`).
- Keyword matches against input text.
- Dependency resolution with cycle and missing dependency blocking metadata.

## 8. Model Provider and OpenAI-Compatible Support

`LlmService` supports providers exposing:

- `GET /models`
- `POST /chat/completions`

Supported API style:

- `openai-chat-completions` only.

Explicitly not supported:

- Legacy `openai completions` (`/v1/completions`) path.

Provider operations:

- List providers and runtime configuration.
- Update active provider/model.
- Upsert provider records at runtime.
- Persist to `config/llm-providers.json`.
- Optional inline API key or environment variable sourced API key.

## 9. Mission Control Feature Breakdown

Navigation tabs currently implemented:

- Summit (Dashboard): cross-domain KPI rollup.
- Engine (System): host and process vitals.
- Trail Files: workspace listing, preview, and file writing.
  - Includes beginner artifact templates and template-to-file creation helpers.
- Memory Pasture: workspace area and `memory/*` breakdown.
- Goat Crew (Agents): role roster with runtime overlays.
- Herd HQ (Office): WebGL office with operator + radial goat stations.
- Pulse (Activity): realtime event feed.
- Bell Tower (Cron): scheduled jobs state.
- Runs (Sessions): session health and spend totals.
- Playbook Skills: loaded skill inventory.
- Feed Ledger (Costs): cost summary and run leaner hints.
- Forge (Settings): policy, auth, LLM, allowlist controls.
- Gatehouse (Approvals): approval queue and replay.
- Trailboard (Tasks): tasks, activities, deliverables, subagent sessions.
  - Includes task trash lifecycle (`active|trash|all`, soft delete, restore, hard delete).
- Connections: integration catalog and connection management.
- Tool Access: catalog, grant lifecycle (create/revoke), access evaluation, and dry-run invoke.
- Prompt Lab: execution benchmarking with separate runtime-failure and quality-failure classification.
- Every tab now includes a `PageGuideCard` with plain-English "what/when/actions/terms".
- Editable tabs use shared change-awareness components with goat-themed risk badges.

Office implementation details:

- True WebGL scene via `@react-three/fiber`.
- Repeated desk kit geometry for performance and visual consistency.
- Neutral lighting and clear status glows.
- Central operator model with presets and rename.
- Goat stations with click-to-inspect details and thought/action overlays.
- Procedural fallback when optional external models are unavailable.

## 10. API Surface Reference

All mutating endpoints require `Idempotency-Key`.

### Health and Streams

- `GET /health`
- `GET /api/v1/events`
- `GET /api/v1/events/stream`

### Sessions and Gateway

- `POST /api/v1/gateway/events`
- `GET /api/v1/sessions`
- `GET /api/v1/sessions/:sessionId`
- `GET /api/v1/sessions/:sessionId/transcript`

### Tools and Policy

- `POST /api/v1/tools/invoke`
- `GET /api/v1/tools/catalog`
- `POST /api/v1/tools/access/evaluate`
- `GET /api/v1/tools/grants`
- `POST /api/v1/tools/grants`
- `POST /api/v1/tools/grants/:grantId/revoke`

### Approvals

- `POST /api/v1/approvals`
- `GET /api/v1/approvals`
- `POST /api/v1/approvals/:approvalId/resolve`
- `GET /api/v1/approvals/:approvalId/replay`

### Costs

- `GET /api/v1/costs/summary`
- `POST /api/v1/costs/run-cheaper`

### Prompt Lab

- `POST /api/v1/prompt-packs/import`
- `POST /api/v1/prompt-packs/:packId/tests/:testId/run`
- `POST /api/v1/prompt-packs/:packId/tests/:testId/score`
- `POST /api/v1/prompt-packs/:packId/tests/:testId/auto-score`
- `POST /api/v1/prompt-packs/:packId/auto-score`
- `GET /api/v1/prompt-packs/:packId/report`
- `POST /api/v1/prompt-packs/:packId/benchmark/run`
- `GET /api/v1/prompt-packs/benchmark/:benchmarkRunId`

### Skills

- `GET /api/v1/skills`
- `POST /api/v1/skills/reload`
- `POST /api/v1/skills/resolve-activation`

### Tasks and Subagents

- `GET /api/v1/tasks`
  - Supports `view=active|trash|all` and `includeDeleted` compatibility alias.
- `POST /api/v1/tasks`
- `GET /api/v1/tasks/:taskId`
- `PATCH /api/v1/tasks/:taskId`
- `DELETE /api/v1/tasks/:taskId`
  - Supports `mode=soft|hard` via query/body.
- `POST /api/v1/tasks/:taskId/restore`
- `GET /api/v1/tasks/:taskId/activities`
- `POST /api/v1/tasks/:taskId/activities`
- `GET /api/v1/tasks/:taskId/deliverables`
- `POST /api/v1/tasks/:taskId/deliverables`
- `GET /api/v1/tasks/:taskId/subagents`
- `POST /api/v1/tasks/:taskId/subagents`
- `PATCH /api/v1/subagents/:agentSessionId`

### Dashboard and Ops

- `GET /api/v1/dashboard/state`
- `GET /api/v1/system/vitals`
- `GET /api/v1/cron/jobs`
- `GET /api/v1/operators`
- `GET /api/v1/agents`
- `GET /api/v1/memory/files`
- `GET /api/v1/settings`
- `PATCH /api/v1/settings`
- `GET /api/v1/auth/settings`
- `PATCH /api/v1/auth/settings`

### Files

- `GET /api/v1/files/templates`
- `POST /api/v1/files/templates/:templateId/create`
- `GET /api/v1/files/list`
- `POST /api/v1/files/upload`
- `GET /api/v1/files/download`
- `GET /api/v1/files/preview`

### UI Change Risk

- `POST /api/v1/ui/change-risk/evaluate`

### LLM

- `GET /api/v1/llm/providers`
- `GET /api/v1/llm/config`
- `PATCH /api/v1/llm/config`
- `GET /api/v1/llm/models`
- `POST /api/v1/llm/chat-completions`

### Integrations and Channels

- `GET /api/v1/integrations/catalog`
- `GET /api/v1/integrations/connections`
- `POST /api/v1/integrations/connections`
- `PATCH /api/v1/integrations/connections/:connectionId`
- `DELETE /api/v1/integrations/connections/:connectionId`
- `POST /api/v1/channels/:channel/inbound`

### Comms Helpers

- `POST /api/v1/comms/send`
- `POST /api/v1/comms/gmail/read`
- `POST /api/v1/comms/gmail/send`
- `POST /api/v1/comms/calendar/list`
- `POST /api/v1/comms/calendar/create`

### Knowledge Helpers

- `POST /api/v1/knowledge/memory/write`
- `POST /api/v1/knowledge/memory/search`
- `POST /api/v1/knowledge/docs/ingest`
- `POST /api/v1/knowledge/embeddings/index`
- `POST /api/v1/knowledge/embeddings/query`

### Orchestration

- `POST /api/v1/orchestration/plans`
- `POST /api/v1/orchestration/plans/:planId/run`
- `POST /api/v1/orchestration/phases/:phaseId/approve`
- `GET /api/v1/orchestration/runs/:runId`
- `GET /api/v1/orchestration/runs/:runId/checkpoints`

## 11. Configuration Reference

### `config/goatcitadel.json`

Canonical unified configuration file. On gateway startup:

1. If `goatcitadel.json` exists, its sections are synced to split config files.
2. If missing, it is created from the current split files.

Supported top-level sections:

- `assistant`
- `toolPolicy`
- `budgets`
- `llm`
- `cronJobs`

Manual sync command:

```bash
pnpm config:sync
```

Private-beta config snapshot:

- `config/private-beta.profile.json` (auth + cron posture reference).
- Environment companion: `.env.private-beta.example`.

### `config/assistant.config.json`

Defines environment, directory roots, auth mode, and approval explainer defaults.

Important fields:

- `auth.mode`
- `auth.allowLoopbackBypass`
- `auth.token.queryParam`
- `approvalExplainer.enabled`
- `approvalExplainer.minRiskLevel`
- `approvalExplainer.timeoutMs`
- `approvalExplainer.maxPayloadChars`

### `config/tool-policy.json`

Defines:

- tool profiles and tool lists.
- global and per-agent allow/deny behavior.
- jail roots, read-only roots, network allowlist, risky shell patterns.

### `config/budgets.json`

Defines token and cost warnings and hard caps by day/session.

### `config/llm-providers.json`

Defines model provider catalog, active provider, and default models.

### `config/cron-jobs.json`

Optional list of scheduled jobs loaded into SQLite for dashboard visibility.

Current convention:

- Active runtime schedules are:
  - `self_improvement_weekly_replay`
  - `private_beta_backup_daily`
- Non-runtime placeholders are marked with `[planned]` in name and `enabled: false`.

## 12. Development and Operations

### 12.1 Local Setup

Prerequisites:

- Node.js 22 or newer.
- pnpm 10 or newer.
- Git on PATH.

Commands:

```bash
pnpm install
pnpm dev
pnpm dev:all
pnpm up
pnpm dev:gateway
pnpm dev:gateway:watch
pnpm dev:ui
pnpm config:sync
```

### 12.2 Quality Gates

```bash
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

### 12.3 Backup and Recovery

Minimum backup set:

- `data/index.db`
- `data/transcripts/*.jsonl`
- `data/audit/*.jsonl`
- `config/*.json`

Release-proof expectation:

- `verify:backup:roundtrip` must seed, mutate, restore, and verify all four classes above, including every runtime `config/*.json` file present at backup time.
- `verify:visual:regression` must compare checked-in baselines for the shell and primary `Work / Observe / Tune` surfaces, not just capture screenshots.
- `verify:catalog:parity` must execute real operator actions for the visible runtime-backed non-channel classes it claims to cover.
- `verify:api:compat` must snapshot REST schemas and realtime event envelopes and fail on breaking diffs.

If `index.db` is lost but logs remain:

- transcripts and audit logs still preserve historical event records.
- a replay/import utility is recommended as a future enhancement.

## 13. Test Coverage Inventory

Current automated tests include:

- Session key determinism (`packages/gateway-core/src/session-key.test.ts`).
- Policy precedence and gate helpers (`packages/policy-engine/src/*.test.ts`).
- Skills precedence/dependency (`packages/skills/src/*.test.ts`).
- Storage repositories and migrations (`packages/storage/src/*.test.ts`).
- Orchestration state transitions and ownership conflict checks (`packages/orchestration/src/*.test.ts`).
- Approval explainer behavior (`apps/gateway/src/services/approval-explainer-service.test.ts`).

## 14. Known Gaps and Risk Areas

These are implementation realities to include in architectural/code review:

- Worktree manager exists, but full orchestration-to-worktree execution is partial.
- File writes in mission control files tab are direct content writes; no diff editor yet.
- No multi-user authorization model; auth is gateway-level only.
- No built-in secrets manager; provider keys can be runtime-persisted if provided inline.
- No formal rate limiter for public-hosting scenarios.
- Replay/import utilities for rebuilding SQLite from logs are not yet shipped.
- Mobile companion runtime remains a placeholder track (docs-first, no production mobile control plane yet).
- Mobile companion research lives in `docs/mobile_app_research_report.md` and is the input source for future implementation.

## 15. Suggested Review Tracks for Subagents

Use separate reviewer tracks for:

- Security hardening and threat model.
- Data durability and migration correctness.
- Performance and scaling under high event volume.
- User experience and accessibility in Mission Control.
- Orchestration correctness, especially limits and checkpoint semantics.
- API contract consistency between frontend client and backend schemas.
- Test coverage gaps and deterministic behavior checks.

## 16. Reviewer Checklist

Before approving production use:

1. Verify every mutating route enforces idempotency.
2. Verify deny-wins behavior under all policy combinations.
3. Verify jail and allowlist gates cannot be bypassed with path traversal or host tricks.
4. Verify approval resolution does not execute stale or malformed pending actions.
5. Verify auth mode changes persist and are applied without restart regression.
6. Verify chat-completion routing never falls back to legacy completions.
7. Verify Mission Control never bypasses gateway APIs for state mutation.
8. Verify all migrations are safe on existing databases.
9. Verify orchestration limits halt execution deterministically.
10. Verify JSONL append and replay paths are stable under duplicate event traffic.

---

For release-facing setup and screenshots, see repository `README.md`.
