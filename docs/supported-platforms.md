# Supported Platforms

This table is the current `1.0` installer support matrix for GoatCitadel.

| OS | Arch | Package | Minimum runtime expectation | Status |
| --- | --- | --- | --- | --- |
| Windows | x64 | `GoatCitadel-Setup-windows-x64.exe` | Windows 10+ | Supported |
| Windows | arm64 | `GoatCitadel-Setup-windows-arm64.exe` | Windows 11 on ARM | Supported |
| macOS | x64 | n/a | macOS 13+ source/dev install | Development-only |
| macOS | arm64 | `GoatCitadel-1.0.0-macos-arm64.dmg` | macOS 13+ experimental signed/notarized release DMG when Apple credentials are configured; ad-hoc manual smoke otherwise | Experimental |
| Linux | x64 | `GoatCitadel-1.0.0-linux-x64.tar.gz` | glibc 2.31+ source/dev install, Docker, or experimental browser-launcher tarball | Experimental release tarball |
| Linux | arm64 | n/a | Deferred until voice/runtime parity is ready | Not shipped |

## Notes

- Windows installer artifacts include an embedded Node runtime, the built Mission Control Next assets, and the native Mission Control desktop host.
- macOS arm64 DMG packaging is experimental. Manual unsigned smoke uses ad-hoc signing, is not notarized, and may require a Gatekeeper Privacy & Security override. Public release DMG publication is fail-closed on Developer ID signing, notarization, stapling, checksum, and DMG smoke proof in `.github/workflows/release-installers.yml`.
- Linux x64 bundle packaging is experimental. The release workflow can publish a checksummed tarball after extracting it and verifying the POSIX launcher plus experimental manifest, but it does not include a native desktop host.
- macOS and Linux stay experimental until a signed/notarized artifact where applicable plus checksum and smoke evidence exists for the exact release SHA and the support matrix is deliberately promoted.
- Installer-managed optional components, such as Chromium and the local voice runtime, are still platform-dependent.
- `apps/npu-sidecar` remains optional experimental infrastructure and is not part of the support matrix above.
