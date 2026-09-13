#pragma once
#include <windows.h>
#include <cstdint>
#include <vector>

namespace goatcitadel::worker_cell {
// Exact protected owner/group/DACL/integrity comparison for broker-owned objects.
DWORD VerifyCellSecurity(HANDLE handle, const std::vector<std::uint8_t>& descriptor) noexcept;
// Convert the frozen controller directory descriptor to its file equivalent.
// Principals, rights and integrity remain unchanged; only inheritance is removed.
DWORD MakeCellControlFileSecurity(std::vector<std::uint8_t>& descriptor) noexcept;
}
