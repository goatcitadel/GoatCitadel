#include "cell_runtime_bundle.hpp"
#include "cell_mounted_workspace.hpp"
#include "cell_provisioning_journal.hpp"
#include <sddl.h>
#include <algorithm>
#include <cstdio>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace {
struct Handle { HANDLE value = INVALID_HANDLE_VALUE; ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
CellFileIdentity Identity(HANDLE handle) {
  FILE_ID_INFO info{}; Check(GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info)), "identity");
  CellFileIdentity result; result.volume_serial = info.VolumeSerialNumber;
  std::copy(std::begin(info.FileId.Identifier), std::end(info.FileId.Identifier), result.file_id.begin()); return result;
}
HANDLE Directory(const std::wstring& path) {
  return CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
}
std::wstring User() {
  Handle token; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value), "token");
  alignas(TOKEN_USER) std::array<std::uint8_t, 4096> data{}; DWORD size = 0;
  Check(GetTokenInformation(token.value, TokenUser, data.data(), static_cast<DWORD>(data.size()), &size), "user");
  LPWSTR sid = nullptr; Check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &sid), "sid");
  std::wstring result(sid); LocalFree(sid); return result;
}
std::uint64_t Bytes(const std::wstring& path) {
  Handle file{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  if (file.value == INVALID_HANDLE_VALUE) { Check(GetLastError() == ERROR_FILE_NOT_FOUND, "size open"); return 0; }
  LARGE_INTEGER size{}; Check(GetFileSizeEx(file.value, &size), "size"); return static_cast<std::uint64_t>(size.QuadPart);
}
struct Authority {
  std::wstring file;
  PinnedCellRuntimeBundle* output = nullptr;
  bool deny = false, revoke_after_chunk = false, revoke_after_verification = false;
  unsigned checks = 0;
  static DWORD CheckNow(void* raw) noexcept {
    auto& self = *static_cast<Authority*>(raw); ++self.checks;
    try {
      return self.deny || (self.revoke_after_chunk && Bytes(self.file) >= 65536) ||
        (self.revoke_after_verification && self.output->Ready()) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  CellFootprintScanGuard Guard() { return {CheckNow, this}; }
};
}
namespace goatcitadel::worker_cell {
struct CellProvisioningJournalTestPeer final {
  // Simulates a nested call without fabricating journal or volume custody.
  static void Busy(CellProvisioningJournal& journal, bool busy) { journal.runtime_install_active_ = busy; }
  static bool Busy(const CellProvisioningJournal& journal) { return journal.runtime_install_active_; }
};
// Uses real temporary guest directories and native checkpoint encoding. Only
// mount/protection verification is substituted; no VHD or mounted-volume proof.
struct CellMountedWorkspaceTestPeer final {
  static DWORD Create(CellMountedWorkspace& owner, HANDLE parent, const CellFileIdentity& parent_identity,
      const std::wstring& name, const std::wstring& user) {
    struct Context { CellMountedWorkspace& owner; HANDLE parent; CellFileIdentity identity; std::wstring name, user; }
      context{owner, parent, parent_identity, name, user};
    owner.attempted_ = true; owner.state_ = CellMountedWorkspaceState::unknown;
    owner.binding_.mount_sha256.fill(0xa1); owner.binding_.security_sha256.fill(0xb2);
    owner.binding_.volume_root = parent_identity; owner.binding_.cell_name = name;
    owner.committer_ = {[](void*, const CellMountedWorkspaceCheckpoint& record, CellFileSha256* ack) noexcept -> DWORD {
      std::copy_n(record.end() - 32, 32, ack->begin()); return ERROR_SUCCESS;
    }, [](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr};
    return owner.Run({[](void*) noexcept -> DWORD { return ERROR_SUCCESS; },
      [](void* raw, CellWorkspaceIdentities* identities, DWORD (*guard)(void*) noexcept, void* guard_context) noexcept -> DWORD {
        auto& value = *static_cast<Context*>(raw);
        auto error = value.owner.contents_.Create(value.parent, value.identity, value.name, value.user, value.user, guard, guard_context);
        return error ? error : value.owner.contents_.RecordIdentities(identities);
      }, [](void* raw, const CellWorkspaceIdentities& expected, bool) noexcept -> DWORD {
        auto& value = *static_cast<Context*>(raw); CellWorkspaceIdentities actual;
        const auto error = value.owner.contents_.RecordIdentities(&actual);
        return error ? error : actual == expected ? ERROR_SUCCESS : ERROR_FILE_INVALID;
      }, &context}, GetTickCount64() + 10000, nullptr);
  }
  static RuntimeBundleInstallResult Install(CellMountedWorkspace& owner, PinnedCellRuntimeBundle& source,
      PinnedCellRuntimeBundle& output, const CellFootprintScanGuard& guard) {
    return owner.InstallRuntimeOwned([](void* raw, DWORD, HANDLE) noexcept -> DWORD {
      return static_cast<CellMountedWorkspace*>(raw)->contents_.Verify();
    }, &owner, source, output, 10000, guard);
  }
  static std::wstring File(const CellMountedWorkspace& owner) { return owner.contents_.DirectoryPath(CellDirectory::runtime) + L"\\entry.bin"; }
  static void Drift(CellMountedWorkspace& owner) { owner.records_.back().back() ^= 1; }
};
}
int wmain(int argc, wchar_t** argv) {
  try {
    Check(argc == 3 && wcslen(argv[2]) == 64, "arguments");
    const std::wstring scratch(argv[1]), source_path = scratch + L"\\source", parent_path = scratch + L"\\cells";
    const auto user = User(); std::vector<std::uint8_t> descriptor;
    Check(!BuildCellParentSecurity(user, user, &descriptor), "parent descriptor");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor.data(), FALSE};
    Check(CreateDirectoryW(parent_path.c_str(), &security), "exclusive parent");
    Handle parent{Directory(parent_path)}, source_root{Directory(source_path)};
    CellFileSha256 hash{};
    for (unsigned i = 0; i < 32; ++i) { unsigned byte = 0; Check(swscanf_s(argv[2] + 2 * i, L"%2x", &byte) == 1, "hash"); hash[i] = static_cast<std::uint8_t>(byte); }
    const std::vector<CellRuntimeBundleFile> files{{L"entry.bin", 6 * 65536, hash}};
    CellFileSha256 manifest{}; Check(!HashRuntimeBundleManifest(files, &manifest), "manifest");
    PinnedCellRuntimeBundle source, output;
    Check(!source.Open(source_path, Identity(source_root.value), files, manifest), "source pin");
    CellWorkspaceDirectories partial;
    Check(!partial.Create(parent.value, Identity(parent.value), L"gc-cell-11111111111111111111111111111111", user, user), "partial workspace");
    Authority authority{partial.DirectoryPath(CellDirectory::runtime) + L"\\entry.bin", &output};
    auto result = source.InstallTo(partial, output, {});
    Check(result.error == ERROR_ACCESS_DENIED && !result.files_created && !output.Ready(), "missing authority refuses");
    authority.deny = true; result = source.InstallTo(partial, output, authority.Guard());
    Check(result.error == ERROR_ACCESS_DENIED && !result.files_created, "initial denial creates nothing");
    authority.deny = false; authority.revoke_after_chunk = true;
    result = source.InstallTo(partial, output, authority.Guard());
    Check(result.error == ERROR_ACCESS_DENIED && result.files_created == 1 && result.bytes_written > 0 &&
      result.bytes_written < files[0].bytes && result.bytes_written == Bytes(authority.file) && !result.verified && !output.Ready(), "revoked copy retains exact partial bytes");
    authority.revoke_after_chunk = false;
    result = source.InstallTo(partial, output, authority.Guard());
    Check(result.error == ERROR_DIR_NOT_EMPTY && !result.files_created && !result.bytes_written, "retry preserves partial state");
    CellWorkspaceDirectories complete;
    Check(!complete.Create(parent.value, Identity(parent.value), L"gc-cell-22222222222222222222222222222222", user, user), "complete workspace");
    result = source.InstallTo(complete, output, authority.Guard());
    Check(!result.error && result.verified && output.Ready() && result.bytes_written == files[0].bytes, "authorized copy verified");
    output.Reset();
    CellWorkspaceDirectories final_denial;
    Check(!final_denial.Create(parent.value, Identity(parent.value), L"gc-cell-33333333333333333333333333333333", user, user), "final denial workspace");
    authority.revoke_after_verification = true;
    result = source.InstallTo(final_denial, output, authority.Guard());
    Check(result.error == ERROR_ACCESS_DENIED && result.bytes_written == files[0].bytes && !result.verified && !output.Ready(), "final denial withholds publication");
    authority.revoke_after_verification = false;
    CellMountedWorkspace mounted;
    Check(!CellMountedWorkspaceTestPeer::Create(mounted, parent.value, Identity(parent.value), L"gc-cell-44444444444444444444444444444444", user), "recorded fixture workspace");
    result = CellMountedWorkspaceTestPeer::Install(mounted, source, output, authority.Guard());
    Check(!result.error && result.verified && output.Ready() && result.bytes_written == files[0].bytes, "recorded guest copy");
    CellProvisioningJournal journal;
    result = journal.InstallRuntime({}, {}, source, output, 10000, authority.Guard());
    Check(result.error == ERROR_ALREADY_INITIALIZED && output.Ready(), "journal preserves caller-owned ready output");
    output.Reset();
    CellFileSha256 head{}; head.fill(0x12);
    const auto before_journal = authority.checks;
    result = journal.InstallRuntime({}, head, source, output, 10000, authority.Guard());
    Check(result.error == ERROR_INVALID_STATE && !result.files_created && !output.Ready(), "unopened journal refuses before copy");
    CellProvisioningPlan plan; plan.assignment_binding.fill(0x31); plan.profile_sha256.fill(0x51);
    plan.disk.identifier = {0x12345678, 0x1234, 0x4123, {0x80, 0, 0, 0, 0, 0, 0, 1}};
    plan.disk.virtual_bytes = 16ULL * 1024 * 1024; plan.disk.reserved_file_bytes = 80ULL * 1024 * 1024;
    std::vector<CellProvisioningRecord> retained;
    const CellProvisioningCommitter committer{[](void* raw, const CellProvisioningRecord& record, CellFileSha256* ack) noexcept -> DWORD {
      try { static_cast<std::vector<CellProvisioningRecord>*>(raw)->push_back(record); }
      catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
      std::copy_n(record.end() - 32, 32, ack->begin()); return ERROR_SUCCESS;
    }, &retained};
    CellProvisioningAnchor anchor;
    Check(!journal.Create(parent.value, Identity(parent.value), L"gc-cell-77777777777777777777777777777777", user, user, plan, &anchor, &committer) &&
      retained.size() == 1, "create actual prepared journal without provisioning a disk");
    std::copy_n(retained.back().end() - 32, 32, head.begin());
    result = journal.InstallRuntime(anchor, head, source, output, 10000, authority.Guard());
    Check(result.error == ERROR_IO_INCOMPLETE && !result.files_created && !result.bytes_written && !CellProvisioningJournalTestPeer::Busy(journal),
      "actual prepared journal cannot substitute for fully recorded mounted history");
    CellProvisioningJournalTestPeer::Busy(journal, true);
    result = journal.InstallRuntime({}, head, source, output, 10000, authority.Guard());
    Check(result.error == ERROR_INVALID_STATE, "recursive journal install refuses");
    CellProvisioningJournalTestPeer::Busy(journal, false);
    result = journal.InstallRuntime({}, head, source, output, 10000, {});
    Check(result.error == ERROR_INVALID_PARAMETER && !CellProvisioningJournalTestPeer::Busy(journal), "journal requires current authority");
    CellProvisioningAnchor foreign{}; foreign.prepared_sha256.fill(0x34);
    result = journal.InstallRuntime(foreign, head, source, output, 10000, authority.Guard());
    Check(result.error == ERROR_FILE_INVALID && !CellProvisioningJournalTestPeer::Busy(journal), "foreign anchor releases install latch without copy");
    Handle cancelled{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
    Check(cancelled.value != nullptr, "journal cancellation event");
    auto cancelled_guard = authority.Guard(); cancelled_guard.cancellation = cancelled.value;
    result = journal.InstallRuntime(anchor, head, source, output, 10000, cancelled_guard);
    Check(result.error == ERROR_CANCELLED && !CellProvisioningJournalTestPeer::Busy(journal) && !result.files_created &&
      !result.bytes_written && authority.checks == before_journal, "cancelled journal entry releases latch before authorization or writes");
    journal.Close();
    CellMountedWorkspace interrupted;
    Check(!CellMountedWorkspaceTestPeer::Create(interrupted, parent.value, Identity(parent.value), L"gc-cell-55555555555555555555555555555555", user), "interrupted recorded workspace");
    authority.file = CellMountedWorkspaceTestPeer::File(interrupted); authority.revoke_after_chunk = true;
    result = CellMountedWorkspaceTestPeer::Install(interrupted, source, output, authority.Guard());
    Check(result.error == ERROR_ACCESS_DENIED && result.files_created == 1 && result.bytes_written > 0 &&
      result.bytes_written == Bytes(authority.file) && !result.verified && !output.Ready(), "recorded copy retains partial counters");
    CellMountedWorkspace drifted;
    Check(!CellMountedWorkspaceTestPeer::Create(drifted, parent.value, Identity(parent.value), L"gc-cell-66666666666666666666666666666666", user), "drift fixture workspace");
    struct Drift { CellMountedWorkspace& owner; std::wstring file; bool changed = false; } drift{drifted, CellMountedWorkspaceTestPeer::File(drifted)};
    result = CellMountedWorkspaceTestPeer::Install(drifted, source, output, {[](void* raw) noexcept -> DWORD {
      auto& value = *static_cast<Drift*>(raw);
      try { if (!value.changed && Bytes(value.file) >= 65536) { CellMountedWorkspaceTestPeer::Drift(value.owner); value.changed = true; } }
      catch (...) { return ERROR_GEN_FAILURE; }
      return ERROR_SUCCESS;
    }, &drift});
    Check(drift.changed && result.error == ERROR_FILE_INVALID && result.files_created == 1 && result.bytes_written == Bytes(drift.file) &&
      result.bytes_written < files[0].bytes && !result.verified && !output.Ready(), "changed recorded head stops copy and retains counts");
    std::printf("{\"passed\":true,\"authorityChecks\":%u,\"volumeOperations\":false,\"serviceInstalled\":false}\n", authority.checks);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
