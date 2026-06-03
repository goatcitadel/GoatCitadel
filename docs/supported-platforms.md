# Supported Platforms

This table is the current `1.0` installer support matrix for GoatCitadel.

| OS | Arch | Package | Minimum runtime expectation | Status |
| --- | --- | --- | --- | --- |
| Windows | x64 | `GoatCitadel-Setup-windows-x64.exe` | Windows 10+ | Supported |
| Windows | arm64 | `GoatCitadel-Setup-windows-arm64.exe` | Windows 11 on ARM | Supported |
| macOS | x64 | n/a | macOS 13+ source/dev install | Development-only |
| macOS | arm64 | `GoatCitadel-1.0.0-macos-arm64.dmg` | macOS 13+ experimental ad-hoc-signed DMG | Experimental friend-smoke |
| Linux | x64 | n/a | glibc 2.31+ source/dev install or Docker | Development-only |
| Linux | arm64 | n/a | Deferred until voice/runtime parity is ready | Not shipped |

## Notes

- Windows installer artifacts include an embedded Node runtime, the built Mission Control Next assets, and the native Mission Control desktop host.
- macOS arm64 DMG packaging is an experimental local/friend-smoke lane. It is ad-hoc signed, not notarized, and may require a Gatekeeper Privacy & Security override.
- macOS and Linux package scripts are not release-proofed until `.github/workflows/release-installers.yml` emits signed/notarized artifacts and smoke evidence for those targets.
- Installer-managed optional components, such as Chromium and the local voice runtime, are still platform-dependent.
- `apps/npu-sidecar` remains optional experimental infrastructure and is not part of the support matrix above.
