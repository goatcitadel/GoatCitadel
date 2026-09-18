#pragma once
#include "cell_controller_transport.hpp"
#include "cell_provisioning_journal.hpp"
#include "cell_runtime_install.hpp"
#include <memory>

namespace goatcitadel::worker_cell {
struct CellRuntimeSessionResult;
struct CellRuntimeCleanupBinding;
struct CellRuntimeCleanupSet;
struct CellRuntimeCleanupAdmission;
struct CellPoolJoinedCapacity;
struct CellCapacityLayoutRecord;
enum class CellControllerMessage : std::uint32_t {
  hello = 1, welcome, request, checkpoint, acknowledgement, receipt, finish,
  volume_authority, volume_authorized, volume_history, format_history, protection_history, mount_history, mounted_workspace_history,
  capacity_observation, backing_capacity_observation,
  inventory_observation, inventory_chunk,
  runtime_authority, runtime_authorized,
  runtime_input, runtime_input_end, runtime_input_ack,
  runtime_output, runtime_output_end, runtime_error, runtime_error_end,
  runtime_binding, runtime_ready,
  runtime_delivery_authority, runtime_delivery_authorized,
  runtime_parent_input_poll, runtime_parent_input_reply, runtime_parent_output_received,
  runtime_parent_finish, runtime_parent_finished,
  runtime_control_authority, runtime_control_authorized,
  runtime_control_setup, runtime_control_hello, runtime_control_welcome,
  install_binding, install_request, install_authority, install_authorized,
  install_outcome, install_outcome_received,
  cleanup_admission, cleanup_ready,
  pool_history_header, pool_history_member, pool_history_member_tail,
  pool_cleanup_size, pool_cleanup_chunk,
  pool_capacity_size, pool_capacity_chunk,
  pool_capture_binding, pool_capacity_ready,
  install_capacity_authority, install_capacity_authorized,
  install_capacity_capture,
  controller_attestation_challenge, controller_attestation_proof,
  controller_attestation_context,
};
using CellControllerNonce = std::array<std::uint8_t, 32>;
struct CellControllerRuntimeBinding final {
  CellControllerNonce nonce{};
  CellFileSha256 request_sha256{}, checkpoint_sha256{};
  bool operator==(const CellControllerRuntimeBinding&) const = default;
};
using CellControllerRuntimeBindingBytes = std::array<std::uint8_t, 128>;
bool EncodeCellControllerRuntimeBinding(const CellControllerNonce& connection_nonce, const CellControllerRuntimeBinding& binding,
  CellControllerRuntimeBindingBytes* output) noexcept;
bool DecodeCellControllerRuntimeBinding(const CellControllerNonce& connection_nonce, const CellControllerRuntimeBindingBytes& bytes,
  CellControllerRuntimeBinding* output) noexcept;
// Outer completion requires both controller-local persistence and protected
// remote retention; a byte receipt alone cannot settle an execution.
bool MatchesCellControllerRuntimeResult(const CellControllerRuntimeBinding&, const CellRuntimeSessionResult&) noexcept;
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
  // Independently admitted metadata from the protected parent, separate from
  // the later workload bytes. Receiving this proposal never grants execution.
  CellControllerRuntimeBinding runtime;
  CellControllerRuntimeBinding installation;
  std::array<std::uint8_t, kCellRuntimeInstallBytes> installation_bytes{};
  // Fixed padded admission precedes the separately transferred cleanup data.
  // Only the client holds cleanup_bytes; the server reads them after replay.
  std::array<std::uint8_t, 416> cleanup_admission{};
  std::vector<std::uint8_t> cleanup_bytes;
  std::vector<std::uint8_t> pool_history;
  std::vector<std::uint8_t> pool_cleanup;
  CellFileSha256 capture_nonce{};
  // Gateway reference metadata; not a filesystem observation or an admission.
  CellFileSha256 references_sha256{};
};
DWORD DecodeCellControllerCleanupAdmission(const CellControllerRequest&, CellRuntimeCleanupAdmission*) noexcept;
constexpr std::size_t kCellControllerRequestBytes = 256;
bool ValidateCellControllerInstallRequest(const CellControllerRequest&) noexcept;
constexpr std::size_t kCellControllerVolumeHistoryBytes = 32 + 6 * 1024;
constexpr std::size_t kCellControllerFormatHistoryBytes = 32 + 2 * 1024;
constexpr std::size_t kCellControllerProtectionHistoryBytes = 32 + 2 * 1024;
constexpr std::size_t kCellControllerMountHistoryBytes = 32 + (5 + 4) * 1024;
constexpr std::size_t kCellControllerMountedWorkspaceHistoryBytes = 32 + 2 * 1024;
constexpr std::size_t kCellControllerCapacityObservationBytes = 352;
using CellControllerCapacityBytes = std::array<std::uint8_t, kCellControllerCapacityObservationBytes>;
constexpr std::size_t kCellControllerBackingCapacityObservationBytes = 424;
using CellControllerBackingCapacityBytes = std::array<std::uint8_t, kCellControllerBackingCapacityObservationBytes>;
constexpr std::uint32_t kCellControllerCapacityOperation = 14; // Read-only; operation 13 remains reserved.
constexpr std::uint32_t kCellControllerBackingCapacityOperation = 15;
constexpr std::uint32_t kCellControllerInventoryOperation = 16;
constexpr std::uint32_t kCellControllerRuntimeOperation = 17;
constexpr std::uint32_t kCellControllerInstallOperation = 18;
constexpr std::uint32_t kCellControllerInstallRecoveryOperation = 19;
constexpr std::uint32_t kCellControllerPoolCapacityOperation = 20;
constexpr std::uint32_t kCellControllerInstallCapacityOperation = 21;
constexpr bool IsCellControllerInstallCapacity(std::uint32_t operation) noexcept { return operation == kCellControllerInstallCapacityOperation; }
constexpr bool IsCellControllerPoolCapacity(std::uint32_t operation) noexcept { return operation == kCellControllerPoolCapacityOperation || IsCellControllerInstallCapacity(operation); }
constexpr bool IsCellControllerInstall(std::uint32_t operation) noexcept {
  return operation == kCellControllerInstallOperation || operation == kCellControllerInstallRecoveryOperation || IsCellControllerInstallCapacity(operation);
}
constexpr bool IsCellControllerRuntime(std::uint32_t operation) noexcept { return operation == kCellControllerRuntimeOperation; }
constexpr std::size_t kCellControllerInventoryChunkEntries = 20;
using CellControllerInventoryChunkBytes = std::array<std::uint8_t, 1000>;
struct CellControllerInventoryChunk final {
  std::uint32_t start = 0, count = 0;
  std::array<CellDirectoryInventoryEntry, kCellControllerInventoryChunkEntries> entries{};
  bool operator==(const CellControllerInventoryChunk&) const = default;
};
constexpr bool IsCellControllerInventory(std::uint32_t operation) noexcept { return operation == kCellControllerInventoryOperation || IsCellControllerPoolCapacity(operation); }
constexpr bool IsCellControllerBackingCapacity(std::uint32_t operation) noexcept { return operation == kCellControllerBackingCapacityOperation; }
constexpr bool IsCellControllerCapacity(std::uint32_t operation) noexcept { return operation == kCellControllerCapacityOperation || IsCellControllerBackingCapacity(operation) || IsCellControllerInventory(operation); }
constexpr bool IsCellControllerOperation(std::uint32_t operation) noexcept { return (operation >= 1 && operation <= 12) || IsCellControllerCapacity(operation) || IsCellControllerRuntime(operation) || IsCellControllerInstall(operation); }
constexpr std::uint32_t kCellControllerMaximumVolumeChecks = 256;
constexpr bool IsCellControllerCreation(std::uint32_t operation) noexcept { return operation == 1 || operation == 3 || operation == 5 || operation == 7 || operation == 9 || operation == 11; }
constexpr bool IsCellControllerVolume(std::uint32_t operation) noexcept { return (operation >= 3 && operation <= 12) || IsCellControllerCapacity(operation) || IsCellControllerRuntime(operation) || IsCellControllerInstall(operation); }
constexpr bool IsCellControllerFormat(std::uint32_t operation) noexcept { return (operation >= 5 && operation <= 12) || IsCellControllerCapacity(operation) || IsCellControllerRuntime(operation) || IsCellControllerInstall(operation); }
constexpr bool IsCellControllerProtection(std::uint32_t operation) noexcept { return (operation >= 7 && operation <= 12) || IsCellControllerCapacity(operation) || IsCellControllerRuntime(operation) || IsCellControllerInstall(operation); }
constexpr bool IsCellControllerMount(std::uint32_t operation) noexcept { return (operation >= 9 && operation <= 12) || IsCellControllerCapacity(operation) || IsCellControllerRuntime(operation) || IsCellControllerInstall(operation); }
constexpr bool IsCellControllerMountedWorkspace(std::uint32_t operation) noexcept { return operation == 11 || operation == 12 || IsCellControllerCapacity(operation) || IsCellControllerRuntime(operation) || IsCellControllerInstall(operation); }
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
// Decode independently bound cleanup metadata and match its journal/head and
// mounted identities to this complete controller request. This grants neither
// current quiescence nor measurement: sealed local outcomes and writer custody
// must still be checked by the installed owner before using the set.
DWORD DecodeCellControllerCleanup(const CellControllerRequest&, std::span<const std::uint8_t>,
  const CellRuntimeCleanupBinding&, const std::wstring& owner_sid, const std::wstring& controller_sid,
  CellRuntimeCleanupSet*) noexcept;
bool DecodeCellControllerRequest(const std::array<std::uint8_t, kCellControllerRequestBytes>& bytes,
  const CellControllerNonce& nonce, CellControllerRequest* output) noexcept;
bool EncodeCellControllerRequest(const CellControllerRequest& request,
  std::array<std::uint8_t, kCellControllerRequestBytes>* output,
  const std::wstring& owner_sid = {}, const std::wstring& controller_sid = {}) noexcept;
constexpr std::size_t kCellControllerPoolHeaderBytes = 136;
constexpr std::size_t kCellControllerPoolMemberBytes = kCellControllerRequestBytes + 21 * 1024;
constexpr std::size_t kCellControllerPoolMemberFirstBytes = kCellControllerRequestBytes + 10 * 1024;
struct CellControllerPoolHistory final {
  CellFileSha256 snapshot_sha256{};
  std::vector<CellControllerRequest> members;
};
// Metadata only: the fingerprint is provenance, not authority. The admitted
// caller must retain lease/writer custody and prove exact physical membership.
DWORD DecodeCellControllerPoolHistory(std::span<const std::uint8_t>, const CellControllerRequest& current,
  const std::wstring& owner_sid, const std::wstring& controller_sid, CellControllerPoolHistory*) noexcept;
// Counts and identities only. The fixed encoding cannot assert process liveness,
// quiescence, quota enforcement or execution readiness. Matching binds it to the
// independently retained full history and trusted local protection principals.
bool EncodeCellControllerCapacity(const CellControllerNonce& nonce, const CellProvisioningFootprint& observation,
  CellControllerCapacityBytes* output) noexcept;
bool DecodeCellControllerCapacity(const CellControllerNonce& nonce, const CellControllerCapacityBytes& bytes,
  CellProvisioningFootprint* output) noexcept;
bool MatchesCellControllerCapacity(const CellControllerRequest& request, const CellProvisioningFootprint& observation,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept;
// Host VHDX and journal allocation, never the mounted-tree allocation a second
// time. The independent full history pins the original host objects and disk.
bool EncodeCellControllerBackingCapacity(const CellControllerNonce& nonce, const CellProvisioningBackingFootprint& observation,
  CellControllerBackingCapacityBytes* output) noexcept;
bool DecodeCellControllerBackingCapacity(const CellControllerNonce& nonce, const CellControllerBackingCapacityBytes& bytes,
  CellProvisioningBackingFootprint* output) noexcept;
bool MatchesCellControllerBackingCapacity(const CellControllerRequest& request, const CellProvisioningBackingFootprint& observation,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept;
// Inventory begins with the existing bounded summary encoding under its own
// message kind, followed by exact indexed chunks. Padding is zero and every
// object is validated before the consumer receives any of the inventory.
bool ValidateCellControllerInventory(const CellProvisioningInventory& observation) noexcept;
bool MatchesCellControllerInventory(const CellControllerRequest& request, const CellProvisioningInventory& observation,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept;
bool EncodeCellControllerInventoryChunk(const CellControllerNonce& nonce, std::uint32_t start,
  std::span<const CellDirectoryInventoryEntry> entries, CellControllerInventoryChunkBytes* output) noexcept;
bool DecodeCellControllerInventoryChunk(const CellControllerNonce& nonce, const CellControllerInventoryChunkBytes& bytes,
  CellControllerInventoryChunk* output) noexcept;
// Only checkpoint/receipt/current-authority/capacity frames are accepted; sizes are checked before reading
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
class CellControllerMeasurementHold {
 public:
  virtual ~CellControllerMeasurementHold() = default;
  virtual DWORD Verify() noexcept = 0;
};
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
  // The composed owner must establish and retain workload quiescence while
  // calling the journal's observation API. Missing ownership refuses capacity
  // requests. The installed service does not yet supply this owner.
  DWORD (*observe_capacity)(void*, CellProvisioningJournal&, const CellProvisioningAnchor&, const CellFileSha256&,
    const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellProvisioningFootprint*) noexcept = nullptr;
  DWORD (*observe_backing_capacity)(void*, CellProvisioningJournal&, const CellProvisioningAnchor&, const CellFileSha256&,
    DWORD wall_ms, const CellFootprintScanGuard&, CellProvisioningBackingFootprint*) noexcept = nullptr;
  DWORD (*observe_inventory)(void*, CellProvisioningJournal&, const CellProvisioningAnchor&, const CellFileSha256&,
    const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellProvisioningInventory*) noexcept = nullptr;
  // Operation 20 requires every admitted member and the shared installed layout.
  // The controller encodes and validates this whole result before any response.
  DWORD (*observe_pool_capacity)(void*, CellProvisioningJournal&, const CellControllerRequest&,
    const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellCapacityLayoutRecord*, CellPoolJoinedCapacity*) noexcept = nullptr;
  // Required only for operation 17. Owns a CellRuntimeSession on this same
  // authenticated pipe and original recovered journal, including fresh workload,
  // input and delivery authority. A volume check cannot replace those owners.
  // Retain the native outcome in the owner even when remote delivery fails;
  // this outer protocol reports handoff status and does not persist job results.
  // The installed service must leave this absent until all owners are composed.
  CellRuntimeSessionResult (*run_runtime)(void*, HANDLE pipe, HANDLE stop, ULONGLONG deadline,
    CellProvisioningJournal&, const CellControllerRuntimeBinding&) noexcept = nullptr;
  // Operation 18 only. Must use the guarded installed-controller copy adapter,
  // including local intent/outcome retention. No implicit installation fallback.
  RuntimeBundleInstallResult (*install_runtime)(void*, CellProvisioningJournal&,
    std::span<const std::uint8_t>, const CellRuntimeInstallBinding&, DWORD wall_ms,
    const CellFootprintScanGuard&) noexcept = nullptr;
  // Combined operation 21. The session retains writer exclusion through finish.
  // Canonical installation checks may exchange messages; local checks used
  // during capture transfer must only validate endpoint and retained custody.
  RuntimeBundleInstallResult (*install_runtime_capacity)(void*, HANDLE pipe, HANDLE stop, ULONGLONG deadline,
    CellProvisioningJournal&, const CellControllerRequest&, CellControllerMeasurementHold&,
    const CellFootprintScanGuard& canonical, const CellFootprintScanGuard& local) noexcept = nullptr;
  // Acquire actual writer exclusion before capacity cleanup reconciliation or
  // operation-18 journal access. The session retains and rechecks this hold
  // through observation/copy, local outcome retention and terminal receipt;
  // destruction releases it on every success/failure path. Missing owner refuses.
  // This does not supply canonical admission or a live capacity reservation.
  DWORD (*begin_measurement)(void*, const CellControllerRequest&, HANDLE stop, ULONGLONG deadline,
    std::unique_ptr<CellControllerMeasurementHold>*) noexcept = nullptr;
  DWORD (*finish_installation)(void*) noexcept = nullptr;
};
struct CellControllerSessionResult final {
  DWORD error = ERROR_INVALID_STATE;
  CellProvisioningPhase phase = CellProvisioningPhase::none;
  bool creation_attempted = false, receipt_written = false, receipt_acknowledged = false;
  std::uint32_t checkpoints = 0;
  std::uint32_t volume_authority_checks = 0;
  bool capacity_written = false;
  bool runtime_attempted = false, runtime_retained = false;
  bool installation_attempted = false, installation_retained = false;
  std::uint32_t installation_authority_checks = 0;
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
// Recovery never resumes effects. No cleanup, protocol retry or implicit ACK
// is supported. Connection nonces bind every exchange.
// Operation 14 observes a fully recorded, quiesced mounted workspace. It shares
// the original 256-byte request and complete recovery history, is capped at
// 60 seconds/20,000 entries/64 levels, and never enters a creation operation.
// Operation 15 observes the recorded host VHDX and journal under the same full
// history, current authority and 60-second deadline, with a distinct fixed frame.
// Operation 17 explicitly hands the same pipe and recovered native journal to
// a required runtime owner, after all 21 records and current canonical checks.
// Its separate 128-byte binding precedes workload bytes, and runtime_ready is
// only a handoff: fresh runtime admission and distinct retention remain required.
// Neither the installed service nor provisioning helper enables this operation
// until its full runtime authority owners are supplied. It never creates a disk.
CellControllerSessionResult RunCellControllerSession(HANDLE pipe, HANDLE stop,
  const CellControllerSessionOwner& owner) noexcept;
}
