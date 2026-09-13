#pragma once
#include "cell_virtual_disk_layout.hpp"
#include <string_view>

namespace goatcitadel::worker_cell {
// Bounded SDK-response decoders only. These do not open a volume or authorize a
// write. The disk number is ephemeral; production obtains it from its pinned
// VHDX device and also verifies the independently retained GPT identity.
bool IsCellVolumeGuidPath(std::wstring_view path) noexcept;
DWORD InspectCellVolumeExtent(std::span<const std::uint8_t> bytes, DWORD disk_number,
                             const CellDiskLayoutSnapshot& layout) noexcept;
DWORD InspectCellVolumePartition(std::span<const std::uint8_t> bytes,
  const CellDiskLayoutPlan& plan, const CellDiskLayoutSnapshot& layout) noexcept;

// Finds the one volume for a verified, completely journaled data partition.
// No caller-provided drive letter, volume path, disk number or raw handle enters
// this owner. It keeps an independent layout/attachment/backing-file pin and
// rechecks the volume's held handle AND its enumerated name on every Verify.
// Bound means identity verified, not formatted, protected, quota-controlled or
// ready for execution. This owner performs queries only. Future formatting must
// have its own current authority and durable intent before invoking a write.
// Calls are serialized and require the controller's outer watchdog for Windows
// enumeration/open calls; overlapped queries cancel and join on timeout.
class CellVirtualDiskVolume final {
 public:
  CellVirtualDiskVolume() = default;
  ~CellVirtualDiskVolume();
  CellVirtualDiskVolume(const CellVirtualDiskVolume&) = delete;
  CellVirtualDiskVolume& operator=(const CellVirtualDiskVolume&) = delete;
  DWORD Open(CellVirtualDiskLayout& source, CellWorkspaceDirectories& workspace,
             DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms,
               HANDLE cancellation = nullptr) noexcept;
  bool Bound() const noexcept { return bound_; }
  void Close() noexcept;

 private:
  friend class CellNtfsFormat;
  friend class CellVolumeProtection;
  friend struct CellNtfsFormatTestPeer;
  friend struct CellVirtualDiskVolumeTestPeer;
  struct Operations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*query)(void*, HANDLE, DWORD, std::span<std::uint8_t>, DWORD*) noexcept;
    DWORD (*next)(void*, bool, std::wstring*) noexcept;
    HANDLE (*open)(void*, const std::wstring&) noexcept;
    void* context;
  };
  struct NativeContext;
  static Operations NativeOperations(NativeContext& context) noexcept;
  DWORD Inspect(const Operations& operations, HANDLE handle, ULONGLONG deadline,
                HANDLE cancellation) noexcept;
  DWORD Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Discover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD ReadNtfs(std::span<std::uint8_t> output, DWORD* used, ULONGLONG deadline, HANDLE cancellation) noexcept;
  CellVirtualDiskLayout layout_;
  DWORD disk_number_ = MAXDWORD;
  HANDLE volume_ = INVALID_HANDLE_VALUE;
  std::wstring path_;
  bool attempted_ = false, bound_ = false;
};
}
