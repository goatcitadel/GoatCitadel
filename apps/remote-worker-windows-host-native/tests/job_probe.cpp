#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <array>
#include <string>

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && wcscmp(argv[1], L"--child") == 0) { Sleep(25000); return 0; }
  const bool retain = argc == 2 && wcscmp(argv[1], L"--retain-breakaway") == 0;
  const bool direct = argc == 2 && !retain;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  if (!QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr)) return 1;
  std::array<wchar_t, 2048> image{};
  if (!GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()))) return 2;
  std::wstring command = L"\"" + std::wstring(image.data()) + L"\" --child";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  const bool escaped = CreateProcessW(image.data(), command.data(), nullptr, nullptr, FALSE,
    CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &startup, &child) != FALSE;
  const DWORD error = escaped ? ERROR_SUCCESS : GetLastError();
  if (escaped) {
    if (retain) ResumeThread(child.hThread);
    else {
      TerminateProcess(child.hProcess, 1);
      WaitForSingleObject(child.hProcess, 5000);
    }
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
  }
  std::array<char, 512> report{};
  const int length = sprintf_s(report.data(), report.size(), "{\"processLimit\":%lu,\"memoryLimit\":%llu,\"killOnClose\":%s,\"breakawayAllowed\":%s,\"escapeError\":%lu,\"breakawayPid\":%lu}\n",
    limits.BasicLimitInformation.ActiveProcessLimit, static_cast<unsigned long long>(limits.JobMemoryLimit),
    limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ? "true" : "false",
    limits.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) ? "true" : "false", error,
    escaped && retain ? child.dwProcessId : 0);
  if (length <= 0) return 4;
  if (direct) {
    std::array<wchar_t, 2048> destination{};
    const DWORD count = GetEnvironmentVariableW(L"GOATCITADEL_CONNECTED_WORKER_REPORT_FILE", destination.data(), static_cast<DWORD>(destination.size()));
    if (!count || count >= destination.size()) return 5;
    HANDLE file = CreateFileW(destination.data(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return 6;
    DWORD written = 0;
    const bool saved = WriteFile(file, report.data(), static_cast<DWORD>(length), &written, nullptr) && written == static_cast<DWORD>(length);
    CloseHandle(file);
    if (!saved) return 7;
  } else std::printf("%s", report.data());
  return escaped && !retain ? 3 : 0;
}
