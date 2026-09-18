#include "cell_runtime_install.hpp"
#include <algorithm>
#include <bcrypt.h>
#include <cstring>

namespace goatcitadel::worker_cell {
namespace {
template <typename Bytes> bool Nonzero(const Bytes& bytes) noexcept {
  return std::any_of(bytes.begin(), bytes.end(), [](auto byte) { return byte != 0; });
}
std::uint64_t U64(const std::uint8_t* bytes) noexcept {
  std::uint64_t value = 0;
  for (unsigned index = 0; index < 8; ++index) value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8);
  return value;
}
}
DWORD HashCellRuntimeInstall(std::span<const std::uint8_t> input, CellFileSha256* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (input.size() != kCellRuntimeInstallBytes) return ERROR_INVALID_PARAMETER;
  constexpr char domain[] = "goatcitadel.worker-runtime-install.v1";
  std::array<std::uint8_t, sizeof(domain) + kCellRuntimeInstallBytes> bytes{};
  std::memcpy(bytes.data(), domain, sizeof(domain));
  std::copy(input.begin(), input.end(), bytes.begin() + sizeof(domain));
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  CellFileSha256 digest{};
  const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()), digest.data(), static_cast<ULONG>(digest.size()));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (status < 0) return ERROR_INVALID_DATA;
  *output = digest; return ERROR_SUCCESS;
}
DWORD DecodeCellRuntimeInstall(std::span<const std::uint8_t> input,
  const CellRuntimeInstallBinding& expected, CellRuntimeInstallRequest* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  // Snapshot the independent binding before clearing potentially aliased output.
  const auto binding = expected;
  *output = {};
  if (input.size() != kCellRuntimeInstallBytes || !Nonzero(binding.nonce) || !Nonzero(binding.request_sha256)) return ERROR_INVALID_PARAMETER;
  try {
    std::array<std::uint8_t, kCellRuntimeInstallBytes> bytes{};
    std::copy(input.begin(), input.end(), bytes.begin());
    CellFileSha256 digest{};
    auto error = HashCellRuntimeInstall(bytes, &digest);
    if (error) return error;
    if (std::memcmp(bytes.data(), "GCRINST1", 8) || digest != binding.request_sha256 ||
        !std::equal(binding.nonce.begin(), binding.nonce.end(), bytes.begin() + 8)) return ERROR_INVALID_DATA;
    CellRuntimeInstallRequest value;
    value.binding = binding;
    value.journal_identity.volume_serial = U64(bytes.data() + 40);
    std::copy_n(bytes.begin() + 48, 16, value.journal_identity.file_id.begin());
    std::copy_n(bytes.begin() + 64, 32, value.prepared_sha256.begin());
    std::copy_n(bytes.begin() + 96, 32, value.checkpoint_sha256.begin());
    std::copy_n(bytes.begin() + 128, 32, value.package_sha256.begin());
    std::copy_n(bytes.begin() + 160, 32, value.bundle_sha256.begin());
    if (!value.journal_identity.volume_serial || !Nonzero(value.journal_identity.file_id) ||
        !Nonzero(value.prepared_sha256) || !Nonzero(value.checkpoint_sha256) || !Nonzero(value.package_sha256)) return ERROR_INVALID_DATA;
    constexpr const wchar_t* names[] = {L"node.exe", L"worker-host-receipt.json"};
    for (std::size_t index = 0; index < 2; ++index) {
      CellRuntimeBundleFile file;
      file.relative_path = names[index]; file.bytes = U64(bytes.data() + 192 + index * 40);
      std::copy_n(bytes.begin() + 200 + index * 40, 32, file.sha256.begin());
      if (!file.bytes || file.bytes > 256ull * 1024 * 1024 || !Nonzero(file.sha256)) return ERROR_INVALID_DATA;
      value.files.push_back(std::move(file));
    }
    error = HashRuntimeBundleManifest(value.files, &digest);
    if (error) return error;
    if (digest != value.bundle_sha256) return ERROR_INVALID_DATA;
    *output = std::move(value); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
}  // namespace goatcitadel::worker_cell
