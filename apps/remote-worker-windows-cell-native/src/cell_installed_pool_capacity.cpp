#include "cell_installed_pool_capacity.hpp"

namespace goatcitadel::worker_cell {
DWORD CellInstalledPoolCapacity::Capture(CellControllerIdentity& identity, CellProvisioningJournal& journal,
  const CellControllerRequest& request, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellCapacityLayoutRecord* record, CellPoolJoinedCapacity* output) noexcept {
  const Operations operations{&identity,
    [](void* raw, CellCapacityAreaRoots* roots) noexcept -> DWORD {
      return static_cast<CellControllerIdentity*>(raw)->ReadCapacityRoots(*roots);
    },
    [](void* raw, CellCapacityLayout& layout, const CellCapacityLayoutRecord& record, const CellCapacityAreaRoots& roots) noexcept -> DWORD {
      return layout.OpenRecordedWithSecurity(record, roots, static_cast<CellControllerIdentity*>(raw)->CapacityRootSecurity());
    },
    [](void*, HANDLE parent, CellProvisioningJournal& journal, const CellControllerRequest& request,
      CellCapacityLayout& layout, const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits,
      const CellFootprintScanGuard& guard, CellPoolJoinedCapacity* output) noexcept -> DWORD {
      return CellPoolCapacityCollector::CaptureRecorded(parent, journal, request, L"S-1-5-18", kCellControllerServiceSid,
        layout, record, limits, guard, output);
    }};
  return Run(operations, journal, request, limits, guard, record, output);
}
DWORD CellInstalledPoolCapacity::Run(const Operations& supplied, CellProvisioningJournal& journal,
  const CellControllerRequest& supplied_request, const CellFootprintScanLimits& supplied_limits, const CellFootprintScanGuard& supplied_guard,
  CellCapacityLayoutRecord* record, CellPoolJoinedCapacity* output) noexcept {
  if (record) *record = {};
  if (output) *output = {};
  if (!record || !output) return ERROR_INVALID_PARAMETER;
  try {
    const auto operations = supplied; const auto request = supplied_request;
    auto limits = supplied_limits; const auto guard = supplied_guard;
    if (!operations.roots || !operations.open || !operations.capture || !guard.authorize ||
        !IsCellControllerPoolCapacity(request.operation) || !limits.max_entries || limits.max_entries > 20000 ||
        !limits.max_depth || limits.max_depth > 64 || !limits.wall_limit_ms || limits.wall_limit_ms > 60000) return ERROR_INVALID_PARAMETER;
    const auto deadline = GetTickCount64() + limits.wall_limit_ms;
    const auto check = [&]() noexcept -> DWORD {
      if (guard.cancellation && WaitForSingleObject(guard.cancellation, 0) != WAIT_TIMEOUT) return ERROR_OPERATION_ABORTED;
      if (GetTickCount64() >= deadline) return ERROR_TIMEOUT;
      const auto error = guard.authorize(guard.context);
      if (error) return error;
      if (guard.cancellation && WaitForSingleObject(guard.cancellation, 0) != WAIT_TIMEOUT) return ERROR_OPERATION_ABORTED;
      return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
    };
    auto error = check();
    CellCapacityAreaRoots roots;
    if (!error) error = operations.roots(operations.context, &roots);
    if (!error) error = check();
    CellCapacityLayoutRecord bound;
    bound.assignment_binding = request.plan.assignment_binding; bound.profile_sha256 = request.plan.profile_sha256;
    if (!error) {
      for (std::size_t i = 0; i < roots.size(); ++i) {
        if (!roots[i].handle || roots[i].handle == INVALID_HANDLE_VALUE || roots[i].identity == CellFileIdentity{}) return ERROR_INVALID_HANDLE;
        bound.roots[i] = roots[i].identity;
      }
      if (bound.roots[0] != request.parent) return ERROR_FILE_INVALID;
    }
    CellCapacityLayout layout;
    if (!error) error = operations.open(operations.context, layout, bound, roots);
    if (!error) error = check();
    CellPoolJoinedCapacity captured;
    if (!error) {
      const auto now = GetTickCount64();
      if (now >= deadline) return ERROR_TIMEOUT;
      limits.wall_limit_ms = static_cast<DWORD>(deadline - now);
      error = operations.capture(operations.context, roots[0].handle, journal, request, layout, bound, limits, guard, &captured);
    }
    if (!error) error = check();
    if (error) return error;
    *record = bound; *output = std::move(captured);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
}
