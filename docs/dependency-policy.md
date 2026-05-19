# Dependency and Platform Policy

This document defines the minimum dependency hygiene expected for GoatCitadel `1.x`.

## Locking Strategy

- Direct and transitive JavaScript dependencies are pinned through `pnpm-lock.yaml`.
- Release builds must use `pnpm install --frozen-lockfile`.
- Packaging and release scripts are part of the locked release surface and should be reviewed like product code.

## Update Cadence

- Security updates: as soon as practical after validation.
- Minor and patch dependency updates: grouped into regular maintenance PRs.
- Major upgrades: planned migrations with explicit verification notes and rollback expectations.

## Supported Toolchain

- Node `22.x` in CI
- pnpm `10.31.0`
- TypeScript as pinned in the workspace lockfile

## Experimental Compiler Pilots

- Preview compiler trials must run side-by-side with the workspace default compiler until the repo explicitly promotes them.
- Preview compiler pilots must not replace required release or verification lanes by default.
- The current TS7 beta pilot, including commands and benchmark artifacts, is documented in [docs/typescript-7-beta-pilot.md](./typescript-7-beta-pilot.md).

## Supported Runtime Surfaces

- Windows x64 and arm64 installers are the current CI-built release installer surfaces.
- macOS x64/arm64 and Linux x64 remain source/shared-host development surfaces until the release workflow emits native artifacts, signing/notarization evidence, and smoke proof for those targets.

## Release Constraints

- Tagged releases must generate a CycloneDX SBOM in CI.
- Tagged releases must generate checksums and keyless cosign signatures for each published installer.
- Tagged releases must assemble a single proof bundle containing artifacts, docs, and provenance metadata.

## Review Expectations

- Any dependency or packaging change that affects the release surface should include the validation lane it relied on.
- Changes to `package.json`, `pnpm-lock.yaml`, `.github/workflows/release-installers.yml`, `scripts/packaging/*`, or `scripts/release/*` should be treated as release-affecting.
