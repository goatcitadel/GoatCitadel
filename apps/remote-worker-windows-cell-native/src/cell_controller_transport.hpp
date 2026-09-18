#pragma once
#include "cell_controller_identity.hpp"

namespace goatcitadel::worker_cell {
constexpr wchar_t kCellControllerPipeName[] = L"\\\\.\\pipe\\LOCAL\\GoatCitadelRemoteWorkerCellController.v1";
// FILE_GENERIC_WRITE also grants FILE_CREATE_PIPE_INSTANCE. Clients get only
// the individual data/attribute rights needed for a duplex connection.
constexpr DWORD kCellControllerPipeClientAccess = FILE_READ_DATA | FILE_WRITE_DATA |
  FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
constexpr DWORD kCellControllerMaximumPipeBytes = 16384;
DWORD BuildCellControllerPipeSecurity(std::vector<std::uint8_t>* descriptor) noexcept;

// Low-level bounded local-pipe I/O, not caller admission or a request protocol.
// Handles must be overlapped, non-inheritable and retained by the caller. The
// caller serializes I/O and supplies a valid stop event and absolute deadline
// no more than ten minutes away. Cancellation drains the exact pending request;
// an undrainable kernel request terminates this process rather than exposing
// stack storage to outstanding I/O. Never retry an uncertain write automatically.
DWORD ConnectCellPipe(HANDLE pipe, HANDLE stop, ULONGLONG deadline) noexcept;
DWORD ReadCellPipe(HANDLE pipe, void* bytes, DWORD count, HANDLE stop, ULONGLONG deadline) noexcept;
DWORD WriteCellPipe(HANDLE pipe, const void* bytes, DWORD count, HANDLE stop, ULONGLONG deadline) noexcept;

// Comparison only, applied to OS-collected facts after successful reversion.
// The pipe token must be identification-only; its type differs from the primary.
// This does not grant controller, worker, service, image or request authority.
bool MatchCellPipeToken(const CellControllerToken& primary, const CellControllerToken& pipe) noexcept;

// Captures a real connected pipe's client process, creation time and primary
// token, then matches the kernel's last-read-message identification token.
// Call only after reading a bounded hello/request. The borrowed pipe must stay
// connected and retained until Close. Reuse after disconnect is forbidden.
// Failed impersonation reversion terminates this process before any operation.
// Raw evidence is inspectable; only CellControllerPeer adds installed admission.
class CellPipeClientEvidence final {
 public:
  ~CellPipeClientEvidence();
  CellPipeClientEvidence() = default;
  CellPipeClientEvidence(const CellPipeClientEvidence&) = delete;
  CellPipeClientEvidence& operator=(const CellPipeClientEvidence&) = delete;
  DWORD Open(HANDLE connected_pipe) noexcept;
  DWORD Verify() noexcept;
  // Current OS continuity only; the installed owner must separately admit the
  // primary endpoint. Neither a PID nor matching token text grants authority.
  DWORD VerifySameProcess(CellPipeClientEvidence& other) noexcept;
  void Close() noexcept;
  HANDLE Process() const noexcept { return process_; }
  DWORD ProcessId() const noexcept { return process_id_; }
  ULONGLONG CreationTime() const noexcept { return creation_time_; }
 private:
  HANDLE process_ = nullptr, pipe_ = nullptr;
  DWORD process_id_ = 0;
  ULONGLONG creation_time_ = 0;
  CellControllerToken primary_;
};

// Client-side OS evidence for a connected local pipe. Retain its actual server
// process, creation time and primary token; a pipe name or SCM PID alone is not
// authority. This class does not impersonate or admit a service. The borrowed
// client-end handle must stay connected and retained until Close.
class CellPipeServerEvidence final {
 public:
  ~CellPipeServerEvidence();
  CellPipeServerEvidence() = default;
  CellPipeServerEvidence(const CellPipeServerEvidence&) = delete;
  CellPipeServerEvidence& operator=(const CellPipeServerEvidence&) = delete;
  DWORD Open(HANDLE connected_pipe) noexcept;
  DWORD Verify() noexcept;
  DWORD VerifySameProcess(CellPipeServerEvidence& other) noexcept;
  void Close() noexcept;
  HANDLE Process() const noexcept { return process_; }
  DWORD ProcessId() const noexcept { return process_id_; }
  ULONGLONG CreationTime() const noexcept { return creation_time_; }
 private:
  HANDLE process_ = nullptr, pipe_ = nullptr;
  DWORD process_id_ = 0;
  ULONGLONG creation_time_ = 0;
  CellControllerToken primary_;
};

// Binds a separate runtime pipe to the same retained process as both inherited
// helper stdio pipes. Owns non-inheritable duplicates, never changes/closes the
// caller's handles. All three must be distinct local client ends; the runtime
// end must have been opened by this process. Stdio ends may have been opened by
// the spawning parent before inheritance. A failed check fences this instance.
// This proves endpoint continuity, not installed worker identity or permission
// to execute: the caller must still supply those independent admission owners.
class CellPipeParentEvidence final {
 public:
  ~CellPipeParentEvidence();
  CellPipeParentEvidence() = default;
  CellPipeParentEvidence(const CellPipeParentEvidence&) = delete;
  CellPipeParentEvidence& operator=(const CellPipeParentEvidence&) = delete;
  DWORD Open(HANDLE input, HANDLE output, HANDLE runtime) noexcept;
  DWORD Verify() noexcept;
  HANDLE RuntimePipe() const noexcept { return open_ && !failure_ ? pipes_[2] : nullptr; }
  HANDLE Process() const noexcept { return open_ && !failure_ ? evidence_[0].Process() : nullptr; }
  void Close() noexcept;
 private:
  DWORD Fail(DWORD error) noexcept;
  std::array<HANDLE, 3> pipes_{};
  std::array<CellPipeServerEvidence, 3> evidence_;
  DWORD failure_ = ERROR_SUCCESS;
  bool attempted_ = false, open_ = false;
};

// Server-side worker admission. Both the controller's current installed custody
// and the client's exact pinned provisioning-helper image/worker token must
// agree with live pipe evidence. Holding evidence alone never grants an action.
class CellControllerPeer final {
 public:
  DWORD Open(HANDLE connected_pipe, CellControllerIdentity& controller) noexcept;
  DWORD Verify() noexcept;
  DWORD VerifyBoundPipe(CellPipeClientEvidence& additional) noexcept;
  void Close() noexcept;
 private:
  CellControllerIdentity* controller_ = nullptr;
  CellPipeClientEvidence evidence_;
};
}
