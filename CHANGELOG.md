# Changelog

All notable changes to GoatCitadel are documented in this file.

The format is inspired by Keep a Changelog and uses semantic pre-release tags.

## [Unreleased]

### Added

- Dream memory-maintenance runtime:
  - workspace policy, status, runs, provenance, and recommendation APIs
  - durable-run backed `memory.maintenance` workflow execution
  - `/dream` and `/dream status` command support in chat sessions
  - SQLite-backed maintenance policy/state/run/change/recommendation persistence
  - Mission Control memory controls for policy editing, run-now, recommendation review, and provenance inspection
- Signed inbound channel runtime for new bridges:
  - WhatsApp Cloud API webhook challenge handling and signed ingress
  - LINE Messaging API signed webhook ingress
  - inbound payload normalization and idempotency-key derivation for both bridges
- Guided setup and runtime truth improvements for channels:
  - Mission Control guided definitions now cover WhatsApp, LINE, Mattermost, Signal, iMessage/BlueBubbles, Nextcloud Talk, Zalo OA, and Zalo Personal
  - integration catalog now separates parity maturity from runtime availability
  - channel-core capability reporting now advertises webhook readiness when the required secret pairs are configured
- OpenClaw parity closeout reporting:
  - new `/api/v1/system/openclaw-parity` report
  - shared `openclaw-parity` contracts and alignment tests
  - blocker classification across repo-runtime, manual/operator, external-repo, and publication work
- Follow-on proof artifact status tracking:
  - browser, packaging, A2UI, voice, companion, and extension lanes now report missing/stale/current artifact state
  - profile-aware freshness and deployment-profile mismatch reporting for profile-bound proof lanes
  - System page coverage for the stronger parity/export flows
- Extension authoring/release workflow:
  - repo-level `release:extensions-sdk:dry-run` and `release:extensions-sdk`
  - package-level prepublish gate and publish wrappers
  - prerelease tag derivation for GitHub Packages publishing
  - starter-pack export path for repo-native extension handoff bundles
- Agent/runtime architecture support:
  - exported orchestration turn-runtime contract
  - gateway turn-runtime adapter wrapping the chat orchestrator
- Bundled skill/documentation work:
  - `agentic-skill-architect` bundled skill
  - agentic-skill implementation roadmap and adoption memo
  - runtime integration checklist docs

### Changed

- Mission Control shell and surface runtime were tightened:
  - browser and shell transport behavior now share one authoritative transport core instead of drifting across duplicate request paths
  - `ChatPage` and several large operator surfaces were decomposed into smaller page, hook, and panel units without changing the live surface model
  - chat dock and approval/session orchestration now use narrower typed contracts instead of broad mixed state props
- Gateway runtime extraction work moved from file-shape cleanup toward clearer ownership:
  - webhook ingress now uses a shared handler factory instead of provider-specific route duplication
  - channel setup, integration diagnostics, and Discord runtime bridging now run behind narrower extracted service seams
  - route and service behavior are protected by contract-oriented tests rather than forwarding-only delegation seams
- Built-in planned channel bridges no longer auto-promote to `beta` just because a partial runtime seam exists; they stay `planned` while still surfacing whether the current runtime can exercise them manually.
- Mission Control client coverage now includes memory-maintenance read/mutate flows and OpenClaw parity fetches.
- Gateway chat memory-context resolution now uses workspace-relative memory roots more consistently when session/workspace metadata is present.
- Follow-on parity reporting is now more explicit about proof freshness, active deployment posture, and when a lane still depends on manual operator evidence.
- README was rebuilt to reflect the current product shape, shipped features, parity posture, verification commands, and operator-facing capabilities instead of the older high-level summary.

### Fixed

- Mission Control lazy-loaded pages now preserve their real prop contracts instead of falling back to an untyped lazy wrapper.
- Dev diagnostics route/session/source sanitization is stricter, so invalid client-side values do not get recorded as if they were trustworthy runtime state.
- Targeted lint and type debt in Mission Control operator pages no longer rely on ignored hook dependency gaps or `any`-based chat dock contracts.
- Extension starter-pack export no longer resolves source files from outside the repo root; the export route now succeeds instead of failing with `400`.
- Signed webhook routes for WhatsApp and LINE no longer get blocked by the generic auth/idempotency middleware before their own verification logic can run.
- Extension SDK dry-run publication no longer packages compiled test output; the tarball now contains only the intended runtime build artifacts and package metadata.
- Follow-on/export tests now match the live extension starter-pack export path after the repo-root fix.

### Verification

- `pnpm --filter @goatcitadel/gateway exec tsc -p tsconfig.json --noEmit`
- `pnpm --filter @goatcitadel/gateway exec vitest run src/routes/chat.routes.test.ts src/routes/chat.messages.test.ts src/routes/integrations.test.ts src/routes/approvals.test.ts src/services/channel-setup-service.contract.test.ts src/services/integration-diagnostics-service.contract.test.ts src/services/discord-runtime-bridge-service.contract.test.ts src/routes/webhook-handler-factory.test.ts`
- `pnpm --filter @goatcitadel/mission-control typecheck`
- `pnpm --filter @goatcitadel/mission-control exec vitest run src/pages/ChatPage.test.ts src/pages/chat/chat-page-helpers.test.ts src/pages/chat/useChatSurfaceOrchestration.test.tsx src/pages/chat/useChatOutboundExecution.test.tsx src/pages/chat/useChatSessionControls.test.tsx src/pages/chat/useChatComposerInteractions.test.tsx src/pages/chat/ChatContextDockPanels.test.tsx src/interaction-coverage.test.tsx src/module-load-smoke.test.ts`
- `pnpm exec eslint apps/gateway/src/routes apps/gateway/src/services apps/mission-control/src/api apps/mission-control/src/pages apps/mission-control/src/state`
- `pnpm vitest run apps/gateway/src/routes/integrations.test.ts apps/gateway/src/services/whatsapp-webhook.test.ts apps/gateway/src/services/line-webhook.test.ts apps/gateway/src/services/channel-setup-definitions.test.ts apps/gateway/src/services/integration-catalog.test.ts packages/gateway-core/src/channel-core.test.ts`
- `pnpm vitest run apps/gateway/src/routes/memory.test.ts apps/gateway/src/services/memory-maintenance-service.test.ts apps/gateway/src/services/gateway-service.dream-command.test.ts apps/mission-control/src/pages/MemoryPage.test.tsx`
- `pnpm vitest run apps/gateway/src/routes/dashboard.follow-on-parity.test.ts apps/gateway/src/services/follow-on-parity-report.test.ts apps/gateway/src/services/openclaw-parity-report.test.ts packages/contracts/src/openclaw-parity.alignment.test.ts apps/mission-control/src/pages/SystemPage.test.tsx apps/mission-control/src/pages/IntegrationsPage.load.test.tsx apps/mission-control/src/api/client.test.ts`
- `pnpm vitest run packages/skills/src/bundled-skill.test.ts`
- `pnpm release:extensions-sdk:dry-run`

### Notes

- This line remains pre-1.0 and continues to prioritize truthful runtime/proof reporting over broad marketing claims.
- Mobile/companion proof is still partly external-repo work and should be treated that way in parity planning.

## [0.6.0-beta.2] - 2026-03-29

### Added

- Mission Control command-deck shell:
  - top-level `Operate`, `Observe`, and `Configure` spaces
  - routed `Chat`, `Cowork`, and `Code` surface modes
  - dedicated approvals, costs, quality, integrations, and agent hub views
- Native-first provider runtime controls:
  - provider API-style selection in settings
  - active model switching and provider smoke-test flows
  - LLM pricing estimation helpers for supported providers and routed models
- Historical LLM spend repair tooling:
  - `apps/gateway/src/services/llm-pricing.ts` for runtime cost estimation
  - `scripts/backfill-llm-costs.ts` for repairing missing assistant message and ledger costs
- Expanded integrations UX:
  - integration overview and channels views
  - connector diagnostics
  - channel send/react/unsend test flows with attachment support
  - MCP management in the same surface
- Workspace and governance foundations:
  - `workspaces` table and repository with `create/list/update/archive/restore`
  - workspace-scoped guidance APIs and resolution rules
  - governance docs and workspace override templates
- Zero-trust tool/runtime hardening:
  - tool security enforcement and ingestion contracts in the policy engine
  - hot-path storage indexes for approvals, tool invocations, and policy blocks
- Docs and release assets:
  - public-share review docs
  - screenshot capture pipeline
  - refreshed top-level README and screenshot coverage

### Changed

- Gateway startup sequencing is now split between critical init and deferred background init so the process can listen sooner while cron/bootstrap work finishes asynchronously.
- Mission Control reconnect cadence was tightened so the UI returns faster after a gateway restart.
- Approval, costs, integrations, and settings pages were reworked as clearer hub surfaces with stronger tests and more intentional page-level copy.
- Prompt-pack evaluation and provider routing were hardened across recent mainline work, including better model usage surfacing and safer recovery behavior.

### Fixed

- Legacy SQLite migration fixtures no longer fail when replaying `createChatSessionHistoryVisibilitySchema` against databases that predate `chat_session_meta`.
- Cron bootstrap now avoids rewriting unchanged cron jobs on startup and can restore configured jobs inside one immediate transaction.

## [0.1.0-beta.1] - 2026-02-28

Initial beta baseline for private testing.

### Added

- Core platform architecture:
  - TypeScript monorepo with `apps/gateway`, `apps/mission-control`, and shared `packages/*`
  - local-first runtime with no Docker dependency
- Gateway control plane:
  - deterministic session routing and canonical session ownership
  - append-only JSONL transcripts and audit streams
  - gateway-owned token and cost accounting
  - idempotent mutation flow with indexed dedupe tracking
- Tool policy and sandboxing:
  - deny-wins policy resolver (`profile + allow + deny + per-agent overrides`)
  - path jail and read scope enforcement
  - network allowlist gate
  - risky shell approval gates with replayable audit
- Approval lifecycle:
  - approval queue API and replay trail
  - async layman explainer with status (`pending/completed/failed`)
  - realtime approval events
- Skills system:
  - `SKILL.md` + YAML frontmatter parser
  - deterministic source precedence and conflict handling
  - activation resolution (explicit, keyword, dependency-aware)
- Mission Control UI:
  - dashboard, system vitals, files, memory, agents, office, activity, cron, sessions, skills, costs, settings, approvals, tasks, integrations, mesh, onboarding
  - API-first operations and SSE-driven live updates
  - Office WebGL scene (central operator + radial goat subagents)
- Integrations and providers:
  - OpenAI-compatible `/v1/chat/completions` support
  - multi-provider runtime config and model discovery endpoints
  - integration catalog and connection lifecycle APIs
- Mesh foundation:
  - node membership, leases, session ownership, replication logs/offsets
  - mesh status and control API surface
- Onboarding:
  - web onboarding wizard (`/api/v1/onboarding/*`)
  - TUI onboarding (`pnpm onboarding:tui` / `goatcitadel onboard`)
- Installation and CLI:
  - cross-platform installers: `install.ps1`, `install.cmd`, `install.sh`
  - `goatcitadel` CLI launcher with `install/update/up/gateway/ui/onboard/smoke/doctor`
- Unified configuration:
  - canonical `config/goatcitadel.json`
  - automatic startup sync to split config files
  - manual sync command: `pnpm config:sync`
- Gateway dev hot reload supervisor:
  - restart-on-change supervisor for gateway dev runtime
  - child process tree termination and port release checks
  - health-checked restart readiness
- Testing and validation:
  - repository typecheck/test/build scripts
  - smoke tests covering gateway, sessions, tools, approvals, integrations, mesh, onboarding
- Documentation:
  - public README with install/run/config guidance
  - engineering handbook for architecture and operational behavior
  - screenshot gallery moved to `docs/screenshots/mission-control`

### Changed

- Public repo hygiene cleanup:
  - removed internal `.claude` settings from tracked files
  - removed private review artifacts from tracked files
  - moved public screenshots from `artifacts/` to `docs/screenshots/`

### Notes

- This beta is intended for active local/private testing and iterative hardening.
- API and config contracts may evolve before stable `1.0.0`.
