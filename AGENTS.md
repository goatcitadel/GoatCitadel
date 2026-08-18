# AGENTS.md - GoatCitadel

Last updated: 2026-08-15

## Scope and Instruction Precedence

This is the repository-wide baseline for coding agents.

- A nested `AGENTS.md` specializes these instructions for its directory tree.
- The closest applicable `AGENTS.md` wins when instructions conflict.
- Explicit user instructions in the active conversation override this file.
- Product security boundaries, deny-wins policy, approval requirements, and runtime authority are implementation invariants; documentation or prompts do not bypass them.
- Treat `AGENTS.md` files as living standard Markdown. Keep them aligned with the current repository instead of preserving stale architecture for historical consistency.

## Project Overview

GoatCitadel is a local-first AI operations console for chat, coding, orchestration, memory, tools, approvals, and operator-visible runtime truth.

It is not just a chat UI. It is a chat-first, multi-provider, skill-aware workspace where users can:

- chat with AI naturally
- supervise agentic workflows
- build, review, and refine code
- manage providers, tools, memory, skills, integrations, approvals, and runtime health
- understand what the system did, why it did it, and what still needs human judgment

## Current Product Truth

- `apps/mission-control-next` is the canonical `1.0` Mission Control shell.
- `apps/mission-control` source is archived from disk; generated build/runtime residue may still exist locally but is not a shipped compatibility source.
- The Fastify gateway owns orchestration, approvals, memory, integrations, audit trails, policy enforcement, durable execution, and runtime APIs.
- Chat is the only primary conversation surface. Planning, research, agentic orchestration, approvals, and code-capability work happen inside Chat.
- Legacy Cowork and Code route/mode inputs are compatibility shims that normalize to Chat or Ops Kanban.
- Durable execution owns the shipped resumable mission-session Chat flow set, including agentic planning/delegation and code-capability turns.
- The capability system governs tools, runtime skills, candidates, proposals, and Code Mode runs through inspectable and callable catalogs.
- Autonomous activation is governed by expiring operator grants and remains subordinate to deny-wins policy, approvals, auth, path jails, provenance, and health checks.
- Code Mode v1 is a governed trusted-code capability launched from Chat with explicit approval, immutable ledger references, recorded artifact hashes, and execution-time hash checks. Do not claim hostile-code sandboxing.
- Native Windows desktop hosting and installer paths are part of the product shape.
- Docker is a supported local/shared-host runtime boundary, but it does not replace auth, approvals, path jails, or policy.
- Public claims must stay aligned with `docs/1_0_CONTRACT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, and current implementation.

## Core Product Surfaces

| Surface | Purpose | Primary Feel |
|---|---|---|
| Chat | Conversation, questions, drafting, planning, research, approvals, agentic work, and code-capability context | Simple, direct, low-friction |
| Projects | Workspace and project organization | Structured, navigable |
| Library | Skills, memory, files, artifacts, capability evidence | Inspectable, provenance-aware |
| Ops | Runtime health, activity, cost, diagnostics, backups, release proof | Operational, high-signal |
| Settings | Providers, models, tools, integrations, channels, auth, workspace controls | Clear, progressive, safe |

## North Star

GoatCitadel should feel like a personal AI operations console:

- powerful without being chaotic
- local-first without feeling primitive
- futuristic without sacrificing readability
- transparent enough for experts
- approachable enough for curious first-timers
- honest about what is implemented, experimental, blocked, or unsafe to claim

## Core Principles

### 1. Truth Beats Theater

Do not dress roadmap, diagnostics, or partial support as finished product behavior. If something is experimental, compatibility-only, advisory, or manually governed, say so.

### 2. Trust Is a Feature

Users should understand which model/provider is being used, why it was selected, what tools or capabilities were available, what tools were used, where memory/context came from, what approvals were required, what persisted as evidence, and what still needs human judgment.

### 3. One Runtime, One Chat Surface

Chat is the primary operator surface. Runtime foundations still support planning, delegation, approvals, memory, tools, and governed Code Mode, but the user should not have to switch to separate Cowork or Code panes to use them.

### 4. Human-in-the-Loop by Default

Risky actions, durable memory writes, code execution, external side effects, and capability activation must stay visible and governed.

### 5. Progressive Disclosure

Beginners should not face a wall of knobs. Advanced users should still have compressed, inspectable controls when they need them.

### 6. Safe Iteration Over Heroic Rewrites

Prefer small, validated, reversible changes. Preserve architecture boundaries unless the current implementation clearly forces a better extraction.

### 7. Cyberpunk, But Legible

Mission Control can feel sharp, technical, and neon-lit, but readability, hierarchy, spacing, accessibility, and responsiveness come first.

## How Agents Should Work

When changing this repo:

1. Find the relevant runtime owner before editing.
2. Prefer current implementation over stale docs.
3. Keep diffs surgical.
4. Preserve public truth: docs, UI copy, and implementation must agree.
5. Do not mutate user data, secrets, generated evidence, or runtime state casually.
6. Do not introduce new dependencies without clear need.
7. Validate proportionally to risk.
8. Report what changed, what was tested, and what remains uncertain.
9. Before acting on a GitHub Security finding (code scanning, secret scanning, Dependabot), read [`docs/security/findings-triage.md`](docs/security/findings-triage.md). It captures recurring CodeQL patterns such as `js/missing-rate-limiting` and `js/unhandled-error-in-stream-pipeline`, Dependabot triage, the narrow `secret_scanning.yml` allowlist convention, and the rules around the synthetic token fixtures in the redaction tests. Do not re-derive these decisions from scratch.

## Repository, Worktree, and Multi-Agent Safety

Assume a checkout may contain work owned by the user or another agent, even when the task sounds isolated.

- Inspect `git status --short --branch` before editing and again before handoff.
- Inspect both tracked diffs and untracked files; ordinary `git diff` output does not include untracked content.
- Treat every pre-existing tracked or untracked change as someone else's work unless the user explicitly assigns it to you.
- Never reset, restore, checkout, clean, stash, delete, or overwrite unrelated changes to make a task easier.
- Do not stage, commit, rebase, merge, push, or force-push unless the user explicitly asks for that operation.
- Keep edits surgical. Avoid unrelated formatting, generated-output churn, dependency changes, or broad mechanical rewrites.
- Re-read a target file immediately before patching it. If it changed since inspection, preserve the new content and reconcile deliberately rather than replacing it from an older snapshot.
- When several agents share a checkout, prefer disjoint file ownership. If overlap is unavoidable, communicate the exact files and wait for a safe handoff before editing.
- Do not delete, move, or repurpose another agent's worktree, scratch files, test artifacts, logs, locks, or running processes.
- Use the repository's output-lock wrappers for build and typecheck commands that provide them. Do not bypass a live lock with a second writer.
- Before stopping a server, database, worker, or watcher, establish that this task started and owns the exact process tree or port. Leave pre-existing processes alone.

## Windows and PowerShell Defaults

The primary local development environment is Windows.

- Default to PowerShell and Windows paths for repository work. From an arbitrary directory, use `Set-Location -LiteralPath 'F:\code\personal-ai'`; do not translate it into a Unix-style `/f/...` path.
- Run workspace commands from the repository root unless a package script explicitly requires a package directory.
- Prefer repository `pnpm` scripts over hand-built command chains, and use the package names from the live `package.json` files.
- Use `rg` and `rg --files` for search. Use `-LiteralPath` for filesystem operations when a path is already known.
- Preserve `.editorconfig` line endings: LF by default, CRLF for `*.bat`, `*.cmd`, and `*.ps1`.
- Quote paths that contain spaces. Avoid unresolved globs, broad recursive operations, and commands whose target depends on an unchecked environment variable.
- PowerShell success must be checked through the command's real exit code when external tools are involved; output text alone is not proof.
- Do not casually mutate `config/`, `data/`, `runtime/`, generated evidence, installed payloads, credentials, or OS keychain state while validating source changes.

## Source of Truth Order

When facts conflict, prefer:

1. current implementation under `apps/` and `packages/`
2. `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
3. `docs/1_0_CONTRACT.md`
4. `docs/ENGINEERING_HANDBOOK.md`
5. older review notes, plans, or roadmap docs

## Surface Guidance

### Chat

Chat should feel immediate and natural. It should prioritize responsiveness, preserve conversation flow, show citations/tool/runtime status when relevant, and avoid becoming a dense orchestration console.

### Agentic Work In Chat

Supervised agentic work lives inside Chat. It should show task decomposition, execution state, approvals, retries, pivots, blocked states, checkpoints, delegation lineage, and synthesis integrity without requiring a separate Cowork surface. It must use the shared Gateway, durable execution, policy, memory, and capability foundations.

### Code Capability In Chat

Implementation help and governed Code Mode runs should be launched, reviewed, and explained from Chat. They should preserve existing project patterns, use minimal reviewable diffs, respect file ownership and architecture boundaries, run targeted validation when feasible, and surface approval and artifact truth for governed Code Mode work.

Code should avoid sweeping rewrites without justification, casual dependency additions, unrelated formatting churn, unsafe claims about sandboxing, and bypassing policy, path jails, approvals, or capability activation rules.

## UI/UX Direction

GoatCitadel's design language should feel like mission control, observability dashboard, cyberpunk operations console, and high-trust SaaS control center.

Visual principles:

- bright, clean, breathable layouts
- teal/cool neon accents over muddy dark-on-dark palettes
- dense but scannable information
- purposeful panels, not random boxes
- clear status hierarchy
- responsive layouts that work on desktop and mobile
- accessibility-visible streaming, focus, and status states

UX rules:

- Important actions should be obvious.
- Dangerous actions should be explicit.
- Secondary detail should be collapsible.
- Status should be visible at a glance.
- Provider, model, cost, latency, tool, and memory behavior should be inspectable.
- Beginners get safer defaults and guidance.
- Advanced users get control without cluttering the default path.
- No visible primary surface should rely on raw JSON or raw tables as its main operator UI.

## Architecture Expectations

### Gateway Runtime

The gateway is the control plane and source of operational truth. It owns runtime APIs, routing, orchestration entrypoints, approvals, policy enforcement, integrations, audit, realtime events, and persistence coordination.

### Mission Control

Mission Control is an API client, not a second backend. It should never bypass gateway-owned state by writing directly to runtime files or databases.

### Provider Layer

Provider work should preserve clean abstractions for OpenAI, Anthropic, Google, Moonshot, Perplexity, local/OpenAI-compatible runtimes, and future providers. Normalize messages, streaming, tool calls, model metadata, error reporting, usage, and cost signals where possible.

### Durable Execution and Orchestration

Durable runs are the authority for resumable mission-session Chat work, including planning, research, delegation, approvals, and code-capability turns. Approval-gated resume must re-enter durable execution rather than advancing only UI or side-table state.

### Capability and Skills Layer

The capability system governs tools, skills, generated candidates, proposals, and Code Mode runs.

Rules:

- `inspectableCatalog` is for review.
- `callableCatalog` is for planning/runtime use.
- Inactive candidates and proposals are never callable.
- Capability activation requires visible trust/provenance state.
- Runtime skills remain `SKILL.md` driven and should define clear inputs, workflow, output contract, and boundaries.

### Memory and Context Layer

`MemoryLifecycleService` is the operator-facing owner for memory lifecycle behavior: context composition, learned-memory policy, item list/edit/forget/history, dedupe, scope, and write policy.

Memory behavior must be explicit, scoped, and reversible where possible.

### Policy, Security, and Approvals

Deny-wins policy, approval gates, path jails, allowlists, auth boundaries, and tool grants are non-overridable by docs or prompts.

High-risk operations should leave durable, inspectable evidence.

### Storage, Audit, and Realtime

Canonical state belongs in repositories and durable logs, not inferred UI state. Realtime events are retained operator signals, not the complete historical record.

### Integrations, Channels, and Extensions

Visible integrations and channels must either have real operator actions and diagnostics or be clearly labeled as incomplete/blocked. Public extension claims should stay aligned with `@goatcitadel/extensions-sdk`.

## Memory Rules

Agents must avoid storing sensitive personal info casually, avoid silently promoting temporary context into durable memory, keep workspace memory separate from user identity/preferences, expose uncertainty when memory may be stale, preserve source/provenance where feasible, and require visible approval where the runtime expects memory-write governance.

Compaction should preserve decisions, evidence, and constraints, not just shorten text.

## Skill Standards

A good GoatCitadel skill should define when to use it, when not to use it, required inputs, optional inputs, what the agent does, what the user must decide, workflow steps, output contract, failure modes and boundaries, examples, related skills, metadata, and provenance.

Skills should be modular, inspectable, composable, and governed by lifecycle/trust state.

## Validation Expectations

Use the smallest validation lane that proves the change, but do not skip validation for runtime, policy, data, or user-facing behavior.

Common proof lanes include:

- focused package tests
- focused app tests
- package typecheck
- `pnpm typecheck`
- `pnpm verify:fast`
- `pnpm verify:gateway:async-boundary`
- `pnpm verify:runtime:truth`
- `pnpm verify:durable:recovery`
- `pnpm verify:desktop`
- `pnpm verify:surface:regression`
- `pnpm verify:visual:regression`
- `pnpm docs:check`
- `git diff --check`

For UI changes, include visual or browser proof when practical.

For installer, desktop, release, auth, backup, provider, or Code Mode changes, use the repo's named verification lanes rather than relying on build success alone.

## Claims Agents Must Not Make Without Fresh Proof

Do not claim:

- hostile-code sandboxing for Code Mode
- ungoverned autonomous high-risk tool activation
- full local inference maturity from the optional NPU sidecar
- compatibility shell parity as canonical product readiness
- remote MCP transport invocation that bypasses Gateway policy, approvals, network allowlists, audit, or supported auth
- generated screenshot or release proof that was not actually produced
- backup restore guarantees beyond the documented offline/operator-run paths

## Project Conventions

This section describes GoatCitadel's runtime guidance injection. It is separate from the source-tree `AGENTS.md` precedence used by coding agents above.

`GuidanceService` resolves each supported runtime guidance document independently: a workspace copy under `workspaces/<workspaceId>/` takes precedence over the same global document type. That selection changes model context for the workspace; it does not change source-tree instruction scope or weaken the immutable approval, deny-wins, tool-grant, host, network, or path boundaries.

## Agent Roles

The built-in profile catalog is owned by `packages/contracts/src/agents.ts`; keep this summary synchronized with that owner. `Goatherder` is the coordinator identity used by the runtime. These roles guide runtime routing and handoffs; they do not require a repository coding agent to spawn subagents or role-play on every task.

Primary default roles:

- `Goatherder`: coordinator, routes work, merges outputs, enforces handoff structure.
- `Architect`: design, interfaces, constraints, migration plans.
- `Coder`: implementation plans, code-level changes, patches.
- `QA`: test strategy, failure analysis, regression checks.
- `Ops`: deployment, runtime, rollback, monitoring.
- `Researcher`: external/source analysis with confidence labels.
- `Product`: requirements, prioritization, scope boundaries.
- `Personal Assistant`: operator support tasks and summaries.
- `Memory Maintainer`: memory curation, source attribution, dedupe, and context hygiene.

Routing rules:

- Choose the minimal number of roles needed for the request.
- For multi-role requests, preserve explicit role order from the prompt.
- Do not silently drop required roles; if unavailable, emit a scaffolded fallback section.

Handoff contract:

- When multiple roles are requested, output must include role-labeled sections in order.
- On partial failure, keep all role sections and add constraints, workarounds, and required user input to continue.

Tool discipline:

- Check tool availability before planning tool-heavy steps.
- Validate required tool arguments before invocation.
- Do not retry identical failing tool calls repeatedly.
- If blocked by policy, jail, or approval, explain the block and provide the next safe action.

## Safety Boundaries (Non-Overridable)

- Deny-wins policy remains authoritative.
- Approval-required tools remain approval-gated.
- Tool grants and sandbox boundaries are not weakened by guidance docs.

## Final Reporting

When handing work back, state:

- what changed
- where it changed
- what was validated
- what was not validated
- any remaining risk or follow-up work

Keep the report truthful, concise, and grounded in the repo.
