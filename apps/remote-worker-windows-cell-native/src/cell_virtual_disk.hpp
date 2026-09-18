#pragma once
#include "cell_workspace.hpp"

namespace goatcitadel::worker_cell {
struct CellFootprintScanGuard;
struct CellVirtualDiskSpec final {
  GUID identifier{};
  std::uint64_t virtual_bytes = 0;
  std::uint64_t reserved_file_bytes = 0;
};
bool IsValidCellVirtualDiskSpec(const CellVirtualDiskSpec& spec) noexcept;

// Retain only after complete verification, together with the canonical workspace
// record and assignment. These are object identities and frozen capacity, not
// current attachment, zero-workload, execution or cleanup authority.
struct CellVirtualDiskRecord final {
  CellVirtualDiskSpec spec;
  CellFileIdentity control, backing;
};

// Host-file charges, distinct from bytes allocated inside the mounted volume.
// The record binds both counts to the original control directory and VHDX.
struct CellVirtualDiskCapacity final {
  CellVirtualDiskRecord record;
  std::uint64_t file_bytes = 0;
  std::uint64_t allocated_bytes = 0;
};

// Internal backing-file provisioning and inspection. The canonical owner supplies an
// already-reserved, frozen spec. Fixed VHDX capacity starts at 16 MiB, aligned
// to 2 MiB, with at least 64 MiB metadata headroom and a 1 TiB total reservation cap. Actual allocation
// is checked after creation; this is not an OS quota or transient-usage guarantee.
// Creates only control\cell.vhdx in verified workspace roots, preserving their
// frozen controller principals/rights with file-appropriate inheritance flags.
// Create never adopts existing images. OpenRecorded opens only the independently
// recorded, unattached image for read-only information queries; it never repairs
// files or ACLs. Neither operation attaches, formats, deletes or grants
// AppContainer access to the backing file.
// Cancellation/expiry joins submitted I/O before releasing its buffers. A slow
// driver can delay that join. Failed/partial files remain for canonical recovery
// and capacity accounting, including when no disk handle was returned.
class CellVirtualDiskFile final {
 public:
  CellVirtualDiskFile() = default;
  ~CellVirtualDiskFile();
  CellVirtualDiskFile(const CellVirtualDiskFile&) = delete;
  CellVirtualDiskFile& operator=(const CellVirtualDiskFile&) = delete;
  DWORD Create(CellWorkspaceDirectories& workspace, const CellVirtualDiskSpec& spec,
               DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD OpenRecorded(CellWorkspaceDirectories& workspace, const CellVirtualDiskRecord& record,
                     DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  // Clears output on failure. A successful read freshly verifies the disk.
  DWORD RecordIdentity(CellWorkspaceDirectories& workspace, CellVirtualDiskRecord* output) noexcept;
  // Read-only, current-authority observation of the exact recorded backing file.
  // The caller serializes this owner and establishes workload quiescence. All
  // output is withheld on authority, identity, security, allocation or time drift.
  // An outer process watchdog must bound blocking OS calls/authority callbacks.
  // This does not report complete pool usage, enforce quotas or authorize launch.
  DWORD ObserveCapacity(CellWorkspaceDirectories& workspace, const CellVirtualDiskRecord& expected,
    DWORD wall_limit_ms, const CellFootprintScanGuard& guard, CellVirtualDiskCapacity* output) noexcept;
  DWORD Verify(CellWorkspaceDirectories& workspace) noexcept;
  void Close() noexcept;
  bool Ready() const noexcept { return ready_; }
  bool CreationAttempted() const noexcept { return attempted_; }
  const std::wstring& Path() const noexcept { return path_; }
  const CellFileIdentity& Identity() const noexcept { return identity_; }
  std::uint64_t PhysicalBytes() const noexcept { return physical_bytes_; }
  std::uint64_t AllocatedBytes() const noexcept { return allocated_bytes_; }

 private:
  friend class CellProvisioningJournal;
  friend class CellVirtualDiskAttachment;
  friend class CellVirtualDiskDevice;
  DWORD OpenRecordedExpected(CellWorkspaceDirectories& workspace, const CellVirtualDiskRecord& record,
                             DWORD wall_limit_ms, HANDLE cancellation, bool attached) noexcept;
  DWORD VerifyExpected(CellWorkspaceDirectories& workspace, bool attached) noexcept;
  DWORD ObserveCapacityExpected(CellWorkspaceDirectories& workspace, const CellVirtualDiskRecord& expected,
    DWORD wall_limit_ms, const CellFootprintScanGuard& guard, bool attached, CellVirtualDiskCapacity* output) noexcept;
  DWORD InspectBackingFile(CellFileIdentity* identity) noexcept;
  HANDLE disk_ = nullptr;
  HANDLE file_ = INVALID_HANDLE_VALUE;
  CellVirtualDiskSpec spec_{};
  CellFileIdentity control_identity_{}, identity_{};
  std::wstring path_;
  std::vector<std::uint8_t> descriptor_;
  std::uint64_t physical_bytes_ = 0, allocated_bytes_ = 0;
  bool attempted_ = false, created_ = false, ready_ = false;
  std::uint64_t lifetime_revision_ = 0;
};

enum class CellAttachmentState { not_started, attached, detached, unknown };

// Checks the effective thread token, falling back to the process token only
// when the thread is not impersonating. Never enables or grants a privilege.
DWORD CheckCellVolumeManagementPrivilege() noexcept;

// Internal provisioning primitive. The caller must persist assignment/planned
// identity before Attach and hold canonical zero-workload authority for Detach.
// Only an independently recorded or newly provisioned, verified and unattached
// CellVirtualDiskFile can be supplied. A reopened record is not attachment authority.
// No arbitrary image path, drive letter, format or quota operation is accepted.
// Attachments have permanent lifetime and no drive letter: losing a controller
// handle cannot silently detach an uncertain workload. Close only releases
// handles. Unknown outcomes retain the attachment for canonical reconciliation.
// DevicePath is diagnostic data, never authority to open/format a numbered disk.
// Successful attachment is not protected-volume, quota or backend readiness.
class CellVirtualDiskAttachment final {
 public:
  CellVirtualDiskAttachment() = default;
  ~CellVirtualDiskAttachment();
  CellVirtualDiskAttachment(const CellVirtualDiskAttachment&) = delete;
  CellVirtualDiskAttachment& operator=(const CellVirtualDiskAttachment&) = delete;
  DWORD Attach(CellVirtualDiskFile& source, CellWorkspaceDirectories& workspace,
               DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  // Recover only an existing attachment from the previously retained disk record.
  // Requires current volume privilege and exact workspace/backing/disk identity.
  // Never attaches, detaches or infers zero workloads. Any failed recovery remains
  // unknown until the canonical owner reconciles it; Close only releases handles.
  DWORD OpenRecorded(CellWorkspaceDirectories& workspace, const CellVirtualDiskRecord& record,
                     DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD Verify(CellWorkspaceDirectories& workspace) noexcept;
  // Uses the retained original backing file and revalidates attachment identity.
  // No attach/detach, device open, formatting or permission mutation is performed.
  DWORD ObserveCapacity(CellWorkspaceDirectories& workspace, const CellVirtualDiskRecord& expected,
    DWORD wall_limit_ms, const CellFootprintScanGuard& guard, CellVirtualDiskCapacity* output) noexcept;
  DWORD Detach(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  void Close() noexcept;
  CellAttachmentState State() const noexcept { return state_; }
  const std::wstring& DevicePath() const noexcept { return device_path_; }

 private:
  friend class CellProvisioningJournal;
  friend class CellVirtualDiskDevice;
  DWORD ReadDevicePath(std::wstring* path);
  CellVirtualDiskFile retained_;
  std::wstring device_path_;
  CellAttachmentState state_ = CellAttachmentState::not_started;
};
}
