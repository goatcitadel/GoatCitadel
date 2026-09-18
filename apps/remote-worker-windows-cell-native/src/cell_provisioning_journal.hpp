#pragma once
#include "cell_virtual_disk.hpp"
#include "cell_virtual_disk_layout.hpp"
#include "cell_ntfs_format.hpp"
#include "cell_volume_protection.hpp"
#include "cell_volume_mount.hpp"
#include "cell_mounted_workspace.hpp"
#include "cell_capacity.hpp"
#include <memory>

namespace goatcitadel::worker_cell {
// Post-create/inspection ceiling, not an OS quota or a transient usage guarantee.
constexpr std::uint64_t kCellProvisioningJournalMaximumAllocatedBytes = 64 * 1024;
using CellProvisioningRecord = std::array<std::uint8_t, 1024>;
struct CellProvisioningCommitter final {
  // Synchronous service bridge: independently retain these exact bytes, then
  // return their committed digest. The bridge must supply a bounded deadline.
  DWORD (*commit)(void*, const CellProvisioningRecord&, CellFileSha256*) noexcept = nullptr;
  void* context = nullptr;
};
struct CellProvisioningPlan final {
  CellFileSha256 assignment_binding{}, profile_sha256{};
  CellVirtualDiskSpec disk;
};
struct CellProvisioningAnchor final {
  CellFileIdentity file;
  CellFileSha256 prepared_sha256{};
  bool operator==(const CellProvisioningAnchor&) const = default;
};
struct CellProvisioningFootprint final {
  CellProvisioningAnchor anchor;
  CellFileSha256 assignment_binding{}, profile_sha256{}, checkpoint_sha256{};
  CellWorkspaceIdentities workspace;
  CellDirectoryFootprint footprint;
  bool operator==(const CellProvisioningFootprint&) const = default;
};
struct CellProvisioningInventory final {
  CellProvisioningAnchor anchor;
  CellFileSha256 assignment_binding{}, profile_sha256{}, checkpoint_sha256{};
  CellWorkspaceIdentities workspace;
  CellDirectoryInventory inventory;
  bool operator==(const CellProvisioningInventory&) const = default;
};
struct CellProvisioningBackingFootprint final {
  CellProvisioningAnchor anchor;
  CellFileSha256 assignment_binding{}, profile_sha256{}, checkpoint_sha256{};
  CellWorkspaceIdentities workspace;
  CellVirtualDiskCapacity backing;
  std::uint64_t journal_bytes = 0, journal_allocated_bytes = 0, host_file_allocated_bytes = 0;
};
struct CellProvisioningHostCapacity final {
  CellProvisioningBackingFootprint backing;
  CellCapacityAreaInventories areas;
};
// Synchronous borrowed custody, not a transferable file/mount capability.
// The callback may nest other journals before one complete-pool scan. All
// pointers, handles and guard contexts expire on return. Evidence is provisional
// until the enclosing call succeeds; discard runs after any attempted failure.
struct CellProvisioningBackingObserver final {
  void* context = nullptr;
  DWORD (*capture)(void*, const CellCapacityBorrowedFiles&, const CellProvisioningBackingFootprint&) noexcept = nullptr;
  void (*discard)(void*) noexcept = nullptr;
};
namespace detail {
class CellProvisioningBackingObservation final {
 public:
  explicit CellProvisioningBackingObservation(const CellProvisioningBackingObserver&) noexcept;
  ~CellProvisioningBackingObservation();
  CellProvisioningBackingObservation(const CellProvisioningBackingObservation&) = delete;
  CellProvisioningBackingObservation& operator=(const CellProvisioningBackingObservation&) = delete;
  bool Valid() const noexcept;
  const CellProvisioningBackingObserver& Bridge() const noexcept { return bridge_; }
  void Complete() noexcept { complete_ = attempted_ && !failed_; }
 private:
  CellProvisioningBackingObserver observer_, bridge_;
  bool attempted_ = false, failed_ = false, complete_ = false;
};
}
struct CellProvisioningJoinedCapacity final {
  CellProvisioningInventory guest;
  CellProvisioningHostCapacity host;
};
enum class CellProvisioningPhase : unsigned {
  none, prepared, workspace_started, workspace_recorded, disk_started, disk_recorded,
};
using CellVolumeProvisioningRecord = std::array<std::uint8_t, 1024>;
enum class CellVolumeProvisioningPhase : unsigned {
  none, attachment_intent, attached, initialize_intent, initialized, partition_intent, partitioned,
};
struct CellVolumeProvisioningCommitter final {
  DWORD (*commit)(void*, const CellVolumeProvisioningRecord&, CellFileSha256*) noexcept = nullptr;
  // Current exclusive provisioning and zero-workload authority, in addition to
  // the controller's installed identity, privilege and original creation claim.
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};
using CellFormatProvisioningRecord = std::array<std::uint8_t, 1024>;
enum class CellFormatProvisioningPhase : unsigned { none, intent, formatted };
struct CellFormatProvisioningCommitter final {
  DWORD (*commit)(void*, const CellFormatProvisioningRecord&, CellFileSha256*) noexcept = nullptr;
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};
using CellProtectionProvisioningRecord = std::array<std::uint8_t, 1024>;
enum class CellProtectionProvisioningPhase : unsigned { none, intent, protected_root };
struct CellProtectionProvisioningCommitter final {
  DWORD (*commit)(void*, const CellProtectionProvisioningRecord&, CellFileSha256*) noexcept = nullptr;
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};
using CellMountProvisioningRecord = std::array<std::uint8_t, 1024>;
enum class CellMountProvisioningPhase : unsigned { none, prepared, directory_recorded, mount_intent, mounted };
struct CellMountProvisioningCommitter final {
  DWORD (*commit)(void*, const CellMountProvisioningRecord&, CellFileSha256*) noexcept = nullptr;
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};
using CellMountedWorkspaceProvisioningRecord = std::array<std::uint8_t, 1024>;
enum class CellMountedWorkspaceProvisioningPhase : unsigned { none, intent, recorded };
struct CellMountedWorkspaceProvisioningCommitter final {
  DWORD (*commit)(void*, const CellMountedWorkspaceProvisioningRecord&, CellFileSha256*) noexcept = nullptr;
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
};

// Pure metadata validation for the authenticated controller transport. The
// independently retained creation facts bind every outer and nested record;
// successful validation does not establish OS readiness or permit writes.
DWORD ValidateCellProvisioningHistory(const CellProvisioningPlan& plan, const CellFileIdentity& parent,
  const std::wstring& name, const std::wstring& owner_sid, const std::wstring& controller_sid,
  const CellProvisioningAnchor& anchor, std::span<const CellProvisioningRecord> records,
  CellWorkspaceIdentities* workspace, CellVirtualDiskRecord* disk, CellFileSha256* disk_recorded_sha256) noexcept;
DWORD ValidateCellVolumeProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& disk_recorded_sha256,
  std::span<const CellVolumeProvisioningRecord> records) noexcept;
DWORD ValidateCellFormatProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& disk_recorded_sha256,
  std::span<const CellVolumeProvisioningRecord> volume, std::span<const CellFormatProvisioningRecord> records) noexcept;
DWORD ValidateCellProtectionProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& disk_recorded_sha256,
  const std::wstring& owner_sid, const std::wstring& controller_sid,
  std::span<const CellVolumeProvisioningRecord> volume, std::span<const CellFormatProvisioningRecord> format,
  std::span<const CellProtectionProvisioningRecord> records) noexcept;
DWORD ValidateCellMountProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellWorkspaceIdentities& workspace,
  const CellVirtualDiskRecord& disk, const CellFileSha256& disk_recorded_sha256,
  const std::wstring& owner_sid, const std::wstring& controller_sid,
  std::span<const CellVolumeProvisioningRecord> volume, std::span<const CellFormatProvisioningRecord> format,
  std::span<const CellProtectionProvisioningRecord> protection, std::span<const CellMountProvisioningRecord> records) noexcept;
DWORD ValidateCellMountedWorkspaceProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellWorkspaceIdentities& workspace,
  const CellVirtualDiskRecord& disk, const CellFileSha256& disk_recorded_sha256,
  const std::wstring& cell_name, const std::wstring& owner_sid, const std::wstring& controller_sid,
  std::span<const CellVolumeProvisioningRecord> volume, std::span<const CellFormatProvisioningRecord> format,
  std::span<const CellProtectionProvisioningRecord> protection, std::span<const CellMountProvisioningRecord> mount,
  std::span<const CellMountedWorkspaceProvisioningRecord> records) noexcept;

// Internal single-writer provisioning owner. The canonical service must hold the
// current assignment/profile/lease and reserve capacity before Create. A required
// committer acknowledges each exact flushed record before the next OS operation.
// It must retain the prepared anchor before permitting workspace creation.
// The file records local OS effects; it is not a replacement for canonical state.
//
// The journal is an exclusive, bounded, hash-chained file relative to the pinned
// protected parent. Intent is flushed before a filesystem/disk creation; verified
// object identities are flushed afterward. No operation overwrites, truncates,
// deletes, repairs, adopts an existing resource or retries an uncertain creation.
// OpenRecorded requires the independent plan/anchor and never creates anything.
// A recovered owner cannot resume provisioning; only the original uninterrupted
// creator can advance. The service must compare observed progress with canonical
// checkpoints; a valid prefix is not independent anti-rollback evidence.
// A started operation without its completion record returns ERROR_IO_INCOMPLETE,
// even when the current name is missing. Torn/corrupt files are retained unchanged.
//
// Optional volume preparation appends six GCCVOL01 records to the same file,
// preserving the first five GCCELLP1 records and the 64 KiB allocation ceiling.
// Attachment/layout require fresh authority and an independent acknowledgement
// of every flushed intent/completion. Recovery verifies only a complete volume
// chain; an interrupted prefix never resumes writes. Close never detaches.
// Optional NTFS formatting appends two GCCFMT01 records, binding the completed
// volume history and the formatter's exact intent/readback checkpoints. Partial
// formatting cannot resume; complete recovery also requires both canonical bytes.
// Optional root protection appends two GCCPRV01 records tied to the complete
// format history and frozen controller descriptor. Recovery verifies all fifteen
// canonical records and current OS state; it cannot resume a permission write.
// Optional mounting appends four GCCMNV01 records tied to all fifteen preceding
// records and the recorded host cell root. Recovery requires all nineteen exact
// canonical records; it never creates a missing directory or retries a mount.
// Optional mounted workspace creation appends two GCCMWP01 records bound to the
// complete mount history and canonical cell name. Recovery requires all twenty-one
// exact records; it cannot create missing workspace directories or repair ACLs.
// This does not launch, settle or clean up a cell. Recorded resources do
// not establish mutable-child protection, quota enforcement or backend readiness.
// Callers serialize this object and supply their current authority before each
// mutation. Synchronous filesystem flushes still require an outer service watchdog.
class CellProvisioningJournal final {
 public:
  CellProvisioningJournal() = default;
  ~CellProvisioningJournal();
  CellProvisioningJournal(const CellProvisioningJournal&) = delete;
  CellProvisioningJournal& operator=(const CellProvisioningJournal&) = delete;
  DWORD Create(HANDLE parent, const CellFileIdentity& expected_parent, const std::wstring& cell_name,
               const std::wstring& owner_sid, const std::wstring& controller_sid,
               const CellProvisioningPlan& plan, CellProvisioningAnchor* output,
               const CellProvisioningCommitter* committer) noexcept;
  // Completed volume recovery requires all six canonical records. Omitting them
  // preserves the legacy creation-only protocol and refuses a volume journal.
  // Formatted/protected journals additionally require both records of each stage;
  // a mounted journal requires all four mount records as well. A mounted-workspace
  // journal additionally requires its two independently retained records.
  DWORD OpenRecorded(HANDLE parent, const CellFileIdentity& expected_parent, const std::wstring& cell_name,
                     const std::wstring& owner_sid, const std::wstring& controller_sid,
                     const CellProvisioningPlan& plan, const CellProvisioningAnchor& anchor,
                     std::span<const CellVolumeProvisioningRecord> expected_volume = {},
                     std::span<const CellFormatProvisioningRecord> expected_format = {},
                     std::span<const CellProtectionProvisioningRecord> expected_protection = {},
                     std::span<const CellMountProvisioningRecord> expected_mount = {},
                     std::span<const CellMountedWorkspaceProvisioningRecord> expected_mounted_workspace = {}) noexcept;
  DWORD ProvisionWorkspace(const CellProvisioningAnchor& persisted_anchor) noexcept;
  DWORD ProvisionDisk(const CellProvisioningAnchor& persisted_anchor, DWORD wall_limit_ms,
                      HANDLE cancellation = nullptr) noexcept;
  DWORD ProvisionVolume(const CellProvisioningAnchor& persisted_anchor,
                        const CellVolumeProvisioningCommitter& committer, DWORD wall_limit_ms,
                        HANDLE cancellation = nullptr) noexcept;
  DWORD ProvisionFormat(const CellProvisioningAnchor& persisted_anchor,
                        const CellFormatProvisioningCommitter& committer, DWORD wall_limit_ms,
                        HANDLE cancellation = nullptr) noexcept;
  DWORD ProvisionProtection(const CellProvisioningAnchor& persisted_anchor,
                            const CellProtectionProvisioningCommitter& committer, DWORD wall_limit_ms,
                            HANDLE cancellation = nullptr) noexcept;
  DWORD ProvisionMount(const CellProvisioningAnchor& persisted_anchor,
                       const CellMountProvisioningCommitter& committer, DWORD wall_limit_ms,
                       HANDLE cancellation = nullptr) noexcept;
  DWORD ProvisionMountedWorkspace(const CellProvisioningAnchor& persisted_anchor,
    const CellMountedWorkspaceProvisioningCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation = nullptr) noexcept;
  DWORD Verify() noexcept;
  DWORD RecordWorkspace(CellWorkspaceIdentities* output) noexcept;
  DWORD RecordMountedWorkspace(CellWorkspaceIdentities* output) noexcept;
  // Serialized, explicit runtime installation into the fully recorded guest.
  // The guard supplies current install, source-custody and complete-pool authority.
  // Anchor/head/lifetime changes refuse; partial bytes remain for accounting.
  // No provisioning checkpoint, retry or execution readiness is inferred.
  RuntimeBundleInstallResult InstallRuntime(const CellProvisioningAnchor& expected_anchor,
    const CellFileSha256& expected_head, PinnedCellRuntimeBundle& source, PinnedCellRuntimeBundle& output,
    DWORD wall_limit_ms, const CellFootprintScanGuard& guard) noexcept;
  // Read-only observation bound to independently retained anchor/head bytes and
  // the complete twenty-one-record journal. The caller must retain assignment
  // authority, workload quiescence and an outer process watchdog. Errors clear
  // output; this never provisions, resumes a partial journal or enforces quotas.
  DWORD ObserveMountedFootprint(const CellProvisioningAnchor& expected_anchor, const CellFileSha256& expected_head,
    const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, CellProvisioningFootprint* output) noexcept;
  // An optional borrowed job binding checks the decoded cell name and guest
  // work identity at each guard boundary. An explicit empty binding refuses.
  // It must outlive this call; the owning job runner still gates publication.
  DWORD ObserveMountedInventory(const CellProvisioningAnchor& expected_anchor, const CellFileSha256& expected_head,
    const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, CellProvisioningInventory* output,
    const CellFootprintCellBinding* binding = nullptr) noexcept;
  // The cell binding is mandatory for retained guest evidence. The caller
  // retains journal/volume custody and quiescence through the joined capture.
  DWORD CaptureMountedInventory(const CellProvisioningAnchor& expected_anchor, const CellFileSha256& expected_head,
    const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, const CellFootprintCellBinding& binding,
    CellDirectoryInventoryPins& pins, CellProvisioningInventory* output) noexcept;
  // Host-file accounting for a completely recorded creation or mounted workspace.
  // Binds the journal and original VHDX to independent anchor/head bytes. Guest
  // allocation must not be added to these backing-file charges. Other host
  // roots, directory/volume metadata and retained owners still need inventory.
  // Requires serialized quiescence/current authority and an outer watchdog;
  // this observation never advances the journal, mounts or launches anything.
  DWORD ObserveBackingFootprint(const CellProvisioningAnchor& expected_anchor, const CellFileSha256& expected_head,
    DWORD wall_limit_ms, const CellFootprintScanGuard& guard, CellProvisioningBackingFootprint* output) noexcept;
  // Retain this original journal/backing and, when mounted, its exact mount leaf
  // throughout the callback. Global writer exclusion and complete pool admission
  // remain the caller's responsibility. No storage creation or repair occurs.
  DWORD WithBackingCapacity(const CellProvisioningAnchor&, const CellFileSha256&, DWORD wall_limit_ms,
    const CellFootprintScanGuard&, const CellProvisioningBackingObserver&, CellProvisioningBackingFootprint*) noexcept;
  // Joins retained journal/backing handles to a separately recorded host layout.
  // The caller owns global quiescence. No provisioning, path adoption, metadata
  // repair, guest-volume traversal or quota authority is supplied by this read.
  DWORD ObserveHostCapacity(const CellProvisioningAnchor& expected_anchor, const CellFileSha256& expected_head,
    CellCapacityLayout& layout, const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits,
    const CellFootprintScanGuard& guard, CellProvisioningHostCapacity* output,
    const CellCapacityCaptureObserver* observer = nullptr) noexcept;
  // Captures guest handles inside the held host observation. Both outputs stay
  // provisional through the final host/journal checks; failures clear both.
  // The caller still owns complete pool coverage and global writer quiescence.
  DWORD ObserveJoinedCapacity(const CellProvisioningAnchor& expected_anchor, const CellFileSha256& expected_head,
    CellCapacityLayout& layout, const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits,
    const CellFootprintScanGuard& guard, const CellFootprintCellBinding& binding,
    CellProvisioningJoinedCapacity* output) noexcept;
  DWORD RecordDisk(CellVirtualDiskRecord* output) noexcept;
  // Read-only derived plan, after fresh verification of disk_recorded. It is not
  // an attachment/partition permit and does not resume a recovered creator.
  DWORD RecordDiskLayoutPlan(CellDiskLayoutPlan* output) noexcept;
  DWORD RecordCheckpoints(std::vector<CellProvisioningRecord>* output) noexcept;
  DWORD RecordVolumeCheckpoints(std::vector<CellVolumeProvisioningRecord>* output) noexcept;
  DWORD RecordFormatCheckpoints(std::vector<CellFormatProvisioningRecord>* output) noexcept;
  DWORD RecordProtectionCheckpoints(std::vector<CellProtectionProvisioningRecord>* output) noexcept;
  DWORD RecordMountCheckpoints(std::vector<CellMountProvisioningRecord>* output) noexcept;
  DWORD RecordMountedWorkspaceCheckpoints(std::vector<CellMountedWorkspaceProvisioningRecord>* output) noexcept;
  CellProvisioningPhase Phase() const noexcept { return phase_; }
  CellVolumeProvisioningPhase VolumePhase() const noexcept { return volume_phase_; }
  CellFormatProvisioningPhase FormatPhase() const noexcept { return format_phase_; }
  CellProtectionProvisioningPhase ProtectionPhase() const noexcept { return protection_phase_; }
  CellMountProvisioningPhase MountPhase() const noexcept { return mount_phase_; }
  CellMountedWorkspaceProvisioningPhase MountedWorkspacePhase() const noexcept { return mounted_workspace_phase_; }
  void Close() noexcept;

 private:
  friend struct CellProvisioningJournalTestPeer;
  friend class CellJournalRuntimeRunner;
  friend class CellRuntimeLocalOutcome;
  friend class CellJoinedCapacityCollector;
  struct CapacityReadScope final {
    explicit CapacityReadScope(CellProvisioningJournal& owner) noexcept;
    ~CapacityReadScope();
    CellProvisioningJournal& owner;
    bool entered = false;
  };
  DWORD Initialize(HANDLE parent, const CellFileIdentity& expected_parent, const std::wstring& cell_name,
                   const std::wstring& owner_sid, const std::wstring& controller_sid,
                   const CellProvisioningPlan& plan) noexcept;
  DWORD OpenFile(bool create) noexcept;
  DWORD InspectFile(std::uint64_t* size) noexcept;
  DWORD ReadJournal() noexcept;
  DWORD Append(CellProvisioningPhase next) noexcept;
  DWORD AppendVolume(CellVolumeProvisioningPhase next, const CellDiskLayoutCheckpoint* layout = nullptr) noexcept;
  DWORD CheckVolume() noexcept;
  DWORD RecoverVolume() noexcept;
  struct VolumeOperations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*attach)(void*) noexcept;
    DWORD (*layout)(void*, const CellDiskLayoutCommitter&) noexcept;
    void* context;
  };
  DWORD RunVolume(const VolumeOperations& operations, const CellVolumeProvisioningCommitter& committer,
                  ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD AppendFormat(CellFormatProvisioningPhase next, const CellNtfsFormatCheckpoint& checkpoint) noexcept;
  DWORD CheckFormat() noexcept;
  DWORD RecoverFormat() noexcept;
  struct FormatOperations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*format)(void*, const CellNtfsFormatCommitter&) noexcept;
    void* context;
  };
  DWORD RunFormat(const FormatOperations& operations, const CellFormatProvisioningCommitter& committer,
                  ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD AppendProtection(CellProtectionProvisioningPhase next, const CellVolumeProtectionCheckpoint& checkpoint) noexcept;
  DWORD CheckProtection() noexcept;
  DWORD RecoverProtection() noexcept;
  struct ProtectionOperations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*protect)(void*, const CellVolumeProtectionCommitter&) noexcept;
    void* context;
  };
  DWORD RunProtection(const ProtectionOperations& operations, const CellProtectionProvisioningCommitter& committer,
                      ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD AppendMount(CellMountProvisioningPhase next, const CellVolumeMountCheckpoint& checkpoint) noexcept;
  DWORD CheckMount() noexcept;
  DWORD RecoverMount() noexcept;
  struct MountOperations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*mount)(void*, const CellVolumeMountCommitter&) noexcept;
    void* context;
  };
  DWORD RunMount(const MountOperations& operations, const CellMountProvisioningCommitter& committer,
                 ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD AppendMountedWorkspace(CellMountedWorkspaceProvisioningPhase next, const CellMountedWorkspaceCheckpoint& checkpoint) noexcept;
  DWORD CheckMountedWorkspace() noexcept;
  DWORD RecoverMountedWorkspace() noexcept;
  struct MountedWorkspaceOperations final {
    DWORD (*verify)(void*) noexcept;
    DWORD (*create)(void*, const CellMountedWorkspaceCommitter&) noexcept;
    void* context;
  };
  DWORD RunMountedWorkspace(const MountedWorkspaceOperations& operations, const CellMountedWorkspaceProvisioningCommitter& committer,
    ULONGLONG deadline, HANDLE cancellation) noexcept;
  DWORD Refuse(DWORD error) noexcept;
  DWORD ReadMountedFootprint(DWORD (*read)(void*, const CellFootprintScanLimits&, const CellFootprintScanGuard&,
    CellDirectoryFootprint*) noexcept, void* context, const CellProvisioningAnchor& expected_anchor,
    const CellFileSha256& expected_head, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
    CellProvisioningFootprint* output) noexcept;
  DWORD ReadMountedInventory(DWORD (*read)(void*, const CellFootprintScanLimits&, const CellFootprintScanGuard&,
    CellDirectoryInventory*) noexcept, void* context, const CellProvisioningAnchor& expected_anchor,
    const CellFileSha256& expected_head, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
    CellProvisioningInventory* output, const CellFootprintCellBinding* binding = nullptr) noexcept;
  template <typename Observation, typename Output>
  DWORD ReadMountedCapacity(DWORD (*read)(void*, const CellFootprintScanLimits&, const CellFootprintScanGuard&,
    Observation*) noexcept, void* context, const CellProvisioningAnchor& expected_anchor,
    const CellFileSha256& expected_head, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
    Output* output, std::uint32_t maximum_entries, const CellFootprintCellBinding* binding) noexcept;
  struct HostCapacityInput final {
    CellCapacityLayout* layout;
    CellCapacityLayoutRecord record;
    CellFootprintScanLimits limits;
    CellCapacityAreaInventories* output;
    const CellCapacityCaptureObserver* observer;
  };
  struct JoinedCapacityReaders final {
    void* context;
    DWORD (*host)(void*, const CellProvisioningAnchor&, const CellFileSha256&, CellCapacityLayout&,
      const CellCapacityLayoutRecord&, const CellFootprintScanLimits&, const CellFootprintScanGuard&,
      CellProvisioningHostCapacity*, const CellCapacityCaptureObserver*) noexcept;
    DWORD (*guest)(void*, const CellProvisioningAnchor&, const CellFileSha256&, const CellFootprintScanLimits&,
      const CellFootprintScanGuard&, const CellFootprintCellBinding&, CellDirectoryInventoryPins&, CellProvisioningInventory*) noexcept;
  };
  DWORD ReadJoinedCapacity(const CellProvisioningAnchor&, const CellFileSha256&, CellCapacityLayout&,
    const CellCapacityLayoutRecord&, const CellFootprintScanLimits&, const CellFootprintScanGuard&,
    const CellFootprintCellBinding&, const JoinedCapacityReaders&, CellProvisioningJoinedCapacity*) noexcept;
  DWORD ReadBackingFootprint(const CellProvisioningAnchor&, const CellFileSha256&, DWORD,
    const CellFootprintScanGuard&, CellProvisioningBackingFootprint*, const HostCapacityInput*,
    const CellProvisioningBackingObserver* = nullptr) noexcept;
  CellWorkspaceDirectories parent_guard_, workspace_;
  CellVirtualDiskFile disk_;
  CellVirtualDiskAttachment attachment_;
  CellVirtualDiskDevice device_;
  CellVirtualDiskLayout layout_;
  std::unique_ptr<CellNtfsFormat> formatter_;
  std::unique_ptr<CellVolumeProtection> protection_;
  std::unique_ptr<CellVolumeMount> mount_;
  std::unique_ptr<CellMountedWorkspace> mounted_workspace_;
  HANDLE file_ = INVALID_HANDLE_VALUE;
  std::uint64_t lifetime_revision_ = 0;
  CellProvisioningPlan plan_;
  CellProvisioningAnchor anchor_;
  CellProvisioningCommitter committer_;
  CellVolumeProvisioningCommitter volume_committer_;
  CellFormatProvisioningCommitter format_committer_;
  CellProtectionProvisioningCommitter protection_committer_;
  CellMountProvisioningCommitter mount_committer_;
  CellMountedWorkspaceProvisioningCommitter mounted_workspace_committer_;
  CellWorkspaceIdentities workspace_record_;
  CellVirtualDiskRecord disk_record_;
  std::wstring name_, owner_, controller_;
  std::vector<std::uint8_t> descriptor_, records_;
  CellProvisioningPhase phase_ = CellProvisioningPhase::none;
  CellVolumeProvisioningPhase volume_phase_ = CellVolumeProvisioningPhase::none;
  std::vector<CellDiskLayoutCheckpoint> layout_records_;
  ULONGLONG volume_deadline_ = 0;
  HANDLE volume_cancellation_ = nullptr;
  CellFormatProvisioningPhase format_phase_ = CellFormatProvisioningPhase::none;
  std::vector<CellNtfsFormatCheckpoint> format_records_;
  ULONGLONG format_deadline_ = 0;
  HANDLE format_cancellation_ = nullptr;
  CellProtectionProvisioningPhase protection_phase_ = CellProtectionProvisioningPhase::none;
  std::vector<CellVolumeProtectionCheckpoint> protection_records_;
  ULONGLONG protection_deadline_ = 0;
  HANDLE protection_cancellation_ = nullptr;
  CellMountProvisioningPhase mount_phase_ = CellMountProvisioningPhase::none;
  std::vector<CellVolumeMountCheckpoint> mount_records_;
  ULONGLONG mount_deadline_ = 0;
  HANDLE mount_cancellation_ = nullptr;
  CellMountedWorkspaceProvisioningPhase mounted_workspace_phase_ = CellMountedWorkspaceProvisioningPhase::none;
  std::vector<CellMountedWorkspaceCheckpoint> mounted_workspace_records_;
  ULONGLONG mounted_workspace_deadline_ = 0;
  HANDLE mounted_workspace_cancellation_ = nullptr;
  bool healthy_ = false;
  bool creating_ = false;
  unsigned capacity_read_depth_ = 0;
  bool capacity_close_pending_ = false;
  bool runtime_install_active_ = false;
};
}
