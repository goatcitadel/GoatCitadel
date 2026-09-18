#pragma once
#include "cell_joined_capacity_wire.hpp"

namespace goatcitadel::worker_cell {
struct CellInstallCapacityBinding final {
  CellControllerNonce connection{};
  CellRuntimeInstallBinding installation;
  CellFileSha256 capture_sha256{};
  std::uint32_t byte_length = 0;
};
using CellInstallCapacityChallenge = std::array<std::uint8_t, 144>;
inline constexpr std::uint32_t kCellInstallCapacityMaximumChecks = 65536;
// Domain-separated transport binding, not decoding, accounting or permission.
DWORD HashCellInstallCapacityCapture(std::span<const std::uint8_t>, CellFileSha256*) noexcept;
bool EncodeCellInstallCapacityChallenge(const CellInstallCapacityBinding&, std::uint32_t ordinal, CellInstallCapacityChallenge*) noexcept;
// The expected ordinal belongs to the live session; never learn it from a peer.
bool MatchCellInstallCapacityChallenge(const CellInstallCapacityChallenge&, const CellInstallCapacityBinding&, std::uint32_t expected_ordinal) noexcept;
}
