#pragma once
#include "cell_volume_mount.hpp"

namespace goatcitadel::worker_cell {
struct CellMountedWorkspaceBinding final {
  CellFileSha256 mount_sha256{}, security_sha256{};
  CellFileIdentity volume_root{};
  std::wstring cell_name;
};
using CellMountedWorkspaceCheckpoint = std::array<std::uint8_t, 512>;
enum class CellMountedWorkspacePhase : unsigned { intent = 1, recorded };
enum class CellMountedWorkspaceState { not_started, unknown, recorded };
struct CellMountedWorkspaceCommitter final {
  DWORD (*commit)(void*, const CellMountedWorkspaceCheckpoint&, CellFileSha256*) noexcept = nullptr;
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};
bool IsValidCellMountedWorkspaceBinding(const CellMountedWorkspaceBinding& binding) noexcept;
DWORD ValidateCellMountedWorkspaceCheckpointPrefix(const CellMountedWorkspaceBinding& binding,
  std::span<const CellMountedWorkspaceCheckpoint> records, CellWorkspaceIdentities* output) noexcept;
DWORD DecodeCellMountedWorkspaceCheckpoints(const CellMountedWorkspaceBinding& binding,
  std::span<const CellMountedWorkspaceCheckpoint> records, CellWorkspaceIdentities* output) noexcept;

// Creates the canonical cell subtree inside the original protected volume,
// using its pinned root handle rather than following the host mount alias.
// An acknowledged intent precedes all directory creation; a current guard runs
// immediately before each native create. The original successful mount is
// consumed once. Complete recorded recovery verifies identities/security only.
// Failure/Close never creates, repairs, deletes, formats, mounts or retries.
// Records do not attest mutable children, quotas, runtime bundles, AppContainer
// profile confinement or execution readiness. Calls need an outer watchdog.
class CellMountedWorkspace final {
 public:
  CellMountedWorkspace() = default;
  ~CellMountedWorkspace();
  CellMountedWorkspace(const CellMountedWorkspace&) = delete;
  CellMountedWorkspace& operator=(const CellMountedWorkspace&) = delete;
  DWORD Create(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
    const std::wstring& owner_sid, const std::wstring& controller_sid, const CellMountedWorkspaceCommitter& committer,
    DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD OpenRecorded(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
    const std::wstring& owner_sid, const std::wstring& controller_sid,
    std::span<const CellMountedWorkspaceCheckpoint> records, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD Verify(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
    DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD RecordIdentities(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
    CellWorkspaceIdentities* output, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD RecordCheckpoints(std::vector<CellMountedWorkspaceCheckpoint>* output) const noexcept;
  CellMountedWorkspaceState State() const noexcept { return state_; }
  void Close() noexcept;
 private:
  friend struct CellMountedWorkspaceTestPeer;
  struct Operations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*create)(void*, CellWorkspaceIdentities*, DWORD (*)(void*) noexcept, void*) noexcept;
    DWORD (*inspect)(void*, const CellWorkspaceIdentities&, bool reopen) noexcept;
    void* context;
  };
  struct NativeContext;
  static Operations NativeOperations(NativeContext& context) noexcept;
  DWORD Prepare(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
    const std::wstring& owner_sid, const std::wstring& controller_sid, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation, bool authorize) noexcept;
  DWORD Commit(CellMountedWorkspacePhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Recover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation, bool reopen) noexcept;
  CellMountedWorkspaceBinding binding_;
  CellWorkspaceIdentities identities_;
  CellMountedWorkspaceCommitter committer_;
  CellWorkspaceDirectories contents_;
  std::vector<CellMountedWorkspaceCheckpoint> records_;
  std::wstring owner_sid_, controller_sid_;
  CellMountedWorkspaceState state_ = CellMountedWorkspaceState::not_started;
  bool attempted_ = false;
};
}
