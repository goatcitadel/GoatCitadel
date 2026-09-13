#include "appcontainer_fixture.hpp"
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <array>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <string_view>
#include <vector>
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell_test {
namespace {
std::vector<std::wstring> created_profiles;
void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
bool ValidName(const std::wstring& name) noexcept {
  constexpr std::wstring_view prefix = L"GoatCitadel.Worker.";
  if (name.size() != prefix.size() + 32 || name.compare(0, prefix.size(), prefix) != 0) return false;
  for (std::size_t index = prefix.size(); index < name.size(); ++index)
    if (!((name[index] >= L'0' && name[index] <= L'9') || (name[index] >= L'a' && name[index] <= L'f'))) return false;
  return true;
}
void GrantRead(const std::wstring& path, PSID sid, DWORD rights) {
  PACL previous = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  Require(GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    nullptr, nullptr, &previous, nullptr, &descriptor) == ERROR_SUCCESS, "Read fixture DACL failed.");
  EXPLICIT_ACCESSW entry{};
  entry.grfAccessPermissions = rights;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.grfInheritance = NO_INHERITANCE;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  PACL updated = nullptr;
  DWORD result = SetEntriesInAclW(1, &entry, previous, &updated);
  if (result == ERROR_SUCCESS) result = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION, nullptr, nullptr, updated, nullptr);
  if (updated) LocalFree(updated);
  if (descriptor) LocalFree(descriptor);
  Require(result == ERROR_SUCCESS, "Grant fixture read/execute failed.");
}
std::string AsciiProfile(const std::wstring& profile) {
  Require(ValidName(profile), "Invalid profile for fixture receipt.");
  std::string ascii;
  for (const wchar_t character : profile) ascii.push_back(static_cast<char>(character));
  return ascii;
}
bool WriteReceipt(const std::wstring& path, const std::string& data) {
  const auto pending = path + L".pending";
  HANDLE file = CreateFileW(pending.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const bool saved = WriteFile(file, data.data(), static_cast<DWORD>(data.size()), &written, nullptr) &&
    written == data.size() && FlushFileBuffers(file);
  CloseHandle(file);
  return saved && MoveFileW(pending.c_str(), path.c_str());
}
}

std::wstring PrepareAppContainer(const std::wstring& job_name, const std::wstring& image, const std::vector<std::wstring>& read_files) {
  Require(job_name.size() == 40 && job_name.compare(0, 8, L"gc-cell-") == 0, "Invalid test job name.");
  const std::wstring name = L"GoatCitadel.Worker." + job_name.substr(8);
  Require(ValidName(name), "Invalid test profile name.");
  // Record ownership before creating so an allocation failure cannot orphan a
  // newly-created profile. Existing profiles are never adopted or removed.
  created_profiles.push_back(name);
  PSID sid = nullptr;
  const HRESULT created = CreateAppContainerProfile(name.c_str(), L"GoatCitadel cell test",
    L"Task-owned disposable native acceptance fixture", nullptr, 0, &sid);
  if (FAILED(created)) {
    created_profiles.pop_back();
    throw std::runtime_error("Create task-owned AppContainer profile failed: " + std::to_string(created));
  }
  try {
    GrantRead(image.substr(0, image.find_last_of(L'\\')), sid,
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE);
    GrantRead(image, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE);
    for (const auto& file : read_files) GrantRead(file, sid, FILE_GENERIC_READ);
  } catch (...) { FreeSid(sid); throw; }
  FreeSid(sid);
  return name;
}

bool CleanupKnownAppContainer(const std::wstring& name) noexcept {
  if (!ValidName(name)) return false;
  const HRESULT result = DeleteAppContainerProfile(name.c_str());
  return SUCCEEDED(result) || result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
}
void BindLaunchFixture(goatcitadel::worker_cell::JobCommand* command, DWORD maximum_image_bytes) {
  Require(maximum_image_bytes > 0 && maximum_image_bytes <= 256 * 1024 * 1024, "Invalid fixture image bound.");
  HANDLE root = CreateFileW(command->directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Require(root != INVALID_HANDLE_VALUE, "Open launch fixture directory failed.");
  FILE_ID_INFO identity{};
  const bool identified = GetFileInformationByHandleEx(root, FileIdInfo, &identity, sizeof(identity)) != FALSE;
  CloseHandle(root);
  Require(identified, "Read launch fixture directory identity failed.");
  command->expected_directory_identity.volume_serial = identity.VolumeSerialNumber;
  std::copy(std::begin(identity.FileId.Identifier), std::end(identity.FileId.Identifier),
    command->expected_directory_identity.file_id.begin());
  HANDLE image = CreateFileW(command->image.c_str(), GENERIC_READ, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Require(image != INVALID_HANDLE_VALUE, "Open launch fixture image failed.");
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(image, &size) || size.QuadPart < 1 || size.QuadPart > maximum_image_bytes) {
    CloseHandle(image); throw std::runtime_error("Invalid fixture image size.");
  }
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size.QuadPart));
  DWORD received = 0;
  const bool read = ReadFile(image, bytes.data(), static_cast<DWORD>(bytes.size()), &received, nullptr) != FALSE;
  CloseHandle(image);
  Require(read && received == bytes.size(), "Read launch fixture image failed.");
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  Require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0, "Open fixture hash provider failed.");
  const bool hashed = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()),
    command->expected_image_sha256.data(), static_cast<ULONG>(command->expected_image_sha256.size())) == 0;
  BCryptCloseAlgorithmProvider(algorithm, 0);
  Require(hashed, "Hash launch fixture image failed.");
}
bool CleanupAppContainers() noexcept {
  bool success = true;
  for (auto current = created_profiles.rbegin(); current != created_profiles.rend(); ++current)
    if (!CleanupKnownAppContainer(*current)) success = false;
  created_profiles.clear();
  return success;
}
void WritePrivateFixture(const std::wstring& path) {
  HANDLE token = nullptr;
  Require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) != FALSE, "Open fixture token failed.");
  std::array<std::uint8_t, 4096> user{};
  DWORD size = 0;
  const bool read = GetTokenInformation(token, TokenUser, user.data(), static_cast<DWORD>(user.size()), &size) != FALSE;
  CloseHandle(token);
  Require(read, "Read fixture token failed.");
  LPWSTR sid = nullptr;
  Require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, &sid) != FALSE,
    "Read fixture user SID failed.");
  const std::wstring sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + std::wstring(sid) + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  Require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != FALSE,
    "Create private fixture descriptor failed.");
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor, FALSE};
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  LocalFree(descriptor);
  Require(file != INVALID_HANDLE_VALUE, "Create private fixture failed.");
  constexpr char data[] = "task-owned private fixture";
  DWORD written = 0;
  const bool saved = WriteFile(file, data, sizeof(data) - 1, &written, nullptr) != FALSE;
  CloseHandle(file);
  Require(saved && written == sizeof(data) - 1, "Write private fixture failed.");
}
void ReportOwnedProfile(const std::wstring& profile, const std::wstring& path) {
  Require(std::find(created_profiles.begin(), created_profiles.end(), profile) != created_profiles.end(),
    "Cannot report ownership of a profile this process did not create.");
  Require(WriteReceipt(path, "{\"profile\":\"" + AsciiProfile(profile) + "\"}"), "Publish owned profile receipt failed.");
}
void ReportOwnedJobProcess(const std::wstring& job_name, const std::wstring& profile, const std::wstring& path) {
  if (!ValidName(profile)) return;
  const ULONGLONG deadline = GetTickCount64() + 5000;
  DWORD last_error = ERROR_SUCCESS;
  while (GetTickCount64() < deadline) {
    HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, (L"Local\\" + job_name).c_str());
    if (job) {
      DWORD child_id = 0;
      HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      if (snapshot != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W entry{};
        entry.dwSize = sizeof(entry);
        if (Process32FirstW(snapshot, &entry)) do {
          if (entry.th32ParentProcessID != GetCurrentProcessId()) continue;
          HANDLE child = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
          BOOL contained = FALSE;
          if (child) {
            if (IsProcessInJob(child, job, &contained) && contained) child_id = entry.th32ProcessID;
            else last_error = GetLastError();
            CloseHandle(child);
          } else last_error = GetLastError();
        } while (!child_id && Process32NextW(snapshot, &entry));
        CloseHandle(snapshot);
      } else last_error = GetLastError();
      CloseHandle(job);
      if (child_id) {
        std::array<char, 160> report{};
        const auto ascii_profile = AsciiProfile(profile);
        const int count = sprintf_s(report.data(), report.size(), "{\"pid\":%llu,\"profile\":\"%s\"}",
          static_cast<unsigned long long>(child_id), ascii_profile.c_str());
        if (count <= 0 || !WriteReceipt(path, report.data())) std::fprintf(stderr, "Publish owned child receipt failed.\n");
        return;
      }
    } else last_error = GetLastError();
    Sleep(10);
  }
  std::fprintf(stderr, "Observe owned child deadline: last_error=%lu\n", last_error);
}
}  // namespace goatcitadel::worker_cell_test
