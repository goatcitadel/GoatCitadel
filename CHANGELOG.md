# Changelog

All notable changes to GoatCitadel are documented in this file.

The project uses semantic pre-release versions while the public surface is still settling.

## [Unreleased]

### Changed

- Continued public repo cleanup, documentation tightening, and release prep.

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
