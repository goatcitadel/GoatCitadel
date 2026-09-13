#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#pragma comment(lib, "advapi32.lib")

namespace {
unsigned checks = 0;
DWORD explicit_create_error = ERROR_GEN_FAILURE, explicit_dacl_error = ERROR_GEN_FAILURE;
void Check(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(message) + " (child workspace check " + std::to_string(checks) + ")");
}
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { Close(); }
  void Close() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
struct LocalMemory final { void* value = nullptr; ~LocalMemory() { if (value) LocalFree(value); } };
DWORD OpenError(const std::wstring& path, DWORD rights, DWORD disposition = OPEN_EXISTING) {
  Handle handle;
  handle.value = CreateFileW(path.c_str(), rights, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, disposition,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  return handle.value == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
}
void Denied(const std::wstring& path, DWORD rights, const char* message) {
  const DWORD error = OpenError(path, rights);
  if (error != ERROR_ACCESS_DENIED) std::fprintf(stderr, "Expected access denied, received %lu for mask %lu\n", error, rights);
  Check(error == ERROR_ACCESS_DENIED, message);
}
std::wstring TokenSid(TOKEN_INFORMATION_CLASS kind) {
  Handle token;
  Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != FALSE, "open actual child token");
  alignas(TOKEN_USER) std::array<std::uint8_t, 4096> data{};
  DWORD size = 0;
  Check(GetTokenInformation(token.value, kind, data.data(), static_cast<DWORD>(data.size()), &size) != FALSE,
    "read actual child SID");
  PSID sid = kind == TokenUser ? reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid :
    reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(data.data())->TokenAppContainer;
  LocalMemory converted;
  Check(sid && ConvertSidToStringSidW(sid, reinterpret_cast<LPWSTR*>(&converted.value)), "convert actual child SID");
  return static_cast<const wchar_t*>(converted.value);
}
void Exercise(wchar_t** argv) {
  const std::wstring root(argv[2]), control_file(argv[3]), runtime_file(argv[4]), sibling(argv[5]);
  const std::wstring work = root + L"\\work", nested = work + L"\\nested";
  const std::wstring original = nested + L"\\original.txt", renamed = nested + L"\\renamed.txt";
  Check(CreateDirectoryW(nested.c_str(), nullptr) != FALSE, "create child work directory");
  Handle output;
  output.value = CreateFileW(original.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(output.value != INVALID_HANDLE_VALUE, "create ordinary writable work file");
  constexpr char marker[] = "native AppContainer work roundtrip";
  DWORD written = 0, read = 0;
  Check(WriteFile(output.value, marker, sizeof(marker), &written, nullptr) && written == sizeof(marker) && FlushFileBuffers(output.value),
    "write and flush work file");
  LARGE_INTEGER start{};
  std::array<char, sizeof(marker)> actual{};
  Check(SetFilePointerEx(output.value, start, nullptr, FILE_BEGIN) &&
    ReadFile(output.value, actual.data(), static_cast<DWORD>(actual.size()), &read, nullptr) &&
    read == sizeof(marker) && std::memcmp(actual.data(), marker, sizeof(marker)) == 0, "read exact work file bytes");
  output.Close();
  Denied(original, WRITE_DAC, "inherited work file denies DACL changes despite creator ownership");
  Denied(original, WRITE_OWNER, "inherited work file denies ownership changes");
  Denied(nested, WRITE_DAC, "inherited work directory denies DACL changes");
  Check(MoveFileW(original.c_str(), renamed.c_str()) != FALSE, "rename a child-owned work file");
  Check(DeleteFileW(renamed.c_str()) != FALSE && RemoveDirectoryW(nested.c_str()) != FALSE, "delete work file and empty child directory");
  Check(OpenError(work, FILE_GENERIC_READ) == ERROR_SUCCESS, "read/list own work root");
  Check(OpenError(root, FILE_GENERIC_READ) == ERROR_SUCCESS, "read/list own cell root");
  Check(OpenError(runtime_file, GENERIC_READ) == ERROR_SUCCESS, "read broker-created runtime input");
  Denied(control_file, GENERIC_READ, "private controller file denies child reads");
  Denied(root + L"\\control\\cell.vhdx", GENERIC_READ, "private virtual disk denies AppContainer reads");
  Denied(root + L"\\control\\cell.vhdx", GENERIC_WRITE, "private virtual disk denies AppContainer writes");
  Denied(root + L"\\control\\cell.vhdx", WRITE_DAC, "private virtual disk denies AppContainer DACL changes");
  Denied(control_file, GENERIC_WRITE, "private controller file denies child writes");
  Denied(root + L"\\control", FILE_LIST_DIRECTORY, "private controller directory denies listing");
  const auto parent = root.substr(0, root.find_last_of(L'\\'));
  Denied(parent, FILE_LIST_DIRECTORY, "protected cell parent denies listing");
  Denied(parent, WRITE_DAC, "protected cell parent denies DACL access");
  Denied(parent, WRITE_OWNER, "protected cell parent denies ownership access");
  Denied(parent, FILE_WRITE_ATTRIBUTES, "protected cell parent denies attribute writes");
  Denied(parent, FILE_ADD_FILE, "protected cell parent denies data-write access");
  Check(OpenError(parent + L"\\intrusion.txt", GENERIC_WRITE, CREATE_NEW) == ERROR_ACCESS_DENIED,
    "cannot create a file beside the cell");
  Check(!CreateDirectoryW((parent + L"\\intrusion-directory").c_str(), nullptr) && GetLastError() == ERROR_ACCESS_DENIED,
    "cannot create a directory beside the cell");
  Denied(sibling, FILE_LIST_DIRECTORY, "another cell's work directory denies listing");
  Check(OpenError(sibling + L"\\intrusion.txt", GENERIC_WRITE, CREATE_NEW) == ERROR_ACCESS_DENIED, "cannot create another cell's work file");
  Denied(work, WRITE_DAC, "work root denies DACL changes");
  Denied(work, WRITE_OWNER, "work root denies ownership changes");
  Denied(work, DELETE, "work root denies deletion and rename access");
  Denied(work, FILE_WRITE_ATTRIBUTES, "work root denies metadata changes");
  Denied(root, GENERIC_WRITE, "cell root denies child-created entries");
  Denied(root, WRITE_DAC, "cell root denies DACL changes");
  Denied(runtime_file, GENERIC_WRITE, "runtime input denies modification");
  Denied(runtime_file, WRITE_DAC, "runtime input denies DACL changes");
  Denied(runtime_file, WRITE_OWNER, "runtime input denies ownership changes");
  Check(SetNamedSecurityInfoW(const_cast<LPWSTR>(work.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    nullptr, nullptr, nullptr, nullptr) == ERROR_ACCESS_DENIED, "actual work-root DACL mutation is denied");

  const auto user = TokenSid(TokenUser), app = TokenSid(TokenAppContainerSid);
  LocalMemory owner;
  Check(ConvertStringSidToSidW(user.c_str(), &owner.value) != FALSE, "parse child owner fixture");
  Check(SetNamedSecurityInfoW(const_cast<LPWSTR>(work.c_str()), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
    owner.value, nullptr, nullptr, nullptr) == ERROR_ACCESS_DENIED, "actual work-root ownership mutation is denied");

  // Record the actual outcome of a creator-supplied protected descriptor. The
  // parent runs the same descriptor as a positive control. Root invariants and
  // ordinary work access above are mandatory regardless of this edge case.
  LocalMemory descriptor;
  const std::wstring sddl = L"D:P(A;;FA;;;" + user + L")(A;;FA;;;" + app + L")";
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr) != FALSE,
    "build explicit child-owned descriptor control");
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
  const std::wstring explicit_file = work + L"\\explicit-descriptor.txt";
  output.value = CreateFileW(explicit_file.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  explicit_create_error = output.value == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  Check(explicit_create_error == ERROR_SUCCESS || explicit_create_error == ERROR_ACCESS_DENIED,
    "explicit descriptor probe produces a definite access outcome");
  if (output.value != INVALID_HANDLE_VALUE)
    Check(WriteFile(output.value, marker, sizeof(marker), &written, nullptr) && written == sizeof(marker), "write explicit descriptor probe file");
  output.Close();
  explicit_dacl_error = OpenError(explicit_file, WRITE_DAC);
  Check(explicit_dacl_error == ERROR_SUCCESS || explicit_dacl_error == ERROR_ACCESS_DENIED || explicit_dacl_error == ERROR_FILE_NOT_FOUND,
    "explicit descriptor DACL probe produces a definite access outcome");
}
}

int ProbeCellWorkspace(wchar_t** argv) {
  try {
    Exercise(argv);
    std::printf("workspace_checks=%u explicit_create_error=%lu explicit_dacl_error=%lu\n", checks, explicit_create_error, explicit_dacl_error);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "Workspace child failed: %s (Windows error %lu)\n", error.what(), GetLastError());
    return 96;
  }
}
