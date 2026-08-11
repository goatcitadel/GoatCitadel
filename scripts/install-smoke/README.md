# Clean-host installer lifecycle smoke (M9 / GC-P1-09)

One command proves the full isolated Windows installer journey on a clean VM or
clean user profile: preflight, install, first launch, status, restart, stop,
uninstall, reinstall, single-instance, `goatcitadel://` protocol
registration/deregistration, and a machine-readable evidence bundle.

Program placement: this is the runnable harness for the "Execute the clean
Windows install ... journeys on the exact candidate" line of
[`docs/MASTER_COMPLETION_PROGRAM.md`](../../docs/MASTER_COMPLETION_PROGRAM.md)
tranche `M9`, feeding the acceptance checklist in
[`docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md`](../../docs/PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md)
(`GC-P1-09`, section 1).

## What runs, in order (fail-fast)

| # | Step | Proves |
|---|------|--------|
| 1 | `preflight` | READ-ONLY. Refuses (exit 2) unless the host carries zero GoatCitadel identity: no `goatcitadel://` protocol keys (HKCU/HKLM/HKCR), no `GoatCitadel.MissionControl.Windows` package identity, no `com.goatcitadel.installer.*` uninstall entries, no default install dir (`%LOCALAPPDATA%\GoatCitadel`), no operator home (`%USERPROFILE%\.GoatCitadel`), no `GOATCITADEL_HOME`, no running GoatCitadel processes. |
| 2 | `lifecycle-pass-1` | Delegates to the shared `scripts/packaging/smoke-windows-installer.ps1` (the same script the release CI runs): silent install, Authenticode/identity validation per trust mode, installed payload validation, exact protocol-command binding, first desktop-host launch with a real window, embedded Mission Control WebView reaching `/settings/onboarding`, packaged runtime `launch --wait` + `status --json` readiness, stop, uninstall, and deregistration checks. |
| 3 | `lifecycle-pass-2-reinstall` | The identical shared lifecycle again in a fresh scratch root: reinstall-after-uninstall behaves like the first install. |
| 4 | `extended-install` | A third (wrapper-owned) install; asserts the protocol handler is rebound to this install's exact desktop executable and the uninstall entry is re-registered. |
| 5 | `extended-restart-journey` | Packaged runtime restart: `launch --no-open --wait --json` to `ready`, `stop --json` to `stopped`, `status --json` confirms `stopped`, `launch` again back to `ready`. |
| 6 | `extended-single-instance` | Starts the installed desktop host, waits for its window, starts a second host process; the second must redirect activation and exit cleanly while exactly one host process remains. |
| 7 | `extended-stop-and-uninstall` | Bounded process teardown, silent uninstall, then asserts the protocol key, uninstall entry, package identity, desktop executable, and immutable `app`/`bin` payload are gone (mutable operator state is intentionally preserved and listed). |

The wrapper is read-only until its preflight passes: before the preflight
verdict the only writes are its own evidence files under `-OutputRoot`.

## VM prerequisites

- Windows 10/11 matching the target (`windows-x64` or `windows-arm64`), with a
  user profile that has never run GoatCitadel. No admin rights required (the
  installer uses `PrivilegesRequired=lowest`).
- WebView2 Evergreen Runtime (preinstalled on Windows 11; install it on
  stripped-down images or the desktop-host steps will fail).
- Windows PowerShell 5.1 (built in) or PowerShell 7+. The harness runs on both.
- No network access is required for the journeys themselves; readiness is
  local-loopback `/health` polling.
- Disk: allow roughly 3x the extracted install size (two shared-pass scratch
  roots plus the extended install) under the evidence output root.

## What to copy onto the VM

Either the whole repo checkout, or a minimal bundle that preserves this layout:

```
smoke-bundle/
  scripts/install-smoke/run-clean-host-smoke.ps1
  scripts/packaging/smoke-windows-installer.ps1
  scripts/packaging/validate-windows-bundle.ps1
  artifacts/GoatCitadel-Setup-windows-x64.exe
  artifacts/release-manifest.json
```

- The two `scripts/packaging` files are hard requirements: the wrapper
  delegates the lifecycle passes to `smoke-windows-installer.ps1`, which loads
  `validate-windows-bundle.ps1` from its own folder. Keep them siblings, or
  point `-PackagingScriptsDir` at their folder.
- The installer is `GoatCitadel-Setup-<target>.exe` from
  `artifacts/installers/windows/` (built by
  `node scripts/packaging/build-windows-native-installer.mjs --target <target>`
  or downloaded from the `release-installers` workflow run under test).
- `release-manifest.json` is the detached copy of the installed manifest from
  the SAME build: `artifacts/installers/bundles/GoatCitadel-<version>-<target>/app/release-manifest.json`
  locally, or `app/release-manifest.json` inside the workflow's assembly
  artifact. The smoke fails if installed bytes differ from this file.

## The one command

From the bundle (or repo) root on the clean VM:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\scripts\install-smoke\run-clean-host-smoke.ps1 `
  -InstallerPath .\artifacts\GoatCitadel-Setup-windows-x64.exe `
  -ReleaseManifestPath .\artifacts\release-manifest.json `
  -Target windows-x64 `
  -TrustMode unsigned
```

Use `-TrustMode signed` for signed release candidates (enforces valid
Authenticode signatures and registered package identity), and
`-Target windows-arm64` on ARM64 hosts. Add `-OutputRoot <dir>` to choose the
evidence location (the default is a timestamped folder under `%TEMP%`; an
existing output root is refused so evidence is never mixed between runs).

To only verify host cleanliness without running anything:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\scripts\install-smoke\run-clean-host-smoke.ps1 -PreflightOnly
```

## Reading the verdict

- Exit code `0` = passed, `1` = failed, `2` = preflight refused (host not
  clean; nothing was modified).
- `<OutputRoot>\clean-host-smoke-verdict.json` is the machine-readable verdict
  (`schema: goatcitadel.clean-host-installer-smoke/1`): overall `verdict`,
  installer/manifest SHA-256, host context, per-step `status` +
  timing + `detail` + relative log paths, and any `cleanupFailures`.
- `<OutputRoot>\logs\` holds the wrapper transcript, the preflight findings,
  the full stdout/stderr of both shared lifecycle passes, and each packaged
  launcher invocation from the extended journeys.
- The evidence bundle is always preserved, including on failure. On failure the
  wrapper uninstalls its own extended install (never a foreign one: the
  protocol key is only removed when bound to this run's install path) and
  records any cleanup problems in `cleanupFailures`.

For the M9/GC-P1-09 proof, attach the whole `<OutputRoot>` folder (verdict +
logs) to the packaging proof bundle
(`templates/verification/packaging-deployment-proof-bundle.md`, exported under
`artifacts/follow-on-parity/packaging/`), alongside the installer SHA-256 the
verdict already records.

## Safety model

- The preflight is the gate: any GoatCitadel protocol/package identity,
  install footprint, home directory, `GOATCITADEL_HOME`, or running process on
  the host refuses the run with exit 2 before anything is touched. This is
  deliberately stronger than the shared smoke's own preflight (protocol key +
  package identity), so developer machines with any GoatCitadel residue keep
  refusing.
- All installs land in wrapper-owned scratch directories; runtime state is
  isolated via `GOATCITADEL_HOME` / `GOATCITADEL_APP_DIR` /
  `WEBVIEW2_USER_DATA_FOLDER`. Mutable operator state preserved by uninstall
  is listed, never asserted away.
- Destructive cleanup is bounded to this run's own install and evidence paths;
  the shared lifecycle passes keep their own hardened cleanup semantics.

## Status / holds

- Proven on a developer host: script parse (Windows PowerShell 5.1 and
  PowerShell 7), preflight refusal with a real GoatCitadel footprint present
  (exit 2, read-only), and the static contract test
  (`scripts/install-smoke/clean-host-smoke-contract.test.mjs`, part of the
  `scripts/**/*.test.mjs` hygiene glob).
- HOLD: the actual clean-VM execution (steps 2-7) requires a built Setup exe
  and a clean Windows host; it has not been executed yet and remains the
  outstanding M9 evidence item. Do not mark GC-P1-09 section 1 complete until
  a run's evidence bundle from a clean host is filed.
