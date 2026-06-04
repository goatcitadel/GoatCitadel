# Smoke Tests

These are the minimum operator-facing smoke checks for release artifacts and source installs.

## Common expectation

Every package should prove:

1. the launcher starts
2. the gateway becomes healthy
3. Mission Control is reachable
4. the package can report its own runtime status

## Windows

```powershell
goatcitadel launch
goat doctor --deep
Invoke-WebRequest http://127.0.0.1:8787/health
```

## macOS source/shared-host smoke

```bash
goatcitadel launch
goat doctor --deep
curl -fsS http://127.0.0.1:8787/health
```

## macOS experimental DMG smoke

```bash
shasum -a 256 -c GoatCitadel-1.0.0-macos-arm64.dmg.sha256
hdiutil verify GoatCitadel-1.0.0-macos-arm64.dmg
```

Public release DMG publication also requires Developer ID signing, notarization, stapling, and staple validation in CI.

## Linux source/shared-host smoke

```bash
goatcitadel launch
goat doctor --deep
curl -fsS http://127.0.0.1:8787/health
```

## Linux experimental tarball smoke

```bash
sha256sum -c GoatCitadel-1.0.0-linux-x64.tar.gz.sha256
tar -tzf GoatCitadel-1.0.0-linux-x64.tar.gz
```

## Release Proof Expectations

- Windows x64 and Windows arm64 installer packages are built in CI for the currently supported installer targets.
- Public signed Windows releases include signed artifacts, checksums, a CycloneDX SBOM, and provenance metadata. Unsigned workflow-dispatch artifacts are development packaging smoke only.
- macOS and Linux package smoke entries are experimental artifact checks. They do not promote macOS/Linux out of experimental status until the release workflow emits exact-SHA signed/notarized proof where applicable, checksums, and smoke evidence, and the support matrix is deliberately updated.
- Cross-platform regression and operator-proof lanes remain governed by the release gates in `docs/1_0_CONTRACT.md`.
