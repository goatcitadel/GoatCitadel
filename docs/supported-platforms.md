# Supported Platforms

This table is the current `1.0` installer support matrix for GoatCitadel.

| OS | Arch | Package | Minimum runtime expectation | Status |
| --- | --- | --- | --- | --- |
| Windows | x64 | `GoatCitadel-Setup-windows-x64.exe` | Windows 10+ | Supported |
| Windows | arm64 | `GoatCitadel-Setup-windows-arm64.exe` | Windows 11 on ARM | Supported |
| macOS | x64 | `GoatCitadel-Setup-darwin-x64.pkg` | macOS 13+ | Supported |
| macOS | arm64 | `GoatCitadel-Setup-darwin-arm64.pkg` | macOS 13+ | Supported |
| Linux | x64 | `GoatCitadel-Setup-linux-x64.tar.gz` | glibc 2.31+ | Supported |
| Linux | arm64 | n/a | Deferred until voice/runtime parity is ready | Not shipped |

## Notes

- The packaged runtime includes an embedded Node runtime and the built Mission Control assets.
- Installer-managed optional components, such as Chromium and the local voice runtime, are still platform-dependent.
- `apps/npu-sidecar` remains optional experimental infrastructure and is not part of the support matrix above.
