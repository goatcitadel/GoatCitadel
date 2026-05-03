# GoatCitadel Packaging

GoatCitadel now has a packaged runtime contract for installer work.

## Supported v1 bundle targets

- `windows-x64`
- `windows-arm64`

The current tagged release workflow publishes Windows proof only. macOS and Linux bundle scripts remain development lanes until their installer artifacts, signing/notarization story, and smoke evidence are wired into `.github/workflows/release-installers.yml`.

Deferred targets:

- `darwin-x64`
- `darwin-arm64`
- `linux-x64`
- `linux-arm64`

## Bundle layout

Each release bundle installs to a mutable GoatCitadel home with this split:

- `app/`
  Immutable packaged payload:
  - deployed gateway runtime
  - built Mission Control assets
  - native Mission Control desktop host
  - embedded Node runtime
  - packaged launcher helpers
  - runtime templates
  - `release-manifest.json`
- `config/`, `skills/`, `workspaces/`, `data/`
  Mutable runtime state created or seeded on first `goatcitadel launch`
- `bin/`
  User-facing launchers

This keeps the shipped payload separate from operator data so upgrades can replace `app/` without clobbering local state.

## Entry point

The Windows installer shortcut launches the native Mission Control desktop host by default. The desktop host starts the same packaged gateway and Mission Control web assets through the launcher, keeps the local runtime warm while the app is open, and exposes tray actions for browser fallback, logs, status, restart, and stop.

Browser and CLI fallback remain supported with:

```text
goatcitadel launch
```

`launch` is the installer-safe entrypoint. It:

1. ensures runtime directories exist
2. seeds config and workspace templates when needed
3. starts the local stack when it is not already healthy
4. waits for gateway and Mission Control health
5. opens onboarding when setup is incomplete
6. opens the dashboard route when setup is complete

Machine-readable runtime control is available with:

```text
goatcitadel launch --no-open --json --wait
goatcitadel status --json
goatcitadel stop --json
```

`goat up`, `goat onboard`, and `goat doctor --deep` remain available for source and operator workflows.

## Windows packaging

Windows packages use Inno Setup and emit separate installers:

- `GoatCitadel-Setup-windows-x64.exe`
- `GoatCitadel-Setup-windows-arm64.exe`

The generated installer installs into `%LOCALAPPDATA%\GoatCitadel`, creates Start Menu shortcuts, supports an optional desktop shortcut, and exposes selectable Chromium and voice runtime components.

## macOS packaging

macOS package scripts are experimental and are not published by the current release workflow:

- `GoatCitadel-Setup-darwin-x64.pkg`
- `GoatCitadel-Setup-darwin-arm64.pkg`

Do not cite macOS packages as release proof until the workflow emits, signs, and smoke-tests them.

## Linux packaging

Linux package scripts are experimental and are not published by the current release workflow:

- `GoatCitadel-Setup-linux-x64.tar.gz`

Do not cite Linux packages as release proof until the workflow emits, signs, and smoke-tests them.

## Build commands

```text
pnpm package:desktop --target windows-x64
pnpm package:bundle --target windows-x64
pnpm package:windows --target windows-x64
pnpm verify:desktop
```

## Release workflow

The GitHub Actions release workflow currently builds and publishes Windows x64/arm64 installers. The desktop executable is built before the bundle, copied into `app/desktop/`, and signed before the final installer when signing secrets are available. macOS/Linux remain development targets until the workflow matrix explicitly produces those assets.

Tagged releases assemble a proof bundle alongside the raw installers. The proof bundle includes:

- the packaged installers
- `.sha256` checksum files
- keyless cosign signatures and certificate sidecars
- a CycloneDX SBOM
- reproducibility and platform docs
- generated handoff and provenance metadata

The release job also writes `release-certificate.json`, which binds the release artifacts and required verification-lane status to the exact commit. A release should not be treated as 1.0-ready unless that certificate is green with no accepted failures.
