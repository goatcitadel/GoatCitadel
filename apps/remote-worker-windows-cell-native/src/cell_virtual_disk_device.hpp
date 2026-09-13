#pragma once
#include "cell_virtual_disk.hpp"
#include <span>

namespace goatcitadel::worker_cell {
// Checks a bounded, pointer-bearing STORAGE_DEPENDENCY_INFO_VERSION_2 response.
// This decoder confers no authority. Production obtains the bytes through the
// opened device handle and compares them with an independently pinned backing
// file. A disk number, path string or replayed response is never enough.
bool MatchesCellVirtualDiskDependency(std::span<const std::uint8_t> bytes,
  const std::wstring& expected_device, const std::wstring& expected_backing) noexcept;

// Owns a device handle for an already verified permanent VHDX attachment. There
// is no caller-supplied path or disk number. Opens read/write access for future
// volume provisioning. Public methods only query; the internal layout owner
// alone can use the private I/O port. No raw handle is exposed.
// The opened device's host dependency must resolve to the exact pinned backing
// file, with matching device number and virtual length. Attachment/file identity
// and privilege are rechecked before returning and on every Verify.
// This does not partition, format, mount, detach, grant privileges or establish
// zero workloads. Close only releases this owner's handles; the attachment stays.
// The caller serializes all use. Synchronous driver queries still require the
// controller's outer watchdog; pending overlapped queries are cancelled/joined.
class CellVirtualDiskDevice final {
 public:
  CellVirtualDiskDevice() = default;
  ~CellVirtualDiskDevice();
  CellVirtualDiskDevice(const CellVirtualDiskDevice&) = delete;
  CellVirtualDiskDevice& operator=(const CellVirtualDiskDevice&) = delete;
  DWORD Open(CellVirtualDiskAttachment& source, CellWorkspaceDirectories& workspace,
             DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  void Close() noexcept;
  bool Ready() const noexcept { return ready_; }

 private:
  friend class CellVirtualDiskLayout;
  friend class CellVirtualDiskVolume;
  DWORD Inspect(ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Io(DWORD code, std::span<const std::uint8_t> input, std::span<std::uint8_t> output,
           DWORD* transferred, ULONGLONG deadline, HANDLE cancellation) noexcept;
  CellVirtualDiskAttachment attachment_;
  CellVirtualDiskRecord record_{};
  HANDLE device_ = INVALID_HANDLE_VALUE;
  bool attempted_ = false, ready_ = false;
};
}
