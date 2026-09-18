#include "cell_install_capacity_challenge.hpp"
#include <algorithm>
#include <bcrypt.h>
#include <cstring>

namespace goatcitadel::worker_cell {
namespace {
bool Nonzero(const CellFileSha256& bytes) noexcept { return std::any_of(bytes.begin(), bytes.end(), [](auto value) { return value != 0; }); }
void Put32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (unsigned i = 0; i < 4; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (i * 8));
}
}
DWORD HashCellInstallCapacityCapture(std::span<const std::uint8_t> input, CellFileSha256* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (input.empty() || input.size() > kCellPoolCapacityResponseMaximumBytes) return ERROR_INVALID_PARAMETER;
  try {
    constexpr char domain[] = "goatcitadel.worker-install-capacity-capture.v1";
    std::vector<std::uint8_t> bytes(sizeof(domain) + input.size());
    std::memcpy(bytes.data(), domain, sizeof(domain)); std::copy(input.begin(), input.end(), bytes.begin() + sizeof(domain));
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
    CellFileSha256 digest{};
    const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()), digest.data(), static_cast<ULONG>(digest.size()));
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) return ERROR_INVALID_DATA;
    *output = digest; return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
bool EncodeCellInstallCapacityChallenge(const CellInstallCapacityBinding& supplied, std::uint32_t ordinal, CellInstallCapacityChallenge* output) noexcept {
  if (!output) return false;
  const auto binding = supplied; *output = {};
  if (!Nonzero(binding.connection) || !Nonzero(binding.installation.nonce) || !Nonzero(binding.installation.request_sha256) ||
      !Nonzero(binding.capture_sha256) || !binding.byte_length || binding.byte_length > kCellPoolCapacityResponseMaximumBytes ||
      !ordinal || ordinal > kCellInstallCapacityMaximumChecks) return false;
  CellInstallCapacityChallenge bytes{};
  std::copy(binding.connection.begin(), binding.connection.end(), bytes.begin());
  std::copy(binding.installation.nonce.begin(), binding.installation.nonce.end(), bytes.begin() + 32);
  std::copy(binding.installation.request_sha256.begin(), binding.installation.request_sha256.end(), bytes.begin() + 64);
  std::copy(binding.capture_sha256.begin(), binding.capture_sha256.end(), bytes.begin() + 96);
  Put32(bytes.data() + 128, ordinal); Put32(bytes.data() + 132, 1); Put32(bytes.data() + 136, binding.byte_length);
  *output = bytes; return true;
}
bool MatchCellInstallCapacityChallenge(const CellInstallCapacityChallenge& bytes, const CellInstallCapacityBinding& binding, std::uint32_t expected_ordinal) noexcept {
  CellInstallCapacityChallenge expected;
  return EncodeCellInstallCapacityChallenge(binding, expected_ordinal, &expected) && expected == bytes;
}
}
