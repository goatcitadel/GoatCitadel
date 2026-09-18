#include "cell_controller_identity.hpp"
#include "cell_workspace.hpp"
#include "cell_capacity.hpp"
#include <sddl.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>

using namespace goatcitadel::worker_cell;
using namespace goatcitadel::worker_host;
namespace {
unsigned checks = 0;
void Check(bool success, const char* name) {
  ++checks;
  if (!success) { std::fprintf(stderr, "Controller identity check failed: %s\n", name); std::exit(1); }
}
CellControllerToken ControllerToken() {
  CellControllerToken token;
  token.user = L"S-1-5-18"; token.integrity = L"S-1-16-16384";
  token.type = TokenPrimary; token.session = 0;
  token.token_id = {100, 1}; token.authentication_id = {0x3e7, 0};
  token.no_thread_token = true; token.restricted = token.appcontainer = false;
  token.change_notify = {23, 0}; token.manage_volume = {28, 0};
  token.groups = {{kCellControllerServiceSid, SE_GROUP_ENABLED | SE_GROUP_OWNER},
    {L"S-1-5-6", SE_GROUP_ENABLED}, {L"S-1-5-80-0", SE_GROUP_ENABLED},
    {L"S-1-5-32-544", SE_GROUP_ENABLED}, {L"S-1-1-0", SE_GROUP_ENABLED}};
  token.privileges = {{token.change_notify, SE_PRIVILEGE_ENABLED | SE_PRIVILEGE_ENABLED_BY_DEFAULT},
    {token.manage_volume, 0}};
  return token;
}
ServiceConfiguration ControllerConfig() {
  ServiceConfiguration config;
  config.binary = L"\"C:\\ProgramData\\GoatCitadel\\RemoteWorker\\payload\\app\\worker\\native\\GoatCitadelRemoteWorkerCellController.exe\"";
  config.account = L"LocalSystem";
  config.type = config.status_type = SERVICE_WIN32_OWN_PROCESS;
  config.start = SERVICE_DEMAND_START; config.error_control = SERVICE_ERROR_NORMAL;
  config.sid_type = SERVICE_SID_TYPE_UNRESTRICTED; config.status_state = SERVICE_START_PENDING;
  config.no_load_group = config.no_dependencies = config.no_triggers = true;
  config.no_failure_actions = config.no_non_crash_actions = config.no_delayed_start = true;
  config.required_privileges = {SE_CHANGE_NOTIFY_NAME, SE_MANAGE_VOLUME_NAME};
  return config;
}
void TokenCases() {
  Check(ValidateCellControllerToken(ControllerToken(), false), "dedicated controller before enabling its existing volume privilege");
  Check(!ValidateCellControllerToken(ControllerToken(), true), "disabled volume privilege cannot operate a volume");
  auto enabled = ControllerToken(); enabled.privileges[1].Attributes = SE_PRIVILEGE_ENABLED;
  Check(ValidateCellControllerToken(enabled, true), "dedicated controller with enabled volume privilege");
  auto inherited = enabled; inherited.groups.erase(inherited.groups.begin() + 1, inherited.groups.begin() + 3);
  Check(ValidateCellControllerToken(inherited, true), "SCM SYSTEM context uses its exact service identity without generic logon groups");
  const auto reject = [](auto mutate, const char* name) {
    auto token = ControllerToken(); mutate(token);
    Check(!ValidateCellControllerToken(token, false) && !ValidateCellControllerToken(token, true), name);
  };
  for (const auto* sid : {kWorkerSid, L"S-1-5-19", L"S-1-5-20", L"S-1-5-21-1-2-3-1001"})
    reject([sid](auto& token) { token.user = sid; }, "worker/shared/interactive principal cannot become controller");
  reject([](auto& t) { t.integrity = L"S-1-16-12288"; }, "high-integrity administrator is not SYSTEM");
  reject([](auto& t) { t.type = TokenImpersonation; }, "impersonation token");
  reject([](auto& t) { t.session = 1; }, "interactive session");
  reject([](auto& t) { t.token_id = {}; }, "missing token identity");
  reject([](auto& t) { t.authentication_id = {}; }, "missing logon identity");
  reject([](auto& t) { t.no_thread_token = false; }, "ambient impersonation");
  reject([](auto& t) { t.restricted = true; }, "restricted substitute token");
  reject([](auto& t) { t.appcontainer = true; }, "AppContainer substitute token");
  reject([](auto& t) { t.groups.clear(); }, "missing service identity");
  reject([](auto& t) { t.groups.erase(t.groups.begin()); }, "SYSTEM and generic services are insufficient");
  reject([](auto& t) { t.groups[0].sid = kWorkerSid; }, "worker service SID is not controller authority");
  reject([](auto& t) { t.groups.push_back({kWorkerSid, 0}); }, "other service identity even if disabled");
  reject([](auto& t) { t.groups[0].attributes = 0; }, "disabled controller SID");
  reject([](auto& t) { t.groups[0].attributes |= SE_GROUP_USE_FOR_DENY_ONLY; }, "deny-only controller SID");
  for (std::size_t index : {0U, 1U, 2U})
    reject([index](auto& t) { t.groups.push_back(t.groups[index]); }, "duplicate service group");
  reject([](auto& t) { t.groups[1].attributes = SE_GROUP_USE_FOR_DENY_ONLY; }, "filtered generic service group");
  reject([](auto& t) { t.groups[2].attributes = 0; }, "disabled All Services group");
  for (const auto* sid : {L"S-1-5-2", L"S-1-5-3", L"S-1-5-4", L"S-1-5-14"})
    reject([sid](auto& t) { t.groups.push_back({sid, SE_GROUP_ENABLED}); }, "network/batch/interactive group");
  reject([](auto& t) { t.groups.resize(129); }, "unbounded group projection");
  reject([](auto& t) { t.change_notify = {}; }, "missing traverse LUID");
  reject([](auto& t) { t.manage_volume = {}; }, "missing volume LUID");
  reject([](auto& t) { t.manage_volume = t.change_notify; }, "privilege identity alias");
  reject([](auto& t) { t.privileges.clear(); }, "missing privileges");
  reject([](auto& t) { t.privileges.pop_back(); }, "missing volume privilege");
  reject([](auto& t) { t.privileges.push_back({{20, 0}, 0}); }, "extra disabled privilege");
  reject([](auto& t) { t.privileges[1] = t.privileges[0]; }, "duplicate privilege");
  reject([](auto& t) { t.privileges[1].Luid = {20, 0}; }, "substituted privilege");
  reject([](auto& t) { t.privileges[0].Attributes = 0; }, "disabled traverse privilege");
  reject([](auto& t) { t.privileges[1].Attributes = SE_PRIVILEGE_REMOVED; }, "removed volume privilege");
  reject([](auto& t) { t.privileges[1].Attributes = 0x1000; }, "unknown privilege attributes");

  TokenIdentity worker;
  worker.user_sid = worker.logon_user_sid = kWorkerSid;
  worker.type = TokenPrimary; worker.session = worker.logon_session = 0; worker.logon_type = 5;
  worker.authentication_id = worker.logon_id = {123, 4}; worker.change_notify = {23, 0};
  worker.no_thread_token = true; worker.restricted = worker.appcontainer = false;
  worker.groups = {{L"S-1-5-6", SE_GROUP_ENABLED}, {kWorkerSid, SE_GROUP_ENABLED}};
  worker.privileges = {{worker.change_notify, SE_PRIVILEGE_ENABLED}};
  Check(ValidateWorkerToken(worker), "existing restricted worker still admitted");
  worker.privileges.push_back({{28, 0}, 0});
  Check(!ValidateWorkerToken(worker), "controller work does not give worker volume privileges");
}
void ConfigurationCases() {
  const auto image = ControllerConfig().binary;
  Check(ValidateCellControllerConfiguration(ControllerConfig(), image, SERVICE_START_PENDING), "controller SCM startup projection");
  auto running = ControllerConfig(); running.status_state = SERVICE_RUNNING;
  Check(ValidateCellControllerConfiguration(running, image, SERVICE_RUNNING), "controller SCM running projection");
  Check(!ValidateCellControllerConfiguration(running, image, SERVICE_START_PENDING), "stale SCM state");
  for (DWORD state : {SERVICE_STOPPED, SERVICE_STOP_PENDING, SERVICE_PAUSED, SERVICE_PAUSE_PENDING, SERVICE_CONTINUE_PENDING}) {
    running.status_state = state;
    Check(!ValidateCellControllerConfiguration(running, image, state), "no admission during shutdown or pause");
  }
  Check(!ValidateCellControllerConfiguration(ControllerConfig(), L"", SERVICE_START_PENDING), "no caller image authority");
  Check(!ValidateCellControllerConfiguration(ControllerConfig(), image.substr(1, image.size() - 2), SERVICE_START_PENDING), "unquoted expected image");
  const auto reject = [&](auto mutate, const char* name) {
    auto config = ControllerConfig(); mutate(config);
    Check(!ValidateCellControllerConfiguration(config, image, SERVICE_START_PENDING), name);
  };
  reject([](auto& c) { c.account = kWorkerAccount; }, "worker cannot host controller");
  reject([](auto& c) { c.binary += L" --foreground"; }, "extra service arguments");
  reject([](auto& c) { c.binary = L"\"C:\\unrelated.exe\""; }, "different service image");
  reject([](auto& c) { c.binary = c.binary.substr(1, c.binary.size() - 2); }, "unquoted actual image");
  reject([](auto& c) { c.type = SERVICE_WIN32_SHARE_PROCESS; }, "shared process controller");
  reject([](auto& c) { c.status_type |= SERVICE_INTERACTIVE_PROCESS; }, "interactive service flag");
  reject([](auto& c) { c.status_flags = SERVICE_RUNS_IN_SYSTEM_PROCESS; }, "shared system-process flag");
  reject([](auto& c) { c.start = SERVICE_AUTO_START; }, "unreviewed auto start");
  reject([](auto& c) { c.error_control = SERVICE_ERROR_IGNORE; }, "hidden startup failure");
  reject([](auto& c) { c.sid_type = SERVICE_SID_TYPE_RESTRICTED; }, "different SID mode");
  reject([](auto& c) { c.required_privileges = {SE_CHANGE_NOTIFY_NAME}; }, "missing installed volume right");
  reject([](auto& c) { c.required_privileges[1] = SE_RESTORE_NAME; }, "unrelated installed right");
  reject([](auto& c) { c.required_privileges.push_back(SE_IMPERSONATE_NAME); }, "extra installed right");
  reject([](auto& c) { c.required_privileges[1] = SE_CHANGE_NOTIFY_NAME; }, "duplicate installed right");
  for (auto member : {&ServiceConfiguration::no_load_group, &ServiceConfiguration::no_dependencies,
      &ServiceConfiguration::no_triggers, &ServiceConfiguration::no_failure_actions,
      &ServiceConfiguration::no_non_crash_actions, &ServiceConfiguration::no_delayed_start})
    reject([member](auto& c) { c.*member = false; }, "unexpected SCM lifecycle behavior");
}
std::vector<std::uint8_t> Custody() {
  std::vector<std::uint8_t> bytes(120);
  std::memcpy(bytes.data(), "GCCUST01", 8);
  std::fill(bytes.begin() + 8, bytes.begin() + 40, std::uint8_t{0x11});
  std::fill(bytes.begin() + 40, bytes.begin() + 72, std::uint8_t{0x22});
  for (unsigned index = 0; index < 8; ++index) bytes[72 + index] = bytes[96 + index] = static_cast<std::uint8_t>(index + 1);
  std::fill(bytes.begin() + 80, bytes.begin() + 96, std::uint8_t{0x33});
  std::fill(bytes.begin() + 104, bytes.end(), std::uint8_t{0x44});
  return bytes;
}
void CustodyCases() {
  const auto bytes = Custody(); CellControllerCustodyRecord record;
  Check(DecodeCellControllerCustody(bytes, &record), "decode independently installed custody");
  Check(record.image_sha256[0] == 0x11 && record.provisioning_sha256[31] == 0x22 &&
    record.native_directory.volume_serial == 0x0807060504030201ULL && record.parent.volume_serial == record.native_directory.volume_serial &&
    record.native_directory.file_id[15] == 0x33 && record.parent.file_id[0] == 0x44, "custody wire layout and little endian identity");
  Check(!DecodeCellControllerCustody(bytes, nullptr), "null custody destination");
  const auto reject = [&](auto mutate, const char* name) {
    auto changed = bytes; mutate(changed); CellControllerCustodyRecord output = record;
    Check(!DecodeCellControllerCustody(changed, &output) && output.image_sha256 == CellFileSha256{} &&
      output.provisioning_sha256 == CellFileSha256{} && output.parent == CellFileIdentity{} && output.native_directory == CellFileIdentity{}, name);
  };
  for (std::size_t length = 0; length < 120; ++length)
    reject([length](auto& b) { b.resize(length); }, "truncated record clears authority");
  for (std::size_t index = 0; index < 8; ++index)
    reject([index](auto& b) { b[index] ^= 1; }, "unknown custody protocol");
  reject([](auto& b) { b.push_back(0); }, "trailing custody data");
  reject([](auto& b) { std::fill(b.begin() + 8, b.begin() + 40, std::uint8_t{0}); }, "zero image pin");
  reject([](auto& b) { std::fill(b.begin() + 40, b.begin() + 72, std::uint8_t{0}); }, "zero helper pin");
  reject([](auto& b) { std::copy_n(b.begin() + 8, 32, b.begin() + 40); }, "one image cannot fill both roles");
  reject([](auto& b) { b[96] ^= 1; }, "cross-volume custody");
  reject([](auto& b) { std::fill(b.begin() + 72, b.begin() + 80, std::uint8_t{0}); std::fill(b.begin() + 96, b.begin() + 104, std::uint8_t{0}); }, "zero volume identity");
  reject([](auto& b) { std::fill(b.begin() + 80, b.begin() + 96, std::uint8_t{0}); }, "zero native directory identity");
  reject([](auto& b) { std::fill(b.begin() + 104, b.end(), std::uint8_t{0}); }, "zero parent identity");
  reject([](auto& b) { std::copy_n(b.begin() + 72, 24, b.begin() + 96); }, "parent cannot be executable directory");

  std::vector<std::uint8_t> descriptor;
  Check(BuildCellParentSecurity(L"S-1-5-18", kCellControllerServiceSid, &descriptor) == ERROR_SUCCESS, "build dedicated controller parent descriptor");
  const std::wstring expected = L"O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + std::wstring(kCellControllerServiceSid) +
    L")(A;OICI;RC;;;OW)S:(ML;OICI;NW;;;ME)";
  PSECURITY_DESCRIPTOR security = nullptr; ULONG length = 0;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(expected.c_str(), SDDL_REVISION_1, &security, &length) != FALSE, "independent descriptor encoding");
  const bool equal = descriptor.size() == length && !std::memcmp(descriptor.data(), security, length);
  LocalFree(security);
  Check(equal, "controller uses existing exact parent custody contract");
  Check(BuildCellParentSecurity(kWorkerSid, kCellControllerServiceSid, &descriptor) == ERROR_INVALID_PARAMETER && descriptor.empty(), "worker SID remains invalid parent owner");
  Check(BuildCellParentSecurity(L"S-1-5-18", L"S-1-15-2-1", &descriptor) == ERROR_INVALID_PARAMETER && descriptor.empty(), "AppContainer cannot control parent");
  Check(BuildCellParentSecurity(L"S-1-5-18", kCellControllerServiceSid, nullptr) == ERROR_INVALID_PARAMETER, "null descriptor destination");
}
void CapacityCustodyCases() {
  std::vector<std::uint8_t> bytes(320); std::memcpy(bytes.data(), "GCCAPS01", 8);
  for (std::size_t i = 0; i < 13; ++i) { bytes[8 + 24 * i] = 7; bytes[16 + 24 * i] = static_cast<std::uint8_t>(i + 1); }
  CellControllerCapacityCustodyRecord record;
  Check(DecodeCellControllerCapacityCustody(bytes, &record) && record.roots[12].volume_serial == 7 && record.roots[12].file_id[0] == 13,
    "Capacity custody binds thirteen ordered independent directory identities");
  Check(!DecodeCellControllerCapacityCustody(bytes, nullptr), "Capacity custody needs an output owner");
  const auto reject = [&](auto mutate) {
    auto changed = bytes; mutate(changed); auto result = record;
    Check(!DecodeCellControllerCapacityCustody(changed, &result) && result == CellControllerCapacityCustodyRecord{},
      "Malformed capacity custody clears every returned identity");
  };
  for (std::size_t length = 0; length < bytes.size(); ++length) reject([length](auto& b) { b.resize(length); });
  reject([](auto& b) { b.push_back(0); });
  for (std::size_t i = 0; i < 8; ++i) reject([i](auto& b) { b[i] ^= 1; });
  for (std::size_t i = 0; i < 13; ++i) {
    reject([i](auto& b) { b[8 + i * 24] = 0; });
    reject([i](auto& b) { b[16 + i * 24] = 0; });
    if (i) {
      reject([i](auto& b) { b[8 + i * 24] = 8; });
      reject([i](auto& b) { std::copy_n(b.begin() + 8, 24, b.begin() + 8 + i * 24); });
    }
  }
}
std::vector<std::uint8_t> PrivilegeState(HANDLE token) {
  DWORD size = 0; GetTokenInformation(token, TokenPrivileges, nullptr, 0, &size);
  Check(GetLastError() == ERROR_INSUFFICIENT_BUFFER && size > 0 && size <= 16384, "actual privilege snapshot bound");
  std::vector<std::uint8_t> bytes(size);
  Check(GetTokenInformation(token, TokenPrivileges, bytes.data(), size, &size) != FALSE, "read actual privilege state");
  return bytes;
}
void ActualProcessCases() {
  HANDLE process_token = nullptr;
  Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &process_token) != FALSE, "read task-owned process token");
  const auto before = PrivilegeState(process_token);
  CellControllerToken current;
  Check(CollectCellControllerToken(process_token, &current) && !current.user.empty() && !current.groups.empty(), "collect actual OS facts");
  Check(!ValidateCellControllerToken(current, false), "actual interactive process is refused");
  current = ControllerToken();
  Check(!CollectCellControllerToken(nullptr, &current) && current.user.empty() && current.privileges.empty(), "invalid token clears stale authority");
  Check(!CollectCellControllerToken(process_token, nullptr), "null token destination");
  CellControllerIdentity identity;
  wchar_t* arguments[] = {const_cast<wchar_t*>(kCellControllerServiceName)};
  Check(identity.Open(0, arguments) == ERROR_BAD_ARGUMENTS, "missing service argument");
  Check(identity.Open(1, nullptr) == ERROR_BAD_ARGUMENTS, "missing service arguments");
  wchar_t* wrong[] = {const_cast<wchar_t*>(L"GoatCitadelRemoteWorker")};
  Check(identity.Open(1, wrong) == ERROR_BAD_ARGUMENTS, "worker cannot claim controller by service entrypoint");
  Check(identity.Open(1, arguments) == ERROR_ACCESS_DENIED, "actual process rejected before installed custody");
  Check(identity.ParentPath().empty() && identity.ParentIdentity() == CellFileIdentity{} && identity.ProvisioningProcessPath().empty(), "failed open retains no authority");
  Check(identity.Verify(SERVICE_START_PENDING, false) == ERROR_INVALID_STATE, "unadmitted instance cannot verify");
  Check(identity.EnableVolumeManagement() == ERROR_INVALID_STATE, "unadmitted instance cannot enable privileges");
  Check(identity.VerifyProvisioningProcess(GetCurrentProcess()) == ERROR_INVALID_STATE, "unadmitted instance cannot bless a helper");
  Check(identity.VerifyWorkerHostProcess(GetCurrentProcess()) == ERROR_INVALID_STATE, "unadmitted controller cannot bless a host marker");
  CellCapacityAreaRoots capacity_roots;
  for (auto& root : capacity_roots) { root.handle = process_token; root.identity.volume_serial = 123; }
  Check(identity.ReadCapacityRoots(capacity_roots) == ERROR_INVALID_STATE, "unadmitted controller cannot export capacity roots");
  for (const auto& root : capacity_roots)
    Check(root.handle == INVALID_HANDLE_VALUE && root.identity == CellFileIdentity{}, "refused root export clears stale handles and identities");
  const auto root_policy = identity.CapacityRootSecurity();
  CellFileIdentity claimed_root; claimed_root.volume_serial = 1; claimed_root.file_id.fill(1);
  Check(root_policy.context == &identity && root_policy.verify != nullptr, "Installed capacity policy retains its exact controller owner");
  for (unsigned area = 0; area < kCellCapacityAreaCount; ++area)
    Check(root_policy.verify(root_policy.context, static_cast<CellCapacityArea>(area), process_token, claimed_root) == ERROR_INVALID_STATE,
      "No area policy bypasses installed controller admission");
  Check(root_policy.verify(root_policy.context, CellCapacityArea::count, GetCurrentProcess(), claimed_root) == ERROR_INVALID_PARAMETER,
    "Unknown capacity area refuses before native inspection");
  Check(root_policy.verify(root_policy.context, CellCapacityArea::mutable_root, INVALID_HANDLE_VALUE, claimed_root) == ERROR_INVALID_PARAMETER,
    "Invalid capacity root handle refuses");
  Check(ImpersonateSelf(SecurityIdentification) != FALSE, "own identification-only thread token");
  const bool captured = CollectCellControllerToken(process_token, &current);
  const DWORD admission = identity.Open(1, arguments);
  Check(RevertToSelf() != FALSE, "revert own thread token");
  Check(!captured && current.user.empty() && !current.no_thread_token && !ValidateCellControllerToken(current, false) &&
    admission == ERROR_ACCESS_DENIED, "ambient thread token prevents capture and admission");
  Check(CollectCellControllerToken(process_token, &current) && current.no_thread_token, "no residual impersonation");
  identity.Close(); identity.Close();
  const auto after = PrivilegeState(process_token); CloseHandle(process_token);
  Check(before == after, "admission failures did not change privileges");

  SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  Check(manager != nullptr, "read-only SCM connection");
  SC_HANDLE event_log = OpenServiceW(manager, L"EventLog", kWorkerServiceRead);
  Check(event_log != nullptr, "query unrelated installed service");
  ServiceConfiguration config; ServiceObjectSecurity security;
  const bool configuration_read = CollectServiceConfiguration(event_log, &config);
  const bool security_read = CollectServiceObjectSecurity(event_log, &security);
  CloseServiceHandle(event_log); CloseServiceHandle(manager);
  Check(configuration_read && security_read && !config.binary.empty() && !security.owner.empty(), "actual SCM collectors");
  Check(!ValidateCellControllerConfiguration(config, ControllerConfig().binary, SERVICE_RUNNING), "unrelated actual service is refused");
  Check(!ValidateServiceObject(security), "unrelated actual service DACL is refused");
}
}
void CapacityFixtureCases(const wchar_t* path) {
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(file != INVALID_HANDLE_VALUE, "Open installer-emitted capacity fixture");
  std::vector<std::uint8_t> bytes(320); LARGE_INTEGER size{}; DWORD read = 0;
  const bool loaded = GetFileSizeEx(file, &size) && size.QuadPart == 320 && ReadFile(file, bytes.data(), 320, &read, nullptr) && read == 320;
  Check(loaded, "Read exact installer-emitted capacity record");
  CellControllerCapacityCustodyRecord record;
  Check(DecodeCellControllerCapacityCustody(bytes, &record), "Decode real installer-produced root identities");
  const std::wstring input(path); const auto separator = input.find_last_of(L"\\/");
  Check(separator != std::wstring::npos, "Fixture path has an explicit parent");
  std::array<HANDLE, 13> roots{};
  for (std::size_t i = 0; i < record.roots.size(); ++i) {
    const auto directory = input.substr(0, separator + 1) + L"area-" + std::to_wstring(i);
    HANDLE root = CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    Check(root != INVALID_HANDLE_VALUE, "Open retained fixture directory for independent native identity read");
    FILE_ID_INFO id{}; FILE_ATTRIBUTE_TAG_INFO attributes{};
    const bool matches = GetFileInformationByHandleEx(root, FileIdInfo, &id, sizeof(id)) &&
      GetFileInformationByHandleEx(root, FileAttributeTagInfo, &attributes, sizeof(attributes)) &&
      (attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == FILE_ATTRIBUTE_DIRECTORY &&
      id.VolumeSerialNumber == record.roots[i].volume_serial && !std::memcmp(id.FileId.Identifier, record.roots[i].file_id.data(), 16);
    roots[i] = root; Check(matches, "Installer/native capacity identity and ordering agree on the real fixture root");
  }
  auto verified = record;
  Check(!ReadCellControllerCapacityCustody(file, roots, verified.roots[0], &verified) && verified == record,
    "Production reader binds installer bytes to all thirteen retained handles and independent cells identity");
  Check(ReadCellControllerCapacityCustody(file, roots, record.roots[1], &verified) == ERROR_FILE_INVALID &&
    verified == CellControllerCapacityCustodyRecord{}, "Wrong independently admitted cells parent clears record output");
  for (std::size_t i = 0; i < roots.size(); ++i) {
    auto substituted = roots; substituted[i] = roots[(i + 1) % roots.size()]; verified = record;
    Check(ReadCellControllerCapacityCustody(file, substituted, record.roots[0], &verified) == ERROR_FILE_INVALID &&
      verified == CellControllerCapacityCustodyRecord{}, "Substituting any root handle clears the entire record");
    substituted[i] = file; verified = record;
    Check(ReadCellControllerCapacityCustody(file, substituted, record.roots[0], &verified) == ERROR_FILE_INVALID &&
      verified == CellControllerCapacityCustodyRecord{}, "A regular file cannot stand in for an area directory");
  }
  verified = record;
  Check(ReadCellControllerCapacityCustody(roots[0], roots, record.roots[0], &verified) == ERROR_INVALID_HANDLE &&
    verified == CellControllerCapacityCustodyRecord{}, "A directory cannot stand in for the installer record");
  Check(ReadCellControllerCapacityCustody(file, roots, record.roots[0], nullptr) == ERROR_INVALID_PARAMETER,
    "Native capacity reader requires its result owner");
  for (const auto root : roots) CloseHandle(root);
  CloseHandle(file);
}
void GateOwnershipCase() {
  std::array<wchar_t, 32768> temp{};
  Check(GetTempPathW(static_cast<DWORD>(temp.size()), temp.data()) != 0, "resolve ordinary gate fixture directory");
  const auto path = std::wstring(temp.data()) + L"goat-identity-gate-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(file != INVALID_HANDLE_VALUE, "create only owned empty identity-gate fixture");
  WorkerStateGateLock retained;
  Check(retained.Acquire(file, false) == ERROR_SUCCESS, "caller holds independent writer custody");
  CellControllerIdentity unadmitted;
  Check(unadmitted.AcquireMeasurementGate(retained) != ERROR_SUCCESS, "unadmitted identity cannot acquire measurement custody");
  Check(retained.Check() == ERROR_SUCCESS, "refused acquisition cannot release caller's earlier lock");
  Check(retained.Release() == ERROR_SUCCESS, "original caller still releases its own lock");
  CloseHandle(file); Check(DeleteFileW(path.c_str()), "remove owned identity-gate fixture");
}
int wmain(int argc, wchar_t** argv) {
  Check(argc == 1 || argc == 2, "Identity fixture accepts only optional capacity-record input");
  if (argc == 2) CapacityFixtureCases(argv[1]);
  TokenCases(); ConfigurationCases(); CustodyCases(); CapacityCustodyCases(); ActualProcessCases();
  GateOwnershipCase();
  std::printf("{\"checks\":%u,\"passed\":true,\"actualInteractiveTokenRefused\":true,\"privilegesUnchanged\":true,\"installedService\":false,\"volumeAttached\":false}\n", checks);
}
