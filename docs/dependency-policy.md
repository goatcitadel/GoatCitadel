# Dependency and Platform Policy

This document defines the minimum dependency hygiene expected for GoatCitadel `1.x`.

## Locking Strategy

- Direct and transitive JavaScript dependencies are pinned through `pnpm-lock.yaml`.
- Release builds must use `pnpm install --frozen-lockfile`.
- Direct `npm install` / `npm ci` is not a supported release or development install path for this monorepo. npm v12's `allowScripts` policy is not maintained as GoatCitadel release evidence; use the pinned pnpm toolchain below.
- Dependency install scripts are governed through the pnpm build approval policy in `pnpm-workspace.yaml`. New build-script allowances or denials require script review plus proportional validation.
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

- Windows x64 and arm64 installers are the current CI-built release installer surfaces. They become public-trust installer proof only when Authenticode signing and installer smoke pass.
- macOS arm64 has an experimental DMG lane: manual smoke remains ad-hoc signed and non-notarized, while public release builds require Developer ID signing, notarization, stapling, checksum, and DMG smoke before upload.
- Linux x64 has an experimental release tarball lane with checksum and archive smoke. It remains a browser-launcher bundle without a native desktop host.
- macOS and Linux stay experimental until a release workflow run emits the exact signed/notarized artifact where applicable plus checksum and smoke proof, and the support matrix is deliberately promoted.

## Release Constraints

- Tagged releases must generate a CycloneDX SBOM in CI.
- Tagged releases must generate checksums and keyless cosign signatures for each published installer.
- Tagged releases must assemble a single proof bundle containing artifacts, docs, and provenance metadata.

## Review Expectations

- Any dependency or packaging change that affects the release surface should include the validation lane it relied on.
- Changes to `package.json`, `pnpm-lock.yaml`, `.github/workflows/release-installers.yml`, `scripts/packaging/*`, or `scripts/release/*` should be treated as release-affecting.
