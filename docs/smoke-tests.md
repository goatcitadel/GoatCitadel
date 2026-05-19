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

## Linux source/shared-host smoke

```bash
goatcitadel launch
goat doctor --deep
curl -fsS http://127.0.0.1:8787/health
```

## Release Proof Expectations

- Windows x64 and Windows arm64 installer packages are built in CI for the currently supported installer targets.
- Public signed Windows releases include signed artifacts, checksums, a CycloneDX SBOM, and provenance metadata. Unsigned workflow-dispatch artifacts are development packaging smoke only.
- macOS and Linux entries above are source/shared-host runtime smoke checks unless a future packaging lane explicitly adds native installers for those platforms.
- Cross-platform regression and operator-proof lanes remain governed by the release gates in `docs/1_0_CONTRACT.md`.
