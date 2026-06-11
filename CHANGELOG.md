# Changelog

All notable changes to GoatCitadel are documented in this file.

## [Unreleased]

### Added

- Release proof bundle tooling for tagged releases:
  - signed installer checksums and cosign certificate sidecars
  - CycloneDX SBOM generation in CI
  - assembled release ZIP with artifacts, docs, and provenance metadata
  - commit-bound `release-certificate.json` covering required lane status, artifact digests, proof ZIP digest, Trivy status, and accepted failures
- Release-facing docs for reproducible builds, supported platforms, smoke tests, and dependency policy.
- `CODEOWNERS` coverage for release-bearing paths.
- Guided `llama.cpp` setup and integration flow:
  - Mission Control setup and diagnostics for local `llama.cpp` runtime validation
  - provider/config templates that treat `llama.cpp` as a first-class local runtime option
  - operator rollout notes in `docs/LLAMA_CPP_INTEGRATION_MEMO.md`

### Changed

- `SECURITY.md` now reflects the shipped `1.x` support posture instead of the pre-1.0 beta line.
- Release workflow is expanded from raw installer publishing to a signed Windows proof-package handoff with commit-bound release certification, plus a manual unsigned packaging-smoke path used for the `v1.0.0` convenience installers.
- Packaging docs now explicitly label macOS/Linux release artifacts as development-only until those workflow matrices produce signed proof.
- Approval control routes are now explicitly operator-fenced, while remote approval token resolution remains on its separate capability-token path.
- Mission Control Channel Setup now shows only shipped guided channels instead of mixing visible built-ins with manual/later-state copy.
- Remote approval delivery now keeps connector delivery auth boundaries explicit instead of implying that approval-control fencing covers the delivery path.
- Windows x64 and arm64 installer proof was refreshed after the `1.0.0` cut; unsigned artifacts may be attached to `v1.0.0` as clearly labeled convenience installers until public Authenticode signing is configured.
- README and Mission Control screenshot gallery were refreshed to match the current main-branch UI and docs posture.

### Fixed

- Postgres upgrade safety for chat sessions: the operator-control prefs repair now appends as a protected migration instead of mutating historical migration numbering, and migration immutability checks lock applied migration names and SQL hashes.
- Chat session creation is now transaction-wrapped so prefs, metadata, bindings, and workspace checks cannot leave half-created sessions when a later write fails.
- Gateway health now surfaces Postgres migration-name drift and required chat prefs columns instead of reporting a clean max migration version for a broken schema.
- Durable chat cancellation now records a `run_cancelled` checkpoint and trace metadata instead of mixing cancelled runs with failed-run trace truth.
- Mission Control Next runtime status now carries per-source backend errors so daemon, backup, and metric panels can render unavailable state instead of false stopped/zero facts.
- Memory admin defaults to the shipped operator lifecycle path, and Discord interaction/autocomplete response failures now emit diagnostics instead of being silently swallowed.
- Release verification now builds `@goatcitadel/extensions-sdk` before fast test/smoke steps so clean generated-output lanes do not depend on prior local build artifacts.
- MCP 1.0 authoring now keeps the visible runtime-invokable surface to local `stdio` plus the internal Approval Inbox template, with generic remote transports gated behind an explicit experimental flag.
- Mission Control shared now pins `shell-quote` to `1.8.4` so the lockfile cannot resolve the vulnerable `<=1.8.3` range affected by CVE-2026-9277, where `quote()` failed to escape newlines in object `.op` values. The current command explainer imports only `parse()`, so the bump is precautionary for this package while preserving the fixed `quote()` behavior if the dependency surface expands later.

### Verification

- Approval auth-boundary proof now covers approval list, replay, resolve, bulk-resolve, and remote-token control routes.
- Channel Setup proof now asserts a guided-only visible surface with no manual/later/parity-deficit copy.

## [1.0.0] - 2026-04-11

### Added

- First-party container deployment support:
  - multi-stage Linux `Dockerfile` for a non-root GoatCitadel runtime
  - Postgres-first `docker-compose.yaml` example with healthchecks, named volumes, and safer shared-host defaults
  - Docker install and hardening guidance in the README and install docs
- Native capability system foundations:
  - shared capability contracts for tools, skills, candidate bundles, proposals, catalog snapshots, and Code Mode runs
  - SQLite-backed persistence for capability snapshots, skill lifecycle metadata, candidate versions, proposal records/events, and Code Mode run records
  - gateway capability catalog APIs for inspectable vs callable views, immutable snapshot lookup, proposal listing/creation, and Code Mode run inspection/creation
- Governed Code Mode v1:
  - feature-flagged trusted-code execution path with explicit operator approval before every run
  - child-process execution harness with bounded IPC JSON-RPC, isolated single-file TypeScript transpilation, bounded stdout/stderr capture, and persisted code/wrapper/policy artifacts
  - curated read-only deterministic wrapper allowlist for Code Mode instead of projecting the full tool surface
- Capability lifecycle and generated-skill groundwork:
  - idempotent backfill of existing skills into lifecycle/trust/category metadata
  - runtime-managed candidate skill bundles under `data/capability-candidates/`
  - structured candidate proof artifacts including originating run, wrapper manifest version, sample input/output, and smoke-case evidence
- Mission Control capability UX:
  - Skills Hub review queue for active skills, candidates, and governed proposals
  - composer-adjacent approval footer with queue semantics, richer Code Mode approval payloads, and server-truth refresh handling

### Changed

- Fresh config defaults now prefer Postgres while keeping SQLite available as an explicit fallback.
- Continued public repo cleanup, documentation tightening, and release prep.
- Chat approvals no longer rely on the old status-lane flow or “send again to continue” behavior; blocking approvals now resume through the runtime-backed footer queue.
- Capability planning/runtime plumbing now enforces a hard split between inspectable metadata and callable capabilities so unactivated proposals and candidates stay visible without becoming executable.
- README now documents the capability system, governed Code Mode v1, the sharper Skills Hub / inline approval behavior, and the new Docker deployment path.

### Fixed

- Code Mode child harness now exits cleanly after each approved run and keeps guest code from seeing ambient Node globals such as `process` and `require`.
- Code Mode wrapper manifests now derive from the frozen callable snapshot for the run instead of the live registry, keeping auditability and execution surfaces aligned.
- Candidate-skill staging failures no longer incorrectly downgrade an otherwise completed Code Mode run.

### Verification

- `pnpm --filter @goatcitadel/contracts typecheck`
- `pnpm --filter @goatcitadel/storage typecheck`
- `pnpm --filter @goatcitadel/policy-engine typecheck`
- `pnpm --filter @goatcitadel/gateway typecheck`
- `pnpm --filter @goatcitadel/mission-control typecheck`
- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/code-mode-child-source.test.ts src/routes/capabilities.test.ts src/services/gateway/auth-credential-planner.test.ts src/config.test.ts`
- `pnpm --filter @goatcitadel/mission-control exec vitest run src/pages/chat/useChatOutboundExecution.test.tsx src/pages/SkillsPage.refresh.test.tsx`

## [0.9.0-beta.1] - 2026-04-09

### Changed

- Reframed the public repository around the current product instead of internal operating material.
- Rewrote the top-level README, install guidance, and contribution guidance for external users and contributors.
- Tightened governance checks so public-required docs match the slimmer repository posture.
- Advanced the workspace release line from `0.6.0-beta.2` to `0.9.0-beta.1`.

### Removed

- Tracked local runtime state, generated artifacts, prompt-pack working files, and workspace-local notes that did not belong in a public repository.
- Internal research, audit, parity, and checklist documents that were useful for private operating workflows but noisy in the public repo.
- Tracked TypeScript build-info files and other generated leftovers that should stay uncommitted.

### Fixed

- Repo ignore rules now keep generated artifacts, runtime JSON state, and build metadata from being reintroduced accidentally.
- Public package/version references now consistently point at `0.9.0-beta.1`, including the extensions SDK release guidance.

## [0.6.0-beta.2] - 2026-03-29

### Added

- Mission Control command-center shell with `Operate`, `Observe`, and `Configure` spaces.
- Stronger runtime flows for approvals, memory maintenance, integrations, and follow-on parity reporting.
- Extension SDK publication workflow and reference authoring scaffolds.
- Signed inbound channel groundwork for WhatsApp and LINE.

### Changed

- Mission Control transport and page orchestration were decomposed into narrower, more testable units.
- Gateway ingress and runtime services were split into clearer contracts and better-covered seams.
- Documentation and screenshots were refreshed to match the newer Mission Control shell.

### Fixed

- Several gateway and Mission Control route, contract, and validation edge cases in the post-refactor stabilization pass.

## [0.1.0-beta.1] - 2026-02-28

Initial public beta baseline.

### Added

- Monorepo foundation with `apps/gateway`, `apps/mission-control`, and shared `packages/*`.
- Local-first gateway runtime with policy enforcement, approvals, skills, memory, and integrations.
- Mission Control UI, installation scripts, onboarding flows, and baseline documentation.
