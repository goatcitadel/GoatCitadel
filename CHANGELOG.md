# Changelog

All notable changes to GoatCitadel are documented in this file.

The format is inspired by Keep a Changelog and uses semantic pre-release tags.

## [Unreleased]

### Added

- Mission Control command-deck shell:
  - top-level `Operate`, `Observe`, and `Configure` spaces,
  - routed `Chat`, `Cowork`, and `Code` surface modes,
  - dedicated approvals, costs, quality, integrations, and agent hub views.
- Native-first provider runtime controls:
  - provider API-style selection in settings,
  - active model switching and provider smoke-test flows,
  - LLM pricing estimation helpers for supported providers and routed models.
- Historical LLM spend repair tooling:
  - `apps/gateway/src/services/llm-pricing.ts` for runtime cost estimation,
  - `scripts/backfill-llm-costs.ts` for repairing missing assistant message and ledger costs.
- Expanded integrations UX:
  - integration overview and channels views,
  - connector diagnostics,
  - channel send/react/unsend test flows with attachment support,
  - MCP management in the same surface.
- Workspace and governance foundations:
  - `workspaces` table and repository with `create/list/update/archive/restore`,
  - workspace-scoped guidance APIs and resolution rules,
  - governance docs and workspace override templates.
- Zero-trust tool/runtime hardening:
  - tool security enforcement and ingestion contracts in the policy engine,
  - hot-path storage indexes for approvals, tool invocations, and policy blocks.
- Docs and release assets:
  - public-share review docs,
  - screenshot capture pipeline,
  - refreshed top-level README and screenshot coverage.

### Changed

- Gateway startup sequencing is now split between critical init and deferred background init so the process can listen sooner while cron/bootstrap work finishes asynchronously.
- Mission Control reconnect cadence was tightened so the UI returns faster after a gateway restart.
- Approval, costs, integrations, and settings pages were reworked as clearer hub surfaces with stronger tests and more intentional page-level copy.
- Prompt-pack evaluation and provider routing were hardened across recent mainline work, including better model usage surfacing and safer recovery behavior.
- README and install docs now reflect the current GitHub owner, current Mission Control shell, and current screenshot set.

### Fixed

- Legacy SQLite migration fixtures no longer fail when replaying `createChatSessionHistoryVisibilitySchema` against databases that predate `chat_session_meta`.
- Cron bootstrap now avoids rewriting unchanged cron jobs on startup and can restore configured jobs inside one immediate transaction.

### Notes

- This line remains pre-1.0 and backward-compatible by defaulting omitted workspace references to `default`.
- Product release history stays in `CHANGELOG.md`; validated runtime learning outcomes are tracked separately in `GOATCITADEL_LEARNING_LOG.md`.

## [0.1.0-beta.1] - 2026-02-28

Initial beta baseline for private testing.

### Added

- Core platform architecture:
  - TypeScript monorepo with `apps/gateway`, `apps/mission-control`, and shared `packages/*`.
  - Local-first runtime with no Docker dependency.
- Gateway control plane:
  - Deterministic session routing and canonical session ownership.
  - Append-only JSONL transcripts and audit streams.
  - Gateway-owned token and cost accounting.
  - Idempotent mutation flow with indexed dedupe tracking.
- Tool policy and sandboxing:
  - Deny-wins policy resolver (`profile + allow + deny + per-agent overrides`).
  - Path jail and read scope enforcement.
  - Network allowlist gate.
  - Risky shell approval gates with replayable audit.
- Approval lifecycle:
  - Approval queue API and replay trail.
  - Async layman explainer with status (`pending/completed/failed`).
  - Realtime approval events.
- Skills system:
  - `SKILL.md` + YAML frontmatter parser.
  - Deterministic source precedence and conflict handling.
  - Activation resolution (explicit, keyword, dependency-aware).
- Mission Control UI:
  - Dashboard, system vitals, files, memory, agents, office, activity, cron, sessions, skills, costs, settings, approvals, tasks, integrations, mesh, onboarding.
  - API-first operations and SSE-driven live updates.
  - Office WebGL scene (central operator + radial goat subagents).
- Integrations and providers:
  - OpenAI-compatible `/v1/chat/completions` support.
  - Multi-provider runtime config and model discovery endpoints.
  - Integration catalog and connection lifecycle APIs.
- Mesh foundation:
  - Node membership, leases, session ownership, replication logs/offsets.
  - Mesh status and control API surface.
- Onboarding:
  - Web onboarding wizard (`/api/v1/onboarding/*`).
  - TUI onboarding (`pnpm onboarding:tui` / `goatcitadel onboard`).
- Installation and CLI:
  - Cross-platform installers: `install.ps1`, `install.cmd`, `install.sh`.
  - `goatcitadel` CLI launcher with `install/update/up/gateway/ui/onboard/smoke/doctor`.
- Unified configuration:
  - Canonical `config/goatcitadel.json`.
  - Automatic startup sync to split config files.
  - Manual sync command: `pnpm config:sync`.
- Gateway dev hot reload supervisor:
  - Restart-on-change supervisor for gateway dev runtime.
  - Child process tree termination and port release checks.
  - Health-checked restart readiness.
- Testing and validation:
  - Repository typecheck/test/build scripts.
  - Smoke tests covering gateway, sessions, tools, approvals, integrations, mesh, onboarding.
- Documentation:
  - Public README with install/run/config guidance.
  - Engineering handbook for architecture and operational behavior.
  - Screenshot gallery moved to `docs/screenshots/mission-control`.

### Changed

- Public repo hygiene cleanup:
  - Removed internal `.claude` settings from tracked files.
  - Removed private review artifacts from tracked files.
  - Moved public screenshots from `artifacts/` to `docs/screenshots/`.

### Notes

- This beta is intended for active local/private testing and iterative hardening.
- API and config contracts may evolve before stable `1.0.0`.
