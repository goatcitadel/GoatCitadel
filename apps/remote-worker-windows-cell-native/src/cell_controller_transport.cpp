#include "cell_controller_transport.hpp"
#include <sddl.h>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_cell {
namespace {
struct Handle final {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
DWORD Error() noexcept { const DWORD code = GetLastError(); return code ? code : ERROR_GEN_FAILURE; }
bool SameLuid(LUID a, LUID b) noexcept { return a.LowPart == b.LowPart && a.HighPart == b.HighPart; }
bool NoThreadToken() noexcept {
  Handle thread;
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread.value)) return false;
  return GetLastError() == ERROR_NO_TOKEN;
}
[[noreturn]] void Fatal(DWORD error) noexcept {
  TerminateProcess(GetCurrentProcess(), error);
  std::abort();
}
bool Creation(HANDLE process, ULONGLONG& value) noexcept {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return false;
  value = (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  return value != 0;
}
bool Alive(HANDLE process) noexcept { return process && WaitForSingleObject(process, 0) == WAIT_TIMEOUT; }
DWORD TimeRemaining(HANDLE stop, ULONGLONG deadline, DWORD& remaining) noexcept {
  const DWORD state = WaitForSingleObject(stop, 0);
  if (state == WAIT_OBJECT_0) return ERROR_OPERATION_ABORTED;
  if (state != WAIT_TIMEOUT) return ERROR_INVALID_HANDLE;
  const auto now = GetTickCount64();
  if (deadline <= now) return ERROR_TIMEOUT;
  if (deadline - now > 600000) return ERROR_INVALID_PARAMETER;
  remaining = static_cast<DWORD>(deadline - now); return ERROR_SUCCESS;
}
DWORD Complete(HANDLE pipe, OVERLAPPED& io, HANDLE stop, ULONGLONG deadline, DWORD& transferred) noexcept {
  DWORD remaining = 0, error = TimeRemaining(stop, deadline, remaining);
  if (!error) {
    const HANDLE waits[] = {stop, io.hEvent};
    const DWORD state = WaitForMultipleObjects(2, waits, FALSE, remaining);
    if (state == WAIT_OBJECT_0 + 1) return GetOverlappedResult(pipe, &io, &transferred, FALSE) ? ERROR_SUCCESS : Error();
    error = state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : state == WAIT_TIMEOUT ? ERROR_TIMEOUT : ERROR_INVALID_HANDLE;
  }
  // Even if cancellation races with completion, drain this exact OVERLAPPED
  // before returning its storage. An uncertain result is never changed to success.
  CancelIoEx(pipe, &io);
  if (WaitForSingleObject(io.hEvent, 2000) != WAIT_OBJECT_0) Fatal(ERROR_TIMEOUT);
  GetOverlappedResult(pipe, &io, &transferred, FALSE);
  return error;
}
DWORD PipeIo(HANDLE pipe, void* bytes, DWORD count, HANDLE stop, ULONGLONG deadline, bool write) noexcept {
  if (!pipe || pipe == INVALID_HANDLE_VALUE || !bytes || !count || count > kCellControllerMaximumPipeBytes) return ERROR_INVALID_PARAMETER;
  DWORD flags = 0;
  if (GetFileType(pipe) != FILE_TYPE_PIPE || !GetHandleInformation(pipe, &flags) || (flags & HANDLE_FLAG_INHERIT)) return ERROR_INVALID_HANDLE;
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!event.value) return Error();
  auto cursor = static_cast<std::uint8_t*>(bytes);
  while (count) {
    DWORD remaining = 0, error = TimeRemaining(stop, deadline, remaining);
    if (error) return error;
    if (!ResetEvent(event.value)) return Error();
    OVERLAPPED io{}; io.hEvent = event.value;
    DWORD transferred = 0;
    const BOOL started = write ? WriteFile(pipe, cursor, count, nullptr, &io) : ReadFile(pipe, cursor, count, nullptr, &io);
    if (!started) {
      error = Error();
      if (error != ERROR_IO_PENDING) return error;
      error = Complete(pipe, io, stop, deadline, transferred);
    } else if (!GetOverlappedResult(pipe, &io, &transferred, FALSE)) error = Error();
    if (error) return error;
    if (!transferred || transferred > count) return ERROR_BROKEN_PIPE;
    cursor += transferred; count -= transferred;
  }
  return ERROR_SUCCESS;
}
DWORD CapturePipeToken(HANDLE pipe, CellControllerToken& result) noexcept {
  result = {};
  if (!NoThreadToken()) return ERROR_ACCESS_DENIED;
  if (!ImpersonateNamedPipeClient(pipe)) return ERROR_CANNOT_IMPERSONATE;
  Handle token;
  const bool opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token.value) != FALSE;
  // Capture the handle at identification level, then inspect it only after
  // restoring our own context. No caller-controlled operation runs impersonated.
  if (!RevertToSelf() || !NoThreadToken()) Fatal(ERROR_CANNOT_IMPERSONATE);
  if (!opened) return ERROR_CANNOT_IMPERSONATE;
  SECURITY_IMPERSONATION_LEVEL level = SecurityAnonymous; DWORD size = 0;
  if (!GetTokenInformation(token.value, TokenImpersonationLevel, &level, sizeof(level), &size) ||
      size != sizeof(level) || level != SecurityIdentification) return ERROR_BAD_IMPERSONATION_LEVEL;
  return CollectCellControllerToken(token.value, &result) ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
}
bool SamePrimary(const CellControllerToken& expected, const CellControllerToken& actual) noexcept {
  if (actual.type != TokenPrimary || !SameLuid(expected.token_id, actual.token_id)) return false;
  // Use the same full comparison without mutating the actual OS token.
  try {
    auto comparison = actual; comparison.type = TokenImpersonation;
    return MatchCellPipeToken(expected, comparison);
  } catch (...) { return false; }
}
}
DWORD BuildCellControllerPipeSecurity(std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  try {
    std::array<wchar_t, 16> access{};
    swprintf_s(access.data(), access.size(), L"0x%08lx", kCellControllerPipeClientAccess);
    const auto text = L"O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;" + std::wstring(kCellControllerServiceSid) +
      L")(A;;" + access.data() + L";;;" + worker_host::kWorkerSid + L")S:(ML;;NW;;;ME)";
    ULONG size = 0;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(), SDDL_REVISION_1, &descriptor, &size)) return Error();
    const auto* bytes = static_cast<const std::uint8_t*>(descriptor);
    output->assign(bytes, bytes + size); LocalFree(descriptor); return ERROR_SUCCESS;
  } catch (...) { if (descriptor) LocalFree(descriptor); output->clear(); return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD ConnectCellPipe(HANDLE pipe, HANDLE stop, ULONGLONG deadline) noexcept {
  DWORD flags = 0, remaining = 0;
  if (!GetNamedPipeInfo(pipe, &flags, nullptr, nullptr, nullptr) || !(flags & PIPE_SERVER_END) ||
      !GetHandleInformation(pipe, &flags) || (flags & HANDLE_FLAG_INHERIT)) return ERROR_INVALID_HANDLE;
  DWORD error = TimeRemaining(stop, deadline, remaining);
  if (error) return error;
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!event.value) return Error();
  OVERLAPPED io{}; io.hEvent = event.value;
  if (ConnectNamedPipe(pipe, &io)) return ERROR_SUCCESS;
  error = Error();
  if (error == ERROR_PIPE_CONNECTED) return ERROR_SUCCESS;
  if (error != ERROR_IO_PENDING) return error;
  DWORD transferred = 0; return Complete(pipe, io, stop, deadline, transferred);
}
DWORD ReadCellPipe(HANDLE pipe, void* bytes, DWORD count, HANDLE stop, ULONGLONG deadline) noexcept {
  return PipeIo(pipe, bytes, count, stop, deadline, false);
}
DWORD WriteCellPipe(HANDLE pipe, const void* bytes, DWORD count, HANDLE stop, ULONGLONG deadline) noexcept {
  return PipeIo(pipe, const_cast<void*>(bytes), count, stop, deadline, true);
}
bool MatchCellPipeToken(const CellControllerToken& primary, const CellControllerToken& pipe) noexcept {
  if (primary.type != TokenPrimary || pipe.type != TokenImpersonation || primary.user.empty() || primary.integrity.empty() ||
      !primary.no_thread_token || !pipe.no_thread_token || primary.restricted || pipe.restricted || primary.appcontainer || pipe.appcontainer ||
      primary.user != pipe.user || primary.integrity != pipe.integrity || primary.session != pipe.session ||
      !SameLuid(primary.authentication_id, pipe.authentication_id) || (!primary.authentication_id.LowPart && !primary.authentication_id.HighPart) ||
      !SameLuid(primary.change_notify, pipe.change_notify) || !SameLuid(primary.manage_volume, pipe.manage_volume) ||
      primary.groups.empty() || primary.groups.size() > 128 || primary.groups.size() != pipe.groups.size() ||
      primary.privileges.size() > 64 || primary.privileges.size() != pipe.privileges.size()) return false;
  const auto same_group = [](const auto& a, const auto& b) { return a.sid == b.sid && a.attributes == b.attributes; };
  const auto same_privilege = [](const auto& a, const auto& b) {
    return SameLuid(a.Luid, b.Luid) && (a.Attributes & ~SE_PRIVILEGE_USED_FOR_ACCESS) == (b.Attributes & ~SE_PRIVILEGE_USED_FOR_ACCESS);
  };
  return std::is_permutation(primary.groups.begin(), primary.groups.end(), pipe.groups.begin(), same_group) &&
    std::is_permutation(primary.privileges.begin(), primary.privileges.end(), pipe.privileges.begin(), same_privilege);
}
CellPipeClientEvidence::~CellPipeClientEvidence() { Close(); }
DWORD CellPipeClientEvidence::Open(HANDLE pipe) noexcept {
  if (process_ || pipe_) return ERROR_ALREADY_INITIALIZED;
  const auto refuse = [&](DWORD error) { Close(); return error; };
  if (!NoThreadToken()) return ERROR_ACCESS_DENIED;
  ULONG pid = 0, session = 0; DWORD flags = 0;
  if (!GetNamedPipeInfo(pipe, &flags, nullptr, nullptr, nullptr) || !(flags & PIPE_SERVER_END) ||
      !GetNamedPipeClientProcessId(pipe, &pid) || !pid || !GetNamedPipeClientSessionId(pipe, &session)) return ERROR_INVALID_HANDLE;
  process_ = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!Alive(process_) || !Creation(process_, creation_time_)) return refuse(ERROR_PROCESS_ABORTED);
  Handle token;
  if (!OpenProcessToken(process_, TOKEN_QUERY, &token.value) || !CollectCellControllerToken(token.value, &primary_) ||
      primary_.type != TokenPrimary || primary_.session != session) return refuse(ERROR_ACCESS_DENIED);
  pipe_ = pipe; process_id_ = pid;
  const DWORD error = Verify(); return error ? refuse(error) : ERROR_SUCCESS;
}
DWORD CellPipeClientEvidence::Verify() noexcept {
  if (!process_ || !pipe_) return ERROR_INVALID_STATE;
  if (!NoThreadToken()) return ERROR_ACCESS_DENIED;
  ULONG pid = 0, session = 0; ULONGLONG creation = 0;
  if (!Alive(process_) || !Creation(process_, creation) || creation != creation_time_) return ERROR_PROCESS_ABORTED;
  if (!GetNamedPipeClientProcessId(pipe_, &pid) || pid != process_id_ || !GetNamedPipeClientSessionId(pipe_, &session) ||
      session != primary_.session || GetProcessId(process_) != process_id_) return ERROR_ACCESS_DENIED;
  Handle token; CellControllerToken primary, identification;
  if (!OpenProcessToken(process_, TOKEN_QUERY, &token.value) || !CollectCellControllerToken(token.value, &primary) ||
      !SamePrimary(primary_, primary)) return ERROR_ACCESS_DENIED;
  DWORD error = CapturePipeToken(pipe_, identification);
  if (!error && !MatchCellPipeToken(primary, identification)) error = ERROR_ACCESS_DENIED;
  if (!error && !Alive(process_)) error = ERROR_PROCESS_ABORTED;
  return error;
}
void CellPipeClientEvidence::Close() noexcept {
  if (process_) CloseHandle(process_);
  process_ = pipe_ = nullptr; process_id_ = 0; creation_time_ = 0; primary_ = {};
}
CellPipeServerEvidence::~CellPipeServerEvidence() { Close(); }
DWORD CellPipeServerEvidence::Open(HANDLE pipe) noexcept {
  if (process_ || pipe_) return ERROR_ALREADY_INITIALIZED;
  const auto refuse = [&](DWORD error) { Close(); return error; };
  if (!NoThreadToken()) return ERROR_ACCESS_DENIED;
  ULONG pid = 0, session = 0; DWORD flags = 0;
  if (!GetNamedPipeInfo(pipe, &flags, nullptr, nullptr, nullptr) || (flags & PIPE_SERVER_END) ||
      !GetHandleInformation(pipe, &flags) || (flags & HANDLE_FLAG_INHERIT) ||
      !GetNamedPipeServerProcessId(pipe, &pid) || !pid || !GetNamedPipeServerSessionId(pipe, &session)) return ERROR_INVALID_HANDLE;
  process_ = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!Alive(process_) || !Creation(process_, creation_time_)) return refuse(ERROR_PROCESS_ABORTED);
  Handle token;
  if (!OpenProcessToken(process_, TOKEN_QUERY, &token.value) || !CollectCellControllerToken(token.value, &primary_) ||
      primary_.type != TokenPrimary || primary_.session != session) return refuse(ERROR_ACCESS_DENIED);
  pipe_ = pipe; process_id_ = pid;
  const DWORD error = Verify(); return error ? refuse(error) : ERROR_SUCCESS;
}
DWORD CellPipeServerEvidence::Verify() noexcept {
  if (!process_ || !pipe_) return ERROR_INVALID_STATE;
  if (!NoThreadToken()) return ERROR_ACCESS_DENIED;
  ULONG pid = 0, session = 0; ULONGLONG creation = 0; DWORD flags = 0;
  if (!Alive(process_) || !Creation(process_, creation) || creation != creation_time_) return ERROR_PROCESS_ABORTED;
  if (!GetNamedPipeInfo(pipe_, &flags, nullptr, nullptr, nullptr) || (flags & PIPE_SERVER_END) ||
      !GetHandleInformation(pipe_, &flags) || (flags & HANDLE_FLAG_INHERIT) ||
      !GetNamedPipeServerProcessId(pipe_, &pid) || pid != process_id_ || !GetNamedPipeServerSessionId(pipe_, &session) ||
      session != primary_.session || GetProcessId(process_) != process_id_) return ERROR_ACCESS_DENIED;
  Handle token; CellControllerToken primary;
  if (!OpenProcessToken(process_, TOKEN_QUERY, &token.value) || !CollectCellControllerToken(token.value, &primary) ||
      !SamePrimary(primary_, primary)) return ERROR_ACCESS_DENIED;
  return Alive(process_) ? ERROR_SUCCESS : ERROR_PROCESS_ABORTED;
}
void CellPipeServerEvidence::Close() noexcept {
  if (process_) CloseHandle(process_);
  process_ = pipe_ = nullptr; process_id_ = 0; creation_time_ = 0; primary_ = {};
}
DWORD CellControllerPeer::Open(HANDLE pipe, CellControllerIdentity& controller) noexcept {
  if (controller_) return ERROR_ALREADY_INITIALIZED;
  DWORD error = controller.Verify(SERVICE_RUNNING);
  if (!error) error = evidence_.Open(pipe);
  if (error) { Close(); return error; }
  controller_ = &controller;
  error = Verify();
  if (error) Close();
  return error;
}
DWORD CellControllerPeer::Verify() noexcept {
  if (!controller_) return ERROR_INVALID_STATE;
  DWORD error = controller_->Verify(SERVICE_RUNNING);
  if (!error) error = evidence_.Verify();
  worker_host::TokenIdentity worker;
  if (!error && (!worker_host::CollectWorkerProcessToken(evidence_.Process(), &worker) || !worker_host::ValidateWorkerToken(worker)))
    error = ERROR_ACCESS_DENIED;
  if (!error) error = controller_->VerifyProvisioningProcess(evidence_.Process());
  return error;
}
void CellControllerPeer::Close() noexcept { evidence_.Close(); controller_ = nullptr; }
}
