#pragma once
#include "cell_controller_install.hpp"
#include "cell_installed_pool_capacity.hpp"

namespace goatcitadel::worker_cell {
// The trusted admission owner binds a reservation to the exact fresh capture
// and installation request, retains canonical authority, and releases its own
// reservation on destruction. This is not a stored acceptance receipt.
class CellInstallCapacityReservation {
 public:
  virtual ~CellInstallCapacityReservation() = default;
  virtual DWORD Verify() noexcept = 0;
};
struct CellInstallCapacityAdmission final {
  void* context = nullptr;
  DWORD (*reserve)(void*, const CellControllerRequest&, const CellCapacityLayoutRecord&,
    const CellPoolJoinedCapacity&, ULONGLONG deadline,
    std::unique_ptr<CellInstallCapacityReservation>*) noexcept = nullptr;
};
class CellInstallCapacity final {
 public:
  // The caller retains actual native writer exclusion through this operation
  // AND terminal receipt handling. Capture, admission and copy share one bounded
  // window. Operation 21 carries independently reviewed installation metadata
  // alongside original operation-20 pool history. Internal callers may supply
  // that composite directly. Missing reservation ownership refuses before copy.
  static RuntimeBundleInstallResult Install(CellControllerIdentity&, CellProvisioningJournal&,
    const CellControllerRequest&, CellControllerMeasurementHold&, const CellFootprintScanLimits&,
    const CellFootprintScanGuard&, const CellInstallCapacityAdmission&, PinnedCellRuntimeBundle&) noexcept;
 private:
  friend struct CellInstallCapacityTestPeer;
  struct Operations final {
    void* context;
    DWORD (*capture)(void*, CellProvisioningJournal&, const CellControllerRequest&, const CellFootprintScanLimits&,
      const CellFootprintScanGuard&, CellCapacityLayoutRecord*, CellPoolJoinedCapacity*) noexcept;
    RuntimeBundleInstallResult (*copy)(void*, CellProvisioningJournal&, const CellControllerRequest&, DWORD,
      const CellFootprintScanGuard&, PinnedCellRuntimeBundle&) noexcept;
  };
  static RuntimeBundleInstallResult Run(const Operations&, CellProvisioningJournal&, const CellControllerRequest&,
    CellControllerMeasurementHold&, const CellFootprintScanLimits&, const CellFootprintScanGuard&,
    const CellInstallCapacityAdmission&, PinnedCellRuntimeBundle&) noexcept;
};
}
