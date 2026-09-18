#include "installed_worker_files.hpp"
#include "service_identity.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <array>
#include <algorithm>

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
void WriterGate(const std::wstring& base) {
  const auto path = base + L".writer-gate-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  HANDLE first = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
    CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  HANDLE second = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  HANDLE third = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(first != INVALID_HANDLE_VALUE && second != INVALID_HANDLE_VALUE && third != INVALID_HANDLE_VALUE, "open separate guard handles on one owned empty file");
  WorkerStateGateLock writer, other_writer, measurement;
  Check(writer.Acquire(first, false) == ERROR_SUCCESS && other_writer.Acquire(second, false) == ERROR_SUCCESS, "multiple active writers share gate");
  Check(measurement.Acquire(third, true) == ERROR_LOCK_VIOLATION, "measurement fails immediately while a writer is present");
  Check(writer.Check() == ERROR_SUCCESS && writer.Acquire(first, false) == ERROR_INVALID_STATE, "held writer cannot acquire overlapping lock again");
  Check(writer.Release() == ERROR_SUCCESS && measurement.Acquire(third, true) == ERROR_LOCK_VIOLATION, "one remaining writer still excludes measurement");
  Check(other_writer.Release() == ERROR_SUCCESS && measurement.Acquire(third, true) == ERROR_SUCCESS, "drained writers allow exclusive measurement");
  Check(writer.Acquire(first, false) == ERROR_LOCK_VIOLATION && other_writer.Acquire(second, true) == ERROR_LOCK_VIOLATION, "measurement excludes new writers and another observer");
  Check(measurement.Check() == ERROR_SUCCESS && measurement.Release() == ERROR_SUCCESS && writer.Acquire(first, false) == ERROR_SUCCESS, "writers regain custody only after measurement releases");
  Check(writer.Release() == ERROR_SUCCESS && writer.Check() != ERROR_SUCCESS, "released custody cannot attest a writer");
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE}; HANDLE reader = nullptr, output = nullptr;
  Check(CreatePipe(&reader, &output, &security, 0) && SetHandleInformation(reader, HANDLE_FLAG_INHERIT, 0), "create owned child handshake pipe");
  std::array<wchar_t, 32768> executable{};
  Check(GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size())) != 0, "read owned fixture executable");
  std::wstring command = L"\"" + std::wstring(executable.data()) + L"\" --writer-gate-child \"" + path + L"\"";
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = startup.hStdError = output;
  PROCESS_INFORMATION process{};
  Check(CreateProcessW(executable.data(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process), "start only owned writer fixture child");
  CloseHandle(output); CloseHandle(process.hThread);
  std::array<char, 5> ready{}; DWORD read = 0;
  Check(ReadFile(reader, ready.data(), 5, &read, nullptr) && read == 5 && std::string(ready.data(), 5) == "ready", "child owns its independent writer lock");
  Check(measurement.Acquire(third, true) == ERROR_LOCK_VIOLATION, "separate process writer excludes controller");
  Check(TerminateProcess(process.hProcess, 23) && WaitForSingleObject(process.hProcess, 3000) == WAIT_OBJECT_0, "terminate and join only owned fixture child");
  CloseHandle(process.hProcess); CloseHandle(reader);
  Check(measurement.Acquire(third, true) == ERROR_SUCCESS && measurement.Release() == ERROR_SUCCESS, "OS releases exited process lock without changing guard bytes");
  DWORD written = 0; char byte = 1;
  Check(WriteFile(first, &byte, 1, &written, nullptr) && written == 1 && writer.Acquire(first, false) == ERROR_INVALID_DATA, "nonempty guard is never repaired or admitted");
  CloseHandle(third); CloseHandle(second); CloseHandle(first);
  Check(DeleteFileW(path.c_str()), "remove only this owned ordinary guard fixture");
}
void HostRunMarker(const std::wstring& base) {
  const auto path = base + L".host-run-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(file != INVALID_HANDLE_VALUE, "create owned host-run marker");
  Check(!BeginWorkerHostRun(file), "missing fixed-size contents never initialize themselves");
  std::array<unsigned char, 32> bytes{}; DWORD count = 0; LARGE_INTEGER start{};
  Check(WriteFile(file, bytes.data(), 32, &count, nullptr) && count == 32 && FlushFileBuffers(file), "initialize fixed-size clean marker");
  Check(!VerifyWorkerHostRunMarker(file, GetCurrentProcess()), "clean marker cannot attest a running host");
  Check(BeginWorkerHostRun(file), "flush host identity before child creation");
  Check(VerifyWorkerHostRunMarker(file, GetCurrentProcess()), "read-only observer binds marker to the live host");
  HANDLE observer = CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(observer != INVALID_HANDLE_VALUE && VerifyWorkerHostRunMarker(observer, GetCurrentProcess()),
    "separate read-only controller handle observes the marker while host write custody is retained");
  CloseHandle(observer);
  Check(!VerifyWorkerHostRunMarker(file, nullptr), "missing process cannot supply host evidence");
  Check(!BeginWorkerHostRun(file), "active marker cannot be begun again");
  Check(!FinishWorkerHostRun(file, INVALID_HANDLE_VALUE), "missing job evidence cannot clear marker");
  HANDLE competing = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
  Check(competing == INVALID_HANDLE_VALUE, "retained marker custody excludes competing writers");
  Check(!MoveFileW(path.c_str(), (path + L".moved").c_str()), "retained marker cannot be renamed");
  CloseHandle(file);
  file = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  Check(file != INVALID_HANDLE_VALUE && !BeginWorkerHostRun(file), "uncertain marker survives handle loss and refuses restart");
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  Check(job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "create owned kill-on-close test job");
  std::array<wchar_t, 32768> image{};
  Check(GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size())) != 0, "resolve test executable");
  std::wstring command = L"\"" + std::wstring(image.data()) + L"\"";
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION child{};
  Check(CreateProcessW(image.data(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
    nullptr, nullptr, &startup, &child), "create suspended owned fixture child");
  const bool assigned = AssignProcessToJobObject(job, child.hProcess) != FALSE;
  if (!assigned) { TerminateProcess(child.hProcess, 1); WaitForSingleObject(child.hProcess, 5000); }
  Check(assigned, "assign owned suspended child to test job");
  Check(!VerifyWorkerHostRunMarker(file, child.hProcess), "another live process cannot reuse the host marker");
  Check(!FinishWorkerHostRun(file, job), "live process prevents marker completion");
  Check(TerminateProcess(child.hProcess, 0) && WaitForSingleObject(child.hProcess, 5000) == WAIT_OBJECT_0, "join only owned fixture child");
  CloseHandle(child.hThread); CloseHandle(child.hProcess);
  bool finished = false; const auto deadline = GetTickCount64() + 5000;
  do { finished = FinishWorkerHostRun(file, job); if (!finished) Sleep(10); } while (!finished && GetTickCount64() < deadline);
  Check(finished, "verified empty original job permits clean marker");
  Check(SetFilePointerEx(file, start, nullptr, FILE_BEGIN) && ReadFile(file, bytes.data(), 32, &count, nullptr) && count == 32 &&
    std::all_of(bytes.begin(), bytes.end(), [](auto value) { return value == 0; }), "completion persists exact clean bytes");
  Check(BeginWorkerHostRun(file), "a clean marker permits the next run");
  Check(SetFilePointerEx(file, start, nullptr, FILE_BEGIN) && ReadFile(file, bytes.data(), 32, &count, nullptr) && count == 32,
    "read owned marker for controlled provenance substitution");
  bytes[8] ^= 1;
  Check(SetFilePointerEx(file, start, nullptr, FILE_BEGIN) && WriteFile(file, bytes.data(), 32, &count, nullptr) && count == 32 && FlushFileBuffers(file),
    "persist substituted host identity in owned fixture");
  Check(!FinishWorkerHostRun(file, job) && !BeginWorkerHostRun(file), "foreign or corrupt host identity cannot be cleared by an empty job");
  CloseHandle(job); CloseHandle(file);
}
}
int wmain(int count, wchar_t** arguments) {
  if (count == 3 && std::wstring(arguments[1]) == L"--writer-gate-child") {
    HANDLE file = CreateFileW(arguments[2], GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    WorkerStateGateLock writer;
    if (file == INVALID_HANDLE_VALUE || writer.Acquire(file, false)) return 3;
    std::fputs("ready", stdout); std::fflush(stdout); Sleep(5000);
    writer.Release(); CloseHandle(file); return 0;
  }
  Check(count == 3, "fixture arguments");
  HostRunMarker(arguments[1]);
  WriterGate(arguments[1]);
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
  const auto with_paths = [&](const std::wstring& state, const std::wstring& report) {
    std::wstring changed(environment.data(), environment.size());
    for (const auto& item : {std::pair<std::wstring, std::wstring>{L"STATE_DIR=", state},
        {L"REPORT_FILE=", report}}) {
      const auto begin = changed.find(L"GOATCITADEL_CONNECTED_WORKER_" + item.first);
      Check(begin != std::wstring::npos, "state layout mutation target");
      const auto value = begin + std::wstring(L"GOATCITADEL_CONNECTED_WORKER_").size() + item.first.size();
      const auto end = changed.find(L'\0', value);
      changed.replace(value, end - value, item.second);
    }
    return std::vector<wchar_t>{changed.begin(), changed.end()};
  };
  bool capacity = true;
  auto legacy = with_paths(root + L"\\state", root + L"\\state\\service-report.json");
  Check(ValidateInstalledEnvironment(legacy, root, &capacity) && !capacity, "legacy layout remains exact");
  auto split = with_paths(root + L"\\state\\retained-outbox", root + L"\\state\\diagnostic\\service-report.json");
  Check(ValidateInstalledEnvironment(split, root, &capacity) && capacity, "separate retained and diagnostic roots");
  for (const auto& bad_layout : {
      with_paths(root + L"\\state", root + L"\\state\\diagnostic\\service-report.json"),
      with_paths(root + L"\\state\\retained-outbox", root + L"\\state\\service-report.json"),
      with_paths(root + L"\\state\\diagnostic", root + L"\\state\\diagnostic\\service-report.json"),
      with_paths(root + L"\\state\\retained-outbox\\..", root + L"\\state\\diagnostic\\service-report.json")}) {
    capacity = true;
    Check(!ValidateInstalledEnvironment(bad_layout, root, &capacity) && !capacity, "mixed or substituted roots fail closed");
  }
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
