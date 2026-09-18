#pragma once
#include "cell_capacity.hpp"

namespace goatcitadel::worker_cell {
using CellCapacityLayoutBytes = std::array<std::uint8_t, 384>;
inline constexpr std::size_t kCellCapacityCaptureMaximumBytes = 840 + 48 * 20000;
// GCLAY001 binds assignment/profile and thirteen ordered root identities.
DWORD EncodeCellCapacityLayout(const CellCapacityLayoutRecord&, CellCapacityLayoutBytes*) noexcept;
// Restores data only; roots, principals and assignment authority stay independent.
DWORD DecodeCellCapacityLayout(std::span<const std::uint8_t>, CellCapacityLayoutRecord*) noexcept;
// GCCAP001: nonce + layout + thirteen 32-byte summaries + ordered 48-byte
// identity/kind/count entries. No names, paths, credentials or execution claims.
DWORD EncodeCellCapacityCapture(const CellCapacityLayoutRecord&, const CellFileSha256& nonce,
  const CellCapacityAreaInventories&, std::vector<std::uint8_t>*) noexcept;
}
