#pragma once
#include "cell_runtime_bundle.hpp"
#include <span>

namespace goatcitadel::worker_cell {
inline constexpr std::size_t kCellRuntimeInstallBytes = 272;
struct CellRuntimeInstallBinding final {
  CellFileSha256 nonce{};
  CellFileSha256 request_sha256{};
};
struct CellRuntimeInstallRequest final {
  CellRuntimeInstallBinding binding;
  CellFileIdentity journal_identity;
  CellFileSha256 prepared_sha256{};
  CellFileSha256 checkpoint_sha256{};
  CellFileSha256 package_sha256{};
  CellFileSha256 bundle_sha256{};
  std::vector<CellRuntimeBundleFile> files;
};
// GCRINST1: fixed 272-byte Node installation metadata. The expected binding
// arrives independently through protected admission. Neither decoding nor
// hashing grants installation, execution, package custody or capacity authority.
DWORD HashCellRuntimeInstall(std::span<const std::uint8_t> bytes, CellFileSha256* output) noexcept;
DWORD DecodeCellRuntimeInstall(std::span<const std::uint8_t> bytes,
  const CellRuntimeInstallBinding& expected, CellRuntimeInstallRequest* output) noexcept;
}  // namespace goatcitadel::worker_cell
