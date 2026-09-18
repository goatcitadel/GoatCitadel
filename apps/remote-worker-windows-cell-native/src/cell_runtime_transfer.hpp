#pragma once
#include "cell_controller_transport.hpp"
#include "cell_runtime_dispatch.hpp"

namespace goatcitadel::worker_cell {
inline constexpr DWORD kRuntimeTransferChunkBytes = 4096;
// One request on an already authenticated, retained, overlapped local pipe.
// The owner supplies its independently retained expected binding and current
// peer/admission callback. Neither the proposal nor its ACK supplies admission.
// The cancellation event is required; the transfer deadline is at most ten
// minutes away. Native callbacks also need the owner's outer watchdog.
// An ACK means only complete, bound bytes were received, never that execution
// started, completed or is safe to retry. Every attempted Read/Write/Run consumes
// this instance, including failures. Never adopt a reconnect or replay a write.
class CellRuntimeTransfer final {
 public:
  CellRuntimeTransfer(HANDLE pipe, ULONGLONG deadline, const CellRuntimeDispatchBinding& expected,
    const CellFootprintScanGuard& authority) noexcept : pipe_(pipe), deadline_(deadline), expected_(expected), authority_(authority) {}
  CellRuntimeTransfer(const CellRuntimeTransfer&) = delete;
  CellRuntimeTransfer& operator=(const CellRuntimeTransfer&) = delete;
  DWORD Read(std::vector<std::uint8_t>* output) noexcept;
  DWORD Write(const std::vector<std::uint8_t>& bytes) noexcept;
  // Server composition. Failed transfer never reaches the journal or runner.
  // The caller separately transports execution/output/inventory receipts; the
  // transfer ACK must not be promoted to one of those receipts.
  CellRuntimeDispatchResult Run(CellProvisioningJournal& journal, JobStdioChannel* stdio = nullptr) noexcept;
 private:
  DWORD Check() const noexcept;
  DWORD Begin() noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeDispatchBinding expected_;
  CellFootprintScanGuard authority_;
  bool attempted_ = false;
};
}
