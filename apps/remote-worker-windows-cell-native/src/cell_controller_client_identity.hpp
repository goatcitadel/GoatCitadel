#pragma once
#include "cell_controller_transport.hpp"

namespace goatcitadel::worker_cell {
// Private read-only metadata frame: GCCINF01, UTF-8 path length (u32 LE), the
// exact 120-byte GCCUST01 record, then the fixed installed parent path. Encoding
// validates metadata only; ReadCustodySnapshot owns current installed authority.
DWORD EncodeCellControllerCustodySnapshot(const std::wstring& parent_path,
  const CellControllerCustodyRecord& custody, std::vector<std::uint8_t>* output) noexcept;
// Mutual authentication from the restricted provisioning helper. Prepare binds
// this process to the worker service token and independently installed helper
// image. Open binds the connected pipe's retained server to the running SCM
// instance, exact controller token and independently installed controller image.
// Recheck before every request/ack and after every response; never infer death
// from a missing PID or adopt another instance. No privilege is enabled here.
// The caller owns a lifecycle watchdog around synchronous OS inspection.
class CellControllerServerIdentity final {
 public:
  ~CellControllerServerIdentity();
  CellControllerServerIdentity() = default;
  CellControllerServerIdentity(const CellControllerServerIdentity&) = delete;
  CellControllerServerIdentity& operator=(const CellControllerServerIdentity&) = delete;
  DWORD Prepare() noexcept;
  DWORD ReadCustodySnapshot(std::vector<std::uint8_t>* output) noexcept;
  DWORD Open(HANDLE connected_pipe) noexcept;
  DWORD Verify() noexcept;
  DWORD VerifyBoundPipe(CellPipeServerEvidence& additional) noexcept;
  const std::wstring& ParentPath() const noexcept { return installed_.ParentPath(); }
  const CellFileIdentity& ParentIdentity() const noexcept { return installed_.ParentIdentity(); }
  void Close() noexcept;
 private:
  DWORD VerifyWorker() noexcept;
  bool CurrentService() noexcept;
  CellControllerInstalledFiles installed_;
  CellPipeServerEvidence server_;
  CellControllerToken worker_;
  SC_HANDLE manager_ = nullptr, service_ = nullptr;
  bool prepared_ = false, open_ = false;
};
}
