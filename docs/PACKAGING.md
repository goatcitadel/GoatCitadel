# GoatCitadel Packaging

GoatCitadel now has a packaged runtime contract for installer work.

## Supported v1 bundle targets

- `windows-x64`
- `windows-arm64`
- `macos-arm64` (experimental friend-smoke bundle/DMG only)
- `linux-x64` (experimental source bundle only)

The current tagged release workflow publishes Windows proof only. The macOS arm64 scripts can create an ad-hoc-signed local DMG for friend smoke, and the Linux x64 bundle target can create a local POSIX browser-launcher bundle, but neither target is release proof. macOS and Linux release claims remain blocked until their installer artifacts, signing/notarization story where applicable, checksums, and smoke evidence are wired into `.github/workflows/release-installers.yml`.

Deferred targets:

- `darwin-x64`
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

`goat up` is installer-safe. Deep diagnostics, verification lanes, and source-oriented operator commands remain source-checkout workflows unless a tagged release explicitly documents them as packaged commands.

## Windows packaging

Windows packages use Inno Setup and emit separate installers:

- `GoatCitadel-Setup-windows-x64.exe`
- `GoatCitadel-Setup-windows-arm64.exe`

The generated installer installs into `%LOCALAPPDATA%\GoatCitadel`, creates Start Menu shortcuts, supports an optional desktop shortcut, and exposes selectable Chromium and voice runtime components.

## macOS packaging

macOS arm64 packaging is experimental and is not published by the current release workflow:

- `GoatCitadel-1.0.0-macos-arm64.dmg`

The DMG embeds the immutable packaged runtime inside the Tauri app at `Contents/Resources/goatcitadel`. The desktop host sets `GOATCITADEL_APP_DIR` to that immutable payload and keeps mutable runtime state under `~/Library/Application Support/GoatCitadel`, including `runtime-root`, logs, pid files, config, data, and artifacts.

The first Mac lane uses ad-hoc signing (`signingIdentity: "-"`) for Apple Silicon friend testing. It is not notarized, may require Gatekeeper override, and must not be described as public-trust distribution.

Do not cite macOS packages as release proof until the workflow emits, signs/notarizes, and smoke-tests them.

The later LaunchAgent stage should introduce a foreground `goatcitadel service run` supervisor before any `~/Library/LaunchAgents/com.goatcitadel.gateway.plist` install path is wired. Do not point `launchctl` at the one-shot `launch` command.

## Linux packaging

Linux package scripts are experimental and are not published by the current release workflow:

- `pnpm package:bundle --target linux-x64 --skip-desktop`

The Linux x64 bundle emits a POSIX `bin/goatcitadel` launcher that opens the packaged web runtime rather than a native desktop host. It is a local/source bundle target only. Do not cite Linux packages as release proof until the workflow emits, signs, checksums, and smoke-tests them.

## Build commands

```text
pnpm package:desktop --target windows-x64
pnpm package:bundle --target windows-x64
pnpm package:windows --target windows-x64
pnpm package:bundle --target macos-arm64 --skip-desktop
pnpm package:macos --target macos-arm64
pnpm package:bundle --target linux-x64 --skip-desktop
pnpm verify:desktop
```

`package:bundle` verifies the embedded Node archive against either `--node-sha256 <sha256>` or the upstream Node `SHASUMS256.txt` entry before copying `node.exe` or `node` into the bundle.

## Unsigned distribution checklist

Unsigned or ad-hoc-signed convenience builds are acceptable for internal or early friend testing, but the release copy must be explicit:

- name artifacts with `unsigned`, target, and commit or tag, for example `GoatCitadel-Setup-windows-x64-unsigned-v1.0.0.exe`
- publish a matching `.sha256` file and a plain checksum verification command
- include known-warning copy that Windows SmartScreen or browser download warnings may appear because the installer is not Authenticode-signed
- include known-warning copy that macOS Gatekeeper may require Privacy & Security override when using ad-hoc-signed, non-notarized DMGs
- attach install smoke output, uninstall smoke output, Mission Control screenshots, provider/channel fixture results, Docker smoke where applicable, and the standalone white-paper link
- keep "works unsigned with warning" separate from any "signed/trusted installer" language

Local unsigned rebuild and verification path:

```text
pnpm package:desktop --target windows-x64
pnpm package:bundle --target windows-x64
pnpm package:windows --target windows-x64
Get-FileHash .\artifacts\installers\windows\GoatCitadel-Setup-windows-x64.exe -Algorithm SHA256
pnpm verify:install
pnpm verify:desktop
pnpm verify:fast
```

## Release workflow

The GitHub Actions installer workflow currently builds Windows x64/arm64 installers. The desktop executable is built before the bundle, checked with `cargo check` and `cargo test`, and copied into `app/desktop/`. Public release publication requires signing before the final installer is uploaded.

Public-trust signed Windows releases are fail-closed: Authenticode signing secrets must be present, and `signtool verify /pa` must pass for both the desktop executable and the generated installer. The `v1.0.0` GitHub release may attach unsigned Windows x64/arm64 installers as clearly labeled convenience assets from an explicit manual workflow run with `allow_unsigned=true`; those assets are not Authenticode-signed, do not carry `release-certificate.json` public-trust status, and must not be described as signed installer proof. macOS/Linux remain development targets until the workflow matrix explicitly produces those assets.

Before public release upload, the workflow also verifies that both Windows matrix targets produced installers/checksums and runs a silent install/uninstall smoke for each generated Windows installer. The manual unsigned smoke path runs the same matrix build and install/uninstall smoke, and its artifacts are named as unsigned package smoke assets; for `v1.0.0`, those artifacts may be copied onto the GitHub release only with explicit unsigned labeling.

Tagged releases assemble a proof bundle alongside the raw installers. The proof bundle includes:

- the packaged installers
- `.sha256` checksum files
- keyless cosign signatures and certificate sidecars
- a CycloneDX SBOM
- reproducibility and platform docs
- generated handoff and provenance metadata

The signed release job also writes `release-certificate.json`, which binds the release artifacts and required verification-lane status to the exact commit. The certificate records direct lane workflow evidence separately from umbrella release-proof evidence; a green umbrella proof may cover only missing or unavailable direct runs for umbrella-covered lanes, while direct-only lanes such as `docs:check` and `security:trivy` must be green in their own workflows. A signed public installer release should not be treated as public-trust ready unless that certificate is green with no accepted failures. Source/dev/onboarding 1.0 readiness is validated through the repo verification lanes; public Windows EXE trust additionally requires signing and the certificate. The unsigned `v1.0.0` convenience installers are outside that certificate path and must be labeled accordingly.
