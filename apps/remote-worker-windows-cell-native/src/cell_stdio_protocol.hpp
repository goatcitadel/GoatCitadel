#pragma once
#include "cell_runtime_bundle.hpp"

namespace goatcitadel::worker_cell {
inline constexpr DWORD kMaximumStdioConfigurationBytes = 512 * 1024;
inline constexpr DWORD kMaximumStdioFrameBytes = 65536;
inline constexpr char kWorkerStdioMagic[] = "GCSTDIO1";
inline constexpr char kWorkerProtectedStdioMagic[] = "GCSTDIO2";
// After the 8-byte magic and LE32 configuration length: six length-prefixed UTF-8
// launch strings; three file identities/digests; runtime digest; resource limits;
// explicit environment entries; then ordered runtime file metadata. All integers
// are little endian. This is a local native-owner protocol, never mesh authority.
// GCSTDIO2 requires a trailing parent path, owner/controller SIDs, then the five
// recorded parent/root identities. It cannot fall back to an unprotected launch.
DWORD DecodeWorkerStdioConfiguration(const std::vector<std::uint8_t>& bytes,
                                    RuntimeJobCommand* command, JobLimits* limits,
                                    bool protected_workspace = false, DWORD maximum_wall_ms = 25000) noexcept;
std::string WorkerStdioCompletion(const RuntimeJobResult& result, DWORD bridge_error);
}  // namespace goatcitadel::worker_cell
