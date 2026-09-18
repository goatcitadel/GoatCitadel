#include "cell_journal_runtime.hpp"
#include <algorithm>
#include <limits>

namespace goatcitadel::worker_cell {
DWORD CellJournalRuntimeRunner::StagePinnedFiles(const CellRuntimeFileStaging* supplied, CellDirectoryInventoryPins& pins,
  const CellFileIdentity& work, const CellDirectoryInventory& inventory, const CellFootprintScanGuard& authority,
  std::vector<CellRuntimeStagedFile>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  if (!supplied) return ERROR_SUCCESS;
  try {
    const auto staging = *supplied;
    const auto root = work;
    const auto captured = inventory;
    const auto guard = authority;
    if (bool(staging.select) == bool(staging.select_paths) || !guard.authorize || !staging.maximum_files || staging.maximum_files > 64 ||
        !staging.maximum_file_bytes || staging.maximum_file_bytes > 1048576 ||
        !staging.maximum_total_bytes || staging.maximum_total_bytes > 64 * 1048576) return ERROR_INVALID_PARAMETER;
    auto error = guard.authorize(guard.context);
    if (!error) error = pins.Check();
    if (error) return error;
    std::vector<CellDirectoryInventoryEntry> selected;
    std::vector<std::wstring> paths;
    error = staging.select_paths ? staging.select_paths(staging.context, &paths) : staging.select(staging.context, captured, &selected);
    if (!error) error = guard.authorize(guard.context);
    if (!error) error = pins.Check();
    if (error) return error;
    if (paths.size() > staging.maximum_files) return ERROR_BUFFER_OVERFLOW;
    for (const auto& path : paths) {
      CellDirectoryInventoryEntry entry;
      error = pins.ResolveFile(root, path, guard, &entry);
      if (error) return error;
      selected.push_back(entry);
    }
    if (selected.size() > staging.maximum_files) return ERROR_BUFFER_OVERFLOW;
    std::uint64_t total = 0;
    for (std::size_t index = 0; index < selected.size(); ++index) {
      const auto& entry = selected[index];
      if (entry.directory || std::find(captured.entries.begin(), captured.entries.end(), entry) == captured.entries.end() ||
          std::any_of(selected.begin(), selected.begin() + index, [&](const auto& prior) { return prior.identity == entry.identity; }))
        return ERROR_FILE_INVALID;
      if (entry.logical_file_bytes > staging.maximum_file_bytes || entry.logical_file_bytes > staging.maximum_total_bytes - total)
        return ERROR_BUFFER_OVERFLOW;
      total += entry.logical_file_bytes;
    }
    std::vector<CellRuntimeStagedFile> pending;
    pending.reserve(selected.size());
    for (std::size_t index = 0; index < selected.size(); ++index) {
      const auto& entry = selected[index];
      CellRuntimeStagedFile file; file.entry = entry;
      if (staging.select_paths) file.relative_path = paths[index];
      error = pins.ReadFileContent(root, entry, staging.maximum_file_bytes, guard, &file.bytes);
      if (error) return error;
      pending.push_back(std::move(file));
    }
    error = guard.authorize(guard.context);
    if (!error) error = pins.Check();
    if (error) return error;
    output->swap(pending);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

struct CellJournalRuntimeRunner::NativeContext final {
  CellProvisioningJournal& journal;
  std::uint64_t lifetime;
  const CellRuntimeFileStaging* staging;
  DWORD Matches(const CellJournalRuntimeReference& reference, const RuntimeJobCommand& command) const noexcept {
    if (!journal.healthy_ || lifetime == std::numeric_limits<std::uint64_t>::max() || journal.lifetime_revision_ != lifetime)
      return ERROR_INVALID_STATE;
    if (!command.protected_workspace || journal.anchor_ != reference.anchor || journal.name_ != command.launch.job_name ||
        journal.owner_ != command.protected_workspace->owner_sid || journal.controller_ != command.protected_workspace->controller_sid)
      return ERROR_FILE_INVALID;
    if (journal.mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::recorded || journal.records_.size() != 21 * 1024)
      return ERROR_IO_INCOMPLETE;
    if (!std::equal(reference.checkpoint_sha256.begin(), reference.checkpoint_sha256.end(), journal.records_.end() - 32))
      return ERROR_CRC;
    return ERROR_SUCCESS;
  }
  static DWORD Verify(void* raw, const CellJournalRuntimeReference& reference, const RuntimeJobCommand& command) noexcept {
    auto& self = *static_cast<NativeContext*>(raw);
    auto error = self.Matches(reference, command);
    if (error) return error;
    CellWorkspaceIdentities actual;
    // This verifies all native journal/volume owners, not just decoded bytes.
    error = self.journal.RecordMountedWorkspace(&actual);
    if (!error) error = self.Matches(reference, command);
    if (!error && actual != command.protected_workspace->identities) error = ERROR_FILE_INVALID;
    return error;
  }
  static DWORD Capture(void* raw, const CellJournalRuntimeReference& reference, const CellFootprintScanGuard& guard,
    const JobQuiescence& job, CellProvisioningInventory* output, CellProvisioningBackingFootprint* backing,
    std::vector<CellRuntimeStagedFile>* staged) noexcept {
    if (!output || !backing) return ERROR_INVALID_PARAMETER;
    *output = {}; *backing = {};
    struct Results final {
      CellProvisioningInventory& guest; CellProvisioningBackingFootprint& backing; bool complete = false;
      ~Results() { if (!complete) { guest = {}; backing = {}; } }
    } results{*output, *backing};
    auto& self = *static_cast<NativeContext*>(raw);
    const auto binding = job.CellBinding();
    const auto deadline = GetTickCount64() + reference.inventory_limits.wall_limit_ms;
    CellDirectoryInventoryPins pins;
    auto error = self.journal.CaptureMountedInventory(reference.anchor, reference.checkpoint_sha256,
      reference.inventory_limits, guard, binding, pins, output);
    if (error) return error;
    struct CaptureGuard final {
      const JobQuiescence& job;
      const CellFootprintScanGuard& authority;
      const CellDirectoryInventoryPins& pins;
      static DWORD Authorize(void* raw) noexcept {
        const auto& value = *static_cast<CaptureGuard*>(raw);
        auto error = value.job.Check();
        if (!error) error = value.authority.authorize(value.authority.context);
        if (!error) error = value.job.Check();
        return error ? error : value.pins.Check();
      }
    } capture{job, guard, pins};
    error = CaptureGuard::Authorize(&capture);
    if (error) return error;
    const auto now = GetTickCount64();
    if (now >= deadline) return ERROR_TIMEOUT;
    error = self.journal.ObserveBackingFootprint(reference.anchor, reference.checkpoint_sha256,
      static_cast<DWORD>(deadline - now), {CaptureGuard::Authorize, &capture, guard.cancellation}, backing);
    if (!error) {
      // ReadFileContent owns the pins during each read. Its fresh guard must
      // check job/authority without recursively consulting that moved owner.
      struct StageGuard final {
        const JobQuiescence& job; const CellFootprintScanGuard& authority;
        static DWORD Authorize(void* raw) noexcept {
          const auto& value = *static_cast<StageGuard*>(raw);
          auto status = value.job.Check();
          if (!status) status = value.authority.authorize(value.authority.context);
          return status ? status : value.job.Check();
        }
      } stage_guard{job, guard};
      error = StagePinnedFiles(self.staging, pins,
        output->workspace.directories[static_cast<std::size_t>(CellDirectory::work)], output->inventory,
        {StageGuard::Authorize, &stage_guard, guard.cancellation}, staged);
    }
    if (!error) error = pins.Check();
    if (!error) results.complete = true;
    return error;
  }
};

CellJournalRuntimeResult CellJournalRuntimeRunner::Run(CellProvisioningJournal& journal,
  const CellJournalRuntimeReference& reference, const RuntimeJobCommand& command, const JobLimits& limits,
  const CellFootprintScanGuard& authority, JobStdioChannel* stdio, const CellRuntimeFileStaging* staging) noexcept {
  const auto snapshot = staging ? *staging : CellRuntimeFileStaging{};
  NativeContext native{journal, journal.lifetime_revision_, staging ? &snapshot : nullptr};
  return RunOwned({&native, NativeContext::Verify, NativeContext::Capture}, reference, command, limits, authority, stdio);
}

CellJournalRuntimeResult CellJournalRuntimeRunner::RunOwned(const Operations& supplied_operations,
  const CellJournalRuntimeReference& supplied_reference, const RuntimeJobCommand& supplied_command, const JobLimits& supplied_limits,
  const CellFootprintScanGuard& supplied_authority, JobStdioChannel* stdio) noexcept {
  CellJournalRuntimeResult result;
  try {
    const auto operations = supplied_operations;
    const auto reference = supplied_reference;
    const auto command = supplied_command;
    const auto limits = supplied_limits;
    const auto authority = supplied_authority;
    const auto& scan = reference.inventory_limits;
    if (!operations.verify || !operations.capture || !authority.authorize || !command.protected_workspace ||
        !scan.max_entries || scan.max_entries > 20000 || scan.max_depth > 64 || !scan.wall_limit_ms || scan.wall_limit_ms > 60000 ||
        std::all_of(reference.checkpoint_sha256.begin(), reference.checkpoint_sha256.end(), [](auto byte) { return byte == 0; })) {
      result.runtime.job.error = ERROR_INVALID_PARAMETER; return result;
    }
    struct Owner final {
      const Operations& operations;
      const CellJournalRuntimeReference& reference;
      const RuntimeJobCommand& command;
      const CellFootprintScanGuard& authority;
      CellProvisioningInventory provisional;
      CellProvisioningBackingFootprint provisional_backing;
      std::vector<CellRuntimeStagedFile> staged;
      DWORD Control() const noexcept {
        if (!authority.cancellation) return ERROR_SUCCESS;
        const auto wait = WaitForSingleObject(authority.cancellation, 0);
        return wait == WAIT_TIMEOUT ? ERROR_SUCCESS : wait == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
      }
      static DWORD Authorize(void* raw) noexcept {
        auto& self = *static_cast<Owner*>(raw);
        auto error = self.Control();
        if (!error) error = self.operations.verify(self.operations.context, self.reference, self.command);
        if (!error) error = self.authority.authorize(self.authority.context);
        if (!error) error = self.Control();
        if (!error) error = self.operations.verify(self.operations.context, self.reference, self.command);
        return error;
      }
      static void Discard(void* raw) noexcept {
        auto& self = *static_cast<Owner*>(raw);
        self.provisional = {}; self.provisional_backing = {}; self.staged.clear();
      }
      static DWORD Capture(void* raw, const JobQuiescence& job) noexcept {
        auto& self = *static_cast<Owner*>(raw);
        Discard(raw);
        auto error = self.operations.capture(self.operations.context, self.reference,
          {Authorize, raw, self.authority.cancellation}, job, &self.provisional, &self.provisional_backing, &self.staged);
        if (!error && (self.provisional.anchor != self.reference.anchor ||
            self.provisional.checkpoint_sha256 != self.reference.checkpoint_sha256 ||
            self.provisional.workspace != self.command.protected_workspace->identities)) error = ERROR_FILE_INVALID;
        if (!error && (self.provisional_backing.anchor != self.provisional.anchor ||
            self.provisional_backing.checkpoint_sha256 != self.provisional.checkpoint_sha256 ||
            self.provisional_backing.assignment_binding != self.provisional.assignment_binding ||
            self.provisional_backing.profile_sha256 != self.provisional.profile_sha256)) error = ERROR_FILE_INVALID;
        if (error) Discard(raw);
        return error;
      }
    } owner{operations, reference, command, authority, {}, {}, {}};
    // Fail before opening/launching a runtime when journal identity or current
    // admission is already invalid. The job repeats this check before launch.
    result.runtime.job.error = Owner::Authorize(&owner);
    if (result.runtime.job.error) return result;
    const JobQuiescenceObserver observer{&owner, Owner::Authorize, Owner::Capture, Owner::Discard, scan.wall_limit_ms, Owner::Authorize};
    result.runtime = RunVerifiedRuntimeJob(command, limits, authority.cancellation, stdio, &observer);
    if (result.runtime.job.quiescent_capture_verified && result.runtime.runtime_bundle_verified && result.runtime.protected_workspace_verified) {
      result.inventory = std::move(owner.provisional);
      result.staged_files = std::move(owner.staged);
      const auto& backing = owner.provisional_backing;
      result.backing = {backing.backing.file_bytes, backing.backing.allocated_bytes,
        backing.journal_bytes, backing.journal_allocated_bytes};
      result.inventory_verified = true;
      result.backing_verified = true;
    }
    return result;
  } catch (...) { result.runtime.job.error = ERROR_NOT_ENOUGH_MEMORY; return result; }
}
}
