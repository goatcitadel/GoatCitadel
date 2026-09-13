#pragma once
#include "cell_controller_transport.hpp"
#include "cell_provisioning_journal.hpp"

namespace goatcitadel::worker_cell {
enum class CellControllerMessage : std::uint32_t {
  hello = 1, welcome, request, checkpoint, acknowledgement, receipt, finish,
  volume_authority, volume_authorized, volume_history, format_history, protection_history, mount_history, mounted_workspace_history,
};
using CellControllerNonce = std::array<std::uint8_t, 32>;
struct CellControllerRequest final {
  std::uint32_t operation = 0, wall_ms = 0;
  CellControllerNonce nonce{};
  std::wstring cell_name;
  CellProvisioningPlan plan;
  CellFileIdentity parent;
  CellProvisioningAnchor anchor;
  std::array<CellVolumeProvisioningRecord, 6> volume_records{};
  std::array<CellFormatProvisioningRecord, 2> format_records{};
  std::array<CellProtectionProvisioningRecord, 2> protection_records{};
  std::array<CellProvisioningRecord, 5> creation_records{};
  std::array<CellMountProvisioningRecord, 4> mount_records{};
  std::array<CellMountedWorkspaceProvisioningRecord, 2> mounted_workspace_records{};
};
constexpr std::size_t kCellControllerRequestBytes = 256;
constexpr std::size_t kCellControllerVolumeHistoryBytes = 32 + 6 * 1024;
constexpr std::size_t kCellControllerFormatHistoryBytes = 32 + 2 * 1024;
constexpr std::size_t kCellControllerProtectionHistoryBytes = 32 + 2 * 1024;
constexpr std::size_t kCellControllerMountHistoryBytes = 32 + (5 + 4) * 1024;
constexpr std::size_t kCellControllerMountedWorkspaceHistoryBytes = 32 + 2 * 1024;
constexpr std::uint32_t kCellControllerMaximumVolumeChecks = 256;
constexpr bool IsCellControllerCreation(std::uint32_t operation) noexcept { return operation == 1 || operation == 3 || operation == 5 || operation == 7 || operation == 9 || operation == 11; }
constexpr bool IsCellControllerVolume(std::uint32_t operation) noexcept { return operation >= 3 && operation <= 12; }
constexpr bool IsCellControllerFormat(std::uint32_t operation) noexcept { return operation >= 5 && operation <= 12; }
constexpr bool IsCellControllerProtection(std::uint32_t operation) noexcept { return operation >= 7 && operation <= 12; }
constexpr bool IsCellControllerMount(std::uint32_t operation) noexcept { return operation >= 9 && operation <= 12; }
constexpr bool IsCellControllerMountedWorkspace(std::uint32_t operation) noexcept { return operation == 11 || operation == 12; }
constexpr std::uint32_t CellControllerCheckpointLimit(std::uint32_t operation) noexcept {
  return IsCellControllerMountedWorkspace(operation) ? 21u : IsCellControllerMount(operation) ? 19u : IsCellControllerProtection(operation) ? 15u : IsCellControllerFormat(operation) ? 13u : IsCellControllerVolume(operation) ? 11u : 5u;
}
bool ValidateCellControllerVolumeHistory(const CellControllerRequest& request) noexcept;
bool ValidateCellControllerFormatHistory(const CellControllerRequest& request) noexcept;
bool ValidateCellControllerProtectionHistory(const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept;
bool ValidateCellControllerMountHistory(const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept;
bool ValidateCellControllerMountedWorkspaceHistory(const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept;
bool DecodeCellControllerRequest(const std::array<std::uint8_t, kCellControllerRequestBytes>& bytes,
  const CellControllerNonce& nonce, CellControllerRequest* output) noexcept;
bool EncodeCellControllerRequest(const CellControllerRequest& request,
  std::array<std::uint8_t, kCellControllerRequestBytes>* output,
  const std::wstring& owner_sid = {}, const std::wstring& controller_sid = {}) noexcept;
// Only checkpoint/receipt/current-volume-authority frames are accepted; sizes are checked before reading
// a body. A failed read clears the output and never exposes a partial response.
DWORD ReadCellControllerReply(HANDLE pipe, CellControllerMessage* kind,
  std::array<std::uint8_t, 1056>* bytes, HANDLE stop, ULONGLONG deadline) noexcept;
DWORD ReadCellControllerMessage(HANDLE pipe, CellControllerMessage kind, void* bytes, DWORD count,
  HANDLE stop, ULONGLONG deadline) noexcept;
DWORD WriteCellControllerMessage(HANDLE pipe, CellControllerMessage kind, const void* bytes, DWORD count,
  HANDLE stop, ULONGLONG deadline) noexcept;

// Trusted host inputs, never decoded from a peer request. Production supplies
// the installed controller's parent and fixed principals. Test fixtures provide
// an independently created current-user parent. Missing callbacks fail closed.
// Authorize must attest the current controller/peer on every call. The caller
// owns canonical lease/capacity admission before dispatch and exact checkpoint
// persistence before acknowledging. This session does not replace that authority.
struct CellControllerSessionOwner final {
  std::wstring parent_path, owner_sid, controller_sid;
  CellFileIdentity parent;
  void* context = nullptr;
  DWORD (*authorize)(void*, bool first_message) noexcept = nullptr;
  void (*arm_watchdog)(void*, ULONGLONG deadline) noexcept = nullptr;
  // Trusted host composition: the installed service calls ProvisionVolume on
  // the original live journal. The protocol supplies fresh canonical checks and
  // exact commits. Missing composition refuses volume dispatch before creation.
  DWORD (*provision_volume)(void*, CellProvisioningJournal&, const CellProvisioningAnchor&,
    const CellVolumeProvisioningCommitter&, DWORD wall_ms, HANDLE stop) noexcept = nullptr;
  DWORD (*provision_format)(void*, CellProvisioningJournal&, const CellProvisioningAnchor&,
    const CellFormatProvisioningCommitter&, DWORD wall_ms, HANDLE stop) noexcept = nullptr;
  DWORD (*provision_protection)(void*, CellProvisioningJournal&, const CellProvisioningAnchor&,
    const CellProtectionProvisioningCommitter&, DWORD wall_ms, HANDLE stop) noexcept = nullptr;
  DWORD (*provision_mount)(void*, CellProvisioningJournal&, const CellProvisioningAnchor&,
    const CellMountProvisioningCommitter&, DWORD wall_ms, HANDLE stop) noexcept = nullptr;
  DWORD (*provision_mounted_workspace)(void*, CellProvisioningJournal&, const CellProvisioningAnchor&,
    const CellMountedWorkspaceProvisioningCommitter&, DWORD wall_ms, HANDLE stop) noexcept = nullptr;
};
struct CellControllerSessionResult final {
  DWORD error = ERROR_INVALID_STATE;
  CellProvisioningPhase phase = CellProvisioningPhase::none;
  bool creation_attempted = false, receipt_written = false, receipt_acknowledged = false;
  std::uint32_t checkpoints = 0;
  std::uint32_t volume_authority_checks = 0;
};
// Operations 1/2 preserve creation-only bytes. Operations 3/4 create through
// volume layout or verify all eleven independently retained records. Operations
// 5/6 extend creation/recovery through both NTFS formatting records. Operations
// 7/8 include both root-protection records. Operations 9/10 include four mount
// records, with the complete creation history supplied independently on recovery.
// Operations 11/12 add both mounted workspace records and require all prior
// history independently on recovery. At most twenty-one checkpoints and 256
// fresh authority checks share one deadline. Protection principals
// are trusted host inputs; peer messages cannot select them.
// Recovery never resumes effects. No workload, cleanup, protocol
// retry or implicit ACK is supported. Connection nonces bind every exchange.
CellControllerSessionResult RunCellControllerSession(HANDLE pipe, HANDLE stop,
  const CellControllerSessionOwner& owner) noexcept;
}
