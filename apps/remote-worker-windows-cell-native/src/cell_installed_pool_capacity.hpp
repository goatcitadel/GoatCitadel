#pragma once
#include "cell_controller_protocol.hpp"
#include "cell_pool_capacity.hpp"

namespace goatcitadel::worker_cell {
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
