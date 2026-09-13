#include "service_identity.hpp"
#include "worker_host.hpp"
#include <ntsecapi.h>
#include <sddl.h>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cwchar>
#include <string_view>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "secur32.lib")

namespace goatcitadel::worker_host {
namespace {
constexpr wchar_t kSystemSid[] = L"S-1-5-18";
constexpr wchar_t kAdministratorsSid[] = L"S-1-5-32-544";
constexpr std::size_t kMaximumPath = 2048;
// SCM configuration queries have an 8 KiB RPC limit; oversized tokens also fail closed.
struct Buffer final { alignas(std::max_align_t) std::array<BYTE, 8192> bytes{}; };
struct TokenHandle final { HANDLE value = nullptr; ~TokenHandle() { if (value) CloseHandle(value); } };
struct ServiceHandle final { SC_HANDLE value = nullptr; ~ServiceHandle() { if (value) CloseServiceHandle(value); } };
struct LocalString final { LPWSTR value = nullptr; ~LocalString() { if (value) LocalFree(value); } };
struct LogonData final {
  PSECURITY_LOGON_SESSION_DATA value = nullptr;
  ~LogonData() { if (value) LsaFreeReturnBuffer(value); }
};

bool SameLuid(LUID a, LUID b) noexcept { return a.LowPart == b.LowPart && a.HighPart == b.HighPart; }
bool SameWindowsName(std::wstring_view a, std::wstring_view b) noexcept {
  return !a.empty() && a.size() <= kMaximumPath && a.size() == b.size() &&
    CompareStringOrdinal(a.data(), static_cast<int>(a.size()), b.data(), static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}
bool Inside(const void* base, std::size_t size, const void* pointer, std::size_t count) noexcept {
  const auto first = reinterpret_cast<std::uintptr_t>(base);
  const auto value = reinterpret_cast<std::uintptr_t>(pointer);
  return pointer && value >= first && value - first <= size && count <= size - (value - first);
}
bool SidString(PSID sid, std::wstring* output) {
  LocalString text;
  if (!sid || !IsValidSid(sid) || GetLengthSid(sid) > SECURITY_MAX_SID_SIZE ||
      !ConvertSidToStringSidW(sid, &text.value)) return false;
  *output = text.value;
  return true;
}
bool BoundedSid(const Buffer& buffer, std::size_t size, PSID sid, std::wstring* output) {
  if (!Inside(buffer.bytes.data(), size, sid, 8)) return false;
  const auto count = static_cast<const SID*>(sid)->SubAuthorityCount;
  return count <= SID_MAX_SUB_AUTHORITIES &&
    Inside(buffer.bytes.data(), size, sid, GetSidLengthRequired(count)) && SidString(sid, output);
}
bool ReadString(const Buffer& buffer, LPCWSTR pointer, std::wstring* output) {
  output->clear();
  if (!pointer) return true;
  if (reinterpret_cast<std::uintptr_t>(pointer) % alignof(wchar_t) ||
      !Inside(buffer.bytes.data(), buffer.bytes.size(), pointer, sizeof(wchar_t))) return false;
  const auto offset = reinterpret_cast<const BYTE*>(pointer) - buffer.bytes.data();
  const auto capacity = (buffer.bytes.size() - static_cast<std::size_t>(offset)) / sizeof(wchar_t);
  const auto length = wcsnlen_s(pointer, capacity);
  if (length == capacity || length > kMaximumPath) return false;
  output->assign(pointer, length);
  return true;
}
bool ReadList(const Buffer& buffer, LPCWSTR pointer, std::vector<std::wstring>* output) {
  output->clear();
  if (!pointer) return true;
  for (;;) {
    std::wstring value;
    if (!ReadString(buffer, pointer, &value)) return false;
    if (value.empty()) return true;
    if (output->size() == 16) return false;
    pointer += value.size() + 1;
    output->push_back(std::move(value));
  }
}
bool TokenInformation(HANDLE token, TOKEN_INFORMATION_CLASS kind, Buffer* buffer, DWORD minimum, DWORD* size) noexcept {
  buffer->bytes.fill(0);
  *size = 0;
  return GetTokenInformation(token, kind, buffer->bytes.data(), static_cast<DWORD>(buffer->bytes.size()), size) &&
    *size >= minimum && *size <= buffer->bytes.size();
}
bool NoThreadToken() noexcept {
  TokenHandle thread;
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread.value)) return false;
  return GetLastError() == ERROR_NO_TOKEN;
}
bool CollectToken(HANDLE process, TokenIdentity* result) {
  result->no_thread_token = NoThreadToken();
  TokenHandle token;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token.value)) return false;
  Buffer buffer;
  DWORD size = 0;
  if (!TokenInformation(token.value, TokenUser, &buffer, sizeof(TOKEN_USER), &size) ||
      !BoundedSid(buffer, size, reinterpret_cast<TOKEN_USER*>(buffer.bytes.data())->User.Sid, &result->user_sid))
    return false;
  if (!TokenInformation(token.value, TokenGroups, &buffer, sizeof(TOKEN_GROUPS), &size)) return false;
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.bytes.data());
  if (groups->GroupCount > 128 || size < offsetof(TOKEN_GROUPS, Groups) + groups->GroupCount * sizeof(SID_AND_ATTRIBUTES))
    return false;
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    GroupIdentity group;
    if (!BoundedSid(buffer, size, groups->Groups[index].Sid, &group.sid)) return false;
    group.attributes = groups->Groups[index].Attributes;
    result->groups.push_back(std::move(group));
  }
  if (!TokenInformation(token.value, TokenPrivileges, &buffer, offsetof(TOKEN_PRIVILEGES, Privileges), &size)) return false;
  const auto* privileges = reinterpret_cast<const TOKEN_PRIVILEGES*>(buffer.bytes.data());
  if (privileges->PrivilegeCount > 8 ||
      size < offsetof(TOKEN_PRIVILEGES, Privileges) + privileges->PrivilegeCount * sizeof(LUID_AND_ATTRIBUTES)) return false;
  result->privileges.assign(privileges->Privileges, privileges->Privileges + privileges->PrivilegeCount);
  if (!LookupPrivilegeValueW(nullptr, SE_CHANGE_NOTIFY_NAME, &result->change_notify) ||
      !TokenInformation(token.value, TokenStatistics, &buffer, sizeof(TOKEN_STATISTICS), &size)) return false;
  const auto* statistics = reinterpret_cast<const TOKEN_STATISTICS*>(buffer.bytes.data());
  result->authentication_id = statistics->AuthenticationId;
  result->type = statistics->TokenType;
  if (!TokenInformation(token.value, TokenSessionId, &buffer, sizeof(DWORD), &size)) return false;
  result->session = *reinterpret_cast<const DWORD*>(buffer.bytes.data());
  if (!TokenInformation(token.value, TokenIsAppContainer, &buffer, sizeof(DWORD), &size)) return false;
  result->appcontainer = *reinterpret_cast<const DWORD*>(buffer.bytes.data()) != 0;
  if (!TokenInformation(token.value, TokenRestrictedSids, &buffer, offsetof(TOKEN_GROUPS, Groups), &size)) return false;
  result->restricted = IsTokenRestricted(token.value) || reinterpret_cast<const TOKEN_GROUPS*>(buffer.bytes.data())->GroupCount != 0;
  LogonData logon;
  if (LsaGetLogonSessionData(&result->authentication_id, &logon.value) != 0 || !logon.value ||
      logon.value->Size < offsetof(SECURITY_LOGON_SESSION_DATA, Sid) + sizeof(PSID) ||
      !SidString(logon.value->Sid, &result->logon_user_sid)) return false;
  result->logon_id = logon.value->LogonId;
  result->logon_type = logon.value->LogonType;
  result->logon_session = logon.value->Session;
  // A changed/uncertain ambient token never earns the no-impersonation projection.
  result->no_thread_token = result->no_thread_token && NoThreadToken();
  return true;
}
bool Configuration2(SC_HANDLE service, DWORD level, Buffer* buffer) noexcept {
  buffer->bytes.fill(0);
  DWORD needed = 0;
  return QueryServiceConfig2W(service, level, buffer->bytes.data(), static_cast<DWORD>(buffer->bytes.size()), &needed) != FALSE;
}
bool CollectConfiguration(SC_HANDLE service, ServiceConfiguration* result) {
  Buffer buffer;
  DWORD needed = 0;
  if (!QueryServiceConfigW(service, reinterpret_cast<QUERY_SERVICE_CONFIGW*>(buffer.bytes.data()),
      static_cast<DWORD>(buffer.bytes.size()), &needed)) return false;
  const auto* config = reinterpret_cast<const QUERY_SERVICE_CONFIGW*>(buffer.bytes.data());
  result->type = config->dwServiceType;
  result->start = config->dwStartType;
  result->error_control = config->dwErrorControl;
  std::wstring load_group;
  std::vector<std::wstring> dependencies;
  if (!ReadString(buffer, config->lpBinaryPathName, &result->binary) ||
      !ReadString(buffer, config->lpServiceStartName, &result->account) ||
      !ReadString(buffer, config->lpLoadOrderGroup, &load_group) ||
      !ReadList(buffer, config->lpDependencies, &dependencies)) return false;
  result->no_load_group = load_group.empty() && config->dwTagId == 0;
  result->no_dependencies = dependencies.empty();
  if (!Configuration2(service, SERVICE_CONFIG_SERVICE_SID_INFO, &buffer)) return false;
  result->sid_type = reinterpret_cast<const SERVICE_SID_INFO*>(buffer.bytes.data())->dwServiceSidType;
  if (!Configuration2(service, SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO, &buffer) ||
      !ReadList(buffer, reinterpret_cast<const SERVICE_REQUIRED_PRIVILEGES_INFOW*>(buffer.bytes.data())->pmszRequiredPrivileges,
        &result->required_privileges)) return false;
  if (!Configuration2(service, SERVICE_CONFIG_TRIGGER_INFO, &buffer)) return false;
  const auto* triggers = reinterpret_cast<const SERVICE_TRIGGER_INFO*>(buffer.bytes.data());
  result->no_triggers = triggers->cTriggers == 0 && triggers->pReserved == nullptr;
  if (!Configuration2(service, SERVICE_CONFIG_FAILURE_ACTIONS, &buffer)) return false;
  const auto* failures = reinterpret_cast<const SERVICE_FAILURE_ACTIONSW*>(buffer.bytes.data());
  std::wstring command, reboot;
  if (!ReadString(buffer, failures->lpCommand, &command) || !ReadString(buffer, failures->lpRebootMsg, &reboot)) return false;
  result->no_failure_actions = failures->cActions == 0 && command.empty() && reboot.empty();
  if (!Configuration2(service, SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, &buffer)) return false;
  result->no_non_crash_actions =
    reinterpret_cast<const SERVICE_FAILURE_ACTIONS_FLAG*>(buffer.bytes.data())->fFailureActionsOnNonCrashFailures == FALSE;
  if (!Configuration2(service, SERVICE_CONFIG_DELAYED_AUTO_START_INFO, &buffer)) return false;
  result->no_delayed_start = reinterpret_cast<const SERVICE_DELAYED_AUTO_START_INFO*>(buffer.bytes.data())->fDelayedAutostart == FALSE;
  SERVICE_STATUS_PROCESS status{};
  if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, reinterpret_cast<BYTE*>(&status), sizeof(status), &needed)) return false;
  result->status_type = status.dwServiceType;
  result->status_state = status.dwCurrentState;
  result->status_flags = status.dwServiceFlags;
  // SCM does not promise a valid PID while START_PENDING. Never authorize by that field.
  return true;
}
bool ProjectObject(Buffer& buffer, ServiceObjectSecurity* result) {
  auto* descriptor = reinterpret_cast<PSECURITY_DESCRIPTOR>(buffer.bytes.data());
  if (!IsValidSecurityDescriptor(descriptor)) return false;
  const auto size = GetSecurityDescriptorLength(descriptor);
  if (!size || size > buffer.bytes.size()) return false;
  DWORD revision = 0;
  PSID owner = nullptr;
  BOOL owner_defaulted = TRUE, present = FALSE, defaulted = TRUE;
  PACL dacl = nullptr;
  if (!GetSecurityDescriptorControl(descriptor, &result->control, &revision) ||
      !GetSecurityDescriptorOwner(descriptor, &owner, &owner_defaulted) ||
      !BoundedSid(buffer, size, owner, &result->owner) ||
      !GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted)) return false;
  result->owner_defaulted = owner_defaulted != FALSE;
  result->dacl_present = present && dacl;
  result->dacl_defaulted = defaulted != FALSE;
  if (!result->dacl_present || !Inside(buffer.bytes.data(), size, dacl, sizeof(ACL)) ||
      !Inside(buffer.bytes.data(), size, dacl, dacl->AclSize) || !IsValidAcl(dacl) || dacl->AceCount > 8) return false;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* pointer = nullptr;
    if (!GetAce(dacl, index, &pointer) || !Inside(dacl, dacl->AclSize, pointer, sizeof(ACCESS_ALLOWED_ACE))) return false;
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(pointer);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
        !Inside(dacl, dacl->AclSize, pointer, ace->Header.AceSize)) return false;
    ServiceAce projected{ace->Header.AceType, ace->Header.AceFlags, ace->Mask, {}};
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    if (!BoundedSid(buffer, size, sid, &projected.sid) ||
        !Inside(pointer, ace->Header.AceSize, sid, GetLengthSid(sid))) return false;
    result->aces.push_back(std::move(projected));
  }
  return true;
}
bool CollectObject(SC_HANDLE service, ServiceObjectSecurity* result) {
  Buffer buffer;
  DWORD needed = 0;
  return QueryServiceObjectSecurity(service, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    reinterpret_cast<PSECURITY_DESCRIPTOR>(buffer.bytes.data()), static_cast<DWORD>(buffer.bytes.size()), &needed) &&
    ProjectObject(buffer, result);
}
bool CollectFileObject(HANDLE file, ServiceObjectSecurity* result) {
  Buffer buffer;
  DWORD needed = 0;
  return GetKernelObjectSecurity(file, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    reinterpret_cast<PSECURITY_DESCRIPTOR>(buffer.bytes.data()), static_cast<DWORD>(buffer.bytes.size()), &needed) &&
    ProjectObject(buffer, result);
}
}  // namespace

bool ValidateWorkerToken(const TokenIdentity& token) noexcept {
  if (token.user_sid != kWorkerSid || token.logon_user_sid != kWorkerSid || token.type != TokenPrimary ||
      token.session != 0 || token.logon_session != 0 || token.logon_type != Service ||
      !SameLuid(token.authentication_id, token.logon_id) ||
      (!token.authentication_id.LowPart && !token.authentication_id.HighPart) ||
      !token.no_thread_token || token.restricted || token.appcontainer ||
      token.groups.empty() || token.groups.size() > 128 || token.privileges.size() != 1) return false;
  unsigned service_groups = 0;
  for (const auto& group : token.groups) {
    // A filtered administrator remains the wrong principal, including deny-only membership.
    if (group.sid == kAdministratorsSid || group.sid == kSystemSid) return false;
    const bool enabled = (group.attributes & SE_GROUP_ENABLED) && !(group.attributes & SE_GROUP_USE_FOR_DENY_ONLY);
    if (group.sid == L"S-1-5-6") { if (!enabled) return false; ++service_groups; }
    if (enabled && (group.sid == L"S-1-5-2" || group.sid == L"S-1-5-3" || group.sid == L"S-1-5-4" ||
        group.sid == L"S-1-5-14")) return false;
  }
  const auto& privilege = token.privileges.front();
  constexpr DWORD allowed = SE_PRIVILEGE_ENABLED | SE_PRIVILEGE_ENABLED_BY_DEFAULT | SE_PRIVILEGE_USED_FOR_ACCESS;
  return service_groups == 1 && SameLuid(privilege.Luid, token.change_notify) &&
    (privilege.Attributes & SE_PRIVILEGE_ENABLED) && !(privilege.Attributes & ~allowed);
}
bool ValidateServiceConfiguration(const ServiceConfiguration& config, const std::wstring& quoted_image) noexcept {
  return quoted_image.size() > 2 && quoted_image.front() == L'"' && quoted_image.back() == L'"' &&
    SameWindowsName(config.binary, quoted_image) && SameWindowsName(config.account, kWorkerAccount) &&
    config.type == SERVICE_WIN32_OWN_PROCESS && config.start == SERVICE_DEMAND_START &&
    config.error_control == SERVICE_ERROR_NORMAL && config.sid_type == SERVICE_SID_TYPE_UNRESTRICTED &&
    config.status_type == SERVICE_WIN32_OWN_PROCESS && config.status_state == SERVICE_START_PENDING && !config.status_flags &&
    config.no_load_group && config.no_dependencies && config.no_triggers && config.no_failure_actions &&
    config.no_non_crash_actions && config.no_delayed_start &&
    config.required_privileges.size() == 1 && config.required_privileges.front() == SE_CHANGE_NOTIFY_NAME;
}
bool ValidateServiceObject(const ServiceObjectSecurity& security) noexcept {
  if (security.owner != kSystemSid || security.owner_defaulted || !security.dacl_present || security.dacl_defaulted ||
      !(security.control & SE_DACL_PROTECTED) ||
      (security.control & (SE_DACL_AUTO_INHERIT_REQ | SE_DACL_AUTO_INHERITED)) || security.aces.size() != 3) return false;
  unsigned system = 0, administrators = 0, worker = 0;
  for (const auto& ace : security.aces) {
    if (ace.type != ACCESS_ALLOWED_ACE_TYPE || ace.flags) return false;
    if (ace.sid == kSystemSid && ace.mask == SERVICE_ALL_ACCESS) ++system;
    else if (ace.sid == kAdministratorsSid && ace.mask == SERVICE_ALL_ACCESS) ++administrators;
    else if (ace.sid == kWorkerSid && ace.mask == kWorkerServiceRead) ++worker;
    else return false;
  }
  return system == 1 && administrators == 1 && worker == 1;
}
bool CollectWorkerToken(TokenIdentity* token) noexcept {
  return CollectWorkerProcessToken(GetCurrentProcess(), token);
}
bool CollectWorkerProcessToken(HANDLE process, TokenIdentity* token) noexcept {
  if (!token) return false;
  *token = {};
  if (!process) return false;
  try {
    TokenIdentity collected;
    if (!CollectToken(process, &collected)) return false;
    *token = std::move(collected);
    return true;
  } catch (...) { return false; }
}
bool ValidateWorkerFileSecurity(const ServiceObjectSecurity& security, bool writable_state) noexcept {
  if (security.owner != kSystemSid || security.owner_defaulted || !security.dacl_present || security.dacl_defaulted ||
      !(security.control & SE_DACL_PROTECTED) || (security.control & SE_DACL_AUTO_INHERIT_REQ) || security.aces.size() != 3)
    return false;
  unsigned system = 0, administrators = 0, worker = 0;
  const BYTE flags = writable_state ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
  for (const auto& ace : security.aces) {
    if (ace.type != ACCESS_ALLOWED_ACE_TYPE || ace.flags != flags) return false;
    if (ace.sid == kSystemSid && ace.mask == FILE_ALL_ACCESS) ++system;
    else if (ace.sid == kAdministratorsSid && ace.mask == FILE_ALL_ACCESS) ++administrators;
    else if (ace.sid == kWorkerSid && ace.mask == (writable_state ? 0x001301bfUL : 0x001200a9UL)) ++worker;
    else return false;
  }
  // Windows may retain the AI bookkeeping bit even when all ACEs are explicit and protected.
  return system == 1 && administrators == 1 && worker == 1;
}
bool VerifyWorkerFileHandle(HANDLE file, bool writable_state) noexcept {
  try {
    ServiceObjectSecurity security;
    return CollectFileObject(file, &security) && ValidateWorkerFileSecurity(security, writable_state);
  } catch (...) { return false; }
}
bool VerifyWorkerAncestorHandle(HANDLE directory, bool shared_root) noexcept {
  try {
    ServiceObjectSecurity security;
    constexpr wchar_t trusted_installer[] = L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    if (!CollectFileObject(directory, &security) || !security.dacl_present || security.dacl_defaulted ||
        (security.owner != kSystemSid && security.owner != trusted_installer)) return false;
    const DWORD forbidden = 0x500c0040UL | (shared_root ? 0x00010116UL : 0);
    for (const auto& ace : security.aces) {
      if (ace.flags & INHERIT_ONLY_ACE) continue;
      if (ace.sid != kSystemSid && ace.sid != kAdministratorsSid && ace.sid != trusted_installer && (ace.mask & forbidden))
        return false;
    }
    return true;
  } catch (...) { return false; }
}
bool CollectServiceConfiguration(SC_HANDLE service, ServiceConfiguration* config) noexcept {
  if (!service || !config) return false;
  try {
    ServiceConfiguration collected;
    if (!CollectConfiguration(service, &collected)) return false;
    *config = std::move(collected);
    return true;
  } catch (...) { return false; }
}
bool CollectServiceObjectSecurity(SC_HANDLE service, ServiceObjectSecurity* security) noexcept {
  if (!service || !security) return false;
  try {
    ServiceObjectSecurity collected;
    if (!CollectObject(service, &collected)) return false;
    *security = std::move(collected);
    return true;
  } catch (...) { return false; }
}
DWORD VerifyWorkerServiceIdentity(DWORD argument_count, wchar_t** arguments) noexcept {
  if (argument_count != 1 || !arguments || !arguments[0] || wcscmp(arguments[0], kServiceName) != 0)
    return ERROR_BAD_ARGUMENTS;
  try {
    TokenIdentity token;
    if (!CollectWorkerToken(&token) || !ValidateWorkerToken(token)) return ERROR_ACCESS_DENIED;
    const ServiceHandle manager{OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT)};
    if (!manager.value) return ERROR_ACCESS_DENIED;
    const ServiceHandle service{OpenServiceW(manager.value, kServiceName, kWorkerServiceRead)};
    if (!service.value) return ERROR_ACCESS_DENIED;
    std::array<wchar_t, kMaximumPath> image{};
    const DWORD length = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()));
    if (!length || length >= image.size()) return ERROR_ACCESS_DENIED;
    const std::wstring quoted = L"\"" + std::wstring(image.data(), length) + L"\"";
    ServiceConfiguration config;
    ServiceObjectSecurity security;
    if (!CollectServiceConfiguration(service.value, &config) || !ValidateServiceConfiguration(config, quoted) ||
        !CollectServiceObjectSecurity(service.value, &security) || !ValidateServiceObject(security) || !NoThreadToken())
      return ERROR_ACCESS_DENIED;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
}  // namespace goatcitadel::worker_host
