#include "cell_runtime_install.hpp"
#include "cell_controller_install.hpp"
#include "cell_controller_protocol.hpp"
#include <fstream>
#include <iostream>
#include <filesystem>
#include <algorithm>
using namespace goatcitadel::worker_cell;

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 1;
  std::ifstream stream(std::filesystem::path(argv[1]), std::ios::binary);
  std::vector<std::uint8_t> fixture((std::istreambuf_iterator<char>(stream)), {});
  if (fixture.size() != 64 + kCellRuntimeInstallBytes) return 2;
  CellRuntimeInstallBinding binding;
  std::copy_n(fixture.begin(), 32, binding.nonce.begin());
  std::copy_n(fixture.begin() + 32, 32, binding.request_sha256.begin());
  const std::vector<std::uint8_t> bytes(fixture.begin() + 64, fixture.end());
  CellRuntimeInstallRequest result;
  unsigned checks = 0;
  const auto check = [&](bool passed) { ++checks; return passed; };
  CellFileSha256 digest{};
  if (!check(HashCellRuntimeInstall(bytes, &digest) == 0 && digest == binding.request_sha256) ||
      !check(DecodeCellRuntimeInstall(bytes, binding, &result) == 0) ||
      !check(result.files.size() == 2 && result.files[0].relative_path == L"node.exe" &&
        result.files[0].bytes == 123456 && result.files[1].bytes == 789 &&
        result.files[1].relative_path == L"worker-host-receipt.json") ||
      !check(result.journal_identity.volume_serial == 0x2222222222222222ull) ||
      !check(result.prepared_sha256[0] == 0x33 && result.checkpoint_sha256[0] == 0x44 && result.package_sha256[0] == 0x55)) return 3;
  // A failed decode must not leave a prior successful request publishable.
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    auto changed = bytes; changed[index] ^= 1;
    if (!check(DecodeCellRuntimeInstall(changed, binding, &result) != 0 && result.files.empty() && result.binding.request_sha256 == CellFileSha256{})) return 4;
    if (!check(DecodeCellRuntimeInstall(std::span(bytes).first(index), binding, &result) != 0)) return 5;
  }
  auto extra = bytes; extra.push_back(0);
  if (!check(DecodeCellRuntimeInstall(extra, binding, &result) != 0)) return 6;
  // Invalid structure stays invalid even with a correctly rehashed binding.
  const std::pair<std::size_t, std::size_t> zero_ranges[] = {
    {40,48}, {48,64}, {64,96}, {96,128}, {128,160}, {160,192},
    {192,200}, {200,232}, {232,240}, {240,272},
  };
  for (const auto [begin, end] : zero_ranges) {
    auto changed = bytes; std::fill(changed.begin() + begin, changed.begin() + end, std::uint8_t{0});
    auto rebound = binding;
    if (!check(HashCellRuntimeInstall(changed, &rebound.request_sha256) == 0) ||
        !check(DecodeCellRuntimeInstall(changed, rebound, &result) != 0 && result.files.empty())) return 7;
  }
  auto changed = bytes; std::fill(changed.begin() + 192, changed.begin() + 200, std::uint8_t{255});
  auto rebound = binding;
  if (!check(HashCellRuntimeInstall(changed, &rebound.request_sha256) == 0) ||
      !check(DecodeCellRuntimeInstall(changed, rebound, &result) != 0)) return 8;
  if (!check(DecodeCellRuntimeInstall(bytes, binding, &result) == 0) ||
      !check(DecodeCellRuntimeInstall(bytes, result.binding, &result) == 0)) return 9;
  rebound = binding; rebound.nonce[0] ^= 1;
  if (!check(DecodeCellRuntimeInstall(bytes, rebound, &result) != 0) ||
      !check(DecodeCellRuntimeInstall(bytes, binding, nullptr) != 0)) return 10;
  CellControllerIdentity identity;
  CellProvisioningJournal journal;
  PinnedCellRuntimeBundle output;
  unsigned authorizations = 0;
  const CellFootprintScanGuard authority{[](void* context) noexcept -> DWORD {
    ++*static_cast<unsigned*>(context); return ERROR_SUCCESS;
  }, &authorizations};
  const auto rejected = [&](std::span<const std::uint8_t> wire, const CellRuntimeInstallBinding& expected,
      DWORD wall, const CellFootprintScanGuard& guard, DWORD expected_error) {
    const auto installed = InstallCellControllerRuntime(identity, journal, wire, expected, output, wall, guard);
    return installed.error == expected_error && !installed.verified && !installed.bytes_written &&
      !installed.files_created && !installed.directories_created && !output.Ready() && authorizations == 0;
  };
  if (!check(rejected(bytes, binding, 1000, {}, ERROR_INVALID_PARAMETER)) ||
      !check(rejected(bytes, binding, 0, authority, ERROR_INVALID_PARAMETER)) ||
      !check(rejected(bytes, binding, 60001, authority, ERROR_INVALID_PARAMETER)) ||
      !check(rejected(std::span(bytes).first(271), binding, 1000, authority, ERROR_INVALID_PARAMETER)) ||
      !check(rejected(bytes, rebound, 1000, authority, ERROR_INVALID_DATA)) ||
      !check(rejected(bytes, binding, 1000, authority, ERROR_INVALID_STATE))) return 11;
  HANDLE cancelled = CreateEventW(nullptr, TRUE, TRUE, nullptr);
  if (!cancelled) return 12;
  auto cancelled_authority = authority; cancelled_authority.cancellation = cancelled;
  const bool cancel_ok = rejected(bytes, binding, 1000, cancelled_authority, ERROR_CANCELLED);
  CloseHandle(cancelled);
  if (!check(cancel_ok)) return 13;
  if (!check(DecodeCellRuntimeInstall(bytes, binding, &result) == 0)) return 14;
  CellControllerRequest install_request;
  install_request.operation = kCellControllerInstallOperation;
  install_request.nonce.fill(0x88);
  install_request.anchor = {result.journal_identity, result.prepared_sha256};
  install_request.installation = {binding.nonce, binding.request_sha256, result.checkpoint_sha256};
  std::copy(bytes.begin(), bytes.end(), install_request.installation_bytes.begin());
  std::copy(result.checkpoint_sha256.begin(), result.checkpoint_sha256.end(), install_request.mounted_workspace_records.back().begin() + 992);
  if (!check(ValidateCellControllerInstallRequest(install_request)) ||
      !check(IsCellControllerMountedWorkspace(18) && IsCellControllerMount(18) && IsCellControllerProtection(18) &&
        IsCellControllerFormat(18) && IsCellControllerVolume(18) && !IsCellControllerCreation(18) && !IsCellControllerRuntime(18))) return 15;
  for (unsigned index = 0; index < 6; ++index) {
    auto changed_request = install_request;
    if (index == 0) changed_request.operation = 17;
    if (index == 1) changed_request.anchor.file.file_id[0] ^= 1;
    if (index == 2) changed_request.anchor.prepared_sha256[0] ^= 1;
    if (index == 3) changed_request.installation.request_sha256[0] ^= 1;
    if (index == 4) changed_request.installation.checkpoint_sha256[0] ^= 1;
    if (index == 5) changed_request.mounted_workspace_records.back()[992] ^= 1;
    if (!check(!ValidateCellControllerInstallRequest(changed_request))) return 16;
  }
  std::cout << "{\"passed\":true,\"checks\":" << checks << ",\"volumeOperations\":false,\"serviceInstalled\":false}\n";
  return 0;
}
