#include "cell_controller_protocol.hpp"
#include "service_inspection.hpp"
#include <atomic>
#include <cstdlib>

using namespace goatcitadel::worker_cell;
#pragma comment(lib, "advapi32.lib")
namespace {
SRWLOCK stop_lock = SRWLOCK_INIT;
HANDLE stop_handle = nullptr;
SERVICE_STATUS_HANDLE service_status = nullptr;
struct Handle final { HANDLE value = nullptr; ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
struct WatchState final {
  HANDLE stop = nullptr, finished = nullptr;
  std::atomic<ULONGLONG> until{GetTickCount64() + 10000};
};
[[noreturn]] void Fatal(DWORD error) noexcept { TerminateProcess(GetCurrentProcess(), error); std::abort(); }
DWORD WINAPI Watch(void* context) noexcept {
  const auto& watch = *static_cast<WatchState*>(context);
  ULONGLONG stop_at = 0;
  while (WaitForSingleObject(watch.finished, 50) == WAIT_TIMEOUT) {
    const auto now = GetTickCount64();
    if (!stop_at && WaitForSingleObject(watch.stop, 0) == WAIT_OBJECT_0) stop_at = now;
    // Terminate only this service process. The journal's uncertain intent and
    // OS resources remain intact for independent canonical reconciliation.
    if (now >= watch.until.load() || (stop_at && now - stop_at >= 5000)) Fatal(ERROR_TIMEOUT);
  }
  return 0;
}
bool Publish(DWORD state, DWORD error, DWORD checkpoint = 0, DWORD wait = 0) noexcept {
  SERVICE_STATUS status{}; status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  status.dwCurrentState = state; status.dwWin32ExitCode = error;
  status.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
  status.dwCheckPoint = checkpoint; status.dwWaitHint = wait;
  return service_status && SetServiceStatus(service_status, &status);
}
void StopHandle(HANDLE handle) noexcept {
  AcquireSRWLockExclusive(&stop_lock); stop_handle = handle; ReleaseSRWLockExclusive(&stop_lock);
}
DWORD WINAPI Control(DWORD control, DWORD, void*, void*) noexcept {
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
    AcquireSRWLockShared(&stop_lock);
    if (stop_handle) SetEvent(stop_handle);
    ReleaseSRWLockShared(&stop_lock);
    Publish(SERVICE_STOP_PENDING, ERROR_SUCCESS, 1, 6000);
    return ERROR_SUCCESS;
  }
  return control == SERVICE_CONTROL_INTERROGATE ? ERROR_SUCCESS : ERROR_CALL_NOT_IMPLEMENTED;
}
struct Connection final {
  CellControllerIdentity& identity;
  CellControllerPeer peer;
  HANDLE pipe;
  WatchState& watch;
  static DWORD Authorize(void* context, bool first) noexcept {
    auto& owner = *static_cast<Connection*>(context);
    return first ? owner.peer.Open(owner.pipe, owner.identity) : owner.peer.Verify();
  }
  static void Arm(void* context, ULONGLONG deadline) noexcept { static_cast<Connection*>(context)->watch.until.store(deadline); }
  static DWORD ProvisionVolume(void* context, CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor,
    const CellVolumeProvisioningCommitter& committer, DWORD wall_ms, HANDLE stop) noexcept {
    auto& owner = *static_cast<Connection*>(context);
    const DWORD error = owner.peer.Verify();
    // This serial controller owns only provisioning journals; it has no workload
    // launch path. Each volume check additionally crosses the canonical claim
    // owner through the authenticated session before this journal can advance.
    return error ? error : journal.ProvisionVolume(anchor, committer, wall_ms, stop);
  }
  static DWORD ProvisionFormat(void* context, CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor,
    const CellFormatProvisioningCommitter& committer, DWORD wall_ms, HANDLE stop) noexcept {
    auto& owner = *static_cast<Connection*>(context);
    const DWORD error = owner.peer.Verify();
    return error ? error : journal.ProvisionFormat(anchor, committer, wall_ms, stop);
  }
  static DWORD ProvisionProtection(void* context, CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor,
    const CellProtectionProvisioningCommitter& committer, DWORD wall_ms, HANDLE stop) noexcept {
    auto& owner = *static_cast<Connection*>(context);
    const DWORD error = owner.peer.Verify();
    return error ? error : journal.ProvisionProtection(anchor, committer, wall_ms, stop);
  }
  static DWORD ProvisionMount(void* context, CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor,
    const CellMountProvisioningCommitter& committer, DWORD wall_ms, HANDLE stop) noexcept {
    auto& owner = *static_cast<Connection*>(context);
    const DWORD error = owner.peer.Verify();
    return error ? error : journal.ProvisionMount(anchor, committer, wall_ms, stop);
  }
  static DWORD ProvisionMountedWorkspace(void* context, CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor,
    const CellMountedWorkspaceProvisioningCommitter& committer, DWORD wall_ms, HANDLE stop) noexcept {
    auto& owner = *static_cast<Connection*>(context);
    const DWORD error = owner.peer.Verify();
    return error ? error : journal.ProvisionMountedWorkspace(anchor, committer, wall_ms, stop);
  }
};
DWORD Run(CellControllerIdentity& identity, HANDLE stop, WatchState& watch) noexcept {
  try {
    std::vector<std::uint8_t> descriptor;
    DWORD error = BuildCellControllerPipeSecurity(&descriptor);
    if (error) return error;
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor.data(), FALSE};
    Handle pipe{CreateNamedPipeW(kCellControllerPipeName,
      PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, kCellControllerMaximumPipeBytes, kCellControllerMaximumPipeBytes, 0, &security)};
    if (pipe.value == INVALID_HANDLE_VALUE) return GetLastError();
    if (!Publish(SERVICE_RUNNING, ERROR_SUCCESS)) return GetLastError();
    while (WaitForSingleObject(stop, 0) == WAIT_TIMEOUT) {
      watch.until.store(GetTickCount64() + 10000);
      error = identity.Verify(SERVICE_RUNNING);
      if (error) return error;
      error = ConnectCellPipe(pipe.value, stop, GetTickCount64() + 5000);
      if (!error) {
        Connection connection{identity, {}, pipe.value, watch};
        CellControllerSessionOwner owner;
        owner.parent_path = identity.ParentPath(); owner.parent = identity.ParentIdentity();
        owner.owner_sid = L"S-1-5-18"; owner.controller_sid = kCellControllerServiceSid;
        owner.context = &connection; owner.authorize = Connection::Authorize; owner.arm_watchdog = Connection::Arm;
        owner.provision_volume = Connection::ProvisionVolume;
        owner.provision_format = Connection::ProvisionFormat;
        owner.provision_protection = Connection::ProvisionProtection;
        owner.provision_mount = Connection::ProvisionMount;
        owner.provision_mounted_workspace = Connection::ProvisionMountedWorkspace;
        // An operation error is returned in its bounded receipt when possible.
        // It never triggers a second dispatch or destroys retained resources.
        RunCellControllerSession(pipe.value, stop, owner);
        connection.peer.Close();
      } else if (error != ERROR_TIMEOUT && error != ERROR_OPERATION_ABORTED) return error;
      watch.until.store(GetTickCount64() + 10000);
      if (!DisconnectNamedPipe(pipe.value) && GetLastError() != ERROR_PIPE_NOT_CONNECTED) return GetLastError();
    }
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
void WINAPI ServiceMain(DWORD count, wchar_t** arguments) noexcept {
  service_status = RegisterServiceCtrlHandlerExW(kCellControllerServiceName, Control, nullptr);
  if (!service_status) return;
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, finished{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  DWORD error = stop.value && finished.value ? ERROR_SUCCESS : ERROR_NOT_ENOUGH_MEMORY;
  if (!error && !Publish(SERVICE_START_PENDING, ERROR_SUCCESS, 1, 10000)) error = GetLastError();
  WatchState watch; watch.stop = stop.value; watch.finished = finished.value;
  Handle watchdog;
  if (!error) {
    StopHandle(stop.value);
    watchdog.value = CreateThread(nullptr, 0, Watch, &watch, 0, nullptr);
    if (!watchdog.value) error = GetLastError();
  }
  if (!error) {
    CellControllerIdentity identity;
    error = identity.Open(count, arguments);
    if (!error && WaitForSingleObject(stop.value, 0) == WAIT_TIMEOUT &&
        !goatcitadel::worker_host::GrantCurrentSystemWorkerInspectionAccess()) error = ERROR_ACCESS_DENIED;
    if (!error && WaitForSingleObject(stop.value, 0) == WAIT_TIMEOUT) error = identity.EnableVolumeManagement();
    if (!error && WaitForSingleObject(stop.value, 0) == WAIT_TIMEOUT) error = Run(identity, stop.value, watch);
    Publish(SERVICE_STOP_PENDING, error, 1, 6000);
    identity.Close();
  }
  StopHandle(nullptr);
  if (finished.value) SetEvent(finished.value);
  if (watchdog.value && WaitForSingleObject(watchdog.value, 2000) != WAIT_OBJECT_0) Fatal(ERROR_TIMEOUT);
  Publish(SERVICE_STOPPED, error);
}
}
int wmain(int count, wchar_t**) {
  if (count != 1) return ERROR_BAD_ARGUMENTS;
  Handle token; CellControllerToken facts;
  // There is no foreground or configuration override that gains this service's
  // authority. SCM admission and installed custody are repeated in ServiceMain.
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) || !CollectCellControllerToken(token.value, &facts) ||
      !ValidateCellControllerToken(facts, false)) return ERROR_ACCESS_DENIED;
  SERVICE_TABLE_ENTRYW table[] = {{const_cast<wchar_t*>(kCellControllerServiceName), ServiceMain}, {nullptr, nullptr}};
  return StartServiceCtrlDispatcherW(table) ? 0 : static_cast<int>(GetLastError());
}
