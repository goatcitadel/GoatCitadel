#pragma once
#include <windows.h>
#include <string>
#include <vector>

namespace goatcitadel::worker_host {
constexpr wchar_t kWorkerAccount[] = L"NT SERVICE\\GoatCitadelRemoteWorker";
constexpr wchar_t kWorkerSid[] = L"S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905";
constexpr DWORD kWorkerServiceRead = READ_CONTROL | SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS;

struct GroupIdentity final { std::wstring sid; DWORD attributes = 0; };
struct TokenIdentity final {
  std::wstring user_sid, logon_user_sid;
  TOKEN_TYPE type = TokenImpersonation;
  DWORD session = MAXDWORD, logon_session = MAXDWORD, logon_type = 0;
  LUID authentication_id{}, logon_id{}, change_notify{};
  bool no_thread_token = false, restricted = true, appcontainer = true;
  std::vector<GroupIdentity> groups;
  std::vector<LUID_AND_ATTRIBUTES> privileges;
};
struct ServiceConfiguration final {
  std::wstring binary, account;
  DWORD type = 0, start = 0, error_control = 0, sid_type = 0;
  DWORD status_type = 0, status_state = 0, status_flags = 0;
  bool no_load_group = false, no_dependencies = false, no_triggers = false;
  bool no_failure_actions = false, no_non_crash_actions = false, no_delayed_start = false;
  std::vector<std::wstring> required_privileges;
};
struct ServiceAce final {
  BYTE type = 0, flags = 0;
  DWORD mask = 0;
  std::wstring sid;
};
struct ServiceObjectSecurity final {
  std::wstring owner;
  bool owner_defaulted = true, dacl_present = false, dacl_defaulted = true;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  std::vector<ServiceAce> aces;
};

// These projections come only from the local OS, never package/config JSON.
bool ValidateWorkerToken(const TokenIdentity& token) noexcept;
bool ValidateServiceConfiguration(const ServiceConfiguration& config, const std::wstring& quoted_image) noexcept;
bool ValidateServiceObject(const ServiceObjectSecurity& security) noexcept;
bool CollectWorkerToken(TokenIdentity* token) noexcept;
// Read an OS process held by the caller; this does not authorize it or acquire
// impersonation/control rights. ValidateWorkerToken remains authoritative.
bool CollectWorkerProcessToken(HANDLE process, TokenIdentity* token) noexcept;
bool CollectServiceConfiguration(SC_HANDLE service, ServiceConfiguration* config) noexcept;
bool CollectServiceObjectSecurity(SC_HANDLE service, ServiceObjectSecurity* security) noexcept;
bool ValidateWorkerFileSecurity(const ServiceObjectSecurity& security, bool writable_state) noexcept;
bool VerifyWorkerFileHandle(HANDLE file, bool writable_state = false) noexcept;
bool VerifyWorkerAncestorHandle(HANDLE directory, bool shared_root) noexcept;
DWORD VerifyWorkerServiceIdentity(DWORD argument_count, wchar_t** arguments) noexcept;
}  // namespace goatcitadel::worker_host
