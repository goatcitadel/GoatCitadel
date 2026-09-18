#include "cell_virtual_disk.hpp"
#include "cell_capacity.hpp"
#include "cell_security.hpp"
#include <sddl.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0;
void Check(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(message) + " (check " + std::to_string(checks) + ")");
}
struct Handle final {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
std::wstring User() {
  Handle token;
  Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value), "Read fixture account.");
  DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  std::vector<std::uint8_t> bytes(size);
  Check(size && GetTokenInformation(token.value, TokenUser, bytes.data(), size, &size), "Read account SID.");
  LPWSTR text = nullptr;
  Check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &text), "Encode account SID.");
  const std::wstring result(text); LocalFree(text); return result;
}
CellFileIdentity Identity(HANDLE file) {
  FILE_ID_INFO info{};
  Check(GetFileInformationByHandleEx(file, FileIdInfo, &info, sizeof(info)), "Independently read file identity.");
  CellFileIdentity result{info.VolumeSerialNumber};
  std::memcpy(result.file_id.data(), info.FileId.Identifier, result.file_id.size()); return result;
}
bool Same(const CellVirtualDiskRecord& a, const CellVirtualDiskRecord& b) {
  return IsEqualGUID(a.spec.identifier, b.spec.identifier) && a.spec.virtual_bytes == b.spec.virtual_bytes &&
    a.spec.reserved_file_bytes == b.spec.reserved_file_bytes && a.control == b.control && a.backing == b.backing;
}
bool Empty(const CellVirtualDiskCapacity& value) {
  return Same(value.record, {}) && !value.file_bytes && !value.allocated_bytes;
}
DWORD Allow(void*) noexcept { return ERROR_SUCCESS; }
CellFileSha256 Hash(const std::wstring& path) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  LARGE_INTEGER size{};
  Check(file.value != INVALID_HANDLE_VALUE && GetFileSizeEx(file.value, &size) && size.QuadPart > 0 && size.QuadPart <= 80LL * 1024 * 1024,
    "Open exact bounded owned image for mutation control.");
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size.QuadPart)); DWORD count = 0;
  Check(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count == bytes.size(), "Read complete control bytes.");
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "Open control hash provider.");
  CellFileSha256 result{};
  const auto error = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()), result.data(), static_cast<ULONG>(result.size()));
  BCryptCloseAlgorithmProvider(algorithm, 0); Check(error >= 0, "Hash unchanged image bytes."); return result;
}
struct Fixture final {
  std::wstring user, path;
  Handle parent;
  CellWorkspaceDirectories workspace;
  CellVirtualDiskFile disk;
  CellVirtualDiskRecord recorded;
  explicit Fixture(const std::wstring& root) : user(User()) {
    Check(IsLiteralCellPath(root) && CreateDirectoryW(root.c_str(), nullptr), "Create exclusive ordinary fixture root.");
    const auto parent_path = root + L"\\protected-parent";
    std::vector<std::uint8_t> descriptor;
    Check(BuildCellParentSecurity(user, user, &descriptor) == ERROR_SUCCESS, "Build permissions only for fixture directory.");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor.data(), FALSE};
    Check(CreateDirectoryW(parent_path.c_str(), &security), "Create owned protected parent, never a drive root.");
    parent.value = CreateFileW(parent_path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    Check(parent.value != INVALID_HANDLE_VALUE, "Open owned parent.");
    Check(workspace.Create(parent.value, Identity(parent.value), L"gc-cell-0123456789abcdef0123456789abcdef", user, user) == ERROR_SUCCESS,
      "Create exact protected workspace.");
    CellVirtualDiskSpec spec; spec.identifier.Data1 = 0x981245;
    spec.virtual_bytes = 16ULL * 1024 * 1024; spec.reserved_file_bytes = 80ULL * 1024 * 1024;
    Check(disk.Create(workspace, spec, 10000) == ERROR_SUCCESS, "Create only a fixed unattached VHDX.");
    Check(disk.RecordIdentity(workspace, &recorded) == ERROR_SUCCESS, "Independently retain original disk record.");
    path = workspace.DirectoryPath(CellDirectory::control) + L"\\cell.vhdx";
  }
  CellVirtualDiskCapacity Observe(const CellFootprintScanGuard& guard = {Allow}, DWORD wall = 10000) {
    CellVirtualDiskCapacity result;
    const auto error = disk.ObserveCapacity(workspace, recorded, wall, guard, &result);
    if (error) std::fprintf(stderr, "observation error=%lu\n", error);
    Check(error == ERROR_SUCCESS && Same(result.record, recorded), "Observation preserves exact disk identity and capacity binding.");
    return result;
  }
  void Refuse(const CellVirtualDiskRecord& expected, const CellFootprintScanGuard& guard = {Allow}, DWORD wall = 10000) {
    CellVirtualDiskCapacity result{recorded, 99, 99};
    Check(disk.ObserveCapacity(workspace, expected, wall, guard, &result) != ERROR_SUCCESS && Empty(result),
      "Refusal clears all prior capacity output.");
  }
};
struct Action final {
  unsigned calls = 0, at = 1;
  DWORD refusal = 0;
  HANDLE cancellation = nullptr;
  Fixture* fixture = nullptr;
  bool reopen = false, close_workspace = false, timestamp = false;
  HANDLE delay = nullptr;
  HANDLE security_file = nullptr;
  PACL original_dacl = nullptr;
  CellVirtualDiskRecord* expected = nullptr;
  CellFootprintScanGuard* original_guard = nullptr;
  static DWORD Current(void* raw) noexcept {
    auto& action = *static_cast<Action*>(raw);
    if (++action.calls != action.at) return ERROR_SUCCESS;
    if (action.refusal) return action.refusal;
    if (action.cancellation && !SetEvent(action.cancellation)) return GetLastError();
    if (action.delay && WaitForSingleObject(action.delay, 150) != WAIT_TIMEOUT) return ERROR_INVALID_STATE;
    if (action.security_file) return SetSecurityInfo(action.security_file, SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, action.original_dacl, nullptr);
    if (action.expected) { action.expected->spec.virtual_bytes *= 2; action.expected->backing.file_id[0] ^= 1; }
    if (action.original_guard) action.original_guard->authorize = nullptr;
    if (action.close_workspace) action.fixture->workspace.Close();
    if (action.reopen) {
      action.fixture->disk.Close();
      return action.fixture->disk.OpenRecorded(action.fixture->workspace, action.fixture->recorded, 10000);
    }
    if (action.timestamp) {
      Handle file{CreateFileW(action.fixture->path.c_str(), FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
      FILETIME written{};
      if (file.value == INVALID_HANDLE_VALUE || !GetFileTime(file.value, nullptr, nullptr, &written)) return GetLastError();
      ULARGE_INTEGER time; time.LowPart = written.dwLowDateTime; time.HighPart = written.dwHighDateTime;
      time.QuadPart += 10000000; written.dwLowDateTime = time.LowPart; written.dwHighDateTime = time.HighPart;
      if (!SetFileTime(file.value, nullptr, nullptr, &written)) return GetLastError();
    }
    return ERROR_SUCCESS;
  }
};
void Tests(const std::wstring& root) {
  Fixture fixture(root);
  const auto before = Hash(fixture.path);
  const auto observed = fixture.Observe();
  Handle control{CreateFileW(fixture.path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  LARGE_INTEGER size{}; DWORD high = 0; SetLastError(ERROR_SUCCESS);
  const DWORD low = GetCompressedFileSizeW(fixture.path.c_str(), &high);
  Check(low != INVALID_FILE_SIZE || GetLastError() == ERROR_SUCCESS, "Independent host allocation measurement succeeds.");
  Check(control.value != INVALID_HANDLE_VALUE && GetFileSizeEx(control.value, &size), "Independent host EOF measurement succeeds.");
  Check(observed.file_bytes == static_cast<std::uint64_t>(size.QuadPart) &&
    observed.allocated_bytes == ((static_cast<std::uint64_t>(high) << 32) | low), "Host charges match independent Windows queries.");
  Check(observed.file_bytes > fixture.recorded.spec.virtual_bytes && observed.allocated_bytes >= observed.file_bytes &&
    observed.allocated_bytes <= fixture.recorded.spec.reserved_file_bytes, "Backing charge includes VHDX metadata outside the guest volume.");
  Check(fixture.disk.ObserveCapacity(fixture.workspace, fixture.recorded, 10000, {Allow}, nullptr) == ERROR_INVALID_PARAMETER, "Null output refused.");
  for (unsigned field = 0; field < 7; ++field) {
    auto wrong = fixture.recorded;
    if (field == 0) ++wrong.spec.identifier.Data1;
    if (field == 1) wrong.spec.virtual_bytes *= 2;
    if (field == 2) wrong.spec.reserved_file_bytes *= 2;
    if (field == 3) ++wrong.control.volume_serial;
    if (field == 4) wrong.control.file_id[0] ^= 1;
    if (field == 5) ++wrong.backing.volume_serial;
    if (field == 6) wrong.backing.file_id[0] ^= 1;
    Action action; fixture.Refuse(wrong, {Action::Current, &action});
    Check(action.calls == 0, "Foreign identity is refused before authority callback.");
  }
  fixture.Refuse(fixture.recorded, {});
  fixture.Refuse(fixture.recorded, {Allow}, 0); fixture.Refuse(fixture.recorded, {Allow}, 60001);
  fixture.Refuse(fixture.recorded, {Allow, nullptr, INVALID_HANDLE_VALUE});
  fixture.Refuse(fixture.recorded, {Allow, nullptr, GetCurrentThread()});
  Handle cancelled{CreateEventW(nullptr, TRUE, TRUE, nullptr)}, delay{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(cancelled.value && delay.value, "Create owned cancellation fixtures.");
  fixture.Refuse(fixture.recorded, {Allow, nullptr, cancelled.value});
  for (unsigned at : {1U, 2U}) {
    Action denied; denied.at = at; denied.refusal = ERROR_ACCESS_DENIED;
    fixture.Refuse(fixture.recorded, {Action::Current, &denied}); Check(denied.calls == at, "Refusal occurs at exact authority boundary.");
    Check(ResetEvent(cancelled.value), "Reset only owned fixture cancellation.");
    Action cancel; cancel.at = at; cancel.cancellation = cancelled.value;
    fixture.Refuse(fixture.recorded, {Action::Current, &cancel, cancelled.value}); Check(cancel.calls == at, "Cancellation wins after callback.");
    Action slow; slow.at = at; slow.delay = delay.value;
    fixture.Refuse(fixture.recorded, {Action::Current, &slow}, 100); Check(slow.calls == at, "Callback cannot extend original deadline.");
  }
  auto mutable_record = fixture.recorded;
  Action mutate; mutate.expected = &mutable_record;
  CellFootprintScanGuard mutable_guard{Action::Current, &mutate}; mutate.original_guard = &mutable_guard;
  CellVirtualDiskCapacity frozen;
  Check(fixture.disk.ObserveCapacity(fixture.workspace, mutable_record, 10000, mutable_guard, &frozen) == ERROR_SUCCESS &&
    Same(frozen.record, fixture.recorded) && mutate.calls == 2, "Caller-owned record and callback table are frozen before first callback.");
  CellVirtualDiskCapacity alias = observed;
  Check(fixture.disk.ObserveCapacity(fixture.workspace, alias.record, 10000, {Allow}, &alias) == ERROR_SUCCESS &&
    Same(alias.record, fixture.recorded), "Aliased input is retained before output clears.");
  Action changed; changed.at = 2; changed.timestamp = true; changed.fixture = &fixture;
  fixture.Refuse(fixture.recorded, {Action::Current, &changed}); Check(changed.calls == 2, "Metadata drift invalidates otherwise equal byte counts.");
  for (unsigned at : {1U, 2U}) {
    Action replaced; replaced.at = at; replaced.reopen = true; replaced.fixture = &fixture;
    fixture.Refuse(fixture.recorded, {Action::Current, &replaced}); Check(replaced.calls == at, "Close/reopen of same file invalidates in-flight owner.");
    Check(fixture.Observe().allocated_bytes == observed.allocated_bytes, "Fresh owner can observe the same independently recorded file.");
  }
  CellVirtualDiskAttachment unattached;
  CellVirtualDiskCapacity refused{fixture.recorded, 99, 99}; Action unused;
  Check(unattached.ObserveCapacity(fixture.workspace, fixture.recorded, 10000, {Action::Current, &unused}, &refused) != ERROR_SUCCESS &&
    Empty(refused) && unused.calls == 0, "Unadmitted attachment never yields capacity or performs authority callbacks.");
  Handle security_file{CreateFileW(fixture.path.c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  PSECURITY_DESCRIPTOR descriptor = nullptr; PACL dacl = nullptr;
  Check(security_file.value != INVALID_HANDLE_VALUE && GetSecurityInfo(security_file.value, SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION, nullptr, nullptr, &dacl, nullptr, &descriptor) == ERROR_SUCCESS,
    "Retain exact permissions of only the owned fixture file.");
  for (unsigned at : {1U, 2U}) {
    Action security; security.at = at; security.security_file = security_file.value; security.original_dacl = dacl;
    CellVirtualDiskCapacity result{fixture.recorded, 99, 99};
    const auto error = fixture.disk.ObserveCapacity(fixture.workspace, fixture.recorded, 10000, {Action::Current, &security}, &result);
    const auto restored = SetSecurityInfo(security_file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, dacl, nullptr);
    Check(error == ERROR_INVALID_SECURITY_DESCR && Empty(result) && security.calls == at && restored == ERROR_SUCCESS,
      "Backing permission drift withholds capacity at each authority boundary.");
    Check(fixture.Observe().allocated_bytes == observed.allocated_bytes, "Restored fixture permissions require fresh successful verification.");
  }
  LocalFree(descriptor);
  Check(Hash(fixture.path) == before, "All observations and refusals preserve every VHDX byte.");
  Action roots; roots.fixture = &fixture; roots.close_workspace = true; roots.at = 2;
  fixture.Refuse(fixture.recorded, {Action::Current, &roots}); Check(roots.calls == 2, "Lost workspace ownership invalidates output.");
}
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 2) return 2;
    Tests(argv[1]);
    std::printf("{\"passed\":true,\"checks\":%u,\"volumeOperations\":false,\"quotaEnforced\":false}\n", checks); return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
