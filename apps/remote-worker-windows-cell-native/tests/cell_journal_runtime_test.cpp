#include "cell_journal_runtime.hpp"
#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace goatcitadel::worker_cell {
// Only the journal/volume boundary is controlled here. The runtime, protected
// roots, actual AppContainer job and full native workspace scan remain real.
struct CellJournalRuntimeTestPeer final {
  struct State final {
    RuntimeJobCommand expected, *caller_command = nullptr;
    CellJournalRuntimeReference reference, *caller_reference = nullptr;
    unsigned mode = 0, verifies = 0, authorizations = 0, captures = 0;
    bool revoked = false, drifted = false;
    HANDLE stop = nullptr;
    std::vector<CellFileIdentity> files;
    static DWORD SelectPaths(void* raw, std::vector<std::wstring>* paths) noexcept {
      const auto& self = *static_cast<State*>(raw);
      if (self.mode == 31) return ERROR_ACCESS_DENIED;
      *paths = {L"gc-staging-fixture-0", L"gc-staging-fixture-1"};
      if (self.mode == 26) paths->back() = L"missing-staging-file";
      if (self.mode == 27) paths->back() = L"../gc-staging-fixture-1";
      if (self.mode == 28) paths->back() = L"GC-STAGING-FIXTURE-0";
      return ERROR_SUCCESS;
    }
    static DWORD Select(void* raw, const CellDirectoryInventory& inventory, std::vector<CellDirectoryInventoryEntry>* selected) noexcept {
      auto& self = *static_cast<State*>(raw);
      if (self.mode == 15) return ERROR_READ_FAULT;
      for (const auto& identity : self.files) {
        const auto entry = std::find_if(inventory.entries.begin(), inventory.entries.end(), [&](const auto& item) { return item.identity == identity; });
        if (entry == inventory.entries.end()) return ERROR_FILE_NOT_FOUND;
        selected->push_back(*entry);
      }
      if (self.mode == 16) selected->push_back(selected->front());
      if (self.mode == 17) selected->front() = *std::find_if(inventory.entries.begin(), inventory.entries.end(), [](const auto& item) { return item.directory; });
      if (self.mode == 18) selected->front().identity.volume_serial ^= 1;
      if (self.mode == 23) self.revoked = true;
      if (self.mode == 24) ++selected->front().logical_file_bytes;
      return ERROR_SUCCESS;
    }
    static DWORD Verify(void* raw, const CellJournalRuntimeReference& reference, const RuntimeJobCommand& command) noexcept {
      auto& self = *static_cast<State*>(raw); ++self.verifies;
      if (self.mode == 1 || self.drifted) return ERROR_FILE_INVALID;
      return reference.anchor == self.reference.anchor && reference.checkpoint_sha256 == self.reference.checkpoint_sha256 &&
        command.launch.job_name == self.expected.launch.job_name && command.protected_workspace &&
        command.protected_workspace->identities == self.expected.protected_workspace->identities ? ERROR_SUCCESS : ERROR_INVALID_DATA;
    }
    static DWORD Authorize(void* raw) noexcept {
      auto& self = *static_cast<State*>(raw); ++self.authorizations;
      if (self.mode == 4) {
        self.caller_command->launch.job_name.back() ^= 1;
        self.caller_reference->checkpoint_sha256.back() ^= 1;
      }
      return self.revoked ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Capture(void* raw, const CellJournalRuntimeReference& reference, const CellFootprintScanGuard& guard,
      const JobQuiescence& job, CellProvisioningInventory* output, CellProvisioningBackingFootprint* backing,
      std::vector<CellRuntimeStagedFile>* staged) noexcept {
      auto& self = *static_cast<State*>(raw); ++self.captures;
      const auto& workspace = *self.expected.protected_workspace;
      const auto binding = job.CellBinding();
      auto error = binding.authorize(binding.context, self.expected.launch.job_name,
        workspace.identities.directories[static_cast<std::size_t>(CellDirectory::work)]);
      if (error) return error;
      HANDLE parent = CreateFileW(workspace.parent_path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      if (parent == INVALID_HANDLE_VALUE) return GetLastError();
      CellWorkspaceDirectories roots;
      error = roots.OpenRecorded(parent, workspace.identities, self.expected.launch.job_name, workspace.owner_sid, workspace.controller_sid);
      CloseHandle(parent);
      if (error) return error;
      if (self.mode >= 14) for (unsigned index = 0; index < 2; ++index) {
        const auto path = roots.DirectoryPath(CellDirectory::work) + L"\\gc-staging-fixture-" + std::to_wstring(index);
        const auto file = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE) return GetLastError();
        const std::uint8_t bytes[] = {1, 2, 3, 4, 5}; DWORD written = 0; FILE_ID_INFO info{};
        const bool valid = WriteFile(file, bytes, sizeof(bytes), &written, nullptr) && written == sizeof(bytes) && FlushFileBuffers(file) &&
          GetFileInformationByHandleEx(file, FileIdInfo, &info, sizeof(info));
        const auto status = valid ? ERROR_SUCCESS : GetLastError(); CloseHandle(file);
        if (status) return status;
        CellFileIdentity identity; identity.volume_serial = info.VolumeSerialNumber;
        std::memcpy(identity.file_id.data(), info.FileId.Identifier, identity.file_id.size()); self.files.push_back(identity);
      }
      struct Scan final {
        const CellFootprintScanGuard& guard;
        const JobQuiescence& job;
        static DWORD Authorize(void* raw) noexcept {
          const auto& self = *static_cast<Scan*>(raw);
          const auto error = self.guard.authorize(self.guard.context);
          return error ? error : self.job.Check();
        }
      } scan{guard, job};
      CellDirectoryInventoryPins pins;
      error = CaptureCellWorkspaceInventory(roots, workspace.identities, reference.inventory_limits,
        {Scan::Authorize, &scan, guard.cancellation}, pins, &output->inventory);
      if (error) return error;
      if (self.mode >= 14) {
        CellRuntimeFileStaging request{&self, Select};
        if (self.mode == 19) request.maximum_total_bytes = 9;
        if (self.mode == 20) request.maximum_file_bytes = 4;
        if (self.mode == 21) request.maximum_files = 1;
        if (self.mode >= 25) {
          request.select_paths = SelectPaths;
          if (self.mode != 29) request.select = nullptr;
          if (self.mode == 30) request.maximum_files = 1;
        }
        error = CellJournalRuntimeRunner::StagePinnedFiles(&request, pins,
          workspace.identities.directories[static_cast<std::size_t>(CellDirectory::work)], output->inventory,
          {Scan::Authorize, &scan, guard.cancellation}, staged);
        if (error) return error;
        if (self.mode == 22) self.revoked = true;
      }
      output->anchor = reference.anchor; output->checkpoint_sha256 = reference.checkpoint_sha256;
      output->workspace = workspace.identities;
      // The journal/volume boundary is controlled; the actual job and guest
      // inventory above are real. Keep host charges distinct from guest bytes.
      backing->anchor = reference.anchor; backing->checkpoint_sha256 = reference.checkpoint_sha256;
      backing->backing.file_bytes = 4096; backing->backing.allocated_bytes = 8192;
      backing->journal_bytes = 21 * 1024; backing->journal_allocated_bytes = 24576;
      backing->host_file_allocated_bytes = 32768;
      if (self.mode == 2) self.revoked = true;
      if (self.mode == 3) return ERROR_IO_INCOMPLETE;
      if (self.mode == 5) output->anchor.file.file_id.back() ^= 1;
      if (self.mode == 6) self.drifted = true;
      if (self.mode == 7 && !SetEvent(self.stop)) return GetLastError();
      if (self.mode == 9) backing->anchor.file.file_id.back() ^= 1;
      if (self.mode == 10) return ERROR_READ_FAULT;
      if (self.mode == 11) backing->assignment_binding.back() ^= 1;
      if (self.mode == 12) backing->profile_sha256.back() ^= 1;
      if (self.mode == 13) backing->checkpoint_sha256.back() ^= 1;
      return ERROR_SUCCESS;
    }
  };
  static CellJournalRuntimeResult Run(State& state, const RuntimeJobCommand& command, const JobLimits& limits,
    const CellJournalRuntimeReference& reference) {
    return CellJournalRuntimeRunner::RunOwned({&state, State::Verify, State::Capture}, reference, command, limits,
      {State::Authorize, &state, state.stop}, nullptr);
  }
};
}

unsigned RunCellJournalRuntimeTests(const goatcitadel::worker_cell::RuntimeJobCommand& supplied,
  const goatcitadel::worker_cell::JobLimits& limits) {
  using namespace goatcitadel::worker_cell;
  unsigned checks = 0;
  const auto check = [&](bool passed, const char* message) { ++checks; if (!passed) throw std::runtime_error(message); };
  using Peer = CellJournalRuntimeTestPeer;
  for (unsigned mode = 0; mode <= 31; ++mode) {
    auto command = supplied;
    command.launch.command_line = L"\"" + command.launch.image + L"\" exit";
    CellJournalRuntimeReference reference;
    reference.anchor.file = command.protected_workspace->identities.directories[0];
    reference.anchor.prepared_sha256.fill(1); reference.checkpoint_sha256.fill(2);
    Peer::State state; state.mode = mode; state.expected = command; state.reference = reference;
    state.caller_command = &command; state.caller_reference = &reference;
    state.stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    check(state.stop != nullptr, "Create owned journal runtime cancellation event failed");
    if (mode == 8) command.protected_workspace.reset();
    const auto result = Peer::Run(state, command, limits, reference);
    CloseHandle(state.stop);
    if (mode == 0 || mode == 4 || mode == 14 || mode == 25) {
      check(result.inventory_verified && result.runtime.job.quiescent_capture_verified && result.runtime.protected_workspace_verified &&
        result.runtime.runtime_bundle_verified, "Journal runtime must retain inventory only after all native runtime checks");
      check(result.inventory.workspace == supplied.protected_workspace->identities && !result.inventory.inventory.entries.empty() &&
        result.inventory.inventory.footprint.root == supplied.protected_workspace->identities.directories[0],
        "Composed capture must scan the actual protected workspace and retain its identities");
      check(result.runtime.job.end == JobEnd::exited && result.runtime.job.process_exit_code == 7 && state.captures == 1,
        "Valid accounting remains distinct from the workload's nonzero exit");
      check(result.backing_verified && result.backing.file_bytes == 4096 && result.backing.allocated_bytes == 8192 &&
        result.backing.journal_bytes == 21 * 1024 && result.backing.journal_allocated_bytes == 24576,
        "Host backing evidence remains separate and is released with the same verified guest capture");
      if (mode == 14 || mode == 25) {
        check(result.staged_files.size() == 2, "Bounded files leave staging only with final verified capture");
        for (const auto& file : result.staged_files) check(file.bytes == std::vector<std::uint8_t>({1, 2, 3, 4, 5}) &&
          file.entry.logical_file_bytes == 5, "Staged bytes match the exact pinned inventory file");
        if (mode == 25) {
          check(result.staged_files[0].relative_path == L"gc-staging-fixture-0" && result.staged_files[1].relative_path == L"gc-staging-fixture-1",
            "Path selection retains each original approved label beside its exact file identity and bytes");
          auto copy = result.staged_files[0]; copy.relative_path = L"old-label";
          copy = result.staged_files[1];
          check(copy.relative_path == result.staged_files[1].relative_path && copy.entry == result.staged_files[1].entry && copy.bytes == result.staged_files[1].bytes,
            "Replacing staged evidence keeps the label, identity and content together");
        }
      } else check(result.staged_files.empty(), "Staging stays opt-in");
    } else {
      const DWORD errors[] = {0, ERROR_FILE_INVALID, ERROR_ACCESS_DENIED, ERROR_IO_INCOMPLETE, 0, ERROR_FILE_INVALID, ERROR_FILE_INVALID, ERROR_CANCELLED, ERROR_INVALID_PARAMETER,
        ERROR_FILE_INVALID, ERROR_READ_FAULT, ERROR_FILE_INVALID, ERROR_FILE_INVALID, ERROR_FILE_INVALID,
        0, ERROR_READ_FAULT, ERROR_FILE_INVALID, ERROR_FILE_INVALID, ERROR_FILE_INVALID,
        ERROR_BUFFER_OVERFLOW, ERROR_BUFFER_OVERFLOW, ERROR_BUFFER_OVERFLOW, ERROR_ACCESS_DENIED, ERROR_ACCESS_DENIED, ERROR_FILE_INVALID,
        0, ERROR_FILE_NOT_FOUND, ERROR_BAD_PATHNAME, ERROR_FILE_INVALID, ERROR_INVALID_PARAMETER, ERROR_BUFFER_OVERFLOW, ERROR_ACCESS_DENIED};
      check(!result.inventory_verified && !result.backing_verified && result.backing == CellRuntimeBackingCounts{} &&
        result.inventory == CellProvisioningInventory{} && result.staged_files.empty() && result.runtime.job.error == errors[mode],
        "Journal runtime must discard partial capture after authority, journal, reader or binding failure");
      if (mode == 1 || mode == 8) {
        check(!result.runtime.job.process_id && !state.captures && !state.authorizations,
          "Invalid journal or absent protected workspace refuses before authority and native launch");
      } else check(result.runtime.job.process_id && result.runtime.job.zero_processes_verified && result.runtime.job.output_drained,
        "Capture failure retains independent proof of actual child cleanup");
    }
  }
  CellProvisioningJournal empty;
  CellJournalRuntimeReference reference; reference.checkpoint_sha256.fill(2);
  unsigned calls = 0;
  const auto rejected = CellJournalRuntimeRunner::Run(empty, reference, supplied, limits,
    {[](void* raw) noexcept -> DWORD { ++*static_cast<unsigned*>(raw); return ERROR_SUCCESS; }, &calls, nullptr});
  check(rejected.runtime.job.error == ERROR_INVALID_STATE && !rejected.runtime.job.process_id && !calls && !rejected.inventory_verified,
    "Production runner refuses a journal without live mounted custody before launch");
  return checks;
}
