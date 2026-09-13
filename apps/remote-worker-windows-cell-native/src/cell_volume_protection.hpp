#pragma once
#include "cell_ntfs_format.hpp"

namespace goatcitadel::worker_cell {
struct CellVolumeProtectionBinding final {
  CellFileSha256 format_sha256{}, security_sha256{};
  GUID volume_id{};
  std::uint64_t partition_bytes = 0;
  CellNtfsIdentity ntfs{};
  CellFileIdentity root{};
};
using CellVolumeProtectionCheckpoint = std::array<std::uint8_t, 512>;
enum class CellVolumeProtectionPhase : unsigned { intent = 1, protected_root = 2 };
enum class CellVolumeProtectionState { not_started, unknown, protected_root };
struct CellVolumeProtectionCommitter final {
  // Exact retention under exclusive provisioning/zero-workload authority must
  // precede acknowledgement. An in-memory callback is not canonical storage.
  DWORD (*commit)(void*, const CellVolumeProtectionCheckpoint&, CellFileSha256*) noexcept = nullptr;
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};
bool IsValidCellVolumeProtectionBinding(const CellVolumeProtectionBinding& binding) noexcept;
// Stable policy-version/SID digest, independent of SDK self-relative descriptor
// allocation/order. The actual descriptor is still generated and checked exactly.
DWORD HashCellVolumeRootSecurity(const std::wstring& owner_sid, const std::wstring& controller_sid,
  CellFileSha256* output) noexcept;
DWORD ValidateCellVolumeProtectionCheckpointPrefix(const CellVolumeProtectionBinding& binding,
  std::span<const CellVolumeProtectionCheckpoint> records) noexcept;
DWORD DecodeCellVolumeProtectionCheckpoints(const CellVolumeProtectionBinding& binding,
  std::span<const CellVolumeProtectionCheckpoint> records) noexcept;

// Protects only the root of an independently verified, freshly formatted cell
// volume. No caller path, raw disk handle, ACL, drive letter or repair flag enters
// this owner. Create consumes the original formatter once; recovery can only
// verify a complete canonical chain. Neither failure nor Close deletes anything.
// Root identity, exact controller security, format history and the current volume
// name are rechecked before completion and every recorded reopen. Directory
// handles exclude data-write/delete opens and are never inherited by workloads.
// This is not a quota, mounted workspace, child-tree attestation or execution
// permit. The controller still needs a durable journal and an outer watchdog for
// synchronous Windows calls; a timeout does not prove a pending OS write stopped.
class CellVolumeProtection final {
 public:
  CellVolumeProtection() = default;
  ~CellVolumeProtection();
  CellVolumeProtection(const CellVolumeProtection&) = delete;
  CellVolumeProtection& operator=(const CellVolumeProtection&) = delete;
  DWORD Create(CellNtfsFormat& source, CellWorkspaceDirectories& workspace,
    const std::wstring& owner_sid, const std::wstring& controller_sid,
    const CellVolumeProtectionCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD OpenRecorded(CellNtfsFormat& source, CellWorkspaceDirectories& workspace,
    const std::wstring& owner_sid, const std::wstring& controller_sid,
    std::span<const CellVolumeProtectionCheckpoint> records, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD RecordCheckpoints(std::vector<CellVolumeProtectionCheckpoint>* output) const noexcept;
  DWORD RecordRoot(CellWorkspaceDirectories& workspace, CellFileIdentity* output,
    DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  HANDLE RootHandle() const noexcept;
  CellVolumeProtectionState State() const noexcept { return state_; }
  void Close() noexcept;

 private:
  friend struct CellVolumeProtectionTestPeer;
  friend struct CellVolumeMountTestPeer;
  friend class CellVolumeMount;
  struct Operations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*security)(void*) noexcept;
    DWORD (*apply)(void*, DWORD (*)(void*) noexcept, void*) noexcept;
    void* context;
  };
  struct NativeContext;
  static Operations NativeOperations(NativeContext& context) noexcept;
  static HANDLE OpenRoot(const std::wstring& path, bool writable) noexcept;
  static DWORD InspectRoot(HANDLE handle, const std::wstring& expected_path,
    std::uint64_t expected_serial, CellFileIdentity* output) noexcept;
  static DWORD ApplySecurity(HANDLE root, const std::vector<std::uint8_t>& descriptor,
    DWORD (*guard)(void*) noexcept, void* context) noexcept;
  DWORD Prepare(CellNtfsFormat& source, const std::wstring& owner, const std::wstring& controller) noexcept;
  DWORD Bind(CellNtfsFormat& source, CellWorkspaceDirectories& workspace, bool create,
    ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation, bool authorize, bool security = false) noexcept;
  DWORD Commit(CellVolumeProtectionPhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Recover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  CellNtfsFormat format_;
  CellVolumeProtectionBinding binding_{};
  CellVolumeProtectionCommitter committer_{};
  std::vector<CellVolumeProtectionCheckpoint> records_;
  std::vector<std::uint8_t> descriptor_;
  std::wstring path_;
  HANDLE root_ = INVALID_HANDLE_VALUE;
  CellVolumeProtectionState state_ = CellVolumeProtectionState::not_started;
  bool attempted_ = false;
  bool freshly_protected_ = false, mount_attempted_ = false;
};
}
