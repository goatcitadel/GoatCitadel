#pragma once
#include "cell_controller_protocol.hpp"
#include "cell_pool_capacity.hpp"

namespace goatcitadel::worker_cell {
// Installed single-cell observations (operations 14, 15 and 16). Each requires
// the measurement hold the session acquired and retains for this request and
// rechecks it before the journal's read-only observation. An absent hold
// refuses with ERROR_NOT_SUPPORTED before any journal access; outputs clear.
class CellInstalledCapacity final {
 public:
  static DWORD Observe(CellControllerMeasurementHold*, CellProvisioningJournal&, const CellProvisioningAnchor&,
    const CellFileSha256&, const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellProvisioningFootprint*) noexcept;
  static DWORD ObserveBacking(CellControllerMeasurementHold*, CellProvisioningJournal&, const CellProvisioningAnchor&,
    const CellFileSha256&, DWORD wall_ms, const CellFootprintScanGuard&, CellProvisioningBackingFootprint*) noexcept;
  static DWORD ObserveInventory(CellControllerMeasurementHold*, CellProvisioningJournal&, const CellProvisioningAnchor&,
    const CellFileSha256&, const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellProvisioningInventory*) noexcept;
};
class CellInstalledPoolCapacity final {
 public:
  // Requires the session's retained measurement hold and current-authority
  // guard. Roots come only from installed identity; no path adoption or repair.
  static DWORD Capture(CellControllerIdentity&, CellProvisioningJournal&, const CellControllerRequest&,
    const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellCapacityLayoutRecord*, CellPoolJoinedCapacity*) noexcept;
 private:
  friend struct CellInstalledPoolCapacityTestPeer;
  struct Operations final {
    void* context;
    DWORD (*roots)(void*, CellCapacityAreaRoots*) noexcept;
    DWORD (*open)(void*, CellCapacityLayout&, const CellCapacityLayoutRecord&, const CellCapacityAreaRoots&) noexcept;
    DWORD (*capture)(void*, HANDLE, CellProvisioningJournal&, const CellControllerRequest&, CellCapacityLayout&,
      const CellCapacityLayoutRecord&, const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellPoolJoinedCapacity*) noexcept;
  };
  static DWORD Run(const Operations&, CellProvisioningJournal&, const CellControllerRequest&,
    const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellCapacityLayoutRecord*, CellPoolJoinedCapacity*) noexcept;
};
}
