#include "cell_workspace.hpp"
#include "cell_runtime_bundle.hpp"
#include "appcontainer_fixture.hpp"
#include <sddl.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <userenv.h>
#include <winioctl.h>
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <functional>
#include <stdexcept>
#include <thread>

using namespace goatcitadel::worker_cell;
unsigned RunCellRuntimeStdioTests(RuntimeJobCommand request, const std::function<void()>& after_start = {});
unsigned RunCellJournalRuntimeTests(const RuntimeJobCommand& command, const JobLimits& limits);
unsigned RunCellVirtualDiskTests(CellWorkspaceDirectories& roots, HANDLE parent,
  const CellFileIdentity& parent_identity, const std::wstring& user, unsigned& attachment_checks, bool live_attachment);
unsigned RunCellProvisioningJournalTests(HANDLE parent, const CellFileIdentity& parent_identity, const std::wstring& user);
unsigned RunCellHostCapacityJournalTests(HANDLE parent, const std::wstring& user);
unsigned RunCellMountedWorkspaceProvisioningJournalTests(HANDLE parent, const CellFileIdentity& parent_identity, const std::wstring& user);
namespace {
CellFootprintScanGuard FixtureInstallAuthority(HANDLE cancellation = nullptr) {
  return {[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, cancellation};
}
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct LocalMemory final { void* value = nullptr; ~LocalMemory() { if (value) LocalFree(value); } };
void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
unsigned checks = 0;
void Check(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(message) + " (workspace check " + std::to_string(checks) + ")");
}
std::wstring Quote(const std::wstring& value) { return L"\"" + value + L"\""; }
constexpr char marker[] = "broker-owned workspace fixture";
void WriteMarker(const std::wstring& path) {
  Handle file;
  file.value = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  Require(file.value != INVALID_HANDLE_VALUE, "Create broker fixture failed.");
  DWORD written = 0;
  Require(WriteFile(file.value, marker, sizeof(marker), &written, nullptr) && written == sizeof(marker), "Write broker fixture failed.");
}
bool SameMarker(const std::wstring& path) {
  Handle file;
  file.value = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file.value == INVALID_HANDLE_VALUE) return false;
  std::array<char, sizeof(marker)> data{};
  DWORD read = 0;
  return ReadFile(file.value, data.data(), static_cast<DWORD>(data.size()), &read, nullptr) &&
    read == sizeof(marker) && std::memcmp(data.data(), marker, sizeof(marker)) == 0;
}
std::wstring CurrentUser() {
  Handle token;
  Require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != FALSE, "Open workspace fixture user failed.");
  alignas(TOKEN_USER) std::array<std::uint8_t, 4096> data{};
  DWORD size = 0;
  Require(GetTokenInformation(token.value, TokenUser, data.data(), static_cast<DWORD>(data.size()), &size) != FALSE,
    "Read workspace fixture user failed.");
  LPWSTR sid = nullptr;
  Require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &sid) != FALSE,
    "Convert workspace fixture user failed.");
  const std::wstring value(sid);
  LocalFree(sid);
  return value;
}
CellFileIdentity Identity(HANDLE handle) {
  FILE_ID_INFO info{};
  Require(GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info)) != FALSE, "Read workspace fixture identity failed.");
  CellFileIdentity value;
  value.volume_serial = info.VolumeSerialNumber;
  std::copy(std::begin(info.FileId.Identifier), std::end(info.FileId.Identifier), value.file_id.begin());
  return value;
}
std::wstring ParentDescriptor(const std::wstring& user) {
  return L"O:" + user + L"G:" + user + L"D:P(A;OICI;FA;;;SY)" +
    (user == L"S-1-5-18" ? L"" : L"(A;OICI;FA;;;" + user + L")") +
    L"(A;OICI;RC;;;OW)S:(ML;OICI;NW;;;ME)";
}
void CreateParent(const std::wstring& path, const std::wstring& sddl) {
  LocalMemory descriptor;
  Require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr),
    "Build independent parent fixture descriptor failed.");
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
  Require(CreateDirectoryW(path.c_str(), &attributes), "Create exclusive parent security fixture failed.");
}
HANDLE OpenParent(const std::wstring& path) {
  const HANDLE value = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Require(value != INVALID_HANDLE_VALUE, "Open parent metadata fixture failed.");
  return value;
}
void CheckClosedWorkspace(const CellWorkspaceDirectories& roots) {
  bool closed = !roots.Ready();
  for (const auto kind : {CellDirectory::root, CellDirectory::control, CellDirectory::runtime, CellDirectory::work})
    closed = closed && !roots.DirectoryHandle(kind) && roots.DirectoryPath(kind).empty() &&
      roots.DirectoryIdentity(kind) == CellFileIdentity{};
  Check(closed, "failed recorded reopen releases every directory and identity");
}
CellWorkspaceIdentities CheckRecordedWorkspaceReopen(CellWorkspaceDirectories& roots, HANDLE parent,
  const CellFileIdentity& parent_identity, const std::wstring& name, const std::wstring& user) {
  CellWorkspaceIdentities recorded;
  Check(roots.RecordIdentities(&recorded) == ERROR_SUCCESS && recorded.parent == parent_identity,
    "freshly verified workspace produces an identity record");
  std::array<std::wstring, 4> paths;
  for (std::size_t index = 0; index < paths.size(); ++index) {
    const auto kind = static_cast<CellDirectory>(index);
    paths[index] = roots.DirectoryPath(kind);
    Check(recorded.directories[index] == Identity(roots.DirectoryHandle(kind)),
      "record contains the actual retained directory identity");
  }
  Check(roots.RecordIdentities(nullptr) == ERROR_INVALID_PARAMETER && roots.Ready(),
    "null record output does not disturb retained workspace");
  roots.Close();
  auto cleared = recorded;
  Check(roots.RecordIdentities(&cleared) == ERROR_INVALID_HANDLE && cleared == CellWorkspaceIdentities{},
    "closed workspace cannot return stale recorded identities");
  Check(roots.OpenRecorded(parent, recorded, name, user, user) == ERROR_SUCCESS && roots.Ready(),
    "new owner reopens the four independently recorded roots");
  for (std::size_t index = 0; index < paths.size(); ++index) {
    const auto kind = static_cast<CellDirectory>(index);
    Check(roots.DirectoryPath(kind) == paths[index] && roots.DirectoryIdentity(kind) == recorded.directories[index],
      "reopening retains original paths and object identities");
  }
  Check(roots.OpenRecorded(parent, recorded, name, user, user) == ERROR_ALREADY_INITIALIZED && roots.Ready(),
    "occupied owner refuses reopening without discarding its workspace");
  CellWorkspaceDirectories reader;
  const auto refuse = [&](const CellWorkspaceIdentities& expected, DWORD error) {
    Check(reader.OpenRecorded(parent, expected, name, user, user) == error,
      "recorded reopen refuses a changed or invalid object identity");
    CheckClosedWorkspace(reader);
  };
  auto changed = recorded;
  changed.parent.file_id.back() ^= 0x80;
  refuse(changed, ERROR_FILE_INVALID);
  for (std::size_t index = 0; index < recorded.directories.size(); ++index) {
    changed = recorded;
    changed.directories[index].file_id.back() ^= 0x80;
    refuse(changed, ERROR_FILE_INVALID);
  }
  refuse({}, ERROR_INVALID_PARAMETER);
  changed = recorded;
  changed.directories[1] = changed.directories[0];
  refuse(changed, ERROR_INVALID_PARAMETER);
  changed = recorded;
  changed.directories[2].volume_serial ^= 1;
  refuse(changed, ERROR_INVALID_PARAMETER);
  Check(reader.OpenRecorded(parent, recorded, name, L"S-1-5-21-1-2-3-1001", user) == ERROR_INVALID_SECURITY_DESCR,
    "recorded reopen refuses substituted owner security");
  CheckClosedWorkspace(reader);
  Check(reader.OpenRecorded(parent, recorded, name, user, L"S-1-5-80-1-2-3-4-5") == ERROR_INVALID_SECURITY_DESCR,
    "recorded reopen refuses substituted controller security");
  CheckClosedWorkspace(reader);
  Check(reader.OpenRecorded(parent, recorded, name + L"\\escape", user, user) == ERROR_INVALID_PARAMETER,
    "recorded reopen refuses noncanonical names");
  CheckClosedWorkspace(reader);
  auto absent = name;
  absent[8] = absent[8] == L'8' ? L'9' : L'8';
  Check(reader.OpenRecorded(parent, recorded, absent, user, user) == ERROR_FILE_NOT_FOUND,
    "recorded reopen never creates an absent cell");
  CheckClosedWorkspace(reader);
  const auto parent_path = paths[0].substr(0, paths[0].find_last_of(L'\\'));
  Check(GetFileAttributesW((parent_path + L"\\" + absent).c_str()) == INVALID_FILE_ATTRIBUTES,
    "missing recorded cell remains absent after refusal");
  Check(reader.OpenRecorded(parent, recorded, name, user, user) == ERROR_SUCCESS &&
    reader.RecordIdentities(&cleared) == ERROR_SUCCESS && cleared == recorded,
    "failed reopen attempts do not prevent a fresh valid reader");
  return recorded;
}
void CheckRecordedWorkspaceReplacement(const std::wstring& fixture, const std::wstring& name, const std::wstring& user) {
  const auto parent_path = fixture + L"\\recorded-reopen-cases";
  CreateParent(parent_path, ParentDescriptor(user));
  Handle parent{OpenParent(parent_path)};
  const auto parent_identity = Identity(parent.value);
  CellWorkspaceDirectories roots, reader;
  CellWorkspaceIdentities old_record, new_record;
  Check(roots.Create(parent.value, parent_identity, name, user, user) == ERROR_SUCCESS &&
    roots.RecordIdentities(&old_record) == ERROR_SUCCESS, "create separate recorded replacement fixture");
  const auto root_path = parent_path + L"\\" + name;
  const auto retained_path = root_path + L".retained";
  WriteMarker(root_path + L"\\work\\old.txt");
  roots.Close();
  Check(root_path.starts_with(parent_path + L"\\") && retained_path.starts_with(parent_path + L"\\") &&
    MoveFileW(root_path.c_str(), retained_path.c_str()), "retain original recorded cell inside its owned fixture parent");
  Check(roots.Create(parent.value, parent_identity, name, user, user) == ERROR_SUCCESS &&
    roots.RecordIdentities(&new_record) == ERROR_SUCCESS, "create same-name replacement with exact protected security");
  WriteMarker(root_path + L"\\work\\new.txt");
  roots.Close();
  Check(reader.OpenRecorded(parent.value, old_record, name, user, user) == ERROR_FILE_INVALID,
    "same path and descriptor cannot substitute for independently recorded identities");
  CheckClosedWorkspace(reader);
  Check(SameMarker(retained_path + L"\\work\\old.txt") && SameMarker(root_path + L"\\work\\new.txt"),
    "identity refusal preserves both original and replacement contents");
  Check(reader.OpenRecorded(parent.value, new_record, name, user, user) == ERROR_SUCCESS,
    "replacement opens only with its own independently captured record");
  reader.Close();
  const auto runtime_path = root_path + L"\\runtime";
  const auto retained_runtime = root_path + L"\\runtime.retained";
  Check(MoveFileW(runtime_path.c_str(), retained_runtime.c_str()), "retain runtime directory before missing-child check");
  Check(reader.OpenRecorded(parent.value, new_record, name, user, user) == ERROR_FILE_NOT_FOUND &&
    GetFileAttributesW(runtime_path.c_str()) == INVALID_FILE_ATTRIBUTES, "missing runtime is never recreated by recorded reopen");
  CheckClosedWorkspace(reader);
  WriteMarker(runtime_path);
  Check(reader.OpenRecorded(parent.value, new_record, name, user, user) != ERROR_SUCCESS && SameMarker(runtime_path),
    "ordinary file cannot replace a recorded directory and is never repaired");
  CheckClosedWorkspace(reader);
  Check(MoveFileW(runtime_path.c_str(), (root_path + L"\\runtime.file").c_str()) &&
    MoveFileW(retained_runtime.c_str(), runtime_path.c_str()), "retain wrong-kind fixture and restore original directory identity");
  const auto target = parent_path + L"\\junction-target";
  Check(CreateDirectoryW(target.c_str(), nullptr), "create owned junction target");
  WriteMarker(target + L"\\untouched.txt");
  struct ReparseBuffer final {
    DWORD tag = IO_REPARSE_TAG_MOUNT_POINT;
    USHORT length = 0, reserved = 0, substitute_offset = 0, substitute_length = 0, print_offset = 0, print_length = 0;
    wchar_t paths[2048]{};
  } buffer;
  const auto substitute = L"\\??\\" + target;
  Require(substitute.size() + target.size() + 2 < std::size(buffer.paths), "Recorded junction fixture exceeds its bound.");
  buffer.substitute_length = static_cast<USHORT>(substitute.size() * sizeof(wchar_t));
  buffer.print_offset = static_cast<USHORT>(buffer.substitute_length + sizeof(wchar_t));
  buffer.print_length = static_cast<USHORT>(target.size() * sizeof(wchar_t));
  std::memcpy(buffer.paths, substitute.c_str(), (substitute.size() + 1) * sizeof(wchar_t));
  std::memcpy(reinterpret_cast<std::uint8_t*>(buffer.paths) + buffer.print_offset, target.c_str(), (target.size() + 1) * sizeof(wchar_t));
  buffer.length = static_cast<USHORT>(8 + buffer.print_offset + buffer.print_length + sizeof(wchar_t));
  {
    Handle directory{CreateFileW(runtime_path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr)};
    DWORD returned = 0;
    Check(directory.value != INVALID_HANDLE_VALUE && DeviceIoControl(directory.value, FSCTL_SET_REPARSE_POINT,
      &buffer, 8 + buffer.length, nullptr, 0, &returned, nullptr), "convert exact recorded runtime object to a junction");
    Check(Identity(directory.value) == new_record.directories[static_cast<std::size_t>(CellDirectory::runtime)],
      "junction negative retains the independently recorded file identity");
  }
  Check(reader.OpenRecorded(parent.value, new_record, name, user, user) != ERROR_SUCCESS && SameMarker(target + L"\\untouched.txt"),
    "recorded reopen rejects reparse metadata without traversing or mutating its target");
  CheckClosedWorkspace(reader);
}
CellRuntimeBundleFile BundleFile(const std::wstring& root, const std::wstring& relative) {
  auto suffix = relative;
  std::replace(suffix.begin(), suffix.end(), L'/', L'\\');
  JobCommand file; file.image = root + L"\\" + suffix; file.directory = root;
  Handle opened{CreateFileW(file.image.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  LARGE_INTEGER bytes{};
  Require(opened.value != INVALID_HANDLE_VALUE && GetFileSizeEx(opened.value, &bytes), "Read installed bundle fixture size failed.");
  if (bytes.QuadPart) goatcitadel::worker_cell_test::BindLaunchFixture(&file);
  else {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    Require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0, "Open empty fixture hash provider failed.");
    const auto error = BCryptHash(algorithm, nullptr, 0, nullptr, 0, file.expected_image_sha256.data(), 32);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    Require(error == 0, "Hash empty fixture file failed.");
  }
  return {relative, static_cast<std::uint64_t>(bytes.QuadPart), file.expected_image_sha256};
}
void CheckInterruptedInstall(HANDLE parent, const CellFileIdentity& identity, const std::wstring& cell_name,
    const std::wstring& user, const std::wstring& fixture_path, const CellRuntimeBundleFile& marker_file) {
  auto name = cell_name; name[8] = name[8] == L'0' ? L'1' : L'0';
  CellWorkspaceDirectories destination;
  Check(destination.Create(parent, identity, name, user, user) == ERROR_SUCCESS, "create separate partial-install destination");
  const auto source_root = fixture_path + L"\\interrupted-source";
  Check(CreateDirectoryW(source_root.c_str(), nullptr), "create owned interruption source");
  std::vector<CellRuntimeBundleFile> files;
  for (unsigned index = 0; index < 256; ++index) {
    std::array<wchar_t, 24> relative{};
    swprintf_s(relative.data(), relative.size(), L"item-%03u.txt", index);
    WriteMarker(source_root + L"\\" + relative.data());
    files.push_back({relative.data(), marker_file.bytes, marker_file.sha256});
  }
  CellFileSha256 digest{};
  Require(HashRuntimeBundleManifest(files, &digest) == ERROR_SUCCESS, "Hash interrupted-install manifest failed.");
  Handle source_root_handle{OpenParent(source_root)};
  PinnedCellRuntimeBundle source, output;
  Check(source.Open(source_root, Identity(source_root_handle.value), files, digest) == ERROR_SUCCESS,
    "pin interruption source files before installing");
  Handle cancelled{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Require(cancelled.value != nullptr, "Create interrupted-install event failed.");
  const auto first = destination.DirectoryPath(CellDirectory::runtime) + L"\\item-000.txt";
  bool observed = false;
  DWORD cancellation_error = ERROR_GEN_FAILURE;
  std::jthread watch([&](std::stop_token stop) {
    const auto deadline = GetTickCount64() + 5000;
    while (!stop.stop_requested() && GetTickCount64() < deadline) {
      if (GetFileAttributesW(first.c_str()) != INVALID_FILE_ATTRIBUTES) {
        observed = true;
        cancellation_error = SetEvent(cancelled.value) ? ERROR_SUCCESS : GetLastError();
        return;
      }
      Sleep(1);
    }
    SetEvent(cancelled.value);
  });
  const auto interrupted = source.InstallTo(destination, output, FixtureInstallAuthority(cancelled.value));
  watch.request_stop(); watch.join();
  if (!observed || cancellation_error || interrupted.error != ERROR_CANCELLED || interrupted.verified)
    std::fprintf(stderr, "Interrupted install observed=%d signal=%lu error=%lu files=%u bytes=%llu verified=%d\n",
      observed, cancellation_error, interrupted.error, interrupted.files_created,
      static_cast<unsigned long long>(interrupted.bytes_written), interrupted.verified);
  Check(observed && cancellation_error == ERROR_SUCCESS && interrupted.error == ERROR_CANCELLED &&
    interrupted.files_created > 0 && interrupted.files_created < files.size() && !interrupted.verified && !output.Ready(),
    "cancellation after actual file creation retains an incomplete runtime without publication");
  std::uint32_t found = 0;
  std::uint64_t bytes = 0;
  for (const auto& file : files) {
    Handle retained{CreateFileW((destination.DirectoryPath(CellDirectory::runtime) + L"\\" + file.relative_path).c_str(),
      GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    if (retained.value == INVALID_HANDLE_VALUE) {
      Require(GetLastError() == ERROR_FILE_NOT_FOUND, "Partial installation file inventory failed.");
      continue;
    }
    LARGE_INTEGER length{};
    Require(GetFileSizeEx(retained.value, &length) && length.QuadPart >= 0, "Partial file footprint read failed.");
    ++found; bytes += static_cast<std::uint64_t>(length.QuadPart);
  }
  Check(found == interrupted.files_created && bytes == interrupted.bytes_written && destination.Verify() == ERROR_SUCCESS,
    "partial file and byte counters match the retained disk footprint");
  const auto retry = source.InstallTo(destination, output, FixtureInstallAuthority());
  Check(retry.error == ERROR_DIR_NOT_EMPTY && retry.files_created == 0 && retry.bytes_written == 0 && !output.Ready(),
    "retry refuses partial state rather than adopting or deleting it");
  auto complete_name = cell_name; complete_name[9] = complete_name[9] == L'0' ? L'1' : L'0';
  CellWorkspaceDirectories complete_destination;
  Check(complete_destination.Create(parent, identity, complete_name, user, user) == ERROR_SUCCESS,
    "create a fresh destination after retaining the partial installation");
  const auto complete = source.InstallTo(complete_destination, output, FixtureInstallAuthority());
  Check(complete.error == ERROR_SUCCESS && complete.verified && output.Ready() && complete.files_created == files.size() &&
    complete.bytes_written == marker_file.bytes * files.size(), "install a complete large runtime without adopting the partial tree");
  FILE_STANDARD_INFO directory_size{};
  Check(GetFileInformationByHandleEx(complete_destination.DirectoryHandle(CellDirectory::runtime), FileStandardInfo,
    &directory_size, sizeof(directory_size)) && directory_size.EndOfFile.QuadPart > 0 && complete_destination.Verify() == ERROR_SUCCESS,
    "normal NTFS directory index growth preserves exact workspace custody");
}
}

unsigned RunCellMountedWorkspaceJournalTests(const std::wstring& directory) {
  const auto user = CurrentUser();
  CreateParent(directory, ParentDescriptor(user));
  Handle parent{OpenParent(directory)};
  return RunCellMountedWorkspaceProvisioningJournalTests(parent.value, Identity(parent.value), user);
}

unsigned RunCellHostCapacityJournalFixture(const std::wstring& directory) {
  const auto user = CurrentUser();
  CreateParent(directory, ParentDescriptor(user));
  Handle parent{OpenParent(directory)};
  return RunCellHostCapacityJournalTests(parent.value, user);
}

unsigned RunCellProvisioningJournalFixture(const std::wstring& directory) {
  const auto user = CurrentUser();
  CreateParent(directory, ParentDescriptor(user));
  Handle parent{OpenParent(directory)};
  return RunCellProvisioningJournalTests(parent.value, Identity(parent.value), user);
}

unsigned RunCellWorkspaceTests(const JobCommand& command, DWORD& explicit_create, DWORD& explicit_dacl,
                              unsigned& disk_checks, unsigned& attachment_checks, unsigned& journal_checks, bool live_attachment,
                              bool include_journal) {
  const auto started = GetTickCount64();
  const auto phase = [&](const char* name) {
    std::fprintf(stderr, "Native workspace phase: %s at %llu ms\n", name,
      static_cast<unsigned long long>(GetTickCount64() - started)); std::fflush(stderr);
  };
  phase("parent");
  const std::wstring fixture_path = command.directory + L"\\workspace-" + std::to_wstring(GetCurrentProcessId());
  Require(CreateDirectoryW(fixture_path.c_str(), nullptr) != FALSE, "Create exclusive workspace fixture parent failed.");
  const auto user = CurrentUser();
  Handle unprotected;
  unprotected.value = OpenParent(fixture_path);
  CellWorkspaceDirectories refused_parent;
  Check(refused_parent.Create(unprotected.value, Identity(unprotected.value), command.job_name, user, user) ==
    ERROR_INVALID_SECURITY_DESCR && !refused_parent.Ready() && !refused_parent.DirectoryHandle(CellDirectory::root),
    "ordinary inherited parent is refused before any cell is created");
  Check(GetFileAttributesW((fixture_path + L"\\" + command.job_name).c_str()) == INVALID_FILE_ATTRIBUTES,
    "unprotected parent rejection leaves no cell directory");
  const std::wstring parent_path = fixture_path + L"\\cells";
  CreateParent(parent_path, ParentDescriptor(user));
  Handle parent;
  parent.value = OpenParent(parent_path);
  const auto identity = Identity(parent.value);
  // Journal corruption/alias fixtures need all original controller pins closed.
  // Run them before this separate workspace owner pins the same parent.
  phase("provisioning-journal");
  journal_checks = include_journal ? RunCellProvisioningJournalTests(parent.value, identity, user) : 0;
  phase("workspace-roots");
  CellWorkspaceDirectories roots;
  const DWORD created = roots.Create(parent.value, identity, command.job_name, user, user);
  if (created) std::fprintf(stderr, "Workspace create error: %lu (root=%p control=%p runtime=%p work=%p)\n", created,
    roots.DirectoryHandle(CellDirectory::root), roots.DirectoryHandle(CellDirectory::control),
    roots.DirectoryHandle(CellDirectory::runtime), roots.DirectoryHandle(CellDirectory::work));
  Check(created == ERROR_SUCCESS && roots.Ready(), "create protected native workspace roots");
  Check(roots.Verify() == ERROR_SUCCESS, "verify newly created workspace roots");
  const auto recorded = CheckRecordedWorkspaceReopen(roots, parent.value, identity, command.job_name, user);
  CheckRecordedWorkspaceReplacement(fixture_path, command.job_name, user);
  phase("virtual-disk");
  disk_checks = RunCellVirtualDiskTests(roots, parent.value, identity, user, attachment_checks, live_attachment);
  phase("workspace-security");
  for (const auto& path : {parent_path, fixture_path}) {
    Handle writable;
    writable.value = CreateFileW(path.c_str(), FILE_ADD_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    Check(writable.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
      "parent and ancestor data-write handles are excluded by retained pins");
    Handle removable;
    removable.value = CreateFileW(path.c_str(), DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    Check(removable.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
      "parent and ancestor deletion handles are excluded by retained pins");
  }
  Check(!MoveFileW(parent_path.c_str(), (fixture_path + L"\\moved-cells").c_str()) &&
    GetLastError() == ERROR_SHARING_VIOLATION, "retained protected parent cannot move while a cell owns it");
  Check(roots.Create(parent.value, identity, command.job_name, user, user) == ERROR_ALREADY_INITIALIZED,
    "occupied owner refuses another creation");
  CellWorkspaceDirectories collision;
  const auto root_identity = roots.DirectoryIdentity(CellDirectory::root);
  Check(collision.Create(parent.value, identity, command.job_name, user, user) == ERROR_ALREADY_EXISTS &&
    !collision.Ready() && !collision.DirectoryHandle(CellDirectory::root), "existing cell name cannot be adopted");
  Check(roots.Verify() == ERROR_SUCCESS && roots.DirectoryIdentity(CellDirectory::root) == root_identity,
    "name collision preserves existing identity and ACLs");
  CellWorkspaceDirectories invalid;
  auto wrong_parent = identity;
  wrong_parent.file_id[0] ^= 1;
  Check(invalid.Create(parent.value, wrong_parent, command.job_name, user, user) == ERROR_FILE_INVALID &&
    !invalid.DirectoryHandle(CellDirectory::root), "wrong admitted parent identity causes no creation");
  wrong_parent = identity;
  wrong_parent.volume_serial ^= 1;
  Check(invalid.Create(parent.value, wrong_parent, command.job_name, user, user) == ERROR_FILE_INVALID,
    "wrong admitted volume causes no creation");
  for (const auto& name : {std::wstring(), std::wstring(L".."), command.job_name + L"\\escape", command.job_name + L":stream",
                          command.job_name + L" ", std::wstring(L"GC-CELL-") + command.job_name.substr(8)})
    Check(invalid.Create(parent.value, identity, name, user, user) == ERROR_INVALID_PARAMETER, "noncanonical cell name is refused");
  Check(invalid.Create(parent.value, identity, command.job_name, user, L"S-1-1-0") == ERROR_INVALID_PARAMETER,
    "broad controller principal is refused");
  Check(invalid.Create(parent.value, identity, command.job_name, L"SY", user) == ERROR_INVALID_PARAMETER,
    "owner requires a canonical, frozen SID");
  Check(invalid.Create(parent.value, identity, command.job_name, L"S-1-5-21-1-2-3-1001", user) ==
    ERROR_INVALID_SECURITY_DESCR && !invalid.DirectoryHandle(CellDirectory::root), "parent owner cannot be substituted");
  Check(invalid.Create(parent.value, identity, command.job_name, user, L"S-1-5-80-1-2-3-4-5") ==
    ERROR_INVALID_SECURITY_DESCR && !invalid.DirectoryHandle(CellDirectory::root), "parent controller cannot be substituted");
  // Independently constructed descriptors must be refused without repair.
  auto broad = ParentDescriptor(user);
  broad.insert(broad.find(L"S:"), L"(A;OICI;FA;;;WD)");
  auto inherited = ParentDescriptor(user);
  inherited.erase(inherited.find(L"D:P") + 2, 1);
  auto low = ParentDescriptor(user);
  low.replace(low.find(L";;;ME)"), 6, L";;;LW)");
  auto owner_rights = ParentDescriptor(user);
  owner_rights.replace(owner_rights.find(L"RC;;;OW"), 7, L"WD;;;OW");
  unsigned variant = 0;
  for (const auto& sddl : {broad, inherited, low, owner_rights}) {
    const auto path = fixture_path + L"\\unsafe-parent-" + std::to_wstring(++variant);
    CreateParent(path, sddl);
    Handle unsafe;
    unsafe.value = OpenParent(path);
    Check(invalid.Create(unsafe.value, Identity(unsafe.value), command.job_name, user, user) ==
      ERROR_INVALID_SECURITY_DESCR && !invalid.DirectoryHandle(CellDirectory::root), "unsafe parent descriptor fails before creation");
    Check(GetFileAttributesW((path + L"\\" + command.job_name).c_str()) == INVALID_FILE_ATTRIBUTES,
      "unsafe descriptor leaves existing parent state intact");
  }
  const auto busy_path = fixture_path + L"\\busy-parent";
  CreateParent(busy_path, ParentDescriptor(user));
  Handle busy, writer;
  busy.value = OpenParent(busy_path);
  writer.value = CreateFileW(busy_path.c_str(), FILE_ADD_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  Check(writer.value != INVALID_HANDLE_VALUE, "controller can open a parent data writer before custody");
  Check(invalid.Create(busy.value, Identity(busy.value), command.job_name, user, user) == ERROR_SHARING_VIOLATION &&
    !invalid.DirectoryHandle(CellDirectory::root), "existing data writer prevents parent custody");
  CloseHandle(writer.value); writer.value = INVALID_HANDLE_VALUE;
  Check(invalid.Create(busy.value, Identity(busy.value), command.job_name, user, user) == ERROR_SUCCESS,
    "fresh verification succeeds after the preexisting writer closes");
  invalid.Close();
  writer.value = CreateFileW(busy_path.c_str(), DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  Check(writer.value != INVALID_HANDLE_VALUE, "close releases protected-parent pins without deleting the directory");
  CloseHandle(writer.value); writer.value = INVALID_HANDLE_VALUE;
  const auto stream_parent = fixture_path + L"\\stream-parent";
  CreateParent(stream_parent, ParentDescriptor(user));
  WriteMarker(stream_parent + L":unexpected");
  Handle stream;
  stream.value = OpenParent(stream_parent);
  Check(invalid.Create(stream.value, Identity(stream.value), command.job_name, user, user) == ERROR_ACCESS_DENIED &&
    !invalid.DirectoryHandle(CellDirectory::root) && SameMarker(stream_parent + L":unexpected"),
    "parent alternate stream is refused and retained for reconciliation");
  std::wstring sibling_name = command.job_name;
  sibling_name.back() = sibling_name.back() == L'0' ? L'1' : L'0';
  CellWorkspaceDirectories sibling;
  Check(sibling.Create(parent.value, identity, sibling_name, user, user) == ERROR_SUCCESS, "create a different cell's protected roots");
  Handle parent_editor;
  parent_editor.value = CreateFileW(parent_path.c_str(), READ_CONTROL | WRITE_DAC | WRITE_OWNER,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(parent_editor.value != INVALID_HANDLE_VALUE, "controller retains parent security rights during custody");
  LocalMemory parent_security;
  PACL parent_dacl = nullptr, parent_label = nullptr;
  Check(GetSecurityInfo(parent_editor.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
    nullptr, nullptr, &parent_dacl, &parent_label, &parent_security.value) == ERROR_SUCCESS,
    "retain original parent security before deliberate fixture drift");
  ACL empty_parent{};
  Check(InitializeAcl(&empty_parent, sizeof(empty_parent), ACL_REVISION) &&
    SetSecurityInfo(parent_editor.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, &empty_parent, nullptr) == ERROR_SUCCESS, "controller changes the owned parent ACL fixture");
  Check(roots.Verify() == ERROR_INVALID_SECURITY_DESCR && !roots.Ready() &&
    sibling.Verify() == ERROR_INVALID_SECURITY_DESCR && !sibling.Ready(), "parent ACL drift invalidates every affected cell");
  CellWorkspaceDirectories recorded_reader;
  auto stale_record = recorded;
  Check(roots.RecordIdentities(&stale_record) == ERROR_INVALID_SECURITY_DESCR && stale_record == CellWorkspaceIdentities{},
    "security drift cannot produce a reusable identity record");
  Check(recorded_reader.OpenRecorded(parent.value, recorded, command.job_name, user, user) != ERROR_SUCCESS,
    "recorded parent identity does not authorize changed parent permissions");
  CheckClosedWorkspace(recorded_reader);
  Check(refused_parent.Create(parent.value, identity, command.job_name, user, user) == ERROR_INVALID_SECURITY_DESCR &&
    !refused_parent.DirectoryHandle(CellDirectory::root), "changed parent security blocks further creation");
  Check(SetSecurityInfo(parent_editor.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
    nullptr, nullptr, parent_dacl, nullptr) == ERROR_SUCCESS && roots.Verify() == ERROR_SUCCESS && sibling.Verify() == ERROR_SUCCESS,
    "only restored exact parent ACL passes fresh verification");
  LocalMemory low_descriptor;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)", SDDL_REVISION_1,
    &low_descriptor.value, nullptr), "prepare owned parent label drift fixture");
  PACL low_label = nullptr;
  BOOL low_present = FALSE, low_defaulted = FALSE;
  Check(GetSecurityDescriptorSacl(low_descriptor.value, &low_present, &low_label, &low_defaulted) && low_present &&
    SetSecurityInfo(parent_editor.value, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION,
      nullptr, nullptr, nullptr, low_label) == ERROR_SUCCESS, "controller changes the owned parent integrity label");
  Check(roots.Verify() == ERROR_INVALID_SECURITY_DESCR && !roots.Ready(), "parent label drift invalidates retained cell readiness");
  Check(recorded_reader.OpenRecorded(parent.value, recorded, command.job_name, user, user) != ERROR_SUCCESS,
    "recorded reopen refuses changed parent integrity label");
  CheckClosedWorkspace(recorded_reader);
  Check(SetSecurityInfo(parent_editor.value, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION,
    nullptr, nullptr, nullptr, parent_label) == ERROR_SUCCESS && roots.Verify() == ERROR_SUCCESS && sibling.Verify() == ERROR_SUCCESS,
    "only restored exact parent label passes fresh verification");
  const auto control_file = roots.DirectoryPath(CellDirectory::control) + L"\\controller.txt";
  const auto runtime_file = roots.DirectoryPath(CellDirectory::runtime) + L"\\support\\runtime.txt";
  WriteMarker(control_file);
  const auto source_root = fixture_path + L"\\install-source";
  Check(CreateDirectoryW(source_root.c_str(), nullptr) && CreateDirectoryW((source_root + L"\\support").c_str(), nullptr),
    "create owned bundle source directories");
  Check(CopyFileW(command.image.c_str(), (source_root + L"\\entry.exe").c_str(), TRUE), "copy exact fixture executable to source bundle");
  {
    Handle empty{CreateFileW((source_root + L"\\empty.txt").c_str(), GENERIC_WRITE, FILE_SHARE_READ,
      nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
    Require(empty.value != INVALID_HANDLE_VALUE, "Create empty installation fixture failed.");
  }
  WriteMarker(source_root + L"\\support\\runtime.txt");
  std::vector<CellRuntimeBundleFile> runtime_files{BundleFile(source_root, L"empty.txt"),
    BundleFile(source_root, L"entry.exe"), BundleFile(source_root, L"support/runtime.txt")};
  CellFileSha256 bundle_hash{};
  Check(HashRuntimeBundleManifest(runtime_files, &bundle_hash) == ERROR_SUCCESS, "freeze source runtime manifest");
  Handle source_directory{OpenParent(source_root)};
  PinnedCellRuntimeBundle source_bundle, installed_bundle;
  auto installation = source_bundle.InstallTo(roots, installed_bundle, FixtureInstallAuthority());
  Check(installation.error == ERROR_INVALID_STATE && installation.files_created == 0 && !installed_bundle.Ready(),
    "an unverified source cannot write a runtime");
  Check(source_bundle.Open(source_root, Identity(source_directory.value), runtime_files, bundle_hash) == ERROR_SUCCESS,
    "pin the complete approved source before copying");
  CellWorkspaceDirectories missing_destination;
  installation = source_bundle.InstallTo(missing_destination, installed_bundle, FixtureInstallAuthority());
  Check(installation.error == ERROR_INVALID_HANDLE && installation.files_created == 0, "unverified destination refuses installation");
  Handle cancelled{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
  Require(cancelled.value != nullptr, "Create install cancellation fixture failed.");
  installation = source_bundle.InstallTo(roots, installed_bundle, FixtureInstallAuthority(cancelled.value));
  Check(installation.error == ERROR_CANCELLED && installation.files_created == 0 && installation.directories_created == 0,
    "pre-cancelled installation has no disk effect");
  const auto occupied_file = sibling.DirectoryPath(CellDirectory::runtime) + L"\\existing.txt";
  WriteMarker(occupied_file);
  installation = source_bundle.InstallTo(sibling, installed_bundle, FixtureInstallAuthority());
  Check(installation.error == ERROR_DIR_NOT_EMPTY && installation.files_created == 0 && SameMarker(occupied_file),
    "nonempty runtime is refused without adopting or replacing its content");
  installation = source_bundle.InstallTo(roots, installed_bundle, FixtureInstallAuthority());
  if (installation.error) std::fprintf(stderr, "Runtime install error=%lu files=%u directories=%u bytes=%llu\n", installation.error,
    installation.files_created, installation.directories_created, static_cast<unsigned long long>(installation.bytes_written));
  Check(installation.error == ERROR_SUCCESS && installation.verified && installed_bundle.Ready(),
    "copy and pin complete runtime into the protected cell");
  Check(installation.files_created == 3 && installation.directories_created == 1 &&
    installation.bytes_written == runtime_files[1].bytes + runtime_files[2].bytes, "report actual installation resource footprint including an empty file");
  Check(SameMarker(runtime_file), "installed nested dependency has the exact source bytes");
  const auto installed_image = roots.DirectoryPath(CellDirectory::runtime) + L"\\entry.exe";
  Check(installed_bundle.ContainsImage(installed_image, command.expected_image_sha256), "installed executable belongs to the exact verified tree");
  Check(source_bundle.InstallTo(roots, installed_bundle, FixtureInstallAuthority()).error == ERROR_INVALID_STATE,
    "a live output pin cannot be replaced implicitly");
  PinnedCellRuntimeBundle refused_install;
  Check(source_bundle.InstallTo(roots, refused_install, FixtureInstallAuthority()).error == ERROR_DIR_NOT_EMPTY && !refused_install.Ready(),
    "installation replay cannot adopt an existing runtime");
  {
    Handle write{CreateFileW(runtime_file.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    Check(write.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
      "installed output stays immutable while its verified pins are held");
  }
  installed_bundle.Reset(); // Exercise real ACL denials, not only retained sharing locks.
  phase("interrupted-install");
  CheckInterruptedInstall(parent.value, identity, command.job_name, user, fixture_path, runtime_files.back());
  phase("protected-runtime");
  WriteMarker(sibling.DirectoryPath(CellDirectory::work) + L"\\sibling.txt");
  auto child_command = command;
  child_command.image = installed_image;
  child_command.directory = roots.DirectoryPath(CellDirectory::work);
  child_command.expected_directory_identity = roots.DirectoryIdentity(CellDirectory::work);
  child_command.command_line = Quote(installed_image) + L" workspace " + Quote(roots.DirectoryPath(CellDirectory::root)) +
    L" " + Quote(control_file) + L" " + Quote(runtime_file) + L" " + Quote(sibling.DirectoryPath(CellDirectory::work));
  const RuntimeJobCommand protected_request{child_command, roots.DirectoryPath(CellDirectory::runtime),
    roots.DirectoryIdentity(CellDirectory::runtime), bundle_hash, runtime_files,
    RuntimeWorkspaceReference{parent_path, recorded, user, user}};
  const JobLimits protected_limits{3, 64ULL * 1024 * 1024, 1000, 5000, 8192, 4096};
  auto changed_request = protected_request;
  changed_request.protected_workspace->identities.directories[0].file_id.back() ^= 0x80;
  const auto changed_run = RunVerifiedRuntimeJob(changed_request, protected_limits);
  Check(changed_run.job.error == ERROR_FILE_INVALID && !changed_run.job.process_id && !changed_run.protected_workspace_verified,
    "changed recorded workspace refuses before any protected child is created");
  changed_request = protected_request;
  changed_request.launch.expected_directory_identity = recorded.directories[static_cast<std::size_t>(CellDirectory::runtime)];
  const auto wrong_directory = RunVerifiedRuntimeJob(changed_request, protected_limits);
  Check(wrong_directory.job.error == ERROR_INVALID_PARAMETER && !wrong_directory.job.process_id,
    "protected runtime cannot substitute the runtime root for the writable work root");
  const auto installed_run = RunVerifiedRuntimeJob(protected_request, protected_limits);
  Check(installed_run.runtime_bundle_verified && installed_run.runtime_bundle_sha256 == bundle_hash && installed_run.protected_workspace_verified,
    "installed runtime composes exact bundle and recorded protected workspace custody");
  checks += RunCellRuntimeStdioTests(protected_request);
  phase("journal-runtime");
  checks += RunCellJournalRuntimeTests(protected_request, protected_limits);
  phase("runtime-security");
  const auto& result = installed_run.job;
  const std::string output(result.standard_output.prefix.begin(), result.standard_output.prefix.end());
  const std::string errors(result.standard_error.prefix.begin(), result.standard_error.prefix.end());
  if (result.error || result.process_exit_code) std::fprintf(stderr, "Workspace child: error=%lu exit=%lu output=%s errors=%s\n",
    result.error, result.process_exit_code, output.c_str(), errors.c_str());
  Check(result.error == ERROR_SUCCESS && result.end == JobEnd::exited && result.process_exit_code == 0,
    "actual AppContainer completes work and permission probes");
  Check(result.app_container_verified && result.launch_files_verified && result.zero_processes_verified && result.output_drained,
    "workspace probe retains existing token, image and process-lifetime guarantees");
  unsigned child_checks = 0;
  explicit_create = ERROR_GEN_FAILURE;
  explicit_dacl = ERROR_GEN_FAILURE;
  Check(sscanf_s(output.c_str(), "workspace_checks=%u explicit_create_error=%lu explicit_dacl_error=%lu", &child_checks,
    &explicit_create, &explicit_dacl) == 3 && child_checks >= 45, "child reports actual permission and explicit-descriptor probe outcomes");
  checks += child_checks;
  Check(roots.Verify() == ERROR_SUCCESS && sibling.Verify() == ERROR_SUCCESS, "child cannot drift either cell's root identities or ACLs");
  Check(SameMarker(control_file) && SameMarker(runtime_file), "private and runtime inputs remain byte-identical");
  PSID app_sid = nullptr;
  Check(SUCCEEDED(DeriveAppContainerSidFromAppContainerName(command.app_container_name.c_str(), &app_sid)),
    "derive identical AppContainer SID for controller descriptor control");
  LocalMemory app_text;
  const bool converted = ConvertSidToStringSidW(app_sid, reinterpret_cast<LPWSTR*>(&app_text.value)) != FALSE;
  FreeSid(app_sid);
  Check(converted, "format identical AppContainer SID for descriptor control");
  LocalMemory control_descriptor;
  const std::wstring control_sddl = L"D:P(A;;FA;;;" + user + L")(A;;FA;;;" + static_cast<const wchar_t*>(app_text.value) + L")";
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(control_sddl.c_str(), SDDL_REVISION_1, &control_descriptor.value, nullptr),
    "build the child's exact descriptor outside AppContainer");
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), control_descriptor.value, FALSE};
  Handle explicit_control;
  explicit_control.value = CreateFileW((roots.DirectoryPath(CellDirectory::work) + L"\\controller-descriptor.txt").c_str(),
    GENERIC_WRITE | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(explicit_control.value != INVALID_HANDLE_VALUE, "same explicit descriptor permits controller write and DACL access");
  DWORD written = 0;
  Check(WriteFile(explicit_control.value, marker, sizeof(marker), &written, nullptr) && written == sizeof(marker),
    "controller explicit-descriptor control writes actual bytes");

  // A retained parent handle, rather than a later path lookup, owns creation.
  // The actual admitted parent is pinned and verified at its current location.
  // The rename precedes custody of this separate subtree. The direct parent
  // must not already be pinned by another cell: that intentionally blocks it.
  const std::wstring rename_fixture = fixture_path + L"\\rename-cases";
  Require(CreateDirectoryW(rename_fixture.c_str(), nullptr), "Create owned rename fixture parent failed.");
  const std::wstring alias_parent_path = rename_fixture + L"\\relative-parent";
  CreateParent(alias_parent_path, ParentDescriptor(user));
  Check(GetFileAttributesW(alias_parent_path.c_str()) != INVALID_FILE_ATTRIBUTES, "create owned relative-parent fixture");
  Handle alias_parent;
  alias_parent.value = CreateFileW(alias_parent_path.c_str(), FILE_GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(alias_parent.value != INVALID_HANDLE_VALUE, "open movable relative-parent fixture");
  const auto alias_identity = Identity(alias_parent.value);
  const std::wstring moved_parent_path = rename_fixture + L"\\relative-parent-moved";
  Check(alias_parent_path.compare(0, rename_fixture.size() + 1, rename_fixture + L"\\") == 0 &&
    moved_parent_path.compare(0, rename_fixture.size() + 1, rename_fixture + L"\\") == 0, "both rename targets stay in owned fixture parent");
  Check(MoveFileW(alias_parent_path.c_str(), moved_parent_path.c_str()) && CreateDirectoryW(alias_parent_path.c_str(), nullptr),
    "replace the original directory spelling with a different object");
  CellWorkspaceDirectories relative;
  Check(relative.Create(alias_parent.value, alias_identity, command.job_name, user, user) == ERROR_SUCCESS &&
    GetFileAttributesW((moved_parent_path + L"\\" + command.job_name).c_str()) != INVALID_FILE_ATTRIBUTES &&
    GetFileAttributesW((alias_parent_path + L"\\" + command.job_name).c_str()) == INVALID_FILE_ATTRIBUTES,
    "creation follows the admitted handle and cannot switch to a replacement at the old path");

  // The broker retains repair rights. Drift invalidates the cached verification;
  // restoration uses the prior descriptor, never newly observed disk authority.
  Handle editable;
  editable.value = CreateFileW(roots.DirectoryPath(CellDirectory::work).c_str(), READ_CONTROL | WRITE_DAC | WRITE_OWNER,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(editable.value != INVALID_HANDLE_VALUE, "controller retains DACL and ownership access");
  PSECURITY_DESCRIPTOR original = nullptr;
  PACL original_dacl = nullptr, original_sacl = nullptr;
  Check(GetSecurityInfo(editable.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
    nullptr, nullptr, &original_dacl, &original_sacl, &original) == ERROR_SUCCESS, "retain exact pre-drift root security");
  struct DescriptorCleanup final { PSECURITY_DESCRIPTOR value; ~DescriptorCleanup() { LocalFree(value); } } original_owner{original};
  ACL empty{};
  Check(InitializeAcl(&empty, sizeof(empty), ACL_REVISION) &&
    SetSecurityInfo(editable.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, &empty, nullptr) == ERROR_SUCCESS, "controller can perform owned ACL drift fixture");
  Check(roots.Verify() == ERROR_INVALID_SECURITY_DESCR && !roots.Ready(), "ACL drift clears readiness even through retained handles");
  const auto changed_security_run = RunVerifiedRuntimeJob(protected_request, protected_limits);
  Check(changed_security_run.job.error != ERROR_SUCCESS && !changed_security_run.job.process_id && !changed_security_run.protected_workspace_verified,
    "changed root security refuses protected launch without falling back to bundle-only execution");
  Check(recorded_reader.OpenRecorded(parent.value, recorded, command.job_name, user, user) != ERROR_SUCCESS,
    "recorded directory identity does not authorize changed root permissions");
  CheckClosedWorkspace(recorded_reader);
  Check(SetSecurityInfo(editable.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
    nullptr, nullptr, original_dacl, nullptr) == ERROR_SUCCESS && roots.Verify() == ERROR_SUCCESS, "restored exact ACL passes a new verification");
  checks += RunCellRuntimeStdioTests(protected_request, [&] {
    Check(SetSecurityInfo(editable.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, &empty, nullptr) == ERROR_SUCCESS, "change owned root permissions after actual child startup");
  });
  Check(SetSecurityInfo(editable.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
    nullptr, nullptr, original_dacl, nullptr) == ERROR_SUCCESS && roots.Verify() == ERROR_SUCCESS,
    "restore exact fixture permissions after protected completion refuses drift");
  PSECURITY_DESCRIPTOR medium = nullptr;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;ME)", SDDL_REVISION_1, &medium, nullptr) != FALSE,
    "prepare medium-integrity drift fixture");
  DescriptorCleanup medium_owner{medium};
  PACL label = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  Check(GetSecurityDescriptorSacl(medium, &present, &label, &defaulted) && present &&
    SetSecurityInfo(editable.value, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, label) == ERROR_SUCCESS,
    "controller can perform owned integrity drift fixture");
  Check(roots.Verify() == ERROR_INVALID_SECURITY_DESCR && !roots.Ready(), "integrity drift clears readiness");
  Check(recorded_reader.OpenRecorded(parent.value, recorded, command.job_name, user, user) != ERROR_SUCCESS,
    "recorded reopen refuses changed root integrity label");
  CheckClosedWorkspace(recorded_reader);
  Check(SetSecurityInfo(editable.value, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, original_sacl) == ERROR_SUCCESS &&
    roots.Verify() == ERROR_SUCCESS, "restored exact integrity label passes a new verification");
  const auto stream_path = roots.DirectoryPath(CellDirectory::work) + L":metadata-drift";
  WriteMarker(stream_path);
  Check(SameMarker(stream_path), "create and read an actual directory alternate stream drift fixture");
  Check(roots.Verify() == ERROR_ACCESS_DENIED && !roots.Ready(), "unaccounted root stream invalidates verification");
  Check(recorded_reader.OpenRecorded(parent.value, recorded, command.job_name, user, user) == ERROR_ACCESS_DENIED,
    "recorded reopen refuses an unaccounted alternate stream");
  CheckClosedWorkspace(recorded_reader);
  installation = source_bundle.InstallTo(roots, refused_install, FixtureInstallAuthority());
  Check(installation.error == ERROR_ACCESS_DENIED && installation.files_created == 0 && !refused_install.Ready(),
    "installer rechecks current protected workspace metadata before writing");
  Check(roots.DirectoryHandle(CellDirectory::work) != nullptr && SameMarker(stream_path),
    "refused metadata remains retained for canonical reconciliation");
  const auto retained_path = roots.DirectoryPath(CellDirectory::root);
  roots.Close();
  Check(!roots.Ready() && !roots.DirectoryHandle(CellDirectory::root) && GetFileAttributesW(retained_path.c_str()) != INVALID_FILE_ATTRIBUTES,
    "closing handles retains owned disk state for recovery and capacity accounting");
  Check(roots.Verify() == ERROR_INVALID_HANDLE && !roots.Ready(), "closed handles cannot claim verified roots");
  return checks;
}
