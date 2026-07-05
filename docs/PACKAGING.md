# GoatCitadel Packaging

GoatCitadel now has a packaged runtime contract for installer work.

## Supported v1 bundle targets

- `windows-x64`
- `windows-arm64`
- `macos-arm64` (experimental DMG; public release path requires Developer ID signing, notarization, stapling, checksum, and DMG smoke)
- `linux-x64` (experimental release tarball with POSIX browser launcher)

The tagged release workflow publishes Windows proof, an experimental Linux x64 tarball, and a macOS arm64 DMG only when the macOS notarization credentials are present. The macOS arm64 workflow-dispatch path can still create an ad-hoc-signed DMG for friend smoke. macOS and Linux remain experimental until their exact release artifacts have signed/notarized evidence where applicable, checksums, and smoke output from `.github/workflows/release-installers.yml`.

Deferred targets:

- `darwin-x64`
- `linux-arm64`

## Bundle layout

Each release bundle installs to a mutable GoatCitadel home with this split:

- `app/`
  Immutable packaged payload:
  - deployed gateway runtime
  - built Mission Control assets
  - native Mission Control desktop host (WinUI 3 / Windows App SDK on Windows)
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

The Windows installer shortcut launches the native WinUI 3 / Windows App SDK Mission Control desktop host by default. The host starts the same packaged gateway and Mission Control web assets through the launcher, keeps the local runtime warm while the app is open, restricts WebView2 navigation to loopback GoatCitadel URLs, and exposes tray actions for browser fallback, logs, status, restart, and stop.

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

Windows packages use the new C# WinUI 3 / Windows App SDK host as the release-bearing desktop app. The host pins the stable `Microsoft.WindowsAppSDK` NuGet line; do not move the release lane to preview or experimental SDK packages. Stage A keeps the existing Inno Setup installer while replacing the bundled desktop executable with the WinUI host:

- `GoatCitadel-Setup-windows-x64.exe`
- `GoatCitadel-Setup-windows-arm64.exe`

The generated installer installs into `%LOCALAPPDATA%\GoatCitadel`, creates Start Menu shortcuts, supports an optional desktop shortcut, registers the `goatcitadel://` protocol for the unpackaged lane, and exposes selectable Chromium and voice runtime components. The release manifest identifies the Windows desktop component as `mission-control-windows-host` with `kind: "winui3-windows-app-sdk"`.

Stage B is the package-identity lane. It builds a sparse MSIX external-location identity package with `pnpm package:windows-msix`, embeds the signed identity package into `app/identity/`, and has the Inno installer register it with `Add-AppxPackage -ExternalLocation` when present. Public Windows releases must sign the identity package and smoke package registration, protocol manifest registration, uninstall cleanup, and signed artifact verification before publication. The public `WINDOWS_MSIX_PUBLISHER` repository variable, or local `GOATCITADEL_WINDOWS_MSIX_PUBLISHER`, must match the signing certificate subject because the WinUI host embeds the same package identity in its executable manifest. Local unsigned manifest-only proof is available with `pnpm package:windows-msix --allow-unsigned`, but unsigned MSIX packages are not bundled into installer payloads.

## macOS packaging

macOS arm64 packaging is experimental:

- `GoatCitadel-1.0.0-macos-arm64.dmg`

The DMG embeds the immutable packaged runtime inside the Tauri app at `Contents/Resources/goatcitadel`. The desktop host sets `GOATCITADEL_APP_DIR` to that immutable payload and keeps mutable runtime state under `~/Library/Application Support/GoatCitadel`, including `runtime-root`, logs, pid files, config, data, and artifacts.

The manual unsigned Mac lane uses ad-hoc signing (`signingIdentity: "-"`) for Apple Silicon friend testing. It is not notarized, may require Gatekeeper override, and must not be described as public-trust distribution. The public release lane is fail-closed on Developer ID signing and Apple notarization credentials, runs `notarytool submit --wait`, staples the DMG, validates the staple, writes a checksum, and mounts the DMG for structural smoke before upload.

Do not cite macOS packages as public-trust proof until the workflow has actually emitted a signed/notarized, stapled, checksummed, and smoke-tested DMG for the exact release SHA.

When a reviewer does not have macOS access, attach a Mac operator evidence bundle instead of asking that reviewer to reproduce locally. The collector is read-only: it does not launch the app, remove quarantine, approve requests, or mutate runtime state.

```text
pnpm macos:desktop:evidence -- --app "/Applications/GoatCitadel Mission Control.app" --dmg "/path/to/GoatCitadel-<version>-macos-arm64.dmg"
```

The command writes `artifacts/macos-desktop-evidence/<timestamp>/macos-desktop-evidence.md` plus redacted raw command output and log tails. Reviewers should check the exact app path, signing/Gatekeeper state, gateway/UI health, packaged `desktopEventStream` status, tokenless SSE behavior when `authMode` is `none`, `/api/v1/auth/sse-token` warning counts, and packaged approval modal visual proof before treating Mac desktop approval behavior as verified.

The later LaunchAgent stage should introduce a foreground `goatcitadel service run` supervisor before any `~/Library/LaunchAgents/com.goatcitadel.gateway.plist` install path is wired. Do not point `launchctl` at the one-shot `launch` command.

## Linux packaging

Linux package scripts are experimental:

- `pnpm package:bundle --target linux-x64 --skip-desktop`

The Linux x64 bundle emits a POSIX `bin/goatcitadel` launcher that opens the packaged web runtime rather than a native desktop host. The release workflow archives it as `GoatCitadel-<version>-linux-x64.tar.gz`, writes a `.sha256`, extracts it, verifies the launcher and experimental manifest, and publishes it as an experimental release asset. Do not cite Linux packages as non-experimental public-trust proof until a release run has signed, checksummed, and smoke-tested the exact artifact and the support matrix is deliberately promoted.

## Build commands

```text
pnpm package:windows-host --target windows-x64
pnpm package:windows-msix --allow-unsigned
pnpm package:bundle --target windows-x64
pnpm package:windows --target windows-x64
pnpm package:desktop --target windows-x64  # Tauri rollback lane only
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
pnpm package:windows-host --target windows-x64
pnpm package:windows-msix --allow-unsigned
pnpm package:bundle --target windows-x64
pnpm package:windows --target windows-x64
Get-FileHash .\artifacts\installers\windows\GoatCitadel-Setup-windows-x64.exe -Algorithm SHA256
pnpm verify:install
pnpm verify:desktop
pnpm verify:fast
```

## Release workflow

The GitHub Actions installer workflow builds Windows x64/arm64 installers, an experimental Linux x64 tarball, and a macOS arm64 DMG when the notarization credentials are configured. The Windows desktop executable is built before the bundle with `pnpm package:windows-host`, checked with `pnpm windows:test` plus `pnpm verify:desktop`, signed, and copied into `app/desktop/`. While the Tauri host remains rollback code, `verify:desktop` still carries Tauri `cargo check` / `cargo test` alongside Windows App SDK proof. Public release publication requires signing before the final Windows installer is uploaded.

Public-trust signed Windows releases are fail-closed: Authenticode signing secrets must be present, and `signtool verify /pa` must pass for both the desktop executable and the generated installer. The `v1.0.0` GitHub release may attach unsigned Windows x64/arm64 installers as clearly labeled convenience assets from an explicit manual workflow run with `allow_unsigned=true`; those assets are not Authenticode-signed, do not carry `release-certificate.json` public-trust status, and must not be described as signed installer proof. macOS/Linux remain development targets until the workflow matrix explicitly produces those assets.

Before public release upload, the workflow verifies that both Windows matrix targets produced installers/checksums and runs a silent install/uninstall smoke for each generated Windows installer. It also requires the experimental Linux tarball/checksum and experimental macOS DMG/checksum artifacts when the public release job runs. The manual unsigned smoke path runs Windows install/uninstall smoke, Linux archive smoke, and macOS ad-hoc DMG smoke; those artifacts are named as unsigned or experimental package smoke assets and may be copied onto `v1.0.0` only with explicit unsigned/experimental labeling.

Tagged releases assemble a proof bundle alongside the raw installers. The proof bundle includes:

- the packaged installers
- `.sha256` checksum files
- keyless cosign signatures and certificate sidecars
- a CycloneDX SBOM
- reproducibility and platform docs
- generated handoff and provenance metadata

The signed release job also writes `release-certificate.json`, which binds the release artifacts and required verification-lane status to the exact commit. The certificate records direct lane workflow evidence separately from umbrella release-proof evidence; a green umbrella proof may cover only missing or unavailable direct runs for umbrella-covered lanes, while direct-only lanes such as `docs:check` and `security:trivy` must be green in their own workflows. A signed public installer release should not be treated as public-trust ready unless that certificate is green with no accepted failures. Source/dev/onboarding 1.0 readiness is validated through the repo verification lanes; public Windows EXE trust additionally requires signing and the certificate. The unsigned `v1.0.0` convenience installers are outside that certificate path and must be labeled accordingly.
