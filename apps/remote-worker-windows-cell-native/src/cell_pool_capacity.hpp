#pragma once
#include "cell_provisioning_journal.hpp"

namespace goatcitadel::worker_cell {
struct CellControllerRequest;
struct CellControllerPoolHistory;
struct CellRuntimePoolCleanupSet;
struct CellRuntimeCleanupSet;
struct CellRuntimeCleanupAdmission;
inline constexpr std::size_t kCellCapacityPoolMaximumMembers = 64;
struct CellPoolCapacityMember final {
  CellProvisioningJournal* journal = nullptr;
  CellProvisioningAnchor anchor;
  CellFileIdentity workspace_root;
  CellFileSha256 head{}, assignment_binding{}, profile_sha256{};
};
struct CellPoolCapacity final {
  CellCapacityAreaInventories areas;
  std::vector<CellProvisioningBackingFootprint> backings;
};
struct CellPoolGuestMember final {
  CellPoolCapacityMember host;
  std::wstring cell_name;
  CellFootprintCellBinding binding;
};
struct CellPoolJoinedCapacity final {
  CellPoolCapacity host;
  std::vector<CellProvisioningInventory> guests;
};
// One host scan inside every member's nested backing/mount custody. The trusted
// caller must independently prove the complete member set, root ownership and
// global writer exclusion. This does not enumerate/adopt journals or grant
// installed readiness. No partial subset is returned on any failure. Calls are
// serialized under an outer watchdog; the member cap bounds native stack depth.
class CellPoolCapacityCollector final {
 public:
  static DWORD Capture(CellCapacityLayout&, const CellCapacityLayoutRecord&,
    std::span<const CellPoolCapacityMember>, const CellFootprintScanLimits&,
    const CellFootprintScanGuard&, CellPoolCapacity*, const CellCapacityCaptureObserver* = nullptr) noexcept;
  // Guest pins are acquired inside the held host scan and retained through all
  // host/member readback. Failure discards the entire joined pool observation.
  static DWORD CaptureJoined(CellCapacityLayout&, const CellCapacityLayoutRecord&,
    std::span<const CellPoolGuestMember>, const CellFootprintScanLimits&,
    const CellFootprintScanGuard&, CellPoolJoinedCapacity*) noexcept;
  // Reuse the current session journal and retain every other independently
  // recorded journal until the entire pool capture and final readback finish.
  // Reconcile both cleanup namespaces on each retained journal before scanning.
  // The caller still owns the stable lease and global writer exclusion.
  // This opens recorded objects only; it cannot provision or repair a member.
  static DWORD CaptureRecorded(HANDLE parent, CellProvisioningJournal& current,
    const CellControllerRequest&, const std::wstring& owner_sid, const std::wstring& controller_sid,
    CellCapacityLayout&, const CellCapacityLayoutRecord&, const CellFootprintScanLimits&,
    const CellFootprintScanGuard&, CellPoolJoinedCapacity*) noexcept;
 private:
  friend struct CellPoolCapacityCollectorTestPeer;
  struct RecordedOperations final {
    void* context;
    DWORD (*open)(void*, HANDLE, const CellControllerRequest&, const std::wstring&, const std::wstring&,
      CellProvisioningJournal&) noexcept;
    DWORD (*read)(void*, CellProvisioningJournal&, const CellControllerRequest&,
      CellWorkspaceIdentities*, CellWorkspaceIdentities*) noexcept;
    DWORD (*installations)(void*, CellProvisioningJournal&, const CellRuntimeCleanupSet&,
      const CellRuntimeCleanupAdmission&, const CellFootprintScanGuard&, DWORD) noexcept;
    DWORD (*runtime)(void*, CellProvisioningJournal&, const CellRuntimeCleanupSet&,
      const CellFootprintScanGuard&, DWORD) noexcept;
    DWORD (*capture)(void*, CellCapacityLayout&, const CellCapacityLayoutRecord&,
      std::span<const CellPoolGuestMember>, const CellFootprintScanLimits&,
      const CellFootprintScanGuard&, CellPoolJoinedCapacity*) noexcept;
  };
  static DWORD RunRecorded(const RecordedOperations&, HANDLE, CellProvisioningJournal&,
    const CellControllerRequest&, const CellControllerPoolHistory&, const CellRuntimePoolCleanupSet&, const std::wstring&, const std::wstring&,
    CellCapacityLayout&, const CellCapacityLayoutRecord&, const CellFootprintScanLimits&,
    const CellFootprintScanGuard&, CellPoolJoinedCapacity*) noexcept;
  struct Operations final {
    void* context = nullptr;
    DWORD (*borrow)(void*, std::size_t, const CellPoolCapacityMember&, DWORD,
      const CellFootprintScanGuard&, const CellProvisioningBackingObserver&, CellProvisioningBackingFootprint*) noexcept = nullptr;
    DWORD (*scan)(void*, const CellCapacityLayoutRecord&, const CellFootprintScanLimits&,
      const CellFootprintScanGuard&, CellCapacityAreaInventories*, const CellCapacityBorrowedFiles*,
      const CellCapacityCaptureObserver*) noexcept = nullptr;
  };
  struct NativeContext;
  struct JoinedObserver final {
    void* context;
    DWORD (*capture)(void*, const CellFootprintScanGuard&) noexcept;
    void (*discard)(void*) noexcept;
  };
  struct JoinedOperations final {
    void* context;
    DWORD (*host)(void*, const CellCapacityLayoutRecord&, std::span<const CellPoolCapacityMember>,
      const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellPoolCapacity*, const JoinedObserver&) noexcept;
    DWORD (*guest)(void*, std::size_t, const CellPoolGuestMember&, const CellFootprintScanLimits&,
      const CellFootprintScanGuard&, CellProvisioningInventory*) noexcept;
    DWORD (*check)(void*, std::size_t) noexcept;
    void (*close)(void*, std::size_t) noexcept;
  };
  static DWORD RunJoined(const JoinedOperations&, const CellCapacityLayoutRecord&, std::span<const CellPoolGuestMember>,
    const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellPoolJoinedCapacity*) noexcept;
  static DWORD Run(const Operations&, const CellCapacityLayoutRecord&, std::span<const CellPoolCapacityMember>,
    const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellPoolCapacity*, const CellCapacityCaptureObserver*) noexcept;
};
}
