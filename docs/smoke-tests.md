# Smoke Tests

These are the minimum operator-facing smoke checks for a tagged release package.

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

## macOS

```bash
goatcitadel launch
goat doctor --deep
curl -fsS http://127.0.0.1:8787/health
```

## Linux

```bash
goatcitadel launch
goat doctor --deep
curl -fsS http://127.0.0.1:8787/health
```

## Release Proof Expectations

- Installer packages are built in CI for every supported target.
- The release package includes signed artifacts, checksums, a CycloneDX SBOM, and provenance metadata.
- Cross-platform regression and operator-proof lanes remain governed by the release gates in `docs/1_0_CONTRACT.md`.
