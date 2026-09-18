#include "cell_controller_client_identity.hpp"
#include "service_inspection.hpp"
#include <array>
#include <algorithm>
#include <cstdio>
#include <cstdlib>

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0, servers = 0;
void Check(bool value, const char* label) {
  ++checks;
  if (!value) { std::fprintf(stderr, "Client identity: %s (OS %lu)\n", label, GetLastError()); std::exit(1); }
}
void Code(DWORD actual, DWORD expected, const char* label) {
  if (actual != expected) std::fprintf(stderr, "%s: actual=%lu expected=%lu\n", label, actual, expected);
  Check(actual == expected, label);
}
const std::wstring custody_parent = L"C:\\ProgramData\\GoatCitadel\\RemoteWorker\\cells";
CellControllerCustodyRecord CustodyFixture() {
  CellControllerCustodyRecord value;
  value.image_sha256.fill(0x11); value.provisioning_sha256.fill(0x22);
  value.native_directory.volume_serial = value.parent.volume_serial = 0x0102030405060708ull;
  value.native_directory.file_id.fill(0x33); value.parent.file_id.fill(0x44);
  return value;
}
void CustodySnapshotChecks() {
  const auto record = CustodyFixture();
  std::vector<std::uint8_t> bytes;
  Code(EncodeCellControllerCustodySnapshot(custody_parent, record, nullptr), ERROR_INVALID_PARAMETER, "null snapshot output refused");
  Code(EncodeCellControllerCustodySnapshot(custody_parent, record, &bytes), ERROR_SUCCESS, "custody snapshot encoded");
  Check(bytes.size() == 132 + custody_parent.size(), "bounded snapshot size");
  Check(std::equal(bytes.begin() + 108, bytes.begin() + 116, std::array<std::uint8_t, 8>{8, 7, 6, 5, 4, 3, 2, 1}.begin()), "native volume serial encoding");
  for (const auto& invalid_path : {L"", L"relative", L"C:\\a\\..\\cells", L"\\\\host\\share\\cells"}) {
    Code(EncodeCellControllerCustodySnapshot(invalid_path, record, &bytes), ERROR_INVALID_DATA, "nonliteral path refused");
    Check(bytes.empty(), "invalid path has no output");
  }
  Code(EncodeCellControllerCustodySnapshot(L"C:\\" + std::wstring(8193, L'a'), record, &bytes), ERROR_INVALID_DATA, "unbounded path refused");
  Code(EncodeCellControllerCustodySnapshot(std::wstring(L"C:\\bad") + L'\xd800', record, &bytes), ERROR_INVALID_DATA, "invalid UTF-16 refused");
  for (unsigned change = 0; change < 5; ++change) {
    auto invalid = record;
    if (change == 0) invalid.image_sha256.fill(0);
    if (change == 1) invalid.provisioning_sha256 = invalid.image_sha256;
    if (change == 2) invalid.parent = invalid.native_directory;
    if (change == 3) ++invalid.parent.volume_serial;
    if (change == 4) invalid.parent.file_id.fill(0);
    Code(EncodeCellControllerCustodySnapshot(custody_parent, invalid, &bytes), ERROR_INVALID_DATA, "invalid custody record refused");
    Check(bytes.empty(), "invalid custody has no output");
  }
}
struct Handle final {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Child final {
  PROCESS_INFORMATION info{};
  ~Child() {
    // This exact process was created and retained by this fixture only.
    if (info.hProcess) {
      if (WaitForSingleObject(info.hProcess, 0) == WAIT_TIMEOUT) { TerminateProcess(info.hProcess, 90); WaitForSingleObject(info.hProcess, 2000); }
      CloseHandle(info.hProcess);
    }
    if (info.hThread) CloseHandle(info.hThread);
  }
  void Start(const std::wstring& pipe) {
    std::array<wchar_t, 2048> image{};
    Check(GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size())) != 0, "fixture image path");
    auto command = L"\"" + std::wstring(image.data()) + L"\" --server \"" + pipe + L"\"";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    Check(CreateProcessW(image.data(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &info),
      "start task-owned server without inherited handles");
    ++servers;
  }
  void Join() {
    Check(WaitForSingleObject(info.hProcess, 10000) == WAIT_OBJECT_0, "server process joins");
    DWORD code = 99;
    Check(GetExitCodeProcess(info.hProcess, &code) && code == 0, "server process finished its exact exchange");
  }
};
CellControllerToken Current() {
  Handle token; CellControllerToken facts;
  Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value), "read own token");
  Check(CollectCellControllerToken(token.value, &facts), "collect own primary token");
  return facts;
}
int Server(const wchar_t* name) {
  Handle pipe{CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 128, 128, 0, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (pipe.value == INVALID_HANDLE_VALUE || !stop.value) return 20;
  const auto deadline = GetTickCount64() + 10000;
  if (ConnectCellPipe(pipe.value, stop.value, deadline)) return 21;
  std::uint8_t value = 0x42;
  if (WriteCellPipe(pipe.value, &value, 1, stop.value, deadline)) return 22;
  if (ReadCellPipe(pipe.value, &value, 1, stop.value, deadline) || value != 1) return 23;
  return 0;
}
struct LocalPipe final {
  Handle server, client, stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  explicit LocalPipe(const std::wstring& name) {
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 128, 128, 0, nullptr);
    Check(server.value != INVALID_HANDLE_VALUE && stop.value, "create private parent evidence pipe");
    client.value = CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    Check(client.value != INVALID_HANDLE_VALUE, "open private parent evidence client");
    Code(ConnectCellPipe(server.value, stop.value, GetTickCount64() + 1000), ERROR_SUCCESS, "connect private parent evidence pipe");
  }
};
void ParentEvidenceChecks(const std::wstring& name) {
  LocalPipe input(name + L"-input"), output(name + L"-output"), runtime(name + L"-runtime");
  CellPipeParentEvidence parent;
  Code(parent.Verify(), ERROR_INVALID_STATE, "unopened parent has no evidence");
  Check(SetHandleInformation(input.client.value, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "fixture stdio may be inherited");
  Code(parent.Open(input.client.value, output.client.value, runtime.client.value), ERROR_SUCCESS, "three pipes retain one actual parent");
  Check(parent.Process() && GetProcessId(parent.Process()) == GetCurrentProcessId(), "local parent process retained");
  Check(parent.RuntimePipe() != runtime.client.value && CompareObjectHandles(parent.RuntimePipe(), runtime.client.value),
    "owns a separate handle to the exact runtime endpoint");
  DWORD flags = 0;
  Check(GetHandleInformation(input.client.value, &flags) && (flags & HANDLE_FLAG_INHERIT), "borrowed inheritance unchanged");
  Check(GetHandleInformation(parent.RuntimePipe(), &flags) && !(flags & HANDLE_FLAG_INHERIT), "retained runtime handle not inheritable");
  Code(parent.Open(input.client.value, output.client.value, runtime.client.value), ERROR_ALREADY_INITIALIZED, "parent cannot be replaced");
  Code(parent.Verify(), ERROR_SUCCESS, "parent verifies before I/O");
  for (unsigned index = 0; index < 3; ++index) {
    CellPipeParentEvidence alias;
    Handle duplicate;
    Check(DuplicateHandle(GetCurrentProcess(), input.client.value, GetCurrentProcess(), &duplicate.value,
      0, FALSE, DUPLICATE_SAME_ACCESS), "duplicate fixture input for alias refusal");
    const HANDLE second = index == 0 ? input.client.value : index == 1 ? duplicate.value : output.client.value;
    const HANDLE third = index == 2 ? duplicate.value : runtime.client.value;
    Code(alias.Open(input.client.value, second, third), ERROR_INVALID_HANDLE, "same object cannot play two parent roles");
    Check(!alias.Process() && !alias.RuntimePipe(), "refused alias exposes no usable handles");
    Code(alias.Open(input.client.value, output.client.value, runtime.client.value), ERROR_INVALID_HANDLE, "failed instance cannot reopen");
  }
  Check(ImpersonateSelf(SecurityIdentification), "parent refusal impersonation fixture");
  const DWORD denied = parent.Verify();
  if (!RevertToSelf()) TerminateProcess(GetCurrentProcess(), 99);
  Code(denied, ERROR_ACCESS_DENIED, "ambient impersonation fences parent");
  Code(parent.Verify(), ERROR_ACCESS_DENIED, "parent refusal remains sticky after reversion");
  Check(!parent.Process() && !parent.RuntimePipe(), "fenced parent exposes no handles");
  parent.Close(); parent.Close();
  std::uint8_t value = 0x51;
  Code(WriteCellPipe(runtime.client.value, &value, 1, runtime.stop.value, GetTickCount64() + 1000), ERROR_SUCCESS,
    "closing evidence preserves borrowed runtime handle");
  Code(ReadCellPipe(runtime.server.value, &value, 1, runtime.stop.value, GetTickCount64() + 1000), ERROR_SUCCESS,
    "borrowed pipe still usable");
  CellPipeParentEvidence disconnected;
  Code(disconnected.Open(input.client.value, output.client.value, runtime.client.value), ERROR_SUCCESS, "separate parent lifetime");
  Check(DisconnectNamedPipe(output.server.value), "disconnect only owned output fixture");
  Check(disconnected.Verify() != ERROR_SUCCESS, "disconnected stdio fences runtime even while parent process lives");
  Check(!disconnected.RuntimePipe(), "disconnected parent cannot supply runtime endpoint");
}
int ParentStdio(const wchar_t* name) {
  Handle pipe{CreateFileW(name, kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  CellPipeParentEvidence parent;
  DWORD error = parent.Open(GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), pipe.value);
  if (error) { std::fprintf(stderr, "stdio parent open: %lu\n", error); return 30; }
  const DWORD pid = GetProcessId(parent.Process());
  std::uint8_t value = 0;
  const auto deadline = GetTickCount64() + 5000;
  error = ReadCellPipe(parent.RuntimePipe(), &value, 1, stop.value, deadline);
  if (error || value != 0x11 || parent.Verify()) return 31;
  value = 0x12;
  if (WriteCellPipe(parent.RuntimePipe(), &value, 1, stop.value, deadline) || parent.Verify()) return 32;
  parent.Close();
  if (parent.RuntimePipe() || parent.Process() || parent.Verify() != ERROR_INVALID_STATE) return 33;
  value = 0x13;
  if (WriteCellPipe(pipe.value, &value, 1, stop.value, deadline)) return 34;
  std::printf("{\"passed\":true,\"parentProcessId\":%lu,\"borrowedPipePreserved\":true}\n", pid);
  return 0;
}
ULONGLONG Exchange(const std::wstring& name) {
  Child child; child.Start(name);
  Handle pipe{INVALID_HANDLE_VALUE}, stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(stop.value != nullptr, "owned stop event");
  const auto deadline = GetTickCount64() + 10000;
  while (GetTickCount64() < deadline) {
    pipe.value = CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    if (pipe.value != INVALID_HANDLE_VALUE) break;
    Check(GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PIPE_BUSY, "bounded fixture connection wait");
    Check(WaitForSingleObject(child.info.hProcess, 20) == WAIT_TIMEOUT, "fixture server still starting");
  }
  Check(pipe.value != INVALID_HANDLE_VALUE, "client connects to actual OS pipe");
  CellPipeServerEvidence evidence;
  Code(evidence.Open(pipe.value), ERROR_SUCCESS, "capture real server before sending any data");
  Check(evidence.ProcessId() == child.info.dwProcessId && evidence.ProcessId() != GetCurrentProcessId(), "actual separate server PID");
  const auto creation = evidence.CreationTime();
  FILETIME created{}, exited{}, kernel{}, user{};
  Check(GetProcessTimes(child.info.hProcess, &created, &exited, &kernel, &user) &&
    evidence.CreationTime() == ((static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime), "independent server birth time");
  Code(evidence.Open(pipe.value), ERROR_ALREADY_INITIALIZED, "cannot replace retained server");
  std::uint8_t value = 0;
  Code(ReadCellPipe(pipe.value, &value, 1, stop.value, deadline), ERROR_SUCCESS, "receive from retained server");
  Check(value == 0x42, "exact server byte");
  LocalPipe local_input(name + L"-local-input"), local_output(name + L"-local-output");
  CellPipeParentEvidence wrong_parent;
  Code(wrong_parent.Open(local_input.client.value, local_output.client.value, pipe.value), ERROR_ACCESS_DENIED,
    "live different process cannot replace inherited parent on runtime pipe");
  Check(!wrong_parent.Process() && !wrong_parent.RuntimePipe(), "different process exposes no retained endpoint");
  Code(evidence.Verify(), ERROR_SUCCESS, "server remains bound after I/O");
  Check(SetHandleInformation(pipe.value, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "set own client handle inheritance");
  Code(evidence.Verify(), ERROR_ACCESS_DENIED, "changed handle inheritance refused");
  CellPipeServerEvidence inherited;
  Code(inherited.Open(pipe.value), ERROR_INVALID_HANDLE, "initially inheritable handle refused");
  Check(!inherited.Process() && !inherited.ProcessId(), "failed capture retains no authority");
  Check(SetHandleInformation(pipe.value, HANDLE_FLAG_INHERIT, 0), "restore fixture inheritance");
  Check(ImpersonateSelf(SecurityIdentification), "create own identification token for refusal");
  const auto ambient_error = evidence.Verify();
  const bool reverted = RevertToSelf() != FALSE;
  if (!reverted) TerminateProcess(GetCurrentProcess(), 99);
  Check(reverted, "revert fixture identification before any more work");
  Code(ambient_error, ERROR_ACCESS_DENIED, "ambient token cannot authenticate the server");
  Code(evidence.Verify(), ERROR_SUCCESS, "reverted client verifies again");
  CellControllerServerIdentity admitted;
  Code(admitted.Prepare(), ERROR_ACCESS_DENIED, "interactive user cannot become installed worker");
  Code(admitted.Open(pipe.value), ERROR_INVALID_STATE, "raw server evidence cannot bypass worker admission");
  Code(admitted.Verify(), ERROR_INVALID_STATE, "failed admission cannot send a request");
  value = 1;
  Code(WriteCellPipe(pipe.value, &value, 1, stop.value, deadline), ERROR_SUCCESS, "finish exact server exchange");
  child.Join();
  Code(evidence.Verify(), ERROR_PROCESS_ABORTED, "retained exited server cannot remain authority");
  evidence.Close(); evidence.Close();
  Check(!evidence.Process() && !evidence.ProcessId() && !evidence.CreationTime(), "close clears retained identity");
  Code(evidence.Verify(), ERROR_INVALID_STATE, "closed server evidence cannot be reused");
  return creation;
}
}
int wmain(int count, wchar_t** arguments) {
  if (count == 3 && !wcscmp(arguments[1], L"--server")) return Server(arguments[2]);
  if (count == 3 && !wcscmp(arguments[1], L"--parent-stdio")) return ParentStdio(arguments[2]);
  if (count == 2 && !wcscmp(arguments[1], L"--custody-fixture")) {
    std::vector<std::uint8_t> frame;
    if (EncodeCellControllerCustodySnapshot(custody_parent, CustodyFixture(), &frame)) return 3;
    DWORD written = 0;
    return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), frame.data(), static_cast<DWORD>(frame.size()), &written, nullptr) && written == frame.size() ? 0 : 4;
  }
  if (count != 1) return 2;
  CustodySnapshotChecks();
  const auto before = Current();
  CellControllerServerIdentity identity;
  std::vector<std::uint8_t> snapshot(200, 1);
  Code(identity.ReadCustodySnapshot(&snapshot), ERROR_INVALID_STATE, "unprepared worker cannot read installed custody");
  Check(snapshot.empty(), "unprepared custody read clears output");
  Code(identity.Verify(), ERROR_INVALID_STATE, "unopened production client");
  Code(identity.Prepare(), ERROR_ACCESS_DENIED, "actual non-worker process refused");
  Check(identity.ParentPath().empty() && identity.ParentIdentity().volume_serial == 0, "failed Prepare clears custody");
  Code(identity.Prepare(), ERROR_ACCESS_DENIED, "repeated refusal does not retain partial admission");
  Code(identity.ReadCustodySnapshot(&snapshot), ERROR_INVALID_STATE, "refused worker cannot read installed custody");
  Check(!goatcitadel::worker_host::GrantCurrentSystemWorkerInspectionAccess(
      goatcitadel::worker_host::WorkerInspectionService::CellController), "shared production grant refuses actual interactive process");
  CellControllerInstalledFiles custody;
  Code(custody.Verify(), ERROR_INVALID_STATE, "unopened installation has no authority");
  Code(custody.VerifyControllerProcess(GetCurrentProcess()), ERROR_INVALID_STATE, "no unverified controller image");
  Code(custody.VerifyProvisioningProcess(GetCurrentProcess()), ERROR_INVALID_STATE, "no unverified helper image");
  CellPipeServerEvidence invalid;
  Code(invalid.Open(nullptr), ERROR_INVALID_HANDLE, "null pipe refused");
  Handle null_file{CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr)};
  Code(invalid.Open(null_file.value), ERROR_INVALID_HANDLE, "non-pipe handle refused");
  const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCellClientIdentity-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  ParentEvidenceChecks(name);
  const auto first_creation = Exchange(name);
  Check(Exchange(name) != first_creation, "replacement listener with the same name requires new process evidence");
  const auto wrong_end_name = name + L"-wrong-end";
  Handle wrong_end{CreateNamedPipeW(wrong_end_name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 128, 128, 0, nullptr)};
  Check(wrong_end.value != INVALID_HANDLE_VALUE, "create isolated wrong-end fixture");
  Code(invalid.Open(wrong_end.value), ERROR_INVALID_HANDLE, "server end cannot substitute for client-side evidence");
  auto after = Current(); after.type = TokenImpersonation;
  Check(MatchCellPipeToken(before, after), "client inspection leaves own privileges and groups unchanged");
  std::printf("{\"passed\":true,\"checks\":%u,\"serverProcesses\":%u,\"privilegesUnchanged\":true,\"installedService\":false}\n", checks, servers);
}
