# Reproducible Release

This document defines the current GoatCitadel release recipe for installer and bundle builds plus the proof bundle that ships with signed public Windows releases and experimental cross-platform artifacts.

## Scope

This process covers the artifacts published by `.github/workflows/release-installers.yml`:

- `windows-x64`
- `windows-arm64`
- `macos-arm64` experimental DMG when Developer ID signing and notarization credentials are configured
- `linux-x64` experimental tarball

Windows signed installers are the current public-trust installer surface. macOS and Linux stay experimental until a release workflow run emits signed/notarized evidence where applicable, checksums, smoke evidence, and an explicit support-matrix promotion. Manual unsigned workflow-dispatch runs are development packaging smoke only: they may prove Windows x64/arm64 build and install/uninstall behavior, Linux archive smoke, or ad-hoc macOS DMG smoke, but they are workflow artifacts, are not automatically published as a GitHub release, and never count as public-trust signed release proof. They may be manually attached only as clearly labeled unsigned or experimental convenience assets.

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
- .NET 10 SDK for the WinUI 3 / Windows App SDK host
- Rust stable MSVC while the Tauri desktop rollback host remains in `verify:desktop`
- Inno Setup `6.x` for Windows packaging
- Authenticode certificate secrets for public `v*` Windows releases
- `WINDOWS_MSIX_PUBLISHER` repository variable matching the Windows signing certificate subject; it is embedded in both the WinUI executable manifest and the sparse MSIX identity manifest
- `zip` for the final proof bundle assembly
- `cosign` keyless signing in the release job

## CI Commands

The release workflow uses these commands:

```text
pnpm install --frozen-lockfile
pnpm package:windows-host --target <windows-target>
pnpm package:windows-msix --cert-path <pfx> --cert-password <password>
pnpm package:bundle --target <target>
pnpm package:windows --target <windows-target>
pnpm dlx @cyclonedx/cyclonedx-npm --output-format json --output-file <sbom-path>
node scripts/release/sign-release-artifacts.mjs --artifacts-dir <artifact-dir>
node scripts/release/assemble-release-package.mjs --version <version> --artifacts-dir <artifact-dir> --sbom-file <sbom-path>
node scripts/release/wait-for-release-proof.mjs --repository <owner/repo> --commit <commit-sha> --timeout-ms 14400000
node scripts/release/write-release-certificate.mjs --version <version> --tag <tag> --artifacts-dir <artifact-dir> --proof-zip <zip-path> --hostile-sandbox-proof <code-mode-hostile-sandbox-proof.json> --out-file <certificate-path> --require-success
```

## Environment Notes

- Installer and bundle builds run on GitHub-hosted Windows, macOS, and Linux runners.
- Public tag builds fail if Authenticode signing secrets are missing. Unsigned output is reserved for explicit manual/dev workflow runs, is not automatically published as a GitHub release, and may only be attached manually as clearly labeled unsigned convenience assets that do not count as public-trust signed release proof.
- Public tag builds fail if macOS notarization secrets are missing for the experimental macOS DMG lane. Manual `allow_unsigned=true` macOS output is ad-hoc signed, non-notarized, and friend-smoke only.
- The embedded Node archive is verified against a pinned `--node-sha256` value or the upstream Node `SHASUMS256.txt` entry before it is copied into the bundle.
- The final release package is assembled on Ubuntu after the per-platform artifacts are downloaded.
- GitHub Actions context values are copied into `provenance/build-metadata.json`, `provenance/slsa-attestation.json`, and the separate `release-certificate.json`.

## Verification

To validate a published release:

1. Download the release proof ZIP and the installer you care about.
2. Verify the installer checksum with the adjacent `.sha256` file.
3. Verify the installer signature with the adjacent `.sig` and `.pem` files.
4. Inspect `provenance/build-metadata.json` for the exact tag, commit, workflow run, and toolchain versions.
5. Inspect `SBOM/*.cyclonedx.json` for the dependency inventory used for the release.
6. Inspect `release-certificate.json` and require every required lane to be `success` with an empty `acceptedFailures` array before treating the signed public installer build as public-trust ready. Direct lane evidence and umbrella release-proof evidence are recorded separately; an exact-SHA direct lane failure is blocking even if the umbrella proof is green.

## Local Rebuild

Local rebuilds are expected to reproduce the same installer contents when run from the same commit with the same lockfile and packaging scripts. Platform-specific packaging metadata may still differ if the host toolchain differs from the GitHub Actions runners.

Use the proof bundle as the reference output for comparison rather than trusting unstamped local artifacts.
