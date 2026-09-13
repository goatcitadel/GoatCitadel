#include "service_identity.hpp"
#include "worker_host.hpp"
#include <ntsecapi.h>
#include <cstdio>
#include <cstdlib>

using namespace goatcitadel::worker_host;
namespace {
unsigned checks = 0;
void Check(bool valid, const char* name) {
  ++checks;
  if (!valid) { std::fprintf(stderr, "Identity check failed: %s\n", name); std::exit(1); }
}
TokenIdentity WorkerToken() {
  TokenIdentity token;
  token.user_sid = token.logon_user_sid = kWorkerSid;
  token.type = TokenPrimary;
  token.session = token.logon_session = 0;
  token.logon_type = Service;
  token.authentication_id = token.logon_id = {123, 4};
  token.change_notify = {23, 0};
  token.no_thread_token = true;
  token.restricted = token.appcontainer = false;
  token.groups = {{L"S-1-5-6", SE_GROUP_ENABLED | SE_GROUP_ENABLED_BY_DEFAULT},
    {L"S-1-1-0", SE_GROUP_ENABLED}, {kWorkerSid, SE_GROUP_ENABLED | SE_GROUP_OWNER}};
  token.privileges = {{token.change_notify, SE_PRIVILEGE_ENABLED | SE_PRIVILEGE_ENABLED_BY_DEFAULT}};
  return token;
}
ServiceConfiguration WorkerConfig() {
  ServiceConfiguration config;
  config.binary = L"\"C:\\Program Files\\GoatCitadel Worker\\bin\\GoatCitadelRemoteWorkerHost.exe\"";
  config.account = kWorkerAccount;
  config.type = config.status_type = SERVICE_WIN32_OWN_PROCESS;
  config.start = SERVICE_DEMAND_START;
  config.error_control = SERVICE_ERROR_NORMAL;
  config.sid_type = SERVICE_SID_TYPE_UNRESTRICTED;
  config.status_state = SERVICE_START_PENDING;
  config.no_load_group = config.no_dependencies = config.no_triggers = true;
  config.no_failure_actions = config.no_non_crash_actions = config.no_delayed_start = true;
  config.required_privileges = {SE_CHANGE_NOTIFY_NAME};
  return config;
}
ServiceObjectSecurity WorkerSecurity() {
  ServiceObjectSecurity security;
  security.owner = L"S-1-5-18";
  security.owner_defaulted = security.dacl_defaulted = false;
  security.dacl_present = true;
  security.control = SE_SELF_RELATIVE | SE_DACL_PRESENT | SE_DACL_PROTECTED;
  security.aces = {{ACCESS_ALLOWED_ACE_TYPE, 0, SERVICE_ALL_ACCESS, L"S-1-5-18"},
    {ACCESS_ALLOWED_ACE_TYPE, 0, SERVICE_ALL_ACCESS, L"S-1-5-32-544"},
    {ACCESS_ALLOWED_ACE_TYPE, 0, kWorkerServiceRead, kWorkerSid}};
  return security;
}
}
int main() {
  Check(ValidateWorkerToken(WorkerToken()), "dedicated service token");
  const auto reject_token = [](auto mutate, const char* name) {
    auto token = WorkerToken(); mutate(token); Check(!ValidateWorkerToken(token), name);
  };
  reject_token([](auto& t) { t.user_sid = L"S-1-5-18"; }, "SYSTEM worker");
  reject_token([](auto& t) { t.user_sid = L"S-1-5-19"; }, "shared service account");
  reject_token([](auto& t) { t.type = TokenImpersonation; }, "impersonation process token");
  reject_token([](auto& t) { t.session = 1; }, "interactive session");
  reject_token([](auto& t) { t.logon_type = Interactive; }, "interactive logon");
  reject_token([](auto& t) { t.logon_type = Network; }, "network logon");
  reject_token([](auto& t) { t.logon_session = 1; }, "different LSA session");
  reject_token([](auto& t) { ++t.logon_id.LowPart; }, "different authentication ID");
  reject_token([](auto& t) { t.logon_user_sid = L"S-1-5-18"; }, "different LSA user");
  reject_token([](auto& t) { t.no_thread_token = false; }, "ambient thread impersonation");
  reject_token([](auto& t) { t.restricted = true; }, "restricted substitute token");
  reject_token([](auto& t) { t.appcontainer = true; }, "AppContainer substitute token");
  reject_token([](auto& t) { t.groups[0].attributes = SE_GROUP_USE_FOR_DENY_ONLY; }, "disabled service logon");
  reject_token([](auto& t) { t.groups.push_back(t.groups[0]); }, "duplicate service group");
  reject_token([](auto& t) { t.groups.push_back({L"S-1-5-32-544", SE_GROUP_USE_FOR_DENY_ONLY}); }, "filtered admin token");
  for (const auto* sid : {L"S-1-5-32-544", L"S-1-5-18", L"S-1-5-2", L"S-1-5-3", L"S-1-5-4", L"S-1-5-14"})
    reject_token([sid](auto& t) { t.groups.push_back({sid, SE_GROUP_ENABLED}); }, "prohibited token group");
  reject_token([](auto& t) { t.privileges.clear(); }, "missing traverse privilege");
  reject_token([](auto& t) { t.privileges.push_back({{20, 0}, 0}); }, "extra disabled privilege");
  reject_token([](auto& t) { t.privileges[0].Attributes = 0; }, "disabled traverse privilege");
  reject_token([](auto& t) { ++t.privileges[0].Luid.LowPart; }, "different privilege LUID");
  reject_token([](auto& t) { t.groups.resize(129); }, "oversized token projection");

  const auto expected_image = WorkerConfig().binary;
  Check(ValidateServiceConfiguration(WorkerConfig(), expected_image), "exact SCM configuration");
  const auto reject_config = [&](auto mutate, const char* name) {
    auto config = WorkerConfig(); mutate(config); Check(!ValidateServiceConfiguration(config, expected_image), name);
  };
  reject_config([](auto& c) { c.account = L"LocalSystem"; }, "SCM SYSTEM configuration");
  reject_config([](auto& c) { c.binary += L" --foreground"; }, "SCM extra arguments");
  reject_config([](auto& c) { c.binary = c.binary.substr(1, c.binary.size() - 2); }, "unquoted SCM path");
  reject_config([](auto& c) { c.type = SERVICE_WIN32_SHARE_PROCESS; }, "shared process");
  reject_config([](auto& c) { c.start = SERVICE_AUTO_START; }, "unreviewed automatic start");
  reject_config([](auto& c) { c.error_control = SERVICE_ERROR_IGNORE; }, "hidden startup failure");
  reject_config([](auto& c) { c.sid_type = SERVICE_SID_TYPE_RESTRICTED; }, "different service SID mode");
  reject_config([](auto& c) { c.status_type |= SERVICE_INTERACTIVE_PROCESS; }, "interactive SCM type");
  reject_config([](auto& c) { c.status_state = SERVICE_RUNNING; }, "unexpected startup phase");
  reject_config([](auto& c) { c.status_flags = SERVICE_RUNS_IN_SYSTEM_PROCESS; }, "system process status");
  reject_config([](auto& c) { c.required_privileges.push_back(SE_IMPERSONATE_NAME); }, "additional SCM privilege");
  for (auto member : {&ServiceConfiguration::no_load_group, &ServiceConfiguration::no_dependencies,
      &ServiceConfiguration::no_triggers, &ServiceConfiguration::no_failure_actions,
      &ServiceConfiguration::no_non_crash_actions, &ServiceConfiguration::no_delayed_start})
    reject_config([member](auto& c) { c.*member = false; }, "unexpected SCM startup behavior");

  Check(ValidateServiceObject(WorkerSecurity()), "worker has query-only SCM access");
  const auto reject_security = [](auto mutate, const char* name) {
    auto security = WorkerSecurity(); mutate(security); Check(!ValidateServiceObject(security), name);
  };
  reject_security([](auto& s) { s.owner = kWorkerSid; }, "worker owns SCM object");
  reject_security([](auto& s) { s.owner_defaulted = true; }, "defaulted owner");
  reject_security([](auto& s) { s.dacl_present = false; }, "null DACL");
  reject_security([](auto& s) { s.dacl_defaulted = true; }, "defaulted DACL");
  reject_security([](auto& s) { s.control &= ~SE_DACL_PROTECTED; }, "unprotected DACL");
  reject_security([](auto& s) { s.control |= SE_DACL_AUTO_INHERITED; }, "inherited service rights");
  reject_security([](auto& s) { s.aces[2].mask |= SERVICE_CHANGE_CONFIG; }, "worker can change service configuration");
  reject_security([](auto& s) { s.aces[2].mask |= SERVICE_START; }, "worker can start itself");
  reject_security([](auto& s) { s.aces[2].sid = L"S-1-1-0"; }, "public SCM grant");
  reject_security([](auto& s) { s.aces[2].flags = INHERITED_ACE; }, "inherited ACE");
  reject_security([](auto& s) { s.aces[2].type = ACCESS_DENIED_ACE_TYPE; }, "different ACE type");
  reject_security([](auto& s) { s.aces.push_back(s.aces[0]); }, "extra SCM ACE");

  TokenIdentity current;
  Check(CollectWorkerToken(&current), "capture actual current OS token");
  Check(!current.user_sid.empty() && !current.groups.empty(), "OS token evidence is populated");
  Check(!ValidateWorkerToken(current), "interactive task process is refused");
  wchar_t* arguments[] = {const_cast<wchar_t*>(kServiceName)};
  Check(VerifyWorkerServiceIdentity(1, arguments) == ERROR_ACCESS_DENIED, "live caller rejected before SCM launch");
  Check(VerifyWorkerServiceIdentity(0, arguments) == ERROR_BAD_ARGUMENTS, "missing SCM argument");
  Check(VerifyWorkerServiceIdentity(1, nullptr) == ERROR_BAD_ARGUMENTS, "missing SCM argument vector");
  Check(ImpersonateSelf(SecurityIdentification) != FALSE, "create task-owned identification token");
  Check(VerifyWorkerServiceIdentity(1, arguments) == ERROR_ACCESS_DENIED, "ambient impersonation is refused");
  Check(RevertToSelf() != FALSE, "revert task-owned identification token");
  TokenIdentity reverted;
  Check(CollectWorkerToken(&reverted) && reverted.no_thread_token, "no residual impersonation after test");
  // Exercise the OS configuration/security collectors without creating or controlling a service.
  SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  Check(manager != nullptr, "open local SCM for read-only evidence");
  SC_HANDLE event_log = OpenServiceW(manager, L"EventLog", kWorkerServiceRead);
  Check(event_log != nullptr, "open Windows EventLog for queries only");
  ServiceConfiguration actual_config;
  ServiceObjectSecurity actual_security;
  const bool config_read = CollectServiceConfiguration(event_log, &actual_config);
  const DWORD config_error = GetLastError();
  const bool security_read = CollectServiceObjectSecurity(event_log, &actual_security);
  if (!config_read) std::fprintf(stderr, "SCM collector Win32 error: %lu\n", config_error);
  CloseServiceHandle(event_log);
  CloseServiceHandle(manager);
  Check(config_read && !actual_config.binary.empty(), "collect actual SCM configuration");
  Check(security_read && !actual_security.owner.empty() && !actual_security.aces.empty(), "collect actual SCM security");
  Check(!ValidateServiceConfiguration(actual_config, expected_image), "unrelated installed service refused");
  Check(!ValidateServiceObject(actual_security), "unrelated service permissions refused");
  std::printf("{\"checks\":%u,\"passed\":true,\"installedService\":false}\n", checks);
}
