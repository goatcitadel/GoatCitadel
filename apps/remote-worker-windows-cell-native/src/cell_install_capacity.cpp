#include "cell_install_capacity.hpp"

namespace goatcitadel::worker_cell {
RuntimeBundleInstallResult CellInstallCapacity::Install(CellControllerIdentity& identity, CellProvisioningJournal& journal,
    const CellControllerRequest& request, CellControllerMeasurementHold& hold, const CellFootprintScanLimits& limits,
    const CellFootprintScanGuard& authority, const CellInstallCapacityAdmission& admission, PinnedCellRuntimeBundle& output) noexcept {
  return Run({&identity,
    [](void* raw, CellProvisioningJournal& journal, const CellControllerRequest& request, const CellFootprintScanLimits& limits,
        const CellFootprintScanGuard& guard, CellCapacityLayoutRecord* layout, CellPoolJoinedCapacity* captured) noexcept -> DWORD {
      return CellInstalledPoolCapacity::Capture(*static_cast<CellControllerIdentity*>(raw), journal, request, limits, guard, layout, captured);
    },
    [](void* raw, CellProvisioningJournal& journal, const CellControllerRequest& request, DWORD wall_ms,
        const CellFootprintScanGuard& guard, PinnedCellRuntimeBundle& output) noexcept -> RuntimeBundleInstallResult {
      return InstallCellControllerRuntime(*static_cast<CellControllerIdentity*>(raw), journal, request.installation_bytes,
        {request.installation.nonce, request.installation.request_sha256}, output, wall_ms, guard);
    }}, journal, request, hold, limits, authority, admission, output);
}
RuntimeBundleInstallResult CellInstallCapacity::Run(const Operations& supplied_operations, CellProvisioningJournal& journal,
    const CellControllerRequest& supplied_request, CellControllerMeasurementHold& hold, const CellFootprintScanLimits& supplied_limits,
    const CellFootprintScanGuard& supplied_authority, const CellInstallCapacityAdmission& supplied_admission, PinnedCellRuntimeBundle& output) noexcept {
  RuntimeBundleInstallResult result;
  if (output.Ready()) { result.error = ERROR_ALREADY_INITIALIZED; return result; }
  try {
    const auto operations = supplied_operations; const auto request = supplied_request;
    const auto authority = supplied_authority; const auto admission = supplied_admission; auto limits = supplied_limits;
    if (!operations.capture || !operations.copy || !authority.authorize || !admission.reserve ||
        !IsCellControllerPoolCapacity(request.operation) || !limits.max_entries || limits.max_entries > 20000 ||
        !limits.max_depth || limits.max_depth > 64 || !limits.wall_limit_ms || limits.wall_limit_ms > 60000) {
      result.error = ERROR_INVALID_PARAMETER; return result;
    }
    auto installation = request; installation.operation = kCellControllerInstallOperation;
    if (!ValidateCellControllerInstallRequest(installation)) { result.error = ERROR_INVALID_DATA; return result; }
    CellRuntimeInstallRequest decoded;
    result.error = DecodeCellRuntimeInstall(request.installation_bytes,
      {request.installation.nonce, request.installation.request_sha256}, &decoded);
    if (result.error) return result;
    const auto deadline = GetTickCount64() + limits.wall_limit_ms;
    std::unique_ptr<CellInstallCapacityReservation> reservation;
    struct Guard final {
      CellControllerMeasurementHold& hold;
      const CellFootprintScanGuard authority;
      const ULONGLONG deadline;
      std::unique_ptr<CellInstallCapacityReservation>& reservation;
      DWORD Control() const noexcept {
        if (authority.cancellation && WaitForSingleObject(authority.cancellation, 0) != WAIT_TIMEOUT) return ERROR_OPERATION_ABORTED;
        return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
      }
      static DWORD Check(void* raw) noexcept {
        auto& self = *static_cast<Guard*>(raw);
        auto error = self.Control();
        if (!error) error = self.hold.Verify();
        if (!error) error = self.authority.authorize(self.authority.context);
        if (!error && self.reservation) error = self.reservation->Verify();
        if (!error) error = self.hold.Verify();
        return error ? error : self.Control();
      }
    } guard{hold, authority, deadline, reservation};
    const CellFootprintScanGuard current{Guard::Check, &guard, authority.cancellation};
    CellCapacityLayoutRecord layout; CellPoolJoinedCapacity captured;
    auto capture_request = request;
    capture_request.operation = kCellControllerPoolCapacityOperation;
    capture_request.installation = {}; capture_request.installation_bytes = {};
    result.error = Guard::Check(&guard);
    if (!result.error) result.error = operations.capture(operations.context, journal, capture_request, limits, current, &layout, &captured);
    if (!result.error) result.error = Guard::Check(&guard);
    if (!result.error) result.error = admission.reserve(admission.context, request, layout, captured, deadline, &reservation);
    if (!result.error && !reservation) result.error = ERROR_INVALID_STATE;
    if (!result.error) result.error = Guard::Check(&guard);
    if (!result.error) {
      const auto now = GetTickCount64();
      if (now >= deadline) result.error = ERROR_TIMEOUT;
      else result = operations.copy(operations.context, journal, request, static_cast<DWORD>(deadline - now), current, output);
    }
    if (!result.error) result.error = Guard::Check(&guard);
    if (!result.error && (!result.verified || result.files_created != 2 || result.directories_created ||
        result.bytes_written != decoded.files[0].bytes + decoded.files[1].bytes)) result.error = ERROR_INVALID_DATA;
  } catch (...) { result.error = ERROR_NOT_ENOUGH_MEMORY; }
  if (result.error) { result.verified = false; output.Reset(); }
  return result;
}
}
