#pragma once
#include "cell_virtual_disk_volume.hpp"

namespace goatcitadel::worker_cell {
struct CellNtfsFormatBinding final {
  CellFileSha256 layout_sha256{};
  GUID volume_id{};
  std::uint64_t partition_bytes = 0;
};
struct CellNtfsIdentity final {
  std::uint64_t serial = 0, sectors = 0, clusters = 0;
  bool operator==(const CellNtfsIdentity&) const = default;
};
using CellNtfsFormatCheckpoint = std::array<std::uint8_t, 512>;
enum class CellNtfsFormatPhase : unsigned { intent = 1, formatted = 2 };
enum class CellNtfsFormatState { not_started, unknown, formatted };
struct CellNtfsFormatCommitter final {
  // The canonical owner must retain exact bytes under current exclusive
  // provisioning/zero-workload authority before acknowledging their SHA-256.
  DWORD (*commit)(void*, const CellNtfsFormatCheckpoint&, CellFileSha256*) noexcept = nullptr;
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};
bool IsValidCellNtfsFormatBinding(const CellNtfsFormatBinding& binding) noexcept;
DWORD InspectCellNtfsVolume(std::span<const std::uint8_t> bytes, std::uint64_t partition_bytes,
                           CellNtfsIdentity* output) noexcept;
DWORD DecodeCellNtfsFormatCheckpoints(const CellNtfsFormatBinding& binding,
  std::span<const CellNtfsFormatCheckpoint> records, CellNtfsIdentity* output) noexcept;
DWORD ValidateCellNtfsFormatCheckpointPrefix(const CellNtfsFormatBinding& binding,
  std::span<const CellNtfsFormatCheckpoint> records, CellNtfsIdentity* output) noexcept;

// Internal fresh-volume formatter. No caller path, filesystem choice, force
// flag, command or raw handle is accepted. A fully recorded layout must bind
// through CellVirtualDiskVolume before the formatter can reach Windows storage.
// Intent is retained before submission; completion requires identity readback,
// exact durable acknowledgement and renewed authority. Any uncertain submission
// or lost acknowledgement stays unknown and must not be automatically retried.
// OpenRecorded accepts only a complete chain and never resumes a format.
// Formatted does not mean protected, quota-controlled, mounted or executable.
// The controller must bound this operation with its outer watchdog: synchronous
// COM/driver calls may overrun a deadline, and stopping the client does not prove
// that a storage-provider format has stopped. No uncertain resource is removed.
class CellNtfsFormat final {
 public:
  DWORD Create(CellVirtualDiskLayout& source, CellWorkspaceDirectories& workspace,
    const CellNtfsFormatCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD OpenRecorded(CellVirtualDiskLayout& source, CellWorkspaceDirectories& workspace,
    std::span<const CellNtfsFormatCheckpoint> records, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD RecordCheckpoints(std::vector<CellNtfsFormatCheckpoint>* output) const noexcept;
  CellNtfsFormatState State() const noexcept { return state_; }
  void Close() noexcept;

 private:
  friend class CellVolumeProtection;
  friend struct CellVolumeProtectionTestPeer;
  friend struct CellNtfsFormatTestPeer;
  struct Operations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*probe)(void*, bool*, CellNtfsIdentity*) noexcept;
    DWORD (*format)(void*, DWORD (*)(void*) noexcept, void*) noexcept;
    void* context;
  };
  struct NativeContext;
  static Operations NativeOperations(NativeContext& context) noexcept;
  DWORD Bind(CellVirtualDiskLayout& source, CellWorkspaceDirectories& workspace, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation, bool authorize) noexcept;
  DWORD RequireRaw(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Commit(CellNtfsFormatPhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Recover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  CellVirtualDiskVolume volume_;
  CellNtfsFormatBinding binding_{};
  CellNtfsIdentity identity_{};
  CellNtfsFormatCommitter committer_{};
  std::vector<CellNtfsFormatCheckpoint> records_;
  CellNtfsFormatState state_ = CellNtfsFormatState::not_started;
  bool attempted_ = false;
  // Root protection may consume only this original successful formatter once.
  // Reopening canonical format records supplies verification, never mutation authority.
  bool freshly_formatted_ = false, protection_attempted_ = false;
};
}
