#include "cell_install_capacity_challenge.hpp"
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
using namespace goatcitadel::worker_cell;
int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 1;
  std::ifstream input(std::filesystem::path(argv[1]), std::ios::binary);
  const std::vector<std::uint8_t> fixture((std::istreambuf_iterator<char>(input)), {});
  constexpr std::size_t payload_size = 1013;
  if (fixture.size() != payload_size + 288) return 2;
  CellInstallCapacityBinding binding; binding.connection.fill(0x11); binding.installation.nonce.fill(0x22);
  binding.installation.request_sha256.fill(0x33); binding.byte_length = payload_size;
  unsigned checks = 0;
  const auto check = [&](bool passed) { ++checks; return passed; };
  if (!check(!HashCellInstallCapacityCapture(std::span(fixture).first(payload_size), &binding.capture_sha256))) return 3;
  for (unsigned index = 0; index < 2; ++index) {
    CellInstallCapacityChallenge expected, encoded;
    std::copy_n(fixture.begin() + payload_size + index * 144, 144, expected.begin());
    const auto ordinal = index ? 65536u : 1u;
    if (!check(EncodeCellInstallCapacityChallenge(binding, ordinal, &encoded) && encoded == expected) ||
        !check(MatchCellInstallCapacityChallenge(expected, binding, ordinal))) return 4;
    for (std::size_t i = 0; i < expected.size(); ++i) {
      auto changed = expected; changed[i] ^= 1;
      if (!check(!MatchCellInstallCapacityChallenge(changed, binding, ordinal))) return 5;
    }
    if (!check(!MatchCellInstallCapacityChallenge(expected, binding, ordinal == 1 ? 2 : 65535))) return 6;
  }
  for (unsigned mode = 0; mode < 8; ++mode) {
    auto changed = binding; auto ordinal = 1u;
    if (mode == 0) changed.connection.fill(0);
    if (mode == 1) changed.installation.nonce.fill(0);
    if (mode == 2) changed.installation.request_sha256.fill(0);
    if (mode == 3) changed.capture_sha256.fill(0);
    if (mode == 4) changed.byte_length = 0;
    if (mode == 5) changed.byte_length = static_cast<std::uint32_t>(kCellPoolCapacityResponseMaximumBytes + 1);
    if (mode == 6) ordinal = 0;
    if (mode == 7) ordinal = 65537;
    CellInstallCapacityChallenge output; output.fill(0xee);
    if (!check(!EncodeCellInstallCapacityChallenge(changed, ordinal, &output) && output == CellInstallCapacityChallenge{})) return 7;
  }
  CellFileSha256 digest; digest.fill(0xee);
  if (!check(HashCellInstallCapacityCapture({}, &digest) == ERROR_INVALID_PARAMETER && digest == CellFileSha256{}) ||
      !check(HashCellInstallCapacityCapture(std::vector<std::uint8_t>(kCellPoolCapacityResponseMaximumBytes + 1), &digest) == ERROR_INVALID_PARAMETER) ||
      !check(!EncodeCellInstallCapacityChallenge(binding, 1, nullptr))) return 8;
  std::cout << "{\"passed\":true,\"checks\":" << checks << ",\"installedService\":false,\"volumeOperations\":false}\n";
  return 0;
}
