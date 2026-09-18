#pragma once
#include "cell_provisioning_journal.hpp"
#include "cell_runtime_bundle.hpp"

namespace goatcitadel::worker_cell {
struct CellJournalRuntimeReference final {
  CellProvisioningAnchor anchor;
  CellFileSha256 checkpoint_sha256{};
  CellFootprintScanLimits inventory_limits;
};
// Compact counts tied to the result's verified inventory and checkpoint. These
// are not a replacement for the journal's independently retained host identities.
struct CellRuntimeBackingCounts final {
  std::uint64_t file_bytes = 0, allocated_bytes = 0, journal_bytes = 0, journal_allocated_bytes = 0;
  bool operator==(const CellRuntimeBackingCounts&) const = default;
};
// Trusted owner selects identities from the captured inventory, never paths.
// Selection does not authorize disclosure. Invoked synchronously while the job
// is empty and inventory handles are retained; the callback must not escape.
struct CellRuntimeFileStaging final {
  void* context = nullptr;
  DWORD (*select)(void*, const CellDirectoryInventory&, std::vector<CellDirectoryInventoryEntry>*) noexcept = nullptr;
  std::uint32_t maximum_files = 64, maximum_file_bytes = 1048576, maximum_total_bytes = 64 * 1048576;
  // Alternative to identity selection: exact approved paths relative to work.
  // Supply exactly one selector. Names resolve through the held inventory.
  DWORD (*select_paths)(void*, std::vector<std::wstring>*) noexcept = nullptr;
};
struct CellRuntimeStagedFile final {
  CellDirectoryInventoryEntry entry;
  std::vector<std::uint8_t> bytes;
  // Empty for identity-only selection. Not part of GCRFA001 or a publication grant.
  std::wstring relative_path;
  CellRuntimeStagedFile() = default;
  CellRuntimeStagedFile(const CellRuntimeStagedFile&) = default;
  CellRuntimeStagedFile& operator=(const CellRuntimeStagedFile& other) {
    if (this != &other) { CellRuntimeStagedFile copy(other); Swap(copy); }
    return *this;
  }
  CellRuntimeStagedFile(CellRuntimeStagedFile&&) noexcept = default;
  CellRuntimeStagedFile& operator=(CellRuntimeStagedFile&& other) noexcept {
    if (this != &other) { CellRuntimeStagedFile moved(std::move(other)); Swap(moved); }
    return *this;
  }
  ~CellRuntimeStagedFile() { if (!bytes.empty()) SecureZeroMemory(bytes.data(), bytes.size()); }
 private:
  void Swap(CellRuntimeStagedFile& other) noexcept { std::swap(entry, other.entry); bytes.swap(other.bytes); relative_path.swap(other.relative_path); }
};
struct CellJournalRuntimeResult final {
  RuntimeJobResult runtime;
  CellProvisioningInventory inventory;
  CellRuntimeBackingCounts backing;
  // Provisional bytes are released only with final verified capture. They still
  // require result-bound hashing, transport and governed artifact publication.
  std::vector<CellRuntimeStagedFile> staged_files;
  // Accounting may be valid even when the workload itself failed. This flag
  // requires the runner's final capture and protected-workspace checks.
  bool inventory_verified = false;
  // Host allocation remains separate from guest inventory allocation.
  bool backing_verified = false;
};

// Serialized trusted owner for one admitted runtime and its mounted journal.
// Checks complete native journal/volume custody before launch and at every
// capture authorization. Provisional inventory remains private until the job
// and runtime owners finish. Callers retain the journal and current canonical
// authority, and supply an outer watchdog for synchronous native operations.
// This does not provision, retry, publish remotely, enforce quotas or enable the
// installed controller. The command must include its protected guest workspace.
class CellJournalRuntimeRunner final {
 public:
  static CellJournalRuntimeResult Run(CellProvisioningJournal& journal, const CellJournalRuntimeReference& reference,
    const RuntimeJobCommand& command, const JobLimits& limits, const CellFootprintScanGuard& authority,
    JobStdioChannel* stdio = nullptr, const CellRuntimeFileStaging* staging = nullptr) noexcept;
 private:
  friend struct CellJournalRuntimeTestPeer;
  struct Operations final {
    void* context = nullptr;
    DWORD (*verify)(void*, const CellJournalRuntimeReference&, const RuntimeJobCommand&) noexcept = nullptr;
    DWORD (*capture)(void*, const CellJournalRuntimeReference&, const CellFootprintScanGuard&,
      const JobQuiescence&, CellProvisioningInventory*, CellProvisioningBackingFootprint*, std::vector<CellRuntimeStagedFile>*) noexcept = nullptr;
  };
  static DWORD StagePinnedFiles(const CellRuntimeFileStaging* staging, CellDirectoryInventoryPins& pins,
    const CellFileIdentity& work, const CellDirectoryInventory& inventory, const CellFootprintScanGuard& authority,
    std::vector<CellRuntimeStagedFile>* output) noexcept;
  struct NativeContext;
  static CellJournalRuntimeResult RunOwned(const Operations& operations, const CellJournalRuntimeReference& reference,
    const RuntimeJobCommand& command, const JobLimits& limits, const CellFootprintScanGuard& authority,
    JobStdioChannel* stdio) noexcept;
};
}
