#pragma once
#include "cell_filesystem.hpp"
#include <array>
#include <memory>
#include <span>
#include <string_view>
#include <vector>

namespace goatcitadel::worker_cell {
// Structural validation only; resolving a selection still requires held pins.
bool IsCellRuntimeFileSelectionPath(std::wstring_view path) noexcept;
class CellWorkspaceDirectories;
class CellCapacityMountLeaf;
struct CellWorkspaceIdentities;
struct CellDirectoryFootprint final {
  CellFileIdentity root{};
  std::uint64_t logical_file_bytes = 0;
  std::uint64_t allocated_bytes = 0;
  std::uint32_t file_count = 0;
  std::uint32_t directory_count = 0;  // Includes the admitted root.
  bool operator==(const CellDirectoryFootprint&) const = default;
};

struct CellDirectoryInventoryEntry final {
  CellFileIdentity identity{};
  bool directory = false;
  std::uint64_t logical_file_bytes = 0;
  std::uint64_t allocated_bytes = 0;
  bool operator==(const CellDirectoryInventoryEntry&) const = default;
};
struct CellDirectoryInventory final {
  CellDirectoryFootprint footprint{};
  std::vector<CellDirectoryInventoryEntry> entries;
  bool operator==(const CellDirectoryInventory&) const = default;
};

// Same stable order as REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.
enum class CellCapacityArea : unsigned {
  mutable_root, input_staging, backup_staging, artifact_staging, immutable_artifact,
  retained_outbox, database_sidecar, backup_publication, manifest, proxy_sidecar,
  diagnostic, failed_cleanup, quarantine_evidence, count,
};
inline constexpr std::size_t kCellCapacityAreaCount = static_cast<unsigned>(CellCapacityArea::count);
struct CellCapacityAreaRoot final {
  HANDLE handle = INVALID_HANDLE_VALUE;
  CellFileIdentity identity{};
};
using CellCapacityAreaRoots = std::array<CellCapacityAreaRoot, kCellCapacityAreaCount>;
using CellCapacityAreaInventories = std::array<CellDirectoryInventory, kCellCapacityAreaCount>;
struct CellCapacityLayoutRecord final {
  CellFileSha256 assignment_binding{}, profile_sha256{};
  std::array<CellFileIdentity, kCellCapacityAreaCount> roots{};
  bool operator==(const CellCapacityLayoutRecord&) const = default;
};

struct CellFootprintScanLimits final {
  std::uint32_t max_entries = 20000;  // Includes files and directories.
  std::uint32_t max_depth = 64;      // The admitted root has depth zero.
  DWORD wall_limit_ms = 10000;
};

struct CellFootprintScanGuard final {
  DWORD (*authorize)(void*) noexcept = nullptr;
  void* context = nullptr;
  HANDLE cancellation = nullptr;
};

// A separate native owner may already hold a journal/backing file open for
// writing. Borrow only its exact retained handle, parent, identity and measured
// counts; never reopen an arbitrary locked file with broader sharing. The
// owner must keep these files quiescent and recheck journal custody in guard.
struct CellCapacityBorrowedFile final {
  HANDLE handle = INVALID_HANDLE_VALUE;
  CellFileIdentity parent{}, identity{};
  std::uint64_t logical_bytes = 0, allocated_bytes = 0;
};
struct CellCapacityBorrowedFiles final {
  std::span<const CellCapacityBorrowedFile> files;
  CellFootprintScanGuard guard;
  // Callback-scoped native mount capabilities. Each must occur exactly once
  // under its recorded parent; the host scan counts the directory, never its
  // mounted contents. All other reparse points remain forbidden.
  std::span<const CellCapacityMountLeaf* const> mounts;
};

// Retains every directory/file handle after an inventory read so another
// native owner can finish a joined observation. Capture borrows authority only
// during that call; Check performs metadata/membership and deadline checks,
// never calls the old authority context, and is not current execution authority.
// The caller retains the admitted root, cancellation handle and global writer
// quiescence until Close/destruction. Serialize calls; never reuse an open owner.
class CellDirectoryInventoryPins final {
 public:
  CellDirectoryInventoryPins() noexcept;
  ~CellDirectoryInventoryPins();
  CellDirectoryInventoryPins(const CellDirectoryInventoryPins&) = delete;
  CellDirectoryInventoryPins& operator=(const CellDirectoryInventoryPins&) = delete;
  DWORD Capture(HANDLE admitted_root, const CellFileIdentity& expected_root,
    const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
    CellDirectoryInventory* output) noexcept;
  DWORD Check() const noexcept;
  // Resolve a literal relative path beneath an independently admitted directory
  // using captured names/identities only. No path is reopened or normalized by
  // the OS. Current authority and the complete inventory are checked again
  // before returning the entry. The caller separately governs disclosure.
  DWORD ResolveFile(const CellFileIdentity& admitted_directory, std::wstring_view relative_path,
    const CellFootprintScanGuard& authority, CellDirectoryInventoryEntry* output) noexcept;
  // Read one exact retained file below an independently admitted directory,
  // proving ancestry from pinned memberships, never a caller-supplied path. The caller
  // supplies fresh authority and preserves writer quiescence. Reads retain the
  // capture deadline and cancellation, check authority between 64 KiB chunks,
  // and revalidate the complete pinned inventory before publishing any bytes.
  // Once a read begins, failure clears output and releases read custody. No
  // partial export or retry permission is implied. Blocking native calls still
  // require the owner's outer watchdog. This does not authorize publication.
  DWORD ReadFileContent(const CellFileIdentity& admitted_directory, const CellDirectoryInventoryEntry& expected, std::uint32_t maximum_bytes,
    const CellFootprintScanGuard& authority, std::vector<std::uint8_t>* output) noexcept;
  void Close() noexcept;
  bool Ready() const noexcept;
 private:
  struct State;
  std::unique_ptr<State> state_;
  bool capturing_ = false, interrupted_ = false;
};

struct CellCapacityCaptureObserver;
struct CellCapacityChild final {
  std::wstring name;
  CellFileIdentity identity;
  bool directory = false;
};
// Borrowed only for the synchronous observer call. Check revalidates held
// metadata and memberships without calling external authority. This is not
// global writer quiescence, and the view must never escape the callback.
class CellCapacityPinnedView final {
 public:
  CellCapacityPinnedView(const CellCapacityPinnedView&) = delete;
  CellCapacityPinnedView& operator=(const CellCapacityPinnedView&) = delete;
  DWORD Check() const noexcept { return check_(context_); }
  // Exact direct-child closure against independently retained names/identities.
  // Uses pinned membership only; never opens or adopts an expected path.
  DWORD VerifyChildren(const CellFileIdentity& directory, std::span<const CellCapacityChild> expected) const noexcept {
    return children_(context_, directory, expected);
  }
 private:
  CellCapacityPinnedView(void* context, DWORD (*check)(void*) noexcept,
    DWORD (*children)(void*, const CellFileIdentity&, std::span<const CellCapacityChild>) noexcept)
    : context_(context), check_(check), children_(children) {}
  void* context_;
  DWORD (*check_)(void*) noexcept;
  DWORD (*children_)(void*, const CellFileIdentity&, std::span<const CellCapacityChild>) noexcept;
  friend DWORD ScanCellCapacityAreas(const CellCapacityAreaRoots&, const CellFootprintScanLimits&,
    const CellFootprintScanGuard&, CellCapacityAreaInventories*, const CellCapacityBorrowedFiles*,
    const CellCapacityCaptureObserver*) noexcept;
};
// Related evidence remains provisional until the enclosing capture succeeds.
// Both callbacks are required. Discard is called once after an attempted
// capture if any enclosing validation fails; it must not throw or reenter.
struct CellCapacityCaptureObserver final {
  void* context = nullptr;
  DWORD (*capture)(void*, const CellCapacityPinnedView&) noexcept = nullptr;
  void (*discard)(void*) noexcept = nullptr;
};
namespace detail {
class CellCapacityObservation final {
 public:
  explicit CellCapacityObservation(const CellCapacityCaptureObserver* observer) noexcept;
  ~CellCapacityObservation();
  CellCapacityObservation(const CellCapacityObservation&) = delete;
  CellCapacityObservation& operator=(const CellCapacityObservation&) = delete;
  bool Valid() const noexcept;
  const CellCapacityCaptureObserver* Bridge() const noexcept { return present_ ? &bridge_ : nullptr; }
  DWORD Capture(const CellCapacityPinnedView& view) noexcept;
  void Complete() noexcept { complete_ = true; }
 private:
  void Discard() noexcept;
  CellCapacityCaptureObserver observer_{}, bridge_{};
  bool present_ = false, attempted_ = false, discarded_ = false, complete_ = false;
};
}

// Borrowed trusted-owner check against independently decoded journal identity.
// This is separate from a generic tree guard so readers cannot silently ignore
// the cell binding. The context must remain alive for the complete observation.
struct CellFootprintCellBinding final {
  DWORD (*authorize)(const void*, const std::wstring&, const CellFileIdentity&) noexcept = nullptr;
  const void* context = nullptr;
};

// Read-only capacity input for an owner-quiesced tree. The caller retains the
// admitted directory handle and its independently recorded identity, proves no
// workload may mutate the tree, and rechecks canonical authority before using
// the observation. This function never adopts a path or creates/repairs objects.
// Opens are relative to verified handles and refuse links, ADS and mount
// crossings. Sparse/compressed files retain distinct logical/allocated counts.
// All entry handles remain held through final metadata and membership readback.
// Any incomplete, changed or unsupported read clears output and returns an error.
// This is neither an atomic snapshot of a live tree nor hard quota enforcement.
// Allocations exclude volume metadata and footprint outside this root; those
// require the volume/pool inventory owner. A process watchdog must bound any
// blocking OS call or authority callback beyond the cooperative deadline.
DWORD ScanCellDirectoryFootprint(HANDLE admitted_root, const CellFileIdentity& expected_root,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryFootprint* output) noexcept;

// The protected workspace owner supplies the root handle. Its complete recorded
// identities and root security are revalidated after each authority callback and
// after the scan. Counts include root/control/runtime/work without overlapping
// scans. The same quiescence, watchdog and incomplete-footprint limits apply.
DWORD ScanCellWorkspaceFootprint(CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities& recorded,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryFootprint* output) noexcept;

// The same handle-bound read with identity-only entries for deduplicated
// accounting. Includes the root and zero-byte files; entries are sorted by
// volume/file identity. At most 20,000 entries may be requested. Neither names
// nor paths are exported. Any failure clears both entries and totals. These
// records still cover only the admitted tree, not the complete storage pool.
DWORD ScanCellDirectoryInventory(HANDLE admitted_root, const CellFileIdentity& expected_root,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryInventory* output) noexcept;
DWORD ScanCellWorkspaceInventory(CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities& recorded,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryInventory* output) noexcept;
// Same workspace custody checks, with explicit ownership of the retained
// inventory handles. The caller supplies an unopened owner and closes it after
// the complete joined observation; any failure withholds output and closes it.
DWORD CaptureCellWorkspaceInventory(CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities& recorded,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryInventoryPins& pins, CellDirectoryInventory* output) noexcept;

// Enumerate all independently admitted area roots in one owner-quiesced window.
// Every area requires a real root, even when empty. Roots must be disjoint;
// duplicate physical identities, nested roots and partial coverage are refused.
// Holds every enumerated handle across all areas and rechecks all metadata and
// memberships after the final owner callback. Limits/deadline apply globally.
// Caller proves global writer quiescence and coverage, and retains root handles.
// This does not infer absent areas, scan VHDX contents, or enforce pool quotas.
DWORD ScanCellCapacityAreas(const CellCapacityAreaRoots& roots, const CellFootprintScanLimits& limits,
  const CellFootprintScanGuard& guard, CellCapacityAreaInventories* output,
  const CellCapacityBorrowedFiles* borrowed = nullptr,
  const CellCapacityCaptureObserver* observer = nullptr) noexcept;

// Trusted installed-host policy, never serialized or supplied by a workload.
// Verify the exact area's installer-owned ACL policy on the pinned handle.
// Retain context for the entire layout lifetime; callbacks must not mutate roots.
struct CellCapacityRootSecurity final {
  void* context = nullptr;
  DWORD (*verify)(void*, CellCapacityArea, HANDLE, const CellFileIdentity&) noexcept = nullptr;
};
// Read-only owner for independently retained host-area identities. The default
// path requires exact controller security; mixed installed roots require the
// explicit trusted-host verifier above. Mutable guest roots use the journal's
// mounted-workspace owner. No path adoption, root creation or ACL repair occurs.
// Serialize calls and retain policy context, current custody and global writer
// quiescence through the complete lifetime, under an outer watchdog.
class CellCapacityLayout final {
 public:
  CellCapacityLayout() = default;
  CellCapacityLayout(const CellCapacityLayout&) = delete;
  CellCapacityLayout& operator=(const CellCapacityLayout&) = delete;
  DWORD OpenRecorded(const CellCapacityLayoutRecord& record, const CellCapacityAreaRoots& roots,
    const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept;
  DWORD OpenRecordedWithSecurity(const CellCapacityLayoutRecord& record, const CellCapacityAreaRoots& roots,
    const CellCapacityRootSecurity& security) noexcept;
  DWORD OpenRecordedBytes(std::span<const std::uint8_t> bytes, const CellFileSha256& assignment_binding,
    const CellFileSha256& profile_sha256, const CellCapacityAreaRoots& roots,
    const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept;
  DWORD Scan(const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits,
    const CellFootprintScanGuard& guard, CellCapacityAreaInventories* output,
    const CellCapacityBorrowedFiles* borrowed = nullptr,
    const CellCapacityCaptureObserver* observer = nullptr) noexcept;
  DWORD Capture(const CellCapacityLayoutRecord& record, const CellFileSha256& nonce, const CellFootprintScanLimits& limits,
    const CellFootprintScanGuard& guard, std::vector<std::uint8_t>* output,
    const CellCapacityBorrowedFiles* borrowed = nullptr,
    const CellCapacityCaptureObserver* observer = nullptr) noexcept;
  void Close() noexcept;
 private:
  friend class CellJoinedCapacityCollector;
  friend class CellPoolCapacityCollector;
  friend struct CellCapacityLayoutTestPeer;
  DWORD VerifyRetainedSecurity(const std::wstring&, const std::wstring&,
    const CellCapacityRootSecurity&, const std::vector<std::uint8_t>&) noexcept;
  DWORD Verify() noexcept;
  DWORD OpenRoots(const CellCapacityLayoutRecord&, const CellCapacityAreaRoots&) noexcept;
  CellCapacityLayoutRecord record_;
  CellCapacityAreaRoots roots_;
  std::array<std::unique_ptr<PinnedCellLaunchFiles>, kCellCapacityAreaCount> pins_;
  std::vector<std::uint8_t> descriptor_;
  CellCapacityRootSecurity security_;
  bool open_ = false, scanning_ = false, interrupted_ = false, verifying_ = false;
};
}
