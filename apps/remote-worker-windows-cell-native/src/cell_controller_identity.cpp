#include "cell_controller_identity.hpp"
#include "cell_workspace.hpp"
#include "cell_security.hpp"
#include <sddl.h>
#include <algorithm>
#include <cstring>
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr wchar_t system_sid[] = L"S-1-5-18";
bool SameLuid(const LUID& a, const LUID& b) noexcept { return a.LowPart == b.LowPart && a.HighPart == b.HighPart; }
bool Nonzero(const LUID& id) noexcept { return id.LowPart || id.HighPart; }
template<class T> bool NonzeroBytes(const T& value) noexcept {
  return std::any_of(value.begin(), value.end(), [](auto byte) { return byte != 0; });
}
bool SamePath(const std::wstring& a, const std::wstring& b) noexcept {
  return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_EQUAL;
}
bool NoThreadToken() noexcept {
  HANDLE token = nullptr;
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token)) { CloseHandle(token); return false; }
  return GetLastError() == ERROR_NO_TOKEN;
}
struct Handle final { HANDLE value = nullptr; ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
struct Buffer final {
  alignas(16) std::array<std::uint8_t, 16384> bytes{};
  DWORD size = 0;
  // Explicit tail keeps the required token-data alignment without ARM64 C4324.
  std::array<std::uint8_t, 12> padding{};
};
bool ReadToken(HANDLE token, TOKEN_INFORMATION_CLASS kind, Buffer& data, std::size_t minimum) noexcept {
  data.bytes.fill(0); data.size = 0;
  return GetTokenInformation(token, kind, data.bytes.data(), static_cast<DWORD>(data.bytes.size()), &data.size) &&
    data.size >= minimum && data.size <= data.bytes.size();
}
bool Sid(const Buffer& data, PSID input, std::wstring& output) {
  const auto start = reinterpret_cast<std::uintptr_t>(data.bytes.data()), address = reinterpret_cast<std::uintptr_t>(input);
  if (!input || address < start || address - start > data.size || data.size - (address - start) < 8) return false;
  const auto count = static_cast<const SID*>(input)->SubAuthorityCount;
  if (count > SID_MAX_SUB_AUTHORITIES || data.size - (address - start) < 8U + 4U * count || !IsValidSid(input)) return false;
  LPWSTR text = nullptr;
  if (!ConvertSidToStringSidW(input, &text)) return false;
  try { output = text; } catch (...) { LocalFree(text); throw; }
  LocalFree(text); return true;
}
CellFileIdentity ReadIdentity(const std::uint8_t* bytes) noexcept {
  CellFileIdentity identity{};
  for (unsigned i = 0; i < 8; ++i) identity.volume_serial |= static_cast<std::uint64_t>(bytes[i]) << (8 * i);
  std::copy_n(bytes + 8, 16, identity.file_id.begin()); return identity;
}
bool IdentityMatches(HANDLE file, const CellFileIdentity& expected) noexcept {
  FILE_ID_INFO actual{};
  return GetFileInformationByHandleEx(file, FileIdInfo, &actual, sizeof(actual)) && actual.VolumeSerialNumber == expected.volume_serial &&
    std::equal(std::begin(actual.FileId.Identifier), std::end(actual.FileId.Identifier), expected.file_id.begin());
}
bool AllowedState(DWORD state) noexcept { return state == SERVICE_START_PENDING || state == SERVICE_RUNNING; }
DWORD ReadCustody(HANDLE record, CellControllerCustodyRecord* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  try {
    LARGE_INTEGER length{}, beginning{};
    std::vector<std::uint8_t> bytes(120); DWORD read = 0;
    if (!GetFileSizeEx(record, &length) || length.QuadPart != static_cast<LONGLONG>(bytes.size()) ||
        !SetFilePointerEx(record, beginning, nullptr, FILE_BEGIN) ||
        !ReadFile(record, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) || read != bytes.size() ||
        !DecodeCellControllerCustody(bytes, output)) return ERROR_INVALID_DATA;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
}
bool DecodeCellControllerCustody(const std::vector<std::uint8_t>& bytes, CellControllerCustodyRecord* output) noexcept {
  if (!output) return false;
  *output = {};
  if (bytes.size() != 120 || std::memcmp(bytes.data(), "GCCUST01", 8)) return false;
  CellControllerCustodyRecord value{};
  std::copy_n(bytes.begin() + 8, 32, value.image_sha256.begin());
  std::copy_n(bytes.begin() + 40, 32, value.provisioning_sha256.begin());
  value.native_directory = ReadIdentity(bytes.data() + 72); value.parent = ReadIdentity(bytes.data() + 96);
  if (!NonzeroBytes(value.image_sha256) || !NonzeroBytes(value.provisioning_sha256) || value.image_sha256 == value.provisioning_sha256 ||
      !value.parent.volume_serial || value.native_directory.volume_serial != value.parent.volume_serial ||
      !NonzeroBytes(value.parent.file_id) || !NonzeroBytes(value.native_directory.file_id) || value.parent == value.native_directory) return false;
  *output = value; return true;
}
bool ValidateCellControllerToken(const CellControllerToken& token, bool require_volume) noexcept {
  if (token.user != system_sid || token.integrity != L"S-1-16-16384" || token.type != TokenPrimary || token.session != 0 ||
      !Nonzero(token.token_id) || !Nonzero(token.authentication_id) || !token.no_thread_token || token.restricted || token.appcontainer ||
      token.groups.empty() || token.groups.size() > 128 || token.privileges.size() != 2 ||
      !Nonzero(token.change_notify) || !Nonzero(token.manage_volume) || SameLuid(token.change_notify, token.manage_volume)) return false;
  unsigned controllers = 0, services = 0, all_services = 0, change = 0, volume = 0;
  for (const auto& group : token.groups) {
    const bool enabled = (group.attributes & SE_GROUP_ENABLED) && !(group.attributes & SE_GROUP_USE_FOR_DENY_ONLY);
    if (group.sid == kCellControllerServiceSid) { if (!enabled) return false; ++controllers; }
    // The OS-wide All Services group is not a second per-service identity.
    // Neither it nor SERVICE can substitute for this controller's exact SID.
    else if (group.sid == L"S-1-5-80-0") { if (!enabled) return false; ++all_services; }
    else if (group.sid.rfind(L"S-1-5-80-", 0) == 0) return false;
    if (group.sid == L"S-1-5-6") { if (!enabled) return false; ++services; }
    if (enabled && (group.sid == L"S-1-5-2" || group.sid == L"S-1-5-3" || group.sid == L"S-1-5-4" || group.sid == L"S-1-5-14")) return false;
  }
  constexpr DWORD allowed = SE_PRIVILEGE_ENABLED | SE_PRIVILEGE_ENABLED_BY_DEFAULT | SE_PRIVILEGE_USED_FOR_ACCESS;
  for (const auto& privilege : token.privileges) {
    if (privilege.Attributes & ~allowed) return false;
    if (SameLuid(privilege.Luid, token.change_notify)) { if (!(privilege.Attributes & SE_PRIVILEGE_ENABLED)) return false; ++change; }
    else if (SameLuid(privilege.Luid, token.manage_volume)) {
      if (require_volume && !(privilege.Attributes & SE_PRIVILEGE_ENABLED)) return false;
      ++volume;
    } else return false;
  }
  // LocalSystem inherits the SCM security context rather than a virtual user's
  // LSA service logon. Admission additionally binds the exact SCM process PID.
  return controllers == 1 && services <= 1 && all_services <= 1 && change == 1 && volume == 1;
}
bool CollectCellControllerToken(HANDLE token, CellControllerToken* output) noexcept {
  if (!output) return false;
  *output = {};
  if (!token || token == INVALID_HANDLE_VALUE) return false;
  try {
    CellControllerToken value;
    value.no_thread_token = NoThreadToken();
    if (!value.no_thread_token) return false;
    Buffer data;
    if (!ReadToken(token, TokenUser, data, sizeof(TOKEN_USER)) || !Sid(data, reinterpret_cast<TOKEN_USER*>(data.bytes.data())->User.Sid, value.user) ||
        !ReadToken(token, TokenIntegrityLevel, data, sizeof(TOKEN_MANDATORY_LABEL)) ||
        !Sid(data, reinterpret_cast<TOKEN_MANDATORY_LABEL*>(data.bytes.data())->Label.Sid, value.integrity)) return false;
    if (!ReadToken(token, TokenStatistics, data, sizeof(TOKEN_STATISTICS))) return false;
    const auto& statistics = *reinterpret_cast<TOKEN_STATISTICS*>(data.bytes.data());
    value.token_id = statistics.TokenId; value.authentication_id = statistics.AuthenticationId; value.type = statistics.TokenType;
    if (!ReadToken(token, TokenSessionId, data, sizeof(DWORD))) return false;
    value.session = *reinterpret_cast<DWORD*>(data.bytes.data());
    if (!ReadToken(token, TokenIsAppContainer, data, sizeof(DWORD))) return false;
    value.appcontainer = *reinterpret_cast<DWORD*>(data.bytes.data()) != 0;
    if (!ReadToken(token, TokenRestrictedSids, data, offsetof(TOKEN_GROUPS, Groups))) return false;
    value.restricted = IsTokenRestricted(token) || reinterpret_cast<TOKEN_GROUPS*>(data.bytes.data())->GroupCount != 0;
    if (!ReadToken(token, TokenGroups, data, offsetof(TOKEN_GROUPS, Groups))) return false;
    const auto* groups = reinterpret_cast<TOKEN_GROUPS*>(data.bytes.data());
    if (groups->GroupCount > 128 || data.size < offsetof(TOKEN_GROUPS, Groups) + groups->GroupCount * sizeof(SID_AND_ATTRIBUTES)) return false;
    for (DWORD i = 0; i < groups->GroupCount; ++i) {
      worker_host::GroupIdentity group;
      if (!Sid(data, groups->Groups[i].Sid, group.sid)) return false;
      group.attributes = groups->Groups[i].Attributes; value.groups.push_back(std::move(group));
    }
    if (!ReadToken(token, TokenPrivileges, data, offsetof(TOKEN_PRIVILEGES, Privileges))) return false;
    const auto* privileges = reinterpret_cast<TOKEN_PRIVILEGES*>(data.bytes.data());
    if (privileges->PrivilegeCount > 64 || data.size < offsetof(TOKEN_PRIVILEGES, Privileges) + privileges->PrivilegeCount * sizeof(LUID_AND_ATTRIBUTES)) return false;
    value.privileges.assign(privileges->Privileges, privileges->Privileges + privileges->PrivilegeCount);
    if (!LookupPrivilegeValueW(nullptr, SE_CHANGE_NOTIFY_NAME, &value.change_notify) || !LookupPrivilegeValueW(nullptr, SE_MANAGE_VOLUME_NAME, &value.manage_volume)) return false;
    if (!NoThreadToken()) return false;
    *output = std::move(value); return true;
  } catch (...) { return false; }
}
bool ValidateCellControllerConfiguration(const worker_host::ServiceConfiguration& config,
  const std::wstring& image, DWORD expected_state) noexcept {
  return AllowedState(expected_state) && image.size() > 2 && image.front() == L'"' && image.back() == L'"' &&
    SamePath(config.binary, image) && SamePath(config.account, L"LocalSystem") && config.type == SERVICE_WIN32_OWN_PROCESS &&
    config.start == SERVICE_DEMAND_START && config.error_control == SERVICE_ERROR_NORMAL && config.sid_type == SERVICE_SID_TYPE_UNRESTRICTED &&
    config.status_type == SERVICE_WIN32_OWN_PROCESS && config.status_state == expected_state && !config.status_flags &&
    config.no_load_group && config.no_dependencies && config.no_triggers && config.no_failure_actions && config.no_non_crash_actions && config.no_delayed_start &&
    config.required_privileges.size() == 2 &&
    std::count(config.required_privileges.begin(), config.required_privileges.end(), SE_CHANGE_NOTIFY_NAME) == 1 &&
    std::count(config.required_privileges.begin(), config.required_privileges.end(), SE_MANAGE_VOLUME_NAME) == 1;
}
CellControllerIdentity::~CellControllerIdentity() { Close(); }
bool CellControllerIdentity::CurrentService(DWORD state) noexcept {
  worker_host::ServiceConfiguration config;
  worker_host::ServiceObjectSecurity security;
  SERVICE_STATUS_PROCESS status{}; DWORD size = 0;
  return service_ && QueryServiceStatusEx(service_, SC_STATUS_PROCESS_INFO, reinterpret_cast<LPBYTE>(&status), sizeof(status), &size) &&
    status.dwProcessId == GetCurrentProcessId() && status.dwServiceType == SERVICE_WIN32_OWN_PROCESS &&
    status.dwCurrentState == state && !status.dwServiceFlags &&
    worker_host::CollectServiceConfiguration(service_, &config) && ValidateCellControllerConfiguration(config, installed_.QuotedImagePath(), state) &&
    worker_host::CollectServiceObjectSecurity(service_, &security) && worker_host::ValidateServiceObject(security);
}
CellControllerInstalledFiles::~CellControllerInstalledFiles() { Close(); }
DWORD CellControllerInstalledFiles::Open() noexcept {
  if (open_ || record_) return ERROR_ALREADY_INITIALIZED;
  const auto refuse = [&](DWORD error) { Close(); return error; };
  try {
    std::array<wchar_t, 2048> windows{};
    const auto count = GetSystemWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
    if (count < 3 || count >= windows.size() || windows[1] != L':' || windows[2] != L'\\') return refuse(ERROR_BAD_PATHNAME);
    root_ = std::wstring(windows.data(), 3) + L"ProgramData\\GoatCitadel\\RemoteWorker";
    image_path_ = root_ + L"\\payload\\app\\worker\\native\\" + kCellControllerImageName;
    quoted_image_ = L"\"" + image_path_ + L"\"";
    parent_path_ = root_ + L"\\cells";
    if (!IsLiteralCellPath(root_)) return refuse(ERROR_BAD_PATHNAME);
    DWORD error = OpenFiles();
    if (error) return refuse(error);
    open_ = true;
    error = Verify();
    return error ? refuse(error) : ERROR_SUCCESS;
  } catch (...) { return refuse(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellControllerInstalledFiles::OpenFiles() noexcept {
  try {
    const auto drive = root_.substr(0, 3), program_data = drive + L"ProgramData", shared = program_data + L"\\GoatCitadel";
    const auto native = root_ + L"\\payload\\app\\worker\\native";
    std::size_t index = 0;
    for (const auto& directory : {drive, program_data, shared, root_, root_ + L"\\payload", root_ + L"\\payload\\app",
        root_ + L"\\payload\\app\\worker", native, root_ + L"\\configuration"}) {
      HANDLE file = nullptr; std::wstring canonical;
      const DWORD error = directories_.PinPath(directory, true, &file, &canonical);
      if (error) return error;
      directory_handles_[index++] = file;
      const bool trusted = directory == drive || directory == program_data || directory == shared
        ? worker_host::VerifyWorkerAncestorHandle(file, directory == shared) : worker_host::VerifyWorkerFileHandle(file);
      if (!trusted) return ERROR_ACCESS_DENIED;
    }
    std::wstring canonical;
    DWORD error = configuration_.PinPath(root_ + L"\\configuration\\cell-controller.identity", false, &record_, &canonical);
    if (error) return error;
    if (!worker_host::VerifyWorkerFileHandle(record_)) return ERROR_ACCESS_DENIED;
    error = ReadCustody(record_, &custody_);
    if (error) return error;
    error = image_.Open(image_path_, native, custody_.image_sha256, custody_.native_directory);
    if (!error) error = helper_.Open(native + L"\\GoatCitadelRemoteWorkerCellProvisioning.exe", native,
      custody_.provisioning_sha256, custody_.native_directory);
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellControllerInstalledFiles::Verify() noexcept {
  if (!open_) return ERROR_INVALID_STATE;
  // Retained data handles exclude content writes and replacement, but do not
  // freeze WRITE_DAC. Recheck all custody descriptors before privileged work.
  for (std::size_t index = 0; index < directory_handles_.size(); ++index) {
    if (!directory_handles_[index] || !(index < 3
        ? worker_host::VerifyWorkerAncestorHandle(directory_handles_[index], index == 2)
        : worker_host::VerifyWorkerFileHandle(directory_handles_[index]))) return ERROR_ACCESS_DENIED;
  }
  if (!record_ || !worker_host::VerifyWorkerFileHandle(record_) || image_.handles_.empty() || helper_.handles_.empty() ||
      !worker_host::VerifyWorkerFileHandle(image_.handles_.back()) ||
      !worker_host::VerifyWorkerFileHandle(helper_.handles_.back())) return ERROR_ACCESS_DENIED;
  CellControllerCustodyRecord record;
  DWORD error = ReadCustody(record_, &record);
  if (!error && (record.image_sha256 != custody_.image_sha256 || record.provisioning_sha256 != custody_.provisioning_sha256 ||
      record.native_directory != custody_.native_directory || record.parent != custody_.parent)) error = ERROR_FILE_INVALID;
  return error;
}

DWORD CellControllerInstalledFiles::VerifyControllerProcess(HANDLE process) const noexcept {
  return open_ ? image_.VerifyProcessImage(process) : ERROR_INVALID_STATE;
}
DWORD CellControllerInstalledFiles::VerifyProvisioningProcess(HANDLE process) const noexcept {
  return open_ ? helper_.VerifyProcessImage(process) : ERROR_INVALID_STATE;
}
void CellControllerInstalledFiles::Close() noexcept {
  open_ = false; record_ = nullptr; directory_handles_.fill(nullptr);
  helper_.Reset(); image_.Reset(); configuration_.Reset(); directories_.Reset();
  custody_ = {}; root_.clear(); image_path_.clear(); quoted_image_.clear(); parent_path_.clear();
}
DWORD CellControllerIdentity::VerifyFiles() noexcept {
  DWORD error = installed_.Verify();
  if (!error) error = installed_.VerifyControllerProcess(GetCurrentProcess());
  if (!error && !IdentityMatches(parent_, installed_.ParentIdentity())) error = ERROR_FILE_INVALID;
  if (!error) error = VerifyCellSecurity(parent_, parent_security_);
  return error;
}
DWORD CellControllerIdentity::Open(DWORD count, wchar_t** arguments) noexcept {
  if (open_ || token_ || service_) return ERROR_ALREADY_INITIALIZED;
  if (count != 1 || !arguments || !arguments[0] || wcscmp(arguments[0], kCellControllerServiceName)) return ERROR_BAD_ARGUMENTS;
  const auto refuse = [&](DWORD error) { Close(); return error; };
  try {
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, &token_) ||
        !CollectCellControllerToken(token_, &initial_token_) || !ValidateCellControllerToken(initial_token_, false)) return refuse(ERROR_ACCESS_DENIED);
    DWORD error = installed_.Open();
    if (!error) error = installed_.VerifyControllerProcess(GetCurrentProcess());
    if (error) return refuse(error);
    manager_ = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!manager_) return refuse(ERROR_ACCESS_DENIED);
    service_ = OpenServiceW(manager_, kCellControllerServiceName, worker_host::kWorkerServiceRead);
    if (!CurrentService(SERVICE_START_PENDING)) return refuse(ERROR_ACCESS_DENIED);
    std::wstring canonical;
    error = parent_pins_.PinPath(installed_.ParentPath(), true, &parent_, &canonical);
    if (!error && !IdentityMatches(parent_, installed_.ParentIdentity())) error = ERROR_FILE_INVALID;
    if (!error) error = BuildCellParentSecurity(system_sid, kCellControllerServiceSid, &parent_security_);
    if (error) return refuse(error);
    open_ = true;
    error = Verify(SERVICE_START_PENDING, false);
    return error ? refuse(error) : ERROR_SUCCESS;
  } catch (...) { return refuse(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellControllerIdentity::Verify(DWORD state, bool require_volume) noexcept {
  if (!open_ || !AllowedState(state)) return ERROR_INVALID_STATE;
  Handle current;
  CellControllerToken token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &current.value) || !CollectCellControllerToken(current.value, &token) ||
      !ValidateCellControllerToken(token, require_volume) || !SameLuid(token.token_id, initial_token_.token_id) ||
      !SameLuid(token.authentication_id, initial_token_.authentication_id) || !CurrentService(state) || !NoThreadToken()) return ERROR_ACCESS_DENIED;
  return VerifyFiles();
}
DWORD CellControllerIdentity::EnableVolumeManagement() noexcept {
  DWORD error = Verify(SERVICE_START_PENDING, false);
  if (error) return error;
  TOKEN_PRIVILEGES privileges{};
  privileges.PrivilegeCount = 1; privileges.Privileges[0] = {initial_token_.manage_volume, SE_PRIVILEGE_ENABLED};
  SetLastError(ERROR_SUCCESS);
  if (!AdjustTokenPrivileges(token_, FALSE, &privileges, 0, nullptr, nullptr)) {
    error = GetLastError(); return error ? error : ERROR_GEN_FAILURE;
  }
  error = GetLastError();
  return error ? error : Verify(SERVICE_START_PENDING);
}
DWORD CellControllerIdentity::VerifyProvisioningProcess(HANDLE process) const noexcept {
  return open_ ? installed_.VerifyProvisioningProcess(process) : ERROR_INVALID_STATE;
}
void CellControllerIdentity::Close() noexcept {
  open_ = false; parent_ = nullptr;
  parent_pins_.Reset(); installed_.Close();
  if (service_) CloseServiceHandle(service_);
  if (manager_) CloseServiceHandle(manager_);
  if (token_) CloseHandle(token_);
  service_ = manager_ = nullptr; token_ = nullptr;
  initial_token_ = {}; parent_security_.clear();
}
}
