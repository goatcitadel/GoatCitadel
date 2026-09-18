#include "cell_mounted_workspace.hpp"
#include "cell_capacity.hpp"
#include "cell_runtime_bundle.hpp"
#include <type_traits>
#include <utility>

namespace goatcitadel::worker_cell {
namespace {
  struct MountedCapacityContext final {
    CellMountedWorkspace* owner;
    CellVolumeMount* mount;
    CellVolumeProtection* protection;
    CellWorkspaceDirectories* host;
    static DWORD Verify(void* raw, DWORD remaining, HANDLE cancellation) noexcept {
      const auto& value = *static_cast<MountedCapacityContext*>(raw);
      return value.owner->Verify(*value.mount, *value.protection, *value.host, remaining, cancellation);
    }
  };
}
DWORD CellMountedWorkspace::ObserveFootprint(CellVolumeMount& mount, CellVolumeProtection& protection,
  CellWorkspaceDirectories& host, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryFootprint* output) noexcept {
  MountedCapacityContext context{this, &mount, &protection, &host};
  return ReadFootprint(MountedCapacityContext::Verify, &context, limits, guard, output);
}
DWORD CellMountedWorkspace::ObserveInventory(CellVolumeMount& mount, CellVolumeProtection& protection,
  CellWorkspaceDirectories& host, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryInventory* output) noexcept {
  MountedCapacityContext context{this, &mount, &protection, &host};
  return ReadInventory(MountedCapacityContext::Verify, &context, limits, guard, output);
}

DWORD CellMountedWorkspace::CaptureInventory(CellVolumeMount& mount, CellVolumeProtection& protection,
  CellWorkspaceDirectories& host, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryInventoryPins& pins, CellDirectoryInventory* output) noexcept {
  MountedCapacityContext context{this, &mount, &protection, &host};
  return ReadRetainedInventory(MountedCapacityContext::Verify, &context, limits, guard, pins, output);
}

template <typename Output, typename Operation>
DWORD CellMountedWorkspace::OperateRecordedWorkspace(DWORD (*verify)(void*, DWORD, HANDLE) noexcept, void* verify_context,
  DWORD wall_limit_ms, const CellFootprintScanGuard& supplied_guard,
  Output* output, Operation operation, bool mutating) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto guard = supplied_guard;
  const auto deadline = GetTickCount64() + wall_limit_ms;
  *output = {};
  try {
    if (!verify || !guard.authorize || !wall_limit_ms || wall_limit_ms > 60000) return ERROR_INVALID_PARAMETER;
    if (guard.cancellation == INVALID_HANDLE_VALUE || guard.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    if (state_ != CellMountedWorkspaceState::recorded) return ERROR_INVALID_STATE;
    CellWorkspaceIdentities recorded;
    auto error = DecodeCellMountedWorkspaceCheckpoints(binding_, records_, &recorded);
    if (error) return error;
    if (recorded != identities_) return ERROR_FILE_INVALID;
    struct Context final {
      CellMountedWorkspace* owner;
      DWORD (*verify)(void*, DWORD, HANDLE) noexcept;
      void* verify_context;
      CellMountedWorkspaceBinding binding;
      CellWorkspaceIdentities recorded;
      std::vector<CellMountedWorkspaceCheckpoint> records;
      CellFootprintScanGuard guard;
      ULONGLONG deadline;
      DWORD Control() const noexcept {
        if (guard.cancellation) {
          const auto state = WaitForSingleObject(guard.cancellation, 0);
          if (state == WAIT_FAILED) return ERROR_INVALID_HANDLE;
          if (state != WAIT_TIMEOUT) return ERROR_CANCELLED;
        }
        return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
      }
      bool Matches() const noexcept {
        return owner->state_ == CellMountedWorkspaceState::recorded && owner->identities_ == recorded && owner->records_ == records &&
          owner->binding_.mount_sha256 == binding.mount_sha256 && owner->binding_.security_sha256 == binding.security_sha256 &&
          owner->binding_.volume_root == binding.volume_root && owner->binding_.cell_name == binding.cell_name;
      }
      DWORD Verify() const noexcept {
        auto error = Control();
        if (error) return error;
        if (!Matches()) return ERROR_FILE_INVALID;
        const auto now = GetTickCount64();
        if (now >= deadline) return ERROR_TIMEOUT;
        error = verify(verify_context, static_cast<DWORD>(deadline - now), guard.cancellation);
        if (error) return error;
        if (!Matches()) return ERROR_FILE_INVALID;
        return Control();
      }
      static DWORD Authorize(void* raw) noexcept {
        const auto& value = *static_cast<Context*>(raw);
        auto error = value.Control();
        if (!error) error = value.guard.authorize(value.guard.context);
        return error ? error : value.Verify();
      }
    } context{this, verify, verify_context, binding_, recorded, records_, guard, deadline};
    error = Context::Authorize(&context);
    if (error) return error;
    Output result;
    const auto now = GetTickCount64(); if (now >= deadline) return ERROR_TIMEOUT;
    error = operation(contents_, context.recorded, static_cast<DWORD>(deadline - now),
      {Context::Authorize, &context, guard.cancellation}, &result);
    if (!error) error = mutating ? Context::Authorize(&context) : context.Verify();
    // Mutation counters describe retained disk state even on refusal. Read-only
    // observations continue to withhold all incomplete evidence.
    if (!error || mutating) *output = std::move(result);
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
template <typename Output, typename Scan>
DWORD CellMountedWorkspace::ReadCapacity(DWORD (*verify)(void*, DWORD, HANDLE) noexcept, void* context,
  const CellFootprintScanLimits& supplied_limits, const CellFootprintScanGuard& guard,
  Output* output, Scan scan, std::uint32_t maximum_entries) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  const auto limits = supplied_limits;
  if constexpr (std::is_pointer_v<Scan>) { if (!scan) return ERROR_INVALID_PARAMETER; }
  if (!limits.max_entries || limits.max_entries > maximum_entries || limits.max_depth > 64) return ERROR_INVALID_PARAMETER;
  return OperateRecordedWorkspace(verify, context, limits.wall_limit_ms, guard, output,
    [&](CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities& recorded, DWORD wall,
        const CellFootprintScanGuard& authority, Output* result) noexcept {
      auto remaining = limits; remaining.wall_limit_ms = wall;
      return scan(workspace, recorded, remaining, authority, result);
    }, false);
}
RuntimeBundleInstallResult CellMountedWorkspace::InstallRuntime(CellVolumeMount& mount, CellVolumeProtection& protection,
    CellWorkspaceDirectories& host, PinnedCellRuntimeBundle& source, PinnedCellRuntimeBundle& output,
    DWORD wall_limit_ms, const CellFootprintScanGuard& guard) noexcept {
  MountedCapacityContext context{this, &mount, &protection, &host};
  return InstallRuntimeOwned(MountedCapacityContext::Verify, &context, source, output, wall_limit_ms, guard);
}
RuntimeBundleInstallResult CellMountedWorkspace::InstallRuntimeOwned(DWORD (*verify)(void*, DWORD, HANDLE) noexcept, void* context,
    PinnedCellRuntimeBundle& source, PinnedCellRuntimeBundle& output, DWORD wall_limit_ms, const CellFootprintScanGuard& guard) noexcept {
  RuntimeBundleInstallResult result;
  if (output.Ready()) { result.error = ERROR_ALREADY_INITIALIZED; return result; }
  const auto error = OperateRecordedWorkspace(verify, context, wall_limit_ms, guard, &result,
    [&](CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities&, DWORD,
        const CellFootprintScanGuard& authority, RuntimeBundleInstallResult* copied) noexcept {
      *copied = source.InstallTo(workspace, output, authority); return copied->error;
    }, true);
  if (error) { result.error = error; result.verified = false; output.Reset(); }
  return result;
}
DWORD CellMountedWorkspace::ReadFootprint(DWORD (*verify)(void*, DWORD, HANDLE) noexcept, void* context,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, CellDirectoryFootprint* output) noexcept {
  return ReadCapacity(verify, context, limits, guard, output, ScanCellWorkspaceFootprint, 65536);
}
DWORD CellMountedWorkspace::ReadInventory(DWORD (*verify)(void*, DWORD, HANDLE) noexcept, void* context,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, CellDirectoryInventory* output) noexcept {
  return ReadCapacity(verify, context, limits, guard, output, ScanCellWorkspaceInventory, 20000);
}
DWORD CellMountedWorkspace::ReadRetainedInventory(DWORD (*verify)(void*, DWORD, HANDLE) noexcept, void* context,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryInventoryPins& pins, CellDirectoryInventory* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (pins.Ready()) return ERROR_ALREADY_INITIALIZED;
  auto error = ReadCapacity(verify, context, limits, guard, output,
    [&pins](CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities& recorded,
      const CellFootprintScanLimits& remaining, const CellFootprintScanGuard& authority, CellDirectoryInventory* inventory) noexcept {
      return CaptureCellWorkspaceInventory(workspace, recorded, remaining, authority, pins, inventory);
    }, 20000);
  if (!error) error = pins.Check();
  if (error) { *output = {}; pins.Close(); }
  return error;
}
}
