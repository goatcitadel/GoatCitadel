#pragma once
#include "cell_volume_protection.hpp"
#include "cell_volume_mount_target.hpp"
#include "cell_capacity.hpp"

namespace goatcitadel::worker_cell {
struct CellVolumeMountBinding final {
  CellFileSha256 protection_sha256{}, security_sha256{};
  GUID volume_id{};
  CellFileIdentity parent{}, volume_root{};
};
using CellVolumeMountCheckpoint = std::array<std::uint8_t, 512>;
enum class CellVolumeMountPhase : unsigned { prepared = 1, directory_recorded, mount_intent, mounted };
enum class CellVolumeMountState { not_started, unknown, mounted };
struct CellVolumeMountCommitter final {
  DWORD (*commit)(void*, const CellVolumeMountCheckpoint&, CellFileSha256*) noexcept = nullptr;
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};
bool IsValidCellVolumeMountBinding(const CellVolumeMountBinding& binding) noexcept;
DWORD ValidateCellVolumeMountCheckpointPrefix(const CellVolumeMountBinding& binding,
  std::span<const CellVolumeMountCheckpoint> records, CellFileIdentity* directory) noexcept;
DWORD DecodeCellVolumeMountCheckpoints(const CellVolumeMountBinding& binding,
  std::span<const CellVolumeMountCheckpoint> records, CellFileIdentity* directory) noexcept;

// Borrowed only during the synchronous native owner's capacity callback.
// Construction is private: paths, reparse tags and peer claims cannot mint an
// admitted mount leaf. Check repeats read-only native mount/protection checks
// without invoking the caller's execution-authority callback. The owner and its
// dependencies must remain alive and quiescent; this is not execution authority.
class CellCapacityMountLeaf final {
 public:
  CellCapacityMountLeaf(const CellCapacityMountLeaf&) = delete;
  CellCapacityMountLeaf& operator=(const CellCapacityMountLeaf&) = delete;
  const CellVolumeMountTarget& Target() const noexcept { return target_; }
  HANDLE DirectoryHandle() const noexcept { return directory_; }
  DWORD Check() const noexcept { return check_(context_); }
 private:
  friend class CellVolumeMount;
  friend struct CellCapacityMountLeafTestPeer;
  CellCapacityMountLeaf(CellVolumeMountTarget target, HANDLE directory, void* context,
    DWORD (*check)(void*) noexcept) : target_(target), directory_(directory), context_(context), check_(check) {}
  const CellVolumeMountTarget target_;
  HANDLE const directory_;
  void* const context_;
  DWORD (*const check_)(void*) noexcept;
};
struct CellCapacityMountObserver final {
  void* context = nullptr;
  DWORD (*capture)(void*, const CellCapacityMountLeaf&) noexcept = nullptr;
  void (*discard)(void*) noexcept = nullptr;
};

// One-shot mount of the original protected volume at the literal "volume"
// child of its recorded host cell root. No caller path, drive letter, disk
// number, permissions, replacement flag or reformat operation is accepted.
// Intent precedes both exclusive directory creation and SetVolumeMountPointW.
// Complete recovery only reopens independently retained identities and checks
// the exact reparse target, sole alias, NTFS root and controller permissions.
// Failure leaves unknown evidence; Close never unmounts, deletes or permits a
// retry. Calls are serialized; the controller's watchdog must bound synchronous
// Windows calls and callbacks. Mounted is not a quota or execution grant.
class CellVolumeMount final {
 public:
  CellVolumeMount() = default;
  ~CellVolumeMount();
  CellVolumeMount(const CellVolumeMount&) = delete;
  CellVolumeMount& operator=(const CellVolumeMount&) = delete;
  DWORD Create(CellVolumeProtection& source, CellWorkspaceDirectories& workspace,
    const CellVolumeMountCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD OpenRecorded(CellVolumeProtection& source, CellWorkspaceDirectories& workspace,
    std::span<const CellVolumeMountCheckpoint> records, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD Verify(CellVolumeProtection& source, CellWorkspaceDirectories& workspace,
    DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD RecordCheckpoints(std::vector<CellVolumeMountCheckpoint>* output) const noexcept;
  DWORD WithCapacityLeaf(CellVolumeProtection& source, CellWorkspaceDirectories& workspace,
    DWORD wall_limit_ms, const CellFootprintScanGuard& guard, const CellCapacityMountObserver& observer) noexcept;
  CellVolumeMountState State() const noexcept { return state_; }
  void Close() noexcept;
 private:
  friend struct CellVolumeMountTestPeer;
  friend struct CellMountedWorkspaceTestPeer;
  friend class CellMountedWorkspace;
  struct Operations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*inspect)(void*, bool directory_created, bool mounted) noexcept;
    DWORD (*create_directory)(void*, CellFileIdentity*, DWORD (*)(void*) noexcept, void*) noexcept;
    DWORD (*mount)(void*, DWORD (*)(void*) noexcept, void*) noexcept;
    void* context;
  };
  struct NativeContext;
  static Operations NativeOperations(NativeContext& context) noexcept;
  static DWORD EmptyDirectory(HANDLE directory) noexcept;
  DWORD CreateDirectory(CellWorkspaceDirectories& workspace, CellFileIdentity* output,
    DWORD (*guard)(void*) noexcept, void* context) noexcept;
  DWORD Prepare(CellVolumeProtection& source, CellWorkspaceDirectories& workspace, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation,
    bool authorize, bool directory_created, bool mounted) noexcept;
  DWORD Commit(CellVolumeMountPhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Recover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD ReadCapacityLeaf(const Operations& operations, DWORD wall_limit_ms,
    const CellFootprintScanGuard& guard, const CellCapacityMountObserver& observer) noexcept;
  CellVolumeMountBinding binding_{};
  CellFileIdentity directory_identity_{};
  CellVolumeMountCommitter committer_{};
  std::vector<CellVolumeMountCheckpoint> records_;
  std::vector<std::uint8_t> descriptor_;
  std::wstring folder_, volume_path_;
  HANDLE directory_ = nullptr;
  CellVolumeMountState state_ = CellVolumeMountState::not_started;
  bool attempted_ = false;
  bool freshly_mounted_ = false, workspace_attempted_ = false;
  bool capacity_reading_ = false, capacity_interrupted_ = false;
};
}
