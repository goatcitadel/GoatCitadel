# Reproducible Release

This document defines the current GoatCitadel release recipe for installer and bundle builds plus the proof bundle that ships with signed public Windows releases and experimental cross-platform artifacts.

## Scope

This process covers the artifacts published by `.github/workflows/release-installers.yml`:

- `windows-x64`
- `windows-arm64`
- `macos-arm64` experimental DMG when Developer ID signing and notarization credentials are configured
- `linux-x64` experimental tarball

Windows signed installers are the current public-trust installer surface. macOS and Linux stay experimental until a release workflow run emits signed/notarized evidence where applicable, checksums, smoke evidence, and an explicit support-matrix promotion. Manual unsigned workflow-dispatch runs are development packaging smoke only: they may prove Windows x64/arm64 build and install/uninstall behavior, Linux archive smoke, or ad-hoc macOS DMG smoke, but they are workflow artifacts, are not automatically published as a GitHub release, and never count as public-trust signed release proof. They may be manually attached only as clearly labeled unsigned or experimental convenience assets.

## External Release Trust Gate

The signed public release gate is closed until repository administrators establish all of the controls below. The workflow's local event checks, live peeled-tag check, protected-environment hook, concurrency, and no-overwrite publication setting are defense in depth; repository code cannot establish or prove the GitHub control-plane settings that make an arbitrary same-repository tag untrusted.

- Protect `v*` tags with a ruleset that restricts tag create, update, and delete operations to the designated release principals.
- Create and protect the `release` environment, restrict it to selected `v*` tags, require independent reviewers, prevent self-review, migrate the Authenticode and Apple credentials out of repository secrets and into that environment, and only then set the environment variable `GOATCITADEL_RELEASE_TRUST_READY=true`.
- Enable immutable GitHub Releases so an older or rerun workflow cannot replace already-published release assets.
- Require each release commit to be reachable from protected `main`, and let only the trusted release controller create a release tag after that reachability check and the required exact-SHA proof lanes pass.

Until every control is configured and independently verified in GitHub, do not set the readiness variable, do not treat a `v*` run as public-trust release proof, and do not publish signed release assets. Manual `workflow_dispatch` is deliberately unsigned-smoke-only and has no path to PFX, Apple, OIDC-signing, or GitHub Release publication jobs.

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

- Node `22.x` in GitHub Actions, pinned to `22.23.1` for the release producer
- pnpm `10.31.0`
- .NET SDK `10.0.300` for the WinUI 3 / Windows App SDK host
- Rust `1.94.0` while the Tauri desktop rollback host remains in `verify:desktop`
- Inno Setup `6.7.3` from the immutable upstream GitHub release, admitted only after SHA-256 `9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732` matches
- `@cyclonedx/cdxgen` `12.7.1` from the root frozen lockfile, invoked through its immutable local bin path with `NODE_PATH` removed
- Authenticode certificate secrets for public `v*` Windows releases
- `WINDOWS_MSIX_PUBLISHER` repository variable matching the Windows signing certificate subject; it is embedded in both the WinUI executable manifest and the sparse MSIX identity manifest
- `zip` for the final proof bundle assembly
- `cosign` keyless signing in the release job

## Material CI Command Templates

The workflow file remains the executable authority. The templates below cover the material build, signing, proof, and finalization commands recorded in release provenance; they are not a transcript of every staging assertion or cleanup command.

```text
pnpm install --frozen-lockfile
pnpm package:windows-host --target <windows-target>
pnpm package:windows-msix --allow-unsigned
signtool sign /fd SHA256 /f <pfx> /p <password> /tr http://timestamp.digicert.com /td SHA256 component-input/GoatCitadel-Mission-Control-Windows.exe
signtool verify /pa component-input/GoatCitadel-Mission-Control-Windows.exe
signtool sign /fd SHA256 /f <pfx> /p <password> /tr http://timestamp.digicert.com /td SHA256 component-input/GoatCitadel-Mission-Control-Windows-Identity.msix
signtool verify /pa component-input/GoatCitadel-Mission-Control-Windows-Identity.msix
pnpm package:bundle --target <windows-target>
pnpm package:windows --target <windows-target>
signtool sign /fd SHA256 /f <pfx> /p <password> /tr http://timestamp.digicert.com /td SHA256 installer-input/GoatCitadel-Setup-<windows-target>.exe
signtool verify /pa installer-input/GoatCitadel-Setup-<windows-target>.exe
pnpm package:bundle --target linux-x64 --skip-desktop
tar -czf "<linux-tar>" -C "<bundle-parent>" "<bundle-directory>"
sha256sum "<linux-tar>" > "<linux-tar>.sha256"
tar -xzf "<linux-tar>" -C "<smoke-dir>"
sha256sum -c "<linux-tar>.sha256"
pnpm package:macos --target macos-arm64
codesign --force --deep --options runtime --timestamp --sign <developer-id> "$WORK/dmg-root/GoatCitadel Mission Control.app"
codesign --verify --deep --strict --verbose=2 "$WORK/dmg-root/GoatCitadel Mission Control.app"
hdiutil create -volname "GoatCitadel Mission Control" -srcfolder "$WORK/dmg-root" -ov -format UDZO "$OUTPUT_DMG"
xcrun notarytool submit "$OUTPUT_DMG" --apple-id <apple-id> --team-id <team-id> --password <app-password> --wait
xcrun stapler staple "$OUTPUT_DMG"
xcrun stapler validate "$OUTPUT_DMG"
hdiutil verify "$OUTPUT_DMG"
shasum -a 256 "$OUTPUT_DMG" > "$OUTPUT_DMG.sha256"
FETCH_LICENSE=false CDXGEN_FETCH_PKG_METADATA=false env -u NODE_PATH node node_modules/@cyclonedx/cdxgen/bin/cdxgen.js . --type js --spec-version 1.6 --no-install-deps --fail-on-error --no-babel --no-recurse --validate --output <sbom-path>
env -u NODE_PATH node scripts/release/validate-pnpm-sbom.mjs --repo-root <repo-root> --sbom-file <sbom-path>
cosign sign-blob --yes --output-signature <fixed-release-asset>.sig --output-certificate <fixed-release-asset>.pem <fixed-release-asset>
cosign verify-blob --signature <fixed-release-asset>.sig --certificate <fixed-release-asset>.pem --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity <workflow-ref> --certificate-github-workflow-name "Release Installers and Bundles" --certificate-github-workflow-ref <tag-ref> --certificate-github-workflow-repository goatcitadel/GoatCitadel --certificate-github-workflow-sha <commit-sha> --certificate-github-workflow-trigger push <fixed-release-asset>
node scripts/release/assemble-release-package.mjs --version <version> --tag <tag> --artifacts-dir <artifact-dir> --sbom-file <sbom-path>
node scripts/release/wait-for-release-proof.mjs --repository <owner/repo> --commit <commit-sha> --timeout-ms 14400000
node scripts/release/wait-for-release-proof.mjs --repository <owner/repo> --commit <commit-sha> --workflow verification-fast.yml --timeout-ms 7200000
node scripts/release/wait-for-release-proof.mjs --repository <owner/repo> --commit <commit-sha> --workflow security-trivy.yml --timeout-ms 7200000
node scripts/release/write-release-certificate.mjs --version <version> --tag <tag> --artifacts-dir <artifact-dir> --runtime-manifest windows-x64=<artifact-dir>/windows-x64-release-assets/app/release-manifest.json --runtime-manifest windows-arm64=<artifact-dir>/windows-arm64-release-assets/app/release-manifest.json --proof-zip <zip-path> --out-file <certificate-path> --require-success
cosign sign-blob --yes --bundle artifacts/release/release-certificate.sigstore.json artifacts/release/release-certificate.json
cosign verify-blob --bundle artifacts/release/release-certificate.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity <workflow-ref> --certificate-github-workflow-name "Release Installers and Bundles" --certificate-github-workflow-ref <tag-ref> --certificate-github-workflow-repository goatcitadel/GoatCitadel --certificate-github-workflow-sha <commit-sha> --certificate-github-workflow-trigger push artifacts/release/release-certificate.json
node scripts/release/assemble-runtime-release-evidence.mjs --certificate artifacts/release/release-certificate.json --attestation artifacts/release/release-certificate.sigstore.json --artifacts-dir release-artifacts --proof-zip <release-proof-zip> --output-dir artifacts/release/runtime-evidence --archive-dir artifacts/release/package --installer windows-x64=release-artifacts/windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe --installer windows-arm64=release-artifacts/windows-arm64-release-assets/GoatCitadel-Setup-windows-arm64.exe
```

## Environment Notes

- Installer and bundle builds run on GitHub-hosted Windows, macOS, and Linux runners.
- Public tag builds fail before credential use unless the `release` environment exposes `GOATCITADEL_RELEASE_TRUST_READY=true`; that marker must remain unset until every external gate above is configured and the signing/notarization credentials have been migrated into the environment. Unsigned output is reserved for explicit manual/dev workflow runs, is not automatically published as a GitHub release, and may only be attached manually as clearly labeled unsigned convenience assets that do not count as public-trust signed release proof.
- Public tag builds fail if macOS notarization secrets are missing from the protected `release` environment for the experimental macOS DMG lane. Manual `allow_unsigned=true` macOS output is ad-hoc signed, non-notarized, and friend-smoke only.
- The embedded Node archive is verified against a pinned `--node-sha256` value or the upstream Node `SHASUMS256.txt` entry before it is copied into the bundle.
- The final release package is assembled on Ubuntu after the per-platform artifacts are downloaded.
- The SBOM generator sets `FETCH_LICENSE=false` and `CDXGEN_FETCH_PKG_METADATA=false` and uses `--no-recurse` intentionally: cdxgen reads the root pnpm v9 lockfile, which resolves every workspace importer, without traversing the source tree or fetching mutable registry metadata. The fail-closed validator requires exact identity parity between every canonical `packages` entry and the CycloneDX components, every lock importer and the root/workspace metadata, and every expected component/importer reference and dependency record. It also requires the exact edge set emitted by pinned cdxgen `12.7.1`: root-to-workspace edges, non-alias root runtime edges, non-alias workspace runtime/dev/peer edges, and the canonical union of required `snapshots[*].dependencies` across peer-expanded variants. Optional and platform-specific lock packages are never excluded from the component/ref inventory, but cdxgen does not emit `optionalDependencies` edges. Direct importer aliases to a differently named package identity also remain in the inventory but have no direct importer edge; snapshot aliases are resolved and required. Those two omissions are counted in validation output rather than presented as complete optional/alias graph coverage.
- GitHub Actions context values are copied into `provenance/build-metadata.json`, `provenance/slsa-attestation.json`, and the separate `release-certificate.json`.

## Verification

To validate a published release:

1. Download the release proof ZIP, `release-certificate.json`, `release-certificate.sigstore.json`, and the installer plus its checksum/signature sidecars.
2. Authenticate `release-certificate.json` with the certificate `cosign verify-blob --bundle` template above. Set `<workflow-ref>` to the full fixed identity `https://github.com/goatcitadel/GoatCitadel/.github/workflows/release-installers.yml@refs/tags/<tag>`, set `<tag-ref>` to `refs/tags/<tag>`, and set `<commit-sha>` to the exact published commit SHA; require the fixed workflow name, repository, exact tag ref, exact SHA, and `push` trigger claims to match.
3. Inspect the authenticated `release-certificate.json` and require every required lane to be `success` with an empty `acceptedFailures` array before treating the signed public installer build as public-trust ready. Direct lane evidence and umbrella release-proof evidence are recorded separately; an exact-SHA direct lane failure is blocking even if the umbrella proof is green.
4. Verify the installer checksum with the adjacent `.sha256` file.
5. Verify the installer with the artifact `cosign verify-blob --signature/--certificate` template above, using the same exact workflow identity, name, tag ref, repository, SHA, and `push` trigger claims.
6. Inspect `provenance/build-metadata.json` for the exact tag, commit, workflow run, material command templates, and toolchain versions.
7. Inspect `SBOM/*.cyclonedx.json` for the dependency inventory used for the release.

## Local Rebuild

Local rebuilds are expected to reproduce the same installer contents when run from the same commit with the same lockfile and packaging scripts. Platform-specific packaging metadata may still differ if the host toolchain differs from the GitHub Actions runners.

Use the proof bundle as the reference output for comparison rather than trusting unstamped local artifacts.
