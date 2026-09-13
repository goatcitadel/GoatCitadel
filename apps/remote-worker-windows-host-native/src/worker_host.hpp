#pragma once
#include <windows.h>

namespace goatcitadel::worker_host {
constexpr wchar_t kServiceName[] = L"GoatCitadelRemoteWorker";
constexpr DWORD kGracefulStopMs = 10000;
constexpr DWORD kTerminationMs = 5000;
constexpr DWORD kExitedChildDrainMs = 1000;
constexpr DWORD kMaximumProcesses = 64;
constexpr SIZE_T kMaximumJobMemory = 4ULL * 1024 * 1024 * 1024;

struct Result final {
  DWORD error = ERROR_SUCCESS;
  DWORD child_exit_code = 0;
  bool stop_requested = false;
  bool forced = false;
  bool job_empty = true;
};
// Notifications describe OS process lifetime, not Gateway admission or task success.
using Observer = bool (*)(DWORD state, void* context) noexcept;
Result Run(HANDLE stop_event, bool watch_standard_input, Observer observer, void* context) noexcept;
int DispatchService() noexcept;
}  // namespace goatcitadel::worker_host
