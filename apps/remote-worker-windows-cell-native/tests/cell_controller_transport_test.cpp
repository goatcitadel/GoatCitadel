#include "cell_controller_transport.hpp"
#include <sddl.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0, pipe_fixtures = 0, client_processes = 0;
void Check(bool value, const char* name) {
  ++checks;
  if (!value) { std::fprintf(stderr, "Cell transport check failed: %s (OS error %lu)\n", name, GetLastError()); std::exit(1); }
}
void Code(DWORD value, DWORD expected, const char* name) {
  if (value != expected) std::fprintf(stderr, "%s: actual=%lu expected=%lu\n", name, value, expected);
  Check(value == expected, name);
}
struct Handle final {
  HANDLE value = nullptr;
  ~Handle() { Close(); }
  void Close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
};
struct Child final {
  PROCESS_INFORMATION info{};
  ~Child() {
    if (info.hProcess) {
      if (WaitForSingleObject(info.hProcess, 0) == WAIT_TIMEOUT) { TerminateProcess(info.hProcess, 90); WaitForSingleObject(info.hProcess, 2000); }
      CloseHandle(info.hProcess);
    }
    if (info.hThread) CloseHandle(info.hThread);
  }
  void Launch(const std::wstring& pipe, const wchar_t* mode) {
    std::array<wchar_t, 2048> path{};
    Check(GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size())) != 0, "fixture executable path");
    std::wstring command = L"\"" + std::wstring(path.data()) + L"\" --pipe-client \"" + pipe + L"\" " + mode;
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    Check(CreateProcessW(path.data(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &info) != FALSE,
      "launch exact task-owned client without inherited handles");
    ++client_processes;
  }
  void Join() {
    Check(WaitForSingleObject(info.hProcess, 10000) == WAIT_OBJECT_0, "join task-owned client");
    DWORD code = 99;
    Check(GetExitCodeProcess(info.hProcess, &code) && code == 0, "client completed its expected exchange");
  }
};
bool NoThreadToken() {
  Handle token;
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token.value)) return false;
  return GetLastError() == ERROR_NO_TOKEN;
}
CellControllerToken Current() {
  Handle token;
  Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != FALSE, "query own primary token");
  CellControllerToken value;
  Check(CollectCellControllerToken(token.value, &value), "collect actual current token facts");
  return value;
}
void TokenComparisonCases() {
  const auto primary = Current(); auto pipe = primary; pipe.type = TokenImpersonation;
  Check(MatchCellPipeToken(primary, pipe), "matching OS fact projection");
  ++pipe.token_id.LowPart;
  Check(MatchCellPipeToken(primary, pipe), "identification token has its own object identity");
  std::reverse(pipe.groups.begin(), pipe.groups.end());
  std::reverse(pipe.privileges.begin(), pipe.privileges.end());
  Check(MatchCellPipeToken(primary, pipe), "OS group order does not change identity");
  const auto reject = [&](auto mutate, const char* name) {
    auto changed = primary; changed.type = TokenImpersonation; mutate(changed);
    Check(!MatchCellPipeToken(primary, changed), name);
  };
  reject([](auto& t) { t.type = TokenPrimary; }, "no pipe identification type");
  reject([](auto& t) { t.user = L"S-1-5-18"; }, "different user");
  reject([](auto& t) { t.integrity = L"S-1-16-0"; }, "different integrity");
  reject([](auto& t) { ++t.session; }, "different session");
  reject([](auto& t) { ++t.authentication_id.LowPart; }, "different logon");
  reject([](auto& t) { ++t.change_notify.LowPart; }, "different privilege name mapping");
  reject([](auto& t) { t.no_thread_token = false; }, "unreverted current thread");
  reject([](auto& t) { t.restricted = true; }, "restricted pipe substitute");
  reject([](auto& t) { t.appcontainer = true; }, "AppContainer pipe substitute");
  reject([](auto& t) { t.groups.pop_back(); }, "missing group");
  reject([](auto& t) { t.groups.push_back(t.groups[0]); }, "extra group");
  reject([](auto& t) { t.groups[0].attributes ^= SE_GROUP_USE_FOR_DENY_ONLY; }, "different group rights");
  reject([](auto& t) { t.privileges.push_back({{99, 0}, 0}); }, "extra privilege");
  if (!primary.privileges.empty()) {
    reject([](auto& t) { t.privileges[0].Attributes ^= SE_PRIVILEGE_ENABLED; }, "different enabled privilege");
    auto used = primary; used.type = TokenImpersonation; used.privileges[0].Attributes ^= SE_PRIVILEGE_USED_FOR_ACCESS;
    Check(MatchCellPipeToken(primary, used), "privilege-use telemetry is not authority");
  }
  goatcitadel::worker_host::TokenIdentity worker;
  Check(goatcitadel::worker_host::CollectWorkerProcessToken(GetCurrentProcess(), &worker), "collect retained process worker facts");
  Check(!goatcitadel::worker_host::ValidateWorkerToken(worker), "raw caller facts do not admit interactive user as worker");
  Check(!goatcitadel::worker_host::CollectWorkerProcessToken(nullptr, &worker) && worker.user_sid.empty(), "failed process collection clears authority");
}
void SecurityCases() {
  std::vector<std::uint8_t> bytes;
  Code(BuildCellControllerPipeSecurity(&bytes), ERROR_SUCCESS, "build controller pipe descriptor");
  Check(IsValidSecurityDescriptor(bytes.data()), "valid controller pipe descriptor");
  SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  Check(GetSecurityDescriptorControl(bytes.data(), &control, &revision) && (control & SE_DACL_PROTECTED), "pipe DACL is protected");
  BOOL present = FALSE, defaulted = TRUE; PACL acl = nullptr;
  Check(GetSecurityDescriptorDacl(bytes.data(), &present, &acl, &defaulted) && present && acl && !defaulted && acl->AceCount == 3,
    "exact three pipe principals");
  PSID worker = nullptr;
  Check(ConvertStringSidToSidW(goatcitadel::worker_host::kWorkerSid, &worker), "independent worker SID");
  unsigned workers = 0;
  for (DWORD index = 0; index < acl->AceCount; ++index) {
    void* raw = nullptr;
    Check(GetAce(acl, index, &raw), "read explicit pipe ACE");
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
    Check(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0, "explicit allow ACE only");
    if (EqualSid(const_cast<DWORD*>(&ace->SidStart), worker)) {
      ++workers;
      Check(ace->Mask == kCellControllerPipeClientAccess && !(ace->Mask & FILE_CREATE_PIPE_INSTANCE) &&
        !(ace->Mask & (WRITE_DAC | WRITE_OWNER | DELETE)), "worker cannot host, control or replace pipe");
    }
  }
  LocalFree(worker);
  Check(workers == 1, "exact one restricted worker grant");
  Code(BuildCellControllerPipeSecurity(nullptr), ERROR_INVALID_PARAMETER, "null pipe descriptor destination");
}
std::wstring PipeName() {
  return L"\\\\.\\pipe\\LOCAL\\GoatCellTransportTest-" + std::to_wstring(GetCurrentProcessId()) +
    L"-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(++pipe_fixtures);
}
HANDLE FixtureServer(const std::wstring& name) {
  // Task-owned current-user fixture, deliberately not a SYSTEM installation.
  HANDLE pipe = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 512, 512, 0, nullptr);
  Check(pipe != INVALID_HANDLE_VALUE, "create fresh task-owned local pipe");
  return pipe;
}
int Client(const wchar_t* name, const wchar_t* mode) {
  DWORD qos = SECURITY_IDENTIFICATION;
  if (!wcscmp(mode, L"impersonation")) qos = SECURITY_IMPERSONATION;
  else if (!wcscmp(mode, L"anonymous")) qos = SECURITY_ANONYMOUS;
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Handle pipe{CreateFileW(name, kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | qos, nullptr)};
  if (pipe.value == INVALID_HANDLE_VALUE || !stop.value) return 20;
  const auto deadline = GetTickCount64() + 10000;
  std::array<std::uint8_t, 32> hello{}; hello.fill(0x42);
  if (WriteCellPipe(pipe.value, hello.data(), 1, stop.value, deadline) ||
      WriteCellPipe(pipe.value, hello.data() + 1, 31, stop.value, deadline)) return 21;
  if (!wcscmp(mode, L"stall-write")) {
    std::this_thread::sleep_for(std::chrono::milliseconds(500)); return 0;
  }
  if (wcscmp(mode, L"echo")) {
    std::uint8_t end = 0;
    const auto error = ReadCellPipe(pipe.value, &end, 1, stop.value, deadline);
    return error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED ? 0 : 22;
  }
  std::array<std::uint8_t, kCellControllerMaximumPipeBytes> data{};
  if (ReadCellPipe(pipe.value, data.data(), static_cast<DWORD>(data.size()), stop.value, deadline) ||
      !std::all_of(data.begin(), data.end(), [](auto value) { return value == 0x5a; })) return 23;
  hello.fill(0x43);
  if (WriteCellPipe(pipe.value, hello.data(), static_cast<DWORD>(hello.size()), stop.value, deadline)) return 24;
  std::uint8_t end = 0;
  return ReadCellPipe(pipe.value, &end, 1, stop.value, deadline) || end != 1 ? 25 : 0;
}
void Exchange() {
  const auto name = PipeName(); Handle server{FixtureServer(name)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)}; Child child; child.Launch(name, L"echo");
  const auto deadline = GetTickCount64() + 10000;
  Code(ConnectCellPipe(server.value, stop.value, deadline), ERROR_SUCCESS, "connect actual client");
  std::array<std::uint8_t, 32> hello{};
  Code(ReadCellPipe(server.value, hello.data(), static_cast<DWORD>(hello.size()), stop.value, deadline), ERROR_SUCCESS, "read fragmented hello");
  Check(std::all_of(hello.begin(), hello.end(), [](auto byte) { return byte == 0x42; }), "exact bounded hello bytes");
  CellPipeClientEvidence evidence;
  Code(evidence.Open(server.value), ERROR_SUCCESS, "match real primary and kernel pipe identity");
  Check(evidence.ProcessId() == child.info.dwProcessId && evidence.CreationTime() != 0, "pipe identity bound to retained child process");
  Code(evidence.Open(server.value), ERROR_ALREADY_INITIALIZED, "no evidence replacement");
  Check(NoThreadToken(), "pipe identification fully reverted");
  std::array<std::uint8_t, kCellControllerMaximumPipeBytes> payload{}; payload.fill(0x5a);
  Code(WriteCellPipe(server.value, payload.data(), static_cast<DWORD>(payload.size()), stop.value, deadline), ERROR_SUCCESS, "duplex payload larger than kernel buffer");
  Code(ReadCellPipe(server.value, hello.data(), static_cast<DWORD>(hello.size()), stop.value, deadline), ERROR_SUCCESS, "read client acknowledgement");
  Check(std::all_of(hello.begin(), hello.end(), [](auto byte) { return byte == 0x43; }), "exact acknowledgement bytes");
  Code(evidence.Verify(), ERROR_SUCCESS, "revalidate identity after later client message");
  Check(NoThreadToken(), "no impersonation after revalidation");
  goatcitadel::worker_host::TokenIdentity worker;
  Check(goatcitadel::worker_host::CollectWorkerProcessToken(evidence.Process(), &worker) && !goatcitadel::worker_host::ValidateWorkerToken(worker),
    "actual separate fixture process is not a service worker");
  CellControllerIdentity unadmitted; CellControllerPeer peer;
  Code(peer.Open(server.value, unadmitted), ERROR_INVALID_STATE, "raw pipe evidence cannot bypass controller admission");
  Code(peer.Verify(), ERROR_INVALID_STATE, "failed controller peer retains no authority");
  Code(ReadCellPipe(server.value, payload.data(), kCellControllerMaximumPipeBytes + 1, stop.value, deadline), ERROR_INVALID_PARAMETER, "oversized I/O rejected before read");
  Code(WriteCellPipe(server.value, nullptr, 1, stop.value, deadline), ERROR_INVALID_PARAMETER, "null write rejected");
  Code(ReadCellPipe(server.value, payload.data(), 1, stop.value, GetTickCount64()), ERROR_TIMEOUT, "expired deadline rejected before read");
  Code(ReadCellPipe(server.value, payload.data(), 1, stop.value, GetTickCount64() + 700000), ERROR_INVALID_PARAMETER, "unbounded deadline rejected");
  Check(SetHandleInformation(server.value, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "mark own fixture handle inheritable");
  Code(ReadCellPipe(server.value, payload.data(), 1, stop.value, deadline), ERROR_INVALID_HANDLE, "inheritable pipe refused");
  Check(SetHandleInformation(server.value, HANDLE_FLAG_INHERIT, 0), "clear own handle inheritance");
  std::uint8_t end = 1;
  Code(WriteCellPipe(server.value, &end, 1, stop.value, deadline), ERROR_SUCCESS, "finish actual client exchange");
  child.Join();
  Code(evidence.Verify(), ERROR_PROCESS_ABORTED, "exited client's retained PID is not live authority");
  evidence.Close(); evidence.Close();
  Code(evidence.Verify(), ERROR_INVALID_STATE, "closed evidence is not authority");
}
void RefusedLevel(const wchar_t* mode) {
  const auto name = PipeName(); Handle server{FixtureServer(name)}, stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Child child; child.Launch(name, mode); const auto deadline = GetTickCount64() + 10000;
  Code(ConnectCellPipe(server.value, stop.value, deadline), ERROR_SUCCESS, "connect caller with different SQOS");
  std::array<std::uint8_t, 32> hello{};
  Code(ReadCellPipe(server.value, hello.data(), static_cast<DWORD>(hello.size()), stop.value, deadline), ERROR_SUCCESS, "read hello before identity refusal");
  CellPipeClientEvidence evidence; const auto error = evidence.Open(server.value);
  Check(error == ERROR_BAD_IMPERSONATION_LEVEL || error == ERROR_CANNOT_IMPERSONATE, "anonymous or broader impersonation level refused");
  Check(!evidence.Process() && evidence.ProcessId() == 0 && NoThreadToken(), "refusal clears facts and reverts impersonation");
  server.Close(); child.Join();
}
void PendingIo(bool cancel, bool write) {
  const auto name = PipeName(); Handle server{FixtureServer(name)}, stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Child child; child.Launch(name, write ? L"stall-write" : L"idle"); const auto connection_deadline = GetTickCount64() + 10000;
  Code(ConnectCellPipe(server.value, stop.value, connection_deadline), ERROR_SUCCESS, "connect idle client");
  std::array<std::uint8_t, 32> hello{};
  Code(ReadCellPipe(server.value, hello.data(), static_cast<DWORD>(hello.size()), stop.value, connection_deadline), ERROR_SUCCESS, "idle client hello");
  // The write fixture never reads. A 16 KiB write cannot complete into its
  // 512-byte buffer, so this exercises cancellation under backpressure.
  std::array<std::uint8_t, kCellControllerMaximumPipeBytes> payload{};
  std::thread signal;
  if (cancel) signal = std::thread([&]() { std::this_thread::sleep_for(std::chrono::milliseconds(100)); SetEvent(stop.value); });
  const auto deadline = GetTickCount64() + (cancel ? 5000 : 100);
  const auto error = write ? WriteCellPipe(server.value, payload.data(), static_cast<DWORD>(payload.size()), stop.value, deadline)
    : ReadCellPipe(server.value, payload.data(), 1, stop.value, deadline);
  if (signal.joinable()) signal.join();
  Code(error, cancel ? ERROR_OPERATION_ABORTED : ERROR_TIMEOUT, "pending I/O cancelled and joined");
  server.Close();
  // A cancelled write can have queued bytes. The client never replays it.
  child.Join();
}
void Unconnected() {
  const auto name = PipeName(); Handle server{FixtureServer(name)}, stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Code(ConnectCellPipe(server.value, stop.value, GetTickCount64() + 100), ERROR_TIMEOUT, "unused listener timeout drains pending connect");
  Check(SetEvent(stop.value), "signal owned stop event");
  Code(ConnectCellPipe(server.value, stop.value, GetTickCount64() + 1000), ERROR_OPERATION_ABORTED, "stopped listener does not connect");
  Code(ReadCellPipe(server.value, nullptr, 0, stop.value, GetTickCount64() + 1000), ERROR_INVALID_PARAMETER, "empty read refused");
  CellPipeClientEvidence evidence;
  Check(evidence.Open(server.value) != ERROR_SUCCESS, "unconnected pipe cannot supply peer authority");
  Check(NoThreadToken(), "all refusal paths leave no thread token");
}
}
int wmain(int count, wchar_t** arguments) {
  if (count == 4 && !wcscmp(arguments[1], L"--pipe-client")) return Client(arguments[2], arguments[3]);
  if (count != 1) return 2;
  const auto before = Current();
  TokenComparisonCases(); SecurityCases(); Exchange(); RefusedLevel(L"impersonation"); RefusedLevel(L"anonymous");
  PendingIo(true, false); PendingIo(false, false); PendingIo(true, true); Unconnected();
  auto after = Current(); after.type = TokenImpersonation;
  Check(MatchCellPipeToken(before, after) && NoThreadToken(), "local proof leaves token rights unchanged");
  std::printf("{\"checks\":%u,\"pipeFixtures\":%u,\"clientProcesses\":%u,\"passed\":true,\"actualPipeIdentityVerified\":true,\"privilegesUnchanged\":true,\"installedService\":false,\"workerServiceAdmitted\":false}\n", checks, pipe_fixtures, client_processes);
}
