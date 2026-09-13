#include <windows.h>
#include <cstdio>

// Controlled driver cancellation fixture. Its working directory is test-owned.
int wmain() {
  char pid[32]{};
  const int length = sprintf_s(pid, "%lu", GetCurrentProcessId());
  HANDLE file = CreateFileW(L"started.pid", GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE || length < 1) return 1;
  DWORD written = 0;
  const bool started = WriteFile(file, pid, static_cast<DWORD>(length), &written, nullptr) && written == static_cast<DWORD>(length);
  CloseHandle(file);
  if (!started) return 2;
  Sleep(30000);
  return 3;
}
