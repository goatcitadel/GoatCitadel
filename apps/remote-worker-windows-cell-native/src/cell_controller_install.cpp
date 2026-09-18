#include "cell_controller_install.hpp"
#include "cell_runtime_result.hpp"
#include <algorithm>

namespace goatcitadel::worker_cell {
RuntimeBundleInstallResult InstallCellControllerRuntime(
  CellControllerIdentity& identity, CellProvisioningJournal& journal,
  std::span<const std::uint8_t> bytes, const CellRuntimeInstallBinding& expected,
  PinnedCellRuntimeBundle& output, DWORD wall_ms,
  const CellFootprintScanGuard& supplied_authority) noexcept {
  RuntimeBundleInstallResult result;
  if (output.Ready()) { result.error = ERROR_ALREADY_INITIALIZED; return result; }
  const auto authority = supplied_authority;
  if (!authority.authorize || !wall_ms || wall_ms > 60000) { result.error = ERROR_INVALID_PARAMETER; return result; }
  CellRuntimeInstallRequest request;
  result.error = DecodeCellRuntimeInstall(bytes, expected, &request);
  if (result.error) return result;
  std::array<std::uint8_t, kCellRuntimeInstallBytes> frozen{};
  std::copy(bytes.begin(), bytes.end(), frozen.begin());
  const auto deadline = GetTickCount64() + wall_ms;
  struct Guard final {
    CellControllerIdentity& identity;
    const CellRuntimeInstallRequest& request;
    const CellFootprintScanGuard authority;
    const ULONGLONG deadline;
    DWORD Control() const noexcept {
      if (authority.cancellation) {
        const auto state = WaitForSingleObject(authority.cancellation, 0);
        if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
      }
      return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
    }
    DWORD Verify() noexcept {
      auto error = Control();
      if (!error) error = identity.Verify(SERVICE_RUNNING);
      if (!error && (identity.RuntimeCustody().package_sha256 != request.package_sha256 ||
          identity.RuntimeCustody().bundle_sha256 != request.bundle_sha256)) error = ERROR_FILE_INVALID;
      return error ? error : Control();
    }
    static DWORD Authorize(void* raw) noexcept {
      auto& value = *static_cast<Guard*>(raw);
      auto error = value.Verify();
      if (!error) error = value.authority.authorize(value.authority.context);
      return error ? error : value.Verify();
    }
  } guard{identity, request, authority, deadline};
  result.error = Guard::Authorize(&guard);
  if (result.error) return result;
  PinnedCellRuntimeBundle source;
  result.error = identity.OpenRuntimeBundle(request.files, source, authority.cancellation);
  if (!result.error) result.error = Guard::Authorize(&guard);
  if (result.error) return result;
  CellRuntimeLocalOutcome local;
  result.error = local.BeginInstall(journal, frozen, request.binding);
  if (result.error) return result;
  result.error = Guard::Authorize(&guard);
  const auto now = GetTickCount64();
  if (!result.error && now >= deadline) result.error = ERROR_TIMEOUT;
  const CellFootprintScanGuard current{Guard::Authorize, &guard, authority.cancellation};
  if (!result.error) result = journal.InstallRuntime({request.journal_identity, request.prepared_sha256}, request.checkpoint_sha256,
    source, output, static_cast<DWORD>(deadline - now), current);
  if (!result.error) result.error = Guard::Authorize(&guard);
  if (!result.error && (!result.verified || !output.Ready())) result.error = ERROR_INVALID_STATE;
  if (result.error) { result.verified = false; output.Reset(); }
  CellRuntimeInstallLocalRecord retained;
  const auto retention_error = local.RetainInstall(result, &retained);
  if (retention_error || !retained.outcome_retained) {
    result.error = retention_error ? retention_error : ERROR_INVALID_DATA;
    result.verified = false; output.Reset();
  }
  return result;
}
}  // namespace goatcitadel::worker_cell
