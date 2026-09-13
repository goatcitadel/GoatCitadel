#include "installed_worker_files.hpp"
#include "service_identity.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>

using namespace goatcitadel::worker_host;
namespace {
unsigned checks = 0;
void Check(bool condition, const char* name) {
  ++checks;
  if (!condition) { std::fprintf(stderr, "Installed worker check failed: %s\n", name); std::exit(1); }
}
ServiceObjectSecurity FileSecurity(bool state) {
  ServiceObjectSecurity security;
  security.owner = L"S-1-5-18";
  security.owner_defaulted = security.dacl_defaulted = false;
  security.dacl_present = true;
  security.control = SE_SELF_RELATIVE | SE_DACL_PRESENT | SE_DACL_PROTECTED;
  const BYTE flags = state ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
  security.aces = {{ACCESS_ALLOWED_ACE_TYPE, flags, FILE_ALL_ACCESS, L"S-1-5-18"},
    {ACCESS_ALLOWED_ACE_TYPE, flags, FILE_ALL_ACCESS, L"S-1-5-32-544"},
    {ACCESS_ALLOWED_ACE_TYPE, flags, state ? 0x001301bfUL : 0x001200a9UL, kWorkerSid}};
  return security;
}
}
int wmain(int count, wchar_t** arguments) {
  Check(count == 3, "fixture arguments");
  HANDLE file = CreateFileW(arguments[1], GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(file != INVALID_HANDLE_VALUE, "open real installer-generated environment");
  Check(!VerifyWorkerFileHandle(file), "ordinary-user file cannot supply installed authority");
  const DWORD bytes = GetFileSize(file, nullptr);
  Check(bytes >= 4 && bytes < 65534 && bytes % sizeof(wchar_t) == 0, "bounded UTF-16 file");
  std::vector<wchar_t> environment(bytes / sizeof(wchar_t));
  DWORD read = 0;
  Check(ReadFile(file, environment.data(), bytes, &read, nullptr) && read == bytes, "read exact installer output");
  CloseHandle(file);
  const std::wstring root(arguments[2]);
  Check(ValidateInstalledEnvironment(environment, root), "PowerShell and native environment agree");
  const auto refuse = [&](const std::wstring& from, const std::wstring& to, const char* name) {
    std::wstring changed(environment.data(), environment.size());
    const auto position = changed.find(from);
    Check(position != std::wstring::npos, "fixture mutation target");
    changed.replace(position, from.size(), to);
    Check(!ValidateInstalledEnvironment({changed.begin(), changed.end()}, root), name);
  };
  refuse(L"RUN_MODE=continuous", L"RUN_MODE=once", "service cannot silently become one-shot");
  refuse(L"EXECUTION_MODE=gateway_inference", L"EXECUTION_MODE=protocol_probe", "service cannot become protocol probe");
  refuse(L"STOP_AFTER=complete", L"STOP_AFTER=admit", "service cannot stop before complete execution");
  refuse(L"PORT=8787", L"PORT=-1", "negative port");
  refuse(L"PORT=8787", L"PORT=65536", "overflow port");
  refuse(L"_HOST=127.0.0.1", L"_HOST=host\nNODE_OPTIONS=x", "control character injection");
  refuse(L"_PROTECTED_KEY_FILE=", L"_CLIENT_KEY_FILE=", "PEM authority substitution");
  refuse(L"\\configuration\\ticket.json", L"\\state\\ticket.json", "mutable input substitution");
  auto selected = environment;
  const std::string disabled = "disabled";
  Check(AddInstalledMeshRegistryEnvironment({disabled.begin(), disabled.end()}, root, selected) && selected == environment,
    "disabled selection preserves the base service environment");
  const std::vector<char> digest(64, 'a');
  Check(AddInstalledMeshRegistryEnvironment(digest, root, selected), "protected selection supplies two derived settings");
  const std::wstring selected_text(selected.data(), selected.size());
  Check(selected_text.find(L"MESH_REGISTRY_FILE=" + root + L"\\configuration\\mesh-registry-" + std::wstring(64, L'a') + L".json") != std::wstring::npos,
    "registry path is derived inside protected configuration");
  Check(selected_text.find(L"MESH_REGISTRY_SHA256=" + std::wstring(64, L'a')) != std::wstring::npos,
    "registry digest remains independently bound");
  Check(!ValidateInstalledEnvironment(selected, root), "operator environment cannot inject derived mesh settings");
  Check(!AddInstalledMeshRegistryEnvironment(digest, root, selected), "selection cannot widen an already derived environment");
  for (const auto& value : {std::string(), std::string("none"), std::string("disabled\n"), std::string(64, 'A'),
      std::string(63, 'a'), std::string(65, 'a'), std::string(32, 'a') + "../" + std::string(29, 'a')}) {
    auto rejected = environment;
    Check(!AddInstalledMeshRegistryEnvironment({value.begin(), value.end()}, root, rejected) && rejected == environment,
      "malformed registry selection cannot change child settings");
  }
  auto bad = environment; bad.pop_back();
  Check(!ValidateInstalledEnvironment(bad, root), "missing terminator");
  bad = environment; bad.push_back(0);
  Check(!ValidateInstalledEnvironment(bad, root), "trailing data");
  bad = environment; bad.insert(bad.begin(), 0xfeff);
  Check(!ValidateInstalledEnvironment(bad, root), "unsupported BOM");
  for (const bool state : {false, true}) {
    auto security = FileSecurity(state);
    Check(ValidateWorkerFileSecurity(security, state), "exact file role permissions");
    security.control |= SE_DACL_AUTO_INHERITED;
    Check(ValidateWorkerFileSecurity(security, state), "historical AI flag does not change explicit rights");
    security.aces[2].mask |= WRITE_DAC;
    Check(!ValidateWorkerFileSecurity(security, state), "worker cannot change permissions");
    security = FileSecurity(state); security.owner = kWorkerSid;
    Check(!ValidateWorkerFileSecurity(security, state), "worker cannot own the protected directory");
    security = FileSecurity(state); security.aces[2].flags |= INHERITED_ACE;
    Check(!ValidateWorkerFileSecurity(security, state), "unexpected inherited ACE refused");
  }
  Check(!ValidateWorkerFileSecurity(FileSecurity(true), false), "writable state is never a code directory");
  InstalledWorkerFiles installed;
  Check(!installed.Load(L"C:\\ordinary-user-package"), "service cannot adopt a portable package path");
  std::printf("{\"passed\":true,\"checks\":%u,\"installedService\":false}\n", checks);
}
