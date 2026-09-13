#include <winsock2.h>
#include <windows.h>
#include <userenv.h>
#include <array>
#include <cstdio>
#include <cwchar>
#include <cstdint>
#include <string>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "ws2_32.lib")
int ProbeCellWorkspace(wchar_t** argv);

namespace {
bool WriteBytes(DWORD stream, const void* bytes, DWORD count) {
  DWORD written = 0;
  return WriteFile(GetStdHandle(stream), bytes, count, &written, nullptr) && written == count;
}
bool WriteText(DWORD stream, const std::string& text) {
  return WriteBytes(stream, text.data(), static_cast<DWORD>(text.size()));
}
std::string InputLine() {
  std::string line;
  while (line.size() < 1024) {
    char byte = 0; DWORD count = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &count, nullptr) || count != 1) return "";
    if (byte == '\n') return line;
    line.push_back(byte);
  }
  return "";
}
int InteractiveInput() {
  DWORD ignored = 0;
  if (WriteFile(GetStdHandle(STD_INPUT_HANDLE), "x", 1, &ignored, nullptr) || GetLastError() != ERROR_ACCESS_DENIED) return 81;
  const auto challenge = std::to_string(GetCurrentProcessId()) + ":" + std::to_string(GetTickCount64());
  if (!WriteText(STD_OUTPUT_HANDLE, "challenge:" + challenge + "\n") || InputLine() != "answer:" + challenge ||
      !WriteText(STD_OUTPUT_HANDLE, "accepted\n") || InputLine() != "finish") return 82;
  char byte = 0; DWORD received = 0;
  const bool read = ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &received, nullptr) != FALSE;
  if (received || (!read && GetLastError() != ERROR_BROKEN_PIPE)) return 83;
  return WriteText(STD_OUTPUT_HANDLE, "complete\n") && WriteText(STD_ERROR_HANDLE, "diagnostic\n") ? 0 : 84;
}
int InteractiveEcho() {
  if (!WriteText(STD_OUTPUT_HANDLE, "ready\n")) return 81;
  std::array<std::uint8_t, 1024> bytes{};
  for (;;) {
    DWORD count = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr))
      return GetLastError() == ERROR_BROKEN_PIPE ? 0 : 82;
    if (!count) return 0;
    if (!WriteBytes(STD_OUTPUT_HANDLE, bytes.data(), count) || !WriteBytes(STD_ERROR_HANDLE, bytes.data(), count)) return 83;
  }
}
int InteractiveFlood(DWORD stream) {
  std::array<std::uint8_t, 4096> bytes{};
  for (;;) if (!WriteBytes(stream, bytes.data(), static_cast<DWORD>(bytes.size()))) return 0;
}
int InspectInput(bool pressure) {
  std::array<std::uint8_t, 1024> bytes{};
  std::array<char, 2048> output{};
  output.fill('P');
  std::uint64_t count = 0, hash = 14695981039346656037ULL;
  // stdin is read-only even though the process can inspect its inherited handle.
  DWORD ignored = 0;
  const bool can_write = WriteFile(GetStdHandle(STD_INPUT_HANDLE), "x", 1, &ignored, nullptr) != FALSE;
  const DWORD write_error = can_write ? ERROR_SUCCESS : GetLastError();
  if (can_write || write_error != ERROR_ACCESS_DENIED) return 86;
  for (;;) {
    if (pressure) {
      for (const DWORD channel : {STD_OUTPUT_HANDLE, STD_ERROR_HANDLE}) {
        DWORD written = 0;
        if (!WriteFile(GetStdHandle(channel), output.data(), static_cast<DWORD>(output.size()), &written, nullptr) ||
            written != output.size()) return 87;
      }
    }
    DWORD received = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()), &received, nullptr)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) break;
      return 88;
    }
    if (!received) break;
    count += received;
    for (DWORD index = 0; index < received; ++index) { hash ^= bytes[index]; hash *= 1099511628211ULL; }
  }
  std::printf("input_bytes=%llu input_hash=%llu eof=1 readonly=1\n",
    static_cast<unsigned long long>(count), static_cast<unsigned long long>(hash));
  return 0;
}
bool SignalUnlistedHandle(HANDLE event) {
  __try { return SetEvent(event) != FALSE; }
  __except (GetExceptionCode() == 0xc0000008U ? EXCEPTION_EXECUTE_HANDLER : EXCEPTION_CONTINUE_SEARCH) {
    // AppContainer strict-handle checks can raise STATUS_INVALID_HANDLE instead
    // of returning FALSE. Either refusal must leave the parent's event unsignaled.
    return false;
  }
}
int InspectSecurity(wchar_t** argv) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 97;
  DWORD app = 0, bytes = 0;
  alignas(TOKEN_MANDATORY_LABEL) std::array<std::uint8_t, 4096> data{};
  const bool app_read = GetTokenInformation(token, TokenIsAppContainer, &app, sizeof(app), &bytes) != FALSE;
  bool same_sid = false;
  if (GetTokenInformation(token, TokenAppContainerSid, data.data(), static_cast<DWORD>(data.size()), &bytes)) {
    PSID expected = nullptr;
    if (SUCCEEDED(DeriveAppContainerSidFromAppContainerName(argv[5], &expected))) {
      const PSID actual = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(data.data())->TokenAppContainer;
      same_sid = actual && EqualSid(actual, expected);
      FreeSid(expected);
    }
  }
  DWORD capabilities = MAXDWORD, integrity = MAXDWORD;
  if (GetTokenInformation(token, TokenCapabilities, data.data(), static_cast<DWORD>(data.size()), &bytes))
    capabilities = reinterpret_cast<TOKEN_GROUPS*>(data.data())->GroupCount;
  if (GetTokenInformation(token, TokenIntegrityLevel, data.data(), static_cast<DWORD>(data.size()), &bytes)) {
    const PSID sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(data.data())->Label.Sid;
    if (sid && IsValidSid(sid) && *GetSidSubAuthorityCount(sid) == 1) integrity = *GetSidSubAuthority(sid, 0);
  }
  CloseHandle(token);
  if (!app_read) return 97;
  HANDLE file = CreateFileW(argv[2], GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  const DWORD read_error = file == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  file = CreateFileW(argv[2], GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  const DWORD write_error = file == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  std::array<wchar_t, 2048> image{};
  if (!GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()))) return 97;
  file = CreateFileW(image.data(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  const bool image_read = file != INVALID_HANDLE_VALUE;
  if (image_read) CloseHandle(file);
  HANDLE job = OpenJobObjectW(JOB_OBJECT_SET_ATTRIBUTES | JOB_OBJECT_TERMINATE, FALSE, argv[3]);
  const DWORD job_error = job ? ERROR_SUCCESS : GetLastError();
  if (job) CloseHandle(job);
  HANDLE parent = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_WRITE | PROCESS_DUP_HANDLE | PROCESS_TERMINATE,
    FALSE, static_cast<DWORD>(_wcstoui64(argv[4], nullptr, 10)));
  const DWORD parent_error = parent ? ERROR_SUCCESS : GetLastError();
  if (parent) CloseHandle(parent);
  std::printf("app=%lu sid=%d caps=%lu integrity=%lu read=%lu write=%lu image=%d job=%lu parent=%lu\n",
    app, same_sid, capabilities, integrity, read_error, write_error, image_read, job_error, parent_error);
  return 0;
}
int ProbeNetwork(const wchar_t* port_text) {
  const auto port = _wcstoui64(port_text, nullptr, 10);
  if (!port || port > 65535) return 98;
  WSADATA data{};
  const int initialized = WSAStartup(MAKEWORD(2, 2), &data);
  if (initialized != 0) { std::printf("startup_error=%d\n", initialized); return 98; }
  SOCKET connection = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  int error = connection == INVALID_SOCKET ? WSAGetLastError() : 0;
  if (connection != INVALID_SOCKET) {
    u_long nonblocking = 1;
    if (ioctlsocket(connection, FIONBIO, &nonblocking) != 0) error = WSAGetLastError();
    else {
      sockaddr_in address{};
      address.sin_family = AF_INET;
      address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      address.sin_port = htons(static_cast<u_short>(port));
      if (connect(connection, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) error = WSAGetLastError();
      if (error == WSAEWOULDBLOCK) {
        fd_set writable{}, failed{};
        FD_ZERO(&writable); FD_ZERO(&failed);
        FD_SET(connection, &writable); FD_SET(connection, &failed);
        timeval deadline{2, 0};
        const int selected = select(0, nullptr, &writable, &failed, &deadline);
        int size = sizeof(error);
        if (selected == SOCKET_ERROR) error = WSAGetLastError();
        else if (!selected) error = WSAETIMEDOUT;
        else if (getsockopt(connection, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &size) != 0) error = WSAGetLastError();
      }
    }
    closesocket(connection);
  }
  WSACleanup();
  std::printf("network_error=%d connected=%d\n", error, error == 0);
  return 0;
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return 90;
  if (wcscmp(argv[1], L"duplex") == 0) return InteractiveInput();
  if (wcscmp(argv[1], L"duplex-echo") == 0) return InteractiveEcho();
  if (wcscmp(argv[1], L"duplex-flood") == 0) return InteractiveFlood(STD_OUTPUT_HANDLE);
  if (wcscmp(argv[1], L"duplex-flood-error") == 0) return InteractiveFlood(STD_ERROR_HANDLE);
  if (wcscmp(argv[1], L"input") == 0) return InspectInput(false);
  if (wcscmp(argv[1], L"input-pressure") == 0) return InspectInput(true);
  if (wcscmp(argv[1], L"input-close") == 0) {
    CloseHandle(GetStdHandle(STD_INPUT_HANDLE));
    Sleep(100);
    std::printf("input-closed\n");
    return 0;
  }
  if (wcscmp(argv[1], L"sleep") == 0) { Sleep(20000); return 0; }
  if (wcscmp(argv[1], L"security") == 0 && argc == 6) return InspectSecurity(argv);
  if (wcscmp(argv[1], L"network") == 0 && argc == 3) return ProbeNetwork(argv[2]);
  if (wcscmp(argv[1], L"workspace") == 0 && argc == 6) return ProbeCellWorkspace(argv);
  if (wcscmp(argv[1], L"exit") == 0) { std::printf("finished\n"); return 7; }
  if (wcscmp(argv[1], L"inspect") == 0) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
    if (!QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr) ||
        !QueryInformationJobObject(nullptr, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu), nullptr)) return 93;
    std::printf("process=%lu memory=%llu flags=%lu cpu=%lu cpuFlags=%lu ambient=%lu\n",
      limits.BasicLimitInformation.ActiveProcessLimit, static_cast<unsigned long long>(limits.JobMemoryLimit),
      limits.BasicLimitInformation.LimitFlags, cpu.CpuRate, cpu.ControlFlags,
      GetEnvironmentVariableW(L"GOAT_CELL_TEST_AMBIENT", nullptr, 0));
    if (argc == 3) {
      const auto value = _wcstoui64(argv[2], nullptr, 10);
      std::printf("inheritedEvent=%d\n", SignalUnlistedHandle(reinterpret_cast<HANDLE>(value)) ? 1 : 0);
    }
    return 0;
  }
  if (wcscmp(argv[1], L"memory") == 0) {
    std::array<void*, 32> allocations{};
    std::size_t count = 0;
    DWORD allocation_error = ERROR_SUCCESS;
    for (; count < allocations.size(); ++count) {
      allocations[count] = VirtualAlloc(nullptr, 8ULL * 1024 * 1024, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
      if (!allocations[count]) { allocation_error = GetLastError(); break; }
    }
    std::printf("allocated=%llu error=%lu\n", static_cast<unsigned long long>(count) * 8 * 1024 * 1024, allocation_error);
    for (void* allocation : allocations) if (allocation) VirtualFree(allocation, 0, MEM_RELEASE);
    return allocation_error ? 0 : 94;
  }
  if (wcscmp(argv[1], L"process") == 0 || wcscmp(argv[1], L"breakaway") == 0) {
    const bool breakaway = wcscmp(argv[1], L"breakaway") == 0;
    std::array<wchar_t, 2048> image{};
    if (!GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()))) return 95;
    unsigned started = 0, refused = 0;
    for (unsigned index = 0; index < (breakaway ? 1U : 8U); ++index) {
      std::wstring command = L"\"" + std::wstring(image.data()) + L"\" sleep";
      STARTUPINFOW startup{};
      startup.cb = sizeof(startup);
      PROCESS_INFORMATION child{};
      const DWORD flags = CREATE_NO_WINDOW | (breakaway ? CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED : 0);
      if (CreateProcessW(image.data(), command.data(), nullptr, nullptr, FALSE, flags, nullptr, nullptr, &startup, &child)) {
        ++started;
        if (breakaway) { TerminateProcess(child.hProcess, 99); WaitForSingleObject(child.hProcess, 5000); }
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
      } else ++refused;
    }
    std::printf("started=%u refused=%u\n", started, refused);
    return 0;
  }
  if (wcscmp(argv[1], L"capture") == 0) {
    for (unsigned index = 0; index < 100; ++index) std::putchar(static_cast<int>('0' + index % 10));
    return 0;
  }
  if (wcscmp(argv[1], L"flood") == 0) {
    std::array<char, 4096> bytes{};
    bytes.fill('A');
    const ULONGLONG end = GetTickCount64() + 20000;
    while (GetTickCount64() < end) {
      DWORD written = 0;
      if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr)) break;
      if (!WriteFile(GetStdHandle(STD_ERROR_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr)) break;
    }
    return 0;
  }
  if (wcscmp(argv[1], L"cpu") == 0) {
    const ULONGLONG end = GetTickCount64() + 1200;
    std::uint64_t value = 1;
    while (GetTickCount64() < end) { value = value * 1664525 + 1013904223; }
    std::printf("cpu-work=%llu\n", static_cast<unsigned long long>(value));
    return 0;
  }
  return 96;
}
