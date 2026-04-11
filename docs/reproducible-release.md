# Reproducible Release

This document defines the current GoatCitadel release recipe for installer builds and the proof bundle that ships with each tagged release.

## Scope

This process covers the signed installer artifacts published by `.github/workflows/release-installers.yml`:

- `windows-x64`
- `windows-arm64`
- `darwin-x64`
- `darwin-arm64`
- `linux-x64`

## Locked Inputs

The release lane treats these files as the minimum rebuild inputs:

- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `Dockerfile`
- `.github/workflows/release-installers.yml`
- `scripts/packaging/*`
- `scripts/release/*`

## Toolchain

- Node `22.x` in GitHub Actions
- pnpm `10.31.0`
- Inno Setup `6.x` for Windows packaging
- `pkgbuild` on the GitHub-hosted macOS runner
- GNU `tar` on the GitHub-hosted Linux runner
- `zip` for the final proof bundle assembly
- `cosign` keyless signing in the release job

## CI Commands

The release workflow uses these commands:

```text
pnpm install --frozen-lockfile
pnpm package:bundle --target <target>
pnpm package:windows --target <windows-target>
pnpm package:macos --target <darwin-target>
pnpm package:linux --target linux-x64
pnpm dlx @cyclonedx/cyclonedx-npm --output-format json --output-file <sbom-path>
node scripts/release/sign-release-artifacts.mjs --artifacts-dir <artifact-dir>
node scripts/release/assemble-release-package.mjs --version <version> --artifacts-dir <artifact-dir> --sbom-file <sbom-path>
```

## Environment Notes

- Installer builds run on GitHub-hosted Windows, macOS, and Ubuntu runners.
- The final release package is assembled on Ubuntu after the per-platform artifacts are downloaded.
- GitHub Actions context values are copied into `provenance/build-metadata.json` and `provenance/slsa-attestation.json`.

## Verification

To validate a published release:

1. Download the release proof ZIP and the installer you care about.
2. Verify the installer checksum with the adjacent `.sha256` file.
3. Verify the installer signature with the adjacent `.sig` and `.pem` files.
4. Inspect `provenance/build-metadata.json` for the exact tag, commit, workflow run, and toolchain versions.
5. Inspect `SBOM/*.cyclonedx.json` for the dependency inventory used for the release.

## Local Rebuild

Local rebuilds are expected to reproduce the same installer contents when run from the same commit with the same lockfile and packaging scripts. Platform-specific packaging metadata may still differ if the host toolchain differs from the GitHub Actions runners.

Use the proof bundle as the reference output for comparison rather than trusting unstamped local artifacts.
