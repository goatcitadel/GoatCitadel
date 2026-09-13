#include "worker_host.hpp"
#include "service_identity.hpp"
#include <cstdio>
#include <cwchar>

#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_host {
namespace {
SRWLOCK g_lock = SRWLOCK_INIT;
HANDLE g_stop = nullptr;
SERVICE_STATUS_HANDLE g_status = nullptr;

void RequestStop() noexcept {
  AcquireSRWLockShared(&g_lock);
  if (g_stop) SetEvent(g_stop);
  ReleaseSRWLockShared(&g_lock);
}
void SetStopHandle(HANDLE handle) noexcept {
  AcquireSRWLockExclusive(&g_lock);
  g_stop = handle;
  ReleaseSRWLockExclusive(&g_lock);
}
BOOL WINAPI ConsoleControl(DWORD control) noexcept {
  if (control != CTRL_C_EVENT && control != CTRL_BREAK_EVENT && control != CTRL_CLOSE_EVENT &&
      control != CTRL_LOGOFF_EVENT && control != CTRL_SHUTDOWN_EVENT) return FALSE;
  RequestStop();
  return TRUE;
}
DWORD WINAPI ServiceControl(DWORD control, DWORD, void*, void*) noexcept {
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
    RequestStop(); return NO_ERROR;
  }
  return control == SERVICE_CONTROL_INTERROGATE ? NO_ERROR : ERROR_CALL_NOT_IMPLEMENTED;
}
bool Publish(DWORD state, DWORD error, DWORD checkpoint, DWORD wait) noexcept {
  SERVICE_STATUS status{};
  status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  status.dwCurrentState = state;
  status.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
  status.dwWin32ExitCode = error;
  status.dwCheckPoint = checkpoint;
  status.dwWaitHint = wait;
  return SetServiceStatus(g_status, &status) != FALSE;
}
bool Observe(DWORD state, void*) noexcept {
  return Publish(state, NO_ERROR, state == SERVICE_STOP_PENDING ? 1 : 0,
    state == SERVICE_STOP_PENDING ? kGracefulStopMs + kTerminationMs : 0);
}
void WINAPI ServiceMain(DWORD count, wchar_t** arguments) noexcept {
  g_status = RegisterServiceCtrlHandlerExW(kServiceName, ServiceControl, nullptr);
  if (!g_status) return;
  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  DWORD error = stop ? ERROR_SUCCESS : GetLastError();
  if (stop && !Publish(SERVICE_START_PENDING, NO_ERROR, 1, 15000)) error = GetLastError();
  if (!error) {
    SetStopHandle(stop);
    error = VerifyWorkerServiceIdentity(count, arguments);
    if (!error && WaitForSingleObject(stop, 0) == WAIT_TIMEOUT) {
      const Result result = Run(stop, false, Observe, nullptr);
      error = result.error ? result.error : result.child_exit_code;
    }
  }
  SetStopHandle(nullptr);
  if (stop) CloseHandle(stop);
  // All child/job/path handles have closed before this sole terminal publication.
  Publish(SERVICE_STOPPED, error, 0, 0);
}
}  // namespace

int DispatchService() noexcept {
  SERVICE_TABLE_ENTRYW table[] = {{const_cast<wchar_t*>(kServiceName), ServiceMain}, {nullptr, nullptr}};
  return StartServiceCtrlDispatcherW(table) ? 0 : static_cast<int>(GetLastError());
}

int Foreground() noexcept {
  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stop) return static_cast<int>(GetLastError());
  SetStopHandle(stop);
  SetConsoleCtrlHandler(ConsoleControl, TRUE);
  const Result result = Run(stop, true, nullptr, nullptr);
  SetStopHandle(nullptr);
  SetConsoleCtrlHandler(ConsoleControl, FALSE);
  CloseHandle(stop);
  std::printf("{\"error\":%lu,\"childExitCode\":%lu,\"stopRequested\":%s,\"forced\":%s,\"jobEmpty\":%s}\n",
    result.error, result.child_exit_code, result.stop_requested ? "true" : "false",
    result.forced ? "true" : "false", result.job_empty ? "true" : "false");
  return static_cast<int>(result.error ? result.error : result.child_exit_code);
}
}  // namespace goatcitadel::worker_host

int wmain(int argc, wchar_t** argv) {
  if (argc == 1) return goatcitadel::worker_host::DispatchService();
  if (argc == 2 && wcscmp(argv[1], L"--foreground") == 0) return goatcitadel::worker_host::Foreground();
  return ERROR_BAD_ARGUMENTS;
}
