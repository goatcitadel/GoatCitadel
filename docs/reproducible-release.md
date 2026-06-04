# Reproducible Release

This document defines the current GoatCitadel release recipe for installer builds and the proof bundle that ships with each signed public Windows release.

## Scope

This process covers the signed installer artifacts published by `.github/workflows/release-installers.yml`:

- `windows-x64`
- `windows-arm64`

macOS and Linux package scripts are not current release proof. They stay development-only until the release workflow emits signed artifacts and smoke evidence for those targets. Manual unsigned Windows workflow-dispatch runs are also development packaging smoke only: they may prove x64/arm64 build and install/uninstall behavior, but they are workflow artifacts, are not automatically published as a GitHub release, and never count as public-trust signed release proof. They may be manually attached only as clearly labeled unsigned convenience assets.

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
- Rust stable MSVC for the Tauri desktop host
- Inno Setup `6.x` for Windows packaging
- Authenticode certificate secrets for public `v*` Windows releases
- `zip` for the final proof bundle assembly
- `cosign` keyless signing in the release job

## CI Commands

The release workflow uses these commands:

```text
pnpm install --frozen-lockfile
pnpm package:desktop --target <target>
pnpm package:bundle --target <target>
pnpm package:windows --target <windows-target>
pnpm dlx @cyclonedx/cyclonedx-npm --output-format json --output-file <sbom-path>
node scripts/release/sign-release-artifacts.mjs --artifacts-dir <artifact-dir>
node scripts/release/assemble-release-package.mjs --version <version> --artifacts-dir <artifact-dir> --sbom-file <sbom-path>
node scripts/release/wait-for-release-proof.mjs --repository <owner/repo> --commit <commit-sha> --timeout-ms 14400000
node scripts/release/write-release-certificate.mjs --version <version> --tag <tag> --artifacts-dir <artifact-dir> --proof-zip <zip-path> --hostile-sandbox-proof <code-mode-hostile-sandbox-proof.json> --out-file <certificate-path> --require-success
```

## Environment Notes

- Installer builds run on GitHub-hosted Windows runners.
- Public tag builds fail if Authenticode signing secrets are missing. Unsigned output is reserved for explicit manual/dev workflow runs, is not automatically published as a GitHub release, and may only be attached manually as clearly labeled unsigned convenience assets that do not count as public-trust signed release proof.
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
