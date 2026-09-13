#pragma once
#include "cell_virtual_disk_device.hpp"
#include <winioctl.h>

namespace goatcitadel::worker_cell {
struct CellDiskLayoutPlan final {
  CellVirtualDiskRecord disk;
  GUID gpt_disk_id{}, data_partition_id{};
};
// These identifiers must be frozen by the canonical provisioning owner before
// creation. They are never inferred from the disk being inspected.
bool IsValidCellDiskLayoutPlan(const CellDiskLayoutPlan& plan) noexcept;
// Same domain-separated native-GUID derivation as the Gateway contract. Binding
// and profile bytes must come from the independently retained provisioning plan.
DWORD DeriveCellDiskLayoutPlan(const CellVirtualDiskRecord& disk, const CellFileSha256& assignment_binding,
                              const CellFileSha256& profile, CellDiskLayoutPlan* output) noexcept;

struct CellDiskLayoutSnapshot final {
  std::uint64_t usable_start = 0, usable_length = 0;
  GUID reserved_id{};
  std::uint64_t reserved_start = 0, reserved_length = 0, reserved_attributes = 0;
  std::array<wchar_t, 36> reserved_name{};
  std::uint64_t data_start = 0, data_length = 0;
};
using CellDiskLayoutCheckpoint = std::array<std::uint8_t, 512>;
enum class CellDiskLayoutPhase : unsigned { initialize_intent = 1, initialized, partition_intent, partitioned };
struct CellDiskLayoutCommitter final {
  // Persist the exact checkpoint independently, with assignment/lease authority,
  // before acknowledging its trailing SHA256. A lost acknowledgement stops the
  // operation. The callback must enforce its own bounded deadline.
  DWORD (*commit)(void*, const CellDiskLayoutCheckpoint&, CellFileSha256*) noexcept = nullptr;
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};
enum class CellDiskLayoutState { not_started, unknown, partitioned };

// Bounded decoders/planners only. Neither API opens a device or confers authority.
DWORD InspectCellDiskLayout(std::span<const std::uint8_t> bytes, const CellDiskLayoutPlan& plan,
                           bool partitioned, CellDiskLayoutSnapshot* output) noexcept;
DWORD DecodeCellDiskLayoutCheckpoints(const CellDiskLayoutPlan& plan,
  std::span<const CellDiskLayoutCheckpoint> records, CellDiskLayoutSnapshot* output) noexcept;
// Metadata validation for a retained nonempty prefix. This does not make an
// interrupted layout recoverable or authorize another write.
DWORD ValidateCellDiskLayoutCheckpointPrefix(const CellDiskLayoutPlan& plan,
  std::span<const CellDiskLayoutCheckpoint> records, CellDiskLayoutSnapshot* output) noexcept;

// Internal fresh-provisioning primitive: only a verified VHDX device can enter.
// The canonical owner must hold exclusive provisioning/zero-workload authority,
// retain the frozen plan, and supply current authorization plus durable commits.
// Create checks RAW, records intent, initializes GPT, waits for volume readiness,
// preserves the observed Microsoft reserved partition, then records intent and
// adds exactly one basic-data partition without an automatic drive letter.
// Every write is followed by exact readback and an independently committed record.
// OpenRecorded only verifies a complete four-record chain; it cannot resume writes.
// Failures retain the disk, attachment and uncertain outcome; no retry, repair,
// format, mount, detach, quota, workload or backend activation occurs here.
// Calls must be serialized. Driver cancellation joins pending I/O; synchronous
// driver calls and durable callbacks still require the controller outer watchdog.
class CellVirtualDiskLayout final {
 public:
  DWORD Create(CellVirtualDiskDevice& source, CellWorkspaceDirectories& workspace,
               const CellDiskLayoutPlan& plan, const CellDiskLayoutCommitter& committer,
               DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD OpenRecorded(CellVirtualDiskDevice& source, CellWorkspaceDirectories& workspace,
                     const CellDiskLayoutPlan& plan, std::span<const CellDiskLayoutCheckpoint> records,
                     DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD RecordCheckpoints(std::vector<CellDiskLayoutCheckpoint>* output) const noexcept;
  CellDiskLayoutState State() const noexcept { return state_; }
  void Close() noexcept;

 private:
  friend class CellVirtualDiskVolume;
  friend class CellNtfsFormat;
  friend struct CellVirtualDiskVolumeTestPeer;
  friend struct CellVirtualDiskLayoutTestPeer;
  // Internal ports let component tests drive the real sequencing without opening
  // physical devices. Production constructs them only from its owned device.
  struct Operations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*io)(void*, DWORD, std::span<const std::uint8_t>, std::span<std::uint8_t>, DWORD*) noexcept;
    void* context;
  };
  struct NativeContext;
  static Operations NativeOperations(NativeContext& context) noexcept;
  DWORD Bind(CellVirtualDiskDevice& source, CellWorkspaceDirectories& workspace,
             const CellDiskLayoutPlan& plan, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Commit(CellDiskLayoutPhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Inspect(const Operations& operations, bool partitioned, CellDiskLayoutSnapshot* output) noexcept;
  CellVirtualDiskDevice device_;
  CellDiskLayoutPlan plan_{};
  CellDiskLayoutSnapshot snapshot_{};
  CellDiskLayoutCommitter committer_{};
  std::vector<CellDiskLayoutCheckpoint> records_;
  CellDiskLayoutState state_ = CellDiskLayoutState::not_started;
  bool attempted_ = false;
};
}
